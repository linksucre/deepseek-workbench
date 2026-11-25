import { createHash, randomUUID } from 'node:crypto'
import { createDraft, evolveTask, TaskError } from '../domain/task.mjs'

const reject = (code, message) => { throw new TaskError(code, message) }

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
  }
  return value
}

function digest(input) {
  return createHash('sha256').update(JSON.stringify(ordered(input))).digest('hex')
}

// Deterministic within actor/workspace/request scope, with RFC UUID version-8 bits.
function creationId(actorId, workspaceId, requestId) {
  const hex = digest(['workbench.task.create', actorId, workspaceId, requestId]).slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
}

/**
 * Application ports are local, trusted Host adapters. Public contract validation,
 * construction of principal, and calling-session discovery happen at the boundary.
 */
export function createTaskService({ repository, authorize, delivery, clock = () => new Date().toISOString(), newId = randomUUID }) {
  function user(principal) {
    if (principal?.kind !== 'user' || !principal.actorId) reject('FORBIDDEN', 'A verified user is required')
    return principal.actorId
  }

  async function load(taskId, principal, operation, userOnly) {
    const record = repository.read(taskId)
    if (record === undefined) reject('NOT_FOUND', 'Task not found')
    const { task, runs } = record.detail
    if (userOnly) user(principal)
    if (principal?.kind === 'agent') {
      const owner = runs.find(run => run.id === task.activeRunId && run.endedAt === null)
      if (!owner || owner.rootSessionId !== principal.sessionId || principal.workspaceId !== task.workspaceId) {
        reject('NOT_FOUND', 'Task not found')
      }
    } else {
      user(principal)
    }
    if (!await authorize({ principal, workspaceId: task.workspaceId, operation })) {
      reject('NOT_FOUND', 'Task not found')
    }
    return record
  }

  function operationRequest(principal, operation, input, payload = input) {
    return {
      actorId: principal.kind === 'agent' ? `agent:${principal.sessionId}` : `user:${principal.actorId}`,
      operation, requestId: input.requestId, digest: digest(payload),
    }
  }

  async function mutate(principal, operation, input, commandFor, { userOnly = true, payload = input } = {}) {
    const record = await load(input.taskId, principal, operation, userOnly)
    const request = operationRequest(principal, operation, input, payload)
    const receipt = record.operations.find(item => item.actorId === request.actorId &&
      item.operation === request.operation && item.requestId === request.requestId)
    if (receipt !== undefined) {
      if (receipt.digest !== request.digest) reject('INVALID', 'Request ID reused with a different input')
      return structuredClone(receipt.result)
    }
    if (record.detail.task.revision !== input.expectedRevision) reject('REVISION_CONFLICT', 'Task revision changed')

    // Observe evidence before entering the synchronous, single-key update.
    // The repository rechecks the revision before applying this observation.
    const now = clock()
    const command = await commandFor(record, now)
    return repository.commit(input.taskId, { request, expectedRevision: input.expectedRevision }, current => {
      if (command.intentId !== undefined && current.pendingIntent?.intentId !== command.intentId) {
        reject('RECONCILIATION_REQUIRED', 'Startup intent changed or is no longer pending')
      }
      const detail = evolveTask(current.detail, command, { expectedRevision: input.expectedRevision, now })
      let stages = current.stages
      if (command.kind === 'bind') {
        stages = [...stages, {
          stageId: command.run.id, runId: command.run.id, afterSeq: command.afterSeq, openedAt: now,
          choices: detail.task.choice === null ? [] : [
            { revision: detail.task.revision, choice: detail.task.choice, observedAt: now },
          ],
        }]
      }
      if (command.kind === 'choose' && detail.task.activeRunId !== null) {
        stages = stages.map(stage => stage.runId !== detail.task.activeRunId ? stage : {
          ...stage, choices: [...stage.choices,
            { revision: detail.task.revision, choice: detail.task.choice, observedAt: now }],
        })
      }
      return {
        detail, stages,
        pendingIntent: ['block-start', 'record-start-receipt'].includes(command.kind) ? command.intent
          : command.kind === 'bind' || command.kind === 'clear-block' ? null : current.pendingIntent,
      }
    })
  }

  return {
    async create(principal, input) {
      const actorId = user(principal)
      if (!await authorize({ principal, workspaceId: input.workspaceId, operation: 'task.create' })) {
        reject('NOT_FOUND', 'Workspace not found')
      }
      const id = creationId(actorId, input.workspaceId, input.requestId)
      const detail = createDraft({ id, workspaceId: input.workspaceId, brief: input, now: clock() })
      return repository.create(detail, operationRequest(principal, 'task.create', input))
    },

    async get(principal, taskId) {
      const { detail } = await load(taskId, principal, 'task.get', true)
      return detail
    },

    updateBrief(principal, input) {
      return mutate(principal, 'task.updateBrief', input, () => ({ kind: 'update-brief', brief: input }))
    },

    ready(principal, input) {
      return mutate(principal, 'task.ready', input, () => ({ kind: 'ready' }))
    },

    choose(principal, input) {
      return mutate(principal, 'task.choose', input, () => ({
        kind: 'choose', choice: { ...input.choice, source: principal.kind },
      }), { userOnly: false })
    },

    // The Host persists this before invoking the native create endpoint.
    reserveStart(principal, input, { agentPreset }) {
      return mutate(principal, 'task.start.reserve', input, (record, now) => {
        if (record.pendingIntent !== null) reject('RECONCILIATION_REQUIRED', 'A startup intent is pending')
        if (record.detail.task.status !== 'ready') reject('INVALID_TRANSITION', 'Only a ready task can reserve a new run')
        return {
          kind: 'block-start',
          intent: {
            intentId: newId(), reservedSessionId: `session-${newId()}`, runId: newId(),
            workspaceId: record.detail.task.workspaceId, agentPreset,
            requestDigest: digest({ input, agentPreset }), createdAt: now,
          },
        }
      }, { payload: { input, agentPreset } })
    },

    saveNativeReceipt(principal, input, receipt) {
      return mutate(principal, 'task.start.receipt', input, record => {
        const intent = record.pendingIntent
        if (!intent || intent.intentId !== receipt.intentId ||
            intent.reservedSessionId !== receipt.sessionId || intent.workspaceId !== receipt.workspaceId) {
          reject('RECONCILIATION_REQUIRED', 'Native creation receipt did not match this startup')
        }
        return { kind: 'record-start-receipt', intentId: intent.intentId, intent: {
          ...intent, receipt: { sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, outcome: receipt.outcome },
        } }
      }, { payload: { input, receipt } })
    },

    discardStart(principal, input) {
      return mutate(principal, 'task.reconcile.discard', input, record => {
        const intent = record.pendingIntent
        if (!intent || input.rootSessionId !== null) reject('RECONCILIATION_REQUIRED', 'No matching startup intent')
        return { kind: 'clear-block', intentId: intent.intentId }
      })
    },

    // Called only after the Host verified the native root and workspace membership.
    bindConfirmedRun(principal, input, verified, operation = 'task.start.bind') {
      return mutate(principal, operation, input, (record, now) => {
        const intent = record.pendingIntent
        if (!intent || intent.intentId !== verified.intentId ||
            intent.reservedSessionId !== verified.sessionId || intent.workspaceId !== verified.workspaceId ||
            intent.agentPreset !== verified.agentPreset ||
            !Number.isSafeInteger(verified.afterSeq) || verified.afterSeq < -1) {
          reject('RECONCILIATION_REQUIRED', 'Verified session does not match the startup intent')
        }
        return {
          kind: 'bind', intentId: intent.intentId, afterSeq: verified.afterSeq,
          run: {
            id: intent.runId, intentId: intent.intentId, rootSessionId: verified.sessionId,
            childSessionIds: [], startedAt: now, endedAt: null,
          },
        }
      }, { payload: { input, verified } })
    },

    submit(principal, input) {
      return mutate(principal, 'task.submit', input, async (record, now) => {
        if (record.detail.task.status !== 'active') reject('INVALID_TRANSITION', 'An active task is required')
        const { artifacts, evidence } = await delivery.resolve({ record, principal, input, now })
        return { kind: 'submit', artifacts, evidence, submissionId: newId() }
      }, { userOnly: false })
    },

    decide(principal, input) {
      return mutate(principal, 'task.decide', input, async (record, now) => {
        const { task, submissions, artifacts } = record.detail
        if (task.status !== 'review' || task.currentSubmissionId !== input.submissionId) {
          reject('INVALID_TRANSITION', 'Decision must target the current submission')
        }
        const selected = submissions.find(item => item.id === input.submissionId)
        const observedVersions = input.verdict === 'accept'
          ? await delivery.observe({
            record, principal, now, artifacts: artifacts.filter(item => selected.artifactIds.includes(item.id)),
          })
          : []
        return {
          kind: input.verdict, actorId: user(principal), submissionId: input.submissionId,
          reason: input.reason, observedVersions,
          reviewEvidence: (input.confirmedCriteria ?? []).map(criterionId => ({
            criterionId, kind: 'user', outcome: 'pass', source: null,
            observedAt: now, summary: 'Reviewer explicitly confirmed this criterion',
          })),
        }
      })
    },
  }
}
