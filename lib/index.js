/**
 * dsh-billing-dashboard — Host 半（自包含，零外部依赖）。
 *
 * 通过 dsh web server 注册一个 JSON 路由：
 *
 *   GET /api/billing-dashboard/summary
 *
 * 返回：
 *   - balance：DeepSeek 官方余额（`/user/balance`，实时准确，需 DEEPSEEK_API_KEY）
 *   - today：今日 token 消耗（输入/输出/缓存命中/缓存写入/推理）与今日消费（按官方价格估算）
 *   - series：最近 7 天逐日 token 与消费（用于趋势图）
 *   - totals：全量累计
 *   - recharge：官方充值 / 用量明细页链接
 *
 * 数据来源：
 *   - 余额：官方 `/user/balance`（DEEPSEEK_API_KEY，复用 DSH 凭据层，密钥不出 Host）
 *   - token / 消费：本地会话日志（sessionPersistence）回放所有 `assistant/message`
 *     事件，用官方价格引擎（含峰谷与缓存命中价）把 token 折算成人民币/美元。
 *     消费为「估算」口径，明确标注；最终以平台账单为准。
 *
 * 价格引擎移植自 bpc-oss/dsh-web-billing（MIT），价格表策展自 DeepSeek 官方定价页。
 */

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

function priceAt(model, timeMs) {
  const peak = isPeak(timeMs);
  const applicable = OFFICIAL_PRICING_POLICIES.filter((policy) => timeMs >= Date.parse(policy.since));
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
  const unit = named ? priceFor(model, baseTable) : priceFor(model, baseTable);
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

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

/** 取 primary 余额条目：DeepSeek 的 balance_infos 顺序不稳定，取 total_balance 最大者。 */
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
  let days = new Map();          // "YYYY-MM-DD" -> day aggregate
  let lastScanAt = 0;
  let scanPromise = null;
  let balanceCache = { fetchedAt: 0, payload: null };
  let disposed = false;

  async function scanAll() {
    const next = new Map();
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
        if (ev === null || typeof ev !== "object" || ev.type !== "assistant/message") continue;
        const data = ev.data;
        const usage = data && data.usage;
        if (usage === void 0 || usage === null) continue;
        const tokens = num(usage.inputTokens) + num(usage.outputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.reasoningTokens);
        if (tokens <= 0) continue;
        const source = data.message && data.message.source;
        const model = source && typeof source.model === "string" && source.model !== "" ? source.model : "unknown";
        const timeMs = typeof ev.time === "number" ? ev.time : Date.now();
        const unit = priceAt(model, timeMs);
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
    }
    return next;
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

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (_req, res) => {
      try {
        if (Date.now() - lastScanAt > SCAN_CACHE_MS) await refreshDays();

        let balance = balanceCache.payload;
        let balanceError = null;
        if (Date.now() - balanceCache.fetchedAt > BALANCE_CACHE_MS) {
          const result = await fetchBalance();
          if (result.ok) {
            balanceCache = { fetchedAt: Date.now(), payload: result.balance };
            balance = result.balance;
          } else {
            balanceError = result;
          }
        }

        const info = primaryBalanceInfo(balance);
        const currency = info && typeof info.currency === "string" ? info.currency : "CNY";

        const todayKey = localDayKey(Date.now());
        const today = days.get(todayKey) ?? emptyDay();

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
          scan: { sessionCount: 0, updatedAt: lastScanAt },
          recharge: { url: RECHARGE_URL, usageUrl: USAGE_URL, label: "DeepSeek 官方充值" },
          note: "余额为官方实时数据；「消费」按官方价格（含峰谷与缓存命中价）对本地会话日志折算估算，最终以平台账单为准。"
        });
      } catch (error) {
        console.error("[dsh-billing-dashboard] summary route failed:", error);
        sendJson(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }), "dsh-billing-dashboard: summary route");
}

export { name, inject, apply };
