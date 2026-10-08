/** HTML of the preview UI: the composition in a scaled iframe plus a time slider. */
export function previewPage(page: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>video-maker Vorschau</title>
<style>
  :root { color-scheme: dark; font: 14px system-ui, sans-serif; }
  body { margin: 0; background: #16181d; color: #e6e6e6; display: grid; grid-template-rows: 1fr auto; height: 100vh; }
  #stage { position: relative; overflow: hidden; }
  iframe { position: absolute; border: 0; transform-origin: 0 0; background: #fff; }
  #bar { display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: #22252c; }
  #slider { flex: 1; }
  button { font: inherit; padding: 4px 12px; }
  #info { font-variant-numeric: tabular-nums; min-width: 16ch; text-align: right; }
</style>
</head>
<body>
<div id="stage"><iframe id="frame" src="${page.replace(/"/g, '&quot;')}"></iframe></div>
<div id="bar">
  <button id="play">▶</button>
  <input id="slider" type="range" min="0" value="0" step="1">
  <span id="info">lädt …</span>
</div>
<script type="module">
  const iframe = document.getElementById('frame')
  const slider = document.getElementById('slider')
  const info = document.getElementById('info')
  const play = document.getElementById('play')
  let meta, busy = false, wanted = 0, playing = false

  await new Promise((r) => iframe.addEventListener('load', r, { once: true }))
  const driver = iframe.contentWindow.__videoMakerDriver
  try { meta = await driver.ready() } catch (e) { info.textContent = String(e.message ?? e); throw e }
  iframe.style.width = meta.width + 'px'
  iframe.style.height = meta.height + 'px'
  slider.max = meta.frames - 1

  const fit = () => {
    const stage = document.getElementById('stage').getBoundingClientRect()
    const scale = Math.min(stage.width / meta.width, stage.height / meta.height)
    iframe.style.transform = 'scale(' + scale + ')'
    iframe.style.left = (stage.width - meta.width * scale) / 2 + 'px'
    iframe.style.top = (stage.height - meta.height * scale) / 2 + 'px'
  }
  addEventListener('resize', fit)
  fit()

  async function show(frame) {
    wanted = frame
    if (busy) return
    busy = true
    while (true) {
      const f = wanted
      await driver.seek(f)
      slider.value = f
      info.textContent = 'Bild ' + f + ' · ' + (f / meta.fps).toFixed(2) + ' s'
      if (wanted === f) break
    }
    busy = false
  }
  slider.addEventListener('input', () => show(Number(slider.value)))

  // Sound: all tracks decoded once, scheduled on the audio clock from the current position.
  const tracks = await (await fetch('/__video-maker/audio.json')).json()
  let audio, buffers, sources = []
  async function startSound(t0) {
    if (!tracks.length) return null
    audio ??= new AudioContext()
    await audio.resume()
    buffers ??= await Promise.all(tracks.map(async (t) => audio.decodeAudioData(await (await fetch(t.url)).arrayBuffer())))
    const now = audio.currentTime + 0.05
    tracks.forEach((t, i) => {
      const start = t.start ?? 0
      const length = t.duration ?? buffers[i].duration - (t.offset ?? 0)
      const skip = Math.max(0, t0 - start)
      if (skip >= length) return
      const gain = audio.createGain()
      // envelope [[videoSeconds, gain], …], fades relative to the track
      const at = (videoTime) => now + videoTime - t0
      if (Array.isArray(t.volume)) {
        const v = (x) => { const k = t.volume; if (x <= k[0][0]) return k[0][1]; for (let j = 1; j < k.length; j++) if (x < k[j][0]) return k[j-1][1] + (k[j][1] - k[j-1][1]) * (x - k[j-1][0]) / (k[j][0] - k[j-1][0]); return k[k.length-1][1] }
        gain.gain.setValueAtTime(v(t0), now)
        for (const [x, g] of t.volume) if (x > t0) gain.gain.linearRampToValueAtTime(g, at(x))
      } else gain.gain.setValueAtTime(t.volume ?? 1, now)
      const fade = audio.createGain()
      fade.gain.setValueAtTime(1, now)
      if (t.fadeIn && skip < t.fadeIn) { fade.gain.setValueAtTime(skip / t.fadeIn, now); fade.gain.linearRampToValueAtTime(1, at(start + t.fadeIn)) }
      if (t.fadeOut) { fade.gain.setValueAtTime(1, Math.max(now, at(start + length - t.fadeOut))); fade.gain.linearRampToValueAtTime(0, at(start + length)) }
      const src = audio.createBufferSource()
      src.buffer = buffers[i]
      src.connect(gain).connect(fade).connect(audio.destination)
      src.start(Math.max(now, at(start)), (t.offset ?? 0) + skip, length - skip)
      sources.push(src)
    })
    return now
  }
  function stopSound() {
    for (const s of sources) try { s.stop() } catch {}
    sources = []
  }

  play.addEventListener('click', async () => {
    playing = !playing
    play.textContent = playing ? '⏸' : '▶'
    if (!playing) return stopSound()
    const t0 = Number(slider.value) / meta.fps
    const soundStart = await startSound(t0)
    const wallStart = performance.now()
    // the audio clock (or the wall clock without sound) decides which frame is due
    const elapsed = () => (soundStart !== null ? audio.currentTime - soundStart : (performance.now() - wallStart) / 1000)
    while (playing) {
      const frame = Math.round((t0 + Math.max(0, elapsed())) * meta.fps)
      if (frame >= meta.frames) {
        playing = false
        play.textContent = '▶'
        stopSound()
        break
      }
      await show(frame)
      await new Promise((r) => requestAnimationFrame(r))
    }
  })
  slider.addEventListener('pointerdown', () => { if (playing) play.click() })
  show(0)
</script>
</body>
</html>`
}
