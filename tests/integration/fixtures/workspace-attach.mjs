import assert from 'node:assert/strict'
import { observeBoundRootSession } from '../../../src/harness/session-observation.mjs'

export const inject = ['workspaceRegistry', 'sessionQuery']

export async function apply(ctx) {
  const { workspaceRegistry, sessionQuery } = ctx
  const sessionId = process.env.WORKBENCH_TEST_RESERVED_ID
  const cwd = process.env.WORKBENCH_TEST_CWD
  const phase = process.env.WORKBENCH_TEST_RECOVERY_PHASE

  if (phase === 'fail-attach') {
    installAttachFailure(workspaceRegistry, sessionId)
  }
  if (phase === 'reattach') {
    const workspace = workspaceRegistry.list().find(entry => entry.path === cwd)
    assert.ok(workspace, 'fixture workspace exists')
    assert.ok(!workspace.sessionIds.includes(sessionId), 'session is unattached after restart')

    const binding = { workspaceId: workspace.id, sessionId }
    const observedBinding = {
      workspaceRegistry, sessionQuery,
      allows: ({ kind, id }) => kind === 'workspace' ? id === workspace.id : id === sessionId,
    }
    assert.equal(await observeBoundRootSession(observedBinding, binding), null, 'a cold orphan is not a readable binding')

    const observation = await sessionQuery.observeSession(sessionId)
    try {
      assert.equal(observation.header.id, sessionId)
      assert.equal(observation.header.cwd, cwd)
      assert.equal(observation.header.origin, undefined)
      assert.equal(observation.header.agentPreset, 'task-collaborator')
      assert.ok(!observation.events.some(event => event.type === 'turn/start'), 'no task message was sent')
    } finally {
      observation[Symbol.dispose]()
    }

    // The fixture supplies the known identity. The production adapter must verify its own receipt.
    await workspace.attachSession(sessionId)
    await workspace.attachSession(sessionId)
    assert.equal(workspace.sessionIds.filter(id => id === sessionId).length, 1)
    assert.equal(
      await observeBoundRootSession({ ...observedBinding, allows: ({ kind }) => kind === 'workspace' }, binding),
      null,
      'workspace authorization alone does not authorize the session',
    )
    let permitted = true
    const revocationCheck = {
      workspaceRegistry,
      allows: () => permitted,
      sessionQuery: {
        async observeSession(...args) {
          const observation = await sessionQuery.observeSession(...args)
          permitted = false
          return observation
        },
      },
    }
    assert.equal(await observeBoundRootSession(revocationCheck, binding), null, 'revocation during observation wins')
    const attached = await observeBoundRootSession(observedBinding, binding)
    assert.ok(attached, 'a fully authorized attached root can be observed')
    try {
      assert.equal(attached.header.id, sessionId)
    } finally {
      attached[Symbol.dispose]()
    }
  }
}

function installAttachFailure(registry, sessionId) {
  const get = registry.get.bind(registry)
  const instrumented = new WeakSet()
  let failed = false

  registry.get = function (workspaceId) {
    const workspace = get(workspaceId)
    if (workspace && !instrumented.has(workspace)) {
      const attach = workspace.attachSession.bind(workspace)
      workspace.attachSession = async function (id) {
        if (!failed && id === sessionId) {
          failed = true
          throw new Error('Injected before workspace attachment')
        }
        return attach(id)
      }
      instrumented.add(workspace)
    }
    return workspace
  }
}
