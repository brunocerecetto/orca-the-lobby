// The plugin's own worker: it asks Orca who its agents are (src/roster.ts), hears their status and
// tool calls, keeps the office in src/office.ts and tells the panel. Its status bar item keeps it running while the plugin is
// enabled; a restart drops memory, so the office is also kept in orca.storage.
import { readFile } from 'node:fs/promises'
import type { OrcaWorkerApi } from 'orca/worker'
import {
  applyListed,
  applyRepos,
  applyRoster,
  applyStatus,
  applyToolAfter,
  applyToolBefore,
  createOffice,
  clearHistory,
  keepTerminals,
  placeWorkspace,
  projectRoot,
  prune,
  removeWorkspace,
  restore,
  startAttentionTracking,
  snapshot,
  storable,
  forPanel,
  hiddenView,
  STORE_BYTES,
  jsonBytes
} from './office'
import { attentionGroups, isCompletionId, readReviewed, reviewedState } from './attention'
import { agentOrder, checkInstruction, compactCommand, mayType, sharedTerminal, stepAgent, terminalOf } from './actions'
import { createContextReader, createSessionTail } from './context'
import {
  PREFS_KEY,
  INSTALLATION_KEY,
  STUCK_CHOICES,
  readPrefs,
  type ActionResult,
  type AgentActions,
  type AgentView,
  type AgentState,
  type Prefs,
  type NotificationControlState
} from './protocol'
import {
  adoptConsumedTransition,
  emptyNotificationQueue,
  emptyNotificationPolicy,
  flushTransitionQueue,
  hasReminderReceipt,
  isProjectMuted,
  isReminderSnoozed,
  notificationForTransition,
  queueTransition,
  readNotificationPolicy,
  recordReminderReceipt,
  reminderNotification,
  setProjectMuted,
  setReminderSnooze,
  type NotificationPolicy,
  type TransitionCandidate
} from './notifications'
import { hasCoordinator, orchestrationFacts } from './orchestration'
import { cli, environmentTarget } from './roster'
import { createReader } from './transcript'
import { createUsageCounter, dayOf } from './usage'

const STORED = 'office'
const REVIEWED = 'attention.reviewed'
const NOTIFICATION_POLICY = 'notification.policy'
type InstallationKind = 'fresh' | 'legacy' | 'unknown'
const PALETTES = ['orca', 'catppuccin-mocha', 'catppuccin-latte', 'dracula', 'github-dark', 'github-light'] as const
function checkedPrefsPatch(value: unknown): Partial<Prefs> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const patch = value as Record<string, unknown>
  const entries = Object.entries(patch)
  if (!entries.length) return null
  for (const [key, item] of entries) {
    const valid = key === 'notifyBlocked' || key === 'notifyDone' || key === 'animate'
      ? typeof item === 'boolean'
      : key === 'palette' ? PALETTES.includes(item as typeof PALETTES[number])
      : key === 'layout' ? item === 'list' || item === 'grid'
      : key === 'density' ? item === 'comfortable' || item === 'compact'
      : key === 'selectedView' ? item === 'office' || item === 'activity' || item === 'attention'
      : key === 'stuckMinutes' ? STUCK_CHOICES.includes(item as number)
      : key === 'projectOrder' ? Array.isArray(item) && item.every((id) => typeof id === 'string')
      : false
    if (!valid) return null
  }
  return patch as Partial<Prefs>
}
/** Tool calls come in bursts and `panels.post` allows 200 per 10 s: one post per burst. */
const POST_MS = 150
const SAVE_MS = 3000
/** How often Orca's list is asked for: while agents work, and while all is quiet. */
const LOOK_BUSY_MS = 3000
const LOOK_IDLE_MS = 20000
/** How often each workspace's uncommitted changes are counted. */
const CHANGES_MS = 15000
/** How often Orca's sidebar order is read, so a project dragged there moves here too. */
const REPOS_MS = 10000
/** How often the workspace and hidden-project lists are read again. */
const HIDDEN_MS = 10000
/** How often today's tokens are counted from the agents' logs. */
const USAGE_MS = 30000
/** Presses of the previous / next shortcuts closer together than this walk one fixed order. */
const WALK_MS = 2500
const MAX_PENDING_ADMISSIONS = 500

let stop = async (): Promise<void> => {}

