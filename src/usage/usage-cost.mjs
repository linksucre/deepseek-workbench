const currencyPattern = /^[A-Z]{3}$/
const rateFields = new Set(['uncachedInput', 'cacheRead', 'cacheWrite', 'output'])
const validPrice = value => typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)

function effectiveTime(rateDate) {
  if (typeof rateDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) return NaN
  const date = new Date(`${rateDate}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === rateDate ? date.getTime() : NaN
}

/** Build an offline rate lookup from explicitly supplied deployment rates. */
export function createRateLookup(rates = []) {
  const byRoute = new Map()
  for (const rate of rates) {
    const { provider, model, currency, rateDate, perMillion } = rate
    const effective = effectiveTime(rateDate)
    if (typeof provider !== 'string' || !provider || typeof model !== 'string' || !model ||
        !Number.isFinite(effective) || typeof currency !== 'string' || !currencyPattern.test(currency) ||
        perMillion === null || typeof perMillion !== 'object' || Array.isArray(perMillion) ||
        !Object.entries(perMillion).every(([field, amount]) => rateFields.has(field) && validPrice(amount))) {
      throw new TypeError('Invalid configured usage rate')
    }
    const key = JSON.stringify([provider, model])
    const entries = byRoute.get(key) ?? new Map()
    if (entries.has(effective)) throw new TypeError('Duplicate configured usage rate for route and date')
    entries.set(effective, Object.freeze({ currency, rateDate, perMillion: Object.freeze({ ...perMillion }) }))
    byRoute.set(key, entries)
  }
  const schedule = new Map([...byRoute].map(([key, entries]) =>
    [key, [...entries].sort(([left], [right]) => right - left)]))
  return ({ provider, model, time }) => schedule.get(JSON.stringify([provider, model]))
    ?.find(([effective]) => effective <= time)?.[1]
}

/** Quote rates per million tokens using decimal strings and a single currency. */
export function estimateCost(attempts, fields, lookupRate) {
  if (attempts.length === 0) return null
  let currency
  let rateDate
  let amount = 0n
  let scale = 0
  for (const { route, time, counts } of attempts) {
    const rate = lookupRate({ ...route, time })
    if (!rate || typeof rate.currency !== 'string' || !currencyPattern.test(rate.currency) ||
        (currency !== undefined && rate.currency !== currency)) return null
    const effective = effectiveTime(rate.rateDate)
    if (!Number.isFinite(effective) || !Number.isFinite(time) || effective > time) return null
    currency = rate.currency
    if (rateDate === undefined || rate.rateDate > rateDate) rateDate = rate.rateDate
    for (const field of fields) {
      if (counts[field] === 0) continue
      const price = rate.perMillion?.[field]
      if (!validPrice(price)) return null
      const [integer, fraction = ''] = price.split('.')
      const precision = Math.max(scale, fraction.length)
      amount *= 10n ** BigInt(precision - scale)
      amount += BigInt(counts[field]) * BigInt(integer + fraction) * 10n ** BigInt(precision - fraction.length)
      scale = precision
    }
  }
  const places = scale + 6
  const digits = amount.toString().padStart(places + 1, '0')
  const fraction = digits.slice(-places).replace(/0+$/, '')
  const decimalAmount = fraction ? `${digits.slice(0, -places)}.${fraction}` : digits.slice(0, -places)
  return { decimalAmount, currency, rateDate }
}
