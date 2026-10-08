import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { CompositionOptions } from './render.js'
import { serve, type StaticServer } from './server.js'

/** Serve a local composition with a time slider at <url>/__video-maker/preview. */
export async function startPreview(options: CompositionOptions): Promise<StaticServer> {
  const [, path, suffix] = /^([^?#]*)(.*)$/.exec(options.input)!
  const file = resolve(path)
  if (!existsSync(file)) throw new Error(`Input not found: ${file}`)
  const root = resolve(options.root ?? dirname(file))
  const page = '/' + relative(root, file).split(/[\\/]/).map(encodeURIComponent).join('/') + suffix
  const server = await serve({
    root,
    preview: {
      page,
      runtime: {
        epoch: options.epoch ?? Date.UTC(2026, 0, 1),
        seed: options.seed ?? 1,
        defaults: { width: options.width, height: options.height, fps: options.fps, frames: options.frames, duration: options.duration },
      },
    },
  })
  return { url: server.url + '/__video-maker/preview', close: server.close }
}
