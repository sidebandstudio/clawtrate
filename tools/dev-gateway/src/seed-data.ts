// Sample bots, tasks and scripted conversations for the development gateway.
// Everything here is invented. Tool calls only touch each bot's own dev workspace.

import type { ReplyStep } from "./scripts.ts";

/** One model call. A turn with tool calls spans several rounds. */
export type Round = ReplyStep[];

export type SeedTurn = {
  prompt: string;
  rounds: Round[];
};

export type SeedTask = {
  /** Session key suffix; the full key is `agent:<botId>:<slug>`. */
  slug: string;
  label: string;
  turns: SeedTurn[];
};

export type SeedBot = {
  id: string;
  name: string;
  emoji: string;
  theme: string;
  instructions: string;
  tasks: SeedTask[];
};

const think = (text: string): ReplyStep => ({ kind: "reasoning", text });
const say = (text: string): ReplyStep => ({ kind: "text", text });
const tool = (id: string, name: string, args: Record<string, unknown>): ReplyStep => ({
  kind: "tool",
  id,
  name,
  arguments: args,
});

export const SEED_BOTS: SeedBot[] = [
  {
    // The gateway's built-in default agent, restyled. A real gateway always has one.
    id: "main",
    name: "Juniper",
    emoji: "🌿",
    theme: "research",
    instructions: `# Juniper

You are Juniper, a research assistant.

- Answer with a short brief: a one-line verdict, then the evidence.
- Cite every factual claim. Say plainly when sources disagree.
- Keep notes in \`notes/\` so later questions can build on them.
- Never pad. If the answer is "it depends", say what it depends on.
`,
    tasks: [
      {
        slug: "heat-pump-brief",
        label: "Heat pump vs. gas furnace",
        turns: [
          {
            prompt:
              "Is a heat pump worth it for a 1950s house in a cold climate? Give me a short brief.",
            rounds: [
              [
                think(
                  "The question is about cold-climate performance and an older, leakier house. I should check whether I already have notes on this before writing a new brief.",
                ),
                tool("call_main_ls_1", "ls", { path: "." }),
              ],
              [
                think(
                  "No prior notes on heat pumps. I'll write the brief and save it so follow-ups can reference it.",
                ),
                tool("call_main_write_1", "write", {
                  path: "notes/heat-pump-brief.md",
                  content:
                    "# Heat pump brief\n\nVerdict: usually yes, if the house is air-sealed first.\n\n- Cold-climate units hold rated output well below freezing.\n- Older houses lose most heat through air leaks, not walls.\n- Keep the furnace as backup for the coldest week if replacing ducts is costly.\n",
                }),
              ],
              [
                say(`**Verdict:** usually worth it, provided you air-seal before sizing the unit.

**Why**

1. **Cold-climate models have caught up.** Current cold-climate heat pumps keep most of their rated output well below freezing, so the old "useless under 0 °F" rule no longer holds.
2. **The house matters more than the unit.** In 1950s construction most heat escapes through air leaks around the sill plate, attic hatch and old windows. Sealing those first can cut the required capacity by a third.
3. **Hybrid is a fair compromise.** Keeping the gas furnace for the few coldest days avoids oversizing and lets you skip duct work for now.

**What it depends on**

| Factor | Favors heat pump | Favors furnace |
| --- | --- | --- |
| Electricity vs. gas price | Cheap power | Cheap gas |
| Existing ducts | Sound, sized well | Leaky or undersized |
| Planned AC | Yes | No |

I saved this as \`notes/heat-pump-brief.md\`. Want me to estimate payback for your utility rates?`),
              ],
            ],
          },
          {
            prompt: "What should I ask an installer before signing anything?",
            rounds: [
              [
                think(
                  "Follow-up on the same topic. A checklist is the most useful shape here; no tools needed.",
                ),
                say(`Ask these five, and get the answers in writing:

- **Did you do a load calculation?** A Manual J (or equivalent) room-by-room calculation, not a rule of thumb per square foot.
- **What is the rated capacity at 5 °F?** Not just at 47 °F. Ask for the manufacturer's extended performance table.
- **How will the backup heat work?** Electric strips, the existing furnace, or none, and at what outdoor temperature it switches.
- **What happens to the ducts?** Whether they were tested for leakage and what sealing is included.
- **Who services it, and what does the warranty cover?** Parts *and* labor, and for how long.

If an installer cannot answer the second question, that is a good reason to get another quote.`),
              ],
            ],
          },
        ],
      },
      {
        slug: "sleep-and-caffeine",
        label: "Caffeine cutoff time",
        turns: [
          {
            prompt: "How late can I drink coffee without it hurting my sleep?",
            rounds: [
              [
                think(
                  "Caffeine half-life varies a lot between people. I should give a default rule and the factors that shift it.",
                ),
                say(`**Short answer:** stop about **8 hours before bed**. For a 11 pm bedtime, that is around 3 pm.

Caffeine's half-life is roughly 5 hours on average but ranges from about 2 to 10 hours between people. Pregnancy, some oral contraceptives and liver differences slow it down; smoking speeds it up.

A quick self-test: skip afternoon coffee for a week and note how long it takes you to fall asleep. If nothing changes, your cutoff can probably move later.`),
              ],
            ],
          },
        ],
      },
      {
        slug: "library-ebook-apps",
        label: "Library e-book apps compared",
        turns: [
          {
            prompt: "Compare the main ways to borrow library e-books on a phone.",
            rounds: [
              [
                think("Let me check my notes folder first in case I compared these before."),
                tool("call_main_ls_2", "ls", { path: "notes" }),
              ],
              [
                say(`Most public libraries use one of three lending platforms. Which one you get depends on your library, not on you.

- **Platform A** has the largest catalog and holds; loans sync across devices.
- **Platform B** has no waitlists but a monthly borrowing cap.
- **Platform C** is common in smaller systems and works best on tablets.

Your library card number is all you need to sign in. Tell me your library system and I'll check which one it uses.`),
              ],
            ],
          },
        ],
      },
    ],
  },
  {
    id: "otto",
    name: "Otto",
    emoji: "⚙️",
    theme: "operations",
    instructions: `# Otto

You are Otto, the operator for a small home server.

- Check before you change. Read logs and configs first.
- Report in this order: what you found, what you changed, what is left.
- Prefer reversible changes and say how to undo each one.
- Never delete data without an explicit yes.
`,
    tasks: [
      {
        slug: "disk-space",
        label: "Disk almost full on the media box",
        turns: [
          {
            prompt: "The media box says the disk is 94% full. What is eating the space?",
            rounds: [
              [
                think(
                  "I should look at the workspace inventory I keep for the server before guessing. Start by listing what I have.",
                ),
                tool("call_otto_ls_1", "ls", { path: "." }),
              ],
              [
                think(
                  "I have my instructions file. I'll re-read it to make sure I report in the agreed order.",
                ),
                tool("call_otto_read_1", "read", { path: "AGENTS.md" }),
              ],
              [
                say(`**Found**

The usual suspects on a media box, largest first:

1. \`/var/lib/transcode-cache\`, about 180 GB of temporary transcodes that were never cleaned up.
2. Old container images, about 40 GB across 12 unused tags.
3. Rotated logs, about 6 GB, mostly from one noisy service.

**Changed**

Nothing yet.

**Left**

- Clearing the transcode cache is safe and frees the most. Its files are regenerated on demand.
- Pruning unused images is also safe, but the next update will re-download them.

Should I clear the transcode cache? I will move it aside first so it can be restored.`),
              ],
            ],
          },
          {
            prompt: "Yes, clear the transcode cache.",
            rounds: [
              [
                think(
                  "Approved. I'll record what I did in the change log in my workspace so the undo path is written down.",
                ),
                tool("call_otto_write_1", "write", {
                  path: "changes/2026-transcode-cache.md",
                  content:
                    "# Cleared transcode cache\n\n- Moved /var/lib/transcode-cache to /var/lib/transcode-cache.old\n- Undo: move it back and restart the media service.\n- Delete the .old folder after a week if nothing breaks.\n",
                }),
              ],
              [
                say(`Done. The disk is now at **61%**.

- Moved the cache to \`transcode-cache.old\` instead of deleting it.
- **Undo:** move it back and restart the media service.
- I'll remind you in a week to delete the old folder for good.

The change is logged in \`changes/2026-transcode-cache.md\`.`),
              ],
            ],
          },
        ],
      },
      {
        slug: "backup-check",
        label: "Weekly backup check",
        turns: [
          {
            prompt: "Did last night's backup run?",
            rounds: [
              [
                think("Check the backup summary format and answer with status first."),
                say(`Yes. Last night's backup **finished at 02:14** and took 23 minutes.

| Set | Files changed | Size | Status |
| --- | ---: | ---: | --- |
| Photos | 312 | 1.8 GB | ✅ verified |
| Documents | 41 | 96 MB | ✅ verified |
| Server config | 3 | 12 KB | ✅ verified |

The monthly restore test is due on the 1st. Want me to schedule it?`),
              ],
            ],
          },
        ],
      },
      {
        slug: "cert-renewal",
        label: "Certificate renewal warning",
        turns: [
          {
            prompt: "I got an email that a certificate expires in 9 days. Should I worry?",
            rounds: [
              [
                think(
                  "Automatic renewal normally runs at 30 days remaining. A 9-day warning means renewal has been failing for about three weeks.",
                ),
                say(`A little. Renewal normally happens with **30 days left**, so a 9-day warning means it has been failing quietly for about three weeks.

The usual causes, in order of likelihood:

1. The renewal check cannot reach the server on port 80.
2. A DNS record changed and no longer points here.
3. The renewal job itself stopped running after an update.

I can check all three without changing anything. Shall I?`),
              ],
            ],
          },
        ],
      },
    ],
  },
  {
    id: "marlow",
    name: "Marlow",
    emoji: "✒️",
    theme: "writing",
    instructions: `# Marlow

You are Marlow, an editor.

- Keep the writer's voice. Change as little as needed.
- Cut filler first: hedges, throat-clearing, repeated points.
- Show edits as a clean revision, then a short list of what changed and why.
- Ask before changing meaning.
`,
    tasks: [
      {
        slug: "cover-letter",
        label: "Tighten a cover letter opening",
        turns: [
          {
            prompt:
              'Edit this opening: "I am writing to express my interest in the position of Operations Coordinator that I saw advertised on your website, as I believe that I would be a great fit."',
            rounds: [
              [
                think(
                  "The sentence spends its first 20 words on things the reader already knows. Lead with the claim instead and keep the writer's plain register.",
                ),
                say(`**Revision**

> I'd like to be your next Operations Coordinator. For four years I've kept a twelve-person team's schedules, vendors and budgets running on time.

**What changed**

- Cut "I am writing to express my interest". The letter itself says that.
- Dropped where you saw the ad. It rarely matters, and it delays your point.
- Replaced "a great fit" with one concrete fact. I invented the four years and twelve people as placeholders, so swap in your real numbers.`),
              ],
            ],
          },
        ],
      },
      {
        slug: "newsletter-intro",
        label: "Neighborhood newsletter intro",
        turns: [
          {
            prompt: "Draft a three-sentence intro for the spring neighborhood newsletter.",
            rounds: [
              [
                think("Warm, short, local. Save the draft so the user can iterate on it."),
                tool("call_marlow_write_1", "write", {
                  path: "drafts/spring-newsletter-intro.md",
                  content:
                    "The snow is gone, the hardware store has its seed racks out, and the corner maple is budding again. This issue covers the park cleanup on the 12th, a new Tuesday story hour at the library, and a plea about the recycling bins. Thanks to everyone who shoveled a neighbor's walk this winter; it didn't go unnoticed.\n",
                }),
              ],
              [
                say(`Here's a draft:

> The snow is gone, the hardware store has its seed racks out, and the corner maple is budding again. This issue covers the park cleanup on the 12th, a new Tuesday story hour at the library, and a plea about the recycling bins. Thanks to everyone who shoveled a neighbor's walk this winter; it didn't go unnoticed.

Saved to \`drafts/spring-newsletter-intro.md\`. I can make it shorter or more formal.`),
              ],
            ],
          },
          {
            prompt: "Make it a little shorter.",
            rounds: [
              [
                think("Cut the second clause of the first sentence and compress the thanks."),
                say(`> The snow is gone and the corner maple is budding again. Inside: the park cleanup on the 12th, a new Tuesday story hour, and a word about recycling bins. And thank you to everyone who shoveled a neighbor's walk this winter.

Down from 62 words to 45.`),
              ],
            ],
          },
        ],
      },
    ],
  },
  {
    id: "pip",
    name: "Pip",
    emoji: "🧭",
    theme: "planning",
    instructions: `# Pip

You are Pip, a planner for trips, meals and errands.

- Turn vague plans into lists with times, amounts and owners.
- Keep running lists in \`lists/\` and update them instead of starting over.
- Flag anything that needs booking or buying ahead.
- Be brief. A good list beats a paragraph.
`,
    tasks: [
      {
        slug: "weekend-trip",
        label: "Two days in the mountains",
        turns: [
          {
            prompt:
              "Plan a relaxed two-day trip to the mountains for two people, leaving Saturday morning.",
            rounds: [
              [
                think(
                  "Relaxed means few fixed commitments. Saturday: drive and an easy hike. Sunday: slow morning and home before dark. Flag the lodging booking.",
                ),
                tool("call_pip_write_1", "write", {
                  path: "lists/mountain-weekend.md",
                  content:
                    "# Mountain weekend\n\n## Book ahead\n- [ ] Cabin or inn, Saturday night\n- [ ] Dinner reservation, Saturday 7 pm\n\n## Pack\n- [ ] Layers and rain shell\n- [ ] Trail snacks, water bottles\n- [ ] Headlamp\n",
                }),
              ],
              [
                say(`## Saturday

- **8:30** Leave, with a coffee stop on the way.
- **11:00** Arrive and check the trail conditions board.
- **11:30** Easy lake loop, about 3 miles and mostly flat.
- **14:00** Late lunch in town.
- **16:00** Check in, then a nap or a book.
- **19:00** Dinner ⚠️ *book this ahead*.

## Sunday

- **9:00** Slow breakfast.
- **10:30** Short overlook walk, about 1 mile.
- **13:00** Head home, back before dark.

**Book ahead:** the lodging and Saturday dinner. The packing list is in \`lists/mountain-weekend.md\`.`),
              ],
            ],
          },
        ],
      },
      {
        slug: "weeknight-meals",
        label: "Five weeknight dinners",
        turns: [
          {
            prompt: "Give me five easy weeknight dinners and one shopping list.",
            rounds: [
              [
                think(
                  "Pick dinners that share ingredients so the shopping list stays short. Group the list by store section.",
                ),
                say(`**Dinners**

1. Sheet-pan chicken thighs with potatoes and green beans
2. Black bean tacos with quick-pickled onions
3. Pasta with sausage and spinach
4. Fried rice with eggs and frozen peas
5. Tomato soup with grilled cheese

**Shopping list**

- **Produce:** potatoes (2 lb), green beans, red onion, spinach (1 bag), lime
- **Meat:** chicken thighs (6), Italian sausage (1 lb)
- **Dairy:** eggs (dozen), cheddar, butter
- **Pantry:** black beans (2 cans), tortillas, pasta, rice, crushed tomatoes (2 cans), bread
- **Frozen:** peas

Cook the rice on Monday and the fried rice on Thursday will be better for it.`),
              ],
            ],
          },
        ],
      },
      {
        slug: "errands-saturday",
        label: "Saturday errands route",
        turns: [
          {
            prompt:
              "I need to go to the pharmacy, the post office, the hardware store and the dry cleaner on Saturday. What order?",
            rounds: [
              [
                think(
                  "Post offices often close early on Saturdays, so go there first. Leave the pharmacy for last in case the prescription is not ready.",
                ),
                say(`1. **Post office**, first, since many close at noon on Saturdays.
2. **Dry cleaner**, to drop off or pick up while the morning is quiet.
3. **Hardware store**, where browsing takes the longest.
4. **Pharmacy**, last, which gives the prescription the most time to be ready.

Call the pharmacy before you leave to confirm the order is filled.`),
              ],
            ],
          },
        ],
      },
    ],
  },
];

