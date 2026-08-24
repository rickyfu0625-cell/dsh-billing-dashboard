/**
 * dsh-billing-dashboard — Host 半（零第三方依赖，仅 node 内置）。
 *
 * 路由：GET /api/billing-dashboard/summary
 * 返回余额（官方 /user/balance）、今日/近 7 日 token 与消费（本地会话日志 +
 * 官方价格引擎折算）、充值链接，以及官方价格同步状态。
 *
 * 价格口径：内置一张「带时间戳的政策表」（历史消息按当时价回放）；此外每天
 * 首次请求时抓取官方定价页（EN $ / ZH 元），若与当前生效价不一致则把新价以
 * 一条新政策追加持久化，之后的消息按新价折算，避免估算随官方调价漂移。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const name = "dsh-billing-dashboard";
const inject = ["credentials", "webServer", "sessionPersistence"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/billing-dashboard/summary";
const TIMEOUT_MS = 15000;
const BALANCE_CACHE_MS = 60 * 1000;
const SCAN_CACHE_MS = 30 * 1000;

const RECHARGE_URL = "https://platform.deepseek.com/top_up";
const USAGE_URL = "https://platform.deepseek.com/usage";

const PRICING_PAGE_EN = "https://api-docs.deepseek.com/quick_start/pricing/";
const PRICING_PAGE_ZH = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICE_STATE_FILE = "dsh-billing-dashboard-pricing.json";
const PRICES_FILE = "dsh-billing-dashboard-prices.json";
const PRICES_ROUTE_PATH = "/api/billing-dashboard/prices";
/** 手动价格只填一种币种时，另一币种按此固定汇率折算（仅用于估算展示）。 */
const USD_TO_CNY = 7.2;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

// ────────────────────────────── 官方价格引擎 ──────────────────────────────

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];
const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 });

const OFFICIAL_PRICING_POLICIES = [
  {
    since: "2025-02-09T00:00:00+08:00",
    label: "deepseek-chat / deepseek-reasoner 标准价（2025-02-09 优惠期结束）",
    prices: {
      "deepseek-chat": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      },
      "deepseek-reasoner": {
        cny: { input: 4, cacheRead: 1, output: 16 },
        usd: { input: 0.55, cacheRead: 0.055, output: 1.68 }
      },
      "*": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      }
    }
  },
  {
    since: "2026-05-22T00:00:00+08:00",
    label: "V4 系列 75% 降价转永久（deepseek-v4-flash / deepseek-v4-pro 上线）",
    prices: {
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 }
      },
      "deepseek-v4-pro": {
        cny: { input: 3, cacheRead: 0.025, output: 6 },
        usd: { input: 0.435, cacheRead: 0.003625, output: 0.87 }
      },
      "*": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 }
      }
    }
  },
  {
    since: "2026-08-17T00:00:00+08:00",
    label: "峰谷定价：高峰 09:00-12:00 / 14:00-18:00（北京时间），空闲时段半价",
    peak: {
      "deepseek-v4-flash": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      },
      "*": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      }
    },
    offPeak: {
      "deepseek-v4-flash": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      },
      "*": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      }
    }
  }
];

function isPeak(timeMs, timezone = DEFAULT_TIMEZONE, windows = DEFAULT_PEAK_WINDOWS) {
  let hour;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "numeric",
      minute: "numeric"
    }).formatToParts(new Date(timeMs));
    hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  } catch {
    hour = -1;
  }
  return windows.some(([start, end]) => hour >= start && hour < end);
}

function priceFor(model, table) {
  return table[model] ?? table["*"] ?? ZERO_UNIT;
}

/** 所有政策中显式点名（非 `*`）的模型名集合，用于识别「非 DeepSeek 官方模型」。 */
function knownModelSet(extraPolicies) {
  const set = new Set();
  for (const policy of [...OFFICIAL_PRICING_POLICIES, ...extraPolicies]) {
    const tables = policy.peak !== void 0 && policy.offPeak !== void 0 ? [policy.peak, policy.offPeak] : [policy.prices];
    for (const table of tables) {
      for (const model of Object.keys(table)) if (model !== "*") set.add(model);
    }
  }
  return set;
}

