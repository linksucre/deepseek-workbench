import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = resolve(process.argv[2] ?? '.')
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url)))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)
const reviewProbeFlag = '--review-recovery-regressions'
const legacyCheckoutFlag = '--review-profile-upgrade-from='
const legacyCheckoutOption = process.argv.slice(3).find(arg => arg.startsWith(legacyCheckoutFlag))
const legacyCheckout = legacyCheckoutOption?.slice(legacyCheckoutFlag.length)
if (legacyCheckoutOption) assert.ok(legacyCheckout, 'Supply an installed legacy Workbench checkout')
const verifyApiUpgrade = process.argv.includes('--verify-api-upgrade')
assert.ok(!verifyApiUpgrade || legacyCheckout, 'Supply the v1 Workbench checkout for the API upgrade test')
const legacyHarnessFlag = '--review-legacy-harness='
const legacyHarnessOption = process.argv.slice(3).find(arg => arg.startsWith(legacyHarnessFlag))
const legacyHarnessPath = legacyHarnessOption?.slice(legacyHarnessFlag.length)
if (legacyHarnessOption) assert.ok(legacyHarnessPath && legacyCheckout,
  'A legacy Harness path requires an installed legacy Workbench checkout')
const legacyHarness = legacyHarnessPath ? resolve(legacyHarnessPath) : checkout
const reviewProbes = ['cold-root', 'reconcile-receipt', 'forward-scope']
const forwardRefusalProbe = 'forward-pre-admission'
const unknownForwardProbe = 'forward-no-admission-proof'
const probeOption = process.argv.slice(3).find(arg => arg === reviewProbeFlag || arg.startsWith(reviewProbeFlag + '='))
assert.ok(!(legacyCheckoutOption && probeOption), 'Run the profile upgrade and review recovery probes separately')
const selectedProbes = probeOption === reviewProbeFlag ? reviewProbes
  : probeOption ? [probeOption.slice(reviewProbeFlag.length + 1)] : []
for (const probe of selectedProbes) assert.ok(
  reviewProbes.includes(probe) || [forwardRefusalProbe, unknownForwardProbe].includes(probe), `Unknown DEV-011 review probe: ${probe}`)
const verifyUnknownForward = selectedProbes.includes(unknownForwardProbe)
const verifyForwardInterruption = verifyUnknownForward || selectedProbes.includes(forwardRefusalProbe)
const reviewFailures = []
function expectReviewRecovery(name, actual, expected) {
  try {
    assert.deepEqual(actual, expected, name)
  } catch (error) {
    reviewFailures.push(error)
  }
}
const root = await mkdtemp(join(tmpdir(), 'dsh-host-delivery-'))
const patch = join(root, 'test.patch.yml')
const data = join(root, 'dsh')
const usagePolicy = join(root, 'usage-policy.json')
const forwardFault = join(root, 'forward-receipt-fault')
const forwardRefusal = join(root, 'forward-refusal')
const forwardObservationFault = join(root, 'forward-observation-fault')
const marker = 'Workbench native presentation probe'
const markerRequest = body => body.tools?.some(tool => tool.name === 'present')
  && JSON.stringify(body.messages).includes(marker)
let modelSteps = 0
let forgedResult
let releaseForged
const forgedGate = new Promise(resolve => { releaseForged = resolve })
const forgedToolId = 'workbench-forged-evidence-probe'
let ownerPresentationCount = 0
const ownerPresentationFiles = ['first.md', 'second.md']
const submitMarker = 'Workbench owner submission concurrency probe'
let allModelRequests = 0
let reviewRequest
let releaseReview
const reviewGate = new Promise(resolve => { releaseReview = resolve })
const queueHoldMarker = 'Hold the native queue for the removal probe'
let queueHoldStarted = false
let releaseQueueHold
const queueHold = new Promise(resolve => { releaseQueueHold = resolve })
let suggestionSteps = 0
let suggestionResults = []
let skillLoadIssued = false
let writingSkillListed = false
let unboundToolNames
const unboundMarker = 'Workbench unbound probe'
const suggestionMarker = 'Workbench approach probe'
const writingSkill = 'workbench-trial-writing'
const writingInstructions = 'State confirmed facts before open questions.'
const reviewRecoveryMarker = 'review recovery probe'
const longReviewConclusion = `${'甲'.repeat(8191)}🧪`
const provider = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    allModelRequests += 1
    const messages = JSON.stringify(body.messages)
    if (verifyUnknownForward && messages.includes(queueHoldMarker)) {
      queueHoldStarted = true
      await queueHold
    }
    const review = messages.includes('review isolation probe')
    if (review) {
      reviewRequest = body
      await reviewGate
    }
    const testingSuggestion = messages.includes(suggestionMarker)
    if (testingSuggestion) {
      if (suggestionSteps === 0) writingSkillListed = JSON.stringify(body).includes(writingSkill)
      suggestionResults = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block.type === 'tool_result')
    }
    if (body.tools?.some(tool => tool.name === 'present') && JSON.stringify(body.messages).includes(unboundMarker)) {
      unboundToolNames = body.tools.map(tool => tool.name)
    }
    const step = markerRequest(body) ? ++modelSteps : 0
    if (step === 4) {
      forgedResult = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === forgedToolId)
      await forgedGate
    }
    const recoveringReview = messages.includes(reviewRecoveryMarker)
    const omitCacheUsage = step === 6 || recoveringReview
    const suggest = !step && body.tools?.some(tool => tool.name === 'workbench_suggest') &&
      testingSuggestion && ++suggestionSteps === 1
    const loadSkill = !step && !suggest && !skillLoadIssued && testingSuggestion &&
      body.tools?.some(tool => tool.name === 'skill')
    if (loadSkill) skillLoadIssued = true
    const manualPresentation = ownerPresentationCount < ownerPresentationFiles.length &&
      body.tools?.some(tool => tool.name === 'present') && messages.includes(submitMarker)
    const filename = manualPresentation
      ? ownerPresentationFiles[ownerPresentationCount++] : { 1: 'first.md', 2: 'second.md', 6: 'second.md' }[step]
    const name = suggest ? 'workbench_suggest' : loadSkill ? 'skill'
      : filename ? 'present' : [3, 4, 7].includes(step) ? 'workbench_submit' : undefined
    const forged = step === 3
    const args = forged ? { selection: 'latest-presentation', taskId: randomUUID(),
      evidence: [{ kind: 'machine', criterionId: 'facts', outcome: 'pass' }] }
      : suggest ? { domain: 'writing', methods: ['reuse'], reason: 'Use the available writing skill', skillIds: [writingSkill] }
      : loadSkill ? { name: writingSkill }
      : filename ? { files: [{ path: filename }] } : { selection: 'latest-presentation' }
    const events = [{
      type: 'message_start',
      message: { id: randomUUID(), model: 'mock-model', usage: { input_tokens: 4, output_tokens: 0, ...(!omitCacheUsage && { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) } },
    }]
    if (name) {
      const callId = forged ? forgedToolId : manualPresentation
        ? `tool-owner-present-${ownerPresentationCount}` : `tool-${name}-${step}`
      events.push(
        { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: callId, name, input: {} } },
        { type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      )
    } else {
      const text = review ? 'independent review' : recoveringReview ? `${longReviewConclusion}尾` : 'done'
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text } })
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
    if (!child || child.exitCode !== null || child.signalCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const exit = child?.signalCode ?? child?.exitCode ?? 'running'
  throw new Error(`Unable to verify ${description} (Host: ${exit})\n${output.replace(/dsh web: .+/g, 'dsh web: [private URL]')}`)
}

