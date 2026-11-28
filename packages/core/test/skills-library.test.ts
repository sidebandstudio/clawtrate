// Gateway skill library: trust-boundary validation, preview bounds, importing SKILL.md via
// `skills.library.save`, conflict and refusal wording, gateway-identity binding, bridge file
// handoff, and refreshing a task's pinned skill revisions (`skills.library.activate`).

import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  ClawtrateClient,
  createBridgeSession,
  decodeUtf8Strict,
  deriveSkillSlug,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_PREVIEW_NAME_CHARS,
  MAX_SKILL_PREVIEW_CHARS,
  parseBridgeCommand,
  parseSkillMarkdown,
  skillSlugProblem,
  toBase64,
  utf8Bytes,
} from "../src/index.ts";
import { KEY, openTask, stampOn } from "./client-harness.ts";
import {
  FakeGateway,
  GatewayError,
  helloOk,
  memoryStorage,
  testHost,
  tokenKey,
  until,
} from "./fake-gateway.ts";

const URL = "ws://127.0.0.1:19001";
const FAST = { reconnect: { initialMs: 20, maxMs: 40 } };
const WRITE = ["operator.read", "operator.write"];
const READ = ["operator.read"];
const REV_A = "a".repeat(64);
const SKILL_ID = "11111111-2222-3333-4444-555555555555";

const VALID_SKILL = [
  "---",
  "name: Deploy Checklist",
  "description: Use when checking release readiness before a deploy.",
  "---",
  "",
  "# Deploy Checklist",
  "",
  "1. Run the test suite.",
  "2. Check the logs for errors.",
  "",
].join("\n");

function entry(overrides: Record<string, unknown> = {}) {
  return {
    skillId: SKILL_ID,
    slug: "deploy-checklist",
    name: "s_deploy_ch_11111111222233334444",
    ownerLabel: "Rowan Example",
    description: "Use when checking release readiness before a deploy.",
    ownerProfileId: "gateway-owner",
    authorProfileId: "gateway-owner",
    shared: false,
    enabled: true,
    removed: false,
    revision: REV_A,
    createdAt: 1795853161707,
    updatedAt: 1795853161707,
    canEdit: true,
    ...overrides,
  };
}

async function connected(
  scopes: string[] = WRITE,
  options: { identity?: () => string; readOnly?: boolean } = {},
) {
  const gateway = new FakeGateway();
  gateway.connectReply = () => ({
    ok: true,
    payload: helloOk(scopes, "device-token"),
  });
  gateway.handlers["gateway.identity.get"] = () => ({
    deviceId: options.identity ? options.identity() : "gw-one",
  });
  gateway.handlers["skills.library.list"] = () => ({
    multipleProfiles: false,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 64,
    entries: [],
    profileId: "gateway-owner",
  });
  gateway.handlers["skills.library.save"] = (params) => {
    const p = params as { slug: string; content: string };
    return {
      state: "published",
      target: "personal",
      entry: entry({ slug: p.slug }),
      sessionActivation: "new-sessions",
      nextAction:
        "Enabled for your new sessions, subject to agent policy and prerequisites. Existing session pins remain. Use skills.library.activate to attach or refresh it.",
    };
  };
  const storage = memoryStorage({
    connection: JSON.stringify({ url: URL, token: null }),
    [tokenKey(URL)]: JSON.stringify({
      token: "device-token",
      grantedScopes: scopes,
      heldScopes: scopes,
    }),
  });
  const client = new ClawtrateClient(testHost(gateway, storage), {
    ...FAST,
    ...(options.readOnly ? { readOnly: true } : {}),
  });
  await client.start();
  await until(() => client.state.discovery.status === "ready");
  return { client, gateway };
}