/** 手动价格：某模型存在用户手填价时返回其双币种单价（无峰谷，固定汇率折算另一币种）。 */
function manualUnit(model, manualPrices) {
  const m = manualPrices && manualPrices[model];
  if (m === void 0 || m === null || typeof m !== "object") return null;
  const input = num(m.input);
  const cacheRead = num(m.cacheRead);
  const output = num(m.output);
  if (input <= 0 && cacheRead <= 0 && output <= 0) return null;
  if (m.currency === "USD") {
    return {
      cny: { input: input * USD_TO_CNY, cacheRead: cacheRead * USD_TO_CNY, output: output * USD_TO_CNY },
      usd: { input, cacheRead, output },
      mode: "manual"
    };
  }
  return {
    cny: { input, cacheRead, output },
    usd: { input: input / USD_TO_CNY, cacheRead: cacheRead / USD_TO_CNY, output: output / USD_TO_CNY },
    mode: "manual"
  };
}

/** 合并内置 + 已同步政策，按生效时间给某模型取价；用户手填价优先。 */
function priceAt(model, timeMs, extraPolicies = [], manualPrices = {}) {
  const manual = manualUnit(model, manualPrices);
  if (manual !== null) return manual;
  const peak = isPeak(timeMs);
  const all = [...OFFICIAL_PRICING_POLICIES, ...extraPolicies];
  const applicable = all.filter((policy) => timeMs >= Date.parse(policy.since));
  const scope = applicable.length > 0 ? applicable : [OFFICIAL_PRICING_POLICIES[0]];
  let winner;
  let named = false;
  let baseTable;
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index];
    const table = policy.peak !== void 0 && policy.offPeak !== void 0
      ? (peak ? policy.peak : policy.offPeak)
      : policy.prices;
    if (table[model] !== void 0) {
      winner = policy;
      named = true;
      baseTable = table;
      break;
    }
  }
  if (winner === void 0) {
    winner = scope[scope.length - 1];
    baseTable = winner.peak !== void 0 && winner.offPeak !== void 0
      ? (peak ? winner.peak : winner.offPeak)
      : winner.prices;
  }
  const unit = priceFor(model, baseTable);
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? (peak ? "peak" : "offPeak") : "flat"
  };
}

function costOf(usage, unit) {
  const inputTokens = num(usage.inputTokens);
  const cacheReadTokens = num(usage.cacheReadTokens);
  const outputTokens = num(usage.outputTokens);
  const cost = (inputTokens * unit.cny.input + cacheReadTokens * unit.cny.cacheRead + outputTokens * unit.cny.output) / 1e6;
  const costUsd = (inputTokens * unit.usd.input + cacheReadTokens * unit.usd.cacheRead + outputTokens * unit.usd.output) / 1e6;
  return { inputTokens, cacheReadTokens, outputTokens, cost, costUsd };
}

// ────────────────────────────── 官方价格同步 ──────────────────────────────

function storagePath(fileName) {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "storages", fileName);
}

function stripCells(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const cells = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    cells.push(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }
  return cells;
}

/**
 * 从官方定价页 HTML 解析「模型 → { peak/offPeak × { input/cacheRead/output } }」。
 * 依赖定价表稳定的列顺序：缓存命中(谷/峰) → 缓存未命中(谷/峰) → 输出(谷/峰)。
 * 解析失败返回 null（调用方回退内置表）。
 */
function parsePricing(html, currency) {
  const cells = stripCells(html);
  const modelList = [];
  for (const c of cells) {
    if (/^deepseek-[a-z0-9][a-z0-9-]*$/.test(c) && !modelList.includes(c)) modelList.push(c);
  }
  const prices = [];
  for (const c of cells) {
    let v;
    if (currency === "usd") {
      const mm = c.match(/^\$([0-9]+(?:\.[0-9]+)?)$/);
      if (mm) v = Number(mm[1]);
    } else {
      const mm = c.match(/^([0-9]+(?:\.[0-9]+)?)元$/);
      if (mm) v = Number(mm[1]);
    }
    if (v !== void 0 && Number.isFinite(v)) prices.push(v);
  }
  const n = modelList.length;
  if (n === 0 || prices.length !== n * 6) return null;
  const result = {};
  modelList.forEach((model, mi) => {
    result[model] = {
      offPeak: {
        cacheRead: prices[mi],
        input: prices[2 * n + mi],
        output: prices[4 * n + mi]
      },
      peak: {
        cacheRead: prices[n + mi],
        input: prices[3 * n + mi],
        output: prices[5 * n + mi]
      }
    };
  });
  return result;
}

