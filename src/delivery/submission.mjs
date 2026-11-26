import { TaskError } from '../domain/task.mjs'

const invalid = message => new TaskError('INVALID', message)
const sourceRef = (sessionId, seq, at, index) => ({
  kind: 'session-event',
  locator: JSON.stringify(index === undefined ? [sessionId, seq] : [sessionId, seq, index]),
  observedAt: at,
})

function inStage(seq, { afterSeq, beforeSeq }) {
  return Number.isSafeInteger(seq) && seq > afterSeq && seq < beforeSeq
}

/** Consume a host-owned event slice for the calling Run and stage only. */
export async function resolvePresentation({ sessionId, events, stage, selection, files, now, newArtifactId }) {
  if (!Number.isSafeInteger(stage.afterSeq) || !Number.isSafeInteger(stage.beforeSeq)
      || stage.afterSeq < -1 || stage.afterSeq >= stage.beforeSeq) {
    throw invalid('Invalid stage cursor')
  }
  const presentations = events.filter(event => event.type === 'deliverables/presented' && inStage(event.seq, stage))
    .sort((a, b) => b.seq - a.seq)
  const selectors = new Map()
  let needed
  if (selection.selection === 'files') {
    if (!Array.isArray(selection.paths) || selection.paths.length === 0) throw invalid('Select at least one file')
    needed = new Set(selection.paths.map(path => files.normalize(path)))
    if (needed.size !== selection.paths.length) throw invalid('Duplicate file selection')
  } else if (selection.selection !== 'latest-presentation') {
    throw invalid('Unknown presentation selection')
  }

  for (const event of presentations) {
    const pathsInEvent = new Set()
    for (const [index, file] of event.data.files.entries()) {
      const path = files.normalize(file.path)
      if (pathsInEvent.has(path)) throw invalid('Ambiguous duplicate path in a presentation')
      pathsInEvent.add(path)
      if (!selectors.has(path) && (needed === undefined || needed.has(path))) {
        selectors.set(path, { seq: event.seq, index })
      }
    }
    if (needed === undefined || selectors.size === needed.size) break
  }
  if (selectors.size === 0 || (needed !== undefined && selectors.size !== needed.size)) {
    throw invalid('Selected files must be presented in the current Run stage')
  }

  const artifacts = []
  for (const [path, { seq, index }] of selectors) {
    artifacts.push({
      id: newArtifactId(),
      kind: 'file',
      locator: path,
      versionKind: 'sha256',
      version: await files.digest(path),
      source: sourceRef(sessionId, seq, now, index),
    })
  }
  return artifacts
}

/** Translate host-mapped check observations; raw model text is never read here. */
export function resolveMachineEvidence({ sessionId, checks, stage, criterionIds }) {
  const seen = new Set()
  const evidence = []
  for (const check of checks) {
    if (!inStage(check.seq, stage) || !criterionIds.has(check.criterionId)) continue
    if (!Number.isSafeInteger(check.exitCode) || check.exitCode < 0) continue
    const key = JSON.stringify([check.seq, check.criterionId])
    if (seen.has(key)) continue
    seen.add(key)
    evidence.push({
      criterionId: check.criterionId,
      kind: 'machine',
      outcome: check.exitCode === 0 ? 'pass' : 'fail',
      source: sourceRef(sessionId, check.seq, check.observedAt),
      observedAt: check.observedAt,
      summary: `Host check exited with code ${check.exitCode}`,
    })
  }
  return evidence
}

/** Recheck the submitted local file versions before attempting acceptance. */
export async function observeArtifactVersions(artifacts, files) {
  const observations = []
  for (const artifact of artifacts) {
    if (artifact.kind !== 'file' || artifact.versionKind !== 'sha256') continue
    try {
      observations.push({
        artifactId: artifact.id, versionKind: 'sha256', version: await files.digest(artifact.locator),
      })
    } catch (error) {
      if (!(error instanceof TaskError)) throw error
      throw new TaskError('ARTIFACT_DRIFT', 'A submitted file cannot be reverified')
    }
  }
  return observations
}
