/** Quote rates per million tokens using decimal strings and a single currency. */
export function estimateCost(attempts, fields, lookupRate) {
  if (attempts.length === 0) return null
  let currency
  let rateDate
  let amount = 0n
  let scale = 0
  for (const { route, time, counts } of attempts) {
    const rate = lookupRate({ ...route, time })
    if (!rate || !/^[A-Z]{3}$/.test(rate.currency) || !/^\d{4}-\d{2}-\d{2}$/.test(rate.rateDate) ||
        (currency !== undefined && rate.currency !== currency)) return null
    const effective = new Date(`${rate.rateDate}T00:00:00Z`)
    if (!Number.isFinite(effective.getTime()) || effective.toISOString().slice(0, 10) !== rate.rateDate ||
        !Number.isFinite(time) || effective.getTime() > time) return null
    currency = rate.currency
    if (rateDate === undefined || rate.rateDate > rateDate) rateDate = rate.rateDate
    for (const field of fields) {
      if (counts[field] === 0) continue
      const price = rate.perMillion?.[field]
      if (typeof price !== 'string' || !/^\d+(\.\d+)?$/.test(price)) return null
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
