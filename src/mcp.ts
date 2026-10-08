#!/usr/bin/env node
/** Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0). Tools mirror the CLI. */
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { check, renderVideo, sheet, still, validate } from './api.js'
import { docs } from './docs.js'
import { VideoMakerError } from './errors.js'
import { schema } from './spec/schema.js'
import { version } from './spec/project.js'

const input = { type: 'string', description: 'Path to a video description (.json/.yaml) or an HTML composition.' }
const formats = { type: 'array', items: { type: 'string' }, description: 'Formats to process (default: all).' }

const tools = [
  {
    name: 'validate',
    description: 'Validate a video description against the schema and compile every format (files, times, durations, caption speed). Returns issues with JSON paths and hints, plus scene timings.',
    inputSchema: { type: 'object', required: ['input'], properties: { input, formats } },
  },
  {
    name: 'check',
    description: 'validate + layout checks in the browser: text outside frame/safe area, overflow, overlaps, low contrast, caption lines.',
    inputSchema: { type: 'object', required: ['input'], properties: { input, formats, layout: { type: 'boolean', description: 'Run browser checks (default true).' } } },
  },
  {
    name: 'still',
    description: 'Render one frame and return it as image. time: seconds or "scene:<id>+1.5", "end-1".',
    inputSchema: {
      type: 'object',
      required: ['input'],
      properties: { input, format: { type: 'string' }, time: { type: ['string', 'number'] }, frame: { type: 'integer' }, out: { type: 'string' } },
    },
  },
  {
    name: 'contact_sheet',
    description: 'Render a grid of frames over the whole video (count) or per scene (perScene) as one PNG and return it, to review a video at a glance.',
    inputSchema: {
      type: 'object',
      required: ['input'],
      properties: { input, format: { type: 'string' }, count: { type: 'integer' }, perScene: { type: 'integer' }, columns: { type: 'integer' }, out: { type: 'string' } },
    },
  },
  {
    name: 'render',
    description: 'Render MP4 (H.264/AAC). With several formats "{format}" in out is replaced or "-<format>" appended. Unchanged scenes come from the cache.',
    inputSchema: {
      type: 'object',
      required: ['input', 'out'],
      properties: { input, out: { type: 'string' }, formats, parallel: { type: 'integer' }, cache: { type: ['string', 'boolean'], description: 'Cache directory or false.' } },
    },
  },
  { name: 'schema', description: 'JSON Schema of the video description.', inputSchema: { type: 'object', properties: {} } },
  { name: 'docs', description: 'Complete reference of the video description and the HTML composition contract.', inputSchema: { type: 'object', properties: {} } },
]

type Args = Record<string, any>
const text = (value: unknown) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) })
const image = async (file: string) => ({ type: 'image', mimeType: 'image/png', data: (await readFile(file)).toString('base64') })
const tmp = (name: string) => join(tmpdir(), `video-maker-${process.pid}-${Date.now()}-${name}`)

async function call(name: string, a: Args) {
  switch (name) {
    case 'validate':
      return { content: [text(await validate(a.input, { formats: a.formats }))] }
    case 'check': {
      const r = await check(a.input, { formats: a.formats, layout: a.layout })
      return { content: [text(r)], isError: !r.ok }
    }
    case 'still': {
      const r = await still(a.input, { out: a.out ?? tmp('still.png'), format: a.format, time: a.time, frame: a.frame })
      return { content: [text(r), await image(r.out)] }
    }
    case 'contact_sheet': {
      const r = await sheet(a.input, { out: a.out ?? tmp('sheet.png'), format: a.format, count: a.count, perScene: a.perScene, columns: a.columns })
      return { content: [text(r), await image(r.out)] }
    }
    case 'render':
      return { content: [text(await renderVideo(a.input, { out: a.out, formats: a.formats, parallel: a.parallel, cache: a.cache === true ? undefined : a.cache }))] }
    case 'schema':
      return { content: [text(schema)] }
    case 'docs':
      return { content: [text(docs)] }
    default:
      throw new VideoMakerError('usage', `Unknown tool ${name}`)
  }
}

export function runMcpServer(): Promise<void> {
  const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', async (line) => {
    if (!line.trim()) return
    let msg: { id?: number | string; method?: string; params?: any }
    try {
      msg = JSON.parse(line)
    } catch {
      return send({ id: null, error: { code: -32700, message: 'Parse error' } })
    }
    const { id, method, params } = msg
    if (id === undefined) return // notification
    try {
      switch (method) {
        case 'initialize':
          return send({
            id,
            result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'video-maker', version } },
          })
        case 'ping':
          return send({ id, result: {} })
        case 'tools/list':
          return send({ id, result: { tools } })
        case 'tools/call':
          try {
            return send({ id, result: await call(params.name, params.arguments ?? {}) })
          } catch (e) {
            const err = e instanceof VideoMakerError ? { kind: e.kind, exitCode: e.exitCode, message: e.message, issues: e.issues } : { message: String(e instanceof Error ? e.message : e) }
            return send({ id, result: { content: [text({ ok: false, error: err })], isError: true } })
          }
        default:
          return send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
      }
    } catch (e) {
      send({ id, error: { code: -32603, message: String(e) } })
    }
  })
  return new Promise((resolve) => lines.on('close', resolve))
}

const self = (() => {
  try {
    return pathToFileURL(realpathSync(process.argv[1] ?? '')).href
  } catch {
    return ''
  }
})()
if (import.meta.url === self) await runMcpServer()
