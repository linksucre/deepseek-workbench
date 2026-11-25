import { realpath } from 'node:fs/promises'
import { TaskError } from '../domain/task.mjs'
import { createLocalFiles } from './local-files.mjs'
import { observeArtifactVersions, resolvePresentation } from './submission.mjs'

const unavailable = () => new TaskError('NOT_FOUND', 'No authorized task delivery session')

/**
 * Bind delivery reads to a trusted, already authorized task Run.
 * These callbacks are Host policy decisions and are never provided by the model.
 */
export function createHostDelivery({ sessionQuery, workspaceRegistry, canUseWorkspace, canReadFile }) {
  if (typeof canUseWorkspace !== 'function' || typeof canReadFile !== 'function') {
    throw new TypeError('Host delivery requires workspace and file authorizers')
  }

  async function read({ principal, record }, action) {
    const { task, runs } = record.detail
    const run = runs.find(item => item.id === task.activeRunId && item.endedAt === null)
    if (!run || !run.rootSessionId ||
        (principal.kind === 'agent' && principal.sessionId !== run.rootSessionId)) throw unavailable()
    if (await canUseWorkspace({ principal, task, run }) !== true) throw unavailable()
    const workspace = workspaceRegistry.get(task.workspaceId)
    if (!workspace?.sessionIds.includes(run.rootSessionId)) throw unavailable()
    const observation = await sessionQuery.observeSession(run.rootSessionId)
    try {
      const { header, projections, events } = observation
      if (header.id !== run.rootSessionId || header.origin !== undefined ||
          !header.cwd || await realpath(header.cwd) !== await realpath(workspace.path)) {
        throw unavailable()
      }
      const cwd = projections.values.workingDirectory ?? header.cwd
      const files = await createLocalFiles({
        root: workspace.path,
        cwd,
        authorizePath: path => canReadFile({ principal, task, run, path }),
      })
      return await action({ sessionId: run.rootSessionId, events, files })
    } finally {
      observation[Symbol.dispose]()
    }
  }

  return {
    resolveArtifacts(input) {
      return read(input, ({ sessionId, events, files }) => {
        const observedThrough = events.at(-1)?.seq ?? -1
        const beforeSeq = Math.min(observedThrough + 1, input.beforeSeq ?? observedThrough + 1)
        return resolvePresentation({
          sessionId, events, files,
          stage: { afterSeq: input.afterSeq, beforeSeq },
          selection: input.selection, now: input.now, newArtifactId: input.newArtifactId,
        })
      })
    },

    observe(input) {
      return read(input, ({ files }) => observeArtifactVersions(input.artifacts, files))
    },
  }
}
