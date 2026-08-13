!macro customHeader
  !undef APP_FILENAME
  !define APP_FILENAME "AI Digital Human"
!macroend

!macro customInstall
  DetailPrint "Installing OBS Virtual Camera and signed virtual audio driver..."
  nsExec::ExecToStack '"$SYSDIR\regsvr32.exe" /i /s "$INSTDIR\resources\prerequisites\obs-portable\data\obs-plugins\win-dshow\obs-virtualcam-module64.dll"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "OBS Virtual Camera registration failed (code $0)."
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$WINDIR\SysWOW64\regsvr32.exe" /i /s "$INSTDIR\resources\prerequisites\obs-portable\data\obs-plugins\win-dshow\obs-virtualcam-module32.dll"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "OBS Virtual Camera 32-bit registration failed (code $0)."
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\pnputil.exe" /add-driver "$INSTDIR\resources\prerequisites\virtual-audio-driver\*.inf" /subdirs /install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Virtual audio driver installation failed (code $0)."
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$SYSDIR\regsvr32.exe" /u /s "$INSTDIR\resources\prerequisites\obs-portable\data\obs-plugins\win-dshow\obs-virtualcam-module64.dll"'
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /u /s "$INSTDIR\resources\prerequisites\obs-portable\data\obs-plugins\win-dshow\obs-virtualcam-module32.dll"'
!macroend
