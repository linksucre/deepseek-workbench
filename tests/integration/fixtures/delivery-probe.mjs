import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHostDelivery } from '../../../src/delivery/host-delivery.mjs'

export const inject = ['workspaceRegistry', 'sessionQuery']

export async function apply(ctx) {
  const workspaceId = process.env.WORKBENCH_DELIVERY_WORKSPACE
  const sessionId = process.env.WORKBENCH_DELIVERY_SESSION
  const target = process.env.WORKBENCH_DELIVERY_RESULT
  if (!workspaceId || !sessionId || !target) return

  const record = { detail: { task: { workspaceId, activeRunId: 'probe' },
    runs: [{ id: 'probe', rootSessionId: sessionId, endedAt: null }] } }
  const principal = { kind: 'agent', sessionId }
  const build = canReadFile => createHostDelivery({
    workspaceRegistry: ctx.workspaceRegistry, sessionQuery: ctx.sessionQuery,
    canUseWorkspace: ({ task }) => task.workspaceId === workspaceId,
    canReadFile,
  })
  const service = build(({ path }) => ['first.md', 'second.md'].includes(basename(path)))
  let id = 0
  const input = {
    record, principal, afterSeq: -1, now: new Date().toISOString(), newArtifactId: () => `probe-${++id}`,
  }
  const latest = await service.resolveArtifacts({ ...input, selection: { selection: 'latest-presentation' } })
  const first = await service.resolveArtifacts({ ...input, selection: { selection: 'files', paths: ['first.md'] } })
  assert.deepEqual(latest.map(item => basename(item.locator)), ['second.md'])
  assert.deepEqual(first.map(item => basename(item.locator)), ['first.md'])
  const latestRef = JSON.parse(latest[0].source.locator)
  const firstRef = JSON.parse(first[0].source.locator)
  assert.equal(latestRef[0], sessionId)
  assert.equal(firstRef[0], sessionId)
  assert.ok(latestRef[1] > firstRef[1])
  await assert.rejects(service.resolveArtifacts({
    ...input, afterSeq: firstRef[1], selection: { selection: 'files', paths: ['first.md'] },
  }), { code: 'INVALID' })
  await assert.rejects(service.resolveArtifacts({
    ...input, principal: { kind: 'agent', sessionId: 'unrelated' }, selection: { selection: 'latest-presentation' },
  }), { code: 'NOT_FOUND' })
  await assert.rejects(build(() => false).resolveArtifacts({
    ...input, selection: { selection: 'latest-presentation' },
  }), { code: 'FORBIDDEN' })

  const prior = process.env.WORKBENCH_DELIVERY_PREVIOUS
  const submitted = prior ? JSON.parse(await readFile(prior, 'utf8')).latest : latest
  const current = await service.observe({ ...input, principal: { kind: 'user', actorId: 'reviewer' }, artifacts: submitted })
  assert.equal(current[0].artifactId, submitted[0].id)
  await writeFile(target, JSON.stringify({ latest, first, current }), { mode: 0o600 })
}
