# video-maker

Videos aus einer Beschreibung oder einer Webseite rendern. Eine YAML- oder JSON-Datei beschreibt Formate, Szenen, Texte,
Bilder, Ton und Untertitel. Headless Chromium nimmt Bild für Bild auf, ffmpeg kodiert MP4 (H.264, yuv420p,
faststart) mit AAC-Ton. Gleiche Eingabe ergibt gleiche Bytes, unveränderte Szenen kommen aus dem Cache.

Gebaut für die Bedienung durch KI-Agenten: `--json` bei allen Befehlen, stabile Exit-Codes, Fehler mit
JSON-Pfad und Korrekturvorschlag, Standbilder zu beliebigen Zeitpunkten, Kontaktbogen, automatische Prüfungen
und ein MCP-Server. Inspiriert vom Prinzip Browser-Rendering.

Die vollständige, knappe Referenz gibt `npx video-maker docs` aus, das JSON-Schema `npx video-maker schema`.

## Schnellstart

```sh
npm install @levino/video-maker
npx playwright install chromium        # einmalig, falls noch kein Chromium da ist
```

`video.yaml`:

```yaml
fps: 30
formats:
  landscape: { width: 1920, height: 1080 }
  portrait: { width: 1080, height: 1920 }
theme:
  colors: { ink: "#1d2430", accent: "#d0562c" }
  background: "#f4f1ea"
  text: { color: ink, size: 64 }
scenes:
  - id: intro
    voice: stimme/01.mp3            # Szene dauert so lange wie die Stimme (+ lead/tail)
    script: Hallo. Das ist ein Beispiel.   # ergibt Untertitel, an Sprechpausen ausgerichtet
    layers:
      - { type: text, text: "Hallo", place: center, enter: pop }
      - { type: text, text: "Beispiel", place: bottom, at: sentence:2, style: { color: accent } }
  - id: zahl
    duration: 4
    layers:
      - { type: counter, to: 1250, suffix: " km", place: center, start: 0.3, end: 2 }
```

```sh
npx video-maker validate video.yaml                     # Schema, Dateien, Zeiten, Untertiteltempo
npx video-maker check video.yaml                        # zusätzlich Layout und Kontrast im Browser
npx video-maker sheet video.yaml --per-scene 2 --out bogen.png
npx video-maker still video.yaml --time scene:zahl+1.5 --out bild.png
npx video-maker render video.yaml --out out/film.mp4    # → out/film-landscape.mp4, out/film-portrait.mp4
```

Ein vollständiges Beispiel mit eigener Grafik liegt in [examples/demo](examples/demo).

Was die Beschreibung kann, in Kürze: Formate nebeneinander (16:9, 9:16 …), Szenendauer nach Sprecherspur,
Untertitel aus dem Skript (an gemessenen Sprechpausen ausgerichtet), Zeitangaben wie `sentence:2`,
`word:"auf dem Dach"+10f` oder `mix(sentence:2, sentence:3, 0.3)`, Ebenen für Text (auch an der Grundlinie
ausgerichtet und zeichenweise eingeblendet), Zähler, Bilder mit Kamerafahrt, Rechtecke, SVG (Linien zeichnen sich),
QR-Codes, Gruppen und eigene JavaScript-Module mit animierten Parametern; Schlüsselbilder mit Easing oder
physikalischen Federn; Tonspuren mit Lautstärkeverlauf; Themes mit eigenen Schriften. Vollständig: `npx video-maker docs`.

## Befehle

| Befehl | Zweck |
| --- | --- |
| `render <eingabe> --out f.mp4` | MP4 rendern; `--format`, `--parallel`, `--no-cache`, `--crf`, `--preset` |
| `still <eingabe> --out f.png` | ein Bild; `--time 12.5`, `--time scene:id+2`, `--frame n` |
| `sheet <eingabe> --out f.png` | Kontaktbogen; `--count n` über das Video oder `--per-scene k` |
| `check <eingabe>` | Prüfungen: Text außerhalb von Bild oder sicherem Bereich, Überlauf, Überlappung, Kontrast, Untertitel zu lang, zu schnell oder zu viele Zeilen, Szene kürzer als ihr Ton, fehlende Dateien |
| `validate <beschreibung>` | nur Schema und Zeitplan, ohne Browser |
| `schema`, `docs` | JSON-Schema bzw. Referenz ausgeben |
| `preview <eingabe>` | lokale Vorschau mit Zeitregler und Ton |
| `mcp` | MCP-Server über stdio (auch als `video-maker-mcp`) |

