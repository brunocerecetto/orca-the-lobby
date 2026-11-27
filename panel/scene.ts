// The office picture: where rooms, desks and people go, and how each is drawn. Everything is in
// office pixels (panel/main.ts scales the canvas), drawn with rectangles so no image ships.
import type { Activity, AgentView, OfficeSnapshot } from '../src/protocol'
import type { PaletteChoice } from '../src/protocol'
import { overdue } from '../src/protocol'
import { BOSS_NAME } from './names'
import { PALETTES } from './palettes'

type Pose = 'idle' | 'type' | 'read' | 'hand' | 'cup'
export type ActivityIcon = 'think' | 'edit' | 'read' | 'search' | 'shell' | 'web' | 'delegate' | 'plan' | 'tool'
type Point = { x: number; y: number }
type Rect = (x: number, y: number, w: number, h: number, color: string) => void

export type Look = { seed: number; shirt: string }

export type Room = {
  id: string
  name: string
  top: number
  /** How tall the sign over the room is. */
  head: number
  /** Where the wall ends and the floor starts. */
  floor: number
  height: number
  /** Folded to its sign by the person. */
  collapsed: boolean
  agents: AgentView[]
  /** Non-finished agents other than the boss, in their permanent desk order. */
  seated: AgentView[]
  /** Non-finished MR.Boss agents; each has the spot of the same index in `bossDesks`. */
  bosses: AgentView[]
  /** The bosses' own desks, in a strip below the workers' rows; empty without a boss. */
  bossDesks: Point[]
  /** Where the partition between the worker rows and the boss strip is drawn, or null without a boss. */
  bossRail: number | null
  /** Friendly display name for each agent in `agents`. */
  labels: string[]
  desks: Point[]
  /** What makes this room its own: every project gets the same room each time. */
  seed: number
  furniture: WallFixture[]
  decorations: Decoration[]
}

export type Actor = Point &
  Look & {
    key: string
    agentId: string
    room: string
    goal: Point
    /** The corners still to turn on the way to `goal`. */
    route: Point[]
    entry: Point
    pose: Pose
    seated: boolean
    activity: ActivityIcon | null
    moving: boolean
    leaving: boolean
  }

export type Palette = typeof NIGHT
export type DayPeriod = 'night' | 'dawn' | 'morning' | 'day' | 'sunset' | 'evening'

export function periodOfHour(hour: number): DayPeriod {
  return (['night', 'dawn', 'morning', 'day', 'sunset', 'evening'] as const)[
    Math.floor(((hour % 24) + 24) % 24 / 4)
  ]
}

/** The dark theme is the office at night, the light theme the office by day. */
const NIGHT = {
  flavor: 'orca' as 'orca' | 'dark' | 'light',
  night: true,
  wall: '#3d4460',
  wallLow: '#333952',
  trim: '#252a3d',
  floor: '#65545d',
  seam: '#56464f',
  desk: '#bb8459',
  deskLight: '#d29d72',
  deskFront: '#93613f',
  deskLeg: '#6c4930',
  chair: '#566080',
  metal: '#8b91a6',
  metalDark: '#5d6379',
  frame: '#59617f',
  skyTop: '#182042',
  skyLow: '#27306a',
  shadow: 'rgba(0, 0, 0, 0.28)',
  name: 'rgba(255, 255, 255, 0.72)'
}
const DAY: Palette = {
  flavor: 'orca',
  night: false,
  wall: '#efe9dc',
  wallLow: '#e2dac8',
  trim: '#bfb6a1',
  floor: '#e6cba3',
  seam: '#d8b98f',
  desk: '#f6f2ea',
  deskLight: '#ffffff',
  deskFront: '#d6cfc0',
  deskLeg: '#a39d90',
  chair: '#6f7896',
  metal: '#a3a8b8',
  metalDark: '#757a8d',
  frame: '#fbf8f1',
  skyTop: '#7fc2f3',
  skyLow: '#bfe3fb',
  shadow: 'rgba(60, 40, 20, 0.2)',
  name: 'rgba(40, 30, 20, 0.7)'
}
export const palette = (dark: boolean): Palette => (dark ? NIGHT : DAY)

export function paletteFor(choice: PaletteChoice, appDark: boolean): Palette {
  if (choice === 'orca') return palette(appDark)
  const tokens = PALETTES[choice]
  const dark = tokens.mode === 'dark'
  const base = dark ? NIGHT : DAY
  return {
    ...base,
    flavor: dark ? 'dark' : 'light',
    night: dark,
    wall: dark ? tokens.background : shade(tokens.background, -0.07),
    wallLow: tokens.card,
    trim: tokens.border,
    floor: dark ? '#394355' : '#ffffff',
    seam: dark ? '#48546a' : '#d1d9e0',
    desk: dark ? '#9a7054' : '#d5b993',
    deskLight: dark ? '#c09670' : '#f0d7b3',
    deskFront: dark ? '#79583f' : '#c2a37d',
    deskLeg: dark ? '#5c4432' : '#967b5c',
    chair: tokens.accent,
    metal: tokens.muted,
    metalDark: tokens.border,
    frame: tokens.border,
    skyTop: dark ? '#242b43' : '#acd6f4',
    skyLow: dark ? '#3c4a67' : '#d9efff',
    name: dark ? 'rgba(255,255,255,0.78)' : 'rgba(31,35,40,0.76)'
  }
}

const WALL = 30
const DESK_TOP = 43
/** Small desk footprint plus enough room for a person and the activity icon above them. */
const DESK_W = 22
const PITCH = 34
const GAP = 6
/** Text is sized in screen pixels, whatever the office's scale. */
const SIGN_PX = 12
const NAME_PX = 10
const RADIUS = 5
/** Speech bubbles: the text is sized in screen pixels like the other text. */
const BUBBLE_PX = 10
/** How long a finished agent's last words stay over its head. */
export const BUBBLE_MS = 20_000
/** Office pixels a second. */
const SPEED = 42
/** A call this fresh still shows after it returned, so quick reads and greps are seen. */
const LINGER_MS = 4000
/** How many finished agents the coffee corner holds; the rest have gone home. */
const COFFEE = 4
const WINDOW_WIDTH = 28
const COFFEE_WIDTH = 18
/** Extra space between the workers' last row and the boss strip. */
const BOSS_GAP = 10
/** Planks: floor and seam. */
const WOOD = { night: ['#6d513d', '#5a4232'], day: ['#c99a62', '#b3844f'] }
/** The door in the wall: its left edge, size and the room the wall fixtures leave for it. */
const DOOR = { left: 4, width: 10, height: 21 }
const DOOR_SPACE = DOOR.left + DOOR.width + 2
/** The door's bounds on the wall of a room whose floor starts at `floor`. */
export const doorBox = (floor: number): { left: number; right: number; top: number; bottom: number } => ({
  left: DOOR.left,
  right: DOOR.left + DOOR.width,
  top: floor - DOOR.height,
  bottom: floor
})
const SKIN = ['#f6d3b3', '#eab88f', '#c98b5e', '#8e5c3e']
const HAIR = ['#2c2a35', '#5b3a26', '#a8582a', '#e0b94f', '#9a9aa8', '#b8433f']
const SHIRTS: Record<string, string> = {
  claude: '#d97757',
  codex: '#3fa58a',
  gemini: '#4f8fe6',
  opencode: '#a878e0',
  cursor: '#d4b13f'
}
const PANTS = '#3d4466'
const INK = '#1d1f2b'
const MUGS = ['#e5484d', '#3e9bd8', '#f1c24b', '#ffffff']
function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index++) {
    value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  }
  return value >>> 0
}

export type WallFixture = { name: 'web' | 'coffee'; center: number; width: number; scale: number; left: number; right: number }

export type DecorationName = 'plant' | 'noticeboard' | 'server' | 'bookshelf' | 'clock' | 'poster' | 'cooler' | 'cabinet' | 'painting'
export type Decoration = { name: DecorationName; left: number; top: number; width: number; height: number }

