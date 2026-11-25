import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { createDraft, evolveTask } from '../../src/domain/task.mjs'
import { openTaskRepository } from '../../src/storage/task-repository.mjs'

const checkout = resolve(process.argv[2] ?? '.')
const loadJson = async url => JSON.parse(await readFile(url, 'utf8'))
const baseline = await loadJson(new URL('../../harness-baseline.json', import.meta.url))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)
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

async function useStorage(root, check) {
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

const temp = await mkdtemp(join(tmpdir(), 'dsh-storage-smoke-'))
const root = join(temp, 'store')
const backup = join(temp, 'backup')
const now = '2026-11-25T12:00:00.000Z'
const id = 'b01f7a11-1b38-41a3-8af7-9f2589279201'
const draft = createDraft({
  id, workspaceId: 'project', now,
  brief: { title: 'Brief', goal: 'Prepare presentation', materials: [],
    deliverables: ['brief.md'], criteria: [{ id: 'facts', description: 'Check facts' }] },
})
const request = name => ({ requestId: name, operation: name, actorId: 'owner', digest: `input-${name}` })
const ready = input => ({ ...input, detail: evolveTask(input.detail, { kind: 'ready' }, { expectedRevision: 0, now }) })
const intent = {
  intentId: 'intent-1', reservedSessionId: 'session-reserved', runId: 'run-1',
  workspaceId: 'project', agentPreset: 'task-collaborator', requestDigest: 'intent-digest', createdAt: now,
}
let exported
try {
  await useStorage(root, async repo => {
    assert.deepEqual(await Promise.all([repo.create(draft, request('create')), repo.create(draft, request('create'))]), [draft, draft])
    const results = await Promise.allSettled(['ready', 'other'].map(name =>
      repo.commit(id, { request: request(name), expectedRevision: 0 }, ready)))
    assert.equal(results[0].status, 'fulfilled')
    assert.equal(results[1].reason.code, 'REVISION_CONFLICT')
    const queued = await repo.commit(id, { request: request('reserve'), expectedRevision: 1 }, input => ({
      detail: evolveTask(input.detail, { kind: 'block-start' }, { expectedRevision: 1, now }),
      pendingIntent: intent,
    }))
    assert.equal(queued.task.status, 'blocked')
    await assert.rejects(repo.commit(id, { request: request('bad'), expectedRevision: 2 }, input => ({
      ...input, pendingIntent: { ...intent, workspaceId: 'other-project' },
      detail: evolveTask(input.detail, { kind: 'clear-block' }, { expectedRevision: 2, now }),
    })), { code: 'INVALID' })
    assert.equal(repo.read(id).detail.task.revision, 2)
    exported = await repo.exportSnapshot()
  })
  await cp(root, backup, { recursive: true })
  for (const directory of [root, backup]) {
    await useStorage(directory, async repo => {
      assert.deepEqual(await repo.exportSnapshot(), exported)
      assert.deepEqual(repo.read(id).pendingIntent, intent)
      const replayed = await repo.commit(id, { request: request('ready'), expectedRevision: 0 }, () => {
        assert.fail('replay must not apply side effects')
      })
      assert.equal(replayed.task.revision, 1)
      await assert.rejects(repo.commit(id, {
        request: { ...request('ready'), digest: 'changed' }, expectedRevision: 0,
      }, ready), { code: 'INVALID' })
      assert.equal(repo.read(id).detail.task.revision, 2)
    })
  }
  console.log('PASS: native storage atomic revision, request replay, pending intent, reopen and backup recovery.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
