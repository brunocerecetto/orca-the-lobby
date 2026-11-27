// `orca plugin test .` runs this in Node: the office's layout is plain arithmetic, no canvas.
import { assert, test } from 'orca/testing'
import type { AgentView, OfficeSnapshot } from '../src/protocol'
import { BOSS_NAME, assignAgentNames } from './names'
import {
  BUBBLE_MS,
  bubbleFor,
  bubbleHeight,
  decorationsFor,
  doorBox,
  draw,
  palette,
  fitText,
  layout,
  lookOf,
  observedActivity,
  periodOfHour,
  pickBubble,
  placeBubbles,
  replyLine,
  step,
  wallFurniture,
  type Actor,
  type Bubble
} from './scene'

const agent = (id: string, state: AgentView['state'], unread = false): AgentView => ({
  id,
  terminalId: null,
  paneKey: id,
  parentPaneKey: null,
  parentId: null,
  workspaceId: '/w',
  projectId: 'p',
  branch: null,
  hostId: null,
  hostName: null,
  sessionId: null,
  completionId: null,
  completionTracked: false,
  title: id,
  prompt: null,
  reply: null,
  agent: 'claude',
  state,
  outcome: null,
  unread,
  stateStartedAt: 0,
  finishedAt: state === 'done' ? 0 : null,
  firstSeenAt: 0,
  lastSeenAt: 0,
  active: [],
  recent: [],
  toolCount: 0,
  helpers: [],
  family: [],
  insight: null,
  history: []
})
const office = (agents: AgentView[]): OfficeSnapshot => ({
  agents,
  journal: [],
  workspaces: { '/w': 'w' },
  projects: { p: 'Project' },
  changes: {},
  links: {},
  can: { open: false },
  today: { day: '', finished: 0, failed: 0, blockedMs: 0 }
})

test('keeps three small desks in every room and adds a visible desk for every worker', () => {
  for (const width of [40, 56, 72, 96, 140, 190, 320]) {
    const empty = layout(office([]), width, 2, new Map()).rooms[0]
    assert.equal(empty.desks.length, 3)
    assert.deepEqual(empty.furniture.map((fixture) => fixture.name), ['web', 'coffee'])
    const workers = Array.from({ length: 8 }, (_, index) => agent(`desk-${width}-${index}`, 'working'))
    const room = layout(office(workers), width, 2, new Map()).rooms[0]
    assert.equal(room.desks.length, 8)
    assert.equal(room.seated.length, 8)
    for (const desk of room.desks) assert.ok(desk.x >= 0 && desk.x + 22 <= width)
    const actors = new Map<string, Actor>()
    step(actors, [room], width, 100, 0, true)
    assert.equal(actors.size, 8)
    for (const worker of workers) {
      const actor = actors.get(worker.id)!
      assert.equal(actor.seated, true)
      assert.ok(actor.goal.x >= 0 && actor.goal.x + 5 <= width)
      assert.ok(actor.goal.y + 1 <= room.top + room.height)
    }
  }
})

test('maps observed tools and helpers to small activity icons', () => {
  const kinds = ['edit', 'read', 'search', 'shell', 'web', 'delegate', 'plan', 'tool'] as const
  for (const kind of kinds) {
    const worker = {
      ...agent(`icon-${kind}`, 'working'),
      active: [{ callId: kind, tool: kind, kind, detail: 'observed', startedAt: 1 }]
    }
    assert.equal(observedActivity(worker, 100), kind)
  }
  assert.equal(observedActivity(agent('thinking', 'working'), 100), 'think')
  assert.equal(observedActivity({
    ...agent('delegating', 'working'),
    helpers: [{ id: 'child', kind: 'agent', name: 'helper', description: '', tool: null, toolKind: null }],
    family: []
  }, 100), 'delegate')
  assert.equal(observedActivity(agent('blocked', 'blocked'), 100), null)
})

test('a worker stays at the same desk when its observed activity changes', () => {
  const first = {
    ...agent('stays-seated', 'working'),
    active: [{ callId: 'shell-call', tool: 'bash', kind: 'shell' as const, detail: 'pwd', startedAt: 1 }]
  }
  const room = layout(office([first]), 190, 2, new Map()).rooms[0]
  const actors = new Map<string, Actor>()
  step(actors, [room], 190, 10, 0, true)
  const seated = actors.get(first.id)!
  const position = { x: seated.x, y: seated.y, goal: { ...seated.goal } }
  assert.equal(seated.activity, 'shell')
  const next = {
    ...first,
    active: [{ callId: 'web-call', tool: 'WebSearch', kind: 'web' as const, detail: 'docs', startedAt: 11 }]
  }
  const nextRoom = layout(office([next]), 190, 2, new Map()).rooms[0]
  step(actors, [nextRoom], 190, 12, 0, true)
  assert.deepEqual({ x: seated.x, y: seated.y, goal: seated.goal }, position)
  assert.equal(seated.seated, true)
  assert.equal(seated.activity, 'web')
})

