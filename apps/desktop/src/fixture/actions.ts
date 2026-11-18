// Action card scenes (docs/design/conversation.md, sections 7 to 9 and 22,
// "What needs a fixture scene"). Each scene is written in the gateway's own
// shapes, `chat.history` rows or `agent` events, as the scenario check
// recorded them (docs/decisions.md, "What each kind of tool call looks like")
// and as the design's samples give them, and goes through the engine itself
// (`mapHistory`, `runsFromHistory`, `applyAgentEvent`), so the fixture draws
// what a gateway's events would. Invented content only.

import {
  applyAgentEvent,
  applyQuestionRequested,
  applyQuestionResolved,
  askUserQuestionId,
  emptyActivity,
  INTERACTIVE_SCOPES,
  mapHistory,
  RawTable,
  retainActivity,
  runsFromHistory,
  type ClawtrateState,
  type EngineContext,
  type OutgoingMessage,
  type TaskActivity,
  type Transcript,
} from "@clawtrate/core";
import { OPEN_TASK } from "./data.ts";

export const ACTION_SCENES = [
  "actions-short",
  "actions-long",
  "actions-thought",
  "actions-running",
  "actions-failed",
  "actions-mixed",
  "actions-kinds",
  "actions-becoming-fold",
  "actions-history",
  "actions-question",
  "actions-retained",
  "actions-retained-history",
] as const;

export type ActionScene = (typeof ACTION_SCENES)[number];

const SECOND = 1000;
type Rec = Record<string, unknown>;

/** One call: its name, arguments and result, as the gateway sends them. */
type Call = {
  name: string;
  args: Rec;
  text?: string;
  details?: Rec;
  isError?: boolean;
  /** Seconds it took. */
  took?: number;
  /** Still running: no result row. */
  open?: boolean;
  commandBearing?: boolean;
};

/** An item of a run, in order. */
type Part = { call: Call } | { text: string } | { thinking: string; took?: number };

