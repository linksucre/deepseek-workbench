import { TaskError } from '../domain/task.mjs'

// The native tools wire supports a subset of the checked JSON Schema.
function toolShape({ type, items, enum: choices }) {
  return { ...(type && { type }), ...(choices && { enum: choices }), ...(items && { items: toolShape(items) }) }
}

// Discover the task from the actual ToolExecution session. No caller arguments
// can name the task or construct its identity.
export function mountWorkbenchTools(ctx, { repository, app, validate, schemas, grantAgent }) {
  function getBinding(agent) {
    if (!agent?.session?.id) return undefined
    return repository.findActiveBySession(agent.session.id)
  }

  for (const [name, type, runTool] of [
    ['workbench_suggest', 'AgentSuggest', (principal, input, args) => app.choose(principal, { ...input, choice: args })],
    ['workbench_submit', 'AgentSubmit', (principal, input, args) => app.submit(principal, { ...input, selection: args })],
  ]) {
    const schema = schemas[type]
    const output = { ...schemas.AgentAck,
      properties: Object.fromEntries(Object.entries(schemas.AgentAck.properties).map(([key, node]) => [key, toolShape(node)])),
    }
    const outputValidator = validate('AgentAck')
    const parameters = Object.fromEntries(Object.entries(schema.properties).map(([key, shape]) => [
      key, { ...toolShape(shape), ...(schema.required.includes(key) && { required: true }) },
    ]))
    const inputValidator = validate(type)
    ctx.effect(() => ctx.tools.register({
      name,
      description: type === 'AgentSubmit'
        ? 'Submit artifacts for the current task after using present. Select latest-presentation or files and their presented paths.'
        : 'Propose an approach for the current task. The user can choose another approach.',
      parameters,
      output: { schema: output, render: (_args, value) => [{ type: 'text', text: `Task revision ${value.revision}` }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        if (!inputValidator(args)) throw new TaskError('INVALID', 'Invalid workbench tool arguments')
        const binding = getBinding(exec.agent)
        if (!binding) throw new TaskError('NOT_FOUND', 'No active task bound to this session')
        const { task, runs } = binding.detail
        const run = runs.find(item => item.id === task.activeRunId)
        const principal = grantAgent({ kind: 'agent', sessionId: run.rootSessionId, workspaceId: task.workspaceId })
        const requestId = `tool:${exec.callId}`
        const operation = type === 'AgentSubmit' ? 'task.submit' : 'task.choose'
        const prior = binding.operations.find(item => item.actorId === `agent:${run.rootSessionId}` &&
          item.operation === operation && item.requestId === requestId)
        const result = await runTool(principal, {
          taskId: task.id, expectedRevision: prior ? prior.result.task.revision - 1 : task.revision, requestId,
        }, args)
        const reply = { revision: result.task.revision }
        if (!outputValidator(reply)) throw new TaskError('HOST_UNAVAILABLE', 'Invalid workbench tool result')
        return reply
      },
    }, { when: ({ agent }) => getBinding(agent) !== undefined }))
  }
}
