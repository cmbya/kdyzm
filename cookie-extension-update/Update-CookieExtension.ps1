[CmdletBinding()]
param(
    [string]$ExtensionDirectory,
    [string]$PackageManifest,
    [string]$BundledManifest,
    [string]$StateDirectory,
    [switch]$CheckOnly,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ExpectedName = '"\u53d6\u4ef6\u52a9\u624b \u00b7 \u767b\u5f55\u540c\u6b65"' | ConvertFrom-Json
$Repository = 'https://github.com/zsdd2/kdyzm'
$Api = 'https://api.github.com/repos/zsdd2/kdyzm/releases'
$MaxArchive = 20 * 1024 * 1024
$MaxExpanded = 16 * 1024 * 1024

function Assert-That($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Property($Object, [string]$Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $null
}
function Read-Json([string]$Path, [long]$Maximum = 524288) {
    Assert-That ((Get-Item -LiteralPath $Path).Length -le $Maximum) 'JSON file exceeds its size limit.'
    return ([IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json)
}
function Write-Json([string]$Path, $Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12))
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Hash([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create(); $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Version([string]$Value) {
    Assert-That ($Value -match '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$') 'Invalid extension version.'
    foreach ($part in $Value.Split('.')) { Assert-That ([int]$part -le 65535) 'Invalid extension version component.' }
    return [version]$Value
}
function Safe-Path([string]$Relative) {
    Assert-That ($Relative.Length -gt 0 -and $Relative.Length -le 180) 'Invalid package path length.'
    foreach ($part in $Relative.Split('/')) {
        Assert-That ($part -match '^[A-Za-z0-9_.-]+$' -and $part -ne '.' -and $part -ne '..' -and $part -notmatch '[. ]$' -and
            $part -notmatch '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)') "Unsafe package path: $Relative"
    }
    Assert-That ([IO.Path]::GetExtension($Relative) -match '^\.(json|mjs|js|html|css|svg|png|jpg|jpeg|webp|ico|txt|md|woff|woff2)$') "Unsupported package file: $Relative"
}
function No-Reparse([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            Assert-That (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Links/reparse points are not allowed: $cursor"
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}
function Child-Path([string]$Root, [string]$Relative) {
    Safe-Path $Relative
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $full = [IO.Path]::GetFullPath((Join-Path $Root $Relative.Replace('/', '\')))
    Assert-That ($full.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) 'Path escaped its directory.'
    No-Reparse $full
    return $full
}
function Extension-Manifest([string]$Directory) {
    No-Reparse $Directory
    Assert-That (Test-Path -LiteralPath $Directory -PathType Container) 'Select the existing loaded extension directory.'
    $path = Child-Path $Directory 'manifest.json'
    $manifest = Read-Json $path
    Assert-That ((Property $manifest 'name') -ceq $ExpectedName -and (Property $manifest 'manifest_version') -eq 3) 'This directory is not the PickCode login extension.'
    Assert-That ((Property (Property $manifest 'background') 'service_worker') -ceq 'background.mjs' -and
        (Property $manifest 'options_page') -ceq 'options.html') 'Extension identity does not match.'
    $null = Version (Property $manifest 'version')
    return $manifest
}
function Validate-DownloadUrl([string]$Value, [bool]$IsApi) {
    $url = [uri]$Value
    Assert-That ($url.Scheme -ceq 'https' -and $url.IsDefaultPort -and -not $url.UserInfo -and -not $url.Fragment) 'Downloads require ordinary HTTPS URLs.'
    if ($IsApi) {
        Assert-That ($url.Host -ceq 'api.github.com' -and $url.AbsolutePath -ceq '/repos/zsdd2/kdyzm/releases') 'Release lookup left the trusted repository.'
    } else {
        Assert-That ($url.Host -cin @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')) 'Download redirected outside GitHub.'
        if ($url.Host -ceq 'github.com') { Assert-That ($url.AbsolutePath.StartsWith('/zsdd2/kdyzm/releases/download/', [StringComparison]::Ordinal)) 'Asset left the trusted repository.' }
    }
}
function Download([string]$Url, [string]$Destination, [long]$Maximum, [bool]$IsApi = $false) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        Validate-DownloadUrl $Url $IsApi
        $request = [Net.HttpWebRequest]::Create($Url)
        $request.AllowAutoRedirect = $false; $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
        $request.UserAgent = 'PickCode-CookieExtension-Updater/1'
        $request.Accept = 'application/vnd.github+json'
        $response = $request.GetResponse()
        try {
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                Assert-That ($redirect -lt 5 -and $response.Headers['Location']) 'Too many or invalid download redirects.'
                $Url = [uri]::new([uri]$Url, $response.Headers['Location']).AbsoluteUri
                continue
            }
            Assert-That ($status -eq 200) "Download failed: HTTP $status"
            Assert-That ($response.ContentLength -le $Maximum) 'Download exceeds size limit.'
            $input = $response.GetResponseStream(); $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
            try {
                $buffer = New-Object byte[] 65536; $total = 0
                while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count; Assert-That ($total -le $Maximum) 'Download exceeds size limit.'
                    $output.Write($buffer, 0, $count)
                }
                Assert-That ($response.ContentLength -lt 0 -or $total -eq $response.ContentLength) 'Incomplete download.'
            } finally { $input.Dispose(); $output.Dispose() }
            return
        } finally { $response.Dispose() }
    }
}
function Online-Package([string]$Workspace) {
    $candidates = @()
    for ($page = 1; $page -le 5; $page++) {
        $metadata = Join-Path $Workspace "releases-$page.json"
        Download ($Api + "?per_page=100&page=$page") $metadata (4 * 1024 * 1024) $true
        $releases = @(Read-Json $metadata (4 * 1024 * 1024))
        foreach ($release in $releases) {
            if ((Property $release 'draft') -eq $false -and (Property $release 'prerelease') -eq $false -and
                (Property $release 'tag_name') -match '^cookie-extension-v([0-9]+\.[0-9]+\.[0-9]+)$') {
                $candidateVersion = Version $Matches[1]
                $candidates += [pscustomobject]@{ Version = $candidateVersion; Release = $release }
            }
        }
        if ($releases.Count -lt 100) { break }
    }
    Assert-That ($candidates.Count -gt 0) 'No stable cookie-extension release is published. Use an official offline bundle.'
    $release = ($candidates | Sort-Object Version -Descending | Select-Object -First 1).Release
    $tag = $release.tag_name; $expectedVersion = $tag.Substring('cookie-extension-v'.Length)
    $names = @('cookie-extension-update.json', "cookie-extension-$expectedVersion.zip")
    foreach ($name in $names) {
        $assets = @($release.assets | Where-Object { $_.name -ceq $name })
        Assert-That ($assets.Count -eq 1) "Release requires exactly one $name"
        $asset = $assets[0]; $maximum = if ($name.EndsWith('.json')) { 524288 } else { $MaxArchive }
        $canonical = "$Repository/releases/download/$tag/$name"
        Assert-That ($asset.browser_download_url -ceq $canonical -and $asset.size -gt 0 -and $asset.size -le $maximum) 'Invalid release asset URL or size.'
        $path = Join-Path $Workspace $name
        Download $canonical $path $maximum
        Assert-That ((Get-Item -LiteralPath $path).Length -eq $asset.size) 'Downloaded asset size differs from release.'
        $digest = Property $asset 'digest'
        if ($digest) { Assert-That ($digest -ceq ('sha256:' + (Hash $path))) 'GitHub asset digest mismatch.' }
    }
    $manifestPath = Join-Path $Workspace $names[0]
    $metadata = Read-Json $manifestPath
    Assert-That ($metadata.tag -ceq $tag -and $metadata.version -ceq $expectedVersion) 'Release and package versions differ.'
    return $manifestPath
}
function Stage-Package([string]$ManifestPath, [string]$Workspace, $Current) {
    $update = Read-Json $ManifestPath
    Assert-That ($update.schemaVersion -eq 1 -and $update.product -ceq 'pickcode-cookie-extension' -and $update.name -ceq $ExpectedName) 'Invalid update manifest identity.'
    $null = Version $update.version
    Assert-That ($update.tag -ceq "cookie-extension-v$($update.version)") 'Invalid update release tag.'
    Assert-That ($update.archive.name -ceq "cookie-extension-$($update.version).zip" -and
        $update.archive.sha256 -cmatch '^[a-f0-9]{64}$' -and $update.archive.size -gt 0 -and $update.archive.size -le $MaxArchive) 'Invalid archive declaration.'
    $archivePath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ManifestPath))) $update.archive.name
    Assert-That ((Get-Item -LiteralPath $archivePath).Length -eq $update.archive.size -and (Hash $archivePath) -ceq $update.archive.sha256) 'Archive SHA256 or size mismatch.'
    $files = @($update.files); Assert-That ($files.Count -gt 0 -and $files.Count -le 256) 'Invalid package file count.'
    $declared = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $total = 0L
    foreach ($file in $files) {
        Safe-Path $file.path
        Assert-That (-not $declared.ContainsKey($file.path)) 'Duplicate manifest path.'
        Assert-That ($file.sha256 -cmatch '^[a-f0-9]{64}$' -and $file.size -ge 0 -and $file.size -le $MaxExpanded -and
            [double]$file.size -eq [long]$file.size) 'Invalid file digest or size.'
        $total += $file.size; Assert-That ($total -le $MaxExpanded) 'Expanded package exceeds size limit.'
        $declared.Add($file.path, $file)
    }
    foreach ($required in @('manifest.json', 'background.mjs', 'options.html', 'core.mjs')) { Assert-That ($declared.ContainsKey($required)) "Package is missing $required" }
    $staging = Join-Path $Workspace 'staged'; $null = [IO.Directory]::CreateDirectory($staging)
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        Assert-That ($zip.Entries.Count -eq $files.Count) 'ZIP contains missing or unexpected files.'
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            Safe-Path $entry.FullName
            Assert-That ($seen.Add($entry.FullName) -and $declared.ContainsKey($entry.FullName)) 'Duplicate or undeclared ZIP entry.'
            $attributes = [long]$entry.ExternalAttributes -band 0xffffffffL
            $kind = ($attributes -shr 16) -band 61440
            Assert-That (($kind -eq 0 -or $kind -eq 32768) -and ($attributes -band 1040) -eq 0) 'ZIP links, devices and directories are not allowed.'
            $file = $declared[$entry.FullName]
            Assert-That ($entry.FullName -ceq $file.path -and $entry.Length -eq $file.size) 'ZIP path or size differs from manifest.'
            $destination = Child-Path $staging $file.path
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
            $input = $entry.Open(); $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew)
            try {
                $buffer = New-Object byte[] 65536; $copied = 0L
                while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $copied += $count; Assert-That ($copied -le $file.size) 'ZIP entry exceeds declared size.'
                    $output.Write($buffer, 0, $count)
                }
                Assert-That ($copied -eq $file.size) 'Truncated ZIP entry.'
            } finally { $input.Dispose(); $output.Dispose() }
            Assert-That ((Hash $destination) -ceq $file.sha256) "File SHA256 mismatch: $($file.path)"
        }
    } finally { $zip.Dispose() }
    $next = Extension-Manifest $staging
    Assert-That ($next.version -ceq $update.version) 'Extension version differs from update manifest.'
    Assert-That ((Property $next 'key') -ceq (Property $Current 'key') -and
        (Property $next 'update_url') -ceq (Property $Current 'update_url')) 'Update cannot change extension key or update URL.'
    return [pscustomobject]@{ Manifest = $update; Staging = $staging }
}
function Replace-File([string]$Source, [string]$Destination) {
    No-Reparse $Destination
    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))
    $temporary = $Destination + '.pickcode-' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::Copy($Source, $temporary, $false)
        No-Reparse $Destination
        if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($temporary, $Destination, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Destination) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Restore-Previous($Journal, [string]$StateRoot) {
    $target = [IO.Path]::GetFullPath($Journal.directory)
    $backup = [IO.Path]::GetFullPath($Journal.backup)
    $backupRoot = [IO.Path]::GetFullPath((Join-Path $StateRoot 'backups')).TrimEnd('\') + '\'
    Assert-That ($backup.StartsWith($backupRoot, [StringComparison]::OrdinalIgnoreCase)) 'Recovery backup left the updater directory.'
    No-Reparse $target; No-Reparse $backup
    Assert-That ($Journal.product -ceq 'pickcode-cookie-extension') 'Invalid recovery journal.'
    $files = @($Journal.files); Assert-That ($files.Count -gt 0 -and $files.Count -le 256) 'Invalid recovery file list.'
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    # Validate the entire backup before any rollback write.
    foreach ($file in $files) {
        Assert-That ($seen.Add($file.path) -and $file.existed -is [bool]) 'Invalid or duplicate recovery record.'
        $null = Child-Path $target $file.path
        if ($file.existed) { Assert-That ($file.sha256 -cmatch '^[a-f0-9]{64}$' -and (Hash (Child-Path $backup $file.path)) -ceq $file.sha256) 'Recovery backup checksum mismatch.' }
    }
    $original = Extension-Manifest $backup
    Assert-That ($original.version -ceq $Journal.previousVersion) 'Recovery backup is not the declared extension version.'
    $installed = Extension-Manifest $target
    Assert-That ($installed.version -cin @($Journal.previousVersion, $Journal.targetVersion) -and
        (Property $installed 'key') -ceq (Property $original 'key')) 'Recovery target no longer matches this extension update.'
    foreach ($file in ($files | Sort-Object { $_.path -ceq 'manifest.json' })) {
        $destination = Child-Path $target $file.path
        if ($file.existed) {
            # Skip unchanged files; a locked untouched file need not obstruct recovery.
            if (-not [IO.File]::Exists($destination) -or (Hash $destination) -cne $file.sha256) {
                Replace-File (Child-Path $backup $file.path) $destination
            }
        } elseif ([IO.File]::Exists($destination)) { [IO.File]::Delete($destination) }
    }
    $restored = Extension-Manifest $target
    Assert-That ($restored.version -ceq $Journal.previousVersion) 'Restored version does not match the backup.'
}

$workspace = $null; $lock = $null; $exitCode = 0
try {
    if (-not $StateDirectory) { $StateDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PickCode\CookieExtensionUpdater' }
    $StateDirectory = [IO.Path]::GetFullPath($StateDirectory); No-Reparse $StateDirectory
    $null = [IO.Directory]::CreateDirectory($StateDirectory)
    $lockPath = Join-Path $StateDirectory 'updater.lock'; No-Reparse $lockPath
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $pending = Join-Path $StateDirectory 'pending-update.json'
    No-Reparse $pending
    if (Test-Path -LiteralPath $pending) {
        $journal = Read-Json $pending
        Write-Host "Interrupted update found. Directory: $($journal.directory)"
        Write-Host "Restore version: $($journal.previousVersion) / Backup: $($journal.backup)"
        Assert-That (-not $CheckOnly) 'Recovery is required before another update.'
        Assert-That ($Apply -or (Read-Host 'Close extension sync, then type RESTORE to recover the previous version') -ceq 'RESTORE') 'Recovery cancelled; backup and journal retained.'
        Restore-Previous $journal $StateDirectory
        [IO.File]::Delete($pending)
        Write-Host 'Previous version restored. Reload the existing extension in Chrome, then run the updater again.'
    } else {
        $settings = Join-Path $StateDirectory 'directory.json'
        No-Reparse $settings
        if (-not $ExtensionDirectory -and (Test-Path -LiteralPath $settings)) { $ExtensionDirectory = (Read-Json $settings).directory }
        if (-not $ExtensionDirectory) {
            Assert-That (-not $Apply -and -not $CheckOnly) 'Supply -ExtensionDirectory on the first noninteractive run.'
            Add-Type -AssemblyName System.Windows.Forms
            $picker = New-Object Windows.Forms.FolderBrowserDialog
            $picker.Description = 'Select the existing Chrome login extension folder (contains manifest.json). Do not select a Chrome profile.'
            $picker.ShowNewFolderButton = $false
            try {
                Assert-That ($picker.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) 'No directory selected.'
                $ExtensionDirectory = $picker.SelectedPath
            } finally { $picker.Dispose() }
        }
        $ExtensionDirectory = [IO.Path]::GetFullPath($ExtensionDirectory).TrimEnd('\')
        Assert-That ($ExtensionDirectory -match '^[A-Za-z]:\\.+') 'Use an existing local extension directory.'
        $current = Extension-Manifest $ExtensionDirectory
        Assert-That (-not ($StateDirectory + '\').StartsWith($ExtensionDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) 'Updater state must be outside the extension directory.'
        $workspace = Join-Path ([IO.Path]::GetTempPath()) ('pickcode-cookie-update-' + [guid]::NewGuid().ToString('N'))
        No-Reparse $workspace; $null = [IO.Directory]::CreateDirectory($workspace)
        if (-not $CheckOnly) {
            $newSettings = Join-Path $workspace 'directory.json'
            Write-Json $newSettings ([pscustomobject]@{ directory = $ExtensionDirectory })
            Replace-File $newSettings $settings
        }
        if (-not $PackageManifest -and $BundledManifest -and (Test-Path -LiteralPath $BundledManifest)) {
            $bundled = Read-Json $BundledManifest
            if ((Version $bundled.version) -gt (Version $current.version)) { $PackageManifest = $BundledManifest }
        }
        if (-not $PackageManifest) { $PackageManifest = Online-Package $workspace }
        $package = Stage-Package $PackageManifest $workspace $current
        $update = $package.Manifest
        Write-Host "Current version: $($current.version)"
        Write-Host "Target version:  $($update.version)"
        Write-Host "Directory:       $ExtensionDirectory"
        if ((Version $update.version) -le (Version $current.version)) {
            Write-Host 'No newer version. No extension files were changed.'
        } elseif ($CheckOnly) {
            Write-Host 'Package verified. Preview only; no extension files or remembered directory changed.'
        } else {
            Assert-That ($Apply -or (Read-Host 'Finish any active sync. Type UPDATE to replace files in this same directory') -ceq 'UPDATE') 'Update cancelled.'
            $rechecked = Extension-Manifest $ExtensionDirectory
            Assert-That ($rechecked.version -ceq $current.version -and (Property $rechecked 'key') -ceq (Property $current 'key')) 'Extension changed during package verification; run again.'
            $backup = Join-Path $StateDirectory ('backups\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
            No-Reparse $backup; $null = [IO.Directory]::CreateDirectory($backup)
            $records = @()
            foreach ($file in $update.files) {
                $destination = Child-Path $ExtensionDirectory $file.path
                Assert-That (-not (Test-Path -LiteralPath $destination -PathType Container)) 'A package file collides with an existing directory.'
                $existed = [IO.File]::Exists($destination); $digest = $null
                if ($existed) {
                    $save = Child-Path $backup $file.path
                    $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($save))
                    [IO.File]::Copy($destination, $save, $false); $digest = Hash $save
                }
                $records += [pscustomobject]@{ path = $file.path; existed = $existed; sha256 = $digest }
            }
            $journal = [pscustomobject]@{ product = 'pickcode-cookie-extension'; directory = $ExtensionDirectory; backup = $backup;
                previousVersion = $current.version; targetVersion = $update.version; files = $records }
            Write-Json (Join-Path $backup 'backup-record.json') $journal
            Write-Json $pending $journal
            try {
                foreach ($file in ($update.files | Sort-Object { $_.path -ceq 'manifest.json' })) {
                    Replace-File (Child-Path $package.Staging $file.path) (Child-Path $ExtensionDirectory $file.path)
                }
                foreach ($file in $update.files) { Assert-That ((Hash (Child-Path $ExtensionDirectory $file.path)) -ceq $file.sha256) 'Installed file verification failed.' }
                $null = Extension-Manifest $ExtensionDirectory
            } catch {
                $failure = $_.Exception.Message
                try { Restore-Previous $journal $StateDirectory; [IO.File]::Delete($pending) }
                catch { throw "Update failed: $failure Recovery also failed: $($_.Exception.Message). Run again to restore; backup: $backup" }
                throw "Update failed and previous files were restored: $failure"
            }
            [IO.File]::Delete($pending)
            Write-Host "Updated to $($update.version). Backup: $backup"
            Write-Host 'Reload this existing extension in Chrome. Do not uninstall or load a different folder.'
        }
    }
} catch { [Console]::Error.WriteLine($_.Exception.Message); $exitCode = 1 }
finally {
    if ($lock) { $lock.Dispose() }
    if ($workspace -and (Test-Path -LiteralPath $workspace)) {
        try { No-Reparse $workspace; Remove-Item -LiteralPath $workspace -Recurse -Force } catch { Write-Warning "Temporary files retained: $workspace" }
    }
}
exit $exitCode
