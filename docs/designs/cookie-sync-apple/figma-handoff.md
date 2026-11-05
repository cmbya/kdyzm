# 登录同步 1.2 · 已确认 Figma 设计

保存日期：2026-11-05。用户已授权将确认后的本地设计同步到 Figma。

文件：[取件助手 · 登录同步 1.2 · 已确认设计](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0)

页面：`0:1`，名称为「已确认设计 · 登录同步 1.2」。

| 画面 | 节点 | 尺寸 |
| --- | --- | --- |
| 桌面首页 | [1:2](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0?node-id=1-2) | 1440 × 1065（完整内容） |
| 添加授权 / 选择连接方式 | [2:2](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0?node-id=2-2) | 1280 × 720 |
| 平台选择 | [3:2](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0?node-id=3-2) | 1280 × 720 |
| 同步结果 | [5:2](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0?node-id=5-2) | 1280 × 720 |
| 本地覆盖更新 | [4:2](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0?node-id=4-2) | 1280 × 720 |
| 窄屏首页 | [7:2](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0?node-id=7-2) | 390 × 952（完整内容） |
| 窄屏添加授权 | [8:2](https://www.figma.com/design/8vZ33CfpH5T718wSficdf0?node-id=8-2) | 390 × 844 |

## 来源与核验

- 直接使用本目录已确认的 `index.html` 结构、原始 `styles.css` 和 `app.js` 演示状态。原始三文件未修改，未读取任何真实 Cookie 或配对凭据。
- 使用 Figma 官方网页捕获保存可编辑图层；共 345 个文本图层、696 个自动布局框架。它们是源页面的原始可编辑框架，不是截图，也没有虚构为已发布组件库。
- 将捕获时遗漏的原生 `dialog::backdrop` 补成独立覆盖层：原 CSS 颜色 `#273d5c28`、模糊 `9px`。按窗口尺寸裁切弹窗画板，整理所有画板位置，避免并行捕获重叠。
- 已获取并目视检查全部七幅 Figma 渲染结果，检查主要文案、布局、按钮、平台标识、弹窗遮罩与窄屏排布；与本目录来源截图和 CSS 对照。
- 所有文本图层保留源页面在 Windows 中解析出的 `Segoe UI` 字体族，字体族断言无不符项。

## 已知限制

Figma MCP 云端字体目录不含 `Segoe UI`，读取文本节点时 `hasMissingFont=true`。已保留原字体名称与导入尺寸，未擅自换用 Inter 或其他设计字体。云端预览可显示内容，但会采用字体回退，细小字形/字重不能据此声明逐像素相同；在 Figma 编辑文本前应使用可访问本机 Segoe UI 的字体环境。产品实现应继续采用原 CSS 的系统字体栈。

此交付为设计状态归档，尚未建立 Figma 原型连线或复用组件库；交互行为以同目录 `app.js` 和业务实现验收为准。