test('keeps only the time window and coffee machine apart at all supported widths', () => {
  for (const width of [40, 48, 56, 64, 72, 80, 96, 140, 190, 320]) {
    const fixtures = wallFurniture(width)
    assert.deepEqual(fixtures.map((fixture) => fixture.name), ['web', 'coffee'])
    assert.ok(fixtures[0].left >= 0 && fixtures[1].right <= width)
    assert.ok(fixtures[0].right <= fixtures[1].left)
  }
})

test('anchors stable decor to wall or floor with bounds clear of fixtures and agents', () => {
  const overlaps = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }): boolean =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const allKinds = new Set<string>()
  for (const width of [40, 56, 72, 96, 140, 190, 320]) {
    const mixed = [
      ...Array.from({ length: 3 }, (_, index) => agent(`decor-worker-${width}-${index}`, 'working')),
      ...Array.from({ length: 2 }, (_, index) => agent(`decor-done-${width}-${index}`, 'done'))
    ].map((person) => ({ ...person, projectId: `decor-room-${width}` }))
    const room = layout(office(mixed), width, 2, new Map()).rooms[0]
    const again = layout(office(mixed), width, 2, new Map()).rooms[0]
    assert.deepEqual(room.decorations, again.decorations, `${width}px redraw preserves seeded decor`)
    assert.ok(room.decorations.length <= 4)
    if (width >= 140) assert.ok(room.decorations.some((decor) => decor.name === 'painting'), `${width}px room hangs a painting`)
    const fixtureBounds = room.furniture.map((item) => ({
      left: item.left,
      right: item.right,
      top: room.floor + (item.name === 'web' ? -29 : -21),
      bottom: room.floor + (item.name === 'web' ? -7 : 0)
    }))
    for (let index = 0; index < room.decorations.length; index++) {
      const decor = room.decorations[index]
      allKinds.add(decor.name)
      const bounds = { left: decor.left, right: decor.left + decor.width, top: decor.top, bottom: decor.top + decor.height }
      assert.ok(bounds.left >= 0 && bounds.right <= width, `${width}px decoration stays in room`)
      assert.ok(bounds.top >= room.top + room.head && bounds.bottom <= room.floor)
      if (['noticeboard', 'clock', 'poster', 'painting'].includes(decor.name)) {
        assert.equal(decor.top, room.floor - 27, 'wall art shares a hanging line')
      } else assert.equal(bounds.bottom, room.floor, 'furniture rests on the floor')
      assert.equal(overlaps(bounds, doorBox(room.floor)), false, `${width}px decor clears the door`)
      for (const fixture of fixtureBounds) assert.equal(overlaps(bounds, fixture), false, `${width}px decor clears wall fixture`)
      for (const other of room.decorations.slice(index + 1))
        assert.equal(overlaps(bounds, { left: other.left - 3, right: other.left + other.width + 3, top: other.top, bottom: other.top + other.height }), false)
    }

    const actors = new Map<string, Actor>()
    step(actors, [room], width, 100, 0, true)
    const actorBoxes = [...actors.values()].flatMap((actor) => [
      { left: actor.x - 5, right: actor.x + 5, top: actor.y - 16, bottom: actor.y + 2 },
      { left: actor.x - (actor.pose === 'cup' ? 9 : 16), right: actor.x + (actor.pose === 'cup' ? 9 : 16), top: actor.y + 2, bottom: actor.y + 8 },
      ...(actor.activity ? [{ left: actor.x - 5, right: actor.x + 5, top: actor.y - 30, bottom: actor.y - 20 }] : [])
    ])
    const deskBoxes = room.desks.map((desk) => ({ left: desk.x, right: desk.x + 22, top: desk.y - 9, bottom: desk.y + 14 }))
    for (const decor of room.decorations) {
      const bounds = { left: decor.left, right: decor.left + decor.width, top: decor.top, bottom: decor.top + decor.height }
      for (const actor of actorBoxes) assert.equal(overlaps(bounds, actor), false, `${width}px decor clears actor, name and thought`)
      for (const desk of deskBoxes) assert.equal(overlaps(bounds, desk), false, `${width}px decor clears desk`)
    }
  }
  assert.ok(allKinds.size >= 6, 'the seeded room pool uses varied decor types')
})

