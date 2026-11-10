# 只读诊断 API

自动诊断使用独立凭据，不使用管理员网页的 8 小时会话。凭据不自动过期，服务重启后仍有效；管理员可以随时撤销。它可以读取所有账号的订单、物流和识别异常，但不能修改设置、同步 Cookie、触发采集、运行 AI 或修改订单。接口不会返回平台 Cookie、管理员密码、设备令牌或 AI 密钥。

首次配置：在后台“服务设置 → 基础设置 → 只读诊断 API”创建凭据并保存。完整凭据只显示一次，数据库只保存 SHA256 摘要。之后脚本直接携带凭据访问 API，后台网页可以关闭或退出。最多允许 10 个有效凭据；遗失后撤销并重新创建。修改管理员密码不会撤销这些独立凭据，停用脚本时应单独撤销。

以环境变量注入凭据，避免将它写入 URL、仓库或日志。部署使用已有 HTTPS 入口：

```powershell
$headers = @{ Authorization = 'Bearer ' + $env:PICKCODE_DIAGNOSTIC_TOKEN }
Invoke-RestMethod -Uri "$env:PICKCODE_BASE_URL/v1/diagnostics/status" -Headers $headers
```

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/diagnostics/status` | 版本、服务器时间、只读范围、`expiresAt: null` |
| `GET /v1/diagnostics/accounts` | 账号标识、平台、采集状态 |
| `GET /v1/diagnostics/orders` | 按 `query`（标题/订单标识）、`platform`、`accountId` 查询订单 |
| `GET /v1/diagnostics/orders/:id` | 规范订单 ID 对应的时间字段、来源、精度、包裹、完整已保存物流与相关异常 |
| `GET /v1/diagnostics/recognition-tasks` | 异常任务、重试进度 |
| `GET /v1/diagnostics/recognition-review` | 每日复盘、规则版本、学习结果；只读，不触发学习 |

订单列表使用 `limit`（默认 30，1–100）和 `after`（默认 0）。按响应 `nextCursor` 继续读取，直到为 `null`，筛选结果为空也可能有下一页。复盘接口默认 100 条，分页方式相同。订单详情返回数据库实际保留的物流记录，`logisticsTruncated` 表示上游或持久化阶段已截断，不代表接口可以恢复未保存的数据。未知时间保持 0/unknown，不用采集时间代替。

诊断请求只有 GET 白名单；不支持的写方法返回 405，缺失/失效凭据返回 401，频控返回 429（每 IP 和每凭据各 120 次/分钟）。所有响应禁止缓存。HTTP OPTIONS 仅处理跨域预检，不返回诊断数据。

凭据管理仍需要管理员权限（`x-admin-token`），可直接调用，无需操作网页：

| 方法与路径 | 请求/响应 |
| --- | --- |
| `GET /v1/admin/diagnostic-tokens` | `{credentials: [{id, name, createdAt, revokedAt}]}` |
| `POST /v1/admin/diagnostic-tokens` | `{name}` → 201 `{token, credential}`，名称 1–80 字符 |
| `DELETE /v1/admin/diagnostic-tokens/:id` | `{revoked: true}`，立即撤销、幂等 |

管理员会话、设备令牌和诊断凭据相互独立，不能互换使用。
