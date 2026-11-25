import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkout = resolve(process.argv[2] ?? '.')
const baseline = JSON.parse(await readFile(new URL('../../harness-baseline.json', import.meta.url), 'utf8'))
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), baseline.commit)

const fixturePath = join(checkout, 'packages/experimental/worktree')
const requireWorktree = createRequire(join(fixturePath, 'package.json'))
const { canonicalPath } = await import(pathToFileURL(requireWorktree.resolve('@deepseek-ai/dsh-sandbox')).href)
const workbenchPath = canonicalPath(fileURLToPath(new URL('../../', import.meta.url)))
const artifactRoot = canonicalPath(join(workbenchPath, '.artifacts'))
if (process.platform === 'darwin') {
  const sharedTempRoots = ['/tmp', tmpdir()].map(canonicalPath)
  const shared = sharedTempRoots.some(root => {
    const path = relative(root, artifactRoot)
    return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
  })
  if (shared) throw new Error('Worktree isolation requires a checkout outside the shared macOS temporary directories.')
}

const requireHost = createRequire(join(checkout, 'package.json'))
const { register } = requireHost('tsx/esm/api')
const unregister = register()
const { git, harness, repository, testAgent } = await import(pathToFileURL(join(fixturePath, 'tests/harness.ts')).href)
const { runCommand } = await import(pathToFileURL(join(fixturePath, 'src/process.ts')).href)
await mkdir(artifactRoot, { recursive: true })
const root = await repository(artifactRoot)
const limits = { timeoutMs: 20_000, graceMs: 1_000, maxOutputBytes: 16_384 }
const signal = () => AbortSignal.timeout(25_000)
const tracked = 'tracked.txt'
let host

try {
  await writeFile(join(root, 'owner-draft.txt'), 'Uncommitted owner work\n')
  host = await harness(root, { nodeCommand: process.execPath, retainOnArchive: true }, 'workspace-write')
  const firstAgent = testAgent(host, root, 'worktree-agent-a')
  const secondAgent = testAgent(host, root, 'worktree-agent-b')
  const [first, second] = await Promise.all([
    host.worktrees.create(firstAgent, { name: 'agent-a' }, signal()),
    host.worktrees.create(secondAgent, { name: 'agent-b' }, signal()),
  ])
  assert.notEqual(first.path, second.path)
  assert.equal(first.baseCommit, second.baseCommit)
  assert.equal(await git(root, 'rev-parse', 'HEAD'), first.baseCommit)
  for (const [agent, worktree] of [[firstAgent, first], [secondAgent, second]]) {
    assert.equal(host.workingDirectory.get(agent.session), worktree.path)
    assert.equal(host.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot, worktree.path)
    await assert.rejects(access(join(worktree.path, 'owner-draft.txt')), { code: 'ENOENT' })
  }

  function sessionCommand(agent, args) {
    return runCommand(host, limits, host.sandboxPolicy.resolve({ session: agent.session }),
      host.workingDirectory.get(agent.session), args, signal())
  }

  function write(agent, path, content) {
    return sessionCommand(agent, [process.execPath, '-e',
      'require("node:fs").writeFileSync(process.argv[1], process.argv[2])', path, content])
  }

  await Promise.all([write(firstAgent, tracked, 'First agent\n'), write(secondAgent, tracked, 'Second agent\n')])
  const denied = /permission denied|operation not permitted|read-only file system/i
  await assert.rejects(write(firstAgent, join(second.path, tracked), 'Cross-session write'), denied)
  await assert.rejects(write(secondAgent, join(root, tracked), 'Source checkout write'), denied)
  await assert.rejects(sessionCommand(firstAgent, ['git', 'add', tracked]), denied)
  assert.equal(await readFile(join(first.path, tracked), 'utf8'), 'First agent\n')
  assert.equal(await readFile(join(second.path, tracked), 'utf8'), 'Second agent\n')
  assert.equal(await readFile(join(root, tracked), 'utf8'), 'initial\n')

  await Promise.all([host.worktrees.exit(firstAgent, signal()), host.worktrees.exit(secondAgent, signal())])
  assert.equal(host.workingDirectory.get(firstAgent.session), root)
  assert.equal(host.workingDirectory.get(secondAgent.session), root)

  // Simulate the owner receiving and committing each branch outside the Agent policies.
  for (const worktree of [first, second]) {
    await git(worktree.path, 'add', tracked)
    await git(worktree.path, 'commit', '-m', worktree.branch)
  }
  const heads = await Promise.all([first, second].map(worktree => git(worktree.path, 'rev-parse', 'HEAD')))
  assert.notEqual(heads[0], heads[1])
  await assert.rejects(git(root, 'merge-tree', '--write-tree', first.branch, second.branch), error => {
    assert.equal(error.code, 1)
    assert.match(error.stdout, /CONFLICT \(content\).*tracked\.txt/)
    return true
  })
  assert.equal(await git(root, 'rev-parse', 'HEAD'), first.baseCommit)
  assert.equal(await readFile(join(root, 'owner-draft.txt'), 'utf8'), 'Uncommitted owner work\n')
  assert.deepEqual(await Promise.all([first, second].map(worktree => git(worktree.path, 'rev-parse', 'HEAD'))), heads)
  console.log('PASS: native worktree isolation, confined writes, shared Git metadata denial, and owner conflict detection.')
} finally {
  try {
    await host?.fiber.dispose()
  } finally {
    unregister()
    await rm(root, { recursive: true, force: true })
  }
}
