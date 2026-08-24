# dsh-billing-dashboard

DeepSeek Harness（DSH）**永久**用量看板插件：右下角常驻悬浮胶囊，点击展开完整面板。

## 功能

- **账户余额**：DeepSeek 官方 `/user/balance` 实时数据（可用 / 充值 / 赠送拆分），低余额标红
- **今日消费**：按官方价格（含峰谷定价与缓存命中价）对本地会话日志折算的估算值
- **今日 token**：输入 / 输出 / 缓存命中 / 缓存写入 / 推理拆分
- **近 7 日消费趋势图**：逐日消费折线 + 数据标签
- **一键充值**：直达 DeepSeek 官方充值页 `platform.deepseek.com/top_up`，另有「用量明细」入口
- 全中文界面，仅使用 `--dsw-*` 主题变量（跟随亮/暗色）

## 数据口径

- **余额**：官方实时，需要已配置 `DEEPSEEK_API_KEY`（「设置 → 模型」中填写即可，插件自动读取，密钥不出 Host）。
- **消费 / token**：回放 `$DSH_HOME` 下的持久化会话日志，聚合所有 `assistant/message` 事件的 token，再用官方价格引擎折算成人民币/美元。属于**估算**口径，最终以 DeepSeek 平台账单为准。

## 安装（永久）

```bash
dsh plugin --profile web add link:/path/to/dsh-billing-dashboard
```

安装后刷新浏览器页面即可看到右下角悬浮胶囊。插件源码保留在原目录，卸载用 `dsh plugin --profile web remove dsh-billing-dashboard`。

## 结构

| 文件 | 说明 |
| --- | --- |
| `package.json` | `dsh.bundle.patch`（Host 半）+ `dsh.client`（浏览器半）声明 |
| `cordis.patch.yml` | bundle 补丁层，插入 `billing-dashboard` 行 |
| `lib/index.js` | Host 半：余额路由 + 本地 token 聚合 + 官方价格计费 |
| `lib/client.js` | 浏览器半：悬浮看板 + 趋势图 + 充值入口 |
