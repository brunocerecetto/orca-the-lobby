import { assert, test } from 'orca/testing'
import { hasCoordinator, orchestrationFacts, parseInbox, parseWorkers, type InboxRow } from './orchestration'

const row = (id: string, over: Partial<InboxRow> = {}): InboxRow =>
  ({ id, type: 'status', to_handle: 'run:r1', run_id: 'r1', created_at: null, thread_id: null, read: 1, sender_pane_key: 'w-pane', from_handle: null, payload: null, ...over })
const agents = [
  { id: 'boss', paneKey: 'b-pane', parentId: null },
  { id: 'worker', paneKey: 'w-pane', parentId: 'boss' }
]

test('an unanswered question marks its sender', () => {
  const facts = orchestrationFacts([row('q1', { type: 'question', to_handle: 'run:r1' })], agents)
  assert.equal(facts.get('worker')?.pendingQuestion, true)
  assert.equal(facts.get('boss')?.pendingQuestion, undefined)
})

test('a question with a reply in its thread is not pending', () => {
  const facts = orchestrationFacts([row('q1', { type: 'question' }), row('m2', { thread_id: 'q1', sender_pane_key: 'b-pane' })], agents)
  assert.equal(facts.get('worker')?.pendingQuestion, undefined)
})

test('unread mail to a run counts against the sender\'s parent', () => {
  const facts = orchestrationFacts([
    row('a', { read: 0 }), row('b', { read: 0, type: 'worker_done' }), row('c', { read: 1 }),
    row('d', { read: 0, to_handle: 'dispatch:x' })
  ], agents)
  assert.equal(facts.get('boss')?.unreadMail, 2)
  assert.equal(facts.get('worker')?.unreadMail, undefined)
})

test('senders that are not listed, or have no parent, count for nobody; no rows means no facts', () => {
  const rows = [row('a', { read: 0, sender_pane_key: 'ghost' }), row('b', { read: 0, sender_pane_key: 'b-pane' })]
  assert.equal(orchestrationFacts(rows, agents).size, 0)
  assert.equal(orchestrationFacts(null, agents).size, 0)
})

test('mail from a worker without a parent goes to the coordinator that dispatched its run', () => {
  const orphans = [{ id: 'boss', paneKey: 'b-pane', parentId: null }, { id: 'worker', paneKey: 'w-pane', parentId: null }]
  const dispatch = row('d', { to_handle: 'dispatch:ctx', sender_pane_key: 'b-pane', run_id: 'r1' })
  const facts = orchestrationFacts([row('a', { read: 0 }), row('b', { read: 0, run_id: 'other' }), dispatch], orphans)
  assert.equal(facts.get('boss')?.unreadMail, 1)
  assert.equal(orchestrationFacts([row('a', { read: 0 })], orphans).size, 0)
})

test('the parent wins over the dispatching coordinator', () => {
  const dispatch = row('d', { to_handle: 'dispatch:ctx', sender_pane_key: 'x-pane' })
  const withOther = [...agents, { id: 'other', paneKey: 'x-pane', parentId: null }]
  const facts = orchestrationFacts([row('a', { read: 0 }), dispatch], withOther)
  assert.equal(facts.get('boss')?.unreadMail, 1)
  assert.equal(facts.get('other'), undefined)
})

test('the facts carry when the newest unread mail and unanswered question arrived', () => {
  const facts = orchestrationFacts([
    row('a', { read: 0, created_at: 5000 }), row('b', { read: 0, created_at: 9000 }), row('c', { read: 1, created_at: 20000 }),
    row('q', { type: 'question', created_at: 7000 })
  ], agents)
  assert.equal(facts.get('boss')?.mailSince, 9000)
  assert.equal(facts.get('worker')?.questionSince, 7000)
})

test('hasCoordinator sees a parent or a family child among the listed agents', () => {
  assert.equal(hasCoordinator(agents), true)
  assert.equal(hasCoordinator([{ id: 'a', paneKey: 'p', parentId: null }, { id: 'b', paneKey: 'q', parentId: 'gone' }]), false)
  assert.equal(hasCoordinator([{ id: 'a', paneKey: 'p', parentId: null, family: [{ kind: 'agent', id: 'b' } as never] }, { id: 'b', paneKey: 'q', parentId: null }]), true)
})

