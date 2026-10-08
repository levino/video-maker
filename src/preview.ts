import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { VideoMakerError } from './errors.js'
import { playerPage, playerPath } from './player/page.js'
import { previewPage } from './preview-page.js'
import type { CompositionOptions } from './render.js'
import { serve, type ServeOptions, type StaticServer } from './server.js'
import { isSpecFile, readSpecFile } from './spec/load.js'
import { prepare } from './spec/project.js'
import type { VideoSpec } from './spec/types.js'

/**
 * Serve a composition (HTML or video description) with a time slider at <url>.
 * Descriptions are recompiled on every page load, so edits show up after a reload.
 */
export async function startPreview(options: CompositionOptions & { format?: string; ffmpegPath?: string }): Promise<StaticServer> {
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
  if (isSpecFile(file)) {
    const format = options.format ?? Object.keys((readSpecFile(file) as VideoSpec).formats)[0]
    let html = playerPage((await prepare(file, format, options)).plan)
    routes[playerPath] = { type: 'text/html; charset=utf-8', body: () => html }
    // recompile in the background whenever the preview page is requested
    routes['/__video-maker/preview'] = {
      type: 'text/html; charset=utf-8',
      body: () => {
        prepare(file, format, options).then(
          (c) => (html = playerPage(c.plan)),
          (e) => console.error(e.message),
        )
        return previewPage(playerPath)
      },
    }
    page = playerPath
  } else routes['/__video-maker/preview'] = { type: 'text/html; charset=utf-8', body: previewPage(page) }
  const server = await serve({ root, routes, inject: runtime })
  return { url: server.url + '/__video-maker/preview', close: server.close }
}
