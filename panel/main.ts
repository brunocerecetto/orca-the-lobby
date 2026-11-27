// The panel: under its sign, asks the worker for the office and shows each project as a room,
// drawn on a canvas, with the list of its agents underneath.
// Orca transpiles this file when the panel loads; `orca` is the frame global.
import {
  PREFS_KEY,
  INSTALLATION_KEY,
  STUCK_CHOICES,
  contextFill,
  overdue,
  readPrefs,
  workspaceContext,
  usageTotal,
  type ActionResult,
  type Activity,
  type AgentActions,
  type AgentContext,
  type AgentView,
  type OfficeSnapshot,
  type NotificationControlState,
  type PaletteChoice,
  type Prefs,
  type Usage
} from '../src/protocol'
import { BANNER_ROWS, drawBanner } from './banner'
import {
  activityTimeText,
  agentCounts,
  currentStatus,
  focusTarget,
  restoreFocus,
  shouldRenderOfficeFrame,
  shouldRefreshOffice,
  tabTargetIndex,
  timeRefreshBucket,
  viewActivityFocusKey
} from './navigation'
import { assignAgentNames, coordinatorIds, readAgentNames } from './names'
import { moveProject, orderProjects, projectGroups, taskLabel } from './work-map'
import { chartLayout, needsAttention, hasAttention, attentionBranches, NODE_WIDTH, NODE_HEIGHT } from './chart'
import { buildFamilyTree, syncFamilyExpansion, type FamilyNode } from './family'
import { refreshAttentionTimes, renderAttention } from './attention'
import { renderNotificationControls, type NotificationProjectRow, type NotificationReminderRow } from './notification-settings'
import { filterAgents } from './search'
import { PALETTES, PALETTE_OPTIONS, paletteVariables } from './palettes'
import {
  agentName,
  draw,
  layout,
  lookOf,
  observedActivity,
  paletteFor,
  bubbleFor,
  pick,
  pickBubble,
  periodOfHour,
  portrait,
  shown,
  step,
  type Actor,
  type Bubble,
  type PlacedBubble,
  type Room
} from './scene'

/** A timer, not requestAnimationFrame: Orca also draws the panel in a hidden window. */
const FRAME_MS = 33
const BEAT_MS = 250
/** How many office pixels wide the picture aims to be: more makes everything smaller. */
const TARGET_WIDTH = 190
/** Below this panel width two columns clip names and scenes, so Grid stays one per line. */
const GRID_MIN_WIDTH = 400
const GRID_GAP = 10

const banner = document.getElementById('banner') as HTMLCanvasElement
const bannerCtx = banner.getContext('2d') as CanvasRenderingContext2D
const officeMessage = document.getElementById('office-message') as HTMLElement
const hover = document.getElementById('hover') as HTMLElement
const today = document.getElementById('today') as HTMLElement
const primaryTabs = [...document.querySelectorAll<HTMLButtonElement>('.primary-tab')]
const pages = [...document.querySelectorAll<HTMLElement>('.page')]
const activityList = document.getElementById('activity-list') as HTMLElement
const settings = document.getElementById('settings') as HTMLElement
const notificationRows = document.createElement('div')
notificationRows.tabIndex = -1
const attentionList = document.getElementById('attention-list') as HTMLElement
type NotificationTarget = { signature: string; state: NotificationControlState | null; loading: boolean; busy: boolean; message: string; writeFailureMessage?: string; retry?: () => void; retryKind?: 'read' | 'write'; focusKey?: string; focusRevision?: number; generation: number }
const notificationProjects = new Map<string, NotificationTarget>()
const notificationReminders = new Map<string, NotificationTarget>()
const notificationExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>()
let notificationFocusRevision = 0
let restoringNotificationFocus = false
document.addEventListener('focusin', () => {
  if (!restoringNotificationFocus) notificationFocusRevision++
})
const attentionFeedback = document.getElementById('attention-feedback') as HTMLElement
const filterBar = document.getElementById('view-filters') as HTMLElement
let searchText = ''
let projectFilter = 'all'
/** Calls shown on a card before "Show all". */
const CALLS = 8
const AGENT_NAMES_KEY = 'friendly-agent-names'
const offices = document.getElementById('offices') as HTMLElement
/** Above the rooms: agent counts and the List / Grid toggle. */
const officeBar = document.createElement('div')
officeBar.className = 'page-bar'
const calm = window.matchMedia('(prefers-reduced-motion: reduce)')

let office: OfficeSnapshot = {
  agents: [],
  journal: [],
  workspaces: {},
  projects: {},
  changes: {},
  links: {},
  can: { open: false },
  today: { day: '', finished: 0, failed: 0, blockedMs: 0 }
}
let agentNames = new Map<string, string>()
const agentNamesReady = orca.storage
  .get(AGENT_NAMES_KEY)
  .then((value) => {
    agentNames = readAgentNames(value)
  })
  .catch(() => {})
let selected: string | null = null
let attentionDrawerAgent: string | null = null
const reviewPending = new Set<string>()
const reviewErrors = new Map<string, string>()
let currentPage = 'office'
let activityRenderKey = ''
let activitySelected: string | null = null
let activityHelper: string | null = null
let anonymousHelperSignature: string | null = null
/** 'attention' de-emphasizes agents that are not blocked or failed; nothing is hidden. */
let activityFilter: 'all' | 'attention' = 'all'
/** Each project keeps a separate scroll position per filter. */
const chartKey = (projectId: string, filter = activityFilter): string => filter === 'attention' ? `${projectId}#attention` : projectId
const chartPositions = new Map<string, number>()
const chartInitialized = new Set<string>()
const expandedFamilies = new Set<string>()
const seenFamilyBranches = new Set<string>()
let hovered: string | null = null
const actors = new Map<string, Actor>()
/** One section of the page per room: its picture and its agents. */
type Section = {
  root: HTMLElement
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  list: HTMLElement
  /** Today's tokens for the room's project. */
  usage: HTMLElement
  room: Room
  /** Where the speech bubbles were last drawn, to click them. */
  bubbles: PlacedBubble[]
  /** The ↑ ↓ buttons over the sign. */
  move: HTMLElement
}
const sections = new Map<string, Section>()
let rooms: Room[] = []
/** Rooms the person folded (true) or unfolded (false) themselves. */
const folded = new Map<string, boolean>()
let width = 0
let scale = 2
let placed = false
let listed = ''
let painted = ''
let last = performance.now()
let prefs: Prefs = readPrefs(null)
/** The agent whose whole call log is open. */
let allCalls: string | null = null
/** The parts of cards the person opened, as `<agent id>:<part>`: kept while the list redraws. */
const opened = new Set<string>()
/** The last total each counting tab showed, to notice a new one. */
const totals = new Map<string, number>()
/** The tab open on each agent's card, by agent id; none until the person picks one. */
const picked = new Map<string, string>()
/** Holds the office still: the system asks for less motion, or the person turned it off. */
const still = (): boolean => calm.matches || !prefs.animate

/** 2.6M, 840k, 950: short token counts. */
function tokens(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1e3) return `${Math.round(count / 1e3)}k`
  return String(count)
}

/** `claude-opus-5-5` reads as Opus 5.5; other ids stay as they are. */
function modelName(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return claude ? `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}` : id
}

/** "2.6M tokens today · 96% cached", or '' when nothing was counted. */
function usageLine(usage: Usage | undefined): string {
  const total = usage ? usageTotal(usage) : 0
  if (!usage || !total) return ''
  return `${tokens(total)} tokens today · ${Math.round((usage.cacheRead / total) * 100)}% cached`
}

/** "Context 73% (512k of 700k) · 2 compactions · 1.2M tokens today"; without a known window, just the tokens. */
function contextLine(context: AgentContext | null | undefined): string {
  if (!context) return ''
  const fill = contextFill(context)
  const parts = [
    context.tokens === null
      ? 'Context not reported yet'
      : fill && context.window
        ? `Context ${fill.percent}% (${tokens(context.tokens)} of ${tokens(context.window)})`
        : `Context ${tokens(context.tokens)} tokens`,
    context.compactions ? `${context.compactions} ${context.compactions === 1 ? 'compaction' : 'compactions'}` : 'no compactions'
  ]
  if (context.today) parts.push(`${tokens(context.today)} tokens today`)
  return parts.join(' · ')
}

function usageModels(usage: Usage): string {
  return Object.entries(usage.models).sort((a, b) => b[1] - a[1]).map(([id, count]) => `${modelName(id)} ${tokens(count)}`).join(' · ')
}

function since(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

const originalNameOf = (agent: AgentView): string => agentName(office, agent)
const nameOf = (agent: AgentView): string => agentNames.get(agent.id) ?? originalNameOf(agent)
/** A terminal agent's own title, shown beside its workspace's name. */
const titleOf = (agent: AgentView): string =>
  agent.title && agent.title !== originalNameOf(agent) ? agent.title : ''
const changeOf = (agent: AgentView): string => {
  const change = agent.workspaceId ? office.changes[agent.workspaceId] : undefined
  return change?.files ? `+${change.added} \u2212${change.removed}` : ''
}

function stateOf(agent: AgentView): string {
  return currentStatus(agent.state, agent.outcome, agent.unread).label
}

/** What the agent is doing: its call and how many subagents it has. */
function activityWork(agent: AgentView, now: number): { call: Activity | null; text: string } {
  const call = agent.state === 'done' ? null : shown(agent, now)
  const helpers = agent.helpers.filter((helper) => helper.kind === 'agent').length
  const parts = call ? [call.tool, call.detail] : [agent.state === 'working' ? 'No current call observed' : '']
  if (helpers && call?.kind !== 'delegate')
    parts.push(`${helpers} subagent${helpers > 1 ? 's' : ''}`)
  return { call, text: parts.filter(Boolean).join(' · ') }
}

function activityTimeLine(agent: AgentView, now: number): string {
  return activityTimeText(
    agent.state,
    agent.stateStartedAt,
    agent.finishedAt,
    now,
    (from, at) => since(from, at),
    clock,
    agent.finishedAtSource
  )
}

function familyChildStatus(child: NonNullable<FamilyNode['child']>, now: number): string {
  if (!child.reported) {
    return `No longer reported · ${child.lastReportedAt ? `last observed ${since(child.lastReportedAt, now)} ago` : 'last observation unavailable'}`
  }
  if (child.state === 'done') return 'Done · outcome unavailable'
  if (child.state === 'working') return 'Working'
  if (child.state === 'blocked') return 'Needs you'
  if (child.state === 'waiting') return 'Waiting'
  return 'State unavailable'
}

/** What the agent is on now: its call, subagents and time on that call. */
function doing(agent: AgentView, now: number): { call: Activity | null; text: string } {
  const { call, text } = activityWork(agent, now)
  const duration = agent.state === 'done'
    ? activityTimeLine(agent, now)
    : call?.endedAt ? `observed ${since(call.endedAt, now)} ago` : since(call?.startedAt ?? agent.stateStartedAt, now)
  return { call, text: [text, duration].filter(Boolean).join(' · ') }
}

/** Text that follows the clock. The drawer keeps these nodes and rewrites only their text each second,
 *  so nothing around them is rebuilt. */
let clockNodes: { node: HTMLElement; text: (now: number) => string }[] = []
function timed(node: HTMLElement, text: (now: number) => string, now: number): HTMLElement {
  node.textContent = text(now)
  clockNodes.push({ node, text })
  return node
}
function tickClock(now: number): void {
  for (const { node, text } of clockNodes) {
    const next = text(now)
    if (node.textContent !== next) node.textContent = next
  }
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  // Titles and tool details come from agents: always text, never markup.
  if (text !== undefined) node.textContent = text
  return node
}

function select(id: string | null): void {
  selected = id
  listed = ''
  renderList()
}

function renderList(): void {
  const now = Date.now()
  const agents = filterAgents(office.agents, office, searchText, projectFilter, nameOf, false)
  const counts = countsLine(agents)
  const shown = officeBar.querySelector('.agent-counts')
  if (!shown) officeBar.prepend(counts)
  else if (shown.textContent !== counts.textContent) shown.replaceWith(counts)
  const rows = agents.map((agent) => [
    agent.finishedAt,
    changeOf(agent),
    agent.id,
    nameOf(agent),
    titleOf(agent),
    stateOf(agent),
    doing(agent, now).text,
    overdue(agent, now, prefs.stuckMinutes)?.kind,
    contextFill(agent.context)
  ])
  const open = agents.find((agent) => agent.id === selected)
  const key = JSON.stringify([
    rows,
    rooms.map((room) => room.collapsed),
    projectOrder(),
    office.usage?.projects,
    office.links,
    office.can,
    office.today,
    open?.history.length,
    open?.recent.length,
    open?.toolCount,
    open?.helpers,
    open?.prompt,
    open?.reply,
    since(open?.lastSeenAt ?? 0, now)
  ])
  if (key === listed) {
    if (currentPage === 'activity') renderActivity()
    else renderDrawer()
    return
  }
  listed = key

  const focusedKey = offices.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.focusKey
    : undefined
  officeMessage.textContent = agents.length
    ? ''
    : 'Nobody in yet. Start an agent in any workspace and it will walk in.'

  today.textContent = ''

  arrange()
  for (const { list, room, usage } of sections.values()) {
    const used = office.usage?.projects[room.id]
    usage.textContent = usageLine(used)
    usage.title = used ? usageModels(used) : ''
    usage.hidden = room.collapsed || !usage.textContent
    // In desk order, left to right, so a row is easy to match to its booth.
    if (room.collapsed) {
      list.replaceChildren()
      continue
    }
    const visible = new Set(agents.map((agent) => agent.id))
    const rows = room.agents.filter((agent) => visible.has(agent.id)).map((agent) => listItem(agent, now))
    list.replaceChildren(...rows)
  }
  if (!agents.length && (searchText || projectFilter !== 'all')) officeMessage.textContent = 'No agents match these filters.'
  if (focusedKey) {
    const target = focusTarget(
      [...offices.querySelectorAll<HTMLElement>('[data-focus-key]')]
        .map((node) => ({ key: node.dataset.focusKey ?? '', target: node })),
      focusedKey
    )
    restoreFocus(target)
  }
  if (currentPage === 'activity') renderActivity()
  else renderDrawer()
}

function listItem(agent: AgentView, now: number): HTMLElement {
  const { text } = doing(agent, now)
  const item = element(
    'li',
    [
      agent.state,
      agent.id === selected ? 'selected' : ''
    ].join(' ')
  )
  const row = element('button', 'agent')
  row.dataset.focusKey = `office-row:${agent.id}`
  row.setAttribute('aria-haspopup', 'dialog')

  const face = document.createElement('canvas')
  face.className = 'face'
  face.width = face.height = 56
  const pen = face.getContext('2d') as CanvasRenderingContext2D
  pen.scale(4, 4)
  portrait(pen, lookOf(agent))

  const status = currentStatus(agent.state, agent.outcome, false)
  const state = element('span', `state status-${status.tone}`)
  state.append(element('i', 'dot'), status.label)
  const task = element('span', 'task-title', taskLabel(agent))
  task.title = taskLabel(agent)
  const identity = element('span', 'agent-meta', nameOf(agent))
  appendAgentLabel(identity, agent)
  if (agent.unread) identity.append(element('span', 'unread-label', 'New'))
  const line = element('span', 'doing')
  const late = overdue(agent, now, prefs.stuckMinutes)
  if (late) line.append(element('span', 'quiet-label', late.kind === 'quiet' ? `Quiet ${since(late.since, now)}` : `Needs you ${since(late.since, now)}`))
  const fill = contextFill(agent.context)
  if (fill && fill.level !== 'ok') {
    const badge = element('span', `context-badge context-${fill.level}`, `Context ${fill.percent}%`)
    badge.title = contextLine(agent.context)
    line.append(badge)
  }
  line.append(element('span', '', text))
  row.append(face, task, identity, state, line)

  row.addEventListener('click', () => select(agent.id))
  row.addEventListener('mouseenter', () => (hovered = agent.id))
  row.addEventListener('mouseleave', () => (hovered = null))
  item.append(row)
  return item
}

function action(label: string, run: () => void): HTMLButtonElement {
  const button = element('button', 'action', label) as HTMLButtonElement
  button.addEventListener('click', run)
  return button
}

const projectName = (id: string): string =>
  id ? office.projects[id] ?? office.workspaces[id] ?? id.split(/[\\/]/).pop() ?? id : 'Unassigned'

/** Project ids as both tabs show them: the person's own order, else Orca's sidebar. */
function projectOrder(): string[] {
  const ids = new Set(office.agents.map((agent) => agent.projectId ?? agent.workspaceId ?? ''))
  return orderProjects([...ids], projectName, office.sidebar, prefs.projectOrder)
}

function moveRoom(id: string, step: -1 | 1): void {
  slideSoon()
  persistPrefsPatch({ projectOrder: moveProject(projectOrder(), id, step) })
  renderSettings()
  showOrder()
}

/** Redraws both tabs in the current project order. */
function showOrder(): void {
  listed = ''
  activityRenderKey = ''
  renderList()
}

/** ↑ and ↓ for one project; `focusKey` keeps focus on the button pressed as the project moves. */
function moveButtons(id: string, name: string, order: readonly string[], focusKey: string): HTMLElement[] {
  const at = order.indexOf(id)
  return ([[-1, '↑', 'up'], [1, '↓', 'down']] as const).map(([step, mark, word]) => {
    const button = action(mark, () => moveRoom(id, step))
    button.classList.add('move-project')
    button.dataset.focusKey = `${focusKey}:${word}`
    button.setAttribute('aria-label', `Move ${name} ${word}`)
    button.title = `Move ${word}`
    if (!id || (step < 0 ? at <= 0 : at < 0 || !order[at + 1])) button.setAttribute('disabled', '')
    return button
  })
}

function appendAgentLabel(name: HTMLElement, agent: AgentView): void {
  if (!agent.agent) return
  const provider = `${agent.agent[0].toUpperCase()}${agent.agent.slice(1)}`
  name.append(element('span', 'model-kind', ` · ${provider}`))
}

const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** What an agent was asked, or said, on a slip of paper. A click shows all of it. */
function note(id: string, kind: 'asked' | 'replied', label: string, text: string): HTMLElement {
  const slip = element('div', `note ${kind}${opened.has(id) ? ' open' : ''}`)
  slip.dataset.focusKey = `${id}:note`
  slip.append(element('span', 'note-label', label), element('p', 'note-text', text))
  slip.title = 'Show the full available excerpt'
  slip.tabIndex = 0
  slip.setAttribute('role', 'button')
  slip.setAttribute('aria-expanded', String(opened.has(id)))
  const toggle = (): void => {
    if (!opened.delete(id)) opened.add(id)
    slip.classList.toggle('open')
    slip.setAttribute('aria-expanded', String(opened.has(id)))
  }
  slip.addEventListener('click', toggle)
  slip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() }
  })
  return slip
}

