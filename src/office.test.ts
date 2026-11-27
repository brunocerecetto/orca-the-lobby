// `orca plugin test .` runs this in Node: the office model is plain data, no host needed.
import { assert, test } from 'orca/testing'
import {
  applyListed,
  applyRepos,
  applyRoster,
  applyStatus,
  applyToolAfter,
  applyToolBefore,
  classify,
  clearHistory,
  createOffice,
  describe,
  keepTerminals,
  jsonBytes,
  placeWorkspace,
  projectRoot,
  prune,
  restore,
  snapshot,
  startAttentionTracking,
  storable,
  forPanel,
  hiddenView,
  STORE_BYTES
} from './office'
import { readPrefs, workspaceContext } from './protocol'
import { attentionGroups } from './attention'
import { createRoster, parseShortstat } from './roster'
import { assign, digest, emptyDigest } from './transcript'

const status = (state: 'working' | 'blocked' | 'waiting' | 'done', receivedAt: number) => ({
  workspaceId: 'w1',
  paneKey: 'pane-1',
  terminalId: 't1',
  title: 'Fix login',
  state,
  receivedAt
})
const call = (tool: string, input: object, callId?: string) => ({
  agent: 'claude',
  workspaceId: 'w1',
  terminalId: 't1',
  tool,
  input: input as never,
  callId
})

test('labels paired environments and keeps identically named panes and paths distinct', async () => {
  const worktrees = [{ path: '/repo', repoId: 'repo', repo: 'Lobby', branch: 'main', agents: [{ paneKey: 'pane', state: 'done' }] }]
  let paired = true
  let reachable = true
  let local = true
  const roster = createRoster(async (args) => {
    if (args[0] === 'host') return JSON.stringify({ result: { hosts: paired ? [{ kind: 'environment', id: 'server', name: 'devbox' }] : [] } })
    if (args.includes('--environment') ? !reachable : !local) return null
    return JSON.stringify({ result: { worktrees } })
  })
  const rows = await roster()
  const office = createOffice()
  applyRoster(office, rows ?? [], Date.now())
  assert.equal(office.agents.size, 2)
  assert.equal(office.roots.size, 2)
  assert.equal(office.projects.get(rows![1].repoId!), 'Lobby · devbox')
  assert.equal(office.agents.get(rows![1].agents![0].paneKey)?.hostId, 'server')
  assert.equal(office.agents.get(rows![1].agents![0].paneKey)?.hostName, 'devbox')
  assert.equal(office.agents.get(rows![0].agents![0].paneKey)?.branch, 'main')
  assert.notEqual(office.agents.get(rows![0].agents![0].paneKey)?.completionId, office.agents.get(rows![1].agents![0].paneKey)?.completionId)
  const remoteCompletion = office.agents.get(rows![1].agents![0].paneKey)?.completionId
  reachable = false
  const disconnected = await roster()
  assert.deepEqual(disconnected, rows?.slice(0, 1))
  applyRoster(office, disconnected ?? [], Date.now())
  assert.equal(office.agents.size, 1)
  reachable = true
  const reconnected = await roster()
  assert.deepEqual(reconnected, rows)
  applyRoster(office, reconnected ?? [], Date.now())
  assert.equal(office.agents.get(rows![1].agents![0].paneKey)?.completionId, remoteCompletion)
  paired = false
  assert.deepEqual((await roster())?.[0].repo, 'Lobby · local')
  local = false
  assert.equal(await roster(), null)
  assert.equal(office.agents.size, 2)
})

test('projects explicit workspace context and omits labels without reported metadata', () => {
  const agent = {
    id: 'environment:["host-a","pane"]',
    terminalId: null,
    paneKey: 'environment:["host-a","pane"]',
    parentPaneKey: null,
    parentId: null,
    workspaceId: 'environment:["host-a","/repo"]',
    projectId: 'environment:["host-a","repo"]',
    title: null,
    prompt: null,
    reply: null,
    agent: null,
    state: 'working' as const,
    outcome: null,
    unread: false,
    stateStartedAt: 1,
    finishedAt: null,
    firstSeenAt: 1,
    lastSeenAt: 1,
    active: [],
    recent: [],
    toolCount: 0,
    helpers: [],
    family: [],
    insight: null,
    history: [],
    branch: 'feature/login',
    hostId: 'host-a',
    hostName: 'Dev server',
    sessionId: null,
    completionId: null,
    completionTracked: false
  }
  const snapshot = {
    agents: [agent], journal: [], workspaces: { [agent.workspaceId]: 'checkout' },
    projects: { [agent.projectId]: 'Shop' }, changes: {}, links: {}, can: { open: false },
    today: { day: '', finished: 0, failed: 0, blockedMs: 0 }
  }
  assert.deepEqual(workspaceContext(agent, snapshot), {
    project: 'Shop', workspace: 'checkout', branch: 'feature/login', host: 'Dev server'
  })
  assert.deepEqual(workspaceContext({ ...agent, branch: null, hostId: null, hostName: null, projectId: null, workspaceId: null }, snapshot), {
    project: null, workspace: null, branch: null, host: null
  })
  assert.equal(workspaceContext({ ...agent, hostName: null }, snapshot).host, 'host-a')
})

test('completion identity survives event, roster, restart and a late source timestamp', () => {
  const office = createOffice()
  office.attentionTracking = true
  applyStatus(office, status('working', 1000))
  applyStatus(office, status('done', 2000))
  const first = snapshot(office).agents[0].completionId
  assert.ok(first)
  assert.equal(snapshot(office).agents[0].finishedAt, 2000)
  assert.equal(snapshot(office).agents[0].finishedAtSource, 'observed')
  applyRoster(office, [{ path: '/w1', agents: [{ paneKey: 'pane-1', state: 'done', lastAssistantMessage: 'same reply' }] }], 3000)
  assert.equal(snapshot(office).agents[0].completionId, first)
  applyRoster(office, [{ path: '/w1', agents: [{ paneKey: 'pane-1', state: 'done', lastAssistantMessage: 'same reply' }] }], 4000)
  assert.equal(snapshot(office).agents[0].completionId, first)

  const restarted = createOffice()
  restore(restarted, JSON.parse(JSON.stringify(snapshot(office))), 5000)
  applyRoster(restarted, [{ path: '/w1', agents: [{ paneKey: 'pane-1', state: 'done', stateStartedAt: 1500 }] }], 6000)
  assert.equal(snapshot(restarted).agents[0].completionId, first)
  assert.equal(snapshot(restarted).agents[0].finishedAt, 1500)
  assert.equal(snapshot(restarted).agents[0].finishedAtSource, 'source')

  applyStatus(restarted, status('working', 7000))
  applyStatus(restarted, status('done', 8000))
  assert.notEqual(snapshot(restarted).agents[0].completionId, first)
})

