# Grok Bot flow teardown

This is the reference Clawtrate's builders work from. It describes how Grok Bot behaves on desktop and iOS, from public material only, as of 16 November 2026. `docs/parity.md` turns each verifiable behavior here into a checklist row.

Grok Bot is the personal agent app from SpaceXSI (formerly xAI). It runs on Cursor's infrastructure. It went into beta on 11 August 2026, and 1.0 shipped on 2 November 2026. The desktop app was at version 0.79.x on 11 November, and the iPhone app at 1.26.0 on 14 November.

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

Two naming notes. The product calls its agents "Bots", with a capital B. The docs call the main Bot both "primary Bot" and "Main Bot".

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
9. The first Bot speaks first. "Working on it" shows for five to ten seconds, then a greeting and a question card arrive. (See section 5.3 for question cards.) ([learngrokbot: first Bot][lgb-first-bot], seen in screenshot)
10. If no primary Bot is set, a dialog titled "Introducing Primary Bot" appears. It shows a Bot picture with a small orange star and reads, in substance, that the primary Bot works proactively, is your go-to for everyday tasks, unblocks your work and checks in when it needs you. It has two buttons: "Use an existing Bot", which opens a searchable list of Bots and a "Confirm" button, and "Create Primary Bot". ([learngrokbot: chief of staff][lgb-cos], reported from caption; [docs: bots][d-bots], seen; [Flavio Copes][flavio], reported)
11. The docs suggest starter templates (Morning briefing, Inbox manager, Competitive intelligence, Travel coordinator) and prebuilt marketplace Bots (Overheard, Tradbot, Meeting Recap Deck, Pitch Deck Coach). ([docs: get started][d-start], seen)
12. Importing memory from another assistant is optional: Settings, General, "Import Memory to Grok Bot", "Start Import". You copy a prompt into the other assistant, paste its answer into a second box and choose "Add to Memory". The import goes to the primary Bot. ([docs: bots][d-bots], seen; [docs: settings][d-settings], seen)

### iOS

- The iPhone welcome screen in the App Store shows the Grok Bot wordmark centered, the line "Your team of always-on Bots that finish the work.", a black full-width "Log in" button and a light grey "Sign up" button. Five Bot avatars float around the edges. ([App Store][appstore], seen)
- The phone sign-in labels include "Continue with Google", "Sign in with Apple", "Continue with email", "Enter your verification code" and "Use the browser instead". Linking a Grok subscription uses "Link Grok Account" and then "Finished Linking? Refresh My Status". ([docs: mobile][d-mobile], seen)
- The phone asks for notification permission during first run. ([docs: settings][d-settings], seen)
- A subscription link to SuperGrok or X Premium+ has to be made on a computer first. ([learngrokbot: setup][lgb-setup], reported)
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
- One accessibility detail: a third-party tool reads the busy state from the window, where a busy Bot's sidebar button is named "<Bot>, Working". ([perch PR][perch], reported)
- No public source describes a numeric unread count on rows. The App Store iPhone home list shows a timestamp at the right of each row ("8:41 AM", "Yesterday", "Tuesday") and no count. ([App Store][appstore], seen)

### Ordering

- Pinned Bots stay at the top. Below them, sections appear in the order you made them. ([docs: bots][d-bots], seen)
- No source documents the sort order inside a section or in the unsectioned list. The App Store iPhone list is sorted newest activity first: 8:41 AM, 8:22 AM, 8:05 AM, Yesterday, Tuesday. (inferred from [App Store][appstore])
- `Cmd/Ctrl+1` to `9` jump to sidebar Bots; `Alt+Up/Down` and `Control+Tab` move between Bots. ([docs: chat][d-chat], seen)

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

### 4.1 One continuous conversation per Bot

This is the most important structural fact for Clawtrate. **In Grok Bot, a Bot is a single, never-ending chat.** There are no separate threads or tasks under a Bot.

- The design post says Grok Bot is organized around Bots rather than conversations, because "chats are disposable" and you come back to the same Bot tomorrow. ([x.ai design post][x-design], seen)
- Staff confirm there is one continuous conversation per Bot. Starting a "New chat" with the same Bot opens a group chat named like "Bot + me", not a fresh session. A second request waits while the Bot is busy. ([forum: compaction][f-compact], reported; [forum: parallel threads][f-parallel], reported)
- You can reply to a single message in a thread (reply threads), which is meant for feedback on one result or approval. ([docs: chat][d-chat], seen)
- "Reset this conversation?" exists only as a recovery path. A blocked-message notice offers "Reset". The history restarts, and memory, files, routines and settings stay. ([docs: bots][d-bots], seen)
- Long conversations are summarized automatically near the context limit. Every reply re-reads the whole conversation, so long chats cost more. There is no manual compaction, no context meter and no fresh session. ([forum: compaction][f-compact], reported; [CellCog][cellcog], reported)
- The workaround staff suggest is one Bot per topic, hiding Bots whose topic is finished, and duplicating a Bot to fork it. ([forum: threads][f-threads], reported)
- Routine runs open in their own chat, and "Close Chat" brings you back to the main conversation. ([changelog][x-changelog], reported)
- The details panel has a "Tasks" tab that lists Cursor Cloud Agents a Bot started, under "Coding", with the states "Working", "Run failed" and "Status unavailable". A finished agent shows "Working" again when a follow-up starts. ([changelog][x-changelog], reported)
- A Bot can start a "Project" when asked: a Cloud Agent that plans the work and runs its own agents. ([changelog][x-changelog], reported)

### 4.2 Desktop chat layout

From a first-hand screenshot of a 1:1 chat with the details panel open (dark theme):

