import { readFile } from 'node:fs/promises'
import { TaskError } from '../domain/task.mjs'
import { openTaskRepository } from '../storage/task-repository.mjs'
import { createHostReview } from './host-review.mjs'
import { mountWorkbenchTools } from './host-tools.mjs'
import { createHostStart } from './host-start.mjs'
import { createTaskService } from './task-service.mjs'

const endpoint = '/workbench/v1/command'
const owner = Object.freeze({ kind: 'user', actorId: 'harness-owner' })
const loopback = new Set(['127.0.0.1', '::1'])
const readJSON = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const maxBytes = 1024 * 1024

const statusByCode = {
  INVALID: 400, FORBIDDEN: 403, NOT_FOUND: 404, REVISION_CONFLICT: 409, INVALID_TRANSITION: 409,
  ARTIFACT_DRIFT: 409, RECONCILIATION_REQUIRED: 409, UNSUPPORTED: 501, HOST_UNAVAILABLE: 503,
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function refuse(res, code, message) {
  send(res, statusByCode[code], { error: { code, message } })
}

async function readBody(req) {
  const parts = []
  let length = 0
  for await (const part of req) {
    length += part.length
    if (length > maxBytes) throw new TaskError('INVALID', 'Command body exceeds the limit')
    parts.push(part)
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    throw new TaskError('INVALID', 'Command body must be JSON')
  }
}

/**
 * Mount the explicit local owner command carrier. The logical operation shapes
 * stay in contracts/v1. The caller supplies the pinned Host storage/schema APIs.
 */
export async function mountWorkbenchHost(ctx, { Ajv2020, z, defineDomain, domainTable, delivery }) {
  if (!loopback.has(ctx.webServer.host)) throw new Error('Workbench commands require a loopback listener')
  const schema = await readJSON('../../contracts/v1/schemas.json')
  const index = await readJSON('../../contracts/v1/operations.json')
  const ajv = new Ajv2020()
  ajv.addFormat('uuid', value => z.uuid().safeParse(value).success)
  ajv.addFormat('date', value => z.iso.date().safeParse(value).success)
  ajv.addFormat('date-time', value => z.iso.datetime({ offset: true }).safeParse(value).success)
  ajv.addSchema(schema)
  const validator = type => ajv.compile({ $ref: `${schema.$id}#/$defs/${type}` })
  const operations = new Map(index.operations.map(operation => [operation.id, operation]))
  const repository = await openTaskRepository({
    storageDomain: ctx.storageDomain, z, defineDomain, domainTable, validateDetail: validator('TaskDetail'),
  })
  ctx.effect(() => () => repository.close())
  const toolPrincipals = new WeakSet()
  const grantAgent = principal => {
    toolPrincipals.add(principal)
    return principal
  }
  const isBoundCaller = (principal, workspaceId) => toolPrincipals.has(principal) &&
    principal.workspaceId === workspaceId && ctx.workspaceRegistry.get(workspaceId)?.sessionIds.includes(principal.sessionId)
  const app = createTaskService({
    repository, delivery: delivery ?? createHostReview(ctx, { owner, isBoundCaller }),
    authorize: ({ principal, workspaceId }) => (principal === owner || isBoundCaller(principal, workspaceId)) &&
      ctx.workspaceRegistry.get(workspaceId) !== undefined,
  })
  mountWorkbenchTools(ctx, { repository, app, validate: validator, schemas: schema.$defs, grantAgent })
  const lifecycle = createHostStart({
    app, repository, sessionController: ctx.sessionController,
    sessionQuery: ctx.sessionQuery, workspaceRegistry: ctx.workspaceRegistry,
  })
  const methods = {
    'task.create': input => app.create(owner, input),
    'task.get': input => app.get(owner, input.taskId),
    'task.updateBrief': input => app.updateBrief(owner, input),
    'task.ready': input => app.ready(owner, input),
    'task.choose': input => app.choose(owner, input),
    'task.start': input => lifecycle.start(owner, input),
    'task.reconcile': input => lifecycle.reconcile(owner, input),
    'task.submit': ({ selection, paths, ...input }) =>
      app.submit(owner, { ...input, selection: { selection, ...(paths && { paths }) } }),
    'task.decide': input => app.decide(owner, input),
  }
  const commands = new Map(Object.entries(methods).map(([id, run]) => {
    const { input, output, actor } = operations.get(id)
    if (actor !== 'user') throw new Error(`Invalid actor for owner command ${id}`)
    return [id, { run, validateInput: validator(input), validateOutput: validator(output) }]
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: endpoint, auth: 'required',
    async handler(req, res, peer) {
      if (peer?.principal.kind !== 'owner') return refuse(res, 'FORBIDDEN', 'Host owner access required')
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        send(res, 405, { error: { code: 'INVALID', message: 'Use POST for workbench commands' } })
        return
      }
      if (req.headers.origin !== ctx.webServer.getOrigin()) return refuse(res, 'FORBIDDEN', 'Same-origin request required')
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return refuse(res, 'INVALID', 'application/json request required')
      }
      try {
        const body = await readBody(req)
        const command = commands.get(body?.operation)
        if (!command) return refuse(res, 'UNSUPPORTED', 'Workbench command is not available')
        if (!command.validateInput(body.input)) return refuse(res, 'INVALID', 'Request does not match the command contract')
        const result = await command.run(body.input)
        if (!command.validateOutput(result)) return refuse(res, 'HOST_UNAVAILABLE', 'Command result did not match its contract')
        send(res, 200, { result })
      } catch (error) {
        if (error instanceof TaskError && Object.hasOwn(statusByCode, error.code)) {
          refuse(res, error.code, error.message)
        } else {
          refuse(res, 'HOST_UNAVAILABLE', 'Workbench command failed')
        }
      }
    },
  }))
}