type Tab = { id: string; label: string; count: string; fill: () => Node[]; total?: number }

/** One box of tabs for what a card keeps out of sight; nothing shows until a tab is picked, and
 *  picking it again closes the box. A tab whose total grew lights up for a moment. */
function tabBox(agentId: string, list: Tab[]): HTMLElement {
  const box = element('div', 'tabbox')
  const bar = element('div', 'tabbar')
  bar.setAttribute('role', 'tablist')
  const chosen = list.find((tab) => tab.id === picked.get(agentId)) ?? list.find((tab) => tab.id === 'calls')
  for (const tab of list) {
    const key = `${agentId}:${tab.id}`
    const grew = tab.total !== undefined && tab.total > (totals.get(key) ?? tab.total)
    if (tab.total !== undefined) totals.set(key, tab.total)
    const button = element('button', `tab${tab === chosen ? ' active' : ''}${grew ? ' grew' : ''}`)
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(tab === chosen))
    button.dataset.focusKey = `${agentId}:tab:${tab.id}`
    button.append(element('span', '', tab.label))
    if (tab.count) button.append(element('span', 'tab-count', tab.count))
    button.addEventListener('click', () => {
      picked.set(agentId, tab.id)
      listed = ''
      renderList()
      if (currentPage === 'activity') renderActivity()
    })
    bar.append(button)
  }
  box.append(bar)
  if (chosen) {
    const body = element('div', 'tabbody')
    body.setAttribute('role', 'tabpanel')
    body.append(...chosen.fill())
    box.append(body)
  }
  return box
}

function details(agent: AgentView, now: number): HTMLElement {
  const disclosure = element('details', 'drawer-extra') as HTMLDetailsElement
  disclosure.dataset.agentId = agent.id
  const summary = element('summary', '', 'More details')
  summary.dataset.focusKey = `${agent.id}:drawer-details`
  disclosure.append(summary)
  const box = element('div', 'details')
  disclosure.append(box)
  const part = (name: string): string => `${agent.id}:${name}`
  /** The agent as the office knows it now: the drawer is not rebuilt for every roster poll. */
  const live = (): AgentView => office.agents.find((other) => other.id === agent.id) ?? agent

  const identity = [
    agent.workspaceId ? `Workspace: ${office.workspaces[agent.workspaceId] ?? agent.workspaceId}` : '',
    agent.title ? `Title: ${agent.title}` : ''
  ].filter(Boolean)
  if (identity.length) box.append(element('p', 'agent-identity', identity.join(' · ')))
  const change = agent.workspaceId ? office.changes[agent.workspaceId] : undefined

  if (agent.prompt) box.append(note(part('asked'), 'asked', 'Asked (excerpt)', agent.prompt))
  box.append(timed(element('p', 'tab-note'), (at) => `Current work: ${doing(live(), at).text || 'Not reported'}`, now))
  if (change?.files) {
    box.append(element('p', 'tab-note', `Workspace shared changes: +${change.added} −${change.removed} · ${change.files} file${change.files === 1 ? '' : 's'}`))
  }
  const context = contextLine(agent.context)
  const used = agent.workspaceId ? office.usage?.workspaces[agent.workspaceId] : undefined
  if (context || (used && usageTotal(used))) {
    const usage = element('div', 'drawer-usage')
    if (context) {
      const provider = agent.agent ? `${agent.agent[0].toUpperCase()}${agent.agent.slice(1)} ` : ''
      usage.append(
        element('p', 'drawer-line drawer-context', context),
        element('p', 'drawer-fine', `Read from this agent's own ${provider}log, which Orca's session record names. ${agent.context?.window ? "The window is the one the log states." : 'The log does not state the context window, so there is no percentage.'} Tokens today count only this agent's current ${provider}session (the latest in Orca's record), cache included; an earlier one before a resume or /clear is not added.`)
      )
    }
    if (used && usageTotal(used)) {
      usage.append(
        element('p', context ? 'drawer-line drawer-workspace' : 'drawer-line', `Workspace ${usageLine(used)}`),
        element('p', 'drawer-models', usageModels(used)),
        element('p', 'drawer-fine', `${tokens(used.input)} input · ${tokens(used.output)} output · ${tokens(used.cacheRead)} cache read · ${tokens(used.cacheWrite)} cache write. Counted from Claude Code and Codex logs on this machine for everyone working in this workspace, not only this agent.`)
      )
    }
    box.append(usage)
  }

  // The rest waits behind tabs in one box, closed until asked for.
  const every = [...agent.active].reverse().concat(agent.recent)
  const running = agent.helpers.length + agent.active.length
  const tabs: Tab[] = [
    {
      id: 'calls',
      label: 'Calls',
      count: String(agent.toolCount),
      total: agent.toolCount,
      fill: () => {
        const lines: Node[] = []
        if (running) lines.push(element('p', 'tab-note', `${running} running now`))
        for (const helper of agent.helpers) {
          const line = element('div', 'call running')
          line.append(
            element('span', 'tool', helper.kind === 'agent' ? helper.name : 'command'),
            element('span', 'detail', helper.description),
            element('span', 'now', helper.tool ?? '')
          )
          lines.push(line)
        }
        const calls = allCalls === agent.id ? every : every.slice(0, CALLS)
        for (const call of calls) {
          const line = element('div', `call${call.endedAt ? '' : ' running'}`)
          line.append(
            element('span', 'tool', call.tool),
            element('span', 'detail', call.detail),
            timed(element('span', 'when'), (at) => (call.endedAt ? `${since(call.endedAt, at)} ago` : since(call.startedAt, at)), now)
          )
          lines.push(line)
        }
        if (!agent.helpers.length && !calls.length)
          lines.push(element('p', 'quiet', 'No tool calls seen yet.'))
        if (every.length > CALLS) {
          const more = action(
            allCalls === agent.id ? 'Show fewer' : `Show all ${every.length}`,
            () => {
              allCalls = allCalls === agent.id ? null : agent.id
              listed = ''
              renderList()
              if (currentPage === 'activity') renderActivity()
            }
          )
          more.classList.add('more')
          more.dataset.focusKey = `${agent.id}:calls:more`
          lines.push(more)
        }
        return lines
      }
    }
  ]
  const todos = agent.insight?.todos ?? []
  if (todos.length) {
    tabs.push({
      id: 'tasks',
      label: 'Tasks (heuristic)',
      count: `${todos.filter((todo) => todo.status === 'completed').length}/${todos.length}`,
      fill: () => todos.map((todo) => element('div', `todo ${todo.status}`, todo.text))
    })
  }
  const files = agent.insight?.files ?? []
  tabs.push({
    id: 'files',
    label: 'Files (heuristic)',
    count: String(files.length),
    fill: () => {
      if (!files.length) return [element('p', 'quiet', 'No files changed that it said.')]
      const chips = element('div', 'files')
      for (const name of files) chips.append(element('code', 'file', name))
      return [chips]
    }
  })
  const links = (agent.workspaceId && office.links[agent.workspaceId]) || []
  tabs.push({
    id: 'links',
    label: 'PRs',
    count: String(links.length),
    fill: () =>
      links.length
        ? links.map((link) => {
            const open = element('button', 'link', `${link.label} ↗`)
            open.title = link.url
            open.dataset.focusKey = `${agent.id}:link:${link.url}`
            open.addEventListener('click', () => void orca.shell?.openExternal(link.url))
            return open
          })
        : [element('p', 'quiet', 'Orca has linked none to this workspace.')]
  })
  box.append(tabBox(agent.id, tabs))

  return disclosure
}

/** Shows an agent in Activity; `open` also opens its drawer, otherwise its node is only found and focused. */
function showActivity(agentId: string, open = true): void {
  const agent = office.agents.find((item) => item.id === agentId)
  if (!agent) return
  selected = null
  const projectId = agent.projectId ?? agent.workspaceId ?? ''
  const ancestors = (node: FamilyNode): boolean => {
    if (node.agent?.id === agentId) return true
    if (node.children.some(ancestors)) { expandedFamilies.add(node.key); return true }
    return false
  }
  buildFamilyTree(office.agents.filter((item) => (item.projectId ?? item.workspaceId ?? '') === projectId)).some(ancestors)
  activitySelected = open ? agentId : null
  activityHelper = null
  activityRenderKey = ''
  if (currentPage !== 'activity') setPage('activity')
  else renderActivity()
  keepChartNodeVisible(`chart-node:${agentId}`)
  if (!open) activityList.querySelector<HTMLElement>(`[data-focus-key="chart-node:${CSS.escape(agentId)}"]`)?.focus({ preventScroll: true })
}

function showHelper(node: FamilyNode): void {
  activitySelected = null
  activityHelper = node.key
  anonymousHelperSignature = node.child && !node.child.id ? JSON.stringify([node.child.name, node.child.description]) : null
  activityRenderKey = ''
  renderActivity()
  keepChartNodeVisible(`chart-helper:${node.key}`)
}

function keepChartNodeVisible(focusKey: string): void {
  const target = [...activityList.querySelectorAll<HTMLElement>('.chart-node-button')].find((node) => node.dataset.focusKey === focusKey)
  const viewport = target?.closest<HTMLElement>('.chart-viewport')
  if (viewport && target && viewport.dataset.project !== undefined) {
    // Only sideways: a chart never scrolls vertically.
    const frame = viewport.getBoundingClientRect(), box = target.getBoundingClientRect()
    if (box.left < frame.left) viewport.scrollLeft += box.left - frame.left
    else if (box.right > frame.right) viewport.scrollLeft += box.right - frame.right
    chartPositions.set(viewport.dataset.project, viewport.scrollLeft)
  }
  // Charts are as tall as their content, so the page does the vertical scrolling.
  target?.scrollIntoView({ block: 'nearest' })
}

function setPage(id: string, persist = true): void {
  if (persist) userSelectedView = true
  const refreshOffice = shouldRefreshOffice(currentPage, id)
  if (currentPage === 'attention' && id !== 'attention') attentionDrawerAgent = null
  if (currentPage === 'settings' && id !== 'settings') notificationFocusRevision++
  currentPage = id
  for (const tab of primaryTabs) {
    const active = tab.id === `${id}-tab`
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
  }
  for (const page of pages) page.hidden = page.id !== `${id}-page`
  filterBar.hidden = id === 'settings'
  document.documentElement.classList.toggle('compact', prefs.density === 'compact')
  if (id === 'activity') renderActivity()
  if (id === 'attention') renderAttentionPage()
  if (id === 'settings') renderNotificationSettings(true)
  if (refreshOffice) { listed = ''; renderList() }
  if (persist && id !== 'settings') {
    persistPrefsPatch({ selectedView: id as Prefs['selectedView'] })
  }
  renderDrawer()
}

function notificationProjectId(agent: AgentView): string {
  return agent.projectId ?? agent.workspaceId ?? agent.id
}

function notificationSignature(agent: AgentView): string {
  return JSON.stringify([notificationProjectId(agent), agent.state, agent.stateStartedAt])
}

function ensureNotificationTarget(map: Map<string, NotificationTarget>, key: string, signature: string): NotificationTarget {
  const previous = map.get(key)
  if (previous?.signature === signature) return previous
  if (previous) previous.generation++
  const next: NotificationTarget = { signature, state: null, loading: false, busy: false, message: '', generation: 0 }
  map.set(key, next)
  return next
}

