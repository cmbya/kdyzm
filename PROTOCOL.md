# App 同步协议 v1

App 3.1.0使用以下兼容JSON接口。HTTPS origin不得带路径或凭证。管理接口用`x-admin-token`；设备用`Authorization: Bearer <device token>`，两种身份互不替代。

| 方法与路径 | 权限 / 用途 |
| --- | --- |
| GET /health | 公开存活检查，返回`{ok:true,serviceId}`，不返回业务数据或局域网地址 |
| GET /v1/setup | 公开初始化状态，`initialized,mode,minPasswordLength`，不返回初始化码或密钥 |
| POST /v1/setup | 首次初始化；`{setupCode,password,baseUrl?}`，成功后不可重复初始化 |
| POST /v1/admin/login | 管理员登录；`{password}`，返回`{token,expiresAt}` |
| GET /v1/admin/status | 管理员；服务地址和模式 |
| PATCH /v1/admin/settings | 管理员；`{baseUrl?,lanBaseUrl?}`，设置HTTPS服务地址，缺席保留、空串清除 |
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
| GET /v1/connection | 设备；`{schemaVersion:1,serviceId,lanBaseUrl}`，只应经已绑定可信地址获取 |
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

## 局域网连接与采集摘要（兼容 v1）

`lanBaseUrl`默认为空，只接受无路径、查询、片段或凭据的HTTPS origin；后台不猜测容器宿主机地址。管理员在服务设置中配置一次，旧App忽略新字段且旧设置请求不会清除它。环境变量模式使用可选`LAN_BASE_URL`，仍只读；管理模式通过设置保存。实际入口须提供匹配地址且由手机系统信任的有效证书。

`serviceId`为32位小写十六进制稳定实例标识：管理模式随机生成并保存于原配置文件，旧配置仅补缺字段；环境模式由原加密密钥以独立用途HMAC派生，不返回原密钥。备份恢复同一配置保留该标识。它是实例匹配信息而非密码，也不能替代TLS认证。客户端只从原绑定可信HTTPS地址取得连接配置，在候选地址完成TLS校验、匿名`/health`实例匹配后才允许发送设备token；失败继续使用原地址，不能降级HTTP或跟随重定向。

设备快照增加`syncJobs`，最多100条最新的已授权scope摘要。scope为精确`accountId + orderId`，`orderId=''`表示全账号；账号任务按当前账号权限，订单任务按订单固化家人权限过滤。摘要包含原任务字段以及`familyId,createdAt,updatedAt,startedAt?,finishedAt?`；`updatedAt`仅在状态改变并持久化时推进。保留摘要的scope中，新任务`createdAt`严格晚于旧摘要`updatedAt`，且`updatedAt>=createdAt`，保证同毫秒请求、重启或时钟回拨后仍能排序；开始和完成时间保留实际时钟。客户端可用较新的同scope摘要替换缓存终态或确已被替代的较早在途任务，列表缺席不表示该scope成功或可删除；不凭账号`status=ok`抹掉无关失败。旧服务缺少该字段时继续旧轮询方式。

后台持久化每scope最新摘要，最多保留1000条终态及尚在途任务，不保存凭据或上游原文。重启保留终态，将未完成任务明确标为中断错误，不自动重发平台请求；更新登录凭据或账号归属后旧版本摘要不再进入快照。任务变化增加`serverRevision`，且摘要参与快照ETag，稳定状态可返回304。在途和终态均可下发，`empty/unavailable`附带的说明表示平台未提供信息，只有明确`error/expired`等失败状态才当作错误。

## 站点别名扩展（3.1.13，兼容 v1）

设备快照增加 `stationRulesVersion`（非负整数）和 `stationRules`（启用站点及名称/地区/别名/子位置）。capability 为 `station_aliases_v1`。ETag 同时覆盖站点规则版本。下发不含候选、证据和 AI 配置，未声明能力的旧后台继续使用原匹配。

