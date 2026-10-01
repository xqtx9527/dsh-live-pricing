# dsh-live-pricing

[![npm](https://img.shields.io/npm/v/dsh-live-pricing.svg?style=flat-square)](https://www.npmjs.com/package/dsh-live-pricing)
[![CI](https://github.com/xqtx9527/dsh-live-pricing/actions/workflows/ci.yml/badge.svg)](https://github.com/xqtx9527/dsh-live-pricing/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-0e7490.svg?style=flat-square)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）的**峰谷时段条**：在输入框下方常驻一条信息，只显示三样东西——
**现在是不是空闲时段、用的是哪个模型、本会话花了多少钱**。

```
● 空闲时段  deepseek-flash                        本会话 ¥3.04
```

点一下整条即可展开明细。

## 显示内容

条形只有三格：

| 项目 | 说明 |
|---|---|
| 时段状态 | 高峰 / 空闲，带颜色圆点（高峰＝琥珀，空闲＝绿） |
| 模型 | 本会话实际使用的模型 id |
| 本会话金额 | 按峰谷分段计价得出的本次会话花费（人民币） |

展开后的明细：

- **北京时间**：日期、星期、精确到秒
- **时段原因**：`工作日 09:00-12:00`、`工作日午休 12:00-14:00`、`周末全天`、`国庆节 · 法定节假日全天` …
- **距下一次切换 / 下一个高峰 / 下一个空闲**：具体时刻与倒计时；长假期间按天显示
- **今日时段**：今天的高峰与空闲分别是几点到几点；周末与节假日直接标"全天空闲"
- **法定节假日**：今天是哪个节，距下一个节假日还有几天、具体日期
- **本会话金额（分时段）**：高峰段与空闲段各自的 token 数与金额，以及缓存读 / 未缓存输入 / 输出的合计，便于逐项对账
- **实时单价**与**高峰 / 空闲两档对照**，另有官方美元价目一行
- **价目来源**与核对时间

## 会话金额怎么算

金额＝每条请求按其**发生时刻**所处的时段取价，再累加：

```
金额 = 高峰桶用量 × 高峰价 + 空闲桶用量 × 空闲价
其中某个桶的用量 = 缓存读 × 命中价 + (未缓存输入 + 缓存写入) × 未命中价 + 输出 × 输出价
```

关键在于**分桶的时机**：会话常常横跨高峰与空闲，用"当前时段"的单价去套整个会话会算错。所以分桶这件事放在 **Host 端**（`index.js`）做——登记一个只读的 session projection，逐条读取 `assistant/message`，按事件的 `time` 归入高峰或空闲桶，折叠的是**整段会话日志**，不受客户端窗口分页影响；浏览器端只负责按对应单价乘出结果。

> 早期 0.1.x 把分桶放在浏览器端，依赖会话窗口里的节点。窗口是分页的，节点经常凑不齐，于是退回"当前时段单价 × 整段用量"，实测偏差可达两倍——这是当时金额对不上的根因。

**已知偏差来源**（展示值仍是估算，不是账单）：

- **币种**：插件按人民币展示（官方中文价目页口径）。如果你的平台账页以美元结算，需要自行换算。
- **口径差异**：缓存读写如何计入未命中、推理 token 是否并入输出、失败重试是否重复计费，各家口径未必完全一致。
- **子代理**：子代理是独立会话，各自单独计费，不计入本会话。

想要与官方账单对齐的金额，请用**官方用量页**，或下面这些专门做计费、并且会与官方余额对账的社区插件：

| 插件 | 说明 |
|---|---|
| [`dsh-elegent-balance-tracker`](https://github.com/X-avier-W/dsh-elegent-balance-tracker) | 逐条按消息时刻选峰谷价，每分钟与官方 `GET /user/balance` 对齐，并自动同步官方定价页 |
| [`dsh-billing`](https://github.com/niliemi/dsh-billing) | 全局/单会话账本、消费上限阻断、账户余额，价目取自官方 `@earendil-works/pi-ai` |

## 峰谷规则

- 高峰时段 = **北京时间 周一至周五（不含中国法定节假日）09:00–12:00 与 14:00–18:00**
- 其余时段（含周末与法定节假日全天）为空闲时段，**空闲价 = 高峰价 × 50%**
- 调休上班的周末（例如 2026-09-20 周日、2026-10-10 周六）仍然是周末，按规则本就空闲，无需特殊处理

## 价目表（高峰价）

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---|---|---|
| `deepseek-flash`（DeepSeek-V4.1-Flash） | ¥0.04 / $0.006 | ¥2 / $0.30 | ¥8 / $1.20 |
| `deepseek-v4-pro`（DeepSeek-V4-Pro） | ¥0.30 / $0.044 | ¥9 / $1.32 | ¥27 / $3.96 |

空闲价一律减半。旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 会归一到 Flash 价。

来源：

- 人民币价目 —— [DeepSeek 官方文档《模型 & 价格》](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- 美元价目 —— DSH 自带的官方机器可读表 `@earendil-works/pi-ai/dist/providers/data/deepseek.json`

> 官方价格可能调整。价目与节假日表都在 `client.js` 顶部的常量里（`PRICE_TABLE`、`HOLIDAY_RANGES`、`PRICE_CHECKED_AT`），改动后重启即可生效。

## 节假日表

`HOLIDAY_RANGES` 目前覆盖 **2026 年**（[国办发明电〔2025〕7 号](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)）：
元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7。

未覆盖的年份不会被误判为节假日，面板会明确写出「价目表未覆盖之后的节假日」。

## 数据来源

| 数据 | 来源 |
|---|---|
| 当前模型 | 内置的 `modelSelection` 会话投影 |
| 会话的分时段用量 | 本插件在 Host 端注册的 `deepseekLivePricing` 会话投影 |
| 时间、峰谷、节假日、单价 | 插件内置，纯本地计算 |

- **不联网**：不做任何网络请求。
- **不采集数据**：无遥测、无上报。
- **不改动模型输入**：不注册工具、不注入提示词段落，模型的每一次请求与不装该插件时完全一致。
- **只读**：不写会话日志、不写任何文件。

## 安装

```bash
# Web 版
dsh plugin --profile web add dsh-live-pricing

# 桌面版
dsh plugin --profile desktop add dsh-live-pricing
```

也可以直接从 GitHub 或本地目录安装：

```bash
dsh plugin --profile web add git+https://github.com/xqtx9527/dsh-live-pricing.git
dsh plugin --profile web add /path/to/dsh-live-pricing
```

> **DSH Desktop 必须重启应用（⌘Q 后重新打开），刷新页面不够。**
> 桌面版主进程在 Host 启动时把 Web boot 注入一次性缓存（`injections = ready.injections`），
> 页面刷新只会重新领取同一份缓存；实时推送通道 `dsh-app://app/plugins/events`
> 在桌面协议下会以 `net::ERR_FAILED` 失败，HMR 也推不到页面。
> 退出并重新打开 DSH 后，时段条会出现在输入框下方。

卸载：

```bash
dsh plugin --profile web remove dsh-live-pricing
```

## 兼容性

- 目标 profile：`web` 与 `desktop`（在 **DSH Desktop 0.2.0-rc.2 / macOS arm64** 上开发）。
- 无构建步骤：浏览器产物是手写的 plain JS，直接由 `./client` 导出提供。
- 只依赖公开契约：`dsh.bundle` / `dsh.client` 清单、`ctx.slots` 席位注册、`ctx.effect`、`ctx.locale`、
  `ctx.sessionProjections` 投影注册，以及内置的 `modelSelection` / `tokenUsage` 会话投影。
- 不 require 任何 Harness Client 包，只从平台模块表取 `react`；Harness 升级时受影响的只有主题 token 的观感。
- **未验证项**：仓库内没有提交界面截图（0.1.x 已在 DSH Desktop 上确认可以正常渲染并刷新，0.3.0 的界面与 Host 端投影待一次重启后确认）。

## 开发

无构建步骤，也没有任何运行时依赖。

```bash
npm run check   # 语法检查
npm test        # 58 项逻辑与渲染回归测试
```

`test/render-check.mjs` 用最小 React 运行时真正执行 `client.js` 的注册与渲染路径，
覆盖 15 组场景：工作日高峰 / 午休 / 夜间、周末、国庆节、中秋节、长假倒计时按天、
Pro 与旧模型名单价、**分时段精确金额**、**Host 投影缺失时的估算兜底**、无用量占位、
非 DeepSeek 路由、未收录模型，以及金额始终带 ¥。

> 这是纯逻辑回归测试，**不构成**对运行中 UI 的视觉验证。

## 变更记录

- **0.3.0** —— 会话金额回归，但改成 Host 端 `deepseekLivePricing` 投影按每条请求的发生时刻分桶，修掉 0.1.x 因客户端窗口分页导致的偏差；条形精简为「时段 + 模型 + 本会话金额」三格；新增分时段金额明细与审计数字。
- **0.2.0** —— 移除消费金额计算与 `tokenUsage` 依赖，改为纯时段 / 节假日 / 单价提示条；新增「今日时段」与官方美元价目对照。
- **0.1.0** —— 首版：时段、节假日、单价与会话花费。

## 目录结构

```
.
├── package.json              # 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # 插入 deepseek-pricing 这一行 Loader 条目
├── index.js                  # Host half：注册 deepseekLivePricing 投影，按事件时刻分峰谷桶
├── client.js                 # Client half：峰谷判定、节假日、金额与渲染
├── icon.svg
├── locale/{zh,en}.json
├── test/render-check.mjs
└── .github/workflows/ci.yml
```

## 许可

[MIT](LICENSE) © 2026 xqtx9527

本项目是独立的社区插件，与 DeepSeek 官方无隶属关系。DeepSeek、DeepSeek Harness 是 DeepSeek 的商标。
