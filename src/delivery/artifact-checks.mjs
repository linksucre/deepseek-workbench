import { isAbsolute, resolve } from 'node:path'
import { TaskError } from '../domain/task.mjs'

const jsonLimit = 1024 * 1024

/** Compile rules supplied by the local deployment, outside model-controlled input. */
export function createArtifactChecks({ z, policy = [] }) {
  const text = z.string().min(1)
  const rules = z.array(z.strictObject({
    workspace: text.refine(isAbsolute),
    taskTitle: text.max(256),
    criterionId: text.max(256),
    description: text.max(8192),
    path: text.refine(value => !isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
      && value.split('/').every(part => part && part !== '.' && part !== '..')),
    check: z.enum(['nonempty', 'json']),
  })).max(100).parse(policy)
  const byWorkspace = new Map()
  for (const rule of rules) {
    const workspace = resolve(rule.workspace)
    const configured = byWorkspace.get(workspace) ?? new Map()
    byWorkspace.set(workspace, configured)
    const key = JSON.stringify([rule.taskTitle, rule.criterionId, rule.description])
    if (configured.has(key)) throw new Error('Duplicate fixed artifact check for the same workspace and criterion')
    configured.set(key, rule)
  }

  return async ({ task, files, artifacts, now }) => {
    const checks = byWorkspace.get(files.root)
    if (!checks) return []
    const inputs = new Map(artifacts.map(artifact => [artifact.locator, artifact]))
    const evidence = []
    for (const { id, description } of task.criteria) {
      const rule = checks.get(JSON.stringify([task.title, id, description]))
      if (!rule) continue
      const artifact = inputs.get(resolve(files.root, rule.path))
      if (!artifact) throw new TaskError('INVALID', 'Include the artifact required by the fixed check')
      const file = await files.inspect(artifact.locator, { captureBytes: rule.check === 'json' ? jsonLimit : 0 })
      if (file.version !== artifact.version) throw new TaskError('ARTIFACT_DRIFT', 'File changed before the fixed check')
      const pass = rule.check === 'nonempty' ? file.size > 0 : validJSON(file.bytes)
      const summary = rule.check === 'nonempty' ? 'Non-empty file check' : 'UTF-8 JSON check (up to 1 MiB)'
      evidence.push({ criterionId: id, kind: 'machine', outcome: pass ? 'pass' : 'fail',
        source: artifact.source, observedAt: now, summary })
    }
    return evidence
  }
}

function validJSON(bytes) {
  if (!bytes) return false
  try {
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return true
  } catch {
    return false
  }
}
