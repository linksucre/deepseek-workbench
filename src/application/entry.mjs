import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { z } from 'zod'
import { mountWorkbenchHost } from './host-runtime.mjs'
import { installReviewerIsolation } from '../harness/bounded-review.mjs'
import { mountWorkbenchPage } from '../web/host-page.mjs'

export const inject = ['storageDomain', 'webServer', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'tools', 'agents', 'subagents']

export async function apply(ctx, config) {
  // The overlay generator pins this local module to the verified Harness build.
  const dependency = new URL(config.storageModule)
  if (dependency.protocol !== 'file:') throw new Error('Workbench requires a local Harness storage module')
  const { defineDomain, domainTable } = await import(dependency.href)
  let usagePolicy
  if (config.usagePolicyFile !== undefined) {
    const policyFile = new URL(config.usagePolicyFile)
    if (policyFile.protocol !== 'file:') throw new Error('Workbench usage policy must be a local file')
    usagePolicy = JSON.parse(await readFile(policyFile, 'utf8'))
  }
  installReviewerIsolation(ctx)
  await mountWorkbenchHost(ctx, { Ajv2020, z, defineDomain, domainTable, usagePolicy })
  await mountWorkbenchPage(ctx)
}
