# Retarget Start Menu / Desktop / Taskbar pins to a stable current\ exe and stamp AppUserModelID.
# Keeps the same taskbar pin across versioned updates (versions\<semver>\... changes every release).
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$AppId,
  [string]$AppRoot = "",
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"

function Write-RetargetLog([string]$Message) {
  if (-not $LogPath) { return }
  try {
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("[$ts] [shortcut-retarget] " + $Message)
  } catch {}
}

if (-not [System.IO.File]::Exists($ExePath)) {
  Write-RetargetLog ("exe missing: " + $ExePath)
  exit 0
}

$productNames = @(
  "Hyperlinks Space Program",
  "Hyperlinks Space App"
)
$exeLeaf = [System.IO.Path]::GetFileName($ExePath)
$appRootNorm = ""
if ($AppRoot) {
  try { $appRootNorm = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd('\', '/').ToLowerInvariant() } catch { $appRootNorm = "" }
}

function Test-IsOurProductExeName([string]$Leaf) {
  if (-not $Leaf) { return $false }
  foreach ($name in $productNames) {
    if ($Leaf -ieq ($name + ".exe")) { return $true }
  }
  if ($Leaf -ieq $exeLeaf) { return $true }
  return $false
}

function Test-IsOurShortcutTarget([string]$Target) {
  if (-not $Target) { return $false }
  $t = $Target.Trim().Trim('"')
  if (-not $t) { return $false }
  $leaf = [System.IO.Path]::GetFileName($t)
  if (Test-IsOurProductExeName $leaf) { return $true }
  if (-not $appRootNorm) { return $false }
  try {
    $full = [System.IO.Path]::GetFullPath($t).ToLowerInvariant()
    if (-not ($full.StartsWith($appRootNorm + [char]92) -or $full -eq $appRootNorm)) { return $false }
    # Only our install layout — never "anything under AppRoot".
    if ($full.Contains('\current\') -or $full.Contains('\versions\')) { return $true }
  } catch {}
  return $false
}

function Test-IsOurShortcutFileName([string]$LnkPath) {
  $base = [System.IO.Path]::GetFileNameWithoutExtension($LnkPath)
  foreach ($name in $productNames) {
    if ($base -ieq $name) { return $true }
  }
  return $false
}

# IPropertyStore for System.AppUserModel.ID via SHGetPropertyStoreFromParsingName (x64-safe).
if (-not ("HspShortcutAumi" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class HspShortcutAumi {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    uint GetCount(out uint cProps);
    uint GetAt(uint iProp, out PROPERTYKEY pkey);
    uint GetValue(ref PROPERTYKEY key, out PropVariant pv);
    uint SetValue(ref PROPERTYKEY key, ref PropVariant pv);
    uint Commit();
  }

  enum GETPROPERTYSTOREFLAGS : uint {
    GPS_DEFAULT = 0,
    GPS_READWRITE = 0x2,
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHGetPropertyStoreFromParsingName(
    string pszPath,
    IntPtr pbc,
    GETPROPERTYSTOREFLAGS flags,
    [In] ref Guid riid,
    out IPropertyStore propertyStore);

  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref PropVariant pvar);

  public static void SetAppUserModelId(string lnkPath, string appId) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, GETPROPERTYSTOREFLAGS.GPS_READWRITE, ref iid, out store);
    var key = new PROPERTYKEY {
      fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
      pid = 5
    };
    var pv = new PropVariant();
    pv.vt = 31; // VT_LPWSTR
    pv.pointerValue = Marshal.StringToCoTaskMemUni(appId);
    try {
      store.SetValue(ref key, ref pv);
      store.Commit();
    } finally {
      PropVariantClear(ref pv);
      if (store != null) Marshal.ReleaseComObject(store);
    }
  }
}
"@
}

function Update-OneShortcut([string]$LnkPath) {
  try {
    if (-not [System.IO.File]::Exists($LnkPath)) { return $false }
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($LnkPath)
    $target = [string]$sc.TargetPath
    $ours = (Test-IsOurShortcutTarget $target) -or (Test-IsOurShortcutFileName $LnkPath)
    if (-not $ours) { return $false }

    $sc.TargetPath = $ExePath
    $sc.WorkingDirectory = $WorkDir
    $sc.IconLocation = "$ExePath,0"
    $sc.Save()

    try {
      [HspShortcutAumi]::SetAppUserModelId($LnkPath, $AppId)
    } catch {
      Write-RetargetLog ("aumid warn: " + $LnkPath + " " + $_.Exception.Message)
    }

    Write-RetargetLog ("updated: " + $LnkPath + " -> " + $ExePath)
    return $true
  } catch {
    Write-RetargetLog ("failed: " + $LnkPath + " " + $_.Exception.Message)
    return $false
  }
}

$updated = 0
$seen = @{}

function Consider-Lnk([string]$LnkPath) {
  if (-not $LnkPath) { return }
  if ($seen.ContainsKey($LnkPath)) { return }
  $seen[$LnkPath] = $true
  if (Update-OneShortcut $LnkPath) { $script:updated++ }
}

# Start Menu + Desktop: only our known shortcut file names (do not scan all Programs).
$namedDirs = @(
  [Environment]::GetFolderPath("CommonPrograms"),
  [Environment]::GetFolderPath("Programs"),
  [Environment]::GetFolderPath("CommonDesktopDirectory"),
  [Environment]::GetFolderPath("Desktop")
) | Where-Object { $_ }

foreach ($dir in $namedDirs) {
  if (-not [System.IO.Directory]::Exists($dir)) { continue }
  foreach ($name in $productNames) {
    Consider-Lnk (Join-Path $dir ($name + ".lnk"))
  }
}

$appData = [Environment]::GetFolderPath("ApplicationData")
if ($appData) {
  $taskBar = Join-Path $appData "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
  if ([System.IO.Directory]::Exists($taskBar)) {
    Get-ChildItem -LiteralPath $taskBar -Filter "*.lnk" -File -ErrorAction SilentlyContinue | ForEach-Object {
      Consider-Lnk $_.FullName
    }
  }
  $implicit = Join-Path $appData "Microsoft\Internet Explorer\Quick Launch\User Pinned\ImplicitAppShortcuts"
  if ([System.IO.Directory]::Exists($implicit)) {
    Get-ChildItem -LiteralPath $implicit -Filter "*.lnk" -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      Consider-Lnk $_.FullName
    }
  }
}

Write-RetargetLog ("done updated=" + $updated + " exe=" + $ExePath + " aumid=" + $AppId)
exit 0
