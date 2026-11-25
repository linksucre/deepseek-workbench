import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const upstream = resolve(process.argv[2] ?? '.')
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url)))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim(), baseline.commit)

const samples = new Map([
  ['usage-known', { input_tokens: 3, output_tokens: 1 }],
  ['usage-omitted', {}],
  ['usage-explicit-zero', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
  ['usage-provider-refusal', { input_tokens: 7, output_tokens: 2 }],
])
const data = await mkdtemp(join(tmpdir(), 'workbench-usage-'))
let modelCalls = 0
let child
let closed

const provider = createServer(async (req, res) => {
  const chunks = []
  try {
    for await (const chunk of req) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks))
    const finalMessage = JSON.stringify(input.messages.at(-1))
    const sample = [...samples].find(([prompt]) => finalMessage.includes(prompt))
    assert.ok(sample, 'the mock only serves known usage fixtures')
    modelCalls += 1
    const events = [
      { type: 'message_start', message: { id: sample[0], model: 'mock-model', usage: sample[1] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: sample[0] === 'usage-provider-refusal' ? 'refusal' : 'end_turn' } },
      { type: 'message_stop' },
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
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

async function start() {
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: upstream,
    env: {
      ...process.env,
      DSH_HOME: join(data, 'dsh'), DSH_AGENTS_HOME: join(data, 'agents'),
      DEEPSEEK_API_KEY: 'mock-usage-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
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
  const events = page.records.map(record => record.event).filter(Boolean)
  const settlements = events.filter(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')
  assert.equal(settlements.length, 1, 'one native settlement per fixture session')
  const route = events.find(event => event.type === 'request/context')
  assert.ok(route?.data.provider && route.data.model, 'native history identifies its provider and model')
  const [settlement] = settlements
  const usage = settlement.data.usage ?? settlement.data.stream.findLast(record =>
    record.type === 'chunk' && record.chunk.type === 'usage')?.chunk.usage
  return { totals: projection.values.tokenUsage, settlement: settlement.type, usage, route: route.data }
}

try {
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  let rpc = await start()
  const sessions = []
  for (const prompt of samples.keys()) {
    const { sessionId } = await rpc('session/create', { cwd: data })
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

  await stop()
  const callsBeforeColdReads = modelCalls
  assert.ok(callsBeforeColdReads >= samples.size, 'all fixture prompts reached the mock provider')
  rpc = await start()
  const cold = await Promise.all(sessions.map(id => measure(rpc, id)))
  assert.deepEqual(cold, live)
  assert.equal(modelCalls, callsBeforeColdReads, 'reading restored usage makes no model calls')
  console.log('PASS: native usage shows totals, history route and available cache fields across restart; input/output omissions are indistinguishable from zero.')
  console.log('PASS: reported usage from a failed provider attempt survives restart and contributes to native totals.')
} finally {
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(data, { recursive: true, force: true })
}
