// dsh-billing-dashboard — 浏览器半。
// 右下角常驻悬浮胶囊：余额 + 今日消费 + 今日 token；点击展开完整面板
// （余额明细、今日 token 拆分、7 日消费趋势图、一键充值 / 用量明细）。
// 只使用 `--dsw-*` 主题变量，自动跟随亮/暗色与缩放。

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
		const POLL_MS = 60 * 1000;

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
			const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
			return `${symbol}${text}`;
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
			// "YYYY-MM-DD" -> "MM-DD"（去掉年份，更紧凑）
			return typeof dateKey === "string" && dateKey.length >= 10 ? dateKey.slice(5) : dateKey;
		}

		function dayTokens(day) {
			if (!day) return 0;
			return (Number(day.input) || 0) + (Number(day.output) || 0) + (Number(day.cacheRead) || 0) + (Number(day.cacheWrite) || 0) + (Number(day.reasoning) || 0);
		}

		// ---- 样式（仅 --dsw-* 主题变量） ---------------------------
		const font = { fontFamily: "var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)" };
		const label = { color: "var(--dsw-alias-label-secondary)", fontWeight: 400 };
		const value = { color: "var(--dsw-alias-label-primary)", fontWeight: 600 };

		const dockStyle = {
			...font,
			boxSizing: "border-box",
			display: "inline-flex",
			alignItems: "center",
			gap: 8,
			maxWidth: "min(440px, calc(100vw - 24px))",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 2px 10px rgba(0, 0, 0, 0.16)",
			padding: "6px 12px",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: "18px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			userSelect: "none",
			cursor: "pointer",
			transition: "border-color 120ms ease, background 120ms ease"
		};

		const dot = (color) => ({ flex: "none", width: 7, height: 7, borderRadius: "50%", background: color });

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

		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			padding: "10px 14px"
		};

		const divider = { height: 1, background: "var(--dsw-alias-border-l2)" };

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

		// ---- 7 日消费趋势图 ----------------------------------------
		function TrendChart({ series, currency }) {
			const points = Array.isArray(series) ? series : [];
			if (points.length === 0) {
				return jsx("div", {
					style: { display: "grid", placeItems: "center", minHeight: 120, color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
					children: "暂无数据"
				});
			}
			const width = 320;
			const height = 140;
			const top = 20;
			const bottom = 24;
			const plotHeight = height - top - bottom;
			const inset = 8;
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
				"aria-label": "7 日消费趋势",
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

		// ---- 看板组件 ----------------------------------------------
		function Dashboard() {
			const [data, setData] = useState(null);
			const [open, setOpen] = useState(false);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const mounted = useRef(true);
			const dataRef = useRef(null);

			const load = useCallback(async () => {
				if (typeof document !== "undefined" && document.hidden) return;
				try {
					const res = await fetch(SUMMARY_PATH, { cache: "no-store" });
					const body = await res.json();
					if (!mounted.current) return;
					dataRef.current = body;
					setData(body);
					setPhase("ready");
				} catch {
					if (!mounted.current) return;
					if (!dataRef.current) setPhase("error");
				}
			}, []);

			useEffect(() => {
				mounted.current = true;
				load();
				const timer = setInterval(load, POLL_MS);
				const onVisible = () => { if (!document.hidden) load(); };
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					mounted.current = false;
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [load]);

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

			const todayTokens = dayTokens(today);
			const todayCost = today ? Number(today.cost) || 0 : 0;
			const stateColor =
				phase === "error"
					? "var(--dsw-alias-state-error-primary)"
					: available === false
						? "var(--dsw-alias-state-error-primary)"
						: "var(--dsw-alias-state-success-primary)";

			const balanceText = phase === "error"
				? "—"
				: balanceError
					? "未配置"
					: formatBalance(totalBalance, currency);

			const low = Number.isFinite(totalBalance) && totalBalance < 10;

			const openUrl = (url) => () => { if (typeof window !== "undefined") window.open(url, "_blank", "noopener"); };

			return jsx("div", {
				style: {
					position: "fixed",
					right: 16,
					bottom: 16,
					zIndex: 2147483000,
					display: "flex",
					flexDirection: "column",
					alignItems: "flex-end",
					gap: 8,
					pointerEvents: "none"
				},
				children: jsxs(Fragment, { children: [
					open && jsxs("div", {
						style: { ...panelStyle, pointerEvents: "auto" },
						children: [
							jsxs("div", { style: { ...rowStyle, padding: "12px 14px" }, children: [
								jsx("div", { style: { fontSize: 14, fontWeight: 600 }, children: "DeepSeek 用量看板" }),
								jsx("button", {
									type: "button",
									onClick: () => setOpen(false),
									"aria-label": "关闭",
									style: { border: 0, background: "transparent", color: "var(--dsw-alias-label-secondary)", fontSize: 16, cursor: "pointer", padding: "0 2px", lineHeight: 1 },
									children: "×"
								})
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { padding: "14px" }, children: [
								jsx("div", { style: { ...label, fontSize: 11 }, children: "账户余额" }),
								jsxs("div", { style: { display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }, children: [
									jsx("span", { style: { fontSize: 26, fontWeight: 700, color: low ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums", lineHeight: 1.2 }, children: balanceText }),
									balanceError && jsx("span", { style: { ...label, fontSize: 11 }, children: "（未配置 API Key）" })
								] }),
								info && jsxs("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 11, ...label }, children: [
									jsxs("span", { children: ["可用 ", jsx("strong", { style: value, children: formatBalance(info.total_balance, currency) })] }),
									jsxs("span", { children: ["充值 ", jsx("strong", { style: value, children: formatBalance(info.topped_up_balance, currency) })] }),
									jsxs("span", { children: ["赠送 ", jsx("strong", { style: value, children: formatBalance(info.granted_balance, currency) })] })
								] })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { padding: "12px 14px" }, children: [
								jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" }, children: [
									jsx("span", { style: { ...label, fontSize: 11 }, children: "今日消费（估算）" }),
									jsx("span", { style: { ...value, fontSize: 16, fontVariantNumeric: "tabular-nums" }, children: formatCost(todayCost, currency) })
								] }),
								jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 6 }, children: [
									jsx("span", { style: { ...label, fontSize: 11 }, children: "今日 token" }),
									jsx("span", { style: value, children: formatTokens(todayTokens) })
								] }),
								jsxs("div", { style: { display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 11, ...label }, children: [
									jsxs("span", { children: ["输入 ", jsx("strong", { style: value, children: formatTokens(today ? today.input : 0) })] }),
									jsxs("span", { children: ["输出 ", jsx("strong", { style: value, children: formatTokens(today ? today.output : 0) })] }),
									jsxs("span", { children: ["缓存命中 ", jsx("strong", { style: value, children: formatTokens(today ? today.cacheRead : 0) })] })
								] })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { padding: "12px 14px 6px" }, children: [
								jsx("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 2 }, children: "近 7 日消费趋势" }),
								jsx("div", { style: { ...label, fontSize: 11, marginBottom: 6 }, children: "按本地会话日志估算" }),
								jsx(TrendChart, { series, currency })
							] }),

							jsx("div", { style: divider }),
							jsxs("div", { style: { display: "flex", gap: 8, padding: 12 }, children: [
								jsx("a", { href: recharge.url, target: "_blank", rel: "noreferrer", style: btnPrimaryStyle, children: "去充值 ↗" }),
								jsx("a", { href: recharge.usageUrl, target: "_blank", rel: "noreferrer", style: btnStyle, children: "用量明细 ↗" })
							] }),

							jsx("div", { style: { padding: "0 14px 12px", fontSize: 10.5, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)" }, children: "余额为官方实时数据；消费为按官方价格对本地会话日志折算的估算值，最终以 DeepSeek 平台账单为准。" })
						]
					}),

					jsx("button", {
						type: "button",
						onClick: () => setOpen((v) => !v),
						"aria-label": "切换用量看板",
						title: "DeepSeek 用量看板",
						style: { ...dockStyle, pointerEvents: "auto", color: open ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)" },
						children: jsxs(Fragment, { children: [
							jsx("span", { "aria-hidden": true, style: dot(phase === "error" ? "var(--dsw-alias-state-error-primary)" : stateColor) }),
							jsxs("span", { children: ["余额 ", jsx("strong", { style: value, children: balanceText })] }),
							jsx("span", { style: { color: "var(--dsw-alias-border-l3)" }, children: "·" }),
							jsxs("span", { children: ["今日 ", jsx("strong", { style: value, children: formatCost(todayCost, currency) })] }),
							jsx("span", { style: { color: "var(--dsw-alias-border-l3)" }, children: "·" }),
							jsxs("span", { children: [formatTokens(todayTokens), " tok"] })
						] })
					})
				] })
			});
		}

		// ---- 客户端插件主体 ----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
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
