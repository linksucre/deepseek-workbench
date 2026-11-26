import { randomUUID } from 'node:crypto'
import { createHostDelivery } from '../delivery/host-delivery.mjs'
import { TaskError } from '../domain/task.mjs'

/** Delivery policy for the local single-owner profile. */
export function createHostReview(ctx, { owner, isBoundCaller, checkArtifacts }) {
  const native = createHostDelivery({
    checkArtifacts,
    sessionQuery: ctx.sessionQuery,
    workspaceRegistry: ctx.workspaceRegistry,
    canUseWorkspace: ({ principal, task }) => principal === owner || isBoundCaller(principal, task.workspaceId),
    // The native delivery adapter constrains owner and bound-agent reads to
    // regular, verified files in the registered local workspace.
    canReadFile: ({ principal, task }) => principal === owner || isBoundCaller(principal, task.workspaceId),
  })
  function deliveryStage(record) {
    const runId = record.detail.task.activeRunId
    const stage = record.stages.find(item => item.runId === runId)
    if (!stage) throw new TaskError('INVALID_TRANSITION', 'No active delivery stage')
    const submissions = record.detail.submissions.filter(item => item.runId === runId)
    const previous = new Set(submissions.flatMap(item => item.artifactIds))
    let afterSeq = Math.max(stage.afterSeq, stage.deliveryAfterSeq ?? -1)
    for (const artifact of record.detail.artifacts) {
      if (!previous.has(artifact.id) || artifact.source.kind !== 'session-event') continue
      const [, seq] = JSON.parse(artifact.source.locator)
      if (Number.isSafeInteger(seq)) afterSeq = Math.max(afterSeq, seq)
    }
    return { stage, afterSeq, submissions }
  }

  return {
    resolve({ record, principal, input, now }) {
      const { stage, afterSeq, submissions } = deliveryStage(record)
      const submissionIds = new Set(submissions.map(item => item.id))
      const legacyReturn = stage.deliveryAfterSeq === undefined && record.detail.decisions.findLast(item =>
        item.verdict === 'return' && submissionIds.has(item.submissionId))
      return native.resolveSubmission({
        record, principal, afterSeq, selection: input.selection, now, newArtifactId: randomUUID,
        legacyReturnedAt: legacyReturn ? Date.parse(legacyReturn.decidedAt) : undefined,
      })
    },
    async observeReturn(input) {
      const { afterSeq } = deliveryStage(input.record)
      const throughSeq = await native.observeThrough(input)
      if (!Number.isSafeInteger(throughSeq) || throughSeq < afterSeq) {
        throw new TaskError('RECONCILIATION_REQUIRED', 'Cannot verify the return presentation boundary')
      }
      return throughSeq
    },
    observe: input => native.observe(input),
  }
}
