import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCollaboratorTools } from './request-tools.mjs'

const checkout = resolve(process.argv[2] ?? '.')
const patch = fileURLToPath(new URL('../../src/preset/cordis.patch.yml', import.meta.url))
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url), 'utf8'))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)
const workspace = await mkdtemp(join(tmpdir(), 'dsh-task-collaborator-'))
const recoveryPatch = join(workspace, 'recovery.patch.yml')
const recoveryPlugin = new URL('./fixtures/workspace-attach.mjs', import.meta.url).href
const reservedId = `session-${randomUUID()}`
const heldPrompt = 'Smoke: wait for native cancellation'
const queuedPrompt = 'Smoke: preserve this queued followup'
const requests = []
let heldRequestStarted = false

function containsPrompt(request, prompt) {
  return JSON.stringify(request.messages?.at(-1) ?? null).includes(prompt)
}

const provider = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const modelRequest = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(modelRequest)
    const events = [
      { type: 'message_start', message: { id: 'workbench-smoke', model: 'mock-model', usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'mock response' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (!heldRequestStarted && containsPrompt(modelRequest, heldPrompt)) {
      heldRequestStarted = true
      response.write(`data: ${JSON.stringify(events[0])}\n\n`)
      return
    }
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  } catch {
    response.writeHead(400).end()
  }
})
provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
let child
let childClosed
let output

function startHarness(phase, cwd) {
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', recoveryPatch,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: checkout,
    env: {
      ...process.env,
      DSH_HOME: join(workspace, 'dsh'),
      DSH_AGENTS_HOME: join(workspace, 'agents'),
      DEEPSEEK_API_KEY: 'mock-workbench-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      WORKBENCH_TEST_CWD: cwd,
      WORKBENCH_TEST_RESERVED_ID: reservedId,
      WORKBENCH_TEST_RECOVERY_PHASE: phase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  childClosed = once(child, 'close')
  output = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output += chunk.toString() })
  }
}

async function stopHarness() {
  if (child === undefined) return
  child.kill()
  await childClosed
  child = undefined
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

async function connectHarness() {
  const launchUrl = await until(() => /dsh web: (http:\/\/[^\s]+)/.exec(output)?.[1], 'Web startup', 60_000)
  const origin = new URL(launchUrl).origin
  assert.equal((await fetch(origin)).status, 401)
  const auth = await fetch(launchUrl, { redirect: 'manual' })
  assert.equal(auth.status, 303)
  const cookie = auth.headers.get('set-cookie').split(';', 1)[0]
  const landing = await fetch(origin, { headers: { cookie } })
  assert.equal(landing.status, 200)

  return async function rpc(method, request, expectedError) {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: method === 'session/list' ? { _request: request } : { request } } }),
    })
    assert.equal(response.status, 200, method)
    const { result } = await response.json()
    if (expectedError !== undefined) {
      assert.equal(result.ok, false, `${method} should fail with ${expectedError}`)
      assert.equal(result.error.code, expectedError)
      return result.error
    }
    assert.equal(result.ok, true, `${method}: ${JSON.stringify(result.error)}`)
    return result.value
  }

}

