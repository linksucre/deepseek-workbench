/** Rejections shared with the workbench operation contract. */
export class TaskError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TaskError'
    this.code = code
  }
}

function requireRule(condition, code, message) {
  if (!condition) throw new TaskError(code, message)
}

const invalid = (condition, message) => requireRule(condition, 'INVALID', message)
const nonblank = value => typeof value === 'string' && value.trim().length > 0

function stateOf(task, ...allowed) {
  requireRule(allowed.includes(task.status), 'INVALID_TRANSITION',
    `Cannot perform this action from ${task.status}`)
}

function validateBrief(brief) {
  invalid(nonblank(brief.title) && nonblank(brief.goal), 'A title and goal are required')
  invalid(brief.deliverables.every(nonblank), 'Deliverable descriptions cannot be blank')
  const ids = new Set()
  for (const criterion of brief.criteria) {
    invalid(nonblank(criterion.id) && nonblank(criterion.description), 'Criteria require an ID and description')
    invalid(!ids.has(criterion.id), 'Criterion IDs must be unique')
    ids.add(criterion.id)
  }
}

/** Create a draft from a contract-validated brief and a host-assigned identity. */
export function createDraft({ id, workspaceId, brief, now }) {
  validateBrief(brief)
  return {
    task: {
      id, workspaceId, ...copyBrief(brief), revision: 0, status: 'draft', choice: null,
      activeRunId: null, currentSubmissionId: null, createdAt: now, updatedAt: now,
    },
    runs: [], artifacts: [], submissions: [], decisions: [],
  }
}

function copyBrief({ title, goal, materials, deliverables, criteria }) {
  return structuredClone({ title, goal, materials, deliverables, criteria })
}

function activeRun(detail) {
  const run = detail.runs.find(candidate => candidate.id === detail.task.activeRunId)
  invalid(run?.endedAt === null && nonblank(run.rootSessionId), 'An active bound run is required')
  return run
}

function closeRun(detail, now) {
  const { task, runs } = detail
  if (task.activeRunId !== null) {
    const run = activeRun(detail)
    runs[runs.indexOf(run)] = { ...run, endedAt: now }
    task.activeRunId = null
  }
}

function applyRun(detail, run) {
  const { task, runs } = detail
  stateOf(task, 'ready', 'blocked')
  invalid(task.activeRunId === null, 'An active run already exists')
  invalid(run.endedAt === null && nonblank(run.rootSessionId), 'A confirmed session binding is required')
  invalid(nonblank(run.id) && !runs.some(previous => previous.id === run.id), 'Run ID must be new')
  runs.push(structuredClone(run))
  task.activeRunId = run.id
  task.status = 'active'
}

function submit(detail, command, now) {
  const { task, artifacts, submissions } = detail
  stateOf(task, 'active')
  const run = activeRun(detail)
  invalid(nonblank(command.submissionId) && !submissions.some(item => item.id === command.submissionId),
    'Submission ID must be new')
  invalid(command.artifacts.length > 0, 'At least one artifact is required')
  const ids = new Set(artifacts.map(item => item.id))
  for (const artifact of command.artifacts) {
    invalid(nonblank(artifact.id) && !ids.has(artifact.id), 'Artifact ID must identify a new immutable version')
    ids.add(artifact.id)
  }
  const criterionIds = new Set(task.criteria.map(criterion => criterion.id))
  invalid(command.evidence.every(item => criterionIds.has(item.criterionId)),
    'Evidence must refer to a task criterion')
  artifacts.push(...structuredClone(command.artifacts))
  submissions.push({
    id: command.submissionId, runId: run.id, submittedAt: now,
    briefRevision: task.revision, artifactIds: command.artifacts.map(item => item.id),
    criteriaSnapshot: structuredClone(task.criteria), evidence: structuredClone(command.evidence),
  })
  task.currentSubmissionId = command.submissionId
  task.status = 'review'
}

