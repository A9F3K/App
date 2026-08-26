; Installer hooks for debug-friendly installs:
; - real-time DetailPrint + mirrored log file in %TEMP%
; - finish page shows full log in selectable read-only text area
;
; InstFiles page: the one-line status above the list is separate from the details list. SetDetailsPrint
; both duplicates DetailPrint into both; we use textonly for HspInstallStepStatus, then listonly so
; HspInstallDetailPrint lines only appear in the list (not repeated on the status line).
; Steps 1–N: see !define HSP_INSTALL_STEP_TOTAL and !insertmacro HspInstallStepStatus in HspInstFilesShow,
; customCheckAppRunning, extractAppPackage (decompress), customInstall.
;
; HSP_INSTALLER_AUTO_FINISH — two finish-page setups (see commits 4f25a5c vs 160595ef):
;   • Defined   → auto-dismiss wizard after install (4f25a5c: no MUI_FINISHPAGE_NOAUTOCLOSE, Finish
;                button, then WM_CLOSE / Quit in HspFinishPage*).
;   • Commented → installer stays open for logs (160595ef: MUI_FINISHPAGE_NOAUTOCLOSE, no forced close).
; Uncomment the next line to enable auto-close:
!define HSP_INSTALLER_AUTO_FINISH

; Extra exe name for older builds (do not use APP_EXECUTABLE_FILENAME here — not always defined by NSIS / CI).
; Legacy main exe from older "Hyperlinks Space App" installs (taskkill / relaunch).
!define HSP_ALT_MAIN_EXE "Hyperlinks Space App.exe"
; Hiding the bar: MUI2 only allows MUI_INSTFILESPAGE_PROGRESSBAR = "" | colored | smooth — "disable" is invalid and breaks InstProgressFlags (NSIS 3 CI). Hide msctls_progress32 at runtime in HspInstFilesShow instead.

!include "FileFunc.nsh"
!include "WinMessages.nsh"

!define HSP_INSTALL_STEP_TOTAL 6
; Status line only (textonly). Keep in sync with step inserts in customCheckAppRunning, extractAppPackage, customInstall.
!macro HspInstallStepStatus STEP
  !ifndef BUILD_UNINSTALLER
  SetDetailsView show
  SetDetailsPrint textonly
  DetailPrint "Installation: Step ${STEP} of ${HSP_INSTALL_STEP_TOTAL}"
  SetDetailsPrint listonly
  !endif
!macroend

!ifdef BUILD_UNINSTALLER
!macro HspAppendInstallerLog TEXT
!macroend
!macro HspInstallDetailPrint MSG
!macroend
!endif

!ifndef BUILD_UNINSTALLER
Var HspLogFile
Var HspLogHandle
Var HspFinishLogEdit
Var HspDidLaunchApp

Function HspEnsureInstallerLogPath
  StrCmp $HspLogFile "" hspSetLogPath hspLogPathDone
hspSetLogPath:
  StrCpy $HspLogFile "$TEMP\HyperlinksSpaceInstall.log"
  Delete "$HspLogFile"
hspLogPathDone:
FunctionEnd

!macro HspAppendInstallerLog TEXT
  Call HspEnsureInstallerLogPath
  ${GetTime} "" "L" $R0 $R1 $R2 $R3 $R4 $R5 $R6
  StrCpy $R7 "[$R2-$R1-$R0 $R4:$R5:$R6] "
  FileOpen $HspLogHandle "$HspLogFile" a
  FileWrite $HspLogHandle $R7
  FileWrite $HspLogHandle "${TEXT}"
  FileWrite $HspLogHandle "$\r$\n"
  FileClose $HspLogHandle
!macroend

!macro HspInstallDetailPrint MSG
  SetDetailsView show
  SetDetailsPrint listonly
  DetailPrint "${MSG}"
  !insertmacro HspAppendInstallerLog "${MSG}"
!macroend