test('completion identity keeps compatible late evidence after reconnect but changes for a known new turn', () => {
  const office = createOffice()
  office.attentionTracking = true
  applyRoster(office, [{ path: '/w', agents: [{ paneKey: 'p', state: 'done' }] }], 1000)
  const first = snapshot(office).agents[0].completionId
  const restarted = createOffice()
  restore(restarted, JSON.parse(JSON.stringify(snapshot(office))), 1100)
  applyRoster(restarted, [], 1200)
  applyRoster(restarted, [{ path: '/w', agents: [{ paneKey: 'p', state: 'done', stateStartedAt: 999, turnId: 'turn-a' }] }], 1300)
  assert.equal(snapshot(restarted).agents[0].completionId, first)
  applyRoster(restarted, [{ path: '/w', agents: [{ paneKey: 'p', state: 'done', stateStartedAt: 999, turnId: 'turn-b' }] }], 1400)
  assert.notEqual(snapshot(restarted).agents[0].completionId, first)
})

test('an observed working turn gets a fresh event completion when its first evidence arrives, including after restart', () => {
  const office = createOffice()
  office.attentionTracking = true
  applyStatus(office, status('done', 1000))
  const reviewedId = snapshot(office).agents[0].completionId
  applyStatus(office, status('working', 2000))
  const restarted = createOffice()
  restore(restarted, JSON.parse(JSON.stringify(snapshot(office))), 2100)
  restarted.attentionTracking = true
  applyStatus(restarted, {
    ...status('done', 3000),
    mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 2500 },
    turnId: 'first-reported-turn'
  } as never)
  const completed = snapshot(restarted).agents[0]
  assert.notEqual(completed.completionId, reviewedId)
  assert.equal(completed.completionTracked, true)
})

test('an observed working turn gets a fresh roster completion when its first evidence arrives, including after restart', () => {
  const office = createOffice()
  office.attentionTracking = true
  const roster = (state: 'working' | 'done', evidence: { stateStartedAt?: number; turnId?: string } = {}) =>
    [{ path: '/w', agents: [{ paneKey: 'p', state, ...evidence }] }]
  applyRoster(office, roster('done'), 1000)
  const reviewedId = snapshot(office).agents[0].completionId
  applyRoster(office, roster('working'), 2000)
  const restarted = createOffice()
  restore(restarted, JSON.parse(JSON.stringify(snapshot(office))), 2100)
  restarted.attentionTracking = true
  applyRoster(restarted, roster('done', { stateStartedAt: 2500, turnId: 'first-reported-turn' }), 3000)
  const completed = snapshot(restarted).agents[0]
  assert.notEqual(completed.completionId, reviewedId)
  assert.equal(completed.completionTracked, true)
})

test('a retry after an authoritative roster keeps history but does not restore roster-absent agents', () => {
  const storedOffice = createOffice()
  applyRoster(storedOffice, [{ path: '/w', agents: [{ paneKey: 'gone', state: 'done', stateStartedAt: 1000 }] }], 1000)
  const stored = JSON.parse(JSON.stringify(snapshot(storedOffice)))
  const completionId = snapshot(storedOffice).agents[0].completionId
  const live = createOffice()
  applyRoster(live, [], 1100)
  live.rostered = false // A later CLI failure must not erase that the roster was once authoritative.
  restore(live, stored, 1200, true, true)
  assert.deepEqual(snapshot(live).agents, [])
  assert.ok(Object.values(snapshot(live).completionIdentities ?? {}).some((entry) => entry.id === completionId))
})

test('captures a roster transition time once when Orca omits its completion time', () => {
  const office = createOffice()
  applyRoster(office, [{ path: '/w', agents: [{ paneKey: 'pane', state: 'working' }] }], 1000)
  applyRoster(office, [{ path: '/w', agents: [{ paneKey: 'pane', state: 'done' }] }], 2000)
  const agent = snapshot(office).agents[0]
  assert.equal(agent.finishedAt, 2000)
  assert.ok(agent.completionId)
  applyRoster(office, [{ path: '/w', agents: [{ paneKey: 'pane', state: 'done' }] }], 3000)
  assert.equal(snapshot(office).agents[0].completionId, agent.completionId)
})

test('baselines old done work once and reuses an ambiguous completion identity on reconnect', () => {
  const office = createOffice()
  applyRoster(office, [{ path: 'environment:["server","/w"]', hostId: 'server', agents: [{ paneKey: 'environment:["server","pane"]', state: 'done', sessionId: 'session-1' }] }], 1000)
  startAttentionTracking(office, 1000)
  const first = snapshot(office).agents[0]
  assert.ok(first.completionId)
  assert.equal(first.completionTracked, false)
  const trackedOffice = createOffice()
  trackedOffice.attentionTracking = true
  applyStatus(trackedOffice, status('working', 1100))
  applyStatus(trackedOffice, status('done', 1200))
  startAttentionTracking(trackedOffice, 1300)
  assert.equal(snapshot(trackedOffice).agents[0].completionTracked, true)
  const stored = JSON.parse(JSON.stringify(snapshot(office)))
  applyRoster(office, [], 2000)
  const restarted = createOffice()
  restore(restarted, stored, 2500)
  restarted.attentionTracking = true
  applyRoster(restarted, [], 2600)
  applyRoster(restarted, [{ path: 'environment:["server","/w"]', hostId: 'server', agents: [{ paneKey: 'environment:["server","pane"]', state: 'done', sessionId: 'session-1' }] }], 3000)
  assert.equal(snapshot(restarted).agents[0].completionId, first.completionId)
  assert.equal(snapshot(restarted).agents[0].completionTracked, false)

  applyRoster(restarted, [{ path: 'environment:["server","/w"]', hostId: 'server', agents: [{ paneKey: 'environment:["server","pane"]', state: 'done', sessionId: 'session-2' }] }], 4000)
  assert.notEqual(snapshot(restarted).agents[0].completionId, first.completionId)
})

