# 后台优先升级：App 3.1.18 / 后台 3.1.15

## 使用方式

App「我的 → 检查更新」先访问当前已绑定后台的升级清单。后台有兼容的新版本时，直接从该后台下载内置APK；没有包、请求失败、清单无效或后台版本不高于当前App时，继续查询固定GitHub Release。未绑定后台时直接使用GitHub。后台有效但只有当前版本、且GitHub暂不可用时，保留后台有效版本结果。

如果旧容器内置的版本高于手机、但低于GitHub最新版本，手机先升级到后台内置版本，再次检查时继续查询GitHub。更新容器后即可直接使用其内置的新版本。

下载弹层显示「已绑定后台」或「GitHub」来源。后台下载失败、截断或摘要不符时，丢弃本次部分文件，重新从GitHub下载同一版本、同一摘要的包；不会拼接两个来源。取消下载会停止请求，不自动发起另一来源。覆盖安装仍由Android安装器确认。

用户已选择仅使用现有绑定地址，不增加独立内网IP配置。该HTTPS域名若在家庭网络内解析到NAS地址，即从局域网直连；没有内网解析时仍走当前地址实际路由，不能保证所有网络都绕开外网。

## 容器内置与发布顺序

镜像构建前运行打包脚本，从固定仓库稳定App Release取回清单、APK和SHA256SUMS，验证版本、大小、摘要和附件一致后，将三份文件置于镜像只读目录 /app/app-updates。容器启动和手机检查时直接读取本地文件，不临时从GitHub代理大文件，也不写入业务数据卷。

主分支构建装入当时最新稳定App。发布新App时，release.published事件自动再次构建镜像，将刚发布的APK内置；仍需管理员拉取新镜像并重建已有容器，已经运行的旧容器不会自动换包。各镜像发布串行，更新latest前核对当前main，历史App Release不能回退latest。也可使用workflow_dispatch指定App标签补构建。

没有内置包或内置包损坏时，普通后台业务继续运行，升级接口返回缺失状态，让App使用GitHub。

## 下载契约与校验

公开只读接口：GET/HEAD /app-updates/app-update.json；GET/HEAD /app-updates/PickCode-private-版本.apk。只公开已验证的当前发布文件，不提供目录列表或任意路径读取。清单返回原始内容，apkUrl仍固定指向zsdd2/kdyzm官方Release；App自行从原生已绑定地址生成后台路径，不采纳网页或清单提供的其他下载域名。

后台更新请求不携带平台Cookie、设备令牌或管理员凭证。后台路径不允许重定向；GitHub路径保留原固定仓库及官方CDN白名单。TLS、64KiB清单、80MiB APK、严格大小和SHA256、包名与递增版本、与已安装App相同签名等校验全部保留。换绑后新下载使用当前绑定地址或GitHub，不继续向旧后台发起下载。

## 升级与验收

本次首次需通过已有GitHub升级入口安装App3.1.18；更新后台到3.1.15后，之后新版才可使用后台优先下载。保留原后台数据卷和加密密钥，App覆盖安装保留现有数据，不要卸载。

验证与发布结果由TASK-029证据记录。真实手机局域网路由、HTTPS证书和系统安装流程仍需现场验收；仓库与镜像发布不等同于部署NAS。

实现依据：[GitHub release事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)、[工作流并发控制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。
