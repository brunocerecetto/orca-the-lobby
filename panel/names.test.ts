import { assert, test } from 'orca/testing'
import type { AgentView } from '../src/protocol'
import { assignAgentNames, BOSS_NAME, coordinatorIds, readAgentNames } from './names'

test('keeps friendly names stable regardless of snapshot order', () => {
  const first = assignAgentNames(['agent-1', 'agent-2', 'agent-3'])
  const refreshed = assignAgentNames(['agent-3', 'agent-1', 'agent-2'])
  assert.deepEqual([...first], [...refreshed])
})

test('gives visible agents distinct friendly names', () => {
  const names = [...assignAgentNames(Array.from({ length: 50 }, (_, index) => `worker-${index}`)).values()]
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.every((name) => /^\p{Lu}\p{L}*( \p{Lu}\p{L}*)*$/u.test(name)))
})

test('a colliding arrival before existing IDs does not rename them', () => {
  const existingIds = Array.from({ length: 40 }, (_, index) => `worker-${index}`)
  const before = assignAgentNames(existingIds)
  const after = assignAgentNames(['000-new', ...existingIds], before)
  for (const id of existingIds) assert.equal(after.get(id), before.get(id))
  assert.ok(after.get('000-new'))
})

test('survivors keep persisted names while departed names are released', () => {
  const ids = Array.from({ length: 40 }, (_, index) => `worker-${index}`)
  const first = assignAgentNames(ids)
  const survivors = ids.slice(1)
  const afterDeparture = assignAgentNames(survivors, first)
  const restarted = assignAgentNames(ids, readAgentNames(Object.fromEntries(afterDeparture)))
  for (const id of survivors) assert.equal(afterDeparture.get(id), first.get(id))
  assert.equal(afterDeparture.has(ids[0]), false)
  for (const id of survivors) assert.equal(restarted.get(id), first.get(id))
})

test('reuses names across many generations without accumulating numeric suffixes', () => {
  let names = new Map<string, string>()
  for (let generation = 0; generation < 20; generation++) {
    const ids = Array.from({ length: 50 }, (_, index) => `${generation}:${index}`)
    names = assignAgentNames(ids, names)
    assert.equal(names.size, 50)
    assert.equal(new Set(names.values()).size, 50)
    assert.ok([...names.values()].every((name) => !/\d/.test(name)))
  }
})

const agentOf = (id: string, parentId: string | null = null, family: { id: string }[] = []): AgentView =>
  ({ id, parentId, family: family.map((child) => ({ ...child, kind: 'agent' })) }) as unknown as AgentView

test('a coordinator is a listed agent another listed agent reports as its parent, or lists as an agent child', () => {
  const agents = [
    agentOf('boss-a'),
    agentOf('worker-a', 'boss-a'),
    agentOf('boss-b', null, [{ id: 'worker-b' }]),
    agentOf('worker-b'),
    agentOf('lonely', null, [{ id: 'not-listed' }]),
    agentOf('orphan', 'gone')
  ]
  assert.deepEqual([...coordinatorIds(agents)].sort(), ['boss-a', 'boss-b'])
})

test('every coordinator is MR.Boss and takes no slot from the friendly names', () => {
  const ids = ['boss-a', 'boss-b', 'worker-1', 'worker-2']
  const names = assignAgentNames(ids, new Map(), new Set(['boss-a', 'boss-b']))
  assert.equal(names.get('boss-a'), BOSS_NAME)
  assert.equal(names.get('boss-b'), BOSS_NAME)
  assert.equal(BOSS_NAME, 'MR.Boss')
  assert.notEqual(names.get('worker-1'), BOSS_NAME)
  assert.deepEqual([...assignAgentNames(['worker-1', 'worker-2'])].filter(([id]) => id.startsWith('w')), [...names].filter(([id]) => id.startsWith('w')))
})

test('a stored MR.Boss for an agent that stopped coordinating gets a regular name', () => {
  const names = assignAgentNames(['ex-boss'], new Map([['ex-boss', BOSS_NAME]]))
  assert.notEqual(names.get('ex-boss'), BOSS_NAME)
  assert.ok(names.get('ex-boss'))
})

test('past the 50 names the suffix keeps names with spaces distinct and stable', () => {
  const ids = Array.from({ length: 53 }, (_, index) => `worker-${index}`)
  const first = assignAgentNames(ids)
  assert.equal(new Set(first.values()).size, 53)
  assert.ok([...first.values()].some((name) => /^\D+ \d+$/.test(name)))
  const again = assignAgentNames(ids, readAgentNames(Object.fromEntries(first)))
  assert.deepEqual([...again], [...first])
})
