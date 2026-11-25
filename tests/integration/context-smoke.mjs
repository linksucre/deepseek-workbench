import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHostTaskContext } from '../../src/application/host-context.mjs'
import { createTaskContext } from '../../src/application/task-context.mjs'
import { createTaskService } from '../../src/application/task-service.mjs'
import { nativeStorageFixture } from './native-storage-fixture.mjs'

const checkout = resolve(process.argv[2] ?? '.')
const useStorage = await nativeStorageFixture(checkout)
const fsPackage = join(checkout, 'packages/fs/fs-local')
const requireHost = createRequire(join(fsPackage, 'package.json'))
const { Context } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href)
const { LocalFileSystem } = await import(pathToFileURL(join(fsPackage, 'lib/index.js')).href)
const native = new Context()
const root = await mkdtemp(join(tmpdir(), 'workbench-task-context-'))
const storage = join(root, 'store')
const now = '2026-11-25T12:00:00Z'
const owner = { kind: 'user', actorId: 'owner' }
const outside = { kind: 'user', actorId: 'outside' }
const reference = { kind: 'file', locator: 'brief.md', observedAt: '2026-09-01T00:00:00Z' }
const restricted = { kind: 'file', locator: 'restricted.md', observedAt: now }
const contents = '\uFEFFEvidence for the handoff\nSecond line'
const workspacePath = join(root, 'workspace')
const workspace = { path: workspacePath, sessionIds: [] }
const workspaceRegistry = new Map([['project', workspace]])
const fileRef = locator => ({ kind: 'file', locator, observedAt: now })
const goodLink = { kind: 'url', locator: 'https://example.invalid/source', observedAt: now }
const badLink = { ...goodLink, locator: 'https://owner:secret@example.invalid/source' }
const escaped = fileRef('../outside/private.md')
const symlinkFile = fileRef('redirect.md')
const symlinkDirectory = fileRef('redirected/private.md')
const binary = fileRef('binary.bin')
const oversized = fileRef('oversized.txt')
const messageSource = { kind: 'session-event', locator: JSON.stringify(['session-fixed-root', 1]), observedAt: now }
const longMessage = { ...messageSource, locator: JSON.stringify(['session-fixed-root', 4]) }
const messagePrefix = '甲'.repeat(8190)
const presentation = { kind: 'session-event', locator: JSON.stringify(['session-fixed-root', 2, 0]), observedAt: now }
const untrusted = { ...messageSource, locator: JSON.stringify(['session-fixed-root', 3]) }
const unrelated = { ...messageSource, locator: JSON.stringify(['unrelated', 1]) }
const binding = { id: 'session-fixed-root', isSeeded: false, cwd: workspacePath }
let leaseCount = 0
let sourceReads = 0
let afterRead
let afterObserve
const sessionQuery = {
  async observeSession(sessionId) {
    assert.equal(sessionId, binding.id)
    leaseCount += 1
    afterObserve?.()
    return { header: binding, events: [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' },
        content: [{ type: 'text', text: 'Source discussion' }, { type: 'image', data: 'private metadata' }] } },
      { seq: 2, type: 'deliverables/presented', data: { files: [{ path: 'brief.md' }] } },
      { seq: 3, type: 'tool/result', data: { secret: 'internal data' } },
      { seq: 4, type: 'assistant/message', data: { message: { content: [
        { type: 'text', text: messagePrefix }, { type: 'text', text: '🧪尾' },
      ] } } },
    ], [Symbol.dispose]() { leaseCount -= 1 } }
  },
}
let current
let snapshot
let reads = 0

function services(repository) {
  const app = createTaskService({
    repository,
    authorize: ({ principal, workspaceId }) => principal === owner && workspaceId === 'project',
    clock: () => now,
    delivery: {
      resolve: () => ({ artifacts: [{ id: 'artifact-1', kind: 'file', locator: reference.locator,
        versionKind: 'sha256', version: createHash('sha256').update(contents).digest('hex'), source: reference }], evidence: [] }),
    },
  })
  const context = createTaskContext({
    async loadTask(principal, taskId) {
      await app.get(principal, taskId)
      return repository.read(taskId)
    },
    canReadSource: ({ principal, workspaceId, source }) => principal === owner && workspaceId === 'project' &&
      source.kind === 'file' && source.locator === reference.locator,
    async readSource({ source }) {
      reads += 1
      return await readFile(join(root, source.locator), 'utf8')
    },
    clock: () => Date.parse(now),
  })
  return { app, context }
}

