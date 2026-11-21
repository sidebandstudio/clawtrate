// The permissions fixture (apps/desktop/src/fixture/permissions.ts) shows what a real read would:
// with `write=stored` the gateway keeps using the settings from before the save, so the latest
// task's listing comes from those, never from the stored revision.
import type { BotPermissions, PermissionWrite } from "@clawtrate/core";
import { describe, expect, it } from "vitest";
import { permissionCommands } from "../src/fixture/permissions.ts";

const params = { rules: null, read: null, perm: null, override: false, write: "stored" };

describe("the permissions fixture", () => {
  it("an unapplied Never does not change Offered, or appear in the current Never count", async () => {
    const command = permissionCommands(Date.now(), params, () => true);
    const before = (await command({ type: "readPermissions", botId: "pip" })) as BotPermissions;
    const read = (view: BotPermissions) => view.lines.find((line) => line.id === "read")!;
    expect(read(before).offered).toBe("yes");
    const result = (await command({
      type: "setPermission",
      botId: "pip",
      line: "read",
      choice: "never",
      configHash: before.configHash,
      rulesVersion: before.versions.bot,
    })) as PermissionWrite;
    expect(result.outcome).toBe("stored");
    expect(result.view!.settingsApplied).toBe("no");
    // The stored deny shows on the line; the task's listing still has the tools in use.
    expect(read(result.view!).offered).toBe("yes");
    // A second stored save keeps the revision in use, and the listing with it.
    const again = (await command({
      type: "setPermission",
      botId: "pip",
      line: "files",
      choice: "never",
      configHash: result.view!.configHash,
      rulesVersion: result.view!.versions.bot,
    })) as PermissionWrite;
    expect(again.view!.settingsApplied).toBe("no");
    expect(again.view!.lines.find((line) => line.id === "files")!.offered).toBe("yes");
  });
});