- 管理员 `GET/POST /v1/admin/stations`，`PATCH /v1/admin/stations/:id`，字段 `name,region,enabled,aliases:[{id?,name,source,subLocation}]`，保存增加规则版本。
- 管理员 `GET /v1/admin/station-candidates`，`POST /v1/admin/station-candidates/:id/approve`（`stationId?,alias?,subLocation?,name?,region?`）或 `/ignore`（空对象）。只有批准写规则。
- 管理员 `GET/PATCH /v1/admin/station-ai`，设置 `channelName,baseUrl,model,apiKey?,clearApiKey?,enabled,intervalMinutes,dailyLimit`。密钥加密；GET 只返回 `hasApiKey/apiKeyMasked`，空值保留，清除须显式指定。`enabled`只控制定期分析，已完整配置时即使关闭定期也可手动分析。`dailyLimit`默认20，可调高，只接受正安全整数；`usageToday`为上海时区当天调用数，含连接测试和每次重试。上传每批20条、候选队列2000条的限制独立于每日额度。
- 管理员 `POST /v1/admin/station-ai/test` 和 `/run` 均为空对象；测试只发固定无隐私JSON。运行返回202及 `{accepted,running,code,message,retryAt?}`。`code`包括 `AI_ACCEPTED/AI_NOT_CONFIGURED/AI_RUNNING/AI_DAILY_LIMIT/AI_NO_PENDING/AI_RETRY_COOLDOWN/SERVICE_STOPPING`；定时器还可能返回 `AI_AUTOMATIC_DISABLED/AI_NOT_DUE`。`retryAt`为等待截止毫秒。请求未接受时不调用模型、不扣额度。临时失败最多即时重试一次，每候选累计最多3次非取消尝试；`attempts`累计实际调用，`cancelledAttempts`单独记录取消的调用，取消仍扣每日额度，但不耗尽失败重试次数。其余结果仍需人工确认。
- 设备 `POST /v1/station-candidates`，`{items:[{id,stationName,fragment,source:'sms'}]}`，最多20项，只允许脱敏站名，返回 `acceptedIds` 供客户端确认。
- 设备 `POST /v1/station-proposals`，`{stationName,otherStationName,subLocation?}`，主动记忆名称关系；两个候选仍待管理员分别确认。设备不能直接写入共享别名、获取后台AI配置或其他人的候选。

平台候选仅从有效末端已到站、非已取/隐藏/归档的近期记录收集；AI异步处理与订单采集隔离。短信端默认关闭，开启后本地仅保留7天/200项队列。候选和传输均不含完整短信、取件码、运单、Cookie。修改密码与撤权后接口沿用原认证边界。

候选可附带 `analysis`，仅管理员读取；未曾调用时为null或缺席。结构为 `{startedAt,finishedAt,input,result,error}`，仅保留最近一次实际调用。`input`与本次发送给模型的user JSON完全相同，包含脱敏 `fragment,region,knownStations,knownStationsTruncated`；站点上下文超过16KiB时，发送前缩减整个站点条目并设置 `knownStationsTruncated:true`，详情不是完整原始HTTP请求。`result`只保存通过字段、站点ID及原文证据校验的结构；无有效返回时为null，不保存供应商原始内容。`error`只含本地白名单 `code,message`，不保存headers、API Key、供应商原文错误或完整短信。每条analysis最多24KiB，重试覆盖上一条记录，不累积请求日志；`finishedAt=0`表示尚未完成或中断，不能当成已返回结果。

更换后台AI地址、模型或密钥会使整个旧批次失效，涵盖在途调用、重试等待与候选间隙；旧批次不能转用新渠道，须重新发起分析。清除密钥和服务关闭也会取消；晚到结果不采纳。取消记录本地安全原因，候选可重新分析，已确认或忽略的候选不会恢复待处理。关闭定期分析会取消该定期批次，手动批次不受自动开关影响。已有候选的人工审核与订单采集继续独立运行。所有实际网络请求沿用公网HTTPS、DNS解析校验并固定地址、禁止重定向、超时和响应大小边界。

## 物流明文识别模板（兼容 v1，后台 3.1.16）

后台模板与 App 本机模板独立保存。3.1.22起通过后述独立只读层同步后台模板；本机编辑不上传、不覆盖后台模板。已有站点别名接口保持不变；模板负责从物流正文提取站点与到站证据，不直接确认同站别名或强制合并包裹。

- 管理员 `GET /v1/admin/logistics-rules` 返回 `{revision,rules,defaults}`，初始 revision 为 1。
- 管理员 `PATCH /v1/admin/logistics-rules` 接收 `{revision,rules}`，整体保存并增加版本；过期版本返回 `409 LOGISTICS_RULE_CONFLICT`，不覆盖较新规则。
- 管理员 `POST /v1/admin/logistics-rules/test` 接收 `{rule,sample}`，返回 `{station,arrival,status,ruleId,reason}`。只预览，不保存、不发起采集或 AI。停用规则也可预览，新草稿可传空 ID。
- 规则字段为 `{id,name,enabled,kind,starts,end,keywords,sample,expectedStation,origin}`。`kind=arrival/location`，`origin=builtin/manual`，starts 是 1–20 个字面前文、keywords 是最多 10 个同片段必须包含的关键词；end 为空按标点截断，也支持逗号等字面结束标记。启用前必须用样例准确提取预期站点，到站规则还须验证到站事件。仅支持明文，不接收正则或脚本。
- 最多 100 条、60000 字符，HTTP 请求仍受原 64 KiB 限制；名称/前后文各最多 80 字符，样例 600 字符、站名 120 字符。无效输入返回 `400 INVALID_LOGISTICS_RULE`，保留原配置。