test('finished agents gather by the actual coffee machine in stable, varied spots', () => {
  for (const width of [40, 56, 72, 96, 190, 320]) {
    const guests = Array.from({ length: 4 }, (_, index) => agent(`coffee-${width}-${index}`, 'done'))
    const room = layout(office(guests), width, 2, new Map()).rooms[0]
    const positions = (): Map<string, { x: number; y: number }> => {
      const actors = new Map<string, Actor>()
      step(actors, [room], width, 100, 0, true)
      return new Map([...actors].map(([id, actor]) => [id, { x: actor.x, y: actor.y }]))
    }
    const first = positions()
    assert.deepEqual(positions(), first)
    assert.ok(first.size > 0 && first.size <= 4)
    assert.equal(new Set([...first.values()].map((spot) => `${spot.x}:${spot.y}`)).size, first.size)
    if (width >= 96) assert.ok(first.size > 1)
    const coffee = room.furniture.find((fixture) => fixture.name === 'coffee')!
    for (const [id, spot] of first) {
      assert.ok(Math.abs(spot.x - coffee.center) <= Math.max(12, width * 0.25))
      assert.ok(spot.x - 5 >= 0 && spot.x + 5 <= width)
      assert.ok(spot.y - 16 > room.floor, `${width}px coffee guest overlaps the machine`)
      assert.ok(room.labels[room.agents.findIndex((person) => person.id === id)])
    }
    const reversed = layout(office([...guests].reverse()), width, 2, new Map()).rooms[0]
    const again = new Map<string, { x: number; y: number }>()
    const actors = new Map<string, Actor>()
    step(actors, [reversed], width, 100, 0, true)
    for (const [id, actor] of actors) again.set(id, { x: actor.x, y: actor.y })
    assert.deepEqual(again, first)
  }
})

test('coffee guests yield space to worker bodies and activity thoughts in mixed rooms', () => {
  const intersects = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }): boolean =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  for (const width of [40, 56, 72, 96, 140, 190, 320]) {
    const worker = {
      ...agent(`worker-${width}`, 'working'),
      active: [{ callId: 'web', tool: 'WebSearch', kind: 'web' as const, detail: 'docs', startedAt: 1 }]
    }
    const guests = Array.from({ length: 4 }, (_, index) => agent(`finished-${width}-${index}`, 'done'))
    const room = layout(office([worker, ...guests]), width, 2, new Map()).rooms[0]
    const actors = new Map<string, Actor>()
    step(actors, [room], width, 100, 0, true)
    const active = actors.get(worker.id)!
    const body = (actor: Actor) => ({ left: actor.x - 5, right: actor.x + 5, top: actor.y - 16, bottom: actor.y + 1 })
    const boxes = (actor: Actor, nameWidth: number): Array<{ left: number; top: number; right: number; bottom: number }> => [
      body(actor),
      { left: actor.x - nameWidth / 2, right: actor.x + nameWidth / 2, top: actor.y + 2, bottom: actor.y + 8 }
    ]
    const workerBoxes = boxes(active, 32)
    if (active.activity) workerBoxes.push({ left: active.x - 5, right: active.x + 5, top: active.y - 30, bottom: active.y - 20 })
    assert.equal(active.seated, true)
    assert.equal(active.activity, 'web')
    const coffeeGuests = [...actors.values()].filter((actor) => actor.pose === 'cup')
    assert.ok(coffeeGuests.length > 0, `${width}px should keep a clear coffee spot for a finished agent`)
    for (const guest of coffeeGuests) {
      const guestBoxes = boxes(guest, 18)
      for (const first of guestBoxes) {
        for (const second of workerBoxes)
          assert.equal(intersects(first, second), false, `${width}px coffee drawing overlaps worker, name or thought`)
        const coffee = room.furniture.find((fixture) => fixture.name === 'coffee')!
        assert.equal(intersects(first, { left: coffee.left, right: coffee.right, top: room.floor - 21, bottom: room.floor }), false,
          `${width}px coffee drawing overlaps its machine`)
      }
    }
    for (let first = 0; first < coffeeGuests.length; first++) {
      for (let second = first + 1; second < coffeeGuests.length; second++) {
        for (const a of boxes(coffeeGuests[first], 18)) {
          for (const b of boxes(coffeeGuests[second], 18))
            assert.equal(intersects(a, b), false, `${width}px coffee guests or names overlap`)
        }
      }
    }
  }
})

test('uses six local-time periods at the exact four-hour boundaries', () => {
  assert.deepEqual(
    [0, 4, 8, 12, 16, 20, 23, 24].map(periodOfHour),
    ['night', 'dawn', 'morning', 'day', 'sunset', 'evening', 'evening', 'night']
  )
})

test('friendly desk labels distinguish agents without changing their source identity', () => {
  const agents = [agent('agent-a', 'working'), agent('agent-b', 'working')]
  const names = assignAgentNames(agents.map((one) => one.id))
  const [room] = layout(office(agents), 190, 2, new Map(), names).rooms
  assert.equal(new Set(room.labels).size, 2)
  assert.deepEqual(room.labels, agents.map((one) => names.get(one.id)))
  assert.deepEqual(agents.map((one) => [one.workspaceId, one.title]), [
    ['/w', 'agent-a'],
    ['/w', 'agent-b']
  ])
})

test('an agent gets the same portrait look wherever its headshot is drawn', () => {
  assert.deepEqual(lookOf(agent('portrait-a', 'working')), lookOf(agent('portrait-a', 'working')))
  assert.notEqual(lookOf(agent('portrait-a', 'working')).seed, lookOf(agent('portrait-b', 'working')).seed)
})

