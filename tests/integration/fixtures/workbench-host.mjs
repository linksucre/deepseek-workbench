import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { mountWorkbenchHost } from '../../../src/application/host-runtime.mjs'

export const inject = ['storageDomain', 'webServer', 'workspaceRegistry']

export async function apply(ctx) {
  const checkout = process.env.WORKBENCH_TEST_CHECKOUT
  const domain = join(checkout, 'packages/storage/storage-domain')
  const fromDomain = createRequire(join(domain, 'package.json'))
  const { z } = await import(pathToFileURL(fromDomain.resolve('zod')).href)
  const { defineDomain, domainTable } = await import(pathToFileURL(join(domain, 'lib/index.js')).href)
  await mountWorkbenchHost(ctx, { Ajv2020, z, defineDomain, domainTable })
}