接口沿用 `X-Admin-Token`、来源限制和管理员会话校验，设备 token 无写权限。保存后下一次成功采集或定向刷新按该次采集的模板快照处理；失败保留原证据。保存操作本身不访问平台、不更改旧记录。预计、否定、请求、退回、中转和催取保护固定生效；仅站点位置规则不会生成到站时间。

## Docker 内置 App 更新包

以下只读接口公开且无需凭证，初始化前也可使用：

| 方法与路径 | 响应 |
| --- | --- |
| GET / HEAD /app-updates/app-update.json | 内置发布清单的原始字节；`application/json`、`Cache-Control: no-store` |
| GET / HEAD /app-updates/PickCode-private-&lt;versionName&gt;.apk | 清单对应的唯一版本 APK；`application/vnd.android.package-archive`、`Cache-Control: public, max-age=31536000, immutable` |

两者均返回 `Content-Length` 和以文件 SHA-256 为值的 `ETag`。HEAD 只返回头部，APK 下载流不会为 HEAD 打开。服务启动时校验服务根目录 `app-updates/`（镜像中为 `/app/app-updates`）的清单、APK 大小/流式 SHA-256 与 `SHA256SUMS`，请求时确认已校验文件未变化；缺失或损坏返回 404 / 503，App 可回退 GitHub。更新包校验失败不影响 `/health`、初始化或业务同步。

清单保持现有发布格式与 GitHub 官方固定 `apkUrl`，不会按请求 Host 改写，不返回重定向。客户端可用已绑定后台 origin 加上述固定 APK 路径下载，并继续核对清单大小、摘要和安装签名。此接口无需管理或设备凭证，只公开精确清单和当前版本 APK；其他文件、目录、旧版本及路径穿越均不开放，`SHA256SUMS` 也不对外提供。账号、设备、凭证与业务数据继续使用原有接口鉴权。

## 自动调优与只读物流规则同步（兼容 v1，后台3.1.22 / App3.1.25）

`GET/PATCH /v1/admin/station-ai` 增加布尔 `autoApply` 与 `logisticsEnabled`，默认均为false。前者允许校验通过的自动应用，后者允许物流候选处理；自动运行还受原 `enabled`、有效渠道及共享额度约束。旧客户端不传字段时保留原值。后台界面一次勾选“自动调优（站点＋物流）”保存两者；关闭后站点回到仅建议模式。能力测试可新增 `logistics_rule` 结果，旧结果渲染保持兼容。

自动站点更新只追加唯一且有原文依据的既有启用站点别名，不新建/合并标准站。物流只接受受限字面模板，并验证原始材料、完成到站语义、具体公共站点、固定反例及已有物流语料无回归；缺依据与冲突留待核对。此显式模式取代上文“其余结果仍需人工确认”的限制，未开启时原人工确认流程保持。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| GET /v1/admin/logistics-ai | 管理员；`{candidates,running}`，候选含状态、脱敏片段、建议及未应用原因 |
| POST /v1/admin/logistics-ai/:id/ignore | 管理员；`{}` → `{candidate}`，已应用规则须撤回 |
| GET /v1/admin/ai-optimization/history | 管理员；`{changes}`，每条含id、kind、summary、status、appliedAt、rolledBackAt、canRollback |
| POST /v1/admin/ai-optimization/history/:kind/:id/rollback | 管理员；kind为station_alias或logistics_rule；`{}` → `{change}` |

撤回只移除本次新增且尚未被人工改动的内容，否则409。物流规则保存及缓存重算同事务完成；自动修改记录同事务保存。授权、渠道或开关变化会取消旧模型结果，模型不能执行代码或直接改包裹归属。

