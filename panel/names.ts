import type { AgentView } from '../src/protocol'

export const BOSS_NAME = 'MR.Boss'

const FRIENDLY_NAMES = [
  'Alejandro', 'Beatriz', 'Carlos', 'Daniela', 'Emiliano', 'Fernanda', 'Gael', 'Hugo', 'Ximena', 'Jorge',
  'Karla', 'Luis', 'Mariana', 'Nicolás', 'Octavio', 'Paola', 'Rodrigo', 'Sofía', 'Tomás', 'Valeria',
  'Xóchitl', 'Yolanda', 'Zoe', 'Andrés', 'Brenda', 'César', 'Diego', 'Elena', 'Francisco', 'Guadalupe',
  'Héctor', 'Isabel', 'Javier', 'Lupita', 'Miguel', 'Natalia', 'Óscar', 'Patricia', 'Ricardo', 'Sergio',
  'Tania', 'Ulises', 'Verónica', 'Adriana', 'Bruno', 'Camila', 'Dante', 'Esperanza', 'Fabián', 'Gloria'
]

const hash = (text: string): number => {
  let value = 2166136261
  for (let index = 0; index < text.length; index++)
    value = Math.imul(value ^ text.charCodeAt(index), 16777619)
  return value >>> 0
}

export function readAgentNames(value: unknown): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map()
  return new Map(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

/** Agents that others report as their parent, by the same links the Activity org chart draws. */
export function coordinatorIds(agents: readonly AgentView[]): Set<string> {
  const listed = new Set(agents.map((agent) => agent.id))
  const bosses = new Set<string>()
  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && listed.has(agent.parentId)) bosses.add(agent.parentId)
    if ((agent.family ?? []).some((child) => child.kind === 'agent' && child.id !== agent.id && listed.has(child.id))) bosses.add(agent.id)
  }
  return bosses
}

/** Keeps active agents stable and releases departed names for the next arrivals. */
export function assignAgentNames(
  agentIds: readonly string[],
  previous: ReadonlyMap<string, string> = new Map(),
  bossIds: ReadonlySet<string> = new Set()
): Map<string, string> {
  const names = new Map<string, string>()
  const used = new Set<string>()
  const active = new Set(agentIds)
  for (const id of bossIds) if (active.has(id)) names.set(id, BOSS_NAME)
  for (const [id, name] of [...previous].sort(([left], [right]) => left.localeCompare(right))) {
    if (active.has(id) && !names.has(id) && name !== BOSS_NAME && !used.has(name)) {
      names.set(id, name)
      used.add(name)
    }
  }
  for (const id of [...new Set(agentIds)].sort()) {
    if (names.has(id)) continue
    const start = hash(id) % FRIENDLY_NAMES.length
    let name = ''
    for (let offset = 0; offset < FRIENDLY_NAMES.length; offset++) {
      const candidate = FRIENDLY_NAMES[(start + offset) % FRIENDLY_NAMES.length]
      if (!used.has(candidate)) {
        name = candidate
        break
      }
    }
    if (!name) {
      const base = FRIENDLY_NAMES[start]
      let suffix = 2
      name = `${base} ${suffix}`
      while (used.has(name)) name = `${base} ${++suffix}`
    }
    used.add(name)
    names.set(id, name)
  }
  return names
}
