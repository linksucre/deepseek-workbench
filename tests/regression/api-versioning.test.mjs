import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'

const load = async (version, name) => JSON.parse(await readFile(
  new URL(`../../contracts/v${version}/${name}.json`, import.meta.url), 'utf8',
))
const [v1, v2] = await Promise.all([1, 2].map(version => load(version, 'schemas')))
const ajv = new Ajv2020({ validateFormats: false })
ajv.addSchema(v1).addSchema(v2)
const validate = (schema, name) => ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })
const id = '00000000-0000-4000-8000-000000000001'

test('v2 preserves existing operation IDs, actors and schema names', async () => {
  const [original, current] = await Promise.all([1, 2].map(version => load(version, 'operations')))
  const byName = new Map(current.operations.map(operation => [operation.id, operation]))
  for (const operation of original.operations) assert.deepEqual(byName.get(operation.id), operation)
  for (const operation of current.operations) {
    validate(v2, operation.input)
    validate(v2, operation.output)
  }
  validate(v2, current.error)
})

test('v1 and v2 accept their own submit shapes for both callers', () => {
  for (const [name, base] of [
    ['SubmitTask', { taskId: id, requestId: 'submit', expectedRevision: 1 }],
    ['AgentSubmit', {}],
  ]) {
    const old = validate(v1, name)
    const next = validate(v2, name)
    const references = { ...base, artifactIds: [id], evidenceRefs: [] }
    const latest = { ...base, selection: 'latest-presentation' }
    const files = { ...base, selection: 'files', paths: ['brief.md'] }
    assert.equal(old(references), true, JSON.stringify(old.errors))
    assert.equal(next(references), false)
    assert.equal(old(latest), false)
    assert.equal(old(files), false)
    assert.equal(next(latest), true, JSON.stringify(next.errors))
    assert.equal(next(files), true, JSON.stringify(next.errors))
    assert.equal(next({ ...base, selection: 'files' }), false)
    assert.equal(next({ ...latest, paths: files.paths }), false)
  }
})

test('strict v1 decision readers reject v2 evidence fields', () => {
  const original = { submissionId: id, verdict: 'accept', decidedAt: '2026-11-26T00:00:00Z', actorId: 'owner', reason: null }
  const old = validate(v1, 'Decision')
  const next = validate(v2, 'Decision')
  assert.equal(old(original), true, JSON.stringify(old.errors))
  assert.equal(next(original), true, JSON.stringify(next.errors))
  assert.equal(old({ ...original, reviewEvidence: [] }), false)
  assert.equal(next({ ...original, reviewEvidence: [] }), true, JSON.stringify(next.errors))
})
