import { createBoundedReview } from '../../../src/harness/bounded-review.mjs'

export const inject = ['workspaceRegistry', 'sessionController', 'agents', 'subagents', 'sessionQuery', 'webServer']

export async function apply(ctx) {
  if (process.env.WORKBENCH_TEST_REVIEW === '1') {
    const runReview = createBoundedReview({
      agents: ctx.agents, subagents: ctx.subagents, workspaceRegistry: ctx.workspaceRegistry, sessionQuery: ctx.sessionQuery,
    }, { timeoutMs: 15_000 })
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', auth: 'required', path: '/workbench/test/review',
      async handler(req, res, peer) {
        if (req.method !== 'POST' || peer?.principal.kind !== 'owner' || req.headers.origin !== ctx.webServer.getOrigin()) {
          res.writeHead(403).end()
          return
        }
        try {
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const input = JSON.parse(Buffer.concat(chunks))
          const result = await runReview({ ...input, allows: ({ kind, id }) => !input.deny &&
            id === (kind === 'workspace' ? input.workspaceId : input.sessionId) })
          const native = await ctx.sessionQuery.observeSession(result.childSessionId)
          try {
            const { origin, parentSession, agentPreset } = native.header
            res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({ ...result, origin, parentSession, agentPreset }))
          } finally {
            native[Symbol.dispose]()
          }
        } catch (error) {
          res.writeHead(error.code === 'REVISION_CONFLICT' ? 409 : error.code === 'NOT_FOUND' ? 404 : 500,
            { 'content-type': 'application/json' }).end(JSON.stringify({ code: error.code, message: error.message }))
        }
      },
    }))
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
