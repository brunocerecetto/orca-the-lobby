<p align="center">
  <a href="https://lilykos.github.io/orca-the-lobby/"><img src="docs/images/catalog/cover.png" alt="The Lobby: four project rooms of pixel-art coding agents, with Need you!, Stuck? and Failed bubbles" width="100%"></a>
</p>

# The Lobby

> Fork of [Lilykos/orca-the-lobby](https://github.com/Lilykos/orca-the-lobby) with Mexican agent names, `MR.Boss` for orchestration coordinators, and hidden Orca projects filtered out.

**Every agent in every worktree, in one live view. Find who needs you, review finished results locally, and keep the pixel-art Office in view.**

An [Orca](https://onorca.dev) plugin with four views: Attention, Office, Activity and Settings. The Office stays true to its pixel-art roots: one room per project, one desk per agent.

### [Take the tour: lilykos.github.io/orca-the-lobby](https://lilykos.github.io/orca-the-lobby/)

## Why you'd want it

- **See everything at once.** Every agent in every worktree, one room per project. Worktrees of a repo share a room, and counts show how many are working, need you, are done or failed.
- **Know who needs you.** Speech bubbles say **Need you!**, **Stuck?** or **Failed**, **Needs attention** dims the rest, and an optional desktop notification fires when an agent has gone quiet for 10 to 60 minutes.
- **Review results in one queue.** Compact Attention rows put the task first: open the title for details or use the separate, validated **Open agent** action. Needs input and failures stay expanded; **Finished · N** keeps other results counted while collapsed, and matching search results reveal them. Mark **Reviewed** inside result details; it is local to The Lobby and does not clear Orca's unread flag or change agent status.
- **See who started whom.** An org chart per project, drawn from the exact parent-to-worker links Orca reports, across worktrees. Nothing is guessed.
- **Search across views.** One literal search and project filter apply to Attention, Office and Activity. Comfortable or Compact density keeps the roster and chart readable at different panel sizes.
- **Act without hunting through tabs.** Open any agent to jump to its terminal, send it an instruction (terminal agents), or compact a Claude Code conversation. `Cmd/Ctrl+Alt+↑/↓` steps through the agents that need you first.
- **Watch the context fill.** Context and tokens per agent, and tokens today per project, read from your Claude Code and Codex logs. Per-agent context needs a macOS chat session; see the [limits](#honest-limits).
- **Private and tidy.** No telemetry. A day and night window, five extra palettes plus Orca's own theme, and reduced motion respected.

<p align="center">
  <img src="docs/images/catalog/office.png" alt="The Office: a pixel room per project with agents at their desks" width="100%">
</p>

## Install

Requires Orca **1.4.248 or newer**.

```sh
orca plugin install Lilykos/orca-the-lobby
```

This command installs the newest tagged release from this repository.

Orca shows the permissions the plugin asks for ([below](#permissions)) and asks you to approve them. Then open **The Lobby** from the right sidebar. The plugin is also listed in the [Orca community catalog](https://github.com/stablyai/orca-community-plugins) (Settings → Plugins).

## Screenshots

| Attention: compact queue | See who started whom |
| --- | --- |
| <img src="docs/images/catalog/attention.png" alt="Compact Attention queue with task-first rows and separate agent actions" width="100%"> | <img src="docs/images/catalog/activity.png" alt="An org chart per project with who started whom" width="100%"> |
| **Act without hunting through tabs** | **Watch the context fill** |
| <img src="docs/images/catalog/drawer.png" alt="The agent drawer: Go to agent, an instruction box and Compact" width="100%"> | <img src="docs/images/catalog/context.png" alt="Context fill and tokens per agent" width="100%"> |

<img src="docs/images/catalog/palettes.png" alt="Five extra palettes plus Orca's theme, day and night" width="100%">

The panel itself, with demo data:

| Office, list | Office, light theme | Settings |
| --- | --- | --- |
| <img src="docs/images/office.png" alt="The Office tab in list layout" width="280"> | <img src="docs/images/office-light.png" alt="The Office tab on a light theme" width="280"> | <img src="docs/images/settings.png" alt="Settings with Appearance first, a collapsed project and episode controls disclosure, Local data and About links" width="280"> |

<img src="docs/images/office-grid.png" alt="The Office tab in grid layout, two projects per row" width="100%">

Attention queue and its local notification controls:

| Attention | Settings → Notifications |
| --- | --- |
| <img src="docs/images/attention-inbox.png" alt="Compact Attention queue with a native Filter disclosure and counted collapsed Finished group" width="320"> | <img src="docs/images/notification-controls.png" alt="Lobby-local project notification mute and episode reminder snooze controls" width="320"> |

## Features

### Attention

Attention groups the current live roster into **Needs input** (blocked), **Failed to review** (explicit failure outcomes) and **Finished** (eligible unread or newly observed completions). Needs input and failures remain open; Finished is a native collapsed disclosure with a visible count. Search can reveal matching Finished items, and clearing search restores your disclosure choice. Waiting, cancelled, interrupted and unconfirmed work is not relabeled as a successful result. Each compact task title opens details; a separate **Open agent** action follows validated navigation rules. **Mark Reviewed** is inside result details and records a local decision only.

Reviewed markers are stored in Orca's per-plugin storage for up to 24 hours and at most 500 completion keys. Opening a drawer or navigating does not mark anything Reviewed, and a later completion gets its own identity when its transition is observed or Orca reports a distinguishing turn/session value.

Search and project selection are shared with Office and Activity under a native **Filter** disclosure. The active-filter count and **Clear** action remain visible whenever a filter restricts results; hidden filters cannot silently restrict the queue. Search uses reported task, prompt, friendly name, provider and project/workspace/branch/host labels; chart ancestors remain visible to keep matching agents in context. Quiet states distinguish no live agents, no matches, and no current intervention; a nonzero Finished count remains visible.

### Notification controls

Open **Settings → Notifications** for alert preferences, project mute and current-episode reminders. Mute a project to pause all Lobby notifications for it, or snooze an eligible blocked/quiet episode's reminder for 15 minutes, 1 hour or until you resume it. Agents stay visible and counted in Attention. Snoozing affects reminders only, and resuming or unmuting does not send missed alerts later. A snooze shows its absolute expiry, and a new episode is treated separately.

Eligible transition alerts are grouped by project and kind over a fixed two-second window from the first event. One event keeps its individual message; a burst becomes one count summary. Duplicate events from the hook, roster and restart are suppressed. These controls are separate from Orca's notification settings.

### Office

- **One room per project checkout and host.** Worktrees of the same repository on the same host share a room; room signs show the host name (or **local**). Click a room's sign to fold or unfold it.
- **Projects in your order.** Rooms and charts follow the order of Orca's sidebar, and move when you reorder it there. Point at a room (or use a chart's header) and press **↑** / **↓** to set your own order instead; it is kept, shared by Office and Activity, and **Use the sidebar order again** in Settings undoes it.
- **Working agents sit at desks** (at least three per room, more rows as needed). A small icon above them shows what Orca reports them doing: thinking, shell, web, edit, read, search, plan, a tool, or delegating to a sub-agent. Each person has a friendly name, shown under them.
- **Finished agents stand at the coffee machine** (up to four are drawn). A window follows your local time of day, and a few decorations (plant, noticeboard, server rack, bookshelf, clock and so on) fill clear space.
- **Speech bubbles**, one per person, in priority order: **Need you!** while an agent is blocked, **Stuck?** once a working agent has been quiet longer than your stuck setting, then for 20 seconds after an agent finishes the first line of its last reply (or **Failed**). Click a bubble to open that agent.
- **A roster under each room**: conversation title (or a labeled prompt excerpt), provider (Claude, Codex, …), state, current work, uncommitted changes and a **Context** badge from 70% (amber) and 90% (red) where the context fill is known. Hover a person for a card with the same details.
- **Status colors**: green working, orange **Needs you**, amber waiting, red failed, grey done, blue done with an unread result.
- **Tokens today** per project appear under each room.
- **List or Grid.** Grid puts two projects on each row once the panel is at least 400px wide.
- **Comfortable or Compact density.** Compact reduces spacing and secondary detail while keeping text and controls usable.

### Activity

- **A connected chart per project**: a project hub at the top, agents below it. Dashed lines show which agents belong to the project; solid lines show only parent/child links Orca reports (a supervised worker's parent, and agent children listed under an agent). Nothing is guessed: an agent whose reported parent is not in the roster stays unlinked with a short note.
- **Agent boxes** show a portrait, name, provider, state and task. Click one to open its drawer. Use the branch buttons to expand reported children; a child without a matching agent opens a small drawer with the state, operation and description Orca reported.
- **All / Needs attention.** Needs attention highlights blocked and failed agents and dims the rest, without removing anything; a project with nothing to act on folds to one line, and an empty state offers **Show all agents**.
- **Shared filters.** The same search and project filter apply here and in Attention and Office; matching descendants retain their reported chart ancestors.
- **Navigation:** the page scrolls up and down; wide charts pan with a trackpad swipe, Shift+wheel, the left and right arrow keys, or dragging the background. **Reset view** recentres. Each chart folds with its ▾ button, moves with **↑** / **↓**, and counts and tokens are shown in its header. List / Grid works here too.

### Agent drawer

Click an agent in the Office (roster or scene) or the Activity chart. The drawer slides up over the panel; Escape, the × button or a click outside closes it and returns focus.

- **Task, state, result and action come first.** The friendly name is secondary; source finish times are distinguished from locally observed finish times.
- **More details** progressively discloses the asked excerpt, current work, changes, context and tokens, **Calls** (running and recent tool calls, with sub-agents), **Tasks** and **Files** (heuristic, from Claude Code transcripts) and **PRs** Orca has linked to the workspace.
- **Go to agent** brings its terminal to the front. For an Orca chat session, Orca gives plugins no way to pick a chat tab, so it opens the agent's workspace and says so.
- **Instruction box** (terminal agents only): sends your text to the agent's terminal. Enter sends, Shift+Enter adds a line.
- **Compact conversation** (Claude Code agents in a terminal): types `/compact` after you confirm.
- **View in Activity** (from the Office) finds the agent in its project's chart.

Controls that cannot work for an agent are left out. A blocked agent says it needs you and points to **Go to agent**: Orca does not tell plugins what an agent is asking or offer approve/deny controls. Live updates never rebuild the controls, so what you are typing is not disturbed.

### Settings

**Appearance** comes first: choose the color palette, Comfortable or Compact density, the shared pixel banner, animation and manual room-order reset. **Notifications** keeps the global switches and reminder interval together, then a native collapsed **Project and episode controls** disclosure. Its summary shows active, muted/snoozed and unavailable counts; expand it to mute a project or snooze a current episode. Read and save errors stay visible with Retry even while the disclosure is closed.

**Local data** explains the observation journal and privacy limits. **Clear activity history** asks you to Cancel or confirm Clear before deleting it, then reports the result. The compact About footer links to the guide, GitHub, What's new and issue reporting, and shows the installed version.

Palette choices are Orca default (follows the app theme), Catppuccin Mocha / Latte, Dracula and GitHub Dark / Light; status colors keep their meaning. The shared banner starts visible. Animation also respects system reduced-motion preferences. The Office and Activity room order follows the sidebar unless you set a manual order.

New installations start in Attention. An upgrade with existing 1.2 data opens Office first. After that, the last functional view is remembered; Settings is not remembered as a startup view. Comfortable density is the migration default.

### Status bar and shortcuts

- The status bar item reads `N working`, or `N working · M need you`.
- **Previous agent** / **Next agent** (command palette, or `Mod+Alt+↑` / `Mod+Alt+↓`) step through agents that need you first, then working ones, then the rest, in a steady order, and jump to each like **Go to agent**. They step on from the agent open in the drawer or the last one they went to.

## Permissions

Orca asks you to approve these when you install. The plugin asks for no more than it uses.

| Capability | Used for | When |
| --- | --- | --- |
| `agent:read` | Agent status and tool-call events, and Orca's agent list for the focused workspace | Continuously, to draw the Lobby |
| `workspace:read` | Workspace names and paths, to group agents into project rooms | Continuously |
| `storage:own` | The plugin's own storage: your settings and the saved office state | On setting changes, and every few seconds while the state changes |
| `workspace:write` | Opens a workspace or brings a terminal to the front | Only when you press **Go to agent**, or use Previous / Next agent |
| `terminal:send` | Types into an agent's terminal | Only when you press **Send** or confirm **Compact conversation**. Never on its own |
| `notifications:show` | Desktop notifications | Only for the events you left on in Settings; none if you turn them off |

The plugin also reads agent events through hooks (`agent.tool.before` / `agent.tool.after`). They only record the call and never deny or change one. It runs as a trusted worker, so it has your user's file access; the [next section](#data-and-privacy) says what it touches.

## Data and privacy

**No telemetry.** The plugin makes no direct network requests. Orca uses its existing connections to list agents on your paired servers.

**What it reads, and from where**

- **Orca**: `orca worktree ps --json` (agents across worktrees, with their state, task title, a prompt and last-reply excerpt, current operation, sub-agents and linked PRs), the host's agent and workspace APIs, `orca repo list --json` every 10 s for the sidebar's project order, and `orca terminal list|switch|send` for the drawer actions. It polls every 3 s while an agent is working and every 20 s when idle.
- **Git**: `git diff --shortstat HEAD` in each workspace with an agent, for the uncommitted-changes count. New untracked files are not counted.
- **Claude Code logs** (`~/.claude/projects/`) and **Codex logs** (`~/.codex/sessions/`): usage numbers and model ids for tokens today. Claude transcript enrichment also reads titles and recent prompt text to match a transcript heuristically, plus TodoWrite entries and file names extracted from edited paths for **Tasks** and **Files**. This stays local; prompt text is not stored in the activity journal.
- **Orca's session store** (`~/Library/Application Support/orca/agent-session-domain.db` on Orca 1.4.261+, or `agent-session-journal.db` on older versions, read-only through the `sqlite3` macOS ships): only the provider and session id of a chat agent, to find its own log for the context line. Never prompts or messages.

**What it stores** (in Orca's per-plugin storage, nowhere else):

- Your settings.
- The office state: current agents with their title, short prompt and last-reply excerpts (up to 400 characters), tool-call labels (up to 80 characters), recent state history, and the counts for today.
- A bounded observation journal of state changes and tool calls: at most 24 hours, oldest dropped first to fit the 200,000-byte storage bound. It may hold clipped tool details and result excerpts; it does not store prompts. **Clear local activity history** in Settings empties it. The journal is never sent to the panel.
- Bounded completion identity metadata and Reviewed completion keys. Reviewed keys expire after 24 hours and are capped at 500; they are not sent to agents and do not change Orca's unread or status state.
- Notification policy: muted project ids, reminder snoozes and handled notification identities. It is bounded to the same 200,000-byte serialized storage limit, with caps of 200 muted projects, 500 snoozes and 1,000 handled transitions. If storage is unavailable or a change cannot fit, the control reports the error and does not claim it was saved.

**What it types.** The plugin types into a terminal only after you press **Send** or confirm **Compact conversation**, and only while Orca's own list still shows that agent working in a terminal no other agent shares.

## Honest limits

- **Orca reports less than you might hope.** There is no selected-model field, so the provider label (Claude, Codex, …) is not a model name. Orca does not say what a blocked agent is asking, and gives plugins no approve/deny and no way to pick a chat tab.
- **Context comes from an exact id chain, only for Orca chat sessions on macOS.** Orca's session store (an Orca internal, not a documented API) names the provider session id, and that id is in the log's file name. Agents in a terminal tab and other providers have no verified link, so they show nothing. Claude Code logs state no context window, so Claude agents show tokens without a percentage rather than a guessed one. Tokens today count only the agent's current provider session. A future Orca release could change the store; the lines then disappear.
- **Tokens are counted for Claude Code and Codex only**, per workspace and per project for the local day, with cache read and write separate. No cost estimate is made.
- **Tasks and Files are heuristic.** They come from Claude transcripts matched to an agent by title and prompt similarity, which can be ambiguous when several agents look alike.
- **Observation is sampled.** Short chat tool calls can fall between roster polls, and Orca does not report terminal tool calls on SSH or WSL hosts yet. Uncommitted changes ignore untracked files.
- **Completion identity depends on reported transitions.** The Lobby prefers Orca's finish time and reported turn/session identifiers; otherwise it saves the local observation identity. If a new turn begins and finishes while it was unobserved and Orca supplies no discriminator, identical pane/state data cannot prove that it was a different turn. A displayed local observation time is labeled as observed, not as an Orca finish time.
- **Charts show only what Orca reports.** The chart does not imply agents talk to each other, and a missing child link does not prove an agent has no parent.
- **Without the Orca CLI**, the plugin falls back to status and tool events plus the focused workspace's agents. Chat calls are then unavailable, and finished agents linger for four hours.
- **Paired Orca servers** appear in the roster when the CLI supports `host list`. **Go to agent** opens the remote terminal if Orca reports one, or the Git worktree otherwise. Unreachable paired servers disappear until they reconnect, so stale states cannot trigger alerts. The Lobby does not read remote files or logs, or send text to remote terminals.
- **"Compact conversation" is only offered for Claude Code**, where `/compact` typed into its terminal is known to work.
- Developed and used on macOS. Context details need macOS; the rest only needs the `orca` CLI.

## Troubleshooting

- **"Nobody in yet."** No agent has been seen yet. Start one in any workspace and it walks in. If agents are running and you still see this, check that the plugin is enabled and not marked as errored in Orca's plugin settings.
- **"The office is closed: …"** The panel's request to the plugin's worker failed, and the error follows. Check that the plugin is enabled and not errored; restarting Orca restarts the worker.
- **No context, tokens, tasks or files.** Context needs a macOS Orca chat session with a Claude Code or Codex agent and `sqlite3` (`/usr/bin/sqlite3`). Tokens need logs under `~/.claude/projects/` or `~/.codex/sessions/`. A missing or locked store is retried after a minute.
- **No Send or Compact controls.** `terminal:send` was not granted, the agent is not in a terminal Orca can type into (for example a chat session), it has finished, or another agent shares its terminal. **Compact** is also hidden while an agent is blocked and for providers other than Claude Code.
- **Go to agent only opened the workspace.** The agent is a chat session (Orca cannot pick a chat tab), or its terminal would not come forward. The drawer says which.
- **Notification title starts with the plugin id.** Orca 1.4.264 adds this prefix itself; plugins cannot change it to their display name yet.
- **No notifications.** Check the three switches in Settings, and that `notifications:show` was approved. A turn under a minute never triggers the "finished" notification.
- **Agents missing or late.** The list updates every 3 to 20 seconds. Without the Orca CLI on the PATH, only status and tool events are seen.
- **Scene looks frozen.** Check **Animate the office** in Settings and your system's reduced-motion setting.

## Develop

```sh
orca plugin types .                          # once: writes the gitignored .orca/ typings tsconfig.json uses
orca plugin test .                           # unit tests
npx --yes --package typescript tsc --noEmit  # type check
orca plugin check .                          # validate the manifest and files
python3 scripts/shots/run.py                 # screenshot and interaction checks
```

Orca transpiles TypeScript when loading the plugin; there is no build step. On current Orca, `orca plugin dev load .` loads this checkout as `local.the-lobby` and reloads edits. Approve the access Orca lists for that folder, and disable `lilykos.the-lobby` while testing to avoid duplicate shortcuts and notifications. Afterwards, unload the development folder with `orca plugin dev unload .` and enable your installed release again. The development copy has separate settings and history.

`scripts/shots` builds an isolated fixture page from the real panel code (demo data only) and screenshots it at several panel widths in headless Chrome; see the headers of `render.cjs` and `run.py`.

Layout: `src/` is the worker (Orca roster, office state, actions, context, usage) and `panel/` the UI (scene drawing, charts, drawer). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributors

Thanks to [@titilambert (Thibault Cohen)](https://github.com/titilambert) for paired-server agents, host labels and Windows CLI discovery ([#1](https://github.com/Lilykos/orca-the-lobby/pull/1)).

## License

[MIT](LICENSE). Palette colors are adapted from the official [Catppuccin palette](https://catppuccin.com/palette/), the [Dracula specification](https://draculatheme.com/spec) and [GitHub Primer primitives](https://github.com/primer/primitives).
