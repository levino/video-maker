import { existsSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import type { AudioTrack } from './audio.js'
import { VideoMakerError } from './errors.js'
import { playerPage, playerPath } from './player/page.js'
import { previewPage } from './preview-page.js'
import type { CompositionOptions } from './render.js'
import { serve, type ServeOptions, type StaticServer } from './server.js'
import { isSpecFile, readSpecFile } from './spec/load.js'
import { prepare } from './spec/project.js'
import type { VideoSpec } from './spec/types.js'

const audioTypes: Record<string, string> = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac' }

/**
 * Serve a composition (HTML or video description) with a time slider and sound at <url>.
 * Descriptions are recompiled whenever the preview page is loaded, so edits show up after a reload.
 */
export async function startPreview(options: CompositionOptions & { format?: string; ffmpegPath?: string; audio?: AudioTrack[] }): Promise<StaticServer> {
  const [, path, suffix] = /^([^?#]*)(.*)$/.exec(options.input)!
  const file = resolve(path)
  if (!existsSync(file)) throw new VideoMakerError('missingFile', `Input not found: ${file}`)
  const root = resolve(options.root ?? dirname(file))
  const runtime = {
    epoch: options.epoch ?? Date.UTC(2026, 0, 1),
    seed: options.seed ?? 1,
    defaults: { width: options.width, height: options.height, fps: options.fps, frames: options.frames, duration: options.duration },
  }
  let page = '/' + relative(root, file).split(/[\\/]/).map(encodeURIComponent).join('/') + suffix
  const routes: NonNullable<ServeOptions['routes']> = {}
  let tracks: AudioTrack[] = options.audio ?? []
  // audio files are served under stable numbered paths; the track list is JSON
  const audioRoutes = () => {
    tracks.forEach((t, i) => (routes[`/__video-maker/audio/${i}`] = { type: audioTypes[extname(t.file).toLowerCase()] ?? 'application/octet-stream', file: t.file }))
    return JSON.stringify(tracks.map((t, i) => ({ ...t, file: undefined, url: `/__video-maker/audio/${i}` })))
  }
  routes['/__video-maker/audio.json'] = { type: 'application/json', body: () => audioRoutes() }
  if (isSpecFile(file)) {
    const format = options.format ?? Object.keys((readSpecFile(file) as VideoSpec).formats)[0]
    const first = await prepare(file, format, options)
    let html = playerPage(first.plan)
    tracks = first.audio
    routes[playerPath] = { type: 'text/html; charset=utf-8', body: () => html }
    routes['/__video-maker/preview'] = {
      type: 'text/html; charset=utf-8',
      body: () => {
        prepare(file, format, options).then(
          (c) => {
            html = playerPage(c.plan)
            tracks = c.audio
          },
          (e) => console.error(e.message),
        )
        return previewPage(playerPath)
      },
    }
    page = playerPath
  } else routes['/__video-maker/preview'] = { type: 'text/html; charset=utf-8', body: previewPage(page) }
  audioRoutes()
  const server = await serve({ root, routes, inject: runtime })
  return { url: server.url + '/__video-maker/preview', close: server.close }
}
