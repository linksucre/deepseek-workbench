import { safeContextLink } from './context-link.mjs'

const $ = id => document.getElementById(id)
const workspace = $('workspace')
const taskForm = $('task-form')
const taskDialog = $('task-dialog')
const workdirDialog = $('workdir-dialog')
const detail = $('detail')
const tasks = new Map()
const retries = new Map()
let cursor = null
let selected = null
let editing = null
let busy = false
let workspaceLoadPending = false
let selectionVersion = 0

const statusLabel = {
  draft: '草稿', ready: '就绪', active: '执行中', review: '待验收',
  accepted: '已验收', paused: '已暂停', blocked: '待核对', cancelled: '已取消',
}
const templateText = {
  development: ['修改后的代码\n验证结果', '实现预期行为\n运行相关测试'],
  design: ['可预览设计\n关键状态说明', '覆盖主要使用场景\n检查响应式与关键状态'],
  writing: ['可编辑正文', '符合目标受众与语气\n核查关键事实'],
  documents: ['可编辑材料\n来源清单', '核对关键事实和数据\n标注来源及缺失信息'],
}
const domains = {
  development: '代码开发', design: '设计', writing: '写作', research: '调研', documents: '材料',
}
const methods = {
  direct: '直接执行', 'direction-review': '先审方向', 'verify-first': '先查证', reuse: '复用已有流程',
}

function node(tag, text, className) {
  const item = document.createElement(tag)
  if (text !== undefined) item.textContent = text
  if (className) item.className = className
  return item
}

function button(label, action, className) {
  const control = node('button', label, className)
  control.type = 'button'
  control.addEventListener('click', action)
  return control
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options })
  const json = response.headers.get('content-type')?.includes('application/json')
  const data = json ? await response.json() : null
  if (!response.ok) {
    const message = response.status === 401 ? '请先在 Harness 登录，再刷新工作台。'
      : response.status === 403 ? '需要从当前 Harness 登录地址打开工作台。'
      : data?.error?.message ?? `请求失败（${response.status}）`
    throw Object.assign(new Error(message), { code: data?.error?.code })
  }
  return data
}
const post = (path, body) => request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const command = async (operation, input) => (await post('/workbench/v2/command', { operation, input })).result

async function mutate(operation, input) {
  const key = JSON.stringify([operation, input])
  if (!retries.has(key)) retries.set(key, crypto.randomUUID())
  const result = await command(operation, { ...input, requestId: retries.get(key) })
  retries.delete(key)
  return result
}

function feedback(message, error = false) {
  const element = $('feedback')
  element.textContent = message
  element.hidden = !message
  element.toggleAttribute('data-error', error)
}

async function perform(action, errorSink = message => feedback(message, true)) {
  if (busy) return
  busy = true
  document.body.setAttribute('aria-busy', 'true')
  try {
    await action()
  } catch (error) {
    if (workspaceLoadPending) return
    errorSink(error.message)
    if (error.code === 'REVISION_CONFLICT' && selected) {
      try { await loadTask(selected.task.id) } catch { /* preserve the original error */ }
    }
  } finally {
    busy = false
    if (workspaceLoadPending) void perform(loadWorkspaceTasks)
    else document.body.removeAttribute('aria-busy')
  }
}

async function loadWorkspaces(preferred) {
  const spaces = await request('/workbench/v2/workspaces')
  const scope = workspaceLoadPending ? workspace.value : preferred
  workspace.replaceChildren(...spaces.map(space => {
    const option = node('option', space.title)
    option.value = space.id
    option.title = space.path
    return option
  }))
  if (spaces.some(space => space.id === scope)) workspace.value = scope
  $('new').disabled = spaces.length === 0
  clearTaskView()
  if (spaces.length === 0) {
    workspaceLoadPending = false
    detail.replaceChildren(mainTitle('添加工作区'), node('p', '选择一个本机目录，任务和代理会话会归到该工作区。'),
      button('添加工作区', () => workdirDialog.showModal(), 'primary'))
    return
  }
  await loadWorkspaceTasks()
}

function renderList() {
  const elements = [...tasks.values()].map(task => {
    const item = button(task.title, () => perform(() => loadTask(task.id)))
    item.append(node('span', statusLabel[task.status], 'subtle'))
    if (selected?.task.id === task.id) item.setAttribute('aria-current', 'true')
    return item
  })
  $('tasks').replaceChildren(...elements)
  $('more').hidden = !cursor
}

function clearTaskView() {
  tasks.clear()
  selected = null
  cursor = null
  renderList()
  detail.replaceChildren(mainTitle('正在读取任务'))
  feedback('')
}

