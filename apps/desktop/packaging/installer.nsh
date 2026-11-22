; Added to electron-builder's NSIS installer through `nsis.include` (config.ts).
;
; The installer keeps a copy of itself for an updater, at
; $LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}: installer.exe in a folder named
; after the package with "-updater". electron-builder's uninstaller removes the
; app, its shortcuts and its registry keys but not that copy. The app has no
; updater, so an uninstall that is not part of an update removes the copy and
; then its folder, if nothing else is in it.
;
; electron-builder registers no URL scheme on Windows, so this installation
; registers Clawtrate links (docs/design/links.md) for its own scope, this user
; or every user, replacing an entry already there, and its uninstaller removes
; that entry only while it still opens this installation, on an update too. The
; command puts `--` before the link, so nothing Windows splits from a link
; reaches Chromium as a switch (src/main/links.ts).

; The folder, from the file's path; the build fails if electron-builder ever names the file otherwise.
!searchparse "${APP_INSTALLER_STORE_FILE}" "" CLAWTRATE_UPDATER_DIR "\installer.exe"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\clawtrate" "" "URL:clawtrate"
  WriteRegStr SHELL_CONTEXT "Software\Classes\clawtrate" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\clawtrate\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The installer wrote it to the current user's folder whatever the install mode.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    Delete "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
    RMDir "$LOCALAPPDATA\${CLAWTRATE_UPDATER_DIR}"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
  ; The link entry goes on an update too. An install for every user first runs
  ; this user's uninstaller as an update, and this user's entry would win over
  ; the new one. electron-builder runs that uninstaller before customInstall, so
  ; an update in the same scope writes the entry again. An entry another copy of
  ; the app, or another program, wrote since stays.
  Push $0
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\clawtrate\shell\open\command" ""
  ${if} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    DeleteRegKey SHELL_CONTEXT "Software\Classes\clawtrate"
  ${endif}
  Pop $0
!macroend

; Distinguish the signed setup container from the app and its uninstaller.
!ifndef BUILD_UNINSTALLER
  VIAddVersionKey /LANG=1033 "OriginalFilename" "ClawtrateSetup.exe"
!endif
