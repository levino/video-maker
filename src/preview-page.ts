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
  play.addEventListener('click', async () => {
    playing = !playing
    play.textContent = playing ? '⏸' : '▶'
    let last = performance.now()
    let frame = Number(slider.value)
    while (playing) {
      await show(frame)
      const now = performance.now()
      frame += Math.max(1, Math.round(((now - last) / 1000) * meta.fps))
      last = now
      if (frame >= meta.frames) frame = 0
      await new Promise((r) => requestAnimationFrame(r))
    }
  })
  show(0)
</script>
</body>
</html>`
}