async function loadWorkspaceTasks() {
  workspaceLoadPending = false
  try {
    await loadList()
  } catch (error) {
    if (workspaceLoadPending) return
    detail.replaceChildren(mainTitle('无法读取任务列表'), button('重试', () => {
      clearTaskView()
      void perform(loadWorkspaceTasks)
    }))
    throw error
  }
}

async function loadList({ selectFirst = true, append = false } = {}) {
  const scope = workspace.value
  const page = await command('task.list', { workspaceId: scope, limit: 50, cursor: append ? cursor : null })
  if (workspaceLoadPending || scope !== workspace.value) return
  if (!append) tasks.clear()
  for (const task of page.items) tasks.set(task.id, task)
  cursor = page.nextCursor
  if (selectFirst) {
    const first = tasks.keys().next().value
    if (first) return loadTask(first)
    selected = null
    detail.replaceChildren(mainTitle('还没有任务'), node('p', '从一个明确的交付目标开始。'),
      button('新建任务', () => openTaskForm(), 'primary'))
  }
  renderList()
}

async function loadTask(id) {
  const version = ++selectionVersion
  const value = await command('task.get', { taskId: id })
  if (workspaceLoadPending || version !== selectionVersion || value.task.workspaceId !== workspace.value) return
  selected = value
  renderDetail()
  renderList()
}

function mainTitle(text) {
  const heading = node('h1', text)
  heading.id = 'title'
  return heading
}

function section(title, ...content) {
  const area = node('section', undefined, 'section')
  area.append(node('h2', title), ...content)
  return area
}

function list(values) {
  const items = node('ul')
  items.append(...values.map(value => node('li', value)))
  return items
}

function taskAction(operation, payload = {}) {
  return perform(async () => {
    const task = selected.task
    const updated = await mutate(operation, { taskId: task.id, expectedRevision: task.revision, ...payload })
    if (workspaceLoadPending) return
    selected = updated
    feedback('已更新任务')
    renderDetail()
    await loadList({ selectFirst: false })
  })
}

function renderDetail() {
  const { task, runs, artifacts, submissions, decisions } = selected
  const head = node('div', undefined, 'detail-head')
  head.append(mainTitle(task.title), node('span', statusLabel[task.status], 'state'))
  const brief = node('div', undefined, 'split')
  const deliverables = node('div')
  deliverables.append(node('strong', '交付物'), list(task.deliverables))
  const criteria = node('div')
  criteria.append(node('strong', '验收条件'), list(task.criteria.map(item => item.description)))
  brief.append(deliverables, criteria)
  const run = runs.find(item => item.id === task.activeRunId) ?? runs.at(-1)
  const actions = node('div', undefined, 'actions')
  actions.append(button('刷新任务', () => perform(() => loadTask(task.id))))
  if (['draft', 'ready'].includes(task.status)) actions.append(button('编辑任务', () => openTaskForm(task)))
  if (task.status === 'draft') actions.append(button('标为就绪', () => taskAction('task.ready'), 'primary'))
  if (task.status === 'ready') actions.append(button('启动 Agent 会话', () => taskAction('task.start'), 'primary'))
  if (task.status === 'active') {
    actions.append(button('提交最新展示', () => taskAction('task.submit', { selection: 'latest-presentation' })),
      button('暂停任务', () => taskAction('task.pause')))
  }
  if (task.status === 'paused') actions.append(button('恢复任务', () => taskAction('task.resume'), 'primary'))
  if (['draft', 'ready', 'active', 'paused', 'review'].includes(task.status)) {
    actions.append(button('取消任务', () => taskAction('task.cancel')))
  }
  if (run?.rootSessionId) {
    const jump = node('a', '查看执行会话')
    jump.href = '#execution-session'
    actions.append(jump)
  }
  detail.replaceChildren(head, node('p', task.goal, 'goal'), actions, section('任务要求', brief))
  if (task.choice) detail.append(choiceSummary(task.choice))
  if (['draft', 'ready', 'active', 'paused'].includes(task.status)) detail.append(choiceEditor(task))
  if (run?.rootSessionId) {
    const link = node('a', '返回 Harness')
    link.href = '/'
    link.target = '_blank'
    link.rel = 'noopener'
    const copy = button('复制会话 ID', () => perform(async () => {
      await navigator.clipboard.writeText(run.rootSessionId)
      feedback('已复制会话 ID')
    }))
    const metadata = node('div', undefined, 'actions')
    metadata.append(node('code', run.rootSessionId), copy, link)
    detail.append(conversationPanel(task, metadata), reviewPanel(task))
  }
  if (task.status === 'blocked') detail.append(recoveryEditor())
  detail.append(contextPanel(task, artifacts), usagePanel(task.id))
  for (const submission of [...submissions].reverse()) {
    const current = submission.id === task.currentSubmissionId
    const area = section(current ? '当前提交' : '历史提交')
    const files = artifacts.filter(item => submission.artifactIds.includes(item.id))
    for (const file of files) {
      const row = node('div', undefined, 'file-row')
      row.append(node('strong', file.locator.split(/[\\/]/).at(-1)), node('span', file.locator, 'path'),
        node('code', `${file.versionKind} ${file.version ?? ''}`))
      area.append(row)
    }
    const decision = decisions.find(item => item.submissionId === submission.id)
    if (decision) area.append(node('p', decision.verdict === 'accept' ? '已验收' : `退回原因：${decision.reason}`))
    area.append(evidencePanel(submission, decision))
    if (current && task.status === 'review') area.append(reviewEditor(submission))
    detail.append(area)
  }
}

