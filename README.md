# Ink

A Quarto reveal.js extension that adds freehand annotation tools to your
slides. Built for tablets and styluses: draw over your slides during a
presentation with a pen, highlighter, eraser and laser pointer.

## Features

- **Pen** with stylus pressure sensitivity
- **Highlighter** with translucent wide strokes
- **Shapes**: arrow, line, rectangle, ellipse with live preview. Tap
  a finished shape with the shape tool to select it: a dashed box and
  corner controls appear for moving, stroke width +/- and deleting,
  and dragging the shape moves it — all undoable
- **Text notes**: tap anywhere to type directly on the slide in a
  floating editor that matches the final rendering, in a friendly
  rounded annotation font; tap a note to re-edit it, drag it to move it
  (works with the pen and shape tools too). Corner controls on the
  editor offer move, font size +/- and delete — every edit, move,
  resize and delete is undoable
- **Eraser** that removes whole strokes it touches
- **Laser pointer** for pointing without leaving marks
- **The Ink Orb**: a single draggable, iridescent orb floats over the
  deck. Tap it and a radial menu blooms open with staggered spring
  animation — an inner ring of tools, a ring of colors (plus a custom
  picker), a ring of stroke sizes, and a fourth ring of shape kinds
  when the shape tool is active. The bloom always aims toward the
  screen center and shifts itself to stay fully on screen.
- **Per-tool memory**: pen, highlighter and shapes each remember their
  own color and stroke width; the orb's glow ring shows the active color
- **Undo / redo** (command based: erasing and clearing are undoable too,
  with disabled button states), **clear slide / clear all / export PNG / export annotated HTML**
  (a standalone copy of the deck with every slide's ink embedded)
- **Smart snapping**: near-horizontal/45°/vertical lines and arrows snap
  to exact angles, near-square rectangles become squares, and a straight
  highlighter swipe is auto-straightened and leveled
- **Two-finger tap to undo** on touch devices (Procreate-style gesture)
- **Input smoothing** removes hand jitter from freehand strokes
- **Fast rendering**: committed ink is cached offscreen, so drawing
  stays responsive on stroke-heavy slides; the orb fades out of the
  way while a stroke is in progress
- **Palm rejection** toggle: accept only stylus input, ignore fingers
- **Unobtrusive**: when idle the orb dims to a small glossy sphere;
  toast hints confirm mode changes
- **Per-slide drawings**: each slide keeps its own ink, restored when
  you navigate back
- **Persistence**: drawings are saved to localStorage and survive
  page reloads
- Touch-friendly: larger targets and no hover tooltips on tablets

## Installation

```bash
quarto add ofurkancoban/quarto-ink
```

## Usage

Enable the plugin in your presentation:

```yaml
---
title: "My Talk"
format: revealjs
revealjs-plugins:
  - ink
---
```

Open the presentation, tap the floating orb (or press **D**, or pick
**Draw on Slides** from the burger menu's Tools panel) to enter draw
mode, then draw directly on the slide with your finger, mouse or
stylus. The shortcut is also listed in reveal's keyboard help (?).

### Keyboard shortcuts

| Key | Action |
|---|---|
| D | Toggle draw mode |
| P | Pen |
| H | Highlighter |
| T | Text |
| S | Shapes |
| E | Eraser |
| L | Laser pointer |
| Z | Undo |
| Y | Redo |

## Development

- `example.qmd` is a demo deck: `quarto render example.qmd`
- `tests/logic.qmd` is a self-checking test deck that simulates pointer
  input and reports PASS/FAIL for drawing, undo/redo, eraser,
  persistence and per-slide isolation
- `tests/autodraw.qmd` draws synthetic strokes for visual inspection
