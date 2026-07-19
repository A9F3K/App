$ErrorActionPreference = 'SilentlyContinue'

function Get-RoboBytes([string]$Path) {
  $raw = & robocopy $Path 'NULL' /L /S /NJH /NJS /NDL /NC /BYTES /NFL /NP /XJ /R:0 /W:0 2>&1 | Out-String
  $m = [regex]::Match($raw, 'Bytes\s+:\s+(\d+)')
  if ($m.Success) { return [int64]$m.Groups[1].Value }
  return 0L
}

function Rank-Children([string]$root, [int]$top) {
  Write-Host ""
  Write-Host "=== $root ==="
  $rows = @()
  Get-ChildItem $root -Directory -Force | ForEach-Object {
    $b = Get-RoboBytes $_.FullName
    $rows += [PSCustomObject]@{
      Name = $_.Name
      GB   = [math]::Round($b / 1GB, 2)
      MB   = [math]::Round($b / 1MB, 0)
    }
  }
  $rows | Sort-Object GB -Descending | Select-Object -First $top | Format-Table -AutoSize
  $total = ($rows | Measure-Object -Property GB -Sum).Sum
  Write-Host ("TOTAL (sum of children): {0:N2} GB" -f $total)
}

Rank-Children "$env:USERPROFILE\AppData\Local" 40
Rank-Children "$env:USERPROFILE\AppData\Roaming" 30
Rank-Children "$env:USERPROFILE\AppData\LocalLow" 20