const DECORATION_SPECS: Array<{ name: DecorationName; width: number; height: number }> = [
  { name: 'plant', width: 8, height: 15 },
  { name: 'noticeboard', width: 24, height: 16 },
  { name: 'server', width: 12, height: 22 },
  { name: 'bookshelf', width: 18, height: 16 },
  { name: 'clock', width: 10, height: 10 },
  { name: 'poster', width: 14, height: 12 },
  { name: 'cooler', width: 12, height: 16 },
  { name: 'cabinet', width: 14, height: 20 },
  { name: 'painting', width: 16, height: 12 }
]

/** A few room-seeded accents in clear wall space; no decoration changes agent routing. */
export function decorationsFor(width: number, floor: number, furniture: WallFixture[], seed: number): Decoration[] {
  const gap = 3
  const intersects = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }): boolean =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const frame = doorBox(floor)
  const door = { left: frame.left - 2, right: frame.right + 2, top: frame.top - 1, bottom: frame.bottom }
  const fixtures = [door, ...furniture.map((item) => ({
    left: item.left,
    right: item.right,
    top: floor + (item.name === 'web' ? -29 : -21),
    bottom: floor + (item.name === 'web' ? -7 : 0)
  }))]
  // The painting always hangs first, so the room keeps it whatever the seed picks after.
  const ordered = [...DECORATION_SPECS].sort(
    (a, b) => Number(b.name === 'painting') - Number(a.name === 'painting') || hash(`${seed}:kind:${a.name}`) - hash(`${seed}:kind:${b.name}`)
  )
  const placed: Decoration[] = []
  for (const spec of ordered) {
    if (placed.length >= 4) break
    const wallMounted = ['noticeboard', 'clock', 'poster', 'painting'].includes(spec.name)
    const top = wallMounted ? floor - 27 : floor - spec.height
    const candidates = Array.from({ length: Math.max(0, width - spec.width - 6) }, (_, index) => index + 3)
      .sort((a, b) => {
        // Floor furniture starts at the room edges; wall art fills the clear wall bays.
        const anchor = spec.name === 'server' || hash(`${seed}:${spec.name}`) % 2 === 0 ? 3 : width - spec.width - 3
        return Math.abs(a - anchor) - Math.abs(b - anchor)
      })
    const left = candidates.find((candidate) => {
      const bounds = { left: candidate, right: candidate + spec.width, top, bottom: top + spec.height }
      return !fixtures.some((fixture) => intersects(bounds, fixture)) &&
        !placed.some((item) => intersects(bounds, { left: item.left - gap, right: item.left + item.width + gap, top: item.top, bottom: item.top + item.height }))
    })
    if (left !== undefined) placed.push({ ...spec, left, top })
  }
  return placed
}

/** Keep just the time window and coffee machine; compress both together in very narrow rooms. */
export function wallFurniture(width: number): WallFixture[] {
  const gap = 2
  const total = WINDOW_WIDTH + 4 + COFFEE_WIDTH
  const widths = [WINDOW_WIDTH + 4, COFFEE_WIDTH]
  let centers: number[]
  let scale = 1
  if (width < 70) {
    scale = Math.min(1, Math.max(0, (width - 2 - gap - DOOR_SPACE) / total))
    let left = DOOR_SPACE + (width - DOOR_SPACE - total * scale - gap) / 2
    centers = widths.map((fixtureWidth) => {
      const center = left + fixtureWidth * scale / 2
      left += fixtureWidth * scale + gap
      return center
    })
  } else {
    centers = [width * 0.46, width * 0.84]
  }
  return (['web', 'coffee'] as const).map((name, index) => {
    const fixtureWidth = widths[index] * scale
    return {
      name,
      center: centers[index],
      width: fixtureWidth,
      scale,
      left: centers[index] - fixtureWidth / 2,
      right: centers[index] + fixtureWidth / 2
    }
  })
}

/** `#rrggbb` mixed toward white (amount above 0) or black (below). */
function shade(color: string, amount: number): string {
  const target = amount > 0 ? 255 : 0
  const mix = (offset: number): string =>
    Math.round(
      parseInt(color.slice(offset, offset + 2), 16) * (1 - Math.abs(amount)) +
        target * Math.abs(amount)
    )
      .toString(16)
      .padStart(2, '0')
  return `#${mix(1)}${mix(3)}${mix(5)}`
}

/** `from` mixed with `to`, both `#rrggbb`. */
function blend(from: string, to: string, share: number): string {
  const mix = (offset: number): string =>
    Math.round(
      parseInt(from.slice(offset, offset + 2), 16) * (1 - share) +
        parseInt(to.slice(offset, offset + 2), 16) * share
    )
      .toString(16)
      .padStart(2, '0')
  return `#${mix(1)}${mix(3)}${mix(5)}`
}

const brush =
  (ctx: CanvasRenderingContext2D): Rect =>
  (x, y, w, h, color) => {
    ctx.fillStyle = color
    ctx.fillRect(Math.round(x), Math.round(y), w, h)
  }

/** White walls and a wooden floor in every palette, each tinted toward the palette's own wall so night stays night. */
function dress(base: Palette, seed: number): Palette {
  const [plank, seam] = WOOD[base.night ? 'night' : 'day']
  const tone = ((seed >>> 3) % 3 - 1) * (base.night ? 0.06 : 0.035)
  const wall = base.night ? blend('#f4f5f9', base.wall, 0.55) : blend('#ffffff', base.wall, 0.12)
  const wallLow = shade(wall, base.night ? -0.1 : -0.06)
  const floor = blend(plank, base.wall, 0.1)
  return {
    ...base,
    wall,
    wallLow,
    trim: shade(wallLow, base.night ? -0.28 : -0.16),
    floor: shade(floor, tone),
    seam: shade(blend(seam, base.wall, 0.1), tone)
  }
}

/** Dawn and sunset warm the room a little; the other hours leave it as the palette has it. */
function warmed(colors: Palette, period: DayPeriod): Palette {
  if (period !== 'dawn' && period !== 'sunset') return colors
  const warm = (color: string): string => blend(color, '#ffb070', colors.night ? 0.06 : 0.1)
  return { ...colors, wall: warm(colors.wall), wallLow: warm(colors.wallLow), floor: warm(colors.floor), seam: warm(colors.seam) }
}

export function lookOf(agent: AgentView): Look {
  return {
    seed: hash(agent.id),
    shirt: SHIRTS[(agent.agent ?? '').toLowerCase()] ?? '#8b93a7'
  }
}

/** What an agent goes by: the name Orca gives its workspace, else its terminal title or kind. */
export function agentName(snap: OfficeSnapshot, agent: AgentView): string {
  return (
    (agent.workspaceId && snap.workspaces[agent.workspaceId]) ||
    agent.title ||
    agent.agent ||
    'Agent'
  )
}

/** The call to show: one in flight, or one that only just returned. */
export function shown(agent: AgentView, now: number): Activity | null {
  const running =
    agent.active.filter((call) => call.kind !== 'delegate').at(-1) ?? agent.active.at(-1)
  if (running) return running
  const last = agent.recent[0]
  return last && now - (last.endedAt ?? 0) < LINGER_MS ? last : null
}

/** A strip of desks for the bosses under the workers' last row, behind a partition; `extra` is how much taller the room gets. */
export function bossSpots(
  count: number,
  workWidth: number,
  perRow: number,
  lastRow: number,
  pitch: number
): { spots: Point[]; rail: number | null; extra: number } {
  if (!count) return { spots: [], rail: null, extra: 0 }
  const columns = Math.min(perRow, count)
  const left = Math.floor((workWidth - ((columns - 1) * PITCH + DESK_W)) / 2)
  const first = lastRow + pitch + BOSS_GAP
  const spots = Array.from({ length: count }, (_, index) => ({
    x: left + (index % perRow) * PITCH,
    y: first + Math.floor(index / perRow) * pitch
  }))
  return { spots, rail: first - 31, extra: BOSS_GAP + Math.ceil(count / perRow) * pitch }
}