function startNotificationRead(
  map: Map<string, NotificationTarget>, key: string, target: NotificationTarget,
  input: { projectId: string; agentId?: string; episodeId?: string }, stillCurrent: () => boolean, force = false
): void {
  if (target.busy || (target.loading && !force) || (!force && target.state)) return
  const focused = document.activeElement as HTMLElement | null
  const targetKey = input.agentId ? `notification:agent:${input.agentId}` : `notification:project:${input.projectId}`
  if (target.focusRevision !== notificationFocusRevision
    && notificationRows.contains(focused) && focused?.closest<HTMLElement>('.notification-row')?.dataset.notificationTarget === targetKey) {
    target.focusKey = focused.dataset.focusKey
    target.focusRevision = notificationFocusRevision
  }
  const generation = ++target.generation
  target.loading = true
  const preserveWriteFailure = target.retryKind === 'write'
  if (!preserveWriteFailure) {
    target.message = ''
    target.retry = undefined
    target.retryKind = undefined
  }
  if (input.agentId) {
    const timer = notificationExpiryTimers.get(input.agentId)
    if (timer) clearTimeout(timer)
    notificationExpiryTimers.delete(input.agentId)
  }
  const apply = (state: NotificationControlState): void => {
    if (map.get(key) !== target || target.generation !== generation || !stillCurrent()) return
    target.loading = false
    if (state.status === 'error' && state.error?.includes('episode is no longer current') && input.agentId && input.episodeId) {
      target.state = null
      target.message = ''
      target.writeFailureMessage = undefined
      target.retry = undefined
      target.retryKind = undefined
      startNotificationRead(map, key, target, { projectId: input.projectId, agentId: input.agentId }, stillCurrent, true)
      return
    }
    target.state = state.status === 'loading'
      ? { ...state, status: 'error', error: 'Notification settings are still loading. Retry to check again.' }
      : state
    if (preserveWriteFailure) {
      target.message = target.state.status === 'error'
        ? `${target.writeFailureMessage ?? target.message} Saved state refresh failed: ${target.state.error ?? 'notification settings are unavailable.'}`
        : target.writeFailureMessage ?? target.message
    } else {
      target.message = target.state.status === 'error' ? target.state.error ?? 'Notification settings are unavailable.' : ''
      target.writeFailureMessage = undefined
      target.retry = target.state.status === 'ready' ? undefined : () => startNotificationRead(map, key, target, input, stillCurrent, true)
      target.retryKind = target.state.status === 'ready' ? undefined : 'read'
    }
    if (input.agentId && target.state.status === 'ready' && target.state.snoozed && target.state.expiresAt !== null && Number.isFinite(target.state.expiresAt)) {
      const expiresAt = target.state.expiresAt
      const delay = Math.max(0, expiresAt - Date.now()) + 25
      notificationExpiryTimers.set(input.agentId, setTimeout(() => {
        notificationExpiryTimers.delete(input.agentId!)
        if (!document.hidden && map.get(key) === target && stillCurrent())
          startNotificationRead(map, key, target, input, stillCurrent, true)
      }, delay))
    }
    if (currentPage === 'settings') renderNotificationSettings()
  }
  void orca.plugin.request('notification.control.read', input).then(apply).catch((error: unknown) => {
    apply({ status: 'error', projectId: input.projectId, muted: null, agentId: input.agentId ?? null, episodeId: null, snoozed: null, expiresAt: null, error: error instanceof Error ? error.message : 'Could not read notification settings.' })
  })
}

function saveNotification(
  map: Map<string, NotificationTarget>, key: string, target: NotificationTarget,
  request: 'notification.project.mute' | 'notification.reminder.snooze', input: Record<string, unknown>,
  read: (force: boolean) => void, stillCurrent: () => boolean
): void {
  const attempt = async (): Promise<void> => {
    if (!stillCurrent() || target.busy) return
    target.focusKey = notificationRows.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined
    target.focusRevision = notificationFocusRevision
    target.busy = true
    target.message = ''
    target.writeFailureMessage = undefined
    target.retry = undefined
    target.retryKind = undefined
    renderNotificationSettings()
    let result: ActionResult
    try {
      result = request === 'notification.project.mute'
        ? await orca.plugin.request(request, input as { projectId: string; muted: boolean })
        : await orca.plugin.request(request, input as { projectId: string; agentId: string; episodeId: string; choice: '15m' | '1h' | 'manual' | 'resume' })
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : 'Could not save notification settings.' }
    }
    if (map.get(key) !== target || !stillCurrent()) return
    target.busy = false
    if (result.ok) {
      target.message = ''
      target.writeFailureMessage = undefined
      target.retry = undefined
      target.retryKind = undefined
      read(true)
    } else {
      target.message = result.error
      target.writeFailureMessage = result.error
      target.retry = () => { void attempt() }
      target.retryKind = 'write'
      if (currentPage === 'settings') renderNotificationSettings()
    }
  }
  void attempt()
}

function syncNotificationControls(force: boolean): { projects: NotificationProjectRow[]; reminders: NotificationReminderRow[] } | undefined {
  const visible = currentPage === 'settings'
  if (!visible && !notificationProjects.size && !notificationReminders.size) return

  const projectAgents = office.agents.filter((agent) => Boolean(agent.projectId || agent.workspaceId))
  const projectNames = new Map<string, string>()
  for (const agent of projectAgents) {
    const id = notificationProjectId(agent)
    const context = workspaceContext(agent, office)
    projectNames.set(id, context.project ?? context.workspace ?? 'Project name unavailable')
  }
  for (const [id, target] of notificationProjects) {
    if (projectNames.has(id)) continue
    target.generation++
    notificationProjects.delete(id)
  }
  const now = Date.now()
  const reminders = office.agents.filter((agent) => overdue(agent, now, prefs.stuckMinutes) !== null)
  const reminderSignatures = new Map(reminders.map((agent) => [agent.id, notificationSignature(agent)]))
  for (const [id, target] of notificationReminders) {
    if (reminderSignatures.get(id) === target.signature) continue
    target.generation++
    notificationReminders.delete(id)
    const timer = notificationExpiryTimers.get(id)
    if (timer) clearTimeout(timer)
    notificationExpiryTimers.delete(id)
  }
  // Retire stale targets on every live update so pending writes stay tied to their original episode.
  if (!visible) return

  const order = projectOrder()
  const projectRows: NotificationProjectRow[] = [...projectNames].map(([projectId, name]) => {
    const target = ensureNotificationTarget(notificationProjects, projectId, projectId)
    const current = (): boolean => notificationProjects.get(projectId) === target && projectNames.has(projectId)
    startNotificationRead(notificationProjects, projectId, target, { projectId }, current, force)
    return { projectId, name, state: target.state, loading: target.loading, busy: target.busy, message: target.message, retryKind: target.retryKind, retry: target.retry }
  }).sort((a, b) => order.indexOf(a.projectId) - order.indexOf(b.projectId) || a.name.localeCompare(b.name))

  const reminderRows: NotificationReminderRow[] = reminders.map((agent) => {
    const projectId = notificationProjectId(agent)
    const signature = notificationSignature(agent)
    const target = ensureNotificationTarget(notificationReminders, agent.id, signature)
    const current = (): boolean => {
      const live = office.agents.find((item) => item.id === agent.id)
      return notificationReminders.get(agent.id) === target && Boolean(live && notificationSignature(live) === signature && overdue(live, Date.now(), prefs.stuckMinutes))
    }
    const input = target.state?.status === 'ready' && target.state.episodeId
      ? { projectId, agentId: agent.id, episodeId: target.state.episodeId }
      : { projectId, agentId: agent.id }
    startNotificationRead(notificationReminders, agent.id, target, input, current, force)
    return { projectId, name: nameOf(agent), agent, state: target.state, loading: target.loading, busy: target.busy, message: target.message, retryKind: target.retryKind, retry: target.retry }
  })
  return { projects: projectRows, reminders: reminderRows }
}

function renderAttentionPage(): void {
  const filtered = { ...office, agents: filterAgents(office.agents, office, searchText, projectFilter, nameOf, false) }
  const now = Date.now()
  for (const agent of filtered.agents) refreshActions(agent.id, now)
  renderAttention(attentionList, filtered, new Set(office.reviewedCompletions ?? []), {
    go: (agent, done) => {
      void orca.plugin.request('office.goTo', { agentId: agent.id }).then((result: ActionResult) => {
        const message = result.ok ? result.note ?? 'Opened the agent in Orca.' : result.error
        attentionFeedback.textContent = message
        done(message)
      }).catch(() => { attentionFeedback.textContent = 'Could not open this agent in Orca.'; done('Could not open this agent in Orca.') })
    },
    canGo: (agent) => {
      const actions = actionsOf.get(agent.id)
      if (!actions || actions.signature !== actionSignature(agent) || !actions.ready) return null
      return actions.value.goTo !== null
    },
    details: (agent) => { attentionDrawerAgent = agent.id; renderDrawer() }
  }, office.agents.length, !filtered.agents.length && Boolean(searchText || projectFilter !== 'all'), nameOf, Boolean(searchText || projectFilter !== 'all'))
}

function nextAttentionFocus(agentId: string): string {
  const rows = [...attentionList.querySelectorAll<HTMLElement>('.attention-row')].filter((row) => {
    const disclosure = row.closest('details')
    return !disclosure || disclosure.open
  })
  const index = rows.findIndex((row) => row.dataset.agentId === agentId)
  const candidates = index < 0 ? rows : [...rows.slice(index + 1), ...rows.slice(0, index).reverse()]
  const next = candidates.find((row) => row.dataset.agentId !== agentId)
  return next?.querySelector<HTMLButtonElement>('.attention-title')?.dataset.focusKey ?? 'attention-heading'
}

function markReviewed(agentId: string): void {
  const agent = office.agents.find((item) => item.id === agentId)
  if (!agent || agent.state !== 'done' || !agent.completionId) return
  const completionId = agent.completionId
  if (office.reviewedCompletions?.includes(completionId) || reviewPending.has(completionId)) return
  const reviewDrawerGeneration = currentPage === 'attention' && attentionDrawerAgent === agentId && sheet.isConnected ? drawerGeneration : null
  const reviewFocusKey = (document.activeElement as HTMLElement | null)?.dataset.focusKey
  const nextFocus = currentPage === 'attention' ? nextAttentionFocus(agentId) : undefined
  reviewErrors.delete(completionId)
  reviewPending.add(completionId)
  renderDrawer()
  void orca.plugin.request('attention.review', { completionId }).then((result: ActionResult) => {
    reviewPending.delete(completionId)
    const current = office.agents.find((item) => item.id === agentId)
    if (!result.ok) {
      reviewErrors.set(completionId, result.error)
      attentionFeedback.textContent = result.error
      if (!current && currentPage === 'attention' && attentionDrawerAgent === agentId) {
        attentionDrawerAgent = null
        renderDrawer()
        return
      }
      renderDrawer()
      return
    }
    if (!current || current.completionId !== completionId) {
      const error = 'Completion changed before it could be reviewed. Open its current result and try again.'
      reviewErrors.set(completionId, error)
      attentionFeedback.textContent = error
      renderDrawer()
      return
    }
    reviewErrors.delete(completionId)
    attentionFeedback.textContent = 'Reviewed in The Lobby.'
    office = { ...office, reviewedCompletions: [...new Set([...(office.reviewedCompletions ?? []), completionId])] }
    const ownsDrawer = reviewDrawerGeneration !== null && drawerGeneration === reviewDrawerGeneration
      && currentPage === 'attention' && attentionDrawerAgent === agentId && sheet.isConnected
      && sheet.contains(document.activeElement)
      && (document.activeElement as HTMLElement).dataset.focusKey === reviewFocusKey
    if (ownsDrawer) closeDrawer(nextFocus)
    else renderDrawer()
  }).catch(() => {
    reviewPending.delete(completionId)
    const error = 'Could not save the review. Try again.'
    reviewErrors.set(completionId, error)
    attentionFeedback.textContent = error
    renderDrawer()
  })
}

function renderNotificationSettings(force = false): void {
  const notifications = syncNotificationControls(force)
  if (!notifications) return
  const disclosure = settings.querySelector<HTMLDetailsElement>('#notification-disclosure')
  const summary = settings.querySelector<HTMLElement>('#notification-summary')
  const summaryStatus = settings.querySelector<HTMLElement>('#notification-summary-status')
  const issues = settings.querySelector<HTMLElement>('.notification-issues')
  if (disclosure && summary && summaryStatus && issues) {
    const summarize = (label: string, rows: Array<NotificationProjectRow | NotificationReminderRow>, secondary: (row: NotificationProjectRow | NotificationReminderRow) => boolean): string => {
      const saving = rows.filter((row) => row.busy).length
      const loading = rows.filter((row) => !row.busy && row.loading).length
      const ready = rows.filter((row) => !row.busy && !row.loading && row.state?.status === 'ready')
      const unavailable = rows.length - saving - loading - ready.length
      const secondaryCount = ready.filter(secondary).length
      const parts = [`${ready.length - secondaryCount} active`, `${secondaryCount} ${label === 'Projects' ? 'muted' : 'snoozed'}`]
      if (loading) parts.push(`${loading} loading`)
      if (saving) parts.push(`${saving} saving`)
      if (unavailable) parts.push(`${unavailable} unavailable`)
      return `${label} ${rows.length}: ${parts.join(', ')}`
    }
    const pendingIssues = [...notifications.projects, ...notifications.reminders].filter((row) => row.retry || row.busy || row.message).length
    const counts = [
      summarize('Projects', notifications.projects, (row) => Boolean(row.state?.status === 'ready' && row.state.muted)),
      summarize('Reminders', notifications.reminders, (row) => Boolean(row.state?.status === 'ready' && row.state.snoozed))
    ]
    if (pendingIssues) counts.push(`${pendingIssues} need attention`)
    summaryStatus.textContent = counts.join(' · ')
    renderNotificationIssues(issues, disclosure, [...notifications.projects, ...notifications.reminders])
  }
  restoringNotificationFocus = true
  try {
    renderNotificationControls(notificationRows, notifications.projects, notifications.reminders, {
      mute: (row) => {
        const target = notificationProjects.get(row.projectId)
        if (!target?.state || target.state.status !== 'ready') return
        const current = (): boolean => notificationProjects.get(row.projectId) === target && office.agents.some((agent) => notificationProjectId(agent) === row.projectId)
        saveNotification(notificationProjects, row.projectId, target, 'notification.project.mute', { projectId: row.projectId, muted: !target.state.muted },
          (force) => startNotificationRead(notificationProjects, row.projectId, target, { projectId: row.projectId }, current, force), current)
      },
      snooze: (row, choice) => {
        const target = notificationReminders.get(row.agent.id)
        if (!target?.state || target.state.status !== 'ready' || !target.state.episodeId) return
        const episodeId = target.state.episodeId
        const current = (): boolean => {
          const live = office.agents.find((agent) => agent.id === row.agent.id)
          return notificationReminders.get(row.agent.id) === target && Boolean(live && notificationSignature(live) === target.signature && overdue(live, Date.now(), prefs.stuckMinutes))
        }
        saveNotification(notificationReminders, row.agent.id, target, 'notification.reminder.snooze', { projectId: row.projectId, agentId: row.agent.id, episodeId, choice },
          (force) => startNotificationRead(notificationReminders, row.agent.id, target, { projectId: row.projectId, agentId: row.agent.id, episodeId }, current, force), current)
      }
    })
    for (const target of [...notificationProjects.values(), ...notificationReminders.values()]) {
      if (!target.focusKey) continue
      if (target.focusRevision === notificationFocusRevision && notificationRows.contains(document.activeElement)) {
        const control = notificationRows.querySelector<HTMLButtonElement>(`button[data-focus-key="${CSS.escape(target.focusKey)}"]:not(:disabled)`)
        if (!control) continue
        control.focus({ preventScroll: true })
      }
      target.focusKey = undefined
      target.focusRevision = undefined
    }
  } finally {
    restoringNotificationFocus = false
  }
}

function renderNotificationIssues(root: HTMLElement, disclosure: HTMLDetailsElement, rows: Array<NotificationProjectRow | NotificationReminderRow>): void {
  const active = root.contains(document.activeElement) ? document.activeElement as HTMLElement : null
  const focusedKey = active?.dataset.focusKey
  const focusIndex = active ? [...root.querySelectorAll<HTMLButtonElement>('button[data-focus-key]')].indexOf(active as HTMLButtonElement) : -1
  const issues = rows.filter((row) => row.retry || row.busy || row.message)
  root.replaceChildren(...issues.map((row) => {
    const retryAction = row.retryKind === 'write' ? 'retry-write' : 'retry'
    const key = 'agent' in row ? `notification-summary:agent:${row.agent.id}:${retryAction}` : `notification-summary:project:${row.projectId}:${retryAction}`
    const item = element('div', 'notification-issue')
    const message = element('p', 'notification-error', row.message || (row.busy ? `Saving settings for ${row.name}…` : 'Notification settings need attention.'))
    message.setAttribute('role', row.message ? 'alert' : 'status')
    item.append(message)
    if (row.retry) {
      const retry = action(`Retry ${row.name}`, () => row.retry?.())
      retry.dataset.focusKey = key
      retry.disabled = row.busy || row.loading
      item.append(retry)
    }
    return item
  }))
  root.hidden = disclosure.open || !issues.length
  if (active) {
    if (root.hidden) {
      disclosure.querySelector('summary')?.focus({ preventScroll: true })
      return
    }
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-focus-key]:not(:disabled)')]
    const target = buttons.find((button) => button.dataset.focusKey === focusedKey)
      ?? buttons[Math.min(Math.max(focusIndex, 0), buttons.length - 1)]
    if (target) target.focus({ preventScroll: true })
    else disclosure.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true })
  }
}

