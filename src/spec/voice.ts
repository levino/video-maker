import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolveFfmpeg } from '../ffmpeg.js'

export interface AudioInfo {
  /** Seconds. */
  duration: number
  /** Middle of each silence between speech, seconds (leading/trailing silence excluded). */
  pauses: number[]
}

const cache = new Map<string, Promise<AudioInfo>>()

const parseTime = (s: string) => s.split(':').reduce((acc, n) => acc * 60 + Number(n), 0)

/** Decode the file once with silencedetect: exact duration and pause positions. */
export function analyzeAudio(file: string, ffmpegPath?: string): Promise<AudioInfo> {
  const { mtimeMs, size } = statSync(file)
  const key = `${file}:${mtimeMs}:${size}`
  let result = cache.get(key)
  if (!result) {
    result = new Promise<AudioInfo>((resolve, reject) => {
      const child = spawn(resolveFfmpeg(ffmpegPath), ['-hide_banner', '-nostats', '-i', file, '-af', 'silencedetect=noise=-38dB:d=0.18,ashowinfo', '-f', 'null', '-'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let log = ''
      child.stderr.on('data', (d) => (log += d))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg could not read ${file}:\n${log.slice(-1000)}`))
        // end of the last decoded audio frame: pts_time + nb_samples / rate
        let duration = 0
        for (const m of log.matchAll(/pts_time:([\d.]+).*?rate:(\d+) nb_samples:(\d+)/g)) duration = Math.max(duration, Number(m[1]) + Number(m[3]) / Number(m[2]))
        if (!duration) {
          const d = /Duration: (\d+:\d+:[\d.]+)/.exec(log)
          duration = d ? parseTime(d[1]) : 0
        }
        const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]))
        const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]))
        const pauses: number[] = []
        starts.forEach((start, i) => {
          const end = ends[i] ?? duration
          if (start <= 0.05 || end >= duration - 0.05) return
          pauses.push(Math.round(((start + end) / 2) * 1000) / 1000)
        })
        resolve({ duration: Math.round(duration * 1000) / 1000, pauses })
      })
    })
    cache.set(key, result)
  }
  return result
}