Exit-Codes: `0` ok, `1` intern, `2` Aufruf falsch, `3` Beschreibung ungültig, `4` Datei fehlt,
`5` Prüfung fand Fehler, `6` Rendern fehlgeschlagen. Mit `--json` steht das Ergebnis bzw. der Fehler
(`{"ok": false, "exitCode", "error": {"kind", "message", "issues"}}`) auf stdout. Jedes Issue hat
`code`, `severity`, `message`, `path` (z. B. `/scenes/2/layers/0`), `hint` und, wo passend, `format`, `scene`, `time`.

MCP-Werkzeuge: `validate`, `check`, `still`, `contact_sheet` (liefern Bilder direkt zurück), `render`, `schema`, `docs`.
Eintrag für einen MCP-Client: `{"command": "npx", "args": ["video-maker-mcp"]}`.

## Eigene HTML-Kompositionen (Vertrag)

Wo die Beschreibung nicht reicht, gibt es zwei Auswege: eine `custom`-Ebene mit eigenem JavaScript-Modul in einer
Szene oder eine ganze Webseite als Eingabe. Eine Webseite ist renderbar, wenn sie `window.videoMaker` setzt:

```js
window.videoMaker = {
  width: 1920, height: 1080, fps: 30, frames: 300,   // oder duration: 10 (Sekunden)
  ready: async () => { /* Daten, Bilder, Schriften laden */ },
  frame: async (n, { time, fps, frames }) => { /* Seite auf Bild n setzen */ },
}
```

Vor jeder Aufnahme ruft der Renderer `frame(n)` auf und wartet auf Schriften und Bilder. `Date`, `performance.now`,
`requestAnimationFrame`, `setTimeout`/`setInterval` und `Math.random` (mit festem Seed) laufen auf einer
virtuellen Uhr. CSS-Animationen und Web Animations stehen bei `currentTime` = Kompositionszeit; ihr Zeitpunkt
wird mit `animation-delay` gesetzt. Hilfen (Easing, `mapRange`, Szenen, Überblendungen, Untertitel) gibt es unter
`/__video-maker/kit/index.js` bzw. als `@levino/video-maker/kit`.

```sh
npx video-maker render seite.html --out film.mp4 --audio musik.mp3@0s,vol=0.4 --parallel 4
```

## Programmatisch

```js
import { validate, check, still, sheet, renderVideo } from '@levino/video-maker'
const result = await renderVideo('video.yaml', { out: 'out/film.mp4', formats: ['portrait'] })
```

## ffmpeg und Chromium

ffmpeg kommt über das optionale Paket [`ffmpeg-static`](https://www.npmjs.com/package/ffmpeg-static); ein
eigenes Binary geht per `--ffmpeg <pfad>` oder `VIDEO_MAKER_FFMPEG`. Chromium kommt über Playwright; ein anderes
Binary per `VIDEO_MAKER_CHROMIUM`. Bei npm ab Version 11 müssen Installationsskripte eventuell freigegeben werden
(`npm install-scripts approve ffmpeg-static`), damit das Binary heruntergeladen wird.

## Lizenz

video-maker steht unter der MIT-Lizenz, siehe [LICENSE](LICENSE).

ffmpeg ist nicht Teil dieses Repositorys und wird nicht mitverteilt. Das Paket `ffmpeg-static` lädt bei der
Installation ein Binary herunter, das mit `--enable-gpl --enable-version3` und libx264 gebaut ist; es steht damit
unter der **GPL v3** (Lizenztext liegt dem Paket bei). Wer Programme mit diesem Binary weitergibt, muss dessen
Lizenzbedingungen beachten. Ein LGPL-Build von ffmpeg lässt sich über `--ffmpeg` einsetzen; H.264-Kodierung braucht
allerdings libx264 (GPL) oder einen anderen H.264-Encoder. Chromium wird von Playwright heruntergeladen und steht
unter eigenen Lizenzen.
