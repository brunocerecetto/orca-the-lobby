import { assert, test } from 'orca/testing'
import { hasCoordinator, orchestrationFacts, parseInbox, type InboxRow } from './orchestration'

const row = (id: string, over: Partial<InboxRow> = {}): InboxRow =>
  ({ id, type: 'status', to_handle: 'run:r1', run_id: 'r1', created_at: null, thread_id: null, read: 1, sender_pane_key: 'w-pane', ...over })
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
