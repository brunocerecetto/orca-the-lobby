// The office's state: one record per agent, changed only by the functions below. No Orca calls
// here, so src/office.test.ts runs it as plain data.
import { createHash } from 'node:crypto'
import type { PluginEvents, PluginHooks } from 'orca/worker'
import type {
  Activity,
  ActivityKind,
  AgentState,
  AgentView,
  Change,
  FamilyChild,
  Insight,
  JournalEvent,
  Link,
  OfficeSnapshot,
  Today,
  Usage
} from './protocol'
import { addUsage, emptyUsage } from './usage'

export type Office = {
  agents: Map<string, AgentView>
  journal: JournalEvent[]
  rosterTools: Map<string, string>
  workspaces: Map<string, string>
  projects: Map<string, string>
  /** Workspace path to the project it belongs to, once looked up. */
  roots: Map<string, string>
  /** Paths of workspaces whose Orca project is hidden; in memory only, never stored. */
  hidden: Set<string>
  /** By workspace path: what is uncommitted there, and what Orca has linked to it. */
  changes: Map<string, Change>
  links: Map<string, Link[]>
  /** What the person has let the plugin do beyond watching. */
  can: { open: boolean }
  today: Today
  /** Today's tokens by workspace path, from the agents' own logs. */
  usage: { day: string; workspaces: Map<string, Usage> } | null
  /** Whether Orca's own list of agents is in: it then decides who is in the office. */
  rostered: boolean
  /** Each project's place in Orca's sidebar, by repo id and by path. */
  sidebar: Map<string, number>
  /** Set after the first successful live roster; reset on each worker start. */
  attentionTracking: boolean
  /** Latest completion per host-qualified pane, retained briefly across roster disconnects. */
  completionIdentities: Map<string, NonNullable<OfficeSnapshot['completionIdentities']>[string]>
  /** Snooze episodes for agents temporarily absent from Orca's latest roster. */
  notificationEpisodes: Map<string, NonNullable<OfficeSnapshot['notificationEpisodes']>[string]>
  /** Observed done transitions that must win over stale stored identities during read recovery. */
  freshCompletionScopes: Set<string>
}

/** What `orca worktree ps --json` says of a worktree and its agents; only the fields used. */
export type RosterWorktree = {
  path: string
  hostId?: string | null
  hostName?: string | null
  displayName?: string | null
  branch?: string | null
  repo?: string | null
  repoId?: string | null
  linkedItems?: { type?: string; number?: number; url?: string }[] | null
  agents?: {
    paneKey: string
    /** Undocumented in Orca 1.4.255 help and types; absent on older Orca. */
    parentPaneKey?: string | null
    state: AgentState
    agentType?: string | null
    prompt?: string | null
    conversationName?: string | null
    lastAssistantMessage?: string | null
    toolName?: string | null
    toolInput?: string | null
    mainAgent?: { outcome?: string }
    /** Optional stable discriminator on newer Orca roster responses. */
    turnId?: string | null
    sessionId?: string | null
    stateStartedAt?: number
    updatedAt?: number
    children?: {
      id?: string
      kind?: string
      state?: string
      name?: string
      description?: string
      operation?: { toolName?: string }
    }[]
    activity?: { listed?: boolean; unread?: boolean }
  }[]
}

type StatusEvent = PluginEvents['agent.status.changed']
type ToolEvent = PluginHooks['agent.tool.after']['event']
type ListedAgent = { terminalId: string | null; title: string | null; agent: string | null }

/** Finished calls kept per agent: the card shows the newest and opens to the rest. */
const RECENT = 40
const DETAIL = 80
const MESSAGE = 400
const LINKS = 4
const HISTORY_MS = 2 * 60 * 60 * 1000
/** A child missing from the latest roster stays marked unreported briefly. */
const HELPER_RETENTION_MS = 10 * 60 * 1000
const HELPER_HISTORY = 12
const HELPER_LIVE = 64
/** An agent nobody heard from for this long has gone home. */
const IDLE_MS = 4 * 60 * 60 * 1000

export function createOffice(): Office {
  return {
    agents: new Map(),
    journal: [],
    rosterTools: new Map(),
    workspaces: new Map(),
    projects: new Map(),
    roots: new Map(),
    hidden: new Set(),
    changes: new Map(),
    links: new Map(),
    can: { open: false },
    today: { day: '', finished: 0, failed: 0, blockedMs: 0 },
    usage: null,
    rostered: false,
    sidebar: new Map(),
    attentionTracking: false,
    completionIdentities: new Map(),
    notificationEpisodes: new Map(),
    freshCompletionScopes: new Set()
  }
}

const JOURNAL_MS = 24 * 60 * 60 * 1000
const JOURNAL_LIMIT = 5000
const NOTIFICATION_EPISODE_LIMIT = 500
const NOTIFICATION_EPISODE_BYTES = 80_000

function pruneJournal(office: Office, now: number): void {
  office.journal = office.journal
    .filter((event) => Number.isFinite(event.observedAt) && event.observedAt > now - JOURNAL_MS)
    .sort((a, b) => a.observedAt - b.observedAt || a.id.localeCompare(b.id))
    .slice(-JOURNAL_LIMIT)
}

function notificationEpisodeScope(hostId: string | null, paneKey: string | null, id: string): string {
  return createHash('sha256').update(JSON.stringify([hostId || 'local', paneKey || id])).digest('hex')
}

function fingerprint(value: string | null | undefined): string | null {
  return typeof value === 'string' && value ? createHash('sha256').update(value).digest('hex') : null
}

function pruneNotificationEpisodes(office: Office, now: number): void {
  const entries = [...office.notificationEpisodes]
    .filter(([, entry]) => Number.isFinite(entry.observedAt) && entry.observedAt > now - JOURNAL_MS &&
      entry.observedAt <= now && Number.isFinite(entry.stateStartedAt))
    .sort(([keyA, a], [keyB, b]) => a.observedAt - b.observedAt || keyA.localeCompare(keyB))
    .slice(-NOTIFICATION_EPISODE_LIMIT)
  while (entries.length && jsonBytes(Object.fromEntries(entries)) > NOTIFICATION_EPISODE_BYTES) entries.shift()
  office.notificationEpisodes = new Map(entries)
}

function freshNotificationEpisodeId(id: string, at: number, discriminator: string | null): string {
  if (!discriminator) return initialNotificationEpisodeId(id, at)
  return createHash('sha256').update(JSON.stringify([id, at, discriminator])).digest('hex')
}

function notificationTransitionId(state: AgentState, episodeId: string): string {
  // Episode identity is immutable even when Orca later corrects its timestamp.
  const legacy = `${state}:${episodeId}`
  return utf8Length(legacy) <= 256 ? legacy : createHash('sha256').update(JSON.stringify([state, episodeId])).digest('hex')
}

