# Ink

Freehand annotation for Quarto reveal.js presentations. Draw over
your slides during a talk with a pen, highlighter, shapes, text and
sticky notes, magnify details, open a multi-page whiteboard, keep
separate annotation sessions per class, and export everything (HTML,
PDF, PNG) with the ink baked in. Built for tablets and styluses, but
fully usable with a mouse, and works the same whether the deck is
served from a web server (`quarto preview`, a hosted site) or opened
from a rendered export (self-contained HTML, a static file).

- Repository: https://github.com/ofurkancoban/QuartoInkExtension
- Requires: Quarto 1.4+, `format: revealjs`
- Version 0.9.1, MIT licensed (bundles html2canvas and jsPDF, both MIT)

Especially handy for students taking notes on a tablet: annotate
lecture slides directly with a stylus during class, keep a separate
session per course or day, and export the annotated deck afterwards
to study from.

## Installation

### Option 1: quarto add (recommended)

Run this in your presentation project's root directory:

```bash
quarto add ofurkancoban/QuartoInkExtension
```

This creates `_extensions/ink/` in your project. Commit that folder
with your project so collaborators and CI get the extension too.

### Option 2: manual install

Copy the extension folder into your project by hand:

```bash
git clone https://github.com/ofurkancoban/QuartoInkExtension
mkdir -p your-project/_extensions
cp -r QuartoInkExtension/_extensions/ink your-project/_extensions/
```

The folder must contain these five files:

```
_extensions/ink/
├── _extension.yml
├── ink.js
├── ink.css
├── html2canvas.min.js   (PNG/PDF export engine)
└── jspdf.umd.min.js     (PDF writer)
```

### Enable the plugin

For a single presentation, add `revealjs-plugins` to the YAML header
of your `.qmd` file:

```yaml
---
title: "My Talk"
format: revealjs
revealjs-plugins:
  - ink
---
```

For every presentation in a project, put it in `_quarto.yml` instead:

```yaml
format:
  revealjs:
    theme: default
revealjs-plugins:
  - ink
```

Then render and open the deck:

```bash
quarto render my-talk.qmd
# or live preview with auto-reload:
quarto preview my-talk.qmd
```

Press **D**: the Ink Orb appears and you can draw. Press **D** or
**Esc** again and the whole UI disappears. This works identically
whether the page is served over `http://localhost` by `quarto
preview`, hosted on a real web server (including under a subpath,
e.g. GitHub Pages project sites), or opened as a self-contained
export (`embed-resources: true`) or a plain double-clicked HTML file.

### Using with an already rendered HTML deck

If you only have the rendered HTML and cannot re-render, inline the
four asset files before the closing `</body>` tag and bootstrap the
plugin manually:

```html
<style>   /* contents of ink.css */   </style>
<script>  /* contents of html2canvas.min.js */ </script>
<script>  /* contents of jspdf.umd.min.js */   </script>
<script>  /* contents of ink.js */             </script>
<script>
(function () {
  function go() {
    if (window.Reveal && Reveal.isReady && Reveal.isReady()) {
      window.InkAnnotate.init(Reveal);
    } else { setTimeout(go, 200); }
  }
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go);
})();
</script>
```

Note: when inlining the JS files, replace any `</script` inside them
with `<\/script`. Re-rendering with the plugin enabled is the
recommended path.

### Opening a standalone deck on iPad

If someone hands you a single self-contained HTML file (for example
a deck exported with `embed-resources: true`, or one with the
extension manually inlined as above) rather than a link, iPadOS
often won't offer Safari in the Files app's "Open With" menu for a
local HTML file. Two reliable ways around that:

- **Documents by Readdle** (free, App Store): import the file into
  the app and tap it — Documents has its own built-in browser that
  runs the page's JavaScript properly, sidestepping the Open With
  limitation entirely. It can also open the file in Safari from
  there if you prefer.
