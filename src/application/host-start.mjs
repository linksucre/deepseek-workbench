import { TaskError } from '../domain/task.mjs'
import { observeBoundRootSession } from '../harness/session-observation.mjs'

const reconcile = () => new TaskError('RECONCILIATION_REQUIRED', 'Native startup requires verification')

export function createHostStart({ app, repository, workspaceRegistry, sessionController, sessionQuery }) {
  const preset = 'task-collaborator'
  let queue = Promise.resolve()
  // Single profile owner. Serialize across tasks as native session claims
  // span more than one task key.
  function exclusive(action) {
    const work = queue.then(action)
    queue = work.catch(() => {})
    return work
  }

  async function lookup(sessionId) {
    try { return await sessionQuery.observeSession(sessionId) }
    catch (err) {
      if (err?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
      throw err
    }
  }

  function command(input, detail) {
    return { taskId: input.taskId, requestId: input.requestId, expectedRevision: detail.task.revision }
  }

  function ownReceipt(record, principal, input, operation) {
    return record.operations.find(receipt => receipt.actorId === `user:${principal.actorId}` &&
      receipt.operation === operation && receipt.requestId === input.requestId)
  }

  async function finish(principal, input, detail, intent, allowRepair) {
    const sessionId = intent.reservedSessionId
    const workspace = workspaceRegistry.get(intent.workspaceId)
    if (!workspace || intent.receipt?.sessionId !== sessionId || intent.receipt.workspaceId !== workspace.id) throw reconcile()
    const ownedElsewhere = workspaceRegistry.list().some(row => row.id !== workspace.id && row.sessionIds.includes(sessionId))
    const boundElsewhere = (await repository.exportSnapshot()).some(({ key, record }) =>
      key !== input.taskId && record.detail.runs.some(run => run.rootSessionId === sessionId))
    if (ownedElsewhere || boundElsewhere) throw reconcile()

    const native = await lookup(sessionId)
    if (!native) throw reconcile()
    try {
      const { header, events } = native
      const validRoot = header.id === sessionId && header.cwd === workspace.path &&
        header.origin === undefined && header.parentSession === undefined && !header.isSeeded &&
        header.agentPreset === intent.agentPreset && !events.some(event => event.type === 'turn/start')
      if (!validRoot) throw reconcile()
    } finally {
      native[Symbol.dispose]()
    }

    if (!workspace.sessionIds.includes(sessionId)) {
      if (!allowRepair) return detail
      await workspace.attachSession(sessionId)
    }
    // Re-observe membership and lineage after attachment has finished.
    const confirmed = await observeBoundRootSession({
      workspaceRegistry, sessionQuery,
      allows: async target => {
        const visible = await app.get(principal, input.taskId)
        return visible.task.workspaceId === workspace.id &&
          target.id === (target.kind === 'workspace' ? workspace.id : sessionId)
      },
    }, { workspaceId: workspace.id, sessionId })
    if (!confirmed) throw reconcile()
    try {
      if (confirmed.header.agentPreset !== intent.agentPreset ||
          confirmed.events.some(event => event.type === 'turn/start')) throw reconcile()
      return await app.bindConfirmedRun(principal, command(input, detail), {
        intentId: intent.intentId, sessionId, workspaceId: workspace.id,
        agentPreset: intent.agentPreset, afterSeq: confirmed.events.at(-1)?.seq ?? -1,
      }, allowRepair ? 'task.reconcile.bind' : 'task.start.bind')
    } finally {
      confirmed[Symbol.dispose]()
    }
  }

  return {
    start(principal, input) {
      return exclusive(async () => {
        const before = await app.get(principal, input.taskId)
        const wasPending = repository.read(input.taskId).pendingIntent !== null
        const reserved = await app.reserveStart(principal, input, { agentPreset: preset })
        // A replay never launches another native command, even if the original
        // result was lost after reservation and before the native request.
        if (wasPending || before.task.status !== 'ready' || before.task.revision !== input.expectedRevision) {
          const persisted = repository.read(input.taskId)
          return ownReceipt(persisted, principal, input, 'task.start.bind')?.result ??
            ownReceipt(persisted, principal, input, 'task.start.receipt')?.result ?? reserved
        }
        const record = repository.read(input.taskId)
        const { pendingIntent: intent } = record
        if (!intent || intent.receipt) return record.detail
        const existing = await lookup(intent.reservedSessionId)
        if (existing) {
          existing[Symbol.dispose]()
          throw reconcile()
        }
        let receipt
        try {
          const created = await sessionController.create({
            workspaceId: intent.workspaceId, sessionId: intent.reservedSessionId, agentPreset: preset,
          })
          if (created.sessionId !== intent.reservedSessionId || created.agentPreset !== preset) throw reconcile()
          receipt = { sessionId: created.sessionId, workspaceId: intent.workspaceId, outcome: 'created' }
        } catch (err) {
          if (err?.isDSHRemoteError !== true || err.code !== 'session/workspace-attach-failed' ||
              err.details?.sessionId !== intent.reservedSessionId || err.details?.workspaceId !== intent.workspaceId) {
            throw reconcile()
          }
          receipt = { ...err.details, outcome: 'attach-failed' }
        }
        const updated = await app.saveNativeReceipt(principal, command(input, record.detail), { ...receipt, intentId: intent.intentId })
        if (receipt.outcome === 'attach-failed') return updated
        return finish(principal, input, updated, repository.read(input.taskId).pendingIntent, false)
      })
    },

    reconcile(principal, input) {
      return exclusive(async () => {
        if (input.action === 'discard-intent') return app.discardStart(principal, input)
        const detail = await app.get(principal, input.taskId)
        const record = repository.read(input.taskId)
        const replay = ownReceipt(record, principal, input, 'task.reconcile.bind')
        if (replay) {
          const root = replay.result.runs.find(item => item.id === replay.result.task.activeRunId)?.rootSessionId
          if (root !== input.rootSessionId || replay.result.task.revision !== input.expectedRevision + 1) throw reconcile()
          return replay.result
        }
        if (detail.task.revision !== input.expectedRevision) throw new TaskError('REVISION_CONFLICT', 'Task revision changed')
        const intent = record.pendingIntent
        if (!intent || input.rootSessionId !== intent.reservedSessionId) throw reconcile()
        return finish(principal, input, detail, intent, true)
      })
    },
  }
}
