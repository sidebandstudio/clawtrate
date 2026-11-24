// A name a bot wrote for itself, renamed once the person confirms it (#424).
//
// A bot asked to take a name edits the `- Name:` line of its own IDENTITY.md.
// The name Clawtrate shows is the bot's identity in the gateway's config,
// which `agents.create` set and which takes precedence over the file, so the
// edit changes nothing a person sees. After each finished run of a bot whose
// task is open, on a connection that can rename, Clawtrate reads that one
// file. When its name line differs from the bot's name, the
// conversation shows one card; its Rename sends `agents.update`, which also
// writes the file's name line, and the card goes once the bot list shows the
// new name. Nothing is sent without that click. Not now is kept on this
// device for that bot and that name, so the card comes back only for another.

import type { KeyValueStore } from "./host.ts";
import { asRecord } from "./mapping.ts";
import { sameStamp, type Bot, type GatewayStamp, type NameProposal } from "./types.ts";

/** A name as long as New bot's Name field takes. */
export const MAX_BOT_NAME_CHARS = 40;
/** An IDENTITY.md longer than this is not read for a name. */
export const MAX_IDENTITY_CHARS = 16_384;
/** Not now, per gateway and bot: the latest kept, oldest dropped. */
export const MAX_NAME_DECLINES = 64;
export const NAME_DECLINES_KEY = "clawtrate.bot-name-declines";
/** Cards, and bots skipped, at most: one per bot the state lists (`MAX_BOTS`). */
export const MAX_NAME_CARDS = 32;
/** What a card says of a Rename that didn't land, at most. */
export const MAX_NAME_ERROR_CHARS = 512;

const PLACEHOLDERS = new Set(["not set yet", "pick something you like"]);
/** A picture `agents.update` copied into IDENTITY.md from the config (R38). */
const PICTURE_LINE = /^- Avatar: data:[^\n]*(\n|$)/gm;

/**
 * The name an IDENTITY.md gives, read as the gateway reads it: the last line labelled `Name`,
 * with or without a list marker and emphasis (`- **Name:** Johnny`, `- Name: Johnny`), and not
 * the template's placeholder. Null when it gives none.
 */
