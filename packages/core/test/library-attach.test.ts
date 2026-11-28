import { describe, expect, it } from "vitest";
import { createBridgeSession, parseBridgeCommand } from "../src/bridge.ts";
import type { LibrarySkill } from "../src/library-attach.ts";
import { KEY, openTask, stampOn } from "./client-harness.ts";
import { deferred, GatewayError, until, type FakeGateway } from "./fake-gateway.ts";

// `skills.library.list {sessionKey}` and `skills.library.activate` as OpenClaw 2026.10.6 and
// 2026.11.10 both answer them (#889; the same on both, run on a development gateway of each).
// Ids, revisions and names are made up.
const SKILL_ID = "e65dd9b1-0271-4cd6-a01b-ca53f774a07a";
const SHOWN = "0123456789abcdef".repeat(4);
const EDITED = "fedcba9876543210".repeat(4);
const COMMAND = "s_moon_phas_e65dd9b102714cd6a01b";
const moon: LibrarySkill = { skillId: SKILL_ID, revision: SHOWN, slug: "moon-phase" };
const entry = (revision = SHOWN) => ({
  skillId: SKILL_ID,
  slug: "moon-phase",
  name: COMMAND,
  ownerLabel: "Rowan Example",
  description: "Use when someone asks for the moon's phase.",
  ownerProfileId: "gateway-owner",
  shared: false,
  enabled: true,
  removed: false,
  revision,
});
const pin = (revision = SHOWN) => ({
  skillId: SKILL_ID,
  revision,
  name: COMMAND,
  ownerProfileId: "gateway-owner",
});
const listed = (session: { selections: unknown[]; attachable: unknown[] }) => ({
  entries: [entry()],
  profileId: "gateway-owner",
  session: { sessionKey: KEY, ...session },
});
const activated = (selections: unknown[]) => ({
  sessionKey: KEY,
  selections,
  sessionActivation: "next-turn",
});
const refusal = (code: string, details: Record<string, unknown>, message: string) =>
  new GatewayError({ code, message, details });

/** A task on a gateway that names itself, so a stamp from it holds. */
async function open(prepare: (gateway: FakeGateway) => void = () => {}) {
  const opened = await openTask();
  opened.gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-a" });
  prepare(opened.gateway);
  opened.gateway.dropAll();
  await until(
    () =>
      opened.client.state.connection.status === "connected" &&
      opened.client.state.connection.gatewayId === "gw-a",
  );
  return { ...opened, stamp: stampOn("gw-a", opened.client) };
}
const activations = (gateway: FakeGateway) => gateway.calls("skills.library.activate");

