---
name: codex-remote-fix
description: 排查并逐步修复 macOS 上 Codex 或 ChatGPT Desktop 无法启用 Remote Control、WebSocket 超时或仅允许运行一个实例的错误，并验证手机配对。
---

# Codex Remote Control 排查与修复

目标：使用户可以从手机 ChatGPT 的 Codex/Remote 控制指定 Mac。区分桌面启用、远程服务注册、生成配对码、手机连接四个结果；只报告实际验证通过的阶段，不承诺所有同类报错都能用同一操作解决。

## 授权与边界

先做非破坏性检查。修复请求通常包含有依据的可逆配置修复；遵守用户明确的授权范围。服务启动/停止和代理功能启用若尚未获得授权，在实际操作前确认。不要删除用户数据、修改 Git 仓库、重置系统网络或随意终止全部 Codex 进程。

清除或修改代理环境变量、重新登录、撤销设备授权、重装应用，以及改变 VPN/代理软件配置前，向用户说明具体影响并确认。不要读取或输出 auth.json 内容、令牌、完整进程环境或未经脱敏的日志。系统权限申请不能替代操作授权。

若工具禁止访问 ChatGPT/Codex 界面，不用其他 UI 技术绕过。继续允许的日志/CLI 检查，明确把无法代操作的点击交给用户。

## 1. 建立基线

核对当前官方文档与本机命令帮助；不同版本可能没有相同子命令。可用 openai-docs 技能则使用它。官方手机 Remote 背景：https://developers.openai.com/blog/mastering-codex-remote-for-engineering 。该文不证明下述 CLI 修复对所有版本有效。

记录错误原文、发生位置、应用/CLI 版本、时间和用户已经尝试的步骤。读取桌面应用 Info.plist 的 CFBundleShortVersionString/CFBundleVersion；若有应用更新检查工具可调用，但不要把“存在更新”当作故障原因。

```sh
command -v codex
codex --version
codex doctor --no-color
codex remote-control --help
codex features list
/usr/sbin/scutil --proxy
/usr/sbin/scutil --nc list
```

没有 codex 时先定位已安装应用中自带的 CLI，不盲目安装另一套。doctor 可能检查当前调用的配置，而非正在运行的桌面进程配置。

只检查 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、WSS_PROXY 及其小写形式；分别检查命令环境和 launchctl getenv 的启动环境。输出代理类型、主机、端口与是否设置，隐藏用户名/密码。它们均为空不代表系统未配置代理。

doctor 的系统代理不可见、DNS 失败或 PATH 权限警告可能来自执行沙箱。通过正常权限机制申请所需只读系统/网络访问，再复查；不得把沙箱故障当作 Mac 本身故障。

使用 doctor 的 Background Server 状态或本机受支持的服务状态命令。remote-control 在某些版本只有 start/stop/pair，不假设存在 status 子命令。

查看当前日期最新桌面日志与 daemon 日志，按最近失败时间过滤 remoteControl、WebSocket、timeout、conflict、instance、registration 等事件。常见路径（以本机发现为准）：
- ~/Library/Logs/com.openai.codex/
- ~/.codex/app-server-daemon/daemon.stderr.log

方法返回成功，只能证明请求完成；仍需查看后续连接/注册状态和界面结果。

## 2. 按证据修复

### 系统代理已开启、respect_system_proxy 关闭

先确认对应代理服务可用。若本机 features list 支持该功能，并且现有代理需要被 Codex 使用：

```sh
codex features enable respect_system_proxy
```

参数是单数 proxy。记录修改前状态，仅改变此项，保留其余配置；这是部分版本的开发中功能，不能默认所有用户都需要启用。复查 feature 状态和 doctor 的 WebSocket。HTTP 101 表示该诊断连接握手成功，不代表桌面 Remote 全流程成功。

已运行的桌面后台可能未重新加载配置，需完全退出应用再打开。不要将关闭窗口当作退出；也不要在有其他任务时强制结束应用。若无法安全代重启，让用户用 ⌘Q 并重开。

### 独立 CLI 服务验证（按需）

只在需要区分网络与桌面问题时使用：

```sh
codex remote-control start
codex remote-control pair
```

记录该服务是否本次排查新启动。配对码短时有效，视作敏感授权材料，仅展示给请求者，不写入公共方案或日志附件。成功生成配对码证明该独立服务可配对，不能宣布桌面设置已修复。

### “请确保仅有一个 ChatGPT 实例在运行”

检查主进程与父子关系，例如 ps -axo pid,ppid,comm。多个 Renderer/Service/crashpad 进程通常属于同一应用，不是多个主实例。不要据此批量杀进程。

检查是否有独立 CLI daemon 与桌面 Remote 同时运行。它们可能产生远程身份/连接占用冲突，但仅凭提示不能断言根因。如果本次诊断新启动了独立服务，先停止它，再让桌面重试：

```sh
codex remote-control stop
```

确认 daemon 已退出。残留的 pid-update-loop 是更新循环，不等于远程服务仍活跃；不要盲目删除 pid/lock 文件。若服务原本由用户运行，先解释停止的影响并确认。

仍报错则完全退出桌面应用再打开，检查新日志。尚有真实重复主实例时只处理确认属于重复实例的进程，避免影响当前对话/任务。

### 仍失败

重新核对最新错误与日志。若网络已经通过、桌面仍失败，保留独立服务/桌面行为差异证据，可建议通过官方更新流程更新已安装应用，然后再验证。账号、设备授权、代理配置等变更只在证据支持且用户确认后进行。

一个有依据的修复完成后复验；没有新证据时不要反复切换代理、重启或生成新服务。报告具体剩余阻碍和最小下一步，必要时整理脱敏材料供用户提交官方支持，不擅自发送。

## 3. 验收与交付

分别报告：
1. 配置和网络：功能实际状态、WebSocket 诊断结果。
2. 桌面：用户或允许的工具确认“允许”后成功启用，是否出现二维码/配对方式。
3. 远程服务：选定的服务正常运行，是否能生成有效配对码；避免诊断 daemon 与桌面双重运行。
4. 手机：同一 ChatGPT 账号/工作区，在当前手机版本的 Codex/Remote 添加设备，扫描二维码或输入配对码，电脑出现在线，并成功打开一个电脑端聊天进行交互。

未确认第 4 项时写“电脑端已通过某阶段，手机连接待验证”。未确认第 2 项时不要写“桌面已修复”。二维码不是唯一验收方式，但独立 CLI 的配对码不能证明桌面界面正常。

结束时交代实际修改、已验证结果、剩余错误、保留的服务及如何恢复修改前状态。若原值为 false，可用 codex features disable respect_system_proxy 恢复；如果原来未显式配置，说明 disable 写入 false 并非精确恢复原文件。不要未经用户要求回滚正在工作的修复。
