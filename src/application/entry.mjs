import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { z } from 'zod'
import { mountWorkbenchHost } from './host-runtime.mjs'
import { installReviewerIsolation } from '../harness/bounded-review.mjs'
import { mountWorkbenchPage } from '../web/host-page.mjs'

export const inject = ['storageDomain', 'webServer', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'fs', 'tools', 'agents', 'subagents']

async function readPolicy(path) {
  if (path === undefined) return undefined
  const file = new URL(path)
  if (file.protocol !== 'file:') throw new Error('Workbench policies require local files')
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function apply(ctx, config) {
  // The overlay generator pins this local module to the verified Harness build.
  const dependency = new URL(config.storageModule)
  if (dependency.protocol !== 'file:') throw new Error('Workbench requires a local Harness storage module')
  const { defineDomain, domainTable } = await import(dependency.href)
  const [usagePolicy, evidencePolicy] = await Promise.all([
    readPolicy(config.usagePolicyFile), readPolicy(config.evidencePolicyFile),
  ])
  installReviewerIsolation(ctx)
  await mountWorkbenchHost(ctx, { Ajv2020, z, defineDomain, domainTable, usagePolicy, evidencePolicy })
  await mountWorkbenchPage(ctx)
}
