import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createHostTaskUsage } from '../../../src/usage/host-usage.mjs'

export const inject = ['workspaceRegistry', 'sessionQuery', 'sessionController', 'subagents']

export async function apply(ctx) {
  const input = process.env.WORKBENCH_USAGE_TEST_BINDINGS
  if (!input) return
  const { workspaceId, sessions, output, taskId, forks, boundChild } = JSON.parse(input)
  const owner = { kind: 'user' }
  const task = { id: taskId, workspaceId, revision: 1 }
  const runs = sessions.map(id => ({ id, rootSessionId: id, childSessionIds: [], endedAt: null }))
  const stages = runs.map(run => ({ runId: run.id, afterSeq: -1 }))
  const record = { detail: { task, runs }, stages }
  const read = createHostTaskUsage({
    workspaceRegistry: ctx.workspaceRegistry, sessionQuery: ctx.sessionQuery,
    loadTask: (principal, id) => principal === owner && id === taskId ? record : null,
    canReadSession: ({ sessionId }) => sessions.includes(sessionId) || sessionId === runs[0].childSessionIds[0],
  })
  const baseline = forks ? await read(owner, taskId) : undefined
  if (forks) {
    const resolved = await ctx.sessionController.resolveAgent(sessions[0])
    if (!('agent' in resolved)) throw new Error('Fixture root could not be resolved')
    for (const { id, prompt, name } of forks) {
      const activation = await ctx.subagents.startActivation({
        provider: 'fork', childId: id, parent: resolved.agent, label: name, name,
        prompt: [{ type: 'text', text: prompt }], delivery: 'caller', signal: AbortSignal.timeout(10_000),
      })
      try {
        assert.equal(activation.childId, id)
        await activation.result
      } finally {
        await activation.dispose()
      }
      const observed = await ctx.sessionQuery.observeSession(id)
      try {
        assert.ok(observed.inheritedEventCount > 0, 'the native child inherited logged root history')
      } finally {
        observed[Symbol.dispose]()
      }
    }
  }
  if (boundChild) runs[0].childSessionIds.push(boundChild)
  await writeFile(output, JSON.stringify({ baseline, usage: await read(owner, taskId) }), { mode: 0o600 })
}
