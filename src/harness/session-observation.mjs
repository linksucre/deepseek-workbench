/**
 * Read a persisted task binding without resuming the Agent. Both IDs must come
 * from the task record. `allows` must use the individual caller's verified Host
 * identity and action, including for calls that originate from model tools.
 * The caller owns the observation lease when the binding is readable.
 */
export async function observeBoundRootSession({ workspaceRegistry, sessionQuery, allows }, { workspaceId, sessionId }, signal) {
  const workspaceAccess = { kind: 'workspace', id: workspaceId }
  const sessionAccess = { kind: 'session', id: sessionId }

  async function authorizedWorkspace() {
    signal?.throwIfAborted()
    if (await allows(workspaceAccess) !== true || await allows(sessionAccess) !== true) return undefined
    signal?.throwIfAborted()
    const workspace = workspaceRegistry.get(workspaceId)
    if (workspace?.sessionIds.includes(sessionId)) return workspace.path
  }

  if (await authorizedWorkspace() === undefined) return null

  let observation
  try {
    observation = await sessionQuery.observeSession(sessionId, { signal })
  } catch (error) {
    if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return null
    throw error
  }

  let keep = false
  try {
    const cwd = await authorizedWorkspace()
    const { header } = observation
    keep = typeof cwd === 'string' && header.cwd === cwd && header.id === sessionId &&
      header.origin === undefined && header.parentSession === undefined && header.isSeeded === false
    return keep ? observation : null
  } finally {
    if (!keep) observation[Symbol.dispose]()
  }
}
