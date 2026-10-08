import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installRuntime, type RuntimeOptions } from './runtime.js'

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt',
  '.srt': 'text/plain; charset=utf-8',
}

const lib = (dir: string) => resolve(fileURLToPath(new URL(`./${dir}/`, import.meta.url)))
const mounts: [string, string][] = [
  ['/__video-maker/kit/', lib('kit')],
  ['/__video-maker/player/', lib('player')],
]

export interface StaticServer {
  url: string
  close(): Promise<void>
}

export interface ServeOptions {
  root: string
  /** Generated responses by exact path. */
  routes?: Record<string, { type: string; body?: string | (() => string); file?: string }>
  /** Inject the runtime into served HTML (needed when no Playwright init script runs, i.e. preview). */
  inject?: RuntimeOptions
}

export const runtimeScript = (options: RuntimeOptions) => `<script>(${installRuntime.toString()})(${JSON.stringify(options)})</script>`

/** Serves `root` on 127.0.0.1 with a random port, plus the kit and player under /__video-maker/. */
export async function serve(options: ServeOptions): Promise<StaticServer> {
  const root = resolve(options.root)
  const server: Server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      const route = options.routes?.[path]
      if (route?.file) {
        res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' })
        return createReadStream(route.file).pipe(res)
      }
      if (route) {
        let body = (typeof route.body === 'function' ? route.body() : route.body) ?? ''
        if (options.inject && route.type.startsWith('text/html') && !path.endsWith('/preview')) body = inject(body, options.inject)
        res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' })
        return res.end(body)
      }
      const mount = mounts.find(([prefix]) => path.startsWith(prefix))
      const [base, rel] = mount ? [mount[1], path.slice(mount[0].length)] : [root, path]
      let file = normalize(join(base, rel))
      if (file !== base && !file.startsWith(base + sep)) {
        res.writeHead(403)
        return res.end()
      }
      let info = await stat(file).catch(() => undefined)
      if (info?.isDirectory()) {
        file = join(file, 'index.html')
        info = await stat(file).catch(() => undefined)
      }
      if (!info) {
        res.writeHead(404)
        return res.end('not found')
      }
      const type = types[extname(file).toLowerCase()] ?? 'application/octet-stream'
      if (options.inject && type === types['.html']) {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
        return res.end(inject(await readFile(file, 'utf8'), options.inject))
      }
      res.writeHead(200, { 'content-type': type, 'content-length': info.size, 'cache-control': 'no-store' })
      createReadStream(file).pipe(res)
    } catch (e) {
      res.writeHead(500)
      res.end(String(e))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

function inject(html: string, runtime: RuntimeOptions) {
  const script = runtimeScript(runtime)
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + script) : script + html
}