- The chat column takes about two thirds of the window width, and the details panel about one third, divided by a thin vertical line. ([learngrokbot: what is][lgb-what], seen)
- The chat header is a floating dark pill at the top center of the chat column, holding the Bot's small avatar and name. Clicking it opens "View conversation details". ([learngrokbot: what is][lgb-what], seen; [docs: files][d-files], seen)
- A centered grey timestamp separates time blocks, for example "Today 2:55 PM" or "Sun, Oct 25 7:35 PM". ([learngrokbot: first Bot][lgb-first-bot], seen; [alexop.dev][alexop], seen)
- **Your messages** are right-aligned rounded bubbles filled with the Bot's color (blue for a blue Bot, orange for an orange one), with white text. "Settings, Appearance, Accent" can switch this from "Bot color" to "Black". ([learngrokbot: what is][lgb-what], seen; [alexop.dev][alexop], seen; [docs: settings][d-settings], seen)
- **The Bot's messages** are left-aligned dark grey rounded bubbles. Consecutive messages stack as separate bubbles with a small gap. In a 1:1 chat there is no avatar or name beside each bubble. Bubbles are at most about three quarters of the column's width. Markdown tables render inside the bubble, and wide tables can extend into the empty space beside the message. ([learngrokbot: what is][lgb-what], seen; [Flavio Copes][flavio], reported)
- Hovering a Bot message shows three small icon actions to its right: react (smiley), reply (curved arrow) and more (three dots). The more menu has "Download" or "Download all" for media, "Copy request ID" for errors, and other actions. ([alexop.dev][alexop], seen; [docs: files][d-files], seen)
- **Composer:** a full-width rounded pill at the bottom. A round "+" button sits on the left, and the placeholder reads "Message <Bot name>". At the right, a round microphone button ("Start voice input") and a round white waveform button ("Start voice chat"). The waveform shows only when the composer is empty; once you type, a round send arrow replaces it. ([learngrokbot: first Bot][lgb-first-bot], seen; [learngrokbot: what is][lgb-what], seen)
- The "+" menu opens upward with "Attach files" and "Teach a task" (with a red record dot). ([learngrokbot: skills][lgb-skills], reported from caption)
- Composer shortcuts: `@` mentions a Bot, group, routine or app; `/` opens a skill list (it was removed in 0.68.1, per one user, and the docs say to ask for a skill by name); `>` at line start makes a block quote; `Enter` sends, `Shift+Enter` adds a new line, `Cmd/Ctrl+Enter` sends from anywhere; `Cmd/Ctrl+D` starts dictation; `Cmd/Ctrl+/` lists all shortcuts; `Cmd/Ctrl+F` finds in chat; `Cmd/Ctrl+I` focuses the prompt; `Cmd/Ctrl+L` adds selected text to chat; `Cmd/Ctrl+K` opens search across Bots, groups, messages, files, links, routines and settings; `Cmd/Ctrl+Shift+F` searches Bots. ([docs: chat][d-chat], seen; [Flavio Copes][flavio], reported; [forum: instructions][f-instructions], reported)
- The `/` menu, when present, lists matching rows with a right-aligned tag. Typing "/check" showed "Check Cursor changelog" tagged "Skill" and "Check for Updates" tagged "Action". A sent skill appears as a chip in your bubble. ([learngrokbot: skills][lgb-skills], reported from caption)
- Drafts are kept per conversation. ([docs: mobile][d-mobile], seen)
- Attachments: up to 20 per message, images 25 MB each and 200 MB total, documents 250 MB, video 1 GB. An oversized file is flagged and dropped. While files upload, your message shows a "Sending…" bar that fills. ([docs: files][d-files], seen; [changelog][x-changelog], reported)
- A failed send shows "Failed to send" with "Resend" and "Delete". On the phone, a divider reads "SEND AFTER RECONNECT". ([learngrokbot: changelog][lgb-changelog], reported; [learngrokbot: error messages][lgb-errors], reported)

### 4.3 Details panel

- It opens on the right when you click the Bot's name. A share button (upload icon) and a close button (X) sit at the top right. Below them, centered: a large avatar about a fifth of the panel's width, the name in bold, "Add a label" (or the label) in grey, then a segmented control with three tabs, "Details", "Library" and "Computer". ([learngrokbot: first Bot][lgb-first-bot], seen)
- **Details** lists "Routines". Each routine is a rounded row with its name, a second line with its schedule or "Paused", and a switch on the right. The empty state reads "Ask in chat to set a routine". On Team Bots, "Details" also shows "About" (the description). Meetings appear under "Upcoming", and "Suggested" can hold "Add to meeting" or "Review learnings". ([docs: routines][d-routines], seen; [docs: meetings][d-meetings], seen; [docs: team Bots][d-team], seen)
- **Library** lists what the Bot made (section 9.5).
- **Computer** shows a 16:9 live thumbnail of the Bot's screen with a dark "Open" pill (expand icon) centered over it, and the caption "<Bot>'s screen". (Section 7.)
- A "Tasks" tab appears when the Bot has launched cloud agents. ([changelog][x-changelog], reported)
- An older layout had "Details / Media / Computer", and "Media" became "Library" in v0.62.0. ([forum: description][f-description], reported; [learngrokbot: changelog][lgb-changelog], reported)

### 4.4 Group chats

