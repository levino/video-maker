import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { AudioMixPlan } from './audio.js'

const require = createRequire(import.meta.url)

/** Explicit path > $VIDEO_MAKER_FFMPEG > optional package ffmpeg-static > "ffmpeg" on PATH. */
export function resolveFfmpeg(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.VIDEO_MAKER_FFMPEG) return process.env.VIDEO_MAKER_FFMPEG
  try {
    const path = require('ffmpeg-static') as string | null
    if (path) return path
  } catch {}
  return 'ffmpeg'
}

/** Explicit path > $VIDEO_MAKER_FFPROBE > package ffprobe-static > "ffprobe" on PATH. */
export function resolveFfprobe(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.VIDEO_MAKER_FFPROBE) return process.env.VIDEO_MAKER_FFPROBE
  try {
    return (require('ffprobe-static') as { path: string }).path
  } catch {}
  return 'ffprobe'
}

export interface EncodeOptions {
  fps: number
  width: number
  height: number
  frames: number
  imageFormat: 'jpeg' | 'png'
  audio?: AudioMixPlan
  out: string
  crf?: number
  preset?: string
  audioBitrate?: string
}

// No encoder version strings or timestamps in the output: same input, same bytes.
const bitexact = ['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact']

/** Arguments for ffmpeg reading images from stdin and writing H.264/AAC MP4. */
export function encodeArgs(o: EncodeOptions): string[] {
  const duration = o.frames / o.fps
  const args = ['-y', '-hide_banner', '-loglevel', 'error']
  args.push('-f', 'image2pipe', '-framerate', String(o.fps), '-c:v', o.imageFormat === 'png' ? 'png' : 'mjpeg', '-i', 'pipe:0')
  for (const file of o.audio?.inputs ?? []) args.push('-i', file)
  if (o.audio) args.push('-filter_complex', o.audio.filter, '-map', '0:v', '-map', '[aout]')
  // yuv420p needs even dimensions
  if (o.width % 2 || o.height % 2) args.push('-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2')
  args.push('-c:v', 'libx264', '-preset', o.preset ?? 'medium', '-crf', String(o.crf ?? 18), '-pix_fmt', 'yuv420p', '-r', String(o.fps))
  if (o.audio) args.push('-c:a', 'aac', '-b:a', o.audioBitrate ?? '192k')
  args.push(...bitexact, '-t', String(duration), '-movflags', '+faststart', o.out)
  return args
}

/** Join video-only segments (concat list file) without re-encoding and add the mixed audio. */
export function muxArgs(o: { list: string; fps: number; frames: number; audio?: AudioMixPlan; out: string; audioBitrate?: string }): string[] {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', o.list]
  for (const file of o.audio?.inputs ?? []) args.push('-i', file)
  if (o.audio) args.push('-filter_complex', o.audio.filter, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', o.audioBitrate ?? '192k')
  args.push('-c:v', 'copy', ...bitexact, '-t', String(o.frames / o.fps), '-movflags', '+faststart', o.out)
  return args
}

export function spawnFfmpeg(ffmpeg: string, args: string[]) {
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] })
  let log = ''
  child.stderr.on('data', (d) => (log = (log + d).slice(-4000)))
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`ffmpeg could not be started (${ffmpeg}): ${e.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}:\n${log}`))))
  })
  return { child, done }
}

export interface ProbeResult {
  width: number
  height: number
  frames: number
  duration: number
  videoCodec: string
  pixelFormat: string
  audioCodec?: string
}

/** Read basic stream data with ffprobe (counts frames exactly). */
export async function probe(file: string, ffprobePath?: string): Promise<ProbeResult> {
  const ffprobe = resolveFfprobe(ffprobePath)
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`ffprobe: ${stderr}`))))
  })
  const json = JSON.parse(out)
  const video = json.streams.find((s: any) => s.codec_type === 'video')
  const audio = json.streams.find((s: any) => s.codec_type === 'audio')
  return {
    width: video.width,
    height: video.height,
    frames: Number(video.nb_read_frames ?? video.nb_frames),
    duration: Number(json.format.duration),
    videoCodec: video.codec_name,
    pixelFormat: video.pix_fmt,
    audioCodec: audio?.codec_name,
  }
}
