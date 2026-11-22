// Changing a bot's picture (bots.md section 8): `agents.update` with the
// picture, saved only once the gateway's bot list shows it, and only on admin.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { avatarFor, pictureWithChoice } from "../src/avatar.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { GatewayError, deferred, until } from "./fake-gateway.ts";
import { SLOW_CREATE_MS } from "../src/accounts.ts";

/** A 2×2 PNG carrying a creature choice, as New bot and Edit picture send it. */
const PICTURE = pictureWithChoice(
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC",
  { family: "shellfolk", shell: "turret", color: "pink" },
)!;

describe("F-037: changing a bot's picture", () => {
  it("sends it with agents.update and is saved once the bot list shows it, as the creature chosen", async () => {
    const { client, fake } = await accountsClient();
    const viewer = createBridgeSession(client);
    expect(
      await viewer.apply({
        type: "setBotPicture",
        botId: "otto",
        avatar: PICTURE,
        gatewayId: "gateway-a",
      }),
    ).toEqual({
      confirmed: true,
    });
    expect(fake.gateway.calls("agents.update")).toEqual([{ agentId: "otto", avatar: PICTURE }]);
    const otto = client.state.bots.find((bot) => bot.id === "otto")!;
    expect(otto.avatarUrl).toBe(PICTURE);
    expect(avatarFor(otto)).toEqual({
      kind: "creature",
      choice: { family: "shellfolk", shell: "turret", color: "pink" },
      chosen: true,
    });
    client.stop();
  });

  it("sends nothing when Edit picture was opened on another gateway", async () => {
    const { client, fake } = await accountsClient();
    const viewer = createBridgeSession(client);
    await expect(
      viewer.apply({
        type: "setBotPicture",
        botId: "otto",
        avatar: PICTURE,
        gatewayId: "gateway-b",
      }),
    ).rejects.toThrow("made for another gateway");
    expect(fake.gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("refuses a missing gateway identity on either side, never matching two missing ones", async () => {
    // The dialog was opened before the gateway said which gateway it is.
    const named = await accountsClient();
    await expect(named.client.setBotPicture("otto", PICTURE, null)).rejects.toThrow(
      "hasn't said which gateway it is",
    );
    named.client.stop();
    // A gateway that names none, with a dialog that has no identity either.
    const fake = new AccountsGateway();
    fake.identity = "";
    const unnamed = await accountsClient({ gateway: fake });
    await expect(unnamed.client.setBotPicture("otto", PICTURE, null)).rejects.toThrow(
      "hasn't said which gateway it is",
    );
    await expect(unnamed.client.setBotPicture("otto", PICTURE, "gateway-a")).rejects.toThrow(
      "made for another gateway",
    );
    expect(fake.gateway.calls("agents.update")).toEqual([]);
    unnamed.client.stop();
  });

  it("refuses when the connection is replaced while the gateway's identity is being read", async () => {
    const { client, fake } = await accountsClient();
    const replaced = async () => {
      const was = client.state.connection.connectedAt;
      fake.gateway.dropAll();
      await until(
        () =>
          client.state.connection.status === "connected" &&
          client.state.connection.connectedAt !== was,
      );
    };
    // A new connection whose identity is slow to come.
    const reply = deferred<unknown>();
    fake.identityReply = reply.promise;
    await replaced();
    // Each outcome is caught at once, so neither refusal goes unhandled while the other is awaited.
    const outcome = (pending: Promise<unknown>) =>
      pending.then(
        () => "sent",
        (error: Error) => error.message,
      );
    const picture = outcome(client.setBotPicture("otto", PICTURE, "gateway-a"));
    const created = outcome(
      client.createBot(
        {
          name: "Viral",
          avatar: null,
          account: "acme:home",
          provider: "acme",
          model: "dev-1",
          effort: null,
        },
        "gateway-a",
      ),
    );
    // Replaced again before the identity arrives: the answer belongs to a connection now gone.
    await replaced();
    reply.resolve({ deviceId: "gateway-a" });
    expect(await picture).toMatch("connection changed");
    expect(await created).toMatch("connection changed");
    expect(fake.gateway.calls("agents.update")).toEqual([]);
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    client.stop();
  });

  it("answers unconfirmed, not unsaved, when the gateway took it but the list can't be read", async () => {
    const { client, fake } = await accountsClient();
    fake.failListAfterUpdate = true;
    expect(await client.setBotPicture("otto", PICTURE)).toEqual({ confirmed: false });
    expect(fake.gateway.calls("agents.update")).toHaveLength(1);
    client.stop();
  });

  it("answers unconfirmed when the gateway took it but its bot list does not show the picture", async () => {
    const { client, fake } = await accountsClient();
    fake.keepNoPicture = true;
    expect(await client.setBotPicture("otto", PICTURE)).toEqual({ confirmed: false });
    // In order: the update, then the list read again.
    expect(fake.gateway.calls("agents.update")).toHaveLength(1);
    client.stop();
  });

  it("needs admin, and sends nothing that is not a PNG small enough to keep", async () => {
    const below = await accountsClient({ scopes: INTERACTIVE_SCOPES });
    await expect(below.client.setBotPicture("otto", PICTURE)).rejects.toThrow("needs admin access");
    expect(below.fake.gateway.calls("agents.update")).toEqual([]);
    below.client.stop();
    const { client, fake } = await accountsClient();
    await expect(
      client.setBotPicture("otto", "data:image/svg+xml;base64,PHN2Zy8+"),
    ).rejects.toThrow("can't be kept");
    await expect(
      client.setBotPicture("otto", `data:image/png;base64,${"A".repeat(40_000)}`),
    ).rejects.toThrow();
    // A PNG that is not well formed (bytes after its end) is refused before anything is sent.
    await expect(client.setBotPicture("otto", `${PICTURE.slice(0, -4)}AAAA`)).rejects.toThrow(
      "can't be kept",
    );
    expect(fake.gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("New bot creates nothing when it was opened on another gateway", async () => {
    const { client, fake } = await accountsClient();
    const viewer = createBridgeSession(client);
    const command = {
      type: "createBot",
      name: "Viral",
      avatar: null,
      account: "acme:home",
      provider: "acme",
      model: "dev-1",
      effort: null,
    } as const;
    await expect(viewer.apply({ ...command, gatewayId: "gateway-b" })).rejects.toThrow(
      "made for another gateway",
    );
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    expect((await viewer.apply({ ...command, gatewayId: "gateway-a" })).botId).toBe("viral");
    client.stop();
  });

  it("New bot refuses an explicit picture that is not a well-formed PNG before agents.create", async () => {
    const { client, fake } = await accountsClient();
    const input = {
      name: "Viral",
      account: "acme:home",
      provider: "acme",
      model: "dev-1",
      effort: null,
    };
    await expect(
      client.createBot({ ...input, avatar: "data:image/png;base64,iVBORw0KGgo=" }),
    ).rejects.toThrow("can't be kept");
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    // Null is an untouched picture: the bot is made, and its id chooses its Clawling.
    await client.createBot({ ...input, avatar: null });
    expect(fake.gateway.calls("agents.create")).toEqual([
      { name: "Viral", model: "acme/dev-1@acme:home" },
    ]);
    client.stop();
  });
});

describe("a bot write is bound to its gateway to the end", () => {
  const input = {
    name: "Viral",
    avatar: null,
    account: "acme:home",
    provider: "acme",
    model: "dev-1",
    effort: null,
  } as const;
  /** Hold `agents.create`'s answer: the bot is made at once, the reply waits for `release`. */
  function holdCreate(fake: AccountsGateway) {
    const original = fake.gateway.handlers["agents.create"]!;
    const answer = deferred<void>();
    fake.gateway.handlers["agents.create"] = (params) => {
      const made = original(params);
      return answer.promise.then(() => made);
    };
    return () => answer.resolve();
  }
  function resetCreation(client: Awaited<ReturnType<typeof accountsClient>>["client"]) {
    (client as unknown as { accounts: { reset(): void } }).accounts.reset();
    (
      client as unknown as {
        store: { update(change: (state: typeof client.state) => typeof client.state): void };
      }
    ).store.update((state) => ({ ...state, accounts: { ...state.accounts, creation: null } }));
  }
  const reconnected = async (
    client: Awaited<ReturnType<typeof accountsClient>>["client"],
    fake: AccountsGateway,
  ) => {
    const was = client.state.connection.connectedAt;
    fake.gateway.dropAll();
    await until(
      () =>
        client.state.connection.status === "connected" &&
        client.state.connection.connectedAt !== was,
    );
  };
  const writes = [
    "agents.create",
    "config.patch",
    "users.prefs.set",
    "sessions.create",
    "agents.update",
  ];
  const sentSince = (fake: AccountsGateway, from: number) =>
    (fake.gateway as unknown as { requests: Array<{ method: string }> }).requests
      .slice(from)
      .map((each) => each.method)
      .filter((method) => writes.includes(method));

  it("sends and publishes nothing to another gateway that replaced it mid-way", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    const created = createBridgeSession(client)
      .apply({ type: "createBot", ...input, gatewayId: "gateway-a" })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.create").length === 1);
    // Another gateway answers at the same address.
    fake.identity = "gateway-b";
    const from = (fake.gateway as unknown as { requests: unknown[] }).requests.length;
    await reconnected(client, fake);
    release();
    expect(await created).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    expect(client.state.accounts.creation?.status).not.toBe("created");
    expect(client.state.accounts.creation?.status).not.toBe("partial");
    // Nothing of the retired Create lingers: a new one for the gateway now connected goes through.
    await until(() => client.state.connection.gatewayId === "gateway-b");
    expect(client.state.accounts.creation?.status).not.toBe("checking");
    expect(client.state.accounts.creation?.status).not.toBe("creating");
    const forB = fake.gateway.calls("agents.create").length;
    expect(
      await createBridgeSession(client).apply({
        type: "createBot",
        ...input,
        name: "Bee",
        gatewayId: "gateway-b",
      }),
    ).toEqual({ botId: "bee", missing: [] });
    expect(fake.gateway.calls("agents.create").slice(forB)).toEqual([
      expect.objectContaining({ name: "Bee" }),
    ]);
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "bee" });
    client.stop();
  });

  it("finishes across a reconnect to the same gateway, its identity read and matched again", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    const created = createBridgeSession(client).apply({
      type: "createBot",
      ...input,
      gatewayId: "gateway-a",
    });
    await until(() => fake.gateway.calls("agents.create").length === 1);
    const from = (fake.gateway as unknown as { requests: unknown[] }).requests.length;
    await reconnected(client, fake);
    release();
    expect((await created).botId).toBe("viral");
    expect(sentSince(fake, from)).toContain("config.patch");
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
    client.stop();
  });

  it("isn't disturbed by another session's Create, refused as busy while it is out", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    const created = createBridgeSession(client).apply({
      type: "createBot",
      ...input,
      gatewayId: "gateway-a",
    });
    await until(() => fake.gateway.calls("agents.create").length === 1);
    await expect(
      createBridgeSession(client).apply({
        type: "createBot",
        ...input,
        name: "Other",
        gatewayId: "gateway-a",
      }),
    ).rejects.toThrow("A bot is already being created.");
    release();
    expect(await created).toEqual({ botId: "viral", missing: [] });
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("isn't disturbed by another session's picture saved while it is out, and leaves no guard behind", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    const created = createBridgeSession(client).apply({
      type: "createBot",
      ...input,
      gatewayId: "gateway-a",
    });
    await until(() => fake.gateway.calls("agents.create").length === 1);
    // Another session's save starts and finishes while the Create is out.
    expect(
      await createBridgeSession(client).apply({
        type: "setBotPicture",
        botId: "otto",
        avatar: PICTURE,
        gatewayId: "gateway-a",
      }),
    ).toEqual({ confirmed: true });
    release();
    expect(await created).toEqual({ botId: "viral", missing: [] });
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
    // Both over: a later write on the same gateway goes through as any other.
    expect(
      await createBridgeSession(client).apply({
        type: "setBotPicture",
        botId: "viral",
        avatar: PICTURE,
        gatewayId: "gateway-a",
      }),
    ).toEqual({ confirmed: true });
    client.stop();
  });

  it("retired by a reset, leaves a Create begun since alone: its plan, its state and its writes", async () => {
    const { client, fake } = await accountsClient();
    const releaseFirst = holdCreate(fake);
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, gatewayId: "gateway-a" })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.create").length === 1);
    // The client forgets the gateway, as a switch does, and a new Create begins.
    resetCreation(client);
    const releaseSecond = holdCreate(fake);
    const second = createBridgeSession(client).apply({
      type: "createBot",
      ...input,
      name: "Bee",
      gatewayId: "gateway-a",
    });
    await until(() => fake.gateway.calls("agents.create").length === 2);
    const from = (fake.gateway as unknown as { requests: unknown[] }).requests.length;
    releaseFirst();
    expect(await first).toMatch("gateway changed");
    // The retired Create sent nothing, and the one begun since is still under way.
    expect(sentSince(fake, from)).toEqual([]);
    expect(client.state.accounts.creation).toMatchObject({ name: "Bee", status: "creating" });
    releaseSecond();
    expect(await second).toEqual({ botId: "bee", missing: [] });
    // Its own plan: the record of its account and its model are written for it.
    expect(fake.gateway.calls("users.prefs.set")).toEqual([
      expect.objectContaining({
        entries: expect.objectContaining({ "clawtrate.bot-account.bee": expect.anything() }),
      }),
    ]);
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "bee" });
    client.stop();
  });

  it("keeps a partial Create's account choice when an earlier Create answers after it", async () => {
    const { client, fake } = await accountsClient();
    const create = fake.gateway.handlers["agents.create"]!;
    const releaseFirst = holdCreate(fake);
    try {
      const first = client.createBot(input, "gateway-a");
      await until(() => fake.gateway.calls("agents.create").length === 1);
      resetCreation(client);
      fake.gateway.handlers["agents.create"] = create;

      const save = fake.gateway.handlers["users.prefs.set"]!;
      fake.gateway.handlers["users.prefs.set"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
      };
      expect(await client.createBot({ ...input, name: "Bee" }, "gateway-a")).toEqual({
        botId: "bee",
        missing: ["preference"],
      });
      releaseFirst();
      await expect(first).rejects.toThrow("gateway changed");

      fake.gateway.handlers["users.prefs.set"] = save;
      expect(await client.finishBot("bee")).toEqual({ botId: "bee", missing: [] });
      expect(fake.prefs["clawtrate.bot-account.bee"]).toEqual({
        mode: "account",
        account: input.account,
      });
    } finally {
      releaseFirst();
      client.stop();
    }
  });

  it("retired by a reset and then refused, leaves the slow note of a Create begun since", async () => {
    const { client, fake } = await accountsClient();
    const original = fake.gateway.handlers["agents.create"]!;
    const refuse = deferred<void>();
    fake.gateway.handlers["agents.create"] = () =>
      refuse.promise.then(() => {
        throw new GatewayError({ code: "INVALID_REQUEST", message: "no" });
      });
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, gatewayId: "gateway-a" })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.create").length === 1);
    resetCreation(client);
    const answer = deferred<void>();
    fake.gateway.handlers["agents.create"] = (params) => {
      const made = original(params);
      return answer.promise.then(() => made);
    };
    const second = createBridgeSession(client).apply({
      type: "createBot",
      ...input,
      name: "Bee",
      gatewayId: "gateway-a",
    });
    await until(() => fake.gateway.calls("agents.create").length === 2);
    refuse.resolve();
    expect(await first).toMatch("gateway changed");
    // The Create begun since keeps its timer: it is said to be slow when it is.
    await until(() => client.state.accounts.creation?.slow === true, SLOW_CREATE_MS + 2_000);
    expect(client.state.accounts.creation).toMatchObject({ name: "Bee", status: "creating" });
    answer.resolve();
    expect(await second).toEqual({ botId: "bee", missing: [] });
    client.stop();
  }, 15_000);

  /** Start Create A and hold its last step, the first task, until its connection drops. */
  async function heldAtTask(
    client: Awaited<ReturnType<typeof accountsClient>>["client"],
    fake: AccountsGateway,
  ) {
    const original = fake.gateway.handlers["sessions.create"]!;
    fake.gateway.handlers["sessions.create"] = () => new Promise(() => {});
    const created = createBridgeSession(client)
      .apply({ type: "createBot", ...input, gatewayId: "gateway-a" })
      .then(
        (result) => result,
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("sessions.create").length === 1);
    fake.gateway.handlers["sessions.create"] = original;
    // Wrapped, so awaiting the start doesn't wait for the Create.
    return { created };
  }
  const requested = (fake: AccountsGateway) =>
    (fake.gateway as unknown as { requests: unknown[] }).requests.length;

  it("leaves no partial of A's for the gateway that replaced it: B creates as any gateway would", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtTask(client, fake);
    fake.identity = "gateway-b";
    const from = requested(fake);
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-b");
    await created;
    expect(client.state.accounts.creation).toBeNull();
    expect(sentSince(fake, from)).toEqual([]);
    const forB = fake.gateway.calls("agents.create").length;
    expect(
      await createBridgeSession(client).apply({
        type: "createBot",
        ...input,
        name: "Bee",
        gatewayId: "gateway-b",
      }),
    ).toEqual({ botId: "bee", missing: [] });
    expect(fake.gateway.calls("agents.create").slice(forB)).toEqual([
      expect.objectContaining({ name: "Bee" }),
    ]);
    client.stop();
  });

  it("never runs A's Finish on the gateway that replaced it, once B has said who it is", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtTask(client, fake);
    fake.identity = "gateway-b";
    const from = requested(fake);
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-b");
    await created;
    await expect(
      createBridgeSession(client).apply({ type: "finishBot", botId: "viral" }),
    ).rejects.toThrow();
    expect(sentSince(fake, from)).toEqual([]);
    client.stop();
  });

  it("never runs A's Finish on the gateway that replaced it, while B's identity is still being read", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtTask(client, fake);
    fake.identity = "gateway-b";
    const identity = deferred<unknown>();
    fake.identityReply = identity.promise;
    const from = requested(fake);
    await reconnected(client, fake);
    await created;
    const finished = createBridgeSession(client)
      .apply({ type: "finishBot", botId: "viral" })
      .then(
        () => "finished",
        (error: Error) => error.message,
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    identity.resolve({ deviceId: "gateway-b" });
    expect(await finished).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    client.stop();
  });

  it("keeps A's partial across a reconnect to A itself, and its Finish completes it", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtTask(client, fake);
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-a");
    expect(await created).toEqual({ botId: "viral", missing: ["task"] });
    expect(client.state.accounts.creation).toMatchObject({ status: "partial", botId: "viral" });
    expect(await createBridgeSession(client).apply({ type: "finishBot", botId: "viral" })).toEqual({
      botId: "viral",
      missing: [],
    });
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
    client.stop();
  });

  it("is retired by a reset: nothing more is sent once the client forgets the gateway", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    const created = createBridgeSession(client)
      .apply({ type: "createBot", ...input, gatewayId: "gateway-a" })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.create").length === 1);
    const from = (fake.gateway as unknown as { requests: unknown[] }).requests.length;
    (client as unknown as { accounts: { reset(): void } }).accounts.reset();
    release();
    expect(await created).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    client.stop();
  });
});
