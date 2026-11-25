import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUsagePolicy } from '../../src/usage/usage-policy.mjs'

test('soft budgets compare exact decimals only within the estimated currency', () => {
  const policy = createUsagePolicy({ softBudget: { currency: 'CNY', decimalAmount: '0.0000001' } })
  const result = (decimalAmount, currency = 'CNY') =>
    policy.applyBudget({ estimatedCost: { decimalAmount, currency } }).softBudget.comparison
  assert.equal(result('0.0000000999999'), 'within')
  assert.equal(result('0.0000001000000'), 'reached')
  assert.equal(result('1', 'USD'), 'unknown')
  assert.equal(policy.applyBudget({ estimatedCost: null }).softBudget.comparison, 'unknown')
  assert.throws(() => createUsagePolicy({ softBudget: { currency: 'CNY', decimalAmount: 100 } }), /Invalid/)
})
