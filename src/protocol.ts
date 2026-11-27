// The panel <-> worker contract, declared once: panel/main.ts and src/worker.ts both read it.

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'
export type PaletteChoice = 'orca' | 'catppuccin-mocha' | 'catppuccin-latte' | 'dracula' | 'github-dark' | 'github-light'

/** What the person chose in Settings; kept in the plugin's storage under `prefs`. */
export type Prefs = {
  /** A desktop notification when an agent starts needing them. */
  notifyBlocked: boolean
  /** One when a turn longer than a minute ends. */
  notifyDone: boolean
  /** People walk and screens flicker; off, the office holds still. */
  animate: boolean
  /** Panel-local colors; `orca` follows the host theme. */
  palette: PaletteChoice
  /** Projects one per line, or two per line when the panel is wide enough. */
  layout: 'list' | 'grid'
  density: 'comfortable' | 'compact'
  /** Last functional view; Settings is intentionally never stored here. */
  selectedView: 'office' | 'activity' | 'attention'
  /** Minutes without observed progress before a notification says an agent may be stuck; 0 is off. */
  stuckMinutes: number
  /** Project ids in the order the person put them; empty follows Orca's sidebar. */
  projectOrder: string[]
}

export const PREFS_KEY = 'prefs'
export const INSTALLATION_KEY = 'lobby.installation'
export const DEFAULT_PREFS: Prefs = { notifyBlocked: true, notifyDone: true, animate: true, palette: 'orca', layout: 'list', density: 'comfortable', selectedView: 'attention', stuckMinutes: 20, projectOrder: [] }

export const STUCK_CHOICES = [0, 10, 20, 30, 60]

const PALETTE_CHOICES: PaletteChoice[] = [
  'orca', 'catppuccin-mocha', 'catppuccin-latte', 'dracula', 'github-dark', 'github-light'
]

/** Stored preferences, with the default for anything missing or of the wrong type. */
export function readPrefs(value: unknown, missingView: Prefs['selectedView'] = 'office'): Prefs {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const pick = (key: 'notifyBlocked' | 'notifyDone' | 'animate'): boolean =>
    typeof stored[key] === 'boolean' ? (stored[key] as boolean) : DEFAULT_PREFS[key]
  const palette = PALETTE_CHOICES.includes(stored.palette as PaletteChoice)
    ? stored.palette as PaletteChoice
    : DEFAULT_PREFS.palette
  const legacyPrefs = ['notifyBlocked', 'notifyDone', 'animate', 'palette', 'layout', 'stuckMinutes', 'projectOrder'].some((key) => key in stored)
  const selectedView = stored.selectedView === 'office' || stored.selectedView === 'activity' || stored.selectedView === 'attention'
    ? stored.selectedView
    : legacyPrefs ? 'office' : missingView
  return {
    notifyBlocked: pick('notifyBlocked'),
    notifyDone: pick('notifyDone'),
    animate: pick('animate'),
    palette,
    layout: stored.layout === 'grid' ? 'grid' : 'list',
    density: stored.density === 'compact' ? 'compact' : 'comfortable',
    selectedView,
    stuckMinutes: STUCK_CHOICES.includes(stored.stuckMinutes as number) ? stored.stuckMinutes as number : DEFAULT_PREFS.stuckMinutes,
    projectOrder: Array.isArray(stored.projectOrder) ? stored.projectOrder.filter((id): id is string => typeof id === 'string') : []
  }
}

/** Whether an agent has gone quiet for longer than the person allows: working with no observed
 *  progress (a status, tool call or roster update), or still needing them. */
export function overdue(
  agent: Pick<AgentView, 'state' | 'lastSeenAt' | 'stateStartedAt'>,
  now: number,
  minutes: number
): { kind: 'quiet' | 'needs-you'; since: number } | null {
  if (!minutes) return null
  const since = agent.state === 'working' ? agent.lastSeenAt : agent.state === 'blocked' ? agent.stateStartedAt : null
  return since !== null && now - since >= minutes * 60_000
    ? { kind: agent.state === 'working' ? 'quiet' : 'needs-you', since }
    : null
}

