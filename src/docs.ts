/** Reference printed by `video-maker docs` (llms.txt style). Keep complete and short. */
export const docs = `# video-maker

> Rendert Videos (MP4, H.264/AAC) aus einer deklarativen Beschreibung (JSON/YAML) oder aus einer
> beliebigen Webseite. Headless Chromium nimmt Bild für Bild auf, ffmpeg kodiert. Gleiche Eingabe
> ergibt gleiche Bytes. Gebaut für die Bedienung durch Agenten: --json, stabile Exit-Codes, Fehler
> mit JSON-Pfad und Korrekturvorschlag, Standbilder, Kontaktbogen und automatische Prüfungen.

## Arbeitsablauf für Agenten

1. Beschreibung schreiben (video.yaml), Schema: \`video-maker schema\`.
2. \`video-maker validate video.yaml --json\` – Schema, Dateien, Zeiten, Szenendauern, Untertiteltempo.
3. \`video-maker check video.yaml --json\` – zusätzlich Layout im Browser: Text außerhalb des Bildes
   oder des sicheren Bereichs, Überlauf, Überlappung, Kontrast, Untertitelzeilen.
4. \`video-maker sheet video.yaml --per-scene 2 --out bogen.png\` ansehen; Details mit
   \`video-maker still video.yaml --time scene:intro+2 --out bild.png\`.
5. \`video-maker render video.yaml --out out/film.mp4\` – alle Formate; unveränderte Szenen kommen
   aus dem Cache (.video-maker-cache neben der Beschreibung, --no-cache schaltet ab).

## Befehle

render <eingabe> --out f.mp4 [--format n]… [--parallel 4] [--no-cache|--cache dir] [--crf 18] [--preset medium] [--image-format jpeg|png]
still <eingabe> --out f.png [--format n] [--time t | --frame n]
sheet <eingabe> --out f.png [--format n] [--count 12 | --per-scene k] [--columns c]   (Alias: kontaktbogen)
check <eingabe> [--format n]… [--no-layout]   (Alias: lint, pruefen)
validate <beschreibung> [--format n]…
schema | docs | preview <eingabe> [--format n] | mcp
Allgemein: --json, --root <ordner> (ausgelieferter Ordner, Standard: Ordner der Eingabe), --ffmpeg <pfad>, --verbose
Nur HTML-Eingabe: --width --height --fps --duration|--frames, --audio datei[@start][,vol=x] (mehrfach)

Exit-Codes: 0 ok · 1 intern · 2 Aufruf falsch · 3 Beschreibung ungültig · 4 Datei fehlt · 5 check fand Fehler · 6 Rendern fehlgeschlagen
--json-Fehler: {"ok":false,"exitCode":n,"error":{"kind","message","issues":[…]}}
Issue: {"code","severity":"error"|"warning","message","path":"/scenes/2/layers/0","hint","format","scene","frame","time"}
MCP-Server (stdio): \`video-maker mcp\` oder \`video-maker-mcp\`; Werkzeuge validate, check, still, contact_sheet, render, schema, docs.

## Beschreibung (Wurzel)

fps: 30
formats: { landscape: {width: 1920, height: 1080}, portrait: {width: 1080, height: 1920} }   # Pflicht
theme: { fonts, colors, background, text, styles, captions, safeArea }
defaults: { voice: {lead, tail, …}, transition, enter, exit }
audio: [Tonspur…]        # über das ganze Video, Zeiten global
overlays: [Ebene…]       # über allen Szenen, Zeiten global
scenes: [Szene…]         # Pflicht, nacheinander

Pfade sind relativ zur Beschreibung und müssen im ausgelieferten Ordner liegen (--root).
Farben: CSS-Farbe oder Name aus theme.colors. Längen: Pixel oder "50%" (der Bildbreite bzw. -höhe).

## Zeiten (TimeRef)

Zahl = Sekunden. Text: "2.5s", "45f" (Bilder), "start", "end", "voice" (Stimme beginnt), "voiceEnd",
"sentence:N" (Satz N des Skripts beginnt, ab 1), "word:Brücke" bzw. word:"E-Bike" (Wort wird gesprochen, geschätzt),
global zusätzlich "scene:<id>", "scene:<id>.end". Versatz anhängen: "sentence:2+0.5", "end-1", "voice+10f".
Rechnen: + - * / ( ), mix(a, b, t) = a + (b − a)·t, min(…), max(…), z. B. "mix(sentence:2, sentence:3, 0.3)",
"(voiceEnd - voice) / 2"; Wörter mit Leerzeichen in Ausdrücken mit Anführungszeichen: word:"zwei Wörter".
In Szenen zählen Zeiten ab Szenenbeginn, in overlays/audio der Wurzel ab Videobeginn.
Dauern (enter/exit/transition duration, voice lead/tail/fadeIn/fadeOut): Sekunden oder "12f".
Satzanfänge (sentence:N) werden an gemessenen Sprechpausen ausgerichtet; Satzenden brauchen Pausen ≥ 0,3 s,
kürzere Pausen (Komma, Doppelpunkt) zählen nur innerhalb eines Satzes.

## Szene

id: "intro"                      # Pflicht, [A-Za-z0-9_-]
duration: 6 | "auto"             # "auto" = lead + Länge der Stimme + tail (Standard mit voice)
voice: "stimme/01.mp3" | {file, lead: 0.25, tail: 0.6, volume: 1, fadeIn: 0, fadeOut: 0.1, pauses: "detect"|"none"|[s…]}
script: "Gesprochener Text."      # ergibt Untertitel (an Sprechpausen ausgerichtet) und sentence:/word:-Zeiten
captions: true | false | [{start, end, text}] | "datei.srt"
background: "#fff"
transition: cut | fade | slide-left | slide-up | wipe | zoom | {type, duration: 0.3, overlap: false}
    overlap: true blendet über die vorige Szene (Szene beginnt früher); sonst blendet der Inhalt über den eigenen Hintergrund ein.
    Standard: erste Szene cut, sonst fade.
audio: [Tonspur…]                # Zeiten relativ zur Szene
layers: [Ebene…]                 # Reihenfolge = Stapelung
only: [format…]; formats: {portrait: {layers, background, captions, transition}}

## Ebene (gemeinsame Felder)

type: text | counter | image | rect | svg | qr | group | custom
x, y, width, height              # Pixel oder "%"; Standard x=y=0
anchor: top-left (Standard) | top | top-right | left | center | right | bottom-left | bottom | bottom-right
        | baseline | baseline-left | baseline-right   (Grundlinie der ersten Textzeile bei y, wie SVG-Text)
place: wie anchor, setzt die Ebene in den sicheren Bereich (ersetzt x/y)
rotate (Grad), scale, opacity
at, until                        # sichtbar von/bis (Standard: ganze Szene)
enter, exit: none | fade | slide-up | slide-down | slide-left | slide-right | scale | pop | wipe | grow-x | grow-y | blur | draw
             oder {type, duration: 0.4, ease, distance: 60}   (draw: Linien einer svg-Ebene zeichnen sich)
animate: {x|y|width|height|scale|scaleX|scaleY|rotate|opacity|blur|draw: [[zeit, wert], …] oder [{t, v, ease}, …]}
         Werte vor dem ersten Schlüsselbild = erster Wert; ease gilt für das Stück bis zu diesem Schlüsselbild
         (Standard inOutCubic). Transform-Ursprung ist der anchor-Punkt.
         Feder: ease "spring(dämpfung, steifigkeit, masse)" läuft in echter Zeit ab dem vorigen Schlüsselbild und
         schwingt nach dem letzten Schlüsselbild aus: [[t0, 0.6], {t: "t0+1f", v: 1, ease: "spring(14)"}].
         Folgt noch ein Schlüsselbild, endet die Feder dort – dann t so wählen, dass sie ausgeschwungen ist.
         draw > 1 zeichnet schneller (Wert wird bei 1 begrenzt), z. B. draw bis 1.9 = nach gut der Hälfte fertig.
only: [format…]; formats: {portrait: {…Felder überschreiben…}}

text:    text: "Zeile 1\\nZeile 2", style: "titel" | {…}. Ohne width bricht Text an der Breite des sicheren Bereichs um.
         split: chars|words mit stagger: 0.05 lässt enter je Zeichen/Wort nacheinander laufen.
qr:      data: "https://…", width (Kantenlänge), color, background, margin (Module, Standard 4), level L|M|Q|H, radius (%)
counter: from: 0, to: 3.8, start, end (Standard at … at+1 s), decimals: 1, locale: "de-DE", prefix, suffix, ease, style
image:   src, fit: cover|contain, camera: {from: {zoom: 1, x: 0.5, y: 0.5}, to: {zoom: 1.1, x: 0.6, y: 0.4}, start, end, ease}
         ohne x/y/width/height füllt das Bild den Rahmen
rect:    color, radius ("50%" = Kreis), borderColor, borderWidth   (Balken: enter grow-x mit anchor left)
svg:     src: "grafik.svg" | markup: "<svg …>"
group:   layers: […]; Kinder bewegen sich mit der Gruppe
custom:  module: "grafik.js", props: {…}, times: {name: TimeRef}, params: {name: zahl | Schlüsselbilder}
         – Ausweg für eigene Grafik (siehe unten)

Textstil (style, theme.text, theme.styles.<name>, theme.captions):
preset (Name aus theme.styles), font (Name aus theme.fonts oder CSS-Familie), size, weight, color, italic,
stretch (Prozent), lineHeight, letterSpacing, uppercase, align, background, borderColor, borderWidth, radius,
padding (Zahl oder [v, h]), shadow, strike
theme.captions zusätzlich: bottom (px), maxWidth (äußere Breite der Box), maxChars (Standard 80 quer, 42 hoch),
             maxCps (Prüfgrenze, 20), fade (s)
theme.fonts: {Archivo: {src: "fonts/archivo.woff2", weight: "100 900", style, stretch: "75% 100%"}}
             mehrere Schnitte einer Familie: verschiedene Schlüssel mit gleichem family, z. B.
             {Mono400: {src: m400.woff2, family: "IBM Plex Mono", weight: "400"}, Mono600: {…, weight: "600"}}
theme.safeArea: Anteil je Seite (Standard 0.05)

Easing: linear, in, out, inOut (kubisch), inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic,
inSine, outSine, inOutSine, inExpo, outExpo, inOutExpo, inBack, outBack, spring, spring(d, s, m)

Wiederholung vermeiden (YAML): Vorlagen unter templates ablegen und mit Anker/Alias nutzen:
templates: { titel: &titel { type: text, style: titel, anchor: baseline } }
… layers: [{ <<: *titel, text: "Hallo", x: 960, y: 300 }]

## Tonspur

{file, start: 0, end, volume: 1 | [[zeit, pegel], …], offset (s in der Datei überspringen), fadeIn, fadeOut (braucht end)}
Stimmen der Szenen werden automatisch gemischt. Ausgabe AAC 192 kb/s, 48 kHz.

## Eigene Grafik: custom-Modul

// grafik.js – Standard-Export erhält das Element (Größe width×height der Ebene), props und Kontext
export default function (el, props, ctx) {
  el.innerHTML = '<svg viewBox="0 0 100 100">…</svg>'
  return (t, info) => { /* t = Sekunden seit Szenenbeginn; info.frame; info.params.<name> */ }
}
ctx: {width, height, fps, format, box: {width, height}, times: {name: sekunden}, scene: {id, frames, voice: {start, end}, sentences: [bild…]}}
times löst Zeitreferenzen auf (z. B. times: {start: 'word:"auf dem Dach"'}), params sind animierte Zahlen
(z. B. params: {neigung: [[sentence:2, 0], {t: "sentence:2+1f", v: 16, ease: "spring(9, 60)"}]}); so bleibt die
Zeitsteuerung in der Beschreibung und das Modul zeichnet nur.
Das Modul darf importieren; Zeitquellen (Date, performance.now, requestAnimationFrame, Timer) laufen virtuell.
Der Szenen-Cache verfolgt relative Importe (import … from './x.js', import('./x.js')); Dateien, die ein Modul
anders lädt (fetch), erkennt er nicht – dann --no-cache.

## Vorschau

video-maker preview <eingabe> startet einen lokalen Server mit Zeitregler und Ton (alle Tonspuren, synchron zur
Wiedergabe). Beschreibungen werden beim Neuladen der Seite neu kompiliert.

## HTML-Komposition (ohne Beschreibung)

Eine Webseite rendert, wenn sie window.videoMaker setzt:
window.videoMaker = { width, height, fps, frames | duration, ready?: Promise | () => Promise, frame?: (n, {time, fps, frames}) => void | Promise }
Hilfen: import { defineVideo, mapRange, ease, sequence, fade, crossfade, captionAt, splitText, timeCues } from '/__video-maker/kit/index.js'
Die Laufzeit stellt Date, performance.now, requestAnimationFrame, setTimeout/setInterval und Math.random (Seed) auf
eine virtuelle Uhr. CSS-Animationen und Web Animations stehen bei currentTime = Kompositionszeit (zeitlich mit
animation-delay setzen), Transitions springen ans Ende. Bilder und Schriften werden vor jeder Aufnahme abgewartet.
`