test('project room order does not change when agent states change', () => {
  const a = { ...agent('a', 'done'), projectId: 'a' }
  const b = { ...agent('b', 'working'), projectId: 'b' }
  const before = layout(office([a, b]), 190, 2, new Map()).rooms.map((room) => room.id)
  const after = layout(office([{ ...a, state: 'blocked' as const }, { ...b, state: 'done' as const }]), 190, 2, new Map()).rooms.map((room) => room.id)
  assert.deepEqual(after, before)
})

const NOW = 1_000_000
const finished = (id: string, extra: Partial<AgentView> = {}): AgentView =>
  ({ ...agent(id, 'done'), reply: 'Moved the sign.', finishedAt: NOW - 5_000, stateStartedAt: NOW - 5_000, ...extra })

test('a finished reply is said for twenty seconds, and a failure just says Failed', () => {
  assert.deepEqual(bubbleFor(finished('a'), NOW, 20), { text: 'Moved the sign.', tone: 'done', since: NOW - 5_000 })
  assert.equal(bubbleFor(finished('a', { finishedAt: NOW - BUBBLE_MS + 1 }), NOW, 20)?.tone, 'done')
  assert.equal(bubbleFor(finished('a', { finishedAt: NOW - BUBBLE_MS }), NOW, 20), null)
  assert.equal(bubbleFor(finished('a', { finishedAt: NOW + BUBBLE_MS }), NOW, 20), null, 'a finish from the far future is not believed')
  assert.equal(bubbleFor(finished('a', { outcome: 'failure', reply: 'It broke.' }), NOW, 20)?.text, 'Failed')
  assert.equal(bubbleFor(finished('a', { outcome: 'failure', reply: 'It broke.' }), NOW, 20)?.tone, 'failed')
  assert.equal(bubbleFor(finished('a', { reply: null }), NOW, 20), null, 'nothing is said when there are no words')
  assert.equal(bubbleFor(finished('a', { reply: '\n  \n' }), NOW, 20), null)
  // Without a real finish time the moment it was seen done stands in for it.
  assert.equal(bubbleFor(finished('a', { finishedAt: null, stateStartedAt: NOW - 30_000 }), NOW, 20), null)
  assert.equal(bubbleFor(finished('a', { finishedAt: null, stateStartedAt: NOW - 1_000 }), NOW, 20)?.tone, 'done')
  assert.equal(bubbleFor({ ...finished('a'), state: 'waiting' }, NOW, 20), null)
})

test('blocked says Need you! for as long as it lasts, and a quiet worker says Stuck? once overdue', () => {
  const blocked = { ...agent('b', 'blocked'), stateStartedAt: NOW - 1_000, reply: 'Done.', finishedAt: NOW }
  assert.deepEqual(bubbleFor(blocked, NOW, 20), { text: 'Need you!', tone: 'need', since: NOW - 1_000 })
  assert.equal(bubbleFor({ ...blocked, stateStartedAt: NOW - 3 * 3_600_000 }, NOW, 20)?.text, 'Need you!')
  assert.equal(bubbleFor(blocked, NOW, 0)?.text, 'Need you!', 'the stuck setting being off does not hide a request')
  const quiet = { ...agent('w', 'working'), lastSeenAt: NOW - 21 * 60_000 }
  assert.deepEqual(bubbleFor(quiet, NOW, 20), { text: 'Stuck?', tone: 'stuck', since: quiet.lastSeenAt + 20 * 60_000 })
  assert.equal(bubbleFor({ ...quiet, lastSeenAt: NOW - 19 * 60_000 }, NOW, 20), null)
  assert.equal(bubbleFor(quiet, NOW, 0), null, 'off means off')
  assert.equal(bubbleFor(quiet, NOW, 30), null)
  assert.equal(bubbleFor({ ...agent('w', 'working'), lastSeenAt: NOW }, NOW, 20), null)
})

test('a reply is cut to its first line without markdown marks', () => {
  assert.equal(replyLine('\n\n## Fixed `scene.ts` **now**\nMore detail'), 'Fixed scene.ts now')
  assert.equal(replyLine('- one\n- two'), 'one')
  assert.equal(replyLine('  spaced   out  '), 'spaced out')
  assert.equal(replyLine(null), '')
  assert.equal(replyLine('***\n> quoted'), 'quoted')
})

test('text is cut with an ellipsis only when it does not fit', () => {
  const measure = (text: string): number => text.length * 3
  assert.equal(fitText('short', 30, measure), 'short')
  assert.equal(fitText('a much longer sentence than fits', 30, measure), 'a much lo…')
  for (const max of [6, 9, 15, 30, 61]) assert.ok(measure(fitText('a much longer sentence than fits', max, measure)) <= Math.max(max, 6))
  assert.equal(fitText('trailing space here', 24, measure).includes(' …'), false)
})

