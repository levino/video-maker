// custom-Ebene: ein Zahnrad, das sich mit der Szenenzeit dreht.
export default function (el, props) {
  const teeth = props.teeth ?? 10
  const points = []
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 ? 38 : 48
    const a = (i / (teeth * 2)) * Math.PI * 2
    points.push(`${50 + r * Math.cos(a)},${50 + r * Math.sin(a)}`)
  }
  el.innerHTML = `<svg viewBox="0 0 100 100" width="100%" height="100%">
    <polygon points="${points.join(' ')}" fill="${props.color ?? '#333'}"/>
    <circle cx="50" cy="50" r="14" fill="#f4f1ea"/>
  </svg>`
  const svg = el.firstElementChild
  return (t) => {
    svg.style.transform = `rotate(${t * 40}deg)`
  }
}
