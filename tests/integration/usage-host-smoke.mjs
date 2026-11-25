import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { summarizeTaskUsage } from '../../src/usage/task-usage.mjs'

const upstream = resolve(process.argv[2] ?? '.')
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url)))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim(), baseline.commit)

const samples = new Map([
  ['usage-known', { input_tokens: 3, output_tokens: 1 }],
  ['usage-omitted', {}],
  ['usage-explicit-zero', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
  ['usage-provider-refusal', { input_tokens: 7, output_tokens: 2 }],
])
const childSamples = new Map([
  ['usage-bound-child', { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
  ['usage-unbound-child', { input_tokens: 13, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
])
const retryPrompt = 'usage-transient-retry'
const cancelPrompt = 'usage-cancelled-stream'
const lifecycleSamples = new Map([
  [retryPrompt, { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
  [cancelPrompt, {}],
])
const data = await mkdtemp(join(tmpdir(), 'workbench-usage-'))
const taskId = 'de39c282-481c-4939-8e50-673bf5da7c76'
const patch = join(data, 'usage.patch.yml')
let modelCalls = 0
let retryCalls = 0
let cancellationSampleStarted = false
let child
let closed

const provider = createServer(async (req, res) => {
  const chunks = []
  try {
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks))
    const finalMessage = JSON.stringify(input.messages.at(-1))
    const sample = [...samples, ...childSamples, ...lifecycleSamples].find(([prompt]) => finalMessage.includes(prompt))
    assert.ok(sample, 'the mock only serves known usage fixtures')
    modelCalls += 1
    const hasTools = input.tools?.length > 0
    if (sample[0] === retryPrompt && hasTools && ++retryCalls === 1) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'transient local test fault' } }))
      return
    }
    const events = [
      { type: 'message_start', message: { id: sample[0], model: 'mock-model', usage: sample[1] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: sample[0] === 'usage-provider-refusal' ? 'refusal' : 'end_turn' } },
      { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (sample[0] === cancelPrompt && hasTools) {
      res.write(events.slice(0, 2).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
      cancellationSampleStarted = true
      return
    }
    res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  } catch {
    res.writeHead(400).end()
  }
})

async function stop() {
  if (child === undefined) return
  child.kill()
  await closed
  child = undefined
}

async function start(bindings, { modelEnabled = true } = {}) {
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', patch,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: upstream,
    env: {
      ...process.env,
      DSH_HOME: join(data, 'dsh'), DSH_AGENTS_HOME: join(data, 'agents'),
      DEEPSEEK_API_KEY: modelEnabled ? 'mock-usage-key' : '',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      WORKBENCH_USAGE_TEST_BINDINGS: bindings === undefined ? '' : JSON.stringify(bindings),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = once(child, 'close')
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString() })
  const deadline = Date.now() + 60_000
  let url
  while (Date.now() < deadline && child.exitCode === null) {
    url = /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1]
    if (url) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(url, 'mock Host starts')
  const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  assert.equal(auth.status, 303)
  const cookie = auth.headers.get('set-cookie').split(';', 1)[0]
  const origin = new URL(url).origin
  return async function rpc(method, request) {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }),
    })
    assert.equal(response.status, 200)
    const { result } = await response.json()
    assert.equal(result.ok, true, `${method}: ${JSON.stringify(result.error)}`)
    return result.value
  }
}

