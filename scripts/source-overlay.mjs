import { execFileSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const usage = 'node scripts/source-overlay.mjs <built-harness> <new-overlay-path> [usage-policy.json] [--evidence-policy <checks.json>]'
let args
try {
  args = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, 'evidence-policy': { type: 'string' },
  } })
} catch {
  console.log(`error: Invalid option or missing option value\nhelp: ${JSON.stringify(usage)}`)
  process.exit(2)
}
if (args.values.help) {
  console.log(`description: Generate a local DeepSeek Workbench overlay\nusage: ${JSON.stringify(usage)}`)
  process.exit(0)
}
const [checkoutPath, outputPath, usagePolicy] = args.positionals
const evidencePolicy = args.values['evidence-policy']
if (!checkoutPath || !outputPath || args.positionals.length > 3 || evidencePolicy === '') {
  console.log(`error: Supply a Harness checkout and a new output file followed by optional policies\nhelp: ${JSON.stringify(usage)}`)
  process.exit(2)
}
const checkout = resolve(checkoutPath)
const baseline = JSON.parse(await readFile(new URL('../harness-baseline.json', import.meta.url), 'utf8'))
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
if (head !== baseline.commit) throw new Error('Harness checkout does not match the Workbench baseline')
const storage = join(checkout, 'packages/storage/storage-domain/lib/index.js')
await access(storage)
const entry = new URL('../src/application/entry.mjs', import.meta.url).href
const preset = await readFile(new URL('../src/preset/cordis.patch.yml', import.meta.url), 'utf8')
await Promise.all([usagePolicy, evidencePolicy].filter(path => path !== undefined).map(path => access(resolve(path))))
const reviewer = await readFile(new URL('../src/preset/reviewer.patch.yml', import.meta.url), 'utf8')
const item = [
  '- insert:',
  '    - id: workbench-host',
  `      name: ${JSON.stringify(entry)}`,
  '      config:',
  `        storageModule: ${JSON.stringify(pathToFileURL(storage).href)}`,
  ...(usagePolicy === undefined ? [] : [
    `        usagePolicyFile: ${JSON.stringify(pathToFileURL(resolve(usagePolicy)).href)}`,
  ]),
  ...(evidencePolicy === undefined ? [] : [
    `        evidencePolicyFile: ${JSON.stringify(pathToFileURL(resolve(evidencePolicy)).href)}`,
  ]),
]
await writeFile(outputPath, `${preset.trimEnd()}\n\n${reviewer.trimEnd()}\n\n${item.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
