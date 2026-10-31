# 3.1.5 包裹操作协议

兼容 schemaVersion=1。设备只能读取和操作已授权账号的订单，所有接口保留 Bearer 设备认证。快照新增 `serverVersion`、`capabilities`（`syncJobs`、`orderRefresh`、`orderDateOverride`）。

- `POST /v1/accounts/sync`：`{}` → `{accepted:true,jobs:[...]}`，202只表示请求已接收。
- `POST /v1/orders/:id/refresh`：`{}` → 同上，id为快照远端订单id。只查询该订单详情/物流。
- `GET /v1/sync-jobs/:id`：`{job}`，state为queued/running/completed/error/cooldown/disabled/expired；`retryAt`说明可重试时间，error脱敏。定向任务可附dateState/dateError/logisticsState/logisticsError，completed不代表每个字段成功。
- 同账号串行，5分钟冷却保留；全量任务执行时新的定向请求排队，不丢弃。3.1.7起普通冷却中的请求同样返回queued，retryAt为最早执行时间，到期自动执行一次；同范围重复请求复用任务。队列已满时cooldown表示本次未排队，需手动重试。任务状态暂存在进程内，重启后旧job返回404；客户端提示重新发起，不能据此清除本地记录。
- `/v1/operations` 新增 `{id,orderId,action:'setOrderDate',date:'YYYY-MM-DD'|null,occurredAt}`。null恢复平台日期；幂等、事务和时间冲突保护与领取操作一致。过期离线操作以superseded确认，快照返回当前有效值。
- 订单平台日期字段保留，人工修正独立为dateOverride/dateOverrideAt，另有dateState/dateError。运单新增logisticsError，失败不清历史轨迹。短信融合和人工领取由App保留原规则。

App离线日期/领取操作排队，恢复网络后上传。手工日期只精确到日。卡片中订单号、各运单号码、确认后的取件码分别复制；冲突码必须确认后才能作为取件码展示。
