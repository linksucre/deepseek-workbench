import { createHash } from 'node:crypto'
import { TaskError } from '../domain/task.mjs'
import { observeBoundRootSession } from '../harness/session-observation.mjs'
import { stopBoundRootSession } from '../harness/session-lifecycle.mjs'

const missing = () => new TaskError('NOT_FOUND', 'No available task conversation')
const stale = () => new TaskError('REVISION_CONFLICT', 'Task revision changed')
const signal = () => AbortSignal.timeout(15_000)

function messageText(content) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function promptReceipt(events, id) {
  for (const event of events) {
    const candidates = event.type === 'agent/inbox/spliced' ? event.data.inserted
      : event.type === 'user/message' ? [event.data] : []
    const message = candidates.find(item => item.source?.kind === 'user' && item.source.rpcId === id)
    if (message) return messageText(message.content)
  }
}

function visibleMessages(events, limit) {
  const messages = []
  for (let i = events.length - 1; i >= 0 && messages.length < limit; i -= 1) {
    const event = events[i]
    const user = event.type === 'user/message' && event.data.source?.kind === 'user'
    const assistant = event.type === 'assistant/message'
    if (!user && !assistant) continue
    const text = messageText(user ? event.data.content : event.data.message.content).trim()
    if (text) messages.push({ seq: event.seq, role: user ? 'user' : 'assistant', text: text.slice(0, 8192) })
  }
  return messages.reverse()
}

/** Authenticated local owner facade for a task's verified native conversation. */
export function createHostConversation({ app, repository, workspaceRegistry, sessionQuery, sessionController }) {
  let queue = Promise.resolve()

  function exclusive(action) {
    const work = queue.then(action)
    queue = work.catch(() => {})
    return work
  }

  function nativeFor(principal, detail, sessionId) {
    const workspaceId = detail.task.workspaceId
    return {
      workspaceRegistry, sessionQuery, sessionController,
      allows: async target => {
        const visible = await app.get(principal, detail.task.id)
        const sessionMatches = visible.runs.some(run => run.rootSessionId === sessionId)
        return sessionMatches && visible.task.workspaceId === workspaceId &&
          target.id === (target.kind === 'workspace' ? workspaceId : sessionId)
      },
    }
  }

  async function withSession(principal, detail, sessionId, call) {
    if (!sessionId) throw missing()
    const timeout = signal()
    const observed = await observeBoundRootSession(nativeFor(principal, detail, sessionId),
      { workspaceId: detail.task.workspaceId, sessionId }, timeout)
    if (!observed) throw missing()
    try {
      return await call(observed, timeout)
    } finally {
      observed[Symbol.dispose]()
    }
  }

  function currentRun(detail) {
    return detail.runs.find(item => item.id === detail.task.activeRunId)
  }

  return {
    async read(principal, input) {
      const detail = await app.get(principal, input.taskId)
      const sessionId = (currentRun(detail) ?? detail.runs.at(-1))?.rootSessionId
      return withSession(principal, detail, sessionId, async ({ events }, timeout) => {
        const state = await sessionController.state({ sessionId }, timeout)
        return { sessionId, running: state.running, pendingInput: state.pendingInput, messages: visibleMessages(events, input.limit) }
      })
    },

    prompt(principal, input) {
      return exclusive(async () => {
        const detail = await app.get(principal, input.taskId)
        const run = currentRun(detail) ?? detail.runs.at(-1)
        const sessionId = run?.rootSessionId
        const text = input.text.trim()
        if (!text) throw new TaskError('INVALID', 'A message is required')
        const requestId = 'workbench-' + createHash('sha256').update(JSON.stringify([
          detail.task.id, run?.id, input.requestId,
        ])).digest('hex')
        return withSession(principal, detail, sessionId, async ({ events }, timeout) => {
          const original = promptReceipt(events, requestId)
          if (original !== undefined) {
            if (original !== text) throw new TaskError('INVALID', 'Request ID reused with a different message')
            return { sessionId, accepted: true }
          }
          const latest = await app.get(principal, input.taskId)
          if (latest.task.revision !== input.expectedRevision) throw stale()
          if (latest.task.status !== 'active' || currentRun(latest)?.rootSessionId !== sessionId) {
            throw new TaskError('INVALID_TRANSITION', 'Task requires an active conversation')
          }
          const receipt = await sessionController.prompt({ sessionId, requestId, mode: 'queue',
            content: [{ type: 'text', text }] }, timeout)
          if (receipt.accepted !== true) throw new TaskError('HOST_UNAVAILABLE', 'Prompt was not admitted')
          return { sessionId, accepted: true }
        })
      })
    },

    transition(principal, input, action) {
      return exclusive(async () => {
        const detail = await app.get(principal, input.taskId)
        const record = repository.read(input.taskId)
        const allowed = {
          pause: ['active'], resume: ['paused'], cancel: ['draft', 'ready', 'active', 'paused', 'review'],
        }
        const receipt = record.operations.find(item => item.actorId === `user:${principal.actorId}` &&
          item.operation === `task.${action}` && item.requestId === input.requestId)
        if (receipt) return app.finishLifecycle(principal, input, action)
        if (detail.task.revision !== input.expectedRevision) throw stale()
        if (!allowed[action].includes(detail.task.status)) {
          throw new TaskError('INVALID_TRANSITION', 'Task state cannot change this way')
        }
        const sessionId = currentRun(detail)?.rootSessionId
        if (action === 'resume') {
          await withSession(principal, detail, sessionId, async () => {})
        } else if (sessionId) {
          const stopped = await stopBoundRootSession(nativeFor(principal, detail, sessionId),
            { workspaceId: detail.task.workspaceId, sessionId }, { signal: signal() })
          if (stopped !== 'stopped') throw new TaskError('RECONCILIATION_REQUIRED', 'Native conversation was not confirmed idle')
        }
        return app.finishLifecycle(principal, input, action)
      })
    },
  }
}