try {
  await mkdir(workspacePath)
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside/private.md'), 'not for the task')
  await writeFile(join(workspacePath, reference.locator), contents)
  await writeFile(join(workspacePath, binary.locator), Buffer.from([255]))
  await writeFile(join(workspacePath, oversized.locator), Buffer.alloc(65_537, 'x'))
  await symlink('../outside/private.md', join(workspacePath, symlinkFile.locator))
  await symlink('../outside', join(workspacePath, 'redirected'))
  await native.plugin(LocalFileSystem, { cwd: workspacePath })
  const readBytes = native.fs.readBytes.bind(native.fs)
  native.fs.readBytes = async (...input) => {
    sourceReads += 1
    const bytes = await readBytes(...input)
    await afterRead?.()
    return bytes
  }
  await writeFile(join(root, reference.locator), contents)
  await useStorage(storage, async repository => {
    const { app, context } = services(repository)
    current = await app.create(owner, {
      workspaceId: 'project', requestId: 'create', title: 'Brief', goal: 'Prepare a brief',
      materials: [reference, restricted], deliverables: ['brief.md'], criteria: [{ id: 'facts', description: 'Check facts' }],
    })
    const input = requestId => ({ taskId: current.task.id, expectedRevision: current.task.revision, requestId })
    current = await app.ready(owner, input('ready'))
    current = await app.reserveStart(owner, input('start'), { agentPreset: 'task-collaborator' })
    const intent = repository.read(current.task.id).pendingIntent
    current = await app.bindConfirmedRun(owner, input('bind'), {
      intentId: intent.intentId, sessionId: intent.reservedSessionId, workspaceId: intent.workspaceId,
      agentPreset: intent.agentPreset, afterSeq: 0,
    })
    current = await app.choose(owner, { ...input('choose'), choice: {
      domain: 'documents', methods: ['verify-first'], reason: 'Check older source', skillIds: [],
    } })
    current = await app.submit(owner, { ...input('submit'), selection: { selection: 'latest-presentation' } })
    current = await app.decide(owner, { ...input('return'), submissionId: current.task.currentSubmissionId,
      verdict: 'return', reason: 'Confirm the briefing date' })
    snapshot = await context.get(owner, current.task.id)
    assert.equal(snapshot.handoff.stage.runId, intent.runId)
    assert.equal(snapshot.handoff.lastDecision.reason, 'Confirm the briefing date')
    assert.deepEqual(snapshot.sources, [{ workspaceId: 'project', source: reference,
      origins: ['brief', 'submission'], freshness: 'stale' }])
    assert.equal(reads, 0)
  })
  await useStorage(storage, async repository => {
    const { context } = services(repository)
    assert.deepEqual(await context.get(owner, current.task.id), snapshot)
    assert.equal((await context.load(owner, current.task.id, reference)).content, contents)
    await assert.rejects(context.get(outside, current.task.id), { code: 'NOT_FOUND' })
    await assert.rejects(context.load(owner, current.task.id, restricted), { code: 'NOT_FOUND' })
    assert.equal(reads, 1)
  })
  let hostTaskId
  let hostSnapshot
  function hostContext(repository, app) {
    return createHostTaskContext({
      owner, repository, app, fs: native.fs, workspaceRegistry, sessionQuery, clock: () => Date.parse(now),
    })
  }
  await useStorage(storage, async repository => {
    const app = createTaskService({
      repository,
      authorize: ({ principal, workspaceId }) => principal === owner && workspaceId === 'project',
      clock: () => now,
      newId: () => 'fixed-root',
      delivery: {
        resolve: () => ({ artifacts: [{ id: 'host-artifact', kind: 'file', locator: 'brief.md',
          versionKind: 'sha256', version: createHash('sha256').update(contents).digest('hex'), source: presentation }], evidence: [] }),
      },
    })
    let task = await app.create(owner, {
      workspaceId: 'project', requestId: 'host-create', title: 'Host sources', goal: 'Review source access',
      materials: [reference, goodLink, badLink, escaped, symlinkFile, symlinkDirectory, binary, oversized,
        messageSource, unrelated, presentation, untrusted, longMessage],
      deliverables: ['brief.md'], criteria: [{ id: 'facts', description: 'Check facts' }],
    })
    hostTaskId = task.task.id
    const input = requestId => ({ taskId: hostTaskId, expectedRevision: task.task.revision, requestId })
    task = await app.ready(owner, input('host-ready'))
    task = await app.reserveStart(owner, input('host-start'), { agentPreset: 'task-collaborator' })
    const intent = repository.read(hostTaskId).pendingIntent
    assert.equal(intent.reservedSessionId, binding.id)
    task = await app.bindConfirmedRun(owner, input('host-bind'), {
      intentId: intent.intentId, sessionId: intent.reservedSessionId, workspaceId: intent.workspaceId,
      agentPreset: intent.agentPreset, afterSeq: 0,
    })
    workspace.sessionIds = [binding.id, 'unrelated']
    task = await app.submit(owner, { ...input('host-submit'), selection: { selection: 'latest-presentation' } })
    hostSnapshot = await hostContext(repository, app).get(owner, hostTaskId)
    assert.deepEqual(hostSnapshot.sources.map(item => item.source),
      [reference, goodLink, binary, oversized, messageSource, presentation, untrusted, longMessage])
    assert.equal(sourceReads, 0)
  })
  await useStorage(storage, async repository => {
    const { app } = services(repository)
    const context = hostContext(repository, app)
    assert.deepEqual(await context.get(owner, hostTaskId), hostSnapshot)
    assert.deepEqual((await context.load(owner, hostTaskId, reference)).content, { kind: 'file', text: contents })
    assert.deepEqual((await context.load(owner, hostTaskId, goodLink)).content, { kind: 'url', href: goodLink.locator })
    assert.deepEqual((await context.load(owner, hostTaskId, messageSource)).content,
      { kind: 'message', role: 'user', text: 'Source discussion' })
    const preview = (await context.load(owner, hostTaskId, longMessage)).content
    assert.equal(preview.kind, 'message')
    assert.equal(preview.role, 'assistant')
    assert.ok(preview.text.isWellFormed(), 'A preview must not split a character at the text limit')
    assert.equal(preview.text, `${messagePrefix}\n🧪`)
    assert.equal([...preview.text].length, 8192)
    const presented = (await context.load(owner, hostTaskId, presentation)).content
    assert.deepEqual(presented, { kind: 'presentation', locator: 'brief.md',
      version: createHash('sha256').update(contents).digest('hex') })
    assert.equal(sourceReads, 1)
    for (const source of [badLink, escaped, symlinkFile, symlinkDirectory, binary, oversized, unrelated, untrusted]) {
      await assert.rejects(context.load(owner, hostTaskId, source), { code: 'NOT_FOUND' })
    }
    afterRead = () => writeFile(join(workspacePath, reference.locator), 'Changed while reading')
    await assert.rejects(context.load(owner, hostTaskId, reference), { code: 'NOT_FOUND' })
    afterRead = undefined

    const readsBeforeRevocation = sourceReads
    afterRead = () => { workspaceRegistry.delete('project') }
    await assert.rejects(context.load(owner, hostTaskId, reference), { code: 'NOT_FOUND' })
    assert.equal(sourceReads, readsBeforeRevocation + 1)
    afterRead = undefined
    workspaceRegistry.set('project', workspace)

    await assert.rejects(context.get({ ...owner }, hostTaskId), { code: 'NOT_FOUND' })
    afterObserve = () => { workspace.sessionIds = [] }
    await assert.rejects(context.load(owner, hostTaskId, messageSource), { code: 'NOT_FOUND' })
    assert.equal(leaseCount, 0)
    afterObserve = undefined
    await assert.rejects(context.load(owner, hostTaskId, messageSource), { code: 'NOT_FOUND' })
  })
  console.log('PASS: native storage reopen and native filesystem scoping, bounded reads, session projection and stage handoff.')
} finally {
  await rm(root, { recursive: true, force: true })
}
