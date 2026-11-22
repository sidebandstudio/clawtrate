// Changing a bot's picture (bots.md section 8): `agents.update` with the
// picture, saved only once the gateway's bot list shows it, and only on admin.

import { describe, expect, it } from "vitest";
import { createBridgeSession } from "../src/bridge.ts";
import { avatarFor, pictureWithChoice } from "../src/avatar.ts";
import { INTERACTIVE_SCOPES } from "../src/scopes.ts";
import { AccountsGateway, accountsClient } from "./accounts-fake.ts";
import { deferred, until } from "./fake-gateway.ts";

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