function renderFilters(): void {
  const query = filterBar.querySelector<HTMLInputElement>('input')!
  const project = filterBar.querySelector<HTMLSelectElement>('select')!
  const options = ['all', ...projectOrder()]
  const key = options.join('\u0000')
  if (project.dataset.options !== key) {
    project.replaceChildren(...options.map((id) => {
      const option = document.createElement('option')
      option.value = id
      option.textContent = id === 'all' ? 'All projects' : projectName(id)
      return option
    }))
    project.dataset.options = key
  }
  if (query.value !== searchText) query.value = searchText
  if (!options.includes(projectFilter)) projectFilter = 'all'
  project.value = options.includes(projectFilter) ? projectFilter : 'all'
  const matches = filterAgents(office.agents, office, searchText, projectFilter, nameOf, false).length
  const active = Number(Boolean(searchText)) + Number(projectFilter !== 'all')
  document.getElementById('filter-active-count')!.textContent = active ? `${active} active` : ''
  document.getElementById('filter-summary')!.setAttribute('aria-label', active ? `Filter, ${active} active ${active === 1 ? 'filter' : 'filters'}` : 'Filter')
  document.getElementById('filter-count')!.textContent = active ? `${matches} ${matches === 1 ? 'match' : 'matches'}` : ''
  const clear = document.getElementById('clear-filters') as HTMLButtonElement
  const clearOwnsFocus = document.activeElement === clear
  clear.hidden = active === 0
  if (clearOwnsFocus && clear.hidden) document.getElementById('filter-summary')!.focus({ preventScroll: true })
}

const searchInput = document.createElement('input')
searchInput.type = 'search'
searchInput.placeholder = 'Search tasks and workspace context'
searchInput.setAttribute('aria-label', 'Search tasks and workspace context')
searchInput.dataset.focusKey = 'shared-search'
const projectSelect = document.createElement('select')
projectSelect.setAttribute('aria-label', 'Filter by project')
projectSelect.dataset.focusKey = 'shared-project'
filterBar.querySelector('#filter-controls')!.append(searchInput, projectSelect)
const clearFilters = document.getElementById('clear-filters') as HTMLButtonElement
const filterDisclosure = document.getElementById('filter-disclosure') as HTMLDetailsElement
const filterIndicator = document.getElementById('filter-indicator')!
filterDisclosure.addEventListener('toggle', () => { filterIndicator.textContent = filterDisclosure.open ? '▾' : '▸' })
clearFilters.addEventListener('click', () => {
  searchText = ''
  projectFilter = 'all'
  renderFilters()
  showOrder()
  if (currentPage === 'attention') renderAttentionPage()
})
searchInput.addEventListener('input', () => { searchText = searchInput.value; renderFilters(); showOrder(); if (currentPage === 'attention') renderAttentionPage() })
projectSelect.addEventListener('change', () => { projectFilter = projectSelect.value; renderFilters(); showOrder(); if (currentPage === 'attention') renderAttentionPage() })

function renderActivity(): void {
  const order = projectOrder()
  const visibleAgents = filterAgents(office.agents, office, searchText, projectFilter, nameOf)
  const groups = projectGroups(visibleAgents).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
  if (activitySelected && !visibleAgents.some((agent) => agent.id === activitySelected)) activitySelected = null
  const trees = groups.map((item) => buildFamilyTree(item.agents))
  syncFamilyExpansion(trees.flat(), expandedFamilies, seenFamilyBranches)
  const findHelper = (nodes: FamilyNode[]): FamilyNode | undefined => {
    for (const node of nodes) {
      if (node.key === activityHelper && !node.agent && node.child && (anonymousHelperSignature === null || anonymousHelperSignature === JSON.stringify([node.child.name, node.child.description]))) return node
      const nested = findHelper(node.children)
      if (nested) return nested
    }
    return undefined
  }
  const selectedHelper = activityHelper ? findHelper(trees.flat()) : undefined
  if (activityHelper && !selectedHelper) activityHelper = null
  drawerHelper = selectedHelper ?? null
  const key = JSON.stringify([visibleAgents, searchText, projectFilter, office.can, office.projects, office.workspaces, office.usage, activitySelected, activityHelper, [...expandedFamilies], [...foldedCharts], activityFilter, prefs.layout, order, timeRefreshBucket(Date.now())])
  if (key === activityRenderKey) return renderDrawer()
  activityRenderKey = key
  const focused = activityList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined
  const scroll = document.scrollingElement?.scrollTop ?? 0
  const oldBlocks = new Map<string, HTMLElement>()
  for (const block of activityList.querySelectorAll<HTMLElement>('.chart-block')) {
    const viewport = block.querySelector<HTMLElement>('.chart-viewport')
    if (!viewport?.dataset.project) continue
    chartPositions.set(viewport.dataset.project, viewport.scrollLeft)
    oldBlocks.set(viewport.dataset.project, block)
  }
  if (!groups.length) {
    activityList.replaceChildren(element('p', 'quiet', office.agents.length ? 'No agents match these filters.' : 'No agents to show yet.'))
    return renderDrawer()
  }
  const attentionOnly = activityFilter === 'attention'
  const counts = trees.map((roots) => roots.reduce((sum, root) => sum + countAttention(root), 0))
  const attentionTotal = counts.reduce((sum, count) => sum + count, 0)
  const children: HTMLElement[] = [filterToggle(attentionTotal, visibleAgents.length)]
  const items: HTMLElement[] = []
  if (attentionOnly && !attentionTotal) children.push(attentionEmpty())
  else {
    children.push(element('p', 'chart-legend', 'One chart per project, like Office, with every workspace\'s agents.  ┄ in this project   ━ started by the agent above'), activityColumns)
    groups.forEach((group, index) => {
      const roots = trees[index]
      const name = projectName(group.id)
      // Needs attention keeps every project in view but folds the ones with nothing to act on.
      if (attentionOnly && !counts[index]) {
        items.push(element('p', 'chart-quiet-project', `${name}: nothing blocked or failed`))
        return
      }
      const block = chartView(group.id, name, roots, attentionOnly, order)
      // Live updates rerender often. Replacing a scroll container ends a scrollbar drag in
      // progress, so a chart already on screen keeps its viewport and swaps only its contents.
      const fresh = block.querySelector<HTMLElement>('.chart-viewport')!
      const kept = oldBlocks.get(fresh.dataset.project!)
      const keptViewport = kept?.querySelector<HTMLElement>('.chart-viewport')
      if (kept && keptViewport) {
        keepScroller(keptViewport, fresh)
        kept.className = block.className
        kept.setAttribute('aria-label', block.getAttribute('aria-label')!)
        kept.querySelector('.chart-toolbar')!.replaceWith(block.querySelector('.chart-toolbar')!)
        items.push(kept)
      } else items.push(block)
    })
  }
  placeChildren(activityList, children)
  applyLayout()
  placeInColumns(activityColumns, items)
  const firstShown: HTMLElement[] = []
  for (const viewport of activityList.querySelectorAll<HTMLElement>('.chart-viewport')) {
    const viewKey = viewport.dataset.project!
    const position = chartPositions.get(viewKey)
    if (position !== undefined) viewport.scrollLeft = position
    else if (!chartInitialized.has(viewKey)) {
      viewport.scrollLeft = Math.max(0, Number(viewport.dataset.initialCenter) - viewport.clientWidth / 2)
      chartInitialized.add(viewKey)
      if (activityFilter === 'attention') firstShown.push(viewport)
    }
  }
  if (focused) restoreFocus(focusTarget([...activityList.querySelectorAll<HTMLElement>('[data-focus-key]')].map((node) => ({ key: node.dataset.focusKey ?? '', target: node })), focused))
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll
  // Needs attention shows its first agent: the chart is as tall as its content, so the page scrolls to it.
  if (firstShown.length) firstShown[0].querySelector<HTMLElement>('.chart-node.attention')?.scrollIntoView({ block: 'nearest' })
  renderDrawer()
}

/** Moves the fresh contents into the scroll container already on screen, keeping its scroll offset. */
function keepScroller(kept: HTMLElement, fresh: HTMLElement): HTMLElement {
  const left = kept.scrollLeft
  kept.replaceChildren(...fresh.childNodes)
  for (const name of kept.getAttributeNames()) if (!fresh.hasAttribute(name) && name !== 'class') kept.removeAttribute(name)
  for (const name of fresh.getAttributeNames()) if (name !== 'class') kept.setAttribute(name, fresh.getAttribute(name)!)
  kept.scrollLeft = left
  return kept
}

const activityColumns = element('div', 'columns')

// Charts have no scrollbars, so dragging a chart's background pans it sideways; up and down is the page's.
activityList.addEventListener('pointerdown', (event) => {
  const viewport = (event.target as HTMLElement).closest<HTMLElement>('.chart-viewport')
  if (!viewport || event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  const start = { x: event.clientX, left: viewport.scrollLeft }
  viewport.setPointerCapture(event.pointerId)
  viewport.classList.add('panning')
  const move = (next: PointerEvent): void => {
    viewport.scrollLeft = start.left - (next.clientX - start.x)
  }
  const end = (): void => {
    viewport.classList.remove('panning')
    viewport.removeEventListener('pointermove', move)
    if (viewport.dataset.project !== undefined) chartPositions.set(viewport.dataset.project, viewport.scrollLeft)
  }
  viewport.addEventListener('pointermove', move)
  viewport.addEventListener('pointerup', end, { once: true })
  viewport.addEventListener('pointercancel', end, { once: true })
})
/** Projects whose Activity chart is folded down to its title bar. */
const foldedCharts = new Set<string>()

/** Two stacked columns. In Grid, projects alternate left and right, so folding one slides up only
 *  the projects beneath it instead of reflowing the whole page. */
function placeInColumns(container: HTMLElement, items: HTMLElement[]): void {
  let columns = [...container.children].filter((child) => child.classList.contains('column')) as HTMLElement[]
  if (columns.length !== 2) {
    columns = [element('div', 'column'), element('div', 'column')]
    container.replaceChildren(...columns)
  }
  const two = document.documentElement.classList.contains('grid')
  placeChildren(columns[0], two ? items.filter((_, index) => index % 2 === 0) : items)
  placeChildren(columns[1], two ? items.filter((_, index) => index % 2 === 1) : [])
  for (const item of items) watchHeight(item)
}

/** Folding sets this; height changes until then slide the projects beneath into place. */
let slideUntil = 0
const slideSoon = (): void => { slideUntil = performance.now() + 600 }
const heights = new WeakMap<Element, number>()
const sliding = new ResizeObserver((entries) => {
  const animate = performance.now() < slideUntil && !still()
  for (const entry of entries) {
    const item = entry.target as HTMLElement
    const before = heights.get(item)
    const after = item.offsetHeight
    heights.set(item, after)
    if (!animate || before === undefined || before === after) continue
    for (let next = item.nextElementSibling; next; next = next.nextElementSibling)
      next.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' })
  }
})
function watchHeight(item: HTMLElement): void {
  if (heights.has(item)) return
  heights.set(item, item.offsetHeight)
  sliding.observe(item)
}

/** Sets the children in order without detaching the ones that stay, so they keep scroll and drags. */
function placeChildren(parent: HTMLElement, next: HTMLElement[]): void {
  for (const child of [...parent.children]) if (!next.includes(child as HTMLElement)) child.remove()
  next.forEach((child, index) => { if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null) })
}

function findAgentNode(nodes: FamilyNode[], agentId: string): FamilyNode | undefined {
  for (const node of nodes) {
    if (node.agent?.id === agentId && !node.cyclic) return node
    const nested = findAgentNode(node.children, agentId)
    if (nested) return nested
  }
  return undefined
}

function countAttention(node: FamilyNode): number {
  return (needsAttention(node) ? 1 : 0) + node.children.reduce((sum, child) => sum + (child.cyclic ? 0 : countAttention(child)), 0)
}

/** "● 3 working · ● 2 done · ● 1 failed", in the state colors; needs-you only when someone does. */
function countsLine(agents: AgentView[] = office.agents): HTMLElement {
  const counts = agentCounts(agents)
  const line = element('span', 'agent-counts')
  line.setAttribute('role', 'status')
  const parts: [number, string, string][] = [
    [counts.working, 'working', 'working'],
    [counts.needsYou, 'blocked', 'need you'],
    [counts.done, 'done', 'done'],
    [counts.failed, 'failed', 'failed']
  ]
  for (const [count, tone, label] of parts) {
    if (tone === 'blocked' && !count) continue
    const part = element('span', `agent-count status-${tone}`)
    part.append(element('i', 'dot'), `${count} ${label}`)
    line.append(part)
  }
  return line
}

/** List or grid, for both Office and Activity. */
function layoutToggle(): HTMLElement {
  const group = element('div', 'layout-toggle')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Project layout')
  for (const [value, label] of [['list', 'List'], ['grid', 'Grid']] as const) {
    const button = action(label, () => {
      if (prefs.layout === value) return
      persistPrefsPatch({ layout: value })
      applyLayout()
    })
    button.dataset.layout = value
    button.dataset.focusKey = `layout:${value}`
    button.setAttribute('aria-pressed', String(prefs.layout === value))
    group.append(button)
  }
  return group
}

