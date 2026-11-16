# mcp-cui-chrome

通用的本地 Chrome 操作 MCP。它不针对任何一个网站，也不内置某个业务的填写流程。服务说明会告诉模型：用户说打开 Chrome、打开网页、登录、点击或看页面时，用这套工具，不要改用 IDE 里的内置浏览器。窗口左下角有黄色 cui-chrome 标签。

浏览器是这台电脑上已经安装的 Google Chrome，配置目录单独放在 `%LOCALAPPDATA%\mcp-cui-chrome\chrome-profile`，不会占用日常使用的那个窗口。在这个窗口里登录过的网站，下次还会保持登录。

多个 Cursor 会话共用这一个窗口。先连上的会话负责打开它，后连上的会话接到同一个窗口，不再另开一个。两边的点击、输入会排队。后连上的会话如果调用关闭，只断开自己，窗口留着。

## 每一步都有说明

每个动作都会先停一下，再动手：

1. 开始前，窗口左下角的黄底标签写成 `cui-chrome  准备：…`，工具返回值的第一行也是这句。
2. 做完后，标签和返回值都改成 `结果：成功。…` 或 `结果：失败。…`。失败时带上原因。

页面上每个元素都会标出控件类型和对应操作，例如「操作：输入文字」「操作：点开后点选一项，不要输入文字」「操作：点击」「操作：拖动」。输入工具只接受文本框。下拉框要先点开，再点里面的选项。

## 环境

- Node.js 20 或更高
- 已安装的 Google Chrome

## 安装

本机已安装 Google Chrome 时，在 MCP 配置里这样接：

```json
{
  "mcpServers": {
    "cui-chrome": {
      "command": "npx",
      "args": ["-y", "mcp-cui-chrome"]
    }
  }
}
```

改完后重载 MCP。日志走 stderr，标准输出只留给协议。

从源码开发：

```bash
npm install
npm run build
```

## 工具

模型先看页面，再按编号操作。编号形如 `e1`、`e3`，页面一变就要重新读取。

编号找不到目标时（元素没被列进快照、页面结构太特殊、iframe 里定位不到），点击、输入、悬停、拖拽可以改传 CSS 选择器 `selector`，和 `ref` 二选一，优先用 `ref`。选择器会搜主文档和所有 iframe，命中多个时必须写得更精确或传 `nth` 指定第几个。拖拽的起点终点分别是 `fromSelector`、`toSelector`。不管走哪条路，鼠标轨迹、遮挡检查和逐字输入的行为都一样。

| 工具 | 作用 |
| --- | --- |
| `browser_navigate` | 打开网址。相同地址的标签已存在就切过去，否则新建标签 |
| `browser_snapshot` | 标题、网址、可操作元素编号、正文。有遮挡层会先写出来 |
| `browser_reload` | 刷新当前页，相当于 F5。本该有的内容没有时用一次 |
| `browser_click` | 沿鼠标轨迹移动后点击 |
| `browser_read_element` | 读取元素信息：文字、标签、属性、状态、位置尺寸、CSS 样式。文字藏在封闭影子节点里时会用调试协议穿透读取 |
| `browser_wait` | 等待元素出现、可见、消失或文字包含指定内容，替代固定延时 |
| `browser_dialog` | 管理 alert / confirm / prompt 弹窗：arm 登记自动处理，触发弹窗后 list 查看记录，off 取消 |
| `browser_type` | 逐字输入，可选先清空、输入后回车 |
| `browser_press` | 按键，例如 Enter、Escape |
| `browser_hover` | 悬停，不点击 |
| `browser_drag` | 按住一个元素拖到另一个元素，或按像素偏移拖动 |
| `browser_scroll` | 分段滚轮 |
| `browser_tabs` | 列出、新建、切换、关闭标签 |
| `browser_go_back` | 后退 |
| `browser_screenshot` | 当前视口截图 |
| `browser_close` | 关掉自己打开的 Chrome；接到别人的窗口时只断开连接 |

点击、输入和滚动都带随机停顿。鼠标走贝塞尔曲线，落点在元素内部的随机位置，不是每次都点正中心。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `MCP_CHROME_PROFILE` | 换一个配置目录 |
| `MCP_CHROME_PATH` | Chrome 不在默认位置时，填 `chrome.exe` 的完整路径 |
| `MCP_CHROME_HEADLESS` | 设为 `1` 时不显示窗口。有窗口时更接近真人使用 |
| `MCP_CHROME_CDP_PORT` | 给后启动的会话留的本机调试端口。不设或设为 `0` 时由 Chrome 自己选 |

## 能力边界

启动参数去掉了自动化开关，并用补丁版 Playwright 遮住常见的调试协议痕迹。这能降低「一眼看出是脚本」的概率。依赖 IP 信誉或验证码的网站仍然可能拦住访问。这个服务不处理验证码。

## 本地冒烟

```bash
npm run smoke
```

会弹出 Chrome，打开 example.com，点其中的链接，再打开检测页看 `navigator.webdriver`。
