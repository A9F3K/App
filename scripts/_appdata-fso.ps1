$ErrorActionPreference = 'SilentlyContinue'
$fso = New-Object -ComObject Scripting.FileSystemObject

function Get-FsoGB([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    $folder = $fso.GetFolder($Path)
    return [math]::Round($folder.Size / 1GB, 2)
  } catch {
    return $null
  }
}

function Rank-Children([string]$root, [int]$top = 40, [double]$minGB = 0.05) {
  Write-Host ""
  Write-Host "=== $root ==="
  $rows = @()
  Get-ChildItem -LiteralPath $root -Directory -Force | ForEach-Object {
    $gb = Get-FsoGB $_.FullName
    if ($null -ne $gb -and $gb -ge $minGB) {
      $rows += [PSCustomObject]@{ GB = $gb; Name = $_.Name }
    }
  }
  $rows | Sort-Object GB -Descending | Select-Object -First $top | Format-Table -AutoSize
  $sum = ($rows | Measure-Object -Property GB -Sum).Sum
  Write-Host ("TOTAL (>= {0} GB): {1:N2} GB across {2} folders" -f $minGB, $sum, $rows.Count)
}

Rank-Children "$env:USERPROFILE\AppData\Local"
Rank-Children "$env:USERPROFILE\AppData\Roaming"
Rank-Children "$env:USERPROFILE\AppData\LocalLow"

Write-Host ""
Write-Host "=== Profile caches / related ==="
$extra = @(
  "$env:USERPROFILE\.cache",
  "$env:USERPROFILE\.nuget",
  "$env:USERPROFILE\.gradle",
  "$env:USERPROFILE\.m2",
  "$env:USERPROFILE\.cargo",
  "$env:USERPROFILE\.rustup",
  "$env:USERPROFILE\.docker",
  "$env:USERPROFILE\.cursor",
  "$env:USERPROFILE\.vscode",
  "$env:USERPROFILE\.ollama",
  "$env:USERPROFILE\.npm",
  "$env:USERPROFILE\.local",
  "$env:USERPROFILE\.expo",
  "$env:USERPROFILE\.android",
  "C:\Windows\Temp",
  "C:\Windows\SoftwareDistribution\Download"
)
$rows = @()
foreach ($p in $extra) {
  $gb = Get-FsoGB $p
  if ($null -ne $gb -and $gb -ge 0.05) {
    $rows += [PSCustomObject]@{ GB = $gb; Path = $p }
  }
}
$rows | Sort-Object GB -Descending | Format-Table -AutoSize
