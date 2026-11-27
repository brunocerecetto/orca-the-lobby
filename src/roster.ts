// The CLI supplies Orca's cross-worktree sidebar list (`orca worktree ps --json`; host
// `agents.list` covers only the focused workspace) and each workspace's Git change count. Without
// the CLI the office falls back to what events and hooks tell it.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { listArgs, parseOutcome, parseTerminals, sendArgs, switchArgs, type TerminalRow } from './actions'
import type { RosterWorktree } from './office'
import { parseInbox, parseWorkers, type InboxRow, type WorkerRow } from './orchestration'
import type { Change } from './protocol'

const ENVIRONMENT_PREFIX = 'environment:'

export function environmentTarget(key: string | null | undefined): { id: string; value: string } | null {
  if (!key?.startsWith(ENVIRONMENT_PREFIX)) return null
  try {
    const pair: unknown = JSON.parse(key.slice(ENVIRONMENT_PREFIX.length))
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      return { id: pair[0], value: pair[1] }
    }
  } catch {
    return null
  }
  return null
}

const environmentArgs = (id?: string): string[] => id ? ['--environment', id] : []

/** The app's bundled CLI on Windows and macOS, or the CLI on the PATH. */
const ORCA = process.platform === 'win32'
  ? [`${process.execPath.replace(/[\\/][^\\/]+$/, '')}\\resources\\bin\\orca.exe`, 'orca.exe']
  : process.execPath.includes('/Contents/')
    ? [process.execPath.replace(/\/Contents\/.*$/, '/Contents/Resources/bin/orca'), 'orca']
    : ['orca']

// Orca's Windows worker omits APPDATA, but its CLI needs it to locate the desktop profile.
const cliEnv = process.platform === 'win32' && !process.env.APPDATA
  ? { ...process.env, APPDATA: `${homedir()}\\AppData\\Roaming` }
  : undefined

/** A program's output, or null when it failed, timed out or is not there. */
function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 16 << 20 }, (error, stdout) =>
      resolve(error ? null : stdout)
    )
  })
}

/** What an Orca command printed, also when it failed (the CLI explains a refusal as JSON on stdout);
 *  null when Orca could not be run or did not answer. The next way of reaching Orca is tried only
 *  when the first is not installed: once a command has run, running it again could type twice. */
async function ask(args: string[]): Promise<string | null> {
  for (const command of ORCA) {
    const { output, missing } = await new Promise<{ output: string | null; missing: boolean }>((resolve) => {
      execFile(command, args, { timeout: 10000, maxBuffer: 16 << 20, env: cliEnv }, (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code
        resolve({ output: stdout || (error ? null : ''), missing: code === 'ENOENT' })
      })
    })
    if (!missing) return output
  }
  return null
}

/** ` 3 files changed, 120 insertions(+), 30 deletions(-)`, as git prints it; empty when clean. */
export function parseShortstat(text: string): Change {
  const count = (word: string): number => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0)
  return { files: count('file'), added: count('insertion'), removed: count('deletion') }
}

function resultArray(output: string | null, key: 'hosts' | 'worktrees'): unknown[] | null {
  try {
    const answer = output === null ? null : JSON.parse(output)
    const rows = answer?.result?.[key]
    return answer?.ok !== false && Array.isArray(rows) ? rows : null
  } catch {
    return null
  }
}

function withHostName(row: RosterWorktree, name: string): RosterWorktree {
  return { ...row, hostId: row.hostId || 'local', hostName: name, repo: `${row.repo || row.displayName || row.path} · ${name}` }
}

