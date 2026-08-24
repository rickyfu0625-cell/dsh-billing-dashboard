# dsh-billing-dashboard

DeepSeek Harness（DSH）**永久**用量看板插件：右下角常驻悬浮胶囊，点击展开完整面板。

## 功能

- **账户余额**：DeepSeek 官方 `/user/balance` 实时数据（可用 / 充值 / 赠送拆分），低余额标红
- **今日消费**：官方优先（配了 `DEEPSEEK_PLATFORM_TOKEN` 时显示官方数据，否则本地估算，面板标「官方 / 估算」）
- **今日 token**：输入 / 输出 / 缓存命中 / 缓存写入 / 推理拆分
- **近 7 日消费趋势图**：逐日消费折线 + 数据标签
- **一键充值**：直达 DeepSeek 官方充值页 `platform.deepseek.com/top_up`，另有「用量明细」入口
- **可拖拽悬浮胶囊**：收起时两行显示「今日消费 / 当前余额」+ 刷新按钮，可随意拖动（位置持久化、窗口缩放自动回视口）；展开时点击面板外可收起
- **中英双语**：始终跟随 DeepSeek Harness 的语言；面板内切换按钮直接切换 harness 语言
- 仅使用 `--dsw-*` 主题变量（跟随亮/暗色）

## 数据口径

- **余额**：官方实时，需要已配置 `DEEPSEEK_API_KEY`（「设置 → 模型」中填写即可，插件自动读取，密钥不出 Host）。
- **今日消费 / 趋势（官方优先）**：若配置了 `DEEPSEEK_PLATFORM_TOKEN`（登录 `platform.deepseek.com` 后，DevTools → Console 执行 `JSON.parse(localStorage.getItem('userToken')).value` 得到），则调官方用量接口拿「今日消费 + 本月逐日消费」，面板标「官方」；未配置 / 过期 / 失败则自动回退到本地估算并标「估算」。
- **消费 / token（估算兜底）**：回放 `$DSH_HOME` 下的持久化会话日志，聚合所有 `assistant/message` 事件的 token，再用官方价格引擎折算成人民币/美元。属于**估算**口径，最终以 DeepSeek 平台账单为准。
- **官方价格自动同步**：每天首次请求时抓取官方定价页（EN `$` / ZH `元`），解析当前各模型的峰谷输入/缓存命中/输出单价；若与当前生效价不一致，则追加一条同步政策并持久化到 `$DSH_HOME/storages/dsh-billing-dashboard-pricing.json`，之后的消息按新价折算（历史消息仍按当时价回放）。抓取/解析失败则回退内置价格快照。

## 适用范围与限制

本插件**只适配「DeepSeek Harness（DSH）+ DeepSeek 官方 API」这一种组合**，不通用：

| 能力 | 依赖 | 说明 |
| --- | --- | --- |
| 运行环境 | DeepSeek Harness（DSH） | 它是 `dsh.bundle`，依赖 DSH 的 `webServer` / `sessionPersistence` / `credentials` / `slots` / `locale` 服务，不能在其他 Harness（如 Claude Code、Codex）里运行 |
| 账户余额 | DeepSeek 官方 `/user/balance` | 只能读 DeepSeek 官方账户（`api.deepseek.com`，`DEEPSEEK_BASE_URL` 可覆盖），需要 `DEEPSEEK_API_KEY`；其他 provider（OpenAI / Anthropic 等）无法读取余额 |
| 消费估算 | DeepSeek 官方价格表 | 只内置了 DeepSeek 官方模型价（deepseek-chat / reasoner / v4-flash / v4-pro）；**非 DeepSeek 模型暂不支持计费统计，不计入消费** |
| 官方价格同步 | DeepSeek 官方定价页 | 只抓取 `api-docs.deepseek.com` 的定价页 |
| 一键充值 | DeepSeek 官方平台 | 跳转 `platform.deepseek.com/top_up` |

- **token / 消费**只统计 DeepSeek 官方模型；如果你通过 DSH 的多 provider（如 `llm-pi-ai`）接入了非 DeepSeek 模型，插件会检测并在面板提示「暂不支持该模型计费统计」，且不将其计入消费。

## 安装（永久）

**方式一：从 GitHub 安装（推荐，日常使用）**

```bash
dsh plugin --profile web add github:rickyfu0625-cell/dsh-billing-dashboard
```

**方式二：本地目录安装（开发 / 改代码，软链实时指向源码）**

```bash
dsh plugin --profile web add link:/path/to/dsh-billing-dashboard
```

安装后需**重启 `dsh web` 进程并刷新浏览器页面**（新 bundle 在启动时组合），随后右下角即可看到悬浮胶囊。

> 卸载：`dsh plugin --profile web remove dsh-billing-dashboard`

## 结构

| 文件 | 说明 |
| --- | --- |
| `package.json` | `dsh.bundle.patch`（Host 半）+ `dsh.client`（浏览器半）声明 |
| `cordis.patch.yml` | bundle 补丁层，插入 `billing-dashboard` 行 |
| `lib/index.js` | Host 半：余额路由 + 本地 token 聚合 + 官方价格计费 + 官方价格日同步 |
| `lib/client.js` | 浏览器半：可拖拽悬浮看板 + 趋势图 + 充值入口 + 中英切换 |
