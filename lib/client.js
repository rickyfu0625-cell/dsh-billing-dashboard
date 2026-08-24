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
		const POLL_MS = 30 * 1000;
		const LANG_KEY = "dsh-billing-dashboard:lang";
		const POS_KEY = "dsh-billing-dashboard:pos";

		const STRINGS = {
			zh: {
				title: "DeepSeek 用量看板",
				balance: "余额",
				notConfigured: "未配置",
				notConfiguredKey: "（未配置 API Key）",
				available: "可用",
				toppedUp: "充值",
				granted: "赠送",
				todayCost: "今日消费（估算）",
				todayTokens: "今日 token",
				input: "输入",
				output: "输出",
				cacheHit: "缓存命中",
				trend: "近 7 日消费趋势",
				trendNote: "按本地会话日志估算",
				recharge: "去充值",
				usage: "用量明细",
				refresh: "刷新",
				priceInSync: "价格与官方一致",
				priceUpdated: "已同步最新官方价格",
				priceUnavailable: "官方价格同步失败，暂用内置价格快照",
				unknownModels: "检测到非 DeepSeek 官方模型，暂不支持该模型计费统计：",
				note: "余额为官方实时数据；消费为按官方价格对本地会话日志折算的估算值，最终以 DeepSeek 平台账单为准。",
				togglePanel: "切换用量看板",
				close: "关闭",
				langLabel: "EN",
				chartAria: "近 7 日消费趋势"
			},
			en: {
				title: "DeepSeek Usage",
				balance: "Balance",
				notConfigured: "Not set",
				notConfiguredKey: "(no API key)",
				available: "Available",
				toppedUp: "Top-up",
				granted: "Granted",
				todayCost: "Today (est.)",
				todayTokens: "Today tokens",
				input: "Input",
				output: "Output",
				cacheHit: "Cache hit",
				trend: "7-day cost trend",
				trendNote: "Estimated from local session logs",
				recharge: "Top up",
				usage: "Usage details",
				refresh: "Refresh",
				priceInSync: "Pricing in sync with official",
				priceUpdated: "Synced latest official pricing",
				priceUnavailable: "Price sync failed — using built-in snapshot",
				unknownModels: "Non-DeepSeek models detected — billing stats for this model are not supported:",
				note: "Balance is live official data; cost is an estimate priced from local session logs at official rates. Final billing is on the DeepSeek platform.",
				togglePanel: "Toggle usage panel",
				close: "Close",
				langLabel: "中",
				chartAria: "7-day cost trend"
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
		function TrendChart({ series, currency, ariaLabel }) {
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
			return jsx("svg", {
				viewBox: `0 0 ${width} ${height}`,
				role: "img",
				"aria-label": ariaLabel,
				style: { display: "block", width: "100%", height: 140 },
				children: jsxs(Fragment, { children: [
					jsx("line", { x1: inset, y1: baseline, x2: width - inset, y2: baseline, stroke: "var(--dsw-alias-border-l2)" }),
					jsx("polygon", { points: areaPoints, fill: "var(--dsw-alias-accent-primary, #4f7cff)", fillOpacity: 0.1 }),
					jsx("polyline", { points: linePoints, fill: "none", stroke: "var(--dsw-alias-accent-primary, #4f7cff)", strokeWidth: 2.5, strokeLinejoin: "round", strokeLinecap: "round" }),
					...pts.map((p) => jsxs("g", { key: p.date, children: [
						jsx("title", { children: `${p.date}：${formatCost(Number(p.cost) || 0, currency)}` }),
						jsx("text", { x: p.x, y: Math.max(10, p.y - 7), textAnchor: "middle", fill: "var(--dsw-alias-label-primary)", fontSize: 10, fontWeight: 600, children: formatCost(Number(p.cost) || 0, currency) }),
						jsx("circle", { cx: p.x, cy: p.y, r: 3, fill: "var(--dsw-alias-bg-overlay)", stroke: "var(--dsw-alias-accent-primary, #4f7cff)", strokeWidth: 2 }),
						jsx("text", { x: p.x, y: height - 6, textAnchor: "middle", fill: "var(--dsw-alias-label-secondary)", fontSize: 10, children: dayLabel(p.date) })
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
				if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return p;
			} catch {}
			return null;
		}

		// ---- 看板组件 ----------------------------------------------
		function makeDashboard(locale) {
			function Dashboard() {
				const [data, setData] = useState(null);
				const [open, setOpen] = useState(false);
				const [phase, setPhase] = useState("loading");
				const [refreshing, setRefreshing] = useState(false);
				const [pos, setPos] = useState(loadPos);
				const [langPref, setLangPref] = useState(() => {
					try { return globalThis.localStorage && globalThis.localStorage.getItem(LANG_KEY); } catch { return null; }
				});
				const mounted = useRef(true);
				const dataRef = useRef(null);
				const dockRef = useRef(null);
				const panelRef = useRef(null);
				const dragRef = useRef(null);
				const suppressClickRef = useRef(false);

				const harnessLang = useHarnessLocale(locale);
				const lang = langPref === "zh" || langPref === "en" ? langPref : (harnessLang === "en" ? "en" : "zh");
				const t = (k) => (STRINGS[lang] && STRINGS[lang][k]) || STRINGS.zh[k] || k;

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
				const available = data ? data.available : null;
				const totalBalance = info ? Number(info.total_balance) : NaN;
				const today = data && data.today ? data.today : null;
				const series = data && Array.isArray(data.series) ? data.series : [];
				const totals = data && data.totals ? data.totals : null;
				const recharge = data && data.recharge ? data.recharge : { url: "https://platform.deepseek.com/top_up", usageUrl: "https://platform.deepseek.com/usage" };
				const balanceError = data && data.balanceError ? data.balanceError : null;
				const pricingStatus = data && data.pricingStatus ? data.pricingStatus : null;
				const unknownModels = data && Array.isArray(data.unknownModels) ? data.unknownModels : [];

				const todayTokens = dayTokens(today);
				const todayCost = today ? Number(today.cost) || 0 : 0;
				const stateColor = phase === "error" ? "var(--dsw-alias-state-error-primary)" : available === false ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-success-primary)";
				const balanceText = phase === "error" ? "—" : balanceError ? t("notConfigured") : formatBalance(totalBalance, currency);
				const low = Number.isFinite(totalBalance) && totalBalance < 10;

				const pricingMsg = pricingStatus
					? (pricingStatus.status === "updated" ? t("priceUpdated") : pricingStatus.status === "unavailable" ? t("priceUnavailable") : t("priceInSync"))
					: "";

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

				const toggleLang = () => {
					const next = lang === "zh" ? "en" : "zh";
					setLangPref(next);
					try { globalThis.localStorage && globalThis.localStorage.setItem(LANG_KEY, next); } catch {}
				};

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
								jsxs("div", { style: { display: "inline-flex", gap: 6, alignItems: "center" }, children: [
									jsx("button", { type: "button", onClick: toggleLang, style: { border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }, children: t("langLabel") }),
									jsx("button", { type: "button", onClick: () => setOpen(false), "aria-label": t("close"), style: { border: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", fontSize: 16, cursor: "pointer", padding: "0 2px", lineHeight: 1 }, children: "×" })
								] })
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
								jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }, children: [
									jsx("span", { style: { ...label, fontSize: 11 }, children: t("todayCost") }),
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
								jsx("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 2 }, children: t("trend") }),
								jsx("div", { style: { ...label, fontSize: 11, marginBottom: 6 }, children: t("trendNote") }),
								jsx(TrendChart, { series, currency, ariaLabel: t("chartAria") })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { display: "flex", gap: 8, padding: 12 }, children: [
								jsx("a", { href: recharge.url, target: "_blank", rel: "noreferrer", style: btnPrimaryStyle, children: `${t("recharge")} ↗` }),
								jsx("a", { href: recharge.usageUrl, target: "_blank", rel: "noreferrer", style: btnStyle, children: `${t("usage")} ↗` })
							] }),

							unknownModels.length > 0 && jsxs("div", { style: { padding: "0 14px 12px", fontSize: 11, lineHeight: 1.5, color: "var(--dsw-alias-state-warn-primary)" }, children: `${t("unknownModels")} ${unknownModels.join("、")}` }),

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
								borderRadius: 999,
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
								jsx("span", { "aria-hidden": true, style: { flex: "none", width: 7, height: 7, borderRadius: "50%", background: stateColor } }),
								jsxs("span", { children: [t("balance"), " ", jsx("strong", { style: value, children: balanceText })] }),
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
