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
const TOKEN_ROUTE_PATH = "/api/billing-dashboard/token";
const TIMEOUT_MS = 15000;
const BALANCE_CACHE_MS = 60 * 1000;
const SCAN_CACHE_MS = 30 * 1000;

const RECHARGE_URL = "https://platform.deepseek.com/top_up";
const USAGE_URL = "https://platform.deepseek.com/usage";

/** 官方平台用量接口（需要 platform.deepseek.com 登录后的 userToken）。 */
// 权威口径：amount 返回整数 token；cost 返回被缩放过的残次数据，仅作兜底
const PLATFORM_USAGE_AMOUNT_URL = "https://platform.deepseek.com/api/v0/usage/amount";
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";
const PLATFORM_TOKEN_REF = "DEEPSEEK_PLATFORM_TOKEN";
const USAGE_CACHE_MS = 5 * 60 * 1000;

const PRICING_PAGE_EN = "https://api-docs.deepseek.com/quick_start/pricing/";
const PRICING_PAGE_ZH = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICE_STATE_FILE = "dsh-billing-dashboard-pricing.json";
const BALANCE_LEDGER_FILE = "dsh-billing-dashboard-balance.json";

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
  },
  {
    since: "2026-09-10T12:00:00+08:00",
    label: "flash 系列降价（2026-09-10 12:00 起）：空闲 ¥0.02/1/4、$0.003/0.15/0.6；高峰翻倍",
    peak: {
      "deepseek-flash": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "deepseek-v4-flash": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "deepseek-v4-flash-vision-exp": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      },
      "*": {
        cny: { input: 2, cacheRead: 0.04, output: 8 },
        usd: { input: 0.3, cacheRead: 0.006, output: 1.2 }
      }
    },
    offPeak: {
      "deepseek-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "deepseek-v4-flash-vision-exp": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      },
      "*": {
        cny: { input: 1, cacheRead: 0.02, output: 4 },
        usd: { input: 0.15, cacheRead: 0.003, output: 0.6 }
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

/**
 * 官方 DeepSeek 模型判定，用于决定是否提示「暂不支持该模型的消费统计」。
 *
 * 只看价格表会误判：DSH 默认目录里的 `deepseek-flash`（provider `deepseek-official`）
 * 并未出现在官方定价页，因而不在同步价格表中。因此优先按 provider 判定，其次按模型名：
 * `deepseek-` 前缀的官方 id，或价格表显式点名的模型都算官方；其余（如 kimi-k3）才算非官方。
 */
function isOfficialModel(provider, model, extraPolicies) {
  if (provider === "deepseek-official") return true;
  if (typeof model !== "string" || model === "" || model === "unknown") return false;
  return model.startsWith("deepseek-") || knownModelSet(extraPolicies).has(model);
}

/** 合并内置 + 已同步政策，按生效时间给某模型取价。 */
function priceAt(model, timeMs, extraPolicies = []) {
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

/** 按账户币种取价：USD 账户用美元价，CNY 账户用人民币价。 */
function costIn(day, currency) {
  return String(currency).toUpperCase() === "USD" ? num(day.costUsd) : num(day.cost);
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
function parsePriceCell(cell, currency) {
  const text = String(cell ?? "");
  if (currency === "usd") {
    const m = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
    return m ? Number(m[1]) : null;
  }
  const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*\u5143/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse the official pricing page into model -> { peak/offPeak x { input, cacheRead, output } }.
 * Row-advancing instead of fixed column offsets: each price section now reads
 * "section name -> off-peak row -> per-model values -> peak row -> per-model values".
 * Returns null when nothing usable was parsed (caller falls back to the built-in snapshot).
 */
function parsePricing(html, currency) {
  const cells = stripCells(html);
  const modelList = [];
  for (const c of cells) {
    const match = String(c).match(/^(deepseek-[a-z0-9][a-z0-9-]*)\b/);
    if (match !== null && !modelList.includes(match[1])) modelList.push(match[1]);
  }
  const count = modelList.length;
  if (count === 0) return null;
  const sections = [
    { key: "cacheRead", label: /\u7f13\u5b58\u547d\u4e2d|cache\s*hit/i },
    { key: "input", label: /\u7f13\u5b58\u672a\u547d\u4e2d|cache\s*miss/i },
    { key: "output", label: /\u767e\u4e07tokens\u8f93\u51fa|1m\s*output|\u8f93\u51fa\s*tokens/i }
  ];
  const result = {};
  for (const model of modelList) result[model] = { peak: {}, offPeak: {} };
  for (const section of sections) {
    const start = cells.findIndex((c) => section.label.test(String(c)));
    if (start < 0) continue;
    const values = [];
    for (let index = start + 1; index < cells.length && values.length < count * 2; index++) {
      const value = parsePriceCell(cells[index], currency);
      if (value !== null) values.push(value);
    }
    for (let slot = 0; slot < count; slot++) {
      if (values[slot] !== void 0) result[modelList[slot]].offPeak[section.key] = values[slot];
      if (values[count + slot] !== void 0) result[modelList[slot]].peak[section.key] = values[count + slot];
    }
  }
  let usable = false;
  for (const model of modelList) {
    const entry = result[model];
    if (entry.peak.input === void 0 || entry.offPeak.input === void 0) continue;
    entry.peak.cacheRead = entry.peak.cacheRead ?? entry.offPeak.cacheRead ?? 0;
    entry.peak.output = entry.peak.output ?? entry.offPeak.output ?? 0;
    entry.offPeak.cacheRead = entry.offPeak.cacheRead ?? 0;
    entry.offPeak.output = entry.offPeak.output ?? 0;
    usable = true;
  }
  return usable ? result : null;
}
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

/** 读取 JSON 请求体（带大小上限）；空体返回 {}。 */
async function readJsonBody(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

/** 官方账号币种别名：平台余额用 CNY，官方用量接口用 RMB。 */
function currencyAlias(currency) {
  const code = String(currency ?? "").trim().toUpperCase();
  if (code === "RMB" || code === "CNY") return "CNY";
  if (code === "USD" || code === "US$") return "USD";
  return code === "" ? "CNY" : code;
}

/** 官方用量接口的产物名 → 本地价格表里的模型名。 */
function officialModelId(model) {
  const name = String(model);
  if (name === "deepseek-flash" || name === "deepseek-v4.1-flash" || name === "deepseek-v4-flash-vision-exp") return "deepseek-v4-flash";
  return name;
}

const COST_INPUT_CURRENCIES = ["USD", "CNY"];

/**
 * 官方用量接口只给 token 数（/usage/amount 为整数；/usage/cost 为缩放过的等价量），
 * 没有金额字段，因此按官方价目表在本地折算成钱；账户币种决定取 USD 还是 CNY 单价。
 */
function costOfOfficial(container, currency, extraPolicies) {
  const want = currencyAlias(currency);
  const summary = {};
  const days = Array.isArray(container && container.days) ? container.days : [];
  const todayKey = localDayKey(Date.now());
  for (const day of days) {
    if (day === null || typeof day !== "object" || typeof day.date !== "string") continue;
    if (day.date > todayKey) continue;
    for (const entry of Array.isArray(day.data) ? day.data : []) {
      if (entry === null || typeof entry !== "object") continue;
      const model = officialModelId(entry.model);
      const counts = {};
      for (const usage of Array.isArray(entry.usage) ? entry.usage : []) {
        if (usage === null || typeof usage !== "object") continue;
        const key = String(usage.type ?? "").toUpperCase();
        if (key === "" || key === "REQUEST") continue;
        const raw = Number(usage.amount) || 0;
        const value = container.source === "cost-fallback" ? raw * 1e9 : raw;
        counts[key] = (counts[key] || 0) + value;
      }
      const hit = counts.PROMPT_CACHE_HIT_TOKEN || 0;
      const miss = (counts.PROMPT_CACHE_MISS_TOKEN || 0) + (counts.PROMPT_TOKEN || 0);
      const output = counts.RESPONSE_TOKEN || 0;
      if (hit + miss + output <= 0) continue;
      if (summary[day.date] === void 0) summary[day.date] = { prompt: 0, cacheRead: 0, output: 0, requests: 0, cost: 0, costUsd: 0 };
      const modelDay = summary[day.date];
      modelDay.prompt += hit + miss;
      modelDay.cacheRead += hit;
      modelDay.output += output;
      modelDay.raw = (modelDay.raw || 0) + hit + miss + output;
      // 逐日按当天生效价折算（日粒度无法拆峰谷，取当日中点的档位）
      const dayMs = Date.parse(`${day.date}T12:00:00+08:00`);
      const price = priceAt(model, Number.isFinite(dayMs) ? dayMs : Date.now(), extraPolicies ?? []);
      const unit = price.mode === "peak" ? (price.peak ?? price) : (price.offPeak ?? price);
      for (const code of COST_INPUT_CURRENCIES) {
        const rate = unit[code.toLowerCase()] ?? {};
        const amount = (hit * (rate.cacheRead || 0) + miss * (rate.input || 0) + output * (rate.output || 0)) / 1e6;
        if (code === "USD") modelDay.costUsd += amount;
        else modelDay.cost += amount;
      }
    }
  }
  const history = Object.keys(summary).sort().map((date) => {
    const entry = summary[date];
    const cost = want === "USD" ? entry.costUsd : entry.cost;
    return { date, cost: Math.round(cost * 1000) / 1000, tokens: entry.raw, input: entry.prompt, cacheRead: entry.cacheRead, output: entry.output };
  });
  const today = history.find((entry) => entry.date === todayKey);
  return {
    todayCost: today !== void 0 ? today.cost : null,
    todayTokens: summary[todayKey] !== void 0 ? { input: summary[todayKey].prompt, cacheRead: summary[todayKey].cacheRead, output: summary[todayKey].output } : null,
    history,
    currency: want,
    source: "official-tokens"
  };
}

/** 余额差额账本：/user/balance 是官方唯一可靠的金额接口，逐日快照做差即真实支出。 */
function ledgerKey(currency) {
  return String(currency ?? "CNY").toUpperCase();
}

function loadLedger() {
  try {
    const raw = JSON.parse(readFileSync(storagePath(BALANCE_LEDGER_FILE), "utf8"));
    if (raw !== null && typeof raw === "object" && raw.days !== null && typeof raw.days === "object") return { days: raw.days };
  } catch {}
  return { days: {} };
}

function saveLedger(ledger) {
  try {
    const dates = Object.keys(ledger.days).sort();
    for (const date of dates.slice(0, Math.max(0, dates.length - 120))) delete ledger.days[date];
    const path = storagePath(BALANCE_LEDGER_FILE);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
    renameSync(tmp, path);
  } catch (error) {
    console.error("[dsh-billing-dashboard] failed to persist balance ledger:", error);
  }
}

/**
 * 抓取官方平台本月逐日消费。响应结构：
 * { code:0, data:{ biz_code:0, biz_data:{ days:[{ date, data:[{ usage:[{ cost|amount }] }] }] } } }
 * 返回 { todayCost, history }；今天之后（本月剩余日期）的零值占位会被过滤。
 */
async function fetchPlatformUsage(token) {
  const now = new Date();
  const query = `month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
  const useAmount = process.env.DSH_BILLING_USAGE_ENDPOINT !== "cost";
  const url = `${useAmount ? PLATFORM_USAGE_AMOUNT_URL : PLATFORM_USAGE_URL}?${query}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-app-version": "1.0.0",
      Origin: "https://platform.deepseek.com",
      Referer: "https://platform.deepseek.com/usage"
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    const err = new Error(`DeepSeek 平台用量接口返回 HTTP ${response.status}`);
    // 401/403 说明 token 已失效/无效，归入「过期」状态，供前端标红提示。
    if (response.status === 401 || response.status === 403) err.code = "expired";
    throw err;
  }
  const body = await response.json();
  const biz = body && typeof body === "object" ? body.data : void 0;
  if (body?.code !== 0 || biz === void 0 || biz.biz_code !== 0) {
    const code = body?.code ?? biz?.biz_code;
    if (code === 40002 || code === 40003) {
      const err = new Error("DEEPSEEK_PLATFORM_TOKEN 已过期：请重新登录 platform.deepseek.com 并更新 userToken");
      err.code = "expired";
      throw err;
    }
    const err = new Error(`DeepSeek 平台用量接口错误 (code ${code ?? "unknown"})`);
    err.code = String(code ?? "unknown");
    throw err;
  }
  const bizData = biz.biz_data;
  const container = Array.isArray(bizData) ? bizData[0] : bizData;
  const days = container && typeof container === "object" ? container.days : void 0;
  if (!Array.isArray(days)) return { todayCost: null, history: [], container: null };
  const todayDate = localDayKey(Date.now());
  const history = [];
  for (const entry of days) {
    if (!entry || typeof entry.date !== "string" || !Array.isArray(entry.data)) continue;
    if (entry.date > todayDate) continue;
    let total = 0;
    for (const modelEntry of entry.data) {
      if (!modelEntry || typeof modelEntry !== "object" || !Array.isArray(modelEntry.usage)) continue;
      for (const usage of modelEntry.usage) {
        if (!usage || typeof usage !== "object") continue;
        const value = Number(usage.cost ?? usage.amount);
        if (Number.isFinite(value)) total += value;
      }
    }
    history.push({ date: entry.date, cost: Math.round(total * 100) / 100 });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const today = history.find((entry) => entry.date === todayDate);
  return { todayCost: today?.cost ?? null, history, container };
}

// ────────────────────────────── 插件主体 ──────────────────────────────

function apply(ctx) {
  let days = new Map();
  let lastScanAt = 0;
  let scanPromise = null;
  let balanceCache = { fetchedAt: 0, payload: null };
  let unknownModels = new Set();
  let officialCache = { fetchedAt: 0, status: "unset", todayCost: null, history: [] };
  let lastOfficialCheckDay = null;
  let officialFetchPromise = null;
  let officialCheckInFlight = false;
  let disposed = false;

  const priceState = loadPriceState();
  let syncedPolicies = priceState.policies;
  let priceStatus = {
    status: priceState.lastCheckedDay === null ? "pending" : "in-sync",
    checkedAt: priceState.lastCheckedDay === null ? null : Date.now(),
    modelCount: 0
  };
  let priceCheckInFlight = false;

  const READ_PAGE = 500;

  /** 扫描单个 assistant/message 事件并累加到按天聚合里。 */
  function scanEvent(ev, next, unknown) {
    if (ev === null || typeof ev !== "object" || ev.type !== "assistant/message") return;
    const data = ev.data;
    const usage = data && data.usage;
    if (usage === void 0 || usage === null) return;
    const tokens = num(usage.inputTokens) + num(usage.outputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.reasoningTokens);
    if (tokens <= 0) return;
    const source = data.message && data.message.source;
    const model = source && typeof source.model === "string" && source.model !== "" ? source.model : "unknown";
    const provider = source && typeof source.provider === "string" ? source.provider : null;
    if (model !== "unknown" && !isOfficialModel(provider, model, syncedPolicies)) {
      unknown.add(model);
      return;
    }
    const timeMs = typeof ev.time === "number" ? ev.time : Date.now();
    const unit = priceAt(model, timeMs, syncedPolicies);
    const c = costOf(usage, unit);
    const key = localDayKey(timeMs);
    let day = next.get(key);
    if (day === undefined) {
      day = emptyDay();
      next.set(key, day);
    }
    day.calls += 1;
    day.input += c.inputTokens;
    day.output += c.outputTokens;
    day.cacheRead += c.cacheReadTokens;
    day.cacheWrite += num(usage.cacheWriteTokens);
    day.reasoning += num(usage.reasoningTokens);
    day.cost += c.cost;
    day.costUsd += c.costUsd;
  }

  /** DSH >= 0.1.5 的 handle 化读取；返回 null 表示宿主没有该接口，需要回退旧读法。 */
  async function scanAllViaHandles() {
    const snapshots = await ctx.sessionPersistence.list();
    if (!Array.isArray(snapshots)) return new Map();
    const next = new Map();
    const unknown = new Set();
    for (const snapshot of snapshots) {
      if (disposed) break;
      const sid = snapshot && snapshot.header && typeof snapshot.header.id === "string" ? snapshot.header.id : undefined;
      if (sid === undefined) continue;
      let handle;
      try {
        handle = await ctx.sessionPersistence.open(sid, "read");
      } catch {
        continue;
      }
      if (handle === void 0 || handle === null || typeof handle.read !== "function") {
        try {
          if (handle && typeof handle.close === "function") await handle.close();
        } catch {}
        return null;
      }
      try {
        let offset = 0;
        for (;;) {
          if (disposed) break;
          const result = await handle.read(offset, READ_PAGE);
          const events = result && Array.isArray(result.events) ? result.events : [];
          if (events.length === 0) break;
          offset += events.length;
          for (const ev of events) scanEvent(ev, next, unknown);
          if (events.length < READ_PAGE) break;
        }
      } catch {
        // 单会话读失败不影响其它会话
      } finally {
        try {
          if (typeof handle.close === "function") await handle.close();
        } catch {}
      }
    }
    unknownModels = new Set([...unknown, ...unknownModels]);
    return next;
  }

  /** 旧宿主兜底：readRaw(sid) 返回 { content }。 */
  async function scanAllFromRaw() {
    const next = new Map();
    const unknown = new Set();
    const headers = await ctx.sessionPersistence.list();
    if (!Array.isArray(headers)) return next;
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
        scanEvent(ev, next, unknown);
      }
    }
    unknownModels = new Set([...unknown, ...unknownModels]);
    return next;
  }

  async function scanAll() {
    if (typeof ctx.sessionPersistence.open === "function") {
      const viaHandles = await scanAllViaHandles();
      if (viaHandles !== null) return viaHandles;
    }
    return scanAllFromRaw();
  }

  function refreshDays() {
    if (scanPromise !== null) return scanPromise;
    scanPromise = (async () => {
      try {
        const next = await scanAll();
        if (!disposed) {
          days = next;
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
      const provider = source && typeof source.provider === "string" ? source.provider : null;
      if (!isOfficialModel(provider, model, syncedPolicies)) unknownModels.add(model);
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
    priceStatus = { status: "checking", checkedAt: Date.now(), modelCount: 0 };
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
        priceStatus = { status: "in-sync", checkedAt: Date.now(), modelCount };
      } else {
        const policy = buildSyncedPolicy(cny, usd, Date.now());
        syncedPolicies = [...syncedPolicies, policy];
        priceState.policies = syncedPolicies;
        priceStatus = { status: "updated", checkedAt: Date.now(), modelCount };
      }
      priceState.lastCheckedDay = today;
      savePriceState(priceState);
    } catch (error) {
      console.warn("[dsh-billing-dashboard] official price sync failed:", error && error.message ? error.message : error);
      priceStatus = { status: "unavailable", checkedAt: Date.now(), modelCount: 0 };
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

  async function fetchOfficialUsage(force = false) {
    if (!force && Date.now() - officialCache.fetchedAt < USAGE_CACHE_MS) return officialCache;
    if (officialFetchPromise !== null) return officialFetchPromise;
    officialFetchPromise = (async () => {
      const hit = await ctx.credentials.resolve(PLATFORM_TOKEN_REF);
      if (hit === void 0) {
        officialCache = { fetchedAt: Date.now(), status: "unset", todayCost: null, history: [] };
        return officialCache;
      }
      try {
        const data = await fetchPlatformUsage(hit.value);
        officialCache = { fetchedAt: Date.now(), status: "ok", todayCost: data.todayCost, history: data.history };
      } catch (error) {
        officialCache = {
          fetchedAt: Date.now(),
          status: error && error.code === "expired" ? "expired" : "error",
          todayCost: null,
          history: []
        };
      }
      return officialCache;
    })().finally(() => {
      officialFetchPromise = null;
    });
    return officialFetchPromise;
  }

  /**
   * 每天首次打开时自检一次官方 token：强制走一次官方用量接口，
   * 其结果（ok / expired / error / unset）写入 officialCache.status，
   * 供前端把「官方」标签标红为「官方token已失效」。同一天内只做一次。
   */
  async function ensureDailyOfficialCheck() {
    const today = localDayKey(Date.now());
    if (lastOfficialCheckDay === today) return;
    if (officialCheckInFlight) return;
    officialCheckInFlight = true;
    try {
      await fetchOfficialUsage(true);
      lastOfficialCheckDay = today;
    } finally {
      officialCheckInFlight = false;
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const force = url.searchParams.get("force") === "1";
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
        await ensureDailyOfficialCheck();

        const official = await fetchOfficialUsage(force);

        const info = primaryBalanceInfo(balance);
        const currency = currencyAlias(info && typeof info.currency === "string" ? info.currency : "CNY");
        const balanceAmount = info ? Number(info.total_balance) : NaN;

        // 官方口径：接口只给 token，按官方价目表折算成账户币种金额
        const officialCost = costOfOfficial(official.container, currency, syncedPolicies);
        official.todayCost = officialCost.todayCost;
        official.history = officialCost.history;
        official.currency = officialCost.currency;
        official.source = officialCost.source;

        // 今日 token 优先用官方拆分（本地日志扫描在部分宿主上取不到事件）
        const todayKeyEarly = localDayKey(Date.now());
        const today = days.get(todayKeyEarly) ?? emptyDay();
        const officialTokens = officialCost.todayTokens;
        if (officialTokens !== null && officialTokens !== void 0) {
          today.input = officialTokens.input;
          today.cacheRead = officialTokens.cacheRead;
          today.output = officialTokens.output;
          today.tokensFromOfficial = true;
        }

        const ledger = loadLedger();
        // 账本日界用 UTC：官方 /user/balance 不带时区，本地日界会把同一笔支出拆到两天
        const ledgerDate = new Date().toISOString().slice(0, 10);

        if (Number.isFinite(balanceAmount)) {
          const existing = ledger.days[ledgerDate];
          if (existing === void 0) {
            // 今日首见：以上次记录闭账价作开盘价；没有历史则用当前余额（差额暂不可算）
            let opening = balanceAmount;
            const past = Object.keys(ledger.days).filter((d) => d < ledgerDate).sort();
            for (let index = past.length - 1; index >= 0; index--) {
              const candidate = Number(ledger.days[past[index]].close);
              if (Number.isFinite(candidate)) {
                opening = candidate;
                break;
              }
            }
            ledger.days[ledgerDate] = { opening, close: balanceAmount, topUps: 0, currency };
          } else {
            // 幂等：重复读到同一余额不累加增量，否则会把支出当成充值
            const knownClose = Number(existing.close);
            if (Number.isFinite(knownClose)) {
              const delta = balanceAmount - knownClose;
              if (delta > 0.000001) existing.topUps = num(existing.topUps) + delta;
            }
            existing.close = balanceAmount;
            existing.currency = currency;
            if (!Number.isFinite(Number(existing.opening))) existing.opening = balanceAmount;
            if (!Number.isFinite(Number(existing.topUps))) existing.topUps = 0;
          }
          saveLedger(ledger);
        }

        const entryToday = ledger.days[ledgerDate];
        const openingAmount = entryToday ? Number(entryToday.opening) : NaN;
        const topUpAmount = entryToday ? num(entryToday.topUps) : 0;
        const closeAmount = Number.isFinite(balanceAmount) ? balanceAmount : (entryToday ? Number(entryToday.close) : NaN);
        const toppedUp = topUpAmount > 0.000001;
        // 闭账 = 开盘 + 充值 - 支出 => 支出 = 开盘 + 充值 - 闭账；充值经 topUps 加回，因此不丢金额
        let todaySpend = null;
        if (Number.isFinite(openingAmount) && Number.isFinite(closeAmount)) {
          todaySpend = Math.max(0, Math.round((openingAmount + topUpAmount - closeAmount) * 1000000) / 1000000);
        }
        const ledgerInfo = {
          date: ledgerDate,
          opening: Number.isFinite(openingAmount) ? openingAmount : null,
          close: Number.isFinite(closeAmount) ? closeAmount : null,
          todaySpend,
          toppedUp,
          topUpAmount: toppedUp ? topUpAmount : 0,
          spendAdjusted: toppedUp,
          currency,
          days: Object.keys(ledger.days).sort().slice(-30).map((date) => ({ date, ...ledger.days[date] }))
        };

        const todayKey = todayKeyEarly;

        const now = new Date();
        const series = [];
        for (let offset = 6; offset >= 0; offset--) {
          const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
          const key = localDayKey(d.getTime());
          const day = days.get(key) ?? emptyDay();
          series.push({ date: key, ...day });
        }

        let totals = emptyDay();
        for (const day of days.values()) {
          totals.calls += day.calls;
          totals.input += day.input;
          totals.output += day.output;
          totals.cacheRead += day.cacheRead;
          totals.cacheWrite += day.cacheWrite;
          totals.reasoning += day.reasoning;
          totals.cost += day.cost;
          totals.costUsd += day.costUsd;
        }

        sendJson(res, 200, {
          ok: true,
          balance,
          balanceError,
          currency,
          available: balance ? balance.is_available !== false : null,
          today,
          series,
          totals,
          unknownModels: [...unknownModels].sort(),
          pricingStatus: priceStatus,
          official,
          ledger: ledgerInfo,
          recharge: { url: RECHARGE_URL, usageUrl: USAGE_URL, label: "DeepSeek 官方充值" }
        });
      } catch (error) {
        console.error("[dsh-billing-dashboard] summary route failed:", error);
        sendJson(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }), "dsh-billing-dashboard: summary route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: TOKEN_ROUTE_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method", message: "仅支持 POST" });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { ok: false, error: "bad-json", message: "请求体不是合法 JSON" });
        return;
      }
      const token = body && typeof body.token === "string" ? body.token.trim() : "";
      if (token === "") {
        sendJson(res, 400, { ok: false, error: "empty", message: "token 不能为空" });
        return;
      }

      // 先校验再落库：拿新 token 调一次官方用量接口，避免把一个无效 token 覆盖进去。
      let data;
      try {
        data = await fetchPlatformUsage(token);
      } catch (error) {
        if (error && error.code === "expired") {
          sendJson(res, 400, { ok: false, error: "invalid", message: "官方 token 无效或已过期" });
        } else {
          sendJson(res, 502, { ok: false, error: "network", message: "无法连接 DeepSeek 平台，请稍后重试" });
        }
        return;
      }

      try {
        await ctx.credentials.set(PLATFORM_TOKEN_REF, token);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: "readonly",
          message: error instanceof Error ? error.message : "无法写入 token"
        });
        return;
      }

      // 立即用校验时拿到的数据填充缓存，让面板无需等待下一次轮询即显示官方数据。
      officialCache = { fetchedAt: Date.now(), status: "ok", todayCost: data.todayCost, history: data.history };
      lastOfficialCheckDay = localDayKey(Date.now());
      sendJson(res, 200, { ok: true, status: "ok" });
    }
  }), "dsh-billing-dashboard: token route");
}

export { name, inject, apply };
