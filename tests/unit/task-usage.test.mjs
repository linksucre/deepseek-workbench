import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeTaskUsage } from '../../src/usage/task-usage.mjs'

const taskId = 'f86b562f-2555-4ba8-9220-4a2987b59a27'
const time = Date.parse('2026-11-25T00:00:00Z')
const route = { provider: 'deepseek-official', model: 'test-model' }
const step = { turn: 1, step: 1 }
const tokens = (inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) =>
  ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
const scope = (sessionId, records, afterSeq = -1, inheritedEventCount = 0) => ({
  sessionId, afterSeq, inheritedEventCount,
  events: records.map(([type, data, date = time], seq) => ({ type, data, time: date, seq })),
})
const message = usage => ['assistant/message', { ...step, usage }]
const summarize = (sessions, options) => summarizeTaskUsage({ taskId, sessions, ...options })

test('counts distinct retry attempts once, excluding inherited and pre-Run settlements', () => {
  const history = [
    ['request/context', route], ['step/start', step], message(tokens(100, 100)),
    ['request/context', route], ['step/start', step],
    ['assistant/attempt', { ...step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: tokens(2, 1) } }] }],
    ['llm/retry-started', step], message(tokens(3, 2)), message(tokens(3, 2)),
  ]
  const root = scope('root', history, 2)
  const child = scope('child', [...history, ['step/start', step], message(tokens(5, 4, 7))], -1, history.length)
  const result = summarize([root, root, child])
  assert.equal(result.completeness, 'complete')
  assert.deepEqual(result.buckets, [{ ...route, uncachedInput: 10, output: 7, cacheRead: 7, cacheWrite: 0 }])
})

test('retains available fields while distinguishing missing deepseek counts from explicit cache zero', () => {
  const native = scope('root', [['request/context', route], ['step/start', step], message({
    inputTokens: 0, outputTokens: 2, cacheReadTokens: 0,
  })])
  const result = summarize([native], { missingSessions: 1 })
  assert.equal(result.completeness, 'partial')
  assert.deepEqual(result.buckets, [{ ...route, uncachedInput: null, output: 2, cacheRead: 0, cacheWrite: null }])
  assert.equal(result.estimatedCost, null)
  assert.equal(result.coverageNotes.length, 2)
  assert.equal(summarize([scope('root', [['request/context', route], ['step/start', step]])]).completeness, 'unknown')
})

test('omits ambiguous observations and reports their coverage gap', () => {
  const first = scope('root', [['request/context', route], ['step/start', step], message(tokens(1, 2))])
  const conflicting = scope('root', [['request/context', route], ['step/start', step], message(tokens(8, 2))])
  const result = summarize([first, conflicting])
  assert.equal(result.completeness, 'unknown')
  assert.deepEqual(result.buckets, [])
  assert.match(result.coverageNotes[0], /conflicting or incomplete/)
})

test('estimates decimal costs per attempt, with no fabricated amount for missing or mixed rates', () => {
  const tomorrow = time + 86_400_000
  const model2 = { ...route, model: 'another-model' }
  const native = scope('root', [
    ['request/context', route], ['step/start', step], message(tokens(3, 1, 2)),
    ['request/context', model2], ['step/start', { ...step, step: 2 }, tomorrow],
    ['assistant/message', { ...step, step: 2, usage: tokens(7, 2) }, tomorrow],
  ])
  const rate = { currency: 'USD', rateDate: '2026-11-25', perMillion: { uncachedInput: '1.25', output: '5.1', cacheRead: '0.2' } }
  const lookupRate = ({ model, time: at }) => {
    assert.equal(at, model === route.model ? time : tomorrow)
    return model === route.model ? rate : { ...rate, rateDate: '2026-11-26' }
  }
  assert.deepEqual(summarize([native], { lookupRate }).estimatedCost, {
    decimalAmount: '0.0000282', currency: 'USD', rateDate: '2026-11-26',
  })
  assert.equal(summarize([native], { lookupRate: ({ model }) => model === route.model ? rate : undefined }).estimatedCost, null)
  assert.equal(summarize([native], { lookupRate: ({ model }) => model === route.model ? rate : { ...rate, currency: 'CNY' } }).estimatedCost, null)
})
