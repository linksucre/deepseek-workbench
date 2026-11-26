import assert from 'node:assert/strict'
import test from 'node:test'
import { stopBoundRootSession } from '../../src/harness/session-lifecycle.mjs'

const binding = { workspaceId: 'workspace-1', sessionId: 'session-root' }
const idle = { running: false, pendingInput: [], queue: [{ id: 'queued-user-input' }] }
const running = { ...idle, running: true }

function fixture({ states = [running, idle], outcome = { reason: 'idle', state: idle }, allows = () => true } = {}) {
  const calls = []
  const workspace = { path: '/test-workspace', sessionIds: [binding.sessionId] }
  const host = {
    allows,
    workspaceRegistry: { get: id => id === binding.workspaceId ? workspace : undefined },
    sessionQuery: {
      async observeSession(id) {
        assert.equal(id, binding.sessionId)
        return {
          header: { id, cwd: workspace.path, isSeeded: false },
          [Symbol.dispose]() { calls.push('release') },
        }
      },
    },
    sessionController: {
      async state(request) {
        assert.deepEqual(request, { sessionId: binding.sessionId })
        calls.push('state')
        return states.shift()
      },
      cancel(request) {
        assert.deepEqual(request, { sessionId: binding.sessionId })
        calls.push('cancel')
      },
      async wait(request) {
        assert.equal(request.sessionId, binding.sessionId)
        calls.push('wait')
        return outcome
      },
    },
  }
  return { host, workspace, calls }
}

test('a running bound root is stopped only after a passive idle check and revalidation', async () => {
  const { host, calls } = fixture()
  assert.equal(await stopBoundRootSession(host, binding), 'stopped')
  assert.deepEqual(calls, ['release', 'state', 'release', 'cancel', 'wait', 'release', 'state'])
})

test('rejects a detached or denied binding before accessing native lifecycle', async () => {
  const detached = fixture()
  detached.workspace.sessionIds = []
  assert.equal(await stopBoundRootSession(detached.host, binding), 'unavailable')
  assert.deepEqual(detached.calls, [])

  const denied = fixture({ allows: ({ kind }) => kind === 'workspace' })
  assert.equal(await stopBoundRootSession(denied.host, binding), 'unavailable')
  assert.deepEqual(denied.calls, [])

  let permitted = true
  const revoked = fixture({ allows: () => permitted })
  const read = revoked.host.sessionController.state
  revoked.host.sessionController.state = async request => {
    permitted = false
    return read(request)
  }
  assert.equal(await stopBoundRootSession(revoked.host, binding), 'unavailable')
  assert.deepEqual(revoked.calls, ['release', 'state'])
})

test('an idle root needs no cancel; timeout or intervening native work cannot confirm a stop', async () => {
  const alreadyIdle = fixture({ states: [idle, idle] })
  assert.equal(await stopBoundRootSession(alreadyIdle.host, binding), 'stopped')
  assert.ok(!alreadyIdle.calls.includes('cancel'))

  const timedOut = fixture({ outcome: { reason: 'timeout', state: running } })
  assert.equal(await stopBoundRootSession(timedOut.host, binding), 'not-stopped')
  assert.deepEqual(timedOut.calls, ['release', 'state', 'release', 'cancel', 'wait'])

  const resumed = fixture({ states: [running, running] })
  assert.equal(await stopBoundRootSession(resumed.host, binding), 'not-stopped')

  const needsInput = fixture({ outcome: { reason: 'input-required', state: { ...idle, pendingInput: ['question'] } } })
  assert.equal(await stopBoundRootSession(needsInput.host, binding), 'not-stopped')
})