function applyLayout(): void {
  const root = document.documentElement
  root.classList.toggle('compact', prefs.density === 'compact')
  const wide = root.clientWidth >= GRID_MIN_WIDTH
  const grid = wide && prefs.layout === 'grid'
  if (root.classList.contains('grid') !== grid && currentPage === 'activity') queueMicrotask(() => { activityRenderKey = ''; renderActivity() })
  root.classList.toggle('grid', grid)
  for (const button of document.querySelectorAll<HTMLElement>('.layout-toggle [data-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.layout === prefs.layout))
    if (button.dataset.layout === 'grid') button.title = wide ? '' : `Two projects per line once the panel is at least ${GRID_MIN_WIDTH}px wide`
  }
}

function setFilter(next: 'all' | 'attention'): void {
  if (next === activityFilter) return
  activityFilter = next
  activityRenderKey = ''
  renderActivity()
  // A selection stays selected; bring it back into view in whichever view now shows it.
  if (activitySelected) keepChartNodeVisible(`chart-node:${activitySelected}`)
  else if (activityHelper) keepChartNodeVisible(`chart-helper:${activityHelper}`)
}

function filterToggle(attentionCount: number, total: number): HTMLElement {
  const row = element('div', 'chart-filter')
  row.setAttribute('role', 'group')
  row.setAttribute('aria-label', 'Show agents')
  for (const [value, label] of [['all', 'All'], ['attention', 'Needs attention']] as const) {
    const button = action(label, () => setFilter(value))
    button.classList.add('chart-filter-button')
    button.dataset.focusKey = `filter:${value}`
    button.setAttribute('aria-pressed', String(activityFilter === value))
    row.append(button)
  }
  const hint = element('span', 'chart-filter-hint', activityFilter === 'attention' ? `${attentionCount} of ${total} need attention` : '')
  hint.setAttribute('aria-live', 'polite')
  row.append(hint, countsLine(), layoutToggle())
  return row
}

function attentionEmpty(): HTMLElement {
  const box = element('section', 'chart-shell chart-empty')
  box.append(element('p', '', 'Nothing in any project is blocked or has failed.'), element('p', 'quiet', 'Only reported blocked states and failure outcomes count; finished and running agents are still in All.'))
  const all = action('Show all agents', () => setFilter('all'))
  all.dataset.focusKey = 'chart-empty-all'
  box.append(all)
  return box
}

function chartView(projectId: string, projectName: string, roots: FamilyNode[], attentionOnly: boolean, order: readonly string[]): HTMLElement {
  const key = chartKey(projectId, attentionOnly ? 'attention' : 'all')
  const isFolded = foldedCharts.has(projectId)
  const shell = element('section', `chart-shell chart-block${isFolded ? ' folded' : ''}`)
  shell.setAttribute('aria-label', `${projectName} agents`)
  const toolbar = element('div', 'chart-toolbar')
  const fold = action(isFolded ? '▸' : '▾', () => {
    slideSoon()
    if (!foldedCharts.delete(projectId)) foldedCharts.add(projectId)
    activityRenderKey = ''
    renderActivity()
  })
  fold.classList.add('chart-fold')
  fold.dataset.focusKey = `chart-fold:${projectId}`
  fold.setAttribute('aria-expanded', String(!isFolded))
  fold.setAttribute('aria-label', `${isFolded ? 'Unfold' : 'Fold'} ${projectName}`)
  const title = element('div', 'chart-heading')
  const members = office.agents.filter((agent) => (agent.projectId ?? agent.workspaceId ?? '') === projectId)
  const spaces = new Set(members.map((agent) => agent.workspaceId)).size
  const tokens = usageLine(office.usage?.projects[projectId])
  const count = `${members.length} agent${members.length === 1 ? '' : 's'}${spaces > 1 ? ` in ${spaces} workspaces` : ''}`
  title.append(element('strong', 'chart-title', projectName), element('span', 'chart-summary', ['Project', count, tokens].filter(Boolean).join(' · ')))
  const legend = element('div', 'chart-heading-row')
  legend.append(fold, title)
  const reset = action('Reset view', () => {
    const viewport = reset.closest('.chart-shell')!.querySelector<HTMLElement>('.chart-viewport')!
    viewport.scrollLeft = Math.max(0, Number(viewport.dataset.initialCenter) - viewport.clientWidth / 2)
    chartPositions.set(key, viewport.scrollLeft)
  })
  reset.dataset.focusKey = `chart-reset:${projectId}`
  reset.hidden = isFolded
  const tools = element('div', 'chart-tools')
  if (order.length > 1 && projectId) tools.append(...moveButtons(projectId, projectName, order, `chart-move:${projectId}`))
  tools.append(reset)
  toolbar.append(legend, tools)
  const viewport = element('div', 'chart-viewport')
  viewport.tabIndex = 0
  viewport.dataset.project = key
  viewport.dataset.focusKey = `chart:${projectId}`
  viewport.setAttribute('aria-label', 'Agent chart; scroll to see more agents')
  // Attention keeps its ancestors open so the path from the project stays visible.
  const open = attentionOnly ? attentionBranches(roots, expandedFamilies) : expandedFamilies
  const layout = chartLayout(roots, open)
  const first = attentionOnly ? layout.nodes.find((item) => needsAttention(item.node)) : undefined
  viewport.dataset.initialCenter = String(first ? first.x + NODE_WIDTH / 2 : layout.nodes[0] ? (layout.nodes[0].x + NODE_WIDTH / 2 + layout.width / 2) / 2 : layout.width / 2)
  const surface = element('div', 'chart-surface')
  surface.style.width = `${layout.width}px`
  surface.style.height = `${layout.height}px`
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.classList.add('chart-lines')
  svg.setAttribute('width', String(layout.width))
  svg.setAttribute('height', String(layout.height))
  svg.setAttribute('aria-hidden', 'true')
  const byKey = new Map(layout.nodes.map((node) => [node.node.key, node]))
  for (const edge of layout.edges) {
    const target = byKey.get(edge.to)!
    const parent = edge.from ? byKey.get(edge.from) : undefined
    const x1 = parent ? parent.x + NODE_WIDTH / 2 : layout.width / 2
    const y1 = parent ? parent.y + NODE_HEIGHT : 42
    const x2 = target.x + NODE_WIDTH / 2
    const y2 = target.y
    const middle = (y1 + y2) / 2
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    const path = parent && parent.y === target.y
      ? `M ${x1} ${y1} V ${y1 + 16} H ${x2} V ${target.y + NODE_HEIGHT}`
      : `M ${x1} ${y1} V ${middle} H ${x2} V ${y2}`
    line.setAttribute('d', path)
    line.setAttribute('class', `chart-edge ${edge.kind}`)
    svg.append(line)
  }
  surface.append(svg)
  const hub = element('div', 'chart-hub', projectName)
  hub.style.left = `${layout.width / 2}px`
  surface.append(hub)
  const now = Date.now()
  for (const item of layout.nodes) {
    const node = item.node
    const selected = (node.agent && node.agent.id === activitySelected) || (!node.agent && node.key === activityHelper)
    const context = attentionOnly && !selected && !needsAttention(node)
    const card = element('div', `chart-node${selected ? ' selected' : ''}${context ? ` context${hasAttention(node) ? ' ancestor' : ''}` : attentionOnly && needsAttention(node) ? ' attention' : ''}`)
    card.style.left = `${item.x}px`
    card.style.top = `${item.y}px`
    card.dataset.nodeKey = node.key
    const agent = node.agent
    const child = node.child
    const summary = element('button', `chart-node-button${agent ? '' : ' chart-helper'}`)
    if (agent) {
      summary.dataset.focusKey = `chart-node:${agent.id}`
      summary.setAttribute('aria-label', `${nameOf(agent)}, ${taskLabel(agent)}, ${stateOf(agent)}`)
      summary.setAttribute('aria-pressed', String(agent.id === activitySelected))
      summary.addEventListener('click', () => showActivity(agent.id))
      const face = document.createElement('canvas')
      face.width = face.height = 56
      face.className = 'chart-face'
      face.setAttribute('aria-hidden', 'true')
      const pen = face.getContext('2d') as CanvasRenderingContext2D
      pen.scale(4, 4)
      portrait(pen, lookOf(agent))
      const identity = element('span', 'chart-identity')
      identity.append(element('strong', 'chart-name', nameOf(agent)), element('span', 'chart-provider', agent.agent ? agent.agent[0].toUpperCase() + agent.agent.slice(1) : 'Unknown provider'))
      summary.append(face, identity)
      const state = currentStatus(agent.state, agent.outcome, false)
      summary.append(element('span', `chart-status status-${state.tone}`, `${state.label}${child && !child.reported ? ' · last reported' : ''}`))
      if (agent.unread) summary.append(element('span', 'chart-new', 'New'))
      const title = element('span', 'chart-task', taskLabel(agent))
      title.title = taskLabel(agent)
      summary.append(title)
    } else {
      summary.dataset.focusKey = `chart-helper:${node.key}`
      summary.setAttribute('aria-label', `${child?.name || 'Unknown child'}, ${child ? familyChildStatus(child, now) : 'state unavailable'}`)
      summary.setAttribute('aria-pressed', String(node.key === activityHelper))
      summary.addEventListener('click', () => showHelper(node))
      const work = [child?.tool, child?.description].filter(Boolean).join(' · ') || 'Work not reported'
      summary.append(element('span', 'chart-placeholder', '?'), element('strong', 'chart-name', child?.name || 'Unknown child'), element('span', `chart-status status-${child?.reported ? child.state : 'unknown'}`, child?.reported ? child.state === 'unknown' ? 'State unavailable' : child.state === 'done' ? 'Done · outcome unknown' : child.state : 'Last reported'), element('span', 'chart-task', work))
    }
    card.append(summary)
    if (node.children.some((childNode) => !childNode.cyclic)) {
      const forced = attentionOnly && !expandedFamilies.has(node.key) && open.has(node.key)
      const isOpen = open.has(node.key)
      const branch = action(isOpen ? '−' : '+', () => {
        if (forced) return
        if (isOpen) expandedFamilies.delete(node.key)
        else expandedFamilies.add(node.key)
        activityRenderKey = ''
        renderActivity()
      })
      branch.classList.add('chart-branch')
      branch.dataset.focusKey = `chart-branch:${node.key}`
      branch.setAttribute('aria-expanded', String(isOpen))
      branch.setAttribute('aria-label', forced ? 'Open to show an agent that needs attention' : `${isOpen ? 'Collapse' : 'Expand'} reported children`)
      if (forced) branch.setAttribute('aria-disabled', 'true')
      card.append(branch)
    }
    if (child && !child.reported) card.title = 'No longer reported; this does not mean finished'
    if (node.relationship === 'multiple') card.title = 'Multiple reported parents; shown as project member'
    if (node.relationship === 'cycle-anchor') card.title = 'Cyclic reported relationship; shown as project member'
    if (node.parentNote) card.title = node.parentNote
    surface.append(card)
  }
  viewport.append(surface)
  shell.append(toolbar, viewport)
  return shell
}

/* Acting on an agent from its drawer: jump to it, send it an instruction, compact it. The worker says
 * what Orca lets a plugin do for each agent; whatever it cannot do is left out, not shown failing.
 * The controls are built once for each agent the drawer opens on and then updated where they stand.
 * Rebuilding them would lose the caret, selection, IME composition and undo history in the box, and
 * a button replaced between mouse down and up drops the click. */
const ACTIONS_FRESH_MS = 15000
const NO_ACTIONS: AgentActions = { goTo: null, send: false, compact: null }
/** What the worker last said each agent allows, and when it was asked. */
const actionsOf = new Map<string, { at: number; value: AgentActions; signature: string; ready: boolean }>()
const actionRequests = new Map<string, number>()
let actionRequestId = 0
function actionSignature(agent: AgentView): string {
  return JSON.stringify([agent.sessionId, agent.terminalId, agent.paneKey, agent.workspaceId, agent.hostId, agent.state])
}
/** What an action is doing, or last said, for one agent; cleared when the drawer closes or moves on. */
const acting = new Map<string, { busy?: 'go' | 'send' | 'compact'; confirm?: boolean; note?: string; error?: string }>()

type Controls = {
  agentId: string
  /** What was last shown, so an unchanged state touches nothing. */
  key: string
  shown: string
  root: HTMLElement
  goWrap: HTMLElement
  go: HTMLButtonElement
  goFine: HTMLElement
  activity: HTMLElement
  blocked: HTMLElement
  form: HTMLElement
  field: HTMLTextAreaElement
  send: HTMLButtonElement
  compact: HTMLElement
  ask: HTMLButtonElement
  confirm: HTMLElement
  confirmText: HTMLElement
  yes: HTMLButtonElement
  no: HTMLButtonElement
  notes: HTMLElement
}
/** The controls of the agent the drawer is open on, if it is open on one. */
let controls: Controls | null = null

/** Asks the worker what this agent allows, unless it was asked a moment ago. */
function refreshActions(agentId: string, now: number): void {
  const agent = office.agents.find((item) => item.id === agentId)
  if (!agent) return
  const signature = actionSignature(agent)
  const known = actionsOf.get(agentId)
  if (known?.signature === signature && now - known.at < ACTIONS_FRESH_MS) return
  const requestId = ++actionRequestId
  actionRequests.set(agentId, requestId)
  const matching = known?.signature === signature
  actionsOf.set(agentId, { at: now, value: matching ? known.value : NO_ACTIONS, signature, ready: matching && known.ready })
  void orca.plugin
    .request('office.actions', { agentId })
    .catch((): AgentActions => NO_ACTIONS)
    .then((value) => {
      if (actionRequests.get(agentId) !== requestId) return
      const current = office.agents.find((item) => item.id === agentId)
      if (!current) { actionsOf.delete(agentId); return }
      if (actionSignature(current) !== signature) { refreshActions(agentId, Date.now()); return }
      actionsOf.set(agentId, { at: Date.now(), value, signature, ready: true })
      redrawDrawer()
      if (currentPage === 'attention') renderAttentionPage()
    })
}

/** Brings the drawer up to date; every part of it skips what has not changed. */
function redrawDrawer(): void {
  renderDrawer()
}

const setText = (node: HTMLElement, text: string): void => { if (node.textContent !== text) node.textContent = text }
/** Puts exactly the wanted children in `parent`, in order, moving only what is out of place: a node that
 *  is already where it belongs (the box being typed in) is never taken out and put back. */
function show(parent: HTMLElement, parts: [HTMLElement, boolean][]): void {
  let at: ChildNode | null = parent.firstChild
  for (const [node, wanted] of parts) {
    if (wanted && at === node) at = node.nextSibling
    else if (wanted) parent.insertBefore(node, at)
    else if (node.parentNode === parent) {
      if (at === node) at = node.nextSibling
      node.remove()
    }
  }
}

/** Runs one action the person asked for and shows how it went. Nothing here runs by itself. */
async function runAction(c: Controls, kind: 'go' | 'send' | 'compact', text = ''): Promise<void> {
  const id = c.agentId
  if (acting.get(id)?.busy) return
  const held = c.root.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null
  acting.set(id, { busy: kind })
  redrawDrawer()
  let result: ActionResult
  try {
    result = await (kind === 'go'
      ? orca.plugin.request('office.goTo', { agentId: id })
      : kind === 'send'
        ? orca.plugin.request('office.send', { agentId: id, text })
        : orca.plugin.request('office.compact', { agentId: id }))
  } catch {
    result = { ok: false, error: 'Orca did not answer.' }
  }
  // The drawer was closed or moved to another agent while Orca worked: this is no longer on screen.
  if (controls !== c) return
  if (result.ok) {
    // Text typed while the request was out stays; only what was sent goes.
    if (kind === 'send' && c.field.value === text) c.field.value = ''
    acting.set(id, { note: result.note ?? (kind === 'send' ? 'Sent.' : kind === 'compact' ? 'Compact command sent.' : undefined) })
  } else {
    acting.set(id, { error: result.error })
    // The terminal may have closed: ask again what is still possible.
    actionsOf.delete(id)
    refreshActions(id, Date.now())
  }
  redrawDrawer()
  // A button that was busy (or swapped away) must not take the keyboard user's place with it.
  const back = held === c.yes ? c.ask : held
  const gone = !!held && ((held as HTMLButtonElement).disabled || !held.isConnected)
  const lost = !document.activeElement || document.activeElement === document.body
  if (back && (gone || lost) && back.isConnected && !(back as HTMLButtonElement).disabled) back.focus({ preventScroll: true })
}

/** Builds Go to agent, the instruction box and Compact, all hidden until the worker says they apply. */
function buildControls(agent: AgentView): Controls {
  const id = agent.id
  const root = element('div', 'drawer-actions')

  const goWrap = element('div', 'go-agent')
  const go = element('button', 'action primary', 'Go to agent') as HTMLButtonElement
  go.dataset.focusKey = `${id}:go`
  const goFine = element('p', 'drawer-fine', 'Orca can open its workspace, but The Lobby cannot select this agent’s tab.')
  goWrap.append(go, goFine)

  const activity = element('div', 'detail-actions')
  const view = action('View in Activity', () => showActivity(id, false))
  view.dataset.focusKey = viewActivityFocusKey(id)
  activity.append(view)

  const blocked = element('p', 'drawer-fine')

  const form = element('div', 'instruction')
  const label = element('label', 'instruction-label', 'Send an instruction') as HTMLLabelElement
  const field = document.createElement('textarea')
  field.id = `instruction-${id}`
  label.htmlFor = field.id
  field.rows = 2
  field.placeholder = 'Enter sends · Shift+Enter adds a line'
  field.maxLength = 8000
  field.dataset.focusKey = `${id}:instruction`
  const send = element('button', 'action', 'Send') as HTMLButtonElement
  send.dataset.focusKey = `${id}:send`
  send.disabled = true
  const row = element('div', 'instruction-row')
  row.append(field, send)
  form.append(label, row)

  const compact = element('div', 'compact')
  const ask = element('button', 'action', 'Compact conversation') as HTMLButtonElement
  ask.dataset.focusKey = `${id}:compact`
  const confirm = element('div', '')
  const confirmText = element('p', 'drawer-line')
  const yes = element('button', 'action') as HTMLButtonElement
  yes.dataset.focusKey = `${id}:compact-yes`
  const no = element('button', 'action', 'Cancel') as HTMLButtonElement
  no.dataset.focusKey = `${id}:compact-no`
  const confirmRow = element('div', 'detail-actions')
  confirmRow.append(yes, no)
  confirm.append(confirmText, confirmRow)
  compact.append(ask, confirm)

  const notes = element('div', '')
  root.append(goWrap, activity, blocked, form, compact, notes)

  const c: Controls = { agentId: id, key: '', shown: '', root, goWrap, go, goFine, activity, blocked, form, field, send, compact, ask, confirm, confirmText, yes, no, notes }
  go.addEventListener('click', () => void runAction(c, 'go'))
  field.addEventListener('input', () => syncSend(c))
  const submit = (): void => {
    if (field.readOnly || !field.value.trim()) return
    void runAction(c, 'send', field.value)
  }
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    // Holding Enter must not send the same text again and again.
    if (!event.repeat) submit()
  })
  send.addEventListener('click', submit)
  ask.addEventListener('click', () => {
    acting.set(id, { confirm: true })
    redrawDrawer()
    yes.focus({ preventScroll: true })
  })
  no.addEventListener('click', () => {
    acting.delete(id)
    redrawDrawer()
    ask.focus({ preventScroll: true })
  })
  yes.addEventListener('click', () => void runAction(c, 'compact'))
  return c
}

