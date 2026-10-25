# dsh-plugin-agent-notifications

[![npm](https://img.shields.io/npm/v/dsh-plugin-agent-notifications.svg)](https://www.npmjs.com/package/dsh-plugin-agent-notifications)
[![license](https://img.shields.io/npm/l/dsh-plugin-agent-notifications.svg)](./LICENSE)

一个 DeepSeek Harness（dsh）Web 插件：当 Agent 任务**完成**、**需要你操作**（审批、提问、计划审阅）或**出错**时，用浏览器通知 API 提醒你，并可分别为三种情况选择提示音。

> 通知由当前 Web 页面发出，所以需要保持 Harness 标签页打开。插件不注册 Service Worker，也不做 Web Push。

## 触发时机

| 类型 | 判定依据 |
|---|---|
| 任务完成 | 会话的 Agent 状态由 `running` 变为空闲（同一时刻出现待办时只发「需要操作」，不重复响） |
| 需要操作 | 会话出现等待用户的交互：工具审批（含工具名）、向用户提问（含问题文本）、计划审阅 |
| 出错 | 会话级错误事件，正文为压缩成单行的错误信息（截断 200 字符） |

这些判定读取 Session 插件自身派生的 UI 状态（`uiSession.sessionStatus`）与转发的 `api-session/error` 事件，因此**不依赖审批 UI 与提问 UI 的注册顺序**，不会抢占或吞掉官方审批面板。

## 可选设定

设置 → **通知**。页面沿用官方 Settings 的骨架：16px/500 页面标题、13px/600 分组标题、16px 行距 + 0.5px 分隔线、36px 控件；开关、下拉菜单、按钮、图标直接用 Harness 原语（`Switch`、`Menu`、`Button`、`IconPlayOutlineRegular`、`IconInfoOutlineRegular`、`IconWarningOutlineRegular`）——与「通用」里的语言/开发者工具行同源，**没有自制控件的兜底实现**，配色全部取自主题 alias token，跟随明暗主题。

页面只有三组：

1. **总开关**「启用通知」
2. **触发时机**（三个事件合并在同一组，每个事件是「开关 + 该事件的提示音」两行）
   - 任务完成 / 需要操作 / 出错，各自一个开关
   - 开关**打开时才出现**它自己的音效行（选择器 + 图标试听）；开关关闭，音效行整行消失
   - 三个默认音互不相同：叮咚 / 竖琴琶音 / 水滴
   - 把某个音效选成**静音**，就是单独关掉这个事件的声音，而事件开关保持开启
3. **范围**：仅在页面处于后台时提醒、包含子代理、**统一音量** 0–100

另外：**权限申请**是一条内联 Alert（未决定时显示说明 + 「允许通知」按钮；被拒绝/不支持时显示对应警告且不给按钮），**授权后这条 Alert 直接消失**，不留常驻的“已允许”行。末尾有「发送测试通知」按钮。

总开关关闭时，三个事件开关、音效行、音量滑杆一并禁用。

设置按浏览器保存在 `localStorage`（`dsh.agent-notifications.v1`），因为这些偏好与「本浏览器的通知权限」同域；同账号换浏览器不会互相覆盖。存储不可用或内容损坏时回落到内置默认值，页面仍可修改（仅本次会话生效）。

## 声音 / Sound

提示音由 Web Audio 合成，不加载音频文件：首次点击/按键时解锁音频上下文；浏览器若拒绝播放则静默跳过，不影响通知。通知本身始终带 `silent: true`，避免与系统提示音叠加。

音色按「敲击琴弦」建模，而不是开关式蜂鸣：每个音都是正弦波，带几毫秒的起音和长指数衰减，并叠一层很轻的八度/十二度泛音。五个预设分别是单音轻提示、两音叮咚、木琴双音、竖琴三音琶音、水滴下行两音；100% 音量也留有充足余量，整体偏柔和。

三种情况**分别选音、默认不同**，闭着眼也能分辨是完成还是出错：

| 情况 | 默认音 | 听感 |
|---|---|---|
| 任务完成 | 叮咚 | 明亮上行，收束感 |
| 需要操作 | 竖琴琶音 | 三音上行，偏「提示」 |
| 出错 | 水滴 | 下行两音，偏「回落」 |

**音量只有一个**，作用于全部三种音。

### 自动播放策略

浏览器（尤其 Chrome）会阻止没有用户交互的页面出声，空闲一段时间后还会再次挂起音频上下文。处理方式：

- 首次点击/按键/窗口获得焦点时解锁，**监听器常驻**而不是用完即弃——否则上下文被重新挂起后就再也响不了。
- 每次播放**先排程音符再 `resume()`**：音符排在上下文自己的时间轴上，`resume()` 一通过就立刻发声；先等 `resume()` 再排程会丢掉那一轮提醒（这正是「有时候听不到」的主要原因）。
- 切回标签页时主动 `wake()` 一次。
- 真被拒绝时（`resume()` reject），试听按钮会就地给出说明，而不是静默失败。

## 行为细节

- 点击通知会聚焦窗口并打开对应会话（会话已不存在时只聚焦）。
- 首次看到某会话状态只做基线，不会在页面打开或重连时轰炸通知。
- 同一会话同一类型 4 秒内只响一次；不同的审批/提问请求各自算独立提醒。
- 权限未授予时不构造通知，但仍播放提示音作为降级提醒。
- 浏览器不支持通知 API（或非安全上下文）时只播放提示音，设置页会说明。

## 安装

### 方式一：官方插件界面（推荐）

打开 Harness 的 **插件** 面板（侧边栏底部「插件」/ **Plugins**），点 **添加插件**（Add plugin）→ **安装第三方插件**，在「包名或地址」（Package name or address）里填入：

```
dsh-plugin-agent-notifications
```

然后安装。装完刷新页面。

这条路径同样支持 GitHub 仓库地址和本地目录，所以下面两种写法也能直接粘进同一个输入框。

### 方式二：命令行

```bash
dsh plugin --profile web add dsh-plugin-agent-notifications
```

### 方式三：Git 仓库

```bash
dsh plugin --profile web add https://github.com/genius-alray/dsh-plugin-agent-notifications
```

### 方式四：本地目录（开发用）

```bash
dsh plugin --profile web add /绝对路径/dsh-plugins/agent-notifications
```

无论哪种方式，安装都会把这个 bundle 登记到当前 profile 的 `package.json` `dsh.profile.bundles`，并按包内 `cordis.patch.yml` 增加一行 `agent-notifications`；不覆盖任何官方组件。

## 开发

```bash
npm run check
npm test
```

测试用 `node:test`，无第三方依赖：`tests/harness.mjs` 模拟浏览器模块契约（`window.__ModuleLoader__`、`localStorage`、`Notification`、`AudioContext`、`Document`、`@deepseek-ai/dsh-client-ui-primitives`），其余文件分别覆盖通知引擎与去重、音色包络与自动播放策略、权限通道、设置页渲染（结构与交互）、以及 bundle 清单与 Loader patch 的一致性。