Function .onInstSuccess
  ; Primary launch trigger for all installer modes (including one-click/silent paths).
  ; Use one-shot guard so Finish-page fallback does not launch twice.
  StrCmp $HspDidLaunchApp "1" hspInstSuccessAfterLaunch
  StrCpy $HspDidLaunchApp "1"
  Sleep 500
  Call HspLaunchInstalledApp
hspInstSuccessAfterLaunch:
  !insertmacro HspAppendInstallerLog "INSTALL_SUCCESS"
FunctionEnd

Function HspLaunchInstalledApp
  ; Keep Forge/electron-builder compatibility: avoid $launchLink (not always defined).
  IfFileExists "$INSTDIR\current\${PRODUCT_FILENAME}.exe" hspLaunchCurrent hspLaunchLegacy
hspLaunchCurrent:
  ExecShell "open" "$INSTDIR\current\${PRODUCT_FILENAME}.exe"
  !insertmacro HspAppendInstallerLog "APP_LAUNCH_TRIGGERED(current)"
  Return
hspLaunchLegacy:
  IfFileExists "$INSTDIR\${PRODUCT_FILENAME}.exe" hspLaunchLegacyDo hspLaunchFailed
hspLaunchLegacyDo:
  ExecShell "open" "$INSTDIR\${PRODUCT_FILENAME}.exe"
  !insertmacro HspAppendInstallerLog "APP_LAUNCH_TRIGGERED"
  Return
hspLaunchFailed:
  !insertmacro HspAppendInstallerLog "APP_LAUNCH_FAILED"
FunctionEnd

Function .onInstFailed
  !insertmacro HspAppendInstallerLog "INSTALL_FAILED"
FunctionEnd

Function HspInstFilesShow
  !insertmacro HspInstallStepStatus 1
  FindWindow $0 "#32770" "" $HWNDPARENT
  FindWindow $1 "msctls_progress32" "" $0
  IntCmp $1 0 hspInstFilesBarDone
  ShowWindow $1 ${SW_HIDE}
hspInstFilesBarDone:
FunctionEnd

; $0 = 1 if any known packaged exe is still running (see hsp-app-process.ps1 -Action Test).
Function HspResolvePowerShellExe
  IfFileExists "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" 0 hspPsSys32
    StrCpy $R5 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    Return
  hspPsSys32:
  StrCpy $R5 "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
FunctionEnd

Function HspSetEnvInstDir
  System::Call 'kernel32::SetEnvironmentVariable(t, t) ("HSP_INSTDIR", "$INSTDIR")'
FunctionEnd

Function HspClearEnvInstDir
  System::Call 'kernel32::SetEnvironmentVariable(t, i) ("HSP_INSTDIR", 0)'
FunctionEnd

; PowerShell: use nsExec::Exec (not ExecWait). ExecWait always attaches a console to powershell.exe,
; which flashes on screen even with -WindowStyle Hidden; nsExec runs the process with no console window.
Function HspAnyPackagedExeRunning
  Call HspResolvePowerShellExe
  Call HspSetEnvInstDir
  IfFileExists "$PLUGINSDIR\hsp-app-process.ps1" 0 hspAnyExeNoScript
    nsExec::Exec `"$R5" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hsp-app-process.ps1" -Action Test`
    Pop $R4
    Call HspClearEnvInstDir
    StrCmp $R4 "error" hspAnyExeNsFail
    StrCmp $R4 "timeout" hspAnyExeNsFail
    IntCmp $R4 0 hspAnyExeYes
    StrCpy $0 0
    Return
  hspAnyExeNsFail:
    StrCpy $0 0
    Return
  hspAnyExeNoScript:
  Call HspClearEnvInstDir
  StrCpy $0 0
  Return
hspAnyExeYes:
  StrCpy $0 1
  Return
FunctionEnd

Function HspWaitUntilPackagedProcessesGone
  StrCpy $R8 0
hspWaitPackagedPoll:
  Call HspAnyPackagedExeRunning
  IntCmp $0 0 hspWaitPackagedDone
  IntOp $R8 $R8 + 1
  IntCmp $R8 600 0 0 hspWaitPackagedDone
  Sleep 50
  Goto hspWaitPackagedPoll
