import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { verifySchemaMeta } from '../../scripts/schema-meta.mjs'
import { assertCollaboratorTools } from '../integration/request-tools.mjs'

test('present alone does not hide missing file, research, or skill tools', () => {
  assert.throws(
    () => assertCollaboratorTools({ tools: [{ name: 'present' }] }),
    /Missing collaborator tools: read, write, edit, web_search, web_fetch, skill/,
  )
})

test('valid definition references do not make an invalid schema keyword valid', async () => {
  const schema = JSON.parse(await readFile(new URL('../../contracts/v1/schemas.json', import.meta.url), 'utf8'))
  verifySchemaMeta(schema)
  schema.$defs.TaskId.type = 'uuid'
  assert.throws(() => verifySchemaMeta(schema), /Invalid JSON Schema 2020-12.*TaskId\/type/)
})
