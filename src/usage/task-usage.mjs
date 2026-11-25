import { estimateCost } from './usage-cost.mjs'

const fields = {
  uncachedInput: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens',
}
const usageFields = Object.keys(fields)
const maxTokens = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Fold native history for already-authorized Run bindings. Observations contain
 * the complete native history at their cut, an exclusive Run start cursor, and
 * the Host's inherited prefix length. No model calls or storage writes occur.
 */
export function summarizeTaskUsage({ taskId, sessions, missingSessions = 0, lookupRate = () => undefined,
  zeroMayBeDefault = ({ provider }) => provider === 'deepseek-official',
}) {
  const coverageNotes = []
  if (missingSessions > 0) coverageNotes.push(`${missingSessions} bound or expected session(s) could not be verified.`)
  const attempts = []
  for (const scope of sessionScopes(sessions, coverageNotes)) {
    for (const attempt of settlements(scope)) attempts.push(attempt)
  }

  const buckets = new Map()
  let missingUsage = 0
  let missingRoute = 0
  for (const attempt of attempts) {
    if (!attempt.route) {
      missingRoute += 1
      continue
    }
    const { provider, model } = attempt.route
    const key = JSON.stringify([provider, model])
    const bucket = buckets.get(key) ?? { provider, model, counts: {} }
    buckets.set(key, bucket)
    attempt.counts = {}
    for (const field of usageFields) {
      const value = attempt.usage?.[fields[field]]
      const isDefault = value === 0 && (field === 'uncachedInput' || field === 'output') && zeroMayBeDefault(attempt.route)
      if (!Number.isSafeInteger(value) || value < 0 || isDefault) continue
      attempt.counts[field] = value
      bucket.counts[field] = (bucket.counts[field] ?? 0n) + BigInt(value)
    }
    if (Object.keys(attempt.counts).length !== usageFields.length) missingUsage += 1
  }
  if (missingRoute) coverageNotes.push(`${missingRoute} attempt(s) have no verified provider and model.`)
  if (missingUsage) coverageNotes.push(`${missingUsage} attempt(s) have missing or ambiguous token counts. Partial totals include available fields only.`)
  let overflow = false
  const reported = [...buckets.values()].map(({ provider, model, counts }) => ({
    provider, model,
    ...Object.fromEntries(usageFields.map(field => {
      const total = counts[field]
      if (total > maxTokens) overflow = true
      return [field, total !== undefined && total <= maxTokens ? Number(total) : null]
    })),
  }))
  if (overflow) coverageNotes.push('Some token totals exceed the supported integer range.')
  const known = reported.some(bucket => usageFields.some(field => bucket[field] !== null))
  const completeness = coverageNotes.length === 0 ? 'complete' : known ? 'partial' : 'unknown'
  const estimatedCost = completeness === 'complete' ? estimateCost(attempts, usageFields, lookupRate) : null
  return { taskId, completeness, coverageNotes, buckets: reported, estimatedCost }
}

function sessionScopes(sessions, coverageNotes) {
  const scopes = new Map()
  for (const { sessionId, afterSeq, inheritedEventCount, events } of sessions) {
    const scope = scopes.get(sessionId) ?? { afterSeq, inheritedEventCount, events: new Map(), conflict: false }
    scopes.set(sessionId, scope)
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 ||
        !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 ||
        scope.afterSeq !== afterSeq || scope.inheritedEventCount !== inheritedEventCount) {
      scope.conflict = true
      continue
    }
    for (const event of events) {
      const previous = scope.events.get(event.seq)
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) scope.conflict = true
      scope.events.set(event.seq, event)
    }
  }
  const verified = []
  for (const scope of scopes.values()) {
    const events = [...scope.events.values()].sort((a, b) => a.seq - b.seq)
    if (scope.conflict || events.some((event, index) => event.seq !== index) ||
        scope.afterSeq >= events.length || scope.inheritedEventCount > events.length) {
      coverageNotes.push('An observed session had conflicting or incomplete history and was excluded.')
      continue
    }
    verified.push({ start: Math.max(scope.afterSeq + 1, scope.inheritedEventCount), events })
  }
  return verified
}

function settlements({ start, events }) {
  const attempts = []
  const current = new Map()
  let route
  for (const event of events) {
    const { type, data, seq, time } = event
    if (type === 'request/context' || type === 'request/header') {
      const config = type === 'request/context' ? data : data.config
      if (config?.provider && config.model) route = { provider: config.provider, model: config.model }
    }
    if (!['step/start', 'llm/retry-started', 'assistant/message', 'assistant/attempt'].includes(type)) continue
    const key = `${data.turn}:${data.step}`
    let attempt = current.get(key)
    if (!attempt || type === 'step/start' || type === 'llm/retry-started') {
      attempt = { route, time, inScope: seq >= start }
      current.set(key, attempt)
      if (attempt.inScope) attempts.push(attempt)
    }
    if (type === 'assistant/message' || type === 'assistant/attempt') {
      const usage = data.usage ?? data.stream?.findLast(record => record.type === 'chunk' && record.chunk.type === 'usage')?.chunk.usage
      if (usage !== undefined || attempt.usage === undefined) attempt.route = route
      if (usage !== undefined) attempt.usage = usage
    }
  }
  return attempts
}
