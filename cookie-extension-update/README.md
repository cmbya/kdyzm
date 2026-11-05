# 登录同步插件：Windows 原目录更新工具

解压工具包，双击 `Update-CookieExtension.cmd`。无需管理员权限、Node.js、企业策略或常驻服务。

首次选择 **Chrome 当前已加载的插件目录**（直接含 `manifest.json`）。更新器记住目录；以后保持该目录不变。不要选择 Chrome 用户资料目录，不要卸载旧插件、另建版本目录或重新安装。新用户先将插件 ZIP 解压到固定目录并在 Chrome 加载，再使用更新工具。

工具先显示当前版本、目标版本和完整目录。结束正在进行的同步后输入 `UPDATE`，才会覆盖。成功后回到插件设置点击重新加载，或在 `chrome://extensions/` 点击原插件的重新加载。Chrome 中的后台地址、角色授权、平台选择和自动同步设置由原扩展实例保留；工具不读取或修改 Chrome 配置。

随包附带的版本较新时优先离线更新；否则只从 `https://github.com/zsdd2/kdyzm` 查询稳定的 `cookie-extension-vX.Y.Z` 发行版。它不使用 App Latest、App 更新索引或后台返回的下载地址。GitHub 不可达时可下载新版完整工具包离线运行；当前尚未发布的发行版无法在线取得。

更新器验证 ZIP 和逐文件 SHA256、大小、版本、名称、完整文件列表，拒绝目录穿越、链接、重复条目及清单外文件。SHA256 用于检测损坏；在线来源身份依赖固定 GitHub 仓库与 HTTPS，离线包必须来自本人信任的来源。不会执行下载包中的程序。

备份保存在 `%LOCALAPPDATA%\PickCode\CookieExtensionUpdater\backups`，仅记录被替换的插件文件，不导出配对令牌。失败自动回滚；断电或进程中断后再次运行会提示输入 `RESTORE` 恢复上一版，再运行更新。备份不会自动删除。更新器只替换清单中的文件，不删除旧版未列出的文件。若系统组织策略不允许运行 PowerShell，请联系管理员；工具不修改执行策略。

命令行（PowerShell）：

```powershell
# 明确指定原目录，预览离线包，完全不修改插件与路径记录
.\Update-CookieExtension.ps1 -ExtensionDirectory 'D:\Apps\CookieExtension' -PackageManifest '.\cookie-extension-update.json' -CheckOnly
# 手动确认后安装；省略目录会使用记住的目录或弹出目录选择
.\Update-CookieExtension.ps1 -PackageManifest '.\cookie-extension-update.json'
# 忽略随包版本，检查固定 GitHub 仓库
.\Update-CookieExtension.ps1
```

`-Apply` 用于调用方已确认的自动化本地操作，仍输出目录/版本；日常双击不会传入该开关。`-StateDirectory` 只用于隔离测试或便携状态目录，不会改变插件目录。只保存目录路径和版本备份，不保存 Chrome 数据。

开发打包：`node scripts/package-cookie-extension.mjs --out-dir <不存在的输出目录>`。输出插件 ZIP、版本与 SHA256 清单、工具脚本、包含离线包的工具 ZIP，以及 `COOKIE-EXTENSION-SHA256SUMS`。脚本只生成文件，不上传、创建发行版或修改 App 更新内容。后续经批准发布到 `cookie-extension-v<version>` 时，应使用 **非 Latest** 发行版并保留 App Latest 不变。