test('bounds reconnect identity metadata and omits it from panel payloads', () => {
  const office = createOffice()
  for (let i = 0; i < 600; i++) {
    applyRoster(office, [{ path: '/w', hostId: 'local', agents: [{ paneKey: `pane-${i}`, state: 'done' }] }], i + 1)
  }
  const stored = snapshot(office)
  assert.equal(Object.keys(stored.completionIdentities ?? {}).length, 500)
  assert.equal(forPanel(stored).completionIdentities, undefined)
  const restored = createOffice()
  restore(restored, stored, 24 * 60 * 60 * 1000 + 601)
  assert.deepEqual(snapshot(restored).completionIdentities, {})
})

test('retains bounded disconnected notification episodes without storing rows or oversizing UTF-8 data', () => {
  const office = createOffice()
  const now = 10_000
  const longUnicode = '🧪'.repeat(100)
  const agents = Array.from({ length: 510 }, (_, index) => ({
    paneKey: `episode-${index}`,
    state: 'blocked' as const,
    sessionId: longUnicode,
    turnId: longUnicode
  }))
  applyRoster(office, [{ path: '/episodes', hostId: 'local', agents }], now)
  applyRoster(office, [{ path: '/episodes', hostId: 'local', agents: [] }], now + 1)
  clearHistory(office)

  const stored = storable(snapshot(office))
  assert.equal(stored.agents.length, 0)
  const retainedEpisodes = Object.keys(stored.notificationEpisodes ?? {}).length
  assert.ok(retainedEpisodes > 0 && retainedEpisodes <= 500)
  assert.ok(jsonBytes(stored) <= STORE_BYTES)
  assert.equal(forPanel(stored).notificationEpisodes, undefined)

  const restored = createOffice()
  restore(restored, JSON.parse(JSON.stringify(stored)), now + 2)
  applyRoster(restored, [{ path: '/episodes', agents: [] }], now + 3)
  assert.equal(snapshot(restored).agents.length, 0)
  assert.equal(Object.keys(snapshot(restored).notificationEpisodes ?? {}).length, retainedEpisodes)

  applyRoster(restored, [{ path: '/episodes', agents: [] }], now + 24 * 60 * 60 * 1000 + 1)
  assert.deepEqual(snapshot(restored).notificationEpisodes, {})
})

test('sorts tools into what the character does', () => {
  const kinds = {
    Edit: 'edit',
    Write: 'edit',
    apply_patch: 'edit',
    Read: 'read',
    Grep: 'search',
    Glob: 'search',
    Bash: 'shell',
    exec_command: 'shell',
    WebSearch: 'web',
    WebFetch: 'web',
    Agent: 'delegate',
    Task: 'delegate',
    TodoWrite: 'plan',
    TaskCreate: 'plan',
    Skill: 'tool'
  }
  for (const [tool, kind] of Object.entries(kinds)) assert.equal(classify(tool), kind, tool)
})

test('labels a call from its input', () => {
  assert.equal(describe({ file_path: '/repo/src/office.ts' }), 'office.ts')
  assert.equal(describe({ command: 'npm test\nmore', description: 'Run tests' }), 'Run tests')
  assert.equal(describe({ command: 'npm test\nmore' }), 'npm test')
  assert.equal(describe({ pattern: 'TODO', path: '/repo' }), 'TODO')
  assert.equal(describe({ url: 'https://example.com/a/b' }), 'example.com')
  assert.equal(describe({ command: 'x'.repeat(200) }).length, 80)
  assert.equal(describe('not an object'), '')
  assert.equal(describe(null), '')
})

test('follows an agent through a turn', () => {
  const office = createOffice()
  applyStatus(office, status('working', 1000))
  applyToolBefore(office, call('Edit', { file_path: '/repo/a.ts' }, 'c1'), 1100)

  let [agent] = snapshot(office).agents
  assert.equal(agent.id, 't1')
  assert.equal(agent.agent, 'claude')
  assert.equal(agent.title, 'Fix login')
  assert.deepEqual(
    agent.active.map((activity) => [activity.kind, activity.detail]),
    [['edit', 'a.ts']]
  )

  applyToolAfter(office, call('Edit', { file_path: '/repo/a.ts' }, 'c1'), 1200)
  ;[agent] = snapshot(office).agents
  assert.deepEqual(agent.active, [])
  assert.equal(agent.recent[0].endedAt, 1200)
  assert.equal(agent.toolCount, 1)

  // A call still open when the turn ends is closed with it.
  applyToolBefore(office, call('Bash', { command: 'sleep 9' }), 1300)
  applyStatus(office, {
    ...status('done', 1400),
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1350 }
  })
  ;[agent] = snapshot(office).agents
  assert.equal(agent.state, 'done')
  assert.equal(agent.outcome, 'failure')
  assert.equal(agent.stateStartedAt, 1400)
  assert.equal(agent.finishedAt, 1350)
  assert.deepEqual(agent.active, [])
  assert.equal(agent.recent[0].tool, 'Bash')
})

test('does not invent a finish time when the roster omits its timestamp', () => {
  const office = createOffice()
  applyRoster(
    office,
    [{ path: '/w', agents: [{ paneKey: 'finished', state: 'done' }] }],
    1234
  )
  assert.equal(snapshot(office).agents[0].finishedAt, null)

  const transitioned = createOffice()
  applyRoster(transitioned, [{ path: '/w', agents: [{ paneKey: 'agent', state: 'working' }] }], 1000)
  applyRoster(transitioned, [{ path: '/w', agents: [{ paneKey: 'agent', state: 'done' }] }], 1600)
  assert.equal(snapshot(transitioned).agents[0].finishedAt, 1600)
  assert.equal(snapshot(transitioned).agents[0].finishedAtSource, 'observed')

  const reported = createOffice()
  applyRoster(reported, [{ path: '/w', agents: [{ paneKey: 'agent', state: 'working' }] }], 1000)
  applyRoster(reported, [{ path: '/w', agents: [{ paneKey: 'agent', state: 'done', stateStartedAt: 1400 }] }], 1600)
  assert.equal(snapshot(reported).agents[0].finishedAt, 1400)
  assert.equal(snapshot(reported).agents[0].finishedAtSource, 'source')
})