/** One room per project, with a persistent row of desks for its active agents. */
export function layout(
  snap: OfficeSnapshot,
  width: number,
  scale: number,
  /** Rooms the person folded (true) or unfolded (false) themselves. */
  folded: Map<string, boolean>,
  displayNames?: ReadonlyMap<string, string>,
  /** Room ids in the order to draw them; others follow by name. */
  order: readonly string[] = []
): { rooms: Room[]; height: number } {
  const byRoom = new Map<string, AgentView[]>()
  for (const agent of snap.agents) {
    const id = agent.projectId ?? agent.workspaceId ?? ''
    byRoom.set(id, [...(byRoom.get(id) ?? []), agent])
  }
  if (!byRoom.size) byRoom.set('', [])
  const nameOf = (id: string): string =>
    id
      ? (snap.projects[id] ?? snap.workspaces[id] ?? id.split(/[\\/]/).pop() ?? id)
      : snap.agents.length
        ? 'Lobby'
        : 'Office'

  const head = Math.ceil((SIGN_PX + 10) / scale)
  const label = Math.ceil((NAME_PX + 3) / scale)
  const rooms: Room[] = []
  let top = 0
  const place = (id: string): number => (order.includes(id) ? order.indexOf(id) : order.length)
  const ids = [...byRoom.keys()].sort((a, b) => place(a) - place(b) || nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b))
  for (const id of ids) {
    const agents = byRoom.get(id) ?? []
    const active = agents.filter((agent) => agent.state !== 'done').sort((a, b) => a.id.localeCompare(b.id))
    const isBoss = (agent: AgentView): boolean => displayNames?.get(agent.id) === BOSS_NAME
    const seated = active.filter((agent) => !isBoss(agent))
    const bosses = active.filter(isBoss)
    const collapsed = folded.get(id) ?? false
    const furniture = wallFurniture(width)
    const coffee = furniture.find((item) => item.name === 'coffee')!
    const workWidth = Math.max(DESK_W, coffee.left - 4)
    const perRow = Math.max(1, Math.floor((workWidth - DESK_W) / PITCH) + 1)
    const deskCount = Math.max(3, seated.length)
    const columns = Math.min(perRow, deskCount)
    const rows = Math.ceil(deskCount / perRow)
    const left = Math.floor((workWidth - ((columns - 1) * PITCH + DESK_W)) / 2)
    const floor = top + head + WALL
    const pitch = 33 + label
    const desks = Array.from({ length: deskCount }, (_, index) => ({
      x: left + (index % perRow) * PITCH,
      y: floor + DESK_TOP + Math.floor(index / perRow) * pitch
    }))
    const { spots: bossDesks, rail: bossRail, extra } = bossSpots(bosses.length, workWidth, perRow, desks.at(-1)!.y, pitch)
    const height = collapsed
      ? head
      : head + WALL + DESK_TOP + (rows - 1) * pitch + 25 + extra
    const seed = hash(id || 'lobby')
    const labels = agents.map((agent) => displayNames?.get(agent.id) ?? agentName(snap, agent))
    const decorations = decorationsFor(width, floor, furniture, seed)
    rooms.push({
      id,
      name: nameOf(id),
      top,
      head,
      floor,
      height,
      collapsed,
      agents,
      seated,
      bosses,
      bossDesks,
      bossRail,
      labels,
      desks,
      seed,
      furniture,
      decorations
    })
    top += height + GAP
  }
  return { rooms, height: top - GAP }
}

type Wanted = Omit<Actor, 'x' | 'y' | 'route' | 'moving' | 'leaving'>

export function observedActivity(agent: AgentView, now: number): ActivityIcon | null {
  if (agent.state !== 'working') return null
  if (agent.helpers.some((helper) => helper.kind === 'agent')) return 'delegate'
  const call = shown(agent, now)
  if (!call) return 'think'
  return call.kind === 'delegate' ? 'delegate' : call.kind
}

function coffeePositions(room: Room, width: number, workers: Wanted[], count: number): Point[] {
  const coffee = room.furniture.find((fixture) => fixture.name === 'coffee')!
  const positions: Point[] = []
  for (let x = 6; x <= width - 6; x += 20) positions.push({ x, y: room.floor + 18 })
  positions.sort((a, b) => Math.abs(a.x - coffee.center) - Math.abs(b.x - coffee.center) || a.x - b.x)
  const boxes = (point: Point): Array<{ left: number; right: number; top: number; bottom: number }> => [
    { left: point.x - 5, right: point.x + 5, top: point.y - 16, bottom: point.y + 1 },
    { left: point.x - 9, right: point.x + 9, top: point.y + 2, bottom: point.y + 8 }
  ]
  const intersects = (a: { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }): boolean =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const clear = (point: Point, other: Point): boolean =>
    !boxes(point).some((box) => boxes(other).some((otherBox) => intersects(box, otherBox)))
  const chosen: Point[] = []
  for (const point of positions) {
    if (Math.abs(point.x - coffee.center) > Math.max(12, width * 0.25)) continue
    const guestBoxes = boxes(point)
    const workerCollision = workers.some((actor) => {
      const workerBoxes = [
        { left: actor.goal.x - 5, right: actor.goal.x + 5, top: actor.goal.y - 16, bottom: actor.goal.y + 1 },
        { left: actor.goal.x - 16, right: actor.goal.x + 16, top: actor.goal.y + 2, bottom: actor.goal.y + 8 }
      ]
      if (actor.activity) workerBoxes.push({ left: actor.goal.x - 5, right: actor.goal.x + 5, top: actor.goal.y - 30, bottom: actor.goal.y - 20 })
      return guestBoxes.some((box) => workerBoxes.some((otherBox) => intersects(box, otherBox)))
    })
    if (workerCollision || chosen.some((other) => !clear(point, other))) continue
    chosen.push(point)
    if (chosen.length === count) break
  }
  return chosen.sort((a, b) => a.y - b.y || a.x - b.x)
}

function wantedIn(room: Room, width: number, now: number): Wanted[] {
  const entry = { x: 9, y: room.floor + 4 }
  const wanted: Wanted[] = []
  if (room.collapsed) return wanted
  const coffeeWishes = room.agents
    .filter((agent) => agent.state === 'done')
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, COFFEE)
  const seats = [
    ...room.seated.map((agent, index) => ({ agent, desk: room.desks[index] })),
    ...room.bosses.map((agent, index) => ({ agent, desk: room.bossDesks[index] }))
  ]
  seats.forEach(({ agent, desk }) => {
    const base = {
      key: agent.id,
      agentId: agent.id,
      room: room.id,
      entry,
      ...lookOf(agent)
    }
    const call = shown(agent, now)
    const activity = observedActivity(agent, now)
    const pose: Pose = agent.state === 'blocked'
      ? 'hand'
      : agent.state === 'waiting'
        ? 'idle'
        : call?.kind === 'read' || call?.kind === 'web'
          ? 'read'
          : 'type'
    wanted.push({
      ...base,
      goal: { x: desk.x + 8, y: desk.y + 5 },
      pose,
      seated: true,
      activity
    })
  })
  const positions = coffeePositions(room, width, wanted, coffeeWishes.length)
  coffeeWishes.slice(0, positions.length).forEach((agent, index) => {
    wanted.push({
      key: agent.id,
      agentId: agent.id,
      room: room.id,
      ...lookOf(agent),
      entry,
      goal: positions[index],
      pose: 'cup',
      seated: false,
      activity: null
    })
  })
  return wanted
}

/** How far apart, in office pixels, people who arrive together walk in. */
const QUEUE_GAP = 16

/** Walking path that uses the floor aisle before approaching a desk or the coffee machine. */
function routeTo(room: Room | undefined, from: Point, goal: Point): Point[] {
  if (!room) return [goal]
  const laneY = room.floor + 22
  const route: Point[] = []
  if (from.y !== laneY) route.push({ x: from.x, y: laneY })
  if (from.x !== goal.x) route.push({ x: goal.x, y: laneY })
  route.push(goal)
  return route
}

/** Moves every actor toward where its agent's state puts it; newcomers enter from the left and
 *  those whose agent is gone walk out. `jump` places them at once. Answers whether any moved. */