/** Send follows what is typed, so it is checked on every call, not only when the state changes. */
function syncSend(c: Controls): void {
  const disabled = acting.get(c.agentId)?.busy === 'send' || !c.field.value.trim()
  if (c.send.disabled !== disabled) c.send.disabled = disabled
}

/** Shows what the worker allows and what an action last said, changing only what differs. */
function syncControls(c: Controls, agent: AgentView): void {
  syncSend(c)
  const reach = actionsOf.get(c.agentId)?.value ?? NO_ACTIONS
  const state = acting.get(c.agentId)
  const key = JSON.stringify([reach, state, agent.state, currentPage])
  if (key === c.key) return
  c.key = key

  c.go.disabled = state?.busy === 'go'
  setText(c.go, state?.busy === 'go' ? 'Going…' : 'Go to agent')
  c.go.title = reach.goTo === 'terminal' ? 'Bring its terminal to the front in Orca' : 'Show its workspace in Orca'
  show(c.goWrap, [[c.go, true], [c.goFine, reach.goTo === 'workspace']])

  const needsYou = agent.state === 'blocked' && (!!reach.goTo || reach.send)
  if (needsYou) setText(c.blocked, 'It needs you. Orca does not say what it is asking: use Go to agent to see the question.' + (reach.send ? ' The box below types text into its terminal, which may not answer a menu.' : ''))

  c.field.readOnly = state?.busy === 'send'
  setText(c.send, state?.busy === 'send' ? 'Sending…' : 'Send')
  syncSend(c)

  const confirming = !!reach.compact && !!state?.confirm
  c.ask.disabled = state?.busy === 'compact'
  setText(c.ask, state?.busy === 'compact' ? 'Compacting…' : 'Compact conversation')
  c.ask.title = reach.compact ? `Sends ${reach.compact} to the agent, after you confirm` : ''
  if (reach.compact) {
    setText(c.confirmText, `Send ${reach.compact} to this agent? It summarizes the conversation to free up room, and cannot be undone.`)
    setText(c.yes, `Send ${reach.compact}`)
  }
  show(c.compact, [[c.ask, !confirming], [c.confirm, confirming]])

  const shown = state?.error ? `error:${state.error}` : state?.note ? `note:${state.note}` : ''
  if (shown !== c.shown) {
    c.shown = shown
    if (!shown) c.notes.replaceChildren()
    else {
      const line = element('p', state?.error ? 'action-error' : 'action-note', state?.error ?? state?.note)
      line.setAttribute('role', state?.error ? 'alert' : 'status')
      c.notes.replaceChildren(line)
    }
  }
  show(c.root, [
    [c.goWrap, !!reach.goTo],
    [c.activity, currentPage === 'office'],
    [c.blocked, needsYou],
    [c.form, reach.send],
    [c.compact, !!reach.compact],
    [c.notes, !!c.notes.childElementCount]
  ])
}

/* The agent drawer: a bottom sheet over the whole panel, shared by Office and Activity. */
const scrim = element('div', 'scrim')
scrim.setAttribute('aria-hidden', 'true')
scrim.addEventListener('click', () => closeDrawer())
const sheet = element('div', 'sheet')
sheet.setAttribute('role', 'dialog')
sheet.setAttribute('aria-modal', 'true')
sheet.setAttribute('aria-labelledby', 'drawer-title')
const sheetBody = element('div', 'sheet-body')
sheet.append(element('div', 'sheet-grab'), sheetBody)
/** The drawer's information, which is rebuilt when its data changes; the action area sits between. */
const topHost = element('div', 'drawer-part')
const restHost = element('div', 'drawer-part')
let drawerHelper: FamilyNode | null = null
let drawerKey = ''
let drawerGeneration = 0
let drawerAgentIdentity: string | null = null
/** Where focus goes back to when the drawer closes. */
let drawerOpener: string | null = null

function drawerAgent(): AgentView | undefined {
  const id = currentPage === 'office' ? selected : currentPage === 'attention' ? attentionDrawerAgent : currentPage === 'activity' ? activitySelected : null
  return id ? office.agents.find((agent) => agent.id === id) : undefined
}

/** What Activity says of the agent's parent, on the Activity page only. */
function parentNoteOf(agent: AgentView): string | undefined {
  if (currentPage !== 'activity') return undefined
  const project = office.agents.filter((item) => (item.projectId ?? item.workspaceId ?? '') === (agent.projectId ?? agent.workspaceId ?? ''))
  return findAgentNode(buildFamilyTree(project), agent.id)?.parentNote
}

/** Brings the action area up to date and sets it between the information above and below it. */
function placeDrawer(agent: AgentView | undefined): void {
  if (controls && agent) {
    syncControls(controls, agent)
    show(sheetBody, [[topHost, true], [controls.root, controls.root.childElementCount > 0], [restHost, true]])
  } else show(sheetBody, [[topHost, true], [restHost, true]])
}

/** Opens, refreshes or closes the drawer to match the current page's selection.
 *  The information is rebuilt only when its data changes, the action area never is while the drawer stays
 *  on the same agent, and times are rewritten in place. This runs every second. */
function renderDrawer(): void {
  const now = Date.now()
  const agent = drawerAgent()
  if (drawerAgentIdentity !== (agent?.id ?? null)) {
    drawerAgentIdentity = agent?.id ?? null
    drawerGeneration++
  }
  const helper = !agent && currentPage === 'activity' ? drawerHelper : null
  // Leaving an agent (closed, another picked, or it left) drops its draft and old notes with it.
  if (controls && controls.agentId !== agent?.id) {
    controls.root.remove()
    controls = null
    acting.clear()
  }
  if (!agent && !helper) {
    if (sheet.isConnected) { scrim.remove(); sheet.remove(); document.documentElement.classList.remove('drawer-open') }
    drawerKey = ''
    clockNodes = []
    acting.clear()
    return
  }
  if (agent) {
    refreshActions(agent.id, now)
    if (!controls) {
      controls = buildControls(agent)
      // The previous / next shortcuts step on from the agent the person is looking at.
      void orca.plugin.request('office.select', { agentId: agent.id }).catch(() => {})
    }
  }
  const changes = agent?.workspaceId ? office.changes[agent.workspaceId] : undefined
  const links = agent?.workspaceId ? office.links[agent.workspaceId] : undefined
  const used = agent?.workspaceId ? office.usage?.workspaces[agent.workspaceId] : undefined
  // lastSeenAt moves with every roster poll and only feeds times that are rewritten in place.
  const key = JSON.stringify([currentPage, agent && { ...agent, lastSeenAt: 0 }, agent && nameOf(agent), agent && overdue(agent, now, prefs.stuckMinutes)?.kind, agent && parentNoteOf(agent), helper?.key, helper?.child, agent && picked.get(agent.id), agent?.completionId && office.reviewedCompletions?.includes(agent.completionId), agent?.completionId && reviewPending.has(agent.completionId), agent?.completionId && reviewErrors.get(agent.completionId), allCalls, changes, links, used, prefs.stuckMinutes])
  const opening = !sheet.isConnected
  if (key !== drawerKey || opening) {
    drawerKey = key
    const inInfo = topHost.contains(document.activeElement) || restHost.contains(document.activeElement)
    const focused = inInfo ? (document.activeElement as HTMLElement).dataset.focusKey : undefined
    const previousDetails = restHost.querySelector<HTMLDetailsElement>('details.drawer-extra')
    const keepDetailsOpen = !!previousDetails && previousDetails.dataset.agentId === agent?.id && previousDetails.open
    const top = sheetBody.scrollTop
    clockNodes = []
    const [upper, lower] = agent ? agentDrawer(agent, now) : [helperDrawer(helper!, now), []]
    const nextDetails = lower.find((node): node is HTMLDetailsElement => node instanceof HTMLDetailsElement && node.classList.contains('drawer-extra'))
    if (nextDetails) nextDetails.open = !!keepDetailsOpen
    topHost.replaceChildren(...upper)
    restHost.replaceChildren(...lower)
    placeDrawer(agent)
    if (opening) {
      drawerOpener = agent ? (currentPage === 'office' ? `office-row:${agent.id}` : currentPage === 'attention' ? `attention-title:${agent.id}` : `chart-node:${agent.id}`) : `chart-helper:${helper!.key}`
      sheet.classList.toggle('still', still())
      scrim.classList.toggle('still', still())
      document.body.append(scrim, sheet)
      document.documentElement.classList.add('drawer-open')
      sheet.querySelector<HTMLElement>('[data-focus-key="drawer-close"]')?.focus({ preventScroll: true })
      return
    }
    sheetBody.scrollTop = top
    if (focused) restoreFocus(focusTarget([...sheet.querySelectorAll<HTMLElement>('[data-focus-key]')].map((node) => ({ key: node.dataset.focusKey ?? '', target: node })), focused))
  }
  placeDrawer(agent)
  tickClock(now)
}

function closeDrawer(returnFocusKey?: string): void {
  if (!sheet.isConnected) return
  const opener = returnFocusKey ?? drawerOpener
  if (currentPage === 'office') {
    selected = null
    listed = ''
    renderList()
  } else if (currentPage === 'attention') {
    attentionDrawerAgent = null
    renderAttentionPage()
  } else {
    activitySelected = null
    activityHelper = null
    activityRenderKey = ''
    renderActivity()
  }
  renderDrawer()
  const target = opener ? document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(opener)}"]`) : null
  if (target?.isConnected) target.focus({ preventScroll: true })
  else if (currentPage === 'attention') attentionList.querySelector<HTMLElement>('.attention-heading')?.focus({ preventScroll: true })
}

function drawerHead(title: string, subtitle: HTMLElement | string, face?: HTMLElement): HTMLElement {
  const head = element('div', 'drawer-head')
  if (face) head.append(face)
  const titles = element('div', 'drawer-titles')
  const heading = element('h2', '', title)
  heading.id = 'drawer-title'
  heading.title = title
  titles.append(heading, typeof subtitle === 'string' ? element('p', 'drawer-sub', subtitle) : subtitle)
  const close = action('×', () => closeDrawer())
  close.classList.add('drawer-close')
  close.dataset.focusKey = 'drawer-close'
  close.setAttribute('aria-label', 'Close')
  head.append(titles, close)
  return head
}

/** The drawer's information as the part above the action area and the part below it. */
function agentDrawer(agent: AgentView, now: number): [HTMLElement[], HTMLElement[]] {
  const live = (): AgentView => office.agents.find((other) => other.id === agent.id) ?? agent
  const face = document.createElement('canvas')
  face.className = 'face drawer-face'
  face.width = face.height = 56
  face.setAttribute('aria-hidden', 'true')
  const pen = face.getContext('2d') as CanvasRenderingContext2D
  pen.scale(4, 4)
  portrait(pen, lookOf(agent))
  const sub = element('p', 'drawer-sub', nameOf(agent))
  appendAgentLabel(sub, agent)
  const status = currentStatus(agent.state, agent.outcome, false)
  const state = element('span', `state status-${status.tone}`)
  state.append(element('i', 'dot'), status.label)
  const lines = [timed(element('p', 'drawer-line'), (at) => activityTimeLine(live(), at), now)]
  const parentNote = parentNoteOf(agent)
  if (parentNote) lines.push(element('p', 'drawer-line', parentNote))
  const late = overdue(agent, now, prefs.stuckMinutes)
  if (late) {
    lines.push(timed(element('p', 'drawer-line quiet-label'), (at) => {
      const current = overdue(live(), at, prefs.stuckMinutes)
      return !current ? '' : current.kind === 'quiet' ? `No activity seen for ${since(current.since, at)}` : `Has needed you for ${since(current.since, at)}`
    }, now))
  }
  const summary = element('div', 'drawer-status')
  summary.append(state, ...lines)
  const upper = [drawerHead(taskLabel(agent), sub, face), summary]
  if (agent.reply) {
    const result = note(`${agent.id}:replied`, 'replied', 'Result (excerpt)', agent.reply)
    result.classList.add('drawer-result')
    upper.push(result)
  }
  if (agent.state === 'done' && agent.completionId) {
    const completionId = agent.completionId
    const review = element('div', 'drawer-review')
    const reviewed = office.reviewedCompletions?.includes(completionId) ?? false
    const pending = reviewPending.has(completionId)
    const error = reviewErrors.get(completionId)
    if (reviewed || pending) {
      const status = element('p', 'drawer-review-status', reviewed ? 'Reviewed in The Lobby.' : 'Saving Reviewed state…')
      status.dataset.focusKey = `drawer-review:${agent.id}`
      status.tabIndex = -1
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      review.append(status)
    } else {
      const button = action(error ? 'Retry Mark Reviewed' : 'Mark Reviewed', () => markReviewed(agent.id))
      button.dataset.focusKey = `drawer-review:${agent.id}`
      button.setAttribute('aria-label', `${error ? 'Retry Mark Reviewed' : 'Mark Reviewed'}: ${taskLabel(agent)}`)
      review.append(button)
      if (error) {
        const status = element('p', 'drawer-review-error', error)
        status.id = `drawer-review-error:${agent.id}`
        status.setAttribute('role', 'alert')
        button.setAttribute('aria-describedby', status.id)
        review.append(status)
      }
    }
    upper.push(review)
  }
  return [upper, [details(agent, now)]]
}

function helperDrawer(node: FamilyNode, now: number): HTMLElement[] {
  const child = node.child!
  const lines = [timed(element('p', 'drawer-line'), (at) => `${familyChildStatus(child, at)}${!child.reported ? ` · last state: ${child.state === 'unknown' ? 'unavailable' : child.state}` : ''}`, now)]
  if (child.tool) lines.push(element('p', 'drawer-line', `Operation: ${child.tool}`))
  if (child.description) lines.push(element('p', 'drawer-line', child.description))
  if (child.reported) lines.push(timed(element('p', 'drawer-line'), (at) => (child.lastReportedAt ? `Last observed ${since(child.lastReportedAt, at)} ago` : 'Last observation unavailable'), now))
  return [drawerHead(child.name || 'Unknown child', 'Reported helper · no linked agent session'), ...lines]
}

document.addEventListener('keydown', (event) => {
  if (!sheet.isConnected) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDrawer()
  } else if (event.key === 'Tab') {
    // Keep focus inside the drawer while it is open.
    const stops = [...sheet.querySelectorAll<HTMLElement>('button, a[href], input, textarea, summary, [tabindex]')]
      .filter((node) => node.tabIndex >= 0 && !node.matches(':disabled') && node.checkVisibility())
    if (!stops.length) return
    const first = stops[0], last = stops[stops.length - 1], current = document.activeElement
    if (event.shiftKey && (current === first || !sheet.contains(current))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (current === last || !sheet.contains(current))) { event.preventDefault(); first.focus() }
  }
})

