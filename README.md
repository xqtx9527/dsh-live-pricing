# dsh-live-pricing

[![npm](https://img.shields.io/npm/v/dsh-live-pricing.svg?style=flat-square)](https://www.npmjs.com/package/dsh-live-pricing)
[![CI](https://github.com/xqtx9527/dsh-live-pricing/actions/workflows/ci.yml/badge.svg)](https://github.com/xqtx9527/dsh-live-pricing/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-0e7490.svg?style=flat-square)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）的**峰谷时段条**：在输入框下方常驻一条信息，实时告诉你
**现在是不是高峰时段、下一次切换还有多久、今天是不是节假日、以及此刻生效的单价**。

```
● 空闲时段  deepseek-flash  缓存命中输入 ¥0.02 · 缓存未命中输入 ¥1 · 输出 ¥4 元 / 百万 tokens        距高峰 42 分
```

点一下整条即可展开明细。

> **本插件不计算、不显示任何消费金额。** 见下方[为什么不显示金额](#为什么不显示金额)。

## 显示内容

| 项目 | 说明 |
|---|---|
| 时段状态 | 高峰 / 空闲，带颜色圆点（高峰＝琥珀，空闲＝绿） |
| 倒计时 | 到下一次「高峰 ⇄ 空闲」切换还有多久 —— 这是最有用的一栏：看到"距空闲 42 分"，就知道值不值得现在开跑 |
| 实时单价 | 缓存命中输入 / 缓存未命中输入 / 输出（元 / 百万 tokens），随峰谷自动切换 |

展开后的明细：

- **北京时间**：日期、星期、精确到秒
- **时段原因**：`工作日 09:00-12:00`、`工作日午休 12:00-14:00`、`周末全天`、`国庆节 · 法定节假日全天` …
- **距下一次切换 / 下一个高峰 / 下一个空闲**：具体时刻
- **今日时段**：今天的高峰与空闲分别是几点到几点；周末与节假日直接标"全天空闲"
- **法定节假日**：今天是哪个节，距下一个节假日还有几天、具体日期
- **当前模型**与它此刻生效的单价
- **高峰 / 空闲两档对照**：一眼看出空闲能省多少
- **官方英文价目**（USD）：方便和平台以美元显示的页面直接对照
- **价目来源**与核对时间

## 为什么不显示金额

早期版本（0.1.x）会累计 token 并算出"本次会话花了多少钱"。实测发现这条路**几乎必然与官方账单对不上**，所以 0.2.0 把它整个移除了。踩到的坑具体有三个：

1. **币种与汇率**。DeepSeek 官方中文价目页用人民币（`deepseek-flash` 未命中 ¥2 / 输出 ¥8），但平台账单一侧可能以美元结算（同一模型 `$0.3` / `$1.2`）。插件里的 `¥1.98` 和平台上的 `0.6` 放一起比，会得出完全错误的结论——它们可能根本不是一个单位。
2. **峰谷加权**。同一会话常常横跨高峰与空闲。正确做法是**按每一条请求的发生时刻**分别选价再累加，而不是拿"当前时段"的单价去套整个会话；而 DSH 客户端的会话窗口是分页的，节点经常凑不齐，退回"按当前时段估算"后误差可达两倍。
3. **计费口径**。缓存读写如何计入未命中、推理 token 是否并入输出、失败重试是否重复计费，各家口径并不完全一致。

想知道一共花了多少钱，请用**官方用量页**，或下面这些专门做计费的社区插件（它们同时处理了余额与上限）：

| 插件 | 说明 |
|---|---|
| [`dsh-elegent-balance-tracker`](https://github.com/X-avier-W/dsh-elegent-balance-tracker) | 逐条按消息时刻选峰谷价，每分钟与官方 `GET /user/balance` 对齐，并自动同步官方定价页 |
| [`dsh-billing`](https://github.com/niliemi/dsh-billing) | 全局/单会话账本、消费上限阻断、账户余额，价目取自官方 `@earendil-works/pi-ai` |

本插件与它们互补而非重复：**只做"现在是不是空闲时段"这一件事，纯本地、零网络、零账号依赖。**

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
- 只依赖公开契约：`dsh.bundle` / `dsh.client` 清单、`ctx.slots` 席位注册、`ctx.effect`、`ctx.locale`，
  以及内置的 `modelSelection` 会话投影。
- 不 require 任何 Harness Client 包，只从平台模块表取 `react`；Harness 升级时受影响的只有主题 token 的观感。
- **未验证项**：仓库内没有提交界面截图（0.1.x 已在 DSH Desktop 上确认可以正常渲染并刷新，0.2.0 的界面待一次重启后确认）。

## 开发

无构建步骤，也没有任何运行时依赖。

```bash
npm run check   # 语法检查
npm test        # 73 项逻辑与渲染回归测试
```

`test/render-check.mjs` 用最小 React 运行时真正执行 `client.js` 的注册与渲染路径，
覆盖 13 组场景：工作日高峰 / 午休 / 夜间、周末、国庆节、中秋节、Pro 与旧模型名单价、
无投影兜底、非 DeepSeek 路由、未收录模型，以及**断言任何状态下都不出现消费金额**。

> 这是纯逻辑回归测试，**不构成**对运行中 UI 的视觉验证。

## 变更记录

- **0.2.0** —— 移除消费金额计算与 `tokenUsage` 依赖，改为纯时段 / 节假日 / 单价提示条；新增「今日时段」与官方美元价目对照。
- **0.1.0** —— 首版：时段、节假日、单价与会话花费。

## 目录结构

```
.
├── package.json              # 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # 插入 deepseek-pricing 这一行 Loader 条目
├── index.js                  # Host half：无副作用（全部逻辑在浏览器端）
├── client.js                 # Client half：峰谷判定、节假日、单价与渲染
├── icon.svg
├── locale/{zh,en}.json
├── test/render-check.mjs
└── .github/workflows/ci.yml
```

## 许可

[MIT](LICENSE) © 2026 xqtx9527

本项目是独立的社区插件，与 DeepSeek 官方无隶属关系。DeepSeek、DeepSeek Harness 是 DeepSeek 的商标。