设备 `GET /v1/snapshot` 兼容增加 `serverLogisticsRulesVersion` 与 `serverLogisticsRules`。规则只含 `id,name,enabled,kind,starts,end,keywords,origin`，不含管理员原始sample/expectedStation、候选、密钥或其他凭证。ETag包含规则版本。App单独保存并用于重算；同ID本机规则（包括停用）优先，解绑/换绑清除只读层。旧后台缺字段时兼容；旧App忽略新增字段。匹配仍由本机确定性证据及唯一性规则决定。

## 浏览器 Cookie 同步（兼容 v1）

以下单账号授权独立于管理员会话和手机设备 token，只允许向一个既有的淘宝、拼多多或京东账号提交登录 Cookie。它没有订单读取、设备管理、角色整组或管理员权限；不能创建账号或更改平台、角色、名称、采集开关。服务须先初始化。后述角色授权采用独立接口和 token，旧单账号接口保持兼容。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| POST /v1/admin/cookie-sync/pairing | 管理员；`{accountId}` → `{code,expiresAt,baseUrl}` |
| GET /v1/admin/cookie-sync/connections?accountId=:id | 管理员；`{connections}` |
| DELETE /v1/admin/cookie-sync/connections/:id | 管理员；`{revoked:true}` |
| POST /v1/cookie-sync/pairing/preview | 公开限频；`{code}` → `{account,expiresAt,serviceId}`，不消耗配对码 |
| POST /v1/cookie-sync/connections | 公开限频；`{code,name}` → `{token,connection,account,serviceId}` |
| GET /v1/cookie-sync/current | 插件 Bearer token；`{connection,account,serviceId}` |
| POST /v1/cookie-sync/current/preview | 插件；`{cookie}` → `{confirmationToken,identityHint,account,expiresAt}` |
| POST /v1/cookie-sync/current/cookie | 插件；`{cookie,expectedCredentialVersion,confirmationToken?}` → `{changed,connection,account,serviceId,job?}` |
| DELETE /v1/cookie-sync/current | 插件；`{revoked:true}` |

`account` 仅含 `{id,platform,label,familyId,familyName,credentialVersion,status}`；`connection` 仅含 `{id,name,platform,accountId,createdAt,expiresAt,revokedAt,lastSyncAt,identityBound,identityHint}`。未撤权的 `revokedAt` 为 null、尚未同步的 `lastSyncAt` 为 0。所有响应 `Cache-Control:no-store`，不返回 Cookie、内部身份摘要或已签发的 token；只有兑换成功响应返回一次新 token。名称和角色显示文本不能作为平台账号身份依据。

配对码为 `CS-` 加 43 个 base64url 字符（256 位随机量），有效十分钟，服务端只保存 SHA-256；同账号重新生成码使旧码失效。配对码绑定创建时账号、角色和凭据版本，兑换时重新校验并在事务内单次消耗。预检和兑换共享真实连接 IP 十分钟十次、全局一百次的限频，不信任 `X-Forwarded-For`。管理员每账号十分钟最多生成十次。未过期配对码最多一千条，过期即清理。

插件 token 为 `csg_` 加 43 个 base64url 字符，仅保存 SHA-256，有效九十天。同一账号兑换新授权会立即撤销旧授权；不同账号互不影响。账号角色转移在数据库写入时撤销该账号所有插件授权和待用配对码，转回原角色也不恢复。角色重命名不改变授权。历史撤权/过期连接最多保留一千条，并清理到期三十天以上的记录；总连接数最多五千，达到上限时拒绝新增而不丢弃有效授权。重启保留授权、身份绑定与撤权状态。

仅 `/v1/cookie-sync/` 命名空间接受 `chrome-extension://` 加 32 个 `a`–`p` 字符的来源和预检；其他接口不向扩展来源开放。来源允许不代替 token 鉴权。账号、Cookie 和确认字段均使用白名单，读取完整请求体后再次检查授权，确保在途上传不能越过撤权或转组。

身份只从严格解析的 Cookie header 取得：淘宝 `unb`，拼多多 `pdd_user_id/pdduid`，京东 `pin/pt_pin`（按百分号解码）。同平台多个身份字段必须一致，重复 Cookie 名、缺失/空白身份、冲突、无效编码或控制字符均拒绝；登录字段还须分别包含非空 `cookie2`、`PDDAccessToken`，或京东桌面订单页使用的 `thor/light_key` 二者之一。不把 `flash`、移动端 `pt_key` 或裸 `pin` 代替京东登录态。上传最多 16384 字符，整个 JSON 请求仍受 64 KiB 限制。身份绑定保存带服务密钥的 HMAC-SHA-256，仅展示脱敏尾号。