/** Tokens counted from the agents' own logs on this machine: Claude Code and Codex. */
export type Usage = {
  /** Input not served from cache. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Total tokens by model id. */
  models: Record<string, number>
}

export function usageTotal(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite
}

/** One agent's context fill, compactions and tokens, read from the log that Orca's own session
 *  record names for it (src/context.ts). */
export type AgentContext = {
  /** Tokens in the context at its latest request; null until the log shows one, or right after a compaction. */
  tokens: number | null
  /** The model's context window, only when the log states it: Codex's do, Claude Code's do not. */
  window: number | null
  compactions: number
  /** This session's tokens today, cache included. */
  today: number
}

/** How full the context is from this percent: a warning, then an alarm. */
export const CONTEXT_WARN = 70
export const CONTEXT_HIGH = 90

/** The share of the window the context fills, and how alarming that is; null without both numbers. */
export function contextFill(context: AgentContext | null | undefined): { percent: number; level: 'ok' | 'warn' | 'high' } | null {
  if (!context || context.tokens === null || !context.window) return null
  const percent = Math.round((context.tokens / context.window) * 100)
  return { percent, level: percent >= CONTEXT_HIGH ? 'high' : percent >= CONTEXT_WARN ? 'warn' : 'ok' }
}

/** What a tool call looks like in the office: it decides where the character goes. */
export type ActivityKind =
  'edit' | 'read' | 'search' | 'shell' | 'web' | 'delegate' | 'plan' | 'tool'

export type Activity = {
  callId: string
  tool: string
  kind: ActivityKind
  /** A short label taken from the tool input: a file name, a command, a query. */
  detail: string
  startedAt: number
  /** Set once the call returned. */
  endedAt?: number
}

/** Work an agent has under way besides itself: a subagent, or a command that is running. */
export type Helper = {
  id: string
  kind: 'agent' | 'command'
  /** A subagent's type, e.g. `general-purpose`. */
  name: string
  description: string
  /** The tool a subagent is running now, and what that looks like in the office. */
  tool: string | null
  toolKind: ActivityKind | null
}

/** A child relationship explicitly reported under a parent by Orca's worktree roster. */
export type FamilyChild = {
  /** CLI identity, empty only when the provider omitted it. */
  id: string
  /** Only exact CLI kind `agent` is included; other child kinds are running commands. */
  kind: 'agent'
  name: string
  description: string
  tool: string | null
  toolKind: ActivityKind | null
  /** Last state Orca reported; done does not provide a success/failure outcome. */
  state: AgentState | 'unknown'
  reported: boolean
  /** Local observation time, not a provider finish time. */
  lastReportedAt: number
  missingSince: number | null
}