const evidenceKinds = {
  machine: '机器检查', user: '用户确认', 'model-claim': '模型自述', unverified: '未验证',
}
const evidenceOutcomes = { pass: '通过', fail: '失败', unknown: '结果未知' }
const reportedOutcomes = { pass: '报告通过', fail: '报告失败', unknown: '结果未知' }

function evidencePanel(submission, decision) {
  const groups = new Map(submission.criteriaSnapshot.map(criterion =>
    [criterion.id, { label: criterion.description, evidence: [] }]))
  for (const item of [...submission.evidence, ...(decision?.reviewEvidence ?? [])]) {
    if (!groups.has(item.criterionId)) groups.set(item.criterionId, { label: item.criterionId, evidence: [] })
    groups.get(item.criterionId).evidence.push(item)
  }
  const pane = node('details', undefined, 'submission-evidence')
  pane.append(node('summary', '验收证据'))
  const rows = node('dl', undefined, 'evidence-criteria')
  for (const { label, evidence } of groups.values()) {
    const row = node('div')
    row.append(node('dt', label))
    for (const item of evidence) {
      const kind = item.kind === 'machine' && !item.source ? 'unverified' : item.kind
      const outcomes = kind === 'machine' || kind === 'user' ? evidenceOutcomes : reportedOutcomes
      const entry = node('dd')
      entry.append(node('strong', `${evidenceKinds[kind]} · ${outcomes[item.outcome]}`),
        node('p', item.summary, 'evidence-summary'))
      if (item.source) entry.append(node('code', item.source.locator))
      const date = node('time', item.observedAt, 'subtle')
      date.dateTime = item.observedAt
      entry.append(date)
      row.append(entry)
    }
    if (evidence.length === 0) row.append(node('dd', '未验证', 'subtle'))
    rows.append(row)
  }
  pane.append(rows)
  return pane
}

function handoffPanel(handoff) {
  const area = node('div', undefined, 'handoff')
  area.append(node('h3', '阶段交接'))
  const stage = handoff.stage ? `阶段开始于 ${new Date(handoff.stage.openedAt).toLocaleString('zh-CN')}` : '尚未开始执行阶段'
  const method = handoff.choice
    ? `执行方式：${choiceMethods(handoff.choice)}` : ''
  const latest = handoff.lastSubmission
    ? `最近提交于 ${new Date(handoff.lastSubmission.submittedAt).toLocaleString('zh-CN')}` : ''
  const outcome = handoff.lastDecision?.verdict === 'return' ? `退回原因：${handoff.lastDecision.reason}`
    : handoff.lastDecision?.verdict === 'accept' ? '最近提交已验收' : ''
  const lines = [stage, method, latest, outcome].filter(Boolean)
  for (const line of lines) area.append(node('p', line))
  if (handoff.stage) area.append(button('复制阶段交接', () => perform(async () => {
    await navigator.clipboard.writeText([handoff.title, handoff.goal, ...lines,
      '交付物', ...handoff.deliverables, '验收条件', ...handoff.criteria.map(item => item.description)].join('\n'))
    feedback('已复制阶段交接')
  })))
  return area
}

