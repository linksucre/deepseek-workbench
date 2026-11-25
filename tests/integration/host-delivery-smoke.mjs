import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const checkout = resolve(process.argv[2] ?? '.')
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url)))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)
const root = await mkdtemp(join(tmpdir(), 'dsh-host-delivery-'))
const patch = join(root, 'test.patch.yml')
const marker = 'Workbench native presentation probe'
const markerRequest = body => body.tools?.some(tool => tool.name === 'present')
  && JSON.stringify(body.messages).includes(marker)
let modelSteps = 0
const provider = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const step = markerRequest(body) ? ++modelSteps : 0
    const filename = { 1: 'first.md', 2: 'second.md' }[step]
    const events = [{
      type: 'message_start',
      message: { id: randomUUID(), model: 'mock-model', usage: { input_tokens: 4, output_tokens: 0 } },
    }]
    if (filename) {
      events.push(
        { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: `present-${step}`, name: 'present', input: {} } },
        { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify({ files: [{ path: filename }] }) } },
      )
    } else {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } })
    }
    events.push(
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: filename ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    )
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  } catch {
    response.writeHead(400).end()
  }
})
provider.listen(0, '127.0.0.1')
await once(provider, 'listening')

let child
let closed
let output = ''
async function until(read, description, timeout = 25_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    if (child?.exitCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Unable to verify ${description}\n${output.replace(/dsh web: .+/g, 'dsh web: [private URL]')}`)
}

async function start(probe = {}) {
  output = ''
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', patch,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: checkout,
    env: {
      ...process.env, DSH_HOME: join(root, 'dsh'), DSH_AGENTS_HOME: join(root, 'agents'),
      DEEPSEEK_API_KEY: 'mock-delivery-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      ...probe,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = once(child, 'close')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk.toString() })
  const link = await until(() => /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1], 'Web startup', 60_000)
  const origin = new URL(link).origin
  const auth = await fetch(link, { redirect: 'manual' })
  assert.equal(auth.status, 303)
  const cookie = auth.headers.get('set-cookie').split(';', 1)[0]
  return async (method, request) => {
    const result = await fetch(`${origin}/api/${method}`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method,
        payload: { args: method === 'session/list' ? { _request: request } : { request } } }),
    })
    assert.equal(result.status, 200)
    const { result: envelope } = await result.json()
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error))
    return envelope.value
  }
}

async function stop() {
  if (!child) return
  child.kill()
  await closed
  child = undefined
}

const hash = text => createHash('sha256').update(text).digest('hex')
try {
  const preset = await readFile(new URL('../../src/preset/cordis.patch.yml', import.meta.url), 'utf8')
  const module = new URL('./fixtures/delivery-probe.mjs', import.meta.url).href
  await writeFile(patch, `${preset}\n- insert:\n    - id: workbench-delivery-probe\n      name: ${JSON.stringify(module)}\n`)
  await writeFile(join(root, 'first.md'), 'draft')
  await writeFile(join(root, 'second.md'), 'version 1')
  const rpc = await start()
  const { workspace } = await rpc('workspace/create', { path: root })
  const { sessionId } = await rpc('session/create', { workspaceId: workspace.workspaceId, agentPreset: 'task-collaborator' })
  await rpc('session/prompt', {
    sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: marker }],
  })
  await until(async () => modelSteps >= 3 && (await rpc('session/list', {})).items.some(item =>
    item.sessionId === sessionId && !item.running && !item.blank), 'two native present calls and completed turn')
  await stop()

  const samples = []
  for (const [index, value] of ['version 1', 'version 2'].entries()) {
    const resultPath = join(root, `probe-${index}.json`)
    await writeFile(join(root, 'second.md'), value)
    await start({
      WORKBENCH_DELIVERY_WORKSPACE: workspace.workspaceId,
      WORKBENCH_DELIVERY_SESSION: sessionId,
      WORKBENCH_DELIVERY_RESULT: resultPath,
      ...(index > 0 && { WORKBENCH_DELIVERY_PREVIOUS: join(root, `probe-${index - 1}.json`) }),
    })
    const sample = await until(async () => {
      try { return JSON.parse(await readFile(resultPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }, 'authorized native delivery selection')
    assert.equal(sample.latest[0].version, hash(value))
    assert.equal(sample.current[0].version, hash(value))
    samples.push(sample)
    await stop()
  }
  assert.equal(samples[0].latest[0].source.locator, samples[1].latest[0].source.locator)
  assert.notEqual(samples[0].latest[0].version, samples[1].latest[0].version)
  console.log('PASS: native present events, cold event lookup, stage and authorization checks, and version changes across Host restarts.')
} finally {
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(root, { recursive: true, force: true })
}
