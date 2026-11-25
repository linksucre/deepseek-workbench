import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskService } from '../../src/application/task-service.mjs'
import { createLocalFiles } from '../../src/delivery/local-files.mjs'
import { observeArtifactVersions, resolveMachineEvidence, resolvePresentation } from '../../src/delivery/submission.mjs'
import { nativeStorageFixture } from './native-storage-fixture.mjs'

const useStorage = await nativeStorageFixture(process.argv[2] ?? '.')
const temp = await mkdtemp(join(tmpdir(), 'dsh-application-smoke-'))
const root = join(temp, 'workspace')
const store = join(temp, 'store')
const now = '2026-11-25T12:00:00Z'
const owner = { kind: 'user', actorId: 'owner' }
const stranger = { kind: 'user', actorId: 'stranger' }
const authorize = ({ principal, workspaceId }) => workspaceId === 'project'
  && (principal.actorId === owner.actorId || principal.kind === 'agent')
const brief = {
  requestId: 'create', workspaceId: 'project', title: 'Brief', goal: 'Prepare a brief',
  materials: [], deliverables: ['brief.md'], criteria: [{ id: 'facts', description: 'Check facts' }],
}
const selection = { selection: 'latest-presentation' }
const choice = { domain: 'documents', methods: ['direct'], reason: 'Clear initial brief', skillIds: [] }
let current
let intent
let agent
let seq = 3
let calls = 0
let generated = 0
const input = (requestId, extra = {}) => ({
  taskId: current.task.id, expectedRevision: current.task.revision, requestId, ...extra,
})

try {
  await mkdir(root)
  const files = await createLocalFiles({ root, authorizePath: () => true })
  await writeFile(join(root, 'brief.md'), 'version 1')
  const delivery = {
    async resolve({ principal, input }) {
      calls += 1
      const sessionId = principal.sessionId
      const stage = { afterSeq: 0, beforeSeq: seq + 2 }
      return {
        artifacts: await resolvePresentation({
          sessionId, stage, selection: input.selection, files, now, newArtifactId: () => `file-${seq}`,
          events: [{ type: 'deliverables/presented', seq, data: { files: [{ path: 'brief.md' }] } }],
        }),
        evidence: resolveMachineEvidence({
          sessionId, stage, criterionIds: new Set(['facts']),
          checks: [{ seq: seq + 1, exitCode: 0, criterionId: 'facts', observedAt: now }],
        }),
      }
    },
    observe: ({ artifacts }) => observeArtifactVersions(artifacts, files),
  }
  const service = repository => createTaskService({
    repository, authorize, delivery, clock: () => now, newId: () => `id-${++generated}`,
  })

  await useStorage(store, async repo => {
    const app = service(repo)
    current = await app.create(owner, brief)
    assert.deepEqual(await app.create(owner, { ...brief }), current)
    await assert.rejects(app.get(stranger, current.task.id), { code: 'NOT_FOUND' })
    current = await app.ready(owner, input('ready'))
    current = await app.reserveStart(owner, input('reserve'), { agentPreset: 'task-collaborator' })
    assert.equal(current.task.status, 'blocked')
    intent = repo.read(current.task.id).pendingIntent
  })
  await useStorage(store, async repo => {
    const app = service(repo)
    assert.deepEqual(repo.read(current.task.id).pendingIntent, intent)
    const verified = {
      intentId: intent.intentId, sessionId: intent.reservedSessionId,
      workspaceId: intent.workspaceId, agentPreset: intent.agentPreset,
    }
    await assert.rejects(app.bindConfirmedRun(owner, input('bind'), { ...verified, sessionId: 'foreign' }),
      { code: 'RECONCILIATION_REQUIRED' })
    current = await app.bindConfirmedRun(owner, input('bind'), verified)
    agent = { kind: 'agent', sessionId: verified.sessionId, workspaceId: verified.workspaceId }
    await assert.rejects(app.choose({ ...agent, sessionId: 'other' }, input('choice', { choice })),
      { code: 'NOT_FOUND' })
    current = await app.choose(agent, input('choice', { choice }))
    current = await app.choose(owner, input('user-choice', { choice: { ...choice, methods: ['verify-first'] } }))
    await assert.rejects(app.choose(agent, input('override', { choice })), { code: 'INVALID_TRANSITION' })
    const submit = input('submit', { selection })
    current = await app.submit(agent, submit)
    assert.deepEqual(await app.submit(agent, submit), current)
    assert.equal(calls, 1)
  })
  await writeFile(join(root, 'brief.md'), 'version 2')
  await useStorage(store, async repo => {
    const app = service(repo)
    assert.deepEqual(await app.get(owner, current.task.id), current)
    const old = current.task.currentSubmissionId
    const decision = input('decide', { submissionId: old, verdict: 'accept', reason: null })
    await assert.rejects(app.decide(agent, decision), { code: 'FORBIDDEN' })
    await assert.rejects(app.decide(owner, decision), { code: 'ARTIFACT_DRIFT' })
    assert.deepEqual(await app.get(owner, current.task.id), current)
    current = await app.decide(owner, input('return', { submissionId: old, verdict: 'return', reason: 'Content drifted' }))
    seq = 7
    current = await app.submit(agent, input('resubmit', { selection }))
    current = await app.decide(owner, input('accept', {
      submissionId: current.task.currentSubmissionId, verdict: 'accept', reason: null,
    }))
    assert.equal(current.task.status, 'accepted')
    assert.equal(current.submissions.length, 2)
    assert.notEqual(current.artifacts[0].version, current.artifacts[1].version)
    assert.deepEqual(current.decisions.map(item => item.verdict), ['return', 'accept'])
    const choices = repo.read(current.task.id).operations
      .filter(receipt => receipt.operation === 'task.choose').map(receipt => receipt.result.task.choice.source)
    assert.deepEqual(choices, ['agent', 'user'])
  })
  console.log('PASS: application with native storage, intent recovery boundary, authorization, override, replay, drift, return and acceptance.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
