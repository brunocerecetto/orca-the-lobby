// Orchestration facts the host API does not carry: derived from `orca orchestration inbox`.
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
}

export type OrchestrationFacts = { pendingQuestion?: boolean; questionSince?: number; unreadMail?: number; mailSince?: number }

type Listed = Pick<AgentView, 'id' | 'paneKey' | 'parentId'> & { family?: AgentView['family'] }

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
        read: row.read ? 1 : 0
      }
    })
  } catch {
    return null
  }
}

/** A question is answered when some other row replies in its thread (`thread_id` is the question's id).
 *  Assumed from the schema, not yet seen on a real reply: change only this line if the link differs. */
const isAnswered = (question: InboxRow, rows: readonly InboxRow[]): boolean =>
  rows.some((row) => row.thread_id === question.id)

/** The coordinator of each run: whoever wrote to the run's workers' dispatches. */
const coordinatorsByRun = (rows: readonly InboxRow[], byPane: ReadonlyMap<string, Listed>): Map<string, string> => {
  const byRun = new Map<string, string>()
  for (const row of rows) {
    const boss = row.run_id && row.sender_pane_key && row.to_handle.startsWith('dispatch:') ? byPane.get(row.sender_pane_key) : undefined
    if (boss && row.run_id && !byRun.has(row.run_id)) byRun.set(row.run_id, boss.id)
  }
  return byRun
}

/** By agent id: who has a question nobody answered, and which coordinators hold unread mail. */
export function orchestrationFacts(
  rows: readonly InboxRow[] | null,
  agents: readonly Listed[]
): Map<string, OrchestrationFacts> {
  const facts = new Map<string, OrchestrationFacts>()
  if (!rows) return facts
  const byPane = new Map(agents.flatMap((agent) => agent.paneKey ? [[agent.paneKey, agent] as const] : []))
  const byRun = coordinatorsByRun(rows, byPane)
  const latest = (was: number | undefined, at: number | null): number | undefined =>
    at === null ? was : Math.max(was ?? at, at)
  const touch = (id: string): OrchestrationFacts => {
    const fact = facts.get(id) ?? {}
    facts.set(id, fact)
    return fact
  }
  for (const row of rows) {
    const sender = row.sender_pane_key ? byPane.get(row.sender_pane_key) : undefined
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
