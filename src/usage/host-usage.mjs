import { TaskError } from '../domain/task.mjs'
import { summarizeTaskUsage } from './task-usage.mjs'

const unavailable = () => new TaskError('NOT_FOUND', 'Task usage is not available')

/** `loadTask` authorizes the verified caller and returns the persisted record. */
export function createHostTaskUsage({ loadTask, canReadSession, workspaceRegistry, sessionQuery, lookupRate }) {
  return async function taskUsage(principal, taskId, { signal } = {}) {
    if (principal?.kind !== 'user') throw unavailable()
    const record = await loadTask(principal, taskId)
    const { task, runs } = record?.detail ?? {}
    if (task?.id !== taskId) throw unavailable()
    const { workspaceId, revision } = task
    const workspace = workspaceRegistry.get(workspaceId)
    if (!workspace) throw unavailable()
    const cwd = workspace.path

    const scopes = []
    const readBindings = []
    let missingSessions = record.pendingIntent ? 1 : 0

    async function readSession(sessionId, run, matchesHeader, afterSeq, end) {
      signal?.throwIfAborted()
      const binding = { principal, task, run, sessionId }
      if (await canReadSession(binding) !== true) return null
      let native
      try {
        native = await sessionQuery.observeSession(sessionId, { signal })
      } catch (error) {
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
        throw error
      }
      try {
        const { header, events, inheritedEventCount } = native
        if (header.id !== sessionId || header.cwd !== cwd || !matchesHeader(header) ||
            await canReadSession(binding) !== true) return null
        signal?.throwIfAborted()
        const boundary = end === undefined ? -1 : events.findIndex(event => event.time >= end)
        const scopedEvents = boundary === -1 ? events : events.slice(0, boundary)
        readBindings.push(binding)
        return { sessionId, afterSeq, inheritedEventCount, events: scopedEvents }
      } finally {
        native[Symbol.dispose]()
      }
    }

    for (const run of runs) {
      const scopeStart = record.stages?.find(stage => stage.runId === run.id)?.afterSeq
      const end = run.endedAt === null ? undefined : Date.parse(run.endedAt)
      const rootId = run.rootSessionId
      const expected = new Set(run.childSessionIds)
      if (!rootId || !Number.isSafeInteger(scopeStart) || scopeStart < -1 ||
          (end !== undefined && !Number.isFinite(end)) || !workspace.sessionIds.includes(rootId)) {
        missingSessions += 1 + expected.size
        continue
      }
      const root = await readSession(rootId, run, header => header.origin === undefined &&
        header.parentSession === undefined && header.isSeeded === false, scopeStart, end)
      if (root === null) {
        missingSessions += 1 + expected.size
        continue
      }

      const verified = [root]
      const seen = new Set([rootId])
      const unreadable = new Set(expected)
      // Only an already verified parent can authorize discovery of the next level.
      for (const parent of verified) {
        for (const { type, seq, data } of parent.events) {
          if (type !== 'subagent/catalog' || seq <= parent.afterSeq || seq < parent.inheritedEventCount) continue
          const { childId, childCreatedAt, mode } = data
          if (seen.has(childId)) continue
          seen.add(childId)
          unreadable.add(childId)
          if (!expected.has(childId) || mode === 'external') continue
          const child = await readSession(childId, run, header => header.origin === 'subagent' &&
            header.parentSession === parent.sessionId && header.createdAt === childCreatedAt, -1, end)
          if (child === null) continue
          unreadable.delete(childId)
          verified.push(child)
        }
      }
      for (const scope of verified) scopes.push(scope)
      missingSessions += unreadable.size
    }

    for (const binding of readBindings) {
      if (await canReadSession(binding) !== true) throw unavailable()
    }
    const current = await loadTask(principal, taskId)
    if (current?.detail.task.id !== taskId) throw unavailable()
    if (current.detail.task.revision !== revision) {
      throw new TaskError('REVISION_CONFLICT', 'Task changed while reading usage')
    }
    signal?.throwIfAborted()
    const currentWorkspace = workspaceRegistry.get(workspaceId)
    if (currentWorkspace?.path !== cwd || readBindings.some(binding => binding.sessionId === binding.run.rootSessionId &&
        !currentWorkspace.sessionIds.includes(binding.sessionId))) throw unavailable()
    return summarizeTaskUsage({ taskId, sessions: scopes, missingSessions, lookupRate })
  }
}
