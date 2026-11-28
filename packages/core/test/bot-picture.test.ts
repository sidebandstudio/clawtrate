// Changing a bot's picture (bots.md section 8): `agents.update` with the
// picture, saved only once the gateway's bot list shows it, and only on admin.

import { describe, expect, it, onTestFinished } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { gatewayStamp } from "../src/types.ts";
import { avatarFor, pictureWithChoice } from "../src/avatar.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { GatewayError, deferred, tokenKey, until } from "./fake-gateway.ts";
import { stampOn, URL_A, URL_B } from "./client-harness.ts";
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
        stamp: stampOn("gateway-a", client),
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
        stamp: stampOn("gateway-b", client),
      }),
    ).rejects.toThrow("made for another gateway");
    expect(fake.gateway.calls("agents.update")).toEqual([]);
    client.stop();
  });

  it("refuses a missing gateway identity on either side, never matching two missing ones", async () => {
    // The dialog was opened before the gateway said which gateway it is.
    const named = await accountsClient();
    await expect(
      named.client.setBotPicture("otto", PICTURE, stampOn(null, named.client)),
    ).rejects.toThrow("hasn't said which gateway it is");
    named.client.stop();
    // A gateway that names none, with a dialog that has no identity either.
    const fake = new AccountsGateway();
    fake.identity = "";
    const unnamed = await accountsClient({ gateway: fake });
    await expect(
      unnamed.client.setBotPicture("otto", PICTURE, stampOn(null, unnamed.client)),
    ).rejects.toThrow("hasn't said which gateway it is");
    // Named none is told apart from named another: what this gateway is isn't known (#782).
    await expect(
      unnamed.client.setBotPicture("otto", PICTURE, stampOn("gateway-a", unnamed.client)),
    ).rejects.toThrow("couldn't confirm which gateway this is");
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
    const picture = outcome(client.setBotPicture("otto", PICTURE, stampOn("gateway-a", client)));
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
        stampOn("gateway-a", client),
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
    await expect(viewer.apply({ ...command, stamp: stampOn("gateway-b", client) })).rejects.toThrow(
      "made for another gateway",
    );
    expect(fake.gateway.calls("agents.create")).toEqual([]);
    expect((await viewer.apply({ ...command, stamp: stampOn("gateway-a", client) })).botId).toBe(
      "viral",
    );
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
    "agents.files.set",
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
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
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
        stamp: stampOn("gateway-b", client),
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
      stamp: stampOn("gateway-a", client),
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
      stamp: stampOn("gateway-a", client),
    });
    await until(() => fake.gateway.calls("agents.create").length === 1);
    await expect(
      createBridgeSession(client).apply({
        type: "createBot",
        ...input,
        name: "Other",
        stamp: stampOn("gateway-a", client),
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
      stamp: stampOn("gateway-a", client),
    });
    await until(() => fake.gateway.calls("agents.create").length === 1);
    // Another session's save starts and finishes while the Create is out.
    expect(
      await createBridgeSession(client).apply({
        type: "setBotPicture",
        botId: "otto",
        avatar: PICTURE,
        stamp: stampOn("gateway-a", client),
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
        stamp: stampOn("gateway-a", client),
      }),
    ).toEqual({ confirmed: true });
    client.stop();
  });

  it("retired by a reset, leaves a Create begun since alone: its plan, its state and its writes", async () => {
    const { client, fake } = await accountsClient();
    const releaseFirst = holdCreate(fake);
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
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
      stamp: stampOn("gateway-a", client),
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
      const first = client.createBot(input, stampOn("gateway-a", client));
      await until(() => fake.gateway.calls("agents.create").length === 1);
      resetCreation(client);
      fake.gateway.handlers["agents.create"] = create;

      const save = fake.gateway.handlers["users.prefs.set"]!;
      fake.gateway.handlers["users.prefs.set"] = () => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
      };
      expect(
        await client.createBot({ ...input, name: "Bee" }, stampOn("gateway-a", client)),
      ).toEqual({
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
    const answer = deferred<void>();
    onTestFinished(() => {
      fake.gateway.handlers["agents.create"] = original;
      refuse.resolve();
      answer.resolve();
      client.stop();
    });
    fake.gateway.handlers["agents.create"] = () =>
      refuse.promise.then(() => {
        throw new GatewayError({ code: "INVALID_REQUEST", message: "no" });
      });
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.create").length === 1);
    resetCreation(client);
    fake.gateway.handlers["agents.create"] = (params) => {
      const made = original(params);
      return answer.promise.then(() => made);
    };
    const second = createBridgeSession(client)
      .apply({ type: "createBot", ...input, name: "Bee", stamp: stampOn("gateway-a", client) })
      .catch((error: Error) => error);
    await until(() => fake.gateway.calls("agents.create").length === 2);
    refuse.resolve();
    expect(await first).toMatch("gateway changed");
    // The Create begun since keeps its timer: it is said to be slow when it is.
    await until(() => client.state.accounts.creation?.slow === true, SLOW_CREATE_MS + 2_000);
    expect(client.state.accounts.creation).toMatchObject({ name: "Bee", status: "creating" });
    answer.resolve();
    expect(await second).toEqual({ botId: "bee", missing: [] });
  }, 15_000);

  /** Start Create A and hold its last step, the first task, until its connection drops. */
  async function heldAtTask(
    client: Awaited<ReturnType<typeof accountsClient>>["client"],
    fake: AccountsGateway,
  ) {
    const original = fake.gateway.handlers["sessions.create"]!;
    fake.gateway.handlers["sessions.create"] = () => new Promise(() => {});
    const created = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
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
        stamp: stampOn("gateway-b", client),
      }),
    ).toEqual({ botId: "bee", missing: [] });
    expect(fake.gateway.calls("agents.create").slice(forB)).toEqual([
      expect.objectContaining({ name: "Bee" }),
    ]);
    client.stop();
  });

  it("publishes a recovered gateway identity before either viewer can start a Create", async () => {
    const fake = new AccountsGateway();
    fake.identity = "";
    const { client } = await accountsClient({ gateway: fake });
    const release = holdCreate(fake);
    let first: Promise<unknown> | undefined;
    try {
      expect(client.state.connection.gatewayId).toBeNull();
      fake.identity = "gateway-a";
      const command = {
        type: "createBot",
        ...input,
        stamp: stampOn(fake.identity, client),
      } as const;
      first = createBridgeSession(client).apply(command);
      await until(() => fake.gateway.calls("agents.create").length === 1);
      expect(client.state.connection.gatewayId).toBe(fake.identity);
      expect(client.state.accounts.creation?.status).toBe("creating");
      await expect(createBridgeSession(client).apply(command)).rejects.toThrow(
        "already being created",
      );
      release();
      await expect(first).resolves.toEqual({ botId: "viral", missing: [] });
      expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    } finally {
      release();
      try {
        await first;
      } finally {
        client.stop();
      }
    }
  });

  it("retires the first gateway's partial when a later identity read identifies its replacement", async () => {
    const { client, fake } = await accountsClient();
    try {
      const { created } = await heldAtTask(client, fake);
      fake.identity = "";
      await reconnected(client, fake);
      await created;
      await until(() => client.state.discovery.status === "ready");
      expect(client.state.connection.gatewayId).toBeNull();
      expect(client.state.accounts.creation).toMatchObject({ status: "partial", botId: "viral" });

      // A delayed Finish from the original dialog prompts a fresh identity read.
      fake.identity = "gateway-b";
      const viewer = createBridgeSession(client);
      const from = requested(fake);
      await expect(
        viewer.apply({ type: "finishBot", botId: "viral", stamp: stampOn("gateway-a", client) }),
      ).rejects.toThrow("another gateway");
      expect(client.state.connection.gatewayId).toBe("gateway-b");
      expect(client.state.accounts.creation).toBeNull();
      await expect(
        viewer.apply({ type: "finishBot", botId: "viral", stamp: stampOn("gateway-b", client) }),
      ).rejects.toThrow("nothing left to finish");
      expect(sentSince(fake, from)).toEqual([]);
    } finally {
      client.stop();
    }
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
      createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-a", client),
      }),
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
    // Asked without naming a gateway, as a caller inside the host may: the creation's is used.
    const finished = client.finishBot("viral").then(
      () => "finished",
      (error: Error) => error.message,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    identity.resolve({ deviceId: "gateway-b" });
    expect(await finished).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    client.stop();
  });

  it("concurrent host callers finish the first task only once while the returning gateway is being identified", async () => {
    const { client, fake } = await accountsClient();
    const identity = deferred<unknown>();
    try {
      const { created } = await heldAtTask(client, fake);
      fake.identityReply = identity.promise;
      await reconnected(client, fake);
      await created;
      expect(client.state.connection.gatewayId).toBeNull();
      expect(client.state.accounts.creation).toMatchObject({
        status: "partial",
        missing: ["task"],
      });
      const before = fake.gateway.calls("sessions.create").length;
      // Without naming a gateway, as a caller inside the host may: New bot's Finish names it,
      // and the host's check of it holds both until the gateway is known.
      const one = client.finishBot("viral");
      const two = client.finishBot("viral");
      const results = Promise.allSettled([one, two]);
      identity.resolve({ deviceId: "gateway-a" });
      const outcomes = await results;
      expect(fake.gateway.calls("sessions.create").length - before).toBe(1);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
      expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
    } finally {
      identity.resolve({ deviceId: "gateway-a" });
      client.stop();
    }
  });

  it("keeps A's partial across a reconnect to A itself, and its Finish completes it", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtTask(client, fake);
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-a");
    expect(await created).toEqual({ botId: "viral", missing: ["task"] });
    expect(client.state.accounts.creation).toMatchObject({ status: "partial", botId: "viral" });
    expect(
      await createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-a", client),
      }),
    ).toEqual({ botId: "viral", missing: [] });
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
    client.stop();
  });

  it("never runs A's Finish, delivered late, on B's own unfinished bot of the same id", async () => {
    const { client, fake } = await accountsClient();
    fake.identity = "gateway-b";
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-b");
    // On B, a bot of the same id is left unfinished: its first task was not made.
    const original = fake.gateway.handlers["sessions.create"]!;
    fake.gateway.handlers["sessions.create"] = () => {
      throw new GatewayError({ code: "UNAVAILABLE", message: "busy" });
    };
    expect(
      await createBridgeSession(client).apply({
        type: "createBot",
        ...input,
        stamp: stampOn("gateway-b", client),
      }),
    ).toEqual({ botId: "viral", missing: ["task"] });
    fake.gateway.handlers["sessions.create"] = original;
    const from = requested(fake);
    // A Finish from a New bot opened on A, delivered only now.
    await expect(
      createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-a", client),
      }),
    ).rejects.toThrow("made for another gateway");
    expect(sentSince(fake, from)).toEqual([]);
    expect(client.state.accounts.creation).toMatchObject({ status: "partial", botId: "viral" });
    // B's own Finish finishes it.
    expect(
      await createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-b", client),
      }),
    ).toEqual({ botId: "viral", missing: [] });
    client.stop();
  });

  /** Start Create A and hold its first-run step's first read, the first request after the bot is made. */
  async function heldAtFirstRun(
    client: Awaited<ReturnType<typeof accountsClient>>["client"],
    fake: AccountsGateway,
  ) {
    const original = fake.gateway.handlers["agents.files.get"]!;
    const reply = deferred<void>();
    onTestFinished(() => {
      fake.gateway.handlers["agents.files.get"] = original;
      reply.resolve();
      client.stop();
    });
    fake.gateway.handlers["agents.files.get"] = (params) =>
      reply.promise.then(() => original(params));
    const created = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
      .then(
        (result) => result,
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.files.get").length === 1);
    fake.gateway.handlers["agents.files.get"] = original;
    return { created, release: () => reply.resolve() };
  }

  it("sends nothing to another gateway that replaced it during the first-run step, and keeps nothing", async () => {
    const { client, fake } = await accountsClient();
    const { created, release } = await heldAtFirstRun(client, fake);
    fake.identity = "gateway-b";
    const from = requested(fake);
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-b");
    release();
    expect(await created).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    expect(fake.gateway.calls("agents.files.set")).toEqual([]);
    expect(client.state.accounts.creation).toBeNull();
    // A's Finish, delivered late, is never run on B.
    await expect(
      createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-a", client),
      }),
    ).rejects.toThrow();
    expect(fake.gateway.calls("agents.files.set")).toEqual([]);
  });

  it("keeps A's made bot with its first run still to end when A drops during that step, and A back ends it", async () => {
    const { client, fake } = await accountsClient();
    const { created, release } = await heldAtFirstRun(client, fake);
    const from = requested(fake);
    await reconnected(client, fake);
    release();
    expect(await created).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    await until(() => client.state.connection.gatewayId === "gateway-a");
    expect(client.state.accounts.creation).toMatchObject({
      status: "partial",
      botId: "viral",
      missing: ["identity", "preference", "fallbacks", "listed", "task"],
    });
    expect(
      await createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-a", client),
      }),
    ).toEqual({ botId: "viral", missing: [] });
    expect(fake.gateway.calls("agents.files.set")).toEqual([
      expect.objectContaining({ agentId: "viral", name: "IDENTITY.md" }),
    ]);
    expect(fake.files.get("viral")!.get("IDENTITY.md")).toMatch(/^- \*\*Name:\*\* Viral$/m);
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
  });

  /** Start Create A and hold its record of the account, a write after the bot is made. */
  async function heldAtPreference(
    client: Awaited<ReturnType<typeof accountsClient>>["client"],
    fake: AccountsGateway,
  ) {
    const original = fake.gateway.handlers["users.prefs.set"]!;
    const reply = deferred<void>();
    onTestFinished(() => {
      fake.gateway.handlers["users.prefs.set"] = original;
      reply.resolve();
      client.stop();
    });
    fake.gateway.handlers["users.prefs.set"] = () => reply.promise;
    const created = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
      .then(
        (result) => result,
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("users.prefs.set").length === 1);
    fake.gateway.handlers["users.prefs.set"] = original;
    // Wrapped, so awaiting the start doesn't wait for the Create.
    return { created };
  }

  it("keeps A's made bot when A drops during its record of the account, and A back finishes only what is left", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtPreference(client, fake);
    // A drops after answering agents.create; while it is away no gateway says who it is.
    const from = requested(fake);
    await reconnected(client, fake);
    expect(await created).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    // A says who it is again: the bot it made is kept, unfinished, with what is left.
    await until(() => client.state.connection.gatewayId === "gateway-a");
    expect(client.state.accounts.creation).toMatchObject({
      status: "partial",
      botId: "viral",
      missing: ["preference", "fallbacks", "listed", "task"],
    });
    expect(client.state.accounts.creation).toMatchObject({ status: "partial", botId: "viral" });
    const creates = fake.gateway.calls("agents.create").length;
    expect(
      await createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-a", client),
      }),
    ).toEqual({ botId: "viral", missing: [] });
    expect(fake.gateway.calls("agents.create")).toHaveLength(creates);
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "viral" });
  });

  it("drops A's made bot once another gateway says who it is, after none had", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtPreference(client, fake);
    fake.identity = "";
    const from = requested(fake);
    await reconnected(client, fake);
    await created;
    expect(client.state.accounts.creation).toMatchObject({ status: "partial", botId: "viral" });
    fake.identity = "gateway-b";
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-b");
    expect(client.state.accounts.creation).toBeNull();
    expect(sentSince(fake, from)).toEqual([]);
  });

  it("sends nothing more, and keeps nothing, when its record of the account is cut off by another gateway", async () => {
    const { client, fake } = await accountsClient();
    const { created } = await heldAtPreference(client, fake);
    fake.identity = "gateway-b";
    const from = requested(fake);
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-b");
    expect(await created).toMatch("gateway changed");
    expect(sentSince(fake, from)).toEqual([]);
    expect(client.state.accounts.creation).toBeNull();
  });

  for (const [caller, outcome] of [
    ["bridge", "refused"],
    ["bridge", "answered"],
    ["host", "refused"],
  ] as const)
    it(`a ${caller} Create retired by a reset leaves the newer Create and timer alone when its last task is ${outcome}`, async () => {
      const { client, fake } = await accountsClient();
      const original = fake.gateway.handlers["sessions.create"]!;
      const made = fake.gateway.handlers["agents.create"]!;
      const task = deferred<void>();
      const answer = deferred<void>();
      onTestFinished(() => {
        fake.gateway.handlers["sessions.create"] = original;
        fake.gateway.handlers["agents.create"] = made;
        task.resolve();
        answer.resolve();
        client.stop();
      });
      fake.gateway.handlers["sessions.create"] = (params) =>
        task.promise.then(() => {
          if (outcome === "refused") throw new GatewayError({ code: "UNAVAILABLE", message: "no" });
          return original(params);
        });
      const creating =
        caller === "host"
          ? client.createBot(input)
          : createBridgeSession(client).apply({
              type: "createBot",
              ...input,
              stamp: stampOn("gateway-a", client),
            });
      const first = creating.then(
        () => "settled",
        (error: Error) => error.message,
      );
      await until(() => fake.gateway.calls("sessions.create").length === 1);
      resetCreation(client);
      fake.gateway.handlers["agents.create"] = (params) => answer.promise.then(() => made(params));
      const second = createBridgeSession(client)
        .apply({
          type: "createBot",
          ...input,
          name: "Bee",
          stamp: stampOn("gateway-a", client),
        })
        .catch((error: Error) => error);
      await until(() => fake.gateway.calls("agents.create").length === 2);
      task.resolve();
      await first;
      expect(client.state.accounts.creation).toMatchObject({ name: "Bee", status: "creating" });
      // The Create begun since keeps its timer: it is said to be slow when it is.
      await until(() => client.state.accounts.creation?.slow === true, SLOW_CREATE_MS + 2_000);
      fake.gateway.handlers["sessions.create"] = original;
      answer.resolve();
      expect(await second).toEqual({ botId: "bee", missing: [] });
    }, 15_000);

  it("keeps a Create whose answer was lost until A says who it is again: Create again finds it, never makes a second", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    onTestFinished(release);
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.create").length === 1);
    // The answer is lost with the connection, and A comes back without saying who it is.
    fake.identity = "";
    await reconnected(client, fake);
    expect(await first).toMatch("gateway changed");
    expect(client.state.accounts.creation).toMatchObject({
      name: "Viral",
      status: "failed",
      uncertain: true,
    });
    fake.identity = "gateway-a";
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-a");
    expect(client.state.accounts.creation).toMatchObject({ status: "failed", uncertain: true });
    // Create again looks first, against the list of bots from before the first Create.
    expect(
      await createBridgeSession(client).apply({
        type: "createBot",
        ...input,
        stamp: stampOn("gateway-a", client),
      }),
    ).toEqual({ botId: "viral", missing: [] });
    expect(fake.gateway.calls("agents.create")).toHaveLength(1);
    client.stop();
  });

  it("drops a Create in doubt once another gateway says who it is", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    onTestFinished(release);
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("agents.create").length === 1);
    fake.identity = "";
    await reconnected(client, fake);
    await first;
    expect(client.state.accounts.creation).toMatchObject({ status: "failed", uncertain: true });
    const from = requested(fake);
    fake.identity = "gateway-b";
    await reconnected(client, fake);
    await until(() => client.state.connection.gatewayId === "gateway-b");
    expect(client.state.accounts.creation).toBeNull();
    expect(sentSince(fake, from)).toEqual([]);
    client.stop();
  });

  it("leaves a fallback write cut off by a switch of gateway off the next gateway's bots, and a Create there shows its own", async () => {
    const { client, fake, storage } = await accountsClient();
    const original = fake.gateway.handlers["config.patch"]!;
    fake.gateway.handlers["config.patch"] = () => new Promise(() => {});
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
      .then(
        () => "created",
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("config.patch").length === 1);
    fake.gateway.handlers["config.patch"] = original;
    // The person switches to another gateway, whose own bot "viral" has its fallback list.
    fake.identity = "gateway-b";
    storage.data.set(tokenKey(URL_B), storage.data.get(tokenKey(URL_A))!);
    await client.connect({ url: URL_B });
    await until(() => client.state.connection.gatewayId === "gateway-b");
    await first;
    const entries = (fake.config.agents as { entries: Record<string, { model?: unknown }> })
      .entries;
    entries.viral = { ...entries.viral, model: { primary: "acme/dev-1@acme:home", fallbacks: [] } };
    await client.refreshAccounts();
    expect(
      client.state.accounts.bindings.find((each) => each.botId === "viral")?.fallbacksUnwritten,
    ).toBe(false);
    // A Create on that gateway, from a screen read since the switch, shows its own state.
    expect(
      await createBridgeSession(client).apply({
        type: "createBot",
        ...input,
        name: "Bee",
        stamp: gatewayStamp(client.state.connection),
      }),
    ).toEqual({ botId: "bee", missing: [] });
    expect(client.state.accounts.creation).toMatchObject({ status: "created", botId: "bee" });
    client.stop();
  });

  it("keeps the bot, unfinished, if its last task fails while the connection hasn't said who it is", async () => {
    // Not reached through a dropped socket (its requests fail before the next connection clears the
    // identity); forced here, so a settlement then never strands the Create.
    const { client, fake } = await accountsClient();
    const original = fake.gateway.handlers["sessions.create"]!;
    const task = deferred<void>();
    onTestFinished(() => task.resolve());
    fake.gateway.handlers["sessions.create"] = () =>
      task.promise.then(() => {
        throw new GatewayError({ code: "UNAVAILABLE", message: "no" });
      });
    const store = (
      client as unknown as {
        store: { update(change: (state: typeof client.state) => typeof client.state): void };
      }
    ).store;
    const first = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
      .then(
        (result) => result,
        (error: Error) => error.message,
      );
    await until(() => fake.gateway.calls("sessions.create").length === 1);
    fake.gateway.handlers["sessions.create"] = original;
    store.update((state) => ({
      ...state,
      connection: { ...state.connection, gatewayId: null },
    }));
    task.resolve();
    expect(await first).toEqual({ botId: "viral", missing: ["task"] });
    expect(client.state.accounts.creation).toMatchObject({
      status: "partial",
      botId: "viral",
      missing: ["task"],
    });
    // A says who it is: Finish makes the task.
    store.update((state) => ({
      ...state,
      connection: { ...state.connection, gatewayId: "gateway-a" },
    }));
    expect(
      await createBridgeSession(client).apply({
        type: "finishBot",
        botId: "viral",
        stamp: stampOn("gateway-a", client),
      }),
    ).toEqual({ botId: "viral", missing: [] });
    client.stop();
  });

  it("is retired by a reset: nothing more is sent once the client forgets the gateway", async () => {
    const { client, fake } = await accountsClient();
    const release = holdCreate(fake);
    const created = createBridgeSession(client)
      .apply({ type: "createBot", ...input, stamp: stampOn("gateway-a", client) })
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