function rememberNotificationEpisode(office: Office, agent: AgentView, now: number): void {
  if (!agent.paneKey || !agent.notificationEpisodeId) return
  const key = notificationEpisodeScope(agent.hostId, agent.paneKey, agent.id)
  office.notificationEpisodes.set(key, {
    id: agent.notificationEpisodeId,
    transitionId: agent.notificationTransitionId ?? notificationTransitionId(agent.state, agent.notificationEpisodeId),
    state: agent.state,
    stateStartedAt: agent.stateStartedAt,
    observedAt: now,
    sessionId: fingerprint(agent.sessionId),
    turnId: agent.notificationTurnId ?? null
  })
}

/** Orca refuses a stored value or panel message over 256 KiB; stay well under it. */
export const STORE_BYTES = 200_000

export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function trimPayload(value: unknown, maxText: number, key = ''): unknown {
  if (typeof value === 'string') {
    if (/^(id|agentId|completionId|notificationEpisodeId|notificationTransitionId|notificationTurnId|transitionId|paneKey|parentPaneKey|parentId|sessionId|turnId|hostId|workspaceId|projectId|terminalId|repoId|state|outcome|kind|source|finishedAtSource|coverage|tone|day)$/.test(key) || key === 'reviewedCompletions') return value
    return Array.from(value).slice(0, maxText).join('')
  }
  if (Array.isArray(value)) return value.map((item) => trimPayload(item, maxText, key))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, trimPayload(item, maxText, name)]))
  return value
}

export class PayloadCapacityError extends RangeError {
  constructor(bytes: number, limit: number) {
    super(`Snapshot requires ${bytes} UTF-8 bytes (limit ${limit}) after optional data was trimmed; it cannot fit without trimming identity data.`)
    this.name = 'PayloadCapacityError'
  }
}

function bounded<T extends OfficeSnapshot>(input: T, limit: number, compactAgents: boolean): T {
  let state = input
  if (jsonBytes(state) <= limit) return state
  while (state.journal.length && jsonBytes(state) > limit) {
    state = { ...state, journal: state.journal.slice(Math.ceil(state.journal.length / 4)) }
  }
  for (let maxText = 2000; jsonBytes(state) > limit && maxText >= 0; maxText = maxText === 0 ? -1 : Math.floor(maxText / 2)) {
    state = trimPayload(state, maxText) as T
  }
  if (state.notificationEpisodes && jsonBytes(state) > limit) {
    const episodes = Object.entries(state.notificationEpisodes)
      .sort(([keyA, a], [keyB, b]) => a.observedAt - b.observedAt || keyA.localeCompare(keyB))
    while (episodes.length && jsonBytes(state) > limit) {
      episodes.shift()
      state = { ...state, notificationEpisodes: Object.fromEntries(episodes) }
    }
  }
  if (jsonBytes(state) > limit) {
    // Discard display and activity detail before considering any identity-bearing fields.
    state = {
      ...state,
      workspaces: {}, projects: {}, changes: {}, links: {}, sidebar: undefined, usage: undefined,
      agents: state.agents.map((agent) => ({
        ...agent, title: null, prompt: null, reply: null, branch: null, hostName: null, insight: null, context: null,
        recent: [], history: [], helpers: [], family: [], active: []
      }))
    }
  }
  if (state.notificationEpisodes && jsonBytes(state) > limit) {
    const episodes = Object.entries(state.notificationEpisodes)
      .sort(([keyA, a], [keyB, b]) => a.observedAt - b.observedAt || keyA.localeCompare(keyB))
    while (episodes.length && jsonBytes(state) > limit) {
      episodes.shift()
      state = { ...state, notificationEpisodes: Object.fromEntries(episodes) }
    }
  }
  if (jsonBytes(state) > limit && compactAgents) {
    state = {
      ...state,
      agents: state.agents.map((agent) => ({
        id: agent.id, terminalId: agent.terminalId, paneKey: agent.paneKey, workspaceId: agent.workspaceId,
        projectId: agent.projectId, parentPaneKey: agent.parentPaneKey, parentId: agent.parentId,
        hostId: agent.hostId, sessionId: agent.sessionId, state: agent.state,
        outcome: agent.outcome, unread: agent.unread, stateStartedAt: agent.stateStartedAt,
        finishedAt: agent.finishedAt, finishedAtSource: agent.finishedAtSource,
        firstSeenAt: agent.firstSeenAt, lastSeenAt: agent.lastSeenAt,
        completionId: agent.completionId, completionTracked: agent.completionTracked,
        notificationEpisodeId: agent.notificationEpisodeId,
        notificationTransitionId: agent.notificationTransitionId,
        notificationTurnId: agent.notificationTurnId
      }))
    }
  }
  const bytes = jsonBytes(state)
  if (bytes > limit) throw new PayloadCapacityError(bytes, limit)
  return state
}

/** The state to store, with the oldest history dropped until it fits Orca's size limit. */
export function storable(state: OfficeSnapshot, limit = STORE_BYTES): OfficeSnapshot {
  const withoutUndefinedTurnIds = state.agents.some((agent) => agent.notificationTurnId === undefined)
    ? { ...state, agents: state.agents.map((agent) => {
        if (agent.notificationTurnId !== undefined) return agent
        const { notificationTurnId: _turn, ...rest } = agent
        return rest
      }) }
    : state
  // A plain episode at its observed timestamp is reconstructible; the transition id is derived
  // from it. Keep explicit identity when Orca has corrected the mutable timestamp or reported a
  // different turn, so those episodes survive a restart.
  const compact = withoutUndefinedTurnIds.agents.some((agent) => agent.notificationEpisodeId === initialNotificationEpisodeId(agent.id, agent.stateStartedAt) &&
    agent.notificationTransitionId === notificationTransitionId(agent.state, agent.notificationEpisodeId) && !('notificationTurnId' in agent))
    ? {
        ...withoutUndefinedTurnIds,
        agents: withoutUndefinedTurnIds.agents.map((agent) => {
          if (agent.notificationEpisodeId !== initialNotificationEpisodeId(agent.id, agent.stateStartedAt) ||
              agent.notificationTransitionId !== notificationTransitionId(agent.state, agent.notificationEpisodeId) || 'notificationTurnId' in agent) return agent
          const { notificationEpisodeId: _episode, notificationTransitionId: _transition, ...rest } = agent
          return rest
        })
      }
    : withoutUndefinedTurnIds
  return bounded(compact, limit, true)
}

export type Hidden = { workspaces: ReadonlySet<string>; projects: ReadonlySet<string> }

/** The hidden workspaces, and the projects (rooms) that have no visible workspace left. */
export function hiddenView(office: Office): Hidden {
  const root = (path: string): string => office.roots.get(path) ?? path
  const shown = new Set([...office.workspaces.keys()].filter((path) => !office.hidden.has(path)).map(root))
  return { workspaces: office.hidden, projects: new Set([...office.hidden].map(root).filter((project) => !shown.has(project))) }
}

