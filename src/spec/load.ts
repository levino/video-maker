import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv'
import { parse as parseYaml } from 'yaml'
import { closest, VideoMakerError, type Issue } from '../errors.js'
import { schema } from './schema.js'
import type { VideoSpec } from './types.js'

let validators: { spec: ValidateFunction; layer: ValidateFunction } | undefined

function getValidators() {
  if (!validators) {
    // verbose: errors carry parentSchema, which the hints need (allowed properties, descriptions)
    const ajv = new Ajv({ allErrors: true, discriminator: true, strict: false, verbose: true })
    ajv.addSchema(schema, 'spec')
    validators = { spec: ajv.getSchema('spec')!, layer: ajv.getSchema('spec#/definitions/layer')! }
  }
  return validators
}

const isSpecFile = (path: string) => ['.json', '.yaml', '.yml'].includes(extname(path.replace(/[?#].*$/, '')).toLowerCase())
export { isSpecFile }

export function readSpecFile(file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new VideoMakerError('missingFile', `Description not found: ${file}`, [
      { code: 'file-missing', severity: 'error', message: `File not found: ${file}`, hint: 'Check the path.' },
    ])
  }
  try {
    // YAML: anchors, aliases and merge keys (<<: *base) are allowed to avoid repetition
    return extname(file).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text, { merge: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new VideoMakerError('invalidSpec', `Cannot parse ${file}: ${message}`, [
      { code: 'parse-error', severity: 'error', message, hint: 'Fix the JSON/YAML syntax at the reported position.' },
    ])
  }
}

function pointerGet(root: unknown, pointer: string): unknown {
  let node = root as any
  for (const part of pointer.split('/').slice(1)) node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  return node
}

function toIssue(e: ErrorObject, root: unknown, basePath = ''): Issue {
  const path = basePath + e.instancePath
  const p = e.params as Record<string, any>
  switch (e.keyword) {
    case 'additionalProperties': {
      let allowed = Object.keys((e.parentSchema as any)?.properties ?? {})
      if (!allowed.length) {
        // layers: ajv reports against the discriminated union; look up the branch for this type
        const type = (pointerGet(root, e.instancePath) as { type?: string } | undefined)?.type
        const branch = (schema.definitions.layer.oneOf as readonly { properties: Record<string, any> }[]).find((b) => b.properties.type.const === type)
        allowed = Object.keys(branch?.properties ?? {})
      }
      const guess = closest(p.additionalProperty, allowed)
      return {
        code: 'unknown-property',
        severity: 'error',
        path: `${path}/${p.additionalProperty}`,
        message: `Unknown property "${p.additionalProperty}".`,
        hint: guess ? `Did you mean "${guess}"?` : `Allowed: ${allowed.join(', ')}.`,
      }
    }
    case 'required':
      return { code: 'missing-property', severity: 'error', path, message: `Missing required property "${p.missingProperty}".`, hint: `Add "${p.missingProperty}".` }
    case 'enum':
    case 'const': {
      const allowed: unknown[] = p.allowedValues ?? [p.allowedValue]
      const value = pointerGet(root, e.instancePath)
      const guess = typeof value === 'string' ? closest(value, allowed.map(String)) : undefined
      return {
        code: 'invalid-value',
        severity: 'error',
        path,
        message: `Value ${JSON.stringify(value)} is not allowed.`,
        hint: guess ? `Did you mean "${guess}"?` : `Use one of: ${allowed.map((a) => JSON.stringify(a)).join(', ')}.`,
      }
    }
    case 'discriminator': {
      const types = (schema.definitions.layer.oneOf as readonly { properties: Record<string, any> }[]).map((b) => b.properties.type.const as string)
      const value = p.tagValue ?? pointerGet(root, `${e.instancePath}/type`)
      const guess = typeof value === 'string' ? closest(value, types) : undefined
      return {
        code: 'invalid-layer-type',
        severity: 'error',
        path: `${path}/type`,
        message: `Unknown layer type ${JSON.stringify(value)}.`,
        hint: guess ? `Did you mean "${guess}"?` : `Use one of: ${types.join(', ')}.`,
      }
    }
    default:
      return { code: 'invalid-value', severity: 'error', path, message: `${e.message ?? 'invalid'}.`, hint: (e.parentSchema as any)?.description }
  }
}

/** Collapse ajv's anyOf noise: keep the most specific error per path. */
function issuesFrom(errors: ErrorObject[], root: unknown, basePath = ''): Issue[] {
  const relevant = errors.filter((e) => e.keyword !== 'anyOf' && e.keyword !== 'oneOf' && e.keyword !== 'if')
  const byPath = new Map<string, Issue>()
  for (const e of relevant) {
    const issue = toIssue(e, root, basePath)
    // one entry per path, except several missing properties at the same place
    const key = issue.code === 'missing-property' ? `${issue.path}|${issue.message}` : (issue.path ?? '')
    const known = byPath.get(key)
    // prefer unknown-property / missing-property over type errors from other anyOf branches
    if (!known || (known.code === 'invalid-value' && issue.code !== 'invalid-value')) byPath.set(key, issue)
  }
  return [...byPath.values()]
}

export function validateSpec(data: unknown): Issue[] {
  const { spec } = getValidators()
  return spec(data) ? [] : issuesFrom(spec.errors ?? [], data)
}

/** Validate one layer (used after merging per-format overrides). */
export function validateLayer(data: unknown, path: string): Issue[] {
  const { layer } = getValidators()
  return layer(data) ? [] : issuesFrom(layer.errors ?? [], data, path)
}

export function loadSpec(file: string): VideoSpec {
  const data = readSpecFile(file)
  const issues = validateSpec(data)
  if (issues.length) throw new VideoMakerError('invalidSpec', `Invalid description: ${issues.length} problem(s)`, issues)
  return data as VideoSpec
}
