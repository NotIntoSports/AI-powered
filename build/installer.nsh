!macro customHeader
  !undef APP_FILENAME
  !define APP_FILENAME "AI Digital Human"
!macroend

!macro customInstall
  DetailPrint "Verifying and registering OBS Virtual Camera..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\install-prerequisite.ps1" -Component obs -ResourcesDirectory "$INSTDIR\resources\prerequisites" -Operation install'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP "OBS Virtual Camera registration failed (code $0)."
    Abort
  ${EndIf}

  DetailPrint "Installing VB-Audio VB-CABLE..."
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\install-prerequisite.ps1" -Component virtual-audio -ResourcesDirectory "$INSTDIR\resources\prerequisites" -Operation install'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_ICONSTOP "VB-CABLE installation failed (code $0)."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\install-prerequisite.ps1" -Component obs -ResourcesDirectory "$INSTDIR\resources\prerequisites" -Operation uninstall'
!macroend
