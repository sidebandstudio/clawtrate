# Grok Bot flow teardown

This is the reference Clawtrate's builders work from. It describes how Grok Bot behaves on desktop and iOS, from public material only, as of 16 November 2026. `docs/parity.md` turns each verifiable behavior here into a checklist row.

Grok Bot is the personal agent app from SpaceXSI (formerly xAI). It runs on Cursor's infrastructure. It went into beta on 11 August 2026 ([x.ai launch][x-launch], seen). SpaceXSI announced 1.0 on 2 November 2026 ([x.ai 1.0][x-10], seen). The numbered 1.0.0 and 1.0.1 desktop releases are dated 11 November, and one reviewer's installed desktop app was still on 0.79.3 that day, so not every installation had 1.0 yet ([Flavio Copes 1.0][flavio-10], reported). The iPhone app was at 1.26.0 on 14 November ([App Store][appstore], seen).

## How to read this document

Every claim ends with a source and a confidence tag:

- `seen`: I read the official documentation page, or I looked at the screenshot or video frame myself.
- `reported`: someone else wrote it down. That covers third-party write-ups by people who used the app, forum posts, and the official changelog, which blocks direct fetches. I read the changelog only through search-engine excerpts, so its entries are tagged `reported` even though the changelog is a primary source.
- `inferred`: my own deduction. Treat it as a design suggestion, not as fact.

Sources are short link labels such as [docs: bots][d-bots]. Their URLs are listed at the end. Where sources disagree, the text says so, and the section "Where sources disagree" collects the conflicts.

The most useful sources were:

1. The official docs at docs.x.ai/grok-bot. They are current, detailed and full of exact labels, but they say nothing about the thinking UI, and almost nothing about the visual layout.
2. The official design post, "Designing Grok Bot for a world of persistent agents" ([x.ai design post][x-design]). It is the only primary source on the working-state UI, the avatars and the computer-view layout.
3. learngrokbot.com, an independent guide with first-hand screenshots from early October 2026 (desktop 0.68.1). It is the best source for layout. Some screens may have changed since then.
4. The App Store screenshots, which are official marketing renders of the iPhone and iPad apps.
5. Cursor forum threads, which show what users ask for and what staff say is missing.

Many SEO pages about Grok Bot contradict the docs, for example on whether each Bot has its own computer or whether Android exists. I used them only where nothing better existed, and I say so.

Two naming notes. The product calls its agents "Bots", with a capital B ([docs: bots][d-bots], seen). The docs call the main Bot the "primary Bot" ([docs: bots][d-bots], seen), and the independent guide and older release notes call it the "Main Bot" ([learngrokbot: multiple Bots][lgb-multi], reported).

---

## 1. First run and onboarding

### Desktop

1. You download the app from x.ai/bot. The page has a large "Download for macOS" button for Apple silicon, with Intel Mac, Windows and Linux under "More downloads". ([x.ai product page][x-product], seen; [learngrokbot: platforms][lgb-platforms], reported)
2. On macOS, the disk image shows the usual drag-to-Applications window titled "Grok Bot Installer". ([learngrokbot: setup][lgb-setup], seen in screenshot)
3. The welcome screen shows the Grok Bot mark, the line "Your team of always-on Bots that you can give real work to", and one button: "Sign in". ([learngrokbot: setup][lgb-setup], reported from caption)
4. "Sign in" opens a browser page titled "Start using Grok Bot", with three buttons: "Sign in with Grok", "Sign in with Cursor" and "Create an account". The last browser page reads "All set! Feel free to return to Grok Bot." and has one button, "Open Grok Bot". ([learngrokbot: setup][lgb-setup], reported from caption; [docs: get started][d-start], seen)
5. If the account has no plan, a "Get Started with Grok Bot" screen offers three columns: "Start a Trial" with "Activate Trial", a paid plan with its button, and "Get Access with Grok" marked "Included" with "Link Grok Account". ([learngrokbot: setup][lgb-setup], reported from caption)
6. The app sets up the cloud computer. The window shows the Grok Bot mark and one line, "Setting up Grok Bot's computer", which can also read "Starting your computer". This can take several minutes, and there is nothing to click. A later changelog entry says the app now opens while the computer is still starting, instead of waiting behind this full-window screen. ([learngrokbot: setup][lgb-setup], reported; [changelog][x-changelog], reported)
7. A short intro follows, a few screens about Bots and their computer, ending on "What do you use every day?". That screen has a search box, a grid of twelve app tiles (Workspace, Slack, HubSpot, Canva and others) that you can tick, and "Next" and "Back". Ticking an app does not connect it. It only shapes which Bots the app suggests. ([learngrokbot: setup][lgb-setup], reported from caption)
8. Setup creates the first Bot, named "Grok Bot", and opens its chat. The composer reads "Message Grok Bot". Earlier versions showed a "Create your first Bot" form here instead. ([docs: get started][d-start], seen; [learngrokbot: setup][lgb-setup], reported)
9. The first Bot speaks first. "Working on it" shows first; the guide says it lasts five to ten seconds ([learngrokbot: first Bot][lgb-first-bot], reported). Then a greeting and a question card arrive ([learngrokbot: first Bot][lgb-first-bot], seen in screenshot). (See section 5.3 for question cards.)
10. If no primary Bot is set, a dialog titled "Introducing Primary Bot" appears. It shows a Bot picture with a small orange star and reads, in substance, that the primary Bot works proactively, is your go-to for everyday tasks, unblocks your work and checks in when it needs you. It has two buttons: "Use an existing Bot", which opens a searchable list of Bots and a "Confirm" button, and "Create Primary Bot". ([learngrokbot: chief of staff][lgb-cos], reported from caption; [docs: bots][d-bots], seen; [Flavio Copes][flavio], reported)
11. The docs suggest starter templates (Morning briefing, Inbox manager, Competitive intelligence, Travel coordinator) and prebuilt marketplace Bots (Overheard, Tradbot, Meeting Recap Deck, Pitch Deck Coach). ([docs: get started][d-start], seen)
12. Importing memory from another assistant is optional: Settings, General, "Import Memory to Grok Bot", "Start Import". You copy a prompt into the other assistant, paste its answer into a second box and choose "Add to Memory". The import goes to the primary Bot. ([docs: bots][d-bots], seen; [docs: settings][d-settings], seen)

### iOS

- The iPhone welcome screen in the App Store shows the Grok Bot wordmark centered, the line "Your team of always-on Bots that finish the work.", a black full-width "Log in" button and a light grey "Sign up" button. Five Bot avatars float around the edges. ([App Store][appstore], seen)
- The phone sign-in labels include "Continue with Google", "Sign in with Apple", "Continue with email", "Enter your verification code" and "Use the browser instead". Linking a Grok subscription uses "Link Grok Account" and then "Finished Linking? Refresh My Status". ([docs: mobile][d-mobile], seen)
- The phone asks for notification permission during first run. ([docs: settings][d-settings], seen)
- Linking a SuperGrok or X Premium+ subscription: the guide, verified 6 October, said the link had to be made on a computer first ([learngrokbot: setup][lgb-setup], reported). The current docs describe linking on the phone: "Link Grok Account" on the access screen, sign in to Grok in the browser, then "Finished Linking? Refresh My Status". A link made on desktop also works on the phone ([docs: mobile][d-mobile], seen; [docs: get started][d-start], seen).
- While the computer starts, the phone home screen shows "Starting your computer…". ([docs: troubleshooting][d-trouble], seen)

### Empty and error states in onboarding

- "Grok Bot couldn't finish setting up" and "Retry exhausted for onboarding-bot-provision after 3 attempts". ([learngrokbot: error messages][lgb-errors], reported)
- Sign-in errors: a red banner "Authentication error" with the line "If you are logged in, try logging out and back in."; on the web page, "There was an issue authenticating". ([learngrokbot: sign-in][lgb-signin], reported from caption)
- An "Update required" overlay covers the whole window when the app version is more than 14 days old and a newer one exists. ([docs: troubleshooting][d-trouble], seen)

---

## 2. The Bot roster (sidebar)

### Desktop layout

From a first-hand sidebar screenshot (dark theme, about 280 points wide) and the docs:

- **Top row:** two round icon buttons at the top right of the sidebar, search (magnifier) and "New chat" (+). Until desktop 0.58.0 these sat elsewhere. ([alexop.dev][alexop], seen; [learngrokbot: changelog][lgb-changelog], reported)
- **Pinned Bots** appear as a grid of large tiles, three per row. Each tile is a big avatar, about a quarter of the sidebar's width, with the name centered below it and truncated with an ellipsis. The selected tile gets a slightly lighter rounded-rectangle background. ([alexop.dev][alexop], seen)
- **The primary Bot** carries a small orange circular badge with a white star on the lower right of its avatar. When it is the only pinned Bot, it sits alone as a large tile above the list. ([alexop.dev][alexop], seen; [learngrokbot: multiple Bots][lgb-multi], seen)
- **Sections:** below the tiles, user-made sections such as "fitness" or "dev stuff" appear as small grey lowercase headers. You make them with right-click, "Move to new section", and move Bots with "Move to". Sections sync to iOS. ([alexop.dev][alexop], seen; [docs: bots][d-bots], seen)
- **List rows:** a small avatar (about one eighth of the sidebar's width) on the left. The name is in white on the first line. The second line is a grey, one-line preview of the latest message, truncated. The preview shows the latest message even when it is a form, photo, widget or approval request. ([alexop.dev][alexop], seen; [changelog][x-changelog], reported)
- **Label chip:** a Bot's label shows as a small grey pill beside its name in the row, for example "News watch". ([learngrokbot: multiple Bots][lgb-multi], seen)
- **Group chats** sit in the same list as Bots. The design post shows a group row with a stacked or combined avatar and a preview prefixed with the speaker's name, such as "John: checkout's clean on staging, 3 bugs closed." ([x.ai design post][x-design], seen)
- **Footer:** a wide "Connect apps" button with three small app icons at its right end. Below or near it, a collapsible "Hidden Bots" section, the account menu at the bottom left, and a round update button with the tooltip "Restart to update" when an update is ready. ([learngrokbot: plugins][lgb-plugins], reported from caption; [docs: bots][d-bots], seen; [Flavio Copes 1.0][flavio-10], reported)
- **Limits:** the design post gives about 50 Bots per account and six per group chat. Flavio Copes reports a combined cap of 50 for Bots and group chats. The cap on how many Bots you can create was lifted on 1 September per the changelog. These conflict, so treat the number as soft. ([x.ai design post][x-design], seen; [Flavio Copes][flavio], reported; [learngrokbot: changelog][lgb-changelog], reported)

### Status and attention states

- The sidebar distinguishes three states: "Needs attention" for a question, approval or handoff; "Unread activity" for a new result; and a working or typing status. Opening a conversation marks its activity as read. The Bot menu has "Mark as Unread" and the matching "Mark as read". The sidebar and the macOS dock badge show unread activity. ([docs: settings][d-settings], seen; [learngrokbot: multiple Bots][lgb-multi], seen in menu screenshot)
- When a Bot waits for an approval, sign-in or other answer, its row turns orange and the preview starts with "Waiting for you". The state clears once the Bot is no longer waiting. ([learngrokbot: approvals][lgb-approvals], reported; [changelog][x-changelog], reported)
- While a routine runs, the Bot's row shows a green dot. ([learngrokbot: routines][lgb-routines], reported)
- After you answer a request to use your own computer, the row shows "Allowed", "Denied" or "Expired" instead of "Permission required". ([changelog][x-changelog], reported)
- The avatar itself shows the Bot's state through motion. The design post lists idle, thinking, working, waiting, blocked and done, and says the avatars in the sidebar and the chat's activity line are animated. (See section 5.1.) ([x.ai design post][x-design], seen; [changelog][x-changelog], reported)
- One accessibility detail: a third-party tool reads the busy state from the window, where a busy Bot's sidebar button is named "&lt;Bot&gt;, Working". ([perch PR][perch], reported)
- No public source describes a numeric unread count on rows. The App Store iPhone home list shows a timestamp at the right of each row ("8:41 AM", "Yesterday", "Tuesday") and no count. ([App Store][appstore], seen)

### Ordering

- Pinned Bots stay at the top ([docs: bots][d-bots], seen). The order of sections is not documented. (no public material found)
- No source documents the sort order inside a section or in the unsectioned list. The App Store iPhone list is sorted newest activity first: 8:41 AM, 8:22 AM, 8:05 AM, Yesterday, Tuesday. (inferred from [App Store][appstore])
- `Cmd/Ctrl+1` to `9` jump to sidebar Bots; `Alt+Up/Down` and `Control+Tab` move between Bots. ([docs: chat][d-chat], seen)

#### Clawtrate design proposal: sort order

Not Grok Bot evidence.

- A sort control in the sidebar header (desktop, iPad), or next to search on the iPhone home screen, offers three orders. "Recent activity" is the default: the latest message or run event in any of the Bot's tasks, newest first. "Name" sorts A to Z, ignoring case. "Manual" uses the user's own order.
- Pinned Bots always stay above the list, in their own manual order. Within each section, Bots follow the chosen order; sections keep their manual order.
- In Manual, Bots are reordered by dragging a row (desktop, iPad), or on iPhone with "Edit order" in the sort control, which shows drag handles, then "Done". Dragging is available only in Manual. A new Bot goes to the end.
- The chosen order and the manual positions persist across restarts. Switching to another order keeps the manual positions, and switching back restores them. Manual positions are stored where other clients of the same gateway can read them; if the gateway cannot store them, they are kept per client and the sort control says "This device only".

### Row context menu (right-click)

A first-hand screenshot of the primary Bot's menu lists, top to bottom, with a separator after the third and fifth items: "Pin", "Move to" (submenu), "Mark as Unread", "Rename Bot", "Copy conversation ID", "Hide from sidebar", "Replace with different Bot". Other Bots show "Delete" where the primary Bot shows "Replace with different Bot". The menu loses "Edit Profile" and "Duplicate" from desktop 0.57.0. Double-clicking a name in the sidebar renames it inline. ([learngrokbot: multiple Bots][lgb-multi], seen, image credited to a Riley Brown video; [docs: bots][d-bots], seen; [learngrokbot: changelog][lgb-changelog], reported)

### Hide, restore and delete

- "Hide from sidebar" removes a Bot from the main list. Its history, memory and routines keep running. "Hidden Bots" at the foot of the sidebar is a collapsible section, and each hidden Bot's menu there has "Show in sidebar". On the phone, a hidden list has "Unhide", and if every Bot is hidden the home screen shows "Show Hidden Bots". ([docs: bots][d-bots], seen; [changelog][x-changelog], reported)
- "Delete" erases the profile, conversations, memory, routines, attachments, the shared facts it saved, and any templates shared from it. It cannot be undone. Files and sign-ins on the shared computer may remain. ([docs: bots][d-bots], seen)

### iOS home screen

See section 14.

---

## 3. Creating and editing a Bot

### Create

There are two creation paths in the sources, and they may both exist:

- **Dialog path** (docs and App Store, current): "New Bot" (the + at the top of the sidebar) or `Cmd/Ctrl+N` opens a "Create New Bot" dialog. You type a name, pick a shape and a color, and press "Create". The chat with the new Bot opens. ([docs: bots][d-bots], seen)
  The iPhone version is a sheet titled "Create New Bot" with a round close (X) button at the top left. A large preview of the avatar sits in the upper third. Below it is a wide rounded name field with centered bold text (the example reads "Personal Shopper"). Then come two rows of four shapes in the chosen color, two rows of color swatches, and a black full-width "Create" button at the bottom. The selected shape and swatch each get a thin light ring. ([App Store][appstore], seen)
  Shapes in that screenshot: circle, rounded blob, rounded square, pill, triangle, hexagon, cloud and droplet. Colors: white, brown, red, orange, amber, green, teal, blue, purple, pink and grey. Later updates added square, sparkle, clover, flower, heart, house and star shapes, bigger eyes, and a Halloween pumpkin. ([App Store][appstore], seen; [Flavio Copes][flavio], reported)
- **To: field path** (learngrokbot, early October): "New chat" (+) opens a "To: Start a chat with…" field across the top of the chat area, with a dropdown whose first rows are "Create new Bot" (+ icon) and "Create group chat" (people icon), followed by existing Bots. Typing a name narrows the list to one row, `Create "<name>" Bot`. "Create new Bot" without a name makes a Bot called "New Bot". If you type the name of an existing Bot, its row shows a "New chat" tag at the right. ([learngrokbot: first Bot][lgb-first-bot], seen; [learngrokbot: usage running out][lgb-usage-out], reported)
- On a Cursor team, + opens a menu with "Create a Bot" and "Browse shared Bots". ([docs: get started][d-start], seen)
- A slow creation shows "Still creating", and your typed text is kept. A failure reads "Could not create the Bot. Please try again." ([Flavio Copes][flavio], reported; [learngrokbot: error messages][lgb-errors], reported)
- Existing Bots can propose or create a new Bot themselves. The new Bot appears in the sidebar. ([docs: bots][d-bots], seen; [learngrokbot: multiple Bots][lgb-multi], reported)

### What you can configure

| Field | Behavior | Source |
|---|---|---|
| Name | Set at creation, editable by the owner. | [docs: bots][d-bots], seen |
| Picture | Shape and color at creation. Later: the "Bot" tab changes the character's look; "Generate" takes a description, then "Generate" and "Set avatar"; "Upload" takes a dropped image or "Browse files", then cropping and "Set avatar". Limit 25 MB. On the phone, "Upload" offers "Choose from Photos" or "Take Photo". | [docs: bots][d-bots], seen |
| Label (desktop) / Title (phone) | A short tag shown beside the name in the sidebar. Empty state reads "Add a label" in grey. | [docs: bots][d-bots], seen; [learngrokbot: first Bot][lgb-first-bot], seen |
| Description | Personal Bots have none any more. Team Bots have one under "About", editable by the owner or a Manager. | [docs: bots][d-bots], seen |
| Instructions | No field and no "Bot settings" page. You change behavior by telling the Bot in chat, and it stores lasting rules in memory. | [docs: bots][d-bots], seen; [forum: instructions][f-instructions], reported |
| Notifications | Per-Bot switch. A toggle in the Bot's profile on the phone. On desktop you ask the Bot to change it. | [docs: settings][d-settings], seen |
| Model | None. "There is no model picker." | [docs: FAQ][d-faq], seen |

Users followed a workaround for the missing description: they send a message that starts "Set your description to this:" and ask the Bot to read the saved text back. The Bot replies "Saved description" and repeats it. Staff say this does not give reliable results. ([learngrokbot: first Bot][lgb-first-bot], seen in screenshot; [forum: description][f-description], reported)

The description field existed until late September 2026. The old right-click item "Edit Profile" and the "Bot settings" page are gone. Mobile kept an "Instructions" field in "Details" for a while, but staff said text entered there is not reliably applied. ([forum: description][f-description], reported; [forum: instructions][f-instructions], reported)

### Edit

- **Desktop:** click the Bot's name in the floating pill at the top of the chat. This opens the details panel on the right (section 4.2). Click the picture, the name or "Add a label" to edit each one in place. ([docs: bots][d-bots], seen; [learngrokbot: first Bot][lgb-first-bot], seen)
- **Phone:** tap the name at the top of the chat to open the profile, tap "Edit", change "Name" or "Title", then "Done". ([docs: bots][d-bots], seen)
- "Rename Bot" is hidden for Bots you do not own. ([docs: bots][d-bots], seen)
- `Cmd/Ctrl+Shift+,` toggles "Bot settings", which now means the details panel. ([docs: chat][d-chat], seen)

### Duplicate and share

- Duplicate is iPhone-only, by long press. It copies the profile, settings, enabled skills, routines and avatar. It does not copy history, learned memory or attachments. ([docs: bots][d-bots], seen; [App Store][appstore], seen in version notes)
- Share as template: details, "Share", "Create a copy". A template card is posted in the chat, with "Publish" and then "Copy link". The recipient sees a preview on x.ai and chooses "Add to Grok Bot". After publishing, "Share" offers "View template details", "Update template" and "Delete Template". On the phone the item is "Share as Template". ([docs: bots][d-bots], seen)
- The template import dialog shows the Bot's picture, name, author and description, then two expandable rows, "Context" ("Instructions, memories, and skills") and "Routines", and an "Add Bot" button at the bottom right. ([learngrokbot: use cases][lgb-usecases], reported from caption)

---

## 4. Starting a conversation, and how work is organized under a Bot

### 4.1 One continuous primary conversation per Bot

This is the most important structural fact for Clawtrate. **In Grok Bot, a Bot has one continuous primary conversation, without a general list of independent user tasks.** ([forum: threads][f-threads], reported; [forum: compaction][f-compact], reported) There are narrower exceptions, listed below: reply threads on single messages, routine runs that open in their own chat, and a Tasks tab for coding-agent runs.

- The design post says Grok Bot is organized around Bots rather than conversations, because "chats are disposable" and you come back to the same Bot tomorrow. ([x.ai design post][x-design], seen)
- Staff confirm there is one continuous conversation per Bot. Starting a "New chat" with the same Bot opens a group chat named like "Bot + me", not a fresh session. A second request waits while the Bot is busy. ([forum: compaction][f-compact], reported; [forum: parallel threads][f-parallel], reported)
- You can reply to a single message in a thread (reply threads), which is meant for feedback on one result or approval. ([docs: chat][d-chat], seen)
- "Reset this conversation?" exists only as a recovery path. A blocked-message notice offers "Reset". The history restarts, and memory, files, routines and settings stay. ([docs: bots][d-bots], seen)
- Long conversations are summarized automatically near the context limit. Every reply re-reads the whole conversation, so long chats cost more. There is no manual compaction, no context meter and no fresh session. ([forum: compaction][f-compact], reported; [CellCog][cellcog], reported)
- The workaround staff suggest is one Bot per topic, hiding Bots whose topic is finished, and duplicating a Bot to fork it. ([forum: threads][f-threads], reported)
- Routine runs open in their own chat, and "Close Chat" brings you back to the main conversation. ([changelog][x-changelog], reported)
- The details panel has a "Tasks" tab that lists Cursor Cloud Agents a Bot started, under "Coding", with the states "Working", "Run failed" and "Status unavailable". A finished agent shows "Working" again when a follow-up starts. ([changelog][x-changelog], reported)
- A Bot can start a "Project" when asked: a Cloud Agent that plans the work and runs its own agents. ([changelog][x-changelog], reported)

#### Clawtrate design proposal: tasks under each Bot

Not Grok Bot evidence. This is Clawtrate's intended behavior; the gateway capability map decides how tasks map onto gateway sessions.

- **Structure.** A Bot owns a list of tasks. Tasks share the Bot's instructions, memory, skills, routines and permissions. Each task has its own transcript, context and run state, and a task never shows another task's messages.
- **Main task.** A new Bot starts with one task called "Main". **A Bot always has at least one task that is not archived:** archiving or deleting its last such task creates a new empty "Main" task at once, and that task is selected.
- **Desktop and iPad sidebar.** A Bot row has a disclosure control, and its expanded or collapsed state persists across restarts. Expanded, the Bot's tasks are listed under it, indented. Each task shows its title, its status and the time of its last activity ("2m", "Yesterday"). Whether expanded or collapsed, the Bot row shows the most urgent status among its tasks, in this order: waiting for you, failed or blocked, working, unread, idle.
- **iPhone.** The home screen lists Bots, with the same status priority on each row. Tapping a Bot opens its task list, with the Bot's avatar and name in the header and "New task". Tapping a task opens its chat. Back from the chat returns to the task list, and Back from the task list returns to the home screen. The phone has no sidebar.
- **Task statuses:** working, waiting for you, blocked, failed, done (an unread result), done with failures (a completed run had a failed step), idle. They follow the run states in section 5.6.
- **New task.** "New task" on the Bot row (desktop and iPad) or in the task list (iPhone) creates an empty task, selects it and focuses the composer. A message sent there runs in the new task.
- **Rename.** On desktop, double-click the task title or choose "Rename" from its menu. On iPhone and iPad, touch and hold, then "Rename". The new title shows in the sidebar or task list and in the task header.
- **Archive.** "Archive" moves a task into a collapsed "Archived" group under its Bot, with its history kept. "Restore" in that group brings it back. If the task has an active run, the dialog offers "Stop and archive" or "Cancel". Archiving cancels the task's queued messages; the dialog lists how many will be cancelled, and they never run.
- **Delete.** "Delete" asks for confirmation, stops an active run first, cancels queued messages, and removes the task's transcript. Memory saved during the task stays, because memory belongs to the Bot.
- **Routine runs** each create a task marked with the routine's name.
- **Context meter and Compact.** The task header shows context use as tokens used out of the model's context window when the gateway reports both, and "Context: unavailable" otherwise. "Compact" replaces older turns in the model's context with a summary. The transcript keeps them, folded under a "Compacted 24 turns" line that expands to show them.

### 4.2 Desktop chat layout

From a first-hand screenshot of a 1:1 chat with the details panel open (dark theme):

- The chat column takes about two thirds of the window width, and the details panel about one third, divided by a thin vertical line. ([learngrokbot: what is][lgb-what], seen)
- The chat header is a floating dark pill at the top center of the chat column, holding the Bot's small avatar and name. Clicking it opens "View conversation details". ([learngrokbot: what is][lgb-what], seen; [docs: files][d-files], seen)
- A centered grey timestamp separates time blocks, for example "Today 2:55 PM" or "Sun, Oct 25 7:35 PM". ([learngrokbot: first Bot][lgb-first-bot], seen; [alexop.dev][alexop], seen)
- **Your messages** are right-aligned rounded bubbles filled with the Bot's color (blue for a blue Bot, orange for an orange one), with white text. "Settings, Appearance, Accent" can switch this from "Bot color" to "Black". ([learngrokbot: what is][lgb-what], seen; [alexop.dev][alexop], seen; [docs: settings][d-settings], seen)
- **The Bot's messages** are left-aligned dark grey rounded bubbles. Consecutive messages stack as separate bubbles with a small gap. In a 1:1 chat there is no avatar or name beside each bubble. Bubbles are at most about three quarters of the column's width. Markdown tables render inside the bubble, and wide tables can extend into the empty space beside the message. ([learngrokbot: what is][lgb-what], seen; [Flavio Copes][flavio], reported)
- Hovering a Bot message shows three small icon actions to its right: react (smiley), reply (curved arrow) and more (three dots). The more menu has "Download" or "Download all" for media, "Copy request ID" for errors, and other actions. ([alexop.dev][alexop], seen; [docs: files][d-files], seen)
- **Composer:** a full-width rounded pill at the bottom. A round "+" button sits on the left, and the placeholder reads "Message &lt;Bot name&gt;". At the right, a round microphone button ("Start voice input") and a round white waveform button ("Start voice chat"). ([learngrokbot: first Bot][lgb-first-bot], seen; [learngrokbot: what is][lgb-what], seen) The waveform shows only when the composer is empty; once you type, a round send arrow replaces it. ([learngrokbot: first Bot][lgb-first-bot], reported; the saved screenshots show only the empty composer)
- The "+" menu opens upward with "Attach files" and "Teach a task" (with a red record dot). ([learngrokbot: skills][lgb-skills], reported from caption)
- Composer shortcuts: `@` mentions a Bot, group, routine or app; `/` opens a skill list (it was removed in 0.68.1, per one user, and the docs say to ask for a skill by name); `>` at line start makes a block quote; `Enter` sends, `Shift+Enter` adds a new line, `Cmd/Ctrl+Enter` sends from anywhere; `Cmd/Ctrl+D` starts dictation; `Cmd/Ctrl+/` lists all shortcuts; `Cmd/Ctrl+F` finds in chat; `Cmd/Ctrl+I` focuses the prompt; `Cmd/Ctrl+L` adds selected text to chat; `Cmd/Ctrl+K` opens search across Bots, groups, messages, files, links, routines and settings; `Cmd/Ctrl+Shift+F` searches Bots. In the desktop search palette, when results say "Searched recent messages", "Search older" looks further back. ([docs: chat][d-chat], seen; [Flavio Copes][flavio], reported; [forum: instructions][f-instructions], reported)
- The `/` menu, when present, lists matching rows with a right-aligned tag. Typing "/check" showed "Check Cursor changelog" tagged "Skill" and "Check for Updates" tagged "Action". A sent skill appears as a chip in your bubble. ([learngrokbot: skills][lgb-skills], reported from caption)
- On the phone, an unsent draft is kept per conversation ([docs: mobile][d-mobile], seen). Desktop draft persistence is not documented. (no public material found)
- Attachments: up to 20 per message, images 25 MB each and 200 MB total, documents 250 MB, video 1 GB. An oversized file is flagged and dropped. While files upload, your message shows a "Sending…" bar that fills. ([docs: files][d-files], seen; [changelog][x-changelog], reported)
- A failed send shows "Failed to send" with "Resend" and "Delete". On the phone, a divider reads "SEND AFTER RECONNECT". ([learngrokbot: changelog][lgb-changelog], reported; [learngrokbot: error messages][lgb-errors], reported)

### 4.3 Details panel

- It opens on the right when you click the Bot's name. A share button (upload icon) and a close button (X) sit at the top right. Below them, centered: a large avatar about a fifth of the panel's width, the name in bold, "Add a label" (or the label) in grey, then a segmented control with three tabs, "Details", "Library" and "Computer". ([learngrokbot: first Bot][lgb-first-bot], seen)
- **Details** lists "Routines". Each routine is a rounded row with its name, a second line with its schedule or "Paused", and a switch on the right. The empty state reads "Ask in chat to set a routine". On Team Bots, "Details" also shows "About" (the description). Meetings appear under "Upcoming", and "Suggested" can hold "Add to meeting" or "Review learnings". ([docs: routines][d-routines], seen; [docs: meetings][d-meetings], seen; [docs: team Bots][d-team], seen)
- **Library** lists what the Bot made and sent (section 9.5). ([docs: files][d-files], seen)
- **Computer** shows a 16:9 live thumbnail of the Bot's screen with a dark "Open" pill (expand icon) centered over it, and the caption "&lt;Bot&gt;'s screen". (Section 7.) ([learngrokbot: what is][lgb-what], seen)
- A "Tasks" tab appears when the Bot has launched cloud agents. ([changelog][x-changelog], reported)
- An older layout had "Details / Media / Computer", and "Media" became "Library" in v0.62.0. ([forum: description][f-description], reported; [learngrokbot: changelog][lgb-changelog], reported)

### 4.4 Group chats

- Create with "New chat", `Cmd/Ctrl+Shift+N` or `Cmd/Ctrl+K` and then "New group chat". On the phone, "+" and then "New Group Chat". Add two to six Bots in the "To:" field. The generated name begins with your own name and then lists the Bots, and you can rename it with right-click, "Rename chat". ([docs: chat][d-chat], seen; [learngrokbot: multiple Bots][lgb-multi], seen)
- The group header is a centered pill with the group's name. Each Bot reply has the Bot's name above it in small text in that Bot's color, and the Bot's small avatar sits at the bottom left of its last bubble. Your messages are right-aligned in a neutral grey, since a group has no single Bot color. ([learngrokbot: multiple Bots][lgb-multi], seen)
- Bots decide among themselves who answers. `@Bot` targets one Bot, `@everyone` all of them, and "Reply" answers one Bot. ([docs: chat][d-chat], seen)
- **The sources conflict on approvals in groups.** The collaboration page says approval requests, secret and login requests, and email and Slack drafts do not appear in a group ([docs: chat][d-chat], seen). The independent guide, dated to the 12 September build, says a Bot that needs your OK says the step is blocked and asks you to open its own chat ([learngrokbot: multiple Bots][lgb-multi], reported). But the approvals page describes group approval cards: only the person whose message the Bot is answering can approve, others see who the card waits on, and "Always allow" is not offered ([docs: approvals][d-approvals], seen). Which one is current is unresolved.
- Groups have no voice chat and no per-Bot notification switch. ([docs: chat][d-chat], seen)

---

## 5. The conversation while a Bot works

### 5.1 The thinking and working UI

The owner named this as a detail he likes. The public evidence, in order of strength:

**What the official design post says** ([x.ai design post][x-design], seen):

- The team rejected the standard three animated dots, because they cannot tell working apart from stuck.
- They tried a short written description of the current action, and users then wanted every step, mostly for reassurance.
- The final design makes the Bot's avatar the first signal. The avatar shows the lifecycle state through motion: calm and a little curious at rest, it acknowledges incoming work, speeds up while working, changes its motion when waiting or needing help, and settles when finished. The named states are idle, thinking, working, waiting, blocked and done.
- If you want to know what the Bot is doing, you can hover to see its **current action**. The post does not say which element you hover, and it does not describe a hover-accessible step log or any view of raw tool calls.
- An illustration in the post lists steps: "Searching the web", "Environment ready 387ms", "Edited math.ts +14 −10", "Ran focused tests npm test", "Thought briefly", "Read AGENTS.md", "Ran full suite 212 passed", "Committed fix: clamp NaN". Each step is a short verb phrase followed by a detail: a duration, a command or a result in muted text, or a diff count given as + and − figures. The post does not say where in the shipped app such a list appears.

**What a first-hand screenshot shows** ([learngrokbot: home][lgb-home], seen):

- Under the last Bot bubble, flush left, there is no bubble. The Bot's small avatar (about the height of two lines of text) sits beside the words "Clicking around" in grey. The first word looks dimmer than the second, which suggests a light sweeping across the text (a shimmer). The shimmer is inferred from one still frame.
- Above that line, the Bot has already posted two short progress bubbles: "On it — pulling Notion, Asana, and Trello public pricing now, then I'll set the Monday check." and "Reading the Notion, Asana, and Trello pricing pages now — table next, then the Monday watch." The answer then arrives as a further bubble.

**What the official changelog says** ([changelog][x-changelog], reported):

- The status line shows up right after you send, even for quick replies.
- The status is a short phrase in your language, in the app and in Slack. Examples: "Thinking it through", "Working on your computer", "Working on it" and "Thinking". The Bot's name is not put in front.
- Greetings and small talk changed over time. An earlier entry made the status for a greeting, thanks or small talk read "is on it" or "is working on it". A later entry replaced that with a status that names the work, and a still later fix keeps a line such as "Thinking it through" showing while the Bot replies. The entries are undated in the excerpts; their order comes from the page order.
- Specific statuses ("Working on your computer") show at once. Generic ones ("Working on it", "Thinking") wait a moment before appearing, so a fast reply never flashes a generic status.
- While a Bot works with nothing to report, a 1:1 chat shows just its animated avatar.
- Animated avatars in the sidebar and in a chat's activity line were made to move more smoothly.
- The Bot stops showing that it is working once a background task finishes.

**What users report:**

- In August, a designer called it surprising that Grok Bot hides all the thinking steps and tool calls. He said it forces a "model take the wheel" mindset, and that the system is opaque: he could not tell whether the Bots used his database correctly. ([Brian Lovin on X][lovin], reported)
- The docs say the transcript shows "tool activity, computer use, created files, questions, approval requests, and voice memos", and that "the chat shows each step as the Bot works". These lines conflict with the user reports. My reading is that "steps" in the docs means the progress messages, system events and cards, not raw tool calls. ([docs: chat][d-chat], seen; [docs: how it works][d-how], seen; inferred)
- A leaked system prompt, which xAI has not confirmed, tells the Bot to post short updates at meaningful moments and never to go silent through a long run of tool calls, because the user would see silence and assume the app froze. This matches the narrated-bubbles pattern. ([leaked prompt][leak], reported)

**Summary of the working UI as shipped** (inferred from all of the above):

1. You send. Within a moment, a working line appears under the conversation: the Bot's animated avatar and a short status phrase in grey, with a shimmer.
2. The Bot narrates progress as separate short chat bubbles. These are written by the model, not generated by the UI.
3. Tool calls, browser steps and shell commands are not listed by default. On desktop, hovering shows the current action, but which element is the hover target is not established. No source shows an expandable step log or raw tool calls in a shipped screenshot, and no touch equivalent of the hover is documented for iOS.
4. When the Bot finishes, the working line disappears and the answer bubble or a card appears. A Bot no longer sends a message that only says it is done (1.0.1).
5. Meanwhile the sidebar avatar animates, and the row shows a working state.

No source describes token-by-token text streaming. Messages appear to arrive as whole bubbles. That is inferred from the screenshots and from changelog fixes about replies "flickering in". ([changelog][x-changelog], reported; inferred)

### 5.2 System events in the transcript

Small grey lines that are not bubbles mark things the Bot did. The design post says these events "can be opened for detail". ([x.ai design post][x-design], seen)

| Event line | Look | Source |
|---|---|---|
| "Created routine" + clock icon + routine name | Grey, small, right-aligned under the Bot's bubble. The routine name is a chip that opens the routine's panel. | [learngrokbot: routines][lgb-routines], seen |
| "Updated routine" | Same style. | [learngrokbot: routines][lgb-routines], reported |
| "Messaged" + small avatar + Bot name | Same style. See section 6. | [learngrokbot: multiple Bots][lgb-multi], seen |
| "Message from" + small avatar + Bot name | Same style. | [learngrokbot: multiple Bots][lgb-multi], seen |
| "6 messages with Kenny, Tyler and Jenny" | Event summarizing an exchange. | [x.ai design post][x-design], seen |
| "Saved to memory" | After a "Thinking" indicator, in the product-page mockup. | [x.ai product page][x-product], seen |
| "Voice chat" + duration | Opens the call transcript. | [learngrokbot: first Bot][lgb-first-bot], reported |
| "Strava connected" | A completed-step line in a Bot's chat. | [alexop.dev][alexop], reported |
| "This turn was stopped after 50 minutes so it would not hang. Send a message to pick up where it left off." | Grey note. | [learngrokbot: error messages][lgb-errors], reported |
| "A background task was stopped after 3 tool calls in a row timed out; the computer may be unresponsive." | Grey note. | [learngrokbot: error messages][lgb-errors], reported |

In the routine and price-watch crops these lines sit at the right; in the hand-off crop the "Messaged" line sits nearer the middle, so alignment against the full chat column is not established. They use a smaller grey font, with the icon or avatar and the name in a slightly lighter grey. They sit between bubbles with normal spacing. ([learngrokbot: multiple Bots][lgb-multi], seen; [learngrokbot: routines][lgb-routines], seen)

### 5.3 Cards in the transcript

Cards are wide rounded panels with a title at the top left, an optional status tag at the top right and buttons at the bottom. In the captured question and approval cards the fill is a dark grey close to that of the Bot's bubbles; the email draft card puts its fields in a near-black inset. ([learngrokbot: approvals][lgb-approvals], seen; [learngrokbot: gmail][lgb-gmail], seen; [learngrokbot: first Bot][lgb-first-bot], seen)

- **Question card:** a title such as "Who or what should I watch?" with an X at the top right. The captured example lists four lettered options (A to D) as rows, each with a grey letter badge, and an option can have a second grey line ("Type the names yourself"). Other option counts are not documented. A "Type your own answer" field sits at the bottom. ([learngrokbot: first Bot][lgb-first-bot], seen)
- **Answered question card:** the card keeps its title ("What should I help with most?") and shrinks to a single dimmed row below it with the chosen letter and text ("B Tracking news or competitors") and a check mark at the right. The other options and the free-text field are gone. ([learngrokbot: first Bot][lgb-first-bot], seen) The Bot no longer repeats the question as a separate message. ([changelog][x-changelog], reported)
- A multiple-choice variant says "Choose all that apply". ([alexop.dev][alexop], reported)
- **File card:** a rounded panel with a document icon on the left, the file name and its size below ("grokbot-setup-overview.md", "37kB"). Clicking it opens a preview with "Download file". ([alexop.dev][alexop], seen; [learngrokbot: first Bot][lgb-first-bot], reported)
- **Link card:** an app icon, the title and the domain ("Q3 board deck v4", "docs.google.com"). Hover shows a preview, and private Notion, GitHub and Slack links show their real titles. ([App Store][appstore], seen; [docs: files][d-files], seen; [changelog][x-changelog], reported)
- **Page card:** the title and "Open". Older cards for the same Page read "Updated below". ([docs: files][d-files], seen)
- **Draft cards** for email and Slack: see section 8.5.
- **Approval, Computer, Secure Form, secret and connect cards:** see sections 7 and 8.
- **Cloud Agent card** with its files, "View PR" and "Open in Cursor" (phone wording). ([docs: files][d-files], seen)
- **Shopping, order and phone-call cards:** see section 15.

### 5.4 Steering, stopping and progress controls

- You can send more instructions while a Bot works. A new direct message redirects the current turn and outranks background work. ([docs: chat][d-chat], seen)
- **No per-turn Stop control was established by the examined material.** The docs tell you to end work by sending a direct message such as "Stop now". Stopping does not undo completed actions. ([docs: chat][d-chat], seen; [docs: troubleshooting][d-trouble], seen)
- Stop cascades: it ends the Bot's background subagents (whose pending approval cards then expire), the other Bots it handed work to, the Cloud Agents it started, and anything still running on its computer. A Bot stuck on an unresponsive step ends within about 30 seconds of a stop or a new message. An email "Send" that a stop cut off still goes out. ([changelog][x-changelog], reported; [learngrokbot: changelog][lgb-changelog], reported)
- Sending a new message closes any open approval card in that chat. ([docs: approvals][d-approvals], seen)
- No progress bar, percentage or elapsed timer exists for a Bot turn. The only progress UI is the working line and the narrated bubbles. ([docs: chat][d-chat], seen; inferred)
- A computer-use task already running on a Bot's screen can block a new one until it finishes or is redirected. ([docs: troubleshooting][d-trouble], seen)
- When several messages are sent quickly, the Bot answers all of them, including the first. ([changelog][x-changelog], reported)
- Hard caps: a turn stops after 50 minutes, and a background task stops after three timed-out tool calls in a row, each with a grey note. ([learngrokbot: error messages][lgb-errors], reported)

### 5.5 Errors and retries

- "Bot failed to respond": a dark red banner with a warning triangle, the title in bold and a second line ("Something went wrong while generating the reply. Try again.", "This request has been rate limited, try again shortly.", or "Something went wrong. Technical details: EAGAIN"). A round close button sits at the right. The fix is to resend. ([learngrokbot: not responding][lgb-notresp], seen; [docs: troubleshooting][d-trouble], seen)
- Other reply errors: "Model provider is overloaded", "Rate limit exceeded.", "Something went wrong on our end. Please try again." ([learngrokbot: error messages][lgb-errors], reported)
- In-app errors are collected above the composer under "Notifications". You can dismiss one or clear all, and some include "Copy request ID". ([docs: settings][d-settings], seen)
- When the app is offline: a "You're offline" banner with "Grok Bot refreshes on its own when you're back online". The chat shows a pill at the top with a spinner, "Reconnecting", over a grey notice: "Showing saved messages. This conversation may be out of date and will refresh when the connection returns." ([docs: troubleshooting][d-trouble], seen; [learngrokbot: can't reach computer][lgb-cantreach], seen)
- When chats, pages, skills, routines or plugins fail to load, the app shows the error with "Try again" and keeps what it last loaded. ([changelog][x-changelog], reported)
- A display bug: a chat can stop showing new messages while the sidebar preview updates. The workaround is to click another Bot and come back. ([forum: stuck][f-stuck], reported)

### 5.6 Clawtrate design proposal: the working view

Not Grok Bot evidence. This is Clawtrate's intended behavior, written so a test can check it. Grok Bot's quiet presentation (state avatar, short phrase, progress messages) is the collapsed state, and the detail shows when the user expands it. Exact appearance, sizes and timing curves belong to the design specification under `docs/design/`.

**Run states.** Each turn of a task is a run with one state at a time. Non-terminal states: `queued`, `running`, `waiting` (a card from the run needs the user), `stopping`. Terminal states: `completed`, `stopped`, `failed`, `cancelled` (queued work removed before it started). A terminal state is final: later events for that run never change its state.

| From | Event or action | To | What happens to pending cards and queued messages |
|---|---|---|---|
| (none) | User sends with no active run in the task | `running` | — |
| (none) | User sends with "Queue after this turn", or sends while the active run is `stopping` | `queued` | The message shows a "Queued" chip. |
| `queued` | The active run reaches a terminal state | `running` | The oldest queued message starts. |
| `queued` | "Cancel" on the chip, or the task is archived or deleted | `cancelled` | The message never runs. |
| `running` | A card from this run becomes pending (approval, question, Secure Form, Computer) | `waiting` | — |
| `waiting` | The last pending card is answered, expires or is dismissed | `running` | — |
| `waiting` | The user sends a steer message | `running` | Open approval cards close as "Closed by your message" (as in F-169). |
| `waiting` | The gateway reports the run finished | `completed` | Pending cards close as "Closed: the run ended"; their actions are not taken. |
| `running` or `waiting` | User presses Stop | `stopping` | Pending cards close as "Cancelled". |
| `stopping` | The gateway confirms the run stopped | `stopped` | Queued messages then start in order. |
| `stopping` | The gateway reports the run finished normally before the stop took effect | `completed` | The stop note says "Finished before Stop took effect". |
| any non-terminal | The gateway reports an error, or the run exceeds Clawtrate's turn limit | `failed` | Pending cards close as "Closed: the run failed". |

**Status line (collapsed view).** Within 1 second of a send (Clawtrate's choice), a status line appears at the bottom of the task's transcript, with the Bot's avatar and a phrase. The phrase always has text. While a step is running, it is that step's plain-language summary ("Reading the pricing pages"). When no step is running, including before the first step and after a step finishes while the Bot is still thinking, it is "Thinking". In `waiting` it reads "Waiting for you" and in `stopping` it reads "Stopping…". Progress messages, cards and Messaged cards that arrive during the run render above the status line, and the status line stays put. **It is removed only when the run reaches a terminal state.**

**Activity block.** Every run with at least one step has one activity block. A step is a tool call, a reasoning segment the gateway exposes, a Bot-to-Bot message, a T3 Code handoff or an approval. A run with no step, for example a plain reply with no exposed reasoning, has no block; its status line reads "Thinking" until it ends. The block sits in the transcript where the run's first step began, and is collapsed by default. While the run is non-terminal, its collapsed line reads "Working · 3 steps". At the end it reads "Worked for 1m 12s · 7 steps", "Thought for 8s" (when every step was reasoning), "Stopped after 40s · 4 steps" or "Failed after 12s · 2 steps". When any step failed, it adds "· 1 failed" (FC-15). Clicking or tapping the line expands the block into its step cards, and doing it again collapses it. Its expanded or collapsed state is kept while new steps arrive, while the user scrolls away and back, and when the user switches to another task and returns. Failed step cards stay visible under the collapsed line.

**Run result.** A run that completed with at least one failed step never presents as a plain success. Its task status becomes "done with failures", the sidebar or task-list row carries a failure marker until the task is opened, and its notification reads "Finished with 1 failed step".

**Step cards.** Collapsed, a step card is one line: an icon for its kind, a plain-language summary, a short detail (target, duration or result count) and a status (running, done, failed, waiting). On desktop, hovering a truncated summary shows it in full. Clicking or tapping a card expands only that card. It shows the inputs and the result in readable form; a running step shows its output as it arrives, where the gateway streams it. A "Raw" control shows what the gateway sent: for a tool call, the exact tool name, arguments, result, timing, error and identifiers; for a reasoning, approval or message step, the event as received with its identifiers, never invented tool fields. Each value can be copied. While one card is expanded, other cards keep updating, new cards keep appending, and nothing above the expanded card moves. On iPhone and iPad, touch and hold on a step card offers "Copy result", which copies the result text shown when expanded, and "Copy raw".

**Hover and touch for the status line.** On desktop, hovering the status line shows the current step's full summary in a tooltip (Grok Bot parity). On iPhone and iPad, tapping the status line expands the activity block and scrolls the running step into view.

**Avatar.** Each state has one qualitative motion in normal mode and one static variant with reduced motion:

| State | Entered when | Motion | Static variant |
|---|---|---|---|
| idle | No non-terminal run in any of the Bot's tasks | Still, with an occasional blink | Eyes open, looking ahead |
| thinking | A run is active and no tool step is running | Slow side-to-side sway, eyes drifting upward | Eyes turned upward |
| working | A tool step is running | Steady, quick bob in place | Eyes forward, with a small motion mark beside the avatar |
| waiting | A card from the Bot's runs is pending | Leans toward the viewer and pulses | Eyes on the viewer, with an attention badge |
| blocked | The gateway or the Bot's machine is unreachable, or the run cannot proceed without a settings change | No motion, slumped, eyes half closed | Eyes half closed, with a warning badge |
| done | A run completed and its task has not been opened since | One small settling nod, then still with smiling eyes | Smiling eyes |

When several states apply, the avatar shows the first in this order: waiting, blocked, working, thinking, done, idle. When waiting wins while the machine is unreachable, the warning badge from blocked is added. The state is exposed to accessibility as text, for example "Demo Research, working". Done returns to idle when the task is opened.

**Reduced motion.** When the system's reduce-motion setting is on, the avatar uses the static variants above, and the state label stays visible. The phrase shimmer becomes plain text and spinners become a static running glyph. Expanding and collapsing of every element (activity blocks, step cards, Messaged and T3 Code cards, sidebar task disclosure) and the opening and closing of the work pane and the computer view all happen without animation. Both modes show the same information.

**Composer while a run is active.** Send stays available. Pressing Enter or Send delivers the message into the current run as a steer, and the sent bubble carries a small "Steer" label. While the run is `stopping`, a sent message is queued instead. Next to Send, a Stop button appears for as long as the run is `running` or `waiting`. The Send button's menu offers "Queue after this turn" and "Start as new task". A queued message shows a "Queued" chip with "Send now" (turns it into a steer) and "Cancel".

**Stop.** Stop moves the run to `stopping`. When the gateway confirms, the status line disappears and a grey note lists what was stopped: helper runs, delegated Bots' runs and processes the run started on its machine. The note also says that completed actions are not undone, and that work already sent to T3 Code continues there. Stop never removes completed steps or results from the transcript.

**Streaming text.** Reply text streams into its bubble as the gateway emits it. While it streams, the bubble carries a streaming marker; the marker goes away when the gateway reports the message complete. A message that ends because the run failed or stopped keeps its text and shows "Incomplete".

**Dismissed question.** Closing a question card with its X sends the Bot a "dismissed" answer. The card folds to its title and a dimmed "Dismissed" row. If it was the run's last pending card, the run returns to `running`, and the Bot continues; it may finish or ask again.

---

## 6. Bot-to-bot messaging and handoffs

The owner likes the card that shows when one Bot has messaged another. **In Grok Bot it is a grey event line, not an expandable card** ([learngrokbot: multiple Bots][lgb-multi], seen). According to the guide, which documents desktop 0.68.1 in early October, clicking the name opens a read-only view of the exchange in place of the chat ([learngrokbot: multiple Bots][lgb-multi], reported). Clawtrate's target, an inline card that expands to show what was sent, is an improvement, not parity (section 6.1).

### What you see in the sending Bot's chat

From a first-hand screenshot ([learngrokbot: multiple Bots][lgb-multi], seen):

1. The Bot's bubble: "Asking Demo Price Watch for Linear Basic pricing now."
2. A grey line: "Messaged", then the receiving Bot's small avatar (about the size of a capital letter) in its color, then its name in a lighter grey. In this crop the line sits to the right, under the bubbles; how it aligns with the full chat column is not visible.
3. The Bot's bubble: "Asked Demo Price Watch — I'll pass along what they say when they reply."
4. Later, a grey line in the same position: "Message from", the same avatar and name.
5. The Bot's bubble relays the answer in its own words: "Demo Price Watch says Linear Basic is $10 per user/month, billed yearly (linear.app/pricing)."

The same pattern appears in a primary Bot's chat: "I'll have…", "Messaged &lt;blurred name&gt;", "I asked… I'll pass along what they change once it's done." In that crop the "Messaged" line sits nearer the middle. ([learngrokbot: chief of staff][lgb-cos], seen; image credited to a Riley Brown video) Another user's chat shows "Messaged Finances" and "Messaged Instagram · Social Media", with the Bot name in bold. ([alexop.dev][alexop], reported)

### Opening the exchange

- You click the Bot's name on the grey line. The exchange opens **in place of the chat**, with no message box and a "Close Chat" button. Both "Messaged" and "Message from" appear in the chat of the Bot that asked (desktop 0.68.1). ([learngrokbot: multiple Bots][lgb-multi], reported)
- In the **receiving** Bot's chat, the same exchange is one grey line with a count, such as "2 messages with &lt;first Bot&gt;". The design post shows the plural form, "6 messages with Kenny, Tyler and Jenny". ([learngrokbot: multiple Bots][lgb-multi], reported; [x.ai design post][x-design], seen)
- No public source shows what the opened exchange looks like inside. I infer it is a read-only chat transcript of the messages between the two Bots, with the same bubble styles. (inferred)
- No source describes a separate view of the receiving Bot's own working steps. Its work shows in its own chat like any other turn: its sidebar avatar animates, and its row shows a working state. ([docs: chat][d-chat], seen; inferred)

### Rules

- A Bot sends another Bot an asynchronous message. The receiver wakes, does the work and may reply later. ([docs: chat][d-chat], seen)
- You can ask for a handoff by naming the other Bot in plain words, or by typing `@` and picking it. Bots also message each other on their own when they judge the job needs it. ([learngrokbot: multiple Bots][lgb-multi], reported)
- Bot-to-group handoff messages are text only, so a Bot should send an image directly to another Bot when that Bot must inspect it. Whether direct Bot-to-Bot messages carry other attachments is not documented. ([docs: chat][d-chat], seen)
- **There is no switch to stop Bots messaging each other.** You tell them in chat and ask them to remember the rule. ([docs: chat][d-chat], seen)
- Every Bot-to-Bot message counts as a reply against usage. One user measured 8 percent of a month's usage as Bot-to-Bot traffic. ([docs: chat][d-chat], seen; [alexop.dev][alexop], reported)
- When one Bot wakes another, the second Bot's questions come to the chat where you asked. ([changelog][x-changelog], reported)
- Approvals raised by work that another Bot started expire after about 30 minutes. ([docs: approvals][d-approvals], seen)
- Stopping a Bot also stops the Bots it handed work to. ([changelog][x-changelog], reported)
- Delegation in Slack: a Team Bot in a Slack thread can hand work to the requester's own Bots, and their replies come back into the same thread. A personal Bot in a shared Slack channel thread cannot hand off. ([docs: chat][d-chat], seen)
- The marketing page shows a Slack-style thread in which "Invoice Bot" tags "@AP Bot", a "Thinking" indicator appears, and "AP Bot" replies, each marked "APP". ([x.ai product page][x-product], seen)

### Handoff to coding agents (the T3 Code equivalent)

- Bots hand coding work to Cursor Cloud Agents and attach the results to their reply. The Cloud Agent shows as a card in the conversation, with the files cited in the agent's final report. On the phone, the card shows the files once the run is "Done", "Error" or "Expired", ordered images, then videos, then other files. "Retry" reloads a file that failed to load; it does not rerun the agent. "View PR" appears only if the run opened a pull request and has not expired. "Open in Cursor" opens the run in the coding app. ([docs: how it works][d-how], seen; [docs: files][d-files], seen)
- The details panel's "Tasks" tab lists these runs (section 4.1). ([changelog][x-changelog], reported)
- A daily routine shown by one user has the Bot pick stale posts and a Cursor cloud agent open a PR, then the Bot posts a one-line summary. ([Flavio Copes][flavio], reported)

My reading, not evidence: this is the slot where Clawtrate shows "Messaged T3 Code", and Grok Bot's Cloud Agent card is the nearest existing pattern, a card with a status, files and a link out to the coding app. (inferred)


### 6.1 Clawtrate design proposal: the expanding Messaged card

Not Grok Bot evidence. Public material does not show Grok Bot's opened exchange, so this is Clawtrate's own design. Event and field names come from the gateway capability map; this document does not invent them.

- **Recognition and correlation.** A Messaged card is drawn for each tool event in which the Bot sends a message to another Bot through the gateway's agent-to-agent messaging. Two events belong to the same card only when identifiers carried in the gateway's events say so. Replayed or duplicated events with the same identifiers update the existing card and never create a second one.
- **Placement.** The card sits in the transcript at the point where the message was sent. It stays visible when the run's activity block is collapsed, and the same message also appears as a step card inside the block.
- **Collapsed.** One line: "Messaged", the recipient's avatar and name, the first line of the message (truncated), and the card's state.
- **States.** Non-terminal: Sending (the send call started), Waiting for approval (the sender's outgoing policy is "ask me", and an approval card is pending), Sent (the call returned successfully), Working (the recipient's run for this message started), Unknown (the sender was stopped and the gateway could not say whether the call completed). Terminal: Replied (the reply arrived), Failed (the send call returned an error, or the recipient's run failed), Blocked by policy (a messaging policy forbade it), Not sent (the user denied the approval, or the sender was stopped before the call returned and the gateway reports it was not sent), Recipient stopped (the recipient's run ended as stopped without a reply).
- **Precedence.** A card moves only forward, in the order Sending, Waiting for approval, Sent, Working, then a terminal state. An event for an earlier state that arrives late never moves the card back; for example, a late send result does not turn Working or Replied back into Sent. Unknown can move to any state that a later correlated event reports. A terminal state is final.
- **Expanded.** Clicking (desktop) or tapping (iPhone, iPad) the card expands it in place, and doing it again collapses it; nothing else in the transcript moves. Expanded, the card shows the exact text sent, any attachments, and the time sent, then the reply text and its time. While the recipient is working, it shows the recipient's live status line (avatar and phrase, as in section 5.6). The card has "Open in &lt;Bot&gt;", which goes to the recipient's task for this message, and "Raw", which shows the tool call as received. Touch and hold offers "Copy message" and "Copy raw".
- **Return.** From the recipient's task, Back (iPhone) or the history-back action (desktop, iPad) returns to the sender's task at the same scroll position, with the card still expanded.
- **Receiving side.** Clawtrate replaces Grok Bot's count-only grey line with a card. The recipient's task shows a "Message from &lt;Bot&gt;" card at the start of the run the message started. Collapsed, it shows the sender's avatar and name, the first line of the message, and the state of the recipient's own run (Working, Replied, Failed, Stopped). It expands the same way to show the full message, any attachments and the reply. Its "Open in &lt;Bot&gt;" goes to the sender's task, scrolled to the matching Messaged card.
- **"Open full exchange"** in either expanded card opens a read-only view of every message between the two Bots in this task. Its close control returns to the card, still expanded. This is Grok Bot's behavior, kept as a secondary path.
- **Motion.** Expanding and collapsing follow the reduced-motion rule in section 5.6.

### 6.2 Clawtrate design proposal: the Messaged T3 Code card

Not Grok Bot evidence. This follows the coordinator's ruling: **the client draws this card only from the Bot's own tool events on the gateway.** The client never connects to T3 Code, never reads its state, and never cancels or steers anything inside it. No T3 Code setting or credential exists in the client.

- **Recognition.** A Messaged T3 Code card is drawn for each tool event in which the Bot sends work to T3 Code. The tool and event names come from the gateway capability map.
- **Correlation.** Two events belong to the same card only when identifiers carried in the gateway's tool events say so; the field names come from the capability map. With no such identifier, each call is its own card. Events are never matched by guessing from project or thread names, so two handoffs to the same project stay separate cards. Replayed or duplicated events, for example after a reconnect, update the existing card and never create a second one. Results that arrive out of order are applied to the card their identifiers name.
- **Identity.** The card uses the text label "T3 Code" with an original generic coding-agent icon. It never uses a third-party logo.
- **Collapsed.** One line: the icon, "Messaged T3 Code", the first line of what was sent, and a state.
- **States.** Sending (the tool call has started); Sent (the call returned and its result says the work was accepted); Done (a correlated tool result carries a final result); Failed (the call returned an error); Not sent or Unknown (the Bot was stopped before the call returned, as the gateway reports). States move only forward, Sending to Sent to Done or Failed, and a terminal state is final.
- **Expanded.** Clicking (desktop) or tapping (iPhone, iPad) expands the card in place, and doing it again collapses it. Expanded, it shows the exact text sent, taken from the tool call's arguments, and any target fields those arguments contain (a project, thread or branch, shown only if present). Below that comes the result text from the tool result, and the time of each. Touch and hold offers "Copy sent text" and "Copy raw". "Raw" shows the tool call and result as received.
- **Files and links.** Files appear on the card only when the gateway's tool result or a gateway attachment carries them; their names and contents come from the gateway. A link appears only if the tool result carries one, and it opens in the system browser only when the user selects it. The client never fetches anything from T3 Code in the background.
- **Waiting.** After Sent, the card changes again only when a correlated later tool event arrives, for example a follow-up tool that returns the result. Without one, it stays at Sent.
- **Failure.** On a tool error, the card shows Failed and the error text when expanded.
- **When the Bot is stopped.** Stopping the Bot stops its run on the gateway. If the work had already been sent, the card keeps its state and adds the line "Work already sent to T3 Code continues there."
- **Coding index.** The Bot's details have a "Coding" section, separate from the Bot's task list. It lists every Messaged T3 Code card from all of the Bot's tasks, newest first, each with its state, the first line sent and the task it came from. Selecting one opens that task, scrolled to the card, expanded.
- **Motion.** Expanding and collapsing follow the reduced-motion rule in section 5.6.

---

## 7. The computer view

### Model

- Each user has one persistent cloud computer, shared by all of that user's Bots. Files, cookies, browser sessions and command-line credentials are shared. Each Bot has its own screen on that computer and can run one computer-use task at a time. Screens are "separate work surfaces, not separate security boundaries". ([docs: computer][d-computer], seen)
- The marketing page says "Every Bot has its own computer". The docs contradict it. ([x.ai product page][x-product], seen; [docs: FAQ][d-faq], seen)
- 1.0 adds a split: your own chat or Slack DM runs on your own Grok Bot computer, while a channel, thread or group chat with a Team Bot runs on the Bot's shared computer. ([Flavio Copes 1.0][flavio-10], reported)
- The computer hibernates when no Bot is working. While it sleeps, the preview reads "Your computer is asleep", and clicking it wakes the computer in place. ([learngrokbot: shared computer][lgb-computer], reported; [changelog][x-changelog], reported)

### Three levels of visibility (design post)

The official design post explains the layout ([x.ai design post][x-design], seen):

1. **Status:** a computer icon in the title bar turns purple while the computer is active.
2. **Preview:** opening it reveals a pinned side panel where you can follow along without leaving the conversation. That this panel is the "Computer" tab of the details panel is my mapping across sources, not something the post says. (inferred)
3. **Takeover:** full screen. You take control, then hand it back.

The team rejected a floating window (it covered the chat), side by side (it encouraged watching), a modal (it treated the workspace as an interruption) and full screen by default (it pushed the chat out). The more prominent the computer, the more people felt they had to supervise it. The wallpaper on the Bot's desktop changes through the day, lighter in the morning and darker at night, so the Bot's machine never looks like your own desktop.

### Preview tile

- The "Computer" tab shows a 16:9 thumbnail of the Bot's live screen, taking the panel's full width with rounded corners. A dark rounded "Open" pill with an expand icon sits in its center, and the caption under it reads "&lt;Bot&gt;'s screen". ([learngrokbot: what is][lgb-what], seen; [learngrokbot: shared computer][lgb-computer], reported)
- When a site shows a human check, the thumbnail shows that page with "Open" over it. ([learngrokbot: logins][lgb-logins], reported from caption)
- A first-hand screenshot of one Bot's screen shows a Linux desktop with a Chrome window, a taskbar with "Applications" and a terminal icon, and a clock. ([alexop.dev][alexop], reported)
- On iPhone, a round monitor icon at the top right of the chat header opens the computer. ([App Store][appstore], seen)

### Full screen and takeover

- "Open" fills the app window with the Bot's desktop. A small "Exit fullscreen" control sits at the top right. You see clicks, typing, navigation and current status as they happen. ([learngrokbot: shared computer][lgb-computer], reported; [docs: computer][d-computer], seen)
- Full screen opens in "Watching" mode until you press "Take control". It shows the live view at once, without a second "Connecting" screen. ([changelog][x-changelog], reported)
- When a Bot needs you (password, two-factor code, CAPTCHA, passkey, SSO, bank card check, a QR code or approval on another device), it posts a **Computer card**. The card is titled "Computer", with a regular-weight white line saying what it needs ("Sign in to GitHub, then hand the screen back.") and a grey note that the sign-in happens in the browser on the Bot's computer and stays signed in there. Under that is a dark 16:9 preview tile with a small monitor icon, then three buttons: "Take over" (white, primary), "I'm done" (outlined) and "Skip" (plain text, right). The Bot's sidebar row starts "Waiting for you", and the card's status shows "Action needed". ([learngrokbot: shared computer][lgb-computer], seen; [docs: troubleshooting][d-trouble], seen)
- After "Take over", the computer opens full screen with a bar across the top holding "Skip this step" (dark) and "I'm done, continue" (white). A collapse icon sits at the top right. ([learngrokbot: shared computer][lgb-computer], seen)
- When you press "I'm done", the chat card changes to "Done", and the Bot continues. The docs also say to tell the Bot to continue. ([learngrokbot: shared computer][lgb-computer], reported; [docs: approvals][d-approvals], seen)
- Recording for "Teach a task" uses the same full-screen view: a red outline around the desktop, a bar reading "&lt;Bot&gt; is watching and learning", a square stop button and a timer at the top right. The record button is red, "Start recording", with an X beside it. (Section 9.2.) ([learngrokbot: skills][lgb-skills], reported from caption)
- On iPad, the full-screen computer view is black. An X and the Bot's name sit at the top left, "?" and "…" at the top right, and the 16:9 screen is centered and letterboxed. Small icons at the bottom left (clipboard) and bottom right (keyboard) handle paste and the on-screen keyboard. ([App Store][appstore], seen)

### Files, terminal, downloads and artifacts

- No file browser or terminal panel was visible in any examined screen, and none is documented; the computer's browser, command line and file system are seen only through the screen view. (inferred from [docs: computer][d-computer] and the screenshots) Durable files belong in `/workspace`. Temporary folders, installed packages, `node_modules` and virtual environments are not kept. ([docs: computer][d-computer], seen; [docs: files][d-files], seen)
- Files reach you as cards in the chat and in the Library (section 9.5). ([docs: files][d-files], seen)
- When disk space is low, the Bot names the largest items once and deletes only after you say yes. ([docs: computer][d-computer], seen)

### Clawtrate design proposal: files and the computer beside the conversation

Not Grok Bot evidence. This is Clawtrate's intended behavior.

- **Desktop and iPad work pane.** The right-hand pane beside the conversation has the tabs Details, Files and Computer. Opening any of them never replaces or hides the conversation. On iPad, the pane is a side column next to the conversation.
- **Files listing.** The Files tab lists the files in the task's workspace on its machine as a folder tree. Each entry shows its name, size and modified time, and the list sorts by name or by modified time. While a run is active, the listing updates as files are created, changed or deleted, and files changed by the current run carry a "changed" marker.
- **Preview.** Selecting a file opens its preview inside the pane: text, code, markdown, images and PDF, and the media viewer for audio and video. An open preview reloads when the file changes. A file without a supported preview shows its name, size, modified time and "Download".
- **Download.** "Download" saves the file under its own name with identical bytes.
- **Show in chat.** "Show in chat" scrolls the conversation to the message or step card that last produced or changed the file, and expands that step card.
- **Errors.** If the listing or a preview fails, the pane shows the error and "Try again" and keeps what it last loaded. A successful retry replaces the error with the listing or preview.
- **iPhone.** Files and Computer are sections of the task's info screen, which opens from the chat header. The Files section shows the same tree as a navigable list; tapping a folder opens it, and Back goes up a level. Tapping a file opens it full screen with "Share" and "Save to Files". "Save to Files" writes the file with identical bytes to the location the user chooses. Closing the preview returns to the list, and closing the info screen returns to the chat at the same scroll position.
- **Computer tab.** On desktop it works as in Grok Bot (preview, "Open", Watching, "Take control", "I'm done"). It also names the machine the Bot runs on and its connection state (FC-02, FC-08).
- **iPhone computer.** The computer opens full screen from the info screen or the header's computer icon. It starts in Watching, where touches are not sent to the machine and the screen keeps updating. "Take control" sends touches and typing to the machine, and "I'm done" returns to Watching. Closing returns to the chat at the same position. These mobile screens are Clawtrate additions, not observed Grok Bot behavior.
- **Leaving.** Closing the pane, leaving the computer view or quitting the client never stops gateway work. When the client returns, it reconnects and shows the run's current state.

### Your own computer

- A Bot can also run commands on your desktop. The first time, a prompt asks "Allow Grok Bot and all Bots to run commands on your local computer?" with "Always allow", "Allow once", "Never" and "Deny once" (Esc). ([docs: approvals][d-approvals], seen)
- Settings, Computer, "Your computer", "Execution on this computer" has "Ask every time" (default), "Always allow" and "Never allow", with the description "Let Grok Bot open files and run tasks on your computer. Auto-review still checks everything first." It shows "Execution on Local Computer" until the desktop is listed. ([docs: settings][d-settings], seen; [learngrokbot: approvals][lgb-approvals], reported from caption)
- "Route traffic through this computer" sends the Bot's web traffic through your desktop, with a count such as "167 routed this session". Only one computer can route at a time. ([docs: settings][d-settings], seen; [learngrokbot: logins][lgb-logins], reported from caption)
- "Manage devices" lists computers and phones, each "This device", "Online now" or last opened. You can rename a device, change another computer's execution setting, or remove an offline computer with "Remove Computer". Phones cannot be removed. ([docs: mobile][d-mobile], seen; [docs: settings][d-settings], seen)

### Stuck computer and recovery

- States: "Reconnecting", "Couldn't Reach Grok Bot's Computer" (with "Retry"), "Unreachable" on the computer card, "Can't reach New Bot's screen". A notice at the top of an empty sidebar reads "Can't reach your computer", with "Retry" and "Recover computer". ([docs: troubleshooting][d-trouble], seen; [learngrokbot: can't reach computer][lgb-cantreach], reported)
- Settings, Updates (or Computer), "Grok Bot's Computer" has "Update Grok Bot's Computer" ("Your computer is on the latest version") and "Reset Grok Bot's Computer" ("Start fresh if the computer gets stuck. It's rebuilt from your last saved snapshot, so very recent changes may be lost."), with a red "Reset" button. ([learngrokbot: not responding][lgb-notresp], reported from caption)
- The update window, "Updating Grok Bot's Computer", lists seven steps with circle icons: "Getting ready", "Backing up your data", "Recreating Grok Bot's computer", "Transferring your data", "Starting Grok Bot's computer", "Cleaning up" and "Reconnecting". Done steps get a check mark, the active one a spinner and grey text turns white. A progress bar with a percentage ("43%") sits under the list, then a box "Update still running" explaining that large transfers take minutes, then "Continue in Background" and a white "Keep waiting". ([learngrokbot: can't reach computer][lgb-cantreach], seen)
- The recovery window, "Recovering Grok Bot's Computer", has four steps ("Getting ready", "Recreating Grok Bot's computer", "Starting Grok Bot's computer", "Reconnecting"), a bar at "75%" and only "Continue in Background". ([learngrokbot: can't reach computer][lgb-cantreach], seen)
- A failed reset shows a dialog "Reset failed": "The reset couldn't finish. Grok Bot's computer may be in a partial state — retry to run the reset again.", with "Dismiss" and a red "Retry Reset". The docs also name "Retry Recovery" for a failed recovery. ([learngrokbot: can't reach computer][lgb-cantreach], seen; [docs: computer][d-computer], seen)
- The escalation order is Retry, quit and relaunch, Update, Recover, then Reset. ([docs: computer][d-computer], seen)
- Users reported "bricked" computers for days in August. Staff fixed them by resetting the computer, which can lose unsynced work. ([CellCog][cellcog], reported; [forum: broken][f-broke], reported)

---

## 8. Approvals and permission prompts

### 8.1 Auto-review

- Auto-review checks each action before it runs: a command, a connected-app call or a computer action. Most actions run without a prompt. It is on by default. ([docs: approvals][d-approvals], seen)
- Only your own chat messages count as your request. Text in an email or web page does not. ([docs: approvals][d-approvals], seen)
- A first-hand test: with no rules, a Bot created and deleted two scratch folders without asking, and posted three bubbles ("Creating…", "Folders are up. Removing…", "Done…"). A `sudo` command on a system folder did stop. ([learngrokbot: approvals][lgb-approvals], reported from caption)
- The switch is "Auto-review" under Settings, General, Bot. When it is off, actions run without checks, and Custom Rules are hidden and unused but kept. If an admin requires it, the switch says "Required by your admin. You can't turn this off." ([docs: approvals][d-approvals], seen)

### 8.2 The approval card

From first-hand screenshots ([learngrokbot: approvals][lgb-approvals], seen):

- A dark rounded card. The title at the top left is a question that names the Bot: "Allow Demo Meeting Prep to run a command?". An orange "Needs approval" tag sits at the top right.
- One plain sentence says what the Bot wants: "Create test file under /etc with sudo on Grok Bot's computer."
- A grey link, "View the full request ›", expands an inset box with the reason ("The agent is trying to create a system test file under /etc using sudo, which needs approval because it modifies protected system locations.") and the exact command in monospace, with a "Hide" button and a copy icon.
- Buttons along the bottom: "Always allow" (white pill), "Allow once" (dark pill) and "Deny" (plain text, right-aligned).
- After "Deny", the tag reads "Denied", the buttons disappear, and a line reads "&lt;Bot&gt; won't do this." The Bot will not retry or re-ask until you send another message.
- After "Always allow", the card is headed "Action approved" with a green "Always allowed" tag. It repeats the task, then says "A rule always allowing this was added to your Auto-review settings", followed by the rule in quotation marks. The docs call this state "Saved to Custom Rules".
- Expired: the card is headed "Approval expired" with a grey "Expired" tag and no buttons, and reads "You can manage Auto-review in Settings". The docs say an expired card says the action was not taken, and that "Always allow next time" still saves the rule.

Variants ([docs: approvals][d-approvals], seen):

| Card | Buttons |
|---|---|
| Standard | "Allow once", "Always allow", "Deny" |
| Terminal command | "Allow", "Skip", "Manage settings" (opens Auto-review settings) |
| Paused by an Ask-first rule | "Allow", "Not now", "Edit rule" (opens Custom Rules) |
| No rule to offer | "Allow" instead of "Allow once"; no "Always allow" |
| Personal account use by a Team Bot ([docs: team Bots][d-team], seen) | "Allow once", "Always allow" (menu: "Always allow for your messages to this Bot" and "Always allow for your messages to every Team Bot"), "Skip" |
| Slack thread ("Review an action") | "Allow once", "Deny", "View details". Only the requester can answer. |
| Group chat | Only the person the Bot is answering can approve. Others see who it waits on. No "Always allow". (This conflicts with the collaboration page; see section 4.4.) |
| Phone | Tap the card to see the full request and all buttons. |

Possible warnings on a card: "This can't be undone", "This changes sign-in or security settings", "This shares your data outside this chat". ([docs: approvals][d-approvals], seen)

### 8.3 Expiry

- Cards from work you started in a chat wait indefinitely. Cards from routines, incoming messages, other Bots or background work expire after 30 minutes (this was 10 minutes earlier). Sending a new message or changing Auto-review settings closes open cards. ([docs: approvals][d-approvals], seen; [changelog][x-changelog], reported)

### 8.4 Custom Rules

- Under the Auto-review switch on desktop: a text box labelled "When Grok Bot wants to:", a menu labelled "It should:" with "Allow automatically" or "Ask first", and "Add Rule", which is greyed until you type and then turns white. A note reads "These rules apply only to you. Built-in safety checks always apply." ([docs: approvals][d-approvals], seen; [learngrokbot: approvals][lgb-approvals], reported from caption)
- Below the form, rules list in two columns, "Action" and "Behavior". Your rules end in a pencil and a bin icon. Team rules end in a padlock and say "Required by your admin. You can't edit or delete this rule." On a team account the note reads "Team rules always apply. Your rules apply only to you. Built-in safety checks always apply." ([learngrokbot: approvals][lgb-approvals], reported from caption; [learngrokbot: teams][lgb-teams], reported from caption)
- Editing on desktop: the edit icon, then "Save Rule" or "Cancel". On the phone: tap a rule, then "Save Rule" or "Delete Rule". ([docs: approvals][d-approvals], seen)
- Ask first always wins over Allow automatically. Allow rules only pass an action when the review finds no other reason to stop it. Limits: 20 rules of each type, 1,000 characters each. At 20 Allow rules, "Always allow" replaces the oldest. Rules sync across desktop and phone. Personal rules can only tighten team rules. ([docs: approvals][d-approvals], seen)
- **Rules are account-wide, for all Bots.** There is no per-Bot rule. ([docs: approvals][d-approvals], seen; [forum: instructions][f-instructions], reported)
- The section was called "Auto-review Rules" until 0.68.1. ([learngrokbot: changelog][lgb-changelog], reported)

### 8.5 Drafts before sending

- Email and Slack messages wait in an editable draft card. The email card is headed "New email" with a "Ready to send" tag (grey dot) at the top right. It has "From", "To", "Cc" and "Subject" rows in an inset box, then the body, "Show less" to fold it, and along the bottom "Disable drafts for this Bot" (grey text link), "Discard" (outlined) and "Send email" (white). The Slack card is headed "Slack message" with "Workspace", "To" and "Thread" rows and "Send message". The docs call the state "Needs approval". ([learngrokbot: gmail][lgb-gmail], seen; [learngrokbot: slack][lgb-slack], reported from caption; [docs: chat][d-chat], seen)
- "Disable drafts for Bot" makes that Bot send directly, subject to Auto-review. Email from the Bot's own address that you did not ask for in chat always waits as a draft. If a draft's attached file changed, nothing is sent and the card reopens. A save failure shows "Couldn't save. Try again." with "Retry". ([docs: chat][d-chat], seen)

### 8.6 Smarter approvals (1.0)

- The 1.0 announcement says Bots better recognize when you have already authorized an action and when they must ask, so they interrupt less, and that they respect each user's permissions and check whether information suits a public channel. ([x.ai 1.0][x-10], seen) The announcement links the change to changelog entry v0.75.5; the version attribution is the changelog's. ([changelog][x-changelog], reported)
- Specific changes from the changelog ([changelog][x-changelog], reported):
  - Background work you start in your own words no longer needs approval to start.
  - Before an action it cannot undo (sending, posting, buying, deleting), a Bot checks your own messages for approval.
  - Cards name the Bot and quote its instruction.
  - Cards show when an Ask-first rule paused the action, or when "Always allow" added a rule, with "Edit rule".
  - Approval cards say in one sentence what the Bot wants, with the detail behind "View the full request" (v0.56.0).
- The alt text of one 1.0 launch image describes a call in which a user asks the Bot to send a deck, and the Bot flags sensitive financials on slide 6 and offers to send it without that slide. I read the alt text, not the image. ([x.ai 1.0][x-10], seen)

### 8.7 Secrets and logins

- Sign-in order: a login saved in Vault, then a connected password manager (1Password), then a Secure Form. Vault and Secure Form values are filled in without the model seeing them. ([docs: approvals][d-approvals], seen)
- The **Secure Form card** in chat shows the site's logo, "Sign in to GitHub", "Secure Form" beneath it and an "Open" button at the right. "Open" shows a dialog titled "Sign in to GitHub" / "Secure Form" with "Username or email address" and "Password", the line "Never shown to your Bot. Filled directly to github.com." and "Continue". A checkbox "Securely save to Bot's vault" decides whether it is saved. ([learngrokbot: logins][lgb-logins], reported from caption; [learngrokbot: shared computer][lgb-computer], reported from caption; [Flavio Copes][flavio], reported)
- The **secure secret card** for API keys has a masked field and "Save securely". Afterwards it says "Saved" and "Saved securely and kept private". Saved values are write-only and never shown again. ([docs: vault][d-vault], seen)
- Vault (Settings, Vault) holds logins, cards and contact info. Everything in it is available to every personal Bot on the account, and you cannot limit an item to one Bot. Team Bots cannot use your personal Vault; they have their own "Secrets" and "Bot's accounts". ([docs: vault][d-vault], seen)
- Phone permission card: "Grok Bot needs permission" with "Allow", or "Open Settings" if denied before. The Bot waits up to five minutes for "Allow". If you allow the app later, within an hour, the Bot can pick the request back up without being asked again. ([docs: mobile][d-mobile], seen)

### 8.8 Clawtrate design proposal: permissions and approvals

Not Grok Bot evidence. This is Clawtrate's intended behavior, following the coordinator's ruling on precedence.

**Precedence, from strongest to weakest:**

1. A denial configured on the gateway. It is a hard ceiling: nothing in the client can loosen it, and it never becomes an approvable card.
2. A client `deny` that matches, whether set for this Bot or for all Bots.
3. A client `ask` that matches.
4. A standing allow (a rule or a grant) that is in scope and unexpired.
5. The default review, whose verdict is honored (allow, ask or deny).

With the automatic review off and nothing above matching, the result is ask. Words the user said earlier in the conversation are an input to the default review and nothing more: they never produce a pass by themselves, and never override an ask or a deny. When a grant expires or is revoked, it is removed from consideration and the order is evaluated again. That does not by itself force an ask; another matching rule or grant, or the review, still decides.

**Blocked calls.** A call stopped by a deny never executes. It appears in the activity block as a failed step, "Blocked by policy", and the expanded step names the rule that decided it.

**Audit log.** A Permissions page lists every reviewed action, newest first, with its time, Bot, task, one-line summary, verdict (allowed, asked, denied, blocked) and source: gateway rule, Bot rule, global rule, grant, default review, or the user's answer to a card. Each entry links to its step card.

**Rule limits.** Each scope (all Bots, and each Bot) holds up to 20 allow rules and 20 ask rules, each up to 1,000 characters (Clawtrate's choices). Adding or editing a rule past these limits shows a message and saves nothing. When "Always allow" is chosen and that scope already has 20 allow rules, the oldest allow rule in that scope is removed and the card says "Replaced the oldest rule: '…'". The removed rule no longer applies.

**Vault restriction.** A Bot that is not chosen for a Vault item treats the item as absent. For a sign-in, it uses the next source its permissions allow: a connected password manager, if that Bot may use it, then a Secure Form.

**Phone permission requests.** A request to use a phone app shows a card with "Allow". If the user has not answered after 5 minutes, the card reads "Timed out", and the Bot continues without the phone app and says so. If the user allows the app within 1 hour of the request, the original request resumes once, and the card reads "Resumed". After 1 hour, allowing grants the permission for later requests only, and the original request does not run. These windows follow the documented Grok Bot behavior and are Clawtrate's choices.

---

## 9. Scheduled and proactive work, notifications, and finished work

### 9.1 Routines

- **Create:** on desktop, you ask the owning Bot in chat ("every weekday at 8:00 AM, post the same kind of digest in this chat"). The Bot replies, and a grey "Created routine" line with a clock-icon chip and the routine's name appears. On the phone, the Bot's profile has "Routines" and "Add routine", which pre-fills "Set up a routine to" in the composer. ([docs: routines][d-routines], seen; [learngrokbot: routines][lgb-routines], seen)
- **Routine panel** (click the chip or the row in Details): "Instruction" with the paragraph the Bot wrote, "When to run" with a clock icon and the schedule in words ("Weekdays at 8:00 AM"), and "Webhook" if it has one. At the bottom: "Pause" or "Resume", "Test", "Edit", and a bin icon for "Delete routine", which asks to confirm. "Test" reads "Running…" until done, and failure says "Couldn't start a test run". ([docs: routines][d-routines], seen; [learngrokbot: routines][lgb-routines], reported from caption)
- "Edit" pre-fills the composer with "Edit your routine: &lt;name&gt;." You add changes and send, and an "Updated routine" line appears. ([docs: routines][d-routines], seen; [learngrokbot: routines][lgb-routines], reported from caption)
- Right-clicking a routine offers Pause/Resume, Test, Edit and Delete. Team Bots add "Who can use this routine?" with "Only me" or "Everyone with access". ([docs: routines][d-routines], seen)
- **Sources disagree** on how much of a routine you can see. One user reported in October that desktop shows only the name, schedule and switch, not the saved prompt or trigger settings, and that "Test run" and "Run history" were gone. The current docs describe "Instruction", "When to run", "Webhook" and "Test". ([forum: instructions][f-instructions], reported; [learngrokbot: changelog][lgb-changelog], reported; [docs: routines][d-routines], seen)
- **Phone:** the routine detail shows "Active", "Schedule", "Next run", "Instruction" and "Run history". Each run is "Running", "Succeeded" or "Failed" with a reason. The empty state is "No runs yet". Turning "Active" off pauses it, and a swipe deletes it. ([docs: routines][d-routines], seen)
- **Triggers:** schedules in plain language, at least five minutes apart, in the timezone set under Settings, Bot, "Timezone" ("Auto-detect" follows the computer). Events: Slack (mention, phrase, your reaction or any message, in one channel or all of Slack), GitHub, Linear, Sentry, PagerDuty, email to the Bot's address, and webhooks. The webhook section shows "POST to", "key" and "header", and clicking a field copies it. A new routine waits for its next slot and does not run at creation. ([docs: routines][d-routines], seen)
- The design post lists trigger wording such as "Every day at 8:00 AM", "Every 30 minutes", "Monthly on the 1st at 8:00 AM", "PR opened in grokbot", "Checks fail on PRs in grokbot", "When webhook receives a POST", "Reaction :eyes: added in #ops" and "Issue status → In Review in Core". ([x.ai design post][x-design], seen)
- **Results** land in the Bot's chat, under a date line, as the Bot's message ("Your first Cursor changelog check is in", then bullets). A routine's runs can also open in their own chat with "Close Chat". ([learngrokbot: routines][lgb-routines], reported from caption; [changelog][x-changelog], reported)
- After a long absence, a Bot asks "You've been away for a bit — keep my routines running?" with "Keep them running", "Pause them all" and "Keep running, don't ask again". If you do not answer, routines pause. ([learngrokbot: error messages][lgb-errors], reported; [docs: routines][d-routines], seen)
- When a routine needs to sign in to a site, it asks you in chat at that step instead of quietly stopping. ([changelog][x-changelog], reported)
- Limits: 50 routines per Bot, the 20 most recent runs kept, 300 runs an hour in total and 200 per routine ("Automation run rate limit exceeded"). Every run spends usage. ([docs: routines][d-routines], seen)

### 9.2 Skills and Teach a task

- You ask the Bot to save a finished process as a named skill. Private skills are one library shared by all your Bots, managed in "Connect apps" under "Private skills", where you switch a skill on per Bot. ([docs: routines][d-routines], seen)
- A skill page shows the name, a "Private skill" tag, "Publish" and "Delete Skill" buttons, then "Name", "Description" (starting "Use when…") and "Instructions" (a heading and numbered steps) fields, and "Save" at the bottom right. Publishing to a team turns the button into "Published", with "Sync", "Copy link" and "Unpublish". ([learngrokbot: skills][lgb-skills], reported from caption; [docs: routines][d-routines], seen)
- **Teach a task:** "+", "Teach a task", then "Start recording". You do the task once on the Bot's desktop (up to ten minutes, no sound). Stopping sends an automatic message, "The recording is finished. Learn the task from it.", with a "Learn from demonstration" chip. The Bot replies "Learned &lt;skill&gt; from your demo", lists numbered steps and asks "Want a dry run?". One guide found that the Bot added a step that was never in the recording, and no review screen appears first. Teach a task is desktop-only. ([docs: routines][d-routines], seen; [learngrokbot: skills][lgb-skills], reported)

### 9.3 Proactive work

- The primary Bot offers to take on work, flags app problems (for example, that Gmail signed you out, with an offer to reconnect) and follows up. It offers first and asks before risky actions. Offers do not count against usage, but the work they lead to does. ([docs: initiative][d-initiative], seen; [learngrokbot: multiple Bots][lgb-multi], reported)
- **Turning off notifications mutes alerts but not the check-ins themselves.** To stop check-ins you must contact support. ([docs: initiative][d-initiative], seen)
- The product page mockup shows a "Sales Bot" message at 8:02 AM reporting that four accounts renew next month and that it already pulled usage, ran health checks and drafted proposals. A suggestion card from "Account Manager" proposes a change with "Update" and "Not now". ([x.ai product page][x-product], seen)
- When background work finishes, the Bot completes what you asked and says what it would do next, instead of acting on its own. ([changelog][x-changelog], reported)

### 9.4 Notifications

- The per-Bot "Notifications" switch alerts you when the Bot finishes or is waiting for you ("Get notified when this Bot finishes or is waiting for you"). On the phone it is in the Bot's profile. **On desktop there is no switch; you ask the Bot.** Groups have no switch. ([docs: settings][d-settings], seen; [docs: mobile][d-mobile], seen)
- While the desktop app is in use on macOS or Windows, alerts for your Bots go to the desktop instead of the phone. A focused window silences only the Bot on screen. Finished replies skip the phone. When input is needed, the phone is alerted about three minutes later unless you open that Bot, turn off its notifications or hide it. On Linux, or when the desktop is not in use, the phone is notified normally. ([docs: settings][d-settings], seen)
- The phone notifies about each Bot reply only once, and never for deleted chats. ([changelog][x-changelog], reported)
- No quiet hours are documented. ([docs: settings][d-settings], seen)

### 9.5 How finished work is surfaced

- Files, images, links and tool results appear as cards in the conversation. Opening a card previews supported formats, from where you can save, open the source or give feedback. ([docs: files][d-files], seen)
- **Library on desktop** (details, "Library" tab): Pages, files and apps the Bot made, plus images, videos and links it sent. The files page says it does not list things you uploaded or files from Cloud Agents. ([docs: files][d-files], seen) **On the phone** (tap the Bot's name, then "Library"), the mobile page says it lists the pages, images, videos, files and links in the conversation, "including ones you sent". ([docs: mobile][d-mobile], seen) The two pages conflict on uploads. On desktop, items are grouped under "Today", "This week" and "Older", five at a time, with "Show more". Desktop filters: "All", "Pages", "Media", "Links", "Files", "Apps" and "Pinned". The row menu has "Pin"/"Unpin", "Open" and "Share…". A "Pinned" section syncs across devices. ([docs: files][d-files], seen)
- **Library on the phone:** newest first under "Today", "This week" and "Older", with "Show more" to look further back and "Try Again" when it fails to load. A Page row you own shows "Private", "Team" or "Public", and touching and holding a Page row offers "Open", "Share", "Copy Link" and "Open in Web". Tapping an image views it full screen, a video plays, a file previews, and a link opens in the browser. ([docs: mobile][d-mobile], seen)
- **Pages** are interactive documents (reports, memos, dashboards). A Page card has the title and "Open". On desktop, the Page fills the window with a smaller chat panel beside it, labelled "Message about &lt;Page title&gt;". The Bot edits the same Page for everyone who can view it. Filters on the Page change only your view. Sharing options are "People you invite" ("Only you" on personal accounts), your team, or "Anyone with the link" on pages.grok.bot. ([docs: files][d-files], seen) On the phone, tapping a Page card opens the Page, and changes are asked for in the conversation; renaming needs the desktop app. ([docs: mobile][d-mobile], seen) Clawtrate design proposal, not observed: on iPhone the Page opens full screen, its close control returns to the chat at the same position, and the Page shows the latest saved version.
- **Media viewer:** click a thumbnail for full screen, arrow keys or thumbnails to move, a download button at the top, Escape to close. Video plays at 2×, 1.5×, 1× or 0.5×. Right-click offers "Copy image", "Save image…" and "Save video…". ([docs: files][d-files], seen)
- A Bot no longer sends a message that only says it is done. The Bot is expected to summarize what it did in a few lines. ([Flavio Copes 1.0][flavio-10], reported)

---

## 10. Memory

- **What a Bot saves:** your preferences and working style, rules you give it, facts about you (name, time zone), and a dated log of work. Logins and cards belong in Vault. ([docs: bots][d-bots], seen)
- **When:** it decides on its own and does not ask. Saves are not always mentioned in chat. The product page mockup shows a "Saved to memory" confirmation line. ([docs: bots][d-bots], seen; [x.ai product page][x-product], seen)
- **Scope:** memory applies across all your chats with that Bot. Each Bot has its own memory, but some facts are shared by all Bots (name, time zone). Bots can also save shared facts and standing rules that apply to all Bots. In a group chat, a Bot may use what you told it privately, and others see its replies. ([docs: bots][d-bots], seen; [forum: memory][f-memory], reported)
- Clawtrate design proposal for pinning, not Grok Bot evidence: a pinned memory item, Bot-scope or shared, is always part of the memory the Bot receives on its next turn. If pinned items would exceed the memory capacity the gateway reports, pinning another is refused with "Pinned memory is full". The capacity comes from the gateway capability map.
- **View, correct, remove: there is no memory screen.** You ask in chat ("What do you remember about me?", "That's out of date…", "Forget that…"). To fully remove a shared fact, you ask the Bot that saved it. ([docs: bots][d-bots], seen)
- Under the hood, memory is reported to be markdown files on the Bot's computer, a profile plus dated logs, with per-Bot snapshots under an agent-data folder. Only the newest few thousand characters are injected into each turn. One user found a shared fact duplicated six times by different Bots. ([forum: memory][f-memory], reported; [forum: memory and usage][f-memusage], reported; [forum: instructions][f-instructions], reported)
- **Resets:** resetting a conversation keeps memory. Deleting a Bot erases its memory. Deleting the account erases all memory. ([docs: bots][d-bots], seen)
- **Team Bots:** learnings from teammates wait for the owner or a Manager under "Review learnings" (section 12). ([docs: team Bots][d-team], seen)
- The docs warn that memory is not a source of truth, and that safety boundaries belong in approvals and rules. ([docs: bots][d-bots], seen)

---

## 11. Connectors and app integrations

- **Entry points:** "Connect apps" at the bottom of the sidebar (`Cmd+Shift+M`), an in-chat "Connect" card, or on the phone, your avatar at the top left, then "Connect apps". It was called "Marketplace" until late September. ([docs: computer][d-computer], seen; [forum: instructions][f-instructions], reported)
- **The Connect Apps window:** a search box "Search across apps and skills", a row of category chips ("All", "Password Managers", "Productivity", …), a "Recommended for you" list with "Add" buttons, and 1Password with "Connect". ([learngrokbot: plugins][lgb-plugins], reported from caption)
- **The iPhone version** ("Plugins" in the App Store screenshot): a back chevron and "Plugins" title, a "Search plugins" field with a filter button, a "Featured" section with "View all", and rows with the app icon, name, a two-line grey description and a state pill at the right: a green "✓ Added" or a grey "Add". A "Team plugins" section follows. ([App Store][appstore], seen)
- **Plugin page:** the logo, "View Source", "Share" and "Add" (or "Uninstall"), the description, "Apps" (rows like "slack, Connector") and "Accounts". An account row named "default" shows "Needs auth" in orange with "Authenticate", and below it "Add Another Account". ([learngrokbot: plugins][lgb-plugins], reported from caption; [learngrokbot: slack][lgb-slack], reported from caption)
- **States:** "Added" (installed, not signed in), "Needs auth", "Disconnected", "Disabled by team admin", "Connected" (green). Actions: "Authenticate" ("Authorize" on phone), "Reconnect", "Reopen" (about 10 minutes to finish), "Remove". "Manage plugins and skills" lists installed plugins with a line such as "1 connector, 3 skills". ([docs: computer][d-computer], seen; [docs: troubleshooting][d-trouble], seen; [learngrokbot: plugins][lgb-plugins], reported from caption)
- **Connect flow:** "Add", the provider's OAuth page in the browser ("Choose an account to continue to Grok"), the permissions page, then a page reading "Authorization complete! You can close this tab." ([learngrokbot: plugins][lgb-plugins], reported from caption; [learngrokbot: gmail][lgb-gmail], reported from caption)
- Individual app tools can be switched on or off from the connected count in Connect apps. ([docs: settings][d-settings], seen)
- `@` in the composer attaches an app to a task. You can ask a Bot to add an app ("Add the Linear app"), and its tools work from your next message. ([docs: computer][d-computer], seen)
- **Custom connector** (desktop): "Add a custom connector" at the bottom of Connect apps. "Name" and "Type": "Remote HTTPS" ("Server URL", optional "HTTP headers", OAuth "Client ID", and a "Client Secret" that appears after a Client ID) or "Command" ("Command" plus "Arguments"). Then "Add plugin". Bots can add MCP servers by URL or command themselves, and private-network ones need your approval. ([docs: computer][d-computer], seen)
- **Apps are account-wide**, shared by every Bot. A second account for the same app uses "Add Another Account" with a label, and you refer to it by label ("Use my work Notion"). OAuth tokens stay on the vendor's backend, not on the computer. ([docs: computer][d-computer], seen)
- **Phone-only device apps** (Calendar, Contacts read-only, Location, Alarms; iPhone also Reminders and Home) appear under Connect apps, "This iPhone", with "Allow", "Allowed" or "Denied". They work only in your own 1:1 chat while the app is open. Some plugins show "Connect on your computer" on the phone. ([docs: mobile][d-mobile], seen; [docs: computer][d-computer], seen)
- **Mac apps (1.0):** Messages, Mail, Notes, Reminders, Calendar, Location and Contacts, each with its own "Allow". ([AIToolsReview][atr], reported)
- **Bot email address:** the account can claim one address at the vendor's mail domain, shared by its Bots. "Get yourself an email address" in chat, or Connect apps, "Email", "Choose a name", "Create address". It is permanent, and there is no inbox view. ([docs: computer][d-computer], seen)

---

## 12. Team Bots and meetings (1.0)

Brief, because Clawtrate is a personal client.

- **Team Bots** are one shared Bot a whole team chats with, each person in a private chat, in the app, Slack or Microsoft Teams. "+", "Create a Bot", name it and describe its purpose. Setup cards walk through the steps, for example "Add plugins — Step 1 of 5" ("Tools it can use. Each teammate signs in with their own account…", with "Skip" and "Add more plugins"), ending with "Step 5 of 5", "You built a Bot. Now your whole team gets a teammate." and "Publish to team" / "View details". It stays a draft only you can see until published. ([docs: team Bots][d-team], seen; [learngrokbot: teams][lgb-teams], reported from caption)
- **Sharing:** "Share", "Share this Bot", "Who has access" (team, organization, "People you invite" with "Limit access"), "Add people or groups", "Copy link". Roles are "Collaborator" (can chat) and "Manager" (can change and share); only the owner can delete. ([docs: team Bots][d-team], seen)
- **Review learnings:** memory and skill changes taught by teammates wait under "Suggested", "Review learnings" with a pending count. Each item has a label such as "Updates the skill" or "Forgets a team memory", plus "Approve" and "Reject". The same list is in "Manage" (wrench), "Knowledge", "To review". The phone shows "Learnings" with "3 to review". ([docs: team Bots][d-team], seen)
- "Manage" also has "General" and "Analytics". A Team Bot has "Secrets" and "Bot's accounts". ([docs: team Bots][d-team], seen; [docs: vault][d-vault], seen)
- **Meetings:** you paste a Google Meet, Zoom or Teams link and ask the Bot to join, then approve the card. The host admits it as "&lt;Bot&gt; (&lt;your first name&gt;'s Bot) - transcribing". Details shows "Upcoming" with a countdown, the next join time, or "Taking notes", and "Meeting actions": "Disable Interactivity" (row shows "Muted"), "Enable Interactivity", "Cancel" and "Quit". After the call, the Bot posts a summary and action items, with a longer report on a Page. ([docs: meetings][d-meetings], seen)

---

## 13. Settings, usage and quota

### Settings structure

Open from the account menu, "Settings", or `Cmd/Ctrl+,`. Panes: "General", "Computer", "Vault", "Usage & Billing", "Updates". ([docs: settings][d-settings], seen)

- **General:** "Account" card (picture, name, email, "Add account", "Sign Out"; several accounts with "Switch account" and "Remove"). "Appearance": "Theme" (Follow System, Light, Dark), "Accent" (Bot color, Black), "Language", "Check Spelling While Typing". "System": "Microphone", "Use hardware acceleration". "Bot": "Timezone", the "Auto-review" switch and "Custom Rules". "Import": "Import Memory to Grok Bot". "Security Key": "Use hardware security keys", on by default on macOS and Windows and not yet supported on Linux ([docs: approvals][d-approvals], seen). "Team Bots": "Clear connector preferences". ([docs: settings][d-settings], seen; [learngrokbot: sign-in][lgb-signin], reported from caption)
- **Computer:** "Your computer" and "Bot's computer" sections, "Manage devices", "Execution on this computer", "Route traffic through this computer", "Update Bot's Computer", "Reset Bot's Computer". ([docs: settings][d-settings], seen)
- **Vault:** "New item", "New item → Import" from other password managers. ([docs: settings][d-settings], seen)
- **Updates:** "Grok Bot Updates" with "Update Track" (Stable), "Automatic Updates" ("Automatically update your client while you're away"), the version with "You're up to date" and "Check for Updates" or "Restart to Update". Automatic updates install while the screen is locked or the screensaver is on, the computer has been idle for at least 10 minutes and the app is not busy. Linux `.deb` and `.rpm` installs update through the system package manager and show no switch. ([docs: settings][d-settings], seen; [learngrokbot: platforms][lgb-platforms], reported from caption)
- There is no model setting anywhere. ([docs: settings][d-settings], seen)

### Clawtrate design proposal: the Gateway pane and connection

Not Grok Bot evidence. Clawtrate connects to a gateway instead of a vendor account.

- **Gateway pane (Settings).** It shows the gateway URL, the connection state (Connected, Connecting, Offline, Disconnected, Pairing pending), this device's name as the gateway knows it, and the operator scopes granted. Errors show as "Pairing rejected", "Unreachable" or "Incompatible version".
- **Reconnect** is available when the state is Offline or Disconnected. The state becomes Connecting, then Connected, or Offline with the error.
- **Re-pair** sends a new pairing request, and the state becomes Pairing pending. When the gateway approves it, the new device authorization replaces the old one, which the client then stops using, and the state becomes Connected. If the request is rejected, the old authorization stays and the error shows.
- **Disconnect** closes the connection and keeps the pairing; the state becomes Disconnected until Reconnect.
- **Protocol compatibility.** During the connection handshake, the client compares the gateway's protocol version with the range it supports. If it is outside that range, the client sends no feature or mutation requests and shows a full-window notice naming both versions. "Retry" runs the handshake again, and "Choose another gateway" opens the gateway list.
- **Several gateways.** "Add gateway" pairs another gateway. "Switch gateway" shows only that gateway's Bots, tasks and permissions. "Remove" deletes the client's stored data and credentials for that gateway.
- **Language.** "Language" offers "System" and the languages the client ships translations for (Clawtrate's choice, listed in the client's localization files). Choosing one changes the interface at once and persists. "System" follows the device and falls back to English when the device's language is not shipped.
- **Updates.** On macOS and Windows, "Automatic Updates" installs a downloaded update only while the screen is locked or the screensaver is on, the computer has been idle for at least 10 minutes, and no run is active. Linux packages show the version and "Updates are managed by your package manager", with no automatic-updates switch.

### Usage and quota

- **Usage & Billing** has up to five sections in this order: "My plan" (with "Manage billing"), "Usage limits" (percentage of weekly usage used and the reset time), "Grok Bot usage" (a chart "By Bot" or "By source"), "Additional usage" (credits with "Buy credits", "Auto top-up" and "Monthly additional usage limit", or the "On-demand monthly limit"), and "Resets" ("Usage reset" rows with "Use reset" and "Confirm"). ([docs: settings][d-settings], seen)
- The "Weekly usage limit" card reads "Included usage with your subscription. Resets weekly." over a thin bar, with "Resets in 1 day" at the left and "2%" at the right. The on-demand card has an amount box and a menu with "None", "Fixed" and "Unlimited". ([learngrokbot: usage running out][lgb-usage-out], reported from caption; [learngrokbot: usage limits][lgb-usage], reported from caption)
- The account menu shows "Weekly usage 2%" at the top. Hovering shows a panel: "Weekly usage", "Resets in 1 day", "2%", then "On-demand", "Spend this cycle", "0 of 50 dollars" and "Change limit". The menu continues "Get Grok Bot for mobile", "Support", "Settings", "Add account", "Log out". ([learngrokbot: not responding][lgb-notresp], reported from caption)
- **Banners above the composer** (from a screenshot): a dark rounded banner with a gauge icon, "You're at 90% of your weekly usage limit. It resets in 6 days.", a white "Get More Usage" button and an X. At the limit: "Weekly usage limit reached. It resets in 6 days.", a grey "Increase limits" link, a white upgrade button and an X. Other variants say "Use Reset" or "Invite a Friend", "Your team has reached its usage limit", and "This Bot's owner has reached their usage limit". At the limit, the Bot stops replying. ([learngrokbot: usage limits][lgb-usage], seen; [docs: settings][d-settings], seen; [learngrokbot: error messages][lgb-errors], reported)
- The owner can ask the Bot about usage in a private chat. Usage views do not name the model. ([docs: settings][d-settings], seen; [docs: FAQ][d-faq], seen)
- Usage resets were handed out to everyone three times (26 August, 5 September, 2 October). Limits were throttled on 1 November for cost reasons. ([learngrokbot: changelog][lgb-changelog], reported; [CellCog][cellcog], reported)

---

## 14. iOS specifics

### Navigation structure

From the App Store screenshots ([App Store][appstore], seen) and the mobile docs ([docs: mobile][d-mobile], seen):

- **Home screen:** your account avatar at the top left; round search and "+" buttons at the top right. Below, a row of three large pinned Bot avatars with their names centered under them, with the primary Bot's star badge. Then a full-width list: avatar on the left, name in bold, timestamp right-aligned on the first line, one grey line of preview. No tab bar.
- "+" offers "New Bot" and "New Group Chat". Search has scopes "Messages", "Bots", "Group Chats", "Files", "Routines" and "All".
- **Chat screen:** a round back chevron at the top left, then a pill with the Bot's avatar and name. Tapping it opens the profile. A round monitor icon at the top right opens the computer. A centered grey timestamp. Your messages are black right-aligned bubbles in light mode, and the Bot's are light grey left-aligned bubbles. Link cards show an icon, title and domain. Reactions appear as a small emoji badge under a message. The composer is a round "+" at the left and a rounded field with the placeholder "Ask &lt;Bot&gt;" and a mic icon inside it on the right.
- **Profile** (tap the name): "Edit", "Notifications" toggle, "Library", "Routines" with "Add routine", "Avatar", "Duplicate", "Replace Primary Bot…", "Share as Template".
- **Settings** is reached from the avatar at the top left: "Connect apps", "Bot" ("Time Zone", "Set Time Zone Automatically", "Custom Rules", Auto-review, "Bot Computer", "Manage your devices"), "Usage", "Import Memory", "Language" ("System"), "Haptics", "Send Feedback", "Delete Account" (confirmed in the browser).
- **iPad:** a two-column split view, with the sidebar (search and + at the top, pinned tiles, then rows, and the account email at the bottom) at about a third of the width and the chat in the rest. The chat header has a sidebar toggle at the left, the Bot pill and a monitor icon at the right.

### Gestures

- Touch and hold a message: "Select Text", then "Add to Chat" or copy. ([docs: mobile][d-mobile], seen)
- Touch and hold a Page row in the Library: "Open", "Share", "Copy Link", "Open in Web". Other Library items open on tap. ([docs: mobile][d-mobile], seen)
- Touch and hold an image: "Copy Image" or "Save to Photos". ([docs: files][d-files], seen)
- Long press a Bot to duplicate it ([App Store][appstore], seen in version notes). "Conversation actions" give quick access to pin and hide, but the docs do not say which gesture opens them ([docs: mobile][d-mobile], seen; the gesture is not established). Swipe a routine to delete it ([docs: mobile][d-mobile], seen). Swipe an account to remove it ([docs: FAQ][d-faq], seen).
- Tap an approval card to see the full request and buttons. ([docs: approvals][d-approvals], seen)
- Haptics have their own setting, and the 1.13.0 notes mention livelier reactions and better haptics. ([App Store][appstore], seen)

### Push notifications and system integration

- Types: a Bot has a result, a question or an approval request. The per-Bot "Notifications" toggle and the device permission must both allow it. "Notifications are off" offers "Open Settings". iPhone push is rolling out gradually. ([docs: mobile][d-mobile], seen)
- No source describes notification action buttons or deep links from notifications. ([docs: mobile][d-mobile], seen)
- Notifications switch to the matching account. ([App Store][appstore], seen in version notes)
- **Siri and Shortcuts:** "List Bots", "Send Message", "Start Dictation", "Start Voice Chat". The Action Button can be set to "Start Voice Chat". ([docs: mobile][d-mobile], seen)
- **Live Activities:** "Start Dictation" shows one on the Lock Screen and in the Dynamic Island with cancel and send. A voice chat shows one while on the line. ([docs: mobile][d-mobile], seen)
- **Share sheet:** choose "Grok Bot", the primary Bot is pre-filled in "To:", optionally "Add a note", then "Send". Fallback: "Open in Grok Bot". ([docs: mobile][d-mobile], seen)
- **Deep link:** `grokbot://app/v1/prompt?id=<bot-id>&text=<message>` opens a Bot's chat with text in the composer, unsent. ([docs: deep links][d-deeplinks], seen)

### Missing on iOS compared with desktop

([docs: mobile][d-mobile], seen; [Flavio Copes][flavio], reported)

- Updating or recovering the computer, and reconnecting the phone when the computer won't connect (Reset is available under "Bot Computer").
- Testing a routine. Editing works on the phone through "Edit routine", which drafts a chat message, and the phone shows "Run history" (the 20 most recent runs are kept).
- Teach a task and "some advanced desktop controls".
- Renaming a Page.
- Custom connectors, and some plugins ("Connect on your computer").
- 1Password, only for accounts the new integration has not reached yet: those phones say "1Password can only be set up on a Mac". Otherwise it can be connected from the phone. ([docs: computer][d-computer], seen)
- Execution on the phone itself: phones cannot be a computer.
- Yearly, Teams or Enterprise purchases, and turning on on-demand usage.
- A shorter language list.

The phone can message Bots, watch or take over the computer, approve actions, and pause or resume routines. ([docs: get started][d-start], seen)

---

## 15. Other surfaces, briefly

These exist in Grok Bot but depend on vendor services. Clawtrate builders should know them, but they are low priority.

- **Voice chat:** "Start voice chat" (waveform, empty composer only). Status "Connecting…" (desktop) or "Calling…" (phone), then "Voice chat". Controls "Mute"/"Unmute", "Hang up", "Show transcript", "Show settings" ("Voice", "Speed" 0.5x–2x, "Language" with "Auto-detect"). One call at a time ("End the current voice chat?", "End and Chat"). Afterwards a "Voice chat" card with the length, and "How was the call?" with "Good" or "Bad". If the connection drops, the app tries to reconnect on its own first, so a short drop usually picks back up. If it can't, the call ends with "Voice chat failed" and "Connection lost", "No connection" or "The call ended unexpectedly", with "Dismiss"; you then start a new call. ([docs: chat][d-chat], seen)
- **Dictation:** "Start voice input" (`Cmd/Ctrl+D`, hold to talk), text lands in the composer. ([docs: chat][d-chat], seen)
- **Voice memos from Bots:** "Play voice memo"/"Pause voice memo", expandable transcript that highlights each word in sync. ([docs: chat][d-chat], seen; [changelog][x-changelog], reported)
- **Shopping:** product cards with "Why it fits", "Where to buy", "Buy now" or "Out of stock" with "Notify me". Order card with "Ship to", "Pay with", "Total", a pay button showing the total, "Cancel", then "Paid with". ([docs: chat][d-chat], seen)
- **Phone calls** (US only): accept terms, "Call"/"Cancel", live transcript, "End call", "Take over" ("Connecting you…", "Transferred to you"), "Your answer" with "Send" or "Skip", then "Ended" with the length and a player. ([docs: chat][d-chat], seen)
- **X:** read-only X search without sign-in, the X plugin for DMs and timeline, X Chat, and tagging @bot on X. ([docs: computer][d-computer], seen; [docs: chat][d-chat], seen)

#### Clawtrate design proposal: voice

Not Grok Bot evidence beyond the controls listed above.

- **Reconnect.** If a call's connection drops, the client tries to reconnect the same call. A short drop resumes the same call, and at most one call is ever active. If reconnecting fails, the call ends with "Voice chat failed" and the reason; "Dismiss" closes the notice, and "Start voice chat" starts a new call.
- **Voice settings.** "Voice" changes the voice from the Bot's next spoken reply in the current call. "Speed" changes playback speed at once. "Language", or "Auto-detect", applies from the user's next utterance. All three persist per Bot.
- **Switching calls.** Starting a call while one is active asks "End the current voice chat?". "End and Chat" ends the old call, then connects the new one. "Cancel" leaves the old call running. At no point are two calls active.
- **Voice memo highlighting.** When the gateway supplies word timings for a memo, the highlighted word at playback position t is the word whose interval contains t, within 100 ms (Clawtrate's choice). Pausing keeps the highlight, and seeking moves it to the word at the new position. Without word timings, no word is highlighted.

---

## Where sources disagree

| Topic | Disagreement | What to build from |
|---|---|---|
| Own computer per Bot | The marketing page says "Every Bot has its own computer". The docs say one computer per user, shared, with one screen per Bot. | The docs. Clawtrate goes further and lets each Bot pick its machine. |
| Bot creation | Docs and App Store (current): a "Create New Bot" dialog with name, shape and color. learngrokbot (early October): a "To:" field with `Create "<name>" Bot`. These are dated presentations; whether both exist today is unverified. | Clawtrate's own choice: it offers both, the dialog as the main path and the To: row as a shortcut. |
| Description and instructions | Older guides and some reviews describe a name, title and description that acts as the system prompt. Since late September, personal Bots have no description or instructions field. | Current behavior; Clawtrate restores a visible, editable field. |
| Tool steps | Docs: "the chat shows each step" and "tool activity". Users: tool calls are hidden. Design post: the current action can be seen on hover; no hover step log or raw view is established. | The design post and the user reports. |
| Routine visibility on desktop | Docs: Instruction, When to run, Webhook, Test. One forum user (October): only the name, schedule and switch; Test and Run history were removed. | The docs, which are newer. |
| `/` skill menu | learngrokbot and Flavio: `/` opens skills. Docs: ask for a skill by name. A forum user: 0.68.1 removed `/`. | Unclear; Clawtrate keeps `/`. |
| Bot limit | Design post: about 50. Flavio: 50 Bots and group chats combined. Changelog: cap lifted on 1 September. | Treat as soft. |
| 1.0 date | The announcement is dated 2 November. The numbered 1.0.0 and 1.0.1 desktop releases are dated 11 November. | 2 November for the announcement, 11 November for the client release. |
| Approvals in group chats | The collaboration page says approval requests do not appear in groups. The approvals page describes group approval cards with requester-only controls. | Unresolved. Clawtrate shows approvals in groups either way (FC-09). |
| Library contents | The files page excludes your uploads; the mobile page includes items you sent. | Unresolved; possibly a platform difference. |
| Sign-in linking on the phone | The guide (6 October) said linking needed a computer; the current docs describe linking on the phone. | The current docs. |
| Platforms | AIToolsReview (14 November) says "no Android". The docs and Google Play show Android since 2 September. | The docs. |
| Models | Docs: "no model picker", the model can vary per request. 9to5Mac and Lindy report routing to third-party models. | No picker; model unknown. |

---

## What users say is missing

Each complaint below has its evidence, then a concrete requirement for Clawtrate's fine-grained control. The requirement ids (`FC-01` and up) are reused in `docs/parity.md`.

### FC-01. No model picker

- **Complaint:** Grok Bot picks the model for each task, does not show which model handled a request, and does not plan to add a picker. Reviewers list this as a main downside, and some users said cheaper routing made Bots "quite stupid at times". ([docs: FAQ][d-faq], seen; [Lindy][lindy], reported; [CellCog][cellcog], reported; [aibuilderclub][aibc], reported)
- **Requirement:** each Bot has a model and a reasoning-effort setting, visible in the chat header and editable in the Bot's settings. Every turn records the model and effort it ran with, shown on hover over the turn and in its raw details. Changing the model mid-conversation applies from the next turn, and a grey event line records the change.

### FC-02. One shared computer and one login set for all Bots

- **Complaint:** all Bots share one computer, its files, browser sessions, Vault, connectors and command-line credentials. The docs say twice not to treat Bots as a security boundary. One user built separate Chrome profiles per Bot to keep logins apart, and they reset daily. Two Bots writing the same file lose one edit with no warning. ([docs: computer][d-computer], seen; [CellCog][cellcog], reported; [aibuilderclub][aibc], reported)
- **Requirement:** each Bot has a chosen machine (a gateway node, or the gateway host) shown in its header and settings, and the user can change it. The Bot's computer panel names the machine. Where the gateway supports it, each Bot gets its own browser profile and workspace folder, and the settings page shows which credentials, connectors and folders a Bot can reach. When two Bots share a machine or profile, the UI says so.

### FC-03. Memory cannot be inspected, edited or cleared

- **Complaint:** there is no memory screen. You ask the Bot what it remembers. Users ask for a list with dates and the Bot that saved each item, plus edit, delete, pin, export and import. A shared fact was duplicated six times. Team learning edits are undocumented. ([docs: bots][d-bots], seen; [forum: memory][f-memory], reported; [forum: instructions][f-instructions], reported; [AIToolsReview][atr], reported)
- **Requirement:** a memory viewer per Bot and a shared-memory viewer. Each item shows its text, scope (this Bot or all Bots), date and the Bot or chat that saved it. The user can edit, delete, pin and add items in both viewers, and the change takes effect on the next turn. A pinned item is always included in the Bot's memory input, within the capacity the gateway reports (section 10). "Saved to memory" event lines in the chat link to the item. Memory can be exported to and imported from a plain markdown file. A "Clear memory" action asks for confirmation and says what stays, such as files and routines.

### FC-04. Instructions are invisible

- **Complaint:** personal Bots lost their description and instructions field in late September. Users cannot see or check a Bot's role, and staff say telling the Bot in chat is unreliable. ([forum: description][f-description], reported; [forum: instructions][f-instructions], reported)
- **Requirement:** each Bot has a visible, editable instructions field (the role brief) in its settings, separate from memory. Chat-driven changes to it show as an event line and a diff the user can accept or undo.

### FC-05. Hidden tool calls and an opaque system

- **Complaint:** Grok Bot hides thinking steps and tool calls, so users cannot tell whether a Bot used a tool correctly. Errors such as exhausted credits or broken scrapers surface as calm "nothing new" reports. ([Brian Lovin on X][lovin], reported; [aibuilderclub][aibc], reported; [x.ai design post][x-design], seen)
- **Requirement:** keep Grok Bot's calm default, an animated avatar with a short status phrase, but every run with at least one step (a tool call, exposed reasoning, a Bot-to-Bot message, a handoff or an approval) has a collapsible activity block (section 5.6). Collapsed, it reads like "Worked for 1m 12s · 7 steps", plus "· 1 failed" when a step failed. Expanded, it lists each step in plain words. Every step, card and event line has a "raw" view of what the gateway sent: for a tool call, the exact tool name, arguments, result, timing and errors. Failed steps stay visible when the block is collapsed.

### FC-06. One unbounded conversation per Bot

- **Complaint:** each Bot is one thread that never resets. Long threads cost more on every reply, and a second request waits while the Bot is busy. Users ask for new chats per Bot, compaction, a context meter and parallel threads with shared memory. ([forum: compaction][f-compact], reported; [forum: parallel threads][f-parallel], reported; [forum: task cards][f-taskcards], reported; [forum: memory and usage][f-memusage], reported)
- **Requirement:** a Bot owns many tasks (threads). Tasks share the Bot's instructions, memory, skills and routines but not their transcripts. The user can start a task, rename, archive and delete it. Each task shows a context-size meter and has a "Compact" action. Tasks can run in parallel where the gateway allows. Each task has a status: working, waiting for you, blocked, done, failed.

### FC-07. Quota burn without attribution

- **Complaint:** heavy users used 42 percent of the weekly allowance on the first day, or a whole week in a day. Every reply, routine run and Bot-to-Bot message spends usage, and long chats cost more per turn. Users ask for usage per Bot, per routine and per session, a token breakdown, and caps. ([CellCog][cellcog], reported; [aibuilderclub][aibc], reported; [forum: hung chats][f-hung], reported; [forum: memory and usage][f-memusage], reported)
- **Requirement:** usage is shown per turn, per task, per Bot, per routine run and for Bot-to-Bot messages, as input, output and cached tokens, plus cost in the provider's currency when the provider reports it. A breakdown into history, memory, tools and output appears where the gateway reports it. Any figure the gateway does not report shows as "unavailable", never as zero. Each Bot and each routine can have a daily or weekly token budget. At 80 percent of a budget the user is warned, and at 100 percent new runs of that Bot or routine do not start, and its chat says why, until the period resets or the budget is raised. A day starts at 00:00 and a week at 00:00 on Monday, in the user's time zone (Clawtrate's choices). Starts refused by a budget are not queued; the user retries them. Raising a budget above current use lets new runs start at once. These budgets are separate from provider limits, which are shown as the gateway reports them.

### FC-08. Stuck computers and stuck Bots

- **Complaint:** computers "bricked" for days, the fix was a reset that can lose work, chats stopped showing new messages, and a hung Bot meant cloning and deleting it. No per-turn Stop control was established by the examined material. ([CellCog][cellcog], reported; [forum: stuck][f-stuck], reported; [forum: hung chats][f-hung], reported; [docs: chat][d-chat], seen)
- **Requirement:** a visible Stop button while a Bot works, which ends the turn, its subagents and the processes it started, and reports what was stopped. The computer panel shows the machine's connection and health. "Restart this Bot's session" works without resetting other Bots. When the transcript and the gateway disagree, the client re-syncs on its own and says so.

### FC-09. Approvals are account-wide and coarse

- **Complaint:** Custom Rules apply to all Bots. There are 20 per type, in free text. Individual app tools can be switched on or off in Connect apps ([docs: settings][d-settings], seen), but no per-Bot allow, ask or deny control per tool was established. Group approvals are disputed between two doc pages (section 4.4). A rule that is too broad stops too much. ([docs: approvals][d-approvals], seen; [learngrokbot: approvals][lgb-approvals], reported; [docs: chat][d-chat], seen)
- **Requirement:** per-Bot tool permissions (allow, ask, deny for each tool or tool group) plus per-Bot approval rules, on top of global rules. Precedence (section 8.8): a denial configured on the gateway is a hard ceiling; then a client deny; then ask; then a standing allow that is in scope and unexpired; then the default review. With the automatic review off and nothing matching, the result is ask. What the user said earlier is an input to the default review only. Every approval card offers Deny. "Always allow" offers a scope (this Bot or all Bots) and a duration (one hour, one day, until revoked). Approval cards work in group chats and show which Bot is asking. A permissions page lists every standing approval with its scope, when it was granted and a revoke button.

### FC-10. Bot-to-Bot messaging cannot be controlled

- **Complaint:** no switch stops Bots messaging each other. Every message costs usage, and parallel handoffs create duplicate work. ([docs: chat][d-chat], seen; [learngrokbot: multiple Bots][lgb-multi], reported)
- **Requirement:** for each Bot, an outgoing and an incoming policy, each set to off, ask me or allowed, with per-peer exceptions (for example, allowed to message Research only). The gateway or client blocks messages the policy forbids, and "ask me" pauses the send behind an approval card. Bot-to-Bot messages are counted separately in usage. The "Messaged" card expands inline to show exactly what was sent and what came back, and links to the receiving Bot's task.

### FC-11. Proactive check-ins cannot be turned off

- **Complaint:** turning off notifications only mutes alerts. Stopping check-ins needs support. Bots "invent relevance to justify running". ([docs: initiative][d-initiative], seen; [aibuilderclub][aibc], reported)
- **Requirement:** a per-Bot "Proactive check-ins" setting with the choices Off, Daily and As needed, separate from notifications. Off means the Bot generates no unprompted check-ins at all; muting notifications does not change it.

### FC-12. Desktop notification control by chat only

- **Complaint:** on desktop you must ask the Bot to change its notification setting. There are no quiet hours. ([docs: settings][d-settings], seen)
- **Requirement:** a notifications switch for each Bot, and an override for each task (inherit, on, off), on desktop and iOS. Quiet hours have a start and end time in the user's time zone and can span midnight. During quiet hours no notification is shown; items that need the user are delivered when quiet hours end, and the in-app badges still update.

### FC-13. Routines are hard to inspect

- **Complaint:** desktop showed only a routine's name, schedule and switch for a while. Test and run history were removed, and Edit just starts a chat. Users could not see webhook or trigger configuration. ([forum: instructions][f-instructions], reported; [learngrokbot: changelog][lgb-changelog], reported)
- **Requirement:** a routine page shows the full instruction, trigger configuration, next run, an editable form (as well as chat editing), "Test run" and a run history in which each run links to its transcript and usage.

### FC-14. Deleting a Bot leaves things behind

- **Complaint:** deleting a Bot removes its chat, memory and routines, but files and browser sessions stay on the shared computer. ([docs: bots][d-bots], seen; [alexop.dev][alexop], reported)
- **Requirement:** the delete dialog lists what will be removed and what will remain (files, sessions, connectors) and offers to remove the Bot's workspace folder too. **Deleting a Bot never deletes a folder another Bot uses.** If any other Bot uses the same workspace folder, the option is shown disabled with "Also used by &lt;Bot&gt;, &lt;Bot&gt;", and the folder and its files stay untouched for those Bots.

### FC-15. Silent failures

- **Complaint:** exhausted credits, redesigned sites and lost file edits produce calm reports instead of errors. ([aibuilderclub][aibc], reported)
- **Requirement:** a tool error always appears as a failed step in the activity block. A run with failed steps cannot render as a plain success: its collapsed summary shows the failure count, and its task status becomes "done with failures" (section 5.6).

---

## Open-source alternatives: what their UIs do better

All three are self-hosted Grok Bot alternatives ([Rakazo README][rakazo], seen; [OpenMausBot site][openmausbot], seen; [OpenSuperBot README][opensuperbot], seen). I read their READMEs and product pages, not their code.

### Rakazo ([github.com/elie222/rakazo][rakazo])

Apache-2.0, web, Electron and Expo clients against one server. Its layout is the closest to Grok Bot's: Bots in a sidebar, chat in the middle and a right-hand panel for the computer and routines. ([Rakazo README][rakazo], seen; [Bitdoze][bitdoze], reported)

What it does better in the UI:

- **A full routine editor in the side panel.** The screenshot shows a "Routine" panel with an "Active" switch, "Delete" and "Test run" at the top, editable "Name" and "Instruction" fields, "When to run" with a timezone label ("America/New_York") and dropdowns ("Weekdays" at "7:00 AM"), "Add trigger", "Save", and a "Run history" list of dated runs, each with a chevron. Grok Bot edits routines only through chat. ([Rakazo README][rakazo], seen in screenshot)
- **A choice of private or shared computer** per Bot, where Grok Bot always shares one. ([Rakazo README][rakazo], seen)
- **Any model with your own keys**, chosen at onboarding. ([Rakazo README][rakazo], seen)
- A notification bell and a sidebar toggle in the sidebar's top row, next to search and +. ([Rakazo README][rakazo], seen in screenshot)
- **"Take control" and "Teach a task" sit in the computer view's title bar**, always visible, rather than appearing only on a card when the Bot asks. ([Rakazo README][rakazo], seen in screenshot)
- On desktop, a first-launch choice between "This computer" and "Existing instance", and a "Quit and Stop Bots" menu item. ([Rakazo README][rakazo], seen)

### OpenMausBot ([mausbot.com][openmausbot], source at [github.com/milind-soni/OpenMausBot][openmausbot-src])

Apache-2.0 Electron app styled like a messaging client, running agents through CLIs installed on your machine. ([OpenMausBot site][openmausbot], seen; [Bitdoze][bitdoze], reported)

What it does better in the UI:

- **A per-Bot model menu in the chat header** showing the current model, with model switching mid-conversation. Group chats can mix engines. ([OpenMausBot site][openmausbot], seen)
- **Routines on a calendar.** A "Routines" view with "Day", "3 days" and "Week" toggles, a date navigator ("Today", "August 2026") and a filter by Bot. The empty state reads "Put your MAUS team on a rhythm" with "Create your first routine". Every run becomes a separate task with its own result. ([OpenMausBot site][openmausbot], seen in video thumbnail)
- **"Advanced mode"** in Settings that shows "the full picture of what your agents are doing". The default stays simple. ([OpenMausBot site][openmausbot], seen)
- **A Keys screen** with write-only credentials and a "Ready" status per provider. ([OpenMausBot site][openmausbot], seen)
- Bot rows show a status or schedule line, for example "Waiting on your yes" or "Every 30 minutes". ([OpenMausBot site][openmausbot], seen)

### OpenSuperBot ([github.com/wolfqing/OpenSuperBot][opensuperbot])

MIT, one container per teammate with Chromium and noVNC. ([OpenSuperBot README][opensuperbot], seen)

What it does better in the UI (from its README and two screenshots I examined):

- **A model chip in the chat header**, for example "● DeepSeek · deepseek-flash", per teammate, with an "AI" section holding one connection per provider. ([OpenSuperBot README][opensuperbot], seen)
- **A collapsible activity card per turn.** Each step streams live into one card, which collapses to a line like "WORKED 2 steps · 26.0s" when the turn ends. A stop button ends the turn. ([OpenSuperBot README][opensuperbot], seen)
- **Uniform reports:** each turn opens with check-mark lines, such as "✓ Web → sources reviewed · 6 pages", then a sentence about what needs you. ([OpenSuperBot README][opensuperbot], seen)
- **"NEEDS YOU" hold cards** with an amber left border: a title ("send the 4 queued drafts"), a monospace destination chip ("email → replies@example.com" here; the screenshot shows a sample company address), "Approve" and "Discard", and "Always allow…" at the right. Standing approvals last an hour, a day or until revoked. Money and bookings always ask. ([OpenSuperBot README][opensuperbot], seen)
- **A computer panel that lists the Bot's permissions and memory**: the live screen at the top, a note on where it runs, a "COMMANDS" checkbox ("Allow commands, in a sandbox…"), "ROUTINES" with play, pause and delete buttons per routine, "ALLOWED WITHOUT ASKING", "STANDING RULES" ("No standing rules yet. Tell it 'from now on…' in the thread.") and "RECENT ACTIONS" (each action with a check mark, the tool name in monospace, the time and who triggered it). ([OpenSuperBot README][opensuperbot], seen in screenshot)
- **Memory as a file you can see:** rules said in chat are written to `MEMORY.md` and the diff is posted as a chip. Each rule in the panel has a remove button. ([OpenSuperBot README][opensuperbot], seen)
- **A per-teammate daily token budget**, with today's usage shown in the panel. ([OpenSuperBot README][opensuperbot], seen)
- **Peer-to-peer handoffs off by default** until you allow a direction. ([OpenSuperBot README][opensuperbot], seen)
- **An amber pending count** on each sidebar row and in the browser tab title. ([OpenSuperBot README][opensuperbot], seen)
- Animated avatars with distinct motions: bob while working, hop when waiting on you, shake when stuck, smile when finished while you were away. ([OpenSuperBot README][opensuperbot], seen)

The README itself concedes Grok Bot's zero-setup polish, its iOS app and its teach-by-demonstration. ([OpenSuperBot README][opensuperbot], seen)

---

## Reference images

The images are kept in a private folder outside the repository, which is not published. The public source URLs below are the portable references. Each one is described here, so builders do not need to open them. "Seen" means I looked at the image myself. "From caption" means I took the description from the source's own caption.

### Grok Bot desktop (first-hand screenshots from learngrokbot.com, desktop around 0.68.1, dark theme)

The source for each file is `https://learngrokbot.com/assets/shots/<name>`, where `<name>` is the file name without the `lgb-` prefix.

| File | What it shows |
|---|---|
| `lgb-what-is-grok-bot-app.png` | Seen. Full desktop window: chat on the left two thirds, details panel on the right third. Floating Bot-name pill at the top center of the chat, a blue user bubble at the right, grey Bot bubbles with a markdown pricing table, a grey right-aligned "Created routine ⏱ Monday pricing check" line, and the composer with + at the left, the placeholder "Message Demo Price Watch", and mic and waveform buttons at the right. The panel has share and close buttons, a large blue avatar, the name, "Add a label", the tabs Details, Library and Computer (Computer selected), a 16:9 screen thumbnail with an "Open" pill, and "Demo Price Watch's screen". |
| `lgb-home-bot-at-work.png` | Seen. The working state: a user bubble, two short progress bubbles from the Bot, then the Bot's small avatar beside grey "Clicking around" text (first word dimmer), and the empty composer. |
| `lgb-multiple-bots-messaged-lines.png` | Seen. Bot-to-Bot messaging: Bot bubble, right-aligned grey "Messaged ● Demo Price Watch" line, Bot bubble, "Message from ● Demo Price Watch" line, then a Bot bubble relaying the answer with a link. |
| `lgb-chief-of-staff-hand-off.jpg` | Seen (image from a Riley Brown video). A primary Bot's chat: a bubble starting "I'll have", a grey "Messaged" line with a blurred name nearer the middle of the crop, and a bubble "I asked … I'll pass along what they change once it's done." |
| `lgb-multiple-bots-main-bot-star.png` | Seen. Top of the sidebar: a large pink avatar with an orange star badge, a blurred name, then rows for Demo Price Watch (preview "Monday check is set for 9:00…") and Demo Research with a grey "News watch" label chip and preview "Stopped — I won't create or s…". |
| `lgb-multiple-bots-replace-menu.jpg` | Seen (image from a Riley Brown video). The primary Bot's right-click menu: Pin, Move to ›, Mark as Unread, Rename Bot, Copy conversation ID, Hide from sidebar, Replace with different Bot, with icons and separators. |
| `lgb-multiple-bots-group-chat-first-hand.png` | Seen. A group chat: centered title pill (blurred user name, then "Demo Research, Demo Meeting Prep"), a grey user bubble at the right, the Bot names above their replies in green and red, and each Bot's avatar at the bottom left of its reply. |
| `lgb-first-bot-new-chat.png` | Seen. Search and + buttons at the top of the sidebar, a "To: Start a chat with…" field, and a dropdown with "Create new Bot" and "Create group chat". |
| `lgb-first-bot-type-a-name.png` | From caption. The To: field with "Demo Research" typed and one row, `Create "Demo Research" Bot`. |
| `lgb-first-bot-first-questions.png` | Seen. A new Bot's first chat: timestamp, greeting bubble, a folded answered question card ("B Tracking news or competitors ✓"), the Bot's reply, and an open card "Who or what should I watch?" with options A to D, an X and "Type your own answer". |
| `lgb-first-bot-details-panel.png` | Seen. The details panel: share and close buttons, a large green avatar, "Demo Research", "Add a label", Details, Library and Computer tabs, and a "Routines" row "AI coding assistants weekday digest / Paused" with a switch. |
| `lgb-first-bot-first-reply.png` | From caption. Three Bot bubbles, then a file card "linear-prep.md, 2.4kB". |
| `lgb-first-bot-voice-buttons.png` | From caption. The right end of the composer: round microphone and waveform buttons. |
| `lgb-routines-created-chip.png` | Seen. A Bot bubble, a right-aligned grey "Created routine ⏱ AI coding assistants weekday digest" line, then another Bot bubble with bold "8:00 AM PT". |
| `lgb-routines-panel.png` | From caption. Routine panel: "Instruction" paragraph, "When to run" with a clock and "Weekdays at 8:00 AM". |
| `lgb-routines-edit-button.png` | From caption. The foot of the routine panel: "Pause", "Edit" and a bin icon. |
| `lgb-routines-list.png` | From caption. Details tab with two routines, one "Paused" with its switch off, one "Every Tuesday at 3:38 PM" with its switch on. |
| `lgb-approvals-card.png` | Seen. Approval card: "Allow Demo Meeting Prep to run a command?", orange "Needs approval" tag, one-line summary, "View the full request ›", and "Always allow" (white), "Allow once" (dark) and "Deny" (text, right). |
| `lgb-approvals-full-request.png` | Seen. The same card expanded: an inset with the reason, the command in monospace, a "Hide" button and a copy icon. |
| `lgb-approvals-denied.png` | From caption. The card after Deny: a "Denied" tag, no buttons, "Demo Meeting Prep won't do this." |
| `lgb-approvals-always-allowed.jpg` | From caption. "Action approved" with a green "Always allowed" tag and the rule added to Auto-review settings. |
| `lgb-approvals-expired.jpg` | From caption. "Approval expired" with a grey "Expired" tag, no buttons, and "You can manage Auto-review in Settings". |
| `lgb-approvals-rules-settings.png` | From caption. Settings, General, Bot: the Auto-review switch, the "When Grok Bot wants to" box, the "It should" menu, a greyed "Add Rule" and the note about built-in checks. |
| `lgb-approvals-rules-list.jpg` | From caption. Rules list with "Action" and "Behavior" columns, a padlock on the first row, and pencil and bin icons on the others. |
| `lgb-approvals-own-computer.png` | From caption. Settings, Computer: a device name field with "Save" and "Remove", and "Execution on this computer" set to "Ask every time". |
| `lgb-shared-computer-open-computer.png` | From caption. Details panel on the Computer tab: the screen thumbnail with "Open" and "Demo Price Watch's screen". |
| `lgb-shared-computer-full-screen.png` | From caption. The Bot's Chrome window filling the app window, with "Exit fullscreen" at the top right. |
| `lgb-shared-computer-take-over-card-first-hand.png` | Seen. The "Computer" card: "Sign in to GitHub, then hand the screen back.", a grey explanation, a dark preview tile with a monitor icon, and "Take over" (white), "I'm done" (outlined) and "Skip" (text). |
| `lgb-shared-computer-hand-back-first-hand.png` | Seen. Takeover: a bar at the top with "Skip this step" and "I'm done, continue", a collapse icon at the top right, and GitHub's sign-in page in Chrome below. |
| `lgb-shared-computer-secure-form.png` | From caption. Secure Form dialog "Sign in to GitHub" with username and password fields, "Never shown to your Bot. Filled directly to github.com." and "Continue". |
| `lgb-logins-and-captchas-secure-form-card.png` | From caption. The in-chat Secure Form card: GitHub logo, "Sign in to GitHub", "Secure Form", "Open". |
| `lgb-logins-and-captchas-route-traffic.png` | From caption. Settings, Computer, Network: "Route traffic through this computer", "167 routed this session", switch on. |
| `lgb-skills-teach-menu.png` | From caption. The composer's + menu: "Attach files" and "Teach a task" with a red record icon. |
| `lgb-skills-recording.png` | From caption. Recording: a red outline around the Bot's desktop, "Demo Meeting Prep is watching and learning", a square stop button and a timer at 1:08. |
| `lgb-skills-review.png` | From caption. The automatic "The recording is finished. Learn the task from it." message with a "Learn from demonstration" chip, and the Bot's numbered steps ending "Want a dry run?". |
| `lgb-skills-slash-menu.png` | From caption. "/check" in the composer, with rows tagged "Skill" and "Action". |
| `lgb-skills-skill-page.png` | From caption. Skill page with a "Private skill" tag, "Publish", "Delete Skill", the Name, Description and Instructions fields, and "Save". |
| `lgb-chief-of-staff-primary-bot-dialog.png` | From caption. "Introducing Primary Bot" dialog with a starred avatar, a description, "Use an existing Bot" and "Create Primary Bot". |
| `lgb-gmail-draft-card.jpg` | Seen. "New email" card with a "Ready to send" tag, From, To, Cc and Subject rows, a blurred body, "Show less", "Disable drafts for this Bot", "Discard" and "Send email". |
| `lgb-slack-draft-card.jpg` | From caption. "Slack message" card with Workspace, To and Thread rows and "Send message". |
| `lgb-plugins-connect-apps-button.png` | From caption. The sidebar footer's wide "Connect apps" button with three app icons. |
| `lgb-plugins-connect-apps-dialog.png` | From caption. The Connect Apps window: "Search across apps and skills", category chips, "Recommended for you" with "Add" buttons, and 1Password with "Connect". |
| `lgb-plugins-manage-states.png` | From caption. Installed plugins with "1 connector, 3 skills" lines, two "Authenticate" buttons and a green "Connected". |
| `lgb-plugins-accounts-block.png` | From caption. Google Calendar plugin page: "Share" and "Uninstall", an "Accounts" row "default" with an orange "Needs auth" and "Authenticate", and "Add Another Account". |
| `lgb-usage-limits-banners.png` | Seen. Two stacked dark banners with a gauge icon: "You're at 90% of your weekly usage limit. It resets in 6 days." with "Get More Usage", and "Weekly usage limit reached. It resets in 6 days." with "Increase limits" and "Upgrade to Pro+", each with an X. |
| `lgb-usage-running-out-meter.png` | From caption. The "Weekly usage limit" card with a thin bar, "Resets in 1 day" and "2%". |
| `lgb-usage-limits-on-demand-menu.png` | From caption. Usage & Billing with the weekly card and the "On-demand monthly limit" card, whose menu offers None, Fixed and Unlimited. |
| `lgb-not-responding-weekly-usage.png` | From caption. The account menu with "Weekly usage 2%" at the top and a side panel with on-demand spend and "Change limit". |
| `lgb-not-responding-banner.png` | From caption. Dark red banner: warning triangle, "Bot failed to respond", "Something went wrong while generating the reply. Try again.", round close button. |
| `lgb-not-responding-updates.png` | From caption. Settings, Updates: Update Track, Automatic Updates, Version 0.68.1, "Check for Updates", and "Update Grok Bot's Computer". |
| `lgb-cant-reach-computer-notice.png` | From caption. "Can't reach your computer" notice at the top of an empty sidebar with "Retry" and "Recover computer". |
| `lgb-cant-reach-computer-reconnecting.png` | Seen (light theme). A "Reconnecting" pill with a spinner over a grey "Showing saved messages" notice. |
| `lgb-cant-reach-computer-updating.png` | Seen. "Updating Grok Bot's Computer": seven steps with check, spinner and empty-circle states, a 43% bar, an "Update still running" box, and "Continue in Background" and "Keep waiting". |
| `lgb-cant-reach-computer-reset-failed.png` | Seen. "Reset failed" dialog with the partial-state explanation, "Dismiss" and a red "Retry Reset". |
| `lgb-cant-reach-computer-recovering.png` | Seen. "Recovering Grok Bot's Computer": four steps (three checked, "Reconnecting" with a spinner), a 75% bar and "Continue in Background". |
| `lgb-setup-welcome.png` | From caption. Desktop welcome: mark, tagline, "Sign in". |
| `lgb-setup-browser-sign-in.png` | From caption. Browser page "Start using Grok Bot" with "Sign in with Grok", "Sign in with Cursor" and "Create an account". |
| `lgb-setup-get-started.png` | From caption. "Get Started with Grok Bot" with three plan columns. |
| `lgb-setup-computer.jpg` | From caption (image from a Nate Herk video). "Setting up Grok Bot's computer" with the mark. |
| `lgb-setup-intro.jpg` | From caption (image from a Nate Herk video). "What do you use every day?" with a search box, twelve app tiles, "Next" and "Back". |
| `lgb-teams-setup-card.jpg` | From caption. Team Bot setup card "Add plugins", "Step 1 of 5", with "Skip" and "Add more plugins". |
| `lgb-teams-publish-card.jpg` | From caption. "Step 5 of 5" card with "Publish to team" and "View details". |
| `lgb-use-cases-template-review.jpg` | From caption. Template import dialog with expandable "Context" and "Routines" rows and "Add Bot". |

### Grok Bot desktop (another user's screenshots, alexop.dev)

| File | Source | What it shows |
|---|---|---|
| `alexop-sidebar.png` | https://alexop.dev/posts/how-i-use-grok-bot/ (image `_astro/sidebar.EA4vH3hz.png`) | Seen. A tall, narrow dark sidebar (about 1:2.3). Search and + circle buttons at the top right. Six pinned Bots in a 3×2 grid of large avatars with names below; the first has a pumpkin stem and an orange star badge, and the selected one ("dr eggbot") has a lighter rounded background. Then the sections "fitness" and "dev stuff" with rows: avatar, name and a grey preview. German UI text. |
| `alexop-chief-of-staff.png` | same page (image `_astro/chief-of-staff-writeup.Bp_6eWE1.png`) | Seen. A 1:1 chat in dark theme: centered "Today 8:52 AM", an orange right-aligned user bubble (the Bot's color), three grey Bot bubbles, a file card "grokbot-setup-overview.md / 37kB" with a document icon, a long answer bubble with bold names, and hover actions (emoji, reply, more) to the right of the last bubble. |

### Grok Bot iPhone and iPad (official App Store screenshots)

Source: the App Store listing at https://apps.apple.com/us/app/grok-bot/id6794501026, with the image URLs taken from the public lookup at https://itunes.apple.com/lookup?id=6794501026 (fields `screenshotUrls` and `ipadScreenshotUrls`). All are seen.

| File | What it shows |
|---|---|
| `appstore-iphone-ss1.jpg` | "Your AI agents for everyday work". Light welcome screen: "Grok Bot", "Your team of always-on Bots that finish the work.", black "Log in", grey "Sign up", and floating avatars. |
| `appstore-iphone-ss2.jpg` | "Connect it to your tools". The "Plugins" screen as a sheet over home: back chevron, "Search plugins" with a filter button, "Featured" with "View all", rows for Gmail, Google Calendar and Google Drive with green "✓ Added" pills, Granola with "Add", then "Team plugins" with Loom and 1Password. |
| `appstore-iphone-ss3.jpg` | "Give each bot a role". The "Create New Bot" sheet: close X, a large orange cloud avatar, a name field "Personal Shopper", eight shapes, eleven colors and a black "Create" button. |
| `appstore-iphone-ss4.jpg` | "Message it like an assistant". Chat with "Chief of staff": back chevron, avatar and name pill, monitor icon at the top right, "Today 8:00 AM", a black user bubble and two grey Bot bubbles reporting handoffs ("3 invoices went to Expense Manager… 1 bug report routed to Bug Triager."), and the composer with + and a mic. |
| `appstore-iphone-ss5.jpg` | "Use many bots at once". Home: account avatar at the top left, search and +, three pinned avatars (Chief of Staff with a star, EA, Inbox Manager), and a list of seven Bots with timestamps and one-line status previews ("Outreach drafts queued for approval.", "Receipts coded — one needs a look."). |
| `appstore-iphone-ss6.jpg` | "They come back with finished tasks". Chat: an approval request in prose, link cards for "Q3 board deck v4" and "v5" (docs.google.com), a thumbs-up reaction badge under a card, and short replies "Pulled and added" and "Sent". Composer placeholder "Ask Chief of staff". |
| `appstore-ipad-ss1.jpg` | "Your team of always-on agents that finish the work". iPad welcome with a ring of avatars around "Grok Bot" and "Log In or Sign Up". |
| `appstore-ipad-ss2.jpg` | "Work with many at once". iPad split view: sidebar at about a third of the width with search, +, pinned tiles, a Bot list and the account email at the bottom; chat with a sidebar toggle, the "Chief of staff" pill, a monitor icon, alternating black and grey bubbles, link cards and reactions. |
| `appstore-ipad-ss3.jpg` | "Signs in to your tools". Full-screen computer view: black background, X and Bot name at the top left, "?" and "…" at the top right, the letterboxed screen showing a "Sign in to Acme CRM" window, and clipboard and keyboard icons at the bottom corners. |
| `appstore-ipad-ss4.jpg` | "Comes back finished". iPad chat with "Inbox Manager", including a "New Email" draft card tagged "Answered" after sending. |

### Open-source alternatives

| File | Source | What it shows |
|---|---|---|
| `alt-rakazo-routines.png` | https://github.com/elie222/rakazo/raw/main/docs/screenshots/readme/routines.png | Seen. Three columns: sidebar (Personal section, Bots with avatars, times and previews, "Connect apps" at the bottom), chat (purple user bubbles), and a "Routine" panel with Active, Delete, Test run, Name, Instruction, When to run, Add trigger, Save and Run history. |
| `alt-rakazo-computer.png` | https://github.com/elie222/rakazo/raw/main/docs/screenshots/readme/computer.png | Seen. Full-window computer view titled "Team Computer" with "Take control", "Teach a task", a more menu and a close button in the title bar, and a live Chrome window below. |
| `alt-rakazo-groups.png` | https://github.com/elie222/rakazo/raw/main/docs/screenshots/readme/groups.png | Seen. Group chat "Launch team" with a cluster avatar in the header pill. Each Bot reply has a small avatar and the Bot's name in its color above the bubble, and user bubbles are grey on the right. The sidebar has search, a bell, a sidebar toggle and + at the top. |
| `alt-opensuperbot-thread.png` | https://github.com/wolfqing/OpenSuperBot/raw/main/assets/screenshot-thread.png | Seen. A thread with a model chip in the header, a ✓ report card, a "WORKED 2 steps · 26.0s" collapsed row, a browser screenshot, a "NEEDS YOU" amber card with Approve, Discard and "Always allow…", and a "CREATED ROUTINE" card. |
| `alt-opensuperbot-panel.png` | https://github.com/wolfqing/OpenSuperBot/raw/main/assets/screenshot-panel.png | Seen. The same thread with "Scout's computer" panel: live screen, COMMANDS checkbox, ROUTINES with play, pause and delete, ALLOWED WITHOUT ASKING, STANDING RULES and RECENT ACTIONS. |
| `alt-openmausbot-calendar.jpg` | https://pbs.twimg.com/amplify_video_thumb/2088312958732636160/img/2oUtjj7MTSkBdrhY?format=jpg&name=small (linked from mausbot.com) | Seen. "Routines" view with Day, 3 days and Week toggles, a date navigator and an empty state "Put your MAUS team on a rhythm" with "Create your first routine". |

---

## Reference link list

[d-overview]: https://docs.x.ai/grok-bot/overview
[d-start]: https://docs.x.ai/grok-bot/get-started
[d-how]: https://docs.x.ai/grok-bot/how-grok-bot-works
[d-bots]: https://docs.x.ai/grok-bot/bots
[d-chat]: https://docs.x.ai/grok-bot/chat-and-collaboration
[d-files]: https://docs.x.ai/grok-bot/files-and-results
[d-computer]: https://docs.x.ai/grok-bot/computer-and-apps
[d-routines]: https://docs.x.ai/grok-bot/skills-routines-and-automations
[d-approvals]: https://docs.x.ai/grok-bot/approvals-security-and-privacy
[d-vault]: https://docs.x.ai/grok-bot/vault
[d-team]: https://docs.x.ai/grok-bot/team-bots
[d-mobile]: https://docs.x.ai/grok-bot/mobile
[d-meetings]: https://docs.x.ai/grok-bot/meetings
[d-initiative]: https://docs.x.ai/grok-bot/initiative
[d-settings]: https://docs.x.ai/grok-bot/settings-and-notifications
[d-deeplinks]: https://docs.x.ai/grok-bot/deep-links
[d-trouble]: https://docs.x.ai/grok-bot/troubleshooting
[d-faq]: https://docs.x.ai/grok-bot/faq
[d-security]: https://docs.x.ai/grok-bot/security
[x-product]: https://x.ai/bot
[x-launch]: https://x.ai/news/introducing-grok-bot
[x-design]: https://x.ai/news/designing-grok-bot
[x-10]: https://x.ai/news/grok-bot-1-0
[x-changelog]: https://x.ai/changelog/bot
[appstore]: https://apps.apple.com/us/app/grok-bot/id6794501026
[lgb-home]: https://learngrokbot.com/
[lgb-what]: https://learngrokbot.com/what-is-grok-bot
[lgb-setup]: https://learngrokbot.com/setup
[lgb-first-bot]: https://learngrokbot.com/first-bot
[lgb-plugins]: https://learngrokbot.com/plugins
[lgb-routines]: https://learngrokbot.com/routines
[lgb-approvals]: https://learngrokbot.com/approvals
[lgb-computer]: https://learngrokbot.com/shared-computer
[lgb-skills]: https://learngrokbot.com/skills
[lgb-multi]: https://learngrokbot.com/multiple-bots
[lgb-cos]: https://learngrokbot.com/chief-of-staff
[lgb-gmail]: https://learngrokbot.com/gmail
[lgb-slack]: https://learngrokbot.com/slack
[lgb-usage]: https://learngrokbot.com/usage-limits
[lgb-usage-out]: https://learngrokbot.com/usage-running-out
[lgb-notresp]: https://learngrokbot.com/not-responding
[lgb-cantreach]: https://learngrokbot.com/cant-reach-computer
[lgb-signin]: https://learngrokbot.com/sign-in-and-linking
[lgb-logins]: https://learngrokbot.com/logins-and-captchas
[lgb-errors]: https://learngrokbot.com/error-messages
[lgb-platforms]: https://learngrokbot.com/platforms
[lgb-teams]: https://learngrokbot.com/teams
[lgb-usecases]: https://learngrokbot.com/use-cases
[lgb-changelog]: https://learngrokbot.com/changelog
[flavio]: https://flaviocopes.com/grok-bot/
[flavio-10]: https://flaviocopes.com/grok-bot-1-0/
[wiegold]: https://www.thomas-wiegold.com/blog/grok-bot-explained
[aibc]: https://aibuilderclub.com/blog/grok-bot-guide
[atr]: https://aitoolsreview.co.uk/insights/grok-bot-1-0
[cellcog]: https://cellcog.ai/blog/grok-bot-problems
[bitdoze]: https://www.bitdoze.com/best-open-source-grok-bot-alternatives/
[alexop]: https://alexop.dev/posts/how-i-use-grok-bot/
[lovin]: https://x.com/brian_lovin/status/2087917528001794393
[lindy]: https://www.lindy.ai/blog/grok-bot
[leak]: https://github.com/asgeirtj/system_prompts_leaks/blob/main/xAI/grok-bot.md
[perch]: https://github.com/asafofer/perch/pull/144
[f-instructions]: https://forum.cursor.com/t/grok-bot-macos-unable-to-see-or-edit-bot-instructions-or-skills-on-desktop/173803
[f-description]: https://forum.cursor.com/t/grok-bot-show-and-edit-bot-role-description-in-the-info-pane-match-docs/173333
[f-memory]: https://forum.cursor.com/t/grok-bot-desktop-ios-memory-management/168066
[f-compact]: https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333
[f-threads]: https://forum.cursor.com/t/grok-bots-as-always-on-workers-vs-topic-threads/168183
[f-parallel]: https://forum.cursor.com/t/grok-bot-let-one-bot-run-several-threads-in-parallel-with-shared-memory/176321
[f-taskcards]: https://forum.cursor.com/t/proposal-bots-and-task-cards-a-simpler-way-to-work-with-several-grok-bots/174982
[f-memusage]: https://forum.cursor.com/t/grok-bot-memory-usage-local-measurements-cross-tool-comparison-and-asks-for-the-product/177366
[f-hung]: https://forum.cursor.com/t/grok-bot-agents-context-compaction-clone-replace-for-hung-chats-and-per-bot-usage-telemetry/173357
[f-tokens]: https://forum.cursor.com/t/grok-bot-context-window-size-and-token-accumulation-logic-in-pro/171540
[f-stuck]: https://forum.cursor.com/t/my-grok-bot-seems-to-be-stuck/173860
[f-broke]: https://forum.cursor.com/t/grok-bot-is-broke/169537
[rakazo]: https://github.com/elie222/rakazo
[opensuperbot]: https://github.com/wolfqing/OpenSuperBot
[openmausbot]: https://mausbot.com
[openmausbot-src]: https://github.com/milind-soni/OpenMausBot