test('does not treat first observation of an already finished agent as a finish transition', () => {
  const office = createOffice()
  applyStatus(office, status('done', 1234))
  assert.equal(snapshot(office).agents[0].finishedAt, null)

  const reported = createOffice()
  applyStatus(reported, {
    ...status('done', 1234),
    mainAgent: { state: 'done', stateStartedAt: 1200 }
  })
  assert.equal(snapshot(reported).agents[0].finishedAt, 1200)
})

test('keeps reported helper state truthful, separates commands, and expires missing history', () => {
  const office = createOffice()
  const row = (children: NonNullable<Parameters<typeof applyRoster>[1][number]['agents']>[number]['children']) =>
    [{ path: '/w', agents: [{ paneKey: 'parent', state: 'working' as const, children }] }]
  const child = { id: 'child-1', kind: 'agent', state: 'working', name: 'Scout', description: 'Read callers' }
  const command = { id: 'cmd-1', kind: 'command', state: 'working', description: 'Run tests' }

  applyRoster(office, row([child, command]), 1000)
  let parent = snapshot(office).agents[0]
  assert.deepEqual(parent.family.map(({ id, kind, state, reported }) => [id, kind, state, reported]), [
    ['child-1', 'agent', 'working', true]
  ])
  assert.deepEqual(parent.helpers.map(({ id, kind }) => [id, kind]), [['child-1', 'agent'], ['cmd-1', 'command']])

  applyRoster(office, row([]), 2000)
  parent = snapshot(office).agents[0]
  assert.deepEqual(
    [parent.family[0].state, parent.family[0].reported, parent.family[0].missingSince],
    ['working', false, 2000]
  )
  applyRoster(office, row([]), 2000 + 10 * 60 * 1000)
  assert.deepEqual(snapshot(office).agents[0].family, [])
})

test('keeps reported done children stable and expires them only after disappearance', () => {
  const office = createOffice()
  const row = (children: NonNullable<Parameters<typeof applyRoster>[1][number]['agents']>[number]['children']) =>
    [{ path: '/w', agents: [{ paneKey: 'parent', state: 'working' as const, children }] }]
  applyRoster(office, row([{ id: 'done-child', kind: 'agent', state: 'done', name: 'Scout' }]), 1000)
  let child = snapshot(office).agents[0].family[0]
  assert.equal(child.state, 'done')
  assert.equal(child.reported, true)
  assert.equal('outcome' in child, false)
  applyRoster(office, row([{ id: 'done-child', kind: 'agent', state: 'done', name: 'Scout' }]), 5000)
  applyRoster(office, row([{ id: 'done-child', kind: 'agent', state: 'done', name: 'Scout' }]), 601_000)
  child = snapshot(office).agents[0].family[0]
  assert.equal(child.state, 'done')
  assert.equal(child.reported, true)
  applyRoster(office, row([]), 602_000)
  child = snapshot(office).agents[0].family[0]
  assert.equal(child.state, 'done')
  assert.equal(child.reported, false)
  assert.equal(child.missingSince, 602_000)
  applyRoster(office, row([]), 1_201_999)
  assert.equal(snapshot(office).agents[0].family[0].reported, false)
  applyRoster(office, row([]), 1_202_000)
  assert.deepEqual(snapshot(office).agents[0].family, [])
})

test('keeps unknown child identities and states explicit', () => {
  const office = createOffice()
  applyRoster(office, [{ path: '/w', agents: [{
    paneKey: 'parent', state: 'working', children: [{ kind: 'agent', state: 'paused', description: 'Unrecognized state' }]
  }] }], 1000)
  const [child] = snapshot(office).agents[0].family
  assert.equal(child.id, '')
  assert.equal(child.state, 'unknown')
  assert.equal(child.reported, true)
  assert.equal(child.name, 'Unidentified agent')
})

test('keeps parallel calls apart and records a call it never saw start', () => {
  const office = createOffice()
  applyToolBefore(office, call('Agent', { description: 'Explore' }, 'a'), 1)
  applyToolBefore(office, call('Agent', { description: 'Review' }, 'b'), 2)
  applyToolAfter(office, call('Agent', { description: 'Explore' }, 'a'), 3)
  applyToolAfter(office, call('Read', { file_path: 'x.md' }), 4)

  const [agent] = snapshot(office).agents
  assert.deepEqual(
    agent.active.map((activity) => activity.detail),
    ['Review']
  )
  assert.deepEqual(
    agent.recent.map((activity) => activity.detail),
    ['x.md', 'Explore']
  )
})

test('gives a call with no terminal to the only agent in its workspace', () => {
  const office = createOffice()
  applyStatus(office, status('working', 1))
  applyToolBefore(office, { ...call('Bash', { command: 'ls' }), terminalId: undefined }, 2)
  assert.equal(snapshot(office).agents[0].active.length, 1)

  applyStatus(office, { ...status('working', 3), paneKey: 'pane-2', terminalId: 't2' })
  applyToolBefore(office, { ...call('Bash', { command: 'ls' }), terminalId: undefined }, 4)
  assert.equal(snapshot(office).agents[0].active.length, 1)
  assert.equal(snapshot(office).agents[1].active.length, 0)
})

test('lists, closes and forgets agents', () => {
  const office = createOffice()
  applyListed(
    office,
    'w1',
    [
      { terminalId: 't1', title: 'One', agent: 'codex', state: 'waiting', stateStartedAt: 5 },
      { terminalId: 't2', title: 'Two', agent: 'claude', state: 'working', stateStartedAt: 6 },
      { terminalId: null, title: null, agent: null, state: 'done', stateStartedAt: 7 }
    ],
    10
  )
  assert.deepEqual(
    snapshot(office).agents.map((agent) => [agent.id, agent.agent, agent.state]),
    [
      ['t1', 'codex', 'waiting'],
      ['t2', 'claude', 'working']
    ]
  )

  keepTerminals(office, 'w1', ['t2'])
  assert.deepEqual(
    snapshot(office).agents.map((agent) => agent.id),
    ['t2']
  )

  // Working agents stay however long they are quiet; idle ones go home.
  const day = 24 * 60 * 60 * 1000
  prune(office, day)
  assert.equal(snapshot(office).agents.length, 1)
  applyStatus(office, { ...status('done', 20), terminalId: 't2', paneKey: 'pane-2' })
  prune(office, day)
  assert.equal(snapshot(office).agents.length, 0)
})

