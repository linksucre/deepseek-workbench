export const inject = ['workspaceRegistry', 'sessionController']

export async function apply(ctx) {
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