test('parseInbox reads result.messages and refuses anything else', () => {
  const ok = JSON.stringify({ ok: true, result: { messages: [{ id: 'm', type: 'question', to_handle: 'run:r', run_id: 'r', created_at: '2026-11-27T18:44:28Z', thread_id: null, read: 0, sender_pane_key: 'p', extra: 1 }] } })
  assert.equal(parseInbox(ok)?.[0].id, 'm')
  assert.equal(parseInbox(ok)?.[0].created_at, Date.parse('2026-11-27T18:44:28Z'))
  assert.equal(parseInbox('not json'), null)
  assert.equal(parseInbox(null), null)
  assert.equal(parseInbox(JSON.stringify({ ok: false, result: { messages: [] } })), null)
  assert.equal(parseInbox(JSON.stringify({ ok: true, result: {} })), null)
})

const realQuestion = row('msg_2ab40a4d3d4e', {
  type: 'question', from_handle: 'dispatch:ctx_0595dfee792f', to_handle: 'run:run_a3a445a10c4e', run_id: 'run_a3a445a10c4e',
  thread_id: 'msg_2ab40a4d3d4e', sender_pane_key: null,
  payload: '{"taskId":"task_ee8edd1c795b","dispatchId":"ctx_0595dfee792f","question":"?"}'
})
const realReply = row('msg_70b94baf5bc1', {
  type: 'status', from_handle: 'run:run_a3a445a10c4e', to_handle: 'dispatch:ctx_0595dfee792f', run_id: 'run_a3a445a10c4e',
  thread_id: 'msg_2ab40a4d3d4e', sender_pane_key: null
})
const workerAgents = [
  { id: 'boss', paneKey: 'b-pane', parentId: null },
  { id: 'worker', paneKey: '4ec47959:6943cd08', parentId: null, terminalId: null }
]
const links = {
  workers: [{ dispatchId: 'ctx_0595dfee792f', terminal: 'term_0503c162' }],
  terminals: [{ handle: 'term_0503c162', paneKey: '4ec47959:6943cd08' }]
}

test('a question whose thread_id is its own id is pending until another row answers it', () => {
  assert.equal(orchestrationFacts([realQuestion], workerAgents, links).get('worker')?.pendingQuestion, true)
  assert.equal(orchestrationFacts([realQuestion, realReply], workerAgents, links).get('worker')?.pendingQuestion, undefined)
})

test('a question sent from a dispatch resolves to the worker through the worker list', () => {
  assert.equal(orchestrationFacts([realQuestion], workerAgents, links).get('worker')?.pendingQuestion, true)
  assert.equal(orchestrationFacts([realQuestion], workerAgents, { ...links, workers: [] }).size, 0)
  assert.equal(orchestrationFacts([realQuestion], workerAgents).size, 0)
})

test('mail from a worker terminal resolves by its handle', () => {
  const done = row('msg_73d4f9eb9d3e', { type: 'worker_done', from_handle: 'term_0503c162', read: 0, sender_pane_key: null })
  const orphans = [{ id: 'boss', paneKey: 'b-pane', parentId: null }, { id: 'worker', paneKey: '4ec47959:6943cd08', parentId: 'boss' }]
  assert.equal(orchestrationFacts([done], orphans, links).get('boss')?.unreadMail, 1)
  const direct = [orphans[0], { ...orphans[1], paneKey: 'other', terminalId: 'term_0503c162' }]
  assert.equal(orchestrationFacts([done], direct, { workers: [], terminals: [{ handle: 'term_0503c162', paneKey: 'x' }] }).get('boss')?.unreadMail, 1)
})

test('a reply from the run is not a coordinator pane; the pane key still names the coordinator', () => {
  const unread = row('a', { read: 0, run_id: 'run_a3a445a10c4e', from_handle: 'term_0503c162', sender_pane_key: null })
  const orphans = [{ id: 'boss', paneKey: 'b-pane', parentId: null }, { id: 'worker', paneKey: '4ec47959:6943cd08', parentId: null }]
  assert.equal(orchestrationFacts([unread, realReply], orphans, links).size, 0)
  const sent = { ...realReply, sender_pane_key: 'b-pane', from_handle: 'term_boss' }
  assert.equal(orchestrationFacts([unread, sent], orphans, links).get('boss')?.unreadMail, 1)
})

test('parseWorkers reads dispatchId and terminal, and refuses anything else', () => {
  const ok = JSON.stringify({ result: { workers: [{ dispatchId: 'd', terminal: 't', x: 1 }, { dispatchId: 'e' }, null] } })
  assert.deepEqual(parseWorkers(ok), [{ dispatchId: 'd', terminal: 't' }])
  for (const bad of [null, 'nope', '{}']) assert.equal(parseWorkers(bad), null)
})
