// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { applyRoster, createOffice, snapshot, type RosterWorktree } from './office'
import { sessionStore } from './context'
import { readPrefs, type OfficeSnapshot } from './protocol'
import { attentionGroups } from './attention'
import { cli } from './roster'
import * as main from './worker'

// Never the real Orca CLI: each test says what Orca lists, or null for an Orca that cannot be asked.
let listed: RosterWorktree[] | null = null
cli.roster = async () => listed
cli.changes = async () => ({ files: 2, added: 12, removed: 3 })
cli.repos = async () => null
// Terminals the pretend Orca has open, and what was typed or switched to in them.
let terminals: { handle: string; paneKey: string }[] | null = []
const typed: string[] = []
const switched: string[] = []
cli.terminals = async () => terminals
cli.switchTo = async (handle) => (switched.push(handle), { ok: true })
cli.send = async (handle, text) => (typed.push(`${handle}: ${text}`), { ok: true })

/** Wait for an observable worker result; timers and file reads can finish in either order. */
async function waitUntil(description: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000
  do {
    if (await ready()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

test('records tool calls without holding the agent up, and tells panels', async () => {
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          {
            id: 'list-1',
            kind: 'worktree',
            name: 'main',
            path: '/repos/shop',
            branch: 'main',
            hostId: null
          }
        ],
        truncated: false
      }
    }
  })
  const worker = await mountWorker(main, { host })
  let stopped = false
  try {
    await worker.emit('agent.status.changed', {
      workspaceId: 'project-1::/repos/shop',
      paneKey: 'pane-1',
      terminalId: 't1',
      title: 'Fix login',
      state: 'working',
      receivedAt: Date.now()
    })
    const event = {
      agent: 'claude',
      workspaceId: 'project-1::/repos/shop',
      terminalId: 't1',
      tool: 'Bash',
      input: { command: 'npm test' },
      callId: 'c1'
    }
    assert.deepEqual(await worker.hooks.fire('agent.tool.before', event), { kind: 'continue', event })

    let office = await worker.request('office.snapshot')
    assert.equal(office.agents[0].workspaceId, '/repos/shop')
    assert.equal(office.agents[0].active[0].detail, 'npm test')

    await waitUntil('published workspace, project and working status', () => {
      const latest = worker.posts.at(-1)?.payload as OfficeSnapshot | undefined
      const status = host.callsOf('statusBar.update').at(-1) as { text?: string } | undefined
      return latest?.workspaces['/repos/shop'] === 'main' && latest.projects['/repos/shop'] === 'shop' && status?.text === '1 working'
    })
    const posted = worker.posts.at(-1)
    assert.equal(posted?.event, 'office.update')
    assert.deepEqual((posted?.payload as OfficeSnapshot).workspaces, { '/repos/shop': 'main' })
    // No `.git` file to read there, so the workspace is its own project.
    assert.deepEqual((posted?.payload as OfficeSnapshot).projects, { '/repos/shop': 'shop' })
    assert.equal((posted?.payload as OfficeSnapshot).agents[0].projectId, '/repos/shop')
    assert.deepEqual(host.callsOf('statusBar.update').at(-1), {
      id: 'office',
      text: '1 working',
      tone: 'neutral'
    })

    await worker.emit('agent.status.changed', {
      workspaceId: 'project-1::/repos/shop',
      paneKey: 'pane-1',
      terminalId: 't1',
      state: 'blocked',
      receivedAt: Date.now()
    })
    await waitUntil('blocked status bar update', () => (host.callsOf('statusBar.update').at(-1) as { text?: string } | undefined)?.text === '0 working · 1 need you')
    assert.deepEqual(host.callsOf('statusBar.update').at(-1), {
      id: 'office',
      text: '0 working · 1 need you',
      tone: 'warning'
    })

    await worker.hooks.fire('agent.tool.after', event)
    office = await worker.request('office.snapshot')
    assert.deepEqual(office.agents[0].active, [])
    assert.equal(office.agents[0].toolCount, 1)

    await worker.emit('workspace.removed', {
      workspaceId: 'list-1',
      kind: 'worktree',
      path: '/repos/shop'
    })
    assert.deepEqual((await worker.request('office.snapshot')).agents, [])

    assert.deepEqual(worker.refusals, [])
    assert.deepEqual(worker.logs, [])
    // Stopping writes the office out, so a restarted worker finds it.
    await worker.deactivate()
    stopped = true
    await waitUntil('empty office persisted on deactivation', () => {
      const stored = host.data().storage.office as OfficeSnapshot | undefined
      return Array.isArray(stored?.agents) && stored.agents.length === 0
    })
    assert.deepEqual((host.data().storage.office as OfficeSnapshot).agents, [])
  } finally {
    if (!stopped) await worker.deactivate()
  }
})