每个新授权首次上传必须先预览并由用户确认角色和平台账号。确认 token 有效五分钟，只存摘要，绑定授权、完整 Cookie 摘要及账号凭据版本；重新预览替代旧确认，成功上传后清除。已存在后台 Cookie 可解析身份时必须一致；旧凭据缺少身份允许首次明确确认，冲突或格式错误则请管理员先核对。绑定后只接受同一身份的自动续更；管理员换成另一平台身份时旧连接拒绝继续，需重新配对。

`expectedCredentialVersion` 为必填正安全整数，过期版本返回 `409 COOKIE_CREDENTIAL_CONFLICT`，保留原凭据。首次无有效确认返回 `409 COOKIE_CONFIRMATION_REQUIRED`；身份不一致为 `409 COOKIE_IDENTITY_MISMATCH`，已有后台身份异常为 `409 COOKIE_BACKEND_IDENTITY_INVALID`；身份缺失、冲突和缺少登录字段分别为 `400 COOKIE_IDENTITY_REQUIRED/COOKIE_IDENTITY_AMBIGUOUS/COOKIE_LOGIN_REQUIRED`；授权过期或撤销为 `401 COOKIE_SYNC_UNAUTHORIZED`；码失效为 `400 COOKIE_PAIRING_INVALID`。

完全相同的 Cookie 返回 `changed:false`，不增加凭据版本、不采集，可更新 `lastSyncAt`。变化则使用原 AES-GCM 加密存储，增加凭据版本使旧采集结果失效，保留原 `lastAttemptAt/nextSyncAt` 冷却与定时设置，并请求一次采集。已有运行采集时在其完成后再次核对授权与凭据版本再请求；期间更新、撤权、转组或关闭服务则取消该次后续请求。原已排队任务可复用并在启动时读新凭据。停用账号不会被启用，五分钟采集冷却仍生效。每授权一分钟最多六次变化写入、一百二十次接口请求，预览最多二十次；限频失败保留原 Cookie。

### 角色级浏览器授权

角色授权包含该角色当前及以后加入的淘宝、拼多多和京东账号，但不含订单、设备或管理员权限。插件须将每个账号的“选中”和“自动同步”默认关闭；每个账号仍单独预览并确认身份后才能写入。空角色也可以授权。角色改名不撤权，账号移出角色则不再可读写；移回时原子授权已永久撤销，客户端看到 `connection:null`，须清除该账号的自动同步选择并重新明确确认。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| POST /v1/admin/cookie-sync/families/pairing | 管理员；`{familyId}` → `{code,expiresAt,baseUrl}` |
| GET /v1/admin/cookie-sync/families/connections?familyId=:id | 管理员；`{connections}` |
| DELETE /v1/admin/cookie-sync/families/connections/:id | 管理员；`{revoked:true}`，同时撤销所有子授权 |
| POST /v1/cookie-sync/families/pairing/preview | 公开限频；`{code}` → `{family,accounts,expiresAt,serviceId}` |
| POST /v1/cookie-sync/families/connections | 公开限频；`{code,name}` → `{token,connection,family,accounts,serviceId}` |
| GET /v1/cookie-sync/families/current | 角色 token；`{connection,family,accounts,serviceId}` |
| DELETE /v1/cookie-sync/families/current | 角色 token；`{revoked:true}` |
| GET /v1/cookie-sync/families/current/accounts/:accountId | 角色 token；`{account,connection,serviceId}` |
| POST /v1/cookie-sync/families/current/accounts/:accountId/preview | 角色 token；`{cookie}` → 原单账号预览字段及 `{connection,serviceId}` |
| POST /v1/cookie-sync/families/current/accounts/:accountId/cookie | 角色 token；请求/响应沿用单账号 Cookie 写入接口 |

角色配对码为 `CF-` 加 43 个 base64url 字符，有效十分钟、单次使用；角色 token 为 `cfg_` 加 43 个 base64url 字符，有效九十天。两者只保存 SHA-256，不能与旧 `CS-/csg_`、设备 token 或管理员会话互换。角色配对预览不继承旧授权，因此其中子连接均为 null；兑换新角色授权时撤销同角色旧父授权及全部子授权，保留已有单账号授权。旧单账号重新兑换沿用原替换行为，撤销对应账号的角色子授权；角色父授权仍有效，但该账号必须重新预览。所有写操作仍复用原身份、确认摘要、凭据版本和冷却检查。