export function step(
  actors: Map<string, Actor>,
  rooms: Room[],
  width: number,
  now: number,
  seconds: number,
  jump: boolean
): boolean {
  const roomOf = new Map(rooms.map((room) => [room.id, room]))
  const wanted = new Map(
    rooms.flatMap((room) => wantedIn(room, width, now)).map((item) => [item.key, item])
  )
  const retarget = (actor: Actor, goal: Point): void => {
    if (actor.goal.x === goal.x && actor.goal.y === goal.y) return
    actor.goal = goal
    actor.route = routeTo(roomOf.get(actor.room), actor, goal)
  }
  // People new to a room this step queue behind its door and walk in one by one, the one going
  // furthest first, so nobody walks on top of or past another.
  const queue = new Map<string, number>()
  const newcomers = [...wanted.values()].filter((item) => !actors.has(item.key)).sort((a, b) => b.goal.x - a.goal.x)
  for (const item of newcomers) {
    const place = [...queue.keys()].filter((key) => wanted.get(key)!.room === item.room).length
    queue.set(item.key, place)
  }
  for (const [key, item] of wanted) {
    const actor = actors.get(key)
    if (actor) {
      const { goal, ...rest } = item
      Object.assign(actor, rest, { leaving: false })
      retarget(actor, goal)
    } else {
      const start = jump ? item.goal : { x: item.entry.x - (queue.get(key) ?? 0) * QUEUE_GAP, y: item.entry.y }
      const route = jump ? [] : routeTo(roomOf.get(item.room), start, item.goal)
      actors.set(key, { ...item, ...start, route, moving: false, leaving: false })
    }
  }

  let moved = false
  for (const actor of actors.values()) {
    if (!wanted.has(actor.key) && !actor.leaving) {
      Object.assign(actor, { leaving: true, activity: null, seated: false })
      retarget(actor, actor.entry)
    }
    if (jump) Object.assign(actor, actor.goal, { route: [] })
    let budget = SPEED * seconds
    actor.moving = false
    while (actor.route.length && budget > 0) {
      const next = actor.route[0]
      const far = Math.hypot(next.x - actor.x, next.y - actor.y)
      if (far <= budget) {
        Object.assign(actor, next)
        actor.route.shift()
        budget -= far
      } else {
        actor.x += ((next.x - actor.x) / far) * budget
        actor.y += ((next.y - actor.y) / far) * budget
        budget = 0
      }
      actor.moving = actor.route.length > 0
      moved = true
    }
    if (actor.leaving && !actor.route.length) actors.delete(actor.key)
  }
  return moved
}

/** The agent whose character is under an office pixel. */
export function pick(actors: Map<string, Actor>, x: number, y: number): string | null {
  let hit: Actor | null = null
  for (const actor of actors.values()) {
    if (Math.abs(x - actor.x) > 6 || y < actor.y - 18 || y > actor.y + 2) continue
    if (!hit || actor.y > hit.y) hit = actor
  }
  return hit?.agentId ?? null
}

type Stance = {
  pose: Pose
  seated: boolean
  moving: boolean
  /** Counts up four times a second; animations read it. */
  beat: number
}

/** One person, feet at (`x`, `y`). With `tint` every pixel takes that colour: an outline. */
function person(
  paint: Rect,
  x: number,
  y: number,
  look: Look,
  stance: Stance,
  tint?: string
): void {
  const rect: Rect = tint ? (rx, ry, w, h) => paint(rx, ry, w, h, tint) : paint
  const { beat } = stance
  const flip = beat % 2
  const stride = stance.moving ? flip : 0
  const left = Math.round(x) - 4
  const top = Math.round(y) - 16 - stride
  const skin = SKIN[look.seed % SKIN.length]
  const hair = HAIR[(look.seed >>> 4) % HAIR.length]
  const style = (look.seed >>> 8) % 4
  const pose = stance.moving ? 'idle' : stance.pose
  const dark = shade(look.shirt, -0.22)

  if (stance.seated && !stance.moving) rect(left - 1, top + 6, 10, 9, '#4d5674')
  else {
    rect(left + 1, top + 13, 2, 3 - stride, PANTS)
    rect(left + 5, top + 13, 2, 2 + stride, PANTS)
    rect(left + 1, top + 15 - stride, 2, 1, INK)
    rect(left + 5, top + 15, 2, 1, INK)
  }

  rect(left, top + 8, 8, 5, look.shirt)
  rect(left + 7, top + 8, 1, 5, dark)
  rect(left + 3, top + 8, 2, 1, skin)

  const lift = 0
  rect(left - 1, top + 8 - lift, 1, 4, dark)
  rect(left - 1, top + 12 - lift, 1, 1, skin)
  if (pose === 'hand') {
    rect(left + 8, top + 4, 1, 5, dark)
    rect(left + 8 + flip, top + 2, 1, 2, skin)
  } else {
    rect(left + 8, top + 8, 1, 4, dark)
    rect(left + 8, top + 12, 1, 1, skin)
  }

  rect(left + 1, top + 7, 6, 1, skin)
  rect(left, top + 2, 8, 5, skin)
  {
    rect(left + 1, top, 6, 1, hair)
    rect(left, top + 1, 8, 2, hair)
    if (style === 1) {
      rect(left, top + 3, 1, 4, hair)
      rect(left + 7, top + 3, 1, 4, hair)
    } else if (style === 2) rect(left + 1, top + 3, 3, 1, hair)
    else if (style === 3) rect(left + 3, top - 1, 2, 1, hair)
  }
  {
    // A blink now and then, each person on their own beat.
    const eyes = (beat + look.seed) % 23 === 0 ? shade(skin, -0.2) : INK
    rect(left + 2, top + 5, 1, 1, eyes)
    rect(left + 5, top + 5, 1, 1, eyes)
  }

  if (pose === 'type') {
    rect(left + 1 + flip, top + 10, 1, 1, skin)
    rect(left + 6 - flip, top + 10, 1, 1, skin)
  } else if (pose === 'read') {
    rect(left + 2, top + 8, 4, 4, '#fbfaf5')
    rect(left + 3, top + 9, 2, 1, '#b9bccb')
  } else if (pose === 'cup') {
    rect(left + 8, top + 10, 2, 2, '#ffffff')
    rect(left + 8 + flip, top + 8, 1, 1, 'rgba(255, 255, 255, 0.7)')
  }
}

/** A head-and-shoulders picture of an agent for the list, on a 14 by 14 pixel canvas. */
export function portrait(ctx: CanvasRenderingContext2D, look: Look): void {
  ctx.clearRect(0, 0, 14, 14)
  person(brush(ctx), 7, 19, look, {
    pose: 'idle',
    seated: false,
    moving: false,
    beat: 1
  })
}

function thought(rect: Rect, kind: ActivityIcon, x: number, y: number, accent: string): void {
  const ink = '#25283a'
  // Pixel cloud and tail; the icon content records activity in the roster's observed tool data.
  rect(x, y + 1, 10, 7, ink)
  rect(x + 1, y, 8, 9, ink)
  rect(x + 3, y + 8, 2, 2, ink)
  rect(x + 1, y + 1, 8, 6, '#fffdf4')
  rect(x + 3, y + 7, 2, 1, '#fffdf4')
  const dot = (dx: number, dy: number, color: string): void => rect(x + dx, y + dy, 1, 1, color)
  if (kind === 'think') {
    dot(3, 4, accent); dot(5, 4, accent); dot(7, 4, accent)
  } else if (kind === 'shell') {
    rect(x + 3, y + 2, 5, 4, '#242b3a')
    dot(4, 3, '#7fe3a1'); dot(5, 4, '#7fe3a1'); dot(6, 4, '#f1c24b')
  } else if (kind === 'web') {
    rect(x + 3, y + 2, 5, 5, '#4c91d8')
    rect(x + 4, y + 3, 3, 3, '#c8ecff')
    rect(x + 5, y + 3, 1, 3, '#4c91d8')
    rect(x + 3, y + 4, 5, 1, '#4c91d8')
  } else if (kind === 'edit') {
    dot(4, 5, '#e8915b'); dot(5, 4, '#e8915b'); dot(6, 3, '#e8915b'); dot(7, 2, '#d4a63d')
  } else if (kind === 'read') {
    rect(x + 3, y + 2, 2, 4, '#a583e6'); rect(x + 6, y + 2, 2, 4, '#5b9be8')
    rect(x + 5, y + 2, 1, 5, ink)
  } else if (kind === 'search') {
    rect(x + 3, y + 2, 4, 4, '#3fb8c9'); rect(x + 4, y + 3, 2, 2, '#fffdf4')
    dot(7, 6, ink)
  } else if (kind === 'delegate') {
    rect(x + 3, y + 2, 2, 2, '#a583e6'); rect(x + 6, y + 2, 2, 2, '#3fa58a')
    rect(x + 3, y + 5, 2, 1, '#a583e6'); rect(x + 6, y + 5, 2, 1, '#3fa58a')
  } else if (kind === 'plan') {
    rect(x + 3, y + 2, 5, 1, accent); rect(x + 3, y + 4, 5, 1, accent); rect(x + 3, y + 6, 3, 1, accent)
  } else {
    rect(x + 4, y + 2, 3, 3, accent); dot(3, 3, ink); dot(8, 5, ink)
  }
}

