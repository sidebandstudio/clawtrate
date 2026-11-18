// The app's bundle id, shared by the main process and the packaging configuration.

export const APP_ID = "dev.clawtrate.desktop";

/**
 * The AppUserModelID the app gives itself on Windows: in a packaged app, the
 * bundle id, which the installer also gives the shortcuts it makes, so the
 * window's taskbar button always belongs to the app's Start menu entry.
 * Without it Windows names the button after the executable's path until it
 * links the executable to a shortcut, and after the shortcut's id from then
 * on. A development build keeps Electron's default; elsewhere there is none.
 */
export function windowsAppUserModelId(platform: string, packaged: boolean): string | null {
  return platform === "win32" && packaged ? APP_ID : null;
}
