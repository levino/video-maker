#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { check, renderVideo, sheet, still, validate } from './api.js'
import { parseAudioSpec } from './audio.js'
import { docs } from './docs.js'
import { exitCodes, VideoMakerError, type Issue } from './errors.js'
import { startPreview } from './preview.js'
import { schema } from './spec/schema.js'

const help = `video-maker – Videos aus einer Beschreibung (JSON/YAML) oder einer Webseite rendern

  video-maker render   <eingabe> --out film.mp4 [--format name …]
  video-maker still    <eingabe> --out bild.png [--time 12.5 | --time scene:intro+2 | --frame n]
  video-maker sheet    <eingabe> --out bogen.png [--count 12 | --per-scene 2]   (Kontaktbogen)
  video-maker check    <eingabe> [--no-layout]                                  (auch: lint, pruefen)
  video-maker validate <beschreibung>
  video-maker schema | docs | preview <eingabe> | mcp

<eingabe>: Beschreibung (.json/.yaml/.yml) oder HTML-Datei/URL nach dem Kompositionsvertrag.
Alle Befehle: --json (maschinenlesbare Ausgabe), --root <ordner>, --ffmpeg <pfad>, --verbose.
Exit-Codes: 0 ok, 1 intern, 2 Aufruf, 3 Beschreibung ungültig, 4 Datei fehlt, 5 Prüfung mit Fehlern, 6 Rendern fehlgeschlagen.
Vollständige Referenz: video-maker docs`

const aliases: Record<string, string> = { kontaktbogen: 'sheet', 'contact-sheet': 'sheet', lint: 'check', pruefen: 'check', doku: 'docs', standbild: 'still' }

let json = process.argv.includes('--json')

function print(result: unknown, text: string) {
  console.log(json ? JSON.stringify(result, null, 2) : text)
}

function formatIssues(issues: Issue[]) {
  return issues
    .map((i) => {
      const where = [i.format, i.path, i.time !== undefined ? `${i.time}s` : undefined].filter(Boolean).join(' ')
      return `${i.severity === 'error' ? 'Fehler' : 'Warnung'} [${i.code}] ${where}\n  ${i.message}${i.hint ? `\n  → ${i.hint}` : ''}`
    })
    .join('\n')
}

