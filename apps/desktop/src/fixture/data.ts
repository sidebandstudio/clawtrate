// Invented content for the fixture mode: bots, tasks and transcripts that cover
// what the interface has to handle. Nothing here comes from a real gateway.

import {
  emptyActivity,
  newRun,
  type Bot,
  type Task,
  type Transcript,
  type TranscriptBlock,
  type TranscriptItem,
} from "@clawtrate/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A small picture, drawn here, for the bot whose gateway identity carries an image. */
function pictureAvatar(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#f3d9a4";
  ctx.fillRect(0, 0, 96, 96);
  ctx.fillStyle = "#e9774f";
  ctx.beginPath();
  ctx.arc(64, 34, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3f6f8f";
  ctx.beginPath();
  ctx.moveTo(0, 70);
  ctx.quadraticCurveTo(26, 44, 52, 66);
  ctx.quadraticCurveTo(74, 52, 96, 62);
  ctx.lineTo(96, 96);
  ctx.lineTo(0, 96);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#24445a";
  ctx.beginPath();
  ctx.moveTo(0, 84);
  ctx.quadraticCurveTo(40, 66, 96, 82);
  ctx.lineTo(96, 96);
  ctx.lineTo(0, 96);
  ctx.closePath();
  ctx.fill();
  return canvas.toDataURL("image/png");
}

export function fixtureBots(): Bot[] {
  return [
    {
      id: "main",
      name: "Juniper",
      emoji: null,
      avatarUrl: pictureAvatar(),
      theme: "research",
      model: "scripted/dev-1",
      isDefault: true,
    },
    {
      id: "marlow",
      name: "Marlow",
      emoji: null,
      avatarUrl: null,
      theme: "editing",
      model: "scripted/dev-1",
      isDefault: false,
    },
    {
      id: "otto",
      name: "Otto",
      emoji: null,
      avatarUrl: null,
      theme: "home server operations",
      model: "scripted/dev-1",
      isDefault: false,
    },
    {
      id: "pip",
      name: "Pip",
      emoji: null,
      avatarUrl: null,
      theme: "planning",
      model: null,
      isDefault: false,
    },
    {
      id: "quartermaster",
      name: "Quartermaster of the Family Calendar and Errands",
      emoji: null,
      avatarUrl: null,
      theme: "household logistics",
      model: "scripted/dev-1",
      isDefault: false,
    },
  ];
}

type TaskSpec = {
  slug: string;
  title: string;
  /** Minutes before now of the latest activity. */
  ago: number;
  preview: string;
  ask: string;
  status?: Task["status"];
  unread?: boolean;
};

const SPECS: Record<string, TaskSpec[]> = {
  main: [
    {
      slug: "heat-pump",
      title: "Heat pump vs. gas furnace",
      ago: 16,
      preview: "Ask these five, and get the answers in writing.",
      ask: "What should I ask an installer before signing anything?",
    },
    {
      slug: "ebook-apps",
      title: "Library e-book apps compared",
      ago: 158,
      preview: "Most public libraries use one of three lending platforms.",
      ask: "Which e-book app does my library use, and is it any good?",
      unread: true,
    },
    {
      slug: "caffeine",
      title: "Caffeine cutoff time",
      ago: 3 * 24 * 60 + 40,
      preview: "Short answer: stop about eight hours before bed.",
      ask: "When should I stop drinking coffee if I want to sleep at eleven?",
    },
  ],
  marlow: [
    {
      slug: "main",
      title: "Main",
      ago: 42,
      preview: "Tightened the intro and cut about 80 words.",
      ask: "Can you tighten the intro of the newsletter draft?",
    },
  ],
  otto: [
    {
      slug: "rotate-logs",
      title: "Rotate the logs on every machine in the rack before the disks fill up again",
      ago: 1,
      preview: "Rotating logs on rack-2",
      ask: "Rotate the logs on every machine in the rack before the disks fill up again.",
      status: "running",
    },
    {
      slug: "disk-space",
      title: "Disk almost full on the media box",
      ago: 4,
      preview: "Done. The disk is now at 61%.",
      ask: "",
    },
    {
      slug: "backup-check",
      title: "Weekly backup check",
      ago: 186,
      preview: "Yes. Last night's backup finished at 3:25 AM.",
      ask: "Did last night's backup finish?",
      unread: true,
    },
    {
      slug: "cert-renewal",
      title: "Certificate renewal warning",
      ago: 26 * 60,
      preview: "A little. Renewal normally happens with 30 days left.",
      ask: "Should I worry about the certificate warning?",
    },
    {
      slug: "router-firmware",
      title: "Router firmware",
      ago: 2 * 24 * 60 + 90,
      preview: "The router is two releases behind. Neither is urgent.",
      ask: "Is the router's firmware current?",
    },
    {
      slug: "printer",
      title: "Printer offline again",
      ago: 3 * 24 * 60,
      preview: "It had fallen off the network. It is back, with a fixed address.",
      ask: "The printer is offline again.",
    },
    {
      slug: "nas-scrub",
      title: "NAS scrub schedule",
      ago: 4 * 24 * 60,
      preview: "The scrub now runs on the first Sunday of the month.",
      ask: "Move the NAS scrub to a quieter time.",
    },
    {
      slug: "garage-camera",
      title: "Why does the garage camera drop off the network every night around two",
      ago: 5 * 24 * 60,
      preview: "It loses its lease at 2:04 every night. A reservation fixes it.",
      ask: "Why does the garage camera drop off the network every night around two?",
    },
    {
      slug: "ups-battery",
      title: "UPS battery report",
      ago: 10 * 24 * 60,
      preview: "The battery holds 41 minutes at the current load.",
      ask: "How long would the UPS last?",
    },
    {
      slug: "guest-wifi",
      title: "Guest Wi-Fi password",
      ago: 11 * 24 * 60,
      preview: "Changed, and the old one no longer works.",
      ask: "Change the guest Wi-Fi password.",
    },
    {
      slug: "media-update",
      title: "Media server update",
      ago: 13 * 24 * 60,
      preview: "Updated. Two plugins needed their settings again.",
      ask: "Update the media server.",
    },
    {
      slug: "thermostat",
      title: "Thermostat schedule",
      ago: 14 * 24 * 60,
      preview: "Weekdays now start warming at 6:30.",
      ask: "Start warming the house earlier on weekdays.",
    },
    {
      slug: "dns-blocklist",
      title: "DNS blocklist review",
      ago: 17 * 24 * 60,
      preview: "Removed three lists that blocked the school's site.",
      ask: "The school's site is blocked again.",
    },
    {
      slug: "old-tickets",
      title: "Old tickets cleanup",
      ago: 19 * 24 * 60,
      preview: "Closed 19 that were already done.",
      ask: "Close the tickets that are already done.",
    },
  ],
  pip: [
    {
      slug: "week",
      title: "Plan the week",
      ago: 150,
      preview: "Here is the week, with Thursday kept clear.",
      ask: "Plan my week. Keep Thursday clear.",
      unread: true,
    },
    {
      slug: "coast-trip",
      title: "Trip to the coast in March",
      ago: 25 * 60,
      preview: "Two options, both under four hours by train.",
      ask: "Find me a weekend at the coast in March.",
      status: "failed",
    },
    {
      slug: "birthday",
      title: "Birthday dinner",
      ago: 4 * 24 * 60,
      preview: "Booked for eight people at 7:30.",
      ask: "Book a table for eight on Saturday.",
    },
    {
      slug: "reading-list",
      title: "Reading list for the spring",
      ago: 14 * 24 * 60,
      preview: "Twelve books, shortest first.",
      ask: "Make me a reading list for the spring.",
    },
  ],
  quartermaster: [
    {
      slug: "errands",
      title: "Pick up the dry cleaning and the prescription before the pharmacy closes on Saturday",
      ago: 2 * 24 * 60 + 300,
      preview: "Both are on Saturday's route, pharmacy first because it closes at noon.",
      ask: "Pick up the dry cleaning and the prescription before the pharmacy closes on Saturday.",
    },
    {
      slug: "school-supplies",
      title: "School supply list",
      ago: 6 * 24 * 60,
      preview: "Everything except the graph paper is already in the cupboard.",
      ask: "What do we still need from the school supply list?",
    },
  ],
};

export const OPEN_BOT = "otto";
export const OPEN_TASK = "agent:otto:disk-space";
/** A task whose transcript fails to load in the failure scenes. */
export const FAILING_TASK = "agent:otto:dns-blocklist";

export function fixtureTasks(now: number, bots: Bot[]): Record<string, Task[]> {
  const byBot: Record<string, Task[]> = {};
  for (const bot of bots) {
    byBot[bot.id] = (SPECS[bot.id] ?? []).map((spec) => ({
      key: `agent:${bot.id}:${spec.slug}`,
      botId: bot.id,
      sessionId: `${bot.id}-${spec.slug}`,
      title: spec.title,
      preview: spec.preview,
      updatedAt: now - spec.ago * MINUTE,
      status: spec.status ?? "done",
      unread: spec.unread ?? false,
      // Marlow's gateway reports no context use, so its task says so.
      ...(bot.id === "marlow"
        ? {}
        : {
            context: {
              used: CONTEXT_USED[`agent:${bot.id}:${spec.slug}`] ?? 3_000 + spec.title.length * 97,
              window: 128_000,
              fresh: true,
            },
          }),
    }));
  }
  return byBot;
}

const CONTEXT_USED: Record<string, number> = {
  "agent:otto:disk-space": 18_432,
  "agent:pip:week": 9_870,
};

/** Pip's week: a run that narrates as it goes, then a table wider than a bubble. */
export const NARRATED_TASK = "agent:pip:week";

function weekTranscript(now: number): TranscriptItem[] {
  const at = now - 150 * MINUTE;
  return [
    item("user", at - 3 * MINUTE, [text("Plan my week. Keep Thursday clear.")]),
    item("assistant", at - 2 * MINUTE, [
      text("On it. Checking your calendar first."),
      tool(
        "w1",
        "read",
        { path: "calendar/this-week.md" },
        { text: "Mon: dentist 9:00\nWed: school play 18:30" },
      ),
      text("Reading Thursday's notes now. The table is next."),
      tool("w2", "read", { path: "calendar/thursday.md" }, { text: "Nothing booked." }),
      text("Thursday is empty, so I kept it that way."),
      text(
        [
          "Here is the week, with Thursday kept clear.",
          "",
          "| | Mon | Tue | Wed | Thu | Fri | Sat | Sun |",
          "| --- | --- | --- | --- | --- | --- | --- | --- |",
          "| Morning | Dentist at 9:00 | Groceries before work | Gym | Clear | Car service at 8:30 | Farmers' market | Long walk |",
          "| Afternoon | Report draft | Team review | Report final | Clear | Pick up the car | Birthday present | Read |",
          "| Evening | Laundry | Call the plumber | School play at 6:30 | Clear | Dinner out | Birthday dinner | Plan next week |",
        ].join("\n"),
      ),
    ]),
  ];
}

/**
 * Every state a task can be in, on fixed tasks: Juniper has a task waiting for
 * you and one working; Otto has one working and one done with failures; Marlow's
 * only task is blocked; Pip keeps its failed task.
 */
export const TASK_STATES: Record<string, Task["status"]> = {
  "agent:main:heat-pump": "waiting",
  "agent:main:ebook-apps": "running",
  "agent:otto:backup-check": "done-with-failures",
  "agent:marlow:main": "blocked",
};

export function withTaskStates(byBot: Record<string, Task[]>): Record<string, Task[]> {
  return Object.fromEntries(
    Object.entries(byBot).map(([bot, tasks]) => [
      bot,
      tasks.map((task) => ({ ...task, status: TASK_STATES[task.key] ?? task.status })),
    ]),
  );
}

const text = (value: string): TranscriptBlock => ({ kind: "text", text: value });
const thought = (value: string): TranscriptBlock => ({ kind: "reasoning", text: value });
function tool(
  callId: string,
  name: string,
  args: Record<string, unknown>,
  result: { text: string; isError?: boolean } | null,
): TranscriptBlock {
  return {
    kind: "tool-call",
    callId,
    name,
    argumentsText: JSON.stringify(args, null, 2),
    result: result ? { isError: result.isError ?? false, text: result.text } : null,
  };
}

let counter = 0;
function item(
  role: TranscriptItem["role"],
  timestamp: number,
  blocks: TranscriptBlock[],
): TranscriptItem {
  counter += 1;
  return {
    id: `item-${counter}`,
    role,
    timestamp,
    blocks,
    model: role === "assistant" ? "scripted/dev-1" : null,
  };
}

/** The long transcript: two days, reasoning, tool calls in every state, markdown. */
function diskTranscript(now: number): TranscriptItem[] {
  const yesterday = now - DAY - 3 * HOUR;
  const today = now - 9 * MINUTE;
  return [
    item("user", yesterday, [
      text("The media box has been slow all evening. Can you check whether something is wrong?"),
    ]),
    item("assistant", yesterday + 40_000, [
      thought(
        "Slow all evening usually means the disk or a runaway process.\nI will look at the workspace notes first, then the logs I am allowed to read.",
      ),
      tool("c1", "ls", { path: "." }, { text: "AGENTS.md\ninventory.md\nnotes/" }),
      tool(
        "c2",
        "read",
        { path: "/var/log/syslog" },
        { text: "Permission denied: /var/log/syslog is outside the workspace.", isError: true },
      ),
      text(
        "Nothing alarming that I can see from here. The system log is outside my workspace, so I could not read it. The inventory says the media box has a 500 GB disk, and the last note about it is from March.",
      ),
    ]),
    item("user", yesterday + 3 * MINUTE, [
      text("Keep an eye on it and tell me if the disk fills up."),
    ]),
    item("assistant", yesterday + 4 * MINUTE, [
      tool(
        "c3",
        "write",
        { path: "notes/media-box.md", content: "Watch disk use. Report above 90%." },
        { text: "Wrote 2 lines." },
      ),
      text("Will do. I added a note so I check the disk each morning and tell you above 90%."),
    ]),
    item("system", yesterday + 5 * MINUTE, [text("Session resumed after a gateway restart.")]),
    item("user", today, [
      text("The media box says the disk is 94% full. What is eating the space?"),
    ]),
    item("assistant", today + 50_000, [
      thought(
        "I should look at the workspace inventory I keep for the server before guessing.\nThen re-read my instructions so I report in the agreed order.",
      ),
      tool("c4", "ls", { path: "." }, { text: "AGENTS.md\ninventory.md\nnotes/" }),
      tool(
        "c5",
        "read",
        { path: "AGENTS.md" },
        {
          text: "# Otto\n\nYou are Otto, the operator for a small home server.\n\n- Check before you change. Read logs and configs first.\n- Report in this order: what you found, what you changed, what is left.",
        },
      ),
      text(
        [
          "### Found",
          "",
          "The usual suspects on a media box, largest first:",
          "",
          "1. `/var/lib/transcode-cache`, about 180 GB of temporary transcodes that were never cleaned up.",
          "2. Old container images, about 40 GB across 12 unused tags.",
          "3. Rotated logs, about 6 GB, mostly from one noisy service.",
          "",
          "### Changed",
          "",
          "Nothing yet.",
          "",
          "### Left",
          "",
          "- Clearing the transcode cache is safe and frees the most. Its files are regenerated on demand.",
          "- Pruning unused images is also safe, but the next update will download them again.",
          "",
          "Should I clear the transcode cache? I will move it aside first so it can be restored.",
        ].join("\n"),
      ),
    ]),
    item("user", now - 5 * MINUTE, [text("Yes, clear the transcode cache.")]),
    item("assistant", now - 4 * MINUTE, [
      tool(
        "c6",
        "write",
        {
          path: "notes/disk-2026-11-16.md",
          content: "Moved the transcode cache aside to transcode-cache.old. Remove after a week.",
        },
        { text: "Wrote 6 lines." },
      ),
      tool("c7", "du", { path: "/var/lib", depth: 1 }, null),
      text(
        [
          "Done. The disk is now at 61%.",
          "",
          "| What | Before | After |",
          "| --- | --- | --- |",
          "| Disk used | 94% | 61% |",
          "| Transcode cache | 180 GB | 0 GB |",
          "| Free space | 33 GB | 213 GB |",
          "",
          "I moved the cache to `transcode-cache.old` instead of deleting it. To undo:",
          "",
          "```",
          "mv /var/lib/transcode-cache.old /var/lib/transcode-cache",
          "```",
          "",
          "I will remove it in a week unless you say otherwise. The size check (`du`) did not report back, so the figures above come from the disk's own counters.",
        ].join("\n"),
      ),
    ]),
  ];
}

/** Juniper's e-book answer: inline markdown (bold, emphasis, a link, inline code) inside sentences. */
export const MARKDOWN_TASK = "agent:main:ebook-apps";

function ebookTranscript(spec: TaskSpec, at: number): TranscriptItem[] {
  return [
    item("user", at - 2 * MINUTE, [text(spec.ask)]),
    item("assistant", at, [
      text(
        [
          `${spec.preview} Yours lists **Libby by OverDrive** on its catalogue page, and it is *the easiest of the three* to start with.`,
          "",
          "Sign in with your card number on [the library's help page](https://example.org/library/help), then choose `Add a library` if it asks twice.",
        ].join("\n"),
      ),
    ]),
  ];
}

function shortTranscript(spec: TaskSpec, at: number): TranscriptItem[] {
  return [
    item("user", at - 2 * MINUTE, [text(spec.ask || `${spec.title}?`)]),
    item("assistant", at, [text(spec.preview)]),
  ];
}

export function fixtureTranscripts(now: number, bots: Bot[]): Record<string, Transcript> {
  const transcripts: Record<string, Transcript> = {};
  for (const bot of bots) {
    for (const spec of SPECS[bot.id] ?? []) {
      const key = `agent:${bot.id}:${spec.slug}`;
      const items =
        key === OPEN_TASK
          ? diskTranscript(now)
          : key === NARRATED_TASK
            ? weekTranscript(now)
            : key === MARKDOWN_TASK
              ? ebookTranscript(spec, now - spec.ago * MINUTE)
              : shortTranscript(spec, now - spec.ago * MINUTE);
      const running = spec.status === "running";
      const text = "Rack-1 is done. Rotating logs on rack-2 now.";
      transcripts[key] = {
        ...emptyActivity,
        // A task the gateway reports running has its run, as the engine keeps it.
        runs: running
          ? [
              newRun(
                "fixture-run",
                { state: "running", origin: "gateway", bound: true, text },
                now - 3 * MINUTE,
              ),
            ]
          : [],
        linkedRuns: {},
        interSession: [],
        sessionKey: key,
        status: "ready",
        items,
        error: null,
        hasMore: false,
        live: running ? { runId: "fixture-run", text } : null,
        loadedAt: now,
      };
    }
  }
  return transcripts;
}