- **Microsoft Edge for iOS**: import/share the file into Edge (via
  the share sheet or Edge's own file picker under its menu) and open
  it there — Edge on iOS uses its own document handling and will run
  the deck normally, orb and all.

Either way, since the deck is a plain local file, the tablet
detection described below still applies: the Ink Orb appears on its
own, no keyboard shortcut needed.

## Configuration (optional)

All settings live under a top level `ink` key in the document or
project metadata. Every key is optional; choices made in the UI are
remembered in localStorage and win on later visits.

```yaml
---
title: "My Talk"
format: revealjs
revealjs-plugins:
  - ink
ink:
  colors: ["#e11d48", "#0ea5e9", "#22c55e", "#f59e0b", "#111827"]
  default-tool: pen        # pen, highlighter, text, note, shape,
                           # eraser, laser, zoom
  board-background: grid   # dots, grid, lines, blank
  pen-only: true           # start with palm rejection on
  session: "Class A"       # open the deck in a named session
  github: false            # hide the About entry in the menu
  auto-show-on-touch: false # don't auto-reveal the orb on tablets
---
```

## Features

### Drawing tools

- **Pen**: pressure sensitive, smoothed, tapered strokes
- **Highlighter**: wide translucent strokes; straight swipes are
  auto-straightened and leveled
- **Text notes**: type directly on the slide in a floating editor
  that matches the final rendering; tap to re-edit, drag to move
- **Sticky notes**: text on a rounded colored card with automatic
  readable text color
- **Shapes**: arrow, curved arrow (with a bend handle), line,
  rectangle, ellipse; live preview and smart angle/square snapping
- **Eraser**: removes whole strokes, with a soft trailing wake
- **Laser pointer**: bright dot with a smooth fading trail
- **Magnifier**: hold to show a 2.2x circular lens that follows the
  pointer, live ink included

### Selection and editing

- Tap any stroke with the shape tool to select it: dashed box,
  corner resize handles, and a control bar (move, width +/-,
  duplicate, delete)
- Pasted slide images resize proportionally (aspect ratio locked)
- Cmd/Ctrl+C copies the selected stroke, Cmd/Ctrl+V pastes a copy
- Everything is undoable (Z / Y): draws, erases, moves, resizes,
  text edits, deletions and clears

### Whiteboard

An opaque multi-page board over the deck, opened from the orb menu.
The top bar has: previous/next page, new page, background switcher
(dotted, squared, ruled, blank), a camera button that pastes a
snapshot of the current slide onto the page as a movable image, a
two-tap page delete, and close. Every page keeps its own ink and
undo history; non-empty pages are appended to the PDF export.

### Sessions

Parallel annotation sets for the same deck, for example one per
class group. When the deck opens with ink from an earlier day, a
small prompt offers to start a fresh session; naming is optional and
defaults to the date. Manage sessions any time from the menu.

### Exports (the "..." menu)

- **PNG**: current slide with its ink, as an image
- **Annotated HTML**: a standalone single-file copy of the deck with
  all drawings embedded (styles, scripts and images inlined)
- **PDF**: one page per slide, tabset slides visited tab by tab,
  whiteboard pages appended, with live progress
- Plus: clear this slide / clear all (two-tap confirmation), pen-only
  input toggle, session manager, GitHub link

### The Ink Orb

The whole UI is a single draggable orb, invisible until you press
**D** (or pick "Draw on Slides" from the burger menu's Tools panel).
Tapping it blooms a radial menu: tools, colors (plus a custom
picker), stroke sizes, shape kinds, and undo/redo/whiteboard/menu/
exit actions. The layout is collision-free and always stays on
screen. Each tool remembers its own color and width.

On tablet-class devices (coarse pointer, no hover, touch, a screen
wide enough not to be a phone) the orb shows itself automatically on
load, dimmed and out of the way until tapped — a student picking up
their tablet in class doesn't need to know the D shortcut exists.
Laptops and phones are unaffected. Disable this with
`ink: {auto-show-on-touch: false}` if you'd rather it stayed hidden
everywhere until D is pressed.

### Plays well with real decks

- Per-tab ink layers on panel-tabset slides
- Tab headers, map controls (Leaflet, Mapbox GL, MapLibre,
  OpenLayers) and citation/footnote hover previews keep working
  while a tool is selected
- Reveal arrows and the Quarto menu stay clickable in draw mode;
  overview and scroll view hide the ink safely
- Third-party overlay widgets (progress indicators, laser pointers,
  lightboxes) are handled: kept out of exports, never blocking the UI
- The **D** shortcut is registered as early as the script loads and
  reaches into same-origin embedded widgets (maps, charts), so it
  still works even if a deck's own script tries to intercept keys
  first, or focus is inside an embedded iframe
- Committed ink is cached offscreen for fast redraws; drawings
  persist in localStorage per slide, tab, board page and session

## Keyboard shortcuts

| Key           | Action                                |
| ------------- | ------------------------------------- |
| D             | Toggle draw mode                      |
| P             | Pen                                   |
| H             | Highlighter                           |
| T             | Text                                  |
| S             | Shapes                                |
| E             | Eraser                                |
| L             | Laser pointer                         |
| Z             | Undo                                  |
| Y             | Redo                                  |
| Cmd/Ctrl+C, V | Copy and paste the selected stroke    |
| Esc           | Close whiteboard, then exit draw mode |

Two-finger tap undoes on touch screens. The D shortcut is listed in
reveal's keyboard help (?) and the burger menu's Tools panel gets a
"Draw on Slides" entry.

## Development

```bash
quarto render example.qmd        # demo deck
quarto render tests/logic.qmd    # self-checking suite, 106 checks
quarto render tests/layout.qmd   # radial menu layout proofs, 24 checks
```

Open the rendered test decks in a browser; results are printed on
the first slide as PASS/FAIL lines. `tests/autodraw.qmd` draws
synthetic strokes for visual inspection.

## License

MIT, see [LICENSE](LICENSE). Bundles html2canvas 1.4.1 (MIT) and
jsPDF 2.5.1 (MIT) for the PNG/PDF exports.
