# kdyzm · 私人取件助手服务端

为私人取件助手 3.1.0 提供线上订单、运单和取件码同步。Node 24 + SQLite，单容器运行，无需 Redis 或外部数据库。

源码：https://github.com/zsdd2/kdyzm

镜像：`ghcr.io/zsdd2/kdyzm:3.1.0`（Linux amd64 / arm64）

## 直接拉取部署

需要 Docker Engine + Compose v2，以及一个已配置 HTTPS 的反向代理。正式 App 只接受 HTTPS 服务地址，不能直接填服务器的 HTTP IP 地址。

1. 下载配置，放进同一个目录：

```sh
mkdir -p kdyzm
cd kdyzm
curl -fL https://raw.githubusercontent.com/zsdd2/kdyzm/main/compose.yaml -o compose.yaml
curl -fL https://raw.githubusercontent.com/zsdd2/kdyzm/main/.env.example -o .env
chmod 600 .env
```

2. 分别运行两次 `openssl rand -hex 32`，将两个不同的随机结果填写到 `.env` 的 `ADMIN_TOKEN` 和 `COOKIE_ENCRYPTION_KEY`。将 `PUBLIC_BASE_URL` 改成自己的 HTTPS 域名，如 `https://parcel.example.com`，不能包含路径。

3. 拉取并启动，不需要克隆或编译源码：

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
curl -f http://127.0.0.1:8787/health
```

`compose config --quiet` 不会打印配置里的秘密。健康接口正常返回 `{"ok":true}`。

默认只监听主机 `127.0.0.1:8787`。将现有 HTTPS 反向代理指向这个端口；若代理在另一台设备或另一个容器网络中，把 `BIND_ADDRESS` 改为代理可达的主机内网 IP，并限制该端口只允许代理访问。不要直接公开明文8787端口。TLS代理保留 `Authorization`、`If-None-Match`、`ETag`，不记录认证头和请求体。

同机 Caddy 的最小站点配置示例：

```caddyfile
parcel.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

本 Compose 不代替现有代理、域名解析或证书配置，也不自动启动模拟订单。

## 后台和 App 绑定

1. 浏览器打开配置的 HTTPS 域名，使用 `.env` 中的 `ADMIN_TOKEN` 登录后台。
2. 添加本人淘宝或拼多多账号及 Cookie，点击“立即采集”。默认每小时采集，可改为30分钟。Cookie 加密保存，不发送给 App。
3. 选择允许同步的账号，生成十分钟一次性绑定码或二维码。
4. App 的「我的 → 线上账号」填写同一 HTTPS 地址和绑定码。二维码可由系统识别后粘贴到 App。
5. 账号 Cookie 过期只需在后台更新；设备被撤销后需重新绑定。后台可以单独撤销设备。

淘宝使用本人 `taobao.com` 登录态 Cookie；拼多多使用 `mobile.yangkeduo.com`，需包含 `PDDAccessToken` 和 `pdd_user_id` 或 `pdduid`。不要把 Cookie、管理员 token 或加密密钥发到 Issue、提交或截图中。

## 数据与刷新

- 订单先进入包裹记录；到站且有码才进入取件列表。普通签收、退款或列表缺席不代表助手已取。
- 一单多运单独立保存，不确定哪个包裹对应取件码时保留无码，避免随意复制。
- 服务端约每小时采集；App 前台读取已有快照，后台约每小时同步；不是平台实时推送。
- 领取、恢复、隐藏等助手操作按设备和操作ID去重，离线可重放；不会在电商平台确认收货。
- 短信解析和关联在手机本地完成，短信正文不上行。
- Cookie AES-256-GCM 加密；设备token和绑定码仅hash落库；每个设备只能读取授权账号。

API见 [PROTOCOL.md](PROTOCOL.md)。

## 持久化、升级与备份

数据在命名卷 `kdyzm_kdyzm-data` 的 `/data` 内。容器删除重建不会删除该卷；不要执行 `docker compose down -v`。

升级时更改 Compose 的镜像版本后执行 `docker compose pull && docker compose up -d`。`latest` 跟随正式版本，`edge` 是主分支；建议部署固定版本。保留 `.env` 中的原密钥，否则无法解密旧 Cookie。

备份时先 `docker compose stop`，备份完整命名卷及 `.env`，然后 `docker compose start`。SQLite包含WAL文件，不能只复制运行中的单个 `.db`。密钥和数据应分开安全保存。恢复先在隔离环境验证，再切换正式服务。

## 开发和镜像构建

```sh
npm ci
npm test
docker build -t kdyzm:smoke .
node scripts/docker-smoke.mjs kdyzm:smoke
```

Node需要24.13.0或更新版本；内建SQLite可能显示实验特性提示。CI先跑业务、认证和采集器mock测试，再检查非root容器、只读根目录、API认证、SQLite写入与重启持久化，最后构建并推送amd64/arm64镜像。主分支发布`edge`，版本标签`v3.1.0`发布`3.1.0`和`latest`。CI使用GitHub提供的临时token，不需要在仓库保存发布密钥。

`npm run fixture`仅供本机临时模拟，监听127.0.0.1:8787，数据保存在内存且不联系电商平台。正式镜像不含fixture脚本或测试数据。

## 已知边界与许可

淘宝/PDD采集依赖登录态网页接口，并非官方公开查件API。平台可能修改字段、限制请求或要求验证；真实账号采集、平台风控及目标主机的HTTPS仍需部署者验收。历史暂无自动清理，大量历史积累时需另行设计分页，当前App单次响应上限2MiB。

采集器参考 [YUNXI-fi/Pickup-Code-Display](https://github.com/YUNXI-fi/Pickup-Code-Display) 提交 `034aad94559e8448644f4670408412ba7222a10d`。保留其完整[非商业许可](LICENSE)和[来源许可副本](licenses/Pickup-Code-Display-LICENSE.txt)，仅用于个人学习、研究及非商业用途，不得商用、转租或打包售卖。公开仓库不改变这些限制。