/** 归一化到可比较字符串（模型排序、双币种对齐）。 */
function comparable(models) {
  const out = {};
  for (const m of Object.keys(models).sort()) {
    const entry = models[m];
    out[m] = {
      cny: entry.cny ?? null,
      usd: entry.usd ?? null
    };
  }
  return JSON.stringify(out);
}

/** 当前生效政策（内置 + 已同步，最后一条）转成与抓取结果同构的 {model:{cny,usd}}。 */
function currentComparable(extraPolicies) {
  const all = [...OFFICIAL_PRICING_POLICIES, ...extraPolicies];
  const policy = all[all.length - 1];
  if (policy === void 0 || policy.peak === void 0 || policy.offPeak === void 0) return null;
  const models = new Set();
  for (const table of [policy.peak, policy.offPeak]) {
    for (const m of Object.keys(table)) if (m !== "*") models.add(m);
  }
  const out = {};
  for (const m of models) {
    out[m] = {
      cny: { peak: policy.peak[m]?.cny ?? null, offPeak: policy.offPeak[m]?.cny ?? null },
      usd: { peak: policy.peak[m]?.usd ?? null, offPeak: policy.offPeak[m]?.usd ?? null }
    };
  }
  return comparable(out);
}

function buildSyncedPolicy(cny, usd, sinceMs) {
  const models = new Set([...Object.keys(cny ?? {}), ...Object.keys(usd ?? {})]);
  const fallbackModel = cny?.["deepseek-v4-flash"] ? "deepseek-v4-flash" : [...models][0];
  const peak = {};
  const offPeak = {};
  for (const m of models) {
    peak[m] = {
      cny: cny?.[m]?.peak ?? ZERO_UNIT,
      usd: usd?.[m]?.peak ?? ZERO_UNIT
    };
    offPeak[m] = {
      cny: cny?.[m]?.offPeak ?? ZERO_UNIT,
      usd: usd?.[m]?.offPeak ?? ZERO_UNIT
    };
  }
  if (fallbackModel !== void 0 && !models.has("*")) {
    peak["*"] = peak[fallbackModel];
    offPeak["*"] = offPeak[fallbackModel];
  }
  return {
    since: new Date(sinceMs).toISOString(),
    label: "官方同步（" + new Date(sinceMs).toISOString().slice(0, 10) + "）",
    peak,
    offPeak
  };
}

function loadPriceState() {
  try {
    const raw = JSON.parse(readFileSync(storagePath(PRICE_STATE_FILE), "utf8"));
    if (raw && raw.version === 1 && Array.isArray(raw.policies)) return raw;
  } catch {}
  return { version: 1, lastCheckedDay: null, policies: [] };
}

function savePriceState(state) {
  try {
    const path = storagePath(PRICE_STATE_FILE);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    console.error("[dsh-billing-dashboard] failed to persist pricing state:", error);
  }
}

/** 用户手填的非官方模型价格：{ "gpt-4o": { input, cacheRead, output, currency } }。 */
function loadManualPrices() {
  try {
    const raw = JSON.parse(readFileSync(storagePath(PRICES_FILE), "utf8"));
    if (raw && raw.version === 1 && raw.models && typeof raw.models === "object") return raw.models;
  } catch {}
  return {};
}

function saveManualPrices(models) {
  try {
    const path = storagePath(PRICES_FILE);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, models }, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    console.error("[dsh-billing-dashboard] failed to persist manual prices:", error);
  }
}