function contextPanel(task, artifacts) {
  const pane = node('details', undefined, 'task-context')
  const body = node('div')
  const state = node('p', undefined, 'subtle')
  state.setAttribute('role', 'status')
  pane.append(node('summary', '资料与阶段交接'), state, body)
  let loading = false
  let loaded = false
  let latestPreview = 0

  function renderPreview(view, preview) {
    const { content } = view
    if (content.kind === 'presentation') {
      preview.append(node('p', '提交版本'), node('code', content.version ?? '未核验版本'),
        node('p', content.locator, 'path'))
    } else if (content.kind === 'url') {
      const href = safeContextLink(content.href)
      if (!href) throw new Error('此网页地址无法安全打开。')
      const link = node('a', '打开原始网页')
      link.href = href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      preview.append(link)
    } else {
      preview.append(node('pre', content.text))
    }
  }

  async function previewSource(source, label, preview) {
    const requestId = ++latestPreview
    preview.replaceChildren()
    state.textContent = `正在读取 ${label}…`
    try {
      const view = await command('task.context.load', { taskId: task.id, source })
      if (!pane.isConnected || requestId !== latestPreview) return
      renderPreview(view, preview)
      state.textContent = ''
    } catch (error) {
      if (pane.isConnected && requestId === latestPreview) {
        state.textContent = error.code === 'NOT_FOUND' ? '此来源已不可预览，请刷新任务核对资料。' : error.message
      }
    }
  }

  async function load() {
    if (loading || loaded) return
    loading = true
    state.textContent = '正在读取资料目录…'
    try {
      const value = await command('task.context.index', { taskId: task.id })
      if (!pane.isConnected) return
      const sources = node('ul', undefined, 'context-sources')
      const preview = node('div', undefined, 'context-preview')
      const freshness = { current: '近期记录', stale: '可能过期', unknown: '日期待核对' }
      for (const entry of value.sources) {
        const { source, origins } = entry
        const submitted = artifacts.find(item => item.source.locator === source.locator &&
          item.source.observedAt === source.observedAt && item.source.kind === source.kind)
        const label = submitted?.locator.split(/[\\/]/).at(-1) ??
          (source.kind === 'session-event' ? '会话记录' : source.locator)
        const item = node('li')
        item.append(button(`预览 ${label}`, () => previewSource(source, label, preview)),
          node('span', `${origins.map(origin => origin === 'brief' ? '任务资料' : '已提交').join('、')} · ${source.observedAt.slice(0, 10)} · ${freshness[entry.freshness]}`, 'subtle'))
        sources.append(item)
      }
      body.replaceChildren(value.sources.length ? sources : node('p', '没有可读取的资料。', 'subtle'),
        preview, handoffPanel(value.handoff))
      state.textContent = ''
      loaded = true
    } catch (error) {
      if (pane.isConnected) {
        state.textContent = error.message
        body.replaceChildren(button('重新读取资料', load))
      }
    } finally {
      loading = false
    }
  }
  pane.addEventListener('toggle', () => { if (pane.open) void load() })
  return section('任务资料', pane)
}

const countFormat = new Intl.NumberFormat('zh-CN')
const coverageLabels = { complete: '用量完整', partial: '部分用量缺报', unknown: '用量未知' }

function usagePanel(taskId) {
  const pane = node('details')
  const summary = node('summary', 'Token 与费用')
  const content = node('div', undefined, 'usage-content')
  content.setAttribute('aria-live', 'polite')
  pane.append(summary, content)
  let sequence = 0
  async function load() {
    const current = ++sequence
    content.replaceChildren(node('p', '正在读取用量…', 'subtle'))
    try {
      const value = await command('task.usage', { taskId })
      if (current !== sequence || !pane.isConnected) return
      const cost = value.estimatedCost
      content.replaceChildren(node('strong', coverageLabels[value.completeness]), node('p', cost
        ? `估算费用：${cost.currency} ${cost.decimalAmount}（费率日期 ${cost.rateDate}）`
        : '暂无可核验费用估算。计数缺报或未配置匹配费率时，金额保留为空。'))
      if (value.softBudget) {
        const { currency, decimalAmount, comparison } = value.softBudget
        const message = { reached: '已达到提醒金额', within: '低于提醒金额', unknown: '尚无法比较' }
        content.append(node('p', `预算提醒：${currency} ${decimalAmount} · ${message[comparison]}`,
          comparison === 'reached' ? 'budget-warning' : 'subtle'))
      }
      if (value.coverageNotes.length) content.append(list(value.coverageNotes.map(coverageNote)))
      for (const bucket of value.buckets) {
        const model = node('article', undefined, 'usage-model')
        model.append(node('h3', `${bucket.model} · ${bucket.provider}`))
        const fields = node('dl', undefined, 'usage-fields')
        for (const [key, label] of Object.entries({
          uncachedInput: '未缓存输入', cacheRead: '缓存读取', cacheWrite: '缓存写入', output: '输出',
        })) {
          const cell = node('div')
          cell.append(node('dt', label), node('dd', bucket[key] === null ? '未报告' : countFormat.format(bucket[key])))
          fields.append(cell)
        }
        model.append(fields)
        content.append(model)
      }
      content.append(button('刷新用量', load))
    } catch (error) {
      if (current === sequence && pane.isConnected) content.replaceChildren(node('p', error.message), button('重试', load))
    }
  }
  pane.addEventListener('toggle', () => { if (pane.open && !content.hasChildNodes()) void load() })
  return section('用量', pane)
}