test('a reply keeps a leading minus or digit and drops only real list markers', () => {
  assert.equal(replyLine('-1 returned'), '-1 returned')
  assert.equal(replyLine('+5 files changed'), '+5 files changed')
  assert.equal(replyLine('#42 is merged'), '#42 is merged')
  assert.equal(replyLine('- one'), 'one')
  assert.equal(replyLine('* one'), 'one')
  assert.equal(replyLine('1. one'), 'one')
  assert.equal(replyLine('2) two'), 'two')
  assert.equal(replyLine('  - > nested'), 'nested')
  assert.equal(replyLine('---\nAfter the rule'), 'After the rule')
  assert.equal(replyLine('-'), '')
})

test('a reply skips fenced code and says nothing when there is only code', () => {
  assert.equal(replyLine('```ts\nconst a = 1\n```\nFixed the typo.'), 'Fixed the typo.')
  assert.equal(replyLine('Intro line\n```\ncode\n```'), 'Intro line')
  assert.equal(replyLine('~~~\n# not a heading\n~~~\nProse'), 'Prose')
  assert.equal(replyLine('````\n```\ninner\n```\n````\nAfter'), 'After')
  assert.equal(replyLine('```js\nlet a\n```'), '')
  assert.equal(replyLine('```js\nlet a = 1\nNever closed'), '')
  assert.equal(replyLine('```one line```\nProse'), 'Prose')
  const reply = '```\nconst a = 1\n```'
  assert.equal(bubbleFor(finished('a', { reply }), NOW, 20), null, 'no reply bubble rather than code')
})

test('text is cut on whole characters, never inside an emoji', () => {
  const measure = (text: string): number => text.length * 3
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
  for (const text of ['😀'.repeat(12), `ab${'😀'.repeat(8)}`, family.repeat(4), 'é'.repeat(3) + 'e\u0301'.repeat(6)]) {
    for (let max = 3; max < 90; max++) {
      const out = fitText(text, max, measure)
      assert.equal(lone.test(out), false, `no broken surrogate at ${max}`)
      assert.equal(out.includes('\ufffd'), false)
    }
  }
  assert.equal(fitText('😀😀😀😀😀😀', 24, measure), '😀😀😀…')
  assert.equal(fitText('😀', 1, measure), '😀…', 'one character stays however narrow')
  // Where Intl.Segmenter exists, a joined family is one character, not three.
  if ('Segmenter' in Intl) assert.equal(fitText(`${family}${family}${family}`, 54, measure), `${family}${family}…`)
})

test('fitText measures a handful of times, not once per character, and remembers its answer', () => {
  let calls = 0
  const measure = (text: string): number => {
    calls++
    return text.length * 3
  }
  const long = 'word '.repeat(80)
  const out = fitText(long, 90, measure)
  assert.ok(measure(out) <= 90)
  assert.ok(calls < 20, `${calls} measures for 400 characters`)
  assert.equal(out, fitText(long, 90, (text) => text.length * 3), 'bisection finds the same cut as counting down')
  calls = 0
  assert.equal(fitText(long, 90, measure, 'cache-test-font'), out)
  const first = calls
  assert.equal(fitText(long, 90, measure, 'cache-test-font'), out)
  assert.equal(calls, first, 'a repaint does not measure again')
  assert.equal(fitText(long, 60, measure, 'cache-test-font').length < out.length, true, 'a new width is cut again')
  fitText(long, 90, measure, 'other-font')
  assert.ok(calls > first, 'a new font is measured again')
})

test('bubbles sit inside the room, under the sign, over their speaker and clear of each other', () => {
  const measure = (text: string): number => text.length * 3
  const long = 'Rewrote the whole scene so every bubble fits the narrowest panel'
  for (const width of [60, 100, 138, 190, 208]) {
    for (const scale of [1.5, 2]) {
      const crowd = [
        ...['a', 'b', 'c', 'd'].map((id) => ({ ...agent(`${id}-${width}`, 'blocked'), stateStartedAt: NOW })),
        ...['e', 'f'].map((id) => finished(`${id}-${width}`, { reply: long })),
        { ...agent(`g-${width}`, 'working'), lastSeenAt: NOW - 25 * 60_000 }
      ]
      const room = layout(office(crowd), width, scale, new Map()).rooms[0]
      const actors = new Map<string, Actor>()
      step(actors, [room], width, NOW, 0, true)
      const bubbles = new Map<string, Bubble>(crowd.map((one) => [one.id, bubbleFor(one, NOW, 20)!]))
      assert.equal(bubbles.size, crowd.length)
      const placed = placeBubbles(room, [...actors.values()], bubbles, width, scale, measure)
      assert.ok(placed.length > 0 && placed.length <= crowd.length)
      for (const item of placed) {
        const actor = actors.get(item.agentId)!
        assert.ok(item.left >= 0 && item.left + item.width <= width, `${width}px bubble inside the room`)
        assert.ok(item.top >= room.top + room.head, `${width}px bubble clear of the sign`)
        assert.ok(item.top + item.height + 1 <= actor.y - 16, `${width}px bubble above its speaker's head`)
        assert.equal(item.height, bubbleHeight(scale))
        assert.ok(actor.x >= item.left && actor.x <= item.left + item.width, `${width}px bubble stays over its speaker`)
        assert.ok(item.tail >= item.left && item.tail + 2 <= item.left + item.width)
        assert.ok(measure(item.text) + 2 <= item.width, `${width}px text fits its bubble: ${item.text}`)
        assert.ok(item.text === bubbles.get(item.agentId)!.text || item.text.endsWith('…'))
      }
      for (let first = 0; first < placed.length; first++) {
        for (const other of placed.slice(first + 1)) {
          const apart =
            placed[first].left + placed[first].width <= other.left || other.left + other.width <= placed[first].left ||
            placed[first].top + placed[first].height < other.top || other.top + other.height < placed[first].top
          assert.ok(apart, `${width}px bubbles ${placed[first].agentId} and ${other.agentId} do not cover each other`)
        }
      }
    }
  }
})

