# Parity checklist

This is Clawtrate's definition of done. Each row is one behavior that a single automated check can verify. The behavior comes from the Grok Bot teardown in `docs/research/grok-bot-flows.md`; the section in the area column points to the evidence and the exact wording.

Columns:

- **id**: stable. Never renumber. New rows get the next free id at the end.
- **area**: the flow, with the teardown section that describes it.
- **platform**: where Clawtrate must pass the check: `desktop`, `iOS` or `both`.
- **Grok Bot behavior**: what Grok Bot does, in one or two sentences. For fine-grained control rows it says what Grok Bot lacks.
- **Clawtrate target**: `same`, or `better:` followed by what Clawtrate changes. A note after `same` narrows the scope; it does not change the behavior. Use Clawtrate's own names, art and branding, never Grok's.
- **gateway dependency**: filled in by the gateway capability map. `unknown` until then.
- **status**: `todo`, then `done` with a passing check, or `gap` with evidence that it cannot be done without breaking a rule.

Fine-grained control requirements (`FC-01` to `FC-15`, defined in the teardown under "What users say is missing") are tagged in the target column.

Rows in "Vendor services" exist for completeness. They depend on services a self-hosted gateway does not have, and are likely to end as `gap`.

| id | area | platform | Grok Bot behavior | Clawtrate target | gateway dependency | status |
|---|---|---|---|---|---|---|
| F-001 | Onboarding (§1) | both | First launch shows a welcome screen with the product mark, a one-line tagline and one primary action ("Sign in"; on iPhone "Log in" and "Sign up"). | better: the primary action is "Connect a gateway"; no vendor account. | unknown | todo |
| F-002 | Onboarding (§1) | both | Sign-in finishes in the browser on a page that says all set and offers a button back to the app. | better: pairing with the gateway happens in the app; a pending-approval screen lists the exact operator scopes requested. | unknown | todo |
| F-003 | Onboarding (§1) | both | While the cloud computer is set up, the window shows the mark and one progress line ("Setting up Grok Bot's computer", "Starting your computer"); newer builds open the app while it starts. | better: a step list (connecting, pairing, loading Bots) and the app opens read-only as soon as Bots load. | unknown | todo |
| F-004 | Onboarding (§1) | desktop | A short intro ends on "What do you use every day?": a search box, a grid of twelve app tiles to tick, "Next" and "Back". Ticking does not connect anything. | same | unknown | todo |
| F-005 | Onboarding (§1) | both | Setup creates a first Bot and opens its chat, with the composer placeholder "Message &lt;Bot&gt;". | better: if the gateway already has agents they appear as Bots; a first Bot is created only when there are none. | unknown | todo |
| F-006 | Onboarding (§1) | both | A new Bot speaks first: "Working on it" for 5–10 s, then a greeting bubble and a question card. | same | unknown | todo |
| F-007 | Onboarding (§1) | both | With no primary Bot set, an "Introducing Primary Bot" dialog offers "Use an existing Bot" (searchable list, "Confirm") and "Create Primary Bot". | same | unknown | todo |
| F-008 | Onboarding (§1) | both | Settings, General, Import: copy a prompt, paste another assistant's answer, "Add to Memory"; the items go to the primary Bot. | better: the parsed items open in the memory viewer for review before they are saved. | unknown | todo |
| F-009 | Onboarding (§1) | both | Setup and sign-in failures show a titled message with a retry action ("Grok Bot couldn't finish setting up", "Authentication error"). | same; note: for gateway unreachable, pairing rejected and pairing expired | unknown | todo |
| F-010 | Onboarding (§1) | both | "Update required" covers the whole window when the client is too old. | better: also shown when the gateway protocol version is incompatible, naming both versions. | unknown | todo |
| F-011 | Onboarding (§1) | iOS | The app asks for notification permission during first run. | same | unknown | todo |
| F-012 | Sidebar (§2) | desktop | Round search and "New chat" (+) buttons sit at the top right of the sidebar. | same | unknown | todo |
| F-013 | Sidebar (§2) | desktop | Pinned Bots show as a grid of large avatar tiles, three per row, with the name centered below and truncated; the selected tile gets a lighter rounded background. | same | unknown | todo |
| F-014 | Sidebar (§2) | both | "Pin" in a Bot's menu moves it into the pinned area; "Unpin" moves it back; pins sync across devices. | same | unknown | todo |
| F-015 | Sidebar (§2) | both | The primary Bot's avatar carries a small orange circular badge with a white star at its lower right. | same | unknown | todo |
| F-016 | Sidebar (§2) | both | Right-click "Move to new section" creates a named section; "Move to" moves a Bot into one; section headers are small grey text; sections sync to iOS. | same | unknown | todo |
| F-017 | Sidebar (§2) | both | A list row shows a small avatar, the name, and one grey line previewing the latest message, truncated; iOS adds a right-aligned timestamp ("8:41 AM", "Yesterday"). | better: desktop rows also show the timestamp. | unknown | todo |
| F-018 | Sidebar (§2) | both | The row preview describes the latest item even when it is a form, photo, widget or approval request, instead of going blank. | same | unknown | todo |
| F-019 | Sidebar (§2) | both | A Bot's label shows as a small grey pill beside its name in the row. | same | unknown | todo |
| F-020 | Sidebar (§2) | both | While a Bot works, its sidebar avatar animates and the row's accessible name is "&lt;Bot&gt;, Working". | same | unknown | todo |
| F-021 | Sidebar (§2) | both | While a Bot waits for an answer, its row turns orange and the preview starts "Waiting for you"; the state clears as soon as nothing is pending. | same | unknown | todo |
| F-022 | Sidebar (§2) | both | A new result marks the row as unread; opening the chat marks it read; the menu has "Mark as Unread" / "Mark as Read". | same | unknown | todo |
| F-023 | Sidebar (§2) | desktop | The dock (or taskbar) badge shows unread activity. | same | unknown | todo |
| F-024 | Sidebar (§2) | desktop | While a routine run is in progress, the Bot's row shows a green dot. | same | unknown | todo |
| F-025 | Sidebar (§2) | desktop | The row menu lists Pin, Move to, Mark as Unread, Rename Bot, Copy conversation ID, Hide from sidebar, and Delete (or "Replace with different Bot" for the primary Bot), with icons and separators. | same | unknown | todo |
| F-026 | Sidebar (§2) | desktop | Double-clicking a Bot's name in the sidebar renames it inline; Enter saves. | same | unknown | todo |
| F-027 | Sidebar (§2) | both | "Hide from sidebar" moves a Bot into a collapsible "Hidden Bots" section at the foot with "Show in sidebar"; iOS uses "Unhide" and shows "Show Hidden Bots" when every Bot is hidden. Hidden Bots keep working. | same | unknown | todo |
| F-028 | Sidebar (§2) | desktop | Cmd/Ctrl+1–9 open sidebar Bots; Alt+Up/Down and Control+Tab move to the previous or next Bot. | same | unknown | todo |
| F-029 | Sidebar (§2) | both | Group chats appear in the same list as Bots, with a combined avatar and a preview prefixed with the speaker ("John: …"). | same | unknown | todo |
| F-030 | Sidebar (§2) | desktop | The sidebar footer has a wide "Connect apps" button with three app icons, the account menu, and a round update button ("Restart to update") when an update is ready. | same | unknown | todo |
| F-031 | Sidebar (§2) | both | Pinned Bots come first, then sections in creation order; within a list, Bots are ordered by latest activity (inferred). | better: the user can choose activity, name or manual order. | unknown | todo |
| F-032 | Sidebar (§2) | both | After the user answers a request to use their own computer, the row shows "Allowed", "Denied" or "Expired" instead of "Permission required". | same | unknown | todo |
| F-033 | Sidebar (§2) | both | Cmd/Ctrl+K opens a search palette over Bots, groups, messages, files, links, routines and settings; Cmd/Ctrl+Shift+F searches Bots; "Search older" extends past recent messages. | same | unknown | todo |
| F-034 | Bot setup (§3) | both | "+" or Cmd/Ctrl+N opens "Create New Bot": a name field, a shape picker, a color picker and "Create"; the new Bot's chat opens. | same | unknown | todo |
| F-035 | Bot setup (§3) | both | The create dialog shows a large live avatar preview; eight base shapes and eleven colors; the selected shape and swatch get a light ring. | same; note: own shape set and art, not Grok's | unknown | todo |
| F-036 | Bot setup (§3) | desktop | The "To:" field in New chat offers "Create new Bot" and "Create group chat"; typing narrows it to `Create "<name>" Bot`; an unnamed create makes "New Bot". | same | unknown | todo |
| F-037 | Bot setup (§3) | both | Clicking the avatar in details opens tabs "Bot" (look), "Generate" (describe, Generate, Set avatar) and "Upload" (drop or Browse files, crop, Set avatar, under 25 MB); iOS offers Choose from Photos or Take Photo. | same; note: Generate depends on an image tool | unknown | todo |
| F-038 | Bot setup (§3) | both | Clicking the name in details edits it in place (desktop); on iOS, Edit, Name, Done. Only the owner can rename. | same | unknown | todo |
| F-039 | Bot setup (§3) | both | The label is edited in place in details; its empty state reads "Add a label" in grey. | same | unknown | todo |
| F-040 | Bot setup (§3) | both | Personal Bots have no visible instructions field; behavior is changed by telling the Bot in chat. | better: an editable "Instructions" field in the Bot's settings, separate from memory (FC-04). | unknown | todo |
| F-041 | Bot setup (§3) | both | Chat-driven changes to the Bot's role are invisible. | better: a role change from chat posts an event line with a diff and Accept / Undo (FC-04). | unknown | todo |
| F-042 | Bot setup (§3) | both | No model picker; the model is chosen per request and never shown. | better: each Bot has a model selector in its settings and chat header (FC-01). | unknown | todo |
| F-043 | Bot setup (§3) | both | No reasoning-effort control. | better: each Bot has a reasoning-effort setting next to the model (FC-01). | unknown | todo |
| F-044 | Bot setup (§3) | both | Usage views and turns never name the model used. | better: each turn records model and effort, shown on hover and in the raw view (FC-01). | unknown | todo |
| F-045 | Bot setup (§3) | both | No model changes exist to record. | better: changing model or effort mid-task posts a grey event line and applies from the next turn (FC-01). | unknown | todo |
| F-046 | Bot setup (§3) | both | Every Bot runs on the one shared cloud computer. | better: each Bot has a chosen machine (gateway node or host), shown in settings and the header, and the user can change it (FC-02). | unknown | todo |
| F-047 | Bot setup (§3) | both | All Bots share files, browser sessions, Vault and connectors, and the UI never says so. | better: a Bot's settings list which credentials, connectors and folders it can reach, and warn when it shares a machine or profile with other Bots (FC-02). | unknown | todo |
| F-048 | Bot setup (§3) | iOS | Long-press "Duplicate" copies profile, settings, enabled skills, routines and avatar, but not history, memory or attachments. | better: Duplicate on desktop and iOS, with a checklist of what to copy. | unknown | todo |
| F-049 | Bot setup (§3) | both | "Share", "Create a copy", "Publish", "Copy link" publishes a public template; recipients choose "Add to Grok Bot". | better: export and import a Bot definition file; nothing is published without the user choosing to. | unknown | todo |
| F-050 | Bot setup (§3) | both | "Delete" asks once, cannot be undone, and erases profile, chats, memory and routines; files and sessions may remain. | better: the delete dialog lists what will be removed and what will remain, and offers to remove the Bot's workspace (FC-14). | unknown | todo |
| F-051 | Bot setup (§3) | both | A Bot can create another Bot on its own; it appears in the sidebar. | better: by default a Bot asks with an approval card before creating a Bot. | unknown | todo |
| F-052 | Bot setup (§3) | both | A slow create shows "Still creating" and keeps the typed text; a failure reads "Could not create the Bot. Please try again." | same | unknown | todo |
| F-053 | Bot setup (§3) | desktop | Clicking the name pill opens the details panel on the right: share and close buttons, large avatar, name, label, and tabs Details, Library, Computer. | better: adds Tasks, Settings, Memory and Permissions tabs. | unknown | todo |
| F-054 | Tasks (§4.1) | both | A Bot has one continuous conversation; "New chat" with the same Bot makes a group chat instead. | better: a Bot owns a list of tasks shown under it in the sidebar; "New task" starts one (FC-06). | unknown | todo |
| F-055 | Tasks (§4.1) | both | Not applicable: there is one conversation. | better: tasks share the Bot's instructions, memory, skills and routines, but not each other's transcripts (FC-06). | unknown | todo |
| F-056 | Tasks (§4.1) | both | Not applicable. | better: a task can be renamed, archived and deleted (FC-06). | unknown | todo |
| F-057 | Tasks (§4.1) | both | Only the Bot as a whole shows working, waiting or unread. | better: each task shows its own status (working, waiting for you, blocked, done, failed) in the sidebar (FC-06). | unknown | todo |
| F-058 | Tasks (§4.1) | both | Each Bot works one conversation at a time; a second request waits. | better: tasks on one Bot can run in parallel where the gateway allows (FC-06). | unknown | todo |
| F-059 | Tasks (§4.1) | both | Long chats are summarized automatically; there is no meter and no manual compaction. | better: each task shows a context-size meter and offers "Compact" (FC-06). | unknown | todo |
| F-060 | Tasks (§4.1) | both | A blocked-message notice offers "Reset"; "Reset this conversation?" restarts history and keeps memory, files, routines and settings. | same | unknown | todo |
| F-061 | Tasks (§4.1) | both | A message sent while the Bot is busy is folded into the current turn; there is no visible queue. | better: a message sent while busy shows "Queued" with "Send now" (steer) and "New task" options. | unknown | todo |
| F-062 | Chat (§4.2) | desktop | The chat header is a floating pill at the top center with the Bot's small avatar and name; clicking it opens details. | same | unknown | todo |
| F-063 | Chat (§4.2) | both | Centered grey timestamps separate blocks ("Today 2:55 PM", "Sun, Oct 25 7:35 PM"). | same | unknown | todo |
| F-064 | Chat (§4.2) | both | The user's messages are right-aligned rounded bubbles filled with the Bot's color; "Accent" can switch this to black. | same | unknown | todo |
| F-065 | Chat (§4.2) | both | The Bot's messages are left-aligned grey bubbles, stacked with small gaps and no per-bubble avatar in 1:1; markdown renders, including tables; wide tables can extend beside the message. | same | unknown | todo |
| F-066 | Chat (§4.2) | desktop | Hovering a message shows react, reply and more (three dots) icons to its right. | same | unknown | todo |
| F-067 | Chat (§4.2) | both | A message can be replied to in a thread and reacted to; reactions show as a small emoji badge under it. | same | unknown | todo |
| F-068 | Chat (§4.2) | both | The composer is a rounded bar: "+" at the left, the placeholder "Message &lt;Bot&gt;" ("Ask &lt;Bot&gt;" on iPhone), a microphone, and a waveform voice button that turns into a send arrow once there is text. | same | unknown | todo |
| F-069 | Chat (§4.2) | both | The "+" menu opens upward with "Attach files" and "Teach a task". | same | unknown | todo |
| F-070 | Chat (§4.2) | both | Typing "@" lists Bots, groups, routines and apps to mention. | same | unknown | todo |
| F-071 | Chat (§4.2) | both | Typing "/" lists skills and app actions, each tagged "Skill" or "Action"; a chosen skill shows as a chip in the sent message. | same | unknown | todo |
| F-072 | Chat (§4.2) | desktop | Enter sends, Shift+Enter adds a line, Cmd/Ctrl+Enter sends from anywhere, Cmd/Ctrl+I focuses the composer, Cmd/Ctrl+L adds selected text, Cmd/Ctrl+/ shows all shortcuts. | same | unknown | todo |
| F-073 | Chat (§4.2) | both | An unsent draft is kept per conversation. | same; note: per task | unknown | todo |
| F-074 | Chat (§4.2) | both | Files can be attached, dragged or pasted (up to 20 per message); an oversized file is flagged and dropped; uploads show a "Sending…" bar that fills. | same | unknown | todo |
| F-075 | Chat (§4.2) | both | A failed send shows "Failed to send" with "Resend" and "Delete"; iOS shows a "SEND AFTER RECONNECT" divider when offline. | same | unknown | todo |
| F-076 | Chat (§4.2) | desktop | Cmd/Ctrl+F finds text in the open chat. | same | unknown | todo |
| F-077 | Groups (§4.4) | both | A group chat is made from "New chat" or "+", "New Group Chat", adding 2–6 Bots in "To:"; the generated name starts with the user's name; "Rename chat" edits it. | same | unknown | todo |
| F-078 | Groups (§4.4) | both | In a group, each Bot reply has the Bot's name above it in the Bot's color and its avatar at the foot; the user's bubbles are neutral grey. | same | unknown | todo |
| F-079 | Groups (§4.4) | both | Bots choose who answers; "@Bot" targets one, "@everyone" all; "Reply" answers one Bot. | same | unknown | todo |
| F-080 | Groups (§4.4) | both | Group chats cannot show approval, secret or login cards or drafts; the Bot asks you to open its own chat. | better: approval cards work in group chats and name the Bot that asks (FC-09). | unknown | todo |
| F-081 | Working UI (§5.1) | both | Right after you send, a working line appears under the conversation: the Bot's small animated avatar and a short grey status phrase. | same | unknown | todo |
| F-082 | Working UI (§5.1) | both | The status phrase is in the user's language; specific phrases ("Working on your computer") show at once, generic ones ("Working on it", "Thinking") only after a short delay. | same | unknown | todo |
| F-083 | Working UI (§5.1) | both | For greetings and small talk, the status reads "&lt;Bot&gt; is on it". | same | unknown | todo |
| F-084 | Working UI (§5.1) | both | The status text has a light sweeping across it (shimmer). | same; note: inferred from one still; verify the animation runs and stops when idle | unknown | todo |
| F-085 | Working UI (§5.1) | both | When the Bot works with nothing to report, a 1:1 chat shows only its animated avatar. | same | unknown | todo |
| F-086 | Working UI (§5.1) | both | The avatar's motion shows idle, thinking, working, waiting, blocked and done, in the sidebar and the chat's activity line. | same; note: own avatar art and motion | unknown | todo |
| F-087 | Working UI (§5.1) | desktop | Hovering the working line shows the Bot's current action. | same | unknown | todo |
| F-088 | Working UI (§5.1) | both | The Bot narrates progress in short separate bubbles ("On it — …", "Reading … now — table next"). | same | unknown | todo |
| F-089 | Working UI (§5.1) | both | The working line disappears when the answer or card arrives; the Bot does not post a message that only says it is done. | same | unknown | todo |
| F-090 | Working UI (§5.1) | both | Tool calls and steps are not listed in the transcript. | better: each turn has an activity block that collapses to "Worked for &lt;time&gt; · &lt;n&gt; steps" (FC-05). | unknown | todo |
| F-091 | Working UI (§5.1) | both | The design post's hover log shows steps as short verb phrases with grey detail ("Edited math.ts +14 −10", "Ran full suite 212 passed"). | better: the expanded activity block lists every step in that style, live while the turn runs (FC-05). | unknown | todo |
| F-092 | Working UI (§5.1) | both | Failures can surface as calm "nothing new" reports. | better: the collapsed activity block shows "· &lt;n&gt; failed" and failed steps stay visible (FC-15). | unknown | todo |
| F-093 | Working UI (§5.1) | both | Raw tool calls are never visible. | better: every step has a raw view with tool name, arguments, result, timing and error (FC-05). | unknown | todo |
| F-094 | Working UI (§5.1) | both | Cards and event lines have no raw detail. | better: every card and event line has a raw view of the call or event behind it (FC-05). | unknown | todo |
| F-095 | Working UI (§5.1) | both | No token-by-token streaming is documented; replies appear as whole bubbles. | better: reply text streams into its bubble as it is generated. | unknown | todo |
| F-096 | Working UI (§5.4) | both | A message sent while the Bot works redirects the current turn and outranks background work. | same | unknown | todo |
| F-097 | Working UI (§5.4) | both | There is no stop button; you send "Stop now". | better: a Stop button replaces send while a turn runs; "Stop now" also works (FC-08). | unknown | todo |
| F-098 | Working UI (§5.4) | both | Stop also ends subagents, delegated Bots, cloud agents and processes on the computer; their pending cards expire. | better: also posts a note listing everything that was stopped (FC-08). | unknown | todo |
| F-099 | Working UI (§5.4) | both | A Bot stuck on an unresponsive step ends within about 30 s of Stop or a new message. | same | unknown | todo |
| F-100 | Working UI (§5.4) | both | A turn is stopped after 50 minutes with the grey note "This turn was stopped after 50 minutes so it would not hang. Send a message to pick up where it left off." | same; note: limit configurable | unknown | todo |
| F-101 | Working UI (§5.4) | both | After three timed-out tool calls in a row, the task stops with a grey note that the computer may be unresponsive. | same | unknown | todo |
| F-102 | Errors (§5.5) | both | "Bot failed to respond" shows as a dark red banner with a warning triangle, a bold title, a second line with the reason, and a round close button. | same | unknown | todo |
| F-103 | Errors (§5.5) | both | In-app errors collect above the composer under "Notifications"; each can be dismissed, all can be cleared, and some offer "Copy request ID". | same | unknown | todo |
| F-104 | Errors (§5.5) | both | Offline: a "You're offline" banner; the chat shows a "Reconnecting" pill with a spinner over "Showing saved messages. This conversation may be out of date…". | same | unknown | todo |
| F-105 | Errors (§5.5) | both | When chats, pages, skills, routines or plugins fail to load, the error shows with "Try again" and the last loaded data stays. | same | unknown | todo |
| F-106 | Errors (§5.5) | both | Several messages sent quickly all get answers, including the first. | same | unknown | todo |
| F-107 | Errors (§5.5) | both | A chat can stop showing new messages while the sidebar updates; the fix is switching Bots. | better: the client detects the gap and re-syncs on its own, with a brief "Synced" notice (FC-08). | unknown | todo |
| F-108 | Events (§5.2) | both | A grey right-aligned "Created routine ⏱ &lt;name&gt;" line appears; the name chip opens the routine. | same | unknown | todo |
| F-109 | Events (§5.2) | both | Editing a routine from chat posts an "Updated routine" line. | same | unknown | todo |
| F-110 | Events (§5.2) | both | A "Saved to memory" line can appear when the Bot saves something. | better: the line always appears and opens the saved item in the memory viewer (FC-03). | unknown | todo |
| F-111 | Events (§5.2) | both | After a voice chat, a "Voice chat" line with the duration opens the transcript. | same | unknown | todo |
| F-112 | Cards (§5.3) | both | A question card shows a title, an X, lettered options A–D (each with an optional grey sub-line) and a "Type your own answer" field. | same | unknown | todo |
| F-113 | Cards (§5.3) | both | An answered question card folds to one line with the letter, the answer and a check mark; the question is not repeated as a message. | same | unknown | todo |
| F-114 | Cards (§5.3) | both | A multiple-choice question card says "Choose all that apply". | same | unknown | todo |
| F-115 | Cards (§5.3) | both | A file card shows a document icon, the file name and size; clicking previews the file with "Download file". | same | unknown | todo |
| F-116 | Cards (§5.3) | both | A link card shows an icon, title and domain; hover shows a preview. | same | unknown | todo |
| F-117 | Cards (§5.3) | both | Images and videos open full screen with arrow-key navigation, a download button and Escape to close; videos play at 0.5×–2×. | same | unknown | todo |
| F-118 | Cards (§5.3) | desktop | The message menu has "Download" or "Download all"; right-click on media has "Copy image", "Save image…", "Save video…". | same | unknown | todo |
| F-119 | Bot-to-bot (§6) | both | When a Bot messages another Bot, the sender's chat shows a grey right-aligned line "Messaged", the recipient's small avatar and name. | better: a Messaged card (see the next rows) in the same position. | unknown | todo |
| F-120 | Bot-to-bot (§6) | both | When the reply arrives, a grey line "Message from", the avatar and name appears. | better: the same card updates to "Replied" in place, and a "Message from" line is kept only for messages the Bot did not ask for. | unknown | todo |
| F-121 | Bot-to-bot (§6) | both | Clicking the name opens the exchange read-only in place of the chat, with no composer and a "Close Chat" button. | better: the card expands inline to the exchange; "Open full exchange" keeps the read-only view. | unknown | todo |
| F-122 | Bot-to-bot (§6) | both | The collapsed line shows only "Messaged" and the Bot. | better: the collapsed card shows the recipient's avatar and name, a one-line summary of the request and a state: sending, sent, working, replied or failed. | unknown | todo |
| F-123 | Bot-to-bot (§6) | both | Not shown inline. | better: the expanded card shows the exact text sent, any attachments, the reply text and both timestamps. | unknown | todo |
| F-124 | Bot-to-bot (§6) | both | Not available. | better: the expanded card links to the receiving Bot's task ("Open in &lt;Bot&gt;"). | unknown | todo |
| F-125 | Bot-to-bot (§6) | both | The receiving Bot's chat shows one grey line with a count, "2 messages with &lt;Bot&gt;". | same | unknown | todo |
| F-126 | Bot-to-bot (§6) | both | While the receiver works, its sidebar avatar animates and its row shows working. | same | unknown | todo |
| F-127 | Bot-to-bot (§6) | both | The user can ask for a handoff by naming the other Bot or picking it with "@". | same | unknown | todo |
| F-128 | Bot-to-bot (§6) | both | Handoff messages are text only. | better: handoff messages can carry attachments. | unknown | todo |
| F-129 | Bot-to-bot (§6) | both | Questions from a Bot woken by another Bot come to the chat where the user asked. | same | unknown | todo |
| F-130 | Bot-to-bot (§6) | both | No setting stops Bots messaging each other. | better: per Bot, "Can message other Bots" and "Can be messaged by" each set to off, ask me or allowed (FC-10). | unknown | todo |
| F-131 | Bot-to-bot (§6) | both | Bot-to-Bot messages count as usage but are not shown separately. | better: Bot-to-Bot usage is shown as its own line per Bot (FC-10, FC-07). | unknown | todo |
| F-132 | Coding handoff (§6) | both | A Bot hands coding work to Cursor Cloud Agents, shown as a card in the conversation. | better: a "Messaged T3 Code" card when a Bot sends work to T3 Code; collapsed, it shows the T3 Code mark, the target project or thread, a one-line summary and a state. | unknown | todo |
| F-133 | Coding handoff (§6) | both | The Cloud Agent card shows files from the final report. | better: the "Messaged T3 Code" card expands to show the exact prompt sent, the target project, branch or worktree, and the reply or result. | unknown | todo |
| F-134 | Coding handoff (§6) | both | The phone card shows states "Done", "Error", "Expired" and offers "Retry", "View PR", "Open in Cursor". | better: the "Messaged T3 Code" card updates live (sent, running, done, failed) and has "Open in T3 Code". | unknown | todo |
| F-135 | Coding handoff (§6) | both | Files cited in the agent's report are attached to the Bot's reply and the card. | same; note: for files and PR links T3 Code returns | unknown | todo |
| F-136 | Coding handoff (§6) | both | The details "Tasks" tab lists coding runs under "Coding" as "Working", "Run failed" or "Status unavailable". | better: the list includes T3 Code threads, with status and a link. | unknown | todo |
| F-137 | Coding handoff (§6) | both | Telling a Bot to stop also stops the Cloud Agents it started. | same; note: for T3 Code threads the Bot started; it asks first when a thread is shared | unknown | todo |
| F-138 | Coding handoff (§6) | both | Not applicable. | better: Settings has a T3 Code connection (endpoint and pairing) used by the Messaged T3 Code card. | unknown | todo |
| F-139 | Computer (§7) | desktop | A computer icon in the title bar turns purple while the Bot's computer is active. | same; note: accent color | unknown | todo |
| F-140 | Computer (§7) | both | The Computer tab shows a 16:9 live thumbnail with a centered "Open" pill and the caption "&lt;Bot&gt;'s screen". | same | unknown | todo |
| F-141 | Computer (§7) | both | While the computer sleeps the preview reads "Your computer is asleep"; clicking it wakes the computer in place. | same | unknown | todo |
| F-142 | Computer (§7) | both | "Open" shows the screen full screen in "Watching" mode; "Take control" enables input; an exit control returns. | same | unknown | todo |
| F-143 | Computer (§7) | both | The live view shows clicks, typing and navigation as they happen. | same | unknown | todo |
| F-144 | Computer (§7) | both | When the Bot needs a human step it posts a "Computer" card: the need in bold, a grey note, a preview tile, "Take over", "I'm done" and "Skip"; the row shows "Waiting for you". | same | unknown | todo |
| F-145 | Computer (§7) | both | After "Take over", a top bar shows "Skip this step" and "I'm done, continue"; afterwards the card reads "Done" and the Bot resumes. | same | unknown | todo |
| F-146 | Computer (§7) | iOS | A monitor icon in the chat header opens the computer; full screen on iPad has close and the Bot name at the top left, help and more at the top right, and clipboard and keyboard controls at the bottom. | same | unknown | todo |
| F-147 | Computer (§7) | both | The computer panel never names a machine. | better: the panel names the machine the Bot runs on and links to the node's settings (FC-02). | unknown | todo |
| F-148 | Computer (§7) | both | Connection problems appear only as "Reconnecting" or "Unreachable". | better: the panel shows the machine's connection state and last heartbeat (FC-08). | unknown | todo |
| F-149 | Computer (§7) | both | The only fix for a stuck computer is update, recover or reset of the whole shared computer. | better: "Restart this Bot's session" restarts one Bot's session without touching other Bots (FC-08). | unknown | todo |
| F-150 | Computer (§7) | both | "Can't reach your computer" shows at the top of the sidebar with "Retry" and "Recover computer"; "Couldn't Reach Grok Bot's Computer" with "Retry". | same; note: for an unreachable gateway or node | unknown | todo |
| F-151 | Computer (§7) | desktop | Updating or recovering the computer opens a window with a step list (check, spinner, empty circle), a percentage bar, an "Update still running" note, "Continue in Background" and "Keep waiting"; failures offer a retry. | same; note: for node repair actions the gateway supports | unknown | todo |
| F-152 | Computer (§7) | both | There is no file browser; files reach the user only as cards and in the Library. | better: a Files tab lists the Bot's workspace folder with preview and download. | unknown | todo |
| F-153 | Computer (§7) | both | There is no terminal view; commands are hidden. | better: a read-only log of the commands the Bot ran on its machine, with output, linked from each step. | unknown | todo |
| F-154 | Computer (§7) | both | A per-Bot recent-actions log does not exist. | better: the computer panel lists recent actions with time and what triggered each (as in OpenSuperBot) (FC-05). | unknown | todo |
| F-155 | Computer (§7) | both | The first local-command request asks "Allow Grok Bot and all Bots to run commands on your local computer?" with "Always allow", "Allow once", "Never" and "Deny once" (Esc). | better: the prompt names the Bot and the choice can apply to this Bot only. | unknown | todo |
| F-156 | Computer (§7) | desktop | "Execution on this computer" offers "Ask every time" (default), "Always allow" and "Never allow", per device. | same; note: per node | unknown | todo |
| F-157 | Computer (§7) | both | "Manage devices" lists devices as "This device", "Online now" or last opened; rename; remove an offline computer. | same; note: gateway nodes and paired clients | unknown | todo |
| F-158 | Computer (§7) | desktop | "Route traffic through this computer" sends the Bot's web traffic through the user's desktop, with a count of routed requests. | same | unknown | todo |
| F-159 | Computer (§7) | both | At low disk space the Bot names the largest items once and deletes only after a yes. | same | unknown | todo |
| F-160 | Teach a task (§9.2) | desktop | "Teach a task" shows a red "Start recording" button; recording draws a red outline, a bar "&lt;Bot&gt; is watching and learning", a square stop button and a timer; 10-minute cap. | same | unknown | todo |
| F-161 | Teach a task (§9.2) | desktop | Stopping sends "The recording is finished. Learn the task from it." with a "Learn from demonstration" chip; the Bot replies with numbered steps and "Want a dry run?". | better: a review screen shows the drafted skill for editing before it is saved. | unknown | todo |
| F-162 | Approvals (§8.1) | both | Auto-review is on by default and most actions run without a card. | better: adds an audit log of every reviewed action and its verdict. | unknown | todo |
| F-163 | Approvals (§8.2) | both | An approval card has a title naming the Bot ("Allow &lt;Bot&gt; to run a command?"), an orange "Needs approval" tag, a one-sentence summary, "View the full request ›", and "Always allow", "Allow once" and "Deny". | same | unknown | todo |
| F-164 | Approvals (§8.2) | both | "View the full request" expands an inset with the reason and the exact command in monospace, with "Hide" and a copy icon. | same | unknown | todo |
| F-165 | Approvals (§8.2) | both | After "Deny" the tag reads "Denied", the buttons go, a line says "&lt;Bot&gt; won't do this.", and the Bot does not retry until the next user message. | same | unknown | todo |
| F-166 | Approvals (§8.2) | both | After "Always allow" the card reads "Action approved" with a green "Always allowed" tag and quotes the saved rule. | same | unknown | todo |
| F-167 | Approvals (§8.2) | both | "Always allow" always creates an account-wide rule. | better: "Always allow" asks for a scope (this Bot or all Bots) and a duration (1 hour, 1 day, until revoked) (FC-09). | unknown | todo |
| F-168 | Approvals (§8.3) | both | Cards from chat work wait indefinitely; cards from routines, other Bots or background work expire after 30 minutes and then read "Approval expired" with no buttons. | same | unknown | todo |
| F-169 | Approvals (§8.3) | both | Sending a new message, or changing Auto-review settings, closes open cards. | same | unknown | todo |
| F-170 | Approvals (§8.2) | both | Variants: terminal cards show "Allow", "Skip", "Manage settings"; cards paused by an Ask-first rule show "Allow", "Not now", "Edit rule"; cards with no rule to offer show "Allow" only. | same | unknown | todo |
| F-171 | Approvals (§8.2) | both | Cards can carry warnings: "This can't be undone", "This changes sign-in or security settings", "This shares your data outside this chat". | same | unknown | todo |
| F-172 | Approvals (§8.2) | iOS | Tapping a card on the phone opens the full request with all buttons. | same | unknown | todo |
| F-173 | Approvals (§8.1) | both | Settings, General, Bot has an "Auto-review" switch; turning it off hides and suspends Custom Rules without deleting them. | same | unknown | todo |
| F-174 | Approvals (§8.4) | both | Custom Rules has a "When Grok Bot wants to:" text box, an "It should:" menu (Allow automatically, Ask first) and "Add Rule", disabled until text is entered. | same | unknown | todo |
| F-175 | Approvals (§8.4) | both | Rules list in "Action" and "Behavior" columns with edit and delete; Ask first beats Allow automatically; 20 rules per type. | same | unknown | todo |
| F-176 | Approvals (§8.4) | both | There are no per-tool permissions. | better: per Bot, each tool or tool group is set to allow, ask or deny (FC-09). | unknown | todo |
| F-177 | Approvals (§8.4) | both | Rules apply to every Bot. | better: rules can be scoped to one Bot, on top of global rules (FC-09). | unknown | todo |
| F-178 | Approvals (§8.4) | both | Standing approvals are scattered across rules and settings. | better: a Permissions page lists every standing approval with scope, grant time and "Revoke" (FC-09). | unknown | todo |
| F-179 | Approvals (§8.2) | both | In a group chat only the person being answered can approve, and "Always allow" is not offered. | better: the card shows which Bot is asking and who can approve, and works the same as in 1:1 (FC-09). | unknown | todo |
| F-180 | Approvals (§8.6) | both | "Smarter approvals": an action the user already authorized in their own message runs without a card; before an irreversible action the Bot checks the user's messages. | same | unknown | todo |
| F-181 | Approvals (§8.5) | both | An email draft card shows "New email", a "Ready to send" tag, From, To, Cc and Subject rows, the body with "Show less", "Disable drafts for this Bot", "Discard" and "Send email"; after sending the tag reads "Answered". | same | unknown | todo |
| F-182 | Approvals (§8.5) | both | "Disable drafts for this Bot" lets that Bot send directly; a draft whose attachment changed is not sent and reopens. | same | unknown | todo |
| F-183 | Approvals (§8.7) | both | A Secure Form card ("Sign in to &lt;site&gt;", "Secure Form", "Open") opens a dialog with the site's fields, the line "Never shown to your Bot. Filled directly to &lt;site&gt;." and "Continue". | same | unknown | todo |
| F-184 | Approvals (§8.7) | both | A secure secret card has a masked field and "Save securely", then reads "Saved"; saved values are write-only. | same | unknown | todo |
| F-185 | Approvals (§8.7) | iOS | A "Grok Bot needs permission" card offers "Allow", or "Open Settings" if permission was denied; the Bot waits up to five minutes. | same | unknown | todo |
| F-186 | Routines (§9.1) | both | Asking a Bot in chat to do something on a schedule creates a routine and posts "Created routine" with its chip. | same | unknown | todo |
| F-187 | Routines (§9.1) | iOS | Profile, "Routines", "Add routine" pre-fills "Set up a routine to" in the composer. | same | unknown | todo |
| F-188 | Routines (§9.1) | both | The routine panel shows "Instruction", "When to run" in words, "Webhook" fields that copy on click, and "Pause"/"Resume", "Test" ("Running…"), "Edit" and a delete icon that asks to confirm. | same | unknown | todo |
| F-189 | Routines (§9.1) | both | "Edit" pre-fills "Edit your routine: &lt;name&gt;." in the composer. | better: an editable form (name, instruction, schedule pickers, timezone, triggers, Save) alongside chat editing (FC-13). | unknown | todo |
| F-190 | Routines (§9.1) | both | Run history exists only on the phone: "Running", "Succeeded", "Failed" with a reason, or "No runs yet". | better: run history on desktop and iOS; each run links to its transcript and usage (FC-13). | unknown | todo |
| F-191 | Routines (§9.1) | both | The Details tab lists routines with name, schedule or "Paused" and a switch; empty state "Ask in chat to set a routine". | same | unknown | todo |
| F-192 | Routines (§9.1) | desktop | Right-clicking a routine offers Pause/Resume, Test, Edit and Delete. | same | unknown | todo |
| F-193 | Routines (§9.1) | both | Routine results post in the Bot's chat; a routine's runs can open in their own chat with "Close Chat". | better: each run is a task under the Bot, marked with the routine's name. | unknown | todo |
| F-194 | Routines (§9.1) | both | After a long absence the Bot asks "You've been away for a bit — keep my routines running?" with "Keep them running", "Pause them all" and "Keep running, don't ask again". | same | unknown | todo |
| F-195 | Routines (§9.1) | both | Schedules are written in plain language, at least five minutes apart; triggers include webhooks, email and app events. | same; note: for the triggers the gateway supports | unknown | todo |
| F-196 | Routines (§9.1) | both | Settings, Bot, "Timezone" sets routine time, with "Auto-detect". | same | unknown | todo |
| F-197 | Routines (§9.1) | both | There is no overview of all routines. | better: a calendar view (day, 3 days, week) of every Bot's routines (as in OpenMausBot). | unknown | todo |
| F-198 | Skills (§9.2) | both | Asking a Bot to save a process creates a named skill; the skill page has Name, Description ("Use when…"), Instructions, "Save" and "Delete Skill". | same | unknown | todo |
| F-199 | Skills (§9.2) | both | Private skills are one library; each skill is switched on per Bot. | same | unknown | todo |
| F-200 | Proactive (§9.3) | both | The primary Bot offers to take on work and flags app sign-outs; it offers first and asks before risky actions. | same | unknown | todo |
| F-201 | Proactive (§9.3) | both | Check-ins cannot be turned off; muting notifications only silences alerts. | better: a per-Bot "Proactive check-ins" switch with a frequency choice (FC-11). | unknown | todo |
| F-202 | Notifications (§9.4) | both | The per-Bot "Notifications" switch exists only on the phone; on desktop you ask the Bot. | better: a per-Bot and per-task notification switch on desktop and iOS (FC-12). | unknown | todo |
| F-203 | Notifications (§9.4) | both | No quiet hours. | better: quiet hours in Settings (FC-12). | unknown | todo |
| F-204 | Notifications (§9.4) | desktop | A system notification fires when a Bot finishes or waits for you; a focused window silences only the Bot on screen. | same | unknown | todo |
| F-205 | Notifications (§9.4) | iOS | Push for results, questions and approvals; while the desktop is in use, finished replies skip the phone and input requests reach it about 3 minutes later. | same | unknown | todo |
| F-206 | Notifications (§9.4) | iOS | With notifications disabled, the app shows "Notifications are off" with "Open Settings". | same | unknown | todo |
| F-207 | Notifications (§9.4) | both | No documented notification deep link. | better: tapping a notification opens the exact task and card. | unknown | todo |
| F-208 | Library (§9.5) | both | The Library tab lists what the Bot made under "Today", "This week" and "Older", five at a time with "Show more", with filters All, Pages, Media, Links, Files, Apps, Pinned and a Pin action. | same | unknown | todo |
| F-209 | Library (§9.5) | both | A Page card has the title and "Open"; the Page fills the window with a side chat "Message about &lt;title&gt;"; older cards read "Updated below". | same | unknown | todo |
| F-210 | Library (§9.5) | both | Pages can be shared with invitees, the team, or anyone with a link on a public domain. | better: share by exporting the Page as a file; nothing is hosted publicly by default. | unknown | todo |
| F-211 | Memory (§10) | both | There is no memory screen. | better: a memory viewer per Bot lists each item with its text, scope, date and the Bot or chat that saved it (FC-03). | unknown | todo |
| F-212 | Memory (§10) | both | Memory is changed only by asking the Bot. | better: items can be edited, deleted, pinned and added in the viewer, taking effect on the next turn (FC-03). | unknown | todo |
| F-213 | Memory (§10) | both | Shared facts across Bots are invisible. | better: a shared-memory viewer shows facts every Bot uses, with the Bot that saved each (FC-03). | unknown | todo |
| F-214 | Memory (§10) | both | No export or import except the one-off import prompt. | better: export and import memory as a markdown file (FC-03). | unknown | todo |
| F-215 | Memory (§10) | both | Memory can be cleared only by deleting the Bot. | better: "Clear memory" with a confirmation that says what stays (FC-03). | unknown | todo |
| F-216 | Memory (§10) | both | Asking "What do you remember about me?" makes the Bot list what it remembers. | same | unknown | todo |
| F-217 | Connectors (§11) | both | "Connect apps" opens a window with "Search across apps and skills", category chips, "Recommended for you" and "Add"; on iPhone it is reached from the avatar menu. | same | unknown | todo |
| F-218 | Connectors (§11) | both | Plugin states are "Added", "Needs auth", "Disconnected", "Connected" (green) and "Disabled by team admin", with "Authenticate", "Reconnect" and "Remove". | same | unknown | todo |
| F-219 | Connectors (§11) | both | A plugin page shows its description, apps, and "Accounts" with per-account status and "Add Another Account" with a label. | same | unknown | todo |
| F-220 | Connectors (§11) | both | A connect card in chat asks the user to sign in to an app, with "Reopen" if the sign-in stalls. | same | unknown | todo |
| F-221 | Connectors (§11) | desktop | "Add a custom connector": Name, Type "Remote HTTPS" (Server URL, HTTP headers, Client ID, Client Secret) or "Command" (Command, Arguments), then "Add plugin". | same | unknown | todo |
| F-222 | Connectors (§11) | both | Connected apps are available to every Bot. | better: each Bot's settings choose which connectors it may use (FC-02). | unknown | todo |
| F-223 | Connectors (§11) | iOS | Device apps (Calendar, Contacts, Location, Alarms, Reminders, Home) list under "This iPhone" with "Allow", "Allowed" or "Denied". | same | unknown | todo |
| F-224 | Team Bots (§12) | both | A Team Bot is created as a draft through step cards ("Step 1 of 5" … "Publish to team") and shared with "Collaborator" or "Manager" roles. | same | unknown | todo |
| F-225 | Team Bots (§12) | both | "Review learnings" lists teammate-taught changes ("Updates the skill", "Forgets a team memory") with "Approve" and "Reject". | same | unknown | todo |
| F-226 | Meetings (§12) | both | A Bot joins a pasted meeting link after an approval card; Details shows "Upcoming" with a countdown or "Taking notes" and "Disable Interactivity", "Cancel", "Quit"; a summary posts after the call. | same | unknown | todo |
| F-227 | Settings (§13) | desktop | Cmd/Ctrl+, opens Settings with panes General, Computer, Vault, Usage & Billing and Updates. | better: a Gateway pane replaces billing. | unknown | todo |
| F-228 | Settings (§13) | both | Appearance has Theme (Follow System, Light, Dark) and Accent (Bot color, Black). | same | unknown | todo |
| F-229 | Settings (§13) | both | Language is "Follow System" or a chosen language. | same | unknown | todo |
| F-230 | Settings (§13) | both | The Account card supports several accounts with "Switch account", "Add account" and "Remove". | better: several gateways, with "Switch gateway", "Add gateway" and "Remove". | unknown | todo |
| F-231 | Settings (§13) | desktop | Updates shows the version, "Check for Updates", "Restart to Update" and "Automatic Updates" (installs only when idle and locked). | same | unknown | todo |
| F-232 | Usage (§13) | both | Usage shows only a weekly total and a chart by Bot or source. | better: usage per turn, task, Bot and routine run (FC-07). | unknown | todo |
| F-233 | Usage (§13) | both | No token breakdown. | better: each turn's usage splits into history, memory, tools and output where the gateway reports it (FC-07). | unknown | todo |
| F-234 | Usage (§13) | both | No per-Bot cap; the whole account pauses at the weekly limit. | better: a daily or weekly budget per Bot and per routine; a warning at 80% and a pause with a chat note at 100% (FC-07). | unknown | todo |
| F-235 | Usage (§13) | both | The "Weekly usage limit" card shows a thin bar, the reset time and a percentage; the account menu shows "Weekly usage &lt;n&gt;%". | same; note: for provider limits the gateway reports | unknown | todo |
| F-236 | Usage (§13) | both | Dark banners above the composer warn at 75–90% ("You're at 90% of your weekly usage limit. It resets in 6 days." with "Get More Usage") and at the limit, each with a close X. | same; note: for budgets and provider limits | unknown | todo |
| F-237 | Usage (§13) | both | "Grok Bot usage" shows a chart "By Bot" or "By source". | same | unknown | todo |
| F-238 | iOS (§14) | iOS | Home: account avatar at the top left, search and "+" at the top right, a row of three large pinned avatars, then a list with avatar, name, timestamp and preview; no tab bar. | same | unknown | todo |
| F-239 | iOS (§14) | iOS | "+" on the home screen offers "New Bot" and "New Group Chat". | better: also offers "New task". | unknown | todo |
| F-240 | iOS (§14) | iOS | Search has scopes Messages, Bots, Group Chats, Files, Routines and All. | same | unknown | todo |
| F-241 | iOS (§14) | iOS | The chat header has a round back chevron, a pill with avatar and name that opens the profile, and a monitor icon for the computer. | same | unknown | todo |
| F-242 | iOS (§14) | iOS | The profile holds Edit, Notifications, Library, Routines, Avatar, Duplicate and the primary-Bot action. | better: adds Model, Instructions, Memory and Permissions. | unknown | todo |
| F-243 | iOS (§14) | iOS | Touch and hold a message offers "Select Text", then "Add to Chat" or copy. | same | unknown | todo |
| F-244 | iOS (§14) | iOS | Swiping a conversation row gives quick pin and hide; swiping a routine deletes it. | same | unknown | todo |
| F-245 | iOS (§14) | iOS | The share sheet offers "Grok Bot" with the primary Bot pre-filled in "To:", "Add a note" and "Send". | same | unknown | todo |
| F-246 | iOS (§14) | iOS | Siri and Shortcuts actions "List Bots" and "Send Message". | same | unknown | todo |
| F-247 | iOS (§14) | iOS | Live Activities exist only for dictation and voice chat. | better: a Live Activity shows a running task's status and a pending approval. | unknown | todo |
| F-248 | iOS (§14) | iOS | The deep link `grokbot://app/v1/prompt?id=<bot-id>&text=<message>` opens a Bot's chat with unsent text. | same; note: own scheme | unknown | todo |
| F-249 | iOS (§14) | iOS | iPad uses a split view with the sidebar at about a third of the width and the chat beside it. | same | unknown | todo |
| F-250 | iOS (§14) | iOS | A "Haptics" setting controls haptic feedback. | same | unknown | todo |
| F-251 | iOS (§14) | iOS | From the phone you can approve actions and watch or take over the computer. | same | unknown | todo |
| F-252 | iOS (§14) | iOS | On the phone, a routine's "Active" toggle pauses it and its detail shows "Schedule", "Next run" and "Run history". | same | unknown | todo |
| F-253 | Voice (§15) | both | The microphone button ("Start voice input", Cmd/Ctrl+D) turns speech into editable text in the composer. | same | unknown | todo |
| F-254 | Voice (§15) | both | "Start voice chat" (waveform, empty composer only) starts a live call with "Mute", "Hang up" and "Show transcript"; a "Voice chat" card follows. | same | unknown | todo |
| F-255 | Voice (§15) | both | Bots can send voice memos with "Play voice memo" and an expandable transcript. | same | unknown | todo |
| F-256 | Vendor services (§15) | both | US phone calls from a "Phone call" card with "Call", a live transcript, "Take over" and "End call". | same | unknown | todo |
| F-257 | Vendor services (§15) | both | Shopping cards with "Buy now" and order cards with "Pay with", "Total" and a pay button. | same | unknown | todo |
| F-258 | Vendor services (§15) | both | Each Bot can claim a permanent email address with its own inbox. | same | unknown | todo |
| F-259 | Sidebar (§2) | both | "Replace with different Bot" on the primary Bot opens "Choose a primary Bot", a list of Bots with "Confirm"; the star moves to the chosen Bot. | same | unknown | todo |
| F-260 | Chat (§4.2) | both | A line starting with ">" in the composer becomes a block quote. | same | unknown | todo |
| F-261 | Approvals (§8.7) | both | Settings, Vault holds logins, cards and contact info with "New item" and "New item → Import"; saved passwords are never shown to Bots, and every item is available to every Bot. | better: each Vault item can be limited to chosen Bots (FC-02). | unknown | todo |
| F-262 | Computer (§7) | both | The Bot's desktop wallpaper changes through the day (lighter in the morning, darker at night) so it never looks like the user's own desktop. | same; note: where the client controls the Bot's desktop | unknown | todo |