hspWaitPackagedDone:
  ; Extra settle after Test script reports processes gone (handles on DLLs).
  Sleep 500
FunctionEnd

Function HspKillPackagedAppProcesses
  Call HspResolvePowerShellExe
  Call HspSetEnvInstDir
  IfFileExists "$PLUGINSDIR\hsp-app-process.ps1" 0 hspKillNoScript
    nsExec::Exec `"$R5" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\hsp-app-process.ps1" -Action Kill`
    Pop $R4
  hspKillNoScript:
  Call HspClearEnvInstDir
FunctionEnd

; Called from windows/extractAppPackage.nsh before each CopyFiles (and each retry).
Function HspKillBeforeCopy
  SetDetailsView show
  SetDetailsPrint listonly
  DetailPrint "[installer] unlock install dir before copy (attempt $R1)"
  Call HspKillPackagedAppProcesses
  Call HspWaitUntilPackagedProcessesGone
  ; Second pass: elevation can miss user processes on first taskkill; retry once.
  Call HspKillPackagedAppProcesses
  Call HspWaitUntilPackagedProcessesGone
  ; Clear read-only on existing tree (helps overwrite in Program Files).
  IfFileExists "$INSTDIR" 0 hspKillBeforeCopyNoAttrib
    nsExec::Exec `%COMSPEC% /c attrib -R "$INSTDIR\*.*" /S /D`
    Pop $R9
  hspKillBeforeCopyNoAttrib:
FunctionEnd

; Remove old app payload before extracting a new build (keep Uninstall*.exe).
Function HspPurgeInstallPayload
  IfFileExists "$INSTDIR" 0 hspPurgeInstallDone
  !insertmacro HspInstallDetailPrint "[installer] purge old app payload (preserve uninstaller)"
  Call HspResolvePowerShellExe
  Call HspSetEnvInstDir
  nsExec::Exec `"$R5" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { $dst = $env:HSP_INSTDIR; if (-not $dst -or -not (Test-Path -LiteralPath $dst)) { exit 0 }; Get-ChildItem -LiteralPath $dst -Force | Where-Object { $_.Name -notlike 'Uninstall*.exe' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }"`
  Pop $R4
  Call HspClearEnvInstDir
hspPurgeInstallDone:
FunctionEnd

Function HspFinishPageShow
!ifndef HSP_INSTALLER_AUTO_FINISH
  SetAutoClose false
!endif
  Call HspEnsureInstallerLogPath
  ; Launch app automatically when install reaches finish page; keep installer open for logs.
  StrCmp $HspDidLaunchApp "1" hspSkipAutoLaunch
  StrCpy $HspDidLaunchApp "1"
  Call HspLaunchInstalledApp
hspSkipAutoLaunch:
  StrCpy $HspFinishLogEdit ""
  System::Call "user32::CreateWindowExW(i 0, w \"Edit\", w \"\", i 0x50201844, i 128, i 128, i 360, i 220, i $HWNDPARENT, i 0, i 0, i 0) i.r0"
  IntCmp $0 0 hspFinishShowDone
  StrCpy $HspFinishLogEdit $0
  StrCpy $9 $0
  System::Call "user32::SendMessageW(i r9, i 0xC5, i 16777216, i 0)"
  IfFileExists "$HspLogFile" hspFinishFillFile
  System::Call "user32::SetWindowTextW(i r9, w \"No installation log file was found.\")"
  Goto hspFinishShowDone
hspFinishFillFile:
  FileOpen $R0 "$HspLogFile" r
hspFinishReadLoop:
  FileRead $R0 $1
  IfErrors hspFinishFileDone
  System::Call "user32::SendMessageW(i r9, i 0x000E, i 0, i 0) i.r4"
  System::Call "user32::SendMessageW(i r9, i 0xB1, i r4, i r4)"
  StrCpy $2 "$1$\r$\n"
  System::Call "user32::SendMessageW(i r9, i 0xC2, i 1, w r2)"
  Goto hspFinishReadLoop
