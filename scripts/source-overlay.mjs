import { execFileSync } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [checkoutPath, outputPath, usagePolicy] = process.argv.slice(2)
if (!checkoutPath || !outputPath) throw new Error('Usage: node scripts/source-overlay.mjs <built-harness> <new-overlay-path> [usage-policy.json]')
const checkout = resolve(checkoutPath)
const baseline = JSON.parse(await readFile(new URL('../harness-baseline.json', import.meta.url), 'utf8'))
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim()
if (head !== baseline.commit) throw new Error('Harness checkout does not match the Workbench baseline')
const storage = join(checkout, 'packages/storage/storage-domain/lib/index.js')
await access(storage)
const entry = new URL('../src/application/entry.mjs', import.meta.url).href
const preset = await readFile(new URL('../src/preset/cordis.patch.yml', import.meta.url), 'utf8')
if (usagePolicy !== undefined) await access(resolve(usagePolicy))
const item = [
  '- insert:',
  '    - id: workbench-host',
  `      name: ${JSON.stringify(entry)}`,
  '      config:',
  `        storageModule: ${JSON.stringify(pathToFileURL(storage).href)}`,
  ...(usagePolicy === undefined ? [] : [
    `        usagePolicyFile: ${JSON.stringify(pathToFileURL(resolve(usagePolicy)).href)}`,
  ]),
]
await writeFile(outputPath, `${preset.trimEnd()}\n\n${item.join('\n')}\n`, { flag: 'wx', mode: 0o600 })