function exit(code: number, result: unknown, text: string): never {
  if (json) console.log(JSON.stringify(result, null, 2))
  else if (text) (code === 0 ? console.log : console.error)(text)
  process.exit(code)
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      format: { type: 'string', multiple: true },
      time: { type: 'string', short: 't' },
      frame: { type: 'string' },
      count: { type: 'string' },
      'per-scene': { type: 'string' },
      columns: { type: 'string' },
      'thumb-width': { type: 'string' },
      layout: { type: 'boolean', default: true },
      'no-layout': { type: 'boolean' },
      cache: { type: 'string' },
      'no-cache': { type: 'boolean' },
      parallel: { type: 'string' },
      'image-format': { type: 'string' },
      quality: { type: 'string' },
      crf: { type: 'string' },
      preset: { type: 'string' },
      ffmpeg: { type: 'string' },
      root: { type: 'string' },
      audio: { type: 'string', multiple: true },
      width: { type: 'string' },
      height: { type: 'string' },
      fps: { type: 'string' },
      duration: { type: 'string' },
      frames: { type: 'string' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  json = !!values.json
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v.replace(/s$/, '')))
  const command = aliases[positionals[0]] ?? positionals[0]
  const input = positionals[1]
  if (values.help || !command) exit(command || values.help ? 0 : exitCodes.usage, { ok: !!values.help, help }, help)

  const common = {
    root: values.root,
    ffmpegPath: values.ffmpeg,
    verbose: values.verbose,
    html: { width: num(values.width), height: num(values.height), fps: num(values.fps), frames: num(values.frames), duration: num(values.duration) },
  }
  const needInput = () => {
    if (!input) throw new VideoMakerError('usage', `"${command}" needs an input file.`)
  }
  const needOut = () => {
    if (!values.out) throw new VideoMakerError('usage', `"${command}" needs --out <file>.`)
  }

  switch (command) {
    case 'schema':
      return console.log(JSON.stringify(schema, null, 2))
    case 'docs':
      return console.log(docs)
    case 'validate': {
      needInput()
      const r = await validate(input, { ...common, formats: values.format })
      const summary = r.formats.map((f) => `${f.name}: ${f.width}×${f.height} @ ${f.fps} fps, ${f.duration} s, ${f.scenes.length} Szenen`).join('\n')
      const code = r.ok ? 0 : r.issues.filter((i) => i.severity === 'error').every((i) => i.code === 'file-missing') ? exitCodes.missingFile : exitCodes.invalidSpec
      return exit(code, { ...r, exitCode: code }, [r.ok ? 'gültig' : 'ungültig', summary, formatIssues(r.issues)].filter(Boolean).join('\n'))
    }
    case 'check': {
      needInput()
      const r = await check(input, { ...common, formats: values.format, layout: values.layout && !values['no-layout'] })
      const code = r.ok ? 0 : exitCodes.checkFailed
      return exit(code, { ...r, exitCode: code }, `${r.errors} Fehler, ${r.warnings} Warnungen\n${formatIssues(r.issues)}`.trim())
    }
    case 'still': {
      needInput()
      needOut()
      const r = await still(input, {
        ...common,
        out: values.out!,
        format: values.format?.[0],
        time: values.time,
        frame: num(values.frame),
        imageFormat: values['image-format'] as 'png' | 'jpeg' | undefined,
      })
      return print({ ok: true, ...r }, `${r.out} (Bild ${r.frame}, ${r.time} s)`)
    }
    case 'sheet': {
      needInput()
      needOut()
      const r = await sheet(input, {
        ...common,
        out: values.out!,
        format: values.format?.[0],
        count: num(values.count),
        perScene: num(values['per-scene']),
        columns: num(values.columns),
        thumbWidth: num(values['thumb-width']),
      })
      return print({ ok: true, ...r }, `${r.out} (${r.frames.length} Bilder)`)
    }
    case 'render': {
      needInput()
      needOut()
      let last = 0
      const results = await renderVideo(input, {
        ...common,
        out: values.out!,
        formats: values.format,
        cache: values['no-cache'] ? false : values.cache,
        parallel: num(values.parallel),
        imageFormat: values['image-format'] as 'jpeg' | 'png' | undefined,
        quality: num(values.quality),
        crf: num(values.crf),
        preset: values.preset,
        audio: values.audio?.map(parseAudioSpec),
        onProgress(format, done, total) {
          const now = Date.now()
          if (!json && process.stderr.isTTY && (now - last > 250 || done === total)) {
            last = now
            process.stderr.write(`\r${format}: ${done}/${total} Bilder (${Math.round((done / total) * 100)} %)   `)
          }
        },
      })
      if (!json && process.stderr.isTTY) process.stderr.write('\n')
      return print(
        { ok: true, results },
        results
          .map((r) => `${r.out}: ${r.width}×${r.height} @ ${r.fps} fps, ${r.frames} Bilder, ${r.seconds} s Renderzeit${r.scenesCached ? `, ${r.scenesCached} Szenen aus dem Cache` : ''}`)
          .join('\n'),
      )
    }
    case 'preview': {
      needInput()
      const server = await startPreview({ input, root: values.root, format: values.format?.[0], ffmpegPath: values.ffmpeg, ...common.html })
      return print({ ok: true, url: server.url }, `Vorschau: ${server.url}  (Strg+C beendet)`)
    }
    case 'mcp': {
      const { runMcpServer } = await import('./mcp.js')
      return runMcpServer()
    }
    default:
      throw new VideoMakerError('usage', `Unknown command "${positionals[0]}". Commands: render, still, sheet, check, validate, schema, docs, preview, mcp.`)
  }
}

main().catch((e: unknown) => {
  const err =
    e instanceof VideoMakerError
      ? e
      : (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || (e as { code?: string }).code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
        ? new VideoMakerError('usage', (e as Error).message)
        : new VideoMakerError('internal', e instanceof Error ? (e.stack ?? e.message) : String(e))
  exit(
    err.exitCode,
    { ok: false, exitCode: err.exitCode, error: { kind: err.kind, message: err.message, issues: err.issues } },
    `${err.message}${err.issues.length ? '\n' + formatIssues(err.issues) : ''}`,
  )
})