async function measure(rpc, sessionId) {
  const projection = await rpc('session/projections', { sessionId })
  const page = await rpc('session/events', { address: { kind: 'session', sessionId } })
  assert.equal(page.hasMore, false, 'fixture reads one complete history')
  const events = page.records.map(record => record.event).filter(Boolean)
  const settlements = events.filter(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')
  assert.equal(settlements.length, 1, 'one native settlement per fixture session')
  const route = events.find(event => event.type === 'request/context')
  assert.ok(route?.data.provider && route.data.model, 'native history identifies its provider and model')
  const [settlement] = settlements
  const usage = settlement.data.usage ?? settlement.data.stream.findLast(record =>
    record.type === 'chunk' && record.chunk.type === 'usage')?.chunk.usage
  const taskUsage = summarizeTaskUsage({
    taskId,
    sessions: [{ sessionId, afterSeq: -1, inheritedEventCount: 0, events }],
  })
  return { totals: projection.values.tokenUsage, settlement: settlement.type, usage, route: route.data, taskUsage }
}

async function readLifecycle(rpc, sessionId) {
  const projection = await rpc('session/projections', { sessionId })
  const page = await rpc('session/events', { address: { kind: 'session', sessionId } })
  const events = page.records.map(record => record.event).filter(Boolean)
  assert.equal(page.hasMore, false)
  return {
    totals: projection.values.tokenUsage,
    attemptsRetried: events.filter(event => event.type === 'llm/retry-started').length,
    end: events.findLast(event => event.type === 'turn/end')?.data.reason.kind,
    taskUsage: summarizeTaskUsage({ taskId, sessions: [{ sessionId, afterSeq: -1, inheritedEventCount: 0, events }] }),
  }
}

try {
  const fixture = new URL('./fixtures/usage-reader.mjs', import.meta.url).href
  await writeFile(patch, `- insert:\n    - id: workbench-test-usage\n      name: ${JSON.stringify(fixture)}\n`)
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  let rpc = await start()
  const { workspace } = await rpc('workspace/create', { path: data })
  const sessions = []
  for (const prompt of samples.keys()) {
    const { sessionId } = await rpc('session/create', { workspaceId: workspace.workspaceId })
    await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: prompt }] })
    assert.equal((await rpc('session/wait', { sessionId, timeoutMs: 8_000 })).reason, 'idle')
    sessions.push(sessionId)
  }
  const live = await Promise.all(sessions.map(id => measure(rpc, id)))
  const [known, omitted, explicitZero, refused] = live
  assert.deepEqual(known.totals, { uncachedInputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.deepEqual(omitted.totals, explicitZero.totals)
  for (const record of [omitted, explicitZero]) {
    assert.equal(record.usage.inputTokens, 0)
    assert.equal(record.usage.outputTokens, 0)
  }
  assert.equal(omitted.usage.cacheReadTokens, undefined)
  assert.equal(explicitZero.usage.cacheReadTokens, 0)
  assert.equal(refused.settlement, 'assistant/attempt')
  assert.equal(refused.usage.inputTokens, 7)
  assert.equal(refused.usage.outputTokens, 2)
  assert.deepEqual(refused.totals, { uncachedInputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
  assert.equal(known.taskUsage.buckets[0].uncachedInput, known.totals.uncachedInputTokens)
  assert.equal(known.taskUsage.buckets[0].cacheRead, null)
  assert.equal(omitted.taskUsage.completeness, 'unknown')
  assert.equal(explicitZero.taskUsage.completeness, 'partial')
  assert.equal(explicitZero.taskUsage.buckets[0].cacheRead, 0)
  assert.equal(refused.taskUsage.buckets[0].uncachedInput, refused.totals.uncachedInputTokens)

  const { sessionId: retriedId } = await rpc('session/create', { workspaceId: workspace.workspaceId })
  await rpc('session/prompt', { sessionId: retriedId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: retryPrompt }] })
  assert.equal((await rpc('session/wait', { sessionId: retriedId, timeoutMs: 8_000 })).reason, 'idle')
  const retried = await readLifecycle(rpc, retriedId)
  assert.equal(retryCalls, 2)
  assert.equal(retried.attemptsRetried, 1)
  assert.equal(retried.end, 'completed')
  assert.equal(retried.totals.uncachedInputTokens, 5)
  assert.equal(retried.taskUsage.buckets[0].uncachedInput, 5)
  assert.equal(retried.taskUsage.completeness, 'partial', 'the first attempt has no token report')

  const { sessionId: cancelledId } = await rpc('session/create', { workspaceId: workspace.workspaceId })
  await rpc('session/prompt', { sessionId: cancelledId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: cancelPrompt }] })
  const deadline = Date.now() + 8_000
  while (!cancellationSampleStarted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(cancellationSampleStarted, 'the mock started the cancellable stream')
  await rpc('session/cancel', { sessionId: cancelledId })
  assert.equal((await rpc('session/wait', { sessionId: cancelledId, timeoutMs: 8_000 })).reason, 'idle')
  const cancelled = await readLifecycle(rpc, cancelledId)
  assert.equal(cancelled.end, 'aborted')
  assert.equal(cancelled.taskUsage.completeness, 'unknown')
  assert.ok(cancelled.taskUsage.buckets.every(bucket => bucket.uncachedInput === null && bucket.output === null))

  await stop()
  assert.ok(modelCalls >= samples.size, 'all fixture prompts reached the mock provider')
  const forks = [...childSamples.keys()].map(prompt => ({ id: `session-${randomUUID()}`, prompt, name: prompt }))
  const boundChild = forks[0].id
  const output = join(data, 'usage-result.json')
  const bindings = { workspaceId: workspace.workspaceId, taskId, output, sessions, boundChild }
  rpc = await start({ ...bindings, forks })
  const cold = await Promise.all(sessions.map(id => measure(rpc, id)))
  assert.deepEqual(cold, live)
  const { baseline: beforeFork, usage } = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(beforeFork.taskId, taskId)
  assert.equal(beforeFork.completeness, 'partial')
  assert.deepEqual(beforeFork.buckets, [{
    provider: known.route.provider, model: known.route.model, uncachedInput: 10, output: 3, cacheRead: 0, cacheWrite: 0,
  }])
  assert.equal(usage.completeness, 'partial')
  assert.deepEqual(usage.buckets, [{
    provider: known.route.provider, model: known.route.model, uncachedInput: 21, output: 7, cacheRead: 0, cacheWrite: 0,
  }])
  assert.match(usage.coverageNotes[0], /^1 bound or expected session/)

  await stop()
  const callsBeforeColdReads = modelCalls
  await rm(output)
  rpc = await start(bindings, { modelEnabled: false })
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')).usage, usage)
  assert.deepEqual(await readLifecycle(rpc, retriedId), retried)
  assert.deepEqual(await readLifecycle(rpc, cancelledId), cancelled)
  assert.equal(modelCalls, callsBeforeColdReads, 'reading restored usage makes no model calls')
  console.log('PASS: native usage shows totals, history route and available cache fields across restart; input/output omissions are indistinguishable from zero.')
  console.log('PASS: reported usage from a failed provider attempt survives restart and contributes to native totals.')
  console.log('PASS: only the bound native fork contributes its own usage, without inherited tokens or model calls on cold read.')
  console.log('PASS: retry and cancellation report their available usage and coverage gaps across restart.')
} finally {
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(data, { recursive: true, force: true })
}
