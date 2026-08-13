$ErrorActionPreference = "Stop"
$src = "c:\1\1\1\1\1\HyperlinksSpaceProgram\.tmp-app.asar.new"
$dest = "C:\Program Files\Hyperlinks Space Program\versions\53.0.1428\resources\app.asar"
$bak = "$dest.bak-pre-swap-coffee"
$log = "c:\1\1\1\1\1\HyperlinksSpaceProgram\.tmp-asar-install.log"
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date).ToString("o"), $m) }
try {
  Log "start"
  if (-not (Test-Path $src)) { throw "missing src $src" }
  if (-not (Test-Path $dest)) { throw "missing dest $dest" }
  if (-not (Test-Path $bak)) {
    Copy-Item -LiteralPath $dest -Destination $bak -Force
    Log "backed up"
  }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  Log "installed size=$((Get-Item -LiteralPath $dest).Length)"
  Log "OK"
} catch {
  Log ("FAIL " + $_.Exception.Message)
  exit 1
}