const diff = (path: string, added: string[], removed: string[] = []) =>
  [
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,3 +1,6 @@",
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
const exec = (command: string, text: string, exitCode = 0, took = 0.8): Call => ({
  name: "exec",
  args: { command, workdir: "~/house" },
  commandBearing: true,
  text,
  details: {
    status: "completed",
    exitCode,
    exitSignal: null,
    exitReason: "exit",
    durationMs: took * 1000,
    aggregated: "",
    noOutputTimedOut: false,
    cwd: "~/house",
  },
  took,
});
const read = (path: string, text: string, took = 0.3): Call => ({
  name: "read",
  args: { path },
  text,
  details: { kind: "file", content: "" },
  took,
});
const edit = (path: string, added: string[]): Call => ({
  name: "edit",
  args: { path, edits: [{ oldText: "", newText: added.join("\n") }] },
  text: `Edited ${path}.`,
  details: { changed: true, diff: diff(path, added), firstChangedLine: 1, patch: "" },
  took: 0.2,
});
const search = (query: string, n: number, host: string): Call => ({
  name: "web_search",
  args: { query, count: 5 },
  text: `${n} results.`,
  details: {
    kind: "web_search_results",
    provider: "scripted",
    query,
    count: n,
    tookMs: 1600,
    results: Array.from({ length: n }, (_, i) => ({
      title: `Result ${i + 1}`,
      url: `https://${host}/r${i + 1}`,
    })),
  },
  took: 1.6,
});
const fetchPage = (url: string, title: string): Call => ({
  name: "web_fetch",
  args: { url, extractMode: "text" },
  text: `${title}\n\nField data…`,
  details: { title, status: 200, text: "Field data…" },
  took: 1.1,
});
const browser = (args: Rec, took = 0.6): Call => ({ name: "browser", args, text: "ok", took });

const LOG = [
  "02:14:00 backup: starting weekly run",
  "02:14:02 backup: source /srv/media (812 GB)",
  "02:19:40 backup: transfer 187 GB",
  "03:25:01 backup: verify ok",
  "03:25:03 backup: finished ok",
  "03:25:03 backup: next run 2026-11-17 02:14",
].join("\n");

/** The runs of each scene, each with the person's message that started it. */
type Turn = { user: string; parts: Part[]; ending?: "stopped" | "error" };

function scene(name: ActionScene): Turn[] {
  switch (name) {
    case "actions-short":
      return [
        {
          user: "Is last night's backup log there, and did it finish?",
          parts: [
            { call: read("logs/backup-2026-11-15.log", LOG, 0.6) },
            {
              call: exec(
                "tail -n 2 logs/backup-2026-11-15.log",
                "03:25:03 backup: finished ok\n03:25:03 backup: next run 2026-11-17 02:14",
                0,
                0.1,
              ),
            },
            {
              text: "Yes. The log is there, and the backup finished at 3:25 AM. The next run is tonight at 2:14.",
            },
          ],
        },
      ];
    case "actions-thought":
      return [
        {
          user: "Is a heat pump worth it in a cold, damp town?",
          parts: [
            {
              thinking:
                "The user asks whether a heat pump is worth it in a cold, damp town. I know the general answer: it depends on insulation and the size of the unit.\n\nThe honest reply is a short yes-if, with the two things to check first.",
              took: 8,
            },
            {
              text: "Usually yes, if two things are true: the house holds its heat, and the unit is sized for your coldest week, not an average one. Damp air makes the unit defrost more often, which costs a little efficiency, not a lot.",
            },
          ],
        },
      ];
    case "actions-long": {
      const parts: Part[] = [
        { text: "On it. Checking what we already know about the house first." },
        {
          call: {
            name: "memory_search",
            args: { query: "loft insulation" },
            text: "1 result.",
            details: {
              results: [
                { path: "memory/2026-09-14.md", snippet: "Loft insulation is 100 mm.", score: 0.8 },
              ],
            },
            took: 0.3,
          },
        },
        {
          call: {
            name: "memory_search",
            args: { query: "heating bills" },
            text: "1 result.",
            details: {
              results: [
                {
                  path: "memory/2026-03-02.md",
                  snippet: "Gas last winter: about 14,800 kWh.",
                  score: 0.7,
                },
              ],
            },
            took: 0.3,
          },
        },
        {
          thinking:
            "The floor plan and the bills give the heat demand. I should read them before searching.",
          took: 3,
        },
        {
          call: read(
            "house/floor-plan.md",
            "Ground floor 52 m²\nFirst floor 48 m²\nLoft (unconverted)",
            0.2,
          ),
        },
        {
          call: read("house/energy-bills-2025.csv", "month,kwh\njan,2410\nfeb,2105\nmar,1820", 0.2),
        },
        {
          call: {
            name: "read",
            args: { path: "house/epc-2019.pdf" },
            isError: true,
            text: "ENOENT: no such file or directory, open 'house/epc-2019.pdf'",
            took: 0.1,
          },
        },
        {
          call: read(
            "house/epc-2023.pdf",
            "Energy rating: D (61)\nMain heating: gas boiler, radiators",
            0.4,
          ),
        },
        {
          call: {
            name: "ls",
            args: { path: "house/quotes" },
            text: "boiler-2024.pdf\nwindows-2023.pdf",
            details: { content: "" },
            took: 0.1,
          },
        },
        {
          call: {
            name: "progress_card",
            args: {
              plan: [
                { step: "What fits the house", status: "in_progress" },
                { step: "What it costs after the rebate", status: "pending" },
                { step: "Book a survey if it is worth it", status: "pending" },
              ],
            },
            text: "Saved the plan.",
            details: { revision: 1, steps: {} },
            took: 0.1,
          },
        },
        {
          text: "The house loses most heat through the loft. Now what the market says about cold, damp winters.",
        },
        { call: search("air source heat pump cold damp climate", 5, "energy.example.org") },
        { call: search("heat pump sizing 100 m2 house", 5, "sizing.example.com") },
        { call: search("heat pump rebate 2026", 3, "grants.example.org") },
        { call: fetchPage("https://energy.example.org/cold-climate", "Heat pumps below freezing") },
        { call: fetchPage("https://sizing.example.com/guide", "Sizing a heat pump") },
        { call: fetchPage("https://grants.example.org/2026", "Rebates for 2026") },
        { call: fetchPage("https://grants.example.org/apply", "How to apply") },
        {
          call: fetchPage(
            "https://forum.example.net/t/damp-winters",
            "Damp winters and defrost cycles",
          ),
        },
        {
          call: {
            name: "x_search",
            args: { query: "heat pump rebate 2026 wait times" },
            text: "Posts mention a six-week wait for the rebate.",
            details: {
              content: "Posts mention a six-week wait…",
              citations: ["https://x.example/a/1", "https://x.example/b/2"],
            },
            took: 3.1,
          },
        },
        {
          text: "Prices next. The installer's site only quotes through its form, so I am using the browser.",
        },
        { call: browser({ action: "open", targetUrl: "https://installer.example/quote" }, 1.3) },
        {
          call: browser({
            action: "act",
            targetUrl: "https://installer.example/quote",
            request: { kind: "type", ref: "e4", element: "Postcode", text: "AB1 2CD" },
          }),
        },
        {
          call: browser({
            action: "act",
            targetUrl: "https://installer.example/quote",
            request: { kind: "click", ref: "e9", text: "Semi-detached" },
          }),
        },
        {
          call: browser({
            action: "act",
            targetUrl: "https://installer.example/quote",
            request: { kind: "type", ref: "e12", element: "Floor area", text: "100" },
          }),
        },
        {
          call: browser({
            action: "act",
            targetUrl: "https://installer.example/quote",
            request: { kind: "click", ref: "e15", text: "8 kW" },
          }),
        },
        {
          call: browser(
            {
              action: "act",
              targetUrl: "https://installer.example/quote",
              request: { kind: "click", ref: "e21", text: "Get my quote" },
            },
            2.4,
          ),
        },
        { call: browser({ action: "snapshot", targetUrl: "https://installer.example/quote" }) },
        { call: browser({ action: "screenshot", targetUrl: "https://installer.example/quote" }) },
        {
          call: browser({
            action: "act",
            targetUrl: "https://installer.example/quote",
            request: { kind: "click", ref: "e30", text: "Save quote" },
          }),
        },
        {
          call: {
            name: "progress_card",
            args: {
              plan: [
                { step: "What fits the house", status: "completed" },
                { step: "What it costs after the rebate", status: "in_progress" },
                { step: "Book a survey if it is worth it", status: "pending" },
              ],
            },
            text: "Saved the plan.",
            details: { revision: 2, steps: {} },
            took: 0.1,
          },
        },
        {
          call: exec(
            "python3 estimate.py --unit 8kw --loft 100",
            "Annual heat demand: 11,900 kWh",
            0,
            0.9,
          ),
        },
        {
          call: exec(
            "python3 estimate.py --unit 8kw --loft 270",
            "Annual heat demand: 9,400 kWh",
            0,
            0.9,
          ),
        },
        {
          call: exec(
            "python3 running-cost.py --scop 3.1 --kwh 9400",
            "Running cost: about £710 a year",
            0,
            0.4,
          ),
        },
        {
          call: exec(
            "python3 running-cost.py --gas --kwh 14800",
            "Running cost: about £960 a year",
            0,
            0.4,
          ),
        },
        {
          call: exec(
            "python3 payback.py --price 9800 --rebate 7500 --saving 250",
            "Payback: 9.2 years",
            0,
            0.3,
          ),
        },
        {
          call: edit("house/heat-pump.md", [
            "## Fit",
            "An 8 kW unit, once the loft is brought to 270 mm.",
          ]),
        },
        {
          call: edit("house/heat-pump.md", ["## Cost", "£9,800 quoted, £2,300 after the rebate."]),
        },
        { call: edit("house/costs.csv", ["heat-pump,2300", "loft-insulation,650"]) },
        {
          call: {
            name: "write",
            args: {
              path: "memory/2026-11-17.md",
              content: "Heat pump: worth it once the loft is insulated; survey booked for Dec 2.",
            },
            text: "Wrote 1 line.",
            details: {
              changed: true,
              created: true,
              diff: diff("memory/2026-11-17.md", [
                "Heat pump: worth it once the loft is insulated.",
              ]),
            },
            took: 0.1,
          },
        },
        {
          call: {
            name: "automations",
            args: {
              action: "add",
              job: {
                name: "Rebate deadline",
                schedule: { kind: "cron", expr: "0 9 * * 1" },
                payload: { kind: "agentTurn", message: "Remind me of the rebate deadline." },
              },
            },
            text: "Created.",
            details: { id: "job_4a", name: "Rebate deadline", enabled: true },
            took: 0.2,
          },
        },
        {
          call: {
            name: "progress_card",
            args: {
              plan: [
                { step: "What fits the house", status: "completed" },
                { step: "What it costs after the rebate", status: "completed" },
                { step: "Book a survey if it is worth it", status: "completed" },
              ],
            },
            text: "Saved the plan.",
            details: { revision: 3, steps: {} },
            took: 0.1,
          },
        },
        {
          call: {
            name: "conversations_send",
            args: {
              conversationRef: "conv_51c2",
              message: "Heat pump survey booked for Dec 2. Summary in the house folder.",
            },
            text: '{"status":"sent"}',
            details: {
              status: "sent",
              conversationRef: "conv_51c2",
              channel: "Telegram",
              messageId: "m_302",
            },
            took: 0.6,
          },
        },
        {
          call: {
            name: "tts",
            args: { text: "Your heat pump survey is booked for the second of December." },
            text: "Made 1 clip.",
            details: { audioPath: "media/survey.mp3" },
            took: 2.2,
          },
        },
        {
          text: "Worth it, once the loft is insulated. An 8 kW unit fits. After the 2026 rebate it costs about £2,300 and saves about £250 a year, so it pays back in roughly nine years. I couldn't find the 2019 energy certificate; the 2023 one says D.",
        },
      ];
      return [
        {
          user: "Get the heat pump decision ready: what fits the house, what it costs after the rebate, and book a survey if it is worth it.",
          parts,
        },
      ];
    }
    case "actions-failed":
      return [
        {
          user: "Copy last week's log next to this one and check the disk.",
          parts: [
            { call: read("logs/backup-2026-11-15.log", LOG, 0.4) },
            {
              call: {
                name: "read",
                args: { path: "logs/backup-2026-11-08.log" },
                isError: true,
                text: "ENOENT: no such file or directory, open 'logs/backup-2026-11-08.log'",
                took: 0.1,
              },
            },
            { call: read("logs/prune-2026-11.log", "prune: 12 snapshots kept", 0.2) },
            { text: "Last week's log is missing. Checking the disk now." },
            {
              call: exec(
                "grep -c transcode /etc/backup/exclude",
                "0\n\n(Command exited with code 1)",
                1,
                0.1,
              ),
            },
            {
              call: {
                name: "exec",
                args: {
                  command: "rsync -a /srv/media/ nas:/backups/media-box/",
                  timeoutSeconds: 120,
                },
                commandBearing: true,
                isError: true,
                text: "Command timed out after 120 seconds.",
                details: { status: "failed", timedOut: true, failureKind: "overall-timeout" },
                took: 120,
              },
            },
            {
              call: {
                name: "x_search",
                args: { query: "heat pump rebate 2026 experiences" },
                text: '{"error":"missing_xai_api_key"}',
                details: {
                  error: "missing_xai_api_key",
                  message: "x_search needs xAI credentials. Sign in on the gateway, then retry.",
                },
                took: 0.1,
              },
            },
            {
              text: "The copy timed out after its two minute limit, and last week's log isn't there.",
            },
          ],
        },
      ];
    case "actions-mixed":
      return [
        {
          user: "Look through memory, make two sketches and tidy the backup folder.",
          parts: [
            {
              call: {
                name: "memory_search",
                args: { query: "gutters" },
                text: "1 result.",
                details: {
                  results: [
                    {
                      path: "memory/2026-09-30.md",
                      snippet: "Gutters cleared before the storm.",
                      score: 0.7,
                    },
                  ],
                  partial: true,
                },
                took: 5,
              },
            },
            {
              call: {
                name: "memory_search",
                args: { query: "loft insulation" },
                text: "Memory search is unavailable.",
                details: {
                  results: [],
                  disabled: true,
                  unavailable: true,
                  warning: "Memory search is unavailable for this bot",
                },
                took: 0.1,
              },
            },
            {
              call: {
                name: "memory_search",
                args: { query: "boiler" },
                text: "2 results.",
                details: {
                  results: [
                    { path: "memory/a.md", snippet: "x" },
                    { path: "memory/b.md", snippet: "y" },
                  ],
                },
                took: 0.3,
              },
            },
            { text: "Starting the sketches." },
            {
              call: {
                name: "image_generate",
                args: {
                  action: "generate",
                  prompt: "A small house in snow with a heat pump outside",
                  count: 1,
                },
                text: "Background task started for image generation (task_91a2).",
                details: { async: true, status: "started", taskId: "task_91a2" },
                took: 0.4,
              },
            },
            {
              call: {
                name: "image_generate",
                args: { action: "generate", prompt: "The same house at dusk", count: 2 },
                text: "Made 2 images.",
                details: { count: 2, paths: ["media/house-dusk-1.png", "media/house-dusk-2.png"] },
                took: 11.2,
              },
            },
            { text: "Now the backup folder." },
            {
              call: {
                name: "exec",
                args: { command: "mv /srv/media/old /srv/scratch/old" },
                commandBearing: true,
                isError: true,
                text: "mv: cannot move: Permission denied",
                took: 0.2,
              },
            },
            { call: exec("du -sh /srv/scratch", "4.0K\t/srv/scratch", 0, 0.3) },
            {
              call: {
                name: "exec",
                args: { command: "rm -rf /srv/media/transcode-cache" },
                commandBearing: true,
                text: "Approval pending.",
                details: {
                  status: "approval-pending",
                  approvalId: "approval-rm",
                  allowedDecisions: ["allow-once", "deny"],
                },
                took: 0.2,
              },
            },
          ],
        },
      ];
    case "actions-kinds":
      return [
        {
          user: "Show me one of everything you can do.",
          parts: [
            { call: read("notes.md", "one\ntwo") },
            {
              call: {
                name: "ls",
                args: { path: "logs" },
                text: "a.log\nb.log",
                details: { content: "" },
              },
            },
            { call: edit("notes/house-log.md", ["## Nov 16", "The backup ran long."]) },
            {
              call: {
                name: "write",
                args: {
                  path: "memory/2026-11-17.md",
                  content: "Dana wants the boiler serviced in October.",
                },
                text: "Wrote 1 line.",
                details: {
                  changed: true,
                  created: true,
                  diff: diff("memory/2026-11-17.md", ["x"]),
                },
              },
            },
            {
              call: {
                name: "memory_search",
                args: { query: "boiler service" },
                text: "2 results.",
                details: {
                  results: [
                    { path: "memory/a.md", snippet: "x" },
                    { path: "memory/b.md", snippet: "y" },
                  ],
                },
              },
            },
            { call: exec("du -sh /srv/media/*", "182G\t/srv/media/transcode-cache") },
            {
              call: {
                name: "terminal",
                args: { action: "list" },
                text: '{"sessions":[]}',
                details: { sessions: [] },
              },
            },
            { call: search("cold climate heat pump", 5, "energy.example.org") },
            {
              call: {
                name: "x_search",
                args: { query: "heat pump rebate" },
                text: "Posts mention a wait.",
                details: { content: "x", citations: ["https://x.example/1"] },
              },
            },
            { call: fetchPage("https://energy.example.org/cold", "Heat pumps below freezing") },
            { call: browser({ action: "open", targetUrl: "https://shop.example/basket" }) },
            {
              call: {
                name: "computer",
                args: { action: "screenshot", node: "study-mac" },
                text: "Screenshot taken.",
                details: { frameId: "f12" },
              },
            },
            {
              call: {
                name: "mobile_ui",
                args: { action: "observe", node: "phone" },
                text: "Snapshot s4.",
                details: { snapshotId: "s4" },
              },
            },
            { call: { name: "screen", args: { action: "desktop_show" }, text: "Shown." } },
            {
              call: {
                name: "automations",
                args: {
                  action: "add",
                  job: {
                    name: "Weekly cleanup",
                    schedule: { kind: "cron", expr: "0 9 * * 1", tz: "Europe/London" },
                    payload: { kind: "agentTurn", message: "Clear the cache." },
                  },
                },
                text: "Created.",
                details: { id: "job_3f2a", name: "Weekly cleanup", enabled: true },
              },
            },
            {
              call: {
                name: "sessions_list",
                args: { limit: 5 },
                text: "5 sessions.",
                details: { count: 5, sessions: [], hasMore: false },
              },
            },
            {
              call: {
                name: "sessions_spawn",
                args: { label: "Price check", task: "Find the current prices." },
                text: "Accepted.",
                details: {
                  status: "accepted",
                  childSessionKey: "agent:otto:subagent:price-check",
                  runId: "run_c41e",
                },
              },
            },
            {
              call: {
                name: "progress_card",
                args: {
                  plan: [
                    { step: "Read", status: "completed" },
                    { step: "Write", status: "pending" },
                  ],
                },
                text: "Saved the plan.",
                details: { revision: 1, steps: {} },
              },
            },
            {
              call: {
                name: "image_generate",
                args: { action: "generate", prompt: "A house in snow", count: 2 },
                text: "Made 2 images.",
                details: { count: 2, paths: ["media/a.png", "media/b.png"] },
              },
            },
            {
              call: {
                name: "pdf",
                args: { pdfs: ["a.pdf", "b.pdf", "c.pdf"], prompt: "Compare them." },
                text: "EPC 2023: D",
              },
            },
            {
              call: {
                name: "conversations_send",
                args: { conversationRef: "conv_1", message: "Survey booked for Dec 2." },
                text: '{"status":"sent"}',
                details: { status: "sent", channel: "Telegram" },
              },
            },
            {
              call: {
                name: "linear__create_issue",
                args: { title: "Exclude the cache" },
                text: 'structuredContent:\n{"id":"HOME-42"}',
                details: {
                  mcpServer: "linear",
                  mcpTool: "create_issue",
                  structuredContent: { id: "HOME-42" },
                },
              },
            },
            {
              call: { name: "skills_search", args: { query: "invoice" }, text: "2 skills match." },
            },
            { text: "That is one of each." },
          ],
        },
      ];
    case "actions-history":
      return [
        {
          user: "Read the six backup logs from this month.",
          parts: [
            ...[
              "2026-11-01",
              "2026-11-02",
              "2026-11-03",
              "2026-11-04",
              "2026-11-05",
              "2026-11-06",
            ].map((day) => ({
              call: read(`logs/backup-${day}.log`, `${day} backup: finished ok`, 0.2),
            })),
            { text: "All six finished." },
          ],
        },
      ];
    case "actions-question":
      // A question the gateway refused before registering it, a read, then the question it asked.
      return [
        {
          user: "Plan Saturday's errands around the backup window.",
          parts: [
            { call: read("logs/backup-2026-11-15.log", LOG, 0.2) },
            {
              call: {
                name: "ask_user",
                args: { questions: [] },
                text: "questions must contain at least one question",
                isError: true,
                took: 0.1,
              },
            },
            { call: read("notes/errands.md", "Hardware store\nLibrary returns\nPost office", 0.2) },
            {
              call: {
                name: "ask_user",
                args: {
                  questions: [
                    {
                      questionId: "route",
                      header: "Route",
                      question: "Which route on Saturday?",
                      options: [{ label: "Lake loop" }, { label: "Town centre" }],
                    },
                  ],
                },
                text: JSON.stringify({ status: "answered" }),
                details: { status: "answered", answers: { answers: { route: ["Lake loop"] } } },
                took: 30,
              },
            },
            {
              text: "Lake loop it is: hardware store first, then the library and the post office.",
            },
          ],
        },
      ];
    default:
      return [];
  }
}

/** The question the scene's valid `ask_user` call (`call_1_04` of `run-1`) registered, answered. */
function sceneQuestions(now: number): Pick<TaskActivity, "questions"> {
  const id = askUserQuestionId("run-1", "call_1_04");
  const ctx: EngineContext = { sessionKey: OPEN_TASK, now, raw: new RawTable() };
  const record = {
    id,
    questions: [
      {
        questionId: "route",
        header: "Route",
        question: "Which route on Saturday?",
        options: [{ label: "Lake loop" }, { label: "Town centre" }],
      },
    ],
    agentId: "otto",
    sessionKey: OPEN_TASK,
    runId: "run-1",
    createdAtMs: now - 29 * 60 * SECOND,
    expiresAtMs: now + 60 * SECOND,
    status: "pending",
  };
  const answered = { id, status: "answered", answers: { answers: { route: ["Lake loop"] } } };
  const activity = applyQuestionResolved(
    applyQuestionRequested(emptyActivity, record, ctx),
    answered,
    {
      via: "question.resolved",
      record: answered,
    },
  );
  return { questions: activity.questions };
}

// History -------------------------------------------------------------------------------

/** A scene's turns as `chat.history` rows, as the gateway returns them. */
function historyRows(turns: Turn[], start: number): unknown[] {
  const rows: unknown[] = [];
  let at = start;
  let row = 0;
  turns.forEach((turn, t) => {
    const runId = `run-${t + 1}`;
    const meta = () => ({ id: `row-${(row += 1)}`, runId });
    rows.push({
      role: "user",
      content: turn.user,
      timestamp: at,
      __openclaw: { id: `row-${(row += 1)}` },
    });
    at += 2 * SECOND;
    let content: Rec[] = [];
    const flush = () => {
      if (content.length)
        rows.push({
          role: "assistant",
          content,
          timestamp: at,
          model: "scripted/dev-1",
          __openclaw: meta(),
        });
      content = [];
    };
    turn.parts.forEach((part, i) => {
      if ("thinking" in part) {
        content.push({ type: "thinking", thinking: part.thinking });
        at += (part.took ?? 1) * SECOND;
      } else if ("text" in part) {
        content.push({ type: "text", text: part.text });
      } else {
        const id = `call_${t + 1}_${String(i + 1).padStart(2, "0")}`;
        content.push({ type: "toolCall", id, name: part.call.name, arguments: part.call.args });
        flush();
        if (part.call.open) return;
        at += Math.round((part.call.took ?? 0.4) * SECOND);
        rows.push({
          role: "toolResult",
          toolCallId: id,
          toolName: part.call.name,
          content: [{ type: "text", text: part.call.text ?? "" }],
          isError: part.call.isError === true,
          ...(part.call.details ? { details: part.call.details } : {}),
          timestamp: at,
          __openclaw: meta(),
        });
      }
    });
    flush();
    at += 20 * SECOND;
  });
  return rows;
}

/** The transcript the engine builds from a scene's history. */
function fromHistory(turns: Turn[], now: number): Pick<Transcript, "items" | "runs"> {
  const rows = historyRows(turns, now - 30 * 60 * SECOND);
  const ctx: EngineContext = { sessionKey: OPEN_TASK, now, raw: new RawTable() };
  return { items: mapHistory(rows), runs: runsFromHistory(rows, null, ctx) };
}

// Live ----------------------------------------------------------------------------------

/**
 * A run in progress, from `agent` events: a read that finished, a second read
 * that finished, text beside the next call, and a command still running.
 */
function liveRun(
  now: number,
  upTo = Infinity,
): { activity: TaskActivity; message: OutgoingMessage } {
  const ctx: EngineContext = { sessionKey: OPEN_TASK, now, raw: new RawTable() };
  const runId = "run-live";
  const t0 = now - 40 * SECOND;
  let seq = 0;
  let activity: TaskActivity = emptyActivity;
  const events: Array<[number, string, Rec]> = [
    [0, "lifecycle", { phase: "start", startedAt: t0 }],
    [1, "thinking", { text: "The log first, then last week's, then the disk." }],
    [
      3,
      "item",
      {
        kind: "tool",
        toolCallId: "call_l1",
        name: "read",
        phase: "start",
        startedAt: t0 + 3 * SECOND,
      },
    ],
    [
      3,
      "tool",
      {
        toolCallId: "call_l1",
        name: "read",
        phase: "start",
        args: { path: "logs/backup-2026-11-15.log" },
      },
    ],
    [
      4,
      "tool",
      {
        toolCallId: "call_l1",
        name: "read",
        phase: "result",
        result: { content: [{ type: "text", text: LOG }], details: { kind: "file", content: "" } },
      },
    ],
    [
      4,
      "item",
      {
        kind: "tool",
        toolCallId: "call_l1",
        name: "read",
        phase: "end",
        startedAt: t0 + 3 * SECOND,
        endedAt: t0 + 4 * SECOND,
      },
    ],
    [
      5,
      "item",
      {
        kind: "tool",
        toolCallId: "call_l2",
        name: "read",
        phase: "start",
        startedAt: t0 + 5 * SECOND,
      },
    ],
    [
      5,
      "tool",
      {
        toolCallId: "call_l2",
        name: "read",
        phase: "start",
        args: { path: "logs/prune-2026-11.log" },
      },
    ],
    [
      6,
      "tool",
      {
        toolCallId: "call_l2",
        name: "read",
        phase: "result",
        result: {
          content: [{ type: "text", text: "prune: 12 snapshots kept" }],
          details: { kind: "file", content: "" },
        },
      },
    ],
    [
      6,
      "item",
      {
        kind: "tool",
        toolCallId: "call_l2",
        name: "read",
        phase: "end",
        startedAt: t0 + 5 * SECOND,
        endedAt: t0 + 6 * SECOND,
      },
    ],
    [
      8,
      "item",
      {
        kind: "preamble",
        itemId: "pre_1",
        phase: "update",
        progressText: "Both logs are fine. Checking how full the disk is.",
      },
    ],
    [
      8,
      "item",
      {
        kind: "preamble",
        itemId: "pre_1",
        phase: "end",
        progressText: "Both logs are fine. Checking how full the disk is.",
      },
    ],
    [
      9,
      "item",
      {
        kind: "tool",
        toolCallId: "call_l3",
        name: "exec",
        phase: "start",
        startedAt: t0 + 9 * SECOND,
        commandBearing: true,
      },
    ],
    [
      9,
      "tool",
      {
        toolCallId: "call_l3",
        name: "exec",
        phase: "start",
        args: { command: "du -sh /srv/media/*", workdir: "/srv/media" },
      },
    ],
    [
      12,
      "tool",
      {
        toolCallId: "call_l3",
        name: "exec",
        phase: "update",
        partialResult: { content: [{ type: "text", text: "182G\t/srv/media/transcode-cache\n" }] },
      },
    ],
  ];
  for (const [offset, stream, data] of events) {
    if (offset > upTo) break;
    seq += 1;
    activity = applyAgentEvent(
      activity,
      { runId, seq, stream, ts: t0 + offset * SECOND, sessionKey: OPEN_TASK, data },
      { ...ctx, now: t0 + offset * SECOND },
    ).activity;
  }
  const message: OutgoingMessage = {
    id: "msg-live",
    text: "Is last night's backup log fine, and how full is the disk?",
    mode: "new",
    status: "sent",
    runId,
    messageSeq: null,
    leftAt: t0,
    createdAt: t0,
    error: null,
    attachments: [],
  };
  activity = {
    ...activity,
    runs: activity.runs.map((run) =>
      run.id === runId ? { ...run, messageId: message.id, origin: "local" as const } : run,
    ),
  };
  return { activity, message };
}

/**
 * A finished run of 400 reads, with text written before the 390th, through
 * the engine's retention: it keeps the newest 128 and counts the others.
 */
function retainedRun(now: number): TaskActivity {
  const ctx: EngineContext = { sessionKey: OPEN_TASK, now, raw: new RawTable() };
  const runId = "run-retained";
  const t0 = now - 10 * 60 * SECOND;
  let seq = 0;
  let activity: TaskActivity = emptyActivity;
  const apply = (at: number, stream: string, data: Rec) => {
    seq += 1;
    activity = applyAgentEvent(
      activity,
      { runId, seq, stream, ts: at, sessionKey: OPEN_TASK, data },
      { ...ctx, now: at },
    ).activity;
  };
  apply(t0, "lifecycle", { phase: "start", startedAt: t0 });
  for (let i = 1; i <= 400; i += 1) {
    const at = t0 + i * SECOND;
    const id = `call_r${String(i).padStart(3, "0")}`;
    const path = `logs/scan-${String(i).padStart(3, "0")}.log`;
    if (i === 390)
      apply(at, "item", {
        kind: "preamble",
        itemId: "pre_r",
        phase: "end",
        progressText: "The last eleven logs are this week's.",
      });
    apply(at, "item", {
      kind: "tool",
      toolCallId: id,
      name: "read",
      phase: "start",
      startedAt: at,
    });
    apply(at, "tool", { toolCallId: id, name: "read", phase: "start", args: { path } });
    apply(at + 300, "tool", {
      toolCallId: id,
      name: "read",
      phase: "result",
      result: { content: [{ type: "text", text: `scan ${i}: ok` }], details: { kind: "file" } },
    });
    apply(at + 300, "item", {
      kind: "tool",
      toolCallId: id,
      name: "read",
      phase: "end",
      startedAt: at,
      endedAt: at + 300,
    });
    activity = retainActivity(activity);
  }
  apply(t0 + 401 * SECOND, "lifecycle", { phase: "end", endedAt: t0 + 401 * SECOND });
  return retainActivity(activity);
}

/**
 * A finished run of 150 reads read from history: its rows hold all 150 calls,
 * and the engine's retention keeps the newest 128 steps of them.
 */
function retainedHistory(now: number): Pick<Transcript, "items" | "runs"> {
  const reads = Array.from({ length: 150 }, (_, i) => ({
    call: read(`logs/scan-${String(i + 1).padStart(3, "0")}.log`, `scan ${i + 1}: ok`, 0.1),
  }));
  const turns: Turn[] = [
    { user: "Scan every log this month.", parts: [...reads, { text: "All 150 are fine." }] },
  ];
  const rows = historyRows(turns, now - 30 * 60 * SECOND);
  const ctx: EngineContext = { sessionKey: OPEN_TASK, now, raw: new RawTable() };
  const runs = retainActivity({ ...emptyActivity, runs: runsFromHistory(rows, null, ctx) }).runs;
  return { items: mapHistory(rows), runs };
}

// Scenes --------------------------------------------------------------------------------

const withOpenTask = (
  state: ClawtrateState,
  change: (t: Transcript) => Transcript,
): ClawtrateState => ({
  ...state,
  transcripts: { ...state.transcripts, [OPEN_TASK]: change(state.transcripts[OPEN_TASK]!) },
});

const interactive = (state: ClawtrateState): ClawtrateState => ({
  ...state,
  connection: {
    ...state.connection,
    scopes: [...INTERACTIVE_SCOPES],
    requestedScopes: [...INTERACTIVE_SCOPES],
    canWrite: true,
    canAnswer: true,
    canApprove: true,
  },
});

export function isActionScene(value: string | null): value is ActionScene {
  return value !== null && (ACTION_SCENES as readonly string[]).includes(value);
}

/** A scene's state, from the loaded fixture state; `steps` change it as time passes. */
export function actionScene(
  name: ActionScene,
  base: ClawtrateState,
  now: number,
): {
  initial: ClawtrateState;
  steps: Array<{ after: number; change: (s: ClawtrateState) => ClawtrateState }>;
} {
  if (name === "actions-running") {
    const { activity, message } = liveRun(now);
    return {
      initial: withOpenTask(interactive(base), (t) => ({
        ...t,
        ...activity,
        items: t.items,
        outbox: [message],
      })),
      steps: [],
    };
  }
  if (name === "actions-retained") {
    const activity = retainedRun(now);
    return {
      initial: withOpenTask(base, (t) => ({ ...t, ...activity, items: [], outbox: [] })),
      steps: [],
    };
  }
  if (name === "actions-becoming-fold") {
    // One read finished; a second read with the same key starts after a moment: the card becomes a fold.
    const first = liveRun(now, 4);
    const second = liveRun(now, 6);
    return {
      initial: withOpenTask(interactive(base), (t) => ({
        ...t,
        ...first.activity,
        outbox: [first.message],
      })),
      steps: [
        {
          after: 1500,
          change: (state) =>
            withOpenTask(state, (t) => ({ ...t, ...second.activity, outbox: [second.message] })),
        },
      ],
    };
  }
  const history =
    name === "actions-retained-history" ? retainedHistory(now) : fromHistory(scene(name), now);
  return {
    initial: withOpenTask(base, (t) => ({
      ...t,
      ...history,
      outbox: [],
      approvals: [],
      questions: name === "actions-question" ? sceneQuestions(now).questions : [],
    })),
    steps: [],
  };
}