const NOTHING_HIDDEN: Hidden = { workspaces: new Set(), projects: new Set() }

/** What the panel gets: everything but the history, which it does not show, and what Orca hides. */
export function forPanel(state: OfficeSnapshot, reviewedCompletions: string[] = [], hidden: Hidden = NOTHING_HIDDEN): OfficeSnapshot {
  const { completionIdentities: _completions, notificationEpisodes: _episodes, ...fullState } = state
  const publicState = hidden.workspaces.size === 0 ? fullState : {
    ...fullState,
    agents: fullState.agents.filter((agent) => !agent.workspaceId || !hidden.workspaces.has(agent.workspaceId)),
    workspaces: Object.fromEntries(Object.entries(fullState.workspaces).filter(([path]) => !hidden.workspaces.has(path))),
    projects: Object.fromEntries(Object.entries(fullState.projects).filter(([id]) => !hidden.projects.has(id)))
  }
  return bounded({ ...publicState, agents: publicState.agents.map(({ notificationEpisodeId: _episode, notificationTransitionId: _transition, notificationTurnId: _turn, ...agent }) => ({ ...agent, sessionId: null })), journal: [], reviewedCompletions: reviewedCompletions.length ? reviewedCompletions : (state.reviewedCompletions ?? []) }, STORE_BYTES, false)
}

function initialNotificationEpisodeId(agentId: string, stateStartedAt: number): string {
  const legacyId = `${agentId}@${stateStartedAt}`
  return legacyId.length <= 256 ? legacyId : createHash('sha256').update(legacyId).digest('hex')
}

function record(office: Office, agent: AgentView, event: Omit<JournalEvent, 'id' | 'agentId' | 'workspaceId' | 'projectId'>, identity: string): void {
  const id = createHash('sha256').update(JSON.stringify([agent.id, event.kind, identity])).digest('hex')
  if (office.journal.some((entry) => entry.id === id)) return
  office.journal.push({ id, agentId: agent.id, workspaceId: agent.workspaceId,
    projectId: (agent.workspaceId && office.roots.get(agent.workspaceId)) || agent.projectId,
    ...event })
  pruneJournal(office, event.observedAt)
}

export function clearHistory(office: Office): void {
  office.journal = []
}

export function classify(tool: string): ActivityKind {
  const name = tool.toLowerCase()
  if (/web|fetch|browser|http/.test(name)) return 'web'
  if (name === 'agent' || name === 'task') return 'delegate'
  if (/^todo|^task|plan/.test(name)) return 'plan'
  if (/edit|write|patch|replace|create_file/.test(name)) return 'edit'
  if (/read|view|open/.test(name)) return 'read'
  if (/grep|glob|search|find|^ls$|list/.test(name)) return 'search'
  if (/bash|shell|exec|command|terminal/.test(name)) return 'shell'
  return 'tool'
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join(' ')
  return ''
}

