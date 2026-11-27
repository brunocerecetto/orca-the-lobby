import { assert, test } from 'orca/testing'
import { orchestrationFacts, parseInbox, type InboxRow } from './orchestration'

const row = (id: string, over: Partial<InboxRow> = {}): InboxRow =>
  ({ id, type: 'status', to_handle: 'run:r1', thread_id: null, read: 1, sender_pane_key: 'w-pane', ...over })
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

test('senders that are not listed, or have no parent, count for nobody', () => {
  const rows = [row('a', { read: 0, sender_pane_key: 'ghost' }), row('b', { read: 0, sender_pane_key: 'b-pane' })]
  assert.equal(orchestrationFacts(rows, agents).size, 0)
})

test('no rows means no facts', () => {
  assert.equal(orchestrationFacts(null, agents).size, 0)
})

test('parseInbox reads result.messages and refuses anything else', () => {
  const ok = JSON.stringify({ ok: true, result: { messages: [{ id: 'm', type: 'question', to_handle: 'run:r', thread_id: null, read: 0, sender_pane_key: 'p', extra: 1 }] } })
  assert.equal(parseInbox(ok)?.[0].id, 'm')
  assert.equal(parseInbox('not json'), null)
  assert.equal(parseInbox(null), null)
  assert.equal(parseInbox(JSON.stringify({ ok: false, result: { messages: [] } })), null)
  assert.equal(parseInbox(JSON.stringify({ ok: true, result: {} })), null)
})