export function identityName(content: string): string | null {
  let found: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^-\s*/, "");
    const colon = cleaned.indexOf(":");
    if (colon === -1) continue;
    if (cleaned.slice(0, colon).replace(/[*_`]/g, "").trim().toLowerCase() !== "name") continue;
    const value = cleaned
      .slice(colon + 1)
      .replace(/^[*_`\s]+|[*_`\s]+$/g, "")
      .trim();
    const bare = value
      .replace(/^\((.*)\)$/, "$1")
      .trim()
      .toLowerCase();
    if (value && !PLACEHOLDERS.has(bare)) found = value;
  }
  return found;
}

/**
 * A bot's name as Rename saves it, from text a bot wrote: control characters and line breaks
 * become spaces, direction controls and invisible spaces go, runs of space one, the ends trimmed, as the gateway stores a name; then cut to
 * `MAX_BOT_NAME_CHARS` characters. Null when nothing is left.
 */
export function plainName(raw: string): string | null {
  const spaced = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    // Direction controls and invisible spaces: a name reads as the characters it has. U+200C and
    // U+200D stay, as emoji sequences and some scripts need them.
    .replace(/[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "");
  const name = Array.from(spaced.replace(/\s+/g, " ").trim())
    .slice(0, MAX_BOT_NAME_CHARS)
    .join("")
    .trim();
  return name || null;
}

export type BotNamesContext = {
  request: (method: string, params: unknown) => Promise<unknown>;
  bots: () => Bot[];
  /** Connected, with `operator.admin`, on a host that writes. */
  canRename: () => boolean;
  /** The gateway's identity, or its address before that is known: whose Not now it is. */
  gateway: () => string | null;
  /** Where a read is made now: the gateway's identity and the host's target (`gatewayStamp`). */
  stamp: () => GatewayStamp;
  /** Refuse unless `stamp` is still where the host is connected, as every bot write does. */
  sameGateway: (stamp: GatewayStamp) => Promise<void>;
  storage: KeyValueStore;
  /** Take one of the client's file reads, or null when they are all in use. */
  takeRead: () => (() => void) | null;
  refreshBots: () => Promise<void>;
  /** Whether an error is the gateway refusing for a missing scope (and note it). */
  missingScope: (error: unknown) => boolean;
  publish: (proposals: NameProposal[]) => void;
  log: (text: string) => void;
};

type Declines = Record<string, string>;
const declineKey = (gateway: string, botId: string) => `${gateway}\n${botId}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class BotNames {
  private proposals = new Map<string, NameProposal>();
  private readonly reading = new Set<string>();
  private readonly skipped = new Set<string>();
  private declines: Declines | null = null;
  /** Moves on with every reset, so a read begun before it changes nothing after. */
  private epoch = 0;

  private readonly ctx: BotNamesContext;

  constructor(ctx: BotNamesContext) {
    this.ctx = ctx;
  }

  /** A run of `botId` ended in an open task: read its name line once, and show a card when it differs. */
  async afterRun(botId: string): Promise<void> {
    if (!this.ctx.canRename() || this.reading.has(botId) || this.skipped.has(botId)) return;
    const bot = this.ctx.bots().find((each) => each.id === botId);
    // The gateway's default bot takes its name in OpenClaw's own first run, which saves the config
    // too, and the gateway renames an implicit `main` only through its config (R13, R16).
    if (!bot || bot.isDefault) return;
    const release = this.ctx.takeRead();
    if (!release) return;
    const epoch = this.epoch;
    // Where this read is made: a card drawn from it is for that gateway and that target only.
    const stamp = this.ctx.stamp();
    this.reading.add(botId);
    try {
      const answer = asRecord(
        asRecord(
          await this.ctx.request("agents.files.get", { agentId: botId, name: "IDENTITY.md" }),
        )?.file,
      );
      if (epoch !== this.epoch) return;
      // A picture copied in isn't counted: Rename takes it out again.
      const content =
        typeof answer?.content === "string" ? answer.content.replace(PICTURE_LINE, "") : null;
      if (content === null) return;
      if (content.length > MAX_IDENTITY_CHARS) {
        // Read once, then left alone on this connection: a file this long isn't one to rename from.
        this.skipped.add(botId);
        if (this.skipped.size > MAX_NAME_CARDS)
          this.skipped.delete(this.skipped.values().next().value!);
        return this.drop(botId);
      }
      const raw = identityName(content);
      const name = raw === null ? null : plainName(raw);
      const declined = name !== null && (await this.declined(botId, name));
      // A card being renamed stays until its Rename settles; a read from before a reset counts for nothing.
      if (
        epoch !== this.epoch ||
        !sameStamp(this.ctx.stamp(), stamp) ||
        this.proposals.get(botId)?.status === "renaming"
      )
        return;
      const now = this.ctx.bots().find((each) => each.id === botId);
      // A name the bot already has, longer than a card's, is not a new one cut short.
      if (!now || name === null || name === now.name || name === plainName(now.name) || declined)
        return this.drop(botId);
      const open = this.proposals.get(botId);
      if (!open && this.proposals.size >= MAX_NAME_CARDS) return;
      this.proposals.set(botId, {
        botId,
        name,
        from: now.name,
        stamp,
        status: "open",
        error: null,
      });
      this.publish();
    } catch (error) {
      this.ctx.log(`could not read ${botId}'s IDENTITY.md: ${errorText(error)}`);
    } finally {
      this.reading.delete(botId);
      release();
    }
  }

  /**
   * Rename: one `agents.update` with the name the card shows, where the card was read (`stamp`),
   * then the bot list read back. The one way a card's name is saved.
   */
  async accept(botId: string, name: string, stamp: GatewayStamp): Promise<void> {
    const open = this.proposals.get(botId);
    if (!open || open.name !== name || open.status === "renaming")
      throw new Error("That name is no longer waiting for you.");
    if (!sameStamp(open.stamp, stamp))
      throw new Error("This name was found on another gateway, so nothing was sent.");
    if (!this.ctx.canRename()) throw new Error("Renaming a bot needs admin access.");
    const epoch = this.epoch;
    const set = (patch: Partial<NameProposal>) => {
      if (epoch !== this.epoch || this.proposals.get(botId)?.name !== name) return;
      this.proposals.set(botId, { ...open, ...patch });
      this.publish();
    };
    set({ status: "renaming", error: null });
    try {
      // The bot as the gateway lists it now: renamed or gone since the card was drawn, nothing is sent.
      await this.ctx.refreshBots();
      const bot = this.ctx.bots().find((each) => each.id === botId);
      if (!bot) {
        this.drop(botId);
        throw new Error(`${open.from} is no longer on the gateway, so nothing was sent.`);
      }
      if (bot.name === name) return this.drop(botId);
      if (bot.name !== open.from) {
        this.drop(botId);
        throw new Error(`${open.from} was renamed ${bot.name} meanwhile, so nothing was sent.`);
      }
      // Still the gateway the card was drawn for, on the connection that read it.
      await this.ctx.sameGateway(stamp);
      if (epoch !== this.epoch) throw new Error("The connection changed, so nothing was sent.");
      await this.ctx.request("agents.update", { agentId: botId, name });
    } catch (error) {
      if (this.proposals.get(botId)?.status !== "renaming") throw error;
      set({
        status: "failed",
        error: this.ctx.missingScope(error)
          ? "The gateway refused: renaming a bot needs admin access."
          : errorText(error).slice(0, MAX_NAME_ERROR_CHARS),
      });
      throw error;
    }
    await this.keepPictureOutOfFile(botId, epoch);
    try {
      await this.ctx.refreshBots();
    } catch {
      // Shown below: the list did not confirm it.
    }
    if (this.ctx.bots().find((each) => each.id === botId)?.name === name) return this.drop(botId);
    const unconfirmed = "The gateway saved it, but its bot list doesn't show it yet.";
    set({ status: "failed", error: unconfirmed });
    throw new Error(unconfirmed);
  }

  /**
   * `agents.update` writes every identity field the config holds into IDENTITY.md, the picture
   * as an `Avatar` line of up to 32 KB that every run would carry (R38). Take that line out
   * again, held to the file just read, as New bot's first step does (`endFirstRun`); the picture
   * stays in the config, which takes precedence over the file. The rename has landed whatever
   * happens here, so a failure is only logged.
   */
  private async keepPictureOutOfFile(botId: string, epoch: number): Promise<void> {
    try {
      const file = asRecord(
        asRecord(
          await this.ctx.request("agents.files.get", { agentId: botId, name: "IDENTITY.md" }),
        )?.file,
      );
      if (epoch !== this.epoch) return;
      const content = typeof file?.content === "string" ? file.content : null;
      const hash =
        typeof file?.hash === "string" && /^[a-f0-9]{64}$/i.test(file.hash) ? file.hash : null;
      if (content === null || hash === null) return;
      const kept = content.replace(PICTURE_LINE, "");
      if (kept === content) return;
      await this.ctx.request("agents.files.set", {
        agentId: botId,
        name: "IDENTITY.md",
        content: kept,
        expectedHash: hash,
      });
    } catch (error) {
      this.ctx.log(`could not take the picture out of ${botId}'s IDENTITY.md: ${errorText(error)}`);
    }
  }

  /** Not now: kept on this device for this bot and this name. */
  async decline(botId: string, name: string): Promise<void> {
    const open = this.proposals.get(botId);
    if (open?.name === name && open.status !== "renaming") this.drop(botId);
    const gateway = this.ctx.gateway();
    if (!gateway) return;
    const declines = { ...(await this.loadDeclines()) };
    const key = declineKey(gateway, botId);
    delete declines[key];
    declines[key] = name;
    const keys = Object.keys(declines);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_NAME_DECLINES)))
      delete declines[old];
    this.declines = declines;
    try {
      await this.ctx.storage.set(NAME_DECLINES_KEY, JSON.stringify(declines));
    } catch (error) {
      this.ctx.log(`could not keep Not now: ${errorText(error)}`);
    }
  }

  /** The bot list changed: a card whose bot is gone, or already has its name, goes. */
  onBots(bots: Bot[]): void {
    let changed = false;
    for (const [botId, proposal] of this.proposals) {
      if (proposal.status === "renaming") continue;
      const bot = bots.find((each) => each.id === botId);
      if (!bot || bot.name === proposal.name) {
        this.proposals.delete(botId);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** Another gateway, or none: nothing read of the last one counts. */
  reset(): void {
    this.epoch += 1;
    this.reading.clear();
    this.skipped.clear();
    if (this.proposals.size === 0) return;
    this.proposals = new Map();
    this.publish();
  }

  private drop(botId: string): void {
    if (this.proposals.delete(botId)) this.publish();
  }

  private publish(): void {
    this.ctx.publish([...this.proposals.values()]);
  }

  private async declined(botId: string, name: string): Promise<boolean> {
    const gateway = this.ctx.gateway();
    if (!gateway) return false;
    return (await this.loadDeclines())[declineKey(gateway, botId)] === name;
  }

  private async loadDeclines(): Promise<Declines> {
    if (this.declines) return this.declines;
    let read: Declines = {};
    try {
      const parsed = asRecord(JSON.parse((await this.ctx.storage.get(NAME_DECLINES_KEY)) ?? "{}"));
      for (const [key, value] of Object.entries(parsed ?? {}).slice(-MAX_NAME_DECLINES))
        if (typeof value === "string" && value.length <= MAX_BOT_NAME_CHARS * 4) read[key] = value;
    } catch {
      read = {};
    }
    this.declines ??= read;
    return this.declines;
  }
}
