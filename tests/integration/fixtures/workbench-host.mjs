import { writeFile } from 'node:fs/promises'

export const inject = ['workspaceRegistry', 'sessionController', 'sessionQuery']

export async function apply(ctx) {
  if (process.env.WORKBENCH_TEST_REVIEW_RECEIPT_FAULT === '1') {
    const query = ctx.sessionQuery
    const observe = query.observeSession.bind(query)
    let failed = false
    let firstReviewId
    query.observeSession = async (...args) => {
      const observation = await observe(...args)
      if (observation.header.agentPreset === 'task-reviewer') {
        firstReviewId ??= observation.header.id
        if (!failed && observation.header.id !== firstReviewId) {
          failed = true
          observation[Symbol.dispose]()
          throw new Error('Injected failure after native reviewer receipt')
        }
      }
      return observation
    }
  }
  if (process.env.WORKBENCH_TEST_FAIL_ATTACH !== undefined) {
    const registry = ctx.workspaceRegistry
    const get = registry.get.bind(registry)
    const instrumented = new WeakSet()
    let failed = false
    registry.get = function (id) {
      const workspace = get(id)
      if (workspace && !instrumented.has(workspace)) {
        const attach = workspace.attachSession.bind(workspace)
        workspace.attachSession = async sessionId => {
          if (!failed) {
            failed = true
            throw new Error('Injected native attach fault')
          }
          return attach(sessionId)
        }
        instrumented.add(workspace)
      }
      return workspace
    }
  }
  const reservedPath = process.env.WORKBENCH_TEST_HOLD_NATIVE_CREATE
  if (reservedPath) {
    ctx.sessionController.create = async ({ sessionId, workspaceId }) => {
      await writeFile(reservedPath, JSON.stringify({ sessionId, workspaceId }), { flag: 'wx', mode: 0o600 })
      return new Promise(() => {})
    }
  }
  if (process.env.WORKBENCH_TEST_FAIL_ATTACH === 'lost-receipt') {
    const controller = ctx.sessionController
    const create = controller.create.bind(controller)
    controller.create = async request => {
      try { return await create(request) }
      catch (error) {
        if (error?.code === 'session/workspace-attach-failed') throw new Error('Injected lost native receipt')
        throw error
      }
    }
  }
}
