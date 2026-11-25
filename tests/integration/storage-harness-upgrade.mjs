import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraft, evolveTask } from '../../src/domain/task.mjs'
import { TASK_DOMAIN } from '../../src/storage/task-repository.mjs'
import { nativeStorageFixture } from './native-storage-fixture.mjs'

const [oldCheckout, oldCommit, newCheckout, newCommit] = process.argv.slice(2)
assert.ok(oldCheckout && newCheckout && oldCommit && newCommit,
  'Supply old-checkout old-commit new-checkout new-commit')
assert.match(oldCommit, /^[0-9a-f]{40}$/)
assert.match(newCommit, /^[0-9a-f]{40}$/)
assert.notEqual(oldCommit, newCommit)
const oldStorage = await nativeStorageFixture(oldCheckout, { expectedCommit: oldCommit })
const newStorage = await nativeStorageFixture(newCheckout, { expectedCommit: newCommit })
const temp = await mkdtemp(join(tmpdir(), 'workbench-harness-storage-upgrade-'))
const source = join(temp, 'source')
const upgraded = join(temp, 'upgraded')
const rollback = join(temp, 'rollback')
const id = 'b01f7a11-1b38-41a3-8af7-9f2589279201'
const now = '2026-11-25T12:00:00.000Z'
const draft = createDraft({ id, workspaceId: 'project', now, brief: {
  title: 'Storage upgrade fixture', goal: 'Preserve the recorded task and receipt', materials: [],
  deliverables: ['brief.md'], criteria: [{ id: 'facts', description: 'Check the facts' }],
} })
const record = profile => join(profile, TASK_DOMAIN, 'tasks', `${id}.json`)
const request = operation => ({ operation, requestId: operation, actorId: 'owner', digest: `digest-${operation}` })
const ready = { request: request('ready'), expectedRevision: 0 }
const cancel = { request: request('cancel'), expectedRevision: 1 }
const apply = kind => input => ({ ...input, detail: evolveTask(input.detail, { kind }, {
  expectedRevision: input.detail.task.revision, now,
}) })
const unexpectedWrite = () => assert.fail('A recognized receipt must replay without a write')

try {
  let before
  let priorReceipt
  await oldStorage(source, async repo => {
    await repo.create(draft, request('create'))
    priorReceipt = await repo.commit(id, ready, apply('ready'))
    before = await repo.exportSnapshot()
  })
  const originalBytes = await readFile(record(source))
  await cp(source, upgraded, { recursive: true })
  await cp(source, rollback, { recursive: true })

  let newReceipt
  await newStorage(upgraded, async repo => {
    assert.deepEqual(await repo.exportSnapshot(), before)
    assert.deepEqual(await repo.commit(id, ready, unexpectedWrite), priorReceipt)
    await assert.rejects(repo.commit(id, { ...ready, request: { ...ready.request, digest: 'different' } },
      unexpectedWrite), { code: 'INVALID' })
    assert.deepEqual(await readFile(record(upgraded)), originalBytes)
    newReceipt = await repo.commit(id, cancel, apply('cancel'))
    assert.equal(newReceipt.task.status, 'cancelled')
    assert.equal(newReceipt.task.revision, 2)
  })
  const upgradedBytes = await readFile(record(upgraded))
  await newStorage(upgraded, async repo => {
    assert.deepEqual(repo.read(id).detail, newReceipt)
    assert.deepEqual(await repo.commit(id, ready, unexpectedWrite), priorReceipt)
    assert.deepEqual(await repo.commit(id, cancel, unexpectedWrite), newReceipt)
    assert.deepEqual(await readFile(record(upgraded)), upgradedBytes)
  })

  await oldStorage(rollback, async repo => {
    assert.deepEqual(await repo.exportSnapshot(), before)
    assert.deepEqual(await repo.commit(id, ready, unexpectedWrite), priorReceipt)
    assert.deepEqual(await readFile(record(rollback)), originalBytes)
  })
  assert.deepEqual(await readFile(record(source)), originalBytes)
  assert.deepEqual(await readFile(record(upgraded)), upgradedBytes)
  console.log('PASS: Harness storage upgrade preserves old bytes and receipts, supports updates and cold replay, and leaves the independent rollback copy usable.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