function coverageNote(note) {
  if (/^\d+ bound or expected session/.test(note)) return `${note.split(' ')[0]} 个关联会话的用量无法核验。`
  if (/^\d+ attempt.*missing or ambiguous/.test(note)) return `${note.split(' ')[0]} 次模型尝试缺少可核验计数，仅汇总可得字段。`
  if (/^\d+ attempt.*no verified provider/.test(note)) return `${note.split(' ')[0]} 次模型尝试无法确认提供方和模型。`
  return note
}

function reviewPanel(task) {
  const history = node('div', undefined, 'conversation-history')
  history.setAttribute('aria-live', 'polite')
  const area = section('独立审阅', history)
  const change = (operation, payload, success) => perform(async () => {
    await mutate(operation, { taskId: task.id, expectedRevision: task.revision, ...payload })
    if (!area.isConnected) return
    feedback(success)
    if (selected?.task.id === task.id) await loadTask(task.id)
  })
  const forwardKey = reviewId => `workbench:review-forward:${task.id}:${reviewId}`
  const pendingForward = reviewId => sessionStorage.getItem(forwardKey(reviewId))

  function forwardReview(reviewId) {
    return perform(async () => {
      const key = forwardKey(reviewId)
      const input = JSON.parse(pendingForward(reviewId) ?? 'null') ?? {
        taskId: task.id, reviewId, expectedRevision: task.revision, requestId: crypto.randomUUID(),
      }
      sessionStorage.setItem(key, JSON.stringify(input))
      try {
        await command('task.review.forward', input)
      } catch (error) {
        if (['INVALID', 'REVISION_CONFLICT', 'INVALID_TRANSITION'].includes(error.code)) sessionStorage.removeItem(key)
        if (error.code === 'INVALID_TRANSITION' && !workspaceLoadPending && selected?.task.id === task.id) {
          try { await loadTask(task.id) } catch { /* preserve the original error */ }
        }
        throw error
      }
      sessionStorage.removeItem(key)
      feedback('已发给主 Agent')
      if (selected?.task.id === task.id) await loadTask(task.id)
    })
  }

  async function refresh() {
    try {
      const { items } = await command('task.reviews', { taskId: task.id })
      const statuses = { reserved: '待核对或仍在执行', completed: '已完成', incomplete: '未完成' }
      const rows = [...items].reverse().map(review => {
        const row = node('article', undefined, 'message')
        row.append(node('strong', review.instruction), node('p', statuses[review.status], 'subtle'))
        if (review.summary) row.append(node('p', review.summary))
        if (review.status === 'reserved') row.append(button('核对审阅', () =>
          change('task.review.reconcile', { reviewId: review.reviewId }, '已核对审阅')))
        const awaitingForward = pendingForward(review.reviewId)
        if (review.status === 'completed' && review.summary &&
            (awaitingForward || (task.status === 'active' && task.activeRunId === review.runId))) {
          row.append(button(awaitingForward ? '核对回送' : '把审阅发给主 Agent',
            () => forwardReview(review.reviewId)))
        }
        return row
      })
      history.replaceChildren(...(rows.length ? rows : [node('p', '还没有审阅', 'subtle')]))
    } catch (error) {
      history.textContent = error.message
    }
  }
  if (task.status === 'active') {
    const form = node('form', undefined, 'prompt-form')
    function field(label, rows, maxLength) {
      const name = node('label', label, 'field')
      const input = node('textarea')
      input.required = true
      input.rows = rows
      input.maxLength = maxLength
      name.append(input)
      form.append(name)
      return input
    }
    const instruction = field('需要审阅的问题', 2, 2048)
    const material = field('选中材料（问题和材料合计最多 24 KiB）', 4, 24576)
    const submit = node('button', '发起审阅', 'primary')
    submit.type = 'submit'
    form.append(submit)
    form.addEventListener('submit', event => {
      event.preventDefault()
      const question = instruction.value.trim()
      const selectedMaterial = material.value.trim()
      if (!question || !selectedMaterial ||
          new TextEncoder().encode(question + selectedMaterial).length > 24 * 1024) {
        feedback('请填写问题和材料，合计最多 24 KiB。', true)
        return
      }
      void change('task.delegate', { instruction: question, material: selectedMaterial }, '已记录审阅状态')
    })
    area.append(form)
  }
  void refresh()
  return area
}

