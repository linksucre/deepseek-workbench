import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = resolve(process.argv[2] ?? '.')
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url)))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)
const root = await mkdtemp(join(tmpdir(), 'dsh-host-delivery-'))
const patch = join(root, 'test.patch.yml')
const usagePolicy = join(root, 'usage-policy.json')
const marker = 'Workbench native presentation probe'
const markerRequest = body => body.tools?.some(tool => tool.name === 'present')
  && JSON.stringify(body.messages).includes(marker)
let modelSteps = 0
let allModelRequests = 0
let suggestionSteps = 0
let suggestionResults = []
let unboundToolNames
const unboundMarker = 'Workbench unbound probe'
const suggestionMarker = 'Workbench approach probe'
const provider = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    allModelRequests += 1
    if (JSON.stringify(body.messages).includes(suggestionMarker)) {
      suggestionResults = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result')
    }
    if (body.tools?.some(tool => tool.name === 'present') && JSON.stringify(body.messages).includes(unboundMarker)) {
      unboundToolNames = body.tools.map(tool => tool.name)
    }
    const step = markerRequest(body) ? ++modelSteps : 0
    const suggest = !step && body.tools?.some(tool => tool.name === 'workbench_suggest') &&
      JSON.stringify(body.messages).includes(suggestionMarker) && ++suggestionSteps === 1
    const filename = { 1: 'first.md', 2: 'second.md', 5: 'second.md' }[step]
    const name = suggest ? 'workbench_suggest'
      : filename ? 'present' : [3, 6].includes(step) ? 'workbench_submit' : undefined
    const args = suggest ? { domain: 'documents', methods: ['direct'], reason: 'Clear draft', skillIds: [] }
      : filename ? { files: [{ path: filename }] } : { selection: 'latest-presentation' }
    const events = [{
      type: 'message_start',
      message: { id: randomUUID(), model: 'mock-model', usage: { input_tokens: 4, output_tokens: 0, ...(step !== 5 && { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) } },
    }]
    if (name) {
      events.push(
        { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: `tool-${name}-${step}`, name, input: {} } },
        { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      )
    } else {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } })
    }
    events.push(
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } },
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
  const rpc = async (method, request) => {
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
  rpc.page = path => fetch(`${origin}${path}`, { headers: { cookie } })
  rpc.workbench = async (operation, input, options = {}) => {
    const headers = { 'content-type': 'application/json', origin: options.origin ?? origin }
    if (!options.anonymous) headers.cookie = cookie
    const response = await fetch(`${origin}/workbench/v1/command`, {
      method: 'POST', signal: AbortSignal.timeout(10_000), headers,
      body: JSON.stringify({ operation, input }),
    })
    assert.equal(response.status, options.status ?? 200, `status for ${operation}\n${output.replace(/dsh web: .+/g, 'dsh web: [private URL]')}`)
    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      assert.ok(!response.ok, 'Successful commands must return JSON')
      return
    }
    const payload = await response.json()
    return payload.result ?? payload.error
  }
  return rpc
}

async function stop() {
  if (!child) return
  child.kill()
  await closed
  child = undefined
}