/** Lays the rooms out for the panel's width and gives each one its section of the page. */
function arrange(): void {
  if (currentPage !== 'office') return
  // One column's width, inside its section's one-pixel border.
  const columns = document.documentElement.classList.contains('grid') ? 2 : 1
  const cssWidth = Math.floor((offices.clientWidth - (columns - 1) * GRID_GAP) / columns) - 2
  if (!cssWidth) return
  // A whole number of device pixels per office pixel keeps the art crisp.
  const ratio = window.devicePixelRatio || 1
  scale = Math.max(Math.ceil(1.5 * ratio), Math.floor((cssWidth * ratio) / TARGET_WIDTH)) / ratio
  width = Math.floor(cssWidth / scale)
  const order = projectOrder()
  rooms = layout(office, width, scale, folded, agentNames, order).rooms

  for (const [id, section] of sections) {
    if (rooms.some((room) => room.id === id)) continue
    section.root.remove()
    sections.delete(id)
  }
  for (const room of rooms) {
    const section = sections.get(room.id) ?? addSection(room)
    section.room = room
    const name = projectName(room.id)
    section.move.replaceChildren(...moveButtons(room.id, name, order, `room-move:${room.id}`))
    section.move.hidden = rooms.length < 2 || !room.id
  }
  placeInColumns(offices, rooms.map((room) => sections.get(room.id)!.root))
}

function addSection(room: Room): Section {
  const root = element('section', 'office')
  const canvas = document.createElement('canvas')
  const list = element('ul', 'roster')
  const usage = element('p', 'room-usage')
  usage.hidden = true
  const move = element('div', 'room-move')
  root.append(canvas, move, usage, list)
  const section: Section = {
    root,
    canvas,
    ctx: canvas.getContext('2d') as CanvasRenderingContext2D,
    list,
    usage,
    room,
    bubbles: [],
    move
  }
  sections.set(room.id, section)

  const point = (event: MouseEvent): [number, number] => {
    const box = canvas.getBoundingClientRect()
    return [
      (event.clientX - box.left) / scale,
      (event.clientY - box.top) / scale + section.room.top
    ]
  }
  const onSign = (event: MouseEvent): boolean =>
    point(event)[1] - section.room.top < section.room.head
  /** A bubble is its character's: clicking or pointing at either is the same. */
  const personAt = (event: MouseEvent): string | null =>
    pickBubble(section.bubbles, ...point(event)) ?? pick(actors, ...point(event))
  canvas.addEventListener('click', (event) => {
    if (!onSign(event)) return select(personAt(event))
    // The sign folds the room away and brings it back.
    slideSoon()
    folded.set(section.room.id, !section.room.collapsed)
    listed = ''
    renderList()
  })
  canvas.addEventListener('mousemove', (event) => {
    hovered = personAt(event)
    const agent = office.agents.find((other) => other.id === hovered)
    canvas.style.cursor = agent || onSign(event) ? 'pointer' : 'default'
    showHover(agent, event)
  })
  canvas.addEventListener('mouseleave', () => {
    hovered = null
    showHover(undefined)
  })
  return section
}

/** The card that follows the pointer over a person: who it is and what it is doing. */
function showHover(agent: AgentView | undefined, event?: MouseEvent): void {
  hover.hidden = !agent || !event
  if (!agent || !event) return
  const now = Date.now()
  const head = element('div', 'name', nameOf(agent))
  if (titleOf(agent)) head.append(element('span', 'title', titleOf(agent)))
  const parts = [
    head,
    element('div', 'doing', `${stateOf(agent)} \u00b7 ${doing(agent, now).text}`)
  ]
  if (agent.prompt) parts.push(element('div', 'said', agent.prompt))
  if (changeOf(agent)) parts.push(element('div', 'doing', `${changeOf(agent)} uncommitted`))
  hover.replaceChildren(...parts)
  // Beside the pointer, kept inside the panel.
  const left = Math.min(
    event.clientX + 12,
    document.documentElement.clientWidth - hover.offsetWidth - 6
  )
  hover.style.left = `${Math.max(6, left)}px`
  hover.style.top = `${event.clientY + 14}px`
}

function frame(): void {
  const time = performance.now()
  if (!shouldRenderOfficeFrame(currentPage)) {
    last = time
    return
  }
  arrange()
  if (!width) {
    last = time
    return
  }
  const seconds = Math.min(0.25, (time - last) / 1000)
  last = time
  const moved = step(actors, rooms, width, Date.now(), seconds, !placed || still())
  placed = true

  // Nothing to repaint between beats while everyone stands still.
  const beat = still() ? 0 : Math.floor(time / BEAT_MS)
  const period = periodOfHour(new Date().getHours())
  const now = Date.now()
  const bubbles = new Map<string, Bubble>()
  for (const agent of office.agents) {
    const said = bubbleFor(agent, now, prefs.stuckMinutes)
    if (said) bubbles.set(agent.id, said)
  }
  const dark = document.documentElement.classList.contains('dark')
  const state = JSON.stringify([
    beat,
    period,
    currentPage,
    primaryTabs[0]?.parentElement?.clientWidth ?? 0,
    width,
    rooms.map((room) => [
      room.id,
      room.height,
      room.labels,
      room.agents.map((agent) => [agent.id, agent.state, agent.outcome, agent.unread, observedActivity(agent, Date.now())])
    ]),
    selected,
    hovered,
    dark,
    prefs.palette,
    [...bubbles].map(([id, said]) => [id, said.text, said.tone])
  ])
  if (!moved && state === painted) return
  painted = state

  const ratio = window.devicePixelRatio || 1
  const style = getComputedStyle(document.documentElement)
  const themed = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  // The sign's pixels are 1.5 screen pixels, or the nearest whole number of device pixels.
  const unit = Math.max(1, Math.round(1.5 * ratio)) / ratio
  const bannerWidth = primaryTabs[0]?.parentElement?.clientWidth ?? 0
  const columns = Math.floor(bannerWidth / unit)
  if (banner.width !== Math.round(columns * unit * ratio)) {
    banner.width = Math.round(columns * unit * ratio)
    banner.height = Math.round(BANNER_ROWS * unit * ratio)
    banner.style.width = `${columns * unit}px`
    banner.style.height = `${BANNER_ROWS * unit}px`
  }
  bannerCtx.setTransform(unit * ratio, 0, 0, unit * ratio, 0, 0)
  drawBanner(bannerCtx, columns, beat)

  const theme = {
    card: themed('--ui-card', dark ? '#1e2028' : '#f5f5f7'),
    text: themed('--ui-foreground', dark ? '#e6e6ea' : '#1c1d22'),
    muted: themed('--ui-muted-foreground', '#888888'),
    border: themed('--ui-border', dark ? '#2c2e3a' : '#e2e2e8'),
    accent: themed('--ui-primary', '#4f8fe6')
  }
  for (const section of sections.values()) {
    const { canvas, ctx, room } = section
    const pixels = [Math.round(width * scale * ratio), Math.round(room.height * scale * ratio)]
    if (canvas.width !== pixels[0] || canvas.height !== pixels[1]) {
      canvas.width = pixels[0]
      canvas.height = pixels[1]
      canvas.style.width = `${width * scale}px`
      canvas.style.height = `${room.height * scale}px`
    }
    // Each canvas shows its own room's slice of the office.
    ctx.setTransform(scale * ratio, 0, 0, scale * ratio, 0, -room.top * scale * ratio)
    ctx.imageSmoothingEnabled = false
    section.bubbles = draw(ctx, {
      width,
      rooms: [room],
      actors,
      beat,
      period,
      scale,
      colors: paletteFor(prefs.palette, dark),
      theme,
      selected,
      hovered,
      framed: false,
      bubbles,
      motion: !still(),
      now
    })
  }
}

function refreshVisibleTimes(): void {
  if (currentPage === 'office') renderList()
  else if (currentPage === 'activity') renderActivity()
  else if (currentPage === 'attention') {
    const now = Date.now()
    for (const agent of office.agents) refreshActions(agent.id, now)
    refreshAttentionTimes(attentionList, office.agents, now)
  }
}

async function acceptSnapshot(snapshot: OfficeSnapshot, refreshNotifications = false): Promise<void> {
  await agentNamesReady
  const present = new Set(snapshot.agents.map((agent) => agent.id))
  for (const id of new Set([...actionsOf.keys(), ...actionRequests.keys()])) {
    if (present.has(id)) continue
    actionsOf.delete(id)
    actionRequests.delete(id)
  }
  office = { ...snapshot, journal: Array.isArray(snapshot.journal) ? snapshot.journal : [] }
  const previousNames = JSON.stringify([...agentNames])
  agentNames = assignAgentNames(snapshot.agents.map((agent) => agent.id), agentNames, coordinatorIds(snapshot.agents))
  if (JSON.stringify([...agentNames]) !== previousNames)
    void orca.storage.set(AGENT_NAMES_KEY, Object.fromEntries(agentNames)).catch(() => {})
  renderFilters()
  renderList()
  if (currentPage === 'activity') renderActivity()
  if (currentPage === 'attention') {
    renderAttentionPage()
    renderDrawer()
  }
  renderNotificationSettings(refreshNotifications)
}

function refresh(): void {
  void orca.plugin
    .request('office.snapshot')
    .then((snapshot) => {
      return acceptSnapshot(snapshot, true)
    })
    .then(() => {
      frame()
    })
    .catch((error) => {
      officeMessage.textContent = `The office is closed: ${error.message}`
    })
}

function applyPalette(): void {
  const root = document.documentElement
  const selectedPalette = PALETTES[prefs.palette]
  root.dataset.palette = prefs.palette
  if (selectedPalette.mode === 'orca') root.style.removeProperty('color-scheme')
  else root.style.colorScheme = selectedPalette.mode
  const variables = paletteVariables(prefs.palette)
  if (!variables) {
    for (const property of Object.keys(paletteVariables('catppuccin-mocha')!)) root.style.removeProperty(property)
  } else {
    for (const [property, value] of Object.entries(variables)) root.style.setProperty(property, value)
  }
  const style = getComputedStyle(root)
  const preview = settings.querySelector<HTMLElement>('.palette-preview')
  const swatch = preview?.querySelector<HTMLElement>('.palette-swatch')
  if (preview && swatch) {
    const colors = prefs.palette === 'orca'
      ? {
          background: style.getPropertyValue('--ui-card').trim(),
          foreground: style.getPropertyValue('--ui-foreground').trim(),
          accent: style.getPropertyValue('--ui-primary').trim()
        }
      : selectedPalette
    preview.style.background = colors.background
    preview.style.color = colors.foreground
    preview.textContent = `${selectedPalette.label} preview `
    const dot = document.createElement('span')
    dot.className = 'palette-swatch'
    dot.setAttribute('aria-hidden', 'true')
    dot.style.background = colors.accent
    preview.append(dot)
  }
  painted = ''
  frame()
}

/** Kept equal to orca-plugin.json's version. */
const VERSION = '1.3.0'
const SITE = 'https://lilykos.github.io/orca-the-lobby/'
const REPO = 'https://github.com/Lilykos/orca-the-lobby'

/** Who made this, what it is, and where to read more. Links open in the browser. */
function aboutCard(): HTMLElement {
  const about = element('section', 'about')
  about.setAttribute('aria-label', 'About The Lobby')
  const heading = element('p', 'about-title')
  heading.append(element('strong', '', 'The Lobby'), element('span', 'about-version', `v${VERSION}`))
  about.append(heading)
  const links = element('div', 'about-links')
  for (const [label, url] of [
    ['Website & guide', SITE],
    ['GitHub', REPO],
    ['What\'s new', `${REPO}/blob/main/CHANGELOG.md`],
    ['Report an issue', `${REPO}/issues`]
  ] as const) {
    const link = element('button', 'link about-link', `${label} ↗`)
    link.title = url
    link.dataset.focusKey = `about:${label}`
    link.addEventListener('click', () => void orca.shell?.openExternal(url))
    links.append(link)
  }
  about.append(links)
  return about
}