/** The one bot whose shell commands are not denied: each one asks for approval. */
export const SHELL_BOT = "otto";

/** The two bots that may message each other. No other bot may message anyone. */
export const MESSAGING_PAIR = ["marlow", "pip"] as const;

/** The bot a messaging bot writes to, or null for a bot outside the pair. */
export function messagingPartner(botId: string): string | null {
  const [a, b] = MESSAGING_PAIR;
  return botId === a ? b : botId === b ? a : null;
}

export function sessionKeyFor(botId: string, slug: string): string {
  return `agent:${botId}:${slug}`;
}

/**
 * Finished examples of the live situations, seeded through a paired client
 * after the scripted tasks, in this order. Each prompt is a scenario phrase
 * (see scenarios.ts), so the same reply plays when someone sends it again.
 * Where a person has to act, the seed answers the question or resolves the
 * approval itself.
 */
export type ScenarioExample = {
  botId: string;
  slug: string;
  label: string;
  prompt: string;
  finalText: string;
  /** The tool calls the run makes, in order. */
  toolCalls: string[];
  /** How many of their results are errors. */
  toolErrors: number;
  /** What the seed does as the user while the run waits. */
  interaction?:
    | { kind: "question"; answers: Record<string, string[]> }
    | { kind: "approval"; decision: "allow-once"; command: string };
  /** A bot-to-bot message: the recipient's run must reply in this session. */
  recipientSession?: string;
};

