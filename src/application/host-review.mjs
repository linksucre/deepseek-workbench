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
  return {
    async resolve({ record, principal, input, now }) {
      const runId = record.detail.task.activeRunId
      const stage = record.stages.find(item => item.runId === runId)
      if (!stage) throw new TaskError('INVALID_TRANSITION', 'No active delivery stage')
      const previous = new Set(record.detail.submissions.filter(item => item.runId === runId)
        .flatMap(item => item.artifactIds))
      let afterSeq = stage.afterSeq
      for (const artifact of record.detail.artifacts) {
        if (!previous.has(artifact.id) || artifact.source.kind !== 'session-event') continue
        const [, seq] = JSON.parse(artifact.source.locator)
        if (Number.isSafeInteger(seq)) afterSeq = Math.max(afterSeq, seq)
      }
      return native.resolveSubmission({
        record, principal, afterSeq, selection: input.selection, now, newArtifactId: randomUUID,
      })
    },
    observe: input => native.observe(input),
  }
}
