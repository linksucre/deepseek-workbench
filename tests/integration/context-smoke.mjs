import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskContext } from '../../src/application/task-context.mjs'
import { createTaskService } from '../../src/application/task-service.mjs'
import { nativeStorageFixture } from './native-storage-fixture.mjs'

const useStorage = await nativeStorageFixture(process.argv[2] ?? '.')
const root = await mkdtemp(join(tmpdir(), 'workbench-task-context-'))
const storage = join(root, 'store')
const now = '2026-11-25T12:00:00Z'
const owner = { kind: 'user', actorId: 'owner' }
const outside = { kind: 'user', actorId: 'outside' }
const reference = { kind: 'file', locator: 'brief.md', observedAt: '2026-09-01T00:00:00Z' }
const restricted = { kind: 'file', locator: 'restricted.md', observedAt: now }
const contents = 'Evidence for the handoff'
let current
let snapshot
let reads = 0

function services(repository) {
  const app = createTaskService({
    repository,
    authorize: ({ principal, workspaceId }) => principal === owner && workspaceId === 'project',
    clock: () => now,
    delivery: {
      resolve: () => ({ artifacts: [{ id: 'artifact-1', kind: 'file', locator: reference.locator,
        versionKind: 'sha256', version: createHash('sha256').update(contents).digest('hex'), source: reference }], evidence: [] }),
    },
  })
  const context = createTaskContext({
    async loadTask(principal, taskId) {
      await app.get(principal, taskId)
      return repository.read(taskId)
    },
    canReadSource: ({ principal, workspaceId, source }) => principal === owner && workspaceId === 'project' &&
      source.kind === 'file' && source.locator === reference.locator,
    async readSource({ source }) {
      reads += 1
      return await readFile(join(root, source.locator), 'utf8')
    },
    clock: () => Date.parse(now),
  })
  return { app, context }
}

try {
  await writeFile(join(root, reference.locator), contents)
  await useStorage(storage, async repository => {
    const { app, context } = services(repository)
    current = await app.create(owner, {
      workspaceId: 'project', requestId: 'create', title: 'Brief', goal: 'Prepare a brief',
      materials: [reference, restricted], deliverables: ['brief.md'], criteria: [{ id: 'facts', description: 'Check facts' }],
    })
    const input = requestId => ({ taskId: current.task.id, expectedRevision: current.task.revision, requestId })
    current = await app.ready(owner, input('ready'))
    current = await app.reserveStart(owner, input('start'), { agentPreset: 'task-collaborator' })
    const intent = repository.read(current.task.id).pendingIntent
    current = await app.bindConfirmedRun(owner, input('bind'), {
      intentId: intent.intentId, sessionId: intent.reservedSessionId, workspaceId: intent.workspaceId,
      agentPreset: intent.agentPreset, afterSeq: 0,
    })
    current = await app.choose(owner, { ...input('choose'), choice: {
      domain: 'documents', methods: ['verify-first'], reason: 'Check older source', skillIds: [],
    } })
    current = await app.submit(owner, { ...input('submit'), selection: { selection: 'latest-presentation' } })
    current = await app.decide(owner, { ...input('return'), submissionId: current.task.currentSubmissionId,
      verdict: 'return', reason: 'Confirm the briefing date' })
    snapshot = await context.get(owner, current.task.id)
    assert.equal(snapshot.handoff.stage.runId, intent.runId)
    assert.equal(snapshot.handoff.lastDecision.reason, 'Confirm the briefing date')
    assert.deepEqual(snapshot.sources, [{ workspaceId: 'project', source: reference,
      origins: ['brief', 'submission'], freshness: 'stale' }])
    assert.equal(reads, 0)
  })
  await useStorage(storage, async repository => {
    const { context } = services(repository)
    assert.deepEqual(await context.get(owner, current.task.id), snapshot)
    assert.equal((await context.load(owner, current.task.id, reference)).content, contents)
    await assert.rejects(context.get(outside, current.task.id), { code: 'NOT_FOUND' })
    await assert.rejects(context.load(owner, current.task.id, restricted), { code: 'NOT_FOUND' })
    assert.equal(reads, 1)
  })
  console.log('PASS: authorized context, source freshness and stage handoff survive native storage reopen.')
} finally {
  await rm(root, { recursive: true, force: true })
}
