import { TaskError } from '../domain/task.mjs'

export const TASK_DOMAIN = 'workbench_tasks'

/** Open the task domain using the pinned Harness storage API and contract validator. */
export async function openTaskRepository({ storageDomain, defineDomain, domainTable, z, validateDetail }) {
  const text = z.string().min(1)
  const detail = z.custom(validateDetail, 'Invalid TaskDetail contract')
  const intent = z.strictObject({
    intentId: text, reservedSessionId: text, runId: text, workspaceId: text,
    agentPreset: text, requestDigest: text, createdAt: text,
  })
  const operation = z.strictObject({
    actorId: text, operation: text, requestId: text, digest: text,
  })
  const receipt = operation.extend({ result: detail })
  const stage = z.strictObject({
    stageId: text, runId: text, afterSeq: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    openedAt: text,
    choices: z.array(z.strictObject({
      revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      choice: z.unknown(), observedAt: text,
    })),
  })
  const schema = z.strictObject({
    schemaVersion: z.literal(1),
    detail,
    pendingIntent: intent.nullable(),
    stages: z.array(stage).default([]),
    operations: z.array(receipt).min(1),
  })
  const domain = await storageDomain.open(defineDomain({
    name: TASK_DOMAIN,
    version: 1,
    layout: 'per-record',
    tables: { tasks: domainTable(schema) },
  }))
  const table = domain.table('tasks')
  let queue = Promise.resolve()

  // A single repository owns this domain. The queue also serializes creation,
  // because the native table exposes update and put but no insert-if-absent.
  function serialize(action) {
    const result = queue.then(action)
    queue = result.catch(() => {})
    return result
  }

  function replay(record, request) {
    const found = record.operations.find(item =>
      item.actorId === request.actorId && item.operation === request.operation && item.requestId === request.requestId)
    if (found === undefined) return undefined
    if (found.digest !== request.digest) throw new TaskError('INVALID', 'Request ID reused with a different input')
    return structuredClone(found.result)
  }

  function checked(key, record) {
    const parsed = schema.parse(record)
    if (parsed.detail.task.id !== key ||
        parsed.operations.some(item => item.result.task.id !== key) ||
        (parsed.pendingIntent && parsed.pendingIntent.workspaceId !== parsed.detail.task.workspaceId)) {
      throw new TaskError('INVALID', 'Storage key, task or intent identity mismatch')
    }
    for (const stage of parsed.stages) {
      if (!parsed.detail.runs.some(run => run.id === stage.runId) ||
          stage.choices.some(item => !validateDetail({
            ...parsed.detail, task: { ...parsed.detail.task, choice: item.choice },
          }))) {
        throw new TaskError('INVALID', 'Stage history does not match its task contract')
      }
    }
    return parsed
  }

  function current(key) {
    const record = table.get(key)
    return record === undefined ? undefined : checked(key, record)
  }

  return {
    read(key) {
      return structuredClone(current(key))
    },

    create(detail, request) {
      const input = structuredClone({ detail, request })
      return serialize(async () => {
        const { detail, request } = input
        const key = detail.task.id
        const identity = operation.parse(request)
        const previous = current(key)
        if (previous !== undefined) {
          const result = replay(previous, identity)
          if (result !== undefined) return result
          throw new TaskError('REVISION_CONFLICT', 'Task ID already exists')
        }
        if (detail.task.status !== 'draft' || detail.task.revision !== 0) {
          throw new TaskError('INVALID', 'Initial task must be a revision-zero draft')
        }
        const record = checked(key, {
          schemaVersion: 1, detail, pendingIntent: null,
          operations: [{ ...identity, result: detail }],
        })
        await table.put(key, record)
        return structuredClone(record.detail)
      })
    },

    commit(key, { request, expectedRevision }, transform) {
      const input = structuredClone({ request, expectedRevision })
      return serialize(async () => {
        const identity = operation.parse(input.request)
        const previous = current(key)
        if (previous === undefined) throw new TaskError('NOT_FOUND', 'Task does not exist')
        const replayed = replay(previous, identity)
        if (replayed !== undefined) return replayed

        const stored = await table.update(key, record => {
          const prior = checked(key, record)
          if (prior.detail.task.revision !== input.expectedRevision) {
            throw new TaskError('REVISION_CONFLICT', 'Task revision changed')
          }
          const next = transform(structuredClone({ detail: prior.detail, pendingIntent: prior.pendingIntent, stages: prior.stages }))
          if (next.detail.task.revision !== input.expectedRevision + 1 ||
              next.detail.task.workspaceId !== prior.detail.task.workspaceId) {
            throw new TaskError('INVALID', 'A commit must advance one revision within the same workspace')
          }
          return checked(key, {
            schemaVersion: 1,
            detail: structuredClone(next.detail),
            pendingIntent: structuredClone(next.pendingIntent),
            stages: structuredClone(next.stages ?? prior.stages),
            operations: [...prior.operations, { ...identity, result: structuredClone(next.detail) }],
          })
        })
        return structuredClone(stored.detail)
      })
    },

    exportSnapshot() {
      return serialize(() => [...table.keys()].sort()
        .map(key => ({ key, record: structuredClone(current(key)) })))
    },

    close() {
      return serialize(() => domain.close())
    },
  }
}