/** The desktop roster includes SSH worktrees, but paired servers need their own query. */
export function createRoster(read: (args: string[]) => Promise<string | null>) {
  let environments: { id: string; name: string }[] = []
  let hostNames = new Map<string, string>()
  const args = ['worktree', 'ps', '--json', '--limit', '200']

  return async (): Promise<RosterWorktree[] | null> => {
    const [local, discovery] = await Promise.all([read(args), read(['host', 'list', '--json'])])
    const localRows = resultArray(local, 'worktrees') as RosterWorktree[] | null
    // Never serve stale local rows: the worker also checks this roster before typing.
    if (!localRows) return null
    const hosts = resultArray(discovery, 'hosts')
    if (hosts) {
      hostNames = new Map(hosts.flatMap((host): [string, string][] =>
        host && typeof host === 'object' && 'id' in host && typeof host.id === 'string' &&
        'name' in host && typeof host.name === 'string'
          ? [[host.id, host.name]]
          : []
      ))
      environments = hosts.flatMap((host): { id: string; name: string }[] =>
        host && typeof host === 'object' && 'kind' in host && host.kind === 'environment' &&
        'id' in host && typeof host.id === 'string' && host.id
          ? [{ id: host.id, name: 'name' in host && typeof host.name === 'string' && host.name ? host.name : host.id }]
          : []
      )
    }

    const remoteRows = await Promise.all(environments.map(async ({ id, name }) => {
      const output = await read([...args, '--environment', id])
      const rows = resultArray(output, 'worktrees') as RosterWorktree[] | null
      // Only live observations belong in the roster; stale working rows cause false alerts.
      if (!rows) return []
      const key = (value: string): string => `${ENVIRONMENT_PREFIX}${JSON.stringify([id, value])}`
      const qualified = rows.filter((row) => typeof row?.path === 'string').map((row) => ({
        ...withHostName(row, name),
        hostId: id,
        path: key(row.path),
        repoId: key(row.repoId ?? row.path),
        agents: row.agents?.filter((agent) => typeof agent?.paneKey === 'string').map((agent) => ({
          ...agent,
          paneKey: key(agent.paneKey),
          parentPaneKey: agent.parentPaneKey ? key(agent.parentPaneKey) : agent.parentPaneKey
        }))
      }))
      return qualified
    }))
    const namedLocalRows = localRows.map((row) => {
      const hostId = row.hostId || 'local'
      return withHostName(row, hostId === 'local' ? 'local' : hostNames.get(hostId) ?? hostId)
    })
    return [...namedLocalRows, ...remoteRows.flat()]
  }
}

/** Tests replace these, so they never run a real program. */
export const cli = {
  /** Orca's worktrees with their agents, or null when Orca cannot be asked. */
  roster: createRoster(ask),
  /** Orca's repos in its sidebar's order, or null when Orca cannot be asked. */
  repos: async (): Promise<{ id?: unknown; path?: unknown }[] | null> => {
    try {
      const repos = JSON.parse((await ask(['repo', 'list', '--json'])) ?? '')?.result?.repos
      return Array.isArray(repos) ? repos : null
    } catch {
      return null
    }
  },
  /** Orchestration mail, read-only (`check` would mark it read); null when Orca cannot be asked. */
  inbox: async (): Promise<InboxRow[] | null> =>
    parseInbox(await ask(['orchestration', 'inbox', '--json', '--full', '--limit', '200'])),
  /** The workers Orca's runs dispatched, read-only; null when Orca cannot be asked. */
  workers: async (): Promise<WorkerRow[] | null> =>
    parseWorkers(await ask(['orchestration', 'worker-list', '--json'])),
  /** The live terminals Orca manages, or null when Orca cannot be asked. */
  terminals: async (environment?: string): Promise<TerminalRow[] | null> =>
    parseTerminals(await ask([...listArgs, ...environmentArgs(environment)])),
  /** Brings a terminal's tab to the front in Orca. */
  switchTo: async (handle: string, environment?: string) =>
    parseOutcome(await ask([...switchArgs(handle), ...environmentArgs(environment)]), 'switch'),
  activateWorkspace: async (path: string, environment: string) =>
    parseOutcome(await ask(['worktree', 'activate', '--worktree', `path:${path}`, '--json', ...environmentArgs(environment)]), 'switch'),
  /** Types text into a terminal and presses Enter; Orca submits it to an agent as a pasted prompt. */
  send: async (handle: string, text: string) => parseOutcome(await ask(sendArgs(handle, text)), 'send'),
  /** What is uncommitted in a workspace, or null when it is not a Git checkout. */
  changes: async (path: string): Promise<Change | null> => {
    if (path.startsWith(ENVIRONMENT_PREFIX)) return null
    const output = await run('git', ['-C', path, 'diff', '--shortstat', 'HEAD'])
    return output === null ? null : parseShortstat(output)
  }
}
