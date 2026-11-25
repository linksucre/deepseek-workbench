import { observeBoundRootSession } from './session-observation.mjs'

/**
 * Stop a task's existing root without clearing queued user input. The caller owns
 * the task mutation and must commit it only after receiving `stopped`.
 */
export async function stopBoundRootSession(host, binding, {
  signal = new AbortController().signal,
  timeoutMs = 5_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('Stop timeout must be a positive supported timer delay')
  }
  const { sessionController } = host
  const target = { sessionId: binding.sessionId }

  async function hasBinding() {
    const observation = await observeBoundRootSession(host, binding, signal)
    if (observation === null) return false
    observation[Symbol.dispose]()
    return true
  }

  if (!await hasBinding()) return 'unavailable'

  const state = await sessionController.state(target, signal)
  if (state.running) {
    if (!await hasBinding()) return 'unavailable'
    signal.throwIfAborted()
    sessionController.cancel(target)
  }

  const outcome = await sessionController.wait({ ...target, timeoutMs, maxMessages: 1 }, signal)
  if (outcome.reason !== 'idle' || outcome.state.running || outcome.state.pendingInput.length > 0) {
    return 'not-stopped'
  }
  if (!await hasBinding()) return 'unavailable'
  const current = await sessionController.state(target, signal)
  if (current.running || current.pendingInput.length > 0) return 'not-stopped'
  return 'stopped'
}
