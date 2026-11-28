// Settings › Models (docs/design/gateway-settings.md sections 4.1, 6 and 7): the default model,
// its backups and the thinking level, written through the accounts engine. The gateway's answers
// are the frames OpenClaw 2026.10.6 and 2026.11.10 sent on development gateways: the stale-hash
// and invalid-value refusals word for word, `config.schema.lookup`'s `reloadKind`, and a restart
// that closes the connection after the write's answer.

import { describe, expect, it } from "vitest";
import { GatewayError } from "./fake-gateway.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { gatewayStamp } from "../src/types.ts";
import { parseBridgeCommand } from "../src/bridge.ts";

/** Both versions answered these for the paths a Models change writes. */
const HOT = { "agents.defaults.model": "hot", "agents.defaults.thinkingDefault": "hot" } as const;

function withLookup(fake: AccountsGateway, kinds: Record<string, string | null> = HOT) {
  fake.gateway.handlers["config.schema.lookup"] = (params) => {
    const path = (params as { path: string }).path;
    const kind = kinds[path];
    if (kind === undefined)
      throw new GatewayError({ code: "INVALID_REQUEST", message: "config schema path not found" });
    return { path, ...(kind === null ? {} : { reloadKind: kind }) };
  };
  return fake;
}

async function models(kinds?: Record<string, string | null>) {
  const fake = withLookup(new AccountsGateway(), kinds);
  const run = await accountsClient({ gateway: fake });
  const stamp = gatewayStamp(run.client.state.connection);
  return { ...run, stamp };
}

const primaryOf = (fake: AccountsGateway) =>
  (fake.config.agents as { defaults: { model: { primary: string } } }).defaults.model.primary;

