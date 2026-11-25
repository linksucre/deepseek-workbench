import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = resolve(process.argv[2] ?? '.')
const patch = fileURLToPath(new URL('../../src/preset/cordis.patch.yml', import.meta.url))
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url), 'utf8'))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)
const workspace = await mkdtemp(join(tmpdir(), 'dsh-task-collaborator-'))
const requests = []
const provider = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const events = [
      { type: 'message_start', message: { id: 'workbench-smoke', model: 'mock-model', usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'mock response' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  } catch {
    response.writeHead(400).end()
  }
})
provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
const child = spawn(process.execPath, [
  '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', patch,
  '--no-open', '--host', '127.0.0.1', '--port', '0',
], {
  cwd: checkout,
  env: {
    ...process.env,
    DSH_HOME: join(workspace, 'dsh'),
    DSH_AGENTS_HOME: join(workspace, 'agents'),
    DEEPSEEK_API_KEY: 'mock-workbench-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const childClosed = once(child, 'close')
let output = ''
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', chunk => { output += chunk.toString() })
}

async function until(read, description, timeout = 25_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    if (child.exitCode !== null) throw new Error(`Harness exited while waiting for ${description}\n${output.replace(/dsh web: .+/g, 'dsh web: [private URL]')}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

try {
  const launchUrl = await until(() => /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1], 'Web startup', 60_000)
  const origin = new URL(launchUrl).origin
  assert.equal((await fetch(origin)).status, 401)
  const auth = await fetch(launchUrl, { redirect: 'manual' })
  assert.equal(auth.status, 303)
  const cookie = auth.headers.get('set-cookie').split(';', 1)[0]
  const landing = await fetch(origin, { headers: { cookie } })
  assert.equal(landing.status, 200)

  async function rpc(method, request) {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: { request } } }),
    })
    assert.equal(response.status, 200, method)
    const { result } = await response.json()
    assert.equal(result.ok, true, `${method}: ${JSON.stringify(result.error)}`)
    return result.value
  }

  async function requestTurn(options, prompt) {
    const session = await rpc('session/create', { cwd: workspace, ...options })
    await rpc('session/prompt', {
      sessionId: session.sessionId, requestId: randomUUID(), mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    })
    const modelRequest = await until(() => requests.find(request =>
      request.tools?.length && JSON.stringify(request.messages).includes(prompt)), 'model request')
    return { session, modelRequest }
  }

  const task = await requestTurn({ agentPreset: 'task-collaborator' }, 'Smoke: review sources and write a client brief')
  assert.equal(task.session.agentPreset, 'task-collaborator')
  assert.match(JSON.stringify(task.modelRequest.system), /You are my task collaborator/)
  assert.match(JSON.stringify(task.modelRequest.system), /Choose the workflow for each phase/)
  assert.ok(task.modelRequest.tools.some(tool => tool.name === 'present'), 'present is available')

  const standard = await requestTurn({}, 'Smoke: confirm the default preset remains standard')
  assert.equal(standard.session.agentPreset, 'standard')
  assert.doesNotMatch(JSON.stringify(standard.modelRequest.system), /You are my task collaborator/)
  console.log('PASS: Web startup, collaborator preset, prompt injection, present tool, and standard preset isolation.')
} finally {
  child.kill()
  provider.closeAllConnections()
  provider.close()
  await childClosed
  await rm(workspace, { recursive: true, force: true })
}
