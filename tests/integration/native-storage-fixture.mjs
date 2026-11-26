import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { openTaskRepository } from '../../src/storage/task-repository.mjs'

export async function nativeStorageFixture(path, { expectedCommit } = {}) {
  const checkout = resolve(path)
  const loadJson = async url => JSON.parse(await readFile(url, 'utf8'))
  const baseline = await loadJson(new URL('../../harness-baseline.json', import.meta.url))
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
    expectedCommit ?? baseline.commit)
  const resolveHost = createRequire(join(checkout, 'packages/storage/storage-domain/package.json'))
  const importHost = (name, resolver = resolveHost) => import(pathToFileURL(resolver.resolve(name)).href)
  const { Context } = await importHost('@deepseek-ai/cordis')
  const { default: Storage } = await importHost('@deepseek-ai/dsh-storage')
  const { z } = await importHost('zod')
  const { DomainFacility, defineDomain, domainTable } = await import(pathToFileURL(
    join(checkout, 'packages/storage/storage-domain/lib/index.js')).href)
  const { JsonStorageBackend } = await import(pathToFileURL(
    join(checkout, 'packages/storage/storage-json/lib/index.js')).href)
  const schema = await loadJson(new URL('../../contracts/v1/schemas.json', import.meta.url))
  const ajv = new Ajv2020({ validateFormats: false })
  ajv.addSchema(schema)
  const validateDetail = ajv.compile({ $ref: `${schema.$id}#/$defs/TaskDetail` })

  return async function useStorage(root, check) {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    ctx.storage.backend.register('json', backend)
    const storageDomain = new DomainFacility(ctx, { backend: 'json', routes: {} })
    try {
      const repo = await openTaskRepository({ storageDomain, defineDomain, domainTable, z, validateDetail })
      try {
        await check(repo)
      } finally {
        await repo.close()
      }
    } finally {
      await backend.close()
    }
  }
}
