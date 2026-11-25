import { safeContextLink } from '../domain/context-link.mjs'
import { TaskError } from '../domain/task.mjs'
import { observeBoundRootSession } from '../harness/session-observation.mjs'
import { createTaskContext } from './task-context.mjs'

const maxSourceBytes = 64 * 1024
const missing = () => new TaskError('NOT_FOUND', 'Task context source is unavailable')
const unavailable = new Set(['FS_NOT_FOUND', 'FS_PERMISSION_DENIED', 'FS_NOT_REGULAR_FILE', 'FS_TOO_LARGE'])

function eventLocation(locator) {
  let parts
  try {
    parts = JSON.parse(locator)
  } catch {
    return
  }
  if (!Array.isArray(parts) || (parts.length !== 2 && parts.length !== 3)) return
  const [sessionId, seq, index] = parts
  if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(seq) || seq < 0) return
  if (parts.length === 3 && (!Number.isSafeInteger(index) || index < 0)) return
  return { sessionId, seq, index }
}

async function availableFile(fs, cwd, path, signal) {
  if (!path.trim() || /[\u0000]/u.test(path)) return
  try {
    const root = await fs.resolve(cwd, { signal })
    const target = await fs.resolve(path, { cwd, signal })
    if (target.targetKey === root.targetKey || !fs.contains(root, target)) return
    const entry = await fs.lstat(path, { cwd }, signal)
    if (entry?.type !== 'file') return
    const current = await fs.stat(target, signal)
    if (current?.type !== 'file' || current.version !== entry.version) return
    return { target, version: current.version }
  } catch (error) {
    if (!unavailable.has(error?.code)) throw error
  }
}

function eventContent(events, location, detail, source) {
  const event = events.find(item => item.seq === location.seq)
  if (location.index !== undefined) {
    const file = event?.type === 'deliverables/presented' && event.data.files[location.index]
    const submitted = new Set(detail.submissions.flatMap(item => item.artifactIds))
    const artifact = detail.artifacts.find(item => submitted.has(item.id) && item.kind === 'file' &&
      item.source?.kind === source.kind && item.source.locator === source.locator &&
      item.source.observedAt === source.observedAt)
    if (!file || !artifact) throw missing()
    return { kind: 'presentation', locator: artifact.locator, version: artifact.version }
  }
  const user = event?.type === 'user/message' && event.data.source?.kind === 'user'
  const assistant = event?.type === 'assistant/message'
  if (!user && !assistant) throw missing()
  const blocks = user ? event.data.content : event.data.message.content
  const lines = []
  let remaining = 8192
  for (const block of blocks) {
    if (block.type !== 'text') continue
    if (lines.length) remaining -= 1
    if (remaining <= 0) break
    let end = 0
    for (const character of block.text) {
      end += character.length
      remaining -= 1
      if (remaining === 0) break
    }
    lines.push(block.text.slice(0, end))
  }
  return { kind: 'message', role: user ? 'user' : 'assistant', text: lines.join('\n') }
}

/** Owner-only adapter for the local Workbench Host. */
export function createHostTaskContext({ owner, app, repository, fs, workspaceRegistry, sessionQuery, clock }) {
  const workspaceFor = ({ principal, workspaceId }) =>
    principal === owner ? workspaceRegistry.get(workspaceId) : undefined

  function boundSession(workspace, detail, source) {
    const location = eventLocation(source.locator)
    if (location && workspace.sessionIds.includes(location.sessionId) &&
        detail.runs.some(run => run.rootSessionId === location.sessionId)) return location
  }

  return createTaskContext({
    clock,
    async loadTask(principal, taskId) {
      if (principal !== owner) throw missing()
      await app.get(principal, taskId)
      return repository.read(taskId)
    },
    async canReadSource(request) {
      const workspace = workspaceFor(request)
      if (!workspace) return false
      const { source, detail } = request
      if (source.kind === 'url') return safeContextLink(source.locator) !== undefined
      if (source.kind === 'session-event') return boundSession(workspace, detail, source) !== undefined
      if (source.kind !== 'file') return false
      return Boolean(await availableFile(fs, workspace.path, source.locator, AbortSignal.timeout(5000)))
    },
    async readSource(request) {
      const workspace = workspaceFor(request)
      if (!workspace) throw missing()
      const { source, detail, workspaceId } = request
      const signal = AbortSignal.timeout(5000)
      if (source.kind === 'url') {
        const href = safeContextLink(source.locator)
        if (!href) throw missing()
        return { kind: 'url', href }
      }
      if (source.kind === 'file') {
        const cwd = workspace.path
        const before = await availableFile(fs, cwd, source.locator, signal)
        if (!before) throw missing()
        let bytes
        try {
          bytes = await fs.readBytes(before.target, signal, maxSourceBytes)
        } catch (error) {
          if (unavailable.has(error?.code)) throw missing()
          throw error
        }
        const current = await availableFile(fs, cwd, source.locator, signal)
        if (workspaceFor(request)?.path !== cwd || !current ||
            before.target.targetKey !== current.target.targetKey || before.version !== current.version) throw missing()
        let text
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        } catch (error) {
          if (error instanceof TypeError) throw missing()
          throw error
        }
        if (text.includes('\0')) throw missing()
        return { kind: 'file', text }
      }
      const location = boundSession(workspace, detail, source)
      if (!location) throw missing()
      const cwd = workspace.path
      const observation = await observeBoundRootSession({
        workspaceRegistry, sessionQuery,
        allows: async target => {
          const current = await app.get(request.principal, request.taskId)
          const activeWorkspace = workspaceFor(request)
          return current.task.workspaceId === workspaceId && activeWorkspace?.path === cwd &&
            boundSession(activeWorkspace, current, source) !== undefined &&
            target.id === (target.kind === 'workspace' ? workspaceId : location.sessionId)
        },
      }, { workspaceId, sessionId: location.sessionId }, signal)
      if (!observation) throw missing()
      try {
        return eventContent(observation.events, location, detail, source)
      } finally {
        observation[Symbol.dispose]()
      }
    },
  })
}