hspFinishFileDone:
  FileClose $R0
hspFinishShowDone:
!ifdef HSP_INSTALLER_AUTO_FINISH
  ; Quit in SHOW alone is unreliable (runs before nsDialogs::Show message loop).
  SendMessage $HWNDPARENT ${WM_CLOSE} 0 0
  System::Call "user32::PostQuitMessage(i 0)"
!endif
FunctionEnd

Function HspFinishPageLeave
  StrCmp $HspFinishLogEdit "" +3
  StrCpy $0 $HspFinishLogEdit
  System::Call "user32::DestroyWindow(i r0)"
  StrCpy $HspFinishLogEdit ""
!ifdef HSP_INSTALLER_AUTO_FINISH
  Quit
!endif
FunctionEnd
!endif

!macro customHeader
  Caption "${PRODUCT_NAME}"
  ShowInstDetails show
  !ifdef BUILD_UNINSTALLER
    ShowUninstDetails show
  !endif
!macroend

!macro customPageAfterChangeDir
  ShowInstDetails show
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW HspInstFilesShow
!macroend

!macro customInstallMode
  ; Leave install mode to electron-builder (perMachine in package.json → Program Files).
  ; Forcing $isForceCurrentInstall breaks INSTALL_MODE_PER_ALL_USERS_REQUIRED / per-machine builds.
!macroend

; Installer only. Uninstaller defines BUILD_UNINSTALLER — Call must use un.* there; use stock _CHECK_APP_RUNNING.
!ifndef BUILD_UNINSTALLER
!macro customCheckAppRunning
  !insertmacro HspInstallDetailPrint "[installer] stop running app processes (tree kill + wait, all exe names)"
  Call HspKillPackagedAppProcesses
  Call HspWaitUntilPackagedProcessesGone
  Call HspPurgeInstallPayload
  !insertmacro HspInstallStepStatus 2
!macroend
!endif

!macro customInit
  !insertmacro HspInstallDetailPrint "[installer] customInit start"
  ; Remove stale Start Menu / Desktop shortcuts from older "Hyperlinks Space App" installs (new product: ${PRODUCT_NAME}).
  Delete "$SMPROGRAMS\Hyperlinks Space App.lnk"
  Delete "$COMMONPROGRAMS\Hyperlinks Space App.lnk"
  Delete "$DESKTOP\Hyperlinks Space App.lnk"
  Delete "$COMMONDESKTOP\Hyperlinks Space App.lnk"
  RMDir /r /REBOOTOK "$SMPROGRAMS\Hyperlinks Space App"
  RMDir /r /REBOOTOK "$COMMONPROGRAMS\Hyperlinks Space App"
  ; Old per-user installs (AppData\Local\Programs\...) when current build uses perMachine → Program Files.
  ReadEnvStr $R8 "LOCALAPPDATA"
  RMDir /r /REBOOTOK "$R8\Programs\Hyperlinks Space App"
  RMDir /r /REBOOTOK "$R8\Programs\HyperlinksSpaceApp"
  !insertmacro HspInstallDetailPrint "[installer] removed legacy Hyperlinks Space App shortcuts (if present)"
  ; Do NOT delete UninstallString / QuietUninstallString here — that breaks Windows Settings "Uninstall"
  ; for this product and can leave a grayed-out Apps entry with no uninstall command.
  !insertmacro HspInstallDetailPrint "[installer] customInit complete"
!macroend

