import assert from 'node:assert/strict'

const collaboratorTools = [
  'read', 'write', 'edit', 'web_search', 'web_fetch', 'skill', 'present',
]

export function assertCollaboratorTools(request) {
  const names = new Set((request.tools ?? []).map(tool => tool.name))
  const missing = collaboratorTools.filter(name => !names.has(name))
  assert.equal(missing.length, 0, `Missing collaborator tools: ${missing.join(', ')}`)
}