const hash = text => createHash('sha256').update(text).digest('hex')
try {
  await writeFile(usagePolicy, JSON.stringify({
    rates: [{ provider: 'deepseek-official', model: 'deepseek-flash', currency: 'CNY', rateDate: '2020-01-01',
      perMillion: { uncachedInput: '1', cacheRead: '0.2', cacheWrite: '1', output: '2' } }],
    softBudget: { currency: 'CNY', decimalAmount: '0.000001' },
  }))
  execFileSync(process.execPath, [
    fileURLToPath(new URL('../../scripts/source-overlay.mjs', import.meta.url)), checkout, patch, usagePolicy,
  ])
  const module = new URL('./fixtures/delivery-probe.mjs', import.meta.url).href
  const entry = new URL('./fixtures/workbench-host.mjs', import.meta.url).href
  await writeFile(patch, `\n- insert:\n    - id: workbench-delivery-probe\n      name: ${JSON.stringify(module)}\n    - id: workbench-test-host\n      name: ${JSON.stringify(entry)}\n`, { flag: 'a' })
  await writeFile(join(root, 'first.md'), 'draft')
  await writeFile(join(root, 'second.md'), 'version 1')
  let rpc = await start({ WORKBENCH_TEST_FAIL_ATTACH: '1' })
  const page = await rpc.page('/workbench')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  assert.match(await page.text(), /新建任务/)
  assert.equal((await rpc.page('/workbench/ui.mjs')).status, 200)
  const { workspace } = await rpc('workspace/create', { path: root })
  assert.ok((await (await rpc.page('/workbench/v1/workspaces')).json()).some(item => item.id === workspace.workspaceId))
  const brief = {
    requestId: 'workbench-create', workspaceId: workspace.workspaceId, title: 'Native workbench',
    goal: 'Verify task persistence', criteria: [{ id: 'facts', description: 'Check sources' }],
    deliverables: ['second.md'], materials: [],
  }
  await rpc.workbench('task.create', brief, { anonymous: true, status: 401 })
  await rpc.workbench('task.create', brief, { origin: 'https://untrusted.example', status: 403 })
  assert.equal((await rpc.workbench('task.create', { ...brief, caller: 'owner' }, { status: 400 })).code, 'INVALID')
  const draft = await rpc.workbench('task.create', brief)
  await rpc.workbench('task.usage', { taskId: draft.task.id }, { anonymous: true, status: 401 })
  await rpc.workbench('task.usage', { taskId: draft.task.id }, { origin: 'https://untrusted.example', status: 403 })
  assert.equal((await rpc.workbench('task.usage', { taskId: randomUUID() }, { status: 404 })).code, 'NOT_FOUND')
  const ready = await rpc.workbench('task.ready', {
    taskId: draft.task.id, requestId: 'workbench-ready', expectedRevision: draft.task.revision,
  })
  assert.equal(ready.task.status, 'ready')
  const startup = { taskId: draft.task.id, requestId: 'launch', expectedRevision: ready.task.revision }
  const blocked = await rpc.workbench('task.start', startup)
  assert.equal(blocked.task.status, 'blocked')
  assert.equal(blocked.runs.length, 0)
  const before = await rpc('session/list', {})
  assert.equal(before.items.length, 1)
  const { sessionId } = before.items[0]
  assert.ok(!(await rpc('workspace/create', { path: root })).workspace.sessionIds.includes(sessionId))
  assert.equal(modelSteps, 0)
  await stop()

  rpc = await start()
  assert.deepEqual(await rpc.workbench('task.get', { taskId: draft.task.id }), blocked)
  assert.deepEqual(await rpc.workbench('task.start', startup), blocked)
  const attach = {
    taskId: draft.task.id, requestId: 'recover', expectedRevision: blocked.task.revision,
    action: 'attach', rootSessionId: sessionId,
  }
  assert.equal((await rpc.workbench('task.reconcile', { ...attach, rootSessionId: 'other' }, { status: 409 })).code,
    'RECONCILIATION_REQUIRED')
  const attached = await rpc.workbench('task.reconcile', attach)
  assert.equal(attached.task.status, 'active')
  assert.equal(attached.runs[0].rootSessionId, sessionId)
  assert.deepEqual(await rpc.workbench('task.reconcile', attach), attached)
  assert.deepEqual((await rpc('session/list', {})).items.map(item => item.sessionId), [sessionId])
  assert.deepEqual((await rpc('workspace/create', { path: root })).workspace.sessionIds, [sessionId])
  const idle = async () => (await rpc('session/list', {})).items.some(item =>
    item.sessionId === sessionId && !item.running && !item.blank)
  const lifecycleInput = { taskId: draft.task.id, requestId: 'pause', expectedRevision: attached.task.revision }
  const paused = await rpc.workbench('task.pause', lifecycleInput)
  assert.equal(paused.task.status, 'paused')
  assert.deepEqual(await rpc.workbench('task.pause', lifecycleInput), paused)
  const resumed = await rpc.workbench('task.resume', { ...lifecycleInput, requestId: 'resume', expectedRevision: paused.task.revision })
  assert.equal(resumed.task.status, 'active')
  assert.equal(resumed.runs[0].rootSessionId, sessionId)
  const prompt = (text, revision, requestId = randomUUID()) => rpc.workbench('task.prompt', {
    taskId: draft.task.id, expectedRevision: revision, requestId, text,
  })
  await prompt(suggestionMarker, resumed.task.revision)
  await until(async () => suggestionSteps >= 1 && await idle(), 'native suggestion tool')
  const suggested = await rpc.workbench('task.get', { taskId: draft.task.id })
  assert.equal(suggested.task.choice?.source, 'agent', JSON.stringify(suggestionResults))
  const overridden = await rpc.workbench('task.choose', {
    taskId: draft.task.id, requestId: 'override', expectedRevision: suggested.task.revision,
    choice: { domain: 'documents', methods: ['verify-first'], reason: 'Check sources first', skillIds: [], source: 'user' },
  })
  assert.equal(overridden.task.choice.source, 'user')
  await prompt(marker, overridden.task.revision, 'stable-display-request')
  await until(async () => modelSteps >= 3 && await idle(), 'native presentations and workbench submission')
  const conversation = await rpc.workbench('task.conversation', { taskId: draft.task.id, limit: 20 })
  assert.equal(conversation.sessionId, sessionId)
  assert.ok(conversation.messages.some(item => item.role === 'user' && item.text === marker))
  assert.ok(conversation.messages.some(item => item.role === 'assistant' && item.text === 'done'))
  const submitted = await rpc.workbench('task.get', { taskId: draft.task.id })
  assert.equal(submitted.task.status, 'review')
  assert.equal(submitted.submissions.length, 1)
  assert.deepEqual(submitted.artifacts.map(artifact => artifact.version), [hash('version 1')])
  const onSubmission = allModelRequests
  const initialUsage = await rpc.workbench('task.usage', { taskId: draft.task.id })
  assert.equal(initialUsage.completeness, 'complete')
  assert.ok(initialUsage.estimatedCost.decimalAmount !== '0')
  assert.equal(initialUsage.estimatedCost.currency, 'CNY')
  assert.equal(initialUsage.softBudget.comparison, 'reached')
  assert.equal(allModelRequests, onSubmission)
  await stop()

  const samples = []
  for (const [index, value] of ['version 1', 'version 2'].entries()) {
    const resultPath = join(root, `probe-${index}.json`)
    await writeFile(join(root, 'second.md'), value)
    const restarted = await start({
      WORKBENCH_DELIVERY_WORKSPACE: workspace.workspaceId,
      WORKBENCH_DELIVERY_SESSION: sessionId,
      WORKBENCH_DELIVERY_RESULT: resultPath,
      ...(index > 0 && { WORKBENCH_DELIVERY_PREVIOUS: join(root, `probe-${index - 1}.json`) }),
    })
    assert.deepEqual(await restarted.workbench('task.get', { taskId: draft.task.id }), submitted)
    assert.deepEqual(await restarted.workbench('task.create', brief), draft)
    assert.deepEqual(await restarted.workbench('task.usage', { taskId: draft.task.id }), initialUsage)
    assert.equal(allModelRequests, onSubmission)
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
  rpc = await start()
  const callsBeforeReplay = modelSteps
  assert.ok((await prompt(marker, overridden.task.revision, 'stable-display-request')).accepted)
  assert.equal((await rpc.workbench('task.prompt', {
    taskId: draft.task.id, expectedRevision: overridden.task.revision, requestId: 'stable-display-request', text: 'changed',
  }, { status: 400 })).code, 'INVALID')
  assert.equal(modelSteps, callsBeforeReplay)
  const decision = { taskId: draft.task.id, expectedRevision: submitted.task.revision,
    submissionId: submitted.task.currentSubmissionId, reason: null, verdict: 'accept', confirmedCriteria: ['facts'] }
  assert.equal((await rpc.workbench('task.decide', { ...decision, requestId: 'drift' }, { status: 409 })).code, 'ARTIFACT_DRIFT')
  const returned = await rpc.workbench('task.decide', {
    taskId: decision.taskId, expectedRevision: decision.expectedRevision, submissionId: decision.submissionId,
    verdict: 'return', reason: 'Review the updated file', requestId: 'return',
  })
  assert.equal(returned.task.status, 'active')
  await prompt('Present the updated file and submit it', returned.task.revision)
  await until(async () => modelSteps >= 6 && await idle(), 'native re-presentation and re-submission')
  const resubmitted = await rpc.workbench('task.get', { taskId: draft.task.id })
  assert.equal(resubmitted.task.status, 'review')
  assert.equal(resubmitted.submissions.length, 2)
  assert.deepEqual(resubmitted.artifacts.map(item => item.version), ['version 1', 'version 2'].map(hash))
  assert.equal((await rpc.workbench('task.decide', {
    ...decision, expectedRevision: resubmitted.task.revision, submissionId: resubmitted.task.currentSubmissionId,
    requestId: 'wrong-criterion', confirmedCriteria: ['forged'],
  }, { status: 400 })).code, 'INVALID')
  const withoutConfirmation = { ...decision }
  delete withoutConfirmation.confirmedCriteria
  assert.equal((await rpc.workbench('task.decide', {
    ...withoutConfirmation, expectedRevision: resubmitted.task.revision,
    submissionId: resubmitted.task.currentSubmissionId, requestId: 'missing-confirmation',
  }, { status: 400 })).code, 'INVALID')
  const accepted = await rpc.workbench('task.decide', {
    ...decision, expectedRevision: resubmitted.task.revision, submissionId: resubmitted.task.currentSubmissionId,
    requestId: 'accept',
  })
  assert.equal(accepted.task.status, 'accepted')
  assert.deepEqual(accepted.decisions.map(record => record.verdict), ['return', 'accept'])
  assert.equal(accepted.decisions[1].reviewEvidence[0].criterionId, 'facts')
  await stop()
  rpc = await start()
  assert.deepEqual(await rpc.workbench('task.get', { taskId: draft.task.id }), accepted)
  const beforeUsage = allModelRequests
  const incomplete = await rpc.workbench('task.usage', { taskId: draft.task.id })
  assert.equal(incomplete.completeness, 'partial')
  assert.equal(incomplete.estimatedCost, null)
  assert.equal(incomplete.softBudget.comparison, 'unknown')
  assert.equal(allModelRequests, beforeUsage)
  const fresh = await rpc.workbench('task.create', { ...brief, requestId: 'second-task' })
  const readyFresh = await rpc.workbench('task.ready', {
    taskId: fresh.task.id, requestId: 'ready', expectedRevision: 0,
  })
  const freshStart = { taskId: fresh.task.id, requestId: 'start', expectedRevision: readyFresh.task.revision }
  const freshActive = await rpc.workbench('task.start', freshStart)
  assert.equal(freshActive.task.status, 'active')
  assert.notEqual(freshActive.runs[0].rootSessionId, sessionId)
  assert.deepEqual(await rpc.workbench('task.start', freshStart), freshActive)
  assert.equal((await rpc('session/list', {})).items.length, 2)
  const knownIds = new Set((await rpc('session/list', {})).items.map(item => item.sessionId))
  await stop()
  rpc = await start({ WORKBENCH_TEST_FAIL_ATTACH: 'lost-receipt' })
  const uncertain = await rpc.workbench('task.create', { ...brief, requestId: 'lost-receipt-task' })
  await rpc.workbench('task.ready', { taskId: uncertain.task.id, requestId: 'ready', expectedRevision: 0 })
  const lostStart = { taskId: uncertain.task.id, requestId: 'start', expectedRevision: 1 }
  await rpc.workbench('task.start', lostStart, { status: 409 })
  const unknownId = (await rpc('session/list', {})).items.find(item => !knownIds.has(item.sessionId))?.sessionId
  assert.ok(unknownId)
  await stop()
  rpc = await start()
  const unresolved = await rpc.workbench('task.get', { taskId: uncertain.task.id })
  assert.equal(unresolved.task.status, 'blocked')
  assert.deepEqual(await rpc.workbench('task.start', lostStart), unresolved)
  await rpc.workbench('task.reconcile', {
    taskId: uncertain.task.id, requestId: 'recover', expectedRevision: unresolved.task.revision,
    action: 'attach', rootSessionId: unknownId,
  }, { status: 409 })
  assert.equal((await rpc('session/list', {})).items.length, 3)
  assert.ok(!(await rpc('workspace/create', { path: root })).workspace.sessionIds.includes(unknownId))
  const listQuery = { workspaceId: workspace.workspaceId, limit: 1, cursor: null }
  const firstPage = await rpc.workbench('task.list', listQuery)
  assert.equal(firstPage.items.length, 1)
  assert.ok(firstPage.nextCursor)
  const nextPage = await rpc.workbench('task.list', { ...listQuery, cursor: firstPage.nextCursor })
  assert.notEqual(firstPage.items[0].id, nextPage.items[0].id)
  assert.equal((await rpc.workbench('task.list', { ...listQuery, cursor: 'bad' }, { status: 400 })).code, 'INVALID')
  const loose = await rpc('session/create', { workspaceId: workspace.workspaceId, agentPreset: 'task-collaborator' })
  await rpc('session/prompt', { sessionId: loose.sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: unboundMarker }] })
  const names = await until(() => unboundToolNames, 'unbound model tool catalog')
  assert.ok(!names.some(name => name.startsWith('workbench_')))
  console.log('PASS: native startup, receipt-gated recovery, no duplicate sessions, native suggestion, presentation, submission, drift, return and persisted acceptance.')
} finally {
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(root, { recursive: true, force: true })
}