!macro customInstall
  !insertmacro HspInstallStepStatus 5
  !insertmacro HspInstallDetailPrint "[installer] customInstall start"
  !insertmacro HspInstallDetailPrint "[installer] files copied, waiting for Finish page"
  ; Prefer current\exe so Start Menu / taskbar pins follow the version junction after updates.
  ; Stamp AppUserModelID so pins group by app id (not versions\<semver>\ path) across updates.
  IfFileExists "$INSTDIR\current\${PRODUCT_FILENAME}.exe" 0 hspSkipCurrentShortcuts
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\current\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\current\${PRODUCT_FILENAME}.exe" 0
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\current\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\current\${PRODUCT_FILENAME}.exe" 0
  WinShell::SetLnkAUMI "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "${APP_ID}"
  WinShell::SetLnkAUMI "$DESKTOP\${PRODUCT_NAME}.lnk" "${APP_ID}"
  !insertmacro HspInstallDetailPrint "[installer] shortcuts pointed at current\\ + AUMID ${APP_ID}"
hspSkipCurrentShortcuts:
  ; Trigger launch as soon as install work is complete.
  StrCmp $HspDidLaunchApp "1" hspCustomInstallAfterLaunch
  StrCpy $HspDidLaunchApp "1"
  Call HspLaunchInstalledApp
hspCustomInstallAfterLaunch:
  !insertmacro HspInstallDetailPrint "[installer] customInstall complete"
  !insertmacro HspInstallStepStatus 6
!macroend

!macro customFinishPage
  !ifndef BUILD_UNINSTALLER
  !ifdef HSP_INSTALLER_AUTO_FINISH
    ; 4f25a5c: omit NOAUTOCLOSE (single-step to Finish; then we force-close in HspFinishPageShow/Leave).
    !define MUI_FINISHPAGE_BUTTON "Finish"
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW HspFinishPageShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE HspFinishPageLeave
    !insertmacro MUI_PAGE_FINISH
  !else
    ; 160595ef: NOAUTOCLOSE keeps the wizard open until the user is done (log copy / manual close).
    !define MUI_FINISHPAGE_NOAUTOCLOSE
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW HspFinishPageShow
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE HspFinishPageLeave
    !insertmacro MUI_PAGE_FINISH
  !endif
  !endif
!macroend

!macro customUnInstall
  !insertmacro HspAppendInstallerLog "[uninstaller] start"
  ; Per-machine installs only remove SHELL_CONTEXT=HKLM keys. Legacy per-user installs also wrote
  ; HKCU Uninstall + Software\{APP_GUID}; that leaves a duplicate "Installed apps" row. Clean HKCU when
  ; uninstalling for all users. (Do not remove HKCU InstallLocation when uninstalling per-user —
  ; InstFiles still reads MenuDirectory from HKCU in that mode.)
  DetailPrint "[uninstaller] legacy HKCU registry cleanup (if any)"
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  ${if} $installMode == "all"
    DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"
  ${endif}

  ; Defensive cleanup for older 32-bit-view uninstall entries (WOW6432Node) that can remain visible
  ; in Windows "Installed apps" if an old uninstall executable was removed manually.
  DetailPrint "[uninstaller] legacy WOW6432Node uninstall key cleanup (if any)"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"

  ; Remove legacy all-users install folders only (do not target current PRODUCT folder here).
  ; Try immediate delete first; schedule reboot cleanup only if path is locked.
  ClearErrors
  RMDir /r "$PROGRAMFILES\Hyperlinks Space App"
  IfErrors 0 +2
    RMDir /r /REBOOTOK "$PROGRAMFILES\Hyperlinks Space App"

  ClearErrors
  RMDir /r "$PROGRAMFILES64\Hyperlinks Space App"
  IfErrors 0 +2
    RMDir /r /REBOOTOK "$PROGRAMFILES64\Hyperlinks Space App"

  !insertmacro HspAppendInstallerLog "[uninstaller] complete"
!macroend

; Runs before Section install (electron-builder prepends this include). Drops helper script for nsExec::Exec -File.
; Use BUILD_RESOURCES_DIR so makensis finds the script when cwd is the NSIS cache dir (Forge/CI).
!ifndef BUILD_UNINSTALLER
Section "-hsp_app_process_ps1"
  InitPluginsDir
  SetOutPath $PLUGINSDIR
  File "${BUILD_RESOURCES_DIR}\hsp-app-process.ps1"
SectionEnd
!endif