test('puts the worktrees of one checkout in one project', () => {
  const linked = 'gitdir: /repos/folio/.git/worktrees/bridge-hardening\n'
  assert.equal(projectRoot('/work/folio/bridge-hardening', linked), '/repos/folio')
  assert.equal(projectRoot('/repos/folio', null), '/repos/folio')
  assert.equal(projectRoot('/tmp/notes', 'gitdir: ../elsewhere/.git/modules/notes'), '/tmp/notes')

  const office = createOffice()
  applyStatus(office, { ...status('working', 1), workspaceId: '/work/folio/bridge-hardening' })
  assert.equal(snapshot(office).agents[0].projectId, null)
  placeWorkspace(office, '/work/folio/bridge-hardening', '/repos/folio')
  assert.equal(snapshot(office).agents[0].projectId, '/repos/folio')
  assert.deepEqual(snapshot(office).projects, { '/repos/folio': 'folio' })
})

test('restores a stored office without its running calls', () => {
  const office = createOffice()
  applyStatus(office, status('working', 1000))
  applyToolBefore(office, call('Bash', { command: 'ls' }), 1100)
  const stored = JSON.parse(JSON.stringify(snapshot(office)))

  const next = createOffice()
  restore(next, stored, 2000)
  assert.equal(snapshot(next).agents[0].id, 't1')
  assert.deepEqual(snapshot(next).agents[0].active, [])
  restore(next, 'garbage', 2000)
  restore(next, null, 2000)
  assert.equal(snapshot(next).agents.length, 1)
})

test('restores older finish timestamps without claiming Orca reported them', () => {
  const office = createOffice()
  applyStatus(office, status('done', 1000))
  const stored = JSON.parse(JSON.stringify(snapshot(office))) as any
  stored.agents[0].finishedAt = 900
  delete stored.agents[0].finishedAtSource
  const restored = createOffice()
  restore(restored, stored, 2000)
  assert.equal(snapshot(restored).agents[0].finishedAtSource, 'unknown')
})

test('restoring and snapshotting strips legacy guessed token counts and model', () => {
  const office = createOffice()
  applyStatus(office, status('working', 1000))
  const stored = JSON.parse(JSON.stringify(snapshot(office))) as any
  stored.agents[0].insight = {
    model: 'guessed-model',
    contextTokens: 154321,
    contextWindowTokens: 200000,
    todos: [{ text: 'Keep this note', status: 'in_progress' }],
    files: ['actual.ts']
  }

  const restored = createOffice()
  restore(restored, stored, 2000)
  assert.deepEqual(snapshot(restored).agents[0].insight, {
    model: null,
    todos: [{ text: 'Keep this note', status: 'in_progress' }],
    files: ['actual.ts']
  })
})

test('follows a chat from one listed call to the next', () => {
  const office = createOffice()
  const row = (toolName: string | null, toolInput: string | null) => [
    { path: '/w', agents: [{ paneKey: 'chat', state: 'working' as const, toolName, toolInput }] }
  ]
  applyRoster(office, row('Read', 'a.ts'), 10)
  applyRoster(office, row('Read', 'a.ts'), 20)
  assert.equal(snapshot(office).agents[0].active[0].startedAt, 10)
  applyRoster(office, row('Bash', 'npm test\nmore'), 30)
  applyRoster(office, row(null, null), 40)

  const [agent] = snapshot(office).agents
  assert.deepEqual(agent.active, [])
  assert.deepEqual(
    agent.recent.map((call) => [call.tool, call.detail, call.endedAt]),
    [
      ['Bash', 'npm test', 40],
      ['Read', 'a.ts', 30]
    ]
  )
  assert.equal(agent.toolCount, 2)

  // Gone from the list, gone from the office.
  applyRoster(office, [], 50)
  assert.deepEqual(snapshot(office).agents, [])
})

test('reads a transcript line by line', () => {
  const into = emptyDigest()
  const say = (record: object): void => digest(into, JSON.stringify(record))
  const turn = (content: object[], usage: object, extra: object = {}) =>
    say({ type: 'assistant', message: { model: 'claude-x', usage, content }, ...extra })

  say({ type: 'ai-title', aiTitle: 'Fix series sort' })
  say({ type: 'last-prompt', lastPrompt: 'ok lets start' })
  turn(
    [
      { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/a.ts' } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/b.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/src/a.ts' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/repo/README.md' } },
      {
        type: 'tool_use',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Find the bug', status: 'completed' },
            { content: 'Fix it', status: 'in_progress' },
            { content: 'Test', status: 'odd' },
            { nothing: true }
          ]
        }
      }
    ],
    { input_tokens: 10, cache_read_input_tokens: 9000, cache_creation_input_tokens: 990 },
    { timestamp: '2026-11-11T08:30:00.000Z' }
  )
  // A subagent's turn, and a line that is not JSON, change nothing.
  turn([], { input_tokens: 5 }, { isSidechain: true })
  digest(into, '{"type":"assistant","mess')

  assert.deepEqual(into, {
    model: null,
    todos: [
      { text: 'Find the bug', status: 'completed' },
      { text: 'Fix it', status: 'in_progress' },
      { text: 'Test', status: 'pending' }
    ],
    files: ['a.ts', 'b.ts'],
    title: 'Fix series sort',
    lastPrompt: 'ok lets start'
  })
})

test('tells whose transcript is whose', () => {
  const named = { ...emptyDigest(), title: 'Fix series sort' }
  const asked = { ...emptyDigest(), lastPrompt: 'turn the  bridge on\nplease' }
  const other = { ...emptyDigest(), title: 'Something else' }
  const agents = [
    { id: 'a', title: 'Fix series sort', prompt: 'x' },
    { id: 'b', title: 'Renamed since', prompt: 'turn the bridge on please' },
    { id: 'c', title: 'No transcript', prompt: 'nothing like it' }
  ]
  const mine = assign(agents, [other, asked, named])
  assert.equal(mine.get('a'), named)
  assert.equal(mine.get('b'), asked)
  assert.equal(mine.has('c'), false)

  // A workspace's only agent gets its newest transcript, whatever it is called.
  assert.equal(assign([agents[2]], [other, named]).get('c'), other)
  assert.equal(assign([agents[2]], []).has('c'), false)
})

