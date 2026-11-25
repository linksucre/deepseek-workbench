import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = resolve(process.argv[2] ?? '.')
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url)))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)
const root = await mkdtemp(join(tmpdir(), 'dsh-host-delivery-'))
const patch = join(root, 'test.patch.yml')
const data = join(root, 'dsh')
const usagePolicy = join(root, 'usage-policy.json')
const marker = 'Workbench native presentation probe'
const markerRequest = body => body.tools?.some(tool => tool.name === 'present')
  && JSON.stringify(body.messages).includes(marker)
let modelSteps = 0
let concurrentPresentation = false
const submitMarker = 'Workbench owner submission concurrency probe'
let allModelRequests = 0
let reviewRequest
let releaseReview
const reviewGate = new Promise(resolve => { releaseReview = resolve })
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
    const review = JSON.stringify(body.messages).includes('review isolation probe')
    if (review) {
      reviewRequest = body
      await reviewGate
    }
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
    const manualPresentation = !concurrentPresentation && body.tools?.some(tool => tool.name === 'present') &&
      JSON.stringify(body.messages).includes(submitMarker)
    if (manualPresentation) concurrentPresentation = true
    const filename = manualPresentation ? 'first.md' : { 1: 'first.md', 2: 'second.md', 5: 'second.md' }[step]
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
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: review ? 'independent review' : 'done' } })
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

async function start(probe = {}, { workbench = true, dataHome = data } = {}) {
  output = ''
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', ...(workbench ? ['--patch', patch] : []),
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: checkout,
    env: {
      ...process.env, DSH_HOME: dataHome, DSH_AGENTS_HOME: join(root, 'agents'),
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
    const statuses = Array.isArray(options.status) ? options.status : [options.status ?? 200]
    assert.ok(statuses.includes(response.status), `status ${response.status} for ${operation}, expected ${statuses.join(' or ')}\n${output.replace(/dsh web: .+/g, 'dsh web: [private URL]')}`)
    if (!response.headers.get('content-type')?.startsWith('application/json')) {
      assert.ok(!response.ok, 'Successful commands must return JSON')
      return
    }
    const payload = await response.json()
    return payload.result ?? payload.error
  }
  return rpc
}