describe("SKILL.md validation and preview", () => {
  it("F-361: parses valid SKILL.md front matter and bounds preview fields as plain text", () => {
    const parsed = parseSkillMarkdown(utf8Bytes(VALID_SKILL));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.content).toBe(VALID_SKILL);
    expect(parsed.preview).toEqual({
      name: "Deploy Checklist",
      nameCut: false,
      description: "Use when checking release readiness before a deploy.",
      slug: "deploy-checklist",
      instructions: "# Deploy Checklist\n\n1. Run the test suite.\n2. Check the logs for errors.",
      instructionsCut: false,
      totalInstructionsChars: 72,
      sizeBytes: utf8Bytes(VALID_SKILL).byteLength,
    });
  });

  it("F-361: cuts long names and instructions to the preview bounds and keeps markup verbatim as text", () => {
    const longName = `Skill ${"a".repeat(MAX_SKILL_PREVIEW_NAME_CHARS + 50)}`;
    const body = `<script>alert(1)</script>\n${"b".repeat(MAX_SKILL_PREVIEW_CHARS + 200)}`;
    const content = `---\nname: ${longName}\ndescription: "Use when: testing <img src=x>"\n---\n\n${body}`;
    const parsed = parseSkillMarkdown(utf8Bytes(content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview.name.length).toBe(MAX_SKILL_PREVIEW_NAME_CHARS);
    expect(parsed.preview.nameCut).toBe(true);
    expect(parsed.preview.description).toBe("Use when: testing <img src=x>");
    expect(parsed.preview.instructions.startsWith("<script>alert(1)</script>\n")).toBe(true);
    expect(parsed.preview.instructions.length).toBe(MAX_SKILL_PREVIEW_CHARS);
    expect(parsed.preview.instructionsCut).toBe(true);
    expect(parsed.preview.totalInstructionsChars).toBe(body.length);
  });

  it("F-361: supports YAML block scalars, BOM, CRLF and nested metadata in front matter", () => {
    const content =
      "\uFEFF---\r\nname: 'Tide Table'\r\ndescription: >-\r\n  Use when someone asks\r\n  about harbour tides.\r\nmetadata:\r\n  openclaw:\r\n    emoji: wave\r\n---\r\n\r\nCheck the tide chart.\r\n";
    const parsed = parseSkillMarkdown(utf8Bytes(content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview.name).toBe("Tide Table");
    expect(parsed.preview.description).toBe("Use when someone asks about harbour tides.");
    expect(parsed.preview.slug).toBe("tide-table");
    expect(parsed.preview.instructions).toBe("Check the tide chart.");
  });

  it("F-361: accepts valid YAML comments after quoted and plain values and keeps original content verbatim", () => {
    const doubleQuoted =
      "---\nname: \"Tide Table\" # display name\ndescription: 'Harbour O''Brien tides' # note\nmetadata: [wave] # flow list\n---\n\nCheck tides.\n";
    const parsed = parseSkillMarkdown(utf8Bytes(doubleQuoted));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview.name).toBe("Tide Table");
    expect(parsed.preview.description).toBe("Harbour O'Brien tides");
    expect(parsed.content).toBe(doubleQuoted);

    const plainComment =
      "---\nname: Tide Table # plain comment\ndescription: Tide#not-a-comment\n---\n\nBody.\n";
    const parsedPlain = parseSkillMarkdown(utf8Bytes(plainComment));
    expect(parsedPlain.ok).toBe(true);
    if (!parsedPlain.ok) return;
    expect(parsedPlain.preview.name).toBe("Tide Table");
    expect(parsedPlain.preview.description).toBe("Tide#not-a-comment");

    // In YAML 1.2 a comment after a quoted value needs preceding whitespace.
    const noSpaceComment =
      '---\nname: "Tide Table"#no-space\ndescription: Checks tides.\n---\nBody.\n';
    expect(parseSkillMarkdown(utf8Bytes(noSpaceComment))).toEqual({
      ok: false,
      error: expect.stringMatching(/name/i),
    });
  });

  it("F-361: validates every front matter value as YAML and names the offending key", () => {
    const badFlow =
      "---\nname: Tide Table\ndescription: Checks tides.\nmetadata: [wave\n---\nBody.";
    expect(parseSkillMarkdown(utf8Bytes(badFlow))).toEqual({
      ok: false,
      error: expect.stringMatching(/metadata/i),
    });

    const badNestedFlow =
      "---\nname: Tide Table\ndescription: Checks tides.\nmetadata:\n  tags: [wave\n---\nBody.";
    expect(parseSkillMarkdown(utf8Bytes(badNestedFlow))).toEqual({
      ok: false,
      error: expect.stringMatching(/metadata\.tags/i),
    });

    const goodFlow =
      '---\nname: Tide Table\ndescription: Checks tides.\nmetadata: [wave]\nextra: {"openclaw": {"emoji": "wave"}}\n---\nBody.';
    expect(parseSkillMarkdown(utf8Bytes(goodFlow)).ok).toBe(true);
  });

  it("F-361: keeps apostrophes inside plain YAML flow values while preserving quoted scalars", () => {
    const plainApostrophe =
      "---\nname: Tide Table\ndescription: Checks tides.\nmetadata: [O'Brien]\n---\nBody.";
    expect(parseSkillMarkdown(utf8Bytes(plainApostrophe)).ok).toBe(true);

    const mixedFlow =
      "---\nname: Tide Table\ndescription: Checks tides.\nmetadata: [Harbour O'Brien, 'O''Brien', \"Mc'Donald\"]\nextra: {author: Tim O'Brien, note: 'O''Brien]', \"k\":'v]'}\n---\nBody.";
    expect(parseSkillMarkdown(utf8Bytes(mixedFlow)).ok).toBe(true);

    const unclosedQuoted =
      "---\nname: Tide Table\ndescription: Checks tides.\nmetadata: ['O''Brien]\n---\nBody.";
    expect(parseSkillMarkdown(utf8Bytes(unclosedQuoted))).toEqual({
      ok: false,
      error: expect.stringMatching(/metadata.*unclosed quote/i),
    });

    const unclosedAfterComma =
      "---\nname: Tide Table\ndescription: Checks tides.\nmetadata: [O'Brien, 'unclosed]\n---\nBody.";
    expect(parseSkillMarkdown(utf8Bytes(unclosedAfterComma))).toEqual({
      ok: false,
      error: expect.stringMatching(/metadata.*unclosed quote/i),
    });
  });

  it("F-361: rejects empty, oversized, non-UTF-8, binary and invalid front matter files at the trust boundary", () => {
    expect(parseSkillMarkdown(new Uint8Array(0))).toEqual({
      ok: false,
      error: expect.stringMatching(/empty/i),
    });

    const tooLarge = new Uint8Array(MAX_SKILL_FILE_BYTES + 1);
    tooLarge.fill(0x61);
    expect(parseSkillMarkdown(tooLarge)).toEqual({
      ok: false,
      error: expect.stringMatching(/at most 1 MB/i),
    });

    // Invalid UTF-8 lead/continuation and overlong sequence.
    expect(decodeUtf8Strict(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(decodeUtf8Strict(new Uint8Array([0xc0, 0xaf]))).toBeNull();
    expect(decodeUtf8Strict(new Uint8Array([0xed, 0xa0, 0x80]))).toBeNull();
    expect(parseSkillMarkdown(new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff]))).toEqual({
      ok: false,
      error: expect.stringMatching(/UTF-8/i),
    });

    // Embedded NUL byte.
    expect(parseSkillMarkdown(utf8Bytes("---\nname: a\ndescription: b\n---\n\0"))).toEqual({
      ok: false,
      error: expect.stringMatching(/binary/i),
    });

    // Missing front matter, missing closing delimiter, missing name or description, long description.
    expect(parseSkillMarkdown(utf8Bytes("# No front matter\nBody")).ok).toBe(false);
    expect(parseSkillMarkdown(utf8Bytes("---\nname: a\ndescription: b\n")).ok).toBe(false);
    expect(parseSkillMarkdown(utf8Bytes("---\ndescription: b\n---\nBody")).ok).toBe(false);
    expect(parseSkillMarkdown(utf8Bytes("---\nname: a\n---\nBody")).ok).toBe(false);
    expect(
      parseSkillMarkdown(
        utf8Bytes(
          `---\nname: a\ndescription: ${"x".repeat(MAX_SKILL_DESCRIPTION_CHARS + 1)}\n---\nBody`,
        ),
      ).ok,
    ).toBe(false);
  });

  it("F-361: derives valid slugs and checks the gateway slug pattern", () => {
    expect(deriveSkillSlug("Deploy Checklist!!")).toBe("deploy-checklist");
    expect(deriveSkillSlug("---Hello_World 2---")).toBe("hello-world-2");
    expect(deriveSkillSlug("日本語")).toBe("");
    expect(skillSlugProblem("deploy-checklist")).toBeNull();
    expect(skillSlugProblem("Bad_Slug")).not.toBeNull();
    expect(skillSlugProblem("-leading")).not.toBeNull();
    expect(skillSlugProblem("a".repeat(64))).not.toBeNull();
  });
});

