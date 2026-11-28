// A device switch's save belongs to the app, not to the Settings sheet (F-519, F-562). Closing
// Settings, opening Font licenses or going Back unmounts the switch's row while its save may
// still be on its way. The value asked for, the one-save-at-a-time lock and the failure are kept
// here for the app's lifetime, so a row opened again shows them.

import type { BridgeCommand } from "@clawtrate/core";
import type { DeviceSwitch } from "./presentation/gateway-state.ts";

export type SwitchSave = {
  /** The value asked for, shown until core reports it; null once it does, or the save failed. */
  asked: boolean | null;
  /** A save is on its way: the switch takes no other until it ends. */
  saving: boolean;
  /** Why the last save failed, redacted. */
  error: string | null;
};

const IDLE: SwitchSave = { asked: null, saving: false, error: null };

export type SwitchSaves = {
  get: (id: DeviceSwitch["id"]) => SwitchSave;
  subscribe: (changed: () => void) => () => void;
  /** Ask core to keep `on`. Refused while a save of the same switch is on its way. */
  toggle: (setting: DeviceSwitch, on: boolean) => void;
  /** Core reports `shown`: a value asked for that core now reports is no longer held. */
  settle: (id: DeviceSwitch["id"], shown: boolean) => void;
};

export function createSwitchSaves(
  send: (command: BridgeCommand) => Promise<unknown>,
  redact: (text: string) => string,
): SwitchSaves {
  const saves = new Map<DeviceSwitch["id"], SwitchSave>();
  const listeners = new Set<() => void>();
  const get = (id: DeviceSwitch["id"]) => saves.get(id) ?? IDLE;
  const update = (id: DeviceSwitch["id"], change: Partial<SwitchSave>) => {
    saves.set(id, { ...get(id), ...change });
    for (const changed of listeners) changed();
  };
  return {
    get,
    subscribe: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    toggle: (setting, on) => {
      // One save at a time: a second tap before the first is kept could show the first's answer.
      if (get(setting.id).saving) return;
      update(setting.id, { asked: on, saving: true, error: null });
      void send({ type: setting.command, on }).then(
        () => update(setting.id, { saving: false }),
        (failure: unknown) =>
          update(setting.id, {
            asked: null,
            saving: false,
            error: redact(failure instanceof Error ? failure.message : String(failure)),
          }),
      );
    },
    settle: (id, shown) => {
      if (get(id).asked === shown) update(id, { asked: null });
    },
  };
}
