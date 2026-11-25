import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { createDraft, evolveTask } from '../../src/domain/task.mjs'

const now = '2026-11-25T12:00:00.000Z'
const brief = {
  title: '产品介绍', goal: '整理可编辑的产品介绍', materials: [],
  deliverables: ['brief.md'], criteria: [{ id: 'claims', description: '核对关键事实' }],
}
const run = {
  id: 'run-1', rootSessionId: 'session-1', childSessionIds: [], intentId: 'intent-1',
  startedAt: now, endedAt: null,
}
const check = {
  criterionId: 'claims', kind: 'machine', outcome: 'pass',
  source: { kind: 'session-event', locator: 'tool-result-1', observedAt: now },
  observedAt: now, summary: '核对通过',
}
const create = (input = brief) => createDraft({
  id: 'b01f7a11-1b38-41a3-8af7-9f2589279201', workspaceId: 'workspace-1', brief: input, now,
})
const apply = (detail, command) => evolveTask(detail, command, { expectedRevision: detail.task.revision, now })
const active = () => apply(apply(create(), { kind: 'ready' }), { kind: 'bind', run })
const version = (artifactId, value) => ({ artifactId, versionKind: 'sha256', version: value })
const submission = (index, hash, evidence = [check]) => ({
  kind: 'submit', submissionId: `sub-${index}`, evidence,
  artifacts: [{
    id: `artifact-${index}`, kind: 'file', locator: 'brief.md',
    versionKind: 'sha256', version: hash,
    source: { kind: 'session-event', locator: `present-${index}`, observedAt: now },
  }],
})
const review = (kind, index, hash) => ({
  kind, actorId: 'user-1', submissionId: `sub-${index}`,
  reason: kind === 'return' ? '文件内容已变更' : null,
  observedVersions: [version(`artifact-${index}`, hash)],
})

test('readiness requires a deliverable and criterion; editing a ready brief returns it to draft', () => {
  const empty = create({ ...brief, deliverables: [], criteria: [] })
  assert.throws(() => apply(empty, { kind: 'ready' }), { code: 'INVALID' })
  assert.throws(() => create({ ...brief, criteria: [...brief.criteria, ...brief.criteria] }), { code: 'INVALID' })
  const ready = apply(create(), { kind: 'ready' })
  const edited = apply(ready, { kind: 'update-brief', brief: { ...brief, deliverables: [] } })
  assert.equal(edited.task.status, 'draft')
  assert.equal(ready.task.status, 'ready')
  assert.equal(edited.task.revision, 2)
})

test('recovering a blocked start needs a confirmed binding; pause and resume preserve the run', () => {
  const ready = apply(create(), { kind: 'ready' })
  const blocked = apply(ready, { kind: 'block-start' })
  assert.throws(() => apply(blocked, { kind: 'bind', run: { ...run, rootSessionId: null } }), { code: 'INVALID' })
  assert.throws(() => apply(blocked, { kind: 'cancel' }), { code: 'INVALID' })
  const bound = apply(blocked, { kind: 'bind', run })
  assert.throws(() => apply(bound, { kind: 'bind', run }), { code: 'INVALID_TRANSITION' })
  assert.throws(() => apply(bound, { kind: 'pause' }), { code: 'INVALID' })
  const paused = apply(bound, { kind: 'pause', stopConfirmed: true })
  assert.throws(() => apply(paused, { kind: 'resume' }), { code: 'INVALID' })
  const resumed = apply(paused, { kind: 'resume', resumeConfirmed: true })
  assert.deepEqual(resumed.runs, [run])
  assert.equal(resumed.task.activeRunId, run.id)
  assert.equal(resumed.task.status, 'active')
})

test('rejects stale commands, drift, and acceptance of old submissions; preserves both submitted versions', async () => {
  const first = submission(1, 'sha-old')
  const awaiting = apply(active(), first)
  first.artifacts[0].version = 'mutated input'
  assert.equal(awaiting.artifacts[0].version, 'sha-old')
  assert.throws(() => evolveTask(awaiting, review('accept', 1, 'sha-old'), { expectedRevision: 0, now }),
    { code: 'REVISION_CONFLICT' })
  assert.throws(() => apply(awaiting, review('accept', 1, 'sha-changed')), { code: 'ARTIFACT_DRIFT' })
  assert.equal(awaiting.task.status, 'review')
  assert.equal(awaiting.decisions.length, 0)
  const returned = apply(awaiting, review('return', 1))
  const refiled = apply(returned, submission(2, 'sha-new'))
  assert.throws(() => apply(refiled, review('accept', 1, 'sha-old')), { code: 'INVALID' })
  const accepted = apply(refiled, review('accept', 2, 'sha-new'))
  assert.equal(accepted.task.status, 'accepted')
  assert.equal(accepted.task.activeRunId, null)
  assert.equal(accepted.runs[0].endedAt, now)
  assert.deepEqual(accepted.decisions.map(item => item.verdict), ['return', 'accept'])
  assert.deepEqual(accepted.artifacts.map(item => item.version), ['sha-old', 'sha-new'])
  assert.throws(() => apply(accepted, { kind: 'cancel' }), { code: 'INVALID_TRANSITION' })

  const schema = JSON.parse(await readFile(new URL('../../contracts/v1/schemas.json', import.meta.url), 'utf8'))
  const ajv = new Ajv2020({ validateFormats: false })
  ajv.addSchema(schema)
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/TaskDetail` })
  assert.ok(validate(accepted), JSON.stringify(validate.errors))
})

test('model claims and conflicting checks cannot satisfy acceptance evidence', () => {
  for (const evidence of [
    [{ ...check, kind: 'model-claim' }],
    [{ ...check, source: null }],
    [check, { ...check, outcome: 'fail' }],
  ]) {
    const awaiting = apply(active(), submission(1, 'sha-old', evidence))
    assert.throws(() => apply(awaiting, review('accept', 1, 'sha-old')), { code: 'INVALID' })
  }
})