父 `connection` 为 `{id,name,familyId,createdAt,expiresAt,revokedAt}`；`family` 为 `{id,name}`；`accounts` 为 `[{account,connection:null|子连接摘要}]`。子连接摘要与原单账号字段相同，没有子 token。读取不创建子授权，只有成功的明确预览才创建；上传接口不会恢复缺失、过期或撤销的子授权。子授权在父授权到期时一同到期。流式请求在完整读取 JSON 后重新校验父授权、当前角色归属、原子授权 ID 和版本，防止撤权、替换以及转走再转回的旧请求写入。

每父授权每分钟最多 240 次接口调用，每父授权/账号最多 120 次，预览 20 次、变化写入 6 次；限频键不会因子授权重建而重置。配对猜测与旧接口共享 IP/全局限频。角色待用码最多 1000、父连接最多 5000、失效父连接历史最多 1000，并清理到期三十天以上的历史；删除历史父连接只级联清理其子状态。旧 3.1.18 数据库只新增角色相关表及可空 `family_connection_id`，原账号、密文、单账号授权和待用码保持有效。

撤销阻止后续 Cookie 写入及尚未发起的“旧采集完成后再请求”回调；已经由后台接受的共享采集队列仍由原账号调度器管理，不因浏览器退出而取消管理员或其他入口的任务。

### 插件先发起授权与首次建立平台账号

插件可先让用户登录平台，在本机检查登录态，再发起不含 Cookie 的授权申请。管理员仅在可信后台登录并选择角色；插件不接收管理员密码或管理会话。浏览器可打开后台 `/#cookie-sync-request=CR-...`，片段仅包含申请码，不得包含轮询密钥。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| POST /v1/cookie-sync/families/requests | 公开限频；`{name,platforms}` → `{requestId,code,pollToken,expiresAt}` |
| POST /v1/cookie-sync/families/requests/poll | 申请轮询密钥；`{requestId,pollToken}` → `{status:'pending',expiresAt}` 或 `{status:'approved',token,connection,family,accounts,serviceId}` |
| GET /v1/admin/cookie-sync/families/requests/:code | 管理员；`{requestId,name,platforms,expiresAt,status}` |
| POST /v1/admin/cookie-sync/families/requests/:code/approve | 管理员；`{familyId}` → `{approved:true}` |
| POST /v1/cookie-sync/families/current/platforms/:platform/preview | 角色 token；`{cookie}` → `{newAccount:true,platform,confirmationToken,identityHint,expiresAt,serviceId}` |
| POST /v1/cookie-sync/families/current/platforms/:platform/cookie | 角色 token；`{cookie,expectedCredentialVersion:0,confirmationToken}` → `{changed:true,account,connection,serviceId,job?}` |

`platforms` 是不重复的非空 `taobao/pdd/jd` 子集，只供管理员了解申请，不改变授权覆盖角色当前及未来账号的范围。申请码为 `CR-` 加 43 个 base64url 字符，轮询密钥为 `cpr_` 加 43 个 base64url 字符，有效十分钟，数据库仅存摘要和非敏感申请元数据。申请创建沿用配对猜测限频、最多 1000 条；轮询每 IP 每分钟 120 次、全局 3000 次。批准只保存角色 ID；首次成功轮询才在事务内消耗申请并签发一次角色 token，重新轮询或过期返回 `400 COOKIE_REQUEST_INVALID`。响应丢失需重新申请，不存可取回的明文 token。重复批准返回 `409 COOKIE_REQUEST_APPROVED`，其他角色或凭证不能代替轮询密钥。

首次建立平台账号仅适用于该角色完全没有该平台账号的情况。预览校验同样的平台身份和登录字段，只保存父授权/平台绑定的 Cookie 摘要、确认 token 摘要和五分钟有效期，不创建账号、不保存 Cookie、不发起采集。用户明确确认后，创建接口再次校验父授权、确认摘要、版本 0 及平台仍然缺席；账号、加密 Cookie、已绑定子授权和确认消耗在一个数据库事务中保存，失败整体回滚。账号名称由角色和平台生成，随后按原调度器请求一次采集。确认凭证不能用于其他角色、平台或 Cookie，撤权即清除。

若预览后已有该平台账号、另一请求先完成创建，或原本存在多个账号，返回 `409 COOKIE_PLATFORM_EXISTS`，不选择或覆盖任何已有账号。已有账号必须使用账号 ID 接口。客户端不能自动调用首次创建接口；应在展示角色、平台和脱敏身份并获得本次批量确认后逐个平台提交。后台创建接口不接受 `enabled`、任意名称、角色或内部事务标志。
