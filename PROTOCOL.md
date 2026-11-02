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
| GET /v1/admin/accounts | 管理员；账号状态及最近全账号采集任务syncJob、响应serverTime，不含Cookie |
| GET /v1/admin/families | 管理员；`{families:[{id,name}]}`，含无账号家人 |
| POST /v1/admin/families | 管理员；`{name}`，返回`{family:{id,name}}` |
| PATCH /v1/admin/families/:id | 管理员；`{name}`，重命名但不改变稳定ID |
| POST /v1/admin/accounts | 管理员；添加账号，`platform,label,cookie,enabled?,intervalMinutes?,familyId?` |
| PATCH /v1/admin/accounts/:id | 管理员；更新账号、Cookie或采集设置 |
| POST /v1/admin/accounts/:id/sync | 管理员；请求采集 |
| POST /v1/pairing-codes | 管理员；`{familyIds:[...]}`持续家人组授权，或旧`{accountIds:[...]}`，两种输入互斥；返回一次性码及二维码 |
| POST /v1/pairing-codes/preview | 公开限频；`{code}`，不消耗码的服务及授权范围预检 |
| GET /v1/admin/devices | 管理员；设备及授权范围 |
| PATCH /v1/admin/devices/:id | 管理员；`{familyIds?,accountIds?}`，缺席保留、空数组清除对应权限 |
| DELETE /v1/devices/:id | 管理员；撤销指定设备 |
| POST /v1/devices | 公开限频；`{code,deviceName}`兑换token、deviceId、accounts、families、familyIds |
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

### 家人归属与持续组授权

家人是`{id,name}`。账号新增`familyId,familyName`；`familyId:""`表示待归属，没有待归属伪家人ID。家人可以当前没有账号，仍可整组授权；设备每次请求按保存的`familyIds`解析当前账号，此后新增账号自动包含。暂停采集不会撤销权限。管理家人接口不创建额外登录身份。

旧数据库启动时只补充家人表及设备/绑定码的`family_ids`字段，原账号、订单、运单、设备token、加密凭证及人工操作ID保持不变。旧设备的明确账号权限存为`legacyAccountIds`，不会自动变成家人组授权。设备管理返回`familyIds,legacyAccountIds,accountIds`，其中`accountIds`是当前组账号与旧明确账号权限的并集。修改授权时缺席字段保留，显式`[]`清除；已撤销设备不可通过修改授权恢复。

设备兑换结果和快照增加`familyIds,families,legacyAccountIds`；`GET /v1/accounts`也携带三者。`legacyAccountIds`仅为旧明确账号权限，不能把当前`accounts`动态并集当成旧账号授权。新协议`familyIds`存在时，即使为空，也只按`familyIds`或`legacyAccountIds`判断历史记录权限；旧服务器缺席`familyIds`时客户端才可兼容旧账号范围。账号转组后，原家人的快照可包含历史订单而当前`accounts`为空，客户端应按记录归属导入，不能因此拒绝整个快照。快照的`families`只包含已授权家人及可见账号/记录实际引用的家人，`familyIds`始终表示设备真正持有的持续组权限，不能依据显示名称或`families`数组推导权限。`serverRevision`使用服务全局递增版本，归属、组权限和家人变更会更新快照。

订单与运单新增固化的`familyId,familyName`。记录首次入库时保存归属，新拆分运单继承所属订单的归属；平台输入不能覆写这些字段。旧待归属账号首次显式分配家人时，仅回填该账号尚无家人的既有记录。之后转组或先移回待归属再重新分配，都不会转移非空历史归属；家人重命名也不会改写历史快照名称。账号转组会使当前组账号范围随之改变，新家人组看不到旧家人历史，原家人组仍可读取其历史。转组会使在途采集结果失效，避免旧范围采集结果写入新家人。

家人设备读取快照、领取/隐藏/日期操作、订单详情刷新和对应任务状态，都按记录固化的家人ID校验；整账号采集仍要求当前账号权限。历史记录可能引用已不在`accounts`列表中的账号，客户端应依据记录自身的`platform,familyId,familyName`展示，不可反查当前账号归属覆盖历史。`?accountId=`只缩小已有权限；拥有某账号旧历史的家人仍可用它筛选自己的历史，不能获得该账号新家人的记录。

