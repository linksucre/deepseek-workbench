import { TaskError } from '../domain/task.mjs'

const missing = () => new TaskError('NOT_FOUND', 'Task context is not available')
const day = 86_400_000

const sourceKey = ({ kind, locator, observedAt }) => JSON.stringify([kind, locator, observedAt])

function collectSources({ task, artifacts, submissions }) {
  const sources = new Map()
  const index = (source, origin) => {
    if (!source) return
    const key = sourceKey(source)
    const entry = sources.get(key) ?? { source: structuredClone(source), origins: new Set() }
    entry.origins.add(origin)
    sources.set(key, entry)
  }
  for (const source of task.materials) index(source, 'brief')
  const submittedIds = new Set(submissions.flatMap(submission => submission.artifactIds))
  for (const artifact of artifacts) {
    if (submittedIds.has(artifact.id)) index(artifact.source, 'submission')
  }
  return sources
}

function handoff(record) {
  const { task, runs, submissions, decisions } = record.detail
  const run = runs.find(item => item.id === task.activeRunId) ?? runs.at(-1)
  const stage = record.stages?.findLast(item => item.runId === run?.id)
  const submission = submissions.findLast(item => item.runId === run?.id)
  const decision = decisions.findLast(item => item.submissionId === submission?.id)
  return structuredClone({
    title: task.title,
    goal: task.goal,
    deliverables: task.deliverables,
    criteria: task.criteria,
    status: task.status,
    stage: stage ? { stageId: stage.stageId, runId: stage.runId, openedAt: stage.openedAt, afterSeq: stage.afterSeq } : null,
    choice: stage?.choices.at(-1)?.choice ?? task.choice,
    lastSubmission: submission ? { id: submission.id, submittedAt: submission.submittedAt } : null,
    lastDecision: decision ? { verdict: decision.verdict, reason: decision.reason, decidedAt: decision.decidedAt } : null,
  })
}

/** Context ports are called by trusted Host adapters. Source content is untrusted data. */
export function createTaskContext({ loadTask, canReadSource, readSource, clock = Date.now, staleAfterMs = 30 * day }) {
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) throw new RangeError('Invalid source freshness interval')

  async function recordFor(principal, taskId) {
    const record = await loadTask(principal, taskId)
    if (record?.detail.task.id !== taskId) throw missing()
    return record
  }

  async function confirm(principal, snapshot) {
    const current = (await recordFor(principal, snapshot.id)).detail.task
    if (current.workspaceId !== snapshot.workspaceId) throw missing()
    if (current.revision !== snapshot.revision) throw new TaskError('REVISION_CONFLICT', 'Task context changed during read')
  }

  function project(source, origins, workspaceId, now) {
    const date = Date.parse(source.observedAt)
    const freshness = !Number.isFinite(date) || date > now ? 'unknown' : now - date > staleAfterMs ? 'stale' : 'current'
    return { workspaceId, source: structuredClone(source), origins: [...origins], freshness }
  }

  return {
    async get(principal, taskId) {
      const record = await recordFor(principal, taskId)
      const { id, workspaceId, revision } = record.detail.task
      const context = { principal, taskId, workspaceId, detail: record.detail }
      const now = clock()
      const sources = []
      for (const { source, origins } of collectSources(record.detail).values()) {
        if (await canReadSource({ ...context, source: structuredClone(source) }) === true) {
          sources.push(project(source, origins, workspaceId, now))
        }
      }
      await confirm(principal, { id, workspaceId, revision })
      return { taskId, workspaceId, revision, sources, handoff: handoff(record) }
    },

    async load(principal, taskId, selected) {
      const record = await recordFor(principal, taskId)
      const { id, workspaceId, revision } = record.detail.task
      const entry = selected && collectSources(record.detail).get(sourceKey(selected))
      if (!entry) throw missing()
      const request = Object.freeze({ principal, taskId, workspaceId, detail: record.detail,
        source: Object.freeze({ ...entry.source }) })
      if (await canReadSource(request) !== true) throw missing()
      const content = await readSource(request)
      if (await canReadSource(request) !== true) throw missing()
      await confirm(principal, { id, workspaceId, revision })
      return { ...project(entry.source, entry.origins, workspaceId, clock()), content }
    },
  }
}
