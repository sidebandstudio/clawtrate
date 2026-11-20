// The gallery: every conversation component in every state.
// Each specimen is a name, an optional note, and markup built from components.js.
// Cards and steps work here as they do in the app: they open, Raw opens, copy
// copies, approvals and questions resolve. A specimen marked `still` is a
// picture of a state whose controls belong to the running conversation; it is
// inert here and works in conversation.html.

(function () {
  const CT = window.CT;
  const S = CT.samples;
  const { glyph, presence, statusLine, messaged, approval, approvalResolved } = CT;

  const labelled = (items) =>
    `<div class="spec-row">${items.map(([html, label]) => `<figure>${html}<figcaption>${label}</figcaption></figure>`).join("")}</div>`;

  const sized = (px, html) => html.replace('class="presence"', `class="presence" style="--size:${px}px"`);
  const eight = ["idle", "thinking", "working", "waiting", "blocked", "done", "failed", "stopped"];

  // Action cards, from the fixture calls in samples.js.
  const C = S.calls;
  const A = (c, patch = {}, opts = {}) => CT.actionCard({ ...c, ...patch }, opts);
  const F = (calls, opts) => CT.foldCard(calls, opts);
  const col = (...cards) => cards.join("");
  const files = ["backup-2026-11-15.log", "house-log.md", "plan.md", "exclude.list", "weekly.sh", "notes.md"];
  const reads = (k) => files.slice(0, k).map((f, i) => ({ ...C.read2, id: `call_7b${i}`, args: { path: `notes/${f}` }, took: `0.${i + 2}s` }));
  // A T3 Code thread's card, drawn from its calls.
  const key = CT.threadKey(C.t3Launch);
  const T3 = (first, calls, opts = {}) => CT.t3Thread(calls, opts);
  const stepBlocked = (source) => A({ ...C.rm, blockedBy: source === "review" ? "review" : "policy", body: S.blockedBody(source) }, {}, { open: true });

  const first = S.marlowFirst;

  const stoppedNote = CT.turnNote({
    lead: glyph("stopped"),
    html:
      "<p><b>Stopped after 40s.</b> Completed steps are not undone.</p>" +
      "<ul><li>Stopped with it: Marlow's run for this message.</li>" +
      "<li>The call to T3 Code was made. Work handed to T3 Code may continue there.</li></ul>",
  });

  const question = S.question;
  const skip = { title: "Which folders should the backup skip?", multi: true, options: [["Transcode cache"], ["Downloads in progress"], ["Thumbnails"], ["Trash"]] };

  // A request raised by a routine: the one kind that mints a grant with a lifetime in days.
  const routine = { request: { ...S.approval.request, routine: "Weekly cleanup" }, kind: "routine" };

  const shelf = (rows) => rows.join("");
  const queuedRow = (kind = "Queued", actions = CT.button("Send now") + CT.button("Cancel", 'data-variant="quiet"')) =>
    CT.shelfRow({ lead: glyph("queued"), text: `<b>${kind}</b> <span>Then check the certificate warning too.</span>`, actions });

  // Every state of lifecycle.html (docs/design/bots-lifecycle.md, section 14), for the Bot lifecycle section.
  const st = "panel=open&tab=settings";
  const lifecycleStates = [
    ["lc=intro", "Introducing the primary bot"],
    ["lc=choose", "Choose a primary bot"],
    ["lc=choose&prefs=device", "Choose a primary bot: this device only"],
    ["lc=choose&primfail=1", "Choose a primary bot: the reply is lost, the read again finds the old choice (choose one, Confirm)"],
    ["lc=choose&primfail=noread", "Choose a primary bot: the reply is lost and the read again gets no answer (choose one, Confirm)"],
    ["pin=otto,marlow&lc=choose", "Choose a primary bot with pins: the star goes first among them (choose Marlow, Confirm)"],
    ["primary=reused&lc=choose", "Choose a primary bot: the saved id now names a bot made since"],
    ["lc=choose&primconflict=1", "Choose a primary bot: another device chose first (choose one, Confirm)"],
    ["lc=choose&access=read", "Choose a primary bot on a read-only connection"],
    ["primary=pip&bot=pip&" + st, "Pip as the primary bot, its Manage group"],
    ["bot=juniper&" + st, "Juniper's settings: About, Manage, the hero editable"],
    ["bot=juniper&" + st + "&access=read", "Juniper's settings, read-only"],
    ["bot=juniper&" + st + "&lc=picture", "The picture editor: Bot"],
    ["bot=juniper&" + st + "&lc=picture&picfail=1", "The picture editor: refused (pick, Set picture)"],
    ["bot=juniper&" + st + "&lc=picture&picfail=dropped", "The picture editor: taken but not shown (pick, Set picture)"],
    ["bot=juniper&" + st + "&lc=picture&ptab=generate", "Generate: no image tool"],
    ["bot=juniper&" + st + "&lc=picture&ptab=generate&imagetool=1", "Generate: the tool offered"],
    ["bot=juniper&" + st + "&lc=picture&ptab=generate&imagetool=unknown", "Generate: not known yet"],
    ["bot=juniper&" + st + "&lc=picture&ptab=generate&imagetool=unlisted", "Generate: not listed"],
    ["bot=juniper&" + st + "&lc=picture&ptab=generate&imagetool=unavailable", "Generate: listed as unavailable"],
    ["bot=juniper&" + st + "&lc=picture&ptab=generate&imagetool=unreadable", "Generate: the tools couldn't be read"],
    ["bot=marlow&" + st + "&outside=1", "A picture at an https address: the character, and the choice"],
    ["bot=marlow&" + st + "&outside=http", "A picture at an http address: never loaded"],
    ["bot=marlow&" + st + "&outside=1&host=web", "A picture at an https address in the web preview: never loaded, no choice"],
    ["bot=juniper&" + st + "&lc=picture&ptab=upload", "Upload"],
    ["bot=juniper&" + st + "&lc=picture&ptab=upload&upload=crop", "Upload: cropping"],
    ["bot=juniper&" + st + "&lc=picture&ptab=upload&upload=toolarge", "Upload: too large"],
    ["bot=juniper&" + st + "&lc=picture&ptab=upload&upload=notimage", "Upload: not an image"],
    ["bot=juniper&" + st + "&edit=name", "The name in place"],
    ["bot=otto&" + st + "&edit=name&namefail=1", "The name in place: refused (type, Enter)"],
    ["bot=juniper&" + st + "&edit=label", "The label in place"],
    ["bot=juniper&" + st + "&bview=instructions", "Instructions"],
    ["bot=juniper&" + st + "&bview=instructions&instr=conflict", "Instructions: changed on the gateway meanwhile"],
    ["bot=juniper&" + st + "&bview=instructions&instrfail=1", "Instructions: a file couldn't be checked (edit, Save)"],
    ["bot=juniper&" + st + "&bview=instructions&instr=conflict2", "Instructions: the gateway's file changes again before Save mine over it (Save, Save mine over it)"],
    ["bot=juniper&" + st + "&bview=instructions&access=read", "Instructions, read-only"],
    ["bot=juniper&task=j1&rolechange=1", "A write to the instructions, in the conversation"],
    ["lc=duplicate&delbot=pip", "Duplicate Pip"],
    ["lc=duplicate&delbot=pip&dupacct=own", "Duplicate Pip: its account is its own"],
    ["lc=duplicate&delbot=pip&dup=partial", "Duplicate Pip: some settings still need attention (Duplicate)"],
    ["lc=duplicate&delbot=pip&dup=refused", "Duplicate Pip: the gateway refuses (Duplicate)"],
    ["lc=duplicate&delbot=pip&dup=nosource", "Duplicate Pip: a file the source doesn't have (Duplicate)"],
    ["lc=duplicate&delbot=pip&dup=partial&second=1", "Duplicate Pip: another device changes a row before Try again (Duplicate, Try again)"],
    ["lc=duplicate&delbot=pip&dup=lostcreate", "Duplicate Pip: the create's answer lost, a bot of that name listed (Duplicate)"],
    ["lc=duplicate&delbot=pip&dup=lostcreate-noroster", "Duplicate Pip: the create's answer lost, the list unanswered (Duplicate)"],
    ["lc=export&delbot=pip", "Export Pip to a Clawtrate file"],
    ["lc=export&delbot=pip&exp=web", "Export: the browser's download (Export file…)"],
    ["lc=export&delbot=pip&exp=cancelled", "Export: the save dialog closed (Export file…)"],
    ["lc=export&delbot=pip&exp=unchanged", "Export: the save failed, the old file unchanged (Export file…)"],
    ["lc=export&delbot=pip&exp=absent", "Export: the save failed, no file (Export file…)"],
    ["lc=export&delbot=pip&exp=saved-anyway", "Export: an error, but the file holds the export (Export file…)"],
    ["lc=export&delbot=pip&exp=unknown", "Export: the save failed, the file unknown (Export file…)"],
    ["lc=export&delbot=pip&exp=readfail", "Export: the read before the review fails"],
    ["lc=import", "Import a bot from a Clawtrate file"],
    ["lc=import&imp=review", "Import: the review"],
    ["lc=import&imp=unavailable", "Import: the review, a model this gateway doesn't offer"],
    ["lc=import&imp=version", "Import: an unknown format version"],
    ["lc=import&imp=size", "Import: a file too large"],
    ["lc=import&imp=type", "Import: a field of the wrong type"],
    ["lc=import&imp=field", "Import: a field the format doesn't define"],
    ["lc=import&imp=account", "Import: a model that names an account"],
    ["lc=import&imp=picture", "Import: a picture that doesn't decode"],
    ["lc=import&imp=review&impresult=taken", "Import: the name taken (Add Bot)"],
    ["lc=import&imp=review&impresult=partial", "Import: some settings still need attention (Add Bot)"],
    ["lc=import&imp=review&access=read", "Import: the review, read-only"],
    ["lc=delete&delbot=pip&delread=loading", "Delete: reading"],
    ["lc=delete&delbot=pip&delread=failed", "Delete: the read failed"],
    ["lc=delete&delbot=pip", "Delete Pip"],
    ["lc=delete&delbot=pip&files=1", "Delete Pip, with its folders"],
    ["lc=delete&delbot=pip&shared=1&files=1", "Delete Pip, its workspace shared with Juniper"],
    ["lc=delete&delbot=pip&files=1&delresult=partial", "Delete: a path not moved (Delete Pip)"],
    ["lc=delete&delbot=pip&files=1&delresult=uncertain", "Delete: the answer lost (Delete Pip)"],
    ["lc=delete&delbot=pip&delresult=refused", "Delete: refused (Delete Pip)"],
    ["lc=delete&delbot=pip&files=1&delresult=purge", "Delete: a task-store cleanup failure (Delete Pip)"],
    ["lc=delete&delbot=pip&delresult=purge", "Delete: a task-store cleanup failure, the box clear (Delete Pip)"],
    ["lc=delete&delbot=pip&files=1&delresult=multi", "Delete: two paths not moved (Delete Pip)"],
    ["lc=delete&delbot=pip&delresult=readfail", "Delete: a read after it fails (Delete Pip)"],
    ["lc=delete&delbot=pip&delchanged=1", "Delete: what the bot has changed meanwhile (Delete Pip)"],
    ["lc=delete&delbot=pip&delreplaced=1", "Delete: the bot was replaced before Delete (Delete Pip)"],
    ["lc=delete&delbot=otto", "Delete Otto, with a channel route"],
    ["bot=otto&" + st + "&onlybot=1", "The gateway's only bot"],
  ];

  // Every state of controls.html (docs/design/controls.md, section 23), for the Controls section.
  const tab = "bot=otto&panel=open&tab=settings";
  const controlStates = [
    [`${tab}`, "A bot's settings, with Tools, Memory, Usage and Runs on"],
    [`${tab}&bview=rules`, "What Otto may do: the glance, the rules plugin running"],
    [`${tab}&bview=rules&rules=noplugin`, "Rules methods unavailable: not being enforced right now"],
    [`${tab}&bview=rules&rules=stopped`, "The rules plugin stopped"],
    [`${tab}&bview=rules&rules=old`, "The rules plugin too old"],
    [`${tab}&bview=rules&rules=unchecked`, "The rules plugin not checked yet"],
    [`${tab}&bview=rules&rules=stopped&held=1`, "Denied in Otto's settings"],
    [`${tab}&bview=rules&held=1`, "The plugin running again, the hold still in place"],
    [`${tab}&bview=rules&rules=stopped&read=none`, "This device never read the plugin's rules"],
    [`${tab}&bview=rules&rules=stopped&width=phone`, "The phone: the plugin stopped"],
    [`${tab}&bview=rules&msg=gateway`, "The gateway's pairs leave Otto no bot to message"],
    [`${tab}&bview=rules&machine=gatewayhost&cmdpolicy=allowlist`, "Creating a bot: a policy that isn't Ask"],
    [`${tab}&bview=rules&machine=gatewayhost`, "Commands on the gateway's machine: plugin rules are advice"],
    [`${tab}&bview=rules&rules=loading`, "Loading"],
    [`${tab}&bview=rules&rules=error`, "Couldn't load"],
    [`${tab}&bview=rules&rules=fresh`, "Before the bot's first task"],
    [`${tab}&bview=rules&rules=stale`, "The listing is old"],
    [`${tab}&bview=rules&override=1`, "The gateway's settings override the bot's"],
    [`${tab}&bview=rules&access=read`, "Read-only"],
    [`bot=pip&panel=open&tab=settings&bview=rules&newbot=step2`, "A new bot whose restrictive write failed"],
    [`bot=pip&panel=open&tab=settings&newbot=step3`, "A new bot whose defaults write failed"],
    [`${tab}&bview=rule&line=files`, "One line: Change files, Limited"],
    [`${tab}&bview=rule&line=exec`, "One line: Run commands, with its four facts"],
    [`${tab}&bview=rule&line=exec&rules=stopped`, "Run commands while the rules plugin is stopped"],
    [`${tab}&bview=rule&line=exec&rules=stopped&held=1`, "Run commands in the hold"],
    [`${tab}&bview=rule&line=exec&override=1`, "Run commands when media-box's file asks every time"],
    [`${tab}&bview=rule&line=exec&cmdpolicy=allowlist`, "A command policy set outside Clawtrate: only listed commands"],
    [`${tab}&bview=rule&line=exec&cmdpolicy=legacy`, "A legacy command policy"],
    ["bot=otto&task=o1&rules=stopped&held=1", "Clawtrate's hold, as a line in the task"],
    [`${tab}&bview=rule&line=browser`, "One line, set on the gateway"],
    [`${tab}&bview=rule&line=web&override=1`, "A bot's allow overridden by the gateway"],
    [`${tab}&bview=rule&line=files&waiting=1`, "Saving while a request waits"],
    [`${tab}&bview=rule&line=files&write=refused`, "A save refused"],
    [`${tab}&bview=rule&line=files&write=conflict`, "A save crossed by another change"],
    [`${tab}&bview=rule&line=files&write=timeout`, "A save with no answer"],
    [`${tab}&bview=rule&line=files&form=open`, "The rule form"],
    [`${tab}&bview=rule&line=files&form=open&pattern=long`, "A pattern of 1,001 characters"],
    [`${tab}&bview=rule&line=files&form=open&limit=allow`, "20 allow rules already"],
    [`${tab}&bview=rule&line=files&form=open&limit=ask`, "20 ask rules already"],
    [`${tab}&bview=rule&line=files&form=open&limit=never`, "Near 50 never rules"],
    [`${tab}&bview=rule&line=files&form=fromcard`, "The rule form from an expired request: an Ask rule still applies"],
    [`${tab}&bview=rule&line=files&form=fromcard&asker=fallback`, "The rule form from an expired request: only the catch-all asked"],
    [`${tab}&bview=rule&line=files&form=fromcard&access=write`, "An expired request's rule, below admin"],
    [`bot=pip&panel=open&tab=settings&bview=rule&line=message`, "A line for a bot with no routines"],
    [`${tab}&bview=rule&line=files&rules=stopped`, "One line while the rules plugin is stopped"],
    [`${tab}&bview=messaging`, "Messaging other bots"],
    [`${tab}&bview=messaging&msg=some`, "Only these bots"],
    [`${tab}&bview=messaging&msg=none`, "No bot"],
    [`${tab}&bview=messaging&msg=gateway`, "The gateway's pair setting decides"],
    [`${tab}&bview=messaging&rules=noplugin`, "Messaging without the rules plugin"],
    ["open=settings&section=permissions", "Settings, Permissions: rules"],
    ["open=settings&section=permissions&rules=stopped", "Rules while the plugin is stopped"],
    ["open=settings&section=permissions&access=write", "Rules below admin"],
    ["open=settings&section=permissions&part=saved", "Saved approvals"],
    ["open=settings&section=permissions&part=saved&saved=revoked", "A routine's grant revoked"],
    ["open=settings&section=permissions&part=saved&saved=empty", "No saved approvals"],
    ["open=settings&section=permissions&part=saved&saved=error", "Saved approvals couldn't load"],
    ["open=settings&section=permissions&part=saved&access=read", "Saved approvals, read-only"],
    ["open=settings&section=permissions&part=saved&access=write", "Saved approvals below admin"],
    ["open=settings&section=permissions&part=activity", "Activity"],
    ["open=settings&section=permissions&part=activity&audit=loading", "Activity loading"],
    ["open=settings&section=permissions&part=activity&audit=partial", "Activity with expired records"],
    ["open=settings&section=permissions&part=activity&audit=empty", "No activity"],
    ["open=settings&section=permissions&part=activity&audit=off", "The gateway records no activity"],
    ["open=settings&section=permissions&part=activity&audit=error", "Activity couldn't load"],
    ["open=settings&section=permissions&part=activity&access=read", "Activity, read-only"],
    [`${tab}&bview=memory`, "What Otto remembers: stored, loads, searchable"],
    [`${tab}&bview=memory&mem=over`, "Root memory past its budget"],
    [`${tab}&bview=memory&mem=empty`, "Nothing stored yet"],
    [`${tab}&bview=memory&mem=loading`, "Memory loading"],
    [`${tab}&bview=memory&mem=error`, "Memory couldn't load"],
    [`${tab}&bview=memory&mem=noplugin`, "Memory without the memory plugin"],
    [`${tab}&bview=memory&mem=nosearch`, "No memory search on the gateway"],
    [`${tab}&bview=memory&mem=searchoff`, "Search off for this bot"],
    [`${tab}&bview=memory&mem=unsearchable`, "A note not yet confirmed searchable"],
    [`${tab}&bview=memory&mem=add`, "Adding to memory"],
    [`${tab}&bview=memory&mem=import`, "Reviewing an import"],
    [`${tab}&bview=memory&access=read`, "Memory, read-only"],
    [`${tab}&bview=memitem&item=m1`, "A root memory item"],
    [`${tab}&bview=memitem&item=n1`, "A note"],
    [`${tab}&bview=memitem&item=n1&mem=noplugin`, "A note without the memory plugin"],
    [`${tab}&bview=memitem&item=m1&mem=edit`, "Editing an item"],
    [`${tab}&bview=memitem&item=m1&mem=conflict`, "An edit crossed by another change"],
    ["open=settings&section=memory", "Settings, Memory: shared memory and who searches it"],
    ["open=settings&section=memory&shared=none", "No shared memory"],
    ["open=settings&section=memory&shared=noplugin", "Shared memory without the plugin"],
    [`${tab}&bview=machine`, "Where Otto runs: three places"],
    [`${tab}&bview=machine&machine=shared`, "A workspace shared with another bot"],
    [`${tab}&bview=machine&machine=offline`, "Its command machine not connected"],
    [`${tab}&bview=machine&machine=ownbrowser`, "A browser of its own"],
    [`bot=pip&panel=open&tab=settings&bview=machine`, "Pip, on the gateway's machine"],
    [`${tab}&bview=machine&access=read`, "Where Otto runs, read-only"],
    ["open=settings&section=machines", "Settings, Machines: approvals files"],
    ["open=settings&section=machines&access=write", "Machines below admin"],
    ["open=settings&section=machines&devices=noscope", "Paired devices below device access"],
    [`${tab}&bview=usage`, "Usage, with its budget first"],
    [`${tab}&bview=usage&usage=loading`, "Usage loading"],
    [`${tab}&bview=usage&usage=error`, "Usage couldn't load"],
    [`${tab}&bview=usage&usage=computing`, "Usage still being counted"],
    [`${tab}&bview=usage&usage=nocost`, "No price configured"],
    [`${tab}&bview=usage&usage=partial`, "A partial cost"],
    [`${tab}&bview=usage&budget=none`, "No budget"],
    [`${tab}&bview=usage&budget=warn`, "A warning budget at 82 percent"],
    [`${tab}&bview=usage&budget=reached`, "A warning budget used up"],
    [`${tab}&bview=usage&budget=daily`, "A Daily budget, counted today"],
    [`${tab}&bview=usage&budget=invalid`, "A budget form with an invalid number"],
    ["open=settings&section=usage", "Settings, Usage"],
    ["open=settings&section=usage&usage=nolimits", "No provider limits reported"],
    ["bot=otto&task=o3&budget=warn", "The 80 percent line in a task"],
    ["bot=otto&budget=reached", "The composer held back by a warning budget"],
    ["bot=otto&plimit=near", "A provider's limit near"],
    ["bot=otto&plimit=reached", "A provider's limit reached"],
    ["bot=otto&task=o1&saveline=1", "Saved to memory, in a task"],
    ["bot=otto&task=o1&ask=full", "A rules-plugin card at the allow limit, answered live"],
    ["bot=pip&task=p1&cmd=create", "Example: a command missing the machine allowlist"],
    [`${tab}&width=phone`, "The phone: a bot's settings"],
    [`${tab}&bview=rules&width=phone`, "The phone: what Otto may do"],
    ["open=settings&section=permissions&part=activity&width=phone", "The phone: Activity"],
  ];

  const sections = [
    {
      id: "access",
      title: "What the connection may do",
      note: "A read-only connection follows the work and is not sent approvals or questions. The access bar stands in the composer's place and asks once for the tier that can send, stop and answer.",
      specimens: [
        { name: "Read-only", still: true, html: CT.accessBar({ bot: "otto", state: "read" }) },
        { name: "Asking the gateway", still: true, html: CT.accessBar({ bot: "otto", state: "asking" }) },
        {
          name: "Requested: waiting for the gateway's owner",
          note: "The command and the request id come from the host. Both can be copied.",
          still: true,
          html: CT.accessBar({ bot: "otto", state: "requested" }),
        },
        { name: "Denied", still: true, html: CT.accessBar({ bot: "otto", state: "denied" }) },
        { name: "Expired", still: true, html: CT.accessBar({ bot: "otto", state: "expired" }) },
        { name: "Couldn't ask", still: true, html: CT.accessBar({ bot: "otto", state: "failed", reason: "The gateway did not answer." }) },
        { name: "A gateway with no way to step up", still: true, html: CT.accessBar({ bot: "otto", state: "none" }) },
        {
          name: "Access granted",
          note: "The composer takes the bar's place and the strip says so for four seconds.",
          still: true,
          html: `<span class="spec-static">${CT.banner("granted")}</span><div style="height:12px"></div>${CT.composer({ bot: "otto", run: "running" })}`,
        },
        {
          name: "A wait this device cannot see",
          note: "Shown only when the gateway reports the wait to a read-only connection.",
          still: true,
          html:
            `<div class="turn-note">${glyph("blocked")}<div><p><b>Otto is waiting for an approval or an answer.</b> This device can't see it on a read-only connection.</p>` +
            `<p>${CT.linkButton("Request access")}</p></div></div>` +
            statusLine({ bot: "otto", state: "thinking", badge: "blocked", phrase: "Waiting for an answer", elapsed: "0:48" }),
        },
        {
          name: "A request this device can read but not answer",
          note: "The full request and Raw still open.",
          html: approval({ ...S.approval, readonly: true }),
        },
      ],
    },
    {
      id: "presence",
      title: "The state avatar",
      note: "The face, the ring and the badge say the same thing three ways. Characters move their eyes and body; a bot with its own picture relies on the ring and the badge.",
      specimens: [
        {
          name: "Every state",
          html: labelled(eight.map((s, i) => [presence(["otto", "juniper", "marlow", "pip"][i % 4], s, { i }), s === "waiting" ? "waiting for you" : s])),
        },
        {
          name: "A bot with its own picture, every state",
          note: "No face to move: thinking is a ring that breathes, working is the orbit, and the badge carries the rest. Done has neither; the row's unread dot tells it from idle.",
          html: labelled(eight.map((s) => [presence("otto", s, { image: true }), s === "waiting" ? "waiting for you" : s])),
        },
        {
          name: "Waiting while the machine is unreachable",
          note: "Waiting wins, and takes the warning badge from blocked.",
          html: labelled([[presence("otto", "waiting", { badge: "blocked" }), "waiting, machine offline"]]),
        },
        {
          name: "Done with failures",
          note: "The done face with the failed badge.",
          html: labelled([[presence("pip", "done", { badge: "failed" }), "done with failures"]]),
        },
        {
          name: "Sizes",
          html: labelled([
            [sized(64, presence("pip", "working")), "64 Work pane"],
            [sized(56, presence("pip", "working")), "56 pinned"],
            [sized(40, presence("pip", "working")), "40 rail"],
            [sized(28, presence("pip", "working")), "28 status line"],
            [sized(22, presence("pip", "working", { size: "sm" })), "22 title pill"],
          ]),
        },
        {
          name: "State marks",
          note: "12 px. Used in task rows, state words and as the avatar's badge. The hollow ring always has a word beside it.",
          html: labelled(["working", "sending", "waiting", "blocked", "failed", "stopped", "done", "check", "unread", "queued"].map((s) => [glyph(s), s === "queued" ? "queued, unknown" : s])),
        },
      ],
    },
    {
      id: "status",
      title: "The status line",
      note: "The last thing in a running turn: the avatar and one phrase. It stays put while everything else arrives above it, and leaves only when the run ends.",
      specimens: [
        { name: "The moment you send", note: "The avatar and the word Thinking appear together. The phrase is never empty.", html: statusLine({ bot: "otto", state: "thinking", phrase: "Thinking", elapsed: "0:00", steps: false }) },
        { name: "A step is running", html: statusLine({ bot: "otto", state: "working", phrase: "Reading backup-2026-11-15.log", elapsed: "0:07" }) },
        {
          name: "A long phrase truncates",
          note: "The full phrase is the tooltip on desktop.",
          html: `<div style="max-width:340px">${statusLine({ bot: "otto", state: "working", phrase: "Searching for the weekly backup profile across every archived log", elapsed: "0:31" })}</div>`,
        },
        { name: "The gateway is reviewing a command", html: statusLine({ bot: "otto", state: "working", phrase: "Reviewing a command", elapsed: "0:52" }) },
        { name: "Waiting for another bot", html: statusLine({ bot: "otto", state: "working", phrase: "Waiting for Marlow", elapsed: "0:40" }) },
        { name: "Setting up", note: "From the gateway's own status phases.", html: statusLine({ bot: "otto", state: "thinking", phrase: "Setting up the workspace", elapsed: "0:03" }) },
        { name: "Gathering context", html: statusLine({ bot: "otto", state: "thinking", phrase: "Gathering context", elapsed: "0:05" }) },
        { name: "Waiting for you", html: statusLine({ bot: "otto", state: "waiting", phrase: "Waiting for you", elapsed: "0:48" }) },
        { name: "Stopping", html: statusLine({ bot: "otto", state: "stopping", phrase: "Stopping…" }) },
        { name: "Blocked", html: statusLine({ bot: "otto", state: "blocked", phrase: "Can't reach media-box" }) },
        { name: "Rate limited", html: statusLine({ bot: "otto", state: "thinking", phrase: "Rate limited. Retrying, attempt 2 of 5", elapsed: "1:12" }) },
        {
          name: "Connection lost mid-run",
          note: "Nothing animates while the client cannot see the run, and the elapsed time is hidden.",
          lost: true,
          html: statusLine({ bot: "otto", state: "blocked", phrase: "Reconnecting. Last seen reading the backup log" }),
        },
      ],
    },
    {
      id: "streaming",
      title: "Streaming text and message captions",
      specimens: [
        {
          name: "A reply streaming",
          html: CT.msg({ md: true, streaming: true, html: "<p>Found it. The transcode cache was swept into the backup: 182 GB that is" }),
        },
        {
          name: "Cut off by a stop or a failure",
          html:
            CT.msg({ md: true, html: "<p>Found it. The transcode cache was swept into the backup: 182 GB that is</p>" }) +
            CT.caption("<span>Incomplete</span>"),
        },
        { name: "Steer", html: CT.msg({ role: "user", html: "Skip the write-up, just fix it." }) + CT.caption("<span>Steer</span>") },
        {
          name: "A steer the gateway turned into a restart",
          note: "Only when the gateway reports the restart.",
          html: CT.msg({ role: "user", html: "Skip the write-up, just fix it." }) + CT.caption("<span>Steer · restarted the turn</span>"),
        },
        {
          name: "Failed to send",
          still: true,
          html:
            CT.msg({ role: "user", html: "Is the disk still at 61%?" }) +
            CT.caption(`<span>Failed to send</span>${CT.linkButton("Resend")}${CT.linkButton("Delete", { tone: "muted" })}`, "danger"),
        },
        {
          name: "Written while offline",
          note: "Not sent yet, so not yet in your colour. The text keeps full contrast.",
          html: CT.msg({ role: "user", pending: "held", html: "Is the disk still at 61%?" }) + CT.caption("<span>Sends when reconnected</span>"),
        },
      ],
    },
    {
      id: "actions",
      title: "What a bot did: action cards",
      note: "Every action is one line in plain words: a verb, the kind's icon and what it acted on, one short fact, the state. Nothing needs opening to follow the run. Cards with nothing between them form one column. Open any card for what it acted on and what came back; Raw is its second tab.",
      specimens: [
        {
          name: "Every kind, done",
          note: "Twenty-six kinds, in the order of the list in section 8, each with a result that its adapter reads as done. The two Messaged cards are members of the same family. The question shows as a card only on a read-only connection; with access it is the question card.",
          html: col(
            A(C.read), A(C.list), A(C.edit), A(C.memory), A(C.recall), A(C.command), A(C.terminalList), A(C.web), A(C.xsearch), A(C.page), A(C.browserClick), A(C.computerClick), A(C.phoneObserve), A(C.screen), A(C.routine),
            messaged({ target: "marlow", first, state: "replied", body: S.marlowBody("replied") }),
            A(C.tasks), A(C.helper), A(C.question, { readOnly: true }), A(C.plan), A(C.imageMade), A(C.pdf), A(C.channelSent), A(C.server),
            T3(C.t3Launch, [C.t3Launch]),
            A(C.general),
          ),
        },
        {
          name: "Every kind, while it runs",
          note: "An action that stays on the gateway: the working mark and the present tense. One whose effect leaves the gateway (a helper, media, a channel, a tool server, T3 Code): its noun and Call started, because a start proves nothing. The status line says the same words at the same moment.",
          html: col(
            ...[C.read, C.list, C.edit, C.memory, C.recall, C.command, C.terminalList, C.web, C.xsearch, C.page, C.browserClick, C.computerClick, C.phoneTap, C.screen, C.routine].map((c, i) => A(c, { status: "running", elapsed: i % 3 ? "" : "0:03" })),
            messaged({ target: "marlow", first, state: "call-started", body: S.marlowBody("call-started") }),
            ...[C.tasks, C.helper, C.plan, C.image, C.pdf, C.channel, C.server].map((c) => A(c, { status: "running" })),
            T3(C.t3Launch, [{ ...C.t3Launch, status: "running" }]),
            A(C.general, { status: "running" }),
          ),
        },
        {
          name: "Every kind, when it failed",
          note: "\"Couldn't\" and the failed mark. A failed card stays where it is, in view.",
          html: col(
            ...[C.read, C.list, C.edit, C.memory, C.recall, C.command, C.terminalList, C.web, C.xsearch, C.page, C.browserClick, C.computerClick, C.phoneTap, C.screen, C.routine].map((c) => A(c, { status: "failed", isError: true, text: "The tool reported an error." })),
            messaged({ target: "marlow", first, state: "failed", body: S.marlowBody("failed") }),
            ...[C.tasks, C.helper, C.plan, C.imageMade, C.pdf, C.channel, C.server].map((c) => A(c, { status: "failed", isError: true, text: "The tool reported an error." })),
            T3(C.t3Launch, [{ ...C.t3Launch, status: "failed", isError: true, details: { mcpServer: "t3code", mcpTool: "t3_thread_launch", structuredContent: { code: "provider_unavailable", message: "The project's provider is not signed in." } } }]),
            A(C.general, { status: "failed", isError: true, text: "The tool reported an error." }),
          ),
        },
        {
          name: "A result is not always completed work",
          note: "Each kind reads its result through an adapter, and every payload that carries its own status or code is read from it. Admitted, queued, not confirmed, suppressed, unavailable, refused, not found or unchanged work says so on its line, and never reads as done. A phone act that needs confirming did nothing; one that ran shows the device's own code (here a sample), because the gateway does not fix a done code.",
          html: col(
            A(C.image),
            A(C.imageMade),
            A(C.helper),
            A(C.routineRun),
            A(C.channel),
            A(C.channelSent),
            A(C.channelSuppressed),
            A(C.message),
            A(C.computerUnconfirmed),
            A(C.recallPartial),
            A(C.recallUnavailable),
            A(C.xsearchUnavailable),
            A(C.phoneConfirm),
            A(C.phoneTap),
            A(C.phoneStale),
            A(C.recallGetError),
            A(C.recallGetNone),
            A(C.unchanged),
            A(C.pending),
            A(C.helperRefused),
            A(C.routineRemoveNone),
            A(C.turn),
          ),
        },
        {
          name: "One card in every state",
          note: "Each state is one the gateway can establish. A start is never proof that a call was made; there is no sending state anywhere.",
          html: col(
            A(C.mv, { status: "running", elapsed: "0:02" }),
            A(C.mv, { status: "review" }),
            A(C.mv, { status: "waiting" }),
            A(C.command),
            A(C.exit1),
            A(C.mv, { status: "failed", isError: true, text: "mv: cannot move: Permission denied" }),
            A(C.timeout),
            A(C.mv, { status: "denied", isError: true, text: "Exec denied (gateway id=a1, user-denied): mv" }),
            A(C.rm),
            A(C.rm, { blockedBy: "review" }),
            A(C.mv, { status: "stopped" }),
            A(C.channel, { status: "unknown" }),
            A(C.channel, { status: "running" }),
          ),
        },
        {
          name: "Real operations, with their own words",
          note: "A shared terminal is not a command; the screen tool changes the Control UI; a phone has its own actions; documents and images are counted; a goal checked is not a plan updated.",
          html: col(A(C.terminalList), A(C.terminalInput), A(C.screen), A(C.phoneObserve), A(C.phoneConfirm), A(C.pdf), A(C.images), A(C.patch), A(C.goalGet), A(C.goalUpdate), A(C.routineRemove), A(C.nextCheck), A(C.voice)),
        },
        {
          name: "Last seen, while the connection is lost",
          note: "Nothing that stands for the gateway's work moves.",
          lost: true,
          html: col(A(C.command, { status: "running", lastSeen: true }), CT.foldCard([C.read, { ...C.read2, status: "running", lastSeen: true }])),
        },
        {
          name: "Text beside a tool call",
          note: "It arrives as an item of kind preamble, not on the reply stream. It is the bot narrating, so it is a bubble, before the card of its call. It ends the column.",
          html: CT.msg({ html: "Reading last night's log first." }) + A(C.read) + A(C.list) + CT.msg({ html: "Now last week's, to compare." }) + A(C.read2),
        },
        {
          name: "Opened: the readable view",
          note: "Level 1. What it acted on and what came back. Long output shows eight whole lines, then the real count.",
          html: A(C.read, {}, { open: true }),
        },
        {
          name: "Opened: Raw, one step further",
          note: "Level 2. The exact tool name, arguments, result, timing and identifiers, as the gateway sent them.",
          html: A(C.read, {}, { open: true, view: "raw" }),
        },
        {
          name: "Opened: the reasoning that led to it",
          note: "Reasoning has no card. It sits at the top of the card it led to, folded; opened, its text (level 2).",
          html: A({ ...C.read2, thought: { ...S.reasonings.beforeRead2, open: true } }, {}, { open: true }),
        },
        {
          name: "Opened while it runs",
          note: "The output so far, as the gateway streams it.",
          html: A(C.command, { status: "running", elapsed: "0:03", partial: "182G\t/srv/media/transcode-cache\n640G\t/srv/media/films\n" }, { open: true }),
        },
        {
          name: "Kinds opened",
          note: "Each kind's readable view: a search's results as links, a plan as a checklist with completed, in progress and pending steps, the media a result carries, admitted media, a browser action and its target, a routine with its time zone, an unavailable search and its reason, a queued message.",
          html: col(A(C.web, {}, { open: true }), A(C.planUpdate, {}, { open: true }), A(C.imageMade, {}, { open: true }), A(C.image, {}, { open: true }), A(C.browserType, {}, { open: true }), A(C.routine, {}, { open: true }), A(C.recallUnavailable, {}, { open: true }), A(C.channel, {}, { open: true }), A(C.computerUnconfirmed, {}, { open: true }), A(C.phoneConfirm, {}, { open: true })),
        },
        {
          name: "On a read-only connection",
          note: "The same cards, as full as anywhere: a client that subscribes to the session receives the tool events with their arguments and results. Only approvals and questions are not sent to it.",
          html:
            A(C.mv, { status: "waiting", readOnly: true }) +
            CT.msg({ html: "Before I plan the day trip, one question." }) +
            A(C.question, { status: "running", readOnly: true }) +
            `<div class="turn-note">${glyph("blocked")}<div><p>This device can't answer it on a read-only connection.</p><p>${CT.linkButton("Request access")}</p></div></div>`,
        },
      ],
    },
    {
      id: "folds",
      title: "Actions of one kind in a row",
      note: "Two or more actions of one kind, with nothing shown between them, are one card with a count. Reasoning between them does not break it; a bubble, a request card or another kind does. Files are counted once.",
      specimens: [
        { name: "Done", html: col(F(reads(6)), F([C.web, C.web2, { ...C.web, id: "call_7a90", args: { query: "heat pump noise at night" } }]), F([C.edit, C.create, C.patch]), F([C.browserOpen, C.browserClick, C.browserType, C.browserShot]), F([C.recall, { ...C.recall, id: "call_7a92", args: { query: "gas safety" } }]), F([C.plan, C.planUpdate, { ...C.planUpdate, id: "call_7a91" }]), F([C.t3Projects, C.t3Threads])) },
        { name: "Counting files and actions", note: "Files are counted once, and the actions too when there are more of them.", html: col(F([C.read2, { ...C.read2, id: "call_7b11" }, { ...C.read, id: "call_7b12" }]), F([C.edit, { ...C.edit, id: "call_7b13" }, C.create])) },
        { name: "One action running", note: "The count includes it; the detail says what it is doing.", html: F([...reads(2), { ...C.read2, id: "call_7a95", status: "running", elapsed: "0:02" }]) },
        { name: "One action waiting for you", html: F([C.command, C.exit1, { ...C.mv, status: "waiting" }]) },
        {
          name: "A failure inside a fold",
          note: "In view without opening anything: the line names the first problem and counts them. It is never drawn as a success.",
          html: F([C.read, C.readFail, C.read2]),
        },
        {
          name: "Mixed states: an earlier failure and a later approval",
          note: "Two places, so neither hides the other: the detail names the failure, the right side says what is happening now.",
          html: col(F([C.command, { ...C.mv, id: "call_7b20", status: "failed", isError: true, text: "mv: Permission denied" }, { ...C.mv, id: "call_7b21", status: "waiting" }]), F([C.read, C.readFail, { ...C.read2, id: "call_7b22", status: "running", elapsed: "0:04" }])),
        },
        {
          name: "Outcomes short of Done in a fold",
          note: "The plural is never more complete than its least-established member. Started alone has its own plural; Partial keeps the past verb; any other mix is neutral. Every outcome short of Done is counted, and there is no duration.",
          html: col(F([C.image, { ...C.image, id: "call_7b30" }]), F([C.recallPartial, { ...C.recallPartial, id: "call_7b31", args: { query: "drains" } }]), F([C.image, C.imageMade]), F([C.computerClick, C.computerUnconfirmed])),
        },
        {
          name: "Each operation folds under its own key and plural",
          note: "Listing image models is not making images: its own key, its own plural.",
          html: col(F([C.imageList, { ...C.imageList, id: "call_7b32" }]), A(C.imageMade)),
        },
        {
          name: "Counting distinct documents and notes",
          note: "Two calls over the same three PDFs are three PDFs, twice. Two writes of the same note are one note, twice.",
          html: col(F([C.pdf, { ...C.pdf, id: "call_7b33" }]), F([{ ...C.memory, args: { path: "MEMORY.md", content: "Boiler: October." } }, { ...C.memory, id: "call_7b34", args: { path: "MEMORY.md", content: "Boiler: October, not winter." } }])),
        },
        {
          name: "Stopped, unavailable, and a missing time",
          note: "Every problem is named by kind. A duration is never a partial sum.",
          html: col(F([{ ...C.read, status: "stopped" }, { ...C.read2, status: "stopped" }]), F([C.recall, { ...C.recallUnavailable, id: "call_7b23" }]), F([C.read2, { ...C.read, id: "call_7b24", took: undefined }])),
        },
        { name: "Opened", note: "Level 1: one row per action, in the singular. Each row opens to its own readable view and Raw.", html: F([C.read, C.readFail, C.read2], { open: true }) },
        { name: "Opened, with one row opened on Raw", html: F([C.read, C.readFail, C.read2], { open: true, rows: { [C.read2.id]: { open: true, view: "raw" } } }) },
        {
          name: "Becoming a fold",
          note: "The second read turns the card into a fold in place. Nothing moves; an open card opens the fold with its first row open in the same view.",
          still: true,
          html: A(C.read, {}, { open: true }) + `<p class="spec-then">The second read starts:</p>` + F([C.read, { ...C.read2, status: "running" }], { open: true, rows: { [C.read.id]: { open: true } } }),
        },
        {
          name: "What breaks a fold",
          note: "A bubble between two reads: two cards.",
          html: A(C.read) + CT.msg({ html: "Now last week's, to compare." }) + A(C.read2),
        },
      ],
    },
    {
      id: "general",
      title: "The general card and tool servers",
      note: "A tool with no kind of its own gets words from its name: split at underscores, hyphens, dots and capitals, in lower case. The detail is the first value among the gateway's own detail keys. A tool-server call is identified only by its result, or by the gateway's own name mapping.",
      specimens: [
        {
          name: "Opaque names, in plain words",
          note: "skills_search, getWeatherNow, github_publish.",
          html: col(A(C.general), A(C.general2), A(C.general3)),
        },
        { name: "Opened", note: "The arguments as rows, the result, and the gateway's own title for the call.", html: A(C.general, {}, { open: true }) },
        {
          name: "A tool-server call, before and after its result",
          note: "Until the result names its server and tool, the call is the general card with words from its effective name. Then it says which server it used.",
          still: true,
          html: A({ ...C.server, mcp: undefined }, { status: "running" }) + `<p class="spec-then">The result names the server and the tool:</p>` + A(C.server),
        },
      ],
    },
    {
      id: "detail",
      title: "How a command ended, and what an opened card shows",
      specimens: [
        {
          name: "A command that exited with a non-zero code",
          note: "Not a failure. The code is shown plainly beside the command.",
          html: A(C.exit1, {}, { open: true }),
        },
        { name: "A command that hit its own time limit", note: "A failed card of its own kind. The run goes on.", html: A(C.timeout, {}, { open: true }) },
        {
          name: "A command cut off by the run's time limit",
          html: A({ ...C.timeout, timedOut: false, cutOff: true, failWord: "Aborted", body: S.timeoutBody("run") }, {}, { open: true }),
        },
        {
          name: "Output the gateway cut",
          note: "The line gives the size actually received when it is plain text, and says only that it was cut when the result is structured. Copy copies what was received and says so.",
          html: col(A({ ...C.command, args: { command: "journalctl -u transcoded --since yesterday", host: "media-box" }, body: S.truncatedBody() }, {}, { open: true }), A({ ...C.command, id: "call_7a92", args: { command: "journalctl -u transcoded --since yesterday", host: "media-box" }, body: S.truncatedBody("raw") }, {}, { open: true })),
        },
        {
          name: "Detail loading, and detail that could not load",
          html: col(A({ ...C.list, body: CT.stepBody({ state: "loading" }) }, {}, { open: true }), A({ ...C.read, body: CT.stepBody({ state: "failed" }) }, {}, { open: true })),
        },
        {
          name: "Raw that is not available",
          note: "One sentence says why. Nothing is invented to fill it.",
          html: col(
            A({ ...C.list, body: CT.stepBody({ view: "raw", readable: CT.note("5 entries."), raw: { state: "unavailable", reason: "This event is older than the history the gateway returned." } }) }, {}, { open: true }),
            A({ ...C.read2, body: CT.stepBody({ view: "raw", readable: CT.note("12 lines."), raw: { state: "failed" } }) }, {}, { open: true }),
          ),
        },
        {
          name: "Rebuilt from history without the result's details",
          note: "History keeps details for some tools only. The line shows what the text gives and leaves out what only details held.",
          html: col(A({ ...C.web, details: undefined }), A({ ...C.read, text: "" })),
        },
        { name: "The automatic review: in progress", html: A({ ...C.mv, status: "review", body: S.commandBody("review") }, {}, { open: true }) },
        { name: "The automatic review: approved", note: "Quiet. The line shows nothing extra; the opened card has one line.", html: A({ ...C.command, args: { command: "df -h /srv/media", host: "media-box" }, body: S.reviewedBody() }, {}, { open: true }) },
      ],
    },
    {
      id: "reasoning",
      title: "Reasoning and the run line",
      note: "Reasoning has no card: it belongs to what it led to. Its text is never on screen until opened. The run line follows a run that had actions; opened, it is the run's record.",
      specimens: [
        {
          name: "Reasoning that led to the reply",
          note: "One line over the reply, folded.",
          html: CT.thought({ place: "reply", ...S.reasonings.beforeReply, raw: CT.thoughtRaw(S.reasonings.beforeReply.text) }) + CT.msg({ md: true, html: "<p>Usually yes, if the house holds its heat and the unit is sized for your coldest week.</p>" }),
        },
        {
          name: "Opened",
          html: CT.thought({ place: "reply", open: true, ...S.reasonings.beforeReply, raw: CT.thoughtRaw(S.reasonings.beforeReply.text) }) + CT.msg({ md: true, html: "<p>Usually yes, if the house holds its heat and the unit is sized for your coldest week.</p>" }),
        },
        {
          name: "A reply that was reasoning only",
          note: "The gateway asks the model again twice, then ends the run as an error. The line stands above the error card.",
          html:
            CT.thought({ place: "reply", time: "12s", text: "I should check the insulation figures before answering." }) +
            CT.turnError({ title: "Otto couldn't finish this turn", reason: "The model wrote only reasoning, three times, and no reply. Nothing ran.", requestId: "req_51d0aa21", raw: S.turnErrorRaw }) +
            CT.runLine({ label: "Failed after 12s", actions: 0, model: "scripted/dev-1", effort: "low", run: "run_51d0aa21" }).replace(/<span aria-hidden="true">·<\/span><span class="run-count">0 actions<\/span>/, ""),
        },
        {
          name: "The run line, every ending",
          html: col(
            CT.runLine({ label: "Worked for 1m 12s", actions: 14, model: "scripted/dev-1", effort: "low", run: "run_7f3a91c2" }),
            CT.runLine({ label: "Worked for 1m 12s", actions: 14, failed: 1, model: "scripted/dev-1", effort: "low", run: "run_7f3a91c2" }),
            CT.runLine({ label: "Stopped after 40s", actions: 4, model: "scripted/dev-1", effort: "low", run: "run_7f3a91c2" }),
            CT.runLine({ label: "Failed after 12s", actions: 2, model: "scripted/dev-1", effort: "", run: "run_7f3a91c2" }),
          ),
        },
        { name: "The run line, opened", note: "The model, the effort requested, and the run id.", html: CT.runLine({ label: "Worked for 1m 12s", actions: 14, model: "scripted/dev-1", effort: "low", run: "run_7f3a91c2", open: true }) },
      ],
    },
    {
      id: "runs",
      title: "Three runs that test the cards",
      note: "What a person sees with nothing opened. Each also plays inside the shell: conversation.html?scene=short, ?scene=long, ?scene=thought.",
      specimens: [
        { name: CT.scenes.short.title, html: CT.sceneHtml("short") },
        { name: CT.scenes.long.title, note: "Forty actions read as sixteen lines in three columns, between the bot's own bubbles. The one failure is named on its line.", html: CT.sceneHtml("long") },
        { name: CT.scenes.thought.title, note: "No card and no run line: a folded Thought line over the reply.", html: CT.sceneHtml("thought") },
      ],
    },
    {
      id: "messaged",
      title: "The Messaged card",
      note: "One card per message sent to another bot. Each state is something an event established. Open any of them: what was sent, what the card can say about the other side, and Raw.",
      specimens: [
        {
          name: "Folded, every state",
          html: Object.keys({ "call-started": 1, approval: 1, sent: 1, working: 1, "recipient-waiting": 1, "no-reply": 1, replied: 1, "recipient-stopped": 1, "recipient-failed": 1, failed: 1, blocked: 1, "not-sent": 1, unknown: 1 })
            .map((state) => messaged({ target: "marlow", first, state, body: S.marlowBody(state) }))
            .join(""),
        },
        { name: "Open, call started", note: "The start is the first thing the gateway reports, and it is never proof the call was made.", html: messaged({ target: "marlow", first, state: "call-started", open: true, body: S.marlowBody("call-started") }) },
        { name: "Open, waiting for approval", html: messaged({ target: "marlow", first, state: "approval", open: true, body: S.marlowBody("approval") }) },
        { name: "Open, sent", html: messaged({ target: "marlow", first, state: "sent", open: true, body: S.marlowBody("sent") }) },
        { name: "Open, the recipient is working", note: "One row for the recipient: its state avatar, its name and its current phrase.", html: messaged({ target: "marlow", first, state: "working", open: true, body: S.marlowBody("working") }) },
        { name: "Open, the recipient is waiting", html: messaged({ target: "marlow", first, state: "recipient-waiting", open: true, body: S.marlowBody("recipient-waiting") }) },
        { name: "Open, no reply yet", html: messaged({ target: "marlow", first, state: "no-reply", open: true, body: S.marlowBody("no-reply") }) },
        {
          name: "Open, no reply after a timeout that says the message was sent",
          note: "Not a failure: a reply that names this message can still arrive.",
          html: messaged({ target: "marlow", first, state: "no-reply", open: true, body: S.marlowBody("no-reply", { timeout: true }) }),
        },
        { name: "Open, replied", note: "Show full exchange opens every message between the two bots in this task, in place.", html: messaged({ target: "marlow", first, state: "replied", open: true, body: S.marlowBody("replied") }) },
        { name: "Open, the recipient was stopped", html: messaged({ target: "marlow", first, state: "recipient-stopped", open: true, body: S.marlowBody("recipient-stopped") }) },
        {
          name: "Open, the recipient's run failed",
          note: "The message was delivered; the failure is the recipient's. The sender's card never stays Working.",
          html: messaged({ target: "marlow", first, state: "recipient-failed", open: true, body: S.marlowBody("recipient-failed") }),
        },
        { name: "Open, failed", html: messaged({ target: "marlow", first, state: "failed", open: true, body: S.marlowBody("failed") }) },
        { name: "Open, blocked by policy", html: messaged({ target: "marlow", first, state: "blocked", open: true, body: S.marlowBody("blocked") }) },
        { name: "Open, not sent", html: messaged({ target: "marlow", first, state: "not-sent", open: true, body: S.marlowBody("not-sent") }) },
        { name: "Open, unknown", note: "The sender was stopped before the call returned.", html: messaged({ target: "marlow", first, state: "unknown", open: true, body: S.marlowBody("unknown") }) },
        {
          name: "The receiving side, every state",
          note: "In the recipient's task, at the start of the run the message started. Its state is the recipient's own run.",
          html: ["working", "waiting-you", "replied", "completed", "failed", "stopped"]
            .map((state) => messaged({ target: "otto", verb: "Message from", first, state, body: S.receivingBody(state) }))
            .join(""),
        },
        { name: "The receiving side, open: working", html: messaged({ target: "otto", verb: "Message from", first, state: "working", open: true, body: S.receivingBody("working") }) },
        { name: "The receiving side, open: waiting for you", html: messaged({ target: "otto", verb: "Message from", first, state: "waiting-you", open: true, body: S.receivingBody("waiting-you") }) },
        { name: "The receiving side, open: replied", html: messaged({ target: "otto", verb: "Message from", first, state: "replied", open: true, body: S.receivingBody("replied") }) },
        { name: "The receiving side, open: failed", html: messaged({ target: "otto", verb: "Message from", first, state: "failed", open: true, body: S.receivingBody("failed") }) },
        {
          name: "Messages no card accounts for",
          note: "A message a bot did not ask for, or a late reply that no identifier ties to a card. Each opens to its text and Raw.",
          html:
            CT.eventDetails({ line: `Message from ${CT.avatar("pip")}<b>Pip</b>`, body: S.incomingBody("pip", "Thursday is clear now. I moved the dentist to next week.") }) +
            CT.eventDetails({ line: `Message from ${CT.avatar("marlow")}<b>Marlow</b>`, body: S.incomingBody("marlow", "Late addition for the house log: note that the cache moved to /srv/scratch.") }),
        },
      ],
    },
    {
      id: "t3code",
      title: "The Messaged T3 Code card",
      note: "The same component. It is drawn only from the bot's own tool events; the app never talks to T3 Code. Call made means the call returned, not that the work is finished. A link or a file shows only when a result carries one.",
      specimens: [
        {
          name: "Folded, every state",
          html: ["call-started", "approval", "call-made", "delivery-unknown", "failed", "not-sent"]
            .map((state) => messaged({ target: "t3code", first: S.t3First, state, body: S.t3Body(state) }))
            .join(""),
        },
        { name: "Open, call started", note: "No progress arrives while the call runs.", html: messaged({ target: "t3code", first: S.t3First, state: "call-started", open: true, body: S.t3Body("call-started") }) },
        { name: "Open, waiting for approval", note: "The call had started; it is held, and goes on as the same call when allowed.", html: messaged({ target: "t3code", first: S.t3First, state: "approval", open: true, body: S.t3Body("approval") }) },
        { name: "Open, call made, with a link in the result", html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made") }) },
        {
          name: "Open, call made, no link and no target fields",
          note: "Nothing is filled in: no Open thread, no chips.",
          html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made", { link: false, fields: false }) }),
        },
        { name: "Open, call made, and the bot was stopped", html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made", { stopped: true }) }) },
        {
          name: "Open, call made, and a later call named this one",
          note: "The bot checked on the work. Its result is added under its own time; the state stays Call made.",
          html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made", { checked: true }) }),
        },
        { name: "Open, delivery unknown", html: messaged({ target: "t3code", first: S.t3First, state: "delivery-unknown", open: true, body: S.t3Body("delivery-unknown") }) },
        { name: "Open, failed", html: messaged({ target: "t3code", first: S.t3First, state: "failed", open: true, body: S.t3Body("failed") }) },
        { name: "Open, not sent", html: messaged({ target: "t3code", first: S.t3First, state: "not-sent", open: true, body: S.t3Body("not-sent") }) },
        {
          name: "A tool-server call that becomes the T3 Code card",
          note: "Recognized per call. Before its result names one of T3 Code's seven tools, it is the general card with words from its effective name. Then the same line, in the same place, becomes the T3 Code card, and whether it was open, which view, and focus carry over. Watch it live in conversation.html?scene=t3.",
          still: true,
          html:
            A({ ...C.t3Launch, mcp: undefined, details: undefined, text: "" }, { status: "running", elapsed: "0:01" }) +
            `<p class="spec-then">The result names t3_thread_launch, and the thread's id:</p>` +
            T3(C.t3Launch, [C.t3Launch]),
        },
        {
          name: "One thread, one card: every call on it, each with its own Raw",
          note: "A wait that came right after the launch joined the card; a follow-up, a failed read and a stop, made later, are items here and keep their own lines below. Each item opens its own call's Raw.",
          html: T3(C.t3Launch, [C.t3Launch, C.t3Wait, C.t3Send, C.t3ReadFail, C.t3Read, C.t3Stop], { open: true, items: { [C.t3Wait.id]: { raw: true } }, lines: [C.t3Send.id, C.t3ReadFail.id, C.t3Read.id, C.t3Stop.id] }),
        },
        {
          name: "The thread's state, from its calls",
          note: "An open call first (Call started, Checking), then what T3 Code last reported in a returned result, with its time, then the latest sending call. A failed read does not change it.",
          html: col(
            T3(C.t3Launch, [{ ...C.t3Launch, status: "running" }]),
            T3(C.t3Launch, [C.t3Launch, { ...C.t3Wait, status: "running" }]),
            T3(C.t3Launch, [C.t3Launch, C.t3Wait]),
            T3(C.t3Launch, [C.t3Launch, C.t3Wait, C.t3ReadFail]),
            T3(C.t3Launch, [C.t3Launch, C.t3Read]),
            T3(C.t3Launch, [C.t3Launch, C.t3Read, C.t3Stop]),
          ),
        },
        {
          name: "A read whose last page holds a cut item",
          note: "No more pages, but the reply's text was cut: the card says part of the reply only, and never that the end was read.",
          html: T3(C.t3Launch, [C.t3Launch, C.t3ReadCut], { open: true }),
        },
        {
          name: "Later calls leave a line where they happened",
          note: "Nothing above the reader moves, so a call made later keeps its own line at its moment, and is also an item of the thread's card. Show the thread finds the card by the thread's identity, never by nearness.",
          html:
            T3(C.t3Launch, [C.t3Launch, C.t3Wait, C.t3Send, C.t3Read, C.t3Stop], { lines: [C.t3Send.id, C.t3Read.id, C.t3Stop.id] }) +
            CT.msg({ html: "While that runs, I'll draft the house log entry." }) +
            CT.t3Line(C.t3Send, { thread: key }) +
            CT.msg({ html: "Checking whether T3 Code has finished." }) +
            CT.t3Line(C.t3Read, { thread: key, open: true }) +
            CT.msg({ html: "You asked me to stop the coding work." }) +
            CT.t3Line(C.t3Stop, { thread: key }),
        },
        {
          name: "Listing projects and threads",
          note: "Ordinary lines in T3 Code's family. They fold with each other and never join a thread's card.",
          html: F([C.t3Projects, C.t3Threads]),
        },
      ],
    },
    {
      id: "approval",
      title: "Approval cards",
      note: "The card shows the decisions the request offers and no others. Deny is always among them and always visible. Answer any of these: the outcome says what the gateway confirmed.",
      specimens: [
        { name: "Pending", html: approval(S.approval) },
        { name: "Pending, full request and Raw open", note: "Raw holds the request's fields as the gateway builds them.", html: approval({ ...S.approval, full: { ...S.approval.full, open: true }, rawOpen: true }) },
        {
          name: "Always allow, for an ordinary command",
          note: "The request's own fields, and in words what the gateway keeps: an allowlist entry whose reach the gateway decides. No lifetime. Deny stays beside the form's buttons.",
          html: approval({ ...S.approval, formOpen: true }),
        },
        {
          name: "Always allow, for a command raised by a routine",
          note: "The one kind that mints a dated grant: whole days, from 1 to 3650, filled with the request's default.",
          html: approval({ ...S.approval, ...routine, formOpen: true, days: "30", foot: "Asked by the routine <b>Weekly cleanup</b>." }),
        },
        { name: "A decision is being sent", note: "Not marked resolved until the gateway answers. Deny stays.", still: true, html: approval({ ...S.approval, formOpen: true, sent: "sending" }) },
        {
          name: "The gateway refused the decision",
          note: "A refusal comes with the gateway's reason, and the request is still open.",
          html: approval({ ...S.approval, formOpen: true, sent: "refused", sentReason: "media-box did not accept a change to its allowlist." }),
        },
        {
          name: "No answer came",
          note: "Unknown is its own outcome. The card never says the command did not run, and offers no allow again until the request's state is known.",
          html: approval({ ...S.approval, formOpen: true, sent: "unknown" }),
        },
        {
          name: "Another decision won",
          note: "The card shows the winner.",
          html: approvalResolved({ state: "denied", line: S.approval.line, when: "5:25 PM", open: true, outcome: "Denied by another reviewer at 5:25 PM. Your decision was not applied.", full: S.approval.full, raw: S.approvalRaw("deny") }),
        },
        { name: "A request that does not offer Always allow", note: "The host is set to always ask, or the gateway finds nothing reusable to save. The choice is Allow or Deny.", html: approval({ ...S.approval, decisions: ["once", "deny"] }) },
        {
          name: "Asked by a helper",
          html: approval({ ...S.approval, asker: { title: "A helper of Otto wants to run a command", line: "Asked by a helper Otto started for this task." } }),
        },
        {
          name: "Asked by a bot that another bot messaged",
          note: "In Marlow's task. In Otto's task the Messaged card reads Recipient waiting and leads here.",
          html: approval({
            ...S.approval,
            bot: "marlow",
            asker: { title: "Marlow wants to run a command", line: "Marlow is working on a message from Otto." },
            summary: "Append two lines to <b>notes/house-log.md</b> in Otto's workspace.",
            line: "Append two lines to notes/house-log.md",
            request: { ...S.approval.request, agent: "Marlow", host: "The gateway's host" },
          }),
        },
        { name: "The run has already ended, and the request is still pending", note: "It says only what is known.", html: approval({ ...S.approval, runEnded: true }) },
        {
          name: "With warnings and an expiry",
          html: approval({
            ...S.approval,
            summary: "Delete the old transcode cache on <b>media-box</b>.",
            line: "Delete the old transcode cache on media-box",
            warnings: ["This can't be undone"],
            full: { ...S.approval.full, command: "rm -rf /srv/scratch/transcode-cache" },
            decisions: ["once", "deny"],
            foot: "Expires in 28 minutes; the command is not run if it does.",
          }),
        },
        {
          name: "Asking to message another bot",
          html: approval({
            bot: "otto",
            what: "message Marlow",
            line: "Message Marlow: Write a two-line entry for the house log.",
            summary: "“Write a two-line entry for the house log…”",
            full: { reason: "Otto's outgoing messages are set to ask first.", command: S.marlowSent, fields: [["To", "Marlow"], ["Asked by", "Your message in this task, 5:24 PM"]] },
            request: { agent: "Otto" },
            kind: "other",
            raw: S.approvalRaw(),
          }),
        },
        {
          name: "Resolved, every outcome",
          html: ["once", "always", "denied", "expired", "closed-ended", "closed-failed", "cancelled"]
            .map((state) =>
              approvalResolved({
                state,
                line: S.approval.line,
                when: "5:25 PM",
                full: S.approval.full,
                saved: state === "always" ? { kind: "command", request: S.approval.request } : undefined,
                raw: S.approvalRaw(state === "once" ? "allow-once" : state === "always" ? "allow-always" : state === "denied" ? "deny" : ""),
              }),
            )
            .join(""),
        },
        {
          name: "Resolved and open: allowed once",
          note: "The command can run. Whether it ran is on its action card.",
          html: approvalResolved({ state: "once", line: S.approval.line, when: "5:25 PM", open: true, full: S.approval.full, raw: S.approvalRaw("allow-once") }),
        },
        {
          name: "Resolved and open: always allowed, an ordinary command",
          note: "What was kept, in the form's own words. The gateway returns no saved rule, so none is shown.",
          html: approvalResolved({ state: "always", line: S.approval.line, when: "5:25 PM", open: true, saved: { kind: "command", request: S.approval.request }, full: S.approval.full, raw: S.approvalRaw("allow-always") }),
        },
        {
          name: "Resolved and open: always allowed, a routine's command, for 30 days",
          html: approvalResolved({ state: "always", line: S.approval.line, when: "5:25 PM", open: true, saved: { ...routine, days: "30" }, full: S.approval.full, raw: S.approvalRaw("allow-always") }),
        },
        { name: "Resolved and open: denied", html: approvalResolved({ state: "denied", line: S.approval.line, when: "5:25 PM", open: true, full: S.approval.full, raw: S.approvalRaw("deny") }) },
        {
          name: "Expired",
          note: "An expired request cannot be answered again on the installed gateway, so the card has no action.",
          html: approvalResolved({ state: "expired", line: S.approval.line, when: "5:53 PM", open: true, full: S.approval.full, raw: S.approvalRaw() }),
        },
      ],
    },
    {
      id: "order",
      title: "The permission order",
      note: "The gateway decides; the app shows what happened and never implies a review or a question that did not happen. First what the installed gateway does by itself, then the rules that need Clawtrate's rules plugin.",
      specimens: [
        {
          name: "The installed gateway: its policy refuses the command",
          note: "A failed action card. No approval card; nothing to approve.",
          html: stepBlocked("gateway"),
        },
        {
          name: "The installed gateway: its policy allows the command with no request",
          note: "Full access with asking off, an allowlist entry, or a routine's grant. An ordinary action card: no approval card and no review line.",
          html: A({ ...C.mv, body: S.allowedBody(), details: { exitCode: 0 }, took: "1.2s" }, {}, { open: true }),
        },
        {
          name: "The installed gateway: the automatic review approved",
          html: A({ ...C.command, args: { command: "df -h /srv/media", host: "media-box" }, body: S.reviewedBody(), took: "0.1s" }, {}, { open: true }),
        },
        {
          name: "The installed gateway: the automatic review denied, and the gateway then asks",
          note: "The ordinary approval card, with the review's line in the full request.",
          html: approval({ ...S.approval, full: { ...S.approval.full, open: true } }),
        },
        {
          name: "The installed gateway: the automatic review denied, and the gateway refuses",
          note: "A failed action card, in view like every card.",
          html: stepBlocked("review"),
        },
        {
          name: "With Clawtrate's rules plugin: a deny rule for this bot",
          html: stepBlocked("bot"),
        },
        {
          name: "With Clawtrate's rules plugin: an ask rule that outranks an allow",
          note: "A card. The full request names the rule that asked.",
          html: approval({
            ...S.approval,
            full: {
              ...S.approval.full,
              open: true,
              review: "",
              cause: {
                text: "Asked because of Otto's rule “ask before moving anything under /srv/media”. It outranks the saved allow.",
                label: "Edit rule",
                where: "Opens Settings, Permissions, at this rule. That needs admin access, asked for the first time it is opened.",
              },
            },
          }),
        },
      ],
    },
    {
      id: "question",
      title: "Question cards",
      note: "One to three questions, each with two to four options, and always a field for your own words. Answer or dismiss any of these.",
      specimens: [
        { name: "Pending, one answer", note: "Choosing answers at once. A, B, C and D choose from the keyboard.", html: CT.question({ ...question, raw: S.questionRaw() }) },
        { name: "Pending, several answers", html: CT.question({ ...skip, picked: [0, 2], raw: S.questionRaw() }) },
        { name: "Pending, with a typed answer", html: CT.question({ ...question, own: "Two weeks, then ask me", raw: S.questionRaw() }) },
        {
          name: "Pending, three questions",
          note: "Send answers is enabled when every question has an answer.",
          html: CT.question({
            questions: [
              { ...question, picked: [0] },
              skip,
              { title: "Should I tell Marlow when it is done?", options: [["Yes"], ["No"]] },
            ],
            raw: S.questionRaw(),
          }),
        },
        { name: "Answered", html: CT.questionAnswered({ title: question.title, answers: [["A", "A week"]], raw: S.questionRaw({ answers: [["A week"]] }) }) },
        { name: "Answered, several", html: CT.questionAnswered({ title: skip.title, answers: [["A", "Transcode cache"], ["C", "Thumbnails"]], raw: S.questionRaw({ answers: [["Transcode cache", "Thumbnails"]] }) }) },
        { name: "Answered in your own words", html: CT.questionAnswered({ title: question.title, answers: [["", "Two weeks, then ask me"]], raw: S.questionRaw({ answers: [["Two weeks, then ask me"]] }) }) },
        { name: "Dismissed", note: "The bot is told there is no answer, and the run carries on.", html: CT.questionAnswered({ title: question.title, state: "dismissed", raw: S.questionRaw({ dismissed: true }) }) },
        { name: "Expired", html: CT.questionAnswered({ title: question.title, state: "expired", raw: S.questionRaw() }) },
        { name: "Cancelled by Stop", html: CT.questionAnswered({ title: question.title, state: "cancelled", raw: S.questionRaw() }) },
        { name: "Closed because the run ended", html: CT.questionAnswered({ title: question.title, state: "closed-ended", raw: S.questionRaw() }) },
        { name: "Closed because the run failed", html: CT.questionAnswered({ title: question.title, state: "closed-failed", raw: S.questionRaw() }) },
        {
          name: "A question record this card does not take",
          note: "A form, a link, a secret, or options outside two to four. Shown readable, with its Raw, and not answerable here.",
          html: CT.questionReadOnly({ questions: [{ question: "Sign in to the backup provider, then confirm.", options: [], why: "This is a form with a link." }], raw: S.questionOtherRaw }),
        },
      ],
    },
    {
      id: "composer",
      title: "The composer during a run",
      note: "Send stays. Stop appears beside it for as long as the run can be stopped. What has not been sent waits on a shelf above the pill. These are pictures of each state; every control works in the scripted run.",
      specimens: [
        { name: "No run, empty", still: true, html: CT.composer({ bot: "otto" }) },
        { name: "No run, with text", still: true, html: CT.composer({ bot: "otto", text: "Find out why it was slow." }) },
        { name: "Running, empty", still: true, html: CT.composer({ bot: "otto", run: "running" }) },
        { name: "Running, with text: Enter steers", still: true, html: CT.composer({ bot: "otto", run: "running", text: "Skip the write-up, just fix it." }) },
        { name: "Choosing how to send", still: true, html: `<div style="padding-top:132px">${CT.composer({ bot: "otto", run: "running", text: "Then check the certificate warning too.", menu: true })}</div>` },
        { name: "Running, set to queue", still: true, html: CT.composer({ bot: "otto", run: "running", text: "Then check the certificate warning too.", mode: "queue" }) },
        { name: "A queued message", still: true, html: CT.composer({ bot: "otto", run: "running", shelf: queuedRow() }) },
        {
          name: "Waiting on an approval",
          note: "A message sent now joins the run and leaves the approval pending.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            pending: "approval",
            text: "Use /srv/tmp instead.",
            shelf: CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Otto needs your approval</b> <span>to run a command</span>", actions: CT.button("Review") }),
          }),
        },
        {
          name: "Waiting on a question, while typing",
          note: "The mode word reads Hold: the message is not the answer.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            pending: "question",
            text: "Also tell me how big it is now.",
            shelf: CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Otto asked a question.</b> <span>A message sent now is held until you answer.</span>", actions: CT.button("Review") }),
          }),
        },
        {
          name: "A held message",
          note: "Released when the last pending question is answered, dismissed or expires. It has no Send now.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            pending: "question",
            shelf: shelf([
              CT.shelfRow({ lead: glyph("queued"), text: "<b>Held until you answer</b> <span>Also tell me how big it is now.</span>", actions: CT.button("Edit") + CT.button("Cancel", 'data-variant="quiet"') }),
              CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Otto asked you a question</b>", actions: CT.button("Review") }),
            ]),
          }),
        },
        {
          name: "A queued message that couldn't start",
          still: true,
          html: CT.composer({
            bot: "otto",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Couldn't start</b> <span>Otto's daily budget is used up. Then check the certificate warning too.</span>", actions: CT.button("Try again") + CT.button("Delete", 'data-variant="quiet"') }),
          }),
        },
        { name: "Stopping", note: "A message sent now is queued.", still: true, html: CT.composer({ bot: "otto", run: "stopping", text: "" }) },
        {
          name: "Stopping, with a message queued",
          note: "Send now is unavailable until the run has ended.",
          still: true,
          html: CT.composer({ bot: "otto", run: "stopping", shelf: queuedRow("Queued", CT.button("Cancel", 'data-variant="quiet"')) }),
        },
        {
          name: "The stop request failed",
          note: "The run is still running, and Stop is back.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "running",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Couldn't stop Otto.</b> <span>The gateway did not answer the stop request.</span>", actions: CT.button("Try again") + `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss this notice">${CT.icon("x")}</button>` }),
          }),
        },
        {
          name: "After Stop: nothing starts by itself",
          note: "Messages that were held or queued stay on the shelf, unsent, until each is sent or removed.",
          still: true,
          html: CT.composer({
            bot: "otto",
            shelf: CT.shelfRow({ lead: glyph("stopped"), text: "<b>Not sent</b> <span>Then check the certificate warning too.</span>", actions: CT.button("Send") + CT.button("Remove", 'data-variant="quiet"') }),
          }),
        },
        { name: "Offline", note: "Send works: the host holds the message and sends it once on reconnect.", still: true, html: CT.composer({ bot: "otto", run: "offline", text: "Is the disk still at 61%?" }) },
        { name: "With attachments", still: true, html: CT.composer({ bot: "otto", text: "Here is the usage chart.", files: [{ name: "disk-usage.png", size: 1.4, image: true }, { name: "backup-2026-11-15.log", size: 0.2 }] }) },
        {
          name: "Attachments over their own limits",
          note: "6 MB for an image, 20 MB for any other file. The refusal shows before anything is sent, and Send is disabled until the files are removed.",
          still: true,
          html: CT.composer({ bot: "otto", text: "Here is the scan.", files: [{ name: "scan.png", size: 8.2, image: true }, { name: "logs.tar", size: 21 }, { name: "notes.txt", size: 0.1 }] }),
        },
        {
          name: "Attachments over the limit for one message",
          still: true,
          html: CT.composer({ bot: "otto", text: "All three.", files: [{ name: "week-1.zip", size: 12 }, { name: "week-2.zip", size: 11.4 }, { name: "chart.png", size: 4, image: true }] }),
        },
        {
          name: "A notice",
          still: true,
          html: CT.composer({
            bot: "otto",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Otto failed to respond</b> <span>The model provider is overloaded.</span>", actions: CT.button("Try again") + `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss">${CT.icon("x")}</button>` }),
          }),
        },
      ],
    },
    {
      id: "jump",
      title: "Jump to latest and the status strip",
      note: "New output is followed only when the reader is near the end. Otherwise their place holds and this control appears above the foot of the transcript, pointing at the most urgent thing out of view.",
      specimens: [
        {
          name: "Jump to latest, every state",
          note: "A pending card first, with the arrow pointing at it; then a live run, with the bot's real state; then new output.",
          still: true,
          html: `<div class="spec-row" style="gap:28px 16px">${[
            CT.jump({ state: "needs-you", phrase: "Needs you" }),
            CT.jump({ state: "needs-you", phrase: "Needs you", up: true }),
            CT.jump({ state: "live", bot: "otto", phrase: "Reading the backup log", face: "working" }),
            CT.jump({ state: "live", bot: "otto", phrase: "Thinking", face: "thinking" }),
            CT.jump({ state: "latest" }),
            CT.jump({ state: "latest", phrase: "3 new" }),
          ]
            .map((html) => `<span class="spec-static">${html}</span>`)
            .join("")}</div>`,
        },
        {
          name: "The status strip, every state",
          note: "It sits inside the conversation, under the title pill. Its dot is its own; the count shows only when it is known.",
          still: true,
          html: `<div class="spec-row" style="gap:12px">${["reconnecting", "offline", "syncing", "synced", "failed", "granted"].map((b) => `<span class="spec-static">${CT.banner(b)}</span>`).join("")}<span class="spec-static">${CT.banner("synced", "", "")}</span></div>`,
        },
      ],
    },
    {
      id: "errors",
      title: "Turn errors and notes",
      specimens: [
        {
          name: "A turn failed",
          note: "Copy request ID copies it, Raw shows the error event, and Dismiss folds the card to a line that opens it again.",
          html: CT.turnError({
            title: "Otto couldn't finish this turn",
            reason: "The model provider is overloaded. Nothing ran after step 4, and steps already completed are not undone.",
            requestId: "req_9c1e44a0",
            raw: S.turnErrorRaw,
          }),
        },
        {
          name: "Rate limited",
          html: CT.turnError({ title: "Otto couldn't finish this turn", reason: "This request was rate limited after 5 attempts. Try again in a moment.", requestId: "req_9c1e44a1", raw: S.turnErrorRaw }),
        },
        {
          name: "The run's time limit",
          note: "The gateway says which limit was hit. The step that was running reads Aborted.",
          html: CT.turnError({
            title: "Otto's turn reached its 50 minute limit",
            reason: "The gateway ended the turn so it would not hang. Send a message to pick up where it left off.",
            requestId: "req_9c1e44a2",
            raw: S.turnErrorRaw,
            retry: false,
          }),
        },
        { name: "Stopped", html: stoppedNote },
        {
          name: "Stopped from somewhere else",
          note: "It goes straight to stopped, without Stopping…",
          html: CT.turnNote({ lead: glyph("stopped"), html: "<p><b>Stopped after 40s</b>, from another device or session. Completed steps are not undone.</p><ul><li>Stopped with it: Marlow's run for this message.</li></ul>" }),
        },
        {
          name: "Stopped while a call had started",
          note: "Nothing is claimed that the gateway did not report.",
          html: CT.turnNote({ lead: glyph("stopped"), html: "<p><b>Stopped after 31s.</b> Completed steps are not undone.</p><ul><li>The message to Marlow may or may not have been delivered.</li></ul>" }),
        },
        { name: "Finished before Stop took effect", html: CT.turnNote({ lead: glyph("check"), html: "<p><b>Finished before Stop took effect.</b> The turn completed normally.</p>" }) },
        { name: "Three tool calls timed out", html: CT.turnNote({ lead: CT.icon("warning"), html: "<p><b>Stopped after 3 tool calls in a row timed out.</b> media-box may not be responding.</p>" }) },
      ],
    },
    {
      id: "rows",
      title: "Rows in the rail",
      note: "One table decides every part of a bot's row: the avatar shows the most urgent state among its tasks, line two follows it, and the unread dot is independent. A task row is its title, the time of its last activity and one mark.",
      specimens: [
        {
          name: "Bot rows, in order of urgency",
          rail: true,
          still: true,
          html: `<ul class="bot-list">${[
            { bot: "pip", state: "waiting", preview: "Waiting for you: a question", time: "2m" },
            { bot: "marlow", state: "failed", preview: "Couldn't finish: provider overloaded", time: "9m" },
            { bot: "otto", state: "blocked", preview: "Can't reach media-box", time: "4m" },
            { bot: "pip", state: "done-failed", preview: "Finished with 1 failed action", time: "4:40 PM", unread: true, tone: "failed" },
            { bot: "otto", state: "working", preview: "Reading backup-2026-11-15.log", time: "now" },
            { bot: "marlow", state: "thinking", preview: "Thinking", time: "now" },
            { bot: "juniper", state: "done", preview: "Verdict: usually worth it.", time: "5:02 PM", unread: true },
            { bot: "otto", state: "stopped", preview: "Stopped. Completed steps are not undone.", time: "4:12 PM" },
            { bot: "juniper", state: "idle", preview: "Ask these five, and get the answers in writing.", time: "5:24 PM" },
          ]
            .map((row, i) => CT.botGroup({ ...row, i }))
            .join("")}</ul>`,
        },
        {
          name: "One done with failures, one working",
          note: "Done with failures comes first, with its badge. Opening that task clears it, and the row shows working.",
          rail: true,
          still: true,
          html:
            `<ul class="bot-list">${CT.botGroup({ bot: "otto", state: "done-failed", preview: "Finished with 1 failed action", time: "5:31 PM", unread: true, tone: "failed", open: true, tasks: CT.taskRow({ title: "Rotate the logs on rack-2", status: "running", time: "now" }) + CT.taskRow({ title: "Router firmware", status: "done-failed", time: "5:31 PM" }) })}</ul>` +
            `<p class="spec-then">After opening Router firmware:</p>` +
            `<ul class="bot-list">${CT.botGroup({ bot: "otto", state: "working", preview: "Rotating logs on rack-2", time: "now", open: true, tasks: CT.taskRow({ title: "Rotate the logs on rack-2", status: "running", time: "now" }) + CT.taskRow({ title: "Router firmware", status: "idle", time: "5:31 PM", current: true }) })}</ul>`,
        },
        {
          name: "One waiting, and more recent activity elsewhere",
          note: "The preview stays Waiting for you; the dot says another task has news.",
          rail: true,
          still: true,
          html: `<ul class="bot-list">${CT.botGroup({ bot: "juniper", state: "waiting", preview: "Waiting for you: a question", time: "10m", unread: true, open: true, tasks: CT.taskRow({ title: "Library e-book apps compared", status: "unread", time: "5:40 PM" }) + CT.taskRow({ title: "Heat pump vs. gas furnace", status: "waiting", time: "5:31 PM" }), i: 1 })}</ul>`,
        },
        {
          name: "Task rows, every state",
          rail: true,
          still: true,
          html: `<ul class="bot-list">${CT.botGroup({
            bot: "otto",
            state: "waiting",
            preview: "Waiting for you: approve a command",
            time: "now",
            open: true,
            tasks:
              [
                ["Weekly backup check", "waiting", "now", true],
                ["Disk almost full on the media box", "running", "now"],
                ["Certificate renewal warning", "unread", "5:12 PM"],
                ["Router firmware", "done-failed", "4:40 PM"],
                ["Printer offline again", "failed", "Mon"],
                ["NAS scrub", "blocked", "Mon"],
                ["UPS battery report", "stopped", "Sun"],
                ["Guest Wi-Fi password", "queued", "Sun"],
                ["Thermostat schedule", "idle", "Nov 2"],
              ]
                .map(([title, status, time, current]) => CT.taskRow({ title, status, time, current }))
                .join("") +
              `<li><button type="button" class="task task-more"><span class="task-title">Show all 14</span></button></li>` +
              `<li><button type="button" class="task task-new">${CT.icon("plus")}<span class="task-title">New task</span></button></li>`,
          })}</ul>`,
        },
      ],
    },
    {
      id: "phone",
      title: "The phone",
      note: "Wherever the desktop uses hover or a right-click, the phone uses a tap or touch and hold. Set the width to Phone above to see every component at touch sizes; holding a step or a card there opens these sheets.",
      specimens: [
        {
          name: "Touch and hold on a step",
          still: true,
          html: `<div class="sheet sheet-specimen"><ul class="menu" role="menu"><li><button type="button" class="menu-item" role="menuitem">${CT.icon("copy")}Copy result</button></li><li><button type="button" class="menu-item" role="menuitem">${CT.icon("code")}Copy raw</button></li></ul></div>`,
        },
        {
          name: "The mode word, or touch and hold on Send, during a run",
          still: true,
          html: `<div class="sheet sheet-specimen">${CT.sendMenu(true, "steer", { sheet: true })}</div>`,
        },
        {
          name: "The composer on a phone, during a run with text",
          note: "The mode word keeps its place, so what Enter does is always in view.",
          still: true,
          html: `<div style="max-width:390px" data-input="touch">${CT.composer({ bot: "otto", run: "running", text: "Skip the write-up." })}</div>`,
        },
        {
          name: "The iPhone app: a bot's task list",
          note: "On iPhone, tapping a bot opens its task list, tapping a task opens its chat, and Back returns the same way. The rows are the task rows above, at touch sizes.",
          rail: true,
          still: true,
          html:
            `<div class="phone-list" data-input="touch"><header class="phone-list-head"><span class="icon-button">${CT.icon("back")}</span>${presence("otto", "waiting", { label: false })}<b>Otto</b><span class="icon-button">${CT.icon("plus")}</span></header>` +
            `<ul class="task-list">${[
              ["Weekly backup check", "waiting", "now"],
              ["Disk almost full on the media box", "running", "now"],
              ["Certificate renewal warning", "unread", "5:12 PM"],
              ["Router firmware", "idle", "Mon"],
            ]
              .map(([title, status, time]) => CT.taskRow({ title, status, time }))
              .join("")}</ul></div>`,
        },
      ],
    },
    {
      id: "proactive",
      title: "Offers, and a connector that stopped working",
      note: "automation.md §13. Both are the bot's own words over the ordinary components: Clawtrate draws no offer card, Accept button, signed-out badge or Reconnect button, because the gateway marks nothing as an offer and reports no connector sign-in state.",
      specimens: [
        {
          name: "An offer (F-200)",
          note: "A reply like any other. The person takes it up by answering, and the work that follows is an ordinary run.",
          html: CT.msg({ html: "The venue's quote expires on Friday and nobody has answered it yet. Want me to draft a reply asking them to hold the price for another week?" }),
        },
        {
          name: "A connector that stopped working (F-364)",
          note: "The tool's failure is its action card in the failed state, with the tool's own error, and Raw one step further. That the app signed the bot out, and the offer to reconnect, are in the bot's reply.",
          html:
            A({ ...C.server, id: "call_7c01", name: "gmail__search_messages", args: { query: "from:venue newer_than:7d" }, mcp: { server: "gmail", tool: "search_messages" }, details: { mcpServer: "gmail", mcpTool: "search_messages" }, status: "failed", isError: true, text: "401 Unauthorized: the token has been expired or revoked.", took: "0.4s" }) +
            CT.msg({ html: "Gmail signed me out, so I couldn't look for the venue's reply. If you reconnect Gmail on the gateway, I'll check again." }),
        },
      ],
    },
    {
      id: "controls",
      title: "Controls",
      note: "What docs/design/controls.md adds to the conversation, and a link to every state of its pages. A refused call says what decided it, recorded, inferred or not recorded; an ask says who asks and offers what it can complete; an answer and what then happened are two lines; only a gateway setting is called enforced without qualification.",
      specimens: [
        ...[
          ["gateway", "The gateway's settings for every bot", "Tool exec not found. Inferred: the gateway's settings for every bot denied this tool when Clawtrate read them at 5:41 PM. Set on the gateway.", JSON.stringify({ result: "Tool exec not found", details: {} })],
          ["bot", "The bot's own deny list", "Tool exec not found. Inferred: Otto's settings denied this tool when Clawtrate read them at 5:41 PM. The gateway enforces this.", JSON.stringify({ result: "Tool exec not found", details: {} })],
          ["inferred", "A not-found call no read explains", "Cause not recorded. The gateway answered 'Tool exec not found'.", JSON.stringify({ result: "Tool exec not found", details: {} })],
          ["plugin", "A rule of Clawtrate's rules plugin", "Clawtrate's rules plugin: Otto's rule 'never matching rm -rf *', version 1.", JSON.stringify({ details: { status: "blocked", deniedReason: "plugin-before-tool-call", reason: "Otto's rule: never run commands matching rm -rf *" } })],
          ["person", "A person, on the card", "You denied it at 5:43 PM.", JSON.stringify({ details: { status: "error", error: "Denied by user. The tool call did not run." } })],
          ["expired", "No answer in time", "No one answered within 10 minutes.", JSON.stringify({ details: { status: "error", error: "Approval timed out" } })],
          ["nobody", "Nobody could be asked", "No one could be asked: a routine's run has no place to ask.", JSON.stringify({ details: { status: "error", error: "Plugin approval unavailable: cron runs have no approval-capable initiating surface." } })],
          ["changed", "The gateway couldn't take the ask", "Cause not recorded. The gateway answered 'Plugin approval required (gateway unavailable)'.", JSON.stringify({ details: { status: "error", error: "Plugin approval required (gateway unavailable)" } })],
        ].map(([key, name, decided, raw]) => ({
          name: `Refused by: ${name}`,
          html: A(
            {
              ...C.rm,
              id: `call_ctl_${key}`,
              ...({ person: { status: "denied", deniedWord: "Denied" }, expired: { status: "denied", deniedWord: "Expired" }, nobody: { status: "denied", deniedWord: "Not run" }, changed: { status: "denied", deniedWord: "Not run" }, inferred: { status: "failed" }, gateway: { status: "failed" }, bot: { status: "failed" } }[key] || { blockedBy: "policy" }),
              body: CT.stepBody({
                readable: CT.fields([
                  ["Command", "rm -rf /srv/media/transcode-cache", { mono: true }],
                  ["Decided by", decided],
                ]) + CT.note("The command was not run."),
                raw: { tool: "exec", args: JSON.stringify({ command: "rm -rf /srv/media/transcode-cache" }), error: raw, ids: S.ids(`call_ctl_${key}`) },
              }),
            },
            {},
            { open: true },
          ),
        })),
        {
          name: "An ask from a rule",
          note: "Who asks and its 10-minute wait. Allow once and Deny only: the gateway tells the plugin the decision alone, so no card makes a standing permission. For admin, Make a rule… opens the rule form filled in from the request.",
          still: true,
          html:
            `<section class="card request" data-kind="approval" data-state="pending" role="region" aria-label="Otto wants to change a file. Needs approval.">` +
            `<header class="request-head"><h3 class="request-title">Otto wants to change a file</h3><span class="tag" data-tone="warn">Needs approval</span></header>` +
            `<p class="request-summary">Write notes/disk-2026-11-16.md in Otto's workspace.</p>` +
            `<p class="request-asker">Asked by Clawtrate's rules plugin: Otto's rule 'Ask first · notes/**', version 1.</p>` +
            `<div class="request-actions"><button type="button" class="button" data-variant="primary">Allow once</button><span class="spacer"></span><button type="button" class="button" data-variant="quiet">Deny</button></div>` +
            `<p class="c-sentence"><button type="button" class="link-button">Make a rule…</button></p>` +
            `<p class="request-foot">The rules plugin asks for a 10-minute wait.</p></section>`,
        },
        {
          name: "A messaging ask",
          note: "Each message is its own decision: Allow once and Deny.",
          still: true,
          html:
            `<section class="card request" data-kind="approval" data-state="pending" role="region" aria-label="Otto wants to message Pip. Needs approval.">` +
            `<header class="request-head"><h3 class="request-title">Otto wants to message Pip</h3><span class="tag" data-tone="warn">Needs approval</span></header>` +
            `<p class="request-summary">Send Pip: "Could you look over the plan?"</p>` +
            `<p class="request-asker">Asked by Clawtrate's rules plugin: Otto's messaging settings. Each message is asked about.</p>` +
            `<div class="request-actions"><button type="button" class="button" data-variant="primary">Allow once</button><span class="spacer"></span><button type="button" class="button" data-variant="quiet">Deny</button></div>` +
            `<p class="request-foot">The rules plugin asks for a 10-minute wait.</p></section>`,
        },
        {
          name: "An ask at the allow limit",
          note: `Nothing is removed by itself. The card offers Allow once and Deny, and in place of Make a rule… says the limit, with the way to <a href="controls.html?bot=otto&amp;panel=open&amp;tab=settings&amp;bview=rule&amp;line=files">the rules list</a>. Allow once answers this request. The call's result shows what happened. <a href="controls.html?bot=otto&amp;task=o1&amp;ask=full">Answer it live</a>.`,
          still: true,
          html:
            `<section class="card request" data-kind="approval" data-state="pending" role="region" aria-label="Otto wants to change a file. Needs approval.">` +
            `<header class="request-head"><h3 class="request-title">Otto wants to change a file</h3><span class="tag" data-tone="warn">Needs approval</span></header>` +
            `<p class="request-summary">Write notes/disk-2026-11-18.md in Otto's workspace.</p>` +
            `<p class="request-asker">Asked by Clawtrate's rules plugin: Otto's rule 'Ask first · notes/**', version 1.</p>` +
            `<div class="request-actions"><button type="button" class="button" data-variant="primary">Allow once</button><span class="spacer"></span><button type="button" class="button" data-variant="quiet">Deny</button></div>` +
            `<p class="c-sentence">Otto has 20 allow rules, the most a scope can hold. <a class="link-button" href="controls.html?bot=otto&amp;panel=open&amp;tab=settings&amp;bview=rule&amp;line=files">Open the rules list</a></p></section>` +
            `<section class="card request" data-kind="approval" data-state="resolved" role="region" aria-label="Otto wanted to change a file. Allowed once."><header class="request-head"><h3 class="request-title">Otto wanted to change a file</h3><span class="tag">Allowed once</span></header>` +
            `<p class="c-outcome">Your answer: Allowed once, 5:44 PM.</p><p class="c-outcome">Then: Ran.</p><p class="c-outcome">Nothing was saved and no rule was removed.</p></section>`,
        },
        {
          name: "An answer, and what then happened",
          note: "The gateway acknowledged the answer; the call is its own fact. When it was tried, a settings change while the card waited ended the call with this answer; the answer alone doesn't say why.",
          still: true,
          html:
            `<section class="card request" data-kind="approval" data-state="resolved" role="region" aria-label="Otto wanted to run a command. Answered."><header class="request-head"><h3 class="request-title">Otto wanted to run a command</h3><span class="tag">Allowed once</span></header>` +
            `<p class="c-outcome">Your answer: Allowed once, 5:44 PM.</p><p class="c-outcome">Then: Didn't run. The gateway answered 'Plugin approval required (gateway unavailable)'.</p></section>`,
        },
        {
          name: "An expired ask",
          note: `Make a rule… (admin; below admin it is absent) opens <a href="controls.html?bot=otto&amp;panel=open&amp;tab=settings&amp;bview=rule&amp;line=files&amp;form=fromcard">the rule form filled in from the request</a>, which, for the request's exact value, says what the new Allow does given the rules already there. It saves only when the person adds the rule, and the expired call never runs.`,
          still: true,
          html: `<section class="card request" data-kind="approval" data-state="resolved" role="region" aria-label="Otto wanted to change a file. Expired."><header class="request-head"><h3 class="request-title">Otto wanted to change a file</h3><span class="tag">Expired</span></header><p class="c-outcome">Expired. Nothing ran.</p><div class="request-actions"><button type="button" class="button">Make a rule…</button></div></section>`,
        },
        {
          name: "The Messaged card's policy states",
          note: "Blocked by the sender's own list, by the gateway's pairs, and not sent after a denied card.",
          html:
            messaged({ target: "marlow", first, state: "blocked", open: true, body: CT.note("Otto may not message Marlow: Otto's messaging settings. The gateway enforces this. Nothing was sent.") + CT.cardFoot("", S.marlowRaw("blocked")) }) +
            messaged({ target: "marlow", first, state: "blocked", body: CT.note("Bots may not message each other on this gateway, or not these two. Set on the gateway. Nothing was sent.") + CT.cardFoot("", S.marlowRaw("blocked")) }) +
            messaged({ target: "marlow", first, state: "not-sent", body: CT.note("You denied the approval. Nothing was sent.") + CT.cardFoot("", S.marlowRaw("not-sent")) }),
        },
        {
          name: "Saved to memory",
          still: true,
          html: `<button type="button" class="event-line link-button" data-side="center">Saved to memory: memory/2026-11-17.md</button>`,
        },
        {
          name: "Budget lines",
          note: "A budget is a warning, and says so: Clawtrate holds back only its own sends.",
          still: true,
          html:
            `<div class="event-line" data-side="center">Otto has used 82% of its weekly budget: 1.64M of 2M tokens.</div>` +
            `<div class="c-composer-note"><p>Otto has reached its weekly warning budget. This is shown only: other apps, channels and Otto's routines aren't stopped.</p><button type="button" class="button" data-size="sm">Raise budget</button></div>`,
        },
        {
          name: "A provider's limit",
          still: true,
          html:
            `<div class="c-composer-note" data-tone="neutral"><p>OpenAI reports 92% of a weekly limit used, as of 5:40 PM. It doesn't say which of your OpenAI accounts.</p></div>` +
            `<div class="c-composer-note"><p>OpenAI reports a weekly limit reached, as of 5:40 PM. It resets Nov 20.</p></div>`,
        },
        {
          name: "Every state of the controls pages",
          note: "Each link opens controls.html in that state, as section 23 of controls.md lists them.",
          html: `<ul class="c-state-links">${controlStates.map(([q, label]) => `<li><a href="controls.html?${q}">${label}</a></li>`).join("")}</ul>`,
        },
      ],
    },
    {
      id: "lifecycle",
      title: "Bot lifecycle",
      note: "The primary bot, editing a bot, a change to its instructions, and duplicate, export, import and delete, from docs/design/bots-lifecycle.md. Each link opens lifecycle.html in that state, as section 14 lists them.",
      specimens: [
        {
          name: "Every state of the lifecycle page",
          html: `<ul class="c-state-links">${lifecycleStates.map(([q, label]) => `<li><a href="lifecycle.html?${q}">${label}</a></li>`).join("")}</ul>`,
        },
      ],
    },
  ];

  const only = CT.params.get("section");
  const root = document.getElementById("gallery");
  root.innerHTML = sections
    .filter((section) => !only || section.id === only)
    .map(
      (section) =>
        `<section class="spec-section" id="${section.id}"><header><h2>${section.title}</h2>` +
        `${section.note ? `<p>${section.note}</p>` : ""}</header>` +
        section.specimens
          .map(
            (spec) =>
              `<article class="spec"><div class="spec-label"><h3>${spec.name}</h3>${spec.note ? `<p>${spec.note}</p>` : ""}</div>` +
              `<div class="spec-box${spec.rail ? " spec-rail" : ""}"${spec.still ? " inert" : ""}${spec.lost ? ' data-connection="lost"' : ""}>${spec.html}</div></article>`,
          )
          .join("") +
        `</section>`,
    )
    .join("");

  const nav = document.getElementById("gallery-nav");
  if (nav) nav.innerHTML = sections.map((section) => `<a href="#${section.id}">${section.title}</a>`).join("");
})();
