#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { parseAudioSpec } from './audio.js'
import { render, renderStill } from './render.js'
import { startPreview } from './preview.js'

const help = `video-maker – Webseiten Bild für Bild als Video rendern

  video-maker render <eingabe.html|url> --out film.mp4 [Optionen]
  video-maker still  <eingabe.html|url> --frame n --out bild.png [Optionen]
  video-maker preview <eingabe.html> [Optionen]

Komposition (überschreibt window.videoMaker):
  --width, --height, --fps
  --duration, --dauer <s>     Länge in Sekunden (z. B. 12 oder 12.5s)
  --frames <n>                Länge in Bildern
  --root <ordner>             Ordner, der für lokale Eingaben ausgeliefert wird

render:
  --audio <datei[@start][,vol=x]>  mehrfach möglich, z. B. sprecher.mp3@0.3s
  --parallel <n>              parallele Seiten (Standard 4)
  --image-format jpeg|png     Bilder zur Pipe (Standard jpeg)
  --quality <0-100>           JPEG-Qualität (Standard 95)
  --crf <n>, --preset <name>  x264-Einstellungen (Standard 18, medium)
  --from <n>, --to <n>        nur einen Ausschnitt rendern
  --ffmpeg <pfad>             sonst $VIDEO_MAKER_FFMPEG, ffmpeg-static, PATH

still:
  --frame <n>, --format png|jpeg

Allgemein: --verbose (Konsole der Seite zeigen), --help`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    width: { type: 'string' },
    height: { type: 'string' },
    fps: { type: 'string' },
    duration: { type: 'string' },
    dauer: { type: 'string' },
    frames: { type: 'string' },
    root: { type: 'string' },
    audio: { type: 'string', multiple: true },
    parallel: { type: 'string' },
    'image-format': { type: 'string' },
    quality: { type: 'string' },
    crf: { type: 'string' },
    preset: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    ffmpeg: { type: 'string' },
    frame: { type: 'string' },
    format: { type: 'string' },
    port: { type: 'string' },
    verbose: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
})

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v.replace(/s$/, '')))
const [command, input] = positionals

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (values.help || !command) {
  console.log(help)
  process.exit(command || values.help ? 0 : 1)
}
if (!input) fail(`Eingabe fehlt.\n\n${help}`)

const composition = {
  input,
  root: values.root,
  width: num(values.width),
  height: num(values.height),
  fps: num(values.fps),
  frames: num(values.frames),
  duration: num(values.duration ?? values.dauer),
  verbose: values.verbose,
}

try {
  if (command === 'render') {
    if (!values.out) fail('--out fehlt')
    const range: [number, number] | undefined =
      values.from !== undefined || values.to !== undefined ? [num(values.from) ?? 0, num(values.to) ?? Infinity] : undefined
    let last = 0
    const result = await render({
      ...composition,
      out: values.out,
      audio: values.audio?.map(parseAudioSpec),
      parallel: num(values.parallel),
      imageFormat: values['image-format'] as 'jpeg' | 'png' | undefined,
      quality: num(values.quality),
      crf: num(values.crf),
      preset: values.preset,
      ffmpegPath: values.ffmpeg,
      range,
      onProgress(done, total) {
        const now = Date.now()
        if (process.stderr.isTTY && (now - last > 200 || done === total)) {
          last = now
          process.stderr.write(`\r${done}/${total} Bilder (${Math.round((done / total) * 100)} %)`)
        }
      },
    })
    if (process.stderr.isTTY) process.stderr.write('\n')
    const { width, height, fps } = result.meta
    console.log(`${result.out}: ${result.frames} Bilder, ${width}×${height} @ ${fps} fps, ${result.seconds.toFixed(1)} s Renderzeit`)
  } else if (command === 'still') {
    if (!values.out) fail('--out fehlt')
    await renderStill({ ...composition, frame: num(values.frame) ?? 0, out: values.out, format: values.format as 'png' | 'jpeg' | undefined })
    console.log(values.out)
  } else if (command === 'preview') {
    const server = await startPreview(composition)
    console.log(`Vorschau: ${server.url}  (Strg+C beendet)`)
  } else {
    fail(`Unbekannter Befehl: ${command}\n\n${help}`)
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
}
