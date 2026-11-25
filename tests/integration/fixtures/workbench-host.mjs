import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { mountWorkbenchHost } from '../../../src/application/host-runtime.mjs'

export const inject = ['storageDomain', 'webServer', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'tools']

export async function apply(ctx) {
  const checkout = process.env.WORKBENCH_TEST_CHECKOUT
  const domain = join(checkout, 'packages/storage/storage-domain')
  const fromDomain = createRequire(join(domain, 'package.json'))
  const { z } = await import(pathToFileURL(fromDomain.resolve('zod')).href)
  const { defineDomain, domainTable } = await import(pathToFileURL(join(domain, 'lib/index.js')).href)
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
  await mountWorkbenchHost(ctx, { Ajv2020, z, defineDomain, domainTable })
}
