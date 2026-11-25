import { TaskError } from '../domain/task.mjs'
import { observeBoundRootSession } from './session-observation.mjs'

const reviewer = 'task-reviewer'
const maxPromptBytes = 24 * 1024
const maxOutputLength = 8192
const isReviewer = agent => agent?.session?.header?.agentPreset === reviewer

/** Installed before any reserved reviewer can be created or resumed. */
export function installReviewerIsolation(ctx) {
  ctx.effect(() => ctx.tools.guard(exec => isReviewer(exec.agent) ? 'Independent reviewers cannot execute tools.' : undefined))
  ctx.on('agent/created', ({ agent }) => {
    if (!isReviewer(agent)) return
    agent.ctx.tools.restrict({ allow: [] })
    if (agent.ctx.tools.schemas(agent).length > 0) {
      throw new TaskError('FORBIDDEN', 'Reviewer preset did not isolate the native tool catalog')
    }
  })
}

/** Dispatch an owner-authorized reserved, one-shot, text-only review. */
export function createBoundedReview({ agents, subagents, workspaceRegistry, sessionQuery }, { timeoutMs = 120_000 } = {}) {
  const running = new Set()
  return async function runReview({ sessionId, workspaceId, childId, instruction, material, allows }) {
    if (!childId || childId === sessionId || typeof allows !== 'function' ||
        typeof instruction !== 'string' || !instruction.trim() ||
        typeof material !== 'string' || !material.trim() ||
        Buffer.byteLength(instruction) + Buffer.byteLength(material) > maxPromptBytes) {
      throw new TaskError('INVALID', 'A bounded review needs a reserved child and a bounded question and material')
    }
    if (running.has(sessionId)) throw new TaskError('REVISION_CONFLICT', 'A review is already running for this session')
    running.add(sessionId)
    try {
      const signal = AbortSignal.timeout(timeoutMs)
      const observation = await observeBoundRootSession({
        workspaceRegistry, sessionQuery, allows,
      }, { workspaceId, sessionId }, signal)
      if (!observation) throw new TaskError('NOT_FOUND', 'The authorized root session is unavailable')
      try {
        const parent = agents.get(sessionId)
        if (!parent || parent.session.header.origin !== undefined || parent.session.header.agentPreset !== 'task-collaborator') {
          throw new TaskError('INVALID_TRANSITION', 'Review requires a live task collaborator session')
        }
        const activation = await subagents.startActivation({
          provider: 'spawn', childId, parent, cwd: observation.header.cwd,
          label: 'Independent review', agentPreset: reviewer, maxDepth: 1,
          agentOptions: { maxTokens: 1024 }, delivery: 'caller', signal,
          prompt: [{ type: 'text', text: JSON.stringify({ instruction, material }) }],
        })
        let stopping
        function cancel() {
          stopping ??= activation.dispose()
          // The finally block observes teardown failure before releasing the slot.
          stopping.catch(() => {})
        }
        signal.addEventListener('abort', cancel, { once: true })
        if (signal.aborted) cancel()
        try {
          if (activation.childId !== childId) throw new TaskError('RECONCILIATION_REQUIRED', 'Native reviewer identity changed')
          const result = await activation.result
          return {
            childSessionId: childId, outcome: !signal.aborted && result.stopReason === 'completed' ? 'completed' : 'incomplete',
            summary: result.output.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, maxOutputLength),
          }
        } finally {
          signal.removeEventListener('abort', cancel)
          await (stopping ?? activation.dispose())
        }
      } finally {
        observation[Symbol.dispose]()
      }
    } finally {
      running.delete(sessionId)
    }
  }
}