describe("Settings › Models: the defaults every bot uses", () => {
  it("reads the default model, its backups, the thinking level and the reload mode", async () => {
    const fake = withLookup(new AccountsGateway());
    fake.config.agents = {
      ...(fake.config.agents as object),
      defaults: {
        model: { primary: "acme/dev-1@acme:work", fallbacks: ["acme/dev-2"] },
        thinkingDefault: "low",
      },
    };
    fake.config.gateway = { reload: { mode: "off" } };
    const { accounts } = await accountsClient({ gateway: fake });
    expect(accounts().defaults).toEqual({
      primary: "acme/dev-1@acme:work",
      fallbacks: ["acme/dev-2"],
      thinking: "low",
      reloadOff: true,
    });
  });

  it("changes the default model with the hash it read, and reads it back as written", async () => {
    const { client, fake, stamp, accounts } = await models();
    await client.setModelDefaults({ primary: "acme/dev-2@acme:home" }, false, stamp);
    expect(primaryOf(fake)).toBe("acme/dev-2@acme:home");
    const sent = fake.gateway.calls("config.patch").at(-1) as { raw: string; baseHash: string };
    expect(sent.baseHash).toBe("h1");
    expect(JSON.parse(sent.raw)).toEqual({
      agents: { defaults: { model: { primary: "acme/dev-2@acme:home" } } },
    });
    expect(accounts().defaultsChange).toMatchObject({
      status: "saved",
      before: { primary: "acme/dev-1" },
      after: { primary: "acme/dev-2@acme:home" },
      restart: false,
    });
    expect(accounts().defaults?.primary).toBe("acme/dev-2@acme:home");
  });

  it("writes a backup list whole, with its path in replacePaths, so a shorter list isn't merged", async () => {
    const { client, fake, stamp } = await models();
    await client.setModelDefaults({ fallbacks: ["acme/dev-2"] }, false, stamp);
    const sent = fake.gateway.calls("config.patch").at(-1) as { replacePaths: string[] };
    expect(sent.replacePaths).toEqual(["agents.defaults.model.fallbacks"]);
  });

  it("takes the backup list out with its path in replacePaths, which both versions require", async () => {
    const { client, fake, stamp } = await models();
    (fake.config.agents as { defaults: Record<string, unknown> }).defaults.model = {
      primary: "acme/dev-1",
    };
    fake.revision += 1;
    await client.setModelDefaults({ fallbacks: ["acme/dev-2"] }, false, stamp);
    await client.putBackModelDefaults(stamp);
    const sent = fake.gateway.calls("config.patch").at(-1) as {
      raw: string;
      replacePaths: string[];
    };
    expect(JSON.parse(sent.raw)).toEqual({ agents: { defaults: { model: { fallbacks: null } } } });
    expect(sent.replacePaths).toEqual(["agents.defaults.model.fallbacks"]);
  });

  it("refuses a model the gateway doesn't list before anything is sent", async () => {
    const { client, fake, stamp } = await models();
    const before = fake.gateway.calls("config.patch").length;
    await expect(
      client.setModelDefaults({ primary: "acme/not-listed" }, false, stamp),
    ).rejects.toThrow("Choose a model the gateway lists.");
    await expect(client.setModelDefaults({ thinking: "xhigh" }, false, stamp)).rejects.toThrow(
      "The default model doesn't offer that thinking level.",
    );
    expect(fake.gateway.calls("config.patch").length).toBe(before);
  });

  it("a stale version stamp is refused with the gateway's words, and says the change is kept to save", async () => {
    const { client, fake, stamp, accounts } = await models();
    // Another device wrote between this device's read and its write: OpenClaw's own words for a
    // stale `baseHash`, on both versions.
    fake.failPatch = "config changed since last load; re-run config.get and retry";
    await expect(
      client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp),
    ).rejects.toThrow();
    expect(primaryOf(fake)).toBe("acme/dev-1");
    expect(accounts().defaultsChange).toMatchObject({
      status: "failed",
      error: "Changed on another device just now. Your change is still here to save.",
    });
  });

  it("a bad value the gateway refuses is refused whole, with its words, and nothing changes", async () => {
    const { client, fake, stamp, accounts } = await models();
    fake.failPatch =
      'invalid config: agents.defaults.thinkingDefault: Invalid option: expected one of "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"adaptive"|"max"|"ultra"';
    await expect(client.setModelDefaults({ thinking: "high" }, false, stamp)).rejects.toThrow();
    expect(accounts().defaultsChange?.status).toBe("failed");
    expect(accounts().defaultsChange?.error).toContain(
      "invalid config: agents.defaults.thinkingDefault",
    );
    expect(
      (fake.config.agents as { defaults: Record<string, unknown> }).defaults.thinkingDefault,
    ).toBeUndefined();
  });

  it("holds a change for Save and restart when reload is off, and sends nothing until pressed", async () => {
    const fake = withLookup(new AccountsGateway());
    fake.config.gateway = { reload: { mode: "off" } };
    const run = await accountsClient({ gateway: fake });
    const stamp = gatewayStamp(run.client.state.connection);
    await run.client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
    expect(run.accounts().defaultsChange).toMatchObject({ status: "held", restart: true });
    expect(fake.gateway.calls("config.patch")).toHaveLength(0);
  });

  it("holds a change whose reload kind is restart, or can't be read", async () => {
    for (const kinds of [
      { ...HOT, "agents.defaults.model": "restart" },
      { "agents.defaults.thinkingDefault": "hot" },
      { ...HOT, "agents.defaults.model": null },
    ]) {
      const { client, fake, stamp, accounts } = await models(kinds);
      await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
      expect(accounts().defaultsChange?.status).toBe("held");
      expect(fake.gateway.calls("config.patch")).toHaveLength(0);
    }
  });

  it("Save and restart writes, waits through the restart and reads the value back", async () => {
    const fake = withLookup(new AccountsGateway());
    fake.config.gateway = { reload: { mode: "off" } };
    const run = await accountsClient({ gateway: fake });
    const stamp = gatewayStamp(run.client.state.connection);
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      // The gateway answers, then closes every connection to restart (SIGUSR2), as both versions did.
      setTimeout(() => fake.gateway.dropAll(), 5);
      return answer;
    };
    await run.client.setModelDefaults({ primary: "acme/dev-2" }, true, stamp);
    expect(run.accounts().defaultsChange).toMatchObject({ status: "saved", restart: true });
    expect(primaryOf(fake)).toBe("acme/dev-2");
  });

  it("through a restart, the read-back waits while the gateway isn't named yet, then reads it back", async () => {
    const fake = withLookup(new AccountsGateway());
    fake.config.gateway = { reload: { mode: "off" } };
    const run = await accountsClient({ gateway: fake });
    const stamp = gatewayStamp(run.client.state.connection);
    const patch = fake.gateway.handlers["config.patch"]!;
    const get = fake.gateway.handlers["config.get"]!;
    let restarted = false;
    let name: (answer: unknown) => void = () => {};
    let namedAt: number | null = null;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      const applied = fake.revision - 1;
      // Not applied until the restart: the read-back can't end before the connection drops.
      fake.gateway.handlers["config.get"] = (p) => {
        return {
          ...(get(p) as object),
          ...(restarted ? {} : { appliedConfigHash: `r${applied}` }),
        };
      };
      // The gateway comes back slow to name itself: its identity is held past several polls.
      fake.identityReply = new Promise((done) => (name = done));
      setTimeout(() => {
        restarted = true;
        fake.gateway.dropAll();
        setTimeout(() => {
          namedAt = Date.now();
          fake.identityReply = null;
          name({ deviceId: "gateway-a" });
        }, 1_500);
      }, 5);
      return answer;
    };
    await run.client.setModelDefaults({ primary: "acme/dev-2" }, true, stamp);
    expect(namedAt).not.toBeNull();
    expect(run.accounts().defaultsChange).toMatchObject({ status: "saved", restart: true });
    expect(run.client.state.connection.gatewayId).toBe("gateway-a");
  }, 15_000);

  it("with reload off, a gateway that saves without restarting leaves it saved, not applied", async () => {
    const fake = withLookup(new AccountsGateway());
    fake.config.gateway = { reload: { mode: "off" } };
    const run = await accountsClient({ gateway: fake });
    // A short wait instead of the 60 seconds a restart is given.
    (
      run.client as unknown as { accounts: { ctx: { restartWaitMs?: number } } }
    ).accounts.ctx.restartWaitMs = 50;
    const stamp = gatewayStamp(run.client.state.connection);
    const get = fake.gateway.handlers["config.get"]!;
    const applied = fake.revision;
    // 2026.11.10: "config reload disabled (gateway.reload.mode=off)"; the revision stays unapplied.
    fake.gateway.handlers["config.get"] = (params) => ({
      ...(get(params) as object),
      appliedConfigHash: `r${applied}`,
    });
    await run.client.setModelDefaults({ primary: "acme/dev-2" }, true, stamp);
    expect(run.accounts().defaultsChange?.status).toBe("notApplied");
  });

  it("a read-back holding another value is said as another device's change, with no Put back", async () => {
    const { client, fake, stamp, accounts } = await models();
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      // Another device's write lands before this device reads back.
      (fake.config.agents as { defaults: Record<string, unknown> }).defaults.model = {
        primary: "acme/dev-1@acme:work",
      };
      fake.revision += 1;
      return answer;
    };
    await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
    expect(accounts().defaultsChange).toMatchObject({
      status: "changedSince",
      current: { primary: "acme/dev-1@acme:work" },
    });
    await expect(client.putBackModelDefaults(stamp)).rejects.toThrow(
      "There is nothing to put back.",
    );
  });

  it("Put back writes the earlier value while the setting still holds the one written", async () => {
    const { client, fake, stamp, accounts } = await models();
    await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
    await client.putBackModelDefaults(stamp);
    expect(primaryOf(fake)).toBe("acme/dev-1");
    expect(accounts().defaultsChange).toMatchObject({
      status: "saved",
      putBack: true,
      after: { primary: "acme/dev-1" },
    });
  });

  it("Put back is withheld after any other write changed the setting, and nothing is sent", async () => {
    const { client, fake, stamp, accounts } = await models();
    await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
    (fake.config.agents as { defaults: Record<string, unknown> }).defaults.model = {
      primary: "acme/dev-1@acme:home",
    };
    fake.revision += 1;
    const sent = fake.gateway.calls("config.patch").length;
    await client.putBackModelDefaults(stamp);
    expect(fake.gateway.calls("config.patch").length).toBe(sent);
    expect(accounts().defaultsChange).toMatchObject({
      status: "changedSince",
      current: { primary: "acme/dev-1@acme:home" },
    });
  });

  it("Put back checks the read whose hash it sends, so a write just after that read isn't overwritten", async () => {
    const { client, fake, stamp, accounts } = await models();
    await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
    const get = fake.gateway.handlers["config.get"]!;
    let reads = 0;
    fake.gateway.handlers["config.get"] = (params) => {
      const answer = get(params);
      // Another device writes just after Put back's read is answered.
      if ((reads += 1) === 1) {
        (fake.config.agents as { defaults: Record<string, unknown> }).defaults.model = {
          primary: "acme/dev-1@acme:home",
        };
        fake.revision += 1;
      }
      return answer;
    };
    await expect(client.putBackModelDefaults(stamp)).rejects.toThrow();
    expect(primaryOf(fake)).toBe("acme/dev-1@acme:home");
    expect(accounts().defaultsChange).toMatchObject({
      status: "failed",
      error: "Changed on another device just now. Your change is still here to save.",
    });
  });

  it("a read-back still running when another gateway is here publishes nothing to it", async () => {
    const { client, fake, stamp, accounts } = await models();
    const engine = (
      client as unknown as {
        accounts: { reset(): void; ctx: { update(f: (a: object) => object): void } };
      }
    ).accounts;
    const patch = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = (params) => {
      const answer = patch(params);
      // The written gateway is retired before the change is read back: what the next one shows
      // is its own.
      engine.reset();
      engine.ctx.update((a) => ({ ...a, defaultsChange: null }));
      return answer;
    };
    await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
    expect(accounts().defaultsChange).toBeNull();
    expect(accounts().defaults?.primary).toBe("acme/dev-1");
  });

  it("a subscriber that stops the client when the read-back lands sees the whole change, and nothing follows", async () => {
    const { client, stamp, accounts } = await models();
    let atStop: unknown;
    let stopped = false;
    const unsubscribe = client.store.subscribe((state) => {
      if (stopped || state.accounts.defaults?.primary !== "acme/dev-2") return;
      // A new target without a reset of the accounts: the change is no longer this screen's.
      stopped = true;
      atStop = state.accounts.defaultsChange;
      client.stop();
    });
    await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp);
    unsubscribe();
    expect(stopped).toBe(true);
    // The defaults and the change record land in one update; after the stop, nothing more.
    expect(atStop).toMatchObject({ status: "saved", after: { primary: "acme/dev-2" } });
    expect(accounts().defaultsChange).toBe(atStop);
  });

  it("a change whose client stopped while it was saving publishes nothing more", async () => {
    const { client, stamp, accounts } = await models();
    let atStop: unknown;
    let stopped = false;
    const unsubscribe = client.store.subscribe((state) => {
      if (stopped || state.accounts.defaultsChange?.status !== "saving") return;
      stopped = true;
      atStop = state.accounts.defaultsChange;
      client.stop();
    });
    await client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp).catch(() => {});
    unsubscribe();
    expect(stopped).toBe(true);
    expect(accounts().defaultsChange).toBe(atStop);
  });

  it("refuses an account one bot keeps as every bot's model or backup, before anything is sent", async () => {
    const { client, fake, stamp } = await models();
    const engine = (
      client as unknown as {
        accounts: {
          ctx: {
            update(f: (a: { accounts: Array<{ id: string }> }) => object): void;
          };
        };
      }
    ).accounts;
    engine.ctx.update((a) => ({
      ...a,
      accounts: a.accounts.map((each) =>
        each.id === "acme:home" ? { ...each, keptBy: "juniper" } : each,
      ),
    }));
    const before = fake.gateway.calls("config.patch").length;
    for (const values of [
      { primary: "acme/dev-2@acme:home" },
      { fallbacks: ["acme/dev-2@acme:home"] },
    ])
      await expect(client.setModelDefaults(values, false, stamp)).rejects.toThrow(
        "That account is one bot's own, so the other bots can't use it.",
      );
    expect(fake.gateway.calls("config.patch").length).toBe(before);
  });

  it("a change from a connection without admin is refused before anything is read or sent", async () => {
    const fake = withLookup(new AccountsGateway());
    const run = await accountsClient({
      gateway: fake,
      scopes: ["operator.read", "operator.write"],
    });
    const stamp = gatewayStamp(run.client.state.connection);
    await expect(
      run.client.setModelDefaults({ primary: "acme/dev-2" }, false, stamp),
    ).rejects.toThrow("Changing the default model needs admin access.");
    expect(fake.gateway.calls("config.patch")).toHaveLength(0);
  });

  it("the bridge takes only the three settings, as model references or levels", () => {
    const stamp = { gatewayId: "gateway-a", target: 1 };
    expect(
      parseBridgeCommand({
        type: "setModelDefaults",
        values: { primary: "acme/dev-2@acme:work", fallbacks: [], thinking: "low" },
        restart: true,
        stamp,
      }),
    ).toEqual({
      type: "setModelDefaults",
      values: { primary: "acme/dev-2@acme:work", fallbacks: [], thinking: "low" },
      restart: true,
      stamp,
    });
    for (const values of [
      {},
      { workspace: "/x" },
      { primary: "no-slash" },
      { fallbacks: "acme/dev-2" },
    ])
      expect(() =>
        parseBridgeCommand({ type: "setModelDefaults", values, restart: false, stamp }),
      ).toThrow();
  });
});
