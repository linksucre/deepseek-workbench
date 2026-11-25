import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostTaskUsage } from '../../src/usage/host-usage.mjs'

const taskId = 'fa9ed1e1-5213-464b-9473-9f6e3c6a6dfc'
const owner = { kind: 'user', actorId: 'owner' }
const time = Date.parse('2026-11-25T00:00:00Z')
const cwd = '/workspace'
const route = { provider: 'deepseek-official', model: 'mock-model' }
const counts = (n, turn = 1) => ['assistant/message', { turn, step: 1, usage: {
  inputTokens: n, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
} }]
const catalog = childId => ['subagent/catalog', { childId, childCreatedAt: time, mode: 'continuable' }]
const cut = (id, rows, ancestry = {}) => ({
  header: { id, cwd, isSeeded: false, createdAt: time, ...ancestry },
  events: rows.map(([type, data, at = time], seq) => ({ type, data, seq, time: at })),
  inheritedEventCount: ancestry.isSeeded ? 2 : 0,
})

function fixture() {
  const run = { id: 'run', rootSessionId: 'root', childSessionIds: [], endedAt: null }
  const record = {
    detail: { task: { id: taskId, workspaceId: 'work', revision: 1 }, runs: [run] },
    stages: [{ runId: run.id, afterSeq: 1 }],
  }
  const observed = new Map([
    ['root', cut('root', [['request/context', route], counts(100, 0), counts(10)])],
  ])
  const reads = []
  const releases = []
  const workspace = { path: cwd, sessionIds: ['root'] }
  const host = {
    loadTask: async principal => principal === owner ? record : null,
    canReadSession: () => true,
    workspaceRegistry: { get: id => id === 'work' ? workspace : undefined },
    sessionQuery: {
      async observeSession(id) {
        reads.push(id)
        const result = observed.get(id)
        if (!result) throw Object.assign(new Error(), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return { ...result, [Symbol.dispose]() { releases.push(id) } }
      },
    },
  }
  return { host, observed, reads, releases, record, run, workspace }
}

test('enumerates only bound children with verified native ancestry and excludes the inherited prefix', async () => {
  const { host, reads, releases, observed, run } = fixture()
  run.childSessionIds = ['child', 'grandchild', 'other-root', 'child']
  observed.set('root', cut('root', [['request/context', route], counts(100, 0), counts(10),
    catalog('child'), catalog('unbound'), catalog('other-root')]))
  observed.set('child', cut('child', [['request/context', route], counts(100, 0), counts(2), catalog('grandchild')],
    { origin: 'subagent', parentSession: 'root', isSeeded: true }))
  observed.set('grandchild', cut('grandchild', [['request/context', route], counts(3)],
    { origin: 'subagent', parentSession: 'child' }))
  observed.set('other-root', cut('other-root', [['request/context', route], counts(900)],
    { origin: 'subagent', parentSession: 'another-root' }))

  const result = await createHostTaskUsage(host)(owner, taskId)
  assert.deepEqual(reads, ['root', 'child', 'other-root', 'grandchild'])
  assert.deepEqual(releases, reads)
  assert.equal(result.buckets[0].uncachedInput, 15)
  assert.equal(result.completeness, 'partial')
  assert.match(result.coverageNotes[0], /^2 bound or expected/)
})

test('rejects unverified callers and entitlement revoked while reading', async () => {
  const { host, reads, record } = fixture()
  await assert.rejects(createHostTaskUsage(host)({ kind: 'agent' }, taskId), { code: 'NOT_FOUND' })
  await assert.rejects(createHostTaskUsage(host)({ kind: 'user' }, taskId), { code: 'NOT_FOUND' })
  assert.deepEqual(reads, [])

  let checks = 0
  host.canReadSession = () => ++checks < 3
  await assert.rejects(createHostTaskUsage(host)(owner, taskId), { code: 'NOT_FOUND' })

  host.canReadSession = () => true
  host.loadTask = async () => ({ ...record, detail: { ...record.detail, task: {
    ...record.detail.task, revision: record.detail.task.revision + checks++,
  } } })
  await assert.rejects(createHostTaskUsage(host)(owner, taskId), { code: 'REVISION_CONFLICT' })
})

test('excludes post-close events and marks legacy runs without a verified start cursor as missing', async () => {
  const { host, run, record, reads, observed } = fixture()
  const afterClose = counts(900)
  afterClose.push(time + 10_000)
  observed.set('root', cut('root', [['request/context', route], counts(100, 0), counts(4), afterClose]))
  run.endedAt = new Date(time + 5_000).toISOString()
  const summarize = createHostTaskUsage(host)
  const result = await summarize(owner, taskId)
  assert.equal(result.buckets[0].uncachedInput, 4)

  record.stages = []
  const legacy = await summarize(owner, taskId)
  assert.equal(legacy.completeness, 'unknown')
  assert.deepEqual(legacy.buckets, [])
  assert.deepEqual(reads, ['root'])
})