- Create with "New chat", `Cmd/Ctrl+Shift+N` or `Cmd/Ctrl+K` and then "New group chat". On the phone, "+" and then "New Group Chat". Add two to six Bots in the "To:" field. The generated name begins with your own name and then lists the Bots, and you can rename it with right-click, "Rename chat". ([docs: chat][d-chat], seen; [learngrokbot: multiple Bots][lgb-multi], seen)
- The group header is a centered pill with the group's name. Each Bot reply has the Bot's name above it in small text in that Bot's color, and the Bot's small avatar sits at the bottom left of its last bubble. Your messages are right-aligned in a neutral grey, since a group has no single Bot color. ([learngrokbot: multiple Bots][lgb-multi], seen)
- Bots decide among themselves who answers. `@Bot` targets one Bot, `@everyone` all of them, and "Reply" answers one Bot. ([docs: chat][d-chat], seen)
- Groups do not show approval requests, secret or login requests, or email and Slack drafts. A Bot that needs your OK says the step is blocked and asks you to open its own chat. Groups have no voice chat and no per-Bot notification switch. ([docs: chat][d-chat], seen; [learngrokbot: multiple Bots][lgb-multi], reported)

---

## 5. The conversation while a Bot works

### 5.1 The thinking and working UI

The owner named this as a detail he likes. The public evidence, in order of strength:

**What the official design post says** ([x.ai design post][x-design], seen):

- The team rejected the standard three animated dots, because they cannot tell working apart from stuck.
- They tried a short written description of the current action, and users then wanted every step, mostly for reassurance.
- The final design makes the Bot's avatar the first signal. The avatar shows the lifecycle state through motion: calm and a little curious at rest, it acknowledges incoming work, speeds up while working, changes its motion when waiting or needing help, and settles when finished. The named states are idle, thinking, working, waiting, blocked and done.
- If you want to know what the Bot is doing, you hover to see its current action. Step details sit behind that hover and are not shown by default.
- The post's mock step log shows what those steps look like: "Searching the web", "Environment ready 387ms", "Edited math.ts +14 −10", "Ran focused tests npm test", "Thought briefly", "Read AGENTS.md", "Ran full suite 212 passed", "Committed fix: clamp NaN". Each step is a short verb phrase with an optional grey detail: a duration, a diff count, a command or a result.

**What a first-hand screenshot shows** ([learngrokbot: home][lgb-home], seen):

- Under the last Bot bubble, flush left, there is no bubble. The Bot's small avatar (about the height of two lines of text) sits beside the words "Clicking around" in grey. The first word looks dimmer than the second, which suggests a light sweeping across the text (a shimmer). The shimmer is inferred from one still frame.
- Above that line, the Bot has already posted two short progress bubbles: "On it — pulling Notion, Asana, and Trello public pricing now, then I'll set the Monday check." and "Reading the Notion, Asana, and Trello pricing pages now — table next, then the Monday watch." The answer then arrives as a further bubble.

**What the official changelog says** ([changelog][x-changelog], reported):

- The status line shows up right after you send, even for quick replies.
- The status is a short phrase in your language, in the app and in Slack. Examples: "Thinking it through", "Working on your computer", "Working on it" and "Thinking". The Bot's name is not put in front. For a greeting, thanks or small talk, it says "is on it" or "is working on it".
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
3. Tool calls, browser steps and shell commands are not listed by default. Hovering the working line (desktop) shows the current action. No source shows an expandable step log in a shipped screenshot.
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

In the screenshots, these lines are right-aligned, in a smaller grey font, with the icon or avatar and the name in a slightly lighter grey. They sit between bubbles with normal spacing. ([learngrokbot: multiple Bots][lgb-multi], seen; [learngrokbot: routines][lgb-routines], seen)

### 5.3 Cards in the transcript

Cards are full-width-ish rounded panels, darker than bubbles, with a title at the top left, an optional status tag at the top right and buttons at the bottom. ([learngrokbot: approvals][lgb-approvals], seen; [learngrokbot: gmail][lgb-gmail], seen)

- **Question card:** a title such as "Who or what should I watch?" with an X at the top right. It lists two to five lettered options (A, B, C, D) as rows, each with a grey letter badge, and an option can have a second grey line ("Type the names yourself"). A "Type your own answer" field sits at the bottom. Once answered, the card folds to one line showing the chosen letter and text, with a check mark on the right. The Bot no longer repeats the question as a separate message. ([learngrokbot: first Bot][lgb-first-bot], seen; [changelog][x-changelog], reported)
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
- **There is no documented stop button.** To end work, you send a direct message such as "Stop now". Stopping does not undo completed actions. ([docs: chat][d-chat], seen; [docs: troubleshooting][d-trouble], seen)
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

---

## 6. Bot-to-bot messaging and handoffs

The owner likes the card that shows when one Bot has messaged another. **In Grok Bot it is a grey event line, not an expandable card.** It opens a read-only view of the exchange in place of the chat. Clawtrate's target, an inline card that expands to show what was sent, is an improvement, not parity.

### What you see in the sending Bot's chat

From a first-hand screenshot ([learngrokbot: multiple Bots][lgb-multi], seen):

1. The Bot's bubble: "Asking Demo Price Watch for Linear Basic pricing now."
2. A right-aligned grey line: "Messaged", then the receiving Bot's small avatar (about the size of a capital letter) in its color, then its name in a lighter grey.
3. The Bot's bubble: "Asked Demo Price Watch — I'll pass along what they say when they reply."
4. Later, a right-aligned grey line: "Message from", the same avatar and name.
5. The Bot's bubble relays the answer in its own words: "Demo Price Watch says Linear Basic is $10 per user/month, billed yearly (linear.app/pricing)."

The same pattern appears in a primary Bot's chat: "I'll have…", "Messaged <Bot>", "I asked… I'll pass along what they change once it's done." ([learngrokbot: chief of staff][lgb-cos], seen; image credited to a Riley Brown video) Another user's chat shows "Messaged Finances" and "Messaged Instagram · Social Media", with the Bot name in bold. ([alexop.dev][alexop], reported)

### Opening the exchange

