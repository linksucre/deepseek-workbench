import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const upstream = resolve(process.argv[2] ?? '.')
const requireHost = createRequire(join(upstream, 'apps/web/package.json'))
const { chromium } = requireHost('playwright')
const home = await mkdtemp(join(tmpdir(), 'workbench-browser-'))
const workspace = join(home, 'workspace')
const overlay = join(home, 'workbench.yml')
const usagePolicy = join(home, 'usage-policy.json')
const evidencePolicy = join(home, 'evidence-policy.json')
const checkedTitle = 'browser checked artifact'
const checkedRevision = 'browser checked revision'
const suggestionPrompt = 'browser execution suggestion'
const suggestionReason = '先核对输入再决定怎么修改'
const overrideReason = '沿用已验证的开发流程'
const recoveryTitle = 'browser recover root session'
const attempts = new Map()
let independentReviewRequests = 0
let modelRequests = 0
let suggested = false

const provider = createServer(async (request, response) => {
  modelRequests += 1
  try {
    const parts = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
    const serialized = JSON.stringify(body.messages)
    const independentReview = serialized.includes('browser isolated review material')
    if (independentReview) {
      assert.deepEqual(body.tools ?? [], [])
      assert.doesNotMatch(serialized, /browser review task/)
      independentReviewRequests += 1
    }
    const flow = [checkedRevision, checkedTitle, 'browser material revision', 'browser material task', 'browser code task']
      .find(marker => serialized.includes(marker))
    const modeled = flow && body.tools?.some(tool => tool.name === 'present')
    const step = modeled ? (attempts.get(flow) ?? 0) + 1 : 0
    if (step) attempts.set(flow, step)
    const suggest = !suggested && serialized.includes(suggestionPrompt) &&
      body.tools?.some(tool => tool.name === 'workbench_suggest')
    if (suggest) suggested = true
    const tool = suggest ? 'workbench_suggest' : step === 1 ? 'present' : step === 2 ? 'workbench_submit' : null
    const filename = flow === checkedRevision || flow === checkedTitle ? 'report.json'
      : flow === 'browser code task' ? 'code.md' : 'materials.md'
    const args = suggest ? { domain: 'development', methods: ['verify-first'], reason: suggestionReason, skillIds: [] }
      : tool === 'present' ? { files: [{ path: filename }] } : { selection: 'latest-presentation' }
    const completeUsage = flow === 'browser code task' || serialized.includes(suggestionPrompt)
    const events = [{
      type: 'message_start',
      message: { id: randomUUID(), model: 'mock-model', usage: { input_tokens: 8, output_tokens: 0, ...(completeUsage && { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) } },
    }]
    if (tool) {
      events.push(
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: randomUUID(), name: tool, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
      )
    } else {
      events.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: independentReview ? '审阅结论文本' : '交付已准备好' } })
    }
    events.push(
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } },
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
let browser
let log = ''
const errors = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function safeOutput() {
  return log.replace(/dsh web: .+/g, 'dsh web: [private URL]')
}
async function start({ failAttach = false } = {}) {
  log = ''
  const env = { ...process.env, DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, 'agents'),
    DEEPSEEK_API_KEY: 'browser-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}` }
  delete env.WORKBENCH_TEST_FAIL_ATTACH
  delete env.WORKBENCH_TEST_HOLD_NATIVE_CREATE
  delete env.WORKBENCH_TEST_LATE_NATIVE_CREATE
  delete env.WORKBENCH_TEST_REVIEW_RECEIPT_FAULT
  if (failAttach) env.WORKBENCH_TEST_FAIL_ATTACH = '1'
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', overlay,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: upstream, env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  closed = once(child, 'close')
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data.toString() })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && child.exitCode === null) {
    const launch = /dsh web: (http:\/\/[^\s]+)/.exec(log)?.[1]
    if (launch) return launch
    await pause(100)
  }
  throw new Error(`Workbench browser Host did not start\n${safeOutput()}`)
}
async function stop() {
  if (!child) return
  child.kill()
  await closed
  child = undefined
}

