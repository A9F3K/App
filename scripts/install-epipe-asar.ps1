$ErrorActionPreference = "Stop"
$src = "c:\1\1\1\1\1\HyperlinksSpaceProgram\.tmp-app.asar.epipe"
$dest = "C:\Program Files\Hyperlinks Space Program\versions\53.0.1428\resources\app.asar"
$flat = "C:\Program Files\Hyperlinks Space Program\resources\app.asar"
$log = "c:\1\1\1\1\1\HyperlinksSpaceProgram\.tmp-asar-install.log"
function Log($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date).ToString("o"), $m) }
try {
  Log "epipe start"
  Copy-Item -LiteralPath $src -Destination $dest -Force
  if (Test-Path $flat) { Copy-Item -LiteralPath $src -Destination $flat -Force }
  Log ("epipe OK size=" + (Get-Item -LiteralPath $dest).Length)
} catch {
  Log ("FAIL " + $_.Exception.Message)
  exit 1
}