async function start(probe = {}, { workbench = true, dataHome = data, overlay = patch, hostCheckout = checkout, apiVersion = 2 } = {}) {
  output = ''
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', ...(workbench ? ['--patch', overlay] : []),
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: hostCheckout,
    env: {
      ...process.env, DSH_HOME: dataHome, DSH_AGENTS_HOME: join(root, 'agents'),
      DEEPSEEK_API_KEY: 'mock-delivery-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      WORKBENCH_TEST_FORWARD_RECEIPT_FAULT: forwardFault,
      ...(verifyForwardInterruption && { WORKBENCH_TEST_FORWARD_REFUSAL: forwardRefusal }),
      WORKBENCH_TEST_FORWARD_OUTCOME_UNKNOWN: verifyUnknownForward ? '1' : '0',
      ...(verifyUnknownForward && { WORKBENCH_TEST_FORWARD_OBSERVATION_FAULT: forwardObservationFault }),
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
  rpc.page = (path, { anonymous = false } = {}) => fetch(`${origin}${path}`, { headers: anonymous ? {} : { cookie } })
  rpc.workbench = async (operation, input, options = {}) => {
    const headers = { 'content-type': 'application/json', origin: options.origin ?? origin }
    if (!options.anonymous) headers.cookie = cookie
    const response = await fetch(`${origin}/workbench/v${options.apiVersion ?? apiVersion}/command`, {
      method: 'POST', signal: AbortSignal.timeout(options.timeout ?? 10_000), headers,
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

async function verifyProfileUpgrade(rpc, brief, legacyPatch) {
  const { task } = await rpc.workbench('task.create', brief)
  const taskId = task.id
  const ready = await rpc.workbench('task.ready', { taskId, requestId: 'ready', expectedRevision: task.revision })
  const active = await rpc.workbench('task.start', { taskId, requestId: 'start', expectedRevision: ready.task.revision })
  const { rootSessionId: sessionId, id: runId } = active.runs[0]
  const sessionAddress = { kind: 'session', sessionId }
  const userEvents = async () => (await rpc('session/events', { address: sessionAddress, maxMessages: 100 }))
    .records.map(({ event }) => event).filter(event => event.type === 'user/message')
  const byId = async id => (await userEvents()).filter(event => event.data.source?.rpcId === id)
  const waitIdle = () => until(async () => {
    const state = await rpc('session/state', { sessionId })
    return !state.running && state.queue?.length === 0
  }, 'review upgrade session returns to idle')
  const snapshot = async () => ({
    detail: await rpc.workbench('task.get', { taskId }),
    reviews: await rpc.workbench('task.reviews', { taskId }),
    sessions: (await rpc('session/list', {})).items.map(item => item.sessionId).sort(),
    events: await userEvents(),
  })
  const parentPrompt = { taskId, expectedRevision: active.task.revision, requestId: 'parent',
    text: 'Prepare the legacy review session' }
  await rpc.workbench('task.prompt', parentPrompt)
  await waitIdle()
  releaseReview()
  const review = await rpc.workbench('task.delegate', { taskId,
    expectedRevision: (await rpc.workbench('task.get', { taskId })).task.revision,
    requestId: 'review', instruction: 'Review the selected material', material: 'review isolation probe' })
  assert.equal(review.summary, 'independent review')
  const common = { taskId, expectedRevision: (await rpc.workbench('task.get', { taskId })).task.revision }
  const forward = { ...common, requestId: 'legacy-forward', reviewId: review.reviewId }
  const legacyId = requestId => 'workbench-' + hash(JSON.stringify([taskId, runId, requestId]))
  const forwardId = requestId => 'workbench-review-forward-v2-' + hash(JSON.stringify([taskId, runId, requestId]))
  const legacyForwardId = verifyApiUpgrade ? forwardId(forward.requestId) : legacyId(`review-forward:${forward.requestId}`)
  const ack = { sessionId, accepted: true }
  assert.deepEqual(await rpc.workbench('task.review.forward', forward), ack)
  const ordinary = {
    taskId, expectedRevision: (await rpc.workbench('task.get', { taskId })).task.revision,
    requestId: 'review-forward:legacy-ordinary', text: 'Ordinary legacy prompt',
  }
  const ordinaryId = legacyId(ordinary.requestId)
  assert.deepEqual(await rpc.workbench('task.prompt', ordinary), ack)
  await until(async () => (await byId(legacyForwardId)).length === 1 && (await byId(ordinaryId)).length === 1,
    'legacy plugin commits the actual forward and ordinary prompt')
  await waitIdle()
  const [legacyEvent] = await byId(legacyForwardId)
  assert.ok(legacyEvent.data.content.some(block => block.type === 'text' && block.text.includes(review.reviewId)))
  const before = await snapshot()
  const beforeReadRequests = allModelRequests

  await stop()
  const backup = join(root, 'legacy-profile-backup')
  await cp(data, backup, { recursive: true })
  const backupRecord = join(backup, 'storages', 'workbench_tasks', 'tasks', `${taskId}.json`)
  const backupBytes = await readFile(backupRecord)
  rpc = await start()
  assert.deepEqual(await snapshot(), before)
  assert.deepEqual(await rpc.workbench('task.review.forward', forward), ack)
  assert.deepEqual(await rpc.workbench('task.prompt', ordinary), ack)
  const conflicting = { ...forward, requestId: 'legacy-ordinary' }
  if (verifyApiUpgrade) {
    await rpc.workbench('task.get', { taskId }, { apiVersion: 1, status: [404, 405] })
    assert.equal((await rpc.workbench('task.prompt', { ...ordinary, text: 'Changed prompt' }, { status: 400 })).code, 'INVALID')
  } else {
    assert.equal((await rpc.workbench('task.review.forward', conflicting, { status: 409 })).code, 'RECONCILIATION_REQUIRED')
  }
  assert.deepEqual(await snapshot(), before)
  assert.equal(allModelRequests, beforeReadRequests)

  const newForward = { ...conflicting, expectedRevision: before.detail.task.revision, requestId: 'forward-after-upgrade' }
  const newId = forwardId(newForward.requestId)
  assert.deepEqual(await rpc.workbench('task.review.forward', newForward), ack)
  await until(async () => (await byId(newId)).length === 1, 'upgraded plugin commits a fresh forward')
  await waitIdle()
  const upgraded = await snapshot()
  assert.equal(upgraded.detail.task.revision, before.detail.task.revision + 2)
  const afterWriteRequests = allModelRequests
  await stop()

  const restored = join(root, 'legacy-profile-restored')
  await cp(backup, restored, { recursive: true })
  rpc = await start({}, { dataHome: restored, overlay: legacyPatch, hostCheckout: legacyHarness, apiVersion: 1 })
  assert.deepEqual(await snapshot(), before)
  assert.deepEqual(await rpc.workbench('task.review.forward', forward), ack)
  assert.deepEqual(await rpc.workbench('task.prompt', ordinary), ack)
  assert.deepEqual(await snapshot(), before)
  assert.equal(allModelRequests, afterWriteRequests)
  await stop()
  assert.deepEqual(await readFile(backupRecord), backupBytes)

  rpc = await start()
  assert.deepEqual(await snapshot(), upgraded)
  assert.deepEqual(await rpc.workbench('task.review.forward', newForward), ack)
  assert.equal((await byId(newId)).length, 1)
  assert.equal(allModelRequests, afterWriteRequests)
  console.log(verifyApiUpgrade
    ? 'PASS: preview v1 receipts replay through v2 with no duplicate writes, and the backup rolls back to preview v1.'
    : 'PASS: real legacy forward and ordinary prompt survive profile upgrade and independent backup rollback.')
}

hostSmoke: try {
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
  const skillDirectory = join(root, 'agents', 'skills', writingSkill)
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'),
    `---\nname: ${writingSkill}\ndescription: Fixture for a writing task\n---\n\n${writingInstructions}\n`)
  let legacyPatch
  if (legacyCheckout) {
    legacyPatch = join(root, 'legacy.patch.yml')
    execFileSync(process.execPath, [resolve(legacyCheckout, 'scripts/source-overlay.mjs'), legacyHarness, legacyPatch, usagePolicy])
  }
  let rpc = legacyPatch ? await start({}, { overlay: legacyPatch, hostCheckout: legacyHarness, apiVersion: 1 })
    : await start({ WORKBENCH_TEST_FAIL_ATTACH: '1' })
  const page = await rpc.page('/workbench')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  assert.match(await page.text(), /新建任务/)
  assert.equal((await rpc.page('/workbench/ui.mjs')).status, 200)
  assert.equal((await rpc.page('/workbench', { anonymous: true })).status, 401)
  const { workspace } = await rpc('workspace/create', { path: root })
  const otherPath = join(root, 'other-workspace')
  await mkdir(otherPath)
  const { workspace: otherWorkspace } = await rpc('workspace/create', { path: otherPath })
  assert.ok((await (await rpc.page(`/workbench/v${legacyPatch ? 1 : 2}/workspaces`)).json()).some(item => item.id === workspace.workspaceId))
  const brief = {
    requestId: 'workbench-create', workspaceId: workspace.workspaceId, title: 'Native workbench',
    goal: 'Verify task persistence', criteria: [{ id: 'facts', description: 'Check sources' }],
    deliverables: ['second.md'], materials: [{ kind: 'file', locator: 'first.md', observedAt: '2025-01-01T00:00:00Z' }],
  }
  if (legacyPatch) {
    await verifyProfileUpgrade(rpc, brief, legacyPatch)
    break hostSmoke
  }
  await rpc.workbench('task.create', brief, { anonymous: true, status: 401 })
  await rpc.workbench('task.create', brief, { origin: 'https://untrusted.example', status: 403 })
  assert.equal((await rpc.workbench('task.create', { ...brief, caller: 'owner' }, { status: 400 })).code, 'INVALID')
  assert.equal((await rpc.workbench('task.create', { ...brief, title: '' }, { status: 400 })).code, 'INVALID')
  assert.equal((await rpc.workbench('task.create', { ...brief, workspaceId: randomUUID() }, { status: 404 })).code, 'NOT_FOUND')
  const draft = await rpc.workbench('task.create', brief)
  await rpc.workbench('task.get', { taskId: draft.task.id }, { anonymous: true, status: 401 })
  assert.equal((await rpc.workbench('task.get', { taskId: randomUUID() }, { status: 404 })).code, 'NOT_FOUND')
  const emptyWorkspaceTasks = { workspaceId: otherWorkspace.workspaceId, limit: 1, cursor: null }
  assert.deepEqual((await rpc.workbench('task.list', emptyWorkspaceTasks)).items, [])
  const taskId = draft.task.id
  const source = brief.materials[0]
  await rpc.workbench('task.context.index', { taskId }, { anonymous: true, status: 401 })
  await rpc.workbench('task.context.load', { taskId, source }, { anonymous: true, status: 401 })
  await rpc.workbench('task.context.index', { taskId }, { origin: 'https://untrusted.example', status: 403 })
  await rpc.workbench('task.context.load', { taskId, source }, { origin: 'https://untrusted.example', status: 403 })
  await rpc.workbench('task.context.load', { taskId, source: { ...source, locator: 'second.md' } }, { status: 404 })
  const draftContext = await rpc.workbench('task.context.index', { taskId })
  assert.deepEqual(draftContext.sources, [{ source, workspaceId: workspace.workspaceId, origins: ['brief'], freshness: 'stale' }])
  assert.equal(draftContext.handoff.stage, null)
  assert.deepEqual((await rpc.workbench('task.context.load', { taskId, source })).content, { kind: 'file', text: 'draft' })
  const outside = { ...source, locator: '../first.md' }
  const limited = await rpc.workbench('task.create', {
    ...brief, workspaceId: otherWorkspace.workspaceId, requestId: 'out-of-scope-material', materials: [outside, source],
  })
  assert.deepEqual((await rpc.workbench('task.context.index', { taskId: limited.task.id })).sources, [])
  await rpc.workbench('task.context.load', { taskId: limited.task.id, source: outside }, { status: 404 })
  assert.equal(allModelRequests, 0)
  assert.equal((await rpc.workbench('task.start', { taskId: draft.task.id, requestId: 'start-draft',
    expectedRevision: draft.task.revision }, { status: 409 })).code, 'INVALID_TRANSITION')
  assert.deepEqual(await rpc.workbench('task.get', { taskId: draft.task.id }), draft)
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
  for (const changed of [
    { ...attach, rootSessionId: 'different-root' },
    { ...attach, expectedRevision: attach.expectedRevision + 1 },
    { ...attach, action: 'discard-intent', rootSessionId: null },
  ]) {
    assert.equal((await rpc.workbench('task.reconcile', changed, { status: 400 })).code, 'INVALID')
  }
  assert.deepEqual(await rpc.workbench('task.get', { taskId }), attached)
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
  assert.equal(writingSkillListed, true, 'Harness lists the fixture skill before the model suggests reuse')
  assert.deepEqual(suggested.task.choice.methods, ['reuse'])
  assert.deepEqual(suggested.task.choice.skillIds, [writingSkill])
  assert.ok(suggestionResults.some(result => !result.is_error && JSON.stringify(result).includes(writingInstructions)),
    'The native skill tool returned the test skill body')
  const overridden = await rpc.workbench('task.choose', {
    taskId: draft.task.id, requestId: 'override', expectedRevision: suggested.task.revision,
    choice: { domain: 'documents', methods: ['verify-first'], reason: 'Check sources first', skillIds: [], source: 'user' },
  })
  assert.equal(overridden.task.choice.source, 'user')
  await prompt(marker, overridden.task.revision, 'stable-display-request')
  try {
    await until(() => forgedResult, 'native rejection of fabricated machine evidence')
    assert.equal(forgedResult.is_error, true)
    assert.deepEqual(await rpc.workbench('task.get', { taskId: draft.task.id }), overridden)
  } finally {
    releaseForged()
  }
  await until(async () => modelSteps >= 5 && await idle(), 'native presentations and workbench submission')
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
    const context = await restarted.workbench('task.context.index', { taskId })
    assert.equal(context.sources[0].freshness, 'stale')
    assert.ok(context.sources.every(source => !Object.hasOwn(source, 'content')))
    assert.equal(context.handoff.lastSubmission.id, submitted.task.currentSubmissionId)
    assert.equal(context.handoff.stage.runId, submitted.task.activeRunId)
    assert.deepEqual(context.handoff.choice, submitted.task.choice)
    const preview = await restarted.workbench('task.context.load', { taskId, source })
    const presented = await restarted.workbench('task.context.load', { taskId, source: submitted.artifacts[0].source })
    assert.deepEqual(preview.content, { kind: 'file', text: 'draft' })
    assert.deepEqual(presented.content, { kind: 'presentation', locator: submitted.artifacts[0].locator,
      version: hash('version 1') })
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
  const submittedPath = join(root, 'second.md')
  await unlink(submittedPath)
  assert.equal((await rpc.workbench('task.decide', { ...decision, requestId: 'missing-file' },
    { status: 409 })).code, 'ARTIFACT_DRIFT')
  await symlink('first.md', submittedPath)
  assert.equal((await rpc.workbench('task.decide', { ...decision, requestId: 'substituted-symlink' },
    { status: 409 })).code, 'ARTIFACT_DRIFT')
  await unlink(submittedPath)
  await writeFile(submittedPath, 'version 2')
  assert.deepEqual(await rpc.workbench('task.get', { taskId: draft.task.id }), submitted)
  const returned = await rpc.workbench('task.decide', {
    taskId: decision.taskId, expectedRevision: decision.expectedRevision, submissionId: decision.submissionId,
    verdict: 'return', reason: 'Review the updated file', requestId: 'return',
  })
  assert.equal(returned.task.status, 'active')
  const handoff = (await rpc.workbench('task.context.index', { taskId })).handoff
  assert.equal(handoff.lastDecision.verdict, 'return')
  assert.equal(handoff.lastDecision.reason, 'Review the updated file')
  await prompt('Present the updated file and submit it', returned.task.revision)
  await until(async () => modelSteps >= 8 && await idle(), 'native re-presentation and re-submission')
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
  assert.equal((await rpc.workbench('task.choose', { taskId: accepted.task.id, requestId: 'change-terminal',
    expectedRevision: accepted.task.revision, choice: overridden.task.choice }, { status: 409 })).code, 'INVALID_TRANSITION')
  assert.deepEqual(await rpc.workbench('task.get', { taskId: draft.task.id }), accepted)
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
  const parentHistory = `${'parent-only history marker'.padEnd(8191, '甲')}🧪`
  await rpc.workbench('task.prompt', { taskId: fresh.task.id, expectedRevision: freshActive.task.revision,
    requestId: 'parent-history', text: parentHistory })
  await until(async () => (await rpc('session/list', {})).items.some(item =>
    item.sessionId === parentId && !item.running && !item.blank), 'review parent history committed')
  const parentConversation = await rpc.workbench('task.conversation', { taskId: fresh.task.id, limit: 20 })
  const parentMessage = parentConversation.messages.find(item => item.role === 'user' && item.text.startsWith('parent-only history marker'))
  assert.equal(parentConversation.sessionId, parentId)
  assert.ok(Number.isSafeInteger(parentMessage?.seq))
  assert.ok(parentMessage.text.endsWith('🧪'), 'The complete boundary character is visible in the root conversation')
  assert.equal(parentMessage.text, parentHistory)
  const reviewParent = await rpc.workbench('task.get', { taskId: fresh.task.id })
  assert.deepEqual(reviewParent.runs[0].childSessionIds, [])
  assert.deepEqual((await rpc.workbench('task.reviews', { taskId: fresh.task.id })).items, [])
  const beforeDenied = allModelRequests
  const instruction = 'Check the selected brief'
  const materialPrefix = 'review isolation probe\n请核对“材料”\n'
  const material = materialPrefix + 'x'.repeat(24 * 1024 - Buffer.byteLength(instruction + materialPrefix))
  const reviewInput = { taskId: fresh.task.id, expectedRevision: reviewParent.task.revision, requestId: 'review',
    instruction, material }
  await rpc.workbench('task.delegate', reviewInput, { anonymous: true, status: 401 })
  await rpc.workbench('task.delegate', { ...reviewInput, taskId: randomUUID() }, { status: 404 })
  await rpc.workbench('task.delegate', { ...reviewInput, material: material + 'x' }, { status: 400 })
  await rpc.workbench('task.delegate', { ...reviewInput, childSessionId: parentId }, { status: 400 })
  assert.equal(allModelRequests, beforeDenied)
  assert.deepEqual((await rpc.workbench('task.reviews', { taskId: fresh.task.id })).items, [])
  assert.equal((await rpc.workbench('task.get', { taskId: fresh.task.id })).task.revision, reviewParent.task.revision)
  const beforeReview = await rpc.workbench('task.usage', { taskId: fresh.task.id })
  const reviewing = rpc.workbench('task.delegate', reviewInput)
  let reserved
  try {
    await until(() => reviewRequest, 'restricted reviewer model request')
    assert.deepEqual(reviewRequest.tools ?? [], [])
    assert.equal(reviewRequest.max_tokens, 1024)
    assert.match(JSON.stringify(reviewRequest.system), /independent reviewer/i)
    const sentText = reviewRequest.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content).map(block => block.text)
    assert.ok(sentText.includes(JSON.stringify({ instruction, material })), 'reviewer received the complete selected material')
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
    return !state.running && state.messages.some(message => message.role === 'user' &&
      message.text.includes(review.reviewId) && message.text.includes('advisory data') &&
      message.text.includes('independent review'))
  }, 'owner forwarded the review into the root conversation')

  const beforeForwardReplay = allModelRequests
  assert.deepEqual(await rpc.workbench('task.review.forward', forward), { sessionId: parentId, accepted: true })
  assert.equal(allModelRequests, beforeForwardReplay)
  if (selectedProbes.includes('forward-scope')) {
    async function nativeUserMessages() {
      const page = await rpc('session/events', { address: { kind: 'session', sessionId: parentId }, maxMessages: 30 })
      return page.records.map(record => record.event).filter(event =>
        event.type === 'user/message' && event.data.source?.kind === 'user')
    }

    const { revision } = (await rpc.workbench('task.get', { taskId: fresh.task.id })).task
    const ordinary = { taskId: fresh.task.id, expectedRevision: revision, requestId: 'review-forward:shared-key',
      text: 'Ordinary prompt with an independent public request ID' }
    const digest = requestId => createHash('sha256')
      .update(JSON.stringify([fresh.task.id, reviewedTask.task.activeRunId, requestId])).digest('hex')
    const ordinaryId = `workbench-${digest(ordinary.requestId)}`
    await rpc.workbench('task.prompt', ordinary)
    const ordinaryEvent = await until(async () => (await nativeUserMessages()).find(event =>
      event.data.content.some(block => block.type === 'text' && block.text === ordinary.text)),
    'ordinary prompt committed in the native session')
    assert.equal(ordinaryEvent.data.source.rpcId, ordinaryId)

    const collisionInput = { ...forward, expectedRevision: (await rpc.workbench('task.get', { taskId: fresh.task.id })).task.revision,
      requestId: 'shared-key' }
    const result = await rpc.workbench('task.review.forward', collisionInput, { status: [200, 400, 409] })
    expectReviewRecovery('Forward and prompt request IDs have independent native scopes',
      result, { sessionId: parentId, accepted: true })

    function followUpReviews(events) {
      return events.filter(event => event.seq > ordinaryEvent.seq && event.data.content.some(block =>
        block.type === 'text' && block.text.includes(review.reviewId) && block.text.includes('independent review')))
    }
    if (result.accepted === true) {
      await until(async () => followUpReviews(await nativeUserMessages()).length > 0,
        'forwarded review committed in the native session')
    }
    await until(async () => {
      const state = await rpc('session/state', { sessionId: parentId })
      return !state.running && state.queue?.length === 0
    }, 'root settles after the prompt and forward')
    const userEvents = await nativeUserMessages()
    const forwardId = `workbench-review-forward-v2-${digest(collisionInput.requestId)}`
    expectReviewRecovery('Native history records one ordinary prompt and one forwarded review with separate IDs', {
      ordinary: userEvents.filter(event => event.data.content.some(block => block.type === 'text' &&
        block.text === ordinary.text)).map(event => event.data.source.rpcId),
      forwarded: followUpReviews(userEvents).map(event => event.data.source.rpcId),
    }, { ordinary: [ordinaryId], forwarded: [forwardId] })
  }
  const beforeRecoveryUsage = await rpc.workbench('task.usage', { taskId: fresh.task.id })
  assert.equal(beforeRecoveryUsage.completeness, 'complete')
  const recoveryInput = { ...reviewInput, expectedRevision: (await rpc.workbench('task.get', { taskId: fresh.task.id })).task.revision,
    requestId: 'lost-review-receipt', material: reviewRecoveryMarker }
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
  assert.ok(recovered.summary.endsWith('🧪'), 'The complete boundary character survives cold review recovery')
  assert.deepEqual(recovered, { ...recoverable, status: 'completed', summary: longReviewConclusion })
  assert.deepEqual(await rpc.workbench('task.review.reconcile', reconcile), recovered)
  const resumedTask = await rpc.workbench('task.get', { taskId: fresh.task.id })
  assert.deepEqual(resumedTask.runs[0].childSessionIds, [review.childSessionId, recovered.childSessionId])
  const recoveredUsage = await rpc.workbench('task.usage', { taskId: fresh.task.id })
  assert.equal(recoveredUsage.completeness, 'partial')
  assert.equal(recoveredUsage.estimatedCost, null)
  assert.match(recoveredUsage.coverageNotes.join(' '), /1 attempt\(s\) have missing or ambiguous token counts/)
  assert.equal(recoveredUsage.buckets[0].uncachedInput, beforeRecoveryUsage.buckets[0].uncachedInput + 4)
  assert.equal(recoveredUsage.buckets[0].output, beforeRecoveryUsage.buckets[0].output + 1)
  assert.deepEqual(await rpc.workbench('task.delegate', reviewInput), review)
  await rpc.workbench('task.delegate', { ...reviewInput, material: 'different' }, { status: 400 })
  await rpc.workbench('task.delegate', { ...reviewInput, expectedRevision: resumedTask.task.revision,
    requestId: 'over-review-limit' }, { status: 409 })
  assert.equal(allModelRequests, beforeReplay)
  if (verifyForwardInterruption) {
    const taskId = fresh.task.id
    const refused = { taskId, reviewId: review.reviewId, expectedRevision: resumedTask.task.revision,
      requestId: 'forward-refused-before-admission' }
    const nativeId = requestId => 'workbench-review-forward-v2-' + createHash('sha256')
      .update(JSON.stringify([taskId, review.runId, requestId])).digest('hex')
    const nativeCount = async requestId => {
      const native = await rpc('session/events', { address: { kind: 'session', sessionId: parentId }, maxMessages: 100 })
      return native.records.filter(({ event }) => event.type === 'user/message' &&
        event.data.source?.rpcId === nativeId(requestId)).length
    }
    const refusalStatus = { status: 409 }
    await writeFile(forwardRefusal, nativeId(refused.requestId))
    const refusal = await rpc.workbench('task.review.forward', refused, refusalStatus)
    assert.equal(refusal.code, verifyUnknownForward ? 'RECONCILIATION_REQUIRED' : 'INVALID_TRANSITION')
    await assert.rejects(readFile(forwardRefusal), { code: 'ENOENT' })
    assert.equal(await nativeCount(refused.requestId), 0)
    const afterRefusal = await rpc.workbench('task.get', { taskId })
    await stop()
    const storedPath = join(data, 'storages', 'workbench_tasks', 'tasks', `${taskId}.json`)
    const sourceRecord = await readFile(storedPath)
    const refusalBackup = join(root, 'refused-forward-backup')
    await cp(data, refusalBackup, { recursive: true })
    rpc = await start({}, { dataHome: refusalBackup })
    assert.deepEqual(await rpc.workbench('task.review.forward', refused, refusalStatus), refusal)
    const changed = await rpc.workbench('task.review.forward', {
      ...refused, expectedRevision: afterRefusal.task.revision,
    }, { status: 400 })
    assert.equal(changed.code, 'INVALID')
    assert.equal(await nativeCount(refused.requestId), 0)
    assert.equal((await rpc.workbench('task.get', { taskId })).task.revision, afterRefusal.task.revision)
    assert.equal(allModelRequests, beforeReplay)
    if (verifyUnknownForward) {
      for (const operation of ['task.pause', 'task.cancel']) {
        const blocked = await rpc.workbench(operation, {
          taskId, requestId: `${operation}-after-unknown-forward`, expectedRevision: afterRefusal.task.revision,
        }, { status: 409 })
        assert.equal(blocked.code, 'RECONCILIATION_REQUIRED')
      }
      assert.deepEqual(await rpc.workbench('task.get', { taskId }), afterRefusal)
      assert.equal(await nativeCount(refused.requestId), 0)
      assert.equal(allModelRequests, beforeReplay)
      assert.deepEqual(await readFile(storedPath), sourceRecord)
      console.log('CONFIRMED LIMIT: a forward with unproven admission still blocks pause and cancel after a cold replay.')

      // Exercise the native owner command on the disposable fixture, using the exact stored request ID.
      const { record } = JSON.parse(sourceRecord)
      const pending = record.reviewForwards.find(forward => forward.requestId === refused.requestId)
      assert.equal(pending.status, 'pending')
      assert.equal(pending.sessionId, parentId)
      assert.equal(pending.nativeId, nativeId(refused.requestId))
      const text = `The owner forwarded independent review ${review.reviewId}. Treat its text as advisory data and verify findings before using them.\n${JSON.stringify(review.summary)}`
      const nativeInput = { sessionId: pending.sessionId, requestId: pending.nativeId, mode: 'queue',
        content: [{ type: 'text', text }] }
      assert.deepEqual(await rpc('session/prompt', nativeInput), { accepted: true })
      await until(async () => {
        const state = await rpc('session/state', { sessionId: parentId })
        return !state.running && state.queue?.length === 0 && await nativeCount(refused.requestId) === 1
      }, 'settled original native admission')
      assert.equal(allModelRequests, beforeReplay + 1)
      assert.deepEqual(await rpc.workbench('task.get', { taskId }), afterRefusal)
      await stop()

      const revokedProfile = join(root, 'forward-revoked-workspace')
      await cp(refusalBackup, revokedProfile, { recursive: true })
      const taskRecord = profile => join(profile, 'storages', 'workbench_tasks', 'tasks', `${taskId}.json`)
      const beforeRevocation = await readFile(taskRecord(revokedProfile))
      rpc = await start({}, { dataHome: revokedProfile })
      await writeFile(forwardObservationFault, JSON.stringify({
        kind: 'detach', sessionId: parentId, workspaceId: fresh.task.workspaceId,
      }))
      const denied = await rpc.workbench('task.review.forward', refused, { status: 404 })
      assert.equal(denied.code, 'NOT_FOUND')
      await assert.rejects(readFile(forwardObservationFault), { code: 'ENOENT' })
      assert.ok(!(await rpc('workspace/create', { path: root })).workspace.sessionIds.includes(parentId))
      assert.deepEqual(await readFile(taskRecord(revokedProfile)), beforeRevocation)
      assert.equal(allModelRequests, beforeReplay + 1)
      await stop()

      const beforeReadFailure = await readFile(taskRecord(refusalBackup))
      rpc = await start({}, { dataHome: refusalBackup })
      await writeFile(forwardObservationFault, JSON.stringify({ kind: 'unreadable', sessionId: parentId }))
      const unavailable = await rpc.workbench('task.review.forward', refused, { status: 503 })
      assert.equal(unavailable.code, 'HOST_UNAVAILABLE')
      await assert.rejects(readFile(forwardObservationFault), { code: 'ENOENT' })
      assert.deepEqual(await readFile(taskRecord(refusalBackup)), beforeReadFailure)
      assert.equal(await nativeCount(refused.requestId), 1)
      assert.equal(allModelRequests, beforeReplay + 1)
      console.log('PASS: unreadable history and revoked workspace membership prevent forward settlement and resubmission.')

      const coldReplays = await Promise.all([
        rpc('session/prompt', nativeInput), rpc('session/prompt', nativeInput),
      ])
      assert.deepEqual(coldReplays, [{ accepted: true }, { accepted: true }])
      assert.equal(await nativeCount(refused.requestId), 1)
      const state = await rpc('session/state', { sessionId: parentId })
      assert.equal(state.running, false)
      assert.deepEqual(state.queue, [])
      const ack = { sessionId: parentId, accepted: true }
      assert.deepEqual(await rpc.workbench('task.review.forward', refused), ack)
      assert.deepEqual(await rpc.workbench('task.review.forward', refused), ack)
      const settled = await rpc.workbench('task.get', { taskId })
      assert.equal(settled.task.revision, afterRefusal.task.revision + 1)
      assert.equal(allModelRequests, beforeReplay + 1)
      console.log('PASS: exact native replays admit one message, and Workbench settles the recovered forward once.')

      // Keep a turn running so the separate test message stays in the native queue until removed.
      const beforeRemoval = allModelRequests
      await rpc('session/prompt', { ...nativeInput, requestId: randomUUID(),
        content: [{ type: 'text', text: queueHoldMarker }] })
      await until(() => queueHoldStarted, 'the holding prompt reaches the simulated model')
      const removed = { ...nativeInput, requestId: randomUUID(),
        content: [{ type: 'text', text: 'Remove this queued fixture before execution' }] }
      assert.deepEqual(await rpc('session/prompt', removed), { accepted: true })
      const queued = await until(async () => (await rpc('session/state', { sessionId: parentId }))
        .queue?.find(item => item.rpcId === removed.requestId), 'the admitted message is visible in the queue')
      assert.deepEqual(await rpc('session/updateQueue', {
        sessionId: parentId, itemId: queued.id, action: { kind: 'remove' },
      }), { accepted: true })
      releaseQueueHold()
      await until(async () => {
        const state = await rpc('session/state', { sessionId: parentId })
        return !state.running && state.queue?.length === 0
      }, 'only the holding prompt completes')
      assert.equal(allModelRequests, beforeRemoval + 1)
      await stop()
      rpc = await start({}, { dataHome: refusalBackup })
      assert.deepEqual(await rpc('session/prompt', removed), { accepted: true })
      const afterRemoval = await rpc('session/state', { sessionId: parentId })
      assert.equal(afterRemoval.running, false)
      assert.deepEqual(afterRemoval.queue, [])
      const events = (await rpc('session/events', { address: { kind: 'session', sessionId: parentId }, maxMessages: 100 }))
        .records.map(({ event }) => event)
      assert.ok(events.some(event => event.type === 'agent/inbox/spliced' &&
        event.data.inserted.some(message => message.source?.rpcId === removed.requestId)))
      assert.ok(!events.some(event => event.type === 'user/message' && event.data.source?.rpcId === removed.requestId))
      assert.equal(allModelRequests, beforeRemoval + 1)
      const paused = await rpc.workbench('task.pause', {
        taskId, requestId: 'pause-after-observed-forward', expectedRevision: settled.task.revision,
      })
      assert.equal(paused.task.status, 'paused')
      assert.equal(allModelRequests, beforeRemoval + 1)
      assert.deepEqual(await readFile(storedPath), sourceRecord)
      console.log('PASS: native replay after restart does not requeue a message the owner removed.')

      // Restart from the original pending record with no request state from the prior client.
      await stop()
      const newClientProfile = join(root, 'pending-forward-new-client')
      await cp(data, newClientProfile, { recursive: true })
      rpc = await start({}, { dataHome: newClientProfile })
      const pendingTask = await rpc.workbench('task.get', { taskId })
      assert.deepEqual(pendingTask, afterRefusal)
      const newInput = { ...refused, requestId: 'new-request-for-pending-review',
        expectedRevision: pendingTask.task.revision }
      const modelCountBefore = allModelRequests
      const result = await rpc.workbench('task.review.forward', newInput, { status: [200, 409] })
      if (result.accepted === true) {
        await until(async () => await nativeCount(newInput.requestId) === 1, 'the new request reaches the native root')
        await until(() => allModelRequests > modelCountBefore, 'a model call caused by the new forward')
      }
      const currentTask = await rpc.workbench('task.get', { taskId })
      assert.deepEqual({
        conflict: result.code === 'REVISION_CONFLICT',
        revisionChange: currentTask.task.revision - pendingTask.task.revision,
        nativeMessages: await nativeCount(newInput.requestId),
        modelRequests: allModelRequests - modelCountBefore,
        recordPreserved: sourceRecord.equals(await readFile(taskRecord(newClientProfile))),
      }, { conflict: true, revisionChange: 0, nativeMessages: 0, modelRequests: 0, recordPreserved: true },
      'A new request ID must not forward the same review while an earlier attempt is pending')
      assert.deepEqual(await rpc.workbench('task.review.forward', refused, refusalStatus), refusal)

      await rpc('session/prompt', nativeInput)
      await until(async () => {
        const state = await rpc('session/state', { sessionId: parentId })
        return !state.running && state.queue?.length === 0 && await nativeCount(refused.requestId) === 1
      }, 'the original native forward settles')
      assert.deepEqual(await rpc.workbench('task.review.forward', refused), ack)
      const confirmed = await rpc.workbench('task.get', { taskId })
      assert.equal(confirmed.task.revision, pendingTask.task.revision + 1)
      const retry = { ...newInput, expectedRevision: confirmed.task.revision }
      assert.deepEqual(await rpc.workbench('task.review.forward', retry), ack)
      await until(async () => {
        const state = await rpc('session/state', { sessionId: parentId })
        return !state.running && state.queue?.length === 0 && await nativeCount(newInput.requestId) === 1
      }, 'the new forward reaches the native session once')
      assert.deepEqual(await rpc.workbench('task.review.forward', retry), ack)
      assert.equal((await rpc.workbench('task.get', { taskId })).task.revision, confirmed.task.revision + 2)
      assert.equal(await nativeCount(newInput.requestId), 1)
      assert.equal(allModelRequests, modelCountBefore + 2)
      console.log('PASS: a new forward conflicts while the original is pending and succeeds once after settlement.')

      await stop()
      const splitProfile = join(root, 'pending-forward-split-receipt')
      await cp(data, splitProfile, { recursive: true })
      rpc = await start({}, { dataHome: splitProfile })
      const splitAt = text.indexOf('\n')
      assert.ok(splitAt > 0)
      const splitContent = [text.slice(0, splitAt), text.slice(splitAt + 1)]
        .map(part => ({ type: 'text', text: part }))
      assert.deepEqual(await rpc('session/prompt', { ...nativeInput, content: splitContent }), { accepted: true })
      await until(async () => {
        const state = await rpc('session/state', { sessionId: parentId })
        return !state.running && state.queue?.length === 0 && await nativeCount(refused.requestId) === 1
      }, 'the native receipt preserves its distinct content blocks')
      await stop()
      rpc = await start({}, { dataHome: splitProfile })
      const nativeEvents = await rpc('session/events', { address: { kind: 'session', sessionId: parentId }, maxMessages: 100 })
      const splitMessage = nativeEvents.records.find(({ event }) => event.type === 'user/message' &&
        event.data.source?.rpcId === nativeInput.requestId)
      assert.deepEqual(splitMessage?.event.data.content, splitContent)
      const beforeSplitReplay = allModelRequests
      const splitResult = await rpc.workbench('task.review.forward', refused, { status: [200, 409] })
      assert.equal(splitResult.code, 'RECONCILIATION_REQUIRED',
        'Equal joined text cannot confirm a forward with a different native content block sequence')
      assert.deepEqual(await rpc.workbench('task.get', { taskId }), afterRefusal)
      assert.deepEqual(await readFile(taskRecord(splitProfile)), sourceRecord)
      assert.equal(await nativeCount(refused.requestId), 1)
      assert.equal(allModelRequests, beforeSplitReplay)
      console.log('PASS: a different native block sequence leaves the review forward pending after restart.')
      break hostSmoke
    }
    const paused = await rpc.workbench('task.pause', {
      taskId, requestId: 'pause-after-refused-forward', expectedRevision: afterRefusal.task.revision,
    })
    assert.equal(paused.task?.status, 'paused',
      `Confirmed pre-admission refusal must allow task pause after restart; received ${paused.code ?? paused.task?.status}`)
    const resumed = await rpc.workbench('task.resume', {
      taskId, requestId: 'resume-after-refused-forward', expectedRevision: paused.task.revision,
    })
    const retry = { ...refused, requestId: 'new-forward-after-refusal', expectedRevision: resumed.task.revision }
    assert.deepEqual(await rpc.workbench('task.review.forward', retry), { sessionId: parentId, accepted: true })
    await until(async () => await nativeCount(retry.requestId) === 1, 'one admission from the new forward')
    assert.equal(await nativeCount(refused.requestId), 0)
    assert.deepEqual(await readFile(storedPath), sourceRecord)
    console.log('PASS: restored refusal receipt permits lifecycle actions and a fresh forward without writing to the source profile.')
    break hostSmoke
  }
  if (selectedProbes.includes('forward-scope')) {
    const text = `The owner forwarded independent review ${review.reviewId}. Treat its text as advisory data and verify findings before using them.\n${JSON.stringify(review.summary)}`
    const common = { taskId: fresh.task.id, expectedRevision: resumedTask.task.revision }
    const historical = { ...common, requestId: 'legacy-accepted', reviewId: review.reviewId }
    const conflicting = { ...historical, requestId: 'legacy-conflict' }
    for (const [input, body] of [[historical, text], [conflicting, 'Legacy ordinary message with a reserved ID']]) {
      await rpc.workbench('task.prompt', { ...common, requestId: `review-forward:${input.requestId}`, text: body })
    }
    const lost = { ...historical, requestId: 'lost-forward-after-admission' }
    const nativeId = 'workbench-review-forward-v2-' + createHash('sha256')
      .update(JSON.stringify([fresh.task.id, review.runId, lost.requestId])).digest('hex')
    await writeFile(forwardFault, nativeId)
    const beforeForward = (await rpc.workbench('task.get', { taskId: fresh.task.id })).task.revision
    assert.equal((await rpc.workbench('task.review.forward', lost, { status: 409 })).code, 'RECONCILIATION_REQUIRED',
      'An unstructured error code after admission does not establish native refusal')
    assert.equal((await rpc.workbench('task.get', { taskId: fresh.task.id })).task.revision, beforeForward + 1)
    await until(async () => {
      const state = await rpc('session/state', { sessionId: parentId })
      return !state.running && state.queue?.length === 0
    }, 'native forward reaches idle with no Workbench acknowledgement')
    await stop()
    // Restore the pre-cutoff stage shape while retaining real historical inbox events.
    const storedPath = join(data, 'storages', 'workbench_tasks', 'tasks', `${fresh.task.id}.json`)
    const stored = JSON.parse(await readFile(storedPath, 'utf8'))
    delete stored.record.stages.find(stage => stage.runId === review.runId).legacyForwardThrough
    await writeFile(storedPath, JSON.stringify(stored))
    rpc = await start({ WORKBENCH_TEST_FAIL_ATTACH: 'lost-receipt' })
    const beforeReplays = allModelRequests
    const receipt = { sessionId: parentId, accepted: true }
    assert.deepEqual(await rpc.workbench('task.review.forward', historical), receipt)
    assert.equal((await rpc.workbench('task.review.forward', conflicting, { status: 409 })).code, 'RECONCILIATION_REQUIRED')
    assert.deepEqual(await rpc.workbench('task.review.forward', lost), receipt)
    assert.deepEqual(await rpc.workbench('task.review.forward', lost), receipt)
    await rpc.workbench('task.review.forward', { ...lost, expectedRevision: lost.expectedRevision + 1 }, { status: 400 })
    assert.equal((await rpc.workbench('task.get', { taskId: fresh.task.id })).task.revision, beforeForward + 2)
    const native = await rpc('session/events', { address: { kind: 'session', sessionId: parentId }, maxMessages: 100 })
    assert.equal(native.records.filter(({ event }) => event.type === 'user/message' &&
      event.data.source?.rpcId === nativeId).length, 1)
    assert.equal(allModelRequests, beforeReplays)
  }
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
  assert.equal((await rpc.workbench('task.list', { ...emptyWorkspaceTasks, cursor: firstPage.nextCursor },
    { status: 400 })).code, 'INVALID')
  const nextPage = await rpc.workbench('task.list', { ...listQuery, cursor: firstPage.nextCursor })
  assert.notEqual(firstPage.items[0].id, nextPage.items[0].id)
  assert.equal((await rpc.workbench('task.list', { ...listQuery, cursor: 'bad' }, { status: 400 })).code, 'INVALID')
  const ownerStage = await rpc.workbench('task.get', { taskId: fresh.task.id })
  await rpc.workbench('task.prompt', { taskId: fresh.task.id, expectedRevision: ownerStage.task.revision,
    requestId: 'owner-presentation', text: submitMarker })
  const presentations = await until(async () => {
    const state = await rpc('session/state', { sessionId: parentId })
    if (state.running || state.queue?.length !== 0) return
    const page = await rpc('session/events', { address: { kind: 'session', sessionId: parentId }, maxMessages: 30 })
    const events = page.records.map(record => record.event).filter(event => event.type === 'deliverables/presented')
    if (events.length >= ownerPresentationFiles.length) return events
  }, 'both owner submission presentations committed')
  assert.deepEqual(presentations.map(event => event.data.files.map(file => basename(file.path))),
    [['first.md'], ['second.md']])
  assert.ok(presentations[0].seq < presentations[1].seq)
  const submit = { taskId: fresh.task.id, expectedRevision: ownerStage.task.revision,
    requestId: 'owner-submit', selection: 'files', paths: ['first.md'] }
  const [singleSubmission, sameSubmission] = await Promise.all([
    rpc.workbench('task.submit', submit), rpc.workbench('task.submit', submit),
  ])
  assert.deepEqual(sameSubmission, singleSubmission)
  assert.equal(singleSubmission.task.revision, ownerStage.task.revision + 1)
  assert.equal(singleSubmission.submissions.length, 1)
  assert.equal(singleSubmission.artifacts.length, 1)
  const [selectedFile] = singleSubmission.artifacts
  assert.equal(selectedFile.locator, await realpath(join(root, 'first.md')))
  assert.equal(selectedFile.versionKind, 'sha256')
  assert.equal(selectedFile.version, hash('draft'))
  assert.equal(selectedFile.source.kind, 'session-event')
  assert.deepEqual(JSON.parse(selectedFile.source.locator), [parentId, presentations[0].seq, 0])
  assert.deepEqual(singleSubmission.submissions[0].artifactIds, [selectedFile.id])
  const changedSubmit = { ...submit, paths: ['second.md'] }
  assert.equal((await rpc.workbench('task.submit', changedSubmit, { status: 400 })).code, 'INVALID')
  assert.deepEqual(await rpc.workbench('task.get', { taskId: fresh.task.id }), singleSubmission)
  const returnOwnerSubmission = { taskId: fresh.task.id, expectedRevision: singleSubmission.task.revision,
    submissionId: singleSubmission.task.currentSubmissionId, verdict: 'return', reason: 'Re-present after return',
    requestId: 'owner-return' }
  const ownerReturned = await rpc.workbench('task.decide', returnOwnerSubmission)
  await stop()
  rpc = await start()
  assert.deepEqual(await rpc.workbench('task.decide', returnOwnerSubmission), ownerReturned)
  const reSubmit = { taskId: fresh.task.id, expectedRevision: ownerReturned.task.revision, requestId: 'owner-resubmit',
    selection: 'files', paths: ['second.md'] }
  assert.equal((await rpc.workbench('task.submit', reSubmit, { status: 400 })).code, 'INVALID')
  assert.equal((await rpc.workbench('task.submit', { taskId: reSubmit.taskId, expectedRevision: reSubmit.expectedRevision,
    requestId: 'owner-resubmit-latest', selection: 'latest-presentation' }, { status: 400 })).code, 'INVALID')
  assert.deepEqual(await rpc.workbench('task.get', { taskId: fresh.task.id }), ownerReturned)
  ownerPresentationFiles.push('second.md')
  await rpc.workbench('task.prompt', { taskId: fresh.task.id, expectedRevision: ownerReturned.task.revision,
    requestId: 'owner-presentation-after-return', text: submitMarker })
  const freshPresentation = await until(async () => {
    const state = await rpc('session/state', { sessionId: parentId })
    if (state.running || state.queue?.length !== 0) return
    const page = await rpc('session/events', { address: { kind: 'session', sessionId: parentId }, maxMessages: 30 })
    return page.records.map(record => record.event).find(event =>
      event.type === 'deliverables/presented' && event.seq > presentations[1].seq)
  }, 'fresh presentation after return')
  const ownerResubmitted = await rpc.workbench('task.submit', reSubmit)
  assert.equal(ownerResubmitted.submissions.length, 2)
  assert.deepEqual(JSON.parse(ownerResubmitted.artifacts.at(-1).source.locator), [parentId, freshPresentation.seq, 0])
  const approve = { taskId: fresh.task.id, expectedRevision: ownerResubmitted.task.revision,
    submissionId: ownerResubmitted.task.currentSubmissionId, verdict: 'accept', reason: null,
    confirmedCriteria: ['facts'] }
  const decisions = await Promise.all(['owner-approve-a', 'owner-approve-b'].map(requestId =>
    rpc.workbench('task.decide', { ...approve, requestId }, { status: [200, 409] })))
  assert.equal(decisions.filter(item => item.code === 'REVISION_CONFLICT').length, 1)
  const oneDecision = decisions.find(item => item.task?.status === 'accepted')
  assert.ok(oneDecision)
  assert.equal(oneDecision.task.revision, ownerResubmitted.task.revision + 1)
  assert.deepEqual(oneDecision.decisions.map(decision => decision.verdict), ['return', 'accept'])
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

  const damaged = join(root, 'damaged')
  await cp(backup, damaged, { recursive: true })
  const damagedFile = join(damaged, 'storages', 'workbench_tasks', 'tasks', `${draft.task.id}.json`)
  const damagedBytes = '{"version":'
  await writeFile(damagedFile, damagedBytes)
  rpc = await start({}, { dataHome: damaged })
  await rpc.workbench('task.create', brief, { status: 405 })
  const damagedPage = await rpc.page('/workbench')
  assert.doesNotMatch(await damagedPage.text(), /<title>DeepSeek 工作台<\/title>/)
  assert.equal(await readFile(damagedFile, 'utf8'), damagedBytes)
  assert.deepEqual((await rpc('session/list', {})).items.map(item => item.sessionId).sort(), sessionIds)
  await stop()

  // Exercise material references from an earlier task record through the real command.
  const archive = join(root, 'archived-context')
  await cp(backup, archive, { recursive: true })
  const archivedTaskFile = join(archive, 'storages', 'workbench_tasks', 'tasks', `${taskId}.json`)
  const archived = JSON.parse(await readFile(archivedTaskFile, 'utf8'))
  const { choices } = archived.record.stages.find(stage => stage.runId === resumed.task.activeRunId)
  assert.deepEqual(choices.slice(0, 2).map(entry => entry.choice), [suggested.task.choice, overridden.task.choice])
  const archivedMessages = [
    conversation.messages.find(item => item.role === 'user' && item.text === marker),
    conversation.messages.find(item => item.role === 'assistant' && item.text === 'done'),
  ]
  const observedAt = brief.materials[0].observedAt
  const archivedSources = archivedMessages.map(item =>
    ({ kind: 'session-event', locator: JSON.stringify([sessionId, item.seq]), observedAt }))
  const unrelatedSource = { ...archivedSources[0], locator: JSON.stringify([randomUUID(), archivedMessages[0].seq]) }
  const otherTaskSource = { ...archivedSources[0], locator: JSON.stringify([parentId, parentMessage.seq]) }
  const toolSource = { ...archivedSources[0], locator: JSON.stringify([sessionId, samples[0].toolResultSeq]) }
  const [, presentationSeq] = JSON.parse(submitted.artifacts[0].source.locator)
  const presentationAsMessage = { ...archivedSources[0], locator: JSON.stringify([sessionId, presentationSeq]) }
  const nonMessageSources = [toolSource, presentationAsMessage]
  archived.record.detail.task.materials.push(...archivedSources, unrelatedSource, otherTaskSource, ...nonMessageSources)
  const archivedBytes = JSON.stringify(archived)
  await writeFile(archivedTaskFile, archivedBytes)
  rpc = await start({}, { dataHome: archive })
  assert.equal(fresh.task.workspaceId, archived.record.detail.task.workspaceId)
  const otherTaskConversation = await rpc.workbench('task.conversation', { taskId: fresh.task.id, limit: 50 })
  assert.equal(otherTaskConversation.sessionId, parentId)
  assert.deepEqual(otherTaskConversation.messages.find(item => item.seq === parentMessage.seq), parentMessage)
  const archivedContext = await rpc.workbench('task.context.index', { taskId })
  assert.deepEqual(archivedContext.sources.filter(entry => entry.origins.includes('brief') &&
    entry.source.kind === 'session-event' && !nonMessageSources.some(item => item.locator === entry.source.locator))
    .map(entry => entry.source), archivedSources)
  for (const [index, archivedSource] of archivedSources.entries()) {
    assert.deepEqual((await rpc.workbench('task.context.load', { taskId, source: archivedSource })).content,
      { kind: 'message', role: archivedMessages[index].role, text: archivedMessages[index].text })
  }
  await rpc.workbench('task.context.load', { taskId, source: unrelatedSource }, { status: 404 })
  await rpc.workbench('task.context.load', { taskId, source: otherTaskSource }, { status: 404 })
  for (const rejected of nonMessageSources) {
    await rpc.workbench('task.context.load', { taskId, source: rejected }, { status: 404 })
  }
  const changedDate = new Date(Date.parse(observedAt) + 1000).toISOString()
  await rpc.workbench('task.context.load', { taskId, source: { ...archivedSources[0], observedAt: changedDate } }, { status: 404 })
  assert.equal(allModelRequests, beforeRollback)
  assert.equal(await readFile(archivedTaskFile, 'utf8'), archivedBytes)
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
  assert.equal((await rpc.workbench('task.submit', changedSubmit, { status: 400 })).code, 'INVALID')
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
  const latePath = join(root, 'late-native-create')
  rpc = await start({ WORKBENCH_TEST_LATE_NATIVE_CREATE: latePath }, { dataHome: restored })
  const pending = await rpc.workbench('task.get', { taskId: interrupted.task.id })
  assert.equal(pending.task.status, 'blocked')
  assert.equal(pending.task.revision, interruptedReady.task.revision + 1)
  assert.deepEqual(pending.runs, [])
  assert.deepEqual(await rpc.workbench('task.start', interruptedStart), pending)
  assert.deepEqual((await rpc('session/list', {})).items.map(item => item.sessionId).sort(), sessionIds)

  const discard = { taskId: pending.task.id, requestId: 'discard',
    expectedRevision: pending.task.revision, action: 'discard-intent', rootSessionId: null }
  const reset = await rpc.workbench('task.reconcile', discard)
  assert.equal(reset.task.status, 'ready')
  assert.deepEqual(await rpc.workbench('task.reconcile', discard), reset)
  assert.equal((await rpc.workbench('task.reconcile', { ...discard, action: 'attach', rootSessionId: pendingNative.sessionId },
    { status: 400 })).code, 'INVALID')
  const retry = { taskId: reset.task.id, requestId: 'explicit-retry', expectedRevision: reset.task.revision }
  const started = await rpc.workbench('task.start', retry)
  assert.equal(started.task.status, 'active')
  assert.notEqual(started.runs[0].rootSessionId, pendingNative.sessionId)
  assert.deepEqual(await rpc.workbench('task.start', retry), started)
  assert.equal((await rpc('session/list', {})).items.length, sessionIds.length + 1)
  assert.equal(allModelRequests, beforeRollback)
  async function readyTask(requestId) {
    const draftTask = await rpc.workbench('task.create', { ...brief, requestId })
    return rpc.workbench('task.ready', { taskId: draftTask.task.id, requestId: 'ready', expectedRevision: 0 })
  }
  const lateReady = await readyTask('late-native-result')
  const unrelatedReady = await readyTask('start-during-native-timeout')
  const lateStart = { taskId: lateReady.task.id, requestId: 'start', expectedRevision: lateReady.task.revision }
  const unrelatedStart = { taskId: unrelatedReady.task.id, requestId: 'start', expectedRevision: unrelatedReady.task.revision }
  const priorSessions = (await rpc('session/list', {})).items.map(item => item.sessionId)
  await writeFile(`${latePath}.arm`, '')
  assert.equal((await rpc.workbench('task.start', lateStart, { status: 409, timeout: 20_000 })).code, 'RECONCILIATION_REQUIRED')
  const lateBlocked = await rpc.workbench('task.get', { taskId: lateStart.taskId })
  assert.equal(lateBlocked.task.status, 'blocked')
  assert.equal(lateBlocked.task.revision, lateReady.task.revision + 1)
  assert.deepEqual(lateBlocked.runs, [])
  assert.deepEqual(await rpc.workbench('task.start', lateStart), lateBlocked)
  assert.equal((await rpc.workbench('task.reconcile', { taskId: lateStart.taskId, requestId: 'discard',
    expectedRevision: lateBlocked.task.revision, action: 'discard-intent', rootSessionId: null },
    { status: 409 })).code, 'RECONCILIATION_REQUIRED')
  const unrelated = await rpc.workbench('task.start', unrelatedStart)
  assert.equal(unrelated.task.status, 'active')

  await writeFile(`${latePath}.release`, '')
  const { sessionId: lateSession } = await until(async () => {
    try { return JSON.parse(await readFile(`${latePath}.result`, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }, 'late native create result')
  const verifyLate = { taskId: lateStart.taskId, requestId: 'verify-late', expectedRevision: lateBlocked.task.revision,
    action: 'attach', rootSessionId: lateSession }
  assert.equal((await rpc.workbench('task.reconcile', verifyLate, { status: 409 })).code, 'RECONCILIATION_REQUIRED')
  assert.deepEqual(await rpc.workbench('task.get', { taskId: lateStart.taskId }), lateBlocked)
  await stop()
  rpc = await start({}, { dataHome: restored })
  assert.deepEqual(await rpc.workbench('task.start', lateStart), lateBlocked)
  assert.equal((await rpc.workbench('task.reconcile', verifyLate, { status: 409 })).code, 'RECONCILIATION_REQUIRED')
  assert.deepEqual(await rpc.workbench('task.reconcile', attach), attached)
  assert.deepEqual(await rpc.workbench('task.reconcile', discard), reset)
  assert.equal((await rpc.workbench('task.reconcile', { ...attach, action: 'discard-intent', rootSessionId: null },
    { status: 400 })).code, 'INVALID')
  const sessionIdsAfterTimeout = (await rpc('session/list', {})).items.map(item => item.sessionId)
  assert.deepEqual(sessionIdsAfterTimeout.sort(), [...priorSessions, unrelated.runs[0].rootSessionId, lateSession].sort())
  assert.equal(allModelRequests, beforeRollback)
  if (selectedProbes.includes('reconcile-receipt')) {
    const beforeReplayedReview = allModelRequests
    const reviewTaskState = await rpc.workbench('task.get', { taskId: fresh.task.id })
    const replayedReview = await rpc.workbench('task.review.reconcile', reconcile, { status: [200, 400, 409] })
    expectReviewRecovery('Identical review reconciliation replays after restart', replayedReview, recovered)
    const alteredReview = await rpc.workbench('task.review.reconcile', { ...reconcile, reviewId: review.reviewId },
      { status: [200, 400, 409] })
    const alteredRevision = await rpc.workbench('task.review.reconcile', { ...reconcile,
      expectedRevision: reconcile.expectedRevision + 1 }, { status: [200, 400, 409] })
    expectReviewRecovery('A reused reconcile request ID rejects another review ID and another revision',
      [alteredReview.code, alteredRevision.code], ['INVALID', 'INVALID'])
    expectReviewRecovery('Review receipt replay performs no model calls', allModelRequests, beforeReplayedReview)
    expectReviewRecovery('Review receipt replay leaves task state unchanged',
      await rpc.workbench('task.get', { taskId: fresh.task.id }), reviewTaskState)
  }
  if (selectedProbes.includes('cold-root')) {
    const coldTaskId = unrelated.task.id
    const coldRootId = unrelated.runs[0].rootSessionId
    const coldRoot = await rpc('session/state', { sessionId: coldRootId })
    assert.equal(coldRoot.active, false, 'the native root must be cold after restarting the Host')
    const beforeColdCalls = allModelRequests
    const beforeColdDetail = await rpc.workbench('task.get', { taskId: coldTaskId })
    const coldResults = []
    for (const requestId of ['cold-review-a', 'cold-review-b']) {
      const current = await rpc.workbench('task.get', { taskId: coldTaskId })
      const result = await rpc.workbench('task.delegate', { taskId: coldTaskId, requestId,
        expectedRevision: current.task.revision, instruction: 'Check the brief', material: 'Cold review fixture' },
        { status: [200, 409] })
      coldResults.push(result.code ?? result.status)
    }
    const afterCold = await rpc.workbench('task.get', { taskId: coldTaskId })
    const storedReviews = (await rpc.workbench('task.reviews', { taskId: coldTaskId })).items
    expectReviewRecovery('Cold root rejects before reserving a review or spending its allowance',
      { outcomes: coldResults, revision: afterCold.task.revision, reviews: storedReviews.length,
        addedCalls: allModelRequests - beforeColdCalls },
      { outcomes: ['INVALID_TRANSITION', 'INVALID_TRANSITION'], revision: beforeColdDetail.task.revision, reviews: 0, addedCalls: 0 })
    await rpc.workbench('task.prompt', { taskId: coldTaskId, requestId: 'activate-cold-root',
      expectedRevision: afterCold.task.revision, text: 'Owner activates the root before review' })
    await until(async () => {
      const native = await rpc('session/state', { sessionId: coldRootId })
      return native.active && !native.running && native.queue?.length === 0
    }, 'owner activation of the cold root')
    const restoredOutcomes = []
    for (const requestId of ['review-after-activation-a', 'review-after-activation-b']) {
      const current = await rpc.workbench('task.get', { taskId: coldTaskId })
      const result = await rpc.workbench('task.delegate', { taskId: coldTaskId, requestId,
        expectedRevision: current.task.revision, instruction: 'Check the brief', material: 'Cold review fixture' },
        { status: [200, 409] })
      restoredOutcomes.push(result.status ?? result.code)
    }
    expectReviewRecovery('The owner retains both review attempts after activating the cold root',
      restoredOutcomes, ['completed', 'completed'])
  }
  if (selectedProbes.length) {
    if (reviewFailures.length) throw new AggregateError(reviewFailures, 'DEV-011 review recovery regressions')
    console.log(`PASS: DEV-011 review recovery probes (${selectedProbes.join(', ')}).`)
  }
  console.log('PASS: native authorization, skill reuse and owner override, task context, delivery, evidence rejection, concurrent submission and acceptance, cold replay, startup crash and late receipt, isolated review, corrupt-record protection, and profile restore.')
} finally {
  releaseForged()
  releaseQueueHold()
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(root, { recursive: true, force: true })
}
