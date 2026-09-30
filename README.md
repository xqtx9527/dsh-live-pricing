# dsh-live-pricing

[![npm](https://img.shields.io/npm/v/dsh-live-pricing.svg?style=flat-square)](https://www.npmjs.com/package/dsh-live-pricing)
[![CI](https://github.com/xqtx9527/dsh-live-pricing/actions/workflows/ci.yml/badge.svg)](https://github.com/xqtx9527/dsh-live-pricing/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-0e7490.svg?style=flat-square)](https://github.com/topics/dsh-plugin)

DeepSeek Harness（DSH）的**实时价格条**：在输入框下方常驻一条信息，实时告诉你
**现在是不是高峰期、是不是节假日、当前生效的单价是多少、以及这次会话已经花了多少钱**。

```
● 空闲时段  deepseek-flash  缓存命中输入 ¥0.02 · 缓存未命中输入 ¥1 · 输出 ¥4 / 百万 tokens      会话花费 ¥0.1900   距高峰 42 分
```

点一下整条即可展开明细。

## 显示内容

| 项目 | 说明 |
|---|---|
| 时段状态 | 高峰 / 空闲，带颜色圆点（高峰＝琥珀，空闲＝绿） |
| 实时单价 | 缓存命中输入、缓存未命中输入、输出（元 / 百万 tokens），随高峰空闲自动切换 |
| 会话花费 | 本次会话按 token 分桶算出的金额 |
| 倒计时 | 到下一次「高峰 ⇄ 空闲」切换还有多久 |

展开后的明细：

- **北京时间**：日期、星期、精确到秒
- **时段原因**：`工作日 09:00-12:00`、`工作日午休 12:00-14:00`、`周末全天`、`国庆节 · 法定节假日全天` …
- **距下一次切换 / 下一个高峰 / 下一个空闲**：具体时刻
- **法定节假日**：今天是哪个节，或距下一个节假日还有几天
- **当前模型**：会话实际使用的 provider / model
- **实时单价明细**：三个 token 桶各自的单价
- **分时段计价**：会话跨越时段边界时，高峰段与空闲段各自的 token 数与金额
- **价目来源**与计费口径说明

## 计费口径

- 高峰时段 = **北京时间 周一至周五（不含中国法定节假日）09:00–12:00 与 14:00–18:00**；
  其余时段（含周末与法定节假日全天）为空闲时段，**空闲价 = 高峰价 × 50%**。
- **缓存未命中输入 = 未缓存输入 token + 缓存写入 token**（写入缓存的部分按未命中价计费）。
- 会话花费默认按**每一步模型完成的时刻**分段计价：跨越 12:00 / 14:00 / 18:00 的长会话会分别套用当时的单价。
  会话窗口被分页导致节点不完整时，自动退回「按当前时段单价整体估算」，并在面板中标注当前用的是哪种口径。

## 价目表（人民币 / 百万 tokens）

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---|---|---|
| `deepseek-flash`（DeepSeek-V4.1-Flash） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro`（DeepSeek-V4-Pro） | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

每格为「**空闲 / 高峰**」。旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 会归一到 Flash 价。

来源：[DeepSeek 官方 API 文档《模型 & 价格》](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

> 官方价格可能调整。价格表与节假日表都写在 `client.js` 顶部的常量里（`PRICE_TABLE`、`HOLIDAY_RANGES`、`PRICE_CHECKED_AT`），改动后刷新即可生效。

## 节假日表

`HOLIDAY_RANGES` 目前覆盖 **2026 年**（[国办发明电〔2025〕7 号](https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)）：
元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7。

调休上班的周末（如 2026-09-20 周日、2026-10-10 周六）仍然是周末，按规则本就属于空闲时段，无需特殊处理。
未覆盖的年份不会被误判为节假日，面板会明确写出「价目表未覆盖之后的节假日」。

## 数据来源

| 数据 | 来源 |
|---|---|
| 会话累计 token 分桶 | 内置的 `tokenUsage` 会话投影（整段日志折叠，分页/压缩不影响数值） |
| 当前模型 | 内置的 `modelSelection` 会话投影 |
| 每一步完成时刻 | `useChat` 的会话节点（仅用于分时段计价） |
| 时间 / 单价 / 节假日 | 插件内置，纯本地计算，**不联网** |

插件不新增任何模型可见内容（无工具、无提示词段落），只往 Web UI 的 `conversation.composer.dock` 席位注册一个条目。

## 安装

一条命令即可，无构建步骤、无运行时依赖。

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
> 退出并重新打开 DSH 后，价格条会出现在输入框下方。

安装后如果没出现，可在开发者工具 Console 里查找与 `deepseek-pricing` 相关的报错。

卸载：

```bash
dsh plugin --profile web remove dsh-live-pricing
```

## 兼容性

- 目标 profile：`web` 与 `desktop`（在 **DSH Desktop 0.2.0-rc.2 / macOS arm64** 上开发）。
- 无构建步骤：浏览器产物是手写的 plain JS，直接由 `./client` 导出提供。
- 只依赖公开契约：`dsh.bundle` / `dsh.client` 清单、`ctx.slots` 席位注册、`ctx.effect`、`ctx.locale`，
  以及内置的 `tokenUsage` / `modelSelection` 会话投影。
- 不 require 任何 Harness Client 包（不碰 `@deepseek-ai/dsh-client-ui-primitives` 之类），只从平台模块表取 `react`；
  Harness 升级时受影响的只有主题 token 的观感，不会因内部包改名而崩。
- **未验证项**：仓库内没有界面截图，因为作者开发环境尚未完成一次应用重启后的目视确认；
  其余（清单、席位注册路径、bundle 交付链路、计价逻辑）均已验证。

## 权限与外部服务

- **不联网**：价格表、节假日表、时区换算全部内置，插件不做任何网络请求。
- **不采集数据**：无遥测、无上报、不读写 `document.body` 之外的 DOM，不访问本地文件。
- **不改动模型输入**：不注册工具、不注入提示词段落，模型的每一次请求与不装该插件时完全一致。
- 卸载后 Host 行与客户端席位、样式表、词典一并移除。

## 开发

无构建步骤，也没有任何运行时依赖。

```bash
npm run check   # 语法检查
npm test        # 54 项逻辑与渲染回归测试
```

`test/render-check.mjs` 用最小 React 运行时真正执行 `client.js` 的注册与渲染路径，
覆盖 13 组场景：工作日高峰 / 午休 / 夜间、周末、国庆节、中秋节、跨时段分段计价、
窗口不完整回退、非 DeepSeek 路由、未知模型、旧模型名归一等。

> 这是纯逻辑回归测试，**不构成**对运行中 UI 的视觉验证。

## 目录结构

```
.
├── package.json              # 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # 插入 deepseek-pricing 这一行 Loader 条目
├── index.js                  # Host half：无副作用（全部逻辑在浏览器端）
├── client.js                 # Client half：时段判定、节假日、计价与渲染
├── icon.svg                  # 插件管理页图标
├── locale/{zh,en}.json       # 插件管理页显示的标题与描述
├── test/render-check.mjs
└── .github/workflows/ci.yml
```

## 许可

[MIT](LICENSE) © 2026 xqtx9527

本项目是独立的社区插件，与 DeepSeek 官方无隶属关系。DeepSeek、DeepSeek Harness 是 DeepSeek 的商标。