// ────────────────────────────── 工具函数 ──────────────────────────────

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function localDayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function emptyDay() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, costUsd: 0 };
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = 16384) {
  return new Promise((resolve) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

function primaryBalanceInfo(payload) {
  if (payload === null || payload === void 0 || !Array.isArray(payload.balance_infos)) return null;
  return payload.balance_infos.reduce((best, b) => {
    if (b === null || typeof b !== "object") return best;
    if (best === null) return b;
    return (Number(b.total_balance) || 0) > (Number(best.total_balance) || 0) ? b : best;
  }, null);
}

// ────────────────────────────── 插件主体 ──────────────────────────────

function apply(ctx) {
  let days = new Map();
  let sessionDays = new Map(); // sessionId -> Map<dayKey, dayAggregate>
  let sessionModelDays = new Map(); // sessionId -> Map<model, Map<dayKey, dayAggregate>>
  let lastScanAt = 0;
  let scanPromise = null;
  let balanceCache = { fetchedAt: 0, payload: null };
  let unknownModels = new Set();
  let disposed = false;

  const priceState = loadPriceState();
  let syncedPolicies = priceState.policies;
  let manualPrices = loadManualPrices();
  let priceStatus = {
    status: priceState.lastCheckedDay === null ? "pending" : "in-sync",
    checkedAt: priceState.lastCheckedDay === null ? null : Date.now(),
    message: "",
    modelCount: 0
  };
  let priceCheckInFlight = false;

  async function scanAll() {
    const next = new Map();
    const sessionNext = new Map();
    const sessionModelNext = new Map(); // sessionId -> Map<model, Map<dayKey, agg>>
    const known = knownModelSet(syncedPolicies);
    const unknown = new Set();

    const ensure = (map, key) => {
      let d = map.get(key);
      if (d === undefined) {
        d = emptyDay();
        map.set(key, d);
      }
      return d;
    };

    const headers = await ctx.sessionPersistence.list();
    if (!Array.isArray(headers)) return { days: next, sessionDays: sessionNext, sessionModelDays: sessionModelNext };
    for (const header of headers) {
      if (disposed) break;
      const sid = header && typeof header.id === "string" ? header.id : undefined;
      if (sid === undefined) continue;
      let raw;
      try {
        raw = await ctx.sessionPersistence.readRaw(sid);
      } catch {
        continue;
      }
      if (raw === void 0 || raw === null || typeof raw.content !== "string") continue;
      for (const line of raw.content.split("\n")) {
        if (line === "") continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev === null || typeof ev !== "object" || ev.type !== "assistant/message") continue;
        const data = ev.data;
        const usage = data && data.usage;
        if (usage === void 0 || usage === null) continue;
        const tokens = num(usage.inputTokens) + num(usage.outputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.reasoningTokens);
        if (tokens <= 0) continue;
        const source = data.message && data.message.source;
        const model = source && typeof source.model === "string" && source.model !== "" ? source.model : "unknown";
        if (model !== "unknown" && !known.has(model)) unknown.add(model);
        const timeMs = typeof ev.time === "number" ? ev.time : Date.now();
        const unit = priceAt(model, timeMs, syncedPolicies, manualPrices);
        const c = costOf(usage, unit);
        const key = localDayKey(timeMs);
        const day = ensure(next, key);
        let sessMap = sessionNext.get(sid);
        if (sessMap === undefined) {
          sessMap = new Map();
          sessionNext.set(sid, sessMap);
        }
        const sday = ensure(sessMap, key);
        let modelMap = sessionModelNext.get(sid);
        if (modelMap === undefined) {
          modelMap = new Map();
          sessionModelNext.set(sid, modelMap);
        }
        let modelDays = modelMap.get(model);
        if (modelDays === undefined) {
          modelDays = new Map();
          modelMap.set(model, modelDays);
        }
        const mday = ensure(modelDays, key);
        for (const d of [day, sday, mday]) {
          d.calls += 1;
          d.input += c.inputTokens;
          d.output += c.outputTokens;
          d.cacheRead += c.cacheReadTokens;
          d.cacheWrite += num(usage.cacheWriteTokens);
          d.reasoning += num(usage.reasoningTokens);
          d.cost += c.cost;
          d.costUsd += c.costUsd;
        }
      }
    }
    unknownModels = new Set([...unknown, ...unknownModels]);
    return { days: next, sessionDays: sessionNext, sessionModelDays: sessionModelNext };
  }

  function refreshDays() {
    if (scanPromise !== null) return scanPromise;
    scanPromise = (async () => {
      try {
        const result = await scanAll();
        if (!disposed) {
          days = result.days;
          sessionDays = result.sessionDays;
          sessionModelDays = result.sessionModelDays;
          lastScanAt = Date.now();
        }
      } catch (error) {
        console.error("[dsh-billing-dashboard] usage scan failed:", error);
      } finally {
        scanPromise = null;
      }
    })();
    return scanPromise;
  }

  // 实时检测：消息事件一到就识别非 DeepSeek 官方模型，不等扫描/落盘
  ctx.on("session/event", (session, event) => {
    try {
      if (event === null || typeof event !== "object" || event.type !== "assistant/message") return;
      const source = event.data && event.data.message && event.data.message.source;
      const model = source && typeof source.model === "string" && source.model !== "" ? source.model : null;
      if (model === null || model === "unknown") return;
      if (!knownModelSet(syncedPolicies).has(model)) unknownModels.add(model);
    } catch {}
  });

  async function fetchBalance() {
    const hit = await ctx.credentials.resolve("DEEPSEEK_API_KEY");
    if (hit === void 0) {
      return { ok: false, error: "no-api-key", message: "未配置 DEEPSEEK_API_KEY：请在「设置 → 模型」中填写 DeepSeek API Key。" };
    }
    let res;
    try {
      res = await fetch(balanceUrl(), {
        headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      return { ok: false, error: "fetch-failed", message: error instanceof Error ? error.message : String(error) };
    }
    const text = await res.text();
    if (!res.ok) {
      let message = `DeepSeek 接口返回 HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error && typeof parsed.error.message === "string") message = parsed.error.message;
      } catch {}
      return { ok: false, error: "provider", message };
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: "parse-failed", message: "余额接口返回无法解析。" };
    }
    return { ok: true, balance: body };
  }

  /** 每天首次触发：抓取官方定价，有变动则追加一条同步政策并持久化。 */
  async function runPriceCheck() {
    if (disposed || priceCheckInFlight) return;
    priceCheckInFlight = true;
    const today = localDayKey(Date.now());
    priceStatus = { status: "checking", checkedAt: Date.now(), message: "", modelCount: 0 };
    try {
      const [zhRes, enRes] = await Promise.all([
        fetch(PRICING_PAGE_ZH, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
        fetch(PRICING_PAGE_EN, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      ]);
      if (!zhRes.ok || !enRes.ok) {
        throw new Error(`官方定价页返回 HTTP ${zhRes.status}/${enRes.status}`);
      }
      const cny = parsePricing(await zhRes.text(), "cny");
      const usd = parsePricing(await enRes.text(), "usd");
      if (cny === null || usd === null) throw new Error("官方定价页解析失败（表格结构变化？）");

      const fetched = {};
      for (const m of new Set([...Object.keys(cny), ...Object.keys(usd)])) {
        fetched[m] = { cny: cny[m] ?? null, usd: usd[m] ?? null };
      }
      const current = currentComparable(syncedPolicies);
      const modelCount = Object.keys(fetched).length;

      if (current !== null && comparable(fetched) === current) {
        priceStatus = { status: "in-sync", checkedAt: Date.now(), message: "内置价格与官方一致", modelCount };
      } else {
        const policy = buildSyncedPolicy(cny, usd, Date.now());
        syncedPolicies = [...syncedPolicies, policy];
        priceState.policies = syncedPolicies;
        priceStatus = { status: "updated", checkedAt: Date.now(), message: "官方价格有变动，已同步最新计费口径", modelCount };
      }
      priceState.lastCheckedDay = today;
      savePriceState(priceState);
    } catch (error) {
      console.warn("[dsh-billing-dashboard] official price sync failed:", error && error.message ? error.message : error);
      priceStatus = { status: "unavailable", checkedAt: Date.now(), message: "官方价格同步失败，暂用内置价格快照", modelCount: 0 };
    } finally {
      priceCheckInFlight = false;
    }
  }

  function maybeRunPriceCheck() {
    const today = localDayKey(Date.now());
    if (priceState.lastCheckedDay !== today && !priceCheckInFlight) {
      void runPriceCheck();
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const force = url.searchParams.get("force") === "1";
        const sessionId = url.searchParams.get("sessionId");
        if (force || Date.now() - lastScanAt > SCAN_CACHE_MS) await refreshDays();

        let balance = balanceCache.payload;
        let balanceError = null;
        if (force || Date.now() - balanceCache.fetchedAt > BALANCE_CACHE_MS) {
          const result = await fetchBalance();
          if (result.ok) {
            balanceCache = { fetchedAt: Date.now(), payload: result.balance };
            balance = result.balance;
          } else {
            balanceError = result;
          }
        }

        maybeRunPriceCheck();

        const info = primaryBalanceInfo(balance);
        const currency = info && typeof info.currency === "string" ? info.currency : "CNY";

        // 选择数据源：指定了 sessionId 且有该会话数据 → 本会话；否则全局
        const scoped = sessionId !== null && sessionId !== "" ? sessionDays.get(sessionId) : undefined;
        const scopeDays = scoped !== undefined ? scoped : days;
        const scope = scoped !== undefined ? "session" : "global";

        const todayKey = localDayKey(Date.now());
        const today = scopeDays.get(todayKey) ?? emptyDay();

        const now = new Date();
        const series = [];
        for (let offset = 6; offset >= 0; offset--) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
          const key = localDayKey(d.getTime());
          const day = scopeDays.get(key) ?? emptyDay();
          series.push({ date: key, ...day });
        }

        let totals = emptyDay();
        for (const day of scopeDays.values()) {
          totals.calls += day.calls;
          totals.input += day.input;
          totals.output += day.output;
          totals.cacheRead += day.cacheRead;
          totals.cacheWrite += day.cacheWrite;
          totals.reasoning += day.reasoning;
          totals.cost += day.cost;
          totals.costUsd += day.costUsd;
        }

        // 当前会话按模型计费：每个模型的今日 / 累计
        const modelDayMap = scope === "session" ? sessionModelDays.get(sessionId) : undefined;
        const models = [];
        if (modelDayMap !== undefined) {
          for (const [model, dayMap] of modelDayMap) {
            const mToday = dayMap.get(todayKey) ?? emptyDay();
            let mTotals = emptyDay();
            for (const d of dayMap.values()) {
              mTotals.calls += d.calls;
              mTotals.input += d.input;
              mTotals.output += d.output;
              mTotals.cacheRead += d.cacheRead;
              mTotals.cacheWrite += d.cacheWrite;
              mTotals.reasoning += d.reasoning;
              mTotals.cost += d.cost;
              mTotals.costUsd += d.costUsd;
            }
            models.push({ model, today: mToday, totals: mTotals });
          }
          models.sort((a, b) => (b.totals.cost || 0) - (a.totals.cost || 0));
        }

        sendJson(res, 200, {
          ok: true,
          balance,
          balanceError,
          currency,
          available: balance ? balance.is_available !== false : null,
          scope,
          sessionId: scope === "session" ? sessionId : null,
          today,
          series,
          totals,
          models,
          unknownModels: [...unknownModels].sort(),
          manualPrices,
          pricingStatus: priceStatus,
          recharge: { url: RECHARGE_URL, usageUrl: USAGE_URL, label: "DeepSeek 官方充值" },
          note: "余额为官方实时数据；「消费」按官方价格（含峰谷与缓存命中价）对本地会话日志折算估算，最终以平台账单为准。"
        });
      } catch (error) {
        console.error("[dsh-billing-dashboard] summary route failed:", error);
        sendJson(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }), "dsh-billing-dashboard: summary route");

  // 手动价格：保存 / 清除某非官方模型的每 1M token 单价（¥ 或 $）
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: PRICES_ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const raw = await readBody(req);
        let payload = {};
        try {
          payload = JSON.parse(raw || "{}");
        } catch {}
        const model = typeof payload.model === "string" ? payload.model.trim() : "";
        if (model === "") {
          sendJson(res, 400, { ok: false, error: "bad-request", message: "缺少模型名" });
          return;
        }
        if (payload.delete === true) {
          delete manualPrices[model];
        } else {
          const currency = payload.currency === "USD" ? "USD" : "CNY";
          const input = num(payload.input);
          const cacheRead = num(payload.cacheRead);
          const output = num(payload.output);
          if (input <= 0 && cacheRead <= 0 && output <= 0) {
            sendJson(res, 400, { ok: false, error: "bad-request", message: "价格至少一项须大于 0" });
            return;
          }
          manualPrices[model] = { input, cacheRead, output, currency };
        }
        saveManualPrices(manualPrices);
        lastScanAt = 0; // 让下一次 summary 重新扫描计价
        sendJson(res, 200, { ok: true, manualPrices });
      } catch (error) {
        console.error("[dsh-billing-dashboard] prices route failed:", error);
        sendJson(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }), "dsh-billing-dashboard: prices route");
}

export { name, inject, apply };