function drawDecoration(rect: Rect, item: Decoration, colors: Palette, accent: string): void {
  const { name, left: x, top: y, width: w, height: h } = item
  const ink = '#24283a'
  const board = colors.night ? '#eceef2' : '#ffffff'
  const fill = (dx: number, dy: number, width: number, height: number, color: string): void =>
    rect(x + dx, y + dy, width, height, color)
  if (name === 'plant') {
    // Original terracotta pot and leafy silhouette, standing on the floor.
    fill(1, 10, 5, 5, '#b5673f'); fill(0, 9, 7, 1, '#c97a4f')
    fill(3, 0, 1, 9, '#3f9a5a'); fill(0, 1, 3, 2, '#4fb56c')
    fill(4, 3, 3, 2, '#4fb56c'); fill(1, 5, 2, 2, '#4fb56c')
  } else if (name === 'noticeboard') {
    // The earlier framed whiteboard, with a tray and room-stable note pattern.
    fill(0, 0, 24, 16, colors.metal); fill(1, 1, 22, 14, board)
    fill(3, 3, 3, 3, '#f1c24b'); fill(7, 3, 3, 3, '#3e7fd8')
    const lines = ['#30a46c', '#a583e6', '#e5484d']
    lines.forEach((color, row) => fill(3, 8 + row * 2, 8 + ((item.left + row * 3) % 6), 1, color))
    fill(16, 3, 5, 5, shade(board, -0.06))
    fill(17, 5, 1, 1, '#30a46c'); fill(18, 4, 1, 1, '#30a46c')
    fill(0, 15, 24, 1, colors.metalDark); fill(17, 14, 3, 1, '#e5484d')
  } else if (name === 'server') {
    // Original six-unit rack, with dark recesses, rails and small status lights.
    fill(0, 0, 12, 22, '#1e212c'); fill(0, 0, 12, 1, '#3a3f52')
    for (let unit = 0; unit < 6; unit++) {
      const yy = 2 + unit * 3
      fill(1, yy, 10, 2, '#2c3142')
      fill(2, yy, 1, 1, unit % 2 ? '#2f6b45' : '#35414f')
      fill(4, yy, 1, 1, '#35414f'); fill(7, yy + 1, 3, 1, '#3d4459')
    }
  } else if (name === 'bookshelf') {
    fill(0, 0, w, h, colors.deskLeg); fill(1, 1, w - 2, h - 2, colors.deskFront)
    fill(0, 0, w, 1, colors.deskLight); fill(w - 2, 1, 1, h - 1, colors.deskLeg)
    fill(1, 7, w - 2, 1, colors.deskLeg); fill(1, 13, w - 2, 1, colors.deskLeg)
    const bookColors = ['#d97757', '#4f8fe6', '#e4c15a', '#6ca77c', '#a878e0']
    for (let index = 0; index < 5; index++) {
      const bookX = 2 + index * 3
      fill(bookX, 2 + index % 2, 2, 5 - index % 2, bookColors[index])
      fill(bookX, 9 + (index + 1) % 2, 2, 4 - (index + 1) % 2, bookColors[(index + 2) % bookColors.length])
    }
  } else if (name === 'clock') {
    fill(0, 0, w, h, colors.metalDark); fill(1, 1, w - 2, h - 2, '#fff5d9')
    fill(4, 2, 1, 4, ink); fill(4, 5, 3, 1, ink); fill(3, 7, 1, 1, accent)
  } else if (name === 'poster') {
    fill(0, 0, w, h, colors.frame); fill(1, 1, w - 2, h - 2, '#f7f0df')
    fill(2, 2, w - 4, 4, '#8ac3e8'); fill(2, 6, w - 4, h - 8, '#78a878')
    fill(3, 7, 4, 4, '#d7b36b'); fill(w - 6, 7, 2, h - 9, '#637755')
  } else if (name === 'painting') {
    // A gilt-framed landscape: sky, hills, a low sun.
    fill(0, 0, w, h, '#a8803f'); fill(1, 1, w - 2, h - 2, '#6e5328')
    fill(2, 2, w - 4, h - 4, colors.night ? '#6f86b8' : '#9ed0f0')
    fill(w - 7, 3, 3, 3, '#ffe9a0')
    fill(2, 7, w - 4, h - 9, '#5f9a62'); fill(2, 8, 6, 1, '#5f9a62'); fill(5, 6, 5, 2, '#5f9a62')
    fill(2, h - 4, w - 4, 2, '#417a4d'); fill(9, h - 5, 2, 1, '#417a4d')
  } else if (name === 'cooler') {
    fill(2, 0, w - 4, 5, '#8acbe5'); fill(3, 1, w - 6, 3, '#c8edf7')
    fill(1, 5, w - 2, h - 5, '#d9dce5'); fill(2, 6, w - 4, h - 8, '#aab3c4')
    fill(3, 9, 2, 2, '#4c91d8'); fill(w - 5, 9, 2, 2, '#df7575'); fill(4, h - 3, w - 8, 2, ink)
  } else {
    // A three-drawer cabinet in the same metal ramp as the original filing cabinet.
    fill(0, 0, w, h, colors.metal); fill(0, 0, w, 1, shade(colors.metal, 0.25))
    fill(w - 1, 1, 1, h - 1, colors.metalDark)
    for (let drawer = 0; drawer < 3; drawer++) {
      const yy = 3 + drawer * 5
      fill(1, yy, w - 2, 4, shade(colors.metal, -0.1))
      fill(5, yy + 1, 4, 1, colors.metalDark)
    }

  }
}

export type BubbleTone = 'need' | 'stuck' | 'failed' | 'done'
/** What one character says: `since` is when it started saying it. */
export type Bubble = { text: string; tone: BubbleTone; since: number }
export type PlacedBubble = Bubble & {
  agentId: string
  /** In office pixels, the body only; the tail hangs one pixel below. */
  left: number
  top: number
  width: number
  height: number
  /** Where the tail's two pixels start. */
  tail: number
}

/** The first line of prose in a reply, with the markdown marks taken off: fenced code is skipped,
 *  and only real markers (`#`, `>`, `- `, `* `, `+ `, `1. `) are stripped, so "-1 returned" stays. */
