/* Ink: freehand annotation tools for Quarto reveal.js slides.
 *
 * Engine:
 *  - Ink is stored in slide coordinates, so drawings stay glued to the
 *    slide content across window resizes, zooms and devices.
 *  - Pen strokes are rendered as variable-width filled outlines with
 *    pressure response and tapered ends.
 *  - Undo/redo is command based: drawing, erasing and clearing are all
 *    reversible.
 *
 * UI:
 *  - A markup-style pen tray: physical pen artwork rises out of a glass
 *    dock, each tool remembers its own color and width, and a second
 *    tap on the active pen opens its options popover.
 */

window.InkAnnotate = (function () {
  "use strict";

  var COLORS = [
    "#ff453a", "#ff9f0a", "#ffd60a", "#30d158",
    "#64d2ff", "#0a84ff", "#bf5af2", "#1c1c1e", "#ffffff"
  ];
  var HIGHLIGHT_ALPHA = 0.32;
  var ERASER_RADIUS = 16;
  var HISTORY_LIMIT = 100;
  var STORE_VERSION = "v2";

  var deck = null;
  var slidesEl = null;
  var canvas, ctx;
  var dock, fab, popover, toast, menuEl, eraserRing;
  var undoBtn, redoBtn;
  var drawMode = false;
  var tool = "pen";
  var penOnly = false;

  // per-tool memory: each pen keeps its own color and width
  var toolCfg = {
    pen:         { color: COLORS[0], size: 4 },
    highlighter: { color: COLORS[2], size: 7 },
    shape:       { color: COLORS[5], size: 3, kind: "arrow" },
    text:        { color: COLORS[0], size: 7 }
  };

  var strokes = {};
  var history = {};
  var current = null;
  var eraseBatch = null;
  var laser = { dot: null, trail: [], raf: null };

  var docKey = "quarto-ink:" + STORE_VERSION + ":" + location.pathname;
  var settingsKey = "quarto-ink-settings:v2";

  /* ================= storage ================= */

  function persist() {
    try {
      localStorage.setItem(docKey, JSON.stringify(strokes,
        function (k, v) {
          // runtime caches (bounding boxes, edit flags) stay in memory
          return k.charAt(0) === "_" ? undefined : v;
        }));
    } catch (e) { /* private mode or full: keep in memory */ }
  }

  function restore() {
    try {
      strokes = JSON.parse(localStorage.getItem(docKey)) || {};
    } catch (e) { strokes = {}; }
  }

  function saveSettings() {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        toolCfg: toolCfg, penOnly: penOnly
      }));
    } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(settingsKey));
      if (s && s.toolCfg) {
        Object.keys(toolCfg).forEach(function (k) {
          if (s.toolCfg[k]) {
            Object.assign(toolCfg[k], s.toolCfg[k]);
          }
        });
        penOnly = !!s.penOnly;
      }
    } catch (e) { /* ignore */ }
  }

  function cfg() {
    return toolCfg[tool] || toolCfg.pen;
  }

  function slideKey() {
    var idx = deck.getIndices();
    return idx.h + "." + (idx.v || 0);
  }

  function slideStrokes() {
    var k = slideKey();
    if (!strokes[k]) strokes[k] = [];
    return strokes[k];
  }

  function slideHistory() {
    var k = slideKey();
    if (!history[k]) history[k] = { done: [], undone: [] };
    return history[k];
  }

  /* ================= slide coordinate mapping ================= */

  function slideFrame() {
    var r = slidesEl.getBoundingClientRect();
    var scale = deck.getScale() || 1;
    return { left: r.left, top: r.top, scale: scale };
  }

  function toSlide(x, y, f) {
    f = f || slideFrame();
    return [(x - f.left) / f.scale, (y - f.top) / f.scale];
  }

  /* ================= canvas ================= */

  function resizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    invalidate();
    redraw();
    if (textEditor) placeEditor();
  }

  function applyFrameTransform() {
    var dpr = window.devicePixelRatio || 1;
    var f = slideFrame();
    ctx.setTransform(dpr * f.scale, 0, 0, dpr * f.scale,
                     dpr * f.left, dpr * f.top);
    return f;
  }

  function strokeWidths(s) {
    return s.points.map(function (p) {
      var pressure = p.length > 2 ? p[2] : 0.6;
      return Math.max(0.4, s.size * (0.35 + 0.95 * pressure));
    });
  }

  function drawPen(s) {
    var pts = s.points;
    if (pts.length === 1) {
      var w0 = strokeWidths(s)[0];
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], w0 / 2, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      return;
    }
    var w = strokeWidths(s);
    var taper = Math.min(4, Math.floor(pts.length / 2));
    for (var t = 0; t < taper; t++) {
      var f = (t + 1) / (taper + 1);
      w[t] *= f;
      w[w.length - 1 - t] *= f;
    }
    var left = [], right = [];
    for (var i = 0; i < pts.length; i++) {
      var prev = pts[Math.max(0, i - 1)];
      var next = pts[Math.min(pts.length - 1, i + 1)];
      var dx = next[0] - prev[0];
      var dy = next[1] - prev[1];
      var len = Math.hypot(dx, dy) || 1;
      var nx = -dy / len, ny = dx / len;
      var hw = w[i] / 2;
      left.push([pts[i][0] + nx * hw, pts[i][1] + ny * hw]);
      right.push([pts[i][0] - nx * hw, pts[i][1] - ny * hw]);
    }
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (var j = 1; j < left.length - 1; j++) {
      ctx.quadraticCurveTo(left[j][0], left[j][1],
        (left[j][0] + left[j + 1][0]) / 2,
        (left[j][1] + left[j + 1][1]) / 2);
    }
    ctx.lineTo(left[left.length - 1][0], left[left.length - 1][1]);
    var e0 = pts[pts.length - 1];
    ctx.arc(e0[0], e0[1], w[w.length - 1] / 2,
      Math.atan2(left[left.length - 1][1] - e0[1],
                 left[left.length - 1][0] - e0[0]),
      Math.atan2(right[right.length - 1][1] - e0[1],
                 right[right.length - 1][0] - e0[0]));
    for (var m = right.length - 1; m > 0; m--) {
      ctx.quadraticCurveTo(right[m][0], right[m][1],
        (right[m][0] + right[m - 1][0]) / 2,
        (right[m][1] + right[m - 1][1]) / 2);
    }
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
  }

  function drawPolyline(s) {
    var pts = s.points;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.1, pts[0][1]);
    for (var i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i][0], pts[i][1],
        (pts[i][0] + pts[i + 1][0]) / 2,
        (pts[i][1] + pts[i + 1][1]) / 2);
    }
    if (pts.length > 1) {
      var l = pts[pts.length - 1];
      ctx.lineTo(l[0], l[1]);
    }
    ctx.stroke();
  }

  function drawShape(s) {
    var a = s.points[0];
    var b = s.points[s.points.length - 1];
    ctx.beginPath();
    if (s.shape === "line" || s.shape === "arrow") {
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      if (s.shape === "arrow") {
        var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        var len = Math.max(10, s.size * 3.5);
        ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - len * Math.cos(ang - 0.45),
                   b[1] - len * Math.sin(ang - 0.45));
        ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - len * Math.cos(ang + 0.45),
                   b[1] - len * Math.sin(ang + 0.45));
      }
    } else if (s.shape === "rect") {
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]),
               Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    } else if (s.shape === "ellipse") {
      ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2,
                  Math.abs(b[0] - a[0]) / 2 || 1,
                  Math.abs(b[1] - a[1]) / 2 || 1, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
  }

  /* Text notes share the stroke model: one anchor point in slide
   * coordinates plus the text and a size that maps to a font size.
   * The rendered bounding box is cached on the stroke for hit tests. */

  var TEXT_FONT = "600 %px -apple-system, 'Segoe UI', Roboto, sans-serif";

  function fontPx(size) {
    return Math.round(10 + size * 3);
  }

  function textFont(size, scale) {
    return TEXT_FONT.replace("%", fontPx(size) * (scale || 1) + "px");
  }

  function drawText(s) {
    if (!s.text) return;
    var px = fontPx(s.size);
    var lh = Math.round(px * 1.3);
    ctx.font = textFont(s.size);
    ctx.textBaseline = "top";
    ctx.fillStyle = s.color;
    var lines = s.text.split("\n");
    var w = 0;
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], s.points[0][0], s.points[0][1] + i * lh);
      w = Math.max(w, ctx.measureText(lines[i]).width);
    }
    s._w = w;
    s._h = lines.length * lh;
  }

  function textBox(s) {
    var px = fontPx(s.size);
    var w = s._w != null ? s._w : (s.text || "").length * px * 0.6;
    var h = s._h != null ? s._h
      : (s.text || "").split("\n").length * Math.round(px * 1.3);
    return { x: s.points[0][0], y: s.points[0][1], w: w, h: h };
  }

  function textAt(p, pad) {
    var list = slideStrokes();
    pad = pad || 0;
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      if (s.tool !== "text") continue;
      var b = textBox(s);
      if (p[0] >= b.x - pad && p[0] <= b.x + b.w + pad &&
          p[1] >= b.y - pad && p[1] <= b.y + b.h + pad) {
        return s;
      }
    }
    return null;
  }

  function drawStroke(s) {
    if (!s.points || s.points.length === 0) return;
    if (s._editing) return; // hidden while its editor is open
    if (s.tool === "text") {
      ctx.save();
      ctx.globalAlpha = 1;
      drawText(s);
      ctx.restore();
      return;
    }
    ctx.save();
    if (s.tool === "pen") {
      ctx.globalAlpha = 1;
      drawPen(s);
    } else if (s.tool === "highlighter") {
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size * 4.5;
      ctx.lineCap = "butt";
      ctx.lineJoin = "round";
      drawPolyline(s);
    } else if (s.tool === "shape") {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(1.5, s.size * 0.9);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawShape(s);
    }
    ctx.restore();
  }

  function drawLaserTrail() {
    if (laser.trail.length === 0) return;
    var now = performance.now();
    ctx.save();
    ctx.lineCap = "round";
    for (var i = 1; i < laser.trail.length; i++) {
      var p0 = laser.trail[i - 1];
      var p1 = laser.trail[i];
      var age = (now - p1.t) / 700;
      if (age >= 1) continue;
      ctx.globalAlpha = (1 - age) * 0.7;
      ctx.strokeStyle = "#ff453a";
      ctx.lineWidth = 5 * (1 - age) + 1;
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Committed strokes are baked into an offscreen canvas so that
   * pointer moves only repaint the in-progress stroke on top. */
  var bake = document.createElement("canvas");
  var bctx = bake.getContext("2d");
  var bakeDirty = true;

  function invalidate() {
    bakeDirty = true;
  }

  function rebake() {
    var dpr = window.devicePixelRatio || 1;
    if (bake.width !== canvas.width || bake.height !== canvas.height) {
      bake.width = canvas.width;
      bake.height = canvas.height;
    }
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, bake.width, bake.height);
    var f = slideFrame();
    bctx.setTransform(dpr * f.scale, 0, 0, dpr * f.scale,
                      dpr * f.left, dpr * f.top);
    var main = ctx;
    ctx = bctx;
    slideStrokes().forEach(drawStroke);
    ctx = main;
    bakeDirty = false;
  }

  function redraw() {
    var dpr = window.devicePixelRatio || 1;
    if (bakeDirty) rebake();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bake, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLaserTrail();
    applyFrameTransform();
    if (current && current.points) drawStroke(current);
  }

  function laserTick() {
    var now = performance.now();
    laser.trail = laser.trail.filter(function (p) {
      return now - p.t < 700;
    });
    redraw();
    laser.raf = laser.trail.length > 0
      ? requestAnimationFrame(laserTick) : null;
  }

  function pushLaserPoint(x, y) {
    laser.trail.push({ x: x, y: y, t: performance.now() });
    laser.dot.style.display = "block";
    laser.dot.style.left = x + "px";
    laser.dot.style.top = y + "px";
    if (!laser.raf) laser.raf = requestAnimationFrame(laserTick);
  }

  function hideLaser() {
    laser.dot.style.display = "none";
  }

  /* ================= history ================= */

  function execute(cmd) {
    applyCmd(cmd, false);
    invalidate();
    var h = slideHistory();
    h.done.push(cmd);
    if (h.done.length > HISTORY_LIMIT) h.done.shift();
    h.undone = [];
    redraw();
    persist();
    refreshHistoryButtons();
  }

  function applyCmd(cmd, inverse) {
    var list = slideStrokes();
    var add = inverse ? cmd.type === "erase" || cmd.type === "clear"
                      : cmd.type === "add";
    if (cmd.type === "add") {
      if (add) list.push(cmd.stroke);
      else list.splice(list.lastIndexOf(cmd.stroke), 1);
    } else if (cmd.type === "erase") {
      if (add) {
        cmd.items.slice().sort(function (a, b) {
          return a.index - b.index;
        }).forEach(function (it) {
          list.splice(Math.min(it.index, list.length), 0, it.stroke);
        });
      } else {
        cmd.items.forEach(function (it) {
          var i = list.indexOf(it.stroke);
          if (i >= 0) list.splice(i, 1);
        });
      }
    } else if (cmd.type === "clear") {
      if (add) {
        cmd.items.forEach(function (s) { list.push(s); });
      } else {
        list.length = 0;
      }
    } else if (cmd.type === "edit") {
      cmd.stroke.text = inverse ? cmd.before : cmd.after;
      cmd.stroke._w = cmd.stroke._h = null;
    } else if (cmd.type === "move") {
      cmd.stroke.points[0] =
        (inverse ? cmd.from : cmd.to).slice();
    }
  }

  function undo() {
    var h = slideHistory();
    var cmd = h.done.pop();
    if (!cmd) return;
    applyCmd(cmd, true);
    invalidate();
    h.undone.push(cmd);
    redraw();
    persist();
    refreshHistoryButtons();
  }

  function redo() {
    var h = slideHistory();
    var cmd = h.undone.pop();
    if (!cmd) return;
    applyCmd(cmd, false);
    invalidate();
    h.done.push(cmd);
    redraw();
    persist();
    refreshHistoryButtons();
  }

  function clearSlide() {
    var list = slideStrokes();
    if (list.length === 0) return;
    execute({ type: "clear", items: list.slice() });
  }

  function clearAllSlides() {
    strokes = {};
    history = {};
    invalidate();
    redraw();
    persist();
    refreshHistoryButtons();
  }

  /* ================= eraser ================= */

  function shapeSamplePoints(s) {
    var a = s.points[0];
    var b = s.points[s.points.length - 1];
    var out = [];
    if (s.shape === "rect" || s.shape === "ellipse") {
      for (var t = 0; t < 24; t++) {
        var ang = t / 24 * Math.PI * 2;
        var cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
        var rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
        if (s.shape === "ellipse") {
          out.push([cx + rx * Math.cos(ang), cy + ry * Math.sin(ang)]);
        } else {
          var px = Math.cos(ang), py = Math.sin(ang);
          var k = 1 / Math.max(Math.abs(px), Math.abs(py));
          out.push([cx + rx * px * k, cy + ry * py * k]);
        }
      }
    } else {
      for (var u = 0; u <= 12; u++) {
        out.push([a[0] + (b[0] - a[0]) * u / 12,
                  a[1] + (b[1] - a[1]) * u / 12]);
      }
    }
    return out;
  }

  function eraseAt(x, y) {
    var f = slideFrame();
    var p = toSlide(x, y, f);
    var r = ERASER_RADIUS / f.scale;
    var list = slideStrokes();
    var removed = [];
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      var hit;
      if (s.tool === "text") {
        var b = textBox(s);
        hit = p[0] >= b.x - r && p[0] <= b.x + b.w + r &&
              p[1] >= b.y - r && p[1] <= b.y + b.h + r;
      } else {
        var pts = s.tool === "shape" ? shapeSamplePoints(s) : s.points;
        var pad = (s.tool === "highlighter" ? s.size * 2.2 : s.size / 2);
        hit = pts.some(function (q) {
          return Math.hypot(q[0] - p[0], q[1] - p[1]) <= r + pad;
        });
      }
      if (hit) {
        removed.push({ index: i, stroke: s });
        list.splice(i, 1);
      }
    }
    if (removed.length > 0) {
      if (!eraseBatch) eraseBatch = [];
      removed.forEach(function (it) { eraseBatch.push(it); });
      invalidate();
      redraw();
    }
  }

  function commitEraseBatch() {
    if (eraseBatch && eraseBatch.length > 0) {
      var items = eraseBatch;
      eraseBatch = null;
      var h = slideHistory();
      h.done.push({ type: "erase", items: items });
      if (h.done.length > HISTORY_LIMIT) h.done.shift();
      h.undone = [];
      persist();
      refreshHistoryButtons();
    }
    eraseBatch = null;
  }

  function moveEraserRing(x, y) {
    eraserRing.style.display = "block";
    eraserRing.style.left = x + "px";
    eraserRing.style.top = y + "px";
    eraserRing.style.width = ERASER_RADIUS * 2 + "px";
    eraserRing.style.height = ERASER_RADIUS * 2 + "px";
  }

  /* ================= smart snapping ================= */

  var SNAP_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

  function snapLine(s) {
    var a = s.points[0];
    var b = s.points[s.points.length - 1];
    var ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    if (ang < 0) ang += 360;
    for (var i = 0; i < SNAP_ANGLES.length; i++) {
      var d = Math.abs(ang - SNAP_ANGLES[i]);
      if (d > 180) d = 360 - d;
      if (d <= 4) {
        var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        var r = SNAP_ANGLES[i] * Math.PI / 180;
        s.points = [a, [a[0] + len * Math.cos(r), a[1] + len * Math.sin(r)]];
        return;
      }
    }
  }

  function snapBox(s) {
    var a = s.points[0];
    var b = s.points[s.points.length - 1];
    var w = Math.abs(b[0] - a[0]);
    var h = Math.abs(b[1] - a[1]);
    var m = Math.max(w, h);
    if (m > 0 && Math.abs(w - h) / m <= 0.12) {
      var side = (w + h) / 2;
      s.points = [a, [a[0] + side * Math.sign(b[0] - a[0] || 1),
                      a[1] + side * Math.sign(b[1] - a[1] || 1)]];
    }
  }

  function straightenHighlight(s) {
    var pts = s.points;
    if (pts.length < 3) return;
    var a = pts[0];
    var b = pts[pts.length - 1];
    var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 40) return;
    var maxDev = 0;
    for (var i = 1; i < pts.length - 1; i++) {
      var dev = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) -
                         (a[0] - pts[i][0]) * (b[1] - a[1])) / len;
      if (dev > maxDev) maxDev = dev;
    }
    if (maxDev <= Math.max(4, len * 0.035)) {
      // straighten, and level it if it is nearly horizontal
      if (Math.abs(b[1] - a[1]) <= len * 0.08) {
        var y = (a[1] + b[1]) / 2;
        a = [a[0], y];
        b = [b[0], y];
      }
      s.points = [a, b];
    }
  }

  function finalizeStroke(s) {
    if (s.tool === "shape") {
      if (s.shape === "line" || s.shape === "arrow") snapLine(s);
      else snapBox(s);
    } else if (s.tool === "highlighter") {
      straightenHighlight(s);
    }
  }

  /* ================= text editor ================= */

  /* A floating textarea, positioned and scaled to match exactly where
   * the committed text will render on the slide. Commit on blur or
   * Cmd/Ctrl+Enter, cancel on Escape. Editing an existing note hides
   * its canvas rendering until the editor closes. */

  var textEditor = null; // { el, stroke, isNew, x, y, size, color }

  function measureEditor() {
    var ed = textEditor;
    var f = slideFrame();
    var px = fontPx(ed.size) * f.scale;
    var lines = ed.el.value.split("\n");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = textFont(ed.size, f.scale);
    var w = 30;
    lines.forEach(function (l) {
      w = Math.max(w, ctx.measureText(l).width);
    });
    ctx.restore();
    ed.el.style.width = Math.ceil(w + px * 0.8) + "px";
    ed.el.style.height = Math.ceil(lines.length * px * 1.3 + 10) + "px";
  }

  function placeEditor() {
    var ed = textEditor;
    var f = slideFrame();
    var px = fontPx(ed.size) * f.scale;
    // border (1.5) + padding (4/6) offsets keep glyphs where they
    // will render once committed
    ed.el.style.left = (f.left + ed.x * f.scale - 7.5) + "px";
    ed.el.style.top = (f.top + ed.y * f.scale - 5.5) + "px";
    ed.el.style.font = textFont(ed.size, f.scale);
    ed.el.style.lineHeight = (px * 1.3) + "px";
    ed.el.style.color = ed.color;
    ed.el.style.caretColor = ed.color;
    ed.el.style.setProperty("--ink-text-tint", ed.color);
    measureEditor();
  }

  function openTextEditor(x, y, stroke) {
    commitTextEditor();
    var ta = document.createElement("textarea");
    ta.className = "ink-text-editor";
    ta.setAttribute("aria-label", "Slide text note");
    ta.spellcheck = false;
    var c = cfg();
    textEditor = {
      el: ta,
      stroke: stroke || null,
      isNew: !stroke,
      x: stroke ? stroke.points[0][0] : x,
      y: stroke ? stroke.points[0][1] : y,
      size: stroke ? stroke.size : c.size,
      color: stroke ? stroke.color : c.color
    };
    if (stroke) {
      ta.value = stroke.text;
      stroke._editing = true;
      invalidate();
      redraw();
    }
    placeEditor();
    ta.addEventListener("input", measureEditor);
    ta.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") {
        cancelTextEditor();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        commitTextEditor();
      }
    });
    ta.addEventListener("blur", function () {
      // let a click that intends to cancel/commit run first
      setTimeout(commitTextEditor, 0);
    });
    ta.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
    });
    document.body.appendChild(ta);
    ta.focus();
    if (stroke) ta.select();
  }

  function removeEditor() {
    var ed = textEditor;
    textEditor = null;
    if (ed.stroke) ed.stroke._editing = false;
    ed.el.remove();
    invalidate();
    redraw();
  }

  function cancelTextEditor() {
    if (!textEditor) return;
    removeEditor();
  }

  function commitTextEditor() {
    if (!textEditor) return;
    var ed = textEditor;
    var text = ed.el.value.replace(/\s+$/, "");
    removeEditor();
    if (ed.isNew) {
      if (text) {
        execute({ type: "add", stroke: {
          tool: "text", color: ed.color, size: ed.size,
          text: text, points: [[ed.x, ed.y]]
        } });
      }
      return;
    }
    // editing an existing note
    if (!text) {
      execute({ type: "erase", items: [{
        index: slideStrokes().indexOf(ed.stroke), stroke: ed.stroke
      }] });
    } else if (text !== ed.stroke.text) {
      execute({ type: "edit", stroke: ed.stroke,
                before: ed.stroke.text, after: text });
    }
  }

  /* ================= pointer handling ================= */

  var touchIds = [];
  var gestureUndo = false;

  function accepts(e) {
    return !(penOnly && e.pointerType !== "pen");
  }

  function pressureOf(e) {
    if (e.pointerType === "pen" && e.pressure > 0) return e.pressure;
    return 0.6;
  }

  function onPointerDown(e) {
    if (!drawMode) return;
    if (e.pointerType === "touch") {
      if (touchIds.indexOf(e.pointerId) < 0) touchIds.push(e.pointerId);
      // second finger lands while a fresh touch stroke is starting:
      // treat the whole thing as a two-finger undo tap
      if (touchIds.length === 2 && current &&
          current.points && current.points.length < 8) {
        current = null;
        gestureUndo = true;
        redraw();
        return;
      }
      if (touchIds.length >= 2) return;
    }
    if (!accepts(e)) return;
    e.preventDefault();
    hidePopover();
    hideMenu();
    dock.classList.add("ink-stroking");
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (err) { /* synthetic events */ }
    if (tool === "eraser") {
      eraseBatch = [];
      eraseAt(e.clientX, e.clientY);
      moveEraserRing(e.clientX, e.clientY);
      current = { tool: "eraser" };
      return;
    }
    if (tool === "laser") {
      pushLaserPoint(e.clientX, e.clientY);
      current = { tool: "laser" };
      return;
    }
    if (tool === "text") {
      // a tap while the editor is open just commits it
      if (textEditor) { commitTextEditor(); return; }
      var tp = toSlide(e.clientX, e.clientY);
      var hitText = textAt(tp, 6 / slideFrame().scale);
      current = {
        tool: "text", startX: e.clientX, startY: e.clientY,
        target: hitText,
        orig: hitText ? hitText.points[0].slice() : null,
        moved: false
      };
      return;
    }
    var c = cfg();
    var p = toSlide(e.clientX, e.clientY);
    current = {
      tool: tool,
      shape: tool === "shape" ? c.kind : undefined,
      color: c.color,
      size: c.size,
      points: [[p[0], p[1], pressureOf(e)]]
    };
    redraw();
  }

  function onPointerMove(e) {
    if (!drawMode) return;
    if (tool === "eraser") moveEraserRing(e.clientX, e.clientY);
    if (!current || !accepts(e)) return;
    e.preventDefault();
    if (current.tool === "eraser") {
      eraseAt(e.clientX, e.clientY);
      return;
    }
    if (current.tool === "laser") {
      pushLaserPoint(e.clientX, e.clientY);
      return;
    }
    if (current.tool === "text") {
      // dragging an existing note moves it live
      if (!current.target) return;
      var tdx = e.clientX - current.startX;
      var tdy = e.clientY - current.startY;
      if (!current.moved && Math.hypot(tdx, tdy) > 6) {
        current.moved = true;
      }
      if (current.moved) {
        var tsc = slideFrame().scale;
        current.target.points[0] = [current.orig[0] + tdx / tsc,
                                    current.orig[1] + tdy / tsc];
        invalidate();
        redraw();
      }
      return;
    }
    var f = slideFrame();
    if (current.tool === "shape") {
      var q = toSlide(e.clientX, e.clientY, f);
      current.points = [current.points[0], [q[0], q[1]]];
      redraw();
      return;
    }
    var events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (events.length === 0) events = [e];
    events.forEach(function (ev) {
      var pt = toSlide(ev.clientX, ev.clientY, f);
      var last = current.points[current.points.length - 1];
      // light exponential smoothing removes hand jitter
      var sx = last[0] + (pt[0] - last[0]) * 0.65;
      var sy = last[1] + (pt[1] - last[1]) * 0.65;
      if (Math.hypot(sx - last[0], sy - last[1]) < 0.7) return;
      current.points.push([sx, sy, pressureOf(ev)]);
    });
    redraw();
  }

  function onPointerUp(e) {
    if (e.pointerType === "touch") {
      var ti = touchIds.indexOf(e.pointerId);
      if (ti >= 0) touchIds.splice(ti, 1);
      if (gestureUndo && touchIds.length === 0) {
        gestureUndo = false;
        undo();
        showToast("Undo");
        return;
      }
    }
    dock.classList.remove("ink-stroking");
    if (!current) return;
    if (current.tool === "laser") {
      hideLaser();
      current = null;
      return;
    }
    if (current.tool === "eraser") {
      commitEraseBatch();
      current = null;
      return;
    }
    if (current.tool === "text") {
      var tcur = current;
      current = null;
      if (tcur.target && tcur.moved) {
        // record the finished move as one undoable command
        var th = slideHistory();
        th.done.push({ type: "move", stroke: tcur.target,
                       from: tcur.orig,
                       to: tcur.target.points[0].slice() });
        if (th.done.length > HISTORY_LIMIT) th.done.shift();
        th.undone = [];
        persist();
        refreshHistoryButtons();
      } else if (tcur.target) {
        openTextEditor(0, 0, tcur.target);
      } else {
        var tq = toSlide(tcur.startX, tcur.startY);
        openTextEditor(tq[0], tq[1]);
      }
      return;
    }
    if (current.points.length > 0 &&
        !(current.tool === "shape" && current.points.length < 2)) {
      var stroke = current;
      current = null;
      finalizeStroke(stroke);
      execute({ type: "add", stroke: stroke });
    } else {
      current = null;
      redraw();
    }
  }

  /* ================= export ================= */

  function exportPng() {
    var out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    var octx = out.getContext("2d");
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    var a = document.createElement("a");
    a.download = "slide-" + slideKey() + "-ink.png";
    a.href = out.toDataURL("image/png");
    a.click();
    showToast("Annotations exported as PNG");
  }

  /* ================= UI: the Ink Orb =================
   * A single draggable orb floats over the deck. Tapping it blooms a
   * radial menu aimed at the screen center: an inner ring of tools, a
   * ring of colors, a ring of stroke sizes, and (for the shape tool) a
   * ring of shape kinds. Action petals (undo/redo/menu/exit) flank the
   * tool ring. */

  var orbRoot, orb, orbGlyph, bloomEl, menuEl, toast;
  var undoBtn, redoBtn;
  var bloomOpen = false;
  var orbPos = null; // {x, y} center, persisted
  var SIZES = [2, 4, 7, 11, 16];

  // engine callbacks expect these names
  function hidePopover() { /* bloom stays; popover concept unused */ }
  function hideMenu() {
    if (menuEl) menuEl.classList.remove("ink-visible");
  }

  var dock = { classList: { add: function () {}, remove: function () {} } };

  /* ---------- icons ---------- */

  var ICONS = {
    pen: '<svg viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.9 1.9 3.8 3.8 1.9-1.9z"/></svg>',
    highlighter: '<svg viewBox="0 0 24 24"><path d="M4 21h16v2H4v-2zM17.7 2.9l3.4 3.4c.4.4.4 1 0 1.4l-9.6 9.6-4.8 1.4 1.4-4.8 9.6-9.6c.4-.4 1-.4 1.4 0z"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M5 4h14v4h-2.3V6.4h-3.5v11.2h2V20H8.8v-2.4h2V6.4H7.3V8H5V4z"/></svg>',
    shape: '<svg viewBox="0 0 24 24"><circle cx="8.5" cy="8.5" r="4.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="12" y="12" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    eraser: '<svg viewBox="0 0 24 24"><path d="M15.1 3.5 3.5 15.1a2 2 0 0 0 0 2.8l2.6 2.6h5.7l8.7-8.7a2 2 0 0 0 0-2.8l-4.6-4.6a2 2 0 0 0-2.8 1.1zM8.9 19 6 16.1l6.4-6.4 2.9 2.9L9.9 19H8.9z"/></svg>',
    laser: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.4"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22M4.9 4.9l2.5 2.5M16.6 16.6l2.5 2.5M4.9 19.1l2.5-2.5M16.6 7.4l2.5-2.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M12 5V1L5 8l7 7v-4c3.9 0 7 3.1 7 7h2c0-5-4-9-9-9z"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M12 5V1l7 7-7 7v-4c-3.9 0-7 3.1-7 7H3c0-5 4-9 9-9z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19l1.4-1.4L13.4 12 19 6.4 17.6 5 12 10.6 6.4 5z"/></svg>',
    line: '<svg viewBox="0 0 24 24"><path d="M4 20 20 4" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M4 20 18 6M18 6h-6M18 6v6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    rect: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1.5" stroke="currentColor" stroke-width="2.2" fill="none"/></svg>',
    ellipse: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8.5" ry="6" stroke="currentColor" stroke-width="2.2" fill="none"/></svg>'
  };

  /* ---------- toast ---------- */

  var toastTimer = null;
  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.classList.add("ink-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("ink-show");
    }, ms || 1400);
  }

  /* ---------- tool state ---------- */

  function setDrawMode(on) {
    if (!on) commitTextEditor();
    drawMode = on;
    canvas.style.pointerEvents = on ? "auto" : "none";
    canvas.style.touchAction = on ? "none" : "auto";
    document.body.classList.toggle("ink-drawing", on);
    orbRoot.classList.toggle("ink-armed", on);
    if (!on) {
      hideLaser();
      eraserRing.style.display = "none";
      closeBloom();
      hideMenu();
    } else {
      refreshHistoryButtons();
    }
    refreshOrb();
  }

  function setTool(t) {
    if (t !== tool) commitTextEditor();
    tool = t;
    canvas.classList.toggle("ink-hide-cursor", t === "eraser");
    canvas.classList.toggle("ink-text-cursor", t === "text");
    if (t !== "eraser") eraserRing.style.display = "none";
    refreshOrb();
    if (bloomOpen) layoutBloom(); // shape ring may appear/disappear
    syncBloom();
    saveSettings();
  }

  function setShapeKind(kind) {
    toolCfg.shape.kind = kind;
    syncBloom();
    saveSettings();
  }

  function setColor(c) {
    if (!toolCfg[tool]) setTool("pen");
    cfg().color = c;
    refreshOrb();
    syncBloom();
    saveSettings();
  }

  function setSize(s) {
    if (!toolCfg[tool]) return;
    cfg().size = Math.max(1, Math.min(24, Number(s) || 4));
    syncBloom();
    saveSettings();
  }

  function togglePenOnly() {
    penOnly = !penOnly;
    saveSettings();
    if (menuEl) {
      menuEl.querySelector("[data-ink-menu='penonly'] .ink-check")
        .style.visibility = penOnly ? "visible" : "hidden";
    }
    showToast(penOnly ? "Pen-only input on" : "Pen-only input off");
  }

  function refreshHistoryButtons() {
    if (!undoBtn) return;
    var h = slideHistory();
    undoBtn.disabled = h.done.length === 0;
    redoBtn.disabled = h.undone.length === 0;
  }

  /* ---------- orb ---------- */

  function refreshOrb() {
    var c = toolCfg[tool] ? cfg().color :
      (tool === "laser" ? "#ff453a" : "#e4506e");
    orbRoot.style.setProperty("--orb-tint", c);
    orbGlyph.innerHTML = ICONS[tool] || ICONS.pen;
  }

  function saveOrbPos() {
    try {
      localStorage.setItem("quarto-ink-orb", JSON.stringify(orbPos));
    } catch (e) { /* ignore */ }
  }

  function loadOrbPos() {
    try {
      orbPos = JSON.parse(localStorage.getItem("quarto-ink-orb"));
    } catch (e) { orbPos = null; }
    if (!orbPos || typeof orbPos.x !== "number") {
      orbPos = { x: window.innerWidth - 64, y: window.innerHeight - 64 };
    }
    clampOrb();
  }

  function clampOrb() {
    orbPos.x = Math.max(36, Math.min(window.innerWidth - 36, orbPos.x));
    orbPos.y = Math.max(36, Math.min(window.innerHeight - 36, orbPos.y));
    orbRoot.style.left = orbPos.x + "px";
    orbRoot.style.top = orbPos.y + "px";
  }

  /* ---------- bloom geometry ---------- */

  function petal(opts) {
    var b = document.createElement("button");
    b.className = "ink-petal" + (opts.cls ? " " + opts.cls : "");
    b.title = opts.title || "";
    b.setAttribute("aria-label", opts.title || "");
    if (opts.svg) b.innerHTML = opts.svg;
    if (opts.dataset) {
      Object.keys(opts.dataset).forEach(function (k) {
        b.dataset[k] = opts.dataset[k];
      });
    }
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      opts.onclick();
    });
    bloomEl.appendChild(b);
    return b;
  }

  function buildBloom() {
    bloomEl = document.createElement("div");
    bloomEl.className = "ink-bloom";
    orbRoot.appendChild(bloomEl);

    [["pen", "Pen (P)"], ["highlighter", "Highlighter (H)"],
     ["text", "Text (T)"], ["shape", "Shapes (S)"],
     ["eraser", "Eraser (E)"], ["laser", "Laser (L)"]].forEach(function (t) {
      petal({
        title: t[1], svg: ICONS[t[0]], cls: "ink-petal-tool",
        dataset: { ring: "tool", key: t[0] },
        onclick: function () { setTool(t[0]); }
      });
    });

    COLORS.forEach(function (c) {
      var b = petal({
        title: c, cls: "ink-petal-color",
        dataset: { ring: "color", key: c },
        onclick: function () { setColor(c); }
      });
      b.style.setProperty("--swatch", c);
    });
    // custom color
    var custom = document.createElement("label");
    custom.className = "ink-petal ink-petal-color ink-petal-custom";
    custom.title = "Custom color";
    custom.dataset.ring = "color";
    custom.dataset.key = "";
    var ci = document.createElement("input");
    ci.type = "color";
    ci.addEventListener("input", function () {
      custom.style.setProperty("--swatch", ci.value);
      custom.dataset.key = ci.value;
      setColor(ci.value);
    });
    custom.appendChild(ci);
    bloomEl.appendChild(custom);

    SIZES.forEach(function (s) {
      var b = petal({
        title: s + "px", cls: "ink-petal-size",
        dataset: { ring: "size", key: String(s) },
        onclick: function () { setSize(s); }
      });
      b.style.setProperty("--dot", (6 + s * 1.1) + "px");
      b.innerHTML = "<span class='ink-dot'></span>";
    });

    [["arrow", "Arrow"], ["line", "Line"],
     ["rect", "Rectangle"], ["ellipse", "Ellipse"]].forEach(function (s) {
      petal({
        title: s[1], svg: ICONS[s[0]], cls: "ink-petal-shape",
        dataset: { ring: "shape", key: s[0] },
        onclick: function () { setShapeKind(s[0]); }
      });
    });

    undoBtn = petal({
      title: "Undo (Z)", svg: ICONS.undo, cls: "ink-petal-action",
      dataset: { ring: "action", key: "undo" },
      onclick: undo
    });
    redoBtn = petal({
      title: "Redo (Y)", svg: ICONS.redo, cls: "ink-petal-action",
      dataset: { ring: "action", key: "redo" },
      onclick: redo
    });
    petal({
      title: "More", svg: ICONS.more, cls: "ink-petal-action",
      dataset: { ring: "action", key: "more" },
      onclick: function () { menuEl.classList.toggle("ink-visible"); }
    });
    petal({
      title: "Exit draw mode (Esc)", svg: ICONS.close,
      cls: "ink-petal-action ink-petal-exit",
      dataset: { ring: "action", key: "exit" },
      onclick: function () { setDrawMode(false); }
    });
  }

  /* The bloom layout is guaranteed overlap-free in three steps:
   * 1. each ring's angular step is derived from its largest petal's
   *    diameter (chord spacing), so petals within a ring never touch;
   * 2. ring radii are spaced further apart than the sum of adjacent
   *    petal radii;
   * 3. a collision-relaxation pass separates any remaining pairs and
   *    keeps every petal inside the viewport and off the orb. */

  var PETAL_GAP = 9;

  function petalRadius(el) {
    return (el.offsetWidth || 44) / 2;
  }

  var FAN = 140; // every ring shares the same fan angle for visual order

  function ringPositions(out, selector, radius, baseAng, d0) {
    var items = bloomEl.querySelectorAll(selector);
    var n = items.length;
    if (n === 0) return;
    var maxD = 0;
    for (var k = 0; k < n; k++) {
      maxD = Math.max(maxD, petalRadius(items[k]) * 2);
    }
    // shared fan span, widened only if petals would touch on the arc
    var chord = Math.min(2 * radius, maxD + PETAL_GAP);
    var minStep = 2 * Math.asin(chord / (2 * radius)) * 180 / Math.PI;
    var step = n > 1 ? Math.max(FAN / (n - 1), minStep) : 0;
    var span = step * (n - 1);
    for (var i = 0; i < n; i++) {
      var ang = n === 1 ? baseAng : baseAng - span / 2 + step * i;
      var rad = ang * Math.PI / 180;
      out.push({
        el: items[i],
        x: radius * Math.cos(rad),
        y: radius * Math.sin(rad),
        r: petalRadius(items[i]),
        d: d0 + i * 22
      });
    }
    return span;
  }

  function resolveCollisions(pos) {
    var M = 10; // viewport margin
    var orbR = 34; // keep petals off the orb itself
    var W = window.innerWidth, H = window.innerHeight;
    for (var it = 0; it < 120; it++) {
      var moved = false;
      // pairwise separation
      for (var i = 0; i < pos.length; i++) {
        for (var j = i + 1; j < pos.length; j++) {
          var a = pos[i], b = pos[j];
          var min = a.r + b.r + PETAL_GAP * 0.55;
          var dx = b.x - a.x, dy = b.y - a.y;
          var d = Math.hypot(dx, dy);
          if (d < min) {
            if (d < 0.01) { dx = 1; dy = 0; d = 1; }
            var push = (min - d) / 2 + 0.1;
            var ux = dx / d, uy = dy / d;
            a.x -= ux * push; a.y -= uy * push;
            b.x += ux * push; b.y += uy * push;
            moved = true;
          }
        }
      }
      for (var k = 0; k < pos.length; k++) {
        var p = pos[k];
        // keep clear of the orb
        var od = Math.hypot(p.x, p.y);
        var omin = orbR + p.r + 4;
        if (od < omin) {
          if (od < 0.01) { p.x = omin; }
          else {
            p.x = p.x / od * omin;
            p.y = p.y / od * omin;
          }
          moved = true;
        }
        // keep on screen
        var sx = orbPos.x + p.x, sy = orbPos.y + p.y;
        var nx = Math.max(p.r + M, Math.min(W - p.r - M, sx));
        var ny = Math.max(p.r + M, Math.min(H - p.r - M, sy));
        if (nx !== sx || ny !== sy) {
          p.x = nx - orbPos.x;
          p.y = ny - orbPos.y;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  function layoutBloom() {
    var W = window.innerWidth, H = window.innerHeight;
    var showShapes = tool === "shape";
    bloomEl.classList.toggle("ink-has-shapes", showShapes);

    // Ring radii, scaled down if the viewport itself is small.
    var maxR = showShapes ? 268 : 208;
    var clr = maxR + 34; // clearance a full bloom needs around its center
    var fit = Math.min(1, (Math.min(W, H) / 2 - 12) / clr);
    var R = {
      tool: 88 * fit, color: 148 * fit,
      size: 208 * fit, shape: 268 * fit,
      act: 208 * fit
    };
    clr = clr * fit;

    // The bloom opens around a virtual center: the orb itself when it
    // has room, otherwise the nearest point with full clearance. The
    // rings always stay perfect circles.
    var vc = {
      x: Math.max(clr, Math.min(W - clr, orbPos.x)),
      y: Math.max(clr, Math.min(H - clr, orbPos.y))
    };
    var vdx = vc.x - orbPos.x, vdy = vc.y - orbPos.y;

    // aim away from the orb if the center moved, else at screen center
    var base;
    if (Math.hypot(vdx, vdy) > 2) {
      base = Math.atan2(vdy, vdx) * 180 / Math.PI;
    } else {
      base = Math.atan2(H / 2 - orbPos.y, W / 2 - orbPos.x) * 180 / Math.PI;
    }

    var pos = [];
    var toolSpan = ringPositions(pos, "[data-ring='tool']", R.tool, base, 0);
    ringPositions(pos, "[data-ring='color']", R.color, base, 40);
    ringPositions(pos, "[data-ring='size']", R.size, base, 90);
    if (showShapes) {
      ringPositions(pos, "[data-ring='shape']", R.shape, base, 130);
    }

    // actions sit on the size ring, just beyond the shared fan
    var acts = bloomEl.querySelectorAll("[data-ring='action']");
    var off = Math.max(FAN, toolSpan || FAN) / 2;
    var actAng = [base - off - 35, base - off - 15,
                  base + off + 15, base + off + 35];
    for (var i = 0; i < acts.length; i++) {
      var rad = actAng[i] * Math.PI / 180;
      pos.push({
        el: acts[i],
        x: R.act * Math.cos(rad),
        y: R.act * Math.sin(rad),
        r: petalRadius(acts[i]),
        d: 60 + i * 22
      });
    }

    // positions are relative to the orb, offset by the virtual center
    pos.forEach(function (p) {
      p.x += vdx;
      p.y += vdy;
    });

    // safety net; with the virtual center this should rarely move much
    resolveCollisions(pos);

    pos.forEach(function (p) {
      p.el.style.setProperty("--tx", p.x.toFixed(1) + "px");
      p.el.style.setProperty("--ty", p.y.toFixed(1) + "px");
      p.el.style.setProperty("--d", p.d + "ms");
    });
  }

  function syncBloom() {
    if (!bloomEl) return;
    var c = toolCfg[tool];
    bloomEl.querySelectorAll("[data-ring='tool']").forEach(function (b) {
      b.classList.toggle("ink-on", b.dataset.key === tool);
    });
    bloomEl.querySelectorAll("[data-ring='color']").forEach(function (b) {
      b.classList.toggle("ink-on", !!c &&
        (b.dataset.key || "").toLowerCase() === c.color.toLowerCase());
    });
    bloomEl.querySelectorAll("[data-ring='size']").forEach(function (b) {
      b.classList.toggle("ink-on", !!c &&
        Number(b.dataset.key) === c.size);
      b.style.setProperty("--tint", c ? c.color : "#fff");
    });
    bloomEl.querySelectorAll("[data-ring='shape']").forEach(function (b) {
      b.classList.toggle("ink-on", b.dataset.key === toolCfg.shape.kind);
    });
    bloomEl.classList.toggle("ink-dim-style", !c);
  }

  function openBloom() {
    layoutBloom();
    syncBloom();
    refreshHistoryButtons();
    bloomOpen = true;
    orbRoot.classList.add("ink-bloom-open");
  }

  function closeBloom() {
    bloomOpen = false;
    orbRoot.classList.remove("ink-bloom-open");
    hideMenu();
  }

  /* ---------- overflow menu ---------- */

  function buildMenu() {
    menuEl = document.createElement("div");
    menuEl.id = "ink-menu";
    var items = [
      { key: "clear", label: "Clear this slide", fn: function () {
          if (slideStrokes().length === 0 ||
              window.confirm("Clear all ink on this slide?")) {
            clearSlide();
            showToast("Slide cleared");
          }
        } },
      { key: "clearall", label: "Clear all slides", fn: function () {
          if (window.confirm("Remove ink from every slide?")) {
            clearAllSlides();
            showToast("All slides cleared");
          }
        } },
      { key: "export", label: "Export PNG", fn: exportPng },
      { key: "penonly", label: "Pen-only input", fn: togglePenOnly,
        check: true }
    ];
    items.forEach(function (it) {
      var b = document.createElement("button");
      b.className = "ink-menu-item";
      b.dataset.inkMenu = it.key;
      b.innerHTML = "<span class='ink-check'>✓</span>" +
        "<span>" + it.label + "</span>";
      b.querySelector(".ink-check").style.visibility =
        (it.check && penOnly) ? "visible" : "hidden";
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!it.check) hideMenu();
        it.fn();
      });
      menuEl.appendChild(b);
    });
    orbRoot.appendChild(menuEl);
  }

  /* ---------- orb drag & tap ---------- */

  function buildOrb() {
    orbRoot = document.createElement("div");
    orbRoot.id = "ink-orb-root";

    orb = document.createElement("button");
    orb.id = "ink-orb";
    orb.title = "Annotate (D)";
    orb.setAttribute("aria-label", "Annotate");
    orbGlyph = document.createElement("span");
    orbGlyph.className = "ink-orb-glyph";
    orb.appendChild(orbGlyph);
    orbRoot.appendChild(orb);

    document.body.appendChild(orbRoot);
    loadOrbPos();
    buildBloom();
    buildMenu();
    refreshOrb();

    toast = document.createElement("div");
    toast.id = "ink-toast";
    document.body.appendChild(toast);

    // drag vs tap
    var drag = null;
    orb.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY,
               ox: orbPos.x, oy: orbPos.y, moved: false };
      try { orb.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    orb.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 8) {
        drag.moved = true;
        closeBloom();
        orbRoot.classList.add("ink-dragging");
      }
      if (drag.moved) {
        orbPos.x = drag.ox + dx;
        orbPos.y = drag.oy + dy;
        clampOrb();
      }
    });
    orb.addEventListener("pointerup", function (e) {
      orbRoot.classList.remove("ink-dragging");
      if (!drag) return;
      var moved = drag.moved;
      drag = null;
      if (moved) {
        saveOrbPos();
        if (drawMode && !bloomOpen) openBloom();
        return;
      }
      // tap
      if (!drawMode) {
        setDrawMode(true);
        openBloom();
      } else if (bloomOpen) {
        closeBloom();
      } else {
        openBloom();
      }
    });
    orb.addEventListener("pointercancel", function () {
      orbRoot.classList.remove("ink-dragging");
      drag = null;
    });

    window.addEventListener("resize", function () {
      clampOrb();
      if (bloomOpen) layoutBloom();
    });
  }

  /* ---------- canvas & keys ---------- */

  function buildCanvas() {
    canvas = document.createElement("canvas");
    canvas.id = "ink-canvas";
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");

    laser.dot = document.createElement("div");
    laser.dot.id = "ink-laser";
    document.body.appendChild(laser.dot);

    eraserRing = document.createElement("div");
    eraserRing.id = "ink-eraser-ring";
    document.body.appendChild(eraserRing);

    canvas.addEventListener("pointerdown", function (e) {
      if (bloomOpen && drawMode) closeBloom();
      onPointerDown(e);
    });
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", function () {
      eraserRing.style.display = "none";
    });
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
  }

  function onKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable) {
      return;
    }
    var k = e.key.toLowerCase();
    if (k === "d") {
      if (drawMode) setDrawMode(false);
      else { setDrawMode(true); openBloom(); }
    }
    if (!drawMode) return;
    if (k === "escape") setDrawMode(false);
    if (k === "z") undo();
    if (k === "y") redo();
    if (k === "p") setTool("pen");
    if (k === "h") setTool("highlighter");
    if (k === "t") setTool("text");
    if (k === "s") setTool("shape");
    if (k === "e") setTool("eraser");
    if (k === "l") setTool("laser");
  }

  return {
    id: "InkAnnotate",
    init: function (reveal) {
      deck = reveal;
      slidesEl = deck.getRevealElement().querySelector(".slides");
      loadSettings();
      restore();
      buildCanvas();
      buildOrb();
      deck.on("slidechanged", function () {
        cancelTextEditor();
        current = null;
        eraseBatch = null;
        invalidate();
        redraw();
        refreshHistoryButtons();
      });
      deck.on("resize", function () {
        invalidate();
        redraw();
      });
      document.addEventListener("keydown", onKey);
    },
    // exposed for testing and programmatic use
    _api: {
      setDrawMode: setDrawMode,
      setTool: setTool,
      setShape: function (kind) { setTool("shape"); setShapeKind(kind); },
      setColor: setColor,
      setSize: setSize,
      undo: undo,
      redo: redo,
      addText: function (x, y, text) {
        execute({ type: "add", stroke: {
          tool: "text", color: toolCfg.text.color,
          size: toolCfg.text.size,
          text: String(text), points: [[x, y]]
        } });
      },
      commitTextEditor: commitTextEditor,
      getStrokes: function () { return strokes; },
      storageKey: function () { return docKey; },
      redraw: redraw,
      moveOrb: function (x, y) {
        orbPos = { x: x, y: y };
        clampOrb();
        if (bloomOpen) layoutBloom();
      },
      openBloom: openBloom,
      closeBloom: closeBloom
    }
  };
})();