test('counts what git says changed', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 120 insertions(+), 30 deletions(-)\n'), {
    files: 3,
    added: 120,
    removed: 30
  })
  assert.deepEqual(parseShortstat(' 1 file changed, 1 deletion(-)'), {
    files: 1,
    added: 0,
    removed: 1
  })
  assert.deepEqual(parseShortstat(''), { files: 0, added: 0, removed: 0 })
})

test("keeps each agent's history and the day's tally", () => {
  const office = createOffice()
  const noon = new Date(2026, 0, 5, 12).getTime()
  const minute = 60_000
  const at = (state: 'working' | 'blocked' | 'done', minutes: number, outcome?: 'failure') => ({
    ...status(state, noon + minutes * minute),
    mainAgent: { state, outcome, stateStartedAt: noon + minutes * minute }
  })
  applyStatus(office, at('working', 0))
  applyStatus(office, at('working', 1))
  applyStatus(office, at('blocked', 2))
  applyStatus(office, at('working', 5))
  applyStatus(office, at('done', 9, 'failure'))

  const [agent] = snapshot(office).agents
  assert.deepEqual(
    agent.history.map((step) => [step.state, (step.at - noon) / minute]),
    [
      ['working', 0],
      ['blocked', 2],
      ['working', 5],
      ['done', 9]
    ]
  )
  assert.deepEqual(snapshot(office).today, {
    day: new Date(noon).toDateString(),
    finished: 1,
    failed: 1,
    blockedMs: 3 * minute
  })

  // An agent first seen already finished did not finish on our watch.
  applyStatus(office, { ...at('done', 10), paneKey: 'late', terminalId: 'late' })
  assert.equal(snapshot(office).today.finished, 1)

  // A new day starts a new tally, and steps older than two hours drop out of the history.
  applyStatus(office, at('working', 24 * 60))
  assert.deepEqual(snapshot(office).today.finished, 0)
  assert.deepEqual(
    snapshot(office).agents[0].history.map((step) => step.state),
    ['working']
  )
})

test('reads preferences, keeping the default for anything odd', () => {
  assert.deepEqual(readPrefs(null), { notifyBlocked: true, notifyDone: true, animate: true, palette: 'orca', layout: 'list', density: 'comfortable', selectedView: 'office', stuckMinutes: 20, projectOrder: [] })
  assert.deepEqual(readPrefs({ notifyBlocked: false, animate: 'no', extra: 1 }), {
    notifyBlocked: false,
    notifyDone: true,
    animate: true,
    palette: 'orca',
    layout: 'list',
    density: 'comfortable',
    selectedView: 'office',
    stuckMinutes: 20,
    projectOrder: []
  })
  assert.deepEqual(readPrefs({ palette: 'dracula', animate: false, layout: 'grid' }), {
    notifyBlocked: true,
    notifyDone: true,
    animate: false,
    palette: 'dracula',
    layout: 'grid',
    density: 'comfortable',
    selectedView: 'office',
    stuckMinutes: 20,
    projectOrder: []
  })
  assert.deepEqual(readPrefs({ palette: 'unknown-theme', layout: 'tiles', stuckMinutes: 7 }), {
    notifyBlocked: true,
    notifyDone: true,
    animate: true,
    palette: 'orca',
    layout: 'list',
    density: 'comfortable',
    selectedView: 'office',
    stuckMinutes: 20,
    projectOrder: []
  })
})

test('new installs default to Attention while old 1.2 preferences keep Office', () => {
  assert.equal(readPrefs(null, 'attention').selectedView, 'attention')
  assert.equal(readPrefs(null, 'office').selectedView, 'office')
  assert.equal(readPrefs({ notifyBlocked: true, layout: 'grid', projectOrder: ['/work'], palette: 'dracula' }).selectedView, 'office')
  assert.equal(readPrefs({ notifyBlocked: true, selectedView: 'activity', density: 'compact' }).selectedView, 'activity')
  assert.equal(readPrefs({ notifyBlocked: true, selectedView: 'settings' }).selectedView, 'office')
  assert.equal(readPrefs({ density: 'compact' }).density, 'compact')
})

test('keeps a stored project order of strings only', () => {
  assert.deepEqual(readPrefs({ projectOrder: ['b', 3, 'a'] }).projectOrder, ['b', 'a'])
  assert.deepEqual(readPrefs({ projectOrder: 'b' }).projectOrder, [])
})

test("places each project where Orca's sidebar lists it, by repo id and by path", () => {
  const office = createOffice()
  applyRepos(office, [{ id: 'r1', path: '/one' }, { id: 'r2', path: '/two' }, { path: 7 }])
  assert.deepEqual(snapshot(office).sidebar, { r1: 0, '/one': 0, r2: 1, '/two': 1 })
  assert.equal(snapshot(createOffice()).sidebar, undefined)
})

test('journals observed roster changes once across polls and restart', () => {
  const office = createOffice()
  const row = { paneKey: 'chat', state: 'done' as const, stateStartedAt: 900, lastAssistantMessage: 'result' }
  applyRoster(office, [{ path: '/w', repoId: 'p', agents: [row] }], 1000)
  applyRoster(office, [{ path: '/w', repoId: 'p', agents: [row] }], 1100)
  let events = snapshot(office).journal
  assert.deepEqual(events.map((event) => event.kind).sort(), ['observed', 'result'])
  const first = events.find((event) => event.kind === 'observed')
  assert.equal(first?.observedAt, 1000)
  assert.equal(first?.sourceAt, 900)
  const restarted = createOffice()
  restore(restarted, JSON.parse(JSON.stringify(snapshot(office))), 1200)
  applyRoster(restarted, [{ path: '/w', repoId: 'p', agents: [row] }], 1300)
  assert.equal(snapshot(restarted).journal.length, 2)
  applyRoster(restarted, [{ path: '/w', repoId: 'p', agents: [] }], 1400)
  events = snapshot(restarted).journal
  assert.equal(events.at(-1)?.kind, 'disappeared')
  assert.equal(events.some((event) => event.kind === 'state'), false)
})