try {
  const cwd = await realpath(workspace)
  const recoveryFixture = `\n- insert:\n    - id: workbench-test-workspace-attach\n      name: ${JSON.stringify(recoveryPlugin)}\n`
  await writeFile(recoveryPatch, await readFile(patch, 'utf8') + recoveryFixture)
  startHarness('fail-attach', cwd)
  let rpc = await connectHarness()

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
  assertCollaboratorTools(task.modelRequest)

  const standard = await requestTurn({}, 'Smoke: confirm the default preset remains standard')
  assert.equal(standard.session.agentPreset, 'standard')
  assert.doesNotMatch(JSON.stringify(standard.modelRequest.system), /You are my task collaborator/)
  console.log('PASS: Web startup, collaborator preset, prompt injection, file/research/skill/present tools, and standard preset isolation.')

  const held = await requestTurn({}, heldPrompt)
  const sessionId = held.session.sessionId
  const queued = {
    sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: queuedPrompt }],
  }
  const queuedRequests = () => requests.filter(request => containsPrompt(request, queuedPrompt)).length
  await rpc('session/prompt', queued)
  const beforeCancel = await rpc('session/state', { sessionId })
  assert.equal(beforeCancel.running, true)
  assert.equal(beforeCancel.queue.length, 1)
  const cancellation = await rpc('session/cancel', { sessionId })
  assert.equal(cancellation.accepted, true)
  const stopped = await rpc('session/wait', { sessionId, timeoutMs: 5_000 })
  assert.equal(stopped.reason, 'idle')
  assert.equal(stopped.state.running, false)
  assert.equal(stopped.state.queue.length, 1, 'stopping preserves the queued followup')
  assert.equal(queuedRequests(), 0, 'the parked followup has not reached the provider')

  await rpc('session/prompt', queued)
  const deduplicated = await rpc('session/state', { sessionId })
  assert.equal(deduplicated.running, false, 'retrying a known prompt does not wake the Agent')
  assert.equal(deduplicated.queue.length, 1)
  await rpc('session/prompt', {
    sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: 'Smoke: wake the parked session' }],
  })
  const resumed = await rpc('session/wait', { sessionId, timeoutMs: 5_000 })
  assert.equal(resumed.reason, 'idle')
  assert.equal(resumed.state.queue.length, 0)
  assert.equal(queuedRequests(), 1)
  console.log('PASS: cancel is followed by a passive stop check; parked input survives until an explicit wake.')

  const { workspace: registered } = await rpc('workspace/create', { path: workspace })
  const failure = await rpc('session/create', {
    workspaceId: registered.workspaceId, sessionId: reservedId, agentPreset: 'task-collaborator',
  }, 'session/workspace-attach-failed')
  assert.match(failure.message, /Injected before workspace attachment/)
  assert.deepEqual(failure.details, { sessionId: reservedId, workspaceId: registered.workspaceId })

  await stopHarness()
  startHarness('observe', cwd)
  rpc = await connectHarness()
  const { workspace: recovered } = await rpc('workspace/create', { path: workspace })
  assert.equal(recovered.workspaceId, registered.workspaceId)
  assert.ok(!recovered.sessionIds.includes(reservedId), 'reserved session survived without membership')
  const { items } = await rpc('session/list', {})
  assert.ok(items.some(item => item.sessionId === reservedId), 'reserved session survives restart')

  await rpc('session/prompt', queued)
  const afterReplay = await rpc('session/state', { sessionId })
  assert.equal(afterReplay.running, false)
  assert.equal(afterReplay.queue.length, 0)
  assert.equal(queuedRequests(), 1, 'native prompt replay is deduplicated after restart')

  const retry = await rpc('session/create', { workspaceId: recovered.workspaceId, sessionId: reservedId })
  assert.notEqual(retry.sessionId, reservedId, 'recreating an unattached named session mints a replacement')
  const { workspace: afterRetry } = await rpc('workspace/create', { path: workspace })
  assert.ok(afterRetry.sessionIds.includes(retry.sessionId))
  assert.ok(!afterRetry.sessionIds.includes(reservedId))
  console.log('PASS: native attach failure returns the original ID; the session survives restart and blind retry creates a replacement.')

  const beforeAttach = await rpc('session/list', {})
  await stopHarness()
  startHarness('reattach', cwd)
  rpc = await connectHarness()
  const { workspace: reattached } = await rpc('workspace/create', { path: workspace })
  assert.equal(reattached.workspaceId, registered.workspaceId)
  assert.equal(reattached.sessionIds.filter(id => id === reservedId).length, 1)
  const afterAttach = await rpc('session/list', {})
  assert.deepEqual(
    afterAttach.items.map(item => item.sessionId).sort(),
    beforeAttach.items.map(item => item.sessionId).sort(),
    'repair does not create another session',
  )

  await stopHarness()
  startHarness('observe', cwd)
  rpc = await connectHarness()
  const { workspace: restored } = await rpc('workspace/create', { path: workspace })
  assert.deepEqual(restored.sessionIds, reattached.sessionIds)
  console.log('PASS: Host attachment reuses the original ID without duplication and survives another restart.')
} finally {
  await stopHarness()
  provider.closeAllConnections()
  provider.close()
  await rm(workspace, { recursive: true, force: true })
}
