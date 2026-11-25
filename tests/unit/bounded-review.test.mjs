import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createBoundedReview } from '../../src/harness/bounded-review.mjs'

test('a timed-out review disposes once and holds the root slot until native cleanup', async () => {
  const sessionId = 'session-root'
  const workspaceId = 'workspace-review'
  const workspace = { path: '/test-workspace', sessionIds: [sessionId] }
  const header = { id: sessionId, cwd: workspace.path, isSeeded: false, agentPreset: 'task-collaborator' }
  const pendingResult = Promise.withResolvers()
  const disposalStarted = Promise.withResolvers()
  const disposalFinished = Promise.withResolvers()
  const activations = []
  const disposals = []
  let released = 0

  const runReview = createBoundedReview({
    agents: new Map([[sessionId, { session: { header } }]]),
    workspaceRegistry: new Map([[workspaceId, workspace]]),
    sessionQuery: {
      async observeSession(id) {
        assert.equal(id, sessionId)
        return { header, [Symbol.dispose]() { released += 1 } }
      },
    },
    subagents: {
      async startActivation({ childId, signal }) {
        activations.push(childId)
        if (childId === 'session-slow-review') {
          return {
            childId,
            result: pendingResult.promise,
            dispose() {
              disposals.push({ childId, reason: signal.reason?.name })
              // A late result becomes readable before the native cleanup completes.
              pendingResult.resolve({ stopReason: 'completed', output: [] })
              disposalStarted.resolve()
              return disposalFinished.promise
            },
          }
        }
        return {
          childId,
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'review complete' }] }),
          async dispose() { disposals.push({ childId, reason: signal.reason?.name }) },
        }
      },
    },
  }, { timeoutMs: 50 })

  const input = { sessionId, workspaceId, instruction: 'Check the brief', material: 'Selected material', allows: () => true }
  let reviewSettled = false
  const review = runReview({ ...input, childId: 'session-slow-review' }).finally(() => { reviewSettled = true })
  // AbortSignal.timeout is unref'ed. Keep the test alive while it waits for the abort.
  const deadline = setTimeout(() => disposalStarted.reject(new Error('Review never requested disposal')), 2000)
  try {
    await Promise.race([
      disposalStarted.promise,
      review.then(() => assert.fail('Review settled before disposal')),
    ])
    await setImmediate()
    assert.equal(reviewSettled, false)
    assert.equal(released, 0)
    assert.deepEqual(disposals, [{ childId: 'session-slow-review', reason: 'TimeoutError' }])
    await assert.rejects(runReview({ ...input, childId: 'session-while-cleaning' }), { code: 'REVISION_CONFLICT' })
  } finally {
    clearTimeout(deadline)
    disposalFinished.resolve()
  }

  assert.deepEqual(await review, { childSessionId: 'session-slow-review', outcome: 'incomplete', summary: '' })
  assert.equal(released, 1)
  assert.deepEqual(await runReview({ ...input, childId: 'session-next-review' }), {
    childSessionId: 'session-next-review', outcome: 'completed', summary: 'review complete',
  })
  assert.deepEqual(activations, ['session-slow-review', 'session-next-review'])
  assert.deepEqual(disposals, [
    { childId: 'session-slow-review', reason: 'TimeoutError' },
    { childId: 'session-next-review', reason: undefined },
  ])
  assert.equal(released, 2)
})
