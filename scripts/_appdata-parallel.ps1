$ErrorActionPreference = 'SilentlyContinue'

function Get-DirBytes([string]$Path) {
  $sum = 0L
  try {
    $opts = [System.IO.EnumerationOptions]::new()
    $opts.RecurseSubdirectories = $true
    $opts.IgnoreInaccessible = $true
    $opts.AttributesToSkip = [System.IO.FileAttributes]::ReparsePoint
    foreach ($f in [System.IO.Directory]::EnumerateFiles($Path, '*', $opts)) {
      try { $sum += (New-Object System.IO.FileInfo $f).Length } catch {}
    }
  } catch {}
  return $sum
}

function Rank-Parallel([string]$root, [int]$workers = 6, [double]$minGB = 0.05) {
  Write-Host ""
  Write-Host "=== $root ==="
  $dirs = @(Get-ChildItem -LiteralPath $root -Directory -Force)
  Write-Host ("Folders: {0}" -f $dirs.Count)

  $jobs = @()
  foreach ($d in $dirs) {
    while (@(Get-Job -State Running).Count -ge $workers) {
      Start-Sleep -Milliseconds 200
      Get-Job -State Completed | ForEach-Object {
        $r = Receive-Job $_
        Remove-Job $_
        if ($r -and $r.GB -ge $minGB) {
          Write-Host ("{0,8:N2} GB  {1}" -f $r.GB, $r.Name)
          [void]$script:allRows.Add($r)
        }
      }
    }
    $name = $d.Name
    $full = $d.FullName
    Start-Job -ScriptBlock {
      param($p, $n)
      $sum = 0L
      try {
        $opts = [System.IO.EnumerationOptions]::new()
        $opts.RecurseSubdirectories = $true
        $opts.IgnoreInaccessible = $true
        $opts.AttributesToSkip = [System.IO.FileAttributes]::ReparsePoint
        foreach ($f in [System.IO.Directory]::EnumerateFiles($p, '*', $opts)) {
          try { $sum += (New-Object System.IO.FileInfo $f).Length } catch {}
        }
      } catch {}
      [PSCustomObject]@{ Name = $n; GB = [math]::Round($sum / 1GB, 2); Bytes = $sum }
    } -ArgumentList $full, $name | Out-Null
  }

  while (@(Get-Job).Count -gt 0) {
    Get-Job -State Completed | ForEach-Object {
      $r = Receive-Job $_
      Remove-Job $_
      if ($r -and $r.GB -ge $minGB) {
        Write-Host ("{0,8:N2} GB  {1}" -f $r.GB, $r.Name)
        [void]$script:allRows.Add($r)
      }
    }
    if (@(Get-Job -State Running).Count -gt 0) { Start-Sleep -Milliseconds 300 }
  }
}

$script:allRows = [System.Collections.Generic.List[object]]::new()
Rank-Parallel "$env:USERPROFILE\AppData\Local"
Write-Host ""
Write-Host "--- Local TOP sorted ---"
$script:allRows | Sort-Object GB -Descending | Format-Table -AutoSize
Write-Host ("LOCAL TOTAL: {0:N2} GB" -f (($script:allRows | Measure-Object GB -Sum).Sum))

$script:allRows = [System.Collections.Generic.List[object]]::new()
Rank-Parallel "$env:USERPROFILE\AppData\Roaming"
Write-Host ""
Write-Host "--- Roaming TOP sorted ---"
$script:allRows | Sort-Object GB -Descending | Format-Table -AutoSize
Write-Host ("ROAMING TOTAL: {0:N2} GB" -f (($script:allRows | Measure-Object GB -Sum).Sum))

$script:allRows = [System.Collections.Generic.List[object]]::new()
Rank-Parallel "$env:USERPROFILE\AppData\LocalLow"
Write-Host ""
Write-Host "--- LocalLow TOP sorted ---"
$script:allRows | Sort-Object GB -Descending | Format-Table -AutoSize
Write-Host ("LOCALLOW TOTAL: {0:N2} GB" -f (($script:allRows | Measure-Object GB -Sum).Sum))