- You click the Bot's name on the grey line. The exchange opens **in place of the chat**, with no message box and a "Close Chat" button. Both "Messaged" and "Message from" appear in the chat of the Bot that asked (desktop 0.68.1). ([learngrokbot: multiple Bots][lgb-multi], reported)
- In the **receiving** Bot's chat, the same exchange is one grey line with a count, such as "2 messages with <first Bot>". The design post shows the plural form, "6 messages with Kenny, Tyler and Jenny". ([learngrokbot: multiple Bots][lgb-multi], reported; [x.ai design post][x-design], seen)
- No public source shows what the opened exchange looks like inside. I infer it is a read-only chat transcript of the messages between the two Bots, with the same bubble styles. (inferred)
- No source describes a separate view of the receiving Bot's own working steps. Its work shows in its own chat like any other turn: its sidebar avatar animates, and its row shows a working state. ([docs: chat][d-chat], seen; inferred)

### Rules

- A Bot sends another Bot an asynchronous message. The receiver wakes, does the work and may reply later. ([docs: chat][d-chat], seen)
- You can ask for a handoff by naming the other Bot in plain words, or by typing `@` and picking it. Bots also message each other on their own when they judge the job needs it. ([learngrokbot: multiple Bots][lgb-multi], reported)
- Handoff messages are text only. A Bot that needs another to see an image must send the image itself. ([docs: chat][d-chat], seen)
- **There is no switch to stop Bots messaging each other.** You tell them in chat and ask them to remember the rule. ([docs: chat][d-chat], seen)
- Every Bot-to-Bot message counts as a reply against usage. One user measured 8 percent of a month's usage as Bot-to-Bot traffic. ([docs: chat][d-chat], seen; [alexop.dev][alexop], reported)
- When one Bot wakes another, the second Bot's questions come to the chat where you asked. ([changelog][x-changelog], reported)
- Approvals raised by work that another Bot started expire after about 30 minutes. ([docs: approvals][d-approvals], seen)
- Stopping a Bot also stops the Bots it handed work to. ([changelog][x-changelog], reported)
- Delegation in Slack: a Team Bot in a Slack thread can hand work to the requester's own Bots, and their replies come back into the same thread. A personal Bot in a shared Slack channel thread cannot hand off. ([docs: chat][d-chat], seen)
- The marketing page shows a Slack-style thread in which "Invoice Bot" tags "@AP Bot", a "Thinking" indicator appears, and "AP Bot" replies, each marked "APP". ([x.ai product page][x-product], seen)

### Handoff to coding agents (the T3 Code equivalent)

- Bots hand coding work to Cursor Cloud Agents and attach the results to their reply. The Cloud Agent shows as a card in the conversation, with the files cited in the agent's final report. On the phone, the card shows the files once the run is "Done", "Error" or "Expired", ordered images, then videos, then other files, with "Retry", "View PR" and "Open in Cursor". ([docs: how it works][d-how], seen; [docs: files][d-files], seen)
- The details panel's "Tasks" tab lists these runs (section 4.1).
- A daily routine shown by one user has the Bot pick stale posts and a Cursor cloud agent open a PR, then the Bot posts a one-line summary. ([Flavio Copes][flavio], reported)

This is the slot where Clawtrate shows "Messaged T3 Code". Grok Bot's Cloud Agent card is the nearest existing pattern: a card with a status, files and a link out to the coding app.

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
2. **Preview:** opening it reveals a pinned side panel where you can follow along without leaving the conversation. This is the "Computer" tab of the details panel.
3. **Takeover:** full screen. You take control, then hand it back.

The team rejected a floating window (it covered the chat), side by side (it encouraged watching), a modal (it treated the workspace as an interruption) and full screen by default (it pushed the chat out). The more prominent the computer, the more people felt they had to supervise it. The wallpaper on the Bot's desktop changes through the day, lighter in the morning and darker at night, so the Bot's machine never looks like your own desktop.

### Preview tile

- The "Computer" tab shows a 16:9 thumbnail of the Bot's live screen, taking the panel's full width with rounded corners. A dark rounded "Open" pill with an expand icon sits in its center, and the caption under it reads "<Bot>'s screen". ([learngrokbot: what is][lgb-what], seen; [learngrokbot: shared computer][lgb-computer], reported)
- When a site shows a human check, the thumbnail shows that page with "Open" over it. ([learngrokbot: logins][lgb-logins], reported from caption)
- A first-hand screenshot of one Bot's screen shows a Linux desktop with a Chrome window, a taskbar with "Applications" and a terminal icon, and a clock. ([alexop.dev][alexop], reported)
- On iPhone, a round monitor icon at the top right of the chat header opens the computer. ([App Store][appstore], seen)

### Full screen and takeover

- "Open" fills the app window with the Bot's desktop. A small "Exit fullscreen" control sits at the top right. You see clicks, typing, navigation and current status as they happen. ([learngrokbot: shared computer][lgb-computer], reported; [docs: computer][d-computer], seen)
- Full screen opens in "Watching" mode until you press "Take control". It shows the live view at once, without a second "Connecting" screen. ([changelog][x-changelog], reported)
- When a Bot needs you (password, two-factor code, CAPTCHA, passkey, SSO, bank card check, a QR code or approval on another device), it posts a **Computer card**. The card is titled "Computer", with a bold line saying what it needs ("Sign in to GitHub, then hand the screen back.") and a grey note that the sign-in happens in the browser on the Bot's computer and stays signed in there. Under that is a dark 16:9 preview tile with a small monitor icon, then three buttons: "Take over" (white, primary), "I'm done" (outlined) and "Skip" (plain text, right). The Bot's sidebar row starts "Waiting for you", and the card's status shows "Action needed". ([learngrokbot: shared computer][lgb-computer], seen; [docs: troubleshooting][d-trouble], seen)
- After "Take over", the computer opens full screen with a bar across the top holding "Skip this step" (dark) and "I'm done, continue" (white). A collapse icon sits at the top right. ([learngrokbot: shared computer][lgb-computer], seen)
- When you press "I'm done", the chat card changes to "Done", and the Bot continues. The docs also say to tell the Bot to continue. ([learngrokbot: shared computer][lgb-computer], reported; [docs: approvals][d-approvals], seen)
- Recording for "Teach a task" uses the same full-screen view: a red outline around the desktop, a bar reading "<Bot> is watching and learning", a square stop button and a timer at the top right. The record button is red, "Start recording", with an X beside it. (Section 9.2.) ([learngrokbot: skills][lgb-skills], reported from caption)
- On iPad, the full-screen computer view is black. An X and the Bot's name sit at the top left, "?" and "…" at the top right, and the 16:9 screen is centered and letterboxed. Small icons at the bottom left (clipboard) and bottom right (keyboard) handle paste and the on-screen keyboard. ([App Store][appstore], seen)