function decide(detail, command, now) {
  const { task, submissions, artifacts, decisions } = detail
  stateOf(task, 'review')
  const submission = submissions.find(item => item.id === task.currentSubmissionId)
  invalid(submission !== undefined && submission.id === command.submissionId, 'Decision must target the current submission')
  invalid(nonblank(command.actorId), 'A verified reviewer identity is required')
  if (command.kind === 'return') {
    invalid(nonblank(command.reason), 'A return reason is required')
    task.status = 'active'
    task.currentSubmissionId = null
  } else {
    verifyAcceptance(submission, artifacts, command.observedVersions)
    task.status = 'accepted'
    closeRun(detail, now)
  }
  decisions.push({
    submissionId: submission.id, verdict: command.kind === 'return' ? 'return' : 'accept',
    actorId: command.actorId, reason: command.reason ?? null, decidedAt: now,
  })
}

function verifyAcceptance(submission, artifacts, versions) {
  const observed = new Map(versions.map(item => [item.artifactId, item]))
  invalid(observed.size === versions.length, 'Conflicting version observations')
  for (const id of submission.artifactIds) {
    const submitted = artifacts.find(item => item.id === id)
    const current = observed.get(id)
    requireRule(submitted?.version != null && current?.version === submitted.version
      && current.versionKind === submitted.versionKind && submitted.versionKind !== 'unverified',
    'ARTIFACT_DRIFT', 'A submitted artifact is missing, unverifiable, or changed')
  }
  for (const criterion of submission.criteriaSnapshot) {
    const trusted = submission.evidence.filter(item =>
      item.criterionId === criterion.id && (item.kind === 'user' || (item.kind === 'machine' && item.source !== null)))
    invalid(trusted.some(item => item.outcome === 'pass') && !trusted.some(item => item.outcome === 'fail'),
      'Each criterion requires passing evidence without a conflicting trusted failure')
  }
}

/**
 * Apply one pre-authorized internal command to a contract-validated aggregate.
 * Session, reviewer and file observations must come from trusted host adapters.
 * The storage owner still performs revision comparison at atomic commit.
 */
export function evolveTask(detail, command, { expectedRevision, now }) {
  requireRule(detail.task.revision === expectedRevision, 'REVISION_CONFLICT', 'Task revision changed')
  requireRule(!['accepted', 'cancelled'].includes(detail.task.status), 'INVALID_TRANSITION', 'Task is closed')
  invalid(Number.isSafeInteger(expectedRevision + 1), 'Task revision limit reached')
  const next = structuredClone(detail)
  const { task } = next
  switch (command.kind) {
    case 'update-brief':
      stateOf(task, 'draft', 'ready')
      validateBrief(command.brief)
      Object.assign(task, copyBrief(command.brief))
      task.status = 'draft'
      break
    case 'ready':
      stateOf(task, 'draft')
      invalid(task.deliverables.length > 0 && task.criteria.length > 0,
        'Readiness requires a deliverable and an acceptance criterion')
      task.status = 'ready'
      break
    case 'bind':
      applyRun(next, command.run)
      break
    case 'block-start':
      stateOf(task, 'ready', 'paused')
      task.status = 'blocked'
      break
    case 'clear-block':
      stateOf(task, 'blocked')
      task.status = task.activeRunId === null ? 'ready' : 'paused'
      break
    case 'pause':
      stateOf(task, 'active')
      invalid(command.stopConfirmed === true, 'Stopping the native run must be confirmed')
      task.status = 'paused'
      break
    case 'resume':
      stateOf(task, 'paused')
      activeRun(next)
      invalid(command.resumeConfirmed === true, 'Session must be confirmed resumable')
      task.status = 'active'
      break
    case 'submit':
      submit(next, command, now)
      break
    case 'accept':
    case 'return':
      decide(next, command, now)
      break
    case 'cancel':
      if (task.activeRunId !== null || task.status === 'blocked') {
        invalid(command.stopConfirmed === true, 'Resolve outstanding native work before cancelling')
      }
      task.status = 'cancelled'
      task.currentSubmissionId = null
      closeRun(next, now)
      break
    default:
      throw new TaskError('INVALID', 'Unknown task command')
  }
  task.revision += 1
  task.updatedAt = now
  return next
}