/** Settings controls are created once, then synchronized in place so storage changes keep focus. */
function renderSettings(): void {
  const choices: [Exclude<keyof Prefs, 'palette' | 'layout' | 'density' | 'selectedView' | 'stuckMinutes' | 'projectOrder'>, string][] = [
    ['notifyBlocked', 'Notify me when an agent needs me'],
    ['notifyDone', 'Notify me when a long turn ends'],
    ['animate', 'Animate the office']
  ]
  const existing = settings.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
  const existingPalette = settings.querySelector<HTMLSelectElement>('select[name="palette"]')
  const existingStuck = settings.querySelector<HTMLSelectElement>('select[name="stuck"]')
  const existingDensity = settings.querySelector<HTMLSelectElement>('select[name="density"]')
  const syncProjectOrder = (): void => {
    const orderSetting = settings.querySelector<HTMLElement>('.settings-order')
    if (!orderSetting) return
    const manualOrder = prefs.projectOrder.length > 0
    const label = manualOrder ? 'Projects use your manual room order.' : 'Projects follow Orca sidebar order.'
    const reset = orderSetting.querySelector<HTMLButtonElement>('[data-focus-key="settings-project-order-reset"]')
    let orderLabel = orderSetting.querySelector<HTMLElement>('.settings-label')
    if (!orderLabel) {
      orderLabel = element('span', 'settings-label')
      orderSetting.prepend(orderLabel)
    }
    orderLabel.textContent = label
    if (!manualOrder && reset) {
      const hadFocus = document.activeElement === reset
      orderSetting.tabIndex = -1
      reset.remove()
      if (hadFocus) orderSetting.focus({ preventScroll: true })
    } else if (manualOrder && !reset) {
      const next = action('Use the sidebar order again', () => {
        persistPrefsPatch({ projectOrder: [] })
        renderSettings()
        showOrder()
      })
      next.dataset.focusKey = 'settings-project-order-reset'
      orderSetting.append(next)
    }
  }
  if (existing.length === choices.length && existingPalette && existingStuck && existingDensity) {
    choices.forEach(([key]) => {
      const control = settings.querySelector<HTMLInputElement>(`input[data-pref-key="${key}"]`)
      if (control) control.checked = prefs[key]
    })
    existingPalette.value = prefs.palette
    existingStuck.value = String(prefs.stuckMinutes)
    existingDensity.value = prefs.density
    syncProjectOrder()
    applyPalette()
    return
  }
  const paletteSelect = document.createElement('select')
  paletteSelect.className = 'palette-select'
  paletteSelect.name = 'palette'
  paletteSelect.setAttribute('aria-label', 'Color palette')
  for (const choice of PALETTE_OPTIONS) {
    const option = document.createElement('option')
    option.value = choice.value
    option.textContent = choice.label
    paletteSelect.append(option)
  }
  paletteSelect.value = prefs.palette
  const preview = element('div', 'palette-preview', 'Palette preview')
  preview.setAttribute('role', 'status')
  preview.setAttribute('aria-live', 'polite')
  preview.append(element('span', 'palette-swatch'))
  paletteSelect.addEventListener('change', () => {
    persistPrefsPatch({ palette: paletteSelect.value as PaletteChoice })
    applyPalette()
  })
  const controls = choices.map(([key, label]) => {
    const row = element('label', 'choice settings-row settings-check')
    row.dataset.prefLabel = key
    const text = element('span', 'settings-label', label)
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = prefs[key]
    box.dataset.prefKey = key
    box.addEventListener('change', () => {
      persistPrefsPatch({ [key]: box.checked })
    })
    row.append(text, box)
    return row
  })
  const selectRow = (key: string, label: string, control: HTMLSelectElement): HTMLLabelElement => {
    const row = element('label', 'settings-row') as HTMLLabelElement
    row.dataset.prefLabel = key
    row.append(element('span', 'settings-label', label), control)
    return row
  }
  const paletteLabel = selectRow('palette', 'Color palette', paletteSelect)
  const densityLabel = element('label', 'settings-row') as HTMLLabelElement
  densityLabel.dataset.prefLabel = 'density'
  const densitySelect = document.createElement('select')
  densitySelect.className = 'palette-select'
  densitySelect.name = 'density'
  densitySelect.setAttribute('aria-label', 'Display density')
  for (const [value, label] of [['comfortable', 'Comfortable'], ['compact', 'Compact']] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    densitySelect.append(option)
  }
  densitySelect.value = prefs.density
  densitySelect.addEventListener('change', () => {
    persistPrefsPatch({ density: densitySelect.value as Prefs['density'] })
    applyLayout()
  })
  densityLabel.append(element('span', 'settings-label', 'Display density'), densitySelect)

  const stuckLabel = element('label', 'settings-row') as HTMLLabelElement
  stuckLabel.dataset.prefLabel = 'stuckMinutes'
  const stuckSelect = document.createElement('select')
  stuckSelect.className = 'palette-select'
  stuckSelect.name = 'stuck'
  stuckSelect.setAttribute('aria-label', 'Notify me when an agent seems stuck')
  for (const minutes of STUCK_CHOICES) {
    const option = document.createElement('option')
    option.value = String(minutes)
    option.textContent = minutes ? `After ${minutes} minutes` : 'Off'
    stuckSelect.append(option)
  }
  stuckSelect.value = String(prefs.stuckMinutes)
  stuckSelect.addEventListener('change', () => {
    persistPrefsPatch({ stuckMinutes: Number(stuckSelect.value) })
    renderNotificationSettings()
  })
  stuckLabel.append(element('span', 'settings-label', 'Notify me when an agent seems stuck'), stuckSelect,
    element('span', 'setting-hint', 'After this long without activity or while it still needs you.'))

  const [notifyBlocked, notifyDone, animate] = controls
  const appearance = element('section', 'appearance-settings')
  const appearanceHeading = element('div', 'appearance-heading')
  const appearanceTitle = element('h2', '', 'Appearance')
  appearanceHeading.append(appearanceTitle)
  const bannerToggle = action(banner.hidden ? 'Show banner' : 'Hide banner', () => {
    banner.hidden = !banner.hidden
    bannerToggle.textContent = banner.hidden ? 'Show banner' : 'Hide banner'
    bannerToggle.setAttribute('aria-expanded', String(!banner.hidden))
  })
  bannerToggle.id = 'brand-toggle'
  bannerToggle.setAttribute('aria-controls', banner.id)
  bannerToggle.setAttribute('aria-expanded', String(!banner.hidden))
  appearanceHeading.append(bannerToggle)
  const appearanceGrid = element('div', 'settings-grid')
  appearanceGrid.append(paletteLabel, densityLabel, animate)
  preview.classList.add('settings-span')
  const bannerRow = element('div', 'settings-row')
  bannerRow.append(element('span', 'settings-label', 'Pixel banner'), bannerToggle)
  appearanceGrid.insertBefore(bannerRow, appearanceGrid.children[2])
  appearanceGrid.append(preview)
  appearance.append(appearanceHeading, appearanceGrid)

  const orderSetting = element('div', 'settings-order')
  appearance.append(orderSetting)
  syncProjectOrder()

  const privacy = element('section', 'local-data')
  const privacyHeading = element('h2', '', 'Local data')
  privacy.append(privacyHeading,
    element('p', '', 'Local observed activity is kept for up to 24 hours; oldest records are dropped first to fit Orca storage. Clearing history does not change Orca unread.'),
    element('p', '', 'Result excerpts and tool details may contain sensitive content. Prompts are not stored in the journal.'))
  const clearFeedback = element('p', 'history-feedback')
  clearFeedback.setAttribute('role', 'status')
  const clearPrompt = element('div', 'settings-clear-confirm')
  clearPrompt.hidden = true
  const clearQuestion = element('p', '', 'Clear local activity history from The Lobby?')
  clearQuestion.id = 'settings-clear-question'
  clearPrompt.append(clearQuestion)
  const clearActions = element('div', 'settings-clear-actions')
  const clearConfirm = action('Clear history', () => { void clearHistory() })
  clearConfirm.dataset.focusKey = 'settings-clear-confirm'
  clearConfirm.setAttribute('aria-describedby', clearQuestion.id)
  const clearCancel = action('Cancel', () => {
    clearPrompt.hidden = true
    clearFeedback.textContent = ''
    clearFeedback.setAttribute('role', 'status')
    if (document.activeElement === clearCancel) clear.focus({ preventScroll: true })
  })
  clearCancel.dataset.focusKey = 'settings-clear-cancel'
  clearCancel.setAttribute('aria-describedby', clearQuestion.id)
  clearActions.append(clearConfirm, clearCancel)
  clearPrompt.append(clearActions)
  const clear = action('Clear activity history', () => {
    clearPrompt.hidden = false
    clearConfirm.textContent = 'Clear history'
    clearFeedback.textContent = ''
    clearFeedback.setAttribute('role', 'status')
    clearCancel.focus({ preventScroll: true })
  })
  clear.dataset.focusKey = 'settings-clear-open'
  privacy.append(clear, clearPrompt, clearFeedback)
  async function clearHistory(): Promise<void> {
    clearConfirm.disabled = true
    clearCancel.disabled = true
    clearConfirm.textContent = 'Clearing…'
    clearFeedback.textContent = 'Clearing local activity history…'
    clearFeedback.setAttribute('role', 'status')
    try {
      const result = await orca.plugin.request('office.clearHistory')
      if (result.cleared) {
        void orca.storage.set('activity-view-cursors', {}).catch(() => {})
        clearFeedback.textContent = 'Local activity history cleared.'
        clearFeedback.setAttribute('role', 'status')
        const ownsFocus = clearPrompt.contains(document.activeElement)
        clearPrompt.hidden = true
        if (ownsFocus) clear.focus({ preventScroll: true })
      } else {
        clearFeedback.textContent = 'History cleared in memory, but could not be cleared from storage.'
        clearFeedback.setAttribute('role', 'alert')
        clearConfirm.textContent = 'Try again'
      }
      refresh()
    } catch {
      clearFeedback.textContent = 'Could not clear local activity history.'
      clearFeedback.setAttribute('role', 'alert')
      clearConfirm.textContent = 'Try again'
    } finally {
      clearConfirm.disabled = false
      clearCancel.disabled = false
    }
  }

  const notifications = element('section', 'notification-controls')
  const notificationHeading = element('h2', '', 'Notifications')
  notificationHeading.id = 'notification-controls-heading'
  notifications.setAttribute('aria-labelledby', notificationHeading.id)
  const notificationGrid = element('div', 'settings-grid')
  notificationGrid.append(notifyBlocked, notifyDone, stuckLabel)
  const notificationDisclosure = element('details', 'notification-disclosure') as HTMLDetailsElement
  notificationDisclosure.id = 'notification-disclosure'
  const notificationSummary = element('summary', 'notification-summary-label', 'Project and episode controls')
  notificationSummary.id = 'notification-summary'
  const notificationSummaryStatus = element('span', 'notification-summary-status')
  notificationSummaryStatus.id = 'notification-summary-status'
  notificationSummary.append(notificationSummaryStatus)
  notificationDisclosure.append(notificationSummary, notificationRows)
  const notificationIssues = element('div', 'notification-issues')
  notificationDisclosure.addEventListener('toggle', () => {
    notificationIssues.hidden = notificationDisclosure.open || !notificationIssues.childElementCount
  })
  notifications.append(notificationHeading, notificationGrid,
    element('p', 'notification-note', 'Project mute pauses all Lobby notifications for that project. Episode snooze pauses repeat reminders only for this episode; it does not hide the agent.'),
    notificationDisclosure, notificationIssues)

  settings.replaceChildren(appearance, notifications, privacy, aboutCard())
  applyPalette()
}

for (const tab of primaryTabs) {
  tab.addEventListener('click', () => setPage(tab.id.replace('-tab', '')))
  tab.addEventListener('keydown', (event) => {
    const index = primaryTabs.indexOf(tab)
    const targetIndex = tabTargetIndex(index, event.key, primaryTabs.length)
    if (targetIndex !== null) {
      event.preventDefault()
      const target = primaryTabs[targetIndex]
      target.focus()
      setPage(target.id.replace('-tab', ''))
    }
  })
}
renderSettings()
const prefsStatus = document.getElementById('prefs-status') as HTMLElement
let preferencesReady = false
let prefsRevision = 0
let installationRevision = 0
let prefsWriteActive = false
let prefsRefreshPending = false
let prefsRetryAttempt = 0
let prefsRetryTimer: ReturnType<typeof setTimeout> | undefined
let pendingPrefsPatch: Partial<Prefs> = {}
let prefsFieldRevision: Partial<Record<keyof Prefs, number>> = {}
let prefsIntentRevision = 0
let officeStorageWarning = ''
let prefsStorageWarning = ''
let installationKind: 'fresh' | 'legacy' | 'unknown' = 'unknown'
let viewPreferenceExplicit = false
let userSelectedView = false
function hasStoredView(value: unknown): boolean {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return stored.selectedView === 'office' || stored.selectedView === 'activity' || stored.selectedView === 'attention'
}
function applyStoredPrefs(value: unknown): void {
  prefs = { ...readPrefs(value, prefs.selectedView), ...pendingPrefsPatch }
  viewPreferenceExplicit ||= hasStoredView(value)
  renderSettings()
  applyLayout()
  showOrder()
  renderFilters()
  if (currentPage === 'attention') renderAttentionPage()
  renderNotificationSettings()
}
function persistPrefsPatch(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch }
  pendingPrefsPatch = { ...pendingPrefsPatch, ...patch }
  for (const key of Object.keys(patch) as (keyof Prefs)[]) prefsFieldRevision[key] = ++prefsIntentRevision
  if (prefsRetryAttempt >= 4) prefsRetryAttempt = 0
  if (!preferencesReady) return
  prefsStatus.textContent = 'Saving Lobby settings…'
  void flushPrefsWrites()
}
async function flushPrefsWrites(): Promise<void> {
  if (prefsWriteActive || !preferencesReady || !Object.keys(pendingPrefsPatch).length) return
  clearTimeout(prefsRetryTimer)
  prefsRetryTimer = undefined
  prefsWriteActive = true
  const patch = { ...pendingPrefsPatch }
  const revisions = { ...prefsFieldRevision }
  let saved = false
  try {
    const result = await orca.plugin.request('prefs.patch', { patch })
    if (!result.ok) throw new Error(result.error)
    for (const key of Object.keys(patch) as (keyof Prefs)[]) {
      if (prefsFieldRevision[key] === revisions[key]) {
        delete pendingPrefsPatch[key]
        delete prefsFieldRevision[key]
      }
    }
    prefsStorageWarning = ''
    prefsRetryAttempt = 0
    saved = true
  } catch {
    prefsStorageWarning = 'Could not save Lobby settings; your changes are still pending.'
    if (prefsRetryAttempt < 4) {
      const delay = Math.min(4_000, 250 * 2 ** prefsRetryAttempt++)
      prefsRetryTimer = setTimeout(() => {
        prefsRetryTimer = undefined
        void flushPrefsWrites()
      }, delay)
      prefsStorageWarning += ' Retrying shortly.'
    } else prefsStorageWarning += ' Change a setting to retry.'
  }
  prefsWriteActive = false
  if (prefsRefreshPending) {
    prefsRefreshPending = false
    void refreshStoredPrefs()
  }
  if (saved && Object.keys(pendingPrefsPatch).length) void flushPrefsWrites()
  else if (!Object.keys(pendingPrefsPatch).length) {
    prefsStatus.textContent = officeStorageWarning
  } else prefsStatus.textContent = prefsStorageWarning || officeStorageWarning
}
async function readCurrentPrefs(): Promise<unknown> {
  let revision = prefsRevision
  let value = await orca.storage.get(PREFS_KEY)
  while (revision !== prefsRevision) {
    revision = prefsRevision
    value = await orca.storage.get(PREFS_KEY)
  }
  return value
}
async function hydratePreferences(): Promise<void> {
  let revision = prefsRevision
  let markerRevision = installationRevision
  let [prefsResult, installResult] = await Promise.allSettled([
    readCurrentPrefs(),
    orca.plugin.request('office.installation')
  ])
  while (revision !== prefsRevision) {
    revision = prefsRevision
    prefsResult = await Promise.resolve(readCurrentPrefs()).then(
      (value) => ({ status: 'fulfilled', value } as const),
      (reason) => ({ status: 'rejected', reason } as const)
    )
  }
  while (markerRevision !== installationRevision) {
    markerRevision = installationRevision
    installResult = await Promise.resolve(orca.plugin.request('office.installation')).then(
      (value) => ({ status: 'fulfilled', value } as const),
      (reason) => ({ status: 'rejected', reason } as const)
    )
  }
  const installLoaded = installResult.status === 'fulfilled'
  const savedPrefs = prefsResult.status === 'fulfilled' ? prefsResult.value : null
  const prefsLoaded = prefsResult.status === 'fulfilled'
  installationKind = installResult.status === 'fulfilled' ? installResult.value.kind : 'unknown'
  viewPreferenceExplicit = hasStoredView(savedPrefs)
  const fallbackView = installationKind === 'fresh' ? 'attention' : 'office'
  prefs = { ...(prefsLoaded ? readPrefs(savedPrefs, fallbackView) : readPrefs(null, 'office')), ...pendingPrefsPatch }
  if (userSelectedView) prefs = { ...prefs, selectedView: currentPage as Prefs['selectedView'] }
  prefsStorageWarning = prefsResult.status === 'rejected' ? 'Could not load saved Lobby settings; keeping Office open.' : ''
  officeStorageWarning = !installLoaded || installationKind === 'unknown' ? 'Could not confirm Lobby installation state; keeping Office open.' : ''
  prefsStatus.textContent = prefsStorageWarning || officeStorageWarning
  renderSettings()
  applyLayout()
  renderFilters()
  setPage(prefs.selectedView, false)
  preferencesReady = true
  document.body.classList.add('prefs-ready')
  if (Object.keys(pendingPrefsPatch).length) void flushPrefsWrites()
}
async function refreshStoredPrefs(): Promise<void> {
  if (prefsWriteActive) { prefsRefreshPending = true; return }
  try {
    const value = await readCurrentPrefs()
    prefsStorageWarning = ''
    prefsStatus.textContent = officeStorageWarning
    applyStoredPrefs(value)
    if (Object.keys(pendingPrefsPatch).length) void flushPrefsWrites()
  } catch {
    prefsStorageWarning = 'Could not refresh saved Lobby settings; your current view is unchanged.'
    prefsStatus.textContent = prefsStorageWarning || officeStorageWarning
  }
}
async function refreshInstallation(): Promise<void> {
  try {
    const result = await orca.plugin.request('office.installation')
    if (result.kind !== 'fresh' && result.kind !== 'legacy') return
    installationKind = result.kind
    officeStorageWarning = ''
    prefsStatus.textContent = prefsStorageWarning
    if (!viewPreferenceExplicit && !userSelectedView) {
      prefs = { ...prefs, selectedView: installationKind === 'fresh' ? 'attention' : 'office' }
      setPage(prefs.selectedView, false)
    }
  } catch {
    officeStorageWarning = 'Could not confirm Lobby installation state; keeping Office open.'
    prefsStatus.textContent = prefsStorageWarning || officeStorageWarning
  }
}
orca.storage.onDidChange(({ key }) => {
  if (key === PREFS_KEY) {
    prefsRevision++
    if (preferencesReady) void refreshStoredPrefs()
  } else if (key === INSTALLATION_KEY) {
    installationRevision++
    if (preferencesReady) void refreshInstallation()
  }
})
void hydratePreferences()
if (!officeBar.querySelector('.agent-counts')) officeBar.append(countsLine())
officeBar.append(layoutToggle())
offices.before(officeBar)
new ResizeObserver(applyLayout).observe(document.documentElement)

orca.plugin.on('office.update', (snapshot) => {
  void acceptSnapshot(snapshot, true)
})
// Posts made while the panel was hidden are gone: ask again when it shows.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh()
})
refresh()
setInterval(frame, FRAME_MS)
setInterval(refreshVisibleTimes, 1000)