预检返回`{service:{name,baseUrl},scope:{familyIds,legacyAccountIds,families:[{id,name,accountCount}],accountIds,accounts:[{id,platform,label,familyId,familyName}],includeFutureAccounts},expiresAt}`。家人组模式的`includeFutureAccounts:true`，旧明确账号模式为`false`；摘要不包含Cookie、token、原始授权码、订单、运单或上游错误。预检和兑换共享基于真实连接IP与全局的猜码限频，响应`Cache-Control:no-store`，不信任`X-Forwarded-For`绕过限频。预检不消耗码，兑换时仍在事务内重新检查有效期和一次使用；二维码仍为`{schemaVersion:1,baseUrl,code}`，家人名称以服务端预检为准。

订单新增可选字段 `tradeStatus`（平台交易枚举）、`orderDateSource`（`platform/unknown/legacy`）和 `firstSeenAt`（首次记录时间，缺失为0）。新订单没有真实下单日期时 `orderDate=0`，不得用同步时间代替。历史记录没有来源标识时按 `legacy` 展示待确认，保留原数值；以后采集到真实日期可以补正，已验证的日期保持稳定。旧App忽略附加字段仍可同步，但未知日期和历史筛选需要新版App正确展示。

操作请求：`{operations:[{id,shipmentId,action,occurredAt}]}`，action仅为`pick/restore/hide/unhide`，每批1–100条。响应`{appliedIds:[]}`。同设备同ID重放幂等；同ID不同内容返回409；越权批次整体失败。短信正文、解析字段和任意凭证不能经操作接口上行。

3.1.3新增可选字段，schemaVersion仍为1。订单的`orderDateOrigin=list/detail`区分证据来源，`dateCheckedAt`记录实际详情补查时间。详情日期可以纠正旧列表日期，同一详情的新结果不能被更早的补查或列表值覆盖；人工记录不参与此纠正。

运单新增`logisticsEvents:[{time,timeText,description,location}]`，`time`为毫秒，无法解析为0且保留原`timeText`；`logisticsState=ok/empty/error/unavailable`，未查询时可为空或缺席；`logisticsCheckedAt`与`logisticsUpdatedAt`分别表示最近尝试、最近成功时间。`logisticsTruncated`提示节点已截断。每运单最多100条，description/location/timeText限制为600/120/100字符；同账号同运单的失败或空结果不清旧缓存。快照轨迹预算根据整个JSON实际UTF-8字节数计算，控制在1,900,000字节目标内（基础数据本身已超限的历史边界需另行分页），只裁输出不清数据库。

`logisticsDetailCheckedAt`为采集端内部公平轮询时间，旧客户端可忽略。新增字段不进入设备写操作白名单，仍不能通过App修改平台原始数据。

账号status为expired表示后台更新Cookie，设备仍有效；设备401表示重新绑定。错误JSON形如`{error:{code,message}}`。分页缺失、网络失败和上游过期时保留历史，真实结果以账号状态与lastSuccessAt为准。

## 站点别名扩展（3.1.13，兼容 v1）

设备快照增加 `stationRulesVersion`（非负整数）和 `stationRules`（启用站点及名称/地区/别名/子位置）。capability 为 `station_aliases_v1`。ETag 同时覆盖站点规则版本。下发不含候选、证据和 AI 配置，未声明能力的旧后台继续使用原匹配。

- 管理员 `GET/POST /v1/admin/stations`，`PATCH /v1/admin/stations/:id`，字段 `name,region,enabled,aliases:[{id?,name,source,subLocation}]`，保存增加规则版本。
- 管理员 `GET /v1/admin/station-candidates`，`POST /v1/admin/station-candidates/:id/approve`（`stationId?,alias?,subLocation?,name?,region?`）或 `/ignore`（空对象）。只有批准写规则。
- 管理员 `GET/PATCH /v1/admin/station-ai`，设置 `channelName,baseUrl,model,apiKey?,clearApiKey?,enabled,intervalMinutes,dailyLimit`。密钥加密；GET 只返回 `hasApiKey/apiKeyMasked`，空值保留，清除须显式指定。`POST /test` 和 `/run` 均为空对象；测试计额度，运行返回202接受状态，结果通过候选队列查询。
- 设备 `POST /v1/station-candidates`，`{items:[{id,stationName,fragment,source:'sms'}]}`，最多20项，只允许脱敏站名，返回 `acceptedIds` 供客户端确认。
- 设备 `POST /v1/station-proposals`，`{stationName,otherStationName,subLocation?}`，主动记忆名称关系；两个候选仍待管理员分别确认。设备不能直接写入共享别名、获取后台AI配置或其他人的候选。

平台候选仅从有效末端已到站、非已取/隐藏/归档的近期记录收集；AI异步处理与订单采集隔离。短信端默认关闭，开启后本地仅保留7天/200项队列。候选和传输均不含完整短信、取件码、运单、Cookie。修改密码与撤权后接口沿用原认证边界。