### Files, terminal, downloads and artifacts

- There is no file browser or terminal panel in the app. The computer has a browser, command line and file system, but you see them only through the screen view. Durable files belong in `/workspace`. Temporary folders, installed packages, `node_modules` and virtual environments are not kept. ([docs: computer][d-computer], seen; [docs: files][d-files], seen)
- Files reach you as cards in the chat and in the Library (section 9.5). ([docs: files][d-files], seen)
- When disk space is low, the Bot names the largest items once and deletes only after you say yes. ([docs: computer][d-computer], seen)

### Your own computer

- A Bot can also run commands on your desktop. The first time, a prompt asks "Allow Grok Bot and all Bots to run commands on your local computer?" with "Always allow", "Allow once", "Never" and "Deny once" (Esc). ([docs: approvals][d-approvals], seen)
- Settings, Computer, "Your computer", "Execution on this computer" has "Ask every time" (default), "Always allow" and "Never allow", with the description "Let Grok Bot open files and run tasks on your computer. Auto-review still checks everything first." It shows "Execution on Local Computer" until the desktop is listed. ([docs: settings][d-settings], seen; [learngrokbot: approvals][lgb-approvals], reported from caption)
- "Route traffic through this computer" sends the Bot's web traffic through your desktop, with a count such as "167 routed this session". Only one computer can route at a time. ([docs: settings][d-settings], seen; [learngrokbot: logins][lgb-logins], reported from caption)
- "Manage devices" lists computers and phones, each "This device", "Online now" or last opened. You can rename a device, change another computer's execution setting, or remove an offline computer with "Remove Computer". Phones cannot be removed. ([docs: mobile][d-mobile], seen; [docs: settings][d-settings], seen)

### Stuck computer and recovery

