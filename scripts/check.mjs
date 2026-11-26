import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifySchemaMeta } from './schema-meta.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFileSync(join(root, file), 'utf8')
const json = file => JSON.parse(read(file))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const rows = (file, id) => read(file).split('\n').filter(line => line.startsWith('| ' + id))
const ids = (text, pattern) => [...text.matchAll(pattern)].map(match => match[0])

function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `Duplicate ${label}`)
  return new Set(values)
}

for (const file of [
  'README', 'SCOPE', 'SRS', 'CONTEXT', 'DOMAIN', 'ARCHITECTURE', 'MODULES',
  'TECH_STACK', 'API_SPEC', 'DATA_MODEL', 'DATABASE', 'SECURITY',
  'PROJECT_STRUCTURE', 'AGENTS', 'TASKS', 'TEST_PLAN', 'ACCEPTANCE', 'CHANGELOG',
  'docs/ENGINEERING', 'docs/DEPLOYMENT', 'docs/adr/README',
]) assert.ok(existsSync(join(root, file + '.md')), `Missing ${file}.md`)

const requirementRows = rows('SRS.md', 'FR-').concat(rows('SRS.md', 'NFR-'))
for (const row of requirementRows) {
  const owner = row.split('|')[3].trim()
  if (owner !== 'governance') {
    assert.match(owner, /^[a-z]+$/)
    assert.ok(existsSync(join(root, 'src', owner, 'DESIGN.md')), `Missing design for ${owner}`)
  }
}
const requirements = unique(
  requirementRows.map(row => row.split('|')[1].trim()),
  'requirement ID',
)
const taskRows = rows('TASKS.md', 'DEV-')
const tasks = unique(taskRows.map(row => row.split('|')[1].trim()), 'task ID')
const tests = unique(rows('TEST_PLAN.md', 'TST-').map(row => row.split('|')[1].trim()), 'test ID')
const acceptance = rows('ACCEPTANCE.md', 'AC-')
unique(acceptance.map(row => row.split('|')[1].trim()), 'acceptance ID')

function checkCoverage(table, title) {
  const covered = unique(table.flatMap(row => ids(row, /\b(?:NFR|FR)-\d+\b/g)), title)
  assert.deepEqual(covered, requirements, `${title} must cover each requirement exactly once`)
}
checkCoverage(taskRows, 'implementation task mapping')
checkCoverage(acceptance, 'acceptance mapping')
for (const row of acceptance) {
  const references = ids(row, /\bTST-\d+\b/g)
  assert.ok(references.length, `No test reference: ${row}`)
  for (const test of references) assert.ok(tests.has(test), `Unknown test ${test}`)
}

const dependencies = new Map(taskRows.map(row => {
  const [, id, , , depends, status] = row.split('|')
  assert.ok(['planned', 'active', 'review', 'done'].includes(status.trim()), id)
  return [id.trim(), ids(depends, /\bDEV-\d+\b/g)]
}))
function checkDependencies(id, ancestors = []) {
  assert.ok(tasks.has(id), `Unknown task dependency ${id}`)
  assert.ok(!ancestors.includes(id), `Dependency cycle: ${[...ancestors, id].join(' → ')}`)
  for (const dependency of dependencies.get(id)) checkDependencies(dependency, [...ancestors, id])
}
for (const id of tasks) checkDependencies(id)

function checkContract(version) {
  const directory = `contracts/v${version}`
  const schema = json(`${directory}/schemas.json`)
  const index = json(`${directory}/operations.json`)
  verifySchemaMeta(schema)
  assert.equal(schema.$id, `urn:deepseek-workbench:v${version}`)
  assert.equal(index.version, version)
  assert.ok(Object.hasOwn(schema.$defs, index.error))
  unique(index.operations.map(operation => operation.id), `API v${version} operation`)
  for (const operation of index.operations) {
    assert.ok(requirements.has(operation.requirement), `Unknown requirement for ${operation.id}`)
    assert.ok(['user', 'host-bound-agent'].includes(operation.actor))
    for (const type of [operation.input, operation.output]) {
      assert.ok(Object.hasOwn(schema.$defs, type), `Unknown schema ${type} in ${directory}`)
    }
  }
  function checkRefs(value) {
    if (!value || typeof value !== 'object') return
    if (Object.hasOwn(value, '$ref')) {
      assert.ok(value.$ref.startsWith('#/$defs/') && Object.hasOwn(schema.$defs, value.$ref.slice(8)), `Unresolved ref ${value.$ref}`)
    }
    for (const child of Object.values(value)) checkRefs(child)
  }
  checkRefs(schema)
  return `v${version}: ${index.operations.length}`
}
const contractCounts = [1, 2].map(checkContract).join(', ')
const baseline = json('harness-baseline.json')
assert.match(baseline.commit, /^[\da-f]{40}$/)
assert.equal(json('package.json').engines.dsh, baseline.version)

function checkLinks(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (['.git', '.artifacts', 'node_modules', 'dist', 'coverage', 'upstream'].includes(entry.name)) continue
    const file = join(directory, entry.name)
    if (entry.isDirectory()) checkLinks(file)
    if (!entry.isFile() || !file.endsWith('.md')) continue
    for (const [, link] of read(file).matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^[a-z]+:/i.test(link) || link.startsWith('#')) continue
      assert.ok(existsSync(resolve(root, dirname(file), link.split('#')[0])), `Broken link: ${file} → ${link}`)
    }
  }
}
checkLinks('.')

if (process.argv.includes('--base')) {
  const base = process.argv[process.argv.indexOf('--base') + 1]
  assert.match(base ?? '', /^[\da-f]{40}$/)
  const changed = new Set(git('diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`).split('\0'))
  assert.ok(![...changed].some(file => file.startsWith('contracts/v1/')), 'The v1 contract is frozen')
  for (const file of changed) {
    const module = /^src\/([^/]+)\//.exec(file)?.[1]
    if (module && !file.endsWith('.md')) {
      assert.ok(changed.has(`src/${module}/DESIGN.md`), `Sync src/${module}/DESIGN.md with ${file}`)
    }
    if (file.startsWith('contracts/')) {
      assert.ok(changed.has('API_SPEC.md') && changed.has('DATA_MODEL.md'), `Sync API_SPEC.md and DATA_MODEL.md with ${file}`)
    }
    if (file === 'harness-baseline.json' || file === '.node-version') {
      assert.ok(changed.has('TECH_STACK.md') && changed.has('docs/DEPLOYMENT.md'), `Sync version documentation with ${file}`)
    }
  }
}
console.log(`PASS: ${requirements.size} requirements, ${tasks.size} tasks, ${tests.size} test cases, ${acceptance.length} acceptance criteria, API operations (${contractCounts}).`)
