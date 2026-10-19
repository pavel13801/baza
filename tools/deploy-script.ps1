# Обновляет серверную часть одной командой: заливает apps-script/ в проект Apps Script
# и переводит веб-приложение на новую версию. Адрес веб-приложения (…/exec) не меняется.
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy-script.ps1 [-Description "что изменилось"]
#
# Один раз до первого запуска: npm install -g @google/clasp, затем clasp login под владельцем
# скрипта и включённый Apps Script API на https://script.google.com/home/usersettings.
param([string]$Description = '')

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

if (-not (Get-Command clasp -ErrorAction SilentlyContinue)) {
  throw 'Не найден clasp. Установите: npm install -g @google/clasp'
}

Write-Host 'Заливаю код в Apps Script…' -ForegroundColor Cyan
clasp push --force
if ($LASTEXITCODE) { throw 'clasp push не удался — см. сообщение выше' }

# Развертывание веб-приложения — нумерованное (не @HEAD); если их несколько, берётся «База»
$web = clasp list-deployments |
  Select-String -Pattern '^- (\S+) @(\d+)(?: - (.*))?$' |
  ForEach-Object { $_.Matches[0] } |
  Sort-Object { if ($_.Groups[3].Value -match 'База') { 0 } else { 1 } } |
  Select-Object -First 1
if (-not $web) { throw 'Не найдено развертывание веб-приложения. Создайте его один раз в редакторе Apps Script.' }

if (-not $Description) {
  $Description = (Get-Date -Format 'yyyy-MM-dd HH:mm') + ' ' + (git log -1 --format=%s)
}
if ($Description.Length -gt 100) { $Description = $Description.Substring(0, 100) }

Write-Host ('Обновляю веб-приложение (сейчас версия ' + $web.Groups[2].Value + ')…') -ForegroundColor Cyan
clasp update-deployment $web.Groups[1].Value -d $Description
if ($LASTEXITCODE) { throw 'clasp update-deployment не удался — см. сообщение выше' }
Write-Host 'Готово: код залит, веб-приложение на новой версии.' -ForegroundColor Green
