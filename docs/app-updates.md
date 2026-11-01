# Android App 发布与在线升级

手机从本仓库的Latest Release读取 `app-update.json`，下载安装包后交给Android确认。更新不依赖Docker账号或Cookie。App 3.1.4首次需手动覆盖安装，后续使用「我的 → 检查更新」。旧私人版不要卸载；覆盖安装保留绑定、短信和领取记录。

当前App版本标签为 `app-v3.1.12`，服务端为 `3.1.9`。3.1.12补齐京东无运单出库状态、待收货暂无物流轨迹时的大组件路上显示，每行增加淘／拼／京小标，商品名限制为前10字；沿用原A稿两区和容量规则。京东采集需要后台3.1.9，只有原单账号授权的设备需明确增加家人整组授权。旧设备无需重绑，已有3.1.9后台无需为本次App更新重建NAS容器。容器流水线不匹配app-v标签。Latest Release专用于稳定App更新，不把Docker标签创建为Latest Release。固定下载入口：

`https://github.com/zsdd2/kdyzm/releases/latest/download/app-update.json`

本轮App版本为 `3.1.12` / `30112`，沿用原签名。完整七项门禁和APK签名校验已通过，版本说明、原生渲染图及安装包校验见 [3.1.12说明](app-widget-3.1.12.md)。按下方步骤发布为Latest后，旧App即可检查并下载更新。

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

App只接受固定仓库及GitHub官方HTTPS下载CDN，验证大小、SHA256、包名、版本和与当前安装相同的签名。Android仍会要求用户允许本应用安装并确认升级。下载失败可以重试；网络受限时可从Release页手动下载APK覆盖安装。
