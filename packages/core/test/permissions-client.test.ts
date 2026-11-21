// What a bot may do, through the client and a viewer's bridge session: a
// choice is bound to the connection it started on, and to the viewer that made it.
import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { deferred, until } from "./fake-gateway.ts";

const CATALOG = {
  groups: [
    {
      id: "fs",
      label: "Files",
      tools: ["ls", "read", "write", "edit", "apply_patch"].map((id) => ({ id, source: "core" })),
    },
  ],
};

function permissionsGateway() {
  const fake = new AccountsGateway();
  fake.gateway.handlers["tools.catalog"] = () => CATALOG;
  fake.gateway.handlers["tools.effective"] = () => ({});
  return fake;
}

describe("a choice of what a bot may do, through the client", () => {
  it("after a reconnect it sends nothing more and reads nothing back from the new connection: the save couldn't be confirmed", async () => {
    const fake = permissionsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const view = await client.readPermissions("otto");
    const config = fake.gateway.handlers["config.get"]!;
    let patched = false;
    let dropped = false;
    fake.gateway.handlers["config.patch"] = ((patch) => (params: unknown) => {
      const answer = patch(params);
      patched = true;
      return answer;
    })(fake.gateway.handlers["config.patch"]!);
    // The first read after the patch says it isn't in use yet; the connection then drops and
    // comes back while the engine waits to read again.
    fake.gateway.handlers["config.get"] = (params) => {
      const answer = config(params) as { appliedConfigHash: string };
      if (!patched || dropped) return answer;
      dropped = true;
      setTimeout(() => fake.gateway.dropAll(), 5);
      return { ...answer, appliedConfigHash: "not-yet" };
    };
    const before = fake.gateway.connects.length;
    const result = await client.setPermission("otto", "files", "never", {
      configHash: view.configHash,
      rulesVersion: view.versions.bot,
    });
    expect(fake.gateway.connects.length).toBeGreaterThan(before);
    expect(result.outcome).toBe("unconfirmed");
    expect(result.view).toBeNull();
    client.stop();
  });

  it("a viewer that closes while its choice is still reading sends nothing", async () => {
    const fake = permissionsGateway();
    const { client } = await accountsClient({ gateway: fake });
    const view = await client.readPermissions("otto");
    const viewer = createBridgeSession(client);
    const held = deferred<unknown>();
    const catalog = fake.gateway.handlers["tools.catalog"]!;
    fake.gateway.handlers["tools.catalog"] = () => held.promise.then(() => catalog({}));
    const pending = viewer.apply({
      type: "setPermission",
      botId: "otto",
      line: "files",
      choice: "never",
      configHash: view.configHash,
      rulesVersion: view.versions.bot,
    });
    await until(() => fake.gateway.calls("tools.catalog").length >= 2);
    viewer.dispose();
    held.resolve(null);
    const result = await pending;
    expect(fake.gateway.calls("config.patch")).toEqual([]);
    expect(result).toMatchObject({ outcome: "failed" });
    client.stop();
  });
});