export type Todo = { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** What a Claude transcript adds: see src/transcript.ts. */
export type Insight = {
  model: string | null
  todos: Todo[]
  /** The files it changed last, newest first. */
  files: string[]
}

/** What is uncommitted in a workspace. */
export type Change = { files: number; added: number; removed: number }

/** A pull request or issue Orca has linked to a workspace. */
export type Link = { label: string; url: string }

export type AgentView = {
  id: string
  terminalId: string | null
  paneKey: string | null
  /** The parent agent's `paneKey` as Orca's roster reports it, whether or not that parent is listed. */
  parentPaneKey: string | null
  /** The `id` of the one listed agent whose `paneKey` equals `parentPaneKey`; null when absent, unlisted or self. */
  parentId: string | null
  /** The workspace's path; null when Orca cannot tie the agent to one. */
  workspaceId: string | null
  /** The checkout its workspace is a worktree of (or the workspace itself): its room. */
  projectId: string | null
  /** Explicit workspace branch and host, when Orca reports them. */
  branch: string | null
  hostId: string | null
  hostName: string | null
  /** Orca's session id, when present; helps disambiguate reused panes. */
  sessionId: string | null
  /** Opaque identity for this agent's current done turn, retained across polling and restart. */
  completionId: string | null
  /** True only when this completion was observed after first-upgrade baseline. */
  completionTracked: boolean
  /** Worker-private persisted snooze episode; retained across same-state metadata corrections. */
  notificationEpisodeId?: string
  /** Worker-private transition identity; source timestamps may be corrected after observation. */
  notificationTransitionId?: string
  /** Hash of the current roster turn id, when Orca reports one. */
  notificationTurnId?: string
  /** A terminal's title, or the name Orca gives the conversation. */
  title: string | null
  /** The last thing it was asked, and the last thing it said, when Orca knows. */
  prompt: string | null
  reply: string | null
  /** The agent kind Orca reports, e.g. `claude` or `codex`. */
  agent: string | null
  state: AgentState
  outcome: string | null
  /** Finished with something you have not looked at yet, by Orca's reckoning. */
  unread: boolean
  stateStartedAt: number
  /** A reported finish, the local observation time, or an ambiguous timestamp restored from older data. */
  finishedAt: number | null
  finishedAtSource?: 'source' | 'observed' | 'unknown' | null
  firstSeenAt: number
  lastSeenAt: number
  /** Tool calls in flight, oldest first. */
  active: Activity[]
  /** Finished tool calls, newest first. */
  recent: Activity[]
  toolCount: number
  helpers: Helper[]
  family: FamilyChild[]
  insight: Insight | null
  /** Context fill and tokens of its own session, when Orca's session record names the log; absent otherwise. */
  context?: AgentContext | null
  /** Runtime only, from Orca's orchestration inbox: it asked a question nobody answered. */
  pendingQuestion?: boolean
  /** Runtime only: when (ms) the newest unanswered question was asked. */
  questionSince?: number
  /** Runtime only: unread orchestration mail to the runs this coordinator launched. */
  unreadMail?: number
  /** Runtime only: when (ms) the newest unread mail arrived. */
  mailSince?: number
  /** Each change of state in the last two hours, oldest first. */
  history: { state: AgentState; at: number }[]
}

/** Locally observed evidence, not a complete execution trace. */
export type JournalEvent = {
  id: string
  agentId: string
  workspaceId: string | null
  projectId: string | null
  kind: 'observed' | 'state' | 'tool' | 'result' | 'disappeared'
  source: 'roster' | 'status' | 'hook' | 'workspace' | 'local'
  observedAt: number
  sourceAt?: number
  coverage: 'sampled' | 'event'
  state?: AgentState
  outcome?: string | null
  tool?: string
  detail?: string
  result?: string
  callId?: string
}

/** What has happened since midnight, for the line under the office. */
export type Today = {
  day: string
  /** Turns that ended, and how many of those failed. */
  finished: number
  failed: number
  /** How long agents spent needing the person, added up. */
  blockedMs: number
}

export type OfficeSnapshot = {
  agents: AgentView[]
  /** Reviewed completion keys owned by the worker; optional for older snapshots. */
  reviewedCompletions?: string[]
  /** Worker persistence for reconnect identity continuity; omitted from panel updates. */
  completionIdentities?: Record<string, { id: string; sourceAt: number | null; turnId: string | null; observedAt: number; tracked: boolean }>
  /** Bounded disconnected-agent snooze identity metadata; omitted from panel updates. */
  notificationEpisodes?: Record<string, {
    id: string
    transitionId: string
    state: AgentState
    stateStartedAt: number
    observedAt: number
    sessionId: string | null
    turnId: string | null
  }>
  /** Locally observed, bounded history, oldest first. */
  journal: JournalEvent[]
  /** Workspace path (an agent's `workspaceId`) to the name Orca gives it, which its agents go by. */
  workspaces: Record<string, string>
  /** Project path (an agent's `projectId`) to the project's name. */
  projects: Record<string, string>
  /** Each project's place in Orca's sidebar, by repo id and by path; absent without the Orca CLI. */
  sidebar?: Record<string, number>
  /** By workspace path. */
  changes: Record<string, Change>
  links: Record<string, Link[]>
  /** What the person has let the plugin do beyond watching. */
  can: { open: boolean }
  today: Today
  /** Today's tokens (local day), by workspace path and by project; absent until first counted. */
  usage?: { day: string; workspaces: Record<string, Usage>; projects: Record<string, Usage> }
}

/** Labels known workspace context without deriving names from paths or identities. */
export function workspaceContext(agent: AgentView, office: Pick<OfficeSnapshot, 'workspaces' | 'projects'>): {
  project: string | null
  workspace: string | null
  branch: string | null
  host: string | null
} {
  return {
    project: agent.projectId ? office.projects[agent.projectId] ?? null : null,
    workspace: agent.workspaceId ? office.workspaces[agent.workspaceId] ?? null : null,
    branch: agent.branch,
    host: agent.hostName ?? agent.hostId
  }
}

/** What can be done to one agent from its drawer, as far as Orca lets a plugin. Anything it cannot is
 *  null or false, and the panel leaves that control out. */
export type AgentActions = {
  /** What **Go to agent** reaches: its terminal, or only its workspace (Orca cannot pick a chat tab). */
  goTo: 'terminal' | 'workspace' | null
  /** Instructions can be typed into its terminal. */
  send: boolean
  /** The command that makes its provider shrink the conversation, e.g. `/compact`. */
  compact: string | null
}

/** The result of an action the person asked for; `error` is a sentence for them. */
export type ActionResult = { ok: true; note?: string } | { ok: false; error: string }

/** One control target, never the full persisted notification policy. */
export type NotificationControlState = {
  status: 'ready' | 'loading' | 'error'
  error?: string
  projectId: string
  muted: boolean | null
  agentId: string | null
  episodeId: string | null
  snoozed: boolean | null
  expiresAt: number | null
}

declare module 'orca' {
  interface PluginRequests {
    /** The whole office as the worker knows it now. */
    'office.snapshot': { output: OfficeSnapshot }
    /** The worker's durable first-run or pre-1.3 migration decision. */
    'office.installation': { output: { kind: 'fresh' | 'legacy' | 'unknown' } }
    /** Serially merges one validated panel intent into the latest saved settings. */
    'prefs.patch': { input: { patch: Partial<Prefs> }; output: { ok: true } | { ok: false; error: string } }
    /** Clears only the plugin's local observed history. */
    'office.clearHistory': { output: { cleared: boolean } }
    /** What the drawer may offer for one agent. */
    'office.actions': { input: { agentId: string }; output: AgentActions }
    /** Brings the agent's terminal, or else its workspace, to the front in Orca. */
    'office.goTo': { input: { agentId: string }; output: ActionResult }
    /** The agent selected in the panel, where the previous / next shortcuts step from. */
    'office.select': { input: { agentId: string }; output: { ok: boolean } }
    /** Types an instruction into the agent's terminal and presses Enter; only on the person's request. */
    'office.send': { input: { agentId: string; text: string }; output: ActionResult }
    /** Types the provider's compact command into the agent's terminal; only on the person's request. */
    'office.compact': { input: { agentId: string }; output: ActionResult }
    /** Marks the current completion as reviewed in The Lobby's local state only. */
    'attention.review': { input: { completionId: string }; output: ActionResult }
    /** Reads mute and current-episode snooze controls for one target without exposing the full policy. */
    'notification.control.read': { input: { projectId: string; agentId?: string; episodeId?: string }; output: NotificationControlState }
    /** Changes a project mute in worker-owned notification storage. */
    'notification.project.mute': { input: { projectId: string; muted: boolean }; output: ActionResult }
    /** Snoozes or resumes reminders for the agent's explicitly identified current episode. */
    'notification.reminder.snooze': { input: { projectId: string; agentId: string; episodeId: string; choice: '15m' | '1h' | 'manual' | 'resume' }; output: ActionResult }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after anything in the office changes. */
    'office.update': OfficeSnapshot
  }
}
