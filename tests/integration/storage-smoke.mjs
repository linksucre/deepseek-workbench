import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraft, evolveTask } from '../../src/domain/task.mjs'
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
  console.log('PASS: native storage atomic revision, request replay, pending intent, reopen and backup recovery.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
