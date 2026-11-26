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
    async resolve({ record, principal, input }) {
      calls += 1
      const sessionId = principal.sessionId
      const currentStage = record.stages.at(-1)
      const stage = { afterSeq: currentStage.deliveryAfterSeq ?? currentStage.afterSeq, beforeSeq: seq + 2 }
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
    observeReturn: () => seq + 1,
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
      workspaceId: intent.workspaceId, agentPreset: intent.agentPreset, afterSeq: 0,
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
    const stage = repo.read(current.task.id).stages[0]
    assert.equal(stage.stageId, current.runs[0].id)
    assert.equal(stage.deliveryAfterSeq, 4)
    assert.equal(stage.afterSeq, 0)
    assert.deepEqual(stage.choices.map(item => item.choice.source), ['agent', 'user'])
    assert.ok(stage.choices[0].revision < stage.choices[1].revision)
  })
  const approaches = [
    { domain: 'development', title: 'Small validation fix', methods: ['direct'], reason: 'Small change with a clear check', skillIds: [] },
    { domain: 'design', title: 'Explore the first screen', methods: ['direction-review'], reason: 'Review a direction before polishing', skillIds: [] },
    { domain: 'writing', title: 'Newsletter update', methods: ['reuse'], reason: 'Use the established editorial workflow', skillIds: ['editorial-fixture'] },
    { domain: 'documents', title: 'Source comparison memo', methods: ['verify-first'], reason: 'Verify source dates before drafting', skillIds: [] },
  ]
  const historical = []
  await useStorage(store, async repo => {
    const app = service(repo)
    for (const { title, ...approach } of approaches) {
      current = await app.create(owner, { ...brief, title, requestId: `create-${approach.domain}` })
      current = await app.ready(owner, input('ready'))
      current = await app.reserveStart(owner, input('reserve'), { agentPreset: 'task-collaborator' })
      const reserved = repo.read(current.task.id).pendingIntent
      current = await app.bindConfirmedRun(owner, input('bind'), {
        intentId: reserved.intentId, sessionId: reserved.reservedSessionId,
        workspaceId: reserved.workspaceId, agentPreset: reserved.agentPreset, afterSeq: 0,
      })
      const collaborator = { kind: 'agent', sessionId: reserved.reservedSessionId, workspaceId: reserved.workspaceId }
      current = await app.choose(collaborator, input('recommend', { choice: approach }))
      assert.deepEqual(current.task.choice, { ...approach, source: 'agent' })
      const override = { ...approach, methods: ['verify-first', 'reuse'], reason: 'Owner revised the execution order' }
      const choiceInput = input('revise', { choice: override })
      current = await app.choose(owner, choiceInput)
      await assert.rejects(app.choose(collaborator, input('rejected-in-run', { choice: approach })),
        { code: 'INVALID_TRANSITION' })
      historical.push({ current, approach, override, choiceInput })
    }
  })
  await useStorage(store, async repo => {
    const app = service(repo)
    for (const { current: expected, approach, override, choiceInput } of historical) {
      assert.deepEqual(await app.get(owner, expected.task.id), expected)
      assert.deepEqual(await app.choose(owner, choiceInput), expected)
      assert.deepEqual(repo.read(expected.task.id).stages[0].choices.map(item => item.choice),
        [{ ...approach, source: 'agent' }, { ...override, source: 'user' }])
    }
  })
  console.log('PASS: application with native storage, intent recovery boundary, authorization, four execution choices, override, replay, drift, return and acceptance.')
} finally {
  await rm(temp, { recursive: true, force: true })
}