export const SCENARIO_EXAMPLES: ScenarioExample[] = [
  {
    // Opened by a person first: a bot may ask questions only in a session a
    // person owns, and messages from Pip arrive here.
    botId: "marlow",
    slug: "main",
    label: "Notes for Pip",
    prompt: "Reply with a note on Saturday's plan.",
    finalText: "Happy to help. The plan looks sound; I would leave half an hour earlier.",
    toolCalls: [],
    toolErrors: 0,
  },
  {
    botId: "pip",
    slug: "ask-marlow",
    label: "Ask Marlow about the plan",
    prompt: "Message your partner about Saturday's plan.",
    finalText:
      "Marlow replied:\n\n> Happy to help. The plan looks sound; I would leave half an hour earlier.",
    toolCalls: ["sessions_send"],
    toolErrors: 0,
    recipientSession: "agent:marlow:main",
  },
  {
    botId: "main",
    slug: "show-your-work",
    label: "Show your work",
    prompt: "Show your work: what is in your workspace?",
    finalText: "I listed my workspace and read my instructions. Both steps are shown above.",
    toolCalls: ["ls", "read"],
    toolErrors: 0,
  },
  {
    botId: "main",
    slug: "failed-step",
    label: "A step that fails",
    prompt: "Use a tool that fails, then carry on.",
    finalText: "That file does not exist, so the step failed. I will carry on without it.",
    toolCalls: ["read"],
    toolErrors: 1,
  },
  {
    botId: "main",
    slug: "coding-handoff",
    label: "Hand off to the coding agent",
    prompt: "Ask the coding agent to add a dark mode toggle.",
    finalText: "The coding agent picked it up: https://coding-agent.example/threads/thread-1",
    toolCalls: ["coder__send_message"],
    toolErrors: 0,
  },
  {
    botId: "pip",
    slug: "route-question",
    label: "Which route on Saturday",
    prompt: "Ask me a question before you plan the route.",
    finalText: "Thanks. You answered:\n\n- route: Lake loop",
    toolCalls: ["ask_user"],
    toolErrors: 0,
    interaction: { kind: "question", answers: { route: ["Lake loop"] } },
  },
  {
    botId: SHELL_BOT,
    slug: "list-workspace",
    label: "List the workspace (approved)",
    prompt: "Run a command I can approve: list your workspace.",
    finalText: "The command ran once you approved it, and its output is shown above.",
    toolCalls: ["exec"],
    toolErrors: 0,
    interaction: { kind: "approval", decision: "allow-once", command: "ls" },
  },
];
