// Orchestration facts the host API does not carry: derived from `orca orchestration inbox`.
import type { AgentView } from './protocol'

/** The fields used of one inbox row. */
export type InboxRow = {
  id: string
  type: string
  to_handle: string
  thread_id: string | null
  read: number
  sender_pane_key: string | null
}

export type OrchestrationFacts = { pendingQuestion?: boolean; unreadMail?: number }

export function parseInbox(output: string | null): InboxRow[] | null {
  try {
    const answer = output === null ? null : JSON.parse(output)
    const rows: unknown = answer?.result?.messages
    if (answer?.ok === false || !Array.isArray(rows)) return null
    return rows.filter((row): row is InboxRow =>
      !!row && typeof row === 'object' && typeof row.id === 'string' && typeof row.type === 'string' &&
      typeof row.to_handle === 'string' &&
      (row.sender_pane_key === null || row.sender_pane_key === undefined || typeof row.sender_pane_key === 'string')
    ).map((row) => ({ ...row, thread_id: row.thread_id ?? null, sender_pane_key: row.sender_pane_key ?? null, read: row.read ? 1 : 0 }))
  } catch {
    return null
  }
}

/** A question is answered when some other row replies in its thread (`thread_id` is the question's id).
 *  Assumed from the schema, not yet seen on a real reply: change only this line if the link differs. */
const isAnswered = (question: InboxRow, rows: readonly InboxRow[]): boolean =>
  rows.some((row) => row.thread_id === question.id)

/** By agent id: who has a question nobody answered, and which coordinators hold unread mail. */
export function orchestrationFacts(
  rows: readonly InboxRow[] | null,
  agents: readonly Pick<AgentView, 'id' | 'paneKey' | 'parentId'>[]
): Map<string, OrchestrationFacts> {
  const facts = new Map<string, OrchestrationFacts>()
  if (!rows) return facts
  const byPane = new Map(agents.flatMap((agent) => agent.paneKey ? [[agent.paneKey, agent] as const] : []))
  const touch = (id: string): OrchestrationFacts => {
    const fact = facts.get(id) ?? {}
    facts.set(id, fact)
    return fact
  }
  for (const row of rows) {
    const sender = row.sender_pane_key ? byPane.get(row.sender_pane_key) : undefined
    if (!sender) continue
    if (row.type === 'question' && !isAnswered(row, rows)) touch(sender.id).pendingQuestion = true
    if (row.read === 0 && row.to_handle.startsWith('run:') && sender.parentId) {
      const boss = touch(sender.parentId)
      boss.unreadMail = (boss.unreadMail ?? 0) + 1
    }
  }
  return facts
}