/** A short label for a tool call; tool input is whatever the agent sent, so every field is checked. */
export function describe(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return ''
  const fields = input as Record<string, unknown>
  const path = text(fields.file_path ?? fields.path ?? fields.notebook_path)
  const label =
    text(fields.description ?? fields.command ?? fields.cmd ?? fields.pattern ?? fields.query) ||
    path.split(/[\\/]/).pop() ||
    text(fields.url)
      .replace(/^[a-z]+:\/\//i, '')
      .split('/')[0]
  const line = label.trim().split('\n')[0]
  return line.length > DETAIL ? `${line.slice(0, DETAIL - 1)}…` : line
}

function find(office: Office, terminalId?: string | null, paneKey?: string): AgentView | undefined {
  for (const agent of office.agents.values()) {
    if (terminalId && agent.terminalId === terminalId) return agent
    if (paneKey && agent.paneKey === paneKey) return agent
  }
  return undefined
}

function add(office: Office, id: string, now: number, fields: Partial<AgentView>): AgentView {
  const agent: AgentView = {
    id,
    terminalId: null,
    paneKey: null,
    parentPaneKey: null,
    parentId: null,
    workspaceId: null,
    projectId: null,
    branch: null,
    hostId: null,
    hostName: null,
    sessionId: null,
    completionId: null,
    completionTracked: false,
    title: null,
    prompt: null,
    reply: null,
    agent: null,
    state: 'working',
    outcome: null,
    unread: false,
    stateStartedAt: now,
    finishedAt: null,
    finishedAtSource: null,
    firstSeenAt: now,
    lastSeenAt: now,
    active: [],
    recent: [],
    toolCount: 0,
    helpers: [],
    family: [],
    insight: null,
    history: [],
    ...fields,
    notificationEpisodeId: fields.notificationEpisodeId ?? initialNotificationEpisodeId(id, fields.stateStartedAt ?? now),
    notificationTransitionId: fields.notificationTransitionId ?? notificationTransitionId(fields.state ?? 'working', fields.notificationEpisodeId ?? initialNotificationEpisodeId(id, fields.stateStartedAt ?? now))
  }
  office.agents.set(id, agent)
  return agent
}

function completionScope(agent: AgentView): string {
  return createHash('sha256').update(JSON.stringify([agent.hostId || 'local', agent.paneKey || agent.id, agent.sessionId])).digest('hex')
}

function pruneCompletionIdentities(office: Office, now: number): void {
  const entries = [...office.completionIdentities]
    .filter(([, value]) => Number.isFinite(value.observedAt) && value.observedAt > now - JOURNAL_MS)
    .sort(([keyA, a], [keyB, b]) => a.observedAt - b.observedAt || keyA.localeCompare(keyB))
    .slice(-500)
  office.completionIdentities = new Map(entries)
}

function beginCompletion(
  office: Office,
  agent: AgentView,
  now: number,
  sourceAt?: number,
  turnId?: string | null,
  allowReconnectReuse = false,
  freshTransition = false
): void {
  const scope = completionScope(agent)
  if (freshTransition) {
    office.freshCompletionScopes.delete(scope)
    office.freshCompletionScopes.add(scope)
    if (office.freshCompletionScopes.size > 500) office.freshCompletionScopes.delete(office.freshCompletionScopes.values().next().value!)
  }
  const turn = typeof turnId === 'string' && turnId
    ? createHash('sha256').update(turnId).digest('hex')
    : null
  const previous = office.completionIdentities.get(scope)
  let retainedPrevious = previous?.id === agent.completionId
  const conflicts = !!previous && ((sourceAt !== undefined && previous.sourceAt !== null && sourceAt !== previous.sourceAt) ||
    (turn !== null && previous.turnId !== null && turn !== previous.turnId))
  if (agent.completionId && retainedPrevious && conflicts) {
    agent.completionId = null
    agent.completionTracked = false
    retainedPrevious = false
  }
  if (!agent.completionId) {
    // Compatible late evidence enriches an observation; absent discriminators remain ambiguous.
    if (!freshTransition && previous && !conflicts && (allowReconnectReuse || sourceAt !== undefined || turn !== null)) {
      agent.completionId = previous.id
      agent.completionTracked = previous.tracked
      retainedPrevious = true
    } else {
      const discriminator = sourceAt !== undefined || turn !== null
        ? `${freshTransition ? `transition:${now}:` : 'evidence:'}${sourceAt ?? ''}:${turn ?? ''}`
        : `observed:${now}`
      agent.completionId = createHash('sha256').update(JSON.stringify([scope, discriminator])).digest('hex')
      agent.completionTracked = office.attentionTracking
    }
  }
  office.completionIdentities.set(scope, {
    id: agent.completionId,
    sourceAt: retainedPrevious ? previous?.sourceAt ?? sourceAt ?? null : sourceAt ?? null,
    turnId: retainedPrevious ? previous?.turnId ?? turn : turn,
    observedAt: retainedPrevious ? previous?.observedAt ?? now : now,
    tracked: agent.completionTracked
  })
  pruneCompletionIdentities(office, now)
}

/** Moves an agent to a state, keeping its history and the day's tally. A no-op if it is there. */
function enter(
  office: Office,
  agent: AgentView,
  state: AgentState,
  outcome: string | null,
  at: number
): void {
  agent.outcome = outcome
  if (!agent.history.length) agent.history = [{ state: agent.state, at: agent.stateStartedAt }]
  if (agent.state === state) return
  const day = new Date(at).toDateString()
  if (office.today.day !== day) office.today = { day, finished: 0, failed: 0, blockedMs: 0 }
  if (agent.state === 'blocked') office.today.blockedMs += Math.max(0, at - agent.stateStartedAt)
  if (state === 'done' && agent.state === 'working') {
    office.today.finished += 1
    if (outcome === 'failure') office.today.failed += 1
  }
  agent.state = state
  agent.stateStartedAt = at
  agent.notificationEpisodeId = initialNotificationEpisodeId(agent.id, at)
  agent.notificationTransitionId = notificationTransitionId(state, agent.notificationEpisodeId)
  agent.notificationTurnId = undefined
  agent.history = [...agent.history, { state, at }].filter((step) => at - step.at < HISTORY_MS)
}

function finish(agent: AgentView, call: Activity, now: number): void {
  agent.active = agent.active.filter((other) => other !== call)
  agent.recent = [{ ...call, endedAt: now }, ...agent.recent].slice(0, RECENT)
}

export function applyStatus(office: Office, event: StatusEvent): void {
  const now = event.receivedAt
  const known = find(office, event.terminalId, event.paneKey)
  // With Orca's list in, an agent it does not list is not in the office.
  if (!known && office.rostered) return
  const agent = known ?? add(office, event.terminalId ?? event.paneKey, now, { state: event.state })
  const transitionedToDone = known !== undefined && known.state !== 'done' && event.state === 'done'
  agent.paneKey = event.paneKey
  agent.terminalId = event.terminalId ?? agent.terminalId
  agent.workspaceId = event.workspaceId ?? agent.workspaceId
  agent.title = event.title ?? agent.title
  const sessionId = typeof (event as unknown as { sessionId?: unknown }).sessionId === 'string'
    ? (event as unknown as { sessionId: string }).sessionId
    : null
  const sessionChanged = !!(agent.sessionId && sessionId && agent.sessionId !== sessionId)
  if (sessionId) agent.sessionId = clip(sessionId, 200)
  if (sessionChanged && event.state === 'done') {
    agent.completionId = null
    agent.completionTracked = false
  }
  // A chat has no terminal for `agents.list` to name its kind by, but its pane key starts with it.
  agent.agent ??= /^structured-agent-session-([a-z]+)_/.exec(event.paneKey)?.[1] ?? null
  agent.lastSeenAt = now
  const statusSourceAt = event.mainAgent?.stateStartedAt
  const sourceAt = typeof statusSourceAt === 'number' && Number.isFinite(statusSourceAt) ? statusSourceAt : undefined
  if (!known || agent.state !== event.state) record(office, agent, {
    kind: known ? 'state' : 'observed', source: 'status', coverage: 'event', observedAt: now,
    ...(sourceAt === undefined ? {} : { sourceAt }), state: event.state,
    outcome: event.state === 'done' ? (event.mainAgent?.outcome ?? null) : null
  }, `${event.state}:${sourceAt ?? now}`)
  enter(
    office,
    agent,
    event.state,
    event.state === 'done' ? (event.mainAgent?.outcome ?? (agent.state === 'done' ? agent.outcome : null)) : null,
    now
  )
  if (sessionChanged && known && known.state === event.state) {
    agent.notificationEpisodeId = freshNotificationEpisodeId(agent.id, now, fingerprint(sessionId))
    agent.notificationTransitionId = notificationTransitionId(event.state, agent.notificationEpisodeId)
  }
  if (event.state === 'done') {
    const reportedAt = event.mainAgent?.stateStartedAt
    const turnId = typeof (event as unknown as { turnId?: unknown }).turnId === 'string'
      ? (event as unknown as { turnId: string }).turnId
      : null
    if (typeof reportedAt === 'number' && Number.isFinite(reportedAt)) {
      agent.finishedAt = reportedAt
      agent.finishedAtSource = 'source'
    } else if (transitionedToDone) {
      agent.finishedAt = now
      agent.finishedAtSource = 'observed'
    }
    beginCompletion(office, agent, now, sourceAt, turnId, !known, transitionedToDone)
  } else {
    agent.finishedAt = null
    agent.finishedAtSource = null
    agent.completionId = null
    agent.completionTracked = false
  }
  // A turn that ended leaves no call running, whatever `agent.tool.after` we missed.
  if (event.state === 'done' || event.state === 'waiting') {
    for (const call of agent.active) finish(agent, call, now)
  }
}

/** The agent a tool call belongs to: by terminal, or the only agent of that kind in the workspace. */
function toolAgent(office: Office, event: ToolEvent, now: number): AgentView | undefined {
  if (event.terminalId) {
    return (
      find(office, event.terminalId) ??
      add(office, event.terminalId, now, { terminalId: event.terminalId })
    )
  }
  const candidates = [...office.agents.values()].filter(
    (agent) =>
      agent.workspaceId === event.workspaceId && (!agent.agent || agent.agent === event.agent)
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

export function applyToolBefore(office: Office, event: ToolEvent, now: number): void {
  const agent = toolAgent(office, event, now)
  if (!agent) return
  agent.agent = event.agent
  agent.workspaceId = event.workspaceId ?? agent.workspaceId
  agent.lastSeenAt = now
  agent.active.push({
    callId: event.callId ?? `${event.tool}:${now}:${agent.toolCount + agent.active.length}`,
    tool: event.tool,
    kind: classify(event.tool),
    detail: describe(event.input),
    startedAt: now
  })
  const call = agent.active[agent.active.length - 1]
  record(office, agent, { kind: 'tool', source: 'hook', coverage: 'event', observedAt: now,
    tool: clip(event.tool, DETAIL) ?? '', detail: call.detail, callId: clip(call.callId, 200) ?? '' }, call.callId)
}

export function applyToolAfter(office: Office, event: ToolEvent, now: number): void {
  const agent = toolAgent(office, event, now)
  if (!agent) return
  agent.agent = event.agent
  agent.lastSeenAt = now
  agent.toolCount += 1
  const call =
    agent.active.find((other) => event.callId !== undefined && other.callId === event.callId) ??
    agent.active.find((other) => other.tool === event.tool)
  // The worker may have started after the call did: record it as one that just ran.
  if (!call) record(office, agent, { kind: 'tool', source: 'hook', coverage: 'event', observedAt: now,
    tool: clip(event.tool, DETAIL) ?? '', detail: describe(event.input), callId: clip(event.callId ?? `${event.tool}:${now}`, 200) ?? ''
  }, event.callId ?? `${event.tool}:${now}`)
  finish(
    agent,
    call ?? {
      callId: event.callId ?? `${event.tool}:${now}`,
      tool: event.tool,
      kind: classify(event.tool),
      detail: describe(event.input),
      startedAt: now
    },
    now
  )
}

const clip = (text: string | null | undefined, max: number): string | null => {
  const line = (text ?? '').trim()
  return line ? (line.length > max ? `${line.slice(0, max - 1)}…` : line) : null
}

/** Makes the office match Orca's own list: who is in, their state, what they were asked, the call
 *  a chat is on, and the subagents and background commands each waits on. */
export function applyRoster(office: Office, worktrees: RosterWorktree[], now: number): void {
  office.rostered = true
  const listed = new Set<string>()
  for (const worktree of worktrees) {
    if (typeof worktree?.path !== 'string') continue
    if (worktree.displayName) office.workspaces.set(worktree.path, worktree.displayName)
    if (worktree.repoId) {
      office.roots.set(worktree.path, worktree.repoId)
      office.projects.set(worktree.repoId, worktree.repo || worktree.repoId)
    }
    const links = new Map<string, Link>()
    for (const item of worktree.linkedItems ?? []) {
      if (typeof item?.url !== 'string' || !/^https?:\/\//.test(item.url)) continue
      links.set(item.url, {
        label: `${item.type === 'pr' ? 'PR' : (item.type ?? 'Link')} #${item.number ?? ''}`,
        url: item.url
      })
    }
    office.links.set(worktree.path, [...links.values()].slice(-LINKS))
    for (const row of worktree.agents ?? []) {
      if (typeof row?.paneKey !== 'string' || row.activity?.listed === false) continue
      listed.add(row.paneKey)
      const sourceAt = typeof row.stateStartedAt === 'number' && Number.isFinite(row.stateStartedAt) ? row.stateStartedAt : undefined
      const rowSessionId = fingerprint(row.sessionId)
      const rowTurnId = fingerprint(row.turnId)
      const known = find(office, null, row.paneKey)
      const episodeScope = notificationEpisodeScope(worktree.hostId ?? null, row.paneKey, row.paneKey)
      const disconnected = known ? undefined : office.notificationEpisodes.get(episodeScope)
      const agent =
        known ??
        // Born in the state it is first seen in: a turn that ended before then is not tallied.
        add(office, row.paneKey, now, {
          paneKey: row.paneKey,
          state: row.state,
          notificationTurnId: rowTurnId ?? undefined,
          ...(typeof row.stateStartedAt === 'number' && Number.isFinite(row.stateStartedAt) ? { stateStartedAt: row.stateStartedAt } : {})
        })
      if (disconnected) {
        const conflictingSession = disconnected.sessionId !== null && rowSessionId !== null && disconnected.sessionId !== rowSessionId
        const conflictingTurn = disconnected.turnId !== null && rowTurnId !== null && disconnected.turnId !== rowTurnId
        const laterEpisode = sourceAt !== undefined && sourceAt > disconnected.stateStartedAt
        if (row.state === disconnected.state && !conflictingSession && !conflictingTurn && !laterEpisode) {
          agent.notificationEpisodeId = disconnected.id
          agent.notificationTransitionId = disconnected.transitionId
          agent.notificationTurnId = rowTurnId ?? disconnected.turnId ?? undefined
        } else if (row.state === disconnected.state) {
          const discriminator = rowTurnId ?? rowSessionId ?? String(sourceAt ?? now)
          agent.notificationEpisodeId = freshNotificationEpisodeId(agent.id, sourceAt ?? now, discriminator)
          agent.notificationTransitionId = notificationTransitionId(row.state, agent.notificationEpisodeId)
        }
        office.notificationEpisodes.delete(episodeScope)
      }
      const wasDone = agent.state === 'done'
      const transitionedToDone = known !== undefined && !wasDone && row.state === 'done'
      agent.workspaceId = worktree.path
      agent.branch = typeof worktree.branch === 'string' && worktree.branch ? worktree.branch : agent.branch
      agent.hostId = typeof worktree.hostId === 'string' && worktree.hostId ? worktree.hostId : agent.hostId
      agent.hostName = typeof worktree.hostName === 'string' && worktree.hostName ? worktree.hostName : agent.hostName
      const sessionChanged = !!(agent.sessionId && row.sessionId && agent.sessionId !== row.sessionId)
      const previousTurnId = agent.notificationTurnId ?? null
      const sameStateNewEpisode = known !== undefined && agent.state === row.state && (
        (sessionChanged && rowSessionId !== null) || (previousTurnId !== null && rowTurnId !== null && previousTurnId !== rowTurnId) ||
        (sourceAt !== undefined && sourceAt > agent.stateStartedAt)
      )
      if (typeof row.sessionId === 'string' && row.sessionId) agent.sessionId = clip(row.sessionId, 200)
      if (sessionChanged && row.state === 'done') {
        agent.completionId = null
        agent.completionTracked = false
      }
      agent.parentPaneKey = typeof row.parentPaneKey === 'string' && row.parentPaneKey ? row.parentPaneKey : null
      agent.agent = row.agentType ?? agent.agent
      agent.title = row.conversationName ?? agent.title
      agent.prompt = clip(row.prompt, MESSAGE)
      const reply = clip(row.lastAssistantMessage, MESSAGE)
      if (!known || agent.state !== row.state) record(office, agent, {
        kind: known ? 'state' : 'observed', source: 'roster', coverage: 'sampled', observedAt: now,
        ...(sourceAt === undefined ? {} : { sourceAt }), state: row.state,
        outcome: row.state === 'done' ? (row.mainAgent?.outcome ?? null) : null
      }, `${row.state}:${sourceAt ?? now}`)
      if (reply && reply !== agent.reply) record(office, agent, {
        kind: 'result', source: 'roster', coverage: 'sampled', observedAt: now, result: reply
      }, `${now}`)
      agent.reply = reply
      enter(
        office,
        agent,
        row.state,
        row.state === 'done' ? (row.mainAgent?.outcome ?? (wasDone ? agent.outcome : null)) : null,
        row.stateStartedAt ?? now
      )
      agent.stateStartedAt = row.stateStartedAt ?? agent.stateStartedAt
      if (sameStateNewEpisode) {
        const discriminator = rowTurnId ?? rowSessionId ?? String(sourceAt ?? now)
        agent.notificationEpisodeId = freshNotificationEpisodeId(agent.id, sourceAt ?? now, discriminator)
        agent.notificationTransitionId = notificationTransitionId(row.state, agent.notificationEpisodeId)
      }
      if (rowTurnId) agent.notificationTurnId = rowTurnId
      if (row.state !== 'done') {
        agent.finishedAt = null
        agent.finishedAtSource = null
      } else if (typeof row.stateStartedAt === 'number' && Number.isFinite(row.stateStartedAt)) {
        agent.finishedAt = row.stateStartedAt
        agent.finishedAtSource = 'source'
      } else if (!wasDone) {
        agent.finishedAt = now
        agent.finishedAtSource = 'observed'
      }
      if (row.state === 'done') beginCompletion(office, agent, now, sourceAt, row.turnId, !known, transitionedToDone)
      else {
        agent.completionId = null
        agent.completionTracked = false
      }
      agent.unread = row.activity?.unread === true
      agent.lastSeenAt = Math.max(agent.lastSeenAt, row.updatedAt ?? 0)
      const previousChildren = agent.family
      const currentChildren = new Map<string, FamilyChild>()
      for (const [index, child] of (row.children ?? []).entries()) {
        if (!child || typeof child !== 'object' || child.kind !== 'agent') continue
        const kind = 'agent' as const
        const id = typeof child.id === 'string' ? child.id : ''
        const key = id ? id : `unknown:${index}`
        const state = child.state === 'working' || child.state === 'blocked' || child.state === 'waiting' || child.state === 'done'
          ? child.state
          : 'unknown'
        const helper: FamilyChild = {
          id,
          kind,
          name: clip(child.name, 100) ?? (id ? 'Agent child' : 'Unidentified agent'),
          description: clip(child.description, DETAIL) ?? '',
          tool: child.operation?.toolName ?? null,
          toolKind: child.operation?.toolName ? classify(child.operation.toolName) : null,
          state,
          reported: true,
          lastReportedAt: now,
          missingSince: null
        }
        currentChildren.set(key, helper)
      }
      const retainedChildren = previousChildren
        .filter((helper) => helper.id && !currentChildren.has(helper.id))
        .map((helper) => ({
          ...helper,
          reported: false,
          missingSince: helper.missingSince ?? now
        }))
        .filter((helper) => now - (helper.missingSince ?? now) < HELPER_RETENTION_MS)
        .sort((a, b) => (b.missingSince ?? 0) - (a.missingSince ?? 0) || a.id.localeCompare(b.id))
        .slice(0, HELPER_HISTORY)
      agent.family = [
        ...[...currentChildren.values()]
          .sort((a, b) => (a.id || `~${a.name}`).localeCompare(b.id || `~${b.name}`))
          .slice(0, HELPER_LIVE),
        ...retainedChildren
      ]
      agent.helpers = (row.children ?? [])
        .filter((child) =>
          (child.kind === 'agent' || child.kind === 'command') &&
          (child.state === 'working' || child.state === 'blocked' || child.state === 'waiting')
        )
        .map((child) => ({
          id: child.id ?? '',
          kind: child.kind as 'agent' | 'command',
          name: clip(child.name, 100) ?? (child.kind === 'agent' ? 'agent' : 'command'),
          description: clip(child.description, DETAIL) ?? '',
          tool: child.operation?.toolName ?? null,
          toolKind: child.operation?.toolName ? classify(child.operation.toolName) : null
        }))

      // Hooks report a terminal agent's calls one by one; for a chat this list is all there is.
      if (agent.terminalId) continue
      const detail = clip(row.toolInput?.split('\n')[0], DETAIL) ?? ''
      const [current] = agent.active
      if (current && (current.tool !== row.toolName || current.detail !== detail)) {
        finish(agent, current, now)
        agent.toolCount += 1
      }
      const toolKey = row.toolName ? JSON.stringify([row.toolName, detail]) : ''
      if (row.toolName && office.rosterTools.get(agent.id) !== toolKey) {
        record(office, agent, { kind: 'tool', source: 'roster', coverage: 'sampled', observedAt: now,
          tool: clip(row.toolName, DETAIL) ?? '', detail }, `${now}`)
      }
      office.rosterTools.set(agent.id, toolKey)
      if (row.toolName && !agent.active.length) {
        agent.active = [
          {
            callId: `listed:${now}`,
            tool: row.toolName,
            kind: classify(row.toolName),
            detail,
            startedAt: now
          }
        ]
      }
    }
  }
  for (const agent of office.agents.values()) {
    if (!agent.paneKey || !listed.has(agent.paneKey)) {
      record(office, agent, { kind: 'disappeared', source: 'roster', coverage: 'sampled', observedAt: now }, `${now}`)
      rememberNotificationEpisode(office, agent, now)
      office.agents.delete(agent.id)
      office.rosterTools.delete(agent.id)
    }
  }
  pruneNotificationEpisodes(office, now)
  resolveParents(office)
}

/** Seeds identities for old done agents, then treats later done transitions as reviewable. */
export function startAttentionTracking(office: Office, now: number): void {
  for (const agent of office.agents.values()) {
    if (agent.state !== 'done') continue
    if (!agent.completionId) agent.completionTracked = false
    beginCompletion(office, agent, now, agent.finishedAt ?? undefined)
  }
  office.attentionTracking = true
}

/** Links each agent to the one listed agent whose `paneKey` is exactly its `parentPaneKey`, in any
 *  worktree. An absent, unlisted, self or duplicated parent leaves `parentId` null. */
function resolveParents(office: Office): void {
  const byPane = new Map<string, string | null>()
  for (const agent of office.agents.values()) {
    if (!agent.paneKey) continue
    byPane.set(agent.paneKey, byPane.has(agent.paneKey) ? null : agent.id)
  }
  for (const agent of office.agents.values()) {
    const parentId = agent.parentPaneKey ? byPane.get(agent.parentPaneKey) ?? null : null
    agent.parentId = parentId === agent.id ? null : parentId
  }
}

/** Fills in what `agents.list` knows about the focused workspace's agents. */
export function applyListed(
  office: Office,
  workspaceId: string | null,
  listed: (ListedAgent & Pick<AgentView, 'state' | 'stateStartedAt'>)[],
  now: number
): void {
  for (const item of listed) {
    if (!item.terminalId) continue
    const agent =
      find(office, item.terminalId) ??
      add(office, item.terminalId, now, {
        terminalId: item.terminalId,
        state: item.state,
        stateStartedAt: item.stateStartedAt
      })
    const wasDone = agent.state === 'done'
    agent.agent = item.agent ?? agent.agent
    agent.title = item.title ?? agent.title
    agent.workspaceId = workspaceId ?? agent.workspaceId
    if (item.state !== 'done') {
      agent.finishedAt = null
      agent.finishedAtSource = null
    } else if (typeof item.stateStartedAt === 'number' && Number.isFinite(item.stateStartedAt)) {
      agent.finishedAt = item.stateStartedAt
      agent.finishedAtSource = 'source'
    } else if (!wasDone) {
      agent.finishedAt = now
      agent.finishedAtSource = 'observed'
    }
  }
}

/** Drops the agents of `workspaceId` whose terminal is no longer open. */
export function keepTerminals(office: Office, workspaceId: string, terminalIds: string[], now = Date.now()): void {
  for (const agent of office.agents.values()) {
    if (agent.workspaceId !== workspaceId || !agent.terminalId) continue
    if (!terminalIds.includes(agent.terminalId)) {
      record(office, agent, { kind: 'disappeared', source: 'workspace', coverage: 'sampled', observedAt: now }, `${now}`)
      office.agents.delete(agent.id)
    }
  }
}

export function removeWorkspace(office: Office, workspaceId: string, now = Date.now()): void {
  for (const agent of office.agents.values()) {
    if (agent.workspaceId === workspaceId) {
      record(office, agent, { kind: 'disappeared', source: 'workspace', coverage: 'event', observedAt: now }, `${now}`)
      office.agents.delete(agent.id)
    }
  }
  office.workspaces.delete(workspaceId)
}

export function prune(office: Office, now: number): void {
  pruneJournal(office, now)
  if (office.rostered) return
  for (const agent of office.agents.values()) {
    if (agent.state !== 'working' && now - agent.lastSeenAt > IDLE_MS) {
      record(office, agent, { kind: 'disappeared', source: 'local', coverage: 'sampled', observedAt: now }, `${now}`)
      office.agents.delete(agent.id)
    }
  }
}

/** The main checkout a workspace belongs to, read from its `.git`: a linked worktree has a file
 *  there that points into the main checkout; a main checkout (a folder) or no Git has `null`. */
export function projectRoot(path: string, gitFile: string | null): string {
  return /^gitdir: (.+?)[\\/]\.git[\\/]worktrees[\\/]/m.exec(gitFile ?? '')?.[1] ?? path
}

/** Orca lists its repos in sidebar order; a project is found by repo id (the roster's) or by path. */
export function applyRepos(office: Office, repos: { id?: unknown; path?: unknown }[]): void {
  office.sidebar.clear()
  repos.forEach((repo, index) => {
    for (const key of [repo.id, repo.path]) if (typeof key === 'string' && !office.sidebar.has(key)) office.sidebar.set(key, index)
  })
}

export function placeWorkspace(office: Office, path: string, root: string): void {
  office.roots.set(path, root)
  office.projects.set(root, root.split(/[\\/]/).pop() || root)
}

export function snapshot(office: Office): OfficeSnapshot {
  for (const agent of office.agents.values()) {
    // Rebuild the public insight shape so legacy guessed token fields cannot leak out.
    agent.insight = safeInsight(agent.insight)
    agent.projectId =
      (agent.workspaceId && office.roots.get(agent.workspaceId)) ?? agent.projectId ?? null
    // Without Orca's list, a subagent is known only as an `Agent` call still in flight.
    if (!office.rostered) {
      agent.helpers = agent.active
        .filter((call) => call.kind === 'delegate')
        .map((call) => ({
          id: call.callId,
          kind: 'agent',
          name: 'subagent',
          description: call.detail,
          tool: null,
          toolKind: null
        }))
      agent.family = []
    }
  }
  return {
    journal: office.journal.slice(),
    completionIdentities: Object.fromEntries(office.completionIdentities),
    notificationEpisodes: Object.fromEntries(office.notificationEpisodes),
    agents: [...office.agents.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt).map((agent) => {
      if (agent.notificationTurnId !== undefined) return agent
      const { notificationTurnId: _turn, ...storedAgent } = agent
      return storedAgent
    }),
    workspaces: Object.fromEntries(office.workspaces),
    projects: Object.fromEntries(office.projects),
    ...(office.sidebar.size ? { sidebar: Object.fromEntries(office.sidebar) } : {}),
    changes: Object.fromEntries(office.changes),
    links: Object.fromEntries(office.links),
    can: office.can,
    today: office.today,
    ...(office.usage ? { usage: usageSnapshot(office, office.usage) } : {})
  }
}

/** Workspace totals, plus the same summed into the project each workspace belongs to. */
function usageSnapshot(office: Office, usage: NonNullable<Office['usage']>): NonNullable<OfficeSnapshot['usage']> {
  const projects: Record<string, Usage> = {}
  for (const [path, used] of usage.workspaces) {
    const project = office.roots.get(path) ?? path
    projects[project] = addUsage(projects[project] ?? emptyUsage(), used)
  }
  return { day: usage.day, workspaces: Object.fromEntries(usage.workspaces), projects }
}

function safeInsight(value: unknown, clearUnverifiedModel = false): Insight | null {
  if (!value || typeof value !== 'object') return null
  const old = value as Partial<Insight>
  return {
    model: !clearUnverifiedModel && typeof old.model === 'string' ? old.model : null,
    todos: Array.isArray(old.todos) ? old.todos : [],
    files: Array.isArray(old.files) ? old.files.filter((file): file is string => typeof file === 'string') : []
  }
}

/** Reads back what `snapshot` stored; calls that were running then are not running now. */
export function restore(office: Office, stored: unknown, now: number, preserveLive = false, rosterObserved = office.rostered): void {
  const { agents, today, journal, completionIdentities, notificationEpisodes } = (stored as Partial<OfficeSnapshot> | null) ?? {}
  const restoredEpisodes = notificationEpisodes && typeof notificationEpisodes === 'object' && !Array.isArray(notificationEpisodes)
    ? Object.entries(notificationEpisodes).filter(([key, entry]) => /^[a-f0-9]{64}$/.test(key) && entry &&
      typeof entry.id === 'string' && utf8Length(entry.id) <= 256 &&
      typeof entry.transitionId === 'string' && utf8Length(entry.transitionId) <= 256 &&
      (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting' || entry.state === 'done') &&
      Number.isFinite(entry.stateStartedAt) && Number.isFinite(entry.observedAt) && entry.observedAt > now - JOURNAL_MS && entry.observedAt <= now &&
      (entry.sessionId === null || /^[a-f0-9]{64}$/.test(entry.sessionId)) &&
      (entry.turnId === null || /^[a-f0-9]{64}$/.test(entry.turnId))
    ).sort(([keyA, a], [keyB, b]) => a.observedAt - b.observedAt || keyA.localeCompare(keyB)).slice(-NOTIFICATION_EPISODE_LIMIT)
    : []
  const mergedEpisodes = new Map(restoredEpisodes)
  if (preserveLive) {
    for (const [key, live] of office.notificationEpisodes) {
      const previous = mergedEpisodes.get(key)
      if (!previous || live.observedAt >= previous.observedAt) mergedEpisodes.set(key, live)
    }
  }
  office.notificationEpisodes = mergedEpisodes
  pruneNotificationEpisodes(office, now)
  if (completionIdentities && typeof completionIdentities === 'object' && !Array.isArray(completionIdentities)) {
    const identities = Object.entries(completionIdentities).filter(([key, entry]) =>
      /^[a-f0-9]{64}$/.test(key) && entry && /^[a-f0-9]{64}$/.test(entry.id) &&
      Number.isFinite(entry.observedAt) && entry.observedAt > now - JOURNAL_MS &&
      (entry.sourceAt === null || Number.isFinite(entry.sourceAt)) &&
      (entry.turnId === null || typeof entry.turnId === 'string') && typeof entry.tracked === 'boolean'
    ).sort(([keyA, a], [keyB, b]) => a.observedAt - b.observedAt || keyA.localeCompare(keyB)).slice(-500)
    const restored = new Map(identities)
    const liveIdentities = preserveLive ? office.completionIdentities : new Map()
    const liveAgents = preserveLive
      ? new Map([...office.agents.values()].map((agent) => [completionScope(agent), agent]))
      : new Map<string, AgentView>()
    for (const [scope, live] of liveIdentities) {
      const previous = restored.get(scope)
      const conflicts = !!previous && ((previous.sourceAt !== null && live.sourceAt !== null && previous.sourceAt !== live.sourceAt) ||
        (previous.turnId !== null && live.turnId !== null && previous.turnId !== live.turnId))
      if (!previous || conflicts || office.freshCompletionScopes.has(scope)) {
        restored.set(scope, live)
      } else {
        restored.set(scope, { ...previous, sourceAt: previous.sourceAt ?? live.sourceAt, turnId: previous.turnId ?? live.turnId })
        const current = liveAgents.get(scope)
        if (current?.state === 'done') {
          current.completionId = previous.id
          current.completionTracked = previous.tracked
        }
      }
    }
    office.completionIdentities = restored
    if (preserveLive) office.freshCompletionScopes.clear()
  }
  if (Array.isArray(journal)) {
    const entries = journal.filter((event) => event && typeof event.id === 'string' && typeof event.agentId === 'string' && typeof event.observedAt === 'number')
    office.journal = [...new Map([...entries, ...office.journal].map((event) => [event.id, event])).values()]
    pruneJournal(office, now)
  }
  if (!Array.isArray(agents)) return
  if (today?.day === new Date(now).toDateString() && (!preserveLive || office.today.day !== today.day)) office.today = today
  for (const agent of agents) {
    if (typeof agent?.id !== 'string' || office.agents.has(agent.id) || (preserveLive && rosterObserved)) continue
    // Remember a sampled call for deduplication without restoring it as running.
    const active = Array.isArray(agent.active) ? agent.active[0] : undefined
    if (!agent.terminalId && active && typeof active.tool === 'string') {
      office.rosterTools.set(agent.id, JSON.stringify([active.tool, active.detail ?? '']))
    }
    // A record stored by an older version lacks the newer fields.
    office.agents.set(agent.id, {
      ...agent,
      branch: typeof agent.branch === 'string' ? agent.branch : null,
      hostId: typeof agent.hostId === 'string' ? agent.hostId : null,
      hostName: typeof agent.hostName === 'string' ? agent.hostName : null,
      sessionId: typeof agent.sessionId === 'string' ? agent.sessionId : null,
      notificationEpisodeId: typeof agent.notificationEpisodeId === 'string' && agent.notificationEpisodeId.length > 0 && agent.notificationEpisodeId.length <= 256
        ? agent.notificationEpisodeId
        : initialNotificationEpisodeId(agent.id, Number.isFinite(agent.stateStartedAt) ? agent.stateStartedAt : now),
      notificationTransitionId: typeof agent.notificationTransitionId === 'string' && utf8Length(agent.notificationTransitionId) <= 256
        ? agent.notificationTransitionId
        : notificationTransitionId(agent.state,
          typeof agent.notificationEpisodeId === 'string' ? agent.notificationEpisodeId : initialNotificationEpisodeId(agent.id, Number.isFinite(agent.stateStartedAt) ? agent.stateStartedAt : now)),
      notificationTurnId: typeof agent.notificationTurnId === 'string' && /^[a-f0-9]{64}$/.test(agent.notificationTurnId)
        ? agent.notificationTurnId
        : undefined,
      completionId: typeof agent.completionId === 'string' ? agent.completionId : null,
      completionTracked: agent.completionTracked === true,
      parentPaneKey: typeof agent.parentPaneKey === 'string' ? agent.parentPaneKey : null,
      parentId: typeof agent.parentId === 'string' ? agent.parentId : null,
      title: agent.title ?? null,
      agent: agent.agent ?? null,
      outcome: agent.outcome ?? null,
      prompt: agent.prompt ?? null,
      reply: agent.reply ?? null,
      unread: false,
      finishedAt: typeof agent.finishedAt === 'number' && Number.isFinite(agent.finishedAt)
        ? agent.finishedAt
        : null,
      finishedAtSource: agent.finishedAtSource === 'source' || agent.finishedAtSource === 'observed' || agent.finishedAtSource === 'unknown'
        ? agent.finishedAtSource
        : typeof agent.finishedAt === 'number' && Number.isFinite(agent.finishedAt) ? 'unknown' : null,
      insight: safeInsight(agent.insight, true),
      context: null,
      recent: Array.isArray(agent.recent) ? agent.recent : [],
      toolCount: Number.isFinite(agent.toolCount) ? agent.toolCount : 0,
      history: agent.history ?? [],
      active: [],
      helpers: [],
      family: []
    })
  }
  prune(office, now)
}