function conversationPanel(task, metadata) {
  const history = node('div', undefined, 'conversation-history')
  history.setAttribute('aria-live', 'polite')
  const state = node('p', '正在读取会话', 'subtle')
  const area = section('执行会话', metadata, state, history)
  area.id = 'execution-session'
  area.tabIndex = -1
  area.firstElementChild.id = 'execution-session-title'
  area.setAttribute('aria-labelledby', 'execution-session-title')
  let seq = 0
  let polling
  async function refresh(tries = 0) {
    if (!area.isConnected) return
    clearTimeout(polling)
    const latest = ++seq
    try {
      const view = await command('task.conversation', { taskId: task.id, limit: 30 })
      if (latest !== seq || !area.isConnected) return
      state.textContent = view.pendingInput.length ? 'Agent 在 Harness 中等待你的输入'
        : view.running ? 'Agent 正在执行' : '会话空闲'
      const messages = view.messages.map(message => {
        const item = node('article', undefined, 'message')
        item.append(node('strong', message.role === 'user' ? '你' : 'Agent'), node('p', message.text))
        return item
      })
      history.replaceChildren(...(messages.length ? messages : [node('p', '还没有对话', 'subtle')]))
      if ((view.running || tries > 0) && !view.pendingInput.length) {
        polling = setTimeout(() => { void refresh(Math.max(tries - 1, 0)) }, 1800)
      }
    } catch (error) {
      if (latest === seq && area.isConnected) state.textContent = error.message
    }
  }
  area.append(button('刷新对话', () => refresh()))
  if (task.status === 'active') {
    const form = node('form', undefined, 'prompt-form')
    const field = node('label', '发给 Agent', 'field')
    const text = node('textarea')
    text.name = 'message'
    text.rows = 3
    text.maxLength = 60000
    text.required = true
    field.append(text)
    const actions = node('div', undefined, 'actions')
    actions.append(button('填入任务说明', () => {
      text.value = [
        task.title, task.goal, `交付物：${task.deliverables.join('；')}`,
        `验收条件：${task.criteria.map(criterion => criterion.description).join('；')}`,
        ...(task.materials.length ? [`材料：${task.materials.map(item => item.locator).join('；')}`] : []),
        ...(task.choice ? [
          `执行方式（${choiceSource(task.choice)}）：${choiceMethods(task.choice)}`,
          `任务类型：${domains[task.choice.domain] ?? task.choice.domain}`,
          `依据：${task.choice.reason}`,
          ...(task.choice.skillIds.length ? [`技能 ID：${task.choice.skillIds.join('；')}`] : []),
        ] : ['请先选择做法。']),
        '交付时使用 present 和 workbench_submit。',
      ].join('\n')
      text.focus()
    }))
    const send = node('button', '发送', 'primary')
    send.type = 'submit'
    actions.append(send)
    form.append(field, actions)
    form.addEventListener('submit', event => {
      event.preventDefault()
      void perform(async () => {
        await mutate('task.prompt', { taskId: task.id, expectedRevision: task.revision, text: text.value.trim() })
        if (!area.isConnected) return
        text.value = ''
        feedback('已发给 Agent')
        await refresh(8)
      })
    })
    area.append(form)
  }
  queueMicrotask(() => { void refresh() })
  return area
}

function choiceMethods(choice) {
  return choice.methods.map(key => methods[key] ?? key).join('、')
}

function choiceSource(choice) {
  return choice.source === 'user' ? '用户选定' : 'Agent 建议'
}

function choiceSummary(choice) {
  const area = section('当前执行方式', node('strong', choiceMethods(choice)),
    node('p', `${domains[choice.domain] ?? choice.domain} · ${choiceSource(choice)}`, 'subtle'),
    node('p', choice.reason, 'choice-text'))
  if (choice.skillIds.length) area.append(node('p', `技能 ID：${choice.skillIds.join('、')}`, 'choice-text'))
  area.firstElementChild.id = 'execution-choice-title'
  area.setAttribute('aria-labelledby', 'execution-choice-title')
  return area
}

