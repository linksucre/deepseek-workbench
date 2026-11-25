import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
