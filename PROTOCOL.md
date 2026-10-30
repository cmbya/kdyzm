# App 同步协议 v1

App 3.1.0使用以下兼容JSON接口。HTTPS origin不得带路径或凭证。管理接口用`x-admin-token`；设备用`Authorization: Bearer <device token>`，两种身份互不替代。

| 方法与路径 | 权限 / 用途 |
| --- | --- |
| GET /health | 公开存活检查，不返回业务数据 |
| GET /v1/setup | 公开初始化状态，`initialized,mode,minPasswordLength`，不返回初始化码或密钥 |
| POST /v1/setup | 首次初始化；`{setupCode,password,baseUrl?}`，成功后不可重复初始化 |
| POST /v1/admin/login | 管理员登录；`{password}`，返回`{token,expiresAt}` |
| GET /v1/admin/status | 管理员；服务地址和模式 |
| PATCH /v1/admin/settings | 管理员；`{baseUrl}`，设置HTTPS服务地址 |
| POST /v1/admin/password | 管理员；`{currentPassword,password}`，改密并返回新`{token,expiresAt}` |
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

## 服务端3.1.1初始化与管理会话

新部署无须提供密钥环境变量。服务生成持久Cookie加密密钥，并在尚未初始化时将一次性初始化码写入容器日志。`POST /v1/setup`要求正确初始化码与12–128字符密码；`baseUrl`可暂为空，否则须为HTTPS origin。成功返回`{initialized:true}`，重复初始化返回409。初始化前业务接口返回409 `SETUP_REQUIRED`。初始化和登录共享限频；服务不会将密码或密钥返回网页。

登录成功后，将返回的token放入`x-admin-token`。会话有效8小时，仅在服务内存中保存，重启即失效；网页也仅在内存保存，刷新页面需要重登。修改密码撤销旧管理会话并为当前请求返回新会话；当前密码错误返回401 `PASSWORD_INVALID`，不撤销会话。会话无效或过期返回401 `ADMIN_UNAUTHORIZED`。设置地址返回`{configurationMode,baseUrl}`；状态接口为`{fixture,baseUrl,configurationMode}`。地址未设置时生成绑定码返回409 `BASE_URL_REQUIRED`。

已有3.1.0部署保留原三项环境变量即可继续运行，`mode/configurationMode`为`environment`。登录密码填原`ADMIN_TOKEN`，原token直接鉴权仍兼容；设置和改密接口返回409 `ENVIRONMENT_READ_ONLY`。首次设置模式为`managed`，不能与旧环境变量配置混用。设备token、绑定和快照协议保持兼容；管理改密不撤销已绑定设备。

管理页面可从同Host的可信内网HTTP地址初始化；公网使用HTTPS反向代理，并保留原始Host。跨来源请求默认拒绝，原生App的无Origin设备请求仍按设备token鉴权。

## 快照与设备操作

快照结构：`{schemaVersion:1,serverRevision,accounts,orders,shipments,hiddenIds,deletedIds}`，可有附加警告字段。订单有`id,accountId,platform,platformOrderId,title,amount,orderDate,orderStatus,refundStatus`；金额缺失为null。运单有`id,orderId,accountId,waybillNo,carrier,status,pickupCode,station,arrivalAt,updatedAt,picked,hidden`。status为`transit/arrived/signed/unknown`，普通signed不派生picked。到站时间是首次已知时间，不随刷新改变。数组缺席不代表删除或已取。

订单新增可选字段 `tradeStatus`（平台交易枚举）、`orderDateSource`（`platform/unknown/legacy`）和 `firstSeenAt`（首次记录时间，缺失为0）。新订单没有真实下单日期时 `orderDate=0`，不得用同步时间代替。历史记录没有来源标识时按 `legacy` 展示待确认，保留原数值；以后采集到真实日期可以补正，已验证的日期保持稳定。旧App忽略附加字段仍可同步，但未知日期和历史筛选需要新版App正确展示。

操作请求：`{operations:[{id,shipmentId,action,occurredAt}]}`，action仅为`pick/restore/hide/unhide`，每批1–100条。响应`{appliedIds:[]}`。同设备同ID重放幂等；同ID不同内容返回409；越权批次整体失败。短信正文、解析字段和任意凭证不能经操作接口上行。

账号status为expired表示后台更新Cookie，设备仍有效；设备401表示重新绑定。错误JSON形如`{error:{code,message}}`。分页缺失、网络失败和上游过期时保留历史，真实结果以账号状态与lastSuccessAt为准。