function choiceEditor(task) {
  const form = node('form', undefined, 'choice-form')
  const domainField = node('label', '任务类型', 'field')
  const domain = node('select')
  domain.required = true
  const placeholder = node('option', '请选择任务类型')
  placeholder.value = ''
  placeholder.disabled = true
  domain.append(placeholder)
  for (const [value, label] of Object.entries(domains)) {
    const option = node('option', label)
    option.value = value
    domain.append(option)
  }
  domain.value = task.choice?.domain ?? ''
  domainField.append(domain)

  const selectedMethods = new Set(task.choice?.methods ?? [])
  const options = node('fieldset', undefined, 'choice-options')
  options.append(node('legend', '执行方式'))
  const save = node('button', '保存执行方式')
  save.disabled = selectedMethods.size === 0
  for (const [value, label] of Object.entries(methods)) {
    const field = node('label', label)
    const checkbox = node('input')
    checkbox.type = 'checkbox'
    checkbox.checked = selectedMethods.has(value)
    field.prepend(checkbox)
    options.append(field)
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedMethods.add(value)
      else selectedMethods.delete(value)
      save.disabled = selectedMethods.size === 0
    })
  }

  const reasonField = node('label', '改选理由', 'field')
  const reason = node('textarea')
  reason.required = true
  reason.rows = 2
  reason.maxLength = 8192
  reason.addEventListener('input', () => reason.setCustomValidity(''))
  reasonField.append(reason)
  const skillsField = node('label', '技能 ID（每行一个，可选）', 'field')
  const skills = node('textarea')
  skills.rows = 2
  skills.value = task.choice?.skillIds.join('\n') ?? ''
  skillsField.append(skills)

  const actions = node('div', undefined, 'actions')
  actions.append(save)
  form.append(domainField, options, reasonField, skillsField, actions)
  form.addEventListener('submit', event => {
    event.preventDefault()
    const reasonText = reason.value.trim()
    if (!reasonText) {
      reason.setCustomValidity('请填写改选理由。')
      reason.reportValidity()
      return
    }
    void taskAction('task.choose', { choice: {
      domain: domain.value, methods: [...selectedMethods], source: 'user',
      reason: reasonText, skillIds: lines(skills.value),
    } })
  })
  return section('选择做法', form)
}

function recoveryEditor() {
  const form = node('form', undefined, 'actions')
  const id = node('input')
  id.setAttribute('aria-label', '要核对的会话 ID')
  id.placeholder = '原会话 ID'
  id.required = true
  form.append(id, node('button', '核对并挂载'), button('结束启动意图', () =>
    taskAction('task.reconcile', { action: 'discard-intent', rootSessionId: null })))
  form.addEventListener('submit', event => {
    event.preventDefault()
    void taskAction('task.reconcile', { action: 'attach', rootSessionId: id.value.trim() })
  })
  return section('会话待核对', node('p', '核对已创建的会话，或结束本次启动意图。'), form)
}

function reviewEditor(submission) {
  const area = node('div')
  const fieldset = node('fieldset')
  fieldset.append(node('legend', '逐项确认'))
  const machine = submission.evidence.filter(item => item.kind === 'machine' && item.source)
  const failed = new Set(machine.filter(item => item.outcome === 'fail').map(item => item.criterionId))
  const passed = new Set(machine.filter(item => item.outcome === 'pass').map(item => item.criterionId))
  const checks = submission.criteriaSnapshot.filter(item => !failed.has(item.id) && !passed.has(item.id)).map(item => {
    const label = node('label', item.description)
    const check = node('input')
    check.type = 'checkbox'
    check.value = item.id
    label.prepend(check)
    fieldset.append(label)
    return check
  })
  const approve = button('接受提交', () => taskAction('task.decide', {
    submissionId: submission.id, verdict: 'accept', reason: null,
    confirmedCriteria: checks.filter(input => input.checked).map(input => input.value),
  }), 'primary')
  function updateApproval() {
    approve.disabled = failed.size > 0 || checks.some(input => !input.checked)
  }
  updateApproval()
  for (const check of checks) check.addEventListener('change', updateApproval)
  const form = node('form', undefined, 'actions')
  const reason = node('input')
  reason.setAttribute('aria-label', '退回理由')
  reason.placeholder = '退回理由'
  reason.required = true
  form.append(approve, reason, node('button', '退回修改'))
  if (checks.length) area.append(fieldset)
  if (failed.size) area.append(node('p', '机器检查失败，请退回并重新提交。'))
  area.append(form)
  form.addEventListener('submit', event => {
    event.preventDefault()
    void taskAction('task.decide', { submissionId: submission.id, verdict: 'return', reason: reason.value.trim() })
  })
  return area
}

