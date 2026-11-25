import { writeFile } from 'node:fs/promises'
import { createHostTaskContext } from '../../../src/application/host-context.mjs'

export const inject = ['fs', 'workspaceRegistry', 'sessionQuery']

export async function apply(ctx) {
  if (!process.env.WORKBENCH_CONTEXT_TEST) return
  const { detail, output } = JSON.parse(process.env.WORKBENCH_CONTEXT_TEST)
  const owner = Object.freeze({ kind: 'user' })
  const context = createHostTaskContext({
    owner, fs: ctx.fs, workspaceRegistry: ctx.workspaceRegistry, sessionQuery: ctx.sessionQuery,
    app: { get: () => detail },
    repository: { read: () => ({ detail }) },
  })
  const index = await context.get(owner, detail.task.id)
  const [preview, presented] = await Promise.all([
    context.load(owner, detail.task.id, detail.task.materials[0]),
    context.load(owner, detail.task.id, detail.artifacts[0].source),
  ])
  await writeFile(output, JSON.stringify({ index, preview, presented }), { mode: 0o600 })
}
