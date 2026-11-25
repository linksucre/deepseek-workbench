import { access, readFile, unlink, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

export const inject = ['workspaceRegistry', 'sessionController', 'sessionQuery']

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

export async function apply(ctx) {
  const forwardFault = process.env.WORKBENCH_TEST_FORWARD_RECEIPT_FAULT
  const forwardRefusal = process.env.WORKBENCH_TEST_FORWARD_REFUSAL
  if (forwardRefusal) {
    const controller = ctx.sessionController
    const prompt = controller.prompt.bind(controller)
    controller.prompt = async (input, signal) => {
      if (await exists(forwardRefusal) && await readFile(forwardRefusal, 'utf8') === input.requestId) {
        await unlink(forwardRefusal)
        throw Object.assign(new Error('Injected native refusal before prompt admission'), {
          isDSHRemoteError: true,
          code: 'session/not-found',
          details: { sessionId: input.sessionId },
        })
      }
      return prompt(input, signal)
    }
  }
  if (forwardFault) {
    const controller = ctx.sessionController
    const prompt = controller.prompt.bind(controller)
    controller.prompt = async (input, signal) => {
      const result = await prompt(input, signal)
      if (await exists(forwardFault) && await readFile(forwardFault, 'utf8') === input.requestId) {
        await unlink(forwardFault)
        throw new Error('Injected failure after native forward admission')
      }
      return result
    }
  }
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
  const latePath = process.env.WORKBENCH_TEST_LATE_NATIVE_CREATE
  if (latePath) {
    const controller = ctx.sessionController
    const create = controller.create.bind(controller)
    let injected = false
    controller.create = async request => {
      if (injected || !await exists(`${latePath}.arm`)) return create(request)
      injected = true
      while (!await exists(`${latePath}.release`)) await setTimeout(50)
      const result = await create(request)
      await writeFile(`${latePath}.result`, JSON.stringify({ sessionId: result.sessionId }), { mode: 0o600 })
      return result
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
