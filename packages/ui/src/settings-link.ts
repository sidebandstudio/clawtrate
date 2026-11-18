// Opening Settings on one of its sections from anywhere in the interface, such
// as an approval card's "Manage settings", without passing a callback down
// through every component in between. The app listens for the event; focus
// goes back to the control that opened Settings when it closes.

export type SettingsSection = "gateway" | "accounts" | "permissions";

export const OPEN_SETTINGS_EVENT = "clawtrate:open-settings";

export function openSettings(section: SettingsSection): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section } }));
}
