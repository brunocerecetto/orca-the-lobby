// Orchestration facts the host API does not carry: derived from `orca orchestration inbox`.
import type { TerminalRow } from './actions'
import type { AgentView } from './protocol'

/** The fields used of one inbox row. */
export type InboxRow = {
  id: string
  type: string
  to_handle: string
  run_id: string | null
  created_at: number | null
  thread_id: string | null
  read: number
  sender_pane_key: string | null
  from_handle: string | null
  payload: string | null
}

/** One running worker: its dispatch and the terminal it runs in. */
export type WorkerRow = { dispatchId: string; terminal: string }

/** What turns a message's sender into a terminal: Orca's terminals and its workers. */
export type SenderLinks = { terminals: readonly TerminalRow[]; workers: readonly WorkerRow[] }

export type OrchestrationFacts = { pendingQuestion?: boolean; questionSince?: number; unreadMail?: number; mailSince?: number }

type Listed = Pick<AgentView, 'id' | 'paneKey' | 'parentId'> & { family?: AgentView['family']; terminalId?: AgentView['terminalId'] }

/** Whether anyone listed leads someone listed; with no coordinator the inbox has nothing to attribute. */
export const hasCoordinator = (agents: readonly Listed[]): boolean => {
  const listed = new Set(agents.map((agent) => agent.id))
  return agents.some((agent) =>
    (agent.parentId && agent.parentId !== agent.id && listed.has(agent.parentId)) ||
    (agent.family ?? []).some((child) => child.kind === 'agent' && child.id !== agent.id && listed.has(child.id)))
}

export function parseInbox(output: string | null): InboxRow[] | null {
  try {
    const answer = output === null ? null : JSON.parse(output)
    const rows: unknown = answer?.result?.messages
    if (answer?.ok === false || !Array.isArray(rows)) return null
    return rows.filter((row): row is InboxRow =>
      !!row && typeof row === 'object' && typeof row.id === 'string' && typeof row.type === 'string' &&
      typeof row.to_handle === 'string' &&
      (row.sender_pane_key === null || row.sender_pane_key === undefined || typeof row.sender_pane_key === 'string')
    ).map((row) => {
      const created = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN
      return {
        ...row,
        run_id: typeof row.run_id === 'string' ? row.run_id : null,
        created_at: Number.isFinite(created) ? created : null,
        thread_id: row.thread_id ?? null,
        sender_pane_key: row.sender_pane_key ?? null,
        from_handle: typeof row.from_handle === 'string' ? row.from_handle : null,
        payload: typeof row.payload === 'string' ? row.payload : null,
        read: row.read ? 1 : 0
      }
    })
  } catch {
    return null
  }
}

export function parseWorkers(output: string | null): WorkerRow[] | null {
  try {
    const rows: unknown = output === null ? null : JSON.parse(output)?.result?.workers
    if (!Array.isArray(rows)) return null
    return rows.flatMap((row): WorkerRow[] =>
      typeof row?.dispatchId === 'string' && typeof row.terminal === 'string'
        ? [{ dispatchId: row.dispatchId, terminal: row.terminal }]
        : [])
  } catch {
    return null
  }
}

/** A question is answered when another row replies in its thread: a question's own `thread_id` is its
 *  id, and the coordinator's `reply` carries that id too. */
const isAnswered = (question: InboxRow, rows: readonly InboxRow[]): boolean =>
  rows.some((row) => row.id !== question.id && row.thread_id === question.id)

const dispatchOf = (row: InboxRow): string | undefined => {
  if (row.from_handle?.startsWith('dispatch:')) return row.from_handle.slice('dispatch:'.length)
  try {
    const id: unknown = row.payload === null ? null : JSON.parse(row.payload)?.dispatchId
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/** The agent that sent a row: by its pane key, else its terminal handle, else the terminal of the
 *  worker its dispatch started. */
const senderResolver = (agents: readonly Listed[], links: SenderLinks) => {
  const byPane = new Map(agents.flatMap((agent) => agent.paneKey ? [[agent.paneKey, agent] as const] : []))
  const byTerminal = (handle: string): Listed | undefined => {
    const paneKey = links.terminals.find((terminal) => terminal.handle === handle)?.paneKey
    return paneKey === undefined ? undefined : agents.find((agent) => agent.terminalId === handle || agent.paneKey === paneKey)
  }
  return (row: InboxRow): Listed | undefined => {
    if (row.sender_pane_key) return byPane.get(row.sender_pane_key)
    if (row.from_handle?.startsWith('term_')) return byTerminal(row.from_handle)
    const dispatchId = dispatchOf(row)
    const worker = dispatchId ? links.workers.find((candidate) => candidate.dispatchId === dispatchId) : undefined
    return worker ? byTerminal(worker.terminal) : undefined
  }
}

/** The coordinator of each run: whoever wrote to the run's workers' dispatches. */
const coordinatorsByRun = (rows: readonly InboxRow[], senderOf: (row: InboxRow) => Listed | undefined): Map<string, string> => {
  const byRun = new Map<string, string>()
  for (const row of rows) {
    if (!row.run_id || byRun.has(row.run_id) || !row.to_handle.startsWith('dispatch:') || row.from_handle?.startsWith('run:')) continue
    const boss = senderOf(row)
    if (boss) byRun.set(row.run_id, boss.id)
  }
  return byRun
}

/** By agent id: who has a question nobody answered, and which coordinators hold unread mail. */
export function orchestrationFacts(
  rows: readonly InboxRow[] | null,
  agents: readonly Listed[],
  links: SenderLinks = { terminals: [], workers: [] }
): Map<string, OrchestrationFacts> {
  const facts = new Map<string, OrchestrationFacts>()
  if (!rows) return facts
  const senderOf = senderResolver(agents, links)
  const byRun = coordinatorsByRun(rows, senderOf)
  const latest = (was: number | undefined, at: number | null): number | undefined =>
    at === null ? was : Math.max(was ?? at, at)
  const touch = (id: string): OrchestrationFacts => {
    const fact = facts.get(id) ?? {}
    facts.set(id, fact)
    return fact
  }
  for (const row of rows) {
    const sender = senderOf(row)
    if (!sender) continue
    if (row.type === 'question' && !isAnswered(row, rows)) {
      const fact = touch(sender.id)
      fact.pendingQuestion = true
      fact.questionSince = latest(fact.questionSince, row.created_at)
    }
    if (row.read === 0 && row.to_handle.startsWith('run:')) {
      const bossId = sender.parentId ?? (row.run_id ? byRun.get(row.run_id) : undefined)
      if (!bossId) continue
      const boss = touch(bossId)
      boss.unreadMail = (boss.unreadMail ?? 0) + 1
      boss.mailSince = latest(boss.mailSince, row.created_at)
    }
  }
  return facts
}