test('the mounted worker marks a fresh installation before its first office save', async () => {
  listed = []
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    assert.deepEqual(await worker.request('office.installation'), { kind: 'fresh' })
    await waitUntil('the worker auto-saves its office', () => host.data().storage.office !== undefined)
    assert.ok(host.data().storage.office)
    assert.deepEqual(host.data().storage['lobby.installation'], { version: 1, kind: 'fresh' })
    const installation = await worker.request('office.installation')
    assert.equal(readPrefs(null, installation.kind === 'fresh' ? 'attention' : 'office').selectedView, 'attention')
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('serial preference patches reread latest settings and acknowledge only after durable writes', async () => {
  let gateRead = false
  let gateWrite = false
  let releaseRead!: () => void
  let releaseWrite!: () => void
  let beganRead!: () => void
  let beganWrite!: () => void
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
  const readStarted = new Promise<void>((resolve) => { beganRead = resolve })
  const writeStarted = new Promise<void>((resolve) => { beganWrite = resolve })
  let prefsReads = 0
  const initialPrefs = { notifyBlocked: true, notifyDone: false, animate: true, palette: 'github-light', layout: 'list', density: 'comfortable', selectedView: 'office', stuckMinutes: 30, projectOrder: ['/base'], futureSetting: 'keep' }
  let storedPrefs: unknown = initialPrefs
  let host: ReturnType<typeof mockHost>
  host = mockHost({ storage: { prefs: initialPrefs }, results: {
    'storage.get': async (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'prefs' && gateRead) {
        prefsReads++
        beganRead()
        await readGate
      }
      return { value: key === 'prefs' ? storedPrefs : (host.data().storage as Record<string, unknown>)[key] ?? null }
    },
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'prefs' && gateWrite) {
        beganWrite()
        await writeGate
      }
      if (key === 'prefs') storedPrefs = value
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await worker.request('office.installation')
    const unchanged = JSON.parse(JSON.stringify(storedPrefs))
    assert.deepEqual(await worker.request('prefs.patch', { patch: { palette: 'purple' } as never }), { ok: false, error: 'Those Lobby settings are invalid.' })
    assert.deepEqual(await worker.request('prefs.patch', { patch: { notifyBlocked: 'false' } as never }), { ok: false, error: 'Those Lobby settings are invalid.' })
    assert.deepEqual(storedPrefs, unchanged)
    gateRead = true
    const firstReadPatch = worker.request('prefs.patch', { patch: { palette: 'dracula' } })
    await readStarted
    const secondReadPatch = worker.request('prefs.patch', { patch: { palette: 'github-dark', projectOrder: ['/latest'] } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(prefsReads, 1, 'the second panel read began before the first write completed')
    releaseRead()
    assert.deepEqual(await Promise.all([firstReadPatch, secondReadPatch]), [{ ok: true }, { ok: true }])
    assert.deepEqual(storedPrefs, {
      notifyBlocked: true, notifyDone: false, animate: true, palette: 'github-dark', layout: 'list', density: 'comfortable',
      selectedView: 'office', stuckMinutes: 30, projectOrder: ['/latest'], futureSetting: 'keep'
    })

    gateWrite = true
    let firstSettled = false
    const firstWritePatch = worker.request('prefs.patch', { patch: { density: 'compact' } }).then((result) => { firstSettled = true; return result })
    await writeStarted
    const storedBeforeRelease = JSON.parse(JSON.stringify(storedPrefs))
    const secondWritePatch = worker.request('prefs.patch', { patch: { density: 'comfortable', notifyDone: true } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(firstSettled, false, 'a panel reported success before its storage write completed')
    assert.deepEqual(storedPrefs, storedBeforeRelease, 'gated storage write became visible before it completed')
    releaseWrite()
    assert.deepEqual(await Promise.all([firstWritePatch, secondWritePatch]), [{ ok: true }, { ok: true }])
    assert.deepEqual(storedPrefs, {
      notifyBlocked: true, notifyDone: true, animate: true, palette: 'github-dark', layout: 'list', density: 'comfortable',
      selectedView: 'office', stuckMinutes: 30, projectOrder: ['/latest'], futureSetting: 'keep'
    })
  } finally {
    await worker.deactivate()
  }
})

test('worker deactivation waits for an in-flight preference patch', async () => {
  let gatePrefsRead = false
  let releasePrefsRead!: () => void
  let beginPrefsRead!: () => void
  const prefsReadGate = new Promise<void>((resolve) => { releasePrefsRead = resolve })
  const prefsReadStarted = new Promise<void>((resolve) => { beginPrefsRead = resolve })
  const storedPrefs = { palette: 'github-light', notifyBlocked: true }
  const host = mockHost({ results: {
    'storage.get': async (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'prefs' && gatePrefsRead) {
        gatePrefsRead = false
        beginPrefsRead()
        await prefsReadGate
      }
      return { value: key === 'prefs' ? storedPrefs : null }
    },
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'prefs') Object.assign(storedPrefs, value)
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await worker.request('office.installation')
    gatePrefsRead = true
    const patch = worker.request('prefs.patch', { patch: { notifyBlocked: false } })
    await prefsReadStarted
    let deactivated = false
    const shutdown = main.deactivate().then(() => { deactivated = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(deactivated, false, 'deactivation must wait for a preference patch already in progress')
    releasePrefsRead()
    assert.deepEqual(await patch, { ok: true })
    await shutdown
    assert.deepEqual(storedPrefs, { palette: 'github-light', notifyBlocked: false })
    assert.deepEqual(await worker.request('prefs.patch', { patch: { notifyDone: false } }), {
      ok: false, error: 'The worker stopped before saving settings.'
    })
  } finally {
    releasePrefsRead()
    await worker.deactivate()
  }
})

test('preference patch failures are reported without changing saved values and retry cleanly', async () => {
  let failRead = true
  let failWrite = false
  let storedPrefs: unknown = { palette: 'github-light', notifyBlocked: true, futureSetting: 'keep' }
  let host: ReturnType<typeof mockHost>
  host = mockHost({ results: {
    'storage.get': (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'prefs') {
        if (failRead) throw new Error('temporary read failure')
        return { value: storedPrefs }
      }
      return { value: (host.data().storage as Record<string, unknown>)[key] ?? null }
    },
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'prefs') {
        if (failWrite) throw new Error('temporary write failure')
        storedPrefs = value
      }
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    assert.deepEqual(await worker.request('prefs.patch', { patch: { notifyBlocked: false } }), {
      ok: false, error: 'Could not save Lobby settings. Try again.'
    })
    assert.deepEqual(storedPrefs, { palette: 'github-light', notifyBlocked: true, futureSetting: 'keep' })
    failRead = false
    failWrite = true
    assert.deepEqual(await worker.request('prefs.patch', { patch: { notifyDone: false } }), {
      ok: false, error: 'Could not save Lobby settings. Try again.'
    })
    assert.deepEqual(storedPrefs, { palette: 'github-light', notifyBlocked: true, futureSetting: 'keep' })
    failWrite = false
    assert.deepEqual(await worker.request('prefs.patch', { patch: { notifyBlocked: false } }), { ok: true })
    assert.deepEqual(storedPrefs, { palette: 'github-light', notifyBlocked: false, futureSetting: 'keep' })
  } finally {
    await worker.deactivate()
  }
})

test('a mounted worker recognizes old office data as a 1.2 installation without preferences', async () => {
  listed = null
  const host = mockHost({ storage: { office: { agents: [], journal: [] } } })
  const worker = await mountWorker(main, { host })
  try {
    const installation = await worker.request('office.installation')
    assert.deepEqual(installation, { kind: 'legacy' })
    assert.deepEqual(host.data().storage['lobby.installation'], { version: 1, kind: 'legacy' })
    assert.equal(readPrefs(null, installation.kind === 'fresh' ? 'attention' : 'office').selectedView, 'office')
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a failed installation marker write stays unknown and retries before office writes', async () => {
  listed = []
  let markerWrites = 0
  let markerValue: unknown = null
  let host: ReturnType<typeof mockHost>
  host = mockHost({ results: {
    'storage.get': (params: unknown) => {
      const key = (params as { key: string }).key
      return { value: key === 'lobby.installation' ? markerValue : host.data().storage[key] ?? null }
    },
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'lobby.installation' && ++markerWrites === 1) throw new Error('temporarily unavailable')
      if (key === 'lobby.installation') markerValue = value
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    assert.deepEqual(await worker.request('office.installation'), { kind: 'unknown' })
    assert.equal(host.data().storage.office, undefined)
    await waitUntil('the installation marker retry', () => markerValue !== null)
    assert.deepEqual(markerValue, { version: 1, kind: 'fresh' })
    assert.deepEqual(await worker.request('office.installation'), { kind: 'fresh' })
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('comes back with the agents it stored', async () => {
  const stored = {
    agents: [
      {
        id: 't9',
        terminalId: 't9',
        paneKey: null,
        workspaceId: null,
        projectId: null,
        title: 'Old hand',
        agent: 'codex',
        state: 'waiting',
        outcome: null,
        stateStartedAt: Date.now(),
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        active: [],
        recent: [],
        toolCount: 3,
        insight: {
          model: 'guessed-model',
          contextTokens: 100_000,
          contextWindowTokens: 200_000,
          todos: [],
          files: []
        }
      }
    ],
    workspaces: {}
  }
  const worker = await mountWorker(main, { host: mockHost({ storage: { office: stored } }) })
  try {
    await waitUntil('stored agent restored', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.title === 'Old hand'))
    assert.equal((await worker.request('office.snapshot')).agents[0].title, 'Old hand')
    assert.deepEqual((await worker.request('office.snapshot')).agents[0].insight, {
      model: null,
      todos: [],
      files: []
    })
  } finally {
    await worker.deactivate()
  }
})

test('shows who Orca lists, with their subagents, and nobody else', async () => {
  listed = [
    {
      path: '/work/folio/fix',
      displayName: 'fix',
      repo: 'Folio',
      repoId: 'repo-1',
      linkedItems: [
        { type: 'pr', number: 40, url: 'https://example.com/pull/40' },
        { type: 'pr', number: 40, url: 'https://example.com/pull/40' },
        { type: 'pr', number: 9, url: 'javascript:alert(1)' }
      ],
      agents: [
        {
          paneKey: 'chat-1',
          state: 'working',
          agentType: 'claude',
          prompt: 'Fix the sort',
          conversationName: 'Fix series sort',
          toolName: 'Grep',
          toolInput: 'sortSeries',
          children: [
            {
              id: 'k1',
              kind: 'agent',
              state: 'working',
              name: 'Explore',
              description: 'Find callers',
              operation: { toolName: 'Read' }
            },
            { id: 'k2', kind: 'command', state: 'working', description: 'Run tests' },
            { id: 'k3', kind: 'agent', state: 'done', name: 'Explore', description: 'Finished one' }
          ]
        },
        { paneKey: 'chat-2', state: 'done', activity: { listed: false } }
      ]
    }
  ]
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-1',
            kind: 'worktree',
            name: 'fix',
            path: '/work/folio/fix',
            branch: 'fix',
            hostId: null
          }
        ],
        truncated: false
      },
      'workspace.open': { opened: true },
      'notifications.show': { delivered: true }
    }
  })
  const originalChanges = cli.changes
  let changesStarted = false
  let releaseChanges!: () => void
  const changesGate = new Promise<void>((resolve) => { releaseChanges = resolve })
  cli.changes = async () => {
    changesStarted = true
    await changesGate
    return { files: 2, added: 12, removed: 3 }
  }
  const worker = await mountWorker(main, { host })
  // Whatever fails below, stop the worker: its timers would keep the test run alive.
  try {
    await waitUntil('roster and delayed Git enrichment to start', async () => {
      const state = await worker.request('office.snapshot')
      return changesStarted && state.agents.some((agent) => agent.id === 'chat-1')
    })
    assert.deepEqual((await worker.request('office.snapshot')).changes, {})
    releaseChanges()
    await waitUntil('Git enrichment and initial status announcement', async () => {
      const state = await worker.request('office.snapshot')
      return state.changes['/work/folio/fix']?.files === 2 && host.callsOf('statusBar.update').length > 0
    })

    // An agent Orca does not list stays out, whatever events say.
    await worker.emit('agent.status.changed', {
      workspaceId: 'p::/work/gone',
      paneKey: 'ghost',
      state: 'working',
      receivedAt: Date.now()
    })
    const office = await worker.request('office.snapshot')
    assert.deepEqual(
      office.agents.map((agent) => agent.id),
      ['chat-1']
    )
    const [agent] = office.agents
    assert.equal(agent.projectId, 'repo-1')
    assert.deepEqual(office.projects, { 'repo-1': 'Folio' })
    assert.deepEqual(office.workspaces, { '/work/folio/fix': 'fix' })
    assert.deepEqual(office.changes, { '/work/folio/fix': { files: 2, added: 12, removed: 3 } })
    assert.deepEqual(office.links, {
      '/work/folio/fix': [{ label: 'PR #40', url: 'https://example.com/pull/40' }]
    })
    assert.deepEqual(office.can, { open: true })
    assert.deepEqual(
      [agent.title, agent.prompt, agent.agent],
      ['Fix series sort', 'Fix the sort', 'claude']
    )
    assert.deepEqual(
      agent.active.map((call) => [call.tool, call.kind, call.detail]),
      [['Grep', 'search', 'sortSeries']]
    )
    assert.deepEqual(
      agent.helpers.map((helper) => [
        helper.kind,
        helper.name,
        helper.description,
        helper.toolKind
      ]),
      [
        ['agent', 'Explore', 'Find callers', 'read'],
        ['command', 'command', 'Run tests', null]
      ]
    )
    assert.deepEqual(agent.family.map(({ id, kind, state, reported }) => [id, kind, state, reported]), [
      ['k1', 'agent', 'working', true],
      ['k3', 'agent', 'done', true]
    ])
    assert.equal('outcome' in agent.family[1], false)

    // Its status still lands at once, between looks.
    listed![0].agents![0].state = 'blocked'
    await worker.emit('agent.status.changed', {
      workspaceId: 'p::/work/folio/fix',
      paneKey: 'chat-1',
      state: 'blocked',
      receivedAt: Date.now()
    })
    assert.equal((await worker.request('office.snapshot')).agents[0].state, 'blocked')
    // ...and the person is told once, by the name the agent goes by.
    await waitUntil('the transition group deadline', () => host.callsOf('notifications.show').length === 1)
    assert.deepEqual(host.callsOf('notifications.show'), [
      { title: 'fix needs you', body: 'Fix series sort' }
    ])

  } finally {
    releaseChanges()
    try {
      await worker.deactivate()
    } finally {
      cli.changes = originalChanges
      listed = null
    }
  }
})

test('keeps quiet about what the person turned off', async () => {
  listed = [
    {
      path: '/w',
      displayName: 'w',
      agents: [{ paneKey: 'chat', state: 'working', agentType: 'claude' }]
    }
  ]
  const host = mockHost({ storage: { prefs: { notifyBlocked: false } } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('roster enrichment before notification check', async () => {
      const state = await worker.request('office.snapshot')
      return state.agents.some((agent) => agent.id === 'chat') && state.changes['/w']?.files === 2
    })
    await worker.emit('agent.status.changed', {
      workspaceId: 'p::/w',
      paneKey: 'chat',
      state: 'blocked',
      receivedAt: Date.now()
    })
    assert.deepEqual(host.callsOf('notifications.show'), [])
  } finally {
    try {
      await worker.deactivate()
    } finally {
      listed = null
    }
  }
})

test('does not replay startup notifications and deduplicates an event when the roster catches up', async () => {
  listed = [{
    path: '/notifications',
    agents: [
      { paneKey: 'agent', state: 'working', agentType: 'claude' },
      { paneKey: 'already-done', state: 'done', agentType: 'claude' }
    ]
  }]
  const originalRoster = cli.roster
  let rosterCalls = 0
  cli.roster = async () => (rosterCalls++, listed)
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('initial roster announcement baseline', () => host.callsOf('statusBar.update').length > 0)
    assert.deepEqual(host.callsOf('notifications.show'), [])

    await worker.emit('agent.status.changed', {
      workspaceId: '/notifications', paneKey: 'agent', state: 'blocked', receivedAt: Date.now()
    })
    await waitUntil('the transition notification', () => host.callsOf('notifications.show').length === 1)
    listed![0].agents![0].state = 'blocked'
    await waitUntil('the roster to observe the event transition', () => rosterCalls > 1)
    assert.deepEqual(host.callsOf('notifications.show'), [{ title: 'An agent needs you', body: undefined }])
  } finally {
    try {
      await worker.deactivate()
    } finally {
      cli.roster = originalRoster
      listed = null
    }
  }
})

test('notification controls are target-specific, persisted, and reject stale episode requests', async () => {
  listed = [{ path: '/notify-project', displayName: 'Notify project', agents: [{ paneKey: 'notify-agent', state: 'working', agentType: 'claude' }] }]
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('notification target roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'notify-agent'))
    const agent = (await worker.request('office.snapshot')).agents.find((entry) => entry.id === 'notify-agent')!
    const projectId = agent.projectId ?? agent.workspaceId!
    const episodeId = `${agent.id}@${agent.stateStartedAt}`
    assert.deepEqual(await worker.request('notification.control.read', { projectId, agentId: agent.id, episodeId }), {
      status: 'ready', projectId, muted: false, agentId: agent.id, episodeId, snoozed: false, expiresAt: null
    })
    assert.deepEqual(await worker.request('notification.reminder.snooze', {
      projectId, agentId: agent.id, episodeId: 'stale-episode', choice: 'manual'
    }), { ok: false, error: 'That agent episode is no longer current.' })
    assert.deepEqual(await Promise.all([
      worker.request('notification.project.mute', { projectId, muted: true }),
      worker.request('notification.reminder.snooze', { projectId, agentId: agent.id, episodeId, choice: 'manual' })
    ]), [{ ok: true }, { ok: true }])
    assert.deepEqual(host.data().storage['notification.policy'], {
      mutedProjects: [projectId], reminderSnoozes: [{ episodeId, expiresAt: null, setAt: (host.data().storage['notification.policy'] as { reminderSnoozes: { setAt: number }[] }).reminderSnoozes[0].setAt }], handledTransitions: []
    })
    const control = await worker.request('notification.control.read', { projectId, agentId: agent.id, episodeId })
    assert.equal(control.muted, true)
    assert.equal(control.snoozed, true)
    assert.equal(control.expiresAt, null)
    const officeUpdates = worker.posts.filter((post) => post.event === 'office.update')
    assert.ok(officeUpdates.every((post) => !JSON.stringify(post.payload).includes('mutedProjects')))
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('successful notification control writes publish a refresh for other panels', async () => {
  listed = [{ path: '/notification-peer-refresh', agents: [{ paneKey: 'peer-agent', state: 'working', agentType: 'claude' }] }]
  const worker = await mountWorker(main)
  try {
    await waitUntil('notification peer roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'peer-agent'))
    const agent = (await worker.request('office.snapshot')).agents.find((entry) => entry.id === 'peer-agent')!
    const projectId = agent.projectId ?? agent.workspaceId!
    let stableCount = 0
    let lastCount = -1
    for (let i = 0; i < 30 && stableCount < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const count = worker.posts.filter((post) => post.event === 'office.update').length
      stableCount = count === lastCount ? stableCount + 1 : 0
      lastCount = count
    }
    const beforeMute = worker.posts.filter((post) => post.event === 'office.update').length
    assert.deepEqual(await worker.request('notification.project.mute', { projectId, muted: true }), { ok: true })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.ok(worker.posts.filter((post) => post.event === 'office.update').length > beforeMute, 'successful mute did not refresh other panels')
    const afterMute = worker.posts.filter((post) => post.event === 'office.update').length
    assert.deepEqual(await worker.request('notification.reminder.snooze', {
      projectId, agentId: agent.id, episodeId: `${agent.id}@${agent.stateStartedAt}`, choice: 'manual'
    }), { ok: true })
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.ok(worker.posts.filter((post) => post.event === 'office.update').length > afterMute, 'successful snooze did not refresh other panels')
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a successful snooze waits for durable status-transition identity before acknowledging', async () => {
  listed = [{ path: '/durable-snooze', agents: [{ paneKey: 'durable-agent', state: 'working', agentType: 'claude' }] }]
  const backing: Record<string, unknown> = { prefs: { notifyBlocked: false } }
  let gateOfficeWrite = false
  let officeWriteStarted = false
  let releaseOfficeWrite!: () => void
  const officeGate = new Promise<void>((resolve) => { releaseOfficeWrite = resolve })
  const host = mockHost({ results: {
    'storage.get': (params: unknown) => ({ value: backing[(params as { key: string }).key] ?? null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office' && gateOfficeWrite) {
        gateOfficeWrite = false
        officeWriteStarted = true
        await officeGate
      }
      backing[key] = value
      return { ok: true }
    }
  } })
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('durable snooze initial office save', () => Array.isArray((backing.office as OfficeSnapshot | undefined)?.agents))
    gateOfficeWrite = true
    const observedAt = Date.now()
    listed![0].agents![0].state = 'blocked'
    listed![0].agents![0].stateStartedAt = observedAt
    const transition = worker.emit('agent.status.changed', {
      workspaceId: '/durable-snooze', paneKey: 'durable-agent', state: 'blocked', receivedAt: observedAt
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(officeWriteStarted, true, 'the observed episode should begin saving before the normal save timer')
    const episodeId = `durable-agent@${observedAt}`
    let snoozeSettled = false
    const snooze = worker.request('notification.reminder.snooze', {
      projectId: '/durable-snooze', agentId: 'durable-agent', episodeId, choice: 'manual'
    }).then((result) => { snoozeSettled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(snoozeSettled, false)
    assert.equal(backing['notification.policy'], undefined)
    releaseOfficeWrite()
    await transition
    assert.deepEqual(await snooze, { ok: true })
    const savedAgent = (backing.office as OfficeSnapshot).agents.find((agent) => agent.id === 'durable-agent')!
    assert.equal(savedAgent.notificationEpisodeId ?? `${savedAgent.id}@${savedAgent.stateStartedAt}`, episodeId)
    const savedPolicy = backing['notification.policy'] as { reminderSnoozes: { episodeId: string }[] } | undefined
    assert.equal(savedPolicy?.reminderSnoozes[0].episodeId, episodeId)

    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('durable snooze restart baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'durable-agent'))
    const restored = await worker.request('notification.control.read', { projectId: '/durable-snooze', agentId: 'durable-agent' })
    assert.equal(restored.episodeId, episodeId)
    assert.equal(restored.snoozed, true)
  } finally {
    releaseOfficeWrite()
    await worker.deactivate()
    listed = null
  }
})

test('a snooze paused at office save cannot overwrite policy after its worker deactivates', async () => {
  listed = [{ path: '/stopped-snooze', agents: [{ paneKey: 'stopped-agent', state: 'working', agentType: 'claude' }] }]
  const backing: Record<string, unknown> = { prefs: { notifyBlocked: false } }
  let gateOfficeWrite = false
  let officeWriteStarted = false
  let releaseOfficeWrite!: () => void
  const officeGate = new Promise<void>((resolve) => { releaseOfficeWrite = resolve })
  const storageResults = {
    'storage.get': (params: unknown) => ({ value: backing[(params as { key: string }).key] ?? null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office' && gateOfficeWrite) {
        gateOfficeWrite = false
        officeWriteStarted = true
        await officeGate
      }
      backing[key] = value
      return { ok: true }
    }
  }
  let oldWorker = await mountWorker(main, { host: mockHost({ results: storageResults }) })
  let newWorker: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    await waitUntil('stopped snooze initial office save', () => Array.isArray((backing.office as OfficeSnapshot | undefined)?.agents))
    await waitUntil('stopped snooze policy restore', async () => (await oldWorker.request('notification.control.read', { projectId: '/stopped-snooze' })).status === 'ready')
    gateOfficeWrite = true
    const observedAt = Date.now()
    listed![0].agents![0].state = 'blocked'
    listed![0].agents![0].stateStartedAt = observedAt
    const transition = oldWorker.emit('agent.status.changed', {
      workspaceId: '/stopped-snooze', paneKey: 'stopped-agent', state: 'blocked', receivedAt: observedAt
    })
    await waitUntil('stopped snooze office save gate', () => officeWriteStarted)
    const oldSnooze = oldWorker.request('notification.reminder.snooze', {
      projectId: '/stopped-snooze', agentId: 'stopped-agent', episodeId: `stopped-agent@${observedAt}`, choice: 'manual'
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    let stopped = false
    const oldShutdown = main.deactivate().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(stopped, false, 'deactivation waits until the queued snooze can finish saving the office episode')
    releaseOfficeWrite()
    await transition
    await oldShutdown
    assert.deepEqual(await oldSnooze, { ok: false, error: 'The worker stopped before saving reminder settings.' })
    assert.equal(backing['notification.policy'], undefined, 'stopped snooze must not begin a policy write')
    await oldWorker.deactivate()
    newWorker = await mountWorker(main, { host: mockHost({ results: storageResults }) })
    await waitUntil('replacement worker notification controls', async () =>
      (await newWorker!.request('notification.control.read', { projectId: '/stopped-snooze' })).status === 'ready')
    assert.deepEqual(await newWorker.request('notification.project.mute', { projectId: '/stopped-snooze', muted: true }), { ok: true })
    const replacementPolicy = backing['notification.policy'] as { mutedProjects: string[] } | undefined
    assert.deepEqual(replacementPolicy?.mutedProjects, ['/stopped-snooze'])
  } finally {
    releaseOfficeWrite()
    await oldWorker.deactivate()
    await newWorker?.deactivate()
    listed = null
  }
})

test('deactivation waits for an in-flight project mute write before a replacement changes policy', async () => {
  listed = [{ path: '/drain-mute', agents: [{ paneKey: 'mute-agent', state: 'working', agentType: 'claude' }] }]
  const backing: Record<string, unknown> = { prefs: { notifyBlocked: false } }
  let gatePolicyWrite = false
  let policyWriteStarted = false
  let releasePolicyWrite!: () => void
  const policyGate = new Promise<void>((resolve) => { releasePolicyWrite = resolve })
  const storageResults = {
    'storage.get': (params: unknown) => ({ value: backing[(params as { key: string }).key] ?? null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'notification.policy' && gatePolicyWrite) {
        gatePolicyWrite = false
        policyWriteStarted = true
        await policyGate
      }
      backing[key] = value
      return { ok: true }
    }
  }
  let worker = await mountWorker(main, { host: mockHost({ results: storageResults }) })
  let replacement: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    await waitUntil('mute target roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'mute-agent'))
    const control = await worker.request('notification.control.read', { projectId: '/drain-mute', agentId: 'mute-agent' })
    assert.equal(control.status, 'ready')
    assert.ok(control.episodeId)
    gatePolicyWrite = true
    const mute = worker.request('notification.project.mute', { projectId: '/drain-mute', muted: true })
    await waitUntil('mute storage write gate', () => policyWriteStarted)
    const queuedSnooze = worker.request('notification.reminder.snooze', {
      projectId: '/drain-mute', agentId: 'mute-agent', episodeId: control.episodeId, choice: 'manual'
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    let stopped = false
    const shutdown = main.deactivate().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(stopped, false, 'deactivation must remain pending while the policy write is in flight')
    releasePolicyWrite()
    await shutdown
    assert.deepEqual(await mute, { ok: false, error: 'Could not save notification settings. Try again.' })
    assert.deepEqual(await queuedSnooze, { ok: false, error: 'The worker stopped before saving reminder settings.' })
    await worker.deactivate()

    replacement = await mountWorker(main, { host: mockHost({ results: storageResults }) })
    await waitUntil('replacement mute target roster', async () => (await replacement!.request('office.snapshot')).agents.some((agent) => agent.id === 'mute-agent'))
    await waitUntil('replacement mute policy ready', async () => (await replacement!.request('notification.control.read', { projectId: '/drain-mute' })).status === 'ready')
    assert.deepEqual(await replacement.request('notification.project.mute', { projectId: '/drain-mute', muted: false }), { ok: true })
    assert.deepEqual((backing['notification.policy'] as { mutedProjects: string[] }).mutedProjects, [])
  } finally {
    releasePolicyWrite()
    await worker.deactivate()
    await replacement?.deactivate()
    listed = null
  }
})

test('deactivation drains an in-flight snooze write before a replacement resumes it', async () => {
  listed = [{ path: '/drain-snooze', agents: [{ paneKey: 'snooze-agent', state: 'blocked', agentType: 'claude' }] }]
  const backing: Record<string, unknown> = { prefs: { notifyBlocked: false } }
  let gatePolicyWrite = false
  let policyWriteStarted = false
  let releasePolicyWrite!: () => void
  const policyGate = new Promise<void>((resolve) => { releasePolicyWrite = resolve })
  const storageResults = {
    'storage.get': (params: unknown) => ({ value: backing[(params as { key: string }).key] ?? null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'notification.policy' && gatePolicyWrite) {
        gatePolicyWrite = false
        policyWriteStarted = true
        await policyGate
      }
      backing[key] = value
      return { ok: true }
    }
  }
  let worker = await mountWorker(main, { host: mockHost({ results: storageResults }) })
  let replacement: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    await waitUntil('snooze target roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'snooze-agent'))
    const control = await worker.request('notification.control.read', { projectId: '/drain-snooze', agentId: 'snooze-agent' })
    assert.equal(control.status, 'ready')
    assert.ok(control.episodeId)
    gatePolicyWrite = true
    const snooze = worker.request('notification.reminder.snooze', {
      projectId: '/drain-snooze', agentId: 'snooze-agent', episodeId: control.episodeId, choice: 'manual'
    })
    await waitUntil('snooze storage write gate', () => policyWriteStarted)
    let stopped = false
    const shutdown = main.deactivate().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(stopped, false, 'deactivation must drain an in-flight snooze policy write')
    releasePolicyWrite()
    await shutdown
    assert.deepEqual(await snooze, { ok: false, error: 'Could not save notification settings. Try again.' })
    await worker.deactivate()

    replacement = await mountWorker(main, { host: mockHost({ results: storageResults }) })
    const restored = await replacement.request('notification.control.read', {
      projectId: '/drain-snooze', agentId: 'snooze-agent'
    })
    assert.equal(restored.status, 'ready')
    assert.equal(restored.snoozed, true)
    assert.ok(restored.episodeId)
    assert.deepEqual(await replacement.request('notification.reminder.snooze', {
      projectId: '/drain-snooze', agentId: 'snooze-agent', episodeId: restored.episodeId, choice: 'resume'
    }), { ok: true })
    assert.deepEqual((backing['notification.policy'] as { reminderSnoozes: unknown[] }).reminderSnoozes, [])
  } finally {
    releasePolicyWrite()
    await worker.deactivate()
    await replacement?.deactivate()
    listed = null
  }
})

test('deactivation drains notification policy recovery and prevents a late restore', async () => {
  listed = [{ path: '/drain-recovery', agents: [{ paneKey: 'recovery-agent', state: 'waiting', agentType: 'claude' }] }]
  const original = { mutedProjects: ['/drain-recovery'], reminderSnoozes: [], handledTransitions: [] }
  let policyReads = 0
  let policyWrites = 0
  let recoveryStarted = false
  let releaseRecovery!: () => void
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve })
  const backing: Record<string, unknown> = { prefs: { notifyBlocked: false }, 'notification.policy': original }
  const host = mockHost({ results: {
    'storage.get': async (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'notification.policy' && ++policyReads === 1) throw new Error('temporary read failure')
      if (key === 'notification.policy' && policyReads === 2) {
        recoveryStarted = true
        await recoveryGate
      }
      return { value: backing[key] ?? null }
    },
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'notification.policy') policyWrites++
      backing[key] = value
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('recovery policy read failure', async () =>
      (await worker.request('notification.control.read', { projectId: '/drain-recovery' })).status === 'error')
    await waitUntil('notification policy retry read gate', () => recoveryStarted)
    let stopped = false
    const shutdown = main.deactivate().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(stopped, false, 'shutdown must drain an in-flight recovery read')
    releaseRecovery()
    await shutdown
    assert.deepEqual(backing['notification.policy'], original)
    assert.equal(policyWrites, 0)
  } finally {
    releaseRecovery()
    await worker.deactivate()
    listed = null
  }
})

test('deactivation drains its office save before a replacement episode and snooze are persisted', async () => {
  listed = [{ path: '/drain-office', agents: [{ paneKey: 'office-agent', state: 'working', agentType: 'claude' }] }]
  const backing: Record<string, unknown> = { prefs: { notifyBlocked: false } }
  let gateShutdownSave = false
  let officeSaveStarted = false
  let releaseOfficeSave!: () => void
  const officeSaveGate = new Promise<void>((resolve) => { releaseOfficeSave = resolve })
  const host = mockHost({ results: {
    'storage.get': (params: unknown) => ({ value: backing[(params as { key: string }).key] ?? null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office' && gateShutdownSave) {
        gateShutdownSave = false
        officeSaveStarted = true
        await officeSaveGate
      }
      backing[key] = value
      return { ok: true }
    }
  } })
  let worker = await mountWorker(main, { host })
  let replacement: Awaited<ReturnType<typeof mountWorker>> | undefined
  try {
    await waitUntil('office drain initial roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'office-agent'))
    await waitUntil('office drain notification baseline', () => worker.posts.some((post) => post.event === 'office.update'))
    await new Promise((resolve) => setTimeout(resolve, 3_100))
    const firstObservedAt = Date.now()
    listed![0].agents![0].state = 'blocked'
    listed![0].agents![0].stateStartedAt = firstObservedAt
    await worker.emit('agent.status.changed', {
      workspaceId: '/drain-office', paneKey: 'office-agent', state: 'blocked', receivedAt: firstObservedAt
    })
    await waitUntil('old blocked episode persisted', () => {
      const saved = (backing.office as OfficeSnapshot | undefined)?.agents.find((agent) => agent.id === 'office-agent')
      return saved?.state === 'blocked'
    })
    await waitUntil('old blocked office update posted', () => worker.posts.some((post) =>
      post.event === 'office.update' && (post.payload as OfficeSnapshot).agents.some((agent) => agent.id === 'office-agent' && agent.state === 'blocked')
    ))
    const oldControl = await worker.request('notification.control.read', { projectId: '/drain-office', agentId: 'office-agent' })
    assert.equal(oldControl.status, 'ready')
    assert.ok(oldControl.episodeId)
    gateShutdownSave = true
    let stopped = false
    const shutdown = main.deactivate().then(() => { stopped = true })
    await waitUntil('shutdown office save gate', () => officeSaveStarted)
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(stopped, false, 'deactivation must wait for the shutdown office write')
    releaseOfficeSave()
    await shutdown
    await worker.deactivate()

    const savedBeforeRestart = (backing.office as OfficeSnapshot).agents.find((agent) => agent.id === 'office-agent')!
    const oldEpisodeId = oldControl.episodeId
    assert.equal(savedBeforeRestart.notificationEpisodeId ?? `${savedBeforeRestart.id}@${savedBeforeRestart.stateStartedAt}`, oldEpisodeId)
    replacement = await mountWorker(main, { host })
    await waitUntil('replacement restores saved blocked row', async () => (await replacement!.request('office.snapshot')).agents.some((agent) => agent.id === 'office-agent'))
    const restored = await replacement.request('notification.control.read', { projectId: '/drain-office', agentId: 'office-agent' })
    assert.equal(restored.status, 'ready')
    assert.equal(restored.episodeId, oldEpisodeId)

    const secondObservedAt = Date.now() + 1
    listed![0].agents![0].state = 'working'
    await replacement.emit('agent.status.changed', {
      workspaceId: '/drain-office', paneKey: 'office-agent', state: 'working', receivedAt: secondObservedAt
    })
    const thirdObservedAt = secondObservedAt + 1
    listed![0].agents![0].state = 'blocked'
    await replacement.emit('agent.status.changed', {
      workspaceId: '/drain-office', paneKey: 'office-agent', state: 'blocked', receivedAt: thirdObservedAt
    })
    const current = await replacement.request('notification.control.read', { projectId: '/drain-office', agentId: 'office-agent' })
    assert.ok(current.episodeId)
    assert.notEqual(current.episodeId, oldEpisodeId)
    assert.deepEqual(await replacement.request('notification.reminder.snooze', {
      projectId: '/drain-office', agentId: 'office-agent', episodeId: current.episodeId, choice: 'manual'
    }), { ok: true })
    const finalOffice = (backing.office as OfficeSnapshot).agents.find((agent) => agent.id === 'office-agent')!
    const finalPolicy = backing['notification.policy'] as { reminderSnoozes: { episodeId: string }[] }
    assert.equal(finalOffice.notificationEpisodeId ?? `${finalOffice.id}@${finalOffice.stateStartedAt}`, current.episodeId)
    assert.equal(finalPolicy.reminderSnoozes[0]?.episodeId, current.episodeId)
  } finally {
    releaseOfficeSave()
    await worker.deactivate()
    await replacement?.deactivate()
    listed = null
  }
})

test('office recovery completing after shutdown cannot enqueue a late save', async () => {
  listed = [{ path: '/late-office-recovery', agents: [{ paneKey: 'recovery-agent', state: 'waiting', agentType: 'claude' }] }]
  const backing: Record<string, unknown> = { office: snapshot(createOffice()) }
  let officeReads = 0
  let gateInstallWrite = true
  let installWriteStarted = false
  let officeWrites = 0
  let releaseInstallWrite!: () => void
  const installGate = new Promise<void>((resolve) => { releaseInstallWrite = resolve })
  const host = mockHost({ results: {
    'storage.get': (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'office' && officeReads++ === 0) throw new Error('temporary office read failure')
      return { value: backing[key] ?? null }
    },
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office') officeWrites++
      if (key === 'lobby.installation' && gateInstallWrite) {
        gateInstallWrite = false
        installWriteStarted = true
        await installGate
      }
      backing[key] = value
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('office recovery retry installation gate', () => installWriteStarted)
    const postsBeforeShutdown = worker.posts.length
    await main.deactivate()
    releaseInstallWrite()
    await worker.deactivate()
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(officeWrites, 0)
    assert.equal(worker.posts.length, postsBeforeShutdown)
  } finally {
    releaseInstallWrite()
    await worker.deactivate()
    listed = null
  }
})

test('a failed or stale office episode save refuses a snooze without writing policy', async () => {
  listed = [{ path: '/snooze-save-failure', agents: [{ paneKey: 'failure-agent', state: 'working', agentType: 'claude' }] }]
  const backing: Record<string, unknown> = { prefs: { notifyBlocked: false } }
  let failOfficeWrites = false
  let gateOfficeWrite = false
  let officeWriteStarted = false
  let releaseOfficeWrite!: () => void
  let officeGate = new Promise<void>((resolve) => { releaseOfficeWrite = resolve })
  const host = mockHost({ results: {
    'storage.get': (params: unknown) => ({ value: backing[(params as { key: string }).key] ?? null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office' && failOfficeWrites) throw new Error('office unavailable')
      if (key === 'office' && gateOfficeWrite) {
        officeWriteStarted = true
        await officeGate
        gateOfficeWrite = false
      }
      backing[key] = value
      return { ok: true }
    }
  } })
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('failed snooze initial office save', () => Array.isArray((backing.office as OfficeSnapshot | undefined)?.agents))
    const initial = (backing.office as OfficeSnapshot).agents.find((agent) => agent.id === 'failure-agent')!
    failOfficeWrites = true
    listed![0].agents![0].state = 'blocked'
    await worker.emit('agent.status.changed', {
      workspaceId: '/snooze-save-failure', paneKey: 'failure-agent', state: 'blocked', receivedAt: Date.now()
    })
    const blocked = await worker.request('notification.control.read', { projectId: '/snooze-save-failure', agentId: 'failure-agent' })
    assert.deepEqual(await worker.request('notification.reminder.snooze', {
      projectId: '/snooze-save-failure', agentId: 'failure-agent', episodeId: blocked.episodeId!, choice: 'manual'
    }), { ok: false, error: 'Could not save the current agent episode. Try again.' })
    assert.equal(backing['notification.policy'], undefined)
    assert.equal((backing.office as OfficeSnapshot).agents.find((agent) => agent.id === 'failure-agent')?.state, initial.state)

    failOfficeWrites = false
    officeWriteStarted = false
    gateOfficeWrite = true
    const workingAt = Date.now() + 1
    const nextTransition = worker.emit('agent.status.changed', {
      workspaceId: '/snooze-save-failure', paneKey: 'failure-agent', state: 'working', receivedAt: workingAt
    })
    await waitUntil('racing status office write begins', () => officeWriteStarted)
    const staleEpisode = `failure-agent@${workingAt}`
    const staleSnooze = worker.request('notification.reminder.snooze', {
      projectId: '/snooze-save-failure', agentId: 'failure-agent', episodeId: staleEpisode, choice: 'manual'
    })
    listed![0].agents![0].state = 'blocked'
    const changedAgain = worker.emit('agent.status.changed', {
      workspaceId: '/snooze-save-failure', paneKey: 'failure-agent', state: 'blocked', receivedAt: Date.now() + 2
    })
    releaseOfficeWrite()
    await Promise.all([nextTransition, changedAgain])
    assert.deepEqual(await staleSnooze, { ok: false, error: 'That agent episode is no longer current.' })
    assert.equal(backing['notification.policy'], undefined)
  } finally {
    releaseOfficeWrite()
    await worker.deactivate()
    listed = null
  }
})

test('a snoozed observed episode survives roster time correction and restart, but observed transitions rotate it', async () => {
  listed = [{ path: '/notification-episode', agents: [{ paneKey: 'episode-agent', state: 'working', agentType: 'claude' }] }]
  const host = mockHost()
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('episode target baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'episode-agent'))
    await waitUntil('episode notification baseline', () => host.callsOf('statusBar.update').length > 0)
    const projectId = '/notification-episode'
    const before = await worker.request('notification.control.read', { projectId, agentId: 'episode-agent' })
    assert.equal(before.status, 'ready')
    const workingEpisode = before.episodeId!

    const transitionAt = Date.now()
    await worker.emit('agent.status.changed', { workspaceId: projectId, paneKey: 'episode-agent', state: 'blocked', receivedAt: transitionAt })
    const observed = await worker.request('notification.control.read', { projectId, agentId: 'episode-agent' })
    assert.equal(observed.status, 'ready')
    const blockedEpisode = observed.episodeId!
    assert.notEqual(blockedEpisode, workingEpisode)
    assert.deepEqual(await worker.request('notification.reminder.snooze', {
      projectId, agentId: 'episode-agent', episodeId: blockedEpisode, choice: 'manual'
    }), { ok: true })

    listed![0].agents![0].state = 'blocked'
    const correctedAt = transitionAt - 5_000
    listed![0].agents![0].stateStartedAt = correctedAt
    await waitUntil('roster corrects the blocked transition timestamp', async () =>
      (await worker.request('office.snapshot')).agents.find((agent) => agent.id === 'episode-agent')?.stateStartedAt === correctedAt
    )
    const corrected = await worker.request('notification.control.read', { projectId, agentId: 'episode-agent' })
    assert.equal(corrected.episodeId, blockedEpisode)
    assert.equal(corrected.snoozed, true)
    await waitUntil('corrected episode identity is durable', () =>
      (host.data().storage.office as OfficeSnapshot | undefined)?.agents.find((agent) => agent.id === 'episode-agent')?.notificationEpisodeId === blockedEpisode
    )
    await worker.deactivate()
    assert.ok(host.data().storage.office)
    worker = await mountWorker(main, { host })
    await waitUntil('restored episode baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'episode-agent'))
    const restored = await worker.request('notification.control.read', { projectId, agentId: 'episode-agent', episodeId: blockedEpisode })
    assert.equal(restored.status, 'ready')
    assert.equal(restored.snoozed, true)

    listed![0].agents![0].state = 'working'
    await worker.emit('agent.status.changed', { workspaceId: projectId, paneKey: 'episode-agent', state: 'working', receivedAt: transitionAt + 1 })
    const nextEpisode = await worker.request('notification.control.read', { projectId, agentId: 'episode-agent' })
    assert.equal(nextEpisode.status, 'ready')
    assert.notEqual(nextEpisode.episodeId, blockedEpisode)
    assert.equal(nextEpisode.snoozed, false)
    await worker.emit('agent.status.changed', { workspaceId: projectId, paneKey: 'episode-agent', state: 'working', receivedAt: transitionAt + 2 })
    const sameObservedEpisode = await worker.request('notification.control.read', { projectId, agentId: 'episode-agent' })
    assert.equal(sameObservedEpisode.episodeId, nextEpisode.episodeId)
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a snoozed episode survives roster removal and restart but a new turn supersedes it', async () => {
  const transitionAt = Date.now()
  const sourceAt = transitionAt - 5_000
  const heartbeat = { paneKey: 'heartbeat-agent', state: 'working' as const, agentType: 'claude' }
  listed = [{ path: '/notification-reconnect', agents: [
    { paneKey: 'reconnect-agent', state: 'working', stateStartedAt: transitionAt - 60_000, turnId: 'turn-a', agentType: 'claude' }, heartbeat
  ] }]
  const host = mockHost({ storage: { prefs: { notifyBlocked: false } } })
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('reconnect target baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'reconnect-agent'))
    await waitUntil('reconnect notification policy ready', async () => (await worker.request('notification.control.read', { projectId: '/notification-reconnect' })).status === 'ready')
    await worker.emit('agent.status.changed', {
      workspaceId: '/notification-reconnect', paneKey: 'reconnect-agent', state: 'blocked', receivedAt: transitionAt
    })
    const blocked = await worker.request('notification.control.read', { projectId: '/notification-reconnect', agentId: 'reconnect-agent' })
    const snoozedEpisode = blocked.episodeId!
    assert.deepEqual(await worker.request('notification.reminder.snooze', {
      projectId: '/notification-reconnect', agentId: 'reconnect-agent', episodeId: snoozedEpisode, choice: 'manual'
    }), { ok: true })

    listed![0].agents![0].state = 'blocked'
    listed![0].agents![0].stateStartedAt = sourceAt
    await waitUntil('late roster timestamp correction', async () =>
      (await worker.request('office.snapshot')).agents.find((agent) => agent.id === 'reconnect-agent')?.stateStartedAt === sourceAt
    )
    listed = [{ path: '/notification-reconnect', agents: [heartbeat] }]
    await waitUntil('roster removal', async () => !(await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'reconnect-agent'))
    await waitUntil('disconnected episode metadata saved', () => {
      const stored = host.data().storage.office as { notificationEpisodes?: Record<string, unknown> } | undefined
      return Object.keys(stored?.notificationEpisodes ?? {}).length > 0
    })

    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('empty roster after restart', async () => (await worker.request('office.snapshot')).agents.length === 0)
    listed = [{ path: '/notification-reconnect', agents: [
      { paneKey: 'reconnect-agent', state: 'blocked', stateStartedAt: sourceAt, turnId: 'turn-a', agentType: 'claude' }, heartbeat
    ] }]
    await waitUntil('same episode reconnects', async () => {
      const state = await worker.request('notification.control.read', { projectId: '/notification-reconnect', agentId: 'reconnect-agent' })
      return state.status === 'ready' && state.snoozed === true
    })
    const reconnected = await worker.request('notification.control.read', { projectId: '/notification-reconnect', agentId: 'reconnect-agent' })
    assert.equal(reconnected.episodeId, snoozedEpisode)
    assert.equal(reconnected.snoozed, true)

    listed![0].agents![0].turnId = 'turn-b'
    await waitUntil('new reported turn supersedes old snooze', async () => {
      const state = await worker.request('notification.control.read', { projectId: '/notification-reconnect', agentId: 'reconnect-agent' })
      return state.status === 'ready' && state.episodeId !== snoozedEpisode
    })
    const nextTurn = await worker.request('notification.control.read', { projectId: '/notification-reconnect', agentId: 'reconnect-agent' })
    assert.equal(nextTurn.snoozed, false)
    listed = [{ path: '/notification-reconnect', agents: [heartbeat] }]
    await waitUntil('new turn removed without resurrecting metadata rows', async () => !(await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'reconnect-agent'))
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    listed = [{ path: '/notification-reconnect', agents: [heartbeat] }]
    await waitUntil('restart keeps unlisted agent absent', async () => !(await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'reconnect-agent'))
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a late roster timestamp correction cannot invalidate a pending blocked notification', async () => {
  const transitionAt = Date.now()
  const sourceAt = transitionAt - 5_000
  const heartbeat = { paneKey: 'correction-heartbeat', state: 'working' as const, agentType: 'claude' }
  listed = [{ path: '/notification-correction', agents: [
    { paneKey: 'correction-agent', state: 'working', stateStartedAt: transitionAt - 60_000, agentType: 'claude' }, heartbeat
  ] }]
  const host = mockHost()
  let worker = await mountWorker(main, { host })
  const originalRoster = cli.roster
  let releaseRoster!: () => void
  let rosterStarted = false
  let gateNextRoster = false
  const rosterGate = new Promise<void>((resolve) => { releaseRoster = resolve })
  cli.roster = async () => {
    if (gateNextRoster) {
      gateNextRoster = false
      rosterStarted = true
      await rosterGate
    }
    return listed
  }
  try {
    await waitUntil('late correction transition baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'correction-agent'))
    await waitUntil('late correction notification baseline', () => host.callsOf('statusBar.update').length > 0)
    gateNextRoster = true
    await waitUntil('roster poll paused before correction', () => rosterStarted)
    const transition = worker.emit('agent.status.changed', {
      workspaceId: '/notification-correction', paneKey: 'correction-agent', state: 'blocked', receivedAt: transitionAt
    })
    await waitUntil('late correction identity persisted', () => {
      const policy = host.data().storage['notification.policy'] as { handledTransitions?: { kind: string; transitionId: string }[] } | undefined
      return policy?.handledTransitions?.some((entry) => entry.kind === 'transition') === true
    })
    listed![0].agents![0].state = 'blocked'
    listed![0].agents![0].stateStartedAt = sourceAt
    releaseRoster()
    await waitUntil('late correction applied before queue deadline', async () =>
      (await worker.request('office.snapshot')).agents.find((agent) => agent.id === 'correction-agent')?.stateStartedAt === sourceAt
    )
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    await transition
    assert.equal(host.callsOf('notifications.show').length, 1)
    const calls = host.calls.map((call) => call.method)
    assert.ok(calls.indexOf('storage.set') < calls.indexOf('notifications.show'))
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('late correction restart baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'correction-agent'))
    await worker.emit('agent.status.changed', {
      workspaceId: '/notification-correction', paneKey: 'correction-agent', state: 'blocked', receivedAt: transitionAt
    })
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    assert.equal(host.callsOf('notifications.show').length, 1)
  } finally {
    releaseRoster()
    await worker.deactivate()
    cli.roster = originalRoster
    listed = null
  }
})

test('a corrupt notification policy blocks controls and preserves the stored bytes', async () => {
  listed = [{ path: '/corrupt-project', agents: [{ paneKey: 'corrupt-agent', state: 'waiting', agentType: 'claude' }] }]
  const original = { mutedProjects: 'corrupt', reminderSnoozes: [], handledTransitions: [] }
  const host = mockHost({ storage: { 'notification.policy': original } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('corrupt policy project roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'corrupt-agent'))
    const projectId = (await worker.request('office.snapshot')).agents[0].projectId ?? '/corrupt-project'
    const control = await worker.request('notification.control.read', { projectId })
    assert.equal(control.status, 'error')
    assert.ok(control.error)
    assert.deepEqual(await worker.request('notification.project.mute', { projectId, muted: true }), {
      ok: false, error: 'Notification settings could not be restored. Retry after storage is available.'
    })
    assert.deepEqual(host.data().storage['notification.policy'], original)
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a failed notification policy read blocks writes, then retries without replacing saved controls', async () => {
  listed = [{ path: '/notification-read', agents: [{ paneKey: 'read-agent', state: 'waiting', agentType: 'claude' }] }]
  const original = { mutedProjects: ['/notification-read'], reminderSnoozes: [], handledTransitions: [] }
  let failRead = true
  let policyReads = 0
  let policyWrites = 0
  let host: ReturnType<typeof mockHost>
  host = mockHost({ storage: { 'notification.policy': original }, results: {
    'storage.get': (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'notification.policy') {
        policyReads++
        if (failRead) { failRead = false; throw new Error('temporarily unavailable') }
      }
      return { value: host.data().storage[key] ?? null }
    },
    'storage.set': (params: unknown) => {
      const { key } = params as { key: string }
      if (key === 'notification.policy') policyWrites++
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('notification read target roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'read-agent'))
    const failed = await worker.request('notification.control.read', { projectId: '/notification-read' })
    assert.equal(failed.status, 'error')
    assert.deepEqual(await worker.request('notification.project.mute', { projectId: '/notification-read', muted: false }), {
      ok: false, error: 'Notification settings could not be restored. Retry after storage is available.'
    })
    assert.equal(policyWrites, 0)
    assert.deepEqual(host.data().storage['notification.policy'], original)
    await waitUntil('notification policy retry recovery', async () => {
      const recovered = await worker.request('notification.control.read', { projectId: '/notification-read' })
      return recovered.status === 'ready' && recovered.muted === true && policyReads >= 2
    })
    assert.equal(policyWrites, 0)
    assert.deepEqual(host.data().storage['notification.policy'], original)
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a failed notification policy write preserves saved controls and recovers from storage before retry', async () => {
  listed = [{ path: '/notification-write', agents: [{ paneKey: 'write-agent', state: 'waiting', agentType: 'claude' }] }]
  let storedPolicy: unknown = null
  let failWrite = true
  const host = mockHost({ results: {
    'storage.get': (params: unknown) => ({ value: (params as { key: string }).key === 'notification.policy' ? storedPolicy : null }),
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'notification.policy') {
        if (failWrite) { failWrite = false; throw new Error('temporarily unavailable') }
        storedPolicy = value
      }
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('notification write target roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'write-agent'))
    assert.deepEqual(await worker.request('notification.project.mute', { projectId: '/notification-write', muted: true }), {
      ok: false, error: 'Could not save notification settings. Try again.'
    })
    assert.equal(storedPolicy, null)
    assert.equal((await worker.request('notification.control.read', { projectId: '/notification-write' })).status, 'error')
    await waitUntil('notification policy write recovery', async () =>
      (await worker.request('notification.control.read', { projectId: '/notification-write' })).status === 'ready'
    )
    assert.equal(storedPolicy, null)
    assert.deepEqual(await worker.request('notification.project.mute', { projectId: '/notification-write', muted: true }), { ok: true })
    assert.deepEqual(storedPolicy, { mutedProjects: ['/notification-write'], reminderSnoozes: [], handledTransitions: [] })
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a transition identity is saved before dispatch and stale live state is filtered after the write', async () => {
  listed = [{ path: '/notification-gate', agents: [{ paneKey: 'gate-agent', state: 'working', agentType: 'claude' }] }]
  let policyValue: unknown = null
  let releaseWrite!: () => void
  let writeStarted = false
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
  const host = mockHost({ results: {
    'storage.get': (params: unknown) => ({ value: (params as { key: string }).key === 'notification.policy' ? policyValue : null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'notification.policy') {
        writeStarted = true
        await gate
        policyValue = value
      }
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('notification policy ready', async () => (await worker.request('notification.control.read', { projectId: '/notification-gate' })).status === 'ready')
    await waitUntil('notification gate agent baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'gate-agent'))
    await waitUntil('initial notification baseline complete', () => host.callsOf('statusBar.update').length > 0)
    const blocked = worker.emit('agent.status.changed', { workspaceId: '/notification-gate', paneKey: 'gate-agent', state: 'blocked', receivedAt: Date.now() })
    await waitUntil('transition identity write begins', () => writeStarted)
    assert.deepEqual(host.callsOf('notifications.show'), [])
    const working = worker.emit('agent.status.changed', { workspaceId: '/notification-gate', paneKey: 'gate-agent', state: 'working', receivedAt: Date.now() + 1 })
    releaseWrite()
    await Promise.all([blocked, working])
    await waitUntil('consumed identity saved', () => (policyValue as { handledTransitions?: unknown[] } | null)?.handledTransitions?.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    assert.deepEqual(host.callsOf('notifications.show'), [])
    listed![0].agents![0].state = 'blocked'
    await worker.emit('agent.status.changed', { workspaceId: '/notification-gate', paneKey: 'gate-agent', state: 'blocked', receivedAt: Date.now() + 2 })
    await waitUntil('eligible transition after its persisted identity', () => host.callsOf('notifications.show').length === 1)
    assert.equal((policyValue as { handledTransitions: unknown[] }).handledTransitions.length, 2)
  } finally {
    releaseWrite()
    await worker.deactivate()
    listed = null
  }
})

test('pending transition queues are discarded on restart after the consumed identity is saved', async () => {
  listed = [{ path: '/notification-restart', agents: [{ paneKey: 'restart-agent', state: 'working', agentType: 'claude' }] }]
  const host = mockHost()
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('notification restart baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'restart-agent'))
    await waitUntil('initial restart notification baseline complete', () => host.callsOf('statusBar.update').length > 0)
    await worker.emit('agent.status.changed', { workspaceId: '/notification-restart', paneKey: 'restart-agent', state: 'blocked', receivedAt: Date.now() })
    await waitUntil('transition consumed before its group deadline', () => (host.data().storage['notification.policy'] as { handledTransitions?: unknown[] } | undefined)?.handledTransitions?.length === 1)
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('restarted worker roster baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'restart-agent'))
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    assert.deepEqual(host.callsOf('notifications.show'), [])
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a dispatched transition identity stays deduplicated across repeat observations and restart', async () => {
  const transitionAt = Date.now()
  listed = [{ path: '/notification-duplicate', agents: [{ paneKey: 'duplicate-agent', state: 'working', agentType: 'claude' }] }]
  const host = mockHost()
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('duplicate target baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'duplicate-agent'))
    await waitUntil('duplicate notification baseline', () => host.callsOf('statusBar.update').length > 0)
    listed![0].agents![0].state = 'blocked'
    await worker.emit('agent.status.changed', { workspaceId: '/notification-duplicate', paneKey: 'duplicate-agent', state: 'blocked', receivedAt: transitionAt })
    await waitUntil('first transition delivery', () => host.callsOf('notifications.show').length === 1)

    listed![0].agents![0].state = 'working'
    await worker.emit('agent.status.changed', { workspaceId: '/notification-duplicate', paneKey: 'duplicate-agent', state: 'working', receivedAt: transitionAt + 1 })
    listed![0].agents![0].state = 'blocked'
    await worker.emit('agent.status.changed', { workspaceId: '/notification-duplicate', paneKey: 'duplicate-agent', state: 'blocked', receivedAt: transitionAt })
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    assert.equal(host.callsOf('notifications.show').length, 1)

    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('duplicate restart baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'duplicate-agent'))
    await waitUntil('duplicate restart announcement baseline', () => host.callsOf('statusBar.update').length > 0)
    listed![0].agents![0].state = 'working'
    await worker.emit('agent.status.changed', { workspaceId: '/notification-duplicate', paneKey: 'duplicate-agent', state: 'working', receivedAt: transitionAt + 1 })
    listed![0].agents![0].state = 'blocked'
    await worker.emit('agent.status.changed', { workspaceId: '/notification-duplicate', paneKey: 'duplicate-agent', state: 'blocked', receivedAt: transitionAt })
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    assert.equal(host.callsOf('notifications.show').length, 1)
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('muting while a transition group waits suppresses it, and unmuting does not catch up', async () => {
  listed = [{ path: '/notification-mute', agents: [{ paneKey: 'mute-agent', state: 'working', agentType: 'claude' }] }]
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('mute target baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'mute-agent'))
    await waitUntil('initial mute notification baseline', () => host.callsOf('statusBar.update').length > 0)
    await worker.emit('agent.status.changed', { workspaceId: '/notification-mute', paneKey: 'mute-agent', state: 'blocked', receivedAt: Date.now() })
    await waitUntil('mute group identity saved', () => (host.data().storage['notification.policy'] as { handledTransitions?: unknown[] } | undefined)?.handledTransitions?.length === 1)
    assert.deepEqual(await worker.request('notification.project.mute', { projectId: '/notification-mute', muted: true }), { ok: true })
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    assert.deepEqual(host.callsOf('notifications.show'), [])
    assert.deepEqual(await worker.request('notification.project.mute', { projectId: '/notification-mute', muted: false }), { ok: true })
    assert.deepEqual(host.callsOf('notifications.show'), [])
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('resuming an overdue reminder records its current spell and does not cause catch-up', async () => {
  const since = Date.now() - 21 * 60_000
  const episodeId = `snooze-agent@${since}`
  listed = [{ path: '/snooze-project', agents: [{ paneKey: 'snooze-agent', state: 'blocked', stateStartedAt: since, agentType: 'claude' }] }]
  const host = mockHost({ storage: { prefs: { stuckMinutes: 10 }, 'notification.policy': {
    mutedProjects: [], reminderSnoozes: [{ episodeId, expiresAt: null, setAt: Date.now() }], handledTransitions: []
  } } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('snoozed overdue agent roster', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'snooze-agent'))
    assert.deepEqual(host.callsOf('notifications.show'), [])
    assert.deepEqual(await worker.request('notification.reminder.snooze', {
      projectId: '/snooze-project', agentId: 'snooze-agent', episodeId, choice: 'resume'
    }), { ok: true })
    await worker.emit('agent.status.changed', { workspaceId: '/snooze-project', paneKey: 'snooze-agent', state: 'blocked', receivedAt: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(host.callsOf('notifications.show'), [])
    const policy = host.data().storage['notification.policy'] as { reminderSnoozes: unknown[]; handledTransitions: { kind: string; episodeId: string; transitionId: string }[] }
    assert.deepEqual(policy.reminderSnoozes, [])
    assert.ok(policy.handledTransitions.some((entry) => entry.kind === 'reminder' && entry.episodeId === episodeId && entry.transitionId === `needs-you:${since}`))
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('a reminder receipt write rechecks quiet progress before dispatch', async () => {
  listed = null
  let releaseWrite!: () => void
  let writeStarted = false
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
  const host = mockHost({ storage: { prefs: { stuckMinutes: 10 } }, results: {
    'storage.set': async (params: unknown) => {
      if ((params as { key: string }).key === 'notification.policy') {
        writeStarted = true
        await gate
      }
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    const observedAt = Date.now() - 11 * 60_000
    const event = worker.emit('agent.status.changed', {
      workspaceId: '/reminder-progress', paneKey: 'progress-agent', state: 'working', receivedAt: observedAt
    })
    await waitUntil('quiet reminder receipt write', () => writeStarted)
    const progress = worker.emit('agent.status.changed', {
      workspaceId: '/reminder-progress', paneKey: 'progress-agent', state: 'working', receivedAt: Date.now()
    })
    releaseWrite()
    await Promise.all([event, progress])
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(host.callsOf('notifications.show'), [])
  } finally {
    releaseWrite()
    await worker.deactivate()
    listed = null
  }
})

test('a reminder receipt write does not dispatch after notification capability is revoked', async () => {
  listed = null
  let releaseWrite!: () => void
  let writeStarted = false
  let revoked = false
  const originalIncludes = Array.prototype.includes
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
  const host = mockHost({ storage: { prefs: { stuckMinutes: 10 } }, results: {
    'storage.set': async (params: unknown) => {
      if ((params as { key: string }).key === 'notification.policy') {
        writeStarted = true
        await gate
      }
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await worker.emit('agent.status.changed', {
      workspaceId: '/reminder-capability', paneKey: 'capability-agent', state: 'working', receivedAt: Date.now() - 11 * 60_000
    })
    await waitUntil('capability reminder receipt write', () => writeStarted)
    Array.prototype.includes = function (searchElement, fromIndex) {
      if (revoked && searchElement === 'notifications:show') return false
      return originalIncludes.call(this, searchElement, fromIndex)
    }
    revoked = true
    releaseWrite()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(host.callsOf('notifications.show'), [])
  } finally {
    Array.prototype.includes = originalIncludes
    releaseWrite()
    await worker.deactivate()
    listed = null
  }
})

test('a transition write finishing after deactivation cannot dispatch', async () => {
  listed = [{ path: '/notification-stop', agents: [{ paneKey: 'stop-agent', state: 'working', agentType: 'claude' }] }]
  let releaseWrite!: () => void
  let writeStarted = false
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
  const host = mockHost({ results: {
    'storage.set': async (params: unknown) => {
      if ((params as { key: string }).key === 'notification.policy') {
        writeStarted = true
        await gate
      }
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('shutdown transition baseline', async () => (await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'stop-agent'))
    await waitUntil('shutdown notification policy ready', async () => (await worker.request('notification.control.read', { projectId: '/notification-stop' })).status === 'ready')
    await waitUntil('shutdown transition announcement baseline', () => host.callsOf('statusBar.update').length > 0)
    const pending = worker.emit('agent.status.changed', { workspaceId: '/notification-stop', paneKey: 'stop-agent', state: 'blocked', receivedAt: Date.now() })
    await waitUntil('shutdown transition write begins', () => writeStarted)
    const deactivating = worker.deactivate()
    releaseWrite()
    await deactivating
    await pending
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(host.callsOf('notifications.show'), [])
  } finally {
    releaseWrite()
    await worker.deactivate()
    listed = null
  }
})

test('a reminder receipt write finishing after deactivation cannot dispatch', async () => {
  listed = null
  let releaseWrite!: () => void
  let writeStarted = false
  const gate = new Promise<void>((resolve) => { releaseWrite = resolve })
  const host = mockHost({ storage: { prefs: { stuckMinutes: 10 } }, results: {
    'storage.set': async (params: unknown) => {
      if ((params as { key: string }).key === 'notification.policy') {
        writeStarted = true
        await gate
      }
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    const pending = worker.emit('agent.status.changed', {
      workspaceId: '/reminder-stop', paneKey: 'reminder-stop-agent', state: 'working', receivedAt: Date.now() - 11 * 60_000
    })
    await waitUntil('shutdown reminder receipt write', () => writeStarted)
    const deactivating = worker.deactivate()
    releaseWrite()
    await deactivating
    await pending
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(host.callsOf('notifications.show'), [])
  } finally {
    releaseWrite()
    await worker.deactivate()
    listed = null
  }
})

test('clears local history without changing agents or unread', async () => {
  listed = [{ path: '/w', agents: [{ paneKey: 'chat', state: 'done', activity: { unread: true } }] }]
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    // The panel never gets the history; it lives in the stored state.
    const stored = (): OfficeSnapshot | undefined => host.data().storage.office as OfficeSnapshot | undefined
    await waitUntil('initial journal observation', async () => (stored()?.journal.length ?? 0) > 0)
    assert.deepEqual((await worker.request('office.snapshot')).journal, [])
    assert.deepEqual(await worker.request('office.clearHistory'), { cleared: true })
    const office = await worker.request('office.snapshot')
    assert.deepEqual(office.journal, [])
    assert.equal(office.agents[0].unread, true)
    assert.deepEqual((host.data().storage.office as OfficeSnapshot).journal, [])
  } finally {
    try {
      await worker.deactivate()
    } finally {
      listed = null
    }
  }
})

test('reports a failed history save without breaking the live office', async () => {
  const host = mockHost({ results: { 'storage.set': () => { throw new Error('disk full') } } })
  const worker = await mountWorker(main, { host })
  try {
    await worker.emit('agent.status.changed', {
      workspaceId: 'w', paneKey: 'p', terminalId: 't', state: 'working', receivedAt: Date.now()
    })
    assert.deepEqual(await worker.request('office.clearHistory'), { cleared: false })
    const office = await worker.request('office.snapshot')
    assert.deepEqual(office.journal, [])
    assert.equal(office.agents[0].state, 'working')
  } finally {
    await worker.deactivate()
  }
})

test('persists concurrent local reviews once and restores them without changing Orca status or unread', async () => {
  listed = [{ path: '/review', agents: [{ paneKey: 'review-pane', state: 'done', stateStartedAt: 1234, mainAgent: { outcome: 'failure' } }] }]
  const host = mockHost()
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('review completion identity', async () => !!(await worker.request('office.snapshot')).agents[0]?.completionId)
    const before = await worker.request('office.snapshot')
    const completionId = before.agents[0].completionId!
    assert.deepEqual(await worker.request('attention.review', null as never), {
      ok: false, error: 'That completion cannot be reviewed.'
    })
    const results = await Promise.all([
      worker.request('attention.review', { completionId }),
      worker.request('attention.review', { completionId })
    ])
    assert.deepEqual(results, [{ ok: true }, { ok: true }])
    const writes = host.callsOf('storage.set').filter((call) => (call as { key?: string }).key === 'attention.reviewed')
    assert.equal(writes.length, 1)
    const stored = host.data().storage['attention.reviewed'] as { version: number; entries: Record<string, number> }
    assert.equal(stored.version, 1)
    assert.ok(Number.isFinite(stored.entries[completionId]))
    const after = await worker.request('office.snapshot')
    assert.equal(after.agents[0].state, 'done')
    assert.equal(after.agents[0].unread, before.agents[0].unread)
    assert.deepEqual(after.reviewedCompletions, [completionId])
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('review and identity restored', async () => (await worker.request('office.snapshot')).reviewedCompletions?.includes(completionId) === true)
    const restored = await worker.request('office.snapshot')
    assert.equal(restored.agents[0].completionId, completionId)
    assert.deepEqual(restored.reviewedCompletions, [completionId])
  } finally {
    try { await worker.deactivate() } finally { listed = null }
  }
})

test('a failed review write reports an error and leaves the current completion unreviewed', async () => {
  listed = [{ path: '/review', agents: [{ paneKey: 'review-pane', state: 'done', stateStartedAt: 1234, mainAgent: { outcome: 'failure' } }] }]
  const host = mockHost({ results: { 'storage.set': (params: unknown) => {
    if ((params as { key: string }).key === 'attention.reviewed') throw new Error('disk full')
    return { ok: true }
  } } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('review completion identity', async () => !!(await worker.request('office.snapshot')).agents[0]?.completionId)
    const before = await worker.request('office.snapshot')
    const completionId = before.agents[0].completionId!
    assert.deepEqual(await worker.request('attention.review', { completionId: 'invalid' }), {
      ok: false, error: 'That completion cannot be reviewed.'
    })
    assert.deepEqual(await worker.request('attention.review', { completionId: 'a'.repeat(64) }), {
      ok: false, error: 'That completion is no longer current.'
    })
    assert.deepEqual(await worker.request('attention.review', { completionId }), {
      ok: false, error: 'Could not save the review. Try again.'
    })
    const after = await worker.request('office.snapshot')
    assert.deepEqual(after.reviewedCompletions, [])
    assert.equal(after.agents[0].completionId, completionId)
    assert.equal(after.agents[0].state, 'done')
  } finally {
    try { await worker.deactivate() } finally { listed = null }
  }
})

test('commits the identity validated before a pending write and keeps later turns separate', async () => {
  listed = [{ path: '/review', agents: [{ paneKey: 'p', state: 'done', turnId: 'turn-a', stateStartedAt: 10, mainAgent: { outcome: 'failure' } }] }]
  let began!: () => void
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { began = resolve })
  let first = true
  let reviewedStorage: unknown
  let host: ReturnType<typeof mockHost>
  host = mockHost({ results: {
    'storage.get': (params: unknown) => ({ value: (params as { key: string }).key === 'attention.reviewed' ? reviewedStorage ?? null : null }),
    'storage.set': async (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'attention.reviewed' && first) {
        first = false
        began()
        await gate
      }
      if (key === 'attention.reviewed') reviewedStorage = value
      return { ok: true }
    }
  } })
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('event completion before review', async () => !!(await worker.request('office.snapshot')).agents[0]?.completionId)
    const completionId = (await worker.request('office.snapshot')).agents[0].completionId!
    const currentAgent = (await worker.request('office.snapshot')).agents[0]
    assert.equal(currentAgent.outcome, 'failure')
    assert.ok(attentionGroups([currentAgent], new Set()).failedToReview.some((agent) => agent.completionId === completionId))
    const review = worker.request('attention.review', { completionId })
    const beganInTime = await Promise.race([started.then(() => true), review.then(() => false)])
    assert.equal(beganInTime, true, 'review must reach the gated storage write')
    const transition = worker.emit('agent.status.changed', { workspaceId: '/review', paneKey: 'p', state: 'done', receivedAt: 11, mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 11 }, turnId: 'turn-b' } as never)
    release()
    assert.deepEqual(await review, { ok: true })
    await transition
    assert.notEqual((await worker.request('office.snapshot')).agents[0]?.completionId, completionId)
    assert.deepEqual(Object.keys((reviewedStorage as { entries: Record<string, number> }).entries), [completionId])
    listed![0].agents![0].turnId = 'turn-b'
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('restart after pending review commit', async () => (await worker.request('office.snapshot')).agents.length > 0)
    const restarted = await worker.request('office.snapshot')
    assert.deepEqual(restarted.reviewedCompletions, [completionId])
    assert.notEqual(restarted.agents[0].completionId, completionId)
    assert.ok(attentionGroups(restarted.agents, new Set(restarted.reviewedCompletions)).failedToReview.some((agent) => agent.completionId === restarted.agents[0].completionId))
  } finally {
    release()
    await worker.deactivate()
    listed = null
  }
})

test('restores each storage side independently and refuses review when review storage could not load', async () => {
  listed = null
  const now = Date.now()
  const oldOffice = { agents: [{ id: 'old', terminalId: null, paneKey: 'old', state: 'waiting', stateStartedAt: now, firstSeenAt: now, lastSeenAt: now, active: [], recent: [], helpers: [], family: [], history: [] }], workspaces: {} }
  const failedReviewHost = mockHost({ storage: { office: oldOffice }, results: { 'storage.get': (params: unknown) => {
    const { key } = params as { key: string }
    if (key === 'attention.reviewed') throw new Error('unavailable')
    return { value: failedReviewHost.data().storage[key] ?? null }
  } } })
  let worker = await mountWorker(main, { host: failedReviewHost })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(worker.logs.some((message) => message.startsWith('office restore:')), false)
    assert.ok((await worker.request('office.snapshot')).agents.some((agent) => agent.id === 'old'))
    await worker.emit('agent.status.changed', { workspaceId: '/w', paneKey: 'done', state: 'done', receivedAt: 3, mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 3 } })
    const id = (await worker.request('office.snapshot')).agents.find((agent) => agent.id === 'done')?.completionId!
    assert.deepEqual(await worker.request('attention.review', { completionId: id }), { ok: false, error: 'Reviewed storage is unavailable. Try again after restarting Orca.' })
  } finally { await worker.deactivate() }

  const failedOfficeHost = mockHost({ storage: { 'attention.reviewed': { version: 1, entries: { ['a'.repeat(64)]: Date.now() } } }, results: { 'storage.get': (params: unknown) => {
    const { key } = params as { key: string }
    if (key === 'office') throw new Error('unavailable')
    return { value: failedOfficeHost.data().storage[key] ?? null }
  } } })
  worker = await mountWorker(main, { host: failedOfficeHost })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const state = await worker.request('office.snapshot')
    assert.ok(state.reviewedCompletions?.includes('a'.repeat(64)), JSON.stringify({ logs: worker.logs, state, calls: failedOfficeHost.callsOf('storage.get') }))
  } finally { await worker.deactivate() }
})

test('a failed office read blocks automatic and review writes until retry restores identities, then survives restart', async () => {
  listed = [{ path: '/prior', agents: [{ paneKey: 'prior-pane', state: 'done', mainAgent: { outcome: 'failure' } }] }]
  const now = Date.now()
  const prior = createOffice()
  prior.attentionTracking = true
  applyRoster(prior, [{ path: '/prior', agents: [{ paneKey: 'prior-pane', state: 'done', mainAgent: { outcome: 'failure' } }] }], now - 1000)
  const priorSnapshot = snapshot(prior)
  const priorId = priorSnapshot.agents[0].completionId!
  let officeValue: unknown = priorSnapshot
  let reviewValue: unknown = { version: 1, entries: { [priorId]: now } }
  let failOfficeRead = true
  let officeWrites = 0
  const host = mockHost({ storage: { office: priorSnapshot }, results: {
    'storage.get': (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'office' && failOfficeRead) {
        failOfficeRead = false
        throw new Error('temporarily unavailable')
      }
      return { value: key === 'office' ? officeValue : key === 'attention.reviewed' ? reviewValue : null }
    },
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office') {
        officeWrites++
        officeValue = value
      } else if (key === 'attention.reviewed') reviewValue = value
      return { ok: true }
    }
  } })
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('live done roster while the saved office is unreadable', async () => !!(await worker.request('office.snapshot')).agents.find((agent) => agent.paneKey === 'prior-pane')?.completionId)
    const liveId = (await worker.request('office.snapshot')).agents[0].completionId!
    assert.notEqual(liveId, priorId)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(officeWrites, 0)
    assert.deepEqual(await worker.request('attention.review', { completionId: liveId }), {
      ok: false, error: 'Office storage is unavailable. Try again after its saved state is restored.'
    })

    await waitUntil('retry reconciles the saved compatible completion', async () =>
      (await worker.request('office.snapshot')).agents.find((agent) => agent.paneKey === 'prior-pane')?.completionId === priorId)
    assert.deepEqual(Object.keys((reviewValue as { entries: Record<string, number> }).entries), [priorId])
    const reconciled = await worker.request('office.snapshot')
    assert.deepEqual(attentionGroups(reconciled.agents, new Set([priorId])).failedToReview, [])
    assert.deepEqual(attentionGroups(reconciled.agents, new Set([priorId])).finishedToReview, [])
    await waitUntil('automatic office save after recovery', () => officeWrites > 0)
    const saved = officeValue as OfficeSnapshot
    assert.equal(saved.agents.some((agent) => agent.completionId === priorId), true)
    assert.equal(saved.completionIdentities && Object.values(saved.completionIdentities).some((entry) => entry.id === priorId), true)
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('recovered office and reviews after restart', async () => {
      const state = await worker.request('office.snapshot')
      return state.agents.some((agent) => agent.completionId === priorId) && state.reviewedCompletions?.includes(priorId) === true
    })
    const restarted = await worker.request('office.snapshot')
    assert.deepEqual(attentionGroups(restarted.agents, new Set(restarted.reviewedCompletions)).failedToReview, [])
    assert.deepEqual(attentionGroups(restarted.agents, new Set(restarted.reviewedCompletions)).failedToReview, [])
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('retry keeps a completion created by an observed working-to-done transition', async () => {
  const now = Date.now()
  const prior = createOffice()
  prior.attentionTracking = true
  applyRoster(prior, [{ path: '/transition', agents: [{ paneKey: 'transition-pane', state: 'done', mainAgent: { outcome: 'failure' } }] }], now - 1000)
  const priorSnapshot = snapshot(prior)
  const priorId = priorSnapshot.agents[0].completionId!
  let officeValue: unknown = priorSnapshot
  let failOfficeRead = true
  listed = [{ path: '/transition', agents: [{ paneKey: 'transition-pane', state: 'working' }] }]
  const host = mockHost({ storage: { office: priorSnapshot }, results: {
    'storage.get': (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'office' && failOfficeRead) { failOfficeRead = false; throw new Error('temporarily unavailable') }
      return { value: key === 'office' ? officeValue : null }
    },
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office') officeValue = value
      return { ok: true }
    }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('working roster during office read failure', async () => (await worker.request('office.snapshot')).agents[0]?.state === 'working')
    await worker.emit('agent.status.changed', {
      workspaceId: '/transition', paneKey: 'transition-pane', state: 'done', receivedAt: now + 1,
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: now + 1 }, turnId: 'fresh-turn'
    } as never)
    const freshId = (await worker.request('office.snapshot')).agents[0].completionId!
    assert.notEqual(freshId, priorId)
    await waitUntil('office read recovery preserves the observed new turn', async () => {
      const agent = (await worker.request('office.snapshot')).agents[0]
      return agent?.state === 'done' && agent.completionId === freshId
    })
    await waitUntil('recovered new completion is saved', () => officeValue !== priorSnapshot && (officeValue as OfficeSnapshot).agents[0]?.completionId === freshId)
    assert.equal((officeValue as OfficeSnapshot).agents[0].completionId, freshId)
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('retry restores completion history but does not resurrect a row removed by the live roster', async () => {
  const now = Date.now()
  const prior = createOffice()
  prior.attentionTracking = true
  applyRoster(prior, [{ path: '/closed', agents: [{ paneKey: 'closed-pane', state: 'done', stateStartedAt: now, mainAgent: { outcome: 'failure' } }] }], now)
  const priorSnapshot = snapshot(prior)
  const priorId = priorSnapshot.agents[0].completionId!
  let officeValue: unknown = priorSnapshot
  let failOfficeRead = true
  let officeWrites = 0
  listed = []
  const host = mockHost({ storage: { office: priorSnapshot }, results: {
    'storage.get': (params: unknown) => {
      const key = (params as { key: string }).key
      if (key === 'office' && failOfficeRead) { failOfficeRead = false; throw new Error('temporarily unavailable') }
      return { value: key === 'office' ? officeValue : { version: 1, entries: { [priorId]: now } } }
    },
    'storage.set': (params: unknown) => {
      const { key, value } = params as { key: string; value: unknown }
      if (key === 'office') { officeValue = value; officeWrites++ }
      return { ok: true }
    }
  } })
  let worker = await mountWorker(main, { host })
  try {
    await waitUntil('empty authoritative roster before office retry', async () => (await worker.request('office.snapshot')).agents.length === 0)
    await waitUntil('closed row excluded from the recovered office save', () => officeWrites > 0)
    const saved = officeValue as OfficeSnapshot
    assert.deepEqual(saved.agents, [])
    assert.equal(Object.values(saved.completionIdentities ?? {}).some((entry) => entry.id === priorId), true)
    assert.deepEqual(attentionGroups((await worker.request('office.snapshot')).agents, new Set([priorId])).failedToReview, [])
    await worker.deactivate()
    worker = await mountWorker(main, { host })
    await waitUntil('closed row remains absent after restart', async () => (await worker.request('office.snapshot')).agents.length === 0)
    const restarted = await worker.request('office.snapshot')
    assert.equal(Object.values((officeValue as OfficeSnapshot).completionIdentities ?? {}).some((entry) => entry.id === priorId), true)
    assert.deepEqual(attentionGroups(restarted.agents, new Set(restarted.reviewedCompletions)).failedToReview, [])
  } finally {
    await worker.deactivate()
    listed = null
  }
})

test('repairs malformed review storage and keeps a later turn reviewable', async () => {
  listed = [{ path: '/review', hostId: 'local', agents: [{ paneKey: 'review-pane', state: 'done', stateStartedAt: 1234, mainAgent: { outcome: 'failure' } }] }]
  const host = mockHost({ storage: { 'attention.reviewed': { version: 9, entries: { invalid: 'yes' } } } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('review completion and successful roster', async () => {
      const agent = (await worker.request('office.snapshot')).agents[0]
      return !!agent?.completionId && agent.hostId === 'local'
    })
    const original = (await worker.request('office.snapshot')).agents[0]
    assert.deepEqual(await worker.request('attention.review', { completionId: original.completionId! }), { ok: true })
    const saved = host.data().storage['attention.reviewed'] as { version: number; entries: Record<string, number> }
    assert.equal(saved.version, 1)
    assert.deepEqual(Object.keys(saved.entries), [original.completionId])

    const nextTurnAt = Date.now() + 1000
    await worker.emit('agent.status.changed', { workspaceId: '/review', paneKey: 'review-pane', state: 'working', receivedAt: nextTurnAt })
    await waitUntil('later turn starts', async () => (await worker.request('office.snapshot')).agents[0]?.state === 'working')
    assert.equal((await worker.request('office.snapshot')).agents[0].completionId, null)
    await worker.emit('agent.status.changed', {
      workspaceId: '/review', paneKey: 'review-pane', state: 'done', receivedAt: nextTurnAt + 1,
      mainAgent: { state: 'done', stateStartedAt: nextTurnAt + 1 }
    })
    await waitUntil('later turn finishes', async () => (await worker.request('office.snapshot')).agents[0]?.state === 'done')
    const later = (await worker.request('office.snapshot')).agents[0]
    assert.notEqual(later.completionId, original.completionId)
    assert.deepEqual(later.outcome, null)
    assert.deepEqual((await worker.request('office.snapshot')).reviewedCompletions, [original.completionId])
    const groups = attentionGroups([later], new Set([original.completionId!]))
    assert.deepEqual(groups.finishedToReview.map((agent) => agent.completionId), [later.completionId])
  } finally {
    try { await worker.deactivate() } finally { listed = null }
  }
})

test('prunes expired Reviewed keys from worker storage on startup', async () => {
  listed = [{ path: '/review', agents: [{ paneKey: 'review-pane', state: 'done', mainAgent: { outcome: 'failure' } }] }]
  const host = mockHost({ storage: {
    'attention.reviewed': { version: 1, entries: { ['a'.repeat(64)]: Date.now() - 24 * 60 * 60 * 1000 - 1 } }
  } })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('expired review metadata pruned', () => {
      const stored = host.data().storage['attention.reviewed'] as { version?: number; entries?: Record<string, number> } | undefined
      return stored?.version === 1 && Object.keys(stored.entries ?? {}).length === 0
    })
    assert.deepEqual((await worker.request('office.snapshot')).reviewedCompletions, [])
  } finally {
    try { await worker.deactivate() } finally { listed = null }
  }
})

test('acts on an agent only where it has a terminal, and only on request', async () => {
  listed = [
    {
      path: '/w',
      displayName: 'w',
      agents: [
        { paneKey: 'tab1:leaf1', state: 'working', agentType: 'claude' },
        { paneKey: 'tab2:leaf2', state: 'blocked', agentType: 'claude' },
        { paneKey: 'tab3:leaf3', state: 'working', agentType: 'codex' },
        { paneKey: 'structured-agent-session-claude_1:a', state: 'working', agentType: 'claude' }
      ]
    }
  ]
  terminals = [
    { handle: 'term_1', paneKey: 'tab1:leaf1' },
    { handle: 'term_2', paneKey: 'tab2:leaf2' },
    { handle: 'term_3', paneKey: 'tab3:leaf3' }
  ]
  typed.length = switched.length = 0
  const host = mockHost({
    results: {
      'workspace.list': {
        workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'w', path: '/w', branch: 'main', hostId: null }],
        truncated: false
      },
      'workspace.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('roster', async () => (await worker.request('office.snapshot')).agents.length === 4)
    // Nothing is typed or switched just by looking.
    assert.deepEqual(typed.concat(switched), [])

    const chat = 'structured-agent-session-claude_1:a'
    assert.deepEqual(await worker.request('office.actions', { agentId: 'tab1:leaf1' }), { goTo: 'terminal', send: true, compact: '/compact' })
    // A blocked agent is waiting on an answer, so no command is offered; a Codex terminal has none verified.
    assert.deepEqual(await worker.request('office.actions', { agentId: 'tab2:leaf2' }), { goTo: 'terminal', send: true, compact: null })
    assert.deepEqual(await worker.request('office.actions', { agentId: 'tab3:leaf3' }), { goTo: 'terminal', send: true, compact: null })
    assert.deepEqual(await worker.request('office.actions', { agentId: chat }), { goTo: 'workspace', send: false, compact: null })
    assert.deepEqual(await worker.request('office.actions', { agentId: 'nobody' }), { goTo: null, send: false, compact: null })

    assert.deepEqual(await worker.request('office.goTo', { agentId: 'tab1:leaf1' }), { ok: true })
    assert.deepEqual(switched, ['term_1'])
    assert.deepEqual(await worker.request('office.goTo', { agentId: chat }), {
      ok: true,
      note: 'Opened its workspace. Orca does not let plugins pick a chat tab.'
    })
    assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'ws-1' }])

    assert.deepEqual(await worker.request('office.send', { agentId: 'tab1:leaf1', text: '  run the tests ' }), { ok: true })
    assert.deepEqual(await worker.request('office.send', { agentId: 'tab1:leaf1', text: '  ' }), { ok: false, error: 'Type an instruction first.' })
    assert.deepEqual((await worker.request('office.send', { agentId: chat, text: 'hi' })).ok, false)
    assert.deepEqual(await worker.request('office.compact', { agentId: 'tab1:leaf1' }), { ok: true })
    assert.equal((await worker.request('office.compact', { agentId: 'tab2:leaf2' })).ok, false)
    assert.equal((await worker.request('office.compact', { agentId: 'tab3:leaf3' })).ok, false)
    assert.deepEqual(typed, ['term_1: run the tests', 'term_1: /compact'])

    // A second agent that resolves to the same terminal makes typing refused: it might reach the wrong one.
    terminals = [{ handle: 'term_1', paneKey: 'tab1:leaf1' }, { handle: 'term_1', paneKey: 'tab3:leaf3' }]
    assert.deepEqual(await worker.request('office.send', { agentId: 'tab1:leaf1', text: 'shared' }), { ok: false, error: 'Another agent uses the same terminal.' })
    terminals = [{ handle: 'term_1', paneKey: 'tab1:leaf1' }, { handle: 'term_2', paneKey: 'tab2:leaf2' }, { handle: 'term_3', paneKey: 'tab3:leaf3' }]
    // Orca's own list says it finished between the drawer opening and Send: nothing is typed.
    listed![0].agents![0].state = 'done'
    assert.deepEqual(await worker.request('office.send', { agentId: 'tab1:leaf1', text: 'late' }), { ok: false, error: 'Orca no longer shows it at work.' })
    // Once the office has seen it finish, its terminal may be a shell: neither offered nor accepted.
    await waitUntil('finished', async () => (await worker.request('office.snapshot')).agents.find((agent) => agent.id === 'tab1:leaf1')?.state === 'done')
    assert.equal((await worker.request('office.actions', { agentId: 'tab1:leaf1' })).send, false)
    assert.deepEqual(await worker.request('office.send', { agentId: 'tab1:leaf1', text: 'ls' }), { ok: false, error: 'It has finished; its terminal may be back at a shell.' })
    assert.equal((await worker.request('office.compact', { agentId: 'tab1:leaf1' })).ok, false)
    assert.equal(typed.length, 2)
    listed![0].agents![0].state = 'working'
    await waitUntil('working again', async () => (await worker.request('office.snapshot')).agents.find((agent) => agent.id === 'tab1:leaf1')?.state === 'working')

    // Orca closing the terminal in the meantime is reported, not hidden.
    terminals = []
    assert.deepEqual(await worker.request('office.send', { agentId: 'tab1:leaf1', text: 'again' }), {
      ok: false,
      error: 'It does not run in a terminal Orca can type into.'
    })
    assert.equal(typed.length, 2)
  } finally {
    try {
      await worker.deactivate()
    } finally {
      listed = null
      terminals = []
    }
  }
})

test('opens paired agents on their own server without enabling remote typing', async () => {
  const key = (value: string): string => `environment:${JSON.stringify(['paired-server', value])}`
  const pane = key('tab:leaf')
  const chat = key('structured-agent-session-remote:leaf')
  listed = [{ path: key('/repo'), agents: [{ paneKey: pane, state: 'working' }, { paneKey: chat, state: 'working' }] }]
  const original = { terminals: cli.terminals, switchTo: cli.switchTo, activateWorkspace: cli.activateWorkspace }
  const calls: string[][] = []
  cli.terminals = async (server) => server === 'paired-server' ? [{ handle: 'remote-handle', paneKey: 'tab:leaf' }] : []
  cli.switchTo = async (handle, server) => (calls.push([handle, server ?? 'local']), { ok: true })
  cli.activateWorkspace = async (path, server) => (calls.push([path, server]), { ok: true })
  const worker = await mountWorker(main, { host: mockHost() })
  try {
    await waitUntil('paired agents', async () => (await worker.request('office.snapshot')).agents.length === 2)
    assert.deepEqual(await worker.request('office.actions', { agentId: pane }), { goTo: 'terminal', send: false, compact: null })
    assert.deepEqual(await worker.request('office.goTo', { agentId: pane }), { ok: true })
    assert.deepEqual(await worker.request('office.actions', { agentId: chat }), { goTo: 'workspace', send: false, compact: null })
    assert.deepEqual(await worker.request('office.goTo', { agentId: chat }), {
      ok: true,
      note: 'Opened its workspace. Orca does not let plugins pick a chat tab.'
    })
    assert.deepEqual(await worker.request('office.send', { agentId: pane, text: 'do not send' }), {
      ok: false,
      error: 'Sending to paired servers is not supported.'
    })
    assert.deepEqual(calls, [['remote-handle', 'paired-server'], ['/repo', 'paired-server']])
  } finally {
    await worker.deactivate()
    Object.assign(cli, original)
    listed = null
  }
})

test('previous and next agent go needs-you first, then working, round and round', async () => {
  listed = [
    {
      path: '/w',
      displayName: 'w',
      agents: [
        { paneKey: 'tab1:leaf1', state: 'working', agentType: 'claude' },
        { paneKey: 'tab2:leaf2', state: 'blocked', agentType: 'claude' },
        { paneKey: 'tab3:leaf3', state: 'done', agentType: 'claude' }
      ]
    }
  ]
  terminals = [
    { handle: 'term_1', paneKey: 'tab1:leaf1' },
    { handle: 'term_2', paneKey: 'tab2:leaf2' },
    { handle: 'term_3', paneKey: 'tab3:leaf3' }
  ]
  switched.length = 0
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('roster', async () => (await worker.request('office.snapshot')).agents.length === 3)
    await worker.command('office.nextAgent')
    await worker.command('office.nextAgent')
    await worker.command('office.nextAgent')
    await worker.command('office.nextAgent')
    await worker.command('office.previousAgent')
    // Blocked, working, done, blocked again; then one step back lands on the done one.
    assert.deepEqual(switched, ['term_2', 'term_1', 'term_3', 'term_2', 'term_3'])
  } finally {
    try {
      await worker.deactivate()
    } finally {
      listed = null
      terminals = []
    }
  }
})

test('an Orca session store that never answers delays no update, and is asked one at a time', async () => {
  listed = [
    {
      path: '/w',
      displayName: 'w',
      agents: [{ paneKey: 'structured-agent-session-slow-1:leaf', state: 'working', agentType: 'claude' }]
    }
  ]
  const original = sessionStore.lookup
  let asked = 0
  sessionStore.lookup = () => (asked++, new Promise(() => {}))
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    // The agent is in a published update while the store has not answered.
    await waitUntil('the store to be asked', () => asked > 0)
    await waitUntil('an update with the agent, and the status bar', () => {
      const latest = worker.posts.at(-1)?.payload as OfficeSnapshot | undefined
      return latest?.agents.length === 1 && !latest.agents[0].context && host.callsOf('statusBar.update').length > 0
    })
    assert.equal(asked, 1)
    // Another look comes (3 s on); the first read is still out, so no second one starts.
    const looks = host.callsOf('statusBar.update').length
    await worker.emit('agent.status.changed', { workspaceId: 'p::/w', paneKey: 'structured-agent-session-slow-1:leaf', state: 'blocked', receivedAt: Date.now() })
    await waitUntil('the blocked status bar update', () => host.callsOf('statusBar.update').length > looks)
    await new Promise((resolve) => setTimeout(resolve, 3500))
    assert.equal(asked, 1)
  } finally {
    sessionStore.lookup = original
    try {
      await worker.deactivate()
    } finally {
      listed = null
    }
  }
})

test('the shortcuts start from the selected agent and keep one order for a whole walk', async () => {
  listed = [
    {
      path: '/w',
      displayName: 'w',
      agents: [
        { paneKey: 'tab1:leaf1', state: 'working', agentType: 'claude' },
        { paneKey: 'tab2:leaf2', state: 'working', agentType: 'claude' },
        { paneKey: 'tab3:leaf3', state: 'working', agentType: 'claude' }
      ]
    }
  ]
  terminals = [
    { handle: 'term_1', paneKey: 'tab1:leaf1' },
    { handle: 'term_2', paneKey: 'tab2:leaf2' },
    { handle: 'term_3', paneKey: 'tab3:leaf3' }
  ]
  switched.length = 0
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  try {
    await waitUntil('roster', async () => (await worker.request('office.snapshot')).agents.length === 3)
    // The agent open in the panel is where the walk goes on from, though nobody went to it.
    assert.deepEqual(await worker.request('office.select', { agentId: 'tab2:leaf2' }), { ok: true })
    await worker.command('office.nextAgent')
    assert.deepEqual(switched, ['term_3'])

    // Within a walk the order holds, though an agent changes state: a fresh order after tab2 turns
    // blocked would send the walk back to tab1, where it began, and skip tab3.
    await worker.request('office.select', { agentId: 'tab1:leaf1' })
    switched.length = 0
    const status = (paneKey: string, state: 'working' | 'blocked') =>
      worker.emit('agent.status.changed', { workspaceId: 'p::/w', paneKey, state, receivedAt: Date.now() })
    await status('tab3:leaf3', 'blocked')
    await worker.command('office.nextAgent')
    await status('tab3:leaf3', 'working')
    await status('tab2:leaf2', 'blocked')
    await worker.command('office.nextAgent')
    assert.deepEqual(switched, ['term_2', 'term_3'])

    // Picking an agent in the panel ends the walk: the next press orders afresh from there.
    await worker.request('office.select', { agentId: 'tab1:leaf1' })
    switched.length = 0
    await worker.command('office.nextAgent')
    assert.deepEqual(switched, ['term_3'])
    // An agent the office does not know changes nothing.
    await worker.request('office.select', { agentId: 'nobody' })
    switched.length = 0
    await worker.command('office.nextAgent')
    assert.deepEqual(switched, ['term_2'])
  } finally {
    try {
      await worker.deactivate()
    } finally {
      listed = null
      terminals = []
    }
  }
})

test('leaves out agents in a hidden Orca project, and a project.list that fails hides nothing', async () => {
  const row = (id: string, path: string, projectId: string) =>
    ({ id, kind: 'worktree', name: id, path, branch: 'main', hostId: null, projectId })
  const results = (projects: unknown) => ({
    'workspace.list': { workspaces: [row('w1', '/repos/shop', 'p1'), row('w2', '/repos/blog', 'p2')], truncated: false },
    ...(projects ? { 'project.list': projects } : {})
  })
  const run = async (projects: unknown): Promise<string[]> => {
    const worker = await mountWorker(main, { host: mockHost({ results: results(projects) as never }) })
    try {
      for (const [paneKey, path] of [['pane-1', '/repos/shop'], ['pane-2', '/repos/blog']])
        await worker.emit('agent.status.changed', { workspaceId: `x::${path}`, paneKey, terminalId: paneKey, title: paneKey, state: 'working', receivedAt: Date.now() })
      let ids: string[] = []
      await waitUntil('workspaces named', async () => {
        const state = await worker.request('office.snapshot')
        ids = state.agents.map((agent) => agent.id).sort()
        return Object.keys(state.workspaces).length > 0 && (projects === null || ids.length < 2)
      })
      return ids
    } finally {
      await worker.deactivate()
    }
  }
  const hidden = { projects: [{ id: 'p1', name: 'shop', kind: 'git', hostId: 'local', path: '/repos/shop', hidden: true }, { id: 'p2', name: 'blog', kind: 'git', hostId: 'local', path: '/repos/blog' }], truncated: false }
  assert.deepEqual(await run(hidden), ['pane-2'])
  assert.deepEqual(await run(null), ['pane-1', 'pane-2'])
})
