import type { Plan } from '../spec/plan.js'

export const playerPath = '/__video-maker/player/index.html'

/** HTML page that plays a compiled plan. */
export function playerPage(plan: Plan): string {
  const json = JSON.stringify(plan).replace(/</g, '\\u003c')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${plan.format}</title>
<style>html, body { margin: 0; overflow: hidden; }</style>
</head>
<body>
<script>window.__videoMakerPlan = ${json}</script>
<script type="module" src="/__video-maker/player/player.js"></script>
</body>
</html>`
}
