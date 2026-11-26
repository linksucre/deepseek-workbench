import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = process.argv[2]
if (!checkout || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/materialize-harness.mjs <Harness checkout>')
}

const cwd = resolve(checkout)
const baseline = JSON.parse(readFileSync(new URL('../harness-baseline.json', import.meta.url), 'utf8'))
const { commit, upstreamCommit, bundleSha256 } = baseline
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const head = git('rev-parse', 'HEAD')

if (upstreamCommit === undefined && bundleSha256 === undefined) {
  if (head !== commit) throw new Error('Harness checkout does not match harness-baseline.json')
} else {
  if (![commit, upstreamCommit].every(value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)) ||
      typeof bundleSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(bundleSha256)) {
    throw new Error('Invalid Harness bundle pins in harness-baseline.json')
  }
  if (head !== upstreamCommit) throw new Error('Start from the exact public Harness base commit')
  if (git('status', '--porcelain')) throw new Error('Start from a clean Harness checkout')

  const bundle = fileURLToPath(new URL('../vendor/harness/storage-records.bundle', import.meta.url))
  const digest = createHash('sha256').update(readFileSync(bundle)).digest('hex')
  if (digest !== bundleSha256) throw new Error('Harness bundle SHA-256 does not match harness-baseline.json')

  git('bundle', 'verify', bundle)
  git('fetch', '--no-tags', '--', bundle, 'HEAD')
  if (git('rev-parse', 'FETCH_HEAD') !== commit) throw new Error('Harness bundle head does not match the pinned commit')
  git('merge-base', '--is-ancestor', upstreamCommit, commit)
  git('checkout', '--detach', commit)
}

console.log(`Harness checkout ready at ${commit}`)