test('when bubbles collide the one that matters stays, and each person speaks once', () => {
  const measure = (text: string): number => text.length * 3
  const width = 60
  const talkers = [
    { ...finished('aa', { reply: 'Finished the long thing' }), projectId: 'p' },
    { ...agent('bb', 'blocked'), stateStartedAt: NOW }
  ]
  const room = layout(office(talkers), width, 2, new Map()).rooms[0]
  const actors = new Map<string, Actor>()
  step(actors, [room], width, NOW, 0, true)
  const bubbles = new Map<string, Bubble>(talkers.map((one) => [one.id, bubbleFor(one, NOW, 20)!]))
  const placed = placeBubbles(room, [...actors.values()], bubbles, width, 2, measure)
  assert.ok(placed.some((item) => item.tone === 'need'), 'Need you! is never the one dropped')
  assert.equal(new Set(placed.map((item) => item.agentId)).size, placed.length)
  // Listing the actors the other way round changes nothing: priority decides, not order.
  assert.deepEqual(placeBubbles(room, [...actors.values()].reverse(), bubbles, width, 2, measure), placed)
  assert.deepEqual(placeBubbles(room, [...actors.values()], new Map(), width, 2, measure), [])
})

test('a click on a bubble belongs to its speaker', () => {
  const placed = [{ agentId: 'x', text: 'Hi', tone: 'done' as const, since: 0, left: 10, top: 20, width: 20, height: 8, tail: 18 }]
  assert.equal(pickBubble(placed, 15, 24), 'x')
  assert.equal(pickBubble(placed, 15, 28.5), 'x', 'the tail counts')
  assert.equal(pickBubble(placed, 9, 24), null)
  assert.equal(pickBubble(placed, 15, 30), null)
})

test('people who arrive together walk in one behind the other, never on top of each other', () => {
  const room = layout(office([agent('first', 'done'), agent('second', 'done')]), 190, 2, new Map()).rooms[0]
  const actors = new Map<string, Actor>()
  step(actors, [room], 190, 10, 0, false)
  for (let tick = 0; tick < 80; tick++) {
    const [a, b] = [...actors.values()]
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 10, `overlapping at tick ${tick}: ${a.x},${a.y} and ${b.x},${b.y}`)
    step(actors, [room], 190, 10, 0.1, false)
  }
  assert.ok([...actors.values()].every((actor) => !actor.route.length), 'both reach the coffee corner')
})

test('the door stays clear of the window and coffee machine at every width', () => {
  for (const width of [40, 48, 56, 64, 72, 80, 96, 140, 190, 320]) {
    const door = doorBox(100)
    const [web] = wallFurniture(width)
    assert.ok(web.left >= door.right, `${width}px window clears the door`)
  }
})

test('MR.Boss sits at his own spot below the worker rows and the workers keep their desks', () => {
  for (const width of [96, 140, 190, 320]) {
    const workers = Array.from({ length: 7 }, (_, index) => agent(`w-${index}`, 'working'))
    const boss = agent('boss', 'working')
    const names = new Map([[boss.id, BOSS_NAME]])
    const without = layout(office(workers), width, 2, new Map(), names).rooms[0]
    const withBoss = layout(office([...workers, boss]), width, 2, new Map(), names).rooms[0]
    assert.equal(withBoss.desks.length, without.desks.length)
    assert.deepEqual(withBoss.desks, without.desks)
    assert.equal(withBoss.seated.length, 7)
    assert.equal(withBoss.bossDesks.length, 1)
    assert.equal(withBoss.bosses[0].id, 'boss')
    const lastRow = Math.max(...withBoss.desks.map((desk) => desk.y))
    const spot = withBoss.bossDesks[0]
    assert.ok(spot.y - 9 > lastRow + 14, 'the boss desk clears the last worker row')
    assert.ok(withBoss.bossRail !== null && withBoss.bossRail > lastRow + 14 && withBoss.bossRail < spot.y - 25, 'the partition is between')
    assert.ok(spot.x >= 0 && spot.x + 22 <= width)
    assert.ok(withBoss.height > without.height)
    assert.ok(spot.y + 14 <= withBoss.top + withBoss.height)
    const actors = new Map<string, Actor>()
    step(actors, [withBoss], width, 100, 0, true)
    assert.deepEqual({ x: actors.get('boss')!.goal.x, y: actors.get('boss')!.goal.y }, { x: spot.x + 8, y: spot.y + 5 })
    assert.equal(actors.get('boss')!.seated, true)
  }
})

