; Added to electron-builder's NSIS installer through `nsis.include` (config.ts).
;
; The installer keeps a copy of itself for an updater, at
; $LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}: installer.exe in a folder named
; after the package with "-updater". electron-builder's uninstaller removes the
; app, its shortcuts and its registry keys but not that copy. The app has no
; updater, so an uninstall that is not part of an update removes the copy and
; then its folder, if nothing else is in it. It also removes the app's own
; registration for Clawtrate links, which the app writes for this user when it
; starts, so no link is handed to a program that is gone.

; The folder, from the file's path; the build fails if electron-builder ever names the file otherwise.
!searchparse "${APP_INSTALLER_STORE_FILE}" "" CLAWTRATE_UPDATER_DIR "\installer.exe"

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
    DeleteRegKey HKCU "Software\Classes\clawtrate"
  ${endif}
!macroend

; Distinguish the signed setup container from the app and its uninstaller.
!ifndef BUILD_UNINSTALLER
  VIAddVersionKey /LANG=1033 "OriginalFilename" "ClawtrateSetup.exe"
!endif
