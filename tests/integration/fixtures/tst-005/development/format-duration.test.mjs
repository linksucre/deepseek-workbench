import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDuration } from './format-duration.mjs'

test('formats elapsed seconds as minutes and two-digit seconds', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(59), '0:59')
  assert.equal(formatDuration(60), '1:00')
  assert.equal(formatDuration(3605), '60:05')
})