test('without a boss the layout has no boss strip, and each boss gets a spot', () => {
  const workers = Array.from({ length: 4 }, (_, index) => agent(`w-${index}`, 'working'))
  const room = layout(office(workers), 190, 2, new Map(), new Map()).rooms[0]
  assert.deepEqual(room.bossDesks, [])
  assert.equal(room.bossRail, null)
  const bosses = [agent('b1', 'working'), agent('b2', 'blocked'), agent('b3', 'done')]
  const names = new Map(bosses.map((boss) => [boss.id, BOSS_NAME]))
  const many = layout(office([...workers, ...bosses]), 190, 2, new Map(), names).rooms[0]
  assert.equal(many.bossDesks.length, 2, 'a boss who finished goes for coffee instead')
  const [a, b] = many.bossDesks
  assert.ok(Math.abs(a.x - b.x) >= 22 || a.y !== b.y)
})

test('with motion an arrival starts at the door; without it, at its seat', () => {
  const worker = agent('arrives', 'working')
  const room = layout(office([worker]), 190, 2, new Map()).rooms[0]
  const door = doorBox(room.floor)
  const walking = new Map<string, Actor>()
  step(walking, [room], 190, 10, 0, false)
  const entered = walking.get('arrives')!
  assert.ok(entered.x >= door.left && entered.x <= door.right && entered.y > room.floor, 'starts at the door')
  assert.ok(entered.route.length > 0)
  const placed = new Map<string, Actor>()
  step(placed, [room], 190, 10, 0, true)
  const seated = placed.get('arrives')!
  assert.deepEqual({ x: seated.x, y: seated.y }, seated.goal)
  assert.equal(seated.route.length, 0)
})

test('a departed agent walks to the door and goes; without motion it goes at once', () => {
  const worker = agent('leaves', 'working')
  const room = layout(office([worker]), 190, 2, new Map()).rooms[0]
  const gone = layout(office([]), 190, 2, new Map()).rooms[0]
  const walking = new Map<string, Actor>()
  step(walking, [room], 190, 10, 0, true)
  step(walking, [gone], 190, 20, 0.1, false)
  const leaving = walking.get('leaves')!
  assert.equal(leaving.leaving, true)
  const door = doorBox(gone.floor)
  assert.ok(leaving.entry.x >= door.left && leaving.entry.x <= door.right)
  for (let tick = 0; tick < 200 && walking.size; tick++) step(walking, [gone], 190, 30, 0.1, false)
  assert.equal(walking.size, 0, 'removed after reaching the door')

  const still = new Map<string, Actor>()
  step(still, [room], 190, 10, 0, true)
  step(still, [gone], 190, 20, 0.1, true)
  assert.equal(still.size, 0, 'no lingering ghost')
})

test('a pending question says Need you!, unread mail says Mail!, and need > failed > stuck > mail > done', () => {
  const asking = { ...agent('q', 'working'), pendingQuestion: true, stateStartedAt: NOW - 1_000 }
  assert.deepEqual(bubbleFor(asking, NOW, 20), { text: 'Need you!', tone: 'need', since: NOW - 1_000 })
  const mailing = { ...agent('m', 'working'), unreadMail: 2, stateStartedAt: NOW - 2_000 }
  assert.deepEqual(bubbleFor(mailing, NOW, 20), { text: 'Mail!', tone: 'mail', since: NOW - 2_000 })
  assert.equal(bubbleFor({ ...mailing, unreadMail: 0 }, NOW, 20), null)
  assert.equal(bubbleFor({ ...mailing, mailSince: NOW - 100 }, NOW, 20)?.since, NOW - 100, 'the newest mail times the bubble')
  assert.equal(bubbleFor({ ...asking, questionSince: NOW - 50 }, NOW, 20)?.since, NOW - 50, 'the question times its bubble')
  assert.equal(bubbleFor({ ...mailing, lastSeenAt: NOW - 21 * 60_000 }, NOW, 20)?.tone, 'stuck')
  const doneWithMail = finished('d', { unreadMail: 1 })
  assert.equal(bubbleFor(doneWithMail, NOW, 20)?.tone, 'mail')
  assert.equal(bubbleFor({ ...doneWithMail, outcome: 'failure' }, NOW, 20)?.tone, 'failed')
  assert.equal(bubbleFor({ ...doneWithMail, pendingQuestion: true, outcome: 'failure' }, NOW, 20)?.tone, 'need')
})