async function stop(signal = 'SIGTERM') {
  if (!child) return
  child.kill(signal)
  const [, exitSignal] = await closed
  child = undefined
  return exitSignal
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
  const contextReader = new URL('./fixtures/context-reader.mjs', import.meta.url).href
  await writeFile(patch, `\n- insert:\n    - id: workbench-delivery-probe\n      name: ${JSON.stringify(module)}\n    - id: workbench-test-host\n      name: ${JSON.stringify(entry)}\n    - id: workbench-context-reader\n      name: ${JSON.stringify(contextReader)}\n`, { flag: 'a' })
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
    deliverables: ['second.md'], materials: [{ kind: 'file', locator: 'first.md', observedAt: '2025-01-01T00:00:00Z' }],
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
    const contextPath = join(root, `context-${index}.json`)
    await writeFile(join(root, 'second.md'), value)
    const restarted = await start({
      WORKBENCH_DELIVERY_WORKSPACE: workspace.workspaceId,
      WORKBENCH_DELIVERY_SESSION: sessionId,
      WORKBENCH_DELIVERY_RESULT: resultPath,
      WORKBENCH_CONTEXT_TEST: JSON.stringify({ detail: submitted, output: contextPath }),
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
    const context = await until(async () => {
      try { return JSON.parse(await readFile(contextPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }, 'native context source lookup')
    assert.equal(context.index.sources[0].freshness, 'stale')
    assert.equal(context.index.handoff.lastSubmission.id, submitted.task.currentSubmissionId)
    assert.deepEqual(context.preview.content, { kind: 'file', text: 'draft' })
    assert.deepEqual(context.presented.content, { kind: 'presentation',
      locator: submitted.artifacts[0].locator, version: hash('version 1') })
    assert.equal(allModelRequests, onSubmission)
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
  rpc = await start({ WORKBENCH_TEST_REVIEW_RECEIPT_FAULT: '1' })
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
  const [freshActive, sameStart] = await Promise.all([
    rpc.workbench('task.start', freshStart), rpc.workbench('task.start', freshStart),
  ])
  assert.deepEqual(sameStart, freshActive)
  assert.equal(freshActive.task.status, 'active')
  assert.notEqual(freshActive.runs[0].rootSessionId, sessionId)
  assert.deepEqual(await rpc.workbench('task.start', freshStart), freshActive)
  assert.equal((await rpc('session/list', {})).items.length, 2)
  const parentId = freshActive.runs[0].rootSessionId
  await rpc.workbench('task.prompt', { taskId: fresh.task.id, expectedRevision: freshActive.task.revision,
    requestId: 'parent-history', text: 'parent-only history marker' })
  await until(async () => (await rpc('session/list', {})).items.some(item =>
    item.sessionId === parentId && !item.running && !item.blank), 'review parent history committed')
  const reviewInput = { taskId: fresh.task.id, expectedRevision: freshActive.task.revision, requestId: 'review',
    instruction: 'Check the selected brief', material: 'review isolation probe' }
  await rpc.workbench('task.delegate', reviewInput, { anonymous: true, status: 401 })
  await rpc.workbench('task.delegate', { ...reviewInput, taskId: randomUUID() }, { status: 404 })
  await rpc.workbench('task.delegate', { ...reviewInput, material: '材'.repeat(9000) }, { status: 400 })
  await rpc.workbench('task.delegate', { ...reviewInput, childSessionId: parentId }, { status: 400 })
  const beforeReview = await rpc.workbench('task.usage', { taskId: fresh.task.id })
  const reviewing = rpc.workbench('task.delegate', reviewInput)
  let reserved
  try {
    await until(() => reviewRequest, 'restricted reviewer model request')
    assert.deepEqual(reviewRequest.tools ?? [], [])
    assert.match(JSON.stringify(reviewRequest.system), /independent reviewer/i)
    assert.doesNotMatch(JSON.stringify(reviewRequest.messages), /parent-only history marker/)
    const pendingReviews = await rpc.workbench('task.reviews', { taskId: fresh.task.id })
    reserved = pendingReviews.items[0]
    assert.equal(reserved.status, 'reserved')
    assert.deepEqual(await rpc.workbench('task.delegate', reviewInput), reserved)
    const pending = await rpc.workbench('task.get', { taskId: fresh.task.id })
    const expectedRevision = pending.task.revision
    await rpc.workbench('task.delegate', { ...reviewInput, expectedRevision, requestId: 'concurrent-review' }, { status: 409 })
    await rpc.workbench('task.pause', { taskId: fresh.task.id, expectedRevision, requestId: 'pending-pause' }, { status: 409 })
    await rpc.workbench('task.review.reconcile', {
      taskId: fresh.task.id, expectedRevision, requestId: 'running-reconcile', reviewId: reserved.reviewId,
    }, { status: 409 })
  } finally {
    releaseReview()
  }
  const review = await reviewing
  assert.deepEqual(review, { ...reserved, status: 'completed', summary: 'independent review' })
  const reviewedTask = await rpc.workbench('task.get', { taskId: fresh.task.id })
  assert.deepEqual(reviewedTask.runs[0].childSessionIds, [review.childSessionId])
  const afterReview = await rpc.workbench('task.usage', { taskId: fresh.task.id })
  assert.equal(afterReview.completeness, 'complete')
  assert.equal(afterReview.buckets[0].uncachedInput, beforeReview.buckets[0].uncachedInput + 4)
  assert.equal(afterReview.buckets[0].output, beforeReview.buckets[0].output + 1)
  const forward = { taskId: fresh.task.id, expectedRevision: reviewedTask.task.revision,
    requestId: 'forward-review', reviewId: review.reviewId }
  const beforeForward = await rpc.workbench('task.conversation', { taskId: fresh.task.id, limit: 30 })
  assert.ok(!beforeForward.messages.some(message => message.text.includes('independent review')))
  assert.deepEqual(await rpc.workbench('task.review.forward', forward), { sessionId: parentId, accepted: true })
  await until(async () => {
    const state = await rpc.workbench('task.conversation', { taskId: fresh.task.id, limit: 30 })
    return !state.running && state.messages.some(message => message.role === 'user' && message.text.includes('independent review'))
  }, 'owner forwarded the review into the root conversation')

  const beforeForwardReplay = allModelRequests
  assert.deepEqual(await rpc.workbench('task.review.forward', forward), { sessionId: parentId, accepted: true })
  assert.equal(allModelRequests, beforeForwardReplay)
  const recoveryInput = { ...reviewInput, expectedRevision: reviewedTask.task.revision,
    requestId: 'lost-review-receipt', material: 'review recovery probe' }
  await rpc.workbench('task.delegate', recoveryInput, { status: 503 })
  const pendingReviews = (await rpc.workbench('task.reviews', { taskId: fresh.task.id })).items
  assert.deepEqual(pendingReviews.map(item => item.status), ['completed', 'reserved'])
  const recoverable = pendingReviews[1]
  const beforeRestart = await rpc.workbench('task.get', { taskId: fresh.task.id })
  assert.deepEqual(beforeRestart.runs[0].childSessionIds, [review.childSessionId])
  const knownIds = new Set((await rpc('session/list', {})).items.map(item => item.sessionId))
  await stop()
  rpc = await start({ WORKBENCH_TEST_FAIL_ATTACH: 'lost-receipt' })
  const beforeReplay = allModelRequests
  assert.deepEqual((await rpc.workbench('task.reviews', { taskId: fresh.task.id })).items, [review, recoverable])
  assert.deepEqual(await rpc.workbench('task.delegate', recoveryInput), recoverable)
  const reconcile = { taskId: fresh.task.id, reviewId: recoverable.reviewId,
    expectedRevision: beforeRestart.task.revision, requestId: 'recover-review' }
  const recovered = await rpc.workbench('task.review.reconcile', reconcile)
  assert.deepEqual(recovered, { ...recoverable, status: 'completed', summary: 'done' })
  assert.deepEqual(await rpc.workbench('task.review.reconcile', reconcile), recovered)
  const resumedTask = await rpc.workbench('task.get', { taskId: fresh.task.id })
  assert.deepEqual(resumedTask.runs[0].childSessionIds, [review.childSessionId, recovered.childSessionId])
  assert.deepEqual(await rpc.workbench('task.delegate', reviewInput), review)
  await rpc.workbench('task.delegate', { ...reviewInput, material: 'different' }, { status: 400 })
  await rpc.workbench('task.delegate', { ...reviewInput, expectedRevision: resumedTask.task.revision,
    requestId: 'over-review-limit' }, { status: 409 })
  assert.equal(allModelRequests, beforeReplay)
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
  assert.equal((await rpc('session/list', {})).items.length, knownIds.size + 1)
  assert.ok(!(await rpc('workspace/create', { path: root })).workspace.sessionIds.includes(unknownId))
  const listQuery = { workspaceId: workspace.workspaceId, limit: 1, cursor: null }
  const firstPage = await rpc.workbench('task.list', listQuery)
  assert.equal(firstPage.items.length, 1)
  assert.ok(firstPage.nextCursor)
  const nextPage = await rpc.workbench('task.list', { ...listQuery, cursor: firstPage.nextCursor })
  assert.notEqual(firstPage.items[0].id, nextPage.items[0].id)
  assert.equal((await rpc.workbench('task.list', { ...listQuery, cursor: 'bad' }, { status: 400 })).code, 'INVALID')
  const ownerStage = await rpc.workbench('task.get', { taskId: fresh.task.id })
  await rpc.workbench('task.prompt', { taskId: fresh.task.id, expectedRevision: ownerStage.task.revision,
    requestId: 'owner-presentation', text: submitMarker })
  await until(async () => concurrentPresentation && (await rpc('session/list', {})).items.some(item =>
    item.sessionId === parentId && !item.running), 'owner submission presentation committed')
  const submit = { taskId: fresh.task.id, expectedRevision: ownerStage.task.revision,
    requestId: 'owner-submit', selection: 'latest-presentation' }
  const [singleSubmission, sameSubmission] = await Promise.all([
    rpc.workbench('task.submit', submit), rpc.workbench('task.submit', submit),
  ])
  assert.deepEqual(sameSubmission, singleSubmission)
  assert.equal(singleSubmission.task.revision, ownerStage.task.revision + 1)
  assert.equal(singleSubmission.submissions.length, 1)
  assert.equal(singleSubmission.artifacts.length, 1)
  assert.equal((await rpc.workbench('task.submit', { ...submit, selection: 'files', paths: ['first.md'] },
    { status: 400 })).code, 'INVALID')
  const approve = { taskId: fresh.task.id, expectedRevision: singleSubmission.task.revision,
    submissionId: singleSubmission.task.currentSubmissionId, verdict: 'accept', reason: null,
    confirmedCriteria: ['facts'] }
  const decisions = await Promise.all(['owner-approve-a', 'owner-approve-b'].map(requestId =>
    rpc.workbench('task.decide', { ...approve, requestId }, { status: [200, 409] })))
  assert.equal(decisions.filter(item => item.code === 'REVISION_CONFLICT').length, 1)
  const oneDecision = decisions.find(item => item.task?.status === 'accepted')
  assert.ok(oneDecision)
  assert.equal(oneDecision.task.revision, singleSubmission.task.revision + 1)
  assert.equal(oneDecision.decisions.length, 1)
  assert.deepEqual(await rpc.workbench('task.get', { taskId: fresh.task.id }), oneDecision)

  const loose = await rpc('session/create', { workspaceId: workspace.workspaceId, agentPreset: 'task-collaborator' })
  await rpc('session/prompt', { sessionId: loose.sessionId, requestId: randomUUID(), mode: 'queue',
    content: [{ type: 'text', text: unboundMarker }] })
  const names = await until(() => unboundToolNames, 'unbound model tool catalog')
  assert.ok(!names.some(name => name.startsWith('workbench_')))
  const sessionIds = (await rpc('session/list', {})).items.map(item => item.sessionId).sort()
  await stop()
  const backup = join(root, 'backup')
  const disabled = join(root, 'disabled')
  const restored = join(root, 'restored')
  await cp(data, backup, { recursive: true })
  await cp(backup, disabled, { recursive: true })
  const beforeRollback = allModelRequests
  rpc = await start({}, { workbench: false, dataHome: disabled })
  assert.deepEqual((await rpc('session/list', {})).items.map(item => item.sessionId).sort(), sessionIds)
  const disabledPage = await rpc.page('/workbench')
  assert.doesNotMatch(await disabledPage.text(), /<title>DeepSeek 工作台<\/title>/)
  assert.equal(await rpc.workbench('task.get', { taskId: draft.task.id }, { status: 405 }), undefined)
  await stop()

  await cp(backup, restored, { recursive: true })
  const reservedPath = join(root, 'before-native-create.json')
  rpc = await start({ WORKBENCH_TEST_HOLD_NATIVE_CREATE: reservedPath }, { dataHome: restored })
  assert.deepEqual(await rpc.workbench('task.get', { taskId: draft.task.id }), accepted)
  assert.deepEqual(await rpc.workbench('task.create', brief), draft)
  assert.deepEqual(await rpc.workbench('task.start', lostStart), unresolved)
  assert.deepEqual((await rpc('session/list', {})).items.map(item => item.sessionId).sort(), sessionIds)
  assert.equal((await rpc.workbench('task.conversation', { taskId: draft.task.id, limit: 50 })).sessionId, sessionId)
  assert.equal(allModelRequests, beforeRollback)
  assert.deepEqual(await rpc.workbench('task.submit', submit), singleSubmission)
  assert.deepEqual(await rpc.workbench('task.get', { taskId: fresh.task.id }), oneDecision)
  const interrupted = await rpc.workbench('task.create', { ...brief, requestId: 'interrupted-after-reservation' })
  const interruptedReady = await rpc.workbench('task.ready', {
    taskId: interrupted.task.id, requestId: 'ready', expectedRevision: 0,
  })
  const interruptedStart = { taskId: interrupted.task.id, requestId: 'start', expectedRevision: interruptedReady.task.revision }
  const pendingResponse = rpc.workbench('task.start', interruptedStart).then(() => null, error => error)
  const pendingNative = await until(async () => {
    try { return JSON.parse(await readFile(reservedPath, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }, 'durable reservation before native create')
  assert.equal(pendingNative.workspaceId, workspace.workspaceId)
  assert.equal(await stop('SIGKILL'), 'SIGKILL')
  assert.ok((await pendingResponse) instanceof Error)
  rpc = await start({}, { dataHome: restored })
  const pending = await rpc.workbench('task.get', { taskId: interrupted.task.id })
  assert.equal(pending.task.status, 'blocked')
  assert.equal(pending.task.revision, interruptedReady.task.revision + 1)
  assert.deepEqual(pending.runs, [])
  assert.deepEqual(await rpc.workbench('task.start', interruptedStart), pending)
  assert.deepEqual((await rpc('session/list', {})).items.map(item => item.sessionId).sort(), sessionIds)

  const reset = await rpc.workbench('task.reconcile', { taskId: pending.task.id, requestId: 'discard',
    expectedRevision: pending.task.revision, action: 'discard-intent', rootSessionId: null })
  assert.equal(reset.task.status, 'ready')
  const retry = { taskId: reset.task.id, requestId: 'explicit-retry', expectedRevision: reset.task.revision }
  const started = await rpc.workbench('task.start', retry)
  assert.equal(started.task.status, 'active')
  assert.notEqual(started.runs[0].rootSessionId, pendingNative.sessionId)
  assert.deepEqual(await rpc.workbench('task.start', retry), started)
  assert.equal((await rpc('session/list', {})).items.length, sessionIds.length + 1)
  assert.equal(allModelRequests, beforeRollback)
  console.log('PASS: native delivery, concurrent submission and acceptance, cold replay, interrupted startup, isolated review and profile restore.')
} finally {
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(root, { recursive: true, force: true })
}
