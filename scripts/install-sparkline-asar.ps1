$ErrorActionPreference = "Stop"
$src = "c:\1\1\1\1\1\HyperlinksSpaceProgram\.tmp-app.asar.sparkline"
$dest = "C:\Program Files\Hyperlinks Space Program\versions\53.0.1428\resources\app.asar"
$flat = "C:\Program Files\Hyperlinks Space Program\resources\app.asar"
$log = "c:\1\1\1\1\1\HyperlinksSpaceProgram\.tmp-asar-install.log"
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date).ToString("o"), $m) }
try {
  Log "sparkline start"
  if (-not (Test-Path $src)) { throw "missing $src" }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  Log ("sparkline dest size=" + (Get-Item -LiteralPath $dest).Length)
  if (Test-Path $flat) {
    Copy-Item -LiteralPath $src -Destination $flat -Force
    Log "sparkline flat ok"
  }
  Log "sparkline OK"
} catch {
  Log ("FAIL " + $_.Exception.Message)
  exit 1
}