test('plants stand by the door, between desks and by the boss, clear of desks, seats, the door and walking paths', () => {
  for (const width of [96, 140, 190, 320]) {
    const workers = Array.from({ length: 6 }, (_, index) => agent(`w-${index}`, 'working'))
    const boss = agent('boss', 'working')
    const names = new Map([[boss.id, BOSS_NAME]])
    const room = layout(office([...workers, boss]), width, 2, new Map(), names).rooms[0]
    const plain = layout(office(workers), width, 2, new Map()).rooms[0]
    const hit = (a: { left: number; top: number; width: number; height: number }, b: { left: number; right: number; top: number; bottom: number }): boolean =>
      a.left < b.right && b.left < a.left + a.width && a.top < b.bottom && b.top < a.top + a.height
    const door = doorBox(room.floor)
    assert.ok(room.plants.length >= 2, `${width}px keeps its plants`)
    for (const plant of room.plants) {
      assert.equal(plant.name, 'plant')
      assert.ok(plant.left >= 0 && plant.left + plant.width <= width)
      assert.ok(!hit(plant, door), 'not over the door')
      for (const desk of [...room.desks, ...room.bossDesks]) {
        assert.ok(!hit(plant, { left: desk.x, right: desk.x + 22, top: desk.y - 9, bottom: desk.y + 14 }), 'not over a desk')
        assert.ok(!hit(plant, { left: desk.x + 3, right: desk.x + 13, top: room.floor + 6, bottom: desk.y + 5 }), 'not on the way to a seat')
      }
      assert.ok(!hit(plant, { left: 0, right: width, top: room.floor + 6, bottom: room.floor + 30 }), 'not in the walking lane')
      for (const other of room.plants) if (other !== plant) assert.ok(!hit(plant, { left: other.left, right: other.left + 8, top: other.top, bottom: other.top + 15 }))
    }
    const bossDesk = room.bossDesks[0]
    assert.ok(room.plants.some((plant) => plant.top + 3 === bossDesk.y && Math.abs(plant.left - bossDesk.x) <= 36), 'one stands by the boss corner')
    const lastRow = Math.max(...plain.desks.map((desk) => desk.y))
    assert.ok(plain.plants.every((plant) => plant.top + 3 <= lastRow), 'without a boss no plant stands below the worker rows')
  }
})

test('every name sits on a plate that contrasts with it, stays inside its seat pitch and never overlaps a neighbour', () => {
  for (const dark of [false, true]) {
    const colors = palette(dark)
    const long = ['María Fernanda', 'José Guadalupe', 'Quetzalcóatl', 'Juan Carlos', 'Kevin', 'Itzel']
    const agents = long.map((name, index) => agent(`w${index}`, 'working'))
    const names = new Map(agents.map((worker, index) => [worker.id, long[index]]))
    const { rooms } = layout(office(agents), 190, 2, new Map(), names)
    const actors = new Map<string, Actor>()
    step(actors, rooms, 190, 100, 0, true)
    let style = ''
    let font = 0
    const plates: Array<{ x: number; y: number; w: number; h: number }> = []
    const texts: Array<{ text: string; x: number; y: number }> = []
    const stub = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => {
        if (key === 'measureText') return (text: string) => ({ width: text.length * font * 0.6 })
        if (key === 'fillRect') return (x: number, y: number, w: number, h: number) => { if (style === colors.plate) plates.push({ x, y, w, h }) }
        if (key === 'fillText') return (text: string, x: number, y: number) => texts.push({ text, x, y })
        return target[key] ?? (() => undefined)
      },
      set: (target, key: string, value: unknown) => {
        if (key === 'fillStyle') style = String(value)
        if (key === 'font') font = Number(/(\d+(?:\.\d+)?)px/.exec(String(value))?.[1])
        target[key] = value
        return true
      }
    }) as unknown as CanvasRenderingContext2D
    draw(stub, { width: 190, rooms, actors, beat: 1, period: dark ? 'night' : 'day', scale: 2, colors, theme: { card: '#fff', text: '#000', muted: '#888', border: '#444', accent: '#4f8fe6' }, selected: null, hovered: null })
    const named = texts.filter((item) => long.some((name) => name.startsWith(item.text.replace('…', ''))))
    assert.equal(named.length, long.length)
    assert.equal(plates.length, long.length)
    for (const plate of plates) assert.ok(plate.w <= 34)
    for (const [index, plate] of plates.entries())
      for (const other of plates.slice(index + 1))
        if (Math.abs(plate.y - other.y) < plate.h) assert.ok(plate.x + plate.w <= other.x || other.x + other.w <= plate.x)
    const luminance = (color: string): number => {
      const channels = (color.startsWith('#') ? [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16)) : (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number))
      return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255
    }
    assert.ok(Math.abs(luminance(colors.plate) - luminance(colors.name)) > 0.6)
  }
})