describe("gateway skill library client and bridge", () => {
  it("F-361: saving a SKILL.md sends skills.library.save with expectedRevision: null and confirms only from the gateway answer", async () => {
    const { client, gateway } = await connected();
    try {
      const result = await client.importLibrarySkill(
        "deploy-checklist",
        utf8Bytes(VALID_SKILL),
        stampOn("gw-one", client),
      );
      expect(gateway.calls("skills.library.save")).toEqual([
        { expectedRevision: null, slug: "deploy-checklist", content: VALID_SKILL },
      ]);
      expect(result).toEqual({
        outcome: "saved",
        state: "published",
        target: "personal",
        nextAction: expect.stringMatching(/Existing session pins remain/),
        entry: expect.objectContaining({
          skillId: SKILL_ID,
          slug: "deploy-checklist",
          revision: REV_A,
        }),
        stamp: stampOn("gw-one", client),
      });

      // Without a confirmed entry from the gateway, never report Saved.
      gateway.handlers["skills.library.save"] = () => ({ state: "published" });
      await expect(
        client.importLibrarySkill(
          "deploy-checklist",
          utf8Bytes(VALID_SKILL),
          stampOn("gw-one", client),
        ),
      ).rejects.toThrow(/did not confirm/i);
    } finally {
      client.stop();
    }
  });

  it("F-361: a slug conflict from skills.library.save is returned as a conflict in the gateway's own words", async () => {
    const { client, gateway } = await connected();
    try {
      const gatewayMessage =
        'A skill named "deploy-checklist" already exists in this library. Choose a different slug; existing skills were preserved.';
      gateway.handlers["skills.library.save"] = () => {
        throw new GatewayError({
          code: "INVALID_REQUEST",
          message: gatewayMessage,
          details: { code: "SKILL_LIBRARY_NAME_CONFLICT" },
        });
      };
      const result = await client.importLibrarySkill(
        "deploy-checklist",
        utf8Bytes(VALID_SKILL),
        stampOn("gw-one", client),
      );
      expect(result).toEqual({
        outcome: "conflict",
        message: gatewayMessage,
        stamp: stampOn("gw-one", client),
      });
    } finally {
      client.stop();
    }
  });

  it("F-361: a gateway refusal other than conflict surfaces in the gateway's own words", async () => {
    const { client, gateway } = await connected();
    try {
      const policyMessage =
        "Skill security scan found critical issues. Review the instructions and support files before publishing.";
      gateway.handlers["skills.library.save"] = () => {
        throw new GatewayError({
          code: "INVALID_REQUEST",
          message: policyMessage,
          details: { code: "SKILL_LIBRARY_POLICY_BLOCKED" },
        });
      };
      await expect(
        client.importLibrarySkill(
          "deploy-checklist",
          utf8Bytes(VALID_SKILL),
          stampOn("gw-one", client),
        ),
      ).rejects.toThrow(policyMessage);
    } finally {
      client.stop();
    }
  });

  it("F-361: refuses without calling skills.library.save when write access is missing, the file is invalid or the gateway changed", async () => {
    const { client: reader, gateway: readGw } = await connected(READ);
    try {
      await expect(
        reader.importLibrarySkill(
          "deploy-checklist",
          utf8Bytes(VALID_SKILL),
          stampOn("gw-one", reader),
        ),
      ).rejects.toThrow(/write access/i);
      expect(readGw.calls("skills.library.save")).toHaveLength(0);
    } finally {
      reader.stop();
    }

    let id = "gw-one";
    const { client, gateway } = await connected(WRITE, { identity: () => id });
    try {
      await expect(
        client.importLibrarySkill(
          "deploy-checklist",
          utf8Bytes("not front matter"),
          stampOn("gw-one", client),
        ),
      ).rejects.toThrow(/front matter/i);
      expect(gateway.calls("skills.library.save")).toHaveLength(0);

      // Gateway replaced at the same address across a reconnect: old stamp must not save to it.
      id = "gw-two";
      const prevConnectedAt = client.state.connection.connectedAt;
      gateway.sockets.at(-1)!.close(1006, "replaced");
      await until(
        () =>
          client.state.connection.status === "connected" &&
          client.state.connection.connectedAt !== prevConnectedAt &&
          client.state.connection.gatewayId === "gw-two",
      );
      await expect(
        client.importLibrarySkill(
          "deploy-checklist",
          utf8Bytes(VALID_SKILL),
          stampOn("gw-one", client),
        ),
      ).rejects.toThrow(/another gateway|different gateway|changed/i);
      expect(gateway.calls("skills.library.save")).toHaveLength(0);
    } finally {
      client.stop();
    }
  });

  it("F-361: bridge takes the uploaded SKILL.md from AttachmentStore, validates it and consumes it", async () => {
    const { client, gateway } = await connected();
    const attachments = new AttachmentStore({ newId: () => "att-1" });
    const session = createBridgeSession(client, { attachments });
    try {
      const info = attachments.add(
        { fileName: "SKILL.md", mimeType: "text/markdown" },
        utf8Bytes(VALID_SKILL).byteLength,
        () => toBase64(utf8Bytes(VALID_SKILL)),
      );
      const command = parseBridgeCommand({
        type: "importLibrarySkill",
        slug: "deploy-checklist",
        attachmentId: info.id,
        stamp: stampOn("gw-one", client),
      });
      const result = await session.apply(command);
      expect(result).toMatchObject({ outcome: "saved", entry: { slug: "deploy-checklist" } });
      expect(gateway.calls("skills.library.save")).toHaveLength(1);
      // Attachment was consumed, not left waiting in the store.
      expect(() => attachments.get([info.id])).toThrow(/no longer available/i);
    } finally {
      session.dispose();
      client.stop();
    }
  });

  it("F-361: refreshing an existing task's skills calls skills.library.activate with next-turn activation", async () => {
    const { client, gateway } = await openTask();
    try {
      gateway.handlers["gateway.identity.get"] = () => ({ deviceId: "gw-one" });
      gateway.handlers["skills.library.activate"] = () => ({
        sessionKey: KEY,
        selections: [
          { skillId: SKILL_ID, revision: REV_A, name: "s_deploy_ch_11111111222233334444" },
        ],
        sessionActivation: "next-turn",
      });
      const result = await client.activateSkillLibrary(KEY, "refresh", stampOn("gw-one", client));
      expect(gateway.calls("skills.library.activate")).toEqual([
        { sessionKey: KEY, action: "refresh" },
      ]);
      expect(result).toEqual({
        sessionKey: KEY,
        sessionActivation: "next-turn",
        selectionCount: 1,
      });
    } finally {
      client.stop();
    }
  });

  it("F-361: fits listSkillLibrary to the web bridge maxResultChars and reports omitted entries", async () => {
    const { client, gateway } = await connected();
    const maxResultChars = 262_144 - 512;
    const session = createBridgeSession(client, { maxResultChars });
    try {
      const largeEntries = Array.from({ length: 256 }, (_, i) =>
        entry({
          skillId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          slug: `skill-${String(i + 1).padStart(3, "0")}`,
          description: "d".repeat(MAX_SKILL_DESCRIPTION_CHARS),
        }),
      );
      gateway.handlers["skills.library.list"] = () => ({
        multipleProfiles: false,
        defaultTarget: "personal",
        canManageWorkspace: false,
        defaultSelectionLimit: 64,
        entries: largeEntries,
        profileId: "gateway-owner",
      });

      const fitted = await session.apply({ type: "listSkillLibrary" });
      expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(maxResultChars);
      expect(fitted.truncated).toBe(true);
      expect(fitted.entries.length).toBeGreaterThan(0);
      expect(fitted.entries.length).toBeLessThan(256);

      // Small lists that fit keep their exact entries and truncated: false.
      gateway.handlers["skills.library.list"] = () => ({
        multipleProfiles: false,
        defaultTarget: "personal",
        canManageWorkspace: false,
        defaultSelectionLimit: 64,
        entries: [entry()],
        profileId: "gateway-owner",
      });
      const small = await session.apply({ type: "listSkillLibrary" });
      expect(small.entries).toHaveLength(1);
      expect(small.truncated).toBe(false);
    } finally {
      session.dispose();
      client.stop();
    }
  });

  it("F-361: keeps the gateway's bounded defaultSelectionNotice alongside truncated", async () => {
    const { client, gateway } = await connected();
    try {
      const notice =
        "New sessions select up to 64 enabled skills, personal skills first and then stable ID order.";
      gateway.handlers["skills.library.list"] = () => ({
        multipleProfiles: false,
        defaultTarget: "personal",
        canManageWorkspace: false,
        defaultSelectionLimit: 64,
        defaultSelectionNotice: notice,
        entries: Array.from({ length: 257 }, (_, i) =>
          entry({
            skillId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
            slug: `skill-${String(i + 1).padStart(3, "0")}`,
            description: "short",
          }),
        ),
        profileId: "gateway-owner",
      });
      const list = await client.listSkillLibrary();
      expect(list.entries).toHaveLength(256);
      expect(list.truncated).toBe(true);
      expect(list.defaultSelectionNotice).toBe(notice);
    } finally {
      client.stop();
    }
  });

  it("F-361: closing a task withdraws a pending activateSkillLibrary waiting on gateway identity", async () => {
    const { client, gateway } = await openTask();
    const session = createBridgeSession(client);
    try {
      await session.apply({ type: "openSession", key: KEY });
      let resolveIdentity!: (value: unknown) => void;
      gateway.handlers["gateway.identity.get"] = () =>
        new Promise((resolve) => {
          resolveIdentity = resolve;
        });
      gateway.handlers["skills.library.activate"] = () => ({
        sessionKey: KEY,
        selections: [],
        sessionActivation: "next-turn",
      });

      const pending = session.apply({
        type: "activateSkillLibrary",
        key: KEY,
        action: "refresh",
        stamp: stampOn("gw-one", client),
      });
      await until(() => resolveIdentity !== undefined);
      await session.apply({ type: "closeSession", key: KEY });
      resolveIdentity({ deviceId: "gw-one" });

      await expect(pending).rejects.toThrow();
      expect(gateway.calls("skills.library.activate")).toHaveLength(0);
    } finally {
      session.dispose();
      client.stop();
    }
  });
});
