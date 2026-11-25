import Ajv2020 from 'ajv/dist/2020.js'

const ajv = new Ajv2020({ allErrors: true, strict: false })
const draft = 'https://json-schema.org/draft/2020-12/schema'

export function verifySchemaMeta(schema) {
  if (schema?.$schema !== draft) {
    throw new Error(`Expected JSON Schema 2020-12 ($schema: ${draft})`)
  }
  if (!ajv.validateSchema(schema)) {
    throw new Error(`Invalid JSON Schema 2020-12: ${ajv.errorsText(ajv.errors)}`)
  }
}