test('journals transitions and tool milestones without prompt transcripts', () => {
  const office = createOffice()
  applyStatus(office, status('working', 1000))
  applyToolBefore(office, call('Edit', { file_path: '/repo/a.ts' }, 'c1'), 1100)
  applyToolAfter(office, call('Edit', { file_path: '/repo/a.ts' }, 'c1'), 1200)
  applyToolAfter(office, call('Edit', { file_path: '/repo/a.ts' }, 'c1'), 1250)
  applyStatus(office, { ...status('done', 1400), mainAgent: { state: 'done', stateStartedAt: 1350 } })
  const events = snapshot(office).journal
  assert.deepEqual(events.map((event) => event.kind), ['observed', 'tool', 'state'])
  assert.equal(events.at(-1)?.sourceAt, 1350)
  assert.equal(events.at(-1)?.observedAt, 1400)
  assert.equal(JSON.stringify(events).includes('prompt'), false)
})

test('prunes journal deterministically to 24 hours and 5000 entries', () => {
  const office = createOffice()
  for (let i = 0; i < 5002; i++) {
    applyStatus(office, { ...status(i % 2 ? 'waiting' : 'working', 100000000 + i), paneKey: 'pane-1' })
  }
  assert.equal(snapshot(office).journal.length, 5000)
  office.rostered = true
  prune(office, 100000000 + 5001 + 24 * 60 * 60 * 1000)
  assert.equal(snapshot(office).journal.length, 0)
})

test('does not duplicate sampled tools across restart and clips result excerpts', () => {
  const office = createOffice()
  const row = { paneKey: 'chat', state: 'working' as const, toolName: 'Read', toolInput: 'file', lastAssistantMessage: 'x'.repeat(800), prompt: 'private prompt' }
  applyRoster(office, [{ path: '/w', agents: [row] }], 1000)
  const restarted = createOffice()
  restore(restarted, JSON.parse(JSON.stringify(snapshot(office))), 1100)
  applyRoster(restarted, [{ path: '/w', agents: [row] }], 1200)
  const events = snapshot(restarted).journal
  assert.equal(events.filter((event) => event.kind === 'tool').length, 1)
  assert.equal(events.find((event) => event.kind === 'result')?.result?.length, 400)
  assert.equal(JSON.stringify(events).includes('private prompt'), false)
})

test('resolves parentPaneKey to the one listed agent with that paneKey across worktrees', () => {
  const office = createOffice()
  applyRoster(office, [
    { path: '/w1', agents: [{ paneKey: 'parent', state: 'done' }, { paneKey: 'self', parentPaneKey: 'self', state: 'working' }] },
    { path: '/w2', agents: [
      { paneKey: 'child', parentPaneKey: 'parent', state: 'working' },
      { paneKey: 'orphan', parentPaneKey: 'gone', state: 'working' },
      { paneKey: 'blank', parentPaneKey: '', state: 'working' },
      { paneKey: 'typed', parentPaneKey: 7 as unknown as string, state: 'working' },
      { paneKey: 'plain', state: 'working' }
    ] }
  ], 1000)
  const byPane = Object.fromEntries(snapshot(office).agents.map((agent) => [agent.paneKey, agent]))
  assert.equal(byPane.child.parentId, byPane.parent.id)
  assert.equal(byPane.child.parentPaneKey, 'parent')
  assert.deepEqual([byPane.self.parentId, byPane.self.parentPaneKey], [null, 'self'])
  assert.deepEqual([byPane.orphan.parentId, byPane.orphan.parentPaneKey], [null, 'gone'])
  for (const key of ['parent', 'blank', 'typed', 'plain']) assert.deepEqual([byPane[key].parentId, byPane[key].parentPaneKey], [null, null])
})

test('drops a parent link when the parent leaves the roster or the link is no longer reported', () => {
  const office = createOffice()
  const roster = (agents: NonNullable<Parameters<typeof applyRoster>[1][number]['agents']>) => [{ path: '/w', agents }]
  const parent = { paneKey: 'parent', state: 'working' as const }
  applyRoster(office, roster([parent, { paneKey: 'child', parentPaneKey: 'parent', state: 'working' }]), 1000)
  assert.notEqual(snapshot(office).agents.find((agent) => agent.paneKey === 'child')?.parentId, null)
  applyRoster(office, roster([{ paneKey: 'child', parentPaneKey: 'parent', state: 'working' }]), 2000)
  const [child] = snapshot(office).agents
  assert.deepEqual([child.parentId, child.parentPaneKey], [null, 'parent'])
  applyRoster(office, roster([parent, { paneKey: 'child', state: 'working' }]), 3000)
  assert.deepEqual(snapshot(office).agents.map((agent) => [agent.paneKey, agent.parentId, agent.parentPaneKey]).sort(), [['child', null, null], ['parent', null, null]])
})

test('a full day of history is trimmed to fit Orca\'s storage limit, oldest first, and never sent to the panel', () => {
  const office = createOffice()
  const state = snapshot(office)
  const journal = Array.from({ length: 5000 }, (_, index) => ({
    id: `event-${index}`, agentId: 'a', workspaceId: '/w', projectId: '/w', kind: 'result' as const, source: 'hook' as const,
    observedAt: index, coverage: 'event' as const, result: 'x'.repeat(400)
  }))
  const big = { ...state, journal }
  assert.ok(JSON.stringify(big).length > 256 * 1024)
  const kept = storable(big)
  assert.ok(JSON.stringify(kept).length <= STORE_BYTES)
  assert.ok(kept.journal.length > 0)
  assert.equal(kept.journal[kept.journal.length - 1].id, 'event-4999')
  assert.equal(storable(state), state)
  assert.deepEqual(forPanel(big).journal, [])
})

