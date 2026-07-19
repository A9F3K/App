$ErrorActionPreference = 'SilentlyContinue'

function Get-RoboBytes([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $raw = & robocopy $Path 'NULL' /L /S /NJH /NJS /NDL /NC /BYTES /NFL /NP /XJ /R:0 /W:0 2>&1 | Out-String
  $m = [regex]::Match($raw, 'Bytes\s+:\s+(\d+)')
  if ($m.Success) { return [int64]$m.Groups[1].Value }
  return 0L
}

$targets = @(
  "$env:LOCALAPPDATA\Temp",
  "$env:LOCALAPPDATA\npm-cache",
  "$env:LOCALAPPDATA\Yarn",
  "$env:LOCALAPPDATA\pnpm-store",
  "$env:LOCALAPPDATA\pnpm",
  "$env:LOCALAPPDATA\pip",
  "$env:LOCALAPPDATA\NuGet",
  "$env:LOCALAPPDATA\Docker",
  "$env:LOCALAPPDATA\Packages",
  "$env:LOCALAPPDATA\Microsoft\Windows\INetCache",
  "$env:LOCALAPPDATA\Microsoft\Windows\Explorer",
  "$env:LOCALAPPDATA\Microsoft\Windows\WebCache",
  "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Cache",
  "$env:LOCALAPPDATA\Microsoft\Edge\User Data\Default\Code Cache",
  "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache",
  "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Code Cache",
  "$env:LOCALAPPDATA\Google\Chrome\User Data\ShaderCache",
  "$env:APPDATA\Code\Cache",
  "$env:APPDATA\Code\CachedData",
  "$env:APPDATA\Code\CachedExtensions",
  "$env:APPDATA\Code\CachedExtensionVSIXs",
  "$env:APPDATA\Code\logs",
  "$env:APPDATA\Cursor\Cache",
  "$env:APPDATA\Cursor\CachedData",
  "$env:APPDATA\Cursor\CachedExtensions",
  "$env:APPDATA\Cursor\logs",
  "$env:APPDATA\Cursor\User\workspaceStorage",
  "$env:APPDATA\Cursor\User\globalStorage",
  "$env:LOCALAPPDATA\Programs",
  "$env:LOCALAPPDATA\Steam",
  "$env:LOCALAPPDATA\Discord",
  "$env:LOCALAPPDATA\NVIDIA",
  "$env:LOCALAPPDATA\NVIDIA Corporation",
  "$env:LOCALAPPDATA\D3DSCache",
  "$env:LOCALAPPDATA\CrashDumps",
  "$env:LOCALAPPDATA\Package Cache",
  "$env:LOCALAPPDATA\uv",
  "$env:LOCALAPPDATA\cargo",
  "$env:USERPROFILE\.cache",
  "$env:USERPROFILE\.nuget",
  "$env:USERPROFILE\.gradle",
  "$env:USERPROFILE\.m2",
  "$env:USERPROFILE\.cargo",
  "$env:USERPROFILE\.rustup",
  "$env:USERPROFILE\.docker",
  "$env:USERPROFILE\.vscode",
  "$env:USERPROFILE\.cursor",
  "$env:LOCALAPPDATA\Microsoft\WinGet",
  "$env:LOCALAPPDATA\Microsoft\VisualStudio",
  "$env:LOCALAPPDATA\Microsoft\TypeScript",
  "$env:LOCALAPPDATA\Temp\WinGet",
  "$env:LOCALAPPDATA\SquirrelTemp",
  "$env:LOCALAPPDATA\Discord\Cache",
  "$env:LOCALAPPDATA\Discord\Code Cache",
  "$env:LOCALAPPDATA\Spotify",
  "$env:LOCALAPPDATA\EpicGamesLauncher",
  "$env:LOCALAPPDATA\Riot Games",
  "$env:LOCALAPPDATA\Roblox",
  "$env:APPDATA\Telegram Desktop",
  "$env:LOCALAPPDATA\Telegram Desktop",
  "$env:LOCALAPPDATA\Comms",
  "$env:LOCALAPPDATA\ConnectedDevicesPlatform",
  "$env:LOCALAPPDATA\ElevatedDiagnostics",
  "$env:WINDIR\Temp",
  "$env:SystemRoot\SoftwareDistribution\Download"
)

Write-Host "Known cache / reclaimable paths (>= 50 MB):"
Write-Host ""
$rows = @()
foreach ($p in $targets) {
  $b = Get-RoboBytes $p
  if ($null -eq $b) { continue }
  $gb = [math]::Round($b / 1GB, 2)
  if ($gb -ge 0.05) {
    $rows += [PSCustomObject]@{ GB = $gb; Path = $p }
  }
}
$rows | Sort-Object GB -Descending | Format-Table -AutoSize
Write-Host ("Subtotal listed: {0:N2} GB" -f (($rows | Measure-Object GB -Sum).Sum))