describe("adding a library skill to an open task (#889)", () => {
  it("F-071: reads the task's list, then attaches the revision the menu showed, and says it was added with the command that runs it", async () => {
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () =>
        listed({ selections: [], attachable: [entry()] });
      gateway.handlers["skills.library.activate"] = () => activated([pin()]);
    });
    try {
      expect(await client.attachLibrarySkill(KEY, moon, stamp)).toEqual({
        status: "added",
        command: COMMAND,
        revision: SHOWN,
      });
      expect(gateway.calls("skills.library.list")).toEqual([{ sessionKey: KEY }]);
      expect(activations(gateway)).toEqual([
        { sessionKey: KEY, action: "attach", skillId: SKILL_ID, revision: SHOWN },
      ]);
    } finally {
      client.stop();
    }
  });

  it("F-071: sends nothing when the task already has the skill, the skill is gone, it changed since the list was read, or the list can't be read, and says which", async () => {
    let answer: unknown = null;
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () => {
        if (answer instanceof Error) throw answer;
        return answer;
      };
      gateway.handlers["skills.library.activate"] = () => activated([pin()]);
    });
    try {
      // Another device added it meanwhile, at a later revision: it is used as the task has it.
      answer = listed({ selections: [pin(EDITED)], attachable: [] });
      expect(await client.attachLibrarySkill(KEY, moon, stamp)).toEqual({
        status: "already",
        command: COMMAND,
        revision: EDITED,
      });
      answer = listed({ selections: [], attachable: [] });
      await expect(client.attachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
        "moon-phase is no longer in your library, so it wasn't added.",
      );
      // The gateway would attach the older revision as if it were the latest.
      answer = listed({ selections: [], attachable: [entry(EDITED)] });
      await expect(client.attachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
        "moon-phase changed since this list was read, so it wasn't added. Choose it again.",
      );
      for (const unreadable of [
        refusal("INVALID_REQUEST", { code: "SKILL_LIBRARY_NOT_FOUND" }, "Session not found."),
        { session: { selections: "x" } },
        null,
      ]) {
        answer = unreadable;
        await expect(client.attachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
          "Couldn't read this task's skills, so moon-phase wasn't added. Try again.",
        );
      }
      expect(activations(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("F-071: says a refusal in plain words, never in the gateway's, and a lost or unreadable answer as not known", async () => {
    let refuse: unknown = null;
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () =>
        listed({ selections: [], attachable: [entry()] });
      gateway.handlers["skills.library.activate"] = () => {
        if (refuse) throw refuse;
        return activated([]);
      };
    });
    const cases: Array<[GatewayError, string]> = [
      [
        refusal(
          "FORBIDDEN",
          { code: "MISSING_SCOPE", missingScope: "operator.write" },
          "missing scope: operator.write",
        ),
        "this connection can't change the task's skills.",
      ],
      [
        refusal(
          "INVALID_REQUEST",
          { code: "SKILL_LIBRARY_NOT_FOUND" },
          "Removed skill cannot be selected. Existing pinned selections remain available.",
        ),
        "the gateway couldn't find moon-phase in your library, or this task.",
      ],
      [
        refusal(
          "INVALID_REQUEST",
          { code: "SKILL_LIBRARY_LIMIT" },
          "A session can select at most 64 library skills.",
        ),
        "a task can have at most 64 library skills.",
      ],
      [
        refusal(
          "INVALID_REQUEST",
          { code: "SKILL_LIBRARY_CONFLICT" },
          "Session changed before activation; refresh and retry.",
        ),
        "the task's skills changed at the same moment. Try again.",
      ],
      [
        refusal(
          "INVALID_REQUEST",
          { code: "SKILL_LIBRARY_FORBIDDEN" },
          "Your current Gateway role cannot change skills.",
        ),
        "the gateway doesn't let this connection change the task's skills.",
      ],
      [
        refusal(
          "INVALID_REQUEST",
          { code: "SKILL_LIBRARY_IDENTITY_REQUIRED" },
          "Sign in with a durable Gateway profile to use a personal skill library.",
        ),
        "the gateway no longer knows whose library this connection uses. Reconnect, then try again.",
      ],
      [
        refusal(
          "UNAVAILABLE",
          {},
          "Unable to complete the skill library operation. Review the bundle or retry the request.",
        ),
        "the gateway refused.",
      ],
    ];
    try {
      for (const [error, words] of cases) {
        refuse = error;
        const failed = client.attachLibrarySkill(KEY, moon, stamp);
        await expect(failed).rejects.toThrow(`Couldn't add moon-phase to this task: ${words}`);
        await expect(failed).rejects.not.toThrow(error.message);
      }
      // An answer that doesn't show the skill: what the task has is not known.
      refuse = null;
      await expect(client.attachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
        "It isn't known whether moon-phase was added to this task: the gateway's answer didn't show it. Type / to see.",
      );
      // The answer is lost: the connection drops after the attach was sent.
      const never = deferred<unknown>();
      gateway.handlers["skills.library.activate"] = () => never.promise;
      const lost = client.attachLibrarySkill(KEY, moon, stamp);
      await until(() => activations(gateway).length === cases.length + 2);
      gateway.dropAll();
      await expect(lost).rejects.toThrow(
        "It isn't known whether moon-phase was added to this task: the gateway's answer didn't arrive. Type / to see.",
      );
    } finally {
      client.stop();
    }
  });

  it("F-071: sends nothing on a connection that may not write, for another gateway's menu, or once the connection changed after the list was read", async () => {
    const readOnly = await openTask({ held: ["operator.read"] });
    try {
      await expect(
        readOnly.client.attachLibrarySkill(KEY, moon, stampOn(null, readOnly.client)),
      ).rejects.toThrow("Adding moon-phase to a task needs write access.");
      expect(readOnly.gateway.calls("skills.library.list")).toEqual([]);
    } finally {
      readOnly.client.stop();
    }
    const listing = deferred<unknown>();
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () => listing.promise;
      gateway.handlers["skills.library.activate"] = () => activated([pin()]);
    });
    try {
      await expect(client.attachLibrarySkill(KEY, moon, stampOn("gw-b", client))).rejects.toThrow(
        /another gateway/,
      );
      const adding = client.attachLibrarySkill(KEY, moon, stamp);
      await until(() => gateway.calls("skills.library.list").length === 1);
      gateway.dropAll();
      listing.resolve(listed({ selections: [], attachable: [entry()] }));
      await expect(adding).rejects.toThrow(/nothing was sent|wasn't added/);
      expect(activations(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("F-071: the attach isn't sent once the host's target has moved on while the list was read", async () => {
    const listing = deferred<unknown>();
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () => listing.promise;
      gateway.handlers["skills.library.activate"] = () => activated([pin()]);
    });
    try {
      const adding = client.attachLibrarySkill(KEY, moon, stamp);
      await until(() => gateway.calls("skills.library.list").length === 1);
      // As a new device token in a hello does, on the same live connection (client.ts).
      (client as unknown as { target: number }).target += 1;
      listing.resolve(listed({ selections: [], attachable: [entry()] }));
      await expect(adding).rejects.toThrow("The connection changed, so moon-phase wasn't added.");
      expect(activations(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });

  it("F-071: a viewer's add goes nowhere once the viewer has gone", async () => {
    const listing = deferred<unknown>();
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () => listing.promise;
      gateway.handlers["skills.library.activate"] = () => activated([pin()]);
    });
    try {
      const viewer = createBridgeSession(client);
      await viewer.apply({ type: "openSession", key: KEY });
      const adding = viewer.apply({ type: "attachLibrarySkill", key: KEY, skill: moon, stamp });
      await until(() => gateway.calls("skills.library.list").length === 1);
      viewer.dispose();
      listing.resolve(listed({ selections: [], attachable: [entry()] }));
      await expect(adding).rejects.toThrow();
      expect(activations(gateway)).toEqual([]);
    } finally {
      client.stop();
    }
  });
});

describe("Undo of an added library skill (#889)", () => {
  it("F-071: takes the skill out only while the task still has the revision this device added, and says what happened", async () => {
    let answer: unknown = listed({ selections: [pin()], attachable: [] });
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () => answer;
      gateway.handlers["skills.library.activate"] = () => activated([]);
    });
    try {
      expect(await client.detachLibrarySkill(KEY, moon, stamp)).toEqual({
        undone: true,
        words: "Undone. moon-phase is out of this task.",
      });
      expect(activations(gateway)).toEqual([
        { sessionKey: KEY, action: "detach", skillId: SKILL_ID },
      ]);
      // Taken out elsewhere: the gateway's detach would say the same, so nothing is sent.
      answer = listed({ selections: [], attachable: [entry()] });
      expect(await client.detachLibrarySkill(KEY, moon, stamp)).toEqual({
        undone: false,
        words: "moon-phase is already out of this task.",
      });
      // Changed in the task since (another revision attached): Undo would take out that one.
      answer = listed({ selections: [pin(EDITED)], attachable: [] });
      expect(await client.detachLibrarySkill(KEY, moon, stamp)).toEqual({
        undone: false,
        words: "moon-phase was changed in this task since it was added here, so it was left in.",
      });
      answer = { session: null };
      await expect(client.detachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
        "Couldn't read this task's skills, so nothing was sent. moon-phase may still be in this task.",
      );
      expect(activations(gateway)).toHaveLength(1);
    } finally {
      client.stop();
    }
  });

  it("F-071: says a refusal plainly, an answer that still lists the skill as such, and a lost answer as not known", async () => {
    let reply: () => unknown = () => activated([pin()]);
    const { client, gateway, stamp } = await open((gateway) => {
      gateway.handlers["skills.library.list"] = () =>
        listed({ selections: [pin()], attachable: [] });
      gateway.handlers["skills.library.activate"] = () => reply();
    });
    try {
      await expect(client.detachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
        "The gateway still lists moon-phase in this task.",
      );
      reply = () => {
        throw refusal("INVALID_REQUEST", { code: "SKILL_LIBRARY_CONFLICT" }, "refresh and retry.");
      };
      await expect(client.detachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
        "Couldn't undo: the task's skills changed at the same moment. Try again.",
      );
      reply = () => ({ sessionKey: KEY });
      await expect(client.detachLibrarySkill(KEY, moon, stamp)).rejects.toThrow(
        "It isn't known whether moon-phase was taken out: the gateway's answer didn't show the task's skills. Type / to see.",
      );
      const never = deferred<unknown>();
      reply = () => never.promise;
      const lost = client.detachLibrarySkill(KEY, moon, stamp);
      await until(() => activations(gateway).length === 4);
      gateway.dropAll();
      await expect(lost).rejects.toThrow(
        "It isn't known whether moon-phase was taken out: the gateway's answer didn't arrive. Type / to see.",
      );
    } finally {
      client.stop();
    }
  });
});

describe("the bridge's add and Undo commands (#889)", () => {
  it("F-071: carry only a library entry's id, a revision and a slug of the menu's length", () => {
    const stamp = { gatewayId: "gw-1", target: 3 };
    for (const type of ["attachLibrarySkill", "detachLibrarySkill"] as const) {
      expect(parseBridgeCommand({ type, key: KEY, skill: { ...moon, extra: 1 }, stamp })).toEqual({
        type,
        key: KEY,
        skill: moon,
        stamp,
      });
      for (const skill of [
        { ...moon, skillId: "not-an-id" },
        { ...moon, revision: "abc" },
        { ...moon, slug: " " },
        { ...moon, slug: "m".repeat(121) },
        { skillId: SKILL_ID, revision: SHOWN },
        null,
      ])
        expect(() => parseBridgeCommand({ type, key: KEY, skill, stamp })).toThrow(
          /invalid library skill|library skill/,
        );
      expect(() => parseBridgeCommand({ type, key: KEY, skill: moon })).toThrow();
    }
  });
});