test('bounds complete JSON payloads by UTF-8 bytes, including live rows and review markers', () => {
  const office = createOffice()
  const parentPaneKey = `parent-${'P'.repeat(32)}`
  const rows = Array.from({ length: 500 }, (_, i) => ({
    paneKey: i === 0 ? parentPaneKey : `p-${i}-${'I'.repeat(32)}`,
    ...(i === 1 ? { parentPaneKey } : {}),
    state: 'done' as const, stateStartedAt: i + 1
  }))
  const initialRows = rows.map((row, i) => i === 1 ? { ...row, state: 'working' as const } : row)
  applyRoster(office, [{ path: '/repo', agents: initialRows }], 1000)
  applyRoster(office, [{ path: '/repo', agents: rows.map((row, i) => i === 1 ? { ...row, stateStartedAt: undefined } : row) }], 1001)
  const original = snapshot(office)
  applyRoster(office, [{ path: '/repo', agents: rows.slice(0, 200).map((row, i) => i === 1 ? { ...row, stateStartedAt: undefined } : row) }], 1002)
  for (const agent of office.agents.values()) {
    agent.prompt = '💩'.repeat(10_000)
    agent.completionTracked = true
  }
  const huge = snapshot(office)
  const parent = huge.agents.find((agent) => agent.paneKey === parentPaneKey)!
  const child = huge.agents.find((agent) => agent.paneKey === rows[1].paneKey)!
  assert.equal(child.parentId, parent.id)
  const reviewKeys = original.agents.map((agent) => agent.completionId!).sort()
  const panel = forPanel({ ...huge, reviewedCompletions: reviewKeys })
  const kept = storable(huge)
  const bytes = new TextEncoder().encode(JSON.stringify(kept)).byteLength
  const panelBytes = new TextEncoder().encode(JSON.stringify(panel)).byteLength
  assert.ok(bytes <= STORE_BYTES)
  assert.ok(panelBytes <= STORE_BYTES)
  assert.equal(kept.agents.length, 200)
  assert.equal(kept.agents[0].finishedAtSource, 'source')
  assert.equal(kept.agents[1].finishedAtSource, 'observed')
  assert.equal(panel.agents.length, 200)
  assert.equal(panel.reviewedCompletions?.length, 500)
  assert.deepEqual(panel.reviewedCompletions, reviewKeys.slice().sort())
  assert.equal(kept.completionIdentities && Object.keys(kept.completionIdentities).length, 500)
  assert.equal(panel.agents[0].id.length, original.agents[0].id.length)
  const keptChild = kept.agents.find((agent) => agent.paneKey === rows[1].paneKey)!
  assert.equal(keptChild.parentPaneKey, parentPaneKey)
  assert.equal(keptChild.parentId, parent.id)
  const restored = createOffice()
  restore(restored, JSON.parse(JSON.stringify(kept)), 1002)
  assert.equal(snapshot(restored).agents[0].finishedAtSource, 'source')
  assert.equal(snapshot(restored).agents[1].finishedAtSource, 'observed')
  const restoredBeforeRoster = snapshot(restored).agents.find((agent) => agent.paneKey === rows[1].paneKey)!
  assert.equal(restoredBeforeRoster.parentPaneKey, parentPaneKey)
  assert.equal(restoredBeforeRoster.parentId, parent.id)
  applyRoster(restored, [{ path: '/repo', agents: rows.slice(0, 200).map((row, i) => i === 1 ? { ...row, stateStartedAt: undefined } : row) }], 1002)
  const restoredChild = snapshot(restored).agents.find((agent) => agent.paneKey === rows[1].paneKey)!
  assert.equal(restoredChild.parentPaneKey, parentPaneKey)
  assert.equal(restoredChild.parentId, parent.id)
  assert.deepEqual(snapshot(restored).agents.map((agent) => agent.completionId), kept.agents.map((agent) => agent.completionId))
  assert.deepEqual(attentionGroups(snapshot(restored).agents, new Set(reviewKeys)), { needsInput: [], failedToReview: [], finishedToReview: [] })
  const restoredAgent = restored.agents.values().next().value!
  assert.ok(restoredAgent.prompt === null || (typeof restoredAgent.prompt === 'string' && restoredAgent.prompt.length <= 2000))
  assert.equal(restoredAgent.state, 'done')
  assert.equal(restoredAgent.completionTracked, true)
})

test('refuses a payload that cannot fit without changing required identity keys', () => {
  const office = createOffice()
  applyStatus(office, status('working', 1))
  const state = snapshot(office)
  const agent = state.agents[0]
  const impossible = { ...state, agents: Array.from({ length: 2 }, (_, i) => ({ ...agent, id: `required-${i}-${'x'.repeat(100)}`, paneKey: `pane-${i}-${'y'.repeat(100)}` })) }
  assert.throws(() => storable(impossible, 50), /cannot fit.*without trimming identity data/i)
})

test('the panel leaves out hidden workspaces, their agents and rooms with nothing visible left', () => {
  const office = createOffice()
  const listed = (terminalId: string) => ({ terminalId, title: terminalId, agent: 'claude', state: 'working' as const, stateStartedAt: 1 })
  applyListed(office, '/a/one', [listed('t1')], 10)
  applyListed(office, '/a/two', [listed('t2')], 10)
  applyListed(office, '/b/one', [listed('t3')], 10)
  placeWorkspace(office, '/a/one', '/a')
  placeWorkspace(office, '/a/two', '/a')
  placeWorkspace(office, '/b/one', '/b')
  for (const path of ['/a/one', '/a/two', '/b/one']) office.workspaces.set(path, path)
  office.hidden = new Set(['/a/one', '/b/one'])
  const panel = forPanel(snapshot(office), [], hiddenView(office))
  assert.deepEqual(panel.agents.map((agent) => agent.id), ['t2'])
  assert.deepEqual(Object.keys(panel.workspaces), ['/a/two'])
  assert.deepEqual(Object.keys(panel.projects), ['/a'])
  assert.equal(forPanel(snapshot(office)).agents.length, 3)
})

test('hidden workspaces are never stored', () => {
  const office = createOffice()
  office.hidden = new Set(['/a/one'])
  assert.ok(!JSON.stringify(storable(snapshot(office))).includes('/a/one'))
})

test('orchestration facts reach the panel but are never stored', () => {
  const office = createOffice()
  applyRoster(office, [{ path: '/a/one', agents: [{ paneKey: 'p1', state: 'working' }] }], 1000)
  const id = snapshot(office).agents[0].id
  office.orchestration.set(id, { pendingQuestion: true, unreadMail: 2 })
  const live = snapshot(office)
  assert.equal(forPanel(live).agents[0].pendingQuestion, true)
  assert.equal(forPanel(live).agents[0].unreadMail, 2)
  const stored = storable(live).agents[0]
  assert.ok(!('pendingQuestion' in stored) && !('unreadMail' in stored))
})