- States: "Reconnecting", "Couldn't Reach Grok Bot's Computer" (with "Retry"), "Unreachable" on the computer card, "Can't reach New Bot's screen". A notice at the top of an empty sidebar reads "Can't reach your computer", with "Retry" and "Recover computer". ([docs: troubleshooting][d-trouble], seen; [learngrokbot: can't reach computer][lgb-cantreach], reported)
- Settings, Updates (or Computer), "Grok Bot's Computer" has "Update Grok Bot's Computer" ("Your computer is on the latest version") and "Reset Grok Bot's Computer" ("Start fresh if the computer gets stuck. It's rebuilt from your last saved snapshot, so very recent changes may be lost."), with a red "Reset" button. ([learngrokbot: not responding][lgb-notresp], reported from caption)
- The update window, "Updating Grok Bot's Computer", lists seven steps with circle icons: "Getting ready", "Backing up your data", "Recreating Grok Bot's computer", "Transferring your data", "Starting Grok Bot's computer", "Cleaning up" and "Reconnecting". Done steps get a check mark, the active one a spinner and grey text turns white. A progress bar with a percentage ("43%") sits under the list, then a box "Update still running" explaining that large transfers take minutes, then "Continue in Background" and a white "Keep waiting". The recovery window, "Recovering Grok Bot's Computer", has four steps and only "Continue in Background". Failure shows "Reset failed" with "Dismiss" and a red "Retry Reset". ([learngrokbot: can't reach computer][lgb-cantreach], seen)
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
- After "Deny", the tag reads "Denied", the buttons disappear, and a line reads "<Bot> won't do this." The Bot will not retry or re-ask until you send another message.
- After "Always allow", the card is headed "Action approved" with a green "Always allowed" tag. It repeats the task, then says "A rule always allowing this was added to your Auto-review settings", followed by the rule in quotation marks. The docs call this state "Saved to Custom Rules".
- Expired: the card is headed "Approval expired" with a grey "Expired" tag and no buttons, and reads "You can manage Auto-review in Settings". The docs say an expired card says the action was not taken, and that "Always allow next time" still saves the rule.

Variants ([docs: approvals][d-approvals], seen):

| Card | Buttons |
|---|---|
| Standard | "Allow once", "Always allow", "Deny" |
| Terminal command | "Allow", "Skip", "Manage settings" (opens Auto-review settings) |
| Paused by an Ask-first rule | "Allow", "Not now", "Edit rule" (opens Custom Rules) |
| No rule to offer | "Allow" instead of "Allow once"; no "Always allow" |
| Personal account use by a Team Bot | "Allow once", "Always allow" (menu: "Always allow for your messages to this Bot", and one for every Team Bot), "Skip" |
| Slack thread ("Review an action") | "Allow once", "Deny", "View details". Only the requester can answer. |
| Group chat | Only the person the Bot is answering can approve. Others see who it waits on. No "Always allow". |
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

- Bots better recognize when you have already authorized an action and when they must ask, so they interrupt less. They respect each user's permissions and check whether information suits a public channel. Shipped in v0.75.5. ([x.ai 1.0][x-10], seen)
- Specific changes from the changelog ([changelog][x-changelog], reported):
  - Background work you start in your own words no longer needs approval to start.
  - Before an action it cannot undo (sending, posting, buying, deleting), a Bot checks your own messages for approval.
  - Cards name the Bot and quote its instruction.
  - Cards show when an Ask-first rule paused the action, or when "Always allow" added a rule, with "Edit rule".
  - Approval cards say in one sentence what the Bot wants, with the detail behind "View the full request" (v0.56.0).
- The 1.0 launch image shows a voice call in which the Bot flags sensitive financials on slide 6 and offers to send the deck without that slide. ([x.ai 1.0][x-10], seen)

### 8.7 Secrets and logins

- Sign-in order: a login saved in Vault, then a connected password manager (1Password), then a Secure Form. Vault and Secure Form values are filled in without the model seeing them. ([docs: approvals][d-approvals], seen)
- The **Secure Form card** in chat shows the site's logo, "Sign in to GitHub", "Secure Form" beneath it and an "Open" button at the right. "Open" shows a dialog titled "Sign in to GitHub" / "Secure Form" with "Username or email address" and "Password", the line "Never shown to your Bot. Filled directly to github.com." and "Continue". A checkbox "Securely save to Bot's vault" decides whether it is saved. ([learngrokbot: logins][lgb-logins], reported from caption; [learngrokbot: shared computer][lgb-computer], reported from caption; [Flavio Copes][flavio], reported)
- The **secure secret card** for API keys has a masked field and "Save securely". Afterwards it says "Saved" and "Saved securely and kept private". Saved values are write-only and never shown again. ([docs: vault][d-vault], seen)
- Vault (Settings, Vault) holds logins, cards and contact info. Everything in it is available to every Bot on the account, and you cannot limit an item to one Bot. ([docs: vault][d-vault], seen)
- Phone permission card: "Grok Bot needs permission" with "Allow", or "Open Settings" if denied before. The Bot waits up to five minutes. ([docs: mobile][d-mobile], seen)

---

## 9. Scheduled and proactive work, notifications, and finished work

### 9.1 Routines

- **Create:** on desktop, you ask the owning Bot in chat ("every weekday at 8:00 AM, post the same kind of digest in this chat"). The Bot replies, and a grey "Created routine" line with a clock-icon chip and the routine's name appears. On the phone, the Bot's profile has "Routines" and "Add routine", which pre-fills "Set up a routine to" in the composer. ([docs: routines][d-routines], seen; [learngrokbot: routines][lgb-routines], seen)
- **Routine panel** (click the chip or the row in Details): "Instruction" with the paragraph the Bot wrote, "When to run" with a clock icon and the schedule in words ("Weekdays at 8:00 AM"), and "Webhook" if it has one. At the bottom: "Pause" or "Resume", "Test", "Edit", and a bin icon for "Delete routine", which asks to confirm. "Test" reads "Running…" until done, and failure says "Couldn't start a test run". ([docs: routines][d-routines], seen; [learngrokbot: routines][lgb-routines], reported from caption)
- "Edit" pre-fills the composer with "Edit your routine: <name>." You add changes and send, and an "Updated routine" line appears. ([docs: routines][d-routines], seen; [learngrokbot: routines][lgb-routines], reported from caption)
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
- **Teach a task:** "+", "Teach a task", then "Start recording". You do the task once on the Bot's desktop (up to ten minutes, no sound). Stopping sends an automatic message, "The recording is finished. Learn the task from it.", with a "Learn from demonstration" chip. The Bot replies "Learned <skill> from your demo", lists numbered steps and asks "Want a dry run?". One guide found that the Bot added a step that was never in the recording, and no review screen appears first. Teach a task is desktop-only. ([docs: routines][d-routines], seen; [learngrokbot: skills][lgb-skills], reported)

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
- **Library** (details, "Library" tab; on the phone, tap the Bot's name, then "Library"): Pages, files and apps the Bot made, plus images, videos and links it sent. It does not list things you uploaded or files from Cloud Agents. Items are grouped under "Today", "This week" and "Older", five at a time, with "Show more". Desktop filters: "All", "Pages", "Media", "Links", "Files", "Apps" and "Pinned". The row menu has "Pin"/"Unpin", "Open" and "Share…". A "Pinned" section syncs across devices. ([docs: files][d-files], seen)
- **Pages** are interactive documents (reports, memos, dashboards). A Page card has the title and "Open". On desktop, the Page fills the window with a smaller chat panel beside it, labelled "Message about <Page title>". The Bot edits the same Page for everyone who can view it. Filters on the Page change only your view. Sharing options are "People you invite" ("Only you" on personal accounts), your team, or "Anyone with the link" on pages.grok.bot. ([docs: files][d-files], seen)
- **Media viewer:** click a thumbnail for full screen, arrow keys or thumbnails to move, a download button at the top, Escape to close. Video plays at 2×, 1.5×, 1× or 0.5×. Right-click offers "Copy image", "Save image…" and "Save video…". ([docs: files][d-files], seen)
- A Bot no longer sends a message that only says it is done. The Bot is expected to summarize what it did in a few lines. ([Flavio Copes 1.0][flavio-10], reported)

---

## 10. Memory

- **What a Bot saves:** your preferences and working style, rules you give it, facts about you (name, time zone), and a dated log of work. Logins and cards belong in Vault. ([docs: bots][d-bots], seen)
- **When:** it decides on its own and does not ask. Saves are not always mentioned in chat. The product page mockup shows a "Saved to memory" confirmation line. ([docs: bots][d-bots], seen; [x.ai product page][x-product], seen)
- **Scope:** memory applies across all your chats with that Bot. Each Bot has its own memory, but some facts are shared by all Bots (name, time zone). Bots can also save shared facts and standing rules that apply to all Bots. In a group chat, a Bot may use what you told it privately, and others see its replies. ([docs: bots][d-bots], seen; [forum: memory][f-memory], reported)
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
- `@` in the composer attaches an app to a task. You can ask a Bot to add an app ("Add the Linear app"), and its tools work from your next message. ([docs: computer][d-computer], seen)
- **Custom connector** (desktop): "Add a custom connector" at the bottom of Connect apps. "Name" and "Type": "Remote HTTPS" ("Server URL", optional "HTTP headers", OAuth "Client ID", and a "Client Secret" that appears after a Client ID) or "Command" ("Command" plus "Arguments"). Then "Add plugin". Bots can add MCP servers by URL or command themselves, and private-network ones need your approval. ([docs: computer][d-computer], seen)
- **Apps are account-wide**, shared by every Bot. A second account for the same app uses "Add Another Account" with a label, and you refer to it by label ("Use my work Notion"). OAuth tokens stay on the vendor's backend, not on the computer. ([docs: computer][d-computer], seen)
- **Phone-only device apps** (Calendar, Contacts read-only, Location, Alarms; iPhone also Reminders and Home) appear under Connect apps, "This iPhone", with "Allow", "Allowed" or "Denied". They work only in your own 1:1 chat while the app is open. Some plugins show "Connect on your computer" on the phone. ([docs: mobile][d-mobile], seen; [docs: computer][d-computer], seen)
- **Mac apps (1.0):** Messages, Mail, Notes, Reminders, Calendar, Location and Contacts, each with its own "Allow". ([AIToolsReview][atr], reported)
- **Bot email address:** "Get yourself an email address" in chat, or Connect apps, "Email", "Choose a name", "Create address". It is permanent, and there is no inbox view. ([docs: computer][d-computer], seen)

---

## 12. Team Bots and meetings (1.0)

Brief, because Clawtrate is a personal client.

- **Team Bots** are one shared Bot a whole team chats with, each person in a private chat, in the app, Slack or Microsoft Teams. "+", "Create a Bot", name it and describe its purpose. Setup cards walk through the steps, for example "Add plugins — Step 1 of 5" ("Tools it can use. Each teammate signs in with their own account…", with "Skip" and "Add more plugins"), ending with "Step 5 of 5", "You built a Bot. Now your whole team gets a teammate." and "Publish to team" / "View details". It stays a draft only you can see until published. ([docs: team Bots][d-team], seen; [learngrokbot: teams][lgb-teams], reported from caption)
- **Sharing:** "Share", "Share this Bot", "Who has access" (team, organization, "People you invite" with "Limit access"), "Add people or groups", "Copy link". Roles are "Collaborator" (can chat) and "Manager" (can change and share); only the owner can delete. ([docs: team Bots][d-team], seen)
- **Review learnings:** memory and skill changes taught by teammates wait under "Suggested", "Review learnings" with a pending count. Each item has a label such as "Updates the skill" or "Forgets a team memory", plus "Approve" and "Reject". The same list is in "Manage" (wrench), "Knowledge", "To review". The phone shows "Learnings" with "3 to review". ([docs: team Bots][d-team], seen)
- "Manage" also has "General" and "Analytics". A Team Bot has "Secrets" and "Bot's accounts". ([docs: team Bots][d-team], seen; [docs: vault][d-vault], seen)
- **Meetings:** you paste a Google Meet, Zoom or Teams link and ask the Bot to join, then approve the card. The host admits it as "<Bot> (<your first name>'s Bot) - transcribing". Details shows "Upcoming" with a countdown, the next join time, or "Taking notes", and "Meeting actions": "Disable Interactivity" (row shows "Muted"), "Enable Interactivity", "Cancel" and "Quit". After the call, the Bot posts a summary and action items, with a longer report on a Page. ([docs: meetings][d-meetings], seen)

---

## 13. Settings, usage and quota

### Settings structure

Open from the account menu, "Settings", or `Cmd/Ctrl+,`. Panes: "General", "Computer", "Vault", "Usage & Billing", "Updates". ([docs: settings][d-settings], seen)

- **General:** "Account" card (picture, name, email, "Add account", "Sign Out"; several accounts with "Switch account" and "Remove"). "Appearance": "Theme" (Follow System, Light, Dark), "Accent" (Bot color, Black), "Language", "Check Spelling While Typing". "System": "Microphone", "Use hardware acceleration". "Bot": "Timezone", the "Auto-review" switch and "Custom Rules". "Import": "Import Memory to Grok Bot". "Security Key": "Use hardware security keys". "Team Bots": "Clear connector preferences". ([docs: settings][d-settings], seen; [learngrokbot: sign-in][lgb-signin], reported from caption)
- **Computer:** "Your computer" and "Bot's computer" sections, "Manage devices", "Execution on this computer", "Route traffic through this computer", "Update Bot's Computer", "Reset Bot's Computer". ([docs: settings][d-settings], seen)
- **Vault:** "New item", "New item → Import" from other password managers. ([docs: settings][d-settings], seen)
- **Updates:** "Grok Bot Updates" with "Update Track" (Stable), "Automatic Updates" ("Automatically update your client while you're away"), the version with "You're up to date" and "Check for Updates" or "Restart to Update". ([docs: settings][d-settings], seen; [learngrokbot: platforms][lgb-platforms], reported from caption)
- There is no model setting anywhere. ([docs: settings][d-settings], seen)

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
- **Chat screen:** a round back chevron at the top left, then a pill with the Bot's avatar and name. Tapping it opens the profile. A round monitor icon at the top right opens the computer. A centered grey timestamp. Your messages are black right-aligned bubbles in light mode, and the Bot's are light grey left-aligned bubbles. Link cards show an icon, title and domain. Reactions appear as a small emoji badge under a message. The composer is a round "+" at the left and a rounded field with the placeholder "Ask <Bot>" and a mic icon inside it on the right.
- **Profile** (tap the name): "Edit", "Notifications" toggle, "Library", "Routines" with "Add routine", "Avatar", "Duplicate", "Replace Primary Bot…", "Share as Template".
- **Settings** is reached from the avatar at the top left: "Connect apps", "Bot" ("Time Zone", "Set Time Zone Automatically", "Custom Rules", Auto-review, "Bot Computer", "Manage your devices"), "Usage", "Import Memory", "Language" ("System"), "Haptics", "Send Feedback", "Delete Account" (confirmed in the browser).
- **iPad:** a two-column split view, with the sidebar (search and + at the top, pinned tiles, then rows, and the account email at the bottom) at about a third of the width and the chat in the rest. The chat header has a sidebar toggle at the left, the Bot pill and a monitor icon at the right.

### Gestures

- Touch and hold a message: "Select Text", then "Add to Chat" or copy. ([docs: mobile][d-mobile], seen)
- Touch and hold a Library row: "Open", "Share", "Copy Link", "Open in Web". ([docs: mobile][d-mobile], seen)
- Touch and hold an image: "Copy Image" or "Save to Photos". ([docs: files][d-files], seen)
- Long press a Bot to duplicate it. Swipe a conversation row for quick pin and hide. Swipe a routine to delete it. Swipe an account to remove it. ([App Store][appstore], seen in version notes; [docs: mobile][d-mobile], seen; [docs: FAQ][d-faq], seen)
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

- Updating or recovering the computer (Reset is available).
- Testing a routine, editing schedules, full run history.
- Teach a task.
- Renaming a Page.
- Custom connectors, and some plugins ("Connect on your computer").
- 1Password setup ("1Password can only be set up on a Mac").
- Execution on the phone itself: phones cannot be a computer.
- Yearly, Teams or Enterprise purchases, and turning on on-demand usage.
- A shorter language list.

The phone can message Bots, watch or take over the computer, approve actions, and pause or resume routines. ([docs: get started][d-start], seen)

---

## 15. Other surfaces, briefly

These exist in Grok Bot but depend on vendor services. Clawtrate builders should know them, but they are low priority.

- **Voice chat:** "Start voice chat" (waveform, empty composer only). Status "Connecting…" (desktop) or "Calling…" (phone), then "Voice chat". Controls "Mute"/"Unmute", "Hang up", "Show transcript", "Show settings" ("Voice", "Speed" 0.5x–2x, "Language" with "Auto-detect"). One call at a time ("End the current voice chat?", "End and Chat"). Afterwards a "Voice chat" card with the length, and "How was the call?" with "Good" or "Bad". Errors: "Voice chat failed", "Connection lost", "No connection". ([docs: chat][d-chat], seen)
- **Dictation:** "Start voice input" (`Cmd/Ctrl+D`, hold to talk), text lands in the composer. ([docs: chat][d-chat], seen)
- **Voice memos from Bots:** "Play voice memo"/"Pause voice memo", expandable transcript that highlights each word in sync. ([docs: chat][d-chat], seen; [changelog][x-changelog], reported)
- **Shopping:** product cards with "Why it fits", "Where to buy", "Buy now" or "Out of stock" with "Notify me". Order card with "Ship to", "Pay with", "Total", a pay button showing the total, "Cancel", then "Paid with". ([docs: chat][d-chat], seen)
- **Phone calls** (US only): accept terms, "Call"/"Cancel", live transcript, "End call", "Take over" ("Connecting you…", "Transferred to you"), "Your answer" with "Send" or "Skip", then "Ended" with the length and a player. ([docs: chat][d-chat], seen)
- **X:** read-only X search without sign-in, the X plugin for DMs and timeline, X Chat, and tagging @bot on X. ([docs: computer][d-computer], seen; [docs: chat][d-chat], seen)

---

## Where sources disagree

| Topic | Disagreement | What to build from |
|---|---|---|
| Own computer per Bot | The marketing page says "Every Bot has its own computer". The docs say one computer per user, shared, with one screen per Bot. | The docs. Clawtrate goes further and lets each Bot pick its machine. |
| Bot creation | Docs and App Store: a "Create New Bot" dialog with name, shape and color. learngrokbot (October): a "To:" field with `Create "<name>" Bot`. | Both, as in section 3: the dialog is current; the To: row is a quick path. |
| Description and instructions | Older guides and some reviews describe a name, title and description that acts as the system prompt. Since late September, personal Bots have no description or instructions field. | Current behavior; Clawtrate restores a visible, editable field. |
| Tool steps | Docs: "the chat shows each step" and "tool activity". Users and the design post: tool calls are hidden, with the current action on hover. | The design post and the user reports. |
| Routine visibility on desktop | Docs: Instruction, When to run, Webhook, Test. One forum user (October): only the name, schedule and switch; Test and Run history were removed. | The docs, which are newer. |
| `/` skill menu | learngrokbot and Flavio: `/` opens skills. Docs: ask for a skill by name. A forum user: 0.68.1 removed `/`. | Unclear; Clawtrate keeps `/`. |
| Bot limit | Design post: about 50. Flavio: 50 Bots and group chats combined. Changelog: cap lifted on 1 September. | Treat as soft. |
| 1.0 date | Official page: 2 November. Some blogs: 11 November (1.0.1). | 2 November. |
| Platforms | AIToolsReview (14 November) says "no Android". The docs and Google Play show Android since 2 September. | The docs. |
| Models | Docs: "no model picker", the model can vary per request. 9to5Mac and Lindy report routing to third-party models. | No picker; model unknown. |

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
