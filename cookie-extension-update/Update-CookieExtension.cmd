@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -File "%~dp0Update-CookieExtension.ps1" -BundledManifest "%~dp0cookie-extension-update.json" %*
if errorlevel 1 echo Update did not complete. Read the message above; your original folder is preserved or recovery is required.
pause
