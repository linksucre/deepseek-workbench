import { writeFile } from 'node:fs/promises'
import { createHostTaskUsage } from '../../../src/usage/host-usage.mjs'

export const inject = ['workspaceRegistry', 'sessionQuery']

export async function apply(ctx) {
  const input = process.env.WORKBENCH_USAGE_TEST_BINDINGS
  if (!input) return
  const { workspaceId, sessions, output, taskId } = JSON.parse(input)
  const owner = { kind: 'user' }
  const task = { id: taskId, workspaceId, revision: 1 }
  const runs = sessions.map(id => ({ id, rootSessionId: id, childSessionIds: [], endedAt: null }))
  const stages = runs.map(run => ({ runId: run.id, afterSeq: -1 }))
  const record = { detail: { task, runs }, stages }
  const read = createHostTaskUsage({
    workspaceRegistry: ctx.workspaceRegistry, sessionQuery: ctx.sessionQuery,
    loadTask: (principal, id) => principal === owner && id === taskId ? record : null,
    canReadSession: ({ sessionId }) => sessions.includes(sessionId),
  })
  await writeFile(output, JSON.stringify(await read(owner, taskId)), { mode: 0o600 })
}
