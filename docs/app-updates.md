# Android App 发布与在线升级

手机优先读取已绑定后台内置的 `app-update.json`，后台缺包、不可用或没有更新版本时读取本仓库Latest Release，下载安装包后交给Android确认。更新不依赖Docker账号或Cookie。App 3.1.4首次需手动覆盖安装，后续使用「我的 → 检查更新」。旧私人版不要卸载；覆盖安装保留绑定、短信和领取记录。

当前App版本标签为 `app-v3.1.18`，服务端为 `3.1.15`。后台手动AI可独立于定期开关执行，返回具体原因，可查看脱敏分析详情；每日额度默认20次且允许调高。App按已确认A排版统一标准站名，柜号标牌置于取件码前；复制纯码，冲突时不展示柜号，隐私模式同时隐藏柜号。AI建议继续人工核对后生效。稳定App Release公开后会触发容器流水线重建，内置刚发布的升级包；历史App不覆盖当前main镜像。Latest Release专用于稳定App更新，不把Docker标签创建为Latest Release。固定下载入口：

`https://github.com/zsdd2/kdyzm/releases/latest/download/app-update.json`

本轮App版本为 `3.1.18` / `30118`，沿用原签名，说明见 [站点与AI增强](station-ai-implementation.md)。按下方步骤发布为Latest后，旧App即可检查并下载更新。

本轮增加已绑定后台优先检查与下载，后台缺包、不可用或版本不高于已安装App时查询GitHub；内置目录由构建期脚本完整校验。详见 [后台优先升级](backend-app-updates-3.1.15.md)。

## 后续发布

1. 在App源码中增加versionName及versionCode，更新说明，运行已有 `node scripts/verify.mjs full --task <当前任务>`。保留原本地签名；密钥不得上传GitHub。
2. 准备APK、上一个已发布APK、更新说明文本。构建工具目录需含aapt及lib/apksigner.jar，Java可通过JAVA_HOME配置。
3. 在本仓库执行准备命令，指定一个尚不存在的输出目录：

   ```powershell
   node scripts/app-release.mjs prepare --apk '<新版APK绝对路径>' --previous-apk '<上一版APK绝对路径>' --notes-file '<更新说明文本路径>' --out-dir '<新输出目录>' --build-tools 'F:/Android/Sdk/build-tools/35.0.0'
   ```

   脚本直接读取APK的包名/版本/minSdk，验证APK签名、与旧包签名一致且版本递增，生成APK、app-update.json、SHA256SUMS；这一步不上传。
4. 检查输出并确认本轮发布授权，使用已有GitHub CLI登录执行：

   ```powershell
   node scripts/app-release.mjs publish --dir '<输出目录>' --target '<本仓库已推送的40位提交SHA>' --previous-apk '<上一版APK绝对路径>' --build-tools 'F:/Android/Sdk/build-tools/35.0.0'
   ```

   先创建草稿、上传三份文件、重新下载逐字节校验，再发布为Latest。网络中断后可用同一命令继续匹配草稿；公开版本不会覆盖，错误草稿内容不自动覆盖。App源码仍保留在原工作区，此仓库的App Release提供安装包与更新清单，源码压缩包是服务端源码。
5. 发布后匿名下载Latest清单和APK，核对大小/SHA256，并在旧版手机测试检查、下载、授权和覆盖安装。不要将本机浏览器或JVM测试视为OPPO真机安装验收。

## 签名与安装边界

目前沿用现有私人测试版的本地Android签名，公钥摘要固定在发布脚本中。更换电脑须安全迁移原签名文件；自动生成新调试密钥会导致无法覆盖升级。不要将签名密钥、密码、账号Cookie或设备token提交或上传为Release附件。

App只接受原生保存的当前已绑定HTTPS后台固定路径、固定仓库及GitHub官方HTTPS下载CDN，验证大小、SHA256、包名、版本和与当前安装相同的签名。后台请求不带设备令牌或管理员凭证，禁止重定向。Android仍会要求用户允许本应用安装并确认升级。下载失败可以重试；网络受限时可从Release页手动下载APK覆盖安装。

### App3.1.15 / 服务端3.1.12

真实到站时间与站点匹配、无候选时手动搜索关联、逐件多包分配、解除不复连和晚到核对。先保留数据卷更新后台，再覆盖安装App并同步；同签名，无需重绑。见 [关联说明](sms-order-matching-3.1.12.md)。

### App3.1.16 / 服务端3.1.13

后台「服务设置 → 站点管理」维护标准站名与别名；「AI 待核对 → AI 设置」配置渠道、模型、Key和周期，AI只给建议，人工确认后生效。手机片段上传默认关闭，主动同意后仅发送可提取的脱敏站名。App保留原界面，记录页分组改为「时间／角色」；自动关联继续遵守时间、双方唯一及冲突规则。先保留数据卷和加密密钥更新后台，再覆盖安装同签名App并同步，无需重绑。完整门禁和同签名检查由发布记录核验；真实AI与实体手机仍待配置、升级后验收。
