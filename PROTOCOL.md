# App 同步协议 v1

App 3.1.0使用以下兼容JSON接口。HTTPS origin不得带路径或凭证。管理接口用`x-admin-token`；设备用`Authorization: Bearer <device token>`，两种身份互不替代。

| 方法与路径 | 权限 / 用途 |
| --- | --- |
| GET /health | 公开存活检查，不返回业务数据 |
| GET /v1/admin/status | 管理员；服务地址和模式 |
| GET /v1/admin/accounts | 管理员；账号状态，不含Cookie |
| POST /v1/admin/accounts | 管理员；添加账号，`platform,label,cookie,enabled?,intervalMinutes?` |
| PATCH /v1/admin/accounts/:id | 管理员；更新账号、Cookie或采集设置 |
| POST /v1/admin/accounts/:id/sync | 管理员；请求采集 |
| POST /v1/pairing-codes | 管理员；`{accountIds:[]}`，返回一次性码及二维码 |
| GET /v1/admin/devices | 管理员；设备及授权范围 |
| DELETE /v1/devices/:id | 管理员；撤销指定设备 |
| POST /v1/devices | 公开限频；`{code,deviceName}`兑换token、deviceId、accounts |
| DELETE /v1/devices/current | 设备；撤销自己 |
| GET /v1/accounts | 设备；只返回获授权账号 |
| POST /v1/accounts/sync | 设备；请求获授权账号采集，不是同步完成回执 |
| GET /v1/snapshot | 设备；完整快照，支持ETag/If-None-Match/304 |
| POST /v1/operations | 设备；批量幂等人工操作 |

快照结构：`{schemaVersion:1,serverRevision,accounts,orders,shipments,hiddenIds,deletedIds}`，可有附加警告字段。订单有`id,accountId,platform,platformOrderId,title,amount,orderDate,orderStatus,refundStatus`；金额缺失为null。运单有`id,orderId,accountId,waybillNo,carrier,status,pickupCode,station,arrivalAt,updatedAt,picked,hidden`。status为`transit/arrived/signed/unknown`，普通signed不派生picked。到站时间是首次已知时间，不随刷新改变。数组缺席不代表删除或已取。

操作请求：`{operations:[{id,shipmentId,action,occurredAt}]}`，action仅为`pick/restore/hide/unhide`，每批1–100条。响应`{appliedIds:[]}`。同设备同ID重放幂等；同ID不同内容返回409；越权批次整体失败。短信正文、解析字段和任意凭证不能经操作接口上行。

账号status为expired表示后台更新Cookie，设备仍有效；设备401表示重新绑定。错误JSON形如`{error:{code,message}}`。分页缺失、网络失败和上游过期时保留历史，真实结果以账号状态与lastSuccessAt为准。
