import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskContext } from '../../src/application/task-context.mjs'

const owner = { kind: 'user', actorId: 'owner' }
const observedAt = '2026-09-01T00:00:00Z'
const material = { kind: 'file', locator: 'brief.md', observedAt }
const hidden = { ...material, locator: 'private.md' }
const claim = { ...material, locator: 'model-claim.md' }
const taskId = 'task-1'
const choice = { methods: ['verify-first'], source: 'user', reason: 'Check the old brief' }

function fixture() {
  const submission = { id: 'submission', runId: 'run', submittedAt: observedAt,
    artifactIds: ['artifact'], evidence: [{ kind: 'model-claim', source: claim }] }
  const record = {
    detail: {
      task: { id: taskId, workspaceId: 'workspace', revision: 3, title: 'Review brief', goal: 'Check facts',
        materials: [material, hidden, material], activeRunId: 'run', status: 'active', choice,
        deliverables: ['brief'], criteria: [{ id: 'facts' }] },
      runs: [{ id: 'run' }], submissions: [submission], artifacts: [{ id: 'artifact', source: material },
        { id: 'not-submitted', source: claim }],
      decisions: [{ submissionId: submission.id, verdict: 'return', reason: 'Revise the sources', decidedAt: observedAt }],
    },
    stages: [{ stageId: 'phase', runId: 'run', openedAt: observedAt, afterSeq: 3, choices: [{ choice }] }],
  }
  const reads = []
  const ports = {
    loadTask: principal => principal === owner ? record : undefined,
    canReadSource: ({ source, workspaceId }) => workspaceId === 'workspace' && source.locator !== hidden.locator,
    readSource: ({ source }) => { reads.push(source.locator); return { text: 'source content' } },
    clock: () => Date.parse('2026-11-25T12:00:00Z'),
  }
  return { ports, reads, record }
}

test('indexes only authorized saved sources, without reading content, and retains the stage and review reason', async () => {
  const { ports, reads } = fixture()
  const context = createTaskContext(ports)
  await assert.rejects(context.get({ kind: 'user', actorId: 'other' }, taskId), { code: 'NOT_FOUND' })
  const result = await context.get(owner, taskId)
  assert.deepEqual(result.sources, [{ workspaceId: 'workspace', source: material,
    origins: ['brief', 'submission'], freshness: 'stale' }])
  assert.equal(result.handoff.stage.stageId, 'phase')
  assert.equal(result.handoff.stage.afterSeq, 3)
  assert.equal(result.handoff.lastDecision.reason, 'Revise the sources')
  assert.deepEqual(result.handoff.choice, choice)
  assert.deepEqual(reads, [])
  assert.deepEqual((await context.load(owner, taskId, material)).content, { text: 'source content' })
  assert.deepEqual(reads, ['brief.md'])
})

test('rejects forged or hidden sources and discards a result after revocation or a revision change', async () => {
  const { ports, reads, record } = fixture()
  await assert.rejects(createTaskContext(ports).load(owner, taskId, claim), { code: 'NOT_FOUND' })
  await assert.rejects(createTaskContext(ports).load(owner, taskId, hidden), { code: 'NOT_FOUND' })
  await assert.rejects(createTaskContext(ports).load(owner, taskId, { ...material, observedAt: '2026-10-01T00:00:00Z' }),
    { code: 'NOT_FOUND' })
  assert.deepEqual(reads, [])

  let permitted = true
  ports.canReadSource = () => permitted
  ports.readSource = () => { permitted = false; return 'already fetched' }
  await assert.rejects(createTaskContext(ports).load(owner, taskId, material), { code: 'NOT_FOUND' })

  ports.canReadSource = () => true
  ports.readSource = () => { record.detail.task.revision += 1; return 'old revision data' }
  await assert.rejects(createTaskContext(ports).load(owner, taskId, material), { code: 'REVISION_CONFLICT' })
})
