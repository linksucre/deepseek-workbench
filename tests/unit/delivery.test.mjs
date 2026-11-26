import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { createArtifactChecks } from '../../src/delivery/artifact-checks.mjs'
import { createLocalFiles } from '../../src/delivery/local-files.mjs'
import { observeArtifactVersions, resolveMachineEvidence, resolvePresentation } from '../../src/delivery/submission.mjs'

const now = '2026-11-25T12:00:00Z'
const stage = { afterSeq: 2, beforeSeq: 10 }
const sessionId = 'session-one'
const sha = text => createHash('sha256').update(text).digest('hex')
const present = (seq, ...paths) => ({ seq, type: 'deliverables/presented', data: { files: paths.map(path => ({ path })) } })

async function fixture(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'workbench-delivery-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const root = join(tmp, 'workspace')
  const cwd = join(root, 'draft')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'first.md'), 'first')
  await writeFile(join(cwd, 'second.md'), 'second')
  await writeFile(join(cwd, 'hidden.md'), 'hidden')
  await writeFile(join(tmp, 'outside.md'), 'outside')
  await symlink(join(tmp, 'outside.md'), join(cwd, 'link.md'))
  let id = 0
  const files = await createLocalFiles({ root, cwd, maxBytes: 8, authorizePath: path => !path.endsWith('hidden.md') })
  return { tmp, root, cwd, files, newArtifactId: () => `artifact-${++id}` }
}

test('latest selects only the current stage presentation and records its event reference', async t => {
  const f = await fixture(t)
  const artifacts = await resolvePresentation({
    ...f, sessionId, stage, now,
    events: [present(2, 'hidden.md'), present(3, 'first.md'), present(6, 'second.md'), present(10, 'hidden.md')],
    selection: { selection: 'latest-presentation' },
  })
  assert.deepEqual(artifacts.map(({ version, source }) => [version, JSON.parse(source.locator)]),
    [[sha('second'), [sessionId, 6, 0]]])
})

test('explicit selection uses each file’s last presentation and rejects duplicates or files from another stage', async t => {
  const f = await fixture(t)
  const run = {
    ...f, sessionId, stage, now,
    events: [present(2, 'hidden.md'), present(4, 'first.md'), present(6, 'first.md', 'second.md')],
  }
  const selection = paths => ({ selection: 'files', paths })
  const artifacts = await resolvePresentation({ ...run, selection: selection(['first.md', 'second.md']) })
  assert.deepEqual(artifacts.map(item => JSON.parse(item.source.locator)), [[sessionId, 6, 0], [sessionId, 6, 1]])
  await assert.rejects(resolvePresentation({ ...run, selection: selection(['first.md', './first.md']) }), { code: 'INVALID' })
  await assert.rejects(resolvePresentation({ ...run, selection: selection(['hidden.md']) }), { code: 'INVALID' })
})

test('version observations reflect content changes; local reads enforce workspace, permission and size', async t => {
  const f = await fixture(t)
  const artifacts = await resolvePresentation({
    ...f, sessionId, stage, now, events: [present(5, 'first.md')],
    selection: { selection: 'latest-presentation' },
  })
  await writeFile(join(f.cwd, 'first.md'), 'modified')
  assert.equal(artifacts[0].version, sha('first'))
  assert.equal((await observeArtifactVersions(artifacts, f.files))[0].version, sha('modified'))
  await writeFile(join(f.cwd, 'first.md'), 'oversized')
  await assert.rejects(observeArtifactVersions(artifacts, f.files), { code: 'ARTIFACT_DRIFT' })
  await assert.rejects(f.files.digest(join(f.tmp, 'outside.md')), { code: 'FORBIDDEN' })
  await assert.rejects(f.files.digest('hidden.md'), { code: 'FORBIDDEN' })
  await assert.rejects(f.files.digest('link.md'), { code: 'INVALID' })
})

test('machine evidence admits only stage-bound host checks for known criteria and deduplicates replay', () => {
  const check = { seq: 7, criterionId: 'build', exitCode: 1, observedAt: now }
  const evidence = resolveMachineEvidence({
    sessionId, stage, criterionIds: new Set(['build']),
    checks: [check, check, { ...check, seq: 2 }, { ...check, criterionId: 'other' }, { ...check, exitCode: null }],
  })
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].outcome, 'fail')
  assert.deepEqual(JSON.parse(evidence[0].source.locator), [sessionId, 7])
})

test('fixed checks record the observed file version, task criterion and authorized presentation', async t => {
  const f = await fixture(t)
  const locator = f.files.normalize('report.json')
  const title = 'Convert report'
  const task = { title, criteria: [{ id: 'json', description: 'Parse JSON' }, { id: 'size', description: 'Nonempty report' }] }
  const rules = task.criteria.map(({ id, description }) => ({
    workspace: f.files.root, taskTitle: title, criterionId: id, description, path: 'draft/report.json',
    check: id === 'json' ? 'json' : 'nonempty',
  }))
  const check = createArtifactChecks({ z, policy: rules })
  assert.throws(() => createArtifactChecks({ z, policy: [rules[0], rules[0]] }), /duplicate/i)
  assert.throws(() => createArtifactChecks({ z, policy: [{ ...rules[0], path: '../report.json' }] }))

  const source = { kind: 'session-event', locator: JSON.stringify([sessionId, 6, 0]), observedAt: now }
  const run = async contents => {
    await writeFile(locator, contents)
    const artifact = { locator, version: await f.files.digest(locator), source }
    return { task, files: f.files, artifacts: [artifact], now }
  }
  const good = await run('{"x":1}')
  assert.deepEqual((await check(good)).map(({ kind, criterionId, outcome, source: ref }) =>
    [kind, criterionId, outcome, ref]), [['machine', 'json', 'pass', source], ['machine', 'size', 'pass', source]])
  assert.deepEqual(await check({ ...good, task: { ...task, title: 'Different task' } }), [])
  assert.deepEqual(await check({ ...good, files: { root: f.tmp } }), [])
  await assert.rejects(check({ ...good, artifacts: [] }), { code: 'INVALID' })
  assert.deepEqual((await check(await run(Buffer.from([0x22, 0xff, 0x22])))).map(item => item.outcome), ['fail', 'pass'])
  assert.deepEqual((await check(await run(''))).map(item => item.outcome), ['fail', 'fail'])
  await assert.rejects(check(good), { code: 'ARTIFACT_DRIFT' })
})
