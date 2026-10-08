# Changelog

## 0.1.0 – unveröffentlicht

Erste Version.

### Rendern

- Headless Chromium (Playwright) nimmt Bild für Bild auf, mehrere Seiten parallel, Bilder per Pipe an ffmpeg.
- MP4 mit H.264 (yuv420p, faststart) und AAC; mehrere Tonspuren mit Startzeit, Lautstärke oder Lautstärkeverlauf,
  Ein- und Ausblenden.
- Virtuelle Zeit im Browser: `Date`, `performance.now`, `requestAnimationFrame`, Timer, `Math.random` (Seed),
  CSS-Animationen und Web Animations.
- Bitexakte Ausgabe: gleiche Eingabe, gleiche Bytes.
- Szenen-Cache: unveränderte Szenen werden nicht neu gerendert; Module werden samt ihrer relativen Importe gehasht.

### Deklarative Beschreibung (YAML/JSON)

- Veröffentlichtes JSON-Schema (`video-maker schema`), Fehler mit JSON-Pfad und Korrekturvorschlag.
- Mehrere Formate in einer Datei, Szenendauer nach Sprecherspur, Untertitel aus dem Skript, an gemessenen
  Sprechpausen ausgerichtet (Satzenden nur an echten Pausen).
- Zeitreferenzen `sentence:N`, `word:…`, `voice`, `scene:id.end` mit Versatz und Ausdrücken
  (`mix(a, b, t)`, `min`, `max`, Grundrechenarten).
- Ebenen: Text (auch an der Grundlinie ausgerichtet, zeichenweise eingeblendet), Zähler, Bild mit Kamerafahrt,
  Rechteck, SVG (mit Zeichnen-Effekt), QR-Code, Gruppe, eigenes JavaScript-Modul mit Zeiten und animierten Parametern.
- Schlüsselbilder mit Easing oder physikalischen Federn, Ein- und Ausblendungen, Szenenübergänge, Themes mit
  eigenen Schriften und benannten Stilen, YAML-Vorlagen über Anker.

### Werkzeuge für Agenten

- CLI: `render`, `still`, `sheet` (Kontaktbogen), `check` (Layout, Kontrast, Untertiteltempo), `validate`,
  `schema`, `docs`, `preview` (mit Ton), `mcp`; `--json` und stabile Exit-Codes.
- MCP-Server über stdio mit `validate`, `check`, `still`, `contact_sheet`, `render`, `schema`, `docs`.
- Programmierschnittstelle mit denselben Möglichkeiten; Hilfsbibliothek `@levino/video-maker/kit` für eigene
  HTML-Kompositionen.