export function replyLine(reply: string | null): string {
  let fence = ''
  for (const line of (reply ?? '').split('\n')) {
    const trimmed = line.trim()
    const opening = /^(`{3,}|~{3,})/.exec(trimmed)?.[1]
    if (fence) {
      if (opening?.[0] === fence[0] && opening.length >= fence.length) fence = ''
      continue
    }
    if (opening) {
      // A fence closed on its own line is one short snippet; otherwise code runs until the closing fence.
      if (!trimmed.slice(opening.length).includes(opening)) fence = opening
      continue
    }
    let text = trimmed
    for (let before = ''; before !== text;) {
      before = text
      text = text.replace(/^(?:#{1,6}|>|[-*+]|\d{1,9}[.)])(?:\s+|$)/, '')
    }
    text = text.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
    // Nothing left, or only a rule such as "---".
    if (text && !/^[-_=]+$/.test(text)) return text
  }
  return ''
}

/** What an agent says over its head, if anything: needing you, then having gone quiet, then the
 *  start of its last reply for a short while after it finished. A person speaks once. */
export function bubbleFor(agent: AgentView, now: number, stuckMinutes: number): Bubble | null {
  if (agent.state === 'blocked') return { text: 'Need you!', tone: 'need', since: agent.stateStartedAt }
  const late = overdue(agent, now, stuckMinutes)
  if (late?.kind === 'quiet') return { text: 'Stuck?', tone: 'stuck', since: late.since + stuckMinutes * 60_000 }
  if (agent.state !== 'done') return null
  const since = agent.finishedAt ?? agent.stateStartedAt
  if (!(now - since < BUBBLE_MS && since - now < BUBBLE_MS)) return null
  if (agent.outcome === 'failure') return { text: 'Failed', tone: 'failed', since }
  const text = replyLine(agent.reply)
  return text ? { text, tone: 'done', since } : null
}

const segmenter = (() => {
  try {
    const Segmenter = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(text: string): Iterable<{ segment: string }> } }).Segmenter
    return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null
  } catch {
    return null
  }
})()

/** The characters a person sees, so a cut never splits an emoji or a surrogate pair. */
function glyphs(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text)
}

const fitted = new Map<string, string>()
const FITTED_MAX = 500

/** Text cut to `max` wide by `measure`, with an ellipsis when it was cut. The cut is on whole
 *  characters and found by bisection. `font` names what `measure` measures in; given, the answer is
 *  remembered, so a repaint of the same text does not measure again. */
export function fitText(text: string, max: number, measure: (text: string) => number, font?: string): string {
  const key = font === undefined ? '' : `${font}\n${max}\n${text}`
  const known = font === undefined ? undefined : fitted.get(key)
  if (known !== undefined) return known
  let result = text
  if (measure(text) > max) {
    const parts = glyphs(text)
    // The most characters that still fit with the ellipsis; one at least, however narrow.
    let low = 1
    let high = parts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (measure(`${parts.slice(0, middle).join('')}…`) > max) high = middle - 1
      else low = middle
    }
    result = `${parts.slice(0, low).join('').trimEnd()}…`
  }
  if (font !== undefined) {
    if (fitted.size >= FITTED_MAX) fitted.clear()
    fitted.set(key, result)
  }
  return result
}

const BUBBLE_RANK: Record<BubbleTone, number> = { need: 0, stuck: 1, failed: 2, done: 3 }

/** How tall a bubble is, in office pixels. */
export const bubbleHeight = (scale: number): number => Math.ceil((BUBBLE_PX + 6) / scale)
const bubblePad = (scale: number): number => 1 + Math.ceil(3 / scale)

/** Where each bubble goes: centred over its character, kept inside the room and under the sign.
 *  Bubbles that would cover a more important one slide sideways, still over their character, or
 *  are left out. `measure` gives a text's width in office pixels in the bubble font. */
export function placeBubbles(
  room: Room,
  actors: Actor[],
  bubbles: ReadonlyMap<string, Bubble>,
  width: number,
  scale: number,
  measure: (text: string) => number,
  font?: string
): PlacedBubble[] {
  const margin = 2
  const gap = 1
  const height = bubbleHeight(scale)
  const pad = bubblePad(scale)
  const widest = Math.min(width - 2 * margin, Math.max(48, Math.round(width * 0.7)), 100)
  const minTop = room.top + room.head + 2
  const placed: PlacedBubble[] = []
  const talking = actors
    .filter((actor) => actor.room === room.id && bubbles.has(actor.agentId))
    .map((actor) => ({ actor, bubble: bubbles.get(actor.agentId)! }))
    .sort((a, b) => BUBBLE_RANK[a.bubble.tone] - BUBBLE_RANK[b.bubble.tone] || a.actor.agentId.localeCompare(b.actor.agentId))
  for (const { actor, bubble } of talking) {
    // Someone still queued behind the door speaks from the doorway.
    const x = Math.min(width - margin - 4, Math.max(margin + 4, actor.x))
    const text = fitText(bubble.text, widest - 2 * pad, measure, font)
    const size = Math.min(widest, Math.ceil(measure(text)) + 2 * pad)
    const top = Math.max(minTop, Math.round(actor.y) - 19 - height)
    const centered = Math.min(width - margin - size, Math.max(margin, Math.round(x - size / 2)))
    const lefts = [centered, ...placed.flatMap((other) => [other.left - gap - size, other.left + other.width + gap])]
      // Still over the character, so the tail points at who is speaking.
      .filter((left) => left >= margin && left + size <= width - margin && x >= left + 2 && x <= left + size - 2)
      .sort((a, b) => Math.abs(a - centered) - Math.abs(b - centered))
    const left = lefts.find((candidate) =>
      !placed.some((other) =>
        candidate < other.left + other.width + gap && other.left < candidate + size + gap &&
        top < other.top + other.height + 1 + gap && other.top < top + height + 1 + gap
      )
    )
    if (left === undefined) continue
    placed.push({
      ...bubble,
      text,
      agentId: actor.agentId,
      left,
      top,
      width: size,
      height,
      tail: Math.min(left + size - 4, Math.max(left + 2, Math.round(x) - 1))
    })
  }
  return placed
}

/** The agent whose bubble is under an office pixel. */
export function pickBubble(bubbles: PlacedBubble[], x: number, y: number): string | null {
  const hit = bubbles.find((item) => x >= item.left && x < item.left + item.width && y >= item.top && y < item.top + item.height + 1)
  return hit?.agentId ?? null
}

/** The fill and text of a bubble; the state colours are the ones the panel's pills use. */
function bubbleColors(tone: BubbleTone): { fill: string; text: string } {
  if (tone === 'need') return { fill: '#ed823b', text: INK }
  if (tone === 'stuck') return { fill: '#f6c9a0', text: INK }
  if (tone === 'failed') return { fill: '#c93a3f', text: '#ffffff' }
  return { fill: '#fffdf4', text: INK }
}

function drawBubble(ctx: CanvasRenderingContext2D, rect: Rect, item: PlacedBubble, dy: number, scale: number): void {
  const { left, width, height } = item
  const top = item.top + dy
  const { fill, text } = bubbleColors(item.tone)
  const ink = '#25283a'
  rect(left + 1, top, width - 2, height, ink)
  rect(left, top + 1, width, height - 2, ink)
  rect(left + 1, top + 1, width - 2, height - 2, fill)
  rect(item.tail, top + height - 1, 2, 1, fill)
  rect(item.tail, top + height, 2, 1, ink)
  ctx.font = `600 ${BUBBLE_PX / scale}px system-ui, sans-serif`
  ctx.fillStyle = text
  // On whole screen pixels, so the letters stay sharp.
  const across = (value: number): number => Math.round(value * scale) / scale
  ctx.fillText(item.text, across(left + (width - ctx.measureText(item.text).width) / 2), across(top + height / 2 + (BUBBLE_PX * 0.36) / scale))
}

export type View = {
  width: number
  rooms: Room[]
  actors: Map<string, Actor>
  beat: number
  period: DayPeriod
  /** Screen pixels per office pixel. */
  scale: number
  colors: Palette
  /** Colours taken from Orca's theme, for what should match the rest of the panel. */
  theme: { card: string; text: string; muted: string; border: string; accent: string }
  selected: string | null
  hovered: string | null
  /** Draw each room's rounded border; off when the page puts the room in a box of its own. */
  framed?: boolean
  /** What agents say over their heads, by agent id. */
  bubbles?: ReadonlyMap<string, Bubble>
  /** Bubbles pop in and bob; off, they just stand there. */
  motion?: boolean
  now?: number
}

/** Draws the office and answers where the bubbles went, for clicks. */
export function draw(ctx: CanvasRenderingContext2D, view: View): PlacedBubble[] {
  const { width, beat, scale, theme } = view
  const rect = brush(ctx)
  const height = view.rooms.reduce((sum, room) => Math.max(sum, room.top + room.height), 0)
  ctx.clearRect(0, 0, width, height)

  /** Text cut to `max` wide, with an ellipsis when it was cut. */
  const fit = (text: string, max: number): string => fitText(text, max, (part) => ctx.measureText(part).width, ctx.font)
  const talk: PlacedBubble[] = []

  for (const room of view.rooms) {
    const { floor, top } = room
    const bottom = top + room.height
    const colors = warmed(dress(view.colors, room.seed), view.period)
    const style = room.seed >>> 11
    const fixture = (name: WallFixture['name']): WallFixture | undefined =>
      room.furniture.find((item) => item.name === name)
    const beginFixture = (item: WallFixture): void => {
      ctx.save()
      ctx.translate(item.center * (1 - item.scale), 0)
      ctx.scale(item.scale, 1)
    }
    const actors = [...view.actors.values()].filter((actor) => actor.room === room.id)
    ctx.save()
    ctx.beginPath()
    if (view.framed === false) ctx.rect(0, top, width, room.height)
    else ctx.roundRect(0, top, width, room.height, RADIUS)
    ctx.clip()

    // The sign over the room.
    rect(0, top, width, room.head, theme.card)
    const baseline = top + room.head / 2 + (SIGN_PX * 0.36) / scale
    ctx.font = `500 ${(SIGN_PX - 1) / scale}px system-ui, sans-serif`
    const count = !room.agents.length
      ? 'empty'
      : room.collapsed && room.agents.every((agent) => agent.state === 'done' && !agent.unread)
        ? `${room.agents.length} finished`
        : `${room.agents.length} agent${room.agents.length > 1 ? 's' : ''}`
    const countWidth = ctx.measureText(count).width
    ctx.fillStyle = theme.muted
    ctx.fillText(count, width - 6 - countWidth, baseline)
    ctx.font = `600 ${SIGN_PX / scale}px system-ui, sans-serif`
    ctx.fillStyle = theme.text
    ctx.fillText(fit(room.name, width - countWidth - 28), 15, baseline)
    // The fold mark: pointing down on an open room, right on a folded one.
    const mark = Math.round(top + room.head / 2)
    for (let step = 0; step < 3; step++) {
      if (room.collapsed) rect(6 + step, mark - 2 + step, 1, 5 - step * 2, theme.muted)
      else rect(5 + step, mark - 1 + step, 5 - step * 2, 1, theme.muted)
    }
    const frame = (): void => {
      ctx.restore()
      if (view.framed === false) return
      ctx.strokeStyle = theme.border
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.roundRect(0.25, top + 0.25, width - 0.5, room.height - 0.5, RADIUS)
      ctx.stroke()
    }
    if (room.collapsed) {
      frame()
      continue
    }

    // Wall and floorboards.
    rect(0, top + room.head, width, WALL, colors.wall)
    rect(0, floor - 9, width, 9, colors.wallLow)
    rect(0, floor - 10, width, 1, colors.trim)
    rect(0, floor, width, bottom - floor, colors.floor)
    for (let y = floor, board = 0; y < bottom; y += 7, board++) {
      if ((board + room.seed) % 3 === 0) rect(0, y, width, 6, shade(colors.floor, colors.night ? 0.05 : -0.035))
      rect(0, y + 6, width, 1, colors.seam)
      for (let x = (board * 13) % 29; x < width; x += 29) rect(x, y, 1, 6, colors.seam)
    }
    rect(0, floor - 2, width, 2, colors.trim)
    rect(0, floor, width, 2, colors.shadow)

    // Window: the web.
    const webFixture = fixture('web')!
    beginFixture(webFixture)
    let x = webFixture.center
    const glassWidth = WINDOW_WIDTH
    const glass = {
      x: x - Math.floor(glassWidth / 2),
      y: floor - 28,
      w: glassWidth,
      h: Math.round(glassWidth * (20 / 28))
    }
    const inGlass = (gx: number, gy: number, w: number, h: number, color: string): void => {
      const from = Math.max(gx, glass.x)
      const to = Math.min(gx + w, glass.x + glass.w)
      const top = Math.max(gy, glass.y)
      const bottom = Math.min(gy + h, glass.y + glass.h)
      if (to > from && bottom > top) rect(from, top, to - from, bottom - top, color)
    }
    rect(glass.x - 1, glass.y - 1, glass.w + 2, glass.h + 2, colors.frame)
    const sky = {
      night: ['#15203e', '#374775', '#e8e4c6'],
      dawn: ['#9b647b', '#edb388', '#ffe0aa'],
      morning: ['#64a8dc', '#c1e5fb', '#fff0a6'],
      day: ['#4d9fe0', '#c5e8ff', '#fff4ac'],
      sunset: ['#a95655', '#efad72', '#ffe0a3'],
      evening: ['#46466f', '#a97091', '#f3e0c7']
    }[view.period]
    rect(glass.x, glass.y, glass.w, glass.h, sky[0])
    const horizon = Math.floor(glass.h * 0.58)
    rect(glass.x, glass.y + horizon, glass.w, glass.h - horizon, sky[1])
    const orb = glass.x + 2 + ((style >>> 2) % Math.max(1, glass.w - 6))
    const darkHours = view.period === 'night' || view.period === 'evening'
    if (darkHours) {
      rect(orb, glass.y + 3, 4, 4, sky[2])
      if (style % 2) rect(orb + 1, glass.y + 3, 2, 3, sky[0])
      for (const [star, [sx, sy]] of [
        [2, 3],
        [6, 6],
        [10, 2],
        [4, 12],
        [23, 8]
      ].entries()) {
        if ((style + star * 5) % 4 && sx < glass.w && sy < glass.h)
          rect(glass.x + sx, glass.y + sy, 1, 1, '#dfe6ff')
      }
    } else {
      const orbY = view.period === 'dawn' || view.period === 'sunset' ? Math.max(2, glass.h - 6) : 3
      rect(orb, glass.y + orbY, Math.min(5, glass.w - (orb - glass.x)), Math.min(5, glass.h - orbY), sky[2])
      for (const [drift, cy] of [
        [0, 3],
        [20, 8]
      ]) {
        const cx = glass.x + 2 + ((Math.floor(beat / 3) + drift) % 30)
        inGlass(cx, glass.y + cy, 6, 2, '#ffffff')
        inGlass(cx + 2, glass.y + cy - 1, 3, 1, '#ffffff')
      }
    }
    if ((style >>> 4) % 2 || darkHours) {
      // Some rooms look out on the city.
      for (const [block, tall] of [5, 8, 4, 7, 6].entries()) {
        const bx = glass.x + 1 + (block * 5) % Math.max(1, glass.w - 5)
        const buildingWidth = Math.min(4, glass.x + glass.w - bx)
        const buildingHeight = Math.min(tall, glass.h)
        rect(bx, glass.y + glass.h - buildingHeight, buildingWidth, buildingHeight, darkHours ? '#101631' : '#8fa8c4')
        if (darkHours && (style + block) % 3)
          rect(bx + 1, glass.y + glass.h - tall + 2, 1, 1, '#ffd75e')
        if (darkHours && (style + block) % 2)
          rect(bx + 2, glass.y + glass.h - tall + 4, 1, 1, '#ffd75e')
      }
    }
    ctx.restore()

    // Coffee corner: finished agents.
    const coffeeFixture = fixture('coffee')!
    beginFixture(coffeeFixture)
    x = coffeeFixture.center
    rect(x - 6, floor - 21, 9, 11, '#262936')
    rect(x - 6, floor - 21, 9, 1, '#454b61')
    rect(x - 4, floor - 19, 3, 2, '#3e7fd8')
    rect(x + 1, floor - 19, 1, 1, '#e5484d')
    rect(x - 4, floor - 14, 4, 1, '#12141c')
    rect(x - 3, floor - 13, 2, 2, '#ffffff')
    if (actors.some((actor) => actor.pose === 'cup' && !actor.moving)) {
      rect(x - 3 + (beat % 2), floor - 15, 1, 1, 'rgba(255, 255, 255, 0.6)')
    }
    rect(x + 4, floor - 13, 2, 3, '#ffffff')
    rect(x + 4, floor - 12, 2, 1, '#d9dbe4')
    rect(x - 9, floor - 10, 18, 10, colors.deskFront)
    rect(x - 9, floor - 11, 18, 2, colors.deskLight)
    rect(x - 7, floor - 7, 6, 6, shade(colors.deskFront, -0.1))
    rect(x + 1, floor - 7, 6, 6, shade(colors.deskFront, -0.1))
    ctx.restore()

    // Small seeded wall accents, placed only in bounds clear of the window and coffee corner.
    for (const decoration of room.decorations) drawDecoration(rect, decoration, colors, theme.accent)

    // The door agents come in and leave by; it stands ajar while someone is at it.
    const door = doorBox(floor)
    const ajar = Boolean(view.motion) && actors.some((actor) => actor.moving && actor.x < door.right + 12)
    const wood = colors.night ? '#7a5438' : '#a8764c'
    rect(door.left - 1, door.top - 1, DOOR.width + 2, DOOR.height + 1, colors.trim)
    rect(door.left, door.top, DOOR.width, DOOR.height, ajar ? (colors.night ? '#15131c' : '#4a3c33') : wood)
    if (ajar) rect(door.left, door.top, 3, DOOR.height, wood)
    else {
      rect(door.left + 1, door.top + 2, 3, 7, shade(wood, -0.15)); rect(door.left + 6, door.top + 2, 3, 7, shade(wood, -0.15))
      rect(door.left + 1, door.top + 11, 3, 8, shade(wood, -0.15)); rect(door.left + 6, door.top + 11, 3, 8, shade(wood, -0.15))
      rect(door.left + 7, door.top + 10, 1, 2, '#e3c36a')
    }

    // Whoever speaks has no thought icon: one thing over a head at a time.
    ctx.font = `600 ${BUBBLE_PX / scale}px system-ui, sans-serif`
    const spoken = view.bubbles
      ? placeBubbles(room, actors, view.bubbles, width, scale, (text) => ctx.measureText(text).width, ctx.font)
      : []
    talk.push(...spoken)
    if (room.bossRail !== null) {
      const rail = room.bossRail
      rect(2, rail + 3, width - 4, 1, colors.shadow)
      rect(2, rail, width - 4, 3, blend(colors.wall, '#9fd0e8', 0.45))
      rect(2, rail, width - 4, 1, colors.metal)
      for (let post = 2; post < width - 2; post += 34) rect(post, rail - 1, 2, 5, colors.metalDark)
      rect(width - 4, rail - 1, 2, 5, colors.metalDark)
    }
    type Item = { y: number; paint: () => void }
    const items: Item[] = []
    const over: (() => void)[] = []
    const spots = [
      ...room.desks.map((desk, index) => ({ desk, index, owner: room.seated[index], boss: false })),
      ...room.bossDesks.map((desk, index) => ({ desk, index: room.desks.length + index, owner: room.bosses[index], boss: true }))
    ]
    spots.forEach(({ desk, index, owner, boss }) => {
      const screenOn = Boolean(owner && owner.state === 'working')
      items.push({
        y: desk.y + 9,
        paint: () => {
          const occupied = owner && actors.some((actor) => actor.key === owner.id && actor.seated && !actor.moving)
          if (!occupied) {
            rect(desk.x + 3, desk.y - 6, 10, 7, shade(colors.chair, boss ? -0.45 : -0.15))
            rect(desk.x + 4, desk.y - 5, 8, 5, boss ? shade(colors.chair, -0.3) : colors.chair)
          }
          rect(desk.x + 1, desk.y + 12, DESK_W - 2, 2, colors.shadow)
          rect(desk.x + 1, desk.y + 10, 2, 3, colors.deskLeg)
          rect(desk.x + DESK_W - 3, desk.y + 10, 2, 3, colors.deskLeg)
          rect(desk.x, desk.y, DESK_W, 6, colors.desk)
          rect(desk.x, desk.y, DESK_W, 1, colors.deskLight)
          rect(desk.x, desk.y + 6, DESK_W, 4, colors.deskFront)
          rect(desk.x, desk.y + 9, DESK_W, 1, colors.deskLeg)

          // Compact terminal; it stays lit only for a working agent at this desk.
          const lines = ['#7fd4a8', '#8fb8ff', '#f1c24b']
          if (boss) {
            // A laptop: the boss has no monitor, and a nameplate on the desk front.
            rect(desk.x + 12, desk.y - 6, 9, 6, '#1e212c')
            rect(desk.x + 13, desk.y - 5, 7, 4, screenOn ? '#16324a' : '#2c3142')
            if (screenOn) for (let line = 0; line < 2; line++) rect(desk.x + 14, desk.y - 4 + line * 2, 3 + ((line + index) % 3), 1, lines[line])
            rect(desk.x + 11, desk.y, 11, 2, colors.metal)
            rect(desk.x + 11, desk.y, 11, 1, shade(colors.metal, 0.25))
            rect(desk.x + 8, desk.y + 7, 6, 2, '#d9b45a')
          } else {
            rect(desk.x + 13, desk.y - 9, 8, 8, '#1e212c')
            rect(desk.x + 14, desk.y - 8, 6, 6, screenOn ? '#16324a' : '#2c3142')
            if (screenOn) {
              for (let line = 0; line < 3; line++) rect(desk.x + 15, desk.y - 7 + line * 2, 2 + ((line + index) % 3), 1, lines[line])
            } else rect(desk.x + 15, desk.y - 7, 2, 1, '#454b61')
            rect(desk.x + 17, desk.y - 1, 2, 2, colors.metalDark)
            rect(desk.x + 15, desk.y + 1, 6, 1, colors.metalDark)
            rect(desk.x + 2, desk.y + 2, 8, 2, colors.metal)
            rect(desk.x + 2, desk.y + 2, 8, 1, shade(colors.metal, 0.25))
          }
          const mug = MUGS[hash(`${room.id}:desk:${index}`) % MUGS.length]
          rect(desk.x + 2, desk.y + 1, 2, 3, mug)
          rect(desk.x + 2, desk.y + 1, 2, 1, shade(mug, -0.25))
        }
      })
    })

    for (const actor of actors) {
      const stance = { ...actor, beat }
      const marked = actor.agentId === view.selected || actor.agentId === view.hovered
      items.push({
        y: actor.y,
        paint: () => {
          if (!actor.seated || actor.moving) rect(actor.x - 4, actor.y - 1, 8, 2, colors.shadow)
          if (marked) {
            for (const [dx, dy] of [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1]
            ]) {
              person(rect, actor.x + dx, actor.y + dy, actor, stance, theme.accent)
            }
          }
          person(rect, actor.x, actor.y, actor, stance)
        }
      })
      const index = room.agents.findIndex((agent) => agent.id === actor.agentId)
      over.push(() => {
        ctx.font = `500 ${(actor.pose === 'cup' ? NAME_PX - 1 : NAME_PX) / scale}px system-ui, sans-serif`
        const label = fit(room.labels[index] ?? '', actor.pose === 'cup' ? 18 : PITCH - 2)
        ctx.fillStyle = marked ? theme.accent : colors.name
        ctx.fillText(label, actor.x - ctx.measureText(label).width / 2, actor.y + 7)
      })
      if (actor.activity && !spoken.some((item) => item.agentId === actor.agentId)) {
        const kind = actor.activity
        over.push(() => thought(rect, kind, Math.round(actor.x) - 5, Math.round(actor.y) - 30, theme.accent))
      }
    }
    items.sort((a, b) => a.y - b.y).forEach((item) => item.paint())
    over.forEach((paint) => paint())
    for (const item of spoken) {
      // A short pop on arrival, then a slow bob for the two that want you.
      const age = (view.now ?? 0) - item.since
      const dy = !view.motion ? 0 : age < 250 ? 2 : age < 500 ? 1 : item.tone === 'need' || item.tone === 'stuck' ? -((beat >> 1) % 2) : 0
      drawBubble(ctx, rect, item, dy, scale)
    }

    frame()
  }
  return talk
}
