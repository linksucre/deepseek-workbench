import { createRateLookup } from './usage-cost.mjs'

const decimal = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/
const currency = /^[A-Z]{3}$/

function scaled(amount, precision) {
  const [whole, fraction = ''] = amount.split('.')
  return BigInt(whole + fraction.padEnd(precision, '0'))
}

function atLeast(left, right) {
  const precision = Math.max(left.split('.')[1]?.length ?? 0, right.split('.')[1]?.length ?? 0)
  return scaled(left, precision) >= scaled(right, precision)
}

/** Deployment policy is offline and optional. Budget comparisons never block execution. */
export function createUsagePolicy(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some(key => !['rates', 'softBudget'].includes(key)) ||
      (config.rates !== undefined && !Array.isArray(config.rates))) {
    throw new TypeError('Invalid Workbench usage policy')
  }
  const lookupRate = createRateLookup(config.rates)
  const budget = config.softBudget
  if (budget !== undefined && (!budget || typeof budget !== 'object' || Array.isArray(budget) ||
      Object.keys(budget).some(key => !['currency', 'decimalAmount'].includes(key)) ||
      typeof budget.decimalAmount !== 'string' || !decimal.test(budget.decimalAmount) ||
      typeof budget.currency !== 'string' || !currency.test(budget.currency) ||
      scaled(budget.decimalAmount, 12) <= 0n)) {
    throw new TypeError('Invalid Workbench soft budget')
  }

  return {
    lookupRate,
    applyBudget(summary) {
      if (budget === undefined) return summary
      const estimate = summary.estimatedCost
      const comparison = !estimate || estimate.currency !== budget.currency ? 'unknown'
        : atLeast(estimate.decimalAmount, budget.decimalAmount) ? 'reached' : 'within'
      return { ...summary, softBudget: { currency: budget.currency, decimalAmount: budget.decimalAmount, comparison } }
    },
  }
}
