import Ajv2020 from 'ajv/dist/2020.js'
import { z } from 'zod'
import { mountWorkbenchHost } from './host-runtime.mjs'
import { mountWorkbenchPage } from '../web/host-page.mjs'

export const inject = ['storageDomain', 'webServer', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'tools']

export async function apply(ctx, config) {
  // The overlay generator pins this local module to the verified Harness build.
  const dependency = new URL(config.storageModule)
  if (dependency.protocol !== 'file:') throw new Error('Workbench requires a local Harness storage module')
  const { defineDomain, domainTable } = await import(dependency.href)
  await mountWorkbenchHost(ctx, { Ajv2020, z, defineDomain, domainTable })
  await mountWorkbenchPage(ctx)
}
