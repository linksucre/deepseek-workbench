import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraft, evolveTask } from '../../src/domain/task.mjs'
import { TASK_DOMAIN } from '../../src/storage/task-repository.mjs'
import { nativeStorageFixture } from './native-storage-fixture.mjs'

const useStorage = await nativeStorageFixture(process.argv[2] ?? '.')
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
  const recordPath = root => join(root, TASK_DOMAIN, 'tasks', `${id}.json`)
  const document = JSON.parse(await readFile(recordPath(backup), 'utf8'))
  const legacyRecord = structuredClone(document.record)
  delete legacyRecord.stages
  const legacy = join(temp, 'legacy')
  await mkdir(legacy)
  const legacyFile = join(legacy, `${TASK_DOMAIN}.json`)
  const legacyContents = JSON.stringify({
    unit: { name: TASK_DOMAIN, version: 1 }, tables: { tasks: { [id]: legacyRecord } },
  })
  await writeFile(legacyFile, legacyContents)
  await useStorage(legacy, async repo => {
    assert.deepEqual(await repo.exportSnapshot(), exported)
    assert.deepEqual(repo.read(id).stages, [])
    const replay = await repo.commit(id, { request: request('ready'), expectedRevision: 0 }, () => {
      assert.fail('legacy replay must not write')
    })
    assert.equal(replay.task.revision, 1)
  })
  assert.equal(await readFile(legacyFile, 'utf8'), legacyContents)
  assert.equal(JSON.parse(await readFile(recordPath(legacy), 'utf8')).version, 1)

  const invalid = join(temp, 'invalid')
  await cp(backup, invalid, { recursive: true })
  const invalidRecord = JSON.stringify({ ...document, record: { ...document.record, schemaVersion: 2 } })
  await writeFile(recordPath(invalid), invalidRecord)
  await assert.rejects(useStorage(invalid, () => assert.fail('invalid Workbench record opened')), { code: 'invalid-record' })
  assert.equal(await readFile(recordPath(invalid), 'utf8'), invalidRecord)

  for (const [label, contents] of [
    ['truncated', '{"version":'],
    ['foreign', JSON.stringify({ ...document, version: 2 })],
  ]) {
    const directory = join(temp, label)
    await cp(backup, directory, { recursive: true })
    await writeFile(recordPath(directory), contents)
    await assert.rejects(useStorage(directory, () => assert.fail('unreadable task domain opened')),
      { code: 'malformed-medium' })
    assert.equal(await readFile(recordPath(directory), 'utf8'), contents)
  }

  const collision = join(temp, 'key-appears')
  await cp(backup, collision, { recursive: true })
  const newId = '01882e02-360d-4d75-bee7-4b8b0dd34b2b'
  const newDraft = structuredClone(draft)
  newDraft.task.id = newId
  await useStorage(collision, async repo => {
    const claimed = join(collision, TASK_DOMAIN, 'tasks', `${newId}.json`)
    const unknown = '{"record":'
    assert.equal(repo.read(newId), undefined)
    await writeFile(claimed, unknown)
    await assert.rejects(repo.create(newDraft, request('create')), { code: 'malformed-medium' })
    assert.equal(await readFile(claimed, 'utf8'), unknown)
    assert.equal(repo.read(id).detail.task.revision, 2)
  })

  const restored = join(temp, 'restored')
  await cp(backup, restored, { recursive: true })
  await useStorage(restored, async repo => assert.deepEqual(await repo.exportSnapshot(), exported))
  console.log('PASS: native storage revision and replay, legacy V1 migration, strict corrupted-record protection, and clean backup restore.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