try {
  await mkdir(workspace)
  await writeFile(join(workspace, 'code.md'), 'Code change and checks')
  await writeFile(join(workspace, 'materials.md'), 'Initial version')
  const briefText = '<handoff>先核对材料，再形成报告。</handoff>'
  await writeFile(join(workspace, 'brief.md'), briefText)
  await writeFile(join(workspace, ' report.md '), '保留文件名空格')
  await writeFile(join(workspace, 'report.json'), '{broken')
  await writeFile(evidencePolicy, JSON.stringify([{
    workspace: await realpath(workspace), taskTitle: checkedTitle, criterionId: 'criterion-1',
    description: 'JSON 格式有效', check: 'json', path: 'report.json',
  }]))
  await writeFile(usagePolicy, JSON.stringify({
    rates: [{ provider: 'deepseek-official', model: 'deepseek-flash', currency: 'CNY', rateDate: '2020-01-01',
      perMillion: { uncachedInput: '1', cacheRead: '0.2', cacheWrite: '1', output: '2' } }],
    softBudget: { currency: 'CNY', decimalAmount: '0.000001' },
  }))
  execFileSync(process.execPath, [
    process.env.WORKBENCH_OVERLAY_GENERATOR ??
      fileURLToPath(new URL('../../scripts/source-overlay.mjs', import.meta.url)), upstream, overlay, usagePolicy, '--evidence-policy', evidencePolicy,
  ])
  const recoveryFixture = new URL('./fixtures/workbench-host.mjs', import.meta.url).href
  await writeFile(overlay, `\n- insert:\n    - id: workbench-test-host\n      name: ${JSON.stringify(recoveryFixture)}\n`, { flag: 'a' })
  browser = await chromium.launch({
    ...(process.env.WORKBENCH_CHROME_PATH ? { executablePath: process.env.WORKBENCH_CHROME_PATH } : {}),
  })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const contextReads = []
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().endsWith('/workbench/v1/command')) return
    const { operation } = request.postDataJSON()
    if (operation.startsWith('task.context.')) contextReads.push(operation)
  })
  page.setDefaultTimeout(15_000)
  async function openWorkbench(launch) {
    const url = new URL(launch)
    try { await page.goto(launch) } catch { throw new Error('Harness browser authentication failed') }
    await page.goto(`${url.origin}/workbench`)
    await page.getByRole('button', { name: '添加工作区', exact: true }).first().waitFor()
  }
  const button = name => page.getByRole('button', { name, exact: true })
  const currentChoice = page.getByRole('region', { name: '当前执行方式' })
  const conversation = page.getByRole('region', { name: '执行会话' })
  const composer = page.getByLabel('发给 Agent')
  const taskState = page.locator('.state')
  const readyButton = button('启动 Agent 会话')
  const attachButton = button('核对并挂载')
  const sessionIdField = page.getByLabel('要核对的会话 ID')
  const taskButton = title => page.getByRole('navigation', { name: '任务列表' }).getByRole('button', { name: title, exact: false })
  await openWorkbench(await start({ failAttach: true }))
  async function tabTo(target) {
    await target.waitFor()
    for (let step = 0; step < 50; step++) {
      if (await target.evaluate(element => element === document.activeElement)) return
      await page.keyboard.press('Tab')
    }
    assert.fail(`Keyboard could not reach ${await target.innerText()}`)
  }
  async function activate(target, key = 'Enter') {
    await tabTo(target)
    await page.keyboard.press(key)
  }
  await activate(button('添加工作区').first())
  const directory = page.getByLabel('本机目录的绝对路径')
  await directory.waitFor()
  assert.equal(await directory.evaluate(element => element === document.activeElement), true)
  await page.keyboard.insertText(workspace)
  await activate(button('添加'))
  await page.getByRole('heading', { name: '还没有任务' }).waitFor()

  const newTask = button('新建任务').first()
  await activate(newTask)
  await page.getByRole('dialog').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(await newTask.evaluate(element => element === document.activeElement), true)

  const goalStart = '材料检索与核验\n<review>'
  const goalEnd = '</review>'
  const longGoal = goalStart + 'x'.repeat(8192 - goalStart.length - goalEnd.length) + goalEnd
  const templateDefaults = {
    development: { deliverables: '修改后的代码\n验证结果', criteria: '实现预期行为\n运行相关测试' },
    design: { deliverables: '可预览设计\n关键状态说明', criteria: '覆盖主要使用场景\n检查响应式与关键状态' },
    writing: { deliverables: '可编辑正文', criteria: '符合目标受众与语气\n核查关键事实' },
    documents: { deliverables: '可编辑材料\n来源清单', criteria: '核对关键事实和数据\n标注来源及缺失信息' },
  }
  const deliverableField = page.getByLabel(/交付物.*每行一项/)
  const criterionField = page.getByLabel(/验收条件.*每行一项/)
  async function choose(domain, labels, reason, skill = '') {
    const taskType = page.getByLabel('任务类型')
    await taskType.waitFor()
    await page.locator('body:not([aria-busy])').waitFor()
    await taskType.selectOption(domain)
    const choices = page.getByRole('group', { name: '执行方式' })
    for (const checkbox of await choices.getByRole('checkbox').all()) {
      const label = await checkbox.evaluate(element => element.labels[0].textContent)
      if (await checkbox.isChecked() !== labels.includes(label)) await activate(checkbox, 'Space')
    }
    const reasonField = page.getByLabel('改选理由')
    await reasonField.fill('  ')
    await activate(button('保存执行方式'))
    assert.equal(await reasonField.evaluate(element => element.validationMessage), '请填写改选理由。')
    await reasonField.fill(reason)
    await page.getByLabel(/技能 ID（每行一个/).fill(skill)
    await activate(button('保存执行方式'))
    await currentChoice.getByText(reason, { exact: true }).waitFor()
    await page.locator('body:not([aria-busy])').waitFor()
  }
  async function createDraft(title, template, { goal, criteria, deliverables, materials } = {}) {
    await activate(newTask)
    await page.getByLabel('模板').selectOption(template)
    assert.equal(await deliverableField.inputValue(), templateDefaults[template].deliverables)
    assert.equal(await criterionField.inputValue(), templateDefaults[template].criteria)
    await tabTo(page.getByLabel('标题'))
    await page.keyboard.insertText(title)
    await tabTo(page.getByLabel('目标'))
    await page.keyboard.insertText(goal ?? '交付并核查该工作')
    if (criteria) await criterionField.fill(criteria)
    if (deliverables) await deliverableField.fill(deliverables)
    if (materials) await page.getByLabel(/资料来源/).fill(materials)
    const onSave = operation => page.waitForResponse(response =>
      response.url().endsWith('/workbench/v1/command') && response.request().method() === 'POST' &&
      response.request().postDataJSON().operation === operation)
    const created = materials ? onSave('task.create') : null
    await activate(button('保存任务'))
    await page.getByRole('heading', { name: title }).waitFor()
    await page.locator('body:not([aria-busy])').waitFor()
    if (created) {
      const original = (await (await created).json()).result.task.materials
      await activate(button('编辑任务'))
      const input = page.getByLabel(/资料来源/)
      assert.equal(await input.inputValue(), materials)
      await input.fill(`${materials}\nhttps://example.test/path part`)
      await activate(button('保存任务'))
      await page.getByRole('alert').filter({ hasText: '请输入不含空格或登录信息' }).waitFor()
      await input.fill(materials)
      const edited = onSave('task.updateBrief')
      await activate(button('保存任务'))
      assert.deepEqual((await (await edited).json()).result.task.materials, original)
      await page.locator('body:not([aria-busy])').waitFor()
    }
  }
  async function createReady(title, template, fields) {
    await createDraft(title, template, fields)
    await activate(button('标为就绪'))
    await readyButton.waitFor()
    await page.locator('body:not([aria-busy])').waitFor()
  }
  async function create(title, template, { goal = '交付并核查该工作', criteria, materials, afterStart } = {}) {
    await createReady(title, template, { goal, criteria, materials })
    await activate(readyButton)
    await conversation.waitFor()
    if (afterStart) await afterStart()
    await activate(page.getByRole('link', { name: '查看执行会话' }))
    assert.equal(await conversation.evaluate(element => element === document.activeElement), true)
    await activate(button('填入任务说明'))
    const prompt = page.getByLabel('发给 Agent')
    assert.equal(await prompt.evaluate(element => element === document.activeElement), true)
    const draftPrompt = await prompt.inputValue()
    assert.ok(draftPrompt.includes(goal))
    if (afterStart) {
      assert.match(draftPrompt, /用户选定.*直接执行、复用已有流程/)
      assert.match(draftPrompt, /任务类型：代码开发/)
      assert.match(draftPrompt, /技能 ID：fixture-check/)
    }
    await activate(button('发送'))
  }
  async function waitReview() {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await button('接受提交').isVisible()) return
      await button('刷新任务').click()
      await pause(300)
    }
    throw new Error(`Submission did not reach review\n${await page.locator('main').innerText()}`)
  }
  async function accept() {
    assert.equal(await button('接受提交').isDisabled(), true)
    for (const checkbox of await page.getByRole('checkbox').all()) {
      await activate(checkbox, 'Space')
      assert.equal(await checkbox.isChecked(), true)
    }
    await activate(button('接受提交'))
  }
  async function nativeSessionIds() {
    const response = await page.request.post(new URL('/api/session/list', page.url()).href, { data: {
      type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } },
    } })
    assert.equal(response.status(), 200)
    const { result } = await response.json()
    assert.equal(result.ok, true, JSON.stringify(result.error))
    return result.value.items.map(item => item.sessionId)
  }
  async function waitTaskState(label) {
    await taskState.getByText(label, { exact: true }).waitFor()
    await page.locator('body:not([aria-busy])').waitFor()
  }
  async function checkCancelled(rootSessionId) {
    await waitTaskState('已取消')
    await taskButton(recoveryTitle).getByText('已取消', { exact: true }).waitFor()
    await conversation.getByText(rootSessionId, { exact: true }).waitFor()
    assert.equal(await composer.isVisible(), false)
    for (const label of ['启动 Agent 会话', '暂停任务', '恢复任务', '提交最新展示', '取消任务']) {
      assert.equal(await button(label).isVisible(), false, label)
    }
  }

  const designTitle = 'browser design template'
  const writingTitle = 'browser writing template'
  await createDraft(designTitle, 'design', { deliverables: '线框稿\n交互说明' })
  await createDraft(writingTitle, 'writing', { criteria: '对照编辑规范\n核查引用来源' })
  await createReady(recoveryTitle, 'development')
  await activate(readyButton)
  await page.getByRole('heading', { name: '会话待核对' }).waitFor()
  await page.locator('body:not([aria-busy])').waitFor()
  const orphaned = await nativeSessionIds()
  assert.equal(orphaned.length, 1)
  assert.equal(await conversation.isVisible(), false)
  await stop()
  await openWorkbench(await start())
  for (const [title, deliverables, criteria] of [
    [designTitle, '线框稿\n交互说明', templateDefaults.design.criteria],
    [writingTitle, templateDefaults.writing.deliverables, '对照编辑规范\n核查引用来源'],
  ]) {
    await activate(taskButton(title))
    await page.getByRole('heading', { name: title }).waitFor()
    await activate(button('编辑任务'))
    assert.equal(await page.getByLabel('模板').isVisible(), false)
    assert.equal(await deliverableField.inputValue(), deliverables)
    assert.equal(await criterionField.inputValue(), criteria)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
  }
  await activate(taskButton(recoveryTitle))
  await sessionIdField.fill(randomUUID())
  await activate(attachButton)
  await page.getByRole('status').filter({ hasText: 'Native startup requires verification' }).waitFor()
  assert.equal(await conversation.isVisible(), false)
  await sessionIdField.fill(orphaned[0])
  await activate(attachButton)
  await conversation.getByText(orphaned[0], { exact: true }).waitFor()
  await waitTaskState('执行中')
  assert.deepEqual(await nativeSessionIds(), orphaned)
  assert.equal(modelRequests, 0)

  await activate(button('暂停任务'))
  await waitTaskState('已暂停')
  await conversation.getByText(orphaned[0], { exact: true }).waitFor()
  assert.equal(await composer.isVisible(), false)
  await activate(button('恢复任务'))
  await waitTaskState('执行中')
  await conversation.getByText(orphaned[0], { exact: true }).waitFor()
  await composer.waitFor()
  await activate(button('取消任务'))
  await checkCancelled(orphaned[0])
  await activate(button('刷新任务'))
  await checkCancelled(orphaned[0])
  assert.deepEqual(await nativeSessionIds(), orphaned)
  assert.equal(modelRequests, 0)

  await create('browser code task', 'development', {
    afterStart: async () => {
      await page.getByLabel('发给 Agent').fill(suggestionPrompt)
      await activate(button('发送'))
      await page.getByText('交付已准备好', { exact: true }).waitFor()
      await activate(button('刷新任务'))
      await currentChoice.getByText('代码开发 · Agent 建议', { exact: true }).waitFor()
      await currentChoice.getByText(suggestionReason, { exact: true }).waitFor()
      assert.equal(await page.getByRole('checkbox', { name: '先查证' }).isChecked(), true)
      const adjustedViewport = page.viewportSize()
      await page.setViewportSize({ width: 390, height: 844 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
      await choose('development', ['直接执行', '复用已有流程'], overrideReason, 'fixture-check')
      assert.equal(await page.getByRole('checkbox', { name: '先查证' }).isChecked(), false)
      await page.setViewportSize(adjustedViewport)
    },
  })
  await waitReview()
  await page.locator('main').getByText('code.md', { exact: true }).waitFor()
  const evidence = page.locator('.submission-evidence')
  await activate(evidence.locator('summary'))
  await evidence.getByText('未验证', { exact: true }).first().waitFor()
  await accept()
  await page.locator('.state').getByText('已验收', { exact: true }).waitFor()

  await activate(evidence.locator('summary'))
  await evidence.getByText('用户确认 · 通过', { exact: true }).first().waitFor()

  // This response fixture exercises contract variants the current Host does not emit.
  const commandRoute = '**/workbench/v1/command'
  await page.route(commandRoute, async route => {
    if (route.request().postDataJSON()?.operation !== 'task.get') return route.continue()
    const response = await route.fetch()
    const json = await response.json()
    const submission = json.result.submissions.at(-1)
    const base = { criterionId: submission.criteriaSnapshot[0].id, observedAt: submission.submittedAt }
    const source = { kind: 'session-event', locator: '["root",5]', observedAt: base.observedAt }
    submission.evidence.push(
      { ...base, kind: 'machine', outcome: 'fail', source, summary: '退出码 1' },
      { ...base, kind: 'model-claim', outcome: 'pass', source: null, summary: '<review>已通过</review>' },
      { ...base, kind: 'unverified', outcome: 'unknown', source: null, summary: '等待佐证' },
    )
    await route.fulfill({ response, json })
  })
  await button('刷新任务').click()
  await page.waitForFunction(() => document.querySelector('.submission-evidence')?.open === false)
  await activate(evidence.locator('summary'))
  await evidence.getByText('机器检查 · 失败', { exact: true }).waitFor()
  await evidence.getByText('模型自述 · 报告通过', { exact: true }).waitFor()
  await evidence.getByText('未验证 · 结果未知', { exact: true }).waitFor()
  await evidence.getByText('<review>已通过</review>', { exact: true }).waitFor()
  assert.equal(await evidence.locator('review').count(), 0)
  await evidence.getByText('["root",5]', { exact: true }).waitFor()
  const desktop = page.viewportSize()
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await page.setViewportSize(desktop)
  await page.unroute(commandRoute)

  await page.getByText('Token 与费用', { exact: true }).click()
  await page.getByText(/预算提醒.*已达到提醒金额/).waitFor()
  await page.getByText(/估算费用：CNY 0\./).waitFor()

  const referenceUrl = 'https://example.test/path%20part'
  await create('browser material task', 'documents', { goal: longGoal, materials: `brief.md\n report.md \n${referenceUrl}` })
  await waitReview()
  assert.deepEqual(contextReads, [])
  const library = page.locator('.task-context')
  await activate(library.locator('summary'))
  await button('预览 brief.md').waitFor()
  assert.deepEqual(contextReads, ['task.context.index'])
  await page.getByRole('button', { name: /预览\s+report\.md/ }).waitFor()
  await activate(button('预览 brief.md'))
  const preview = library.locator('.context-preview')
  await preview.getByText(briefText, { exact: true }).waitFor()
  assert.equal(await preview.locator('handoff').count(), 0)
  await button(`预览 ${referenceUrl}`).click()
  assert.equal(await preview.getByRole('link', { name: '打开原始网页' }).getAttribute('href'), referenceUrl)
  await button('预览 materials.md').click()
  await preview.getByText('提交版本', { exact: true }).waitFor()
  const recordedVersion = await preview.locator('code').innerText()
  assert.match(recordedVersion, /^[a-f0-9]{64}$/)
  await writeFile(join(workspace, 'materials.md'), 'Updated version')
  await stop()
  await openWorkbench(await start())
  await activate(taskButton(recoveryTitle))
  await checkCancelled(orphaned[0])
  await activate(page.getByRole('button', { name: /browser code task/ }))
  await currentChoice.getByText('代码开发 · 用户选定', { exact: true }).waitFor()
  await currentChoice.getByText(overrideReason, { exact: true }).waitFor()
  await currentChoice.getByText('技能 ID：fixture-check', { exact: true }).waitFor()
  await activate(page.getByRole('button', { name: /browser material task/ }))
  await waitReview()
  await activate(library.locator('summary'))
  await button('预览 materials.md').click()
  await preview.getByText(recordedVersion, { exact: true }).waitFor()
  await accept()
  await page.locator('#feedback[data-error]').waitFor()
  const feedback = page.getByRole('status').filter({ hasText: /artifact .*changed/i })
  assert.equal(await feedback.getAttribute('aria-live'), 'polite')
  const longText = page.locator('.goal')
  assert.equal(await longText.textContent(), longGoal)
  assert.equal(await longText.locator('review').count(), 0)
  await page.getByLabel('退回理由').fill('请重新展示修改后的版本')
  await activate(button('退回修改'))
  await page.locator('.state').getByText('执行中', { exact: true }).waitFor()
  await activate(library.locator('summary'))
  await library.getByText('退回原因：请重新展示修改后的版本', { exact: true }).waitFor()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
  await activate(library.getByRole('button', { name: '复制阶段交接' }))
  await page.getByRole('status').filter({ hasText: '已复制阶段交接' }).waitFor()
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /退回原因：请重新展示修改后的版本/)
  await choose('research', ['先审方向', '先查证'], '退回后先确认方向和资料来源')
  await activate(library.locator('summary'))
  await library.getByText('执行方式：先审方向、先查证', { exact: true }).waitFor()
  await activate(button('预览 brief.md'))
  await preview.getByText(briefText, { exact: true }).waitFor()
  await activate(button('填入任务说明'))
  const materialPrompt = page.getByLabel('发给 Agent')
  assert.match(await materialPrompt.inputValue(), /用户选定.*先审方向、先查证/)
  await materialPrompt.fill('browser material revision')
  await button('发送').click()
  await waitReview()
  await accept()
  await page.locator('.state').getByText('已验收', { exact: true }).waitFor()
  await page.getByText('Token 与费用', { exact: true }).click()
  await page.getByText('部分用量缺报', { exact: true }).waitFor()
  await page.getByText(/预算提醒.*尚无法比较/).waitFor()
  await create('browser review task', 'documents')
  await page.getByLabel('需要审阅的问题').fill('核对材料是否完整')
  await page.getByLabel(/选中材料/).fill('browser isolated review material')
  await button('发起审阅').click()
  await page.getByText('审阅结论文本', { exact: true }).waitFor()
  assert.equal(independentReviewRequests, 1)
  await button('把审阅发给主 Agent').click()
  await page.getByText('已发给主 Agent', { exact: true }).waitFor()
  assert.equal(independentReviewRequests, 1)

  await create(checkedTitle, 'development', { goal: '交付 JSON', criteria: 'JSON 格式有效\n与任务主题相符' })
  await waitReview()
  const currentEvidence = page.locator('.submission-evidence').first()
  await currentEvidence.locator('summary').click()
  await currentEvidence.getByText('机器检查 · 失败', { exact: true }).waitFor()
  const manual = page.getByRole('checkbox', { name: '与任务主题相符' })
  await manual.check()
  assert.equal(await button('接受提交').isDisabled(), true)
  await writeFile(join(workspace, 'report.json'), '{"ready":true}')
  await page.getByLabel('退回理由').fill('请重新提交有效的 JSON')
  await button('退回修改').click()
  await page.getByLabel('发给 Agent').fill(checkedRevision)
  await button('发送').click()
  await waitReview()
  await currentEvidence.locator('summary').click()
  await currentEvidence.getByText('机器检查 · 通过', { exact: true }).waitFor()
  assert.equal(await page.getByRole('checkbox', { name: 'JSON 格式有效' }).count(), 0)
  const decisionRequest = page.waitForRequest(request => request.url().endsWith('/workbench/v1/command') &&
    request.method() === 'POST' && request.postDataJSON().operation === 'task.decide')
  await accept()
  assert.deepEqual((await decisionRequest).postDataJSON().input.confirmedCriteria, ['criterion-2'])
  await page.locator('.state').getByText('已验收', { exact: true }).waitFor()
  await stop()
  await openWorkbench(await start({ failAttach: true }))
  await page.getByRole('button', { name: /browser checked artifact/ }).click()
  await currentEvidence.locator('summary').click()
  await page.locator('.submission-evidence').last().locator('summary').click()
  await currentEvidence.getByText('机器检查 · 通过', { exact: true }).waitFor()
  await currentEvidence.getByText('用户确认 · 通过', { exact: true }).waitFor()
  await page.locator('.submission-evidence').last().getByText('机器检查 · 失败', { exact: true }).waitFor()

  const beforeDiscard = await nativeSessionIds()
  const beforeDiscardRequests = modelRequests
  await createReady('browser discard start intent', 'writing')
  await activate(readyButton)
  await sessionIdField.waitFor()
  await page.locator('body:not([aria-busy])').waitFor()
  const withOrphan = await nativeSessionIds()
  assert.equal(withOrphan.length, beforeDiscard.length + 1)
  assert.ok(beforeDiscard.every(id => withOrphan.includes(id)))
  await activate(button('结束启动意图'))
  await readyButton.waitFor()
  await page.locator('body:not([aria-busy])').waitFor()
  assert.equal(await sessionIdField.isVisible(), false)
  assert.equal(await conversation.isVisible(), false)
  assert.deepEqual((await nativeSessionIds()).sort(), withOrphan.sort())
  await activate(readyButton)
  await conversation.waitFor()
  const afterRestart = await nativeSessionIds()
  const replacements = afterRestart.filter(id => !withOrphan.includes(id))
  assert.equal(replacements.length, 1)
  assert.equal(afterRestart.length, withOrphan.length + 1)
  await conversation.getByText(replacements[0], { exact: true }).waitFor()
  assert.equal(modelRequests, beforeDiscardRequests)

  const workspaceSelect = page.getByLabel('工作区', { exact: true })
  const originalScope = await workspaceSelect.inputValue()
  async function addWorkspace(name, title) {
    const path = join(home, name)
    await mkdir(path)
    await activate(button('添加工作区'))
    await directory.fill(path)
    await activate(button('添加'))
    await page.getByRole('heading', { name: '还没有任务' }).waitFor()
    await page.locator('body:not([aria-busy])').waitFor()
    await createDraft(title, 'development')
    return workspaceSelect.inputValue()
  }
  const delayedTitle = 'browser delayed workspace task'
  const latestTitle = 'browser latest workspace task'
  const delayedScope = await addWorkspace('delayed-workspace', delayedTitle)
  const latestScope = await addWorkspace('latest-workspace', latestTitle)
  await workspaceSelect.selectOption(originalScope)
  await taskButton('browser discard start intent').waitFor()
  await page.locator('body:not([aria-busy])').waitFor()

  const workspaceCommand = '**/workbench/v1/command'
  const { promise: listHeld, resolve: reportListHeld } = Promise.withResolvers()
  const { promise: releaseList, resolve: finishDelayedList } = Promise.withResolvers()
  async function holdWorkspaceList(route) {
    const { operation, input } = route.request().postDataJSON() ?? {}
    if (operation !== 'task.list' || input.workspaceId !== delayedScope) return route.continue()
    const response = await route.fetch()
    reportListHeld()
    await releaseList
    return route.fulfill({ response })
  }
  await page.route(workspaceCommand, holdWorkspaceList)
  try {
    await Promise.all([
      page.waitForRequest(request => request.method() === 'POST' &&
        request.url().endsWith('/workbench/v1/command') && request.postDataJSON()?.operation === 'task.list' &&
        request.postDataJSON().input.workspaceId === delayedScope),
      workspaceSelect.selectOption(delayedScope),
    ])
    await listHeld
    await workspaceSelect.selectOption(latestScope)
    assert.equal(await workspaceSelect.inputValue(), latestScope)
    const displayedOriginalWhileLoading = await taskButton('browser discard start intent').isVisible()
    finishDelayedList()
    await page.getByRole('heading', { name: latestTitle, exact: true }).waitFor()
    await taskButton(latestTitle).waitFor()
    assert.equal(displayedOriginalWhileLoading, false)
    assert.equal(await taskButton(delayedTitle).count(), 0)
    assert.equal(await taskButton('browser discard start intent').count(), 0)
  } finally {
    finishDelayedList()
    await page.unroute(workspaceCommand, holdWorkspaceList)
  }

  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  assert.deepEqual(errors, [])
  console.log('PASS: Chromium workspace switching, task templates, root-session recovery, discard, pause, resume and cancellation, development, materials and independent review flows, keyboard, session jump, long text, execution choices, drift, context preview and stage handoff, machine evidence, and mobile layout.')
} finally {
  await browser?.close()
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(home, { recursive: true, force: true })
}
