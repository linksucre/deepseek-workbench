import { realpath } from 'node:fs/promises'
import { TaskError } from '../domain/task.mjs'
import { createLocalFiles } from './local-files.mjs'
import { observeArtifactVersions, resolvePresentation } from './submission.mjs'

const unavailable = () => new TaskError('NOT_FOUND', 'No authorized task delivery session')

/**
 * Bind delivery reads to a trusted, already authorized task Run.
 * These callbacks are Host policy decisions and are never provided by the model.
 */
export function createHostDelivery({ sessionQuery, workspaceRegistry, canUseWorkspace, canReadFile, checkArtifacts = () => [] }) {
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
      if (!workspaceRegistry.get(task.workspaceId)?.sessionIds.includes(run.rootSessionId) ||
          await canUseWorkspace({ principal, task, run }) !== true) throw unavailable()
      return await action({ sessionId: run.rootSessionId, task, events, files })
    } finally {
      observation[Symbol.dispose]()
    }
  }

  function resolveSubmission(input) {
    return read(input, async ({ sessionId, task, events, files }) => {
      const observedThrough = events.at(-1)?.seq ?? -1
      const beforeSeq = Math.min(observedThrough + 1, input.beforeSeq ?? observedThrough + 1)
      const artifacts = await resolvePresentation({
        sessionId, events: input.legacyReturnedAt === undefined ? events
          : events.filter(event => Date.parse(event.time) > input.legacyReturnedAt),
        files, stage: { afterSeq: input.afterSeq, beforeSeq },
        selection: input.selection, now: input.now, newArtifactId: input.newArtifactId,
      })
      const evidence = await checkArtifacts({ task, files, artifacts, now: input.now })
      return { artifacts, evidence }
    })
  }

  return {
    resolveSubmission,
    async resolveArtifacts(input) {
      return (await resolveSubmission(input)).artifacts
    },

    observeThrough(input) {
      return read(input, ({ events }) => events.at(-1)?.seq ?? -1)
    },
    observe(input) {
      return read(input, ({ files }) => observeArtifactVersions(input.artifacts, files))
    },
  }
}