export default function activate(orca: OrcaWorkerApi): void {
  const office = createOffice()
  let postTimer: ReturnType<typeof setTimeout> | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let statusText = ''
  let lookTimer: ReturnType<typeof setTimeout> | undefined
  let looking = false
  let lookedAt = 0
  let stopped = false
  let countedAt = 0
  /** Each agent's state as last seen by `announce`, so a change is told once. */
  const told = new Map<string, { state: AgentState; since: number }>()
  /** The quiet spell each agent was last nudged about, so one spell is told once. */
  const nudged = new Map<string, string>()
  const reminderInFlight = new Set<string>()
  let notificationQueue = emptyNotificationQueue()
  let notificationPolicy: NotificationPolicy | undefined
  let notificationStatus: Pick<NotificationControlState, 'status' | 'error'> = { status: 'loading' }
  let notificationOps: Promise<void> = Promise.resolve()
  let notificationTimer: ReturnType<typeof setTimeout> | undefined
  let notificationRetryTimer: ReturnType<typeof setTimeout> | undefined
  let notificationRetryAttempt = 0
  const pendingAdmissions: TransitionCandidate[] = []
  // One pass over each log serves both the day counts and the context.
  const tail = createSessionTail()
  const countUsage = createUsageCounter(undefined, tail)
  let usageAt = 0
  let reposAt = 0
  const readTranscripts = createReader()
  const readContexts = createContextReader(undefined, tail)
  let reading = false
  const granted = (capability: string): boolean => orca.grantedCapabilities.includes(capability)
  let prefs: Prefs = readPrefs(null)
  let prefsWriteQueue: Promise<void> = Promise.resolve()
  let prefsRevision = 0
  const loadPrefs = async (): Promise<void> => {
    let revision = prefsRevision
    try {
      let value = await orca.storage.get(PREFS_KEY)
      while (revision !== prefsRevision) {
        revision = prefsRevision
        value = await orca.storage.get(PREFS_KEY)
      }
      prefs = readPrefs(value)
    } catch { /* Retain the last valid settings until storage can be read. */ }
  }
  loadPrefs()
  orca.storage.onDidChange(({ key }) => {
    if (key !== PREFS_KEY) return
    prefsRevision++
    void loadPrefs()
  })
  office.can = { open: granted('workspace:write') }
  let listing = false
  let namedAt = 0
  const looked = new Set<string>()
  let listed: { id: string; name: string; path: string; branch: string | null; hostId: string | null; projectId?: string | null }[] = []
  let reviewed = new Set<string>()
  let storedReviews = readReviewed(null, Date.now())
  let reviewWrites: Promise<void> = Promise.resolve()
  let reviewsLoaded = false
  let reviewStorageAvailable = false
  let reviewsNeedSave = false
  let officeStorageAvailable = false
  let officeRetryAttempt = 0
  let officeRetryTimer: ReturnType<typeof setTimeout> | undefined
  let installationKind: InstallationKind = 'unknown'
  let rosterObserved = false

  // Events name a workspace `<project>::<path>` and `workspace.list` by another id; the path is
  // in both, so the office keys its rooms by path.
  const roomOf = (workspaceId: string | null): string | null => {
    if (workspaceId === null) return null
    const cut = workspaceId.indexOf('::')
    if (cut >= 0) return workspaceId.slice(cut + 2)
    return listed.find((workspace) => workspace.id === workspaceId)?.path ?? workspaceId
  }

  const projectOfAgent = (agent: AgentView): string => agent.projectId ?? agent.workspaceId ?? agent.id
  const episodeOfAgent = (agent: AgentView): string | null => {
    if (typeof agent.notificationEpisodeId === 'string' && agent.notificationEpisodeId.length > 0 && agent.notificationEpisodeId.length <= 256) {
      return agent.notificationEpisodeId
    }
    if (!Number.isFinite(agent.stateStartedAt)) return null
    const episodeId = `${agent.id}@${agent.stateStartedAt}`
    return episodeId.length <= 256 ? episodeId : null
  }
  const agentName = (agent: AgentView): string =>
    (agent.workspaceId && office.workspaces.get(agent.workspaceId)) || agent.title || 'An agent'
  const hasProject = (projectId: string): boolean => office.projects.has(projectId) ||
    [...office.agents.values()].some((agent) => projectOfAgent(agent) === projectId)
  const currentTransition = (candidate: TransitionCandidate): AgentView | undefined =>
    [...office.agents.values()].find((agent) =>
      episodeOfAgent(agent) === candidate.episodeId && projectOfAgent(agent) === candidate.projectId &&
      candidate.transitionId === (agent.state === 'done'
        ? agent.completionId ?? agent.notificationTransitionId ?? `${agent.state}:${agent.stateStartedAt}`
        : agent.notificationTransitionId ?? `${agent.state}:${agent.stateStartedAt}`) &&
      (candidate.kind === 'blocked'
        ? agent.state === 'blocked' && prefs.notifyBlocked
        : agent.state === 'done' && (candidate.kind === 'failed' ? agent.outcome === 'failure' : agent.outcome !== 'failure') && prefs.notifyDone)
    )

  const notificationErrorText = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error)
    return message.replace(/[\r\n]+/g, ' ').slice(0, 180) || 'Unknown storage error'
  }
  const serializeNotification = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = notificationOps.then(operation, operation)
    notificationOps = next.then(() => {}, () => {})
    return next
  }
  const notificationFailure = (error: unknown): void => {
    notificationStatus = { status: 'error', error: notificationErrorText(error) }
    scheduleNotificationRetry()
  }
  const scheduleNotificationRetry = (): void => {
    if (stopped || notificationRetryTimer) return
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(notificationRetryAttempt++, 6))
    notificationRetryTimer = setTimeout(() => {
      notificationRetryTimer = undefined
      void serializeNotification(async () => {
        if (stopped) return
        try {
          const stored = await orca.storage.get(NOTIFICATION_POLICY)
          if (stopped) return
          const policy = readNotificationPolicy(stored, Date.now())
          notificationPolicy = policy
          notificationStatus = { status: 'ready' }
          notificationRetryAttempt = 0
          await retryAdmissions()
          if (stopped) return
          scheduleNotificationTimer()
          nudge()
        } catch (error) {
          notificationFailure(error)
        }
      }).catch(() => {})
    }, delay)
  }
  const persistNotificationPolicy = async (next: NotificationPolicy): Promise<boolean> => {
    if (stopped) return false
    if (jsonBytes(next) > STORE_BYTES) {
      notificationFailure(new Error('Notification settings exceed the storage byte limit.'))
      return false
    }
    try {
      if (stopped) return false
      await orca.storage.set(NOTIFICATION_POLICY, next)
      if (stopped) return false
      notificationPolicy = next
      notificationStatus = { status: 'ready' }
      notificationRetryAttempt = 0
      return true
    } catch (error) {
      notificationFailure(error)
      return false
    }
  }
  const transitionEligible = (candidate: TransitionCandidate): boolean => !!currentTransition(candidate)
  const dispatchNotifications = (notifications: { title: string; body?: string }[]): void => {
    if (stopped || !granted('notifications:show')) return
    for (const notification of notifications) {
      void orca.host.call('notifications.show', notification).catch(() => {})
    }
  }
  const scheduleNotificationTimer = (): void => {
    if (stopped) return
    const deadlines = notificationQueue.pending.map((group) => group.deadline)
    for (const entry of notificationPolicy?.reminderSnoozes ?? []) {
      if (entry.expiresAt !== null && entry.expiresAt > Date.now()) deadlines.push(entry.expiresAt)
    }
    const next = Math.min(...deadlines)
    if (!Number.isFinite(next)) {
      clearTimeout(notificationTimer)
      notificationTimer = undefined
      return
    }
    const delay = Math.max(0, next - Date.now())
    if (notificationTimer) clearTimeout(notificationTimer)
    notificationTimer = setTimeout(() => {
      notificationTimer = undefined
      void serializeNotification(async () => {
        if (stopped || !notificationPolicy || notificationStatus.status !== 'ready') return
        const result = flushTransitionQueue(notificationQueue, notificationPolicy, Date.now(), transitionEligible)
        notificationQueue = result.queue
        notificationPolicy = result.policy
        if (result.refusals.length) orca.log(`notification flush refused: ${result.refusals[0].reason}`)
        dispatchNotifications(result.notifications)
        nudge()
        scheduleNotificationTimer()
      }).catch(() => {})
    }, delay)
  }
  const queueObservedTransition = (candidate: TransitionCandidate): void => {
    if (stopped) return
    if (notificationStatus.status !== 'ready' || !notificationPolicy) {
      if (pendingAdmissions.length < MAX_PENDING_ADMISSIONS) pendingAdmissions.push(candidate)
      else orca.log('notification candidate refused: pending-admissions-full')
      return
    }
    void serializeNotification(async () => {
      if (stopped) return
      if (!notificationPolicy || notificationStatus.status !== 'ready') {
        if (pendingAdmissions.length < MAX_PENDING_ADMISSIONS) pendingAdmissions.push(candidate)
        else orca.log('notification candidate refused: pending-admissions-full')
        return
      }
      if (notificationPolicy.handledTransitions.some((entry) =>
        entry.kind === 'transition' && entry.episodeId === candidate.episodeId && entry.transitionId === candidate.transitionId
      )) return
      const now = Date.now()
      const preview = queueTransition(emptyNotificationQueue(), notificationPolicy, candidate, now, transitionEligible)
      if (preview.refusals.length) {
        orca.log(`notification candidate refused: ${preview.refusals[0].reason}`)
        return
      }
      if (!await persistNotificationPolicy(preview.policy)) {
        if (pendingAdmissions.length < MAX_PENDING_ADMISSIONS) pendingAdmissions.push(candidate)
        else orca.log('notification candidate refused: pending-admissions-full')
        return
      }
      if (stopped) return
      const adopted = adoptConsumedTransition(notificationQueue, preview.policy, candidate, Date.now(), transitionEligible)
      notificationQueue = adopted.queue
      notificationPolicy = adopted.policy
      dispatchNotifications(adopted.notifications)
      if (adopted.refusals.length) orca.log(`notification queue refused: ${adopted.refusals[0].reason}`)
      scheduleNotificationTimer()
    }).catch((error) => orca.log(`notification admission: ${error}`))
  }
  const retryAdmissions = async (): Promise<void> => {
    const waiting = pendingAdmissions.splice(0)
    for (const candidate of waiting) queueObservedTransition(candidate)
  }

  let writes: Promise<void> = Promise.resolve()
  const persist = (duringShutdown = false): Promise<void> => {
    if (stopped && !duringShutdown) return Promise.reject(new Error('The worker is stopping.'))
    if (!officeStorageAvailable) return Promise.reject(new Error('Office storage is unavailable; saved data was left untouched.'))
    let state
    try {
      state = storable(snapshot(office))
    } catch (error) {
      return Promise.reject(error)
    }
    const write = writes.then(() => orca.storage.set(STORED, state))
    writes = write.catch(() => {})
    return write
  }
  const save = (duringShutdown = false): void => {
    saveTimer = undefined
    void persist(duringShutdown).catch((error) => orca.log(`save: ${error}`))
  }

  const publish = (): void => {
    postTimer = undefined
    if (stopped) return
    pruneReviews()
    prune(office, Date.now())
    let state
    try {
      state = forPanel(snapshot(office), [...reviewed].sort(), hiddenView(office))
    } catch (error) {
      orca.log(`office.update: ${error}`)
      saveTimer ??= setTimeout(save, SAVE_MS)
      return
    }
    const size = new TextEncoder().encode(JSON.stringify(state)).byteLength
    if (size > STORE_BYTES) orca.log(`office.update is ${size} bytes, near Orca's 256 KiB limit`)
    orca.panels.post('office.update', state)
    saveTimer ??= setTimeout(save, SAVE_MS)

    const working = state.agents.filter((agent) => agent.state === 'working').length
    const blocked = state.agents.filter((agent) => agent.state === 'blocked').length
    const text = blocked ? `${working} working · ${blocked} need you` : `${working} working`
    if (text === statusText) return
    statusText = text
    // Desktop app only: a headless Orca has no status bar.
    void orca.host
      .call('statusBar.update', { id: 'office', text, tone: blocked ? 'warning' : 'neutral' })
      .catch(() => {})
  }

  const changed = (): void => {
    if (stopped) return
    postTimer ??= setTimeout(publish, POST_MS)
  }

  const pruneReviews = (): void => {
    if (!reviewsLoaded) return
    const operation = reviewWrites.then(async () => {
      const next = readReviewed(storedReviews, Date.now())
      if (!reviewsNeedSave && JSON.stringify(next) === JSON.stringify(storedReviews)) return
      await orca.storage.set(REVIEWED, next)
      storedReviews = next
      reviewed = new Set(Object.keys(next.entries))
      reviewsNeedSave = false
      changed()
    })
    reviewWrites = operation.then(() => {}, () => {})
    void operation.catch((error) => orca.log(`review cleanup: ${error}`))
  }

  /** Asks Orca for its list, then again later: soon while agents work, seldom while none does. */
  const look = async (): Promise<void> => {
    if (stopped) return
    lookTimer = undefined
    looking = true
    lookedAt = Date.now()
    const inboxWanted = office.agents.size === 0 || hasCoordinator([...office.agents.values()])
    const [worktrees, mail] = await Promise.all([
      cli.roster().catch(() => null),
      inboxWanted
        ? Promise.all([cli.inbox().catch(() => null), cli.workers().catch(() => null), cli.terminals().catch(() => null)])
        : null
    ])
    const [inbox, workers, terminalRows] = mail ?? [null, null, null]
    if (stopped) return
    if (worktrees) {
      rosterObserved = true
      const identitiesBefore = new Map([...office.agents].map(([id, agent]) => [id, agent.completionId]))
      const notificationStateBefore = JSON.stringify([
        [...office.agents].map(([id, agent]) => [id, agent.stateStartedAt, agent.notificationEpisodeId, agent.notificationTransitionId, agent.notificationTurnId]),
        [...office.notificationEpisodes]
      ])
      const hadNotificationState = office.agents.size > 0 || office.notificationEpisodes.size > 0
      applyRoster(office, worktrees, Date.now())
      if (!office.attentionTracking) startAttentionTracking(office, Date.now())
      const completionChanged = [...office.agents].some(([id, agent]) => agent.completionId && identitiesBefore.get(id) !== agent.completionId)
      const notificationStateChanged = hadNotificationState && notificationStateBefore !== JSON.stringify([
        [...office.agents].map(([id, agent]) => [id, agent.stateStartedAt, agent.notificationEpisodeId, agent.notificationTransitionId, agent.notificationTurnId]),
        [...office.notificationEpisodes]
      ])
      if (notificationStateChanged && officeStorageAvailable) {
        void persist().catch((error) => orca.log(`notification episode: ${error}`))
      } else if (completionChanged) {
        void persist().catch((error) => orca.log(`completion identity: ${error}`))
      }
    }
    else office.rostered = false
    const listedAgents = [...office.agents.values()]
    office.orchestration = hasCoordinator(listedAgents) ? orchestrationFacts(inbox, listedAgents, { workers: workers ?? [], terminals: terminalRows ?? [] }) : new Map()
    await enrich().catch((error) => orca.log(`enrich: ${error}`))
    looking = false
    if (stopped) return
    announce()
    changed()
    const busy = [...office.agents.values()].some((agent) => agent.state === 'working')
    lookSoon(busy ? LOOK_BUSY_MS : LOOK_IDLE_MS)
  }

  /** Reads each agent's context in the background: Orca's session store can take seconds to answer,
   *  and nothing else waits for it. One read at a time; the panel hears of the result when it is in. */
  const readContext = (agents: AgentView[]): void => {
    if (reading) return
    reading = true
    readContexts(agents, Date.now())
      .then((contexts) => {
        if (stopped) return
        let different = false
        for (const { id } of agents) {
          const agent = office.agents.get(id)
          const context = contexts.get(id) ?? null
          if (!agent || JSON.stringify(agent.context ?? null) === JSON.stringify(context)) continue
          agent.context = context
          different = true
        }
        if (different) changed()
      })
      .catch((error) => orca.log(`context: ${error}`))
      .finally(() => {
        reading = false
      })
  }

  /** Adds supplementary Claude transcript notes and each workspace's uncommitted changes. */
  const enrich = async (): Promise<void> => {
    const agents = [...office.agents.values()]
    const insights = await readTranscripts(agents, Date.now())
    if (stopped) return
    for (const agent of agents) {
      const fresh = insights.get(agent.id)
      if (fresh) agent.insight = fresh
    }
    readContext(agents)
    if (Date.now() - namedAt >= HIDDEN_MS) {
      namedAt = Date.now()
      await nameWorkspaces()
      if (stopped) return
    }
    if (Date.now() - reposAt >= REPOS_MS) {
      reposAt = Date.now()
      const repos = await cli.repos().catch(() => null)
      if (stopped) return
      if (repos) applyRepos(office, repos)
    }
    if (Date.now() - usageAt >= USAGE_MS) {
      usageAt = Date.now()
      const paths = [...new Set([...agents.map((agent) => agent.workspaceId), ...office.workspaces.keys()])]
      try {
        const workspaces = await countUsage(paths.filter((path): path is string => !!path), usageAt)
        if (stopped) return
        office.usage = { day: dayOf(usageAt), workspaces }
      } catch (error) {
        orca.log(`usage: ${error}`)
      }
    }
    if (Date.now() - countedAt < CHANGES_MS) return
    countedAt = Date.now()
    for (const path of new Set(agents.map((agent) => agent.workspaceId))) {
      if (!path) continue
      const change = await cli.changes(path)
      if (stopped) return
      if (change) office.changes.set(path, change)
      else office.changes.delete(path)
    }
  }

  /** Tells the person, if they allowed it, when an agent starts needing them or ends a long turn. */
  const announce = (): void => {
    for (const agent of office.agents.values()) {
      const was = told.get(agent.id)
      told.set(agent.id, { state: agent.state, since: agent.stateStartedAt })
      if (!was || was.state === agent.state) continue
      const name = agentName(agent)
      const episodeId = episodeOfAgent(agent)
      if (!episodeId) continue
      const transitionId = agent.state === 'done'
        ? agent.completionId ?? agent.notificationTransitionId ?? `${agent.state}:${agent.stateStartedAt}`
        : agent.notificationTransitionId ?? `${agent.state}:${agent.stateStartedAt}`
      const candidate = notificationForTransition(was, {
        state: agent.state,
        stateStartedAt: agent.stateStartedAt,
        name,
        title: agent.title,
        outcome: agent.outcome
      }, prefs, {
        transitionId,
        episodeId,
        projectId: projectOfAgent(agent),
        projectName: office.projects.get(projectOfAgent(agent)) ?? projectOfAgent(agent)
      }, Date.now())
      if (candidate) queueObservedTransition(candidate)
    }
    nudge()
  }

  const processReminder = (agentId: string, episodeId: string, spell: string): void => {
    const key = `${episodeId}:${spell}`
    if (reminderInFlight.has(key)) return
    reminderInFlight.add(key)
    void serializeNotification(async () => {
      try {
        if (stopped || notificationStatus.status !== 'ready' || !notificationPolicy || !granted('notifications:show')) return
        const current = office.agents.get(agentId)
        if (!current || episodeOfAgent(current) !== episodeId) return
        const now = Date.now()
        const decision = reminderNotification({ ...current, name: agentName(current) }, now, prefs.stuckMinutes, undefined)
        if (!decision || decision.spell !== spell) return
        if (hasReminderReceipt(notificationPolicy, episodeId, spell)) {
          nudged.set(agentId, spell)
          return
        }
        if (isReminderSnoozed(notificationPolicy, episodeId, now)) return
        const next = notificationPolicy
        if (isProjectMuted(next, projectOfAgent(current))) {
          const receipt = recordReminderReceipt(next, episodeId, spell, now)
          if (!receipt.ok) {
            orca.log(`reminder receipt refused: ${receipt.error}`)
            return
          }
          if (!await persistNotificationPolicy(receipt.policy)) return
          nudged.set(agentId, spell)
          return
        }
        const receipt = recordReminderReceipt(next, episodeId, spell, now)
        if (!receipt.ok) {
          orca.log(`reminder receipt refused: ${receipt.error}`)
          return
        }
        if (!await persistNotificationPolicy(receipt.policy)) return
        if (stopped) return
        const stillCurrent = office.agents.get(agentId)
        const dispatchAt = Date.now()
        const currentDecision = stillCurrent
          ? reminderNotification({ ...stillCurrent, name: agentName(stillCurrent) }, dispatchAt, prefs.stuckMinutes, undefined)
          : null
        if (!stillCurrent || episodeOfAgent(stillCurrent) !== episodeId || !currentDecision || currentDecision.spell !== spell ||
            notificationStatus.status !== 'ready' || !granted('notifications:show') ||
            isProjectMuted(notificationPolicy!, projectOfAgent(stillCurrent)) ||
            isReminderSnoozed(notificationPolicy!, episodeId, dispatchAt)) return
        nudged.set(agentId, spell)
        dispatchNotifications([currentDecision.notification])
      } finally {
        reminderInFlight.delete(key)
      }
    }).catch((error) => {
      reminderInFlight.delete(key)
      orca.log(`reminder: ${error}`)
    })
  }

  /** Tells the person once per quiet spell when an agent seems stuck or still needs them. */
  const nudge = (): void => {
    const now = Date.now()
    for (const agent of office.agents.values()) {
      const episodeId = episodeOfAgent(agent)
      if (!episodeId) continue
      const reminder = reminderNotification({ ...agent, name: agentName(agent) }, now, prefs.stuckMinutes, undefined)
      if (!reminder) continue
      if (nudged.get(agent.id) === reminder.spell || hasReminderReceipt(notificationPolicy ?? emptyNotificationPolicy(), episodeId, reminder.spell)) continue
      if (isReminderSnoozed(notificationPolicy ?? emptyNotificationPolicy(), episodeId, now)) continue
      processReminder(agent.id, episodeId, reminder.spell)
    }
    for (const id of nudged.keys()) if (!office.agents.has(id)) nudged.delete(id)
  }

  /** Brings the next look forward, never closer than LOOK_BUSY_MS to the last one. */
  const lookSoon = (wait = 0): void => {
    if (looking || stopped) return
    clearTimeout(lookTimer)
    lookTimer = setTimeout(() => void look(), Math.max(wait, lookedAt + LOOK_BUSY_MS - Date.now()))
  }

  /** Finds which project a workspace belongs to, once: worktrees of one checkout share a room. */
  const place = (path: string | null): void => {
    if (stopped || !path || looked.has(path) || office.rostered) return
    looked.add(path)
    void readFile(`${path}/.git`, 'utf8')
      .catch(() => null)
      .then((gitFile) => {
        if (stopped) return
        placeWorkspace(office, path, projectRoot(path, gitFile))
        changed()
      })
  }

  /** Workspace names for the agent details; asked again when an agent shows up in an unknown one. */
  const nameWorkspaces = async (): Promise<void> => {
    if (stopped || listing) return
    listing = true
    try {
      listed = (await orca.host.call('workspace.list')).workspaces
      if (stopped) return
      const hiddenProjects = await orca.host.call('project.list')
        .then(({ projects }) => new Set(projects.filter((project) => project.hidden).map((project) => project.id)))
        .catch(() => new Set<string>())
      if (stopped) return
      office.hidden = new Set(listed.filter((row) => row.projectId && hiddenProjects.has(row.projectId)).map((row) => row.path))
      for (const { name, path, branch, hostId } of listed) {
        office.workspaces.set(path, name)
        for (const agent of office.agents.values()) {
          if (agent.workspaceId !== path) continue
          if (typeof branch === 'string' && branch) agent.branch = branch
          if (typeof hostId === 'string' && hostId) agent.hostId = hostId
        }
      }
      changed()
    } catch (error) {
      orca.log(`workspace.list: ${error}`)
    } finally {
      listing = false
    }
  }

  orca.events.on('agent.status.changed', (event) => {
    if (stopped) return
    const workspaceId = roomOf(event.workspaceId)
    const before = [...office.agents.values()].find((agent) =>
      (event.terminalId && agent.terminalId === event.terminalId) || agent.paneKey === event.paneKey
    )
    const previousEpisodeId = before?.notificationEpisodeId
    const previousTransitionId = before?.notificationTransitionId
    const previousCompletionId = before?.completionId
    applyStatus(office, { ...event, workspaceId })
    const current = [...office.agents.values()].find((agent) =>
      (event.terminalId && agent.terminalId === event.terminalId) || agent.paneKey === event.paneKey
    )
    const notificationEpisodeChanged = !!current && (current.notificationEpisodeId !== previousEpisodeId ||
      current.notificationTransitionId !== previousTransitionId)
    const completionChanged = event.state === 'done' && !!current?.completionId && current.completionId !== previousCompletionId
    if (officeStorageAvailable && (notificationEpisodeChanged || completionChanged)) {
      void persist().catch((error) => orca.log(`${completionChanged ? 'completion identity' : 'notification episode'}: ${error}`))
    }
    place(workspaceId)
    if (workspaceId && !office.workspaces.has(workspaceId)) void nameWorkspaces()
    announce()
    changed()
    lookSoon()
  })

  // `agents.list` and the context name the focused workspace but not its id: match it by name.
  orca.events.on('workspace.changed', async ({ context }) => {
    if (stopped || !context) return
    await nameWorkspaces()
    if (stopped) return
    const focused = listed.filter(
      (workspace) => workspace.name === context.displayName && workspace.branch === context.branch
    )
    const workspaceId = focused.length === 1 ? focused[0].path : null
    const { agents } = await orca.host.call('agents.list')
    if (stopped) return
    applyListed(office, workspaceId, agents, Date.now())
    place(workspaceId)
    if (workspaceId) {
      keepTerminals(
        office,
        workspaceId,
        context.terminals.map((terminal) => terminal.id)
      )
    }
    changed()
  })

  orca.events.on('workspace.removed', ({ path }) => {
    if (stopped) return
    removeWorkspace(office, path)
    changed()
  })

  // Claude Code waits on this hook: only record the call and return at once, never deny.
  orca.hooks.on('agent.tool.before', (event) => {
    if (stopped) return
    const workspaceId = roomOf(event.workspaceId)
    applyToolBefore(office, { ...event, workspaceId }, Date.now())
    place(workspaceId)
    changed()
    lookSoon()
  })

  orca.hooks.on('agent.tool.after', (event) => {
    if (stopped) return
    applyToolAfter(office, { ...event, workspaceId: roomOf(event.workspaceId) }, Date.now())
    changed()
  })

  orca.panels.handle('office.snapshot', () => forPanel(snapshot(office), [...reviewed].sort(), hiddenView(office)))

  const controlFailure = (): NotificationControlState => ({
    status: notificationStatus.status,
    ...(notificationStatus.error ? { error: notificationStatus.error } : {}),
    projectId: '', muted: null, agentId: null, episodeId: null, snoozed: null, expiresAt: null
  })
  const validRequestId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256

  orca.panels.handle('notification.control.read', async (input): Promise<NotificationControlState> => {
    await loaded
    return serializeNotification(async () => {
      if (stopped) return { ...controlFailure(), error: 'Notification controls are unavailable while the worker is stopping.' }
      const request = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
      const projectId = Object.prototype.hasOwnProperty.call(request, 'projectId') ? request.projectId : undefined
      const agentId = Object.prototype.hasOwnProperty.call(request, 'agentId') ? request.agentId : undefined
      const requestedEpisode = Object.prototype.hasOwnProperty.call(request, 'episodeId') ? request.episodeId : undefined
      if (!validRequestId(projectId) || (agentId !== undefined && !validRequestId(agentId)) ||
          (requestedEpisode !== undefined && !validRequestId(requestedEpisode)) || !hasProject(projectId)) {
        return { ...controlFailure(), error: 'That notification target is no longer available.' }
      }
      if (!notificationPolicy || notificationStatus.status !== 'ready') {
        return { ...controlFailure(), projectId, error: notificationStatus.error ?? 'Notification settings are unavailable.' }
      }
      if (agentId === undefined) {
        return { status: 'ready', projectId, muted: isProjectMuted(notificationPolicy, projectId), agentId: null, episodeId: null, snoozed: null, expiresAt: null }
      }
      const agent = office.agents.get(agentId)
      const episodeId = agent && episodeOfAgent(agent)
      if (!agent || !episodeId || projectOfAgent(agent) !== projectId ||
          (requestedEpisode !== undefined && requestedEpisode !== episodeId)) {
        return { ...controlFailure(), projectId, agentId, error: 'That agent episode is no longer current.' }
      }
      const snooze = notificationPolicy.reminderSnoozes.find((entry) => entry.episodeId === episodeId)
      const snoozed = isReminderSnoozed(notificationPolicy, episodeId, Date.now())
      return {
        status: 'ready', projectId, muted: isProjectMuted(notificationPolicy, projectId), agentId, episodeId,
        snoozed, expiresAt: snoozed ? snooze?.expiresAt ?? null : null
      }
    })
  })

  orca.panels.handle('notification.project.mute', async (input): Promise<ActionResult> => {
    await loaded
    return serializeNotification(async () => {
      if (stopped) return { ok: false, error: 'The worker stopped before saving notification settings.' }
      const request = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
      const projectId = Object.prototype.hasOwnProperty.call(request, 'projectId') ? request.projectId : undefined
      const muted = Object.prototype.hasOwnProperty.call(request, 'muted') ? request.muted : undefined
      if (!validRequestId(projectId) || typeof muted !== 'boolean' || !hasProject(projectId)) {
        return { ok: false, error: 'That project notification control is invalid or no longer current.' }
      }
      if (!notificationPolicy || notificationStatus.status !== 'ready') return { ok: false, error: 'Notification settings could not be restored. Retry after storage is available.' }
      const update = setProjectMuted(notificationPolicy, projectId, muted, Date.now())
      if (!update.ok) return { ok: false, error: `Could not update project mute: ${update.error}.` }
      let next = update.policy
      if (muted || isProjectMuted(notificationPolicy, projectId)) {
        const now = Date.now()
        for (const agent of office.agents.values()) {
          if (projectOfAgent(agent) !== projectId) continue
          const episodeId = episodeOfAgent(agent)
          if (!episodeId || isReminderSnoozed(next, episodeId, now)) continue
          const reminder = reminderNotification({ ...agent, name: agentName(agent) }, now, prefs.stuckMinutes, undefined)
          if (!reminder) continue
          const receipt = recordReminderReceipt(next, episodeId, reminder.spell, now)
          if (!receipt.ok) return { ok: false, error: `Could not preserve reminder state: ${receipt.error}.` }
          next = receipt.policy
        }
      }
      if (!await persistNotificationPolicy(next)) return { ok: false, error: 'Could not save notification settings. Try again.' }
      scheduleNotificationTimer()
      changed()
      return { ok: true }
    })
  })

  orca.panels.handle('notification.reminder.snooze', async (input): Promise<ActionResult> => {
    await loaded
    return serializeNotification(async () => {
      if (stopped) return { ok: false, error: 'The worker stopped before saving reminder settings.' }
      const request = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
      const projectId = Object.prototype.hasOwnProperty.call(request, 'projectId') ? request.projectId : undefined
      const agentId = Object.prototype.hasOwnProperty.call(request, 'agentId') ? request.agentId : undefined
      const episodeId = Object.prototype.hasOwnProperty.call(request, 'episodeId') ? request.episodeId : undefined
      const choice = Object.prototype.hasOwnProperty.call(request, 'choice') ? request.choice : undefined
      if (!validRequestId(projectId) || !validRequestId(agentId) || !validRequestId(episodeId) ||
          (choice !== '15m' && choice !== '1h' && choice !== 'manual' && choice !== 'resume')) {
        return { ok: false, error: 'That reminder control is invalid.' }
      }
      const agent = office.agents.get(agentId)
      if (!agent || episodeOfAgent(agent) !== episodeId || projectOfAgent(agent) !== projectId || !hasProject(projectId)) {
        return { ok: false, error: 'That agent episode is no longer current.' }
      }
      if (!notificationPolicy || notificationStatus.status !== 'ready') return { ok: false, error: 'Notification settings could not be restored. Retry after storage is available.' }
      const now = Date.now()
      let base = notificationPolicy
      if (choice === 'resume') {
        const overdueReminder = reminderNotification({ ...agent, name: agentName(agent) }, now, prefs.stuckMinutes, undefined)
        if (overdueReminder) {
          const receipt = recordReminderReceipt(base, episodeId, overdueReminder.spell, now)
          if (!receipt.ok) return { ok: false, error: `Could not preserve reminder state: ${receipt.error}.` }
          base = receipt.policy
        }
      }
      const update = setReminderSnooze(base, episodeId, now, choice)
      if (!update.ok) return { ok: false, error: `Could not update reminder snooze: ${update.error}.` }
      try {
        // A snooze is keyed by this episode, so make the matching office identity durable before
        // acknowledging the control. This also queues behind any in-flight roster/event save.
        await persist()
      } catch {
        return { ok: false, error: 'Could not save the current agent episode. Try again.' }
      }
      if (stopped) return { ok: false, error: 'The worker stopped before saving reminder settings.' }
      const current = office.agents.get(agentId)
      if (!current || episodeOfAgent(current) !== episodeId || projectOfAgent(current) !== projectId) {
        return { ok: false, error: 'That agent episode is no longer current.' }
      }
      if (!await persistNotificationPolicy(update.policy)) return { ok: false, error: 'Could not save notification settings. Try again.' }
      scheduleNotificationTimer()
      changed()
      return { ok: true }
    })
  })

  orca.panels.handle('attention.review', async (input): Promise<ActionResult> => {
    await loaded
    const completionId = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as { completionId?: unknown }).completionId
      : undefined
    if (!isCompletionId(completionId)) return { ok: false, error: 'That completion cannot be reviewed.' }
    if (!officeStorageAvailable) return { ok: false, error: 'Office storage is unavailable. Try again after its saved state is restored.' }
    if (!reviewStorageAvailable) return { ok: false, error: 'Reviewed storage is unavailable. Try again after restarting Orca.' }
    const operation = reviewWrites.then(async () => {
      const current = (): boolean => {
        const groups = attentionGroups([...office.agents.values()], new Set())
        return [...groups.failedToReview, ...groups.finishedToReview].some((agent) => agent.completionId === completionId)
      }
      if (!current()) return { ok: false, error: 'That completion is no longer current.' } as const
      if (reviewed.has(completionId)) return { ok: true } as const
      const next = new Set(reviewed)
      next.add(completionId)
      const state = reviewedState(next, Date.now(), storedReviews)
      await orca.storage.set(REVIEWED, state)
      // The id was current when this serialized transaction began. A later turn gets a different
      // key, so committing this identity remains valid even if the live roster advances meanwhile.
      storedReviews = state
      reviewed = new Set(Object.keys(state.entries))
      reviewsNeedSave = false
      changed()
      return { ok: true } as const
    })
    reviewWrites = operation.then(() => {}, () => {})
    try {
      return await operation
    } catch (error) {
      orca.log(`review: ${error}`)
      return { ok: false, error: 'Could not save the review. Try again.' }
    }
  })

  orca.panels.handle('office.clearHistory', async () => {
    await loaded
    if (stopped) return { cleared: false }
    clearHistory(office)
    try {
      await persist()
      changed()
      return { cleared: true }
    } catch (error) {
      orca.log(`clear history: ${error}`)
      changed()
      return { cleared: false }
    }
  })

  /** Shows an agent's workspace in Orca. */
  const openWorkspace = async (agentId: string): Promise<boolean> => {
    const path = office.agents.get(agentId)?.workspaceId
    if (!listed.some((workspace) => workspace.path === path)) await nameWorkspaces()
    const workspace = listed.find((other) => other.path === path)
    if (!workspace) return false
    await orca.host.call('workspace.open', { workspaceId: workspace.id })
    return true
  }

  /** The live terminal an agent runs in, or why there is none. Chat sessions have no terminal. */
  const terminalFor = async (agentId: string): Promise<{ handle: string; environment?: string } | { error: string }> => {
    const agent = office.agents.get(agentId)
    if (!agent) return { error: 'That agent has left.' }
    const remote = environmentTarget(agent.workspaceId)
    const pane = environmentTarget(agent.paneKey)
    if (remote && pane?.id !== remote.id) return { error: 'Orca did not report a terminal on that server.' }
    const terminals = await cli.terminals(remote?.id)
    if (!terminals) return { error: 'Orca could not be reached.' }
    const handle = terminalOf(pane ? { paneKey: pane.value, terminalId: null } : agent, terminals)
    return handle ? { handle, environment: remote?.id } : { error: 'Orca did not report a live terminal for this agent.' }
  }

  orca.panels.handle('office.actions', async ({ agentId }): Promise<AgentActions> => {
    const agent = office.agents.get(agentId)
    const none: AgentActions = { goTo: null, send: false, compact: null }
    if (!agent) return none
    const mayGo = granted('workspace:write')
    const maySend = granted('terminal:send') && !environmentTarget(agent.workspaceId)
    const terminal = mayGo || maySend ? 'handle' in (await terminalFor(agentId)) : false
    const send = maySend && terminal && mayType(agent)
    return {
      goTo: !mayGo ? null : terminal ? 'terminal' : agent.workspaceId ? 'workspace' : null,
      send,
      // A blocked agent is waiting on an answer: a command typed now would be taken as that answer.
      compact: send && agent.state !== 'blocked' ? compactCommand(agent.agent) : null
    }
  })

  /** The agent the shortcuts step from: the last one the person went to or selected in the panel. */
  let cursor: string | null = null
  /** The order a run of presses walks, kept for a moment so an agent changing state mid-walk neither
   *  skips nor repeats anyone. Any other way of choosing an agent ends the walk. */
  let walk: { ids: string[]; at: number } | null = null

  /** The agent's terminal if it has one and Orca switches to it, else its workspace. */
  const goTo = async (agentId: string, stepping = false): Promise<ActionResult> => {
    if (!granted('workspace:write')) return { ok: false, error: 'Opening workspaces is not allowed.' }
    cursor = agentId
    if (!stepping) walk = null
    const found = await terminalFor(agentId)
    if ('handle' in found) {
      const switched = await cli.switchTo(found.handle, found.environment)
      if (switched.ok) return { ok: true }
    }
    const agent = office.agents.get(agentId)
    const remote = environmentTarget(agent?.workspaceId)
    if (remote) {
      const opened = await cli.activateWorkspace(remote.value, remote.id)
      if (!opened.ok) return { ok: false, error: `Could not open its remote workspace: ${opened.error}` }
    } else if (!(await openWorkspace(agentId))) {
      return { ok: false, error: 'Orca does not know where it is.' }
    }
    return 'handle' in found
      ? { ok: true, note: 'Opened its workspace; its terminal would not come forward.' }
      : (environmentTarget(agent?.paneKey)?.value ?? agent?.paneKey)?.startsWith('structured-agent-session-')
        ? { ok: true, note: 'Opened its workspace. Orca does not let plugins pick a chat tab.' }
        : { ok: true, note: `Opened its workspace. ${found.error}` }
  }

  orca.panels.handle('office.goTo', ({ agentId }) => goTo(agentId))

  orca.panels.handle('office.select', ({ agentId }) => {
    if (typeof agentId === 'string' && office.agents.has(agentId)) {
      cursor = agentId
      walk = null
    }
    return { ok: true }
  })

  /** Types into an agent's terminal. Only ever called for something the person just asked for, and
   *  only while Orca's own list still shows that agent at work in a terminal no other agent shares. */
  const type = async (agentId: string, text: string): Promise<ActionResult> => {
    if (!granted('terminal:send')) return { ok: false, error: 'Typing into terminals is not allowed.' }
    if (environmentTarget(office.agents.get(agentId)?.workspaceId)) return { ok: false, error: 'Sending to paired servers is not supported.' }
    if (!mayType(office.agents.get(agentId))) return { ok: false, error: 'It has finished; its terminal may be back at a shell.' }
    const listed = await cli.roster()
    const paneKey = office.agents.get(agentId)?.paneKey
    const row = listed?.flatMap((worktree) => worktree.agents ?? []).find((other) => other.paneKey === paneKey)
    if (!listed) return { ok: false, error: 'Orca could not be reached.' }
    if (!row || row.state === 'done') return { ok: false, error: 'Orca no longer shows it at work.' }
    const terminals = await cli.terminals()
    const agent = office.agents.get(agentId)
    const handle = agent && terminals ? terminalOf(agent, terminals) : null
    if (!terminals) return { ok: false, error: 'Orca could not be reached.' }
    if (!handle) return { ok: false, error: 'It does not run in a terminal Orca can type into.' }
    if (sharedTerminal(agentId, handle, [...office.agents.values()], terminals)) return { ok: false, error: 'Another agent uses the same terminal.' }
    const sent = await cli.send(handle, text)
    return sent.ok ? { ok: true } : sent
  }

  orca.panels.handle('office.send', ({ agentId, text }) => {
    const checked = checkInstruction(text)
    return checked.ok ? type(agentId, checked.text) : { ok: false, error: checked.error }
  })

  orca.panels.handle('office.compact', async ({ agentId }) => {
    const agent = office.agents.get(agentId)
    const command = agent && agent.state !== 'blocked' ? compactCommand(agent.agent) : null
    return command ? type(agentId, command) : { ok: false, error: 'This agent has no compact command.' }
  })

  /** Previous / next agent: needs-you first, then working, then the rest. */
  const step = async (direction: 1 | -1): Promise<string> => {
    const now = Date.now()
    if (!walk || now - walk.at > WALK_MS) walk = { ids: agentOrder([...office.agents.values()]).map((agent) => agent.id), at: now }
    walk.at = now
    // Someone who left mid-walk drops out; the order of everyone else holds.
    walk.ids = walk.ids.filter((id) => office.agents.has(id))
    const id = stepAgent(walk.ids, cursor, direction)
    const agent = id === null ? undefined : office.agents.get(id)
    if (!agent) return 'No agents to go to.'
    const name = (agent.workspaceId && office.workspaces.get(agent.workspaceId)) || agent.title || 'An agent'
    const result = await goTo(agent.id, true)
    return result.ok ? `${name}${result.note ? ` · ${result.note}` : ''}` : `${name} · ${result.error}`
  }
  orca.commands.register('office.previousAgent', () => step(-1))
  orca.commands.register('office.nextAgent', () => step(1))

  const saveInstallation = async (
    storedOffice: unknown,
    result: PromiseSettledResult<unknown>
  ): Promise<boolean> => {
    if (result.status === 'rejected') {
      installationKind = 'unknown'
      orca.log(`installation restore: ${result.reason}`)
      return false
    }
    const marker = result.value as { version?: unknown; kind?: unknown } | null
    if (marker?.version === 1 && (marker.kind === 'fresh' || marker.kind === 'legacy')) {
      installationKind = marker.kind
      return true
    }
    installationKind = storedOffice == null ? 'fresh' : 'legacy'
    const kind = installationKind
    try {
      await orca.storage.set(INSTALLATION_KEY, { version: 1, kind })
      return true
    } catch (error) {
      installationKind = 'unknown'
      orca.log(`installation save: ${error}`)
      return false
    }
  }

  const retryOfficeRead = (): void => {
    if (stopped || officeRetryTimer) return
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(officeRetryAttempt++, 6))
    officeRetryTimer = setTimeout(() => {
      officeRetryTimer = undefined
      void Promise.allSettled([orca.storage.get(STORED), orca.storage.get(INSTALLATION_KEY)]).then(async ([officeResult, installResult]) => {
        if (stopped) return
        if (officeResult.status === 'rejected') throw officeResult.reason
        restore(office, officeResult.value, Date.now(), true, rosterObserved)
        const installed = await saveInstallation(officeResult.value, installResult)
        if (stopped) return
        if (!installed) { retryOfficeRead(); return }
        officeStorageAvailable = true
        officeRetryAttempt = 0
        changed()
      }).catch((error) => {
        if (stopped) return
        orca.log(`office restore retry: ${error}`)
        retryOfficeRead()
      })
    }, delay)
  }

  const loaded = Promise.allSettled([orca.storage.get(STORED), orca.storage.get(REVIEWED), orca.storage.get(INSTALLATION_KEY), orca.storage.get(NOTIFICATION_POLICY)])
    .then(async (results) => {
      if (stopped) return
      const [officeResult, reviewResult, installResult, notificationResult] = results
      if (officeResult.status === 'fulfilled') {
        restore(office, officeResult.value, Date.now())
        office.freshCompletionScopes.clear()
        const installed = await saveInstallation(officeResult.value, installResult)
        if (stopped) return
        if (installed) officeStorageAvailable = true
        else retryOfficeRead()
      } else {
        orca.log(`office restore: ${officeResult.reason}`)
        if (installResult.status === 'fulfilled') {
          const marker = installResult.value as { version?: unknown; kind?: unknown } | null
          if (marker?.version === 1 && (marker.kind === 'fresh' || marker.kind === 'legacy')) installationKind = marker.kind
        }
        retryOfficeRead()
      }
      if (reviewResult.status === 'fulfilled') {
        const reviews = reviewResult.value
        storedReviews = readReviewed(reviews, Date.now())
        reviewed = new Set(Object.keys(storedReviews.entries))
        reviewsLoaded = reviewStorageAvailable = true
        reviewsNeedSave = reviews !== undefined && reviews !== null && JSON.stringify(reviews) !== JSON.stringify(storedReviews)
        if (reviewsNeedSave) pruneReviews()
      } else orca.log(`review restore: ${reviewResult.reason}`)
      if (notificationResult.status === 'fulfilled') {
        try {
          notificationPolicy = readNotificationPolicy(notificationResult.value, Date.now())
          notificationStatus = { status: 'ready' }
          notificationRetryAttempt = 0
          await retryAdmissions()
          scheduleNotificationTimer()
        } catch (error) {
          notificationPolicy = undefined
          notificationFailure(error)
          orca.log(`notification restore: ${error}`)
        }
      } else {
        notificationPolicy = undefined
        notificationFailure(notificationResult.reason)
        orca.log(`notification restore: ${notificationResult.reason}`)
      }
      for (const agent of snapshot(office).agents) place(agent.workspaceId)
      return nameWorkspaces()
    })
    .then(() => lookSoon())

  orca.panels.handle('office.installation', async () => {
    await loaded
    return { kind: installationKind }
  })

  orca.panels.handle('prefs.patch', (input) => {
    if (stopped) return { ok: false, error: 'The worker stopped before saving settings.' }
    const patch = checkedPrefsPatch(input?.patch)
    if (!patch) return { ok: false, error: 'Those Lobby settings are invalid.' }
    const operation = prefsWriteQueue.then(async () => {
      const stored = await orca.storage.get(PREFS_KEY)
      const current = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? stored as Record<string, unknown>
        : {}
      const next = { ...current, ...patch }
      await orca.storage.set(PREFS_KEY, next)
      prefs = readPrefs(next, prefs.selectedView)
      return { ok: true } as const
    })
    prefsWriteQueue = operation.then(() => {}, () => {})
    return operation.catch((error) => {
      orca.log(`preferences save: ${error}`)
      return { ok: false, error: 'Could not save Lobby settings. Try again.' } as const
    })
  })

  stop = async () => {
    if (stopped) {
      await notificationOps
      await writes
      await prefsWriteQueue
      return
    }
    stopped = true
    clearTimeout(lookTimer)
    clearTimeout(officeRetryTimer)
    clearTimeout(notificationTimer)
    clearTimeout(notificationRetryTimer)
    clearTimeout(postTimer)
    if (saveTimer || postTimer) {
      clearTimeout(saveTimer)
      clearTimeout(postTimer)
      save(true)
    }
    // Snoozes can enqueue office writes, so drain notification work before the office write chain.
    await notificationOps
    await writes
    await prefsWriteQueue
  }
}

export function deactivate(): Promise<void> {
  return stop()
}
