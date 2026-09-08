!macro customInit
  StrCpy $INSTDIR "$LocalAppData\Programs\AI获客-测试版"
  ${GetOptions} $CMDLINE "--force-run" $R0
  ${IfNot} ${Errors}
    SetSilent normal
  ${EndIf}
!macroend
