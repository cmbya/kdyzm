# 取件与包裹设计场景

仅为设计原型，全部数据为合成示例。正式源码没有改动；提示性操作使用 `data-demo`，不会提交、同步、删除或改变生产记录。

## 场景索引

| 场景 ID | 范围 | 关键状态 |
| --- | --- | --- |
| pickup | 取件 | 默认按站点、单件、多件、未匹配、历史末尾 |
| pickup-time | 取件 | 按日期、站点分层 |
| pickup-history | 取件 | 已取历史 |
| pickup-empty | 取件 | 无待取、可添加与更新 |
| pickup-long | 取件 | 长码、无柜号、站点待确认、未归属 |
| notifications | 取件 | 待确认、无取件码短信、同步摘要 |
| notifications-empty | 取件 | 无待办、后台更新、未绑定仍可本地使用 |
| pickup-detail | 取件 | 未匹配仍可独立领取 |
| pickup-multi | 取件 | 同码多件、部分已取、成员选择 |
| pickup-match | 取件 | 候选、搜索、筛选、部分关联 |
| pickup-match-empty | 取件 | 搜索无结果、件数限制、权限、差异确认提示 |
| pickup-conflict | 取件 | 不同来源取件码选择 |
| pickup-source | 取件 | 原短信、关联依据、解除、此前已取归属 |
| pickup-menu | 取件 | 修改、站点、忽略、单码与日期组删除 |
| station | 取件 | 当前、常用、自动识别、空站点提示 |
| station-saved | 取件 | 修正已保存、优化进度独立 |
| pickup-edit | 取件 | 码、物流公司、标签、备注、已取状态 |
| pickup-ignore | 取件 | 忽略影响、可选原因、恢复路径 |
| packages | 包裹 | 未收到统计、平台、状态、按日期列表 |
| packages-filter | 包裹 | 角色、时间、隐藏记录 |
| package-detail | 包裹 | 完整名称、订单与运单信息、站点、领取 |
| package-multi | 包裹 | 一单多运单、独立领取 |
| package-expired | 包裹 | 超过 30 天、签收与仅归档、恢复 |
| package-delivery | 包裹 | 已送达待确认、本地收货记录 |
| package-date | 包裹 | 手工日期与恢复平台日期 |
| package-edit | 包裹 | 新增／编辑共用表单、单号校验边界 |
| package-error | 包裹 | 更新失败保留本地、账号异常 |
| package-loading | 包裹 | 初次加载、后台更新保留记录 |
| package-logistics | 包裹 | 时间线、查询失败但保留缓存、无轨迹提示 |
| package-history | 包裹 | 已完成、过期、手动、自动完成撤销与恢复 |
| pickup-unmatched | 取件 | 无商品关联，仍可独立领取 |
| pickup-linked-source | 取件 | 已关联来源、匹配依据、解除 |
| pickup-assignment | 取件 | 此前已取数量待确认归属 |
| pickup-reminder | 取件 | 未识别到取件码的原始短信 |
| notifications-review | 取件 | 待确认分类，独立关闭每条 |
| notifications-error | 取件 | 账号、本地读取、短信更新异常 |
| notifications-sync | 取件 | 更新中与同步结果，独立关闭 |
| station-empty | 取件 | 无可用站点 |
| pickup-match-conflict | 取件 | 末端站点差异，二次确认 |
| package-empty | 包裹 | 无记录，添加或绑定账号 |
| package-edit-error | 包裹 | 字段校验失败 |
| package-refreshing | 包裹 | 后台更新中继续展示本地记录 |
| package-logistics-empty | 包裹 | 平台未返回轨迹 |

## 信息整理

- 共 43 个可打开场景。列表商品名最多十字，完整名称放详情；取件卡以柜号、码、领取操作为主。
- 添加区为输入、添加、图标更新的单行。未匹配商品与平台留白，不增加重复占位标签。
- 同站点按柜号从小到大排列；展开历史后，待取记录仍在顶部、已取历史在末尾。
- 站点／日期只在分组标题出现；角色和平台作为同一行次级身份信息。
- 列表显示一句最新物流，轨迹与查询时间集中到物流面板。
- 低频编辑、忽略、删除放更多菜单；取件列表的已取历史位于末尾。
- 订单级字段只在详情顶部出现一次，每个运单保留各自状态与领取操作。
- 通知集中异常与需要确认的事项，每条使用独立关闭按钮，不与内容按钮嵌套。

## 不能被去重消除的规则

- 未匹配可独立取件；匹配只关联所选运单，不会领取或确认电商收货。
- 同码多件按成员领取。此前已取待归属时，准确确认相应数量。
- 已取关联不能在重新匹配时直接移除；单独解除会保留已取状态，解除后不自动重连。
- 删除码、忽略短信、隐藏订单含义不同，分别保留恢复或不重建说明。
- 物流签收、实际领取、上门送达确认、自动完成与归档不是同一状态。
- 超过 30 天归档；未签收仅归档。已签收的超期确认需保留原因，并可恢复当前订单。
- 包裹默认总数统计“未收到”；手动记录按条、过期订单按笔，多运单按包裹计。
- 站点修改保留短信和物流原文，同码包裹一起更换，优化进度单独记录。

源码依据：`pages/index/index.vue`、`pages/index/edit-code.vue`、`pages/packages/index.vue`、`pages/packages/edit.vue`、`components/PickupDetail.vue`、`components/StationChooser.vue`、`components/LogisticsTimeline.vue`、`services/pickup-matching-view.js`、`core/package-presentation.js`。

## 集成约定

- `pickup.js` 以 IIFE 注册到 `window.SCENES`，仅调用统一 `window.UI`。
- 未引入视觉 token。复用公共类：`stack`、`card`、`inset`、`hrow`、`between`、`chips`、`muted`、`small`、`text-action`、`code-hero`、`cabinet`、`mini-code`、`section-title`、`progress`、`field`。
- 额外布局类由主样式统一提供：`.quick-add`（输入余宽、添加 64px、更新 44px）、`.notification-item`（内容与 44px 关闭）、`.skeleton`（加载占位）。未加入任何独立色值或动效。
- 每个 section 内容包在 `.stack.gap-sm`，卡片间隔由统一样式控制。详情柜号使用 teal badge，避免复用列表大柜号格。
- 主样式需覆盖原生 `textarea`；公共 `field` helper 提供可见 label，标识符使用文本输入，长码不截断。
- 原型通过可打开场景演示状态，不增加真实后台接口。确认删除、解除、恢复、复制等通过原型反馈表达。

## 验证

- `node --check docs/designs/silver-cobalt-20261107/pickup.js` 通过。
- 初版隔离 VM 与 UI helper 桩检查已由真实 helper 集成检查替代；最新修订再次通过语法检查。
- 最新 `node verify-design.mjs` 通过：全设计目录 76 场景、326 导航目标、14 路由。该检查加载真实 `ui.js` 及两个场景模块。
- 最终统一 UI helper、页面壳和浏览器视觉验收由主代理集成执行。

## Modern Web Guidance

- `forms`：输入保留可见标签，取件码和运单按文本标识符呈现，避免依赖 placeholder 或数字转换；遵循 “use visible labels; do not rely on placeholder alone”。
- `accessibility`：额外操作使用原生 button，备注采用 label 关联 textarea；遵循 “Prefer HTML elements and attributes to ARIA”。统一页壳负责导航标题和焦点处理。
