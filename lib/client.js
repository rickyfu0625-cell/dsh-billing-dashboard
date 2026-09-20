// dsh-billing-dashboard — 浏览器半。
// 可拖拽的常驻悬浮胶囊：收起时只显示余额 + 刷新按钮；点击展开完整面板
// （余额明细、今日消费/token、近 7 日消费趋势、一键充值 / 用量明细、中英切换）。
// 语言默认跟随 DeepSeek Harness 的 locale，可在面板手动切换并持久化。
// 仅使用 `--dsw-*` 主题变量，自动跟随亮/暗色。

window.__ModuleLoader__.load({
	id: "dsh-billing-dashboard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useRef, useCallback } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		// ---- 常量 -------------------------------------------------
		const SUMMARY_PATH = "/api/billing-dashboard/summary";
		const TOKEN_PATH = "/api/billing-dashboard/token";
		const POLL_MS = 30 * 1000;
		const POS_KEY = "dsh-billing-dashboard:pos";
		const SOURCE_KEY = "dsh-billing-dashboard:source";

		const STRINGS = {
			zh: {
				title: "DeepSeek 用量看板",
				balance: "余额",
				currentBalance: "当前余额",
				notConfigured: "未配置",
				notConfiguredKey: "（未配置 API 密钥）",
				available: "总余额",
				toppedUp: "充值",
				granted: "赠送",
				todayCost: "今日消费",
				official: "官方",
				estimate: "估算",
				todayTokens: "今日 token",
				input: "输入",
				output: "输出",
				cacheHit: "缓存命中",
				trend: "近 {n} 日消费趋势",
				trendNote: "按本地会话日志估算",
				trendNoteOfficial: "官方账单口径",
				recharge: "去充值",
				usage: "用量明细",
				refresh: "刷新",
				priceInSync: "价格与官方一致",
				priceUpdated: "已同步最新官方价格",
				priceUnavailable: "官方价格同步失败，暂用内置价格快照",
				unknownModels: "检测到非 DeepSeek 官方模型，暂不支持该模型的消费统计：",
				note: "余额为官方实时数据；「今日消费」优先取当日官方 token 按官方单价折算，缺失时回退本地日志估算；非官方模型不计入消费。最终以平台账单为准。",
				togglePanel: "切换用量看板",
				close: "关闭",
				chartAria: "近 {n} 日消费趋势",
				source: "数据来源",
				tokenExpired: "官方token已失效",
				tokenExpiredHint: "官方 token 已失效，请更新后重新使用官方数据。",
				updateToken: "更新官方 token",
				tokenPlaceholder: "粘贴 platform.deepseek.com 的 userToken",
				tokenHelper: "登录 platform.deepseek.com 后，在 DevTools Console 执行 JSON.parse(localStorage.getItem('userToken')).value 即可获得。",
				save: "保存",
				cancel: "取消",
				tokenSaved: "官方 token 已更新",
				tokenInvalid: "官方 token 无效或已过期",
				tokenEmpty: "token 不能为空",
				tokenUpdateFailed: "更新失败，请稍后重试"
			},
			en: {
				title: "DeepSeek Usage",
				balance: "Balance",
				currentBalance: "Current balance",
				notConfigured: "Not set",
				notConfiguredKey: "(no API key)",
				available: "Total",
				toppedUp: "Top-up",
				granted: "Granted",
				todayCost: "Today cost",
				official: "Official",
				estimate: "Estimate",
				todayTokens: "Today tokens",
				input: "Input",
				output: "Output",
				cacheHit: "Cache hit",
				trend: "{n}-day cost trend",
				trendNote: "Estimated from local session logs",
				trendNoteOfficial: "Official billing",
				recharge: "Top up",
				usage: "Usage details",
				refresh: "Refresh",
				priceInSync: "Pricing in sync with official",
				priceUpdated: "Synced latest official pricing",
				priceUnavailable: "Price sync failed — using built-in snapshot",
				unknownModels: "Non-DeepSeek models detected — cost stats for this model are not supported:",
				note: "Balance is live official data. Today's cost converts the official token counts with the official price table, falling back to local-log estimation when unavailable; non-official models are excluded. Final billing is on the platform.",
				togglePanel: "Toggle usage panel",
				close: "Close",
				chartAria: "{n}-day cost trend",
				source: "Data source",
				tokenExpired: "Official token expired",
				tokenExpiredHint: "Official token has expired — update it to use official data.",
				updateToken: "Update official token",
				tokenPlaceholder: "Paste the userToken from platform.deepseek.com",
				tokenHelper: "Sign in to platform.deepseek.com, then run JSON.parse(localStorage.getItem('userToken')).value in the DevTools Console.",
				save: "Save",
				cancel: "Cancel",
				tokenSaved: "Official token updated",
				tokenInvalid: "Official token is invalid or expired",
				tokenEmpty: "Token cannot be empty",
				tokenUpdateFailed: "Update failed, please try again later"
			}
		};

		// ---- 小工具 ------------------------------------------------
		function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}
		function formatBalance(value, currency) {
			const symbol = currencySymbol(currency);
			const n = Number(value);
			if (!Number.isFinite(n)) return `${symbol}—`;
			return `${symbol}${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;
		}
		function formatCost(value, currency) {
			const symbol = currencySymbol(currency);
			if (!Number.isFinite(value) || value <= 0) return `${symbol}0`;
			if (value >= 100) return `${symbol}${value.toFixed(0)}`;
			if (value >= 1) return `${symbol}${value.toFixed(2)}`;
			if (value >= 0.01) return `${symbol}${value.toFixed(3)}`;
			return `${symbol}${value.toPrecision(2)}`;
		}
		function formatTokens(value) {
			const n = Number(value);
			if (!Number.isFinite(n)) return "—";
			if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
			if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
			return Math.round(n).toLocaleString();
		}
		function dayLabel(dateKey) {
			return typeof dateKey === "string" && dateKey.length >= 10 ? dateKey.slice(5) : dateKey;
		}
		function dayTokens(day) {
			if (!day) return 0;
			return (Number(day.input) || 0) + (Number(day.output) || 0) + (Number(day.cacheRead) || 0) + (Number(day.cacheWrite) || 0) + (Number(day.reasoning) || 0);
		}

		// ---- 主题样式 ----------------------------------------------
		const font = { fontFamily: "var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)" };
		const label = { color: "var(--dsw-alias-label-secondary)", fontWeight: 400 };
		const value = { color: "var(--dsw-alias-label-primary)", fontWeight: 600 };
		const divider = { height: 1, background: "var(--dsw-alias-border-l2)" };

		const panelStyle = {
			...font,
			boxSizing: "border-box",
			width: 360,
			maxWidth: "calc(100vw - 24px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 8px 30px rgba(0, 0, 0, 0.2)",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)"
		};
		const rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px" };

		const btnStyle = {
			...font,
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 4,
			flex: 1,
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 8,
			background: "var(--dsw-alias-bg-base, rgba(127,127,127,.08))",
			color: "var(--dsw-alias-label-primary)",
			padding: "8px 10px",
			fontSize: 13,
			cursor: "pointer",
			textDecoration: "none",
			textAlign: "center"
		};
		const btnPrimaryStyle = {
			...btnStyle,
			background: "var(--dsw-alias-accent-primary, #4f7cff)",
			borderColor: "var(--dsw-alias-accent-primary, #4f7cff)",
			color: "#fff"
		};

		// ---- 7 日趋势图 --------------------------------------------
		function TrendChart({ series, currency, ariaLabel, lang }) {
			const points = Array.isArray(series) ? series : [];
			if (points.length === 0) {
				return jsx("div", { style: { display: "grid", placeItems: "center", minHeight: 120, color: "var(--dsw-alias-label-secondary)", fontSize: 12 }, children: "—" });
			}
			const width = 320, height = 140, top = 20, bottom = 24, inset = 8;
			const plotHeight = height - top - bottom;
			const plotWidth = width - inset * 2;
			const baseline = top + plotHeight;
			const max = Math.max(...points.map((p) => Number(p.cost) || 0), 0.01);
			const pts = points.map((p, i) => {
				const x = points.length === 1 ? width / 2 : inset + (i / (points.length - 1)) * plotWidth;
				const y = baseline - ((Number(p.cost) || 0) / max) * plotHeight;
				return { ...p, x, y };
			});
			const linePoints = pts.map((p) => `${p.x},${p.y}`).join(" ");
			const areaPoints = `${pts[0].x},${baseline} ${linePoints} ${pts[pts.length - 1].x},${baseline}`;
			// 日期轴按宽度抽稀：点数多时每隔几根显示一个日期，首尾必显示
			const labelStep = Math.max(1, Math.ceil(points.length / 7));
			const showDate = (i) => i === 0 || i === points.length - 1 || i % labelStep === 0;
			return jsx("svg", {
				viewBox: `0 0 ${width} ${height}`,
				role: "img",
				"aria-label": ariaLabel,
				style: { display: "block", width: "100%", height: 140 },
				children: jsxs(Fragment, { children: [
					jsx("line", { x1: inset, y1: baseline, x2: width - inset, y2: baseline, stroke: "var(--dsw-alias-border-l2)" }),
					jsx("polygon", { points: areaPoints, fill: "var(--dsw-alias-accent-primary, #4f7cff)", fillOpacity: 0.1 }),
					jsx("polyline", { points: linePoints, fill: "none", stroke: "var(--dsw-alias-accent-primary, #4f7cff)", strokeWidth: 2.5, strokeLinejoin: "round", strokeLinecap: "round" }),
					...pts.map((p, i) => jsxs("g", { key: p.date, children: [
						jsx("title", { children: `${p.date}${lang === "en" ? ": " : "："}${formatCost(Number(p.cost) || 0, currency)}` }),
						jsx("text", { x: p.x, y: Math.max(10, p.y - 7), textAnchor: "middle", fill: "var(--dsw-alias-label-primary)", fontSize: 10, fontWeight: 600, children: formatCost(Number(p.cost) || 0, currency) }),
						jsx("circle", { cx: p.x, cy: p.y, r: 3, fill: "var(--dsw-alias-bg-overlay)", stroke: "var(--dsw-alias-accent-primary, #4f7cff)", strokeWidth: 2 }),
						showDate(i) ? jsx("text", { x: p.x, y: height - 6, textAnchor: "middle", fill: "var(--dsw-alias-label-secondary)", fontSize: 10, children: dayLabel(p.date) }) : null
					] }))
				] })
			});
		}

		// ---- 跟随 harness 语言 --------------------------------------
		function useHarnessLocale(locale) {
			const [lang, setLang] = useState(() => (locale && typeof locale.getSnapshot === "function" ? locale.getSnapshot().active : "zh"));
			useEffect(() => {
				if (!locale || typeof locale.subscribe !== "function") return undefined;
				const unsub = locale.subscribe(() => setLang(locale.getSnapshot().active));
				return unsub;
			}, [locale]);
			return lang;
		}

		function loadPos() {
			try {
				const raw = globalThis.localStorage && globalThis.localStorage.getItem(POS_KEY);
				if (!raw) return null;
				const p = JSON.parse(raw);
				if (!(p && Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
				// 首次挂载即把持久化坐标钳制回当前视口：上次在大窗口/大屏拖到的
				// 位置在更小的窗口里会落到屏外，若不在此钳制，悬浮球加载后不可见。
				if (typeof window === "undefined") return p;
				const w = 200, h = 40;
				return {
					x: Math.max(0, Math.min(p.x, window.innerWidth - w)),
					y: Math.max(0, Math.min(p.y, window.innerHeight - h))
				};
			} catch {}
			return null;
		}

		function loadSourceMode() {
			try {
				const v = globalThis.localStorage && globalThis.localStorage.getItem(SOURCE_KEY);
				if (v === "official" || v === "estimate") return v;
			} catch {}
			return "official";
		}

		// ---- 看板组件 ----------------------------------------------
		function makeDashboard(locale) {
			function Dashboard() {
				const [data, setData] = useState(null);
				const [open, setOpen] = useState(false);
				const [phase, setPhase] = useState("loading");
				const [refreshing, setRefreshing] = useState(false);
				const [pos, setPos] = useState(loadPos);
				const [sourceMode, setSourceMode] = useState(loadSourceMode);
				const [tokenUi, setTokenUi] = useState("closed");
				const [tokenValue, setTokenValue] = useState("");
				const [tokenBusy, setTokenBusy] = useState(false);
				const [tokenMsg, setTokenMsg] = useState(null);
				const mounted = useRef(true);
				const dataRef = useRef(null);
				const dockRef = useRef(null);
				const panelRef = useRef(null);
				const dragRef = useRef(null);
				const suppressClickRef = useRef(false);

				const harnessLang = useHarnessLocale(locale);
				const lang = harnessLang === "en" ? "en" : "zh";
				const t = (k, vars) => {
					const raw = (STRINGS[lang] && STRINGS[lang][k]) || STRINGS.zh[k] || k;
					if (vars === void 0 || raw.indexOf("{") < 0) return raw;
					return raw.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === void 0 ? whole : String(vars[name])));
				};

				const load = useCallback(async (force) => {
					if (typeof document !== "undefined" && document.hidden) return;
					try {
						const res = await fetch(force ? `${SUMMARY_PATH}?force=1` : SUMMARY_PATH, { cache: "no-store" });
						const body = await res.json();
						if (!mounted.current) return;
						dataRef.current = body;
						setData(body);
						setPhase("ready");
						setRefreshing(false);
					} catch {
						if (!mounted.current) return;
						if (!dataRef.current) setPhase("error");
						setRefreshing(false);
					}
				}, []);

				useEffect(() => {
					mounted.current = true;
					load(false);
					const timer = setInterval(() => load(false), POLL_MS);
					const onVisible = () => { if (!document.hidden) load(false); };
					document.addEventListener("visibilitychange", onVisible);
					return () => {
						mounted.current = false;
						clearInterval(timer);
						document.removeEventListener("visibilitychange", onVisible);
					};
				}, [load]);

				const applySourceMode = (mode) => {
					setSourceMode(mode);
					try { globalThis.localStorage && globalThis.localStorage.setItem(SOURCE_KEY, mode); } catch {}
				};

				const submitToken = async () => {
					const value = tokenValue.trim();
					if (value === "") {
						setTokenMsg({ kind: "err", text: t("tokenEmpty") });
						return;
					}
					setTokenBusy(true);
					setTokenMsg(null);
					try {
						const res = await fetch(TOKEN_PATH, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ token: value })
						});
						const body = await res.json().catch(() => null);
						if (res.ok && body && body.ok) {
							setTokenMsg({ kind: "ok", text: t("tokenSaved") });
							setTokenValue("");
							setTokenUi("closed");
							applySourceMode("official");
							load(true);
						} else {
							let msg = t("tokenUpdateFailed");
							if (body && body.error === "invalid") msg = t("tokenInvalid");
							else if (body && body.error === "empty") msg = t("tokenEmpty");
							else if (body && body.error === "network") msg = t("tokenUpdateFailed");
							else if (body && body.message) msg = body.message;
							setTokenMsg({ kind: "err", text: msg });
						}
					} catch {
						setTokenMsg({ kind: "err", text: t("tokenUpdateFailed") });
					} finally {
						setTokenBusy(false);
					}
				};

				// 展开时点击面板/胶囊之外 → 收起
				useEffect(() => {
					if (!open) return undefined;
					const onDocPointerDown = (e) => {
						const target = e.target;
						const inPanel = panelRef.current && panelRef.current.contains(target);
						const inDock = dockRef.current && dockRef.current.contains(target);
						if (!inPanel && !inDock) setOpen(false);
					};
					document.addEventListener("pointerdown", onDocPointerDown);
					return () => document.removeEventListener("pointerdown", onDocPointerDown);
				}, [open]);

				const payload = data && data.balance ? data.balance : null;
				const info = payload && Array.isArray(payload.balance_infos)
					? payload.balance_infos.reduce((best, b) => {
						if (b === null || typeof b !== "object") return best;
						if (best === null) return b;
						return (Number(b.total_balance) || 0) > (Number(best.total_balance) || 0) ? b : best;
					}, null)
					: null;
				const currency = (data && data.currency) || (info && info.currency) || "CNY";
				const totalBalance = info ? Number(info.total_balance) : NaN;
				const today = data && data.today ? data.today : null;
				const series = data && Array.isArray(data.series) ? data.series : [];
				const totals = data && data.totals ? data.totals : null;
				const official = data && data.official && typeof data.official === "object" ? data.official : null;
				const recharge = data && data.recharge ? data.recharge : { url: "https://platform.deepseek.com/top_up", usageUrl: "https://platform.deepseek.com/usage" };
				const balanceError = data && data.balanceError ? data.balanceError : null;
				const pricingStatus = data && data.pricingStatus ? data.pricingStatus : null;
				const unknownModels = data && Array.isArray(data.unknownModels) ? data.unknownModels : [];

				const isUsd = currency === "USD";
				const estCost = (day) => (day ? (isUsd ? (Number(day.costUsd) || 0) : (Number(day.cost) || 0)) : 0);
				const offTodayCost = official && official.todayCost !== null && official.todayCost !== undefined ? Number(official.todayCost) : null;
				const officialStatus = official ? official.status : "unset";
				const officialOk = officialStatus === "ok" && offTodayCost !== null;
				// 数据来源切换：估算模式强制走估算；官方模式在官方数据可用时用官方，否则回退估算。
				const useOfficial = sourceMode === "official" && officialOk;
				const costSource = useOfficial ? "official" : "estimate";
				const tokenExpired = sourceMode === "official" && officialStatus === "expired";

				const todayTokens = dayTokens(today);
				const todayCost = useOfficial ? offTodayCost : estCost(today);

				// 趋势：仅在使用官方源时用官方逐日消费覆盖估算值
				const offMap = {};
				if (useOfficial && official && Array.isArray(official.history)) {
					for (const h of official.history) if (h && typeof h.date === "string") offMap[h.date] = h.cost;
				}
				// å®˜æ–¹ç”¨é‡æŽ¥å£åªç»™æœ¬æœˆæ•°æ®ï¼šæœˆåˆæ—¶æŠŠä¸Šä¸€æœŸæœ€åŽä¸€ä¸ªå®Œæ•´æ—¥çš„é‡‘é¢å‘å‰å›žå¡«ï¼Œ
				// è®©è¶‹åŠ¿å›¾è·¨æœˆä¸æ–­æ¡£ï¼ˆæ³¨æ„åˆ«å›žå¡«ã€Œä»Šå¤©ã€ï¼Œé‚£ä¼šæŠŠä»Šæ—¥æ¶ˆè´¹æå‰å†™æˆä¸Šä¸€æœŸé‡‘é¢ï¼‰ã€‚
				if (useOfficial) {
					const keys = Object.keys(offMap).sort();
					const todayKey = series.length > 0 ? series[series.length - 1].date : "";
					const done = keys.filter((k) => k < todayKey);
					if (done.length > 0) {
						const carry = offMap[done[done.length - 1]];
						if (Number.isFinite(Number(carry))) {
							for (const s of series) if (offMap[s.date] === undefined && s.date < done[0]) offMap[s.date] = carry;
						}
					}
				}
				const trendSeries = series.map((s) => {
					const off = offMap[s.date];
					const cost = off !== undefined && Number.isFinite(Number(off)) ? Number(off) : estCost(s);
					return { date: s.date, cost };
				});

				const balanceText = phase === "error" ? "—" : balanceError ? t("notConfigured") : formatBalance(totalBalance, currency);
				const low = Number.isFinite(totalBalance) && totalBalance < 5;

				const pricingMsg = pricingStatus
					? (pricingStatus.status === "updated" ? t("priceUpdated") : pricingStatus.status === "unavailable" ? t("priceUnavailable") : t("priceInSync"))
					: "";

				const sourceBadge = tokenExpired
					? { text: t("tokenExpired"), bg: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)", color: "var(--dsw-alias-state-error-primary)" }
					: useOfficial
						? { text: t("official"), bg: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent)", color: "var(--dsw-alias-state-success-primary)" }
						: { text: t("estimate"), bg: "var(--dsw-alias-bg-base, rgba(127,127,127,.08))", color: "var(--dsw-alias-label-secondary)" };

				// ---- 拖拽 ----
				const onPointerDown = (e) => {
					if (e.target && e.target.closest && e.target.closest("[data-nodrag]")) return;
					const el = dockRef.current;
					if (!el) return;
					const rect = el.getBoundingClientRect();
					dragRef.current = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false, pid: e.pointerId };
					try { el.setPointerCapture(e.pointerId); } catch {}
				};
				const onPointerMove = (e) => {
					const d = dragRef.current;
					if (!d || d.pid !== e.pointerId) return;
					const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
					if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
					if (!d.moved) return;
					const el = dockRef.current;
					const maxX = window.innerWidth - (el ? el.offsetWidth : 200);
					const maxY = window.innerHeight - (el ? el.offsetHeight : 40);
					setPos({ x: Math.max(0, Math.min(maxX, d.ox + dx)), y: Math.max(0, Math.min(maxY, d.oy + dy)) });
				};
				const onPointerUp = () => {
					const d = dragRef.current;
					if (d && d.moved) {
						suppressClickRef.current = true;
						setTimeout(() => { suppressClickRef.current = false; }, 0);
						try { globalThis.localStorage && globalThis.localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
					}
					dragRef.current = null;
				};
				const onDockClick = () => {
					if (suppressClickRef.current) return;
					setOpen((v) => !v);
				};

				// 窗口缩放时把悬浮球钳制回视口内，避免被拖到边缘后缩窗导致不可见
				useEffect(() => {
					const clampToViewport = () => {
						setPos((prev) => {
							if (!prev) return prev;
							const el = dockRef.current;
							const w = el ? el.offsetWidth : 200;
							const h = el ? el.offsetHeight : 40;
							const x = Math.max(0, Math.min(prev.x, window.innerWidth - w));
							const y = Math.max(0, Math.min(prev.y, window.innerHeight - h));
							return (x === prev.x && y === prev.y) ? prev : { x, y };
						});
					};
					clampToViewport();
					window.addEventListener("resize", clampToViewport);
					return () => window.removeEventListener("resize", clampToViewport);
				}, []);

				const dockPosition = pos ? { left: pos.x, top: pos.y } : { right: 16, bottom: 16 };

				function computePanelStyle() {
					const el = dockRef.current;
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					const pw = Math.min(360, Math.max(160, vw - 24));
					const margin = 12;
					const gap = 8;
					const style = { position: "fixed", width: pw, zIndex: 2147483000, pointerEvents: "auto" };
					if (!el) {
						style.right = margin;
						style.bottom = 56;
						style.maxHeight = vh - 56 - margin;
						return style;
					}
					const r = el.getBoundingClientRect();
					let left = r.right - pw;
					if (left < margin) left = r.left;
					left = Math.max(margin, Math.min(left, vw - pw - margin));
					style.left = left;
					const spaceUp = r.top - margin;
					const spaceDown = vh - r.bottom - margin;
					if (spaceUp >= spaceDown) {
						style.bottom = vh - r.top + gap;
						style.maxHeight = Math.max(120, spaceUp);
					} else {
						style.top = r.bottom + gap;
						style.maxHeight = Math.max(120, spaceDown);
					}
					return style;
				}

				return jsxs(Fragment, { children: [
						open && jsxs("div", { ref: panelRef, style: { ...panelStyle, overflowY: "auto", ...computePanelStyle() }, children: [
							jsxs("div", { style: { ...rowStyle, padding: "12px 14px" }, children: [
								jsx("div", { style: { fontSize: 14, fontWeight: 600 }, children: t("title") }),
								jsx("button", { type: "button", onClick: () => setOpen(false), "aria-label": t("close"), style: { border: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", fontSize: 16, cursor: "pointer", padding: "0 2px", lineHeight: 1 }, children: "×" })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { padding: "14px" }, children: [
								jsx("div", { style: { ...label, fontSize: 11 }, children: t("balance") }),
								jsxs("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }, children: [
									jsx("span", { style: { fontSize: 26, fontWeight: 700, color: low ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }, children: balanceText }),
									balanceError && jsx("span", { style: { ...label, fontSize: 11 }, children: t("notConfiguredKey") })
								] }),
								info && jsxs("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 11, ...label }, children: [
									jsxs("span", { children: [t("available"), " ", jsx("strong", { style: value, children: formatBalance(info.total_balance, currency) })] }),
									jsxs("span", { children: [t("toppedUp"), " ", jsx("strong", { style: value, children: formatBalance(info.topped_up_balance, currency) })] }),
									jsxs("span", { children: [t("granted"), " ", jsx("strong", { style: value, children: formatBalance(info.granted_balance, currency) })] })
								] })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { padding: "12px 14px" }, children: [
								jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }, children: [
									jsx("span", { style: { ...label, fontSize: 11 }, children: t("source") }),
									jsxs("div", { style: { display: "inline-flex", borderRadius: 8, overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2)" }, children: [
										jsx("button", {
											type: "button",
											onClick: () => applySourceMode("official"),
											style: { ...font, border: 0, background: sourceMode === "official" ? "var(--dsw-alias-accent-primary, #4f7cff)" : "transparent", color: sourceMode === "official" ? "#fff" : "var(--dsw-alias-label-secondary)", padding: "4px 10px", fontSize: 12, cursor: "pointer" },
											children: t("official")
										}),
										jsx("button", {
											type: "button",
											onClick: () => applySourceMode("estimate"),
											style: { ...font, border: 0, background: sourceMode === "estimate" ? "var(--dsw-alias-accent-primary, #4f7cff)" : "transparent", color: sourceMode === "estimate" ? "#fff" : "var(--dsw-alias-label-secondary)", padding: "4px 10px", fontSize: 12, cursor: "pointer" },
											children: t("estimate")
										})
									] })
								] }),
								tokenExpired && jsx("div", { style: { marginTop: 8, fontSize: 11, lineHeight: 1.5, color: "var(--dsw-alias-state-error-primary)" }, children: t("tokenExpiredHint") }),
								jsxs("div", { style: { display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }, children: [
									tokenUi === "open"
										? jsxs(Fragment, { children: [
											jsx("input", {
												type: "password",
												value: tokenValue,
												onChange: (e) => setTokenValue(e.target.value),
												placeholder: t("tokenPlaceholder"),
												autoComplete: "off",
												spellCheck: false,
												style: { ...font, flex: "1 1 100%", boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, background: "var(--dsw-alias-bg-base, rgba(127,127,127,.08))", color: "var(--dsw-alias-label-primary)", padding: "7px 10px", fontSize: 12 }
											}),
											jsxs("div", { style: { display: "flex", gap: 8 }, children: [
												jsx("button", { type: "button", onClick: submitToken, disabled: tokenBusy, style: { ...btnPrimaryStyle, flex: "0 0 auto", padding: "6px 12px" }, children: tokenBusy ? "…" : t("save") }),
												jsx("button", { type: "button", onClick: () => { setTokenUi("closed"); setTokenMsg(null); }, disabled: tokenBusy, style: { ...btnStyle, flex: "0 0 auto", padding: "6px 12px" }, children: t("cancel") })
											] })
										] })
										: jsx("button", { type: "button", onClick: () => { setTokenUi("open"); setTokenMsg(null); }, style: btnStyle, children: t("updateToken") })
								] }),
								tokenUi === "open" && jsx("div", { style: { marginTop: 6, fontSize: 10.5, lineHeight: 1.4, color: "var(--dsw-alias-label-secondary)" }, children: t("tokenHelper") }),
								tokenMsg && jsx("div", { style: { marginTop: 6, fontSize: 11, color: tokenMsg.kind === "ok" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" }, children: tokenMsg.text })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { padding: "12px 14px" }, children: [
								jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }, children: [
									jsxs("span", { style: { ...label, fontSize: 11, display: "inline-flex", alignItems: "center", gap: 5 }, children: [
										t("todayCost"),
										jsx("span", { style: { borderRadius: 4, padding: "0 5px", fontSize: 10, fontWeight: 600, background: sourceBadge.bg, color: sourceBadge.color }, children: sourceBadge.text })
									] }),
									jsx("span", { style: { ...value, fontSize: 16, fontVariantNumeric: "tabular-nums" }, children: formatCost(todayCost, currency) })
								] }),
								jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6 }, children: [
									jsx("span", { style: { ...label, fontSize: 11 }, children: t("todayTokens") }),
									jsx("span", { style: value, children: formatTokens(todayTokens) })
								] }),
								jsxs("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 11, ...label }, children: [
									jsxs("span", { children: [t("input"), " ", jsx("strong", { style: value, children: formatTokens(today ? today.input : 0) })] }),
									jsxs("span", { children: [t("output"), " ", jsx("strong", { style: value, children: formatTokens(today ? today.output : 0) })] }),
									jsxs("span", { children: [t("cacheHit"), " ", jsx("strong", { style: value, children: formatTokens(today ? today.cacheRead : 0) })] })
								] })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { padding: "12px 14px 6px" }, children: [
								jsx("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 2 }, children: t("trend", { n: trendSeries.length }) }),
								jsx("div", { style: { ...label, fontSize: 11, marginBottom: 6 }, children: costSource === "official" ? t("trendNoteOfficial") : t("trendNote") }),
								jsx(TrendChart, { series: trendSeries, currency, ariaLabel: t("chartAria", { n: trendSeries.length }), lang })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { display: "flex", gap: 8, padding: 12 }, children: [
								jsx("a", { href: recharge.url, target: "_blank", rel: "noreferrer", style: btnPrimaryStyle, children: `${t("recharge")} ↗` }),
								jsx("a", { href: recharge.usageUrl, target: "_blank", rel: "noreferrer", style: btnStyle, children: `${t("usage")} ↗` })
							] }),

							unknownModels.length > 0 && jsxs("div", { style: { padding: "0 14px 12px", fontSize: 11, lineHeight: 1.5, color: "var(--dsw-alias-state-warn-primary)" }, children: `${t("unknownModels")} ${unknownModels.join(lang === "en" ? ", " : "、")}` }),

							jsx("div", { style: { padding: "0 14px 12px", fontSize: 10.5, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)" }, children: jsxs(Fragment, { children: [
								pricingMsg && jsx("div", { style: { color: pricingStatus && pricingStatus.status === "updated" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-secondary)", marginBottom: 4 }, children: pricingMsg }),
								jsx("div", { children: t("note") })
							] }) })
						] }),

						jsx("div", {
							ref: dockRef,
							role: "button",
							tabIndex: 0,
							"aria-label": t("togglePanel"),
							onPointerDown: onPointerDown,
							onPointerMove: onPointerMove,
							onPointerUp: onPointerUp,
							onClick: onDockClick,
							onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } },
							style: {
								...font,
								position: "fixed",
								...dockPosition,
								zIndex: 2147483000,
								boxSizing: "border-box",
								display: "inline-flex",
								alignItems: "center",
								gap: 8,
								maxWidth: "min(320px, calc(100vw - 24px))",
								borderRadius: 10,
								border: "1px solid var(--dsw-alias-border-l2)",
								background: "var(--dsw-alias-bg-overlay)",
								boxShadow: "0 2px 10px rgba(0, 0, 0, 0.16)",
								padding: "6px 8px 6px 12px",
								color: "var(--dsw-alias-label-secondary)",
								fontSize: 12,
								lineHeight: "18px",
								fontVariantNumeric: "tabular-nums",
								whiteSpace: "nowrap",
								userSelect: "none",
								cursor: "grab",
								pointerEvents: "auto",
								touchAction: "none"
							},
							children: jsxs(Fragment, { children: [
								jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 3 }, children: [
									jsxs("div", { style: { display: "flex", alignItems: "baseline", gap: 6 }, children: [
										jsx("span", { style: { ...label, fontSize: 11 }, children: t("todayCost") }),
										jsx("strong", { style: { ...value, fontSize: 12 }, children: formatCost(todayCost, currency) })
									] }),
									jsxs("div", { style: { display: "flex", alignItems: "baseline", gap: 6 }, children: [
										jsx("span", { style: { ...label, fontSize: 11 }, children: t("currentBalance") }),
										jsx("strong", { style: { ...value, fontSize: 12, color: low ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-primary)" }, children: balanceText })
									] })
								] }),
								jsx("button", {
									type: "button",
									"data-nodrag": "true",
									"aria-label": t("refresh"),
									title: t("refresh"),
									onClick: (e) => { e.stopPropagation(); setRefreshing(true); load(true); },
									style: {
										border: 0,
										background: "transparent",
										color: "var(--dsw-alias-label-secondary)",
										fontSize: 14,
										lineHeight: 1,
										cursor: "pointer",
										padding: "2px",
										borderRadius: "50%"
									},
									children: refreshing ? "⏳" : "↻"
								})
							] })
						})
					] });
			}
			return Dashboard;
		}

		// ---- 客户端插件主体 ----------------------------------------
		const inject = ["slots", "locale"];

		function apply(ctx) {
			const locale = ctx.locale;
			const Dashboard = makeDashboard(locale);
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "billing-dashboard",
				order: 900
			}, Dashboard));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
