import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTaskService } from '../../src/application/task-service.mjs'
import { createDraft } from '../../src/domain/task.mjs'
import { nativeStorageFixture } from './native-storage-fixture.mjs'

const useStorage = await nativeStorageFixture(process.argv[2] ?? '.')
const root = await mkdtemp(join(tmpdir(), 'workbench-list-performance-'))
const workspaceId = 'perf-workspace'
const input = { workspaceId, limit: 50, cursor: null }
const principal = { kind: 'user', actorId: 'local-owner' }

try {
  await useStorage(root, async repository => {
    for (let i = 0; i < 3000; i += 1) {
      const id = `00000000-0000-4000-8000-${i.toString().padStart(12, '0')}`
      const now = new Date(Date.UTC(2026, 10, 25) + i * 1000).toISOString()
      const detail = createDraft({
        id, workspaceId, now,
        brief: { title: `调研报告 ${i}`, goal: '核对来源与数字，交付可编辑版本',
          materials: [], deliverables: ['research.md'], criteria: [{ id: 'sources', description: '核对关键来源' }] },
      })
      await repository.create(detail, { actorId: principal.actorId, operation: 'seed', requestId: id, digest: id })
    }
  })
  await useStorage(root, async repository => {
    assert.equal(repository.listTasks(workspaceId).length, 3000)
    const app = createTaskService({ repository, authorize: () => true })
    const first = await app.list(principal, input)
    const second = await app.list(principal, { ...input, cursor: first.nextCursor })
    assert.equal(new Set([...first.items, ...second.items].map(task => task.id)).size, 100)
    for (let i = 0; i < 10; i += 1) await app.list(principal, input)
    const times = []
    for (let i = 0; i < 50; i += 1) {
      const start = performance.now()
      assert.equal((await app.list(principal, input)).items.length, 50)
      times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    const p95 = times[Math.ceil(times.length * 0.95) - 1]
    console.log(JSON.stringify({ tasks: 3000, limit: 50, samples: times.length, p95Ms: +p95.toFixed(2),
      machine: cpus()[0]?.model, node: process.version, layer: 'application with reopened native JSON storage' }))
    assert.ok(p95 <= 300, 'Warm application list p95 must meet NFR-004')
  })
} finally {
  await rm(root, { recursive: true, force: true })
}