function fillTemplate() {
  const [deliverables, criteria] = templateText[$('template').value]
  taskForm.elements.deliverables.value = deliverables
  taskForm.elements.criteria.value = criteria
}

function openTaskForm(task) {
  editing = task ?? null
  taskForm.reset()
  taskForm.querySelector('.form-error').textContent = ''
  $('form-title').textContent = task ? '编辑任务' : '新建任务'
  $('template-field').hidden = Boolean(task)
  if (task) {
    taskForm.elements.title.value = task.title
    taskForm.elements.goal.value = task.goal
    taskForm.elements.materials.value = [...new Set(task.materials.filter(editableMaterial)
      .map(item => item.locator))].join('\n')
    taskForm.elements.deliverables.value = task.deliverables.join('\n')
    taskForm.elements.criteria.value = task.criteria.map(item => item.description).join('\n')
  } else {
    fillTemplate()
  }
  taskDialog.showModal()
}
const lines = value => value.split('\n').map(item => item.trim()).filter(Boolean)
function editableMaterial(source) {
  return source.kind !== 'session-event' && !/[\r\n]/u.test(source.locator)
}

function materialEntries(text, existing = []) {
  const locators = new Set(text.split(/\r?\n/u).filter(locator => locator.length > 0))
  const entries = existing.filter(item => !editableMaterial(item) || locators.has(item.locator))
  const known = new Set(existing.filter(editableMaterial).map(item => item.locator))
  const observedAt = new Date().toISOString()
  for (const locator of locators) {
    if (known.has(locator) || !locator.trim()) continue
    const kind = /^https?:\/\//iu.test(locator.trimStart()) ? 'url' : 'file'
    if (kind === 'url' && !safeContextLink(locator)) {
      throw new Error('请输入不含空格或登录信息的 HTTP 或 HTTPS 地址。')
    }
    if (locator.length > 8192) throw new Error('单条资料的位置最多 8192 字符。')
    entries.push({ kind, locator, observedAt })
  }
  return entries
}

taskForm.addEventListener('submit', event => {
  event.preventDefault()
  const values = new FormData(taskForm)
  const fields = {
    title: values.get('title').trim(), goal: values.get('goal').trim(),
    deliverables: lines(values.get('deliverables')),
    criteria: lines(values.get('criteria')).map((description, index) => ({ id: `criterion-${index + 1}`, description })),
  }
  const showError = message => { taskForm.querySelector('.form-error').textContent = message }
  try {
    fields.materials = materialEntries(values.get('materials'), editing?.materials)
  } catch (error) {
    showError(error.message)
    return
  }
  if (!fields.title || !fields.goal || !fields.deliverables.length || !fields.criteria.length) {
    showError('请填写标题、目标、交付物和验收条件。')
    return
  }
  void perform(async () => {
    const updated = editing
      ? await mutate('task.updateBrief', { taskId: editing.id, expectedRevision: editing.revision, ...fields })
      : await mutate('task.create', { workspaceId: workspace.value, ...fields })
    taskDialog.close()
    if (workspaceLoadPending) return
    selected = updated
    renderDetail()
    await loadList({ selectFirst: false })
    if (!workspaceLoadPending) feedback('已保存任务')
  }, showError)
})

$('workdir-form').addEventListener('submit', event => {
  event.preventDefault()
  const form = event.currentTarget
  const path = new FormData(form).get('path').trim()
  void perform(async () => {
    const envelope = await post('/api/workspace/create', {
      type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/create', payload: { args: { request: { path } } },
    })
    if (!envelope.result.ok) throw new Error(envelope.result.error.message)
    workdirDialog.close()
    await loadWorkspaces(envelope.result.value.workspace.workspaceId)
  }, message => { form.querySelector('.form-error').textContent = message })
})
for (const control of document.querySelectorAll('[data-close]')) {
  control.addEventListener('click', () => control.closest('dialog').close())
}
$('template').addEventListener('change', fillTemplate)
$('register').addEventListener('click', () => workdirDialog.showModal())
$('new').addEventListener('click', () => openTaskForm())
$('more').addEventListener('click', () => perform(() => loadList({ selectFirst: false, append: true })))
workspace.addEventListener('change', () => {
  workspaceLoadPending = true
  clearTaskView()
  void perform(loadWorkspaceTasks)
})
void perform(() => loadWorkspaces())
