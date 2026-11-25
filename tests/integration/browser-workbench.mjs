import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
const attempts = new Map()
let independentReviewRequests = 0

const provider = createServer(async (request, response) => {
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
    const flow = ['browser material revision', 'browser material task', 'browser code task']
      .find(marker => serialized.includes(marker))
    const modeled = flow && body.tools?.some(tool => tool.name === 'present')
    const step = modeled ? (attempts.get(flow) ?? 0) + 1 : 0
    if (step) attempts.set(flow, step)
    const tool = step === 1 ? 'present' : step === 2 ? 'workbench_submit' : null
    const filename = flow === 'browser code task' ? 'code.md' : 'materials.md'
    const args = tool === 'present' ? { files: [{ path: filename }] } : { selection: 'latest-presentation' }
    const events = [{
      type: 'message_start',
      message: { id: randomUUID(), model: 'mock-model', usage: { input_tokens: 8, output_tokens: 0, ...(flow === 'browser code task' && { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) } },
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
async function start() {
  log = ''
  child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'web', '--patch', overlay,
    '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], {
    cwd: upstream, env: { ...process.env, DSH_HOME: join(home, 'dsh'), DSH_AGENTS_HOME: join(home, 'agents'),
      DEEPSEEK_API_KEY: 'browser-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${provider.address().port}` },
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
  await writeFile(usagePolicy, JSON.stringify({
    rates: [{ provider: 'deepseek-official', model: 'deepseek-flash', currency: 'CNY', rateDate: '2020-01-01',
      perMillion: { uncachedInput: '1', cacheRead: '0.2', cacheWrite: '1', output: '2' } }],
    softBudget: { currency: 'CNY', decimalAmount: '0.000001' },
  }))
  execFileSync(process.execPath, [
    process.env.WORKBENCH_OVERLAY_GENERATOR ??
      fileURLToPath(new URL('../../scripts/source-overlay.mjs', import.meta.url)), upstream, overlay, usagePolicy,
  ])
  browser = await chromium.launch({
    ...(process.env.WORKBENCH_CHROME_PATH ? { executablePath: process.env.WORKBENCH_CHROME_PATH } : {}),
  })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15_000)
  async function openWorkbench(launch) {
    const url = new URL(launch)
    try { await page.goto(launch) } catch { throw new Error('Harness browser authentication failed') }
    await page.goto(`${url.origin}/workbench`)
    await page.getByRole('button', { name: '添加工作区', exact: true }).first().waitFor()
  }
  const button = name => page.getByRole('button', { name, exact: true })
  await openWorkbench(await start())
  await button('添加工作区').first().click()
  await page.getByLabel('本机目录的绝对路径').fill(workspace)
  await button('添加').click()
  await page.getByRole('heading', { name: '还没有任务' }).waitFor()

  async function create(title, template) {
    await button('新建任务').first().click()
    await page.getByLabel('模板').selectOption(template)
    await page.getByLabel('标题').fill(title)
    await page.getByLabel('目标').fill('交付并核查该工作')
    await button('保存任务').click()
    await page.getByRole('heading', { name: title }).waitFor()
    await button('标为就绪').click()
    await button('启动 Agent 会话').click()
    await button('填入任务说明').click()
    await button('发送').click()
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
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check()
    await button('接受提交').click()
  }
  await create('browser code task', 'development')
  await waitReview()
  await page.locator('main').getByText('code.md', { exact: true }).waitFor()
  await accept()
  await page.locator('.state').getByText('已验收', { exact: true }).waitFor()

  await page.getByText('Token 与费用', { exact: true }).click()
  await page.getByText(/预算提醒.*已达到提醒金额/).waitFor()
  await page.getByText(/估算费用：CNY 0\./).waitFor()

  await create('browser material task', 'documents')
  await waitReview()
  await writeFile(join(workspace, 'materials.md'), 'Updated version')
  await stop()
  await openWorkbench(await start())
  await page.getByRole('button', { name: /browser material task/ }).click()
  await waitReview()
  await accept()
  await page.locator('#feedback[data-error]').waitFor()
  assert.match(await page.locator('#feedback').innerText(), /artifact .*changed/i)
  await page.getByLabel('退回理由').fill('请重新展示修改后的版本')
  await button('退回修改').click()
  await page.getByLabel('发给 Agent').fill('browser material revision')
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

  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  assert.deepEqual(errors, [])
  console.log('PASS: real browser development and materials flows, conversation, drift, return, acceptance, independent review and mobile layout.')
} finally {
  await browser?.close()
  await stop()
  provider.closeAllConnections()
  provider.close()
  await rm(home, { recursive: true, force: true })
}
