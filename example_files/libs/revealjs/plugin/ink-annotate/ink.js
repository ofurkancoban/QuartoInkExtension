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

  /* a harmonised palette: the same hue families tuned to matching
   * saturation and lightness so they read as one set */
  var COLORS = [
    "#f43f5e", // rose
    "#fb923c", // tangerine
    "#fbbf24", // amber
    "#34d399", // emerald
    "#38bdf8", // sky
    "#6366f1", // indigo
    "#a78bfa", // violet
    "#1e293b", // ink
    "#f8fafc"  // paper
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
    text:        { color: COLORS[0], size: 7 },
    note:        { color: COLORS[2], size: 7 }
  };

  var strokes = {};
  var history = {};
  var current = null;
  var eraseBatch = null;
  var laser = { dot: null, trail: [], etrail: [], raf: null };
  var LASER_LIFE = 700;
  var ERASER_LIFE = 450;

  var inkShowGithub = true;
  var orbAlwaysVisible = false;
  var orbAutoTouchCfg = true; // false only if the user opted out

  /* Tablets get the orb shown automatically (no D press needed): a
   * coarse pointer with no hover capability and touch support, on a
   * screen wide enough to not be a phone. Desktops with touchscreens
   * (fine pointer available) and phones are excluded. */
  function isTabletLike() {
    try {
      var coarse = window.matchMedia &&
        window.matchMedia("(pointer: coarse) and (hover: none)").matches;
      var touch = (navigator.maxTouchPoints || 0) > 0 ||
        "ontouchstart" in window;
      var wide = Math.min(window.innerWidth, window.innerHeight) >= 600;
      return !!(coarse && touch && wide);
    } catch (e) { return false; }
  }

  /* ---- named sessions: parallel annotation sets per deck ---- */
  var docBase = "quarto-ink:" + STORE_VERSION + ":" + location.pathname;
  var session = "";           // "" = the default session
  try { session = localStorage.getItem(docBase + ":session") || ""; }
  catch (e) { /* ignore */ }

  function docKey() {
    return docBase +
      (session ? ":s:" + encodeURIComponent(session) : "");
  }

  function sessionList() {
    try {
      return JSON.parse(
        localStorage.getItem(docBase + ":sessions")) || [];
    } catch (e) { return []; }
  }

  function saveSessionList(list) {
    try {
      localStorage.setItem(docBase + ":sessions",
        JSON.stringify(list));
    } catch (e) { /* ignore */ }
  }
  var settingsKey = "quarto-ink-settings:v2";

  /* ================= storage ================= */

  // runtime caches (bounding boxes, edit flags) stay in memory
  function stripPrivate(k, v) {
    return k.charAt(0) === "_" ? undefined : v;
  }

  function persist() {
    try {
      localStorage.setItem(docKey(),
        JSON.stringify(strokes, stripPrivate));
      localStorage.setItem(docKey() + ":ts", String(Date.now()));
    } catch (e) { /* private mode or full: keep in memory */ }
  }

  function restore() {
    var local = null;
    try {
      local = JSON.parse(localStorage.getItem(docKey())) || null;
    } catch (e) { local = null; }

    /* An exported deck carries its drawings as an embedded seed.
     * Each export has a unique id: the first time this particular
     * export is opened its seed wins over any stale localStorage
     * left by earlier files at the same path; afterwards edits made
     * in the file take precedence again. */
    var seed = window.InkAnnotateSeed;
    if (seed) {
      var seedStrokes = seed.strokes || seed; // also old seed format
      var seedId = String(seed.id || "legacy");
      var imported = null;
      try { imported = localStorage.getItem(docKey() + ":seed"); }
      catch (e) { /* ignore */ }
      if (imported !== seedId || !local) {
        strokes = JSON.parse(JSON.stringify(seedStrokes));
        try { localStorage.setItem(docKey() + ":seed", seedId); }
        catch (e) { /* ignore */ }
        persist();
        return;
      }
    }
    strokes = local || {};
  }

  function saveSettings() {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        toolCfg: toolCfg, penOnly: penOnly,
        boardPages: boardPages, boardPage: boardPage,
        boardBg: boardBg
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
        if (s.boardPages >= 1) boardPages = s.boardPages;
        if (s.boardPage >= 0 && s.boardPage < boardPages) {
          boardPage = s.boardPage;
        }
        if (BOARD_BGS.indexOf(s.boardBg) >= 0) boardBg = s.boardBg;
      }
    } catch (e) { /* ignore */ }
  }

  function cfg() {
    return toolCfg[tool] || toolCfg.pen;
  }

  /* ================= whiteboard ================= */

  /* The whiteboard is an opaque surface over the deck with its own
   * multi-page ink, independent of slides. Every tool works on it;
   * its strokes live under "board.<page>" keys, so undo history and
   * persistence come for free. */

  var boardOn = false;
  var boardPage = 0;
  var boardPages = 1;
  var boardEl = null, boardBar = null, boardLabel = null;
  var BOARD_BGS = ["dots", "grid", "lines", "blank"];
  var BOARD_BG_NAMES = {
    dots: "Dotted", grid: "Squared", lines: "Ruled", blank: "Blank"
  };
  var boardBg = "dots";

  function applyBoardBg() {
    if (!boardEl) return;
    boardEl.className = "ink-board-bg-" + boardBg;
  }

  function setBoardBackground(bg) {
    if (BOARD_BGS.indexOf(bg) < 0) return;
    boardBg = bg;
    invalidateLens();
    applyBoardBg();
    saveSettings();
  }

  function cycleBoardBg() {
    var i = (BOARD_BGS.indexOf(boardBg) + 1) % BOARD_BGS.length;
    setBoardBackground(BOARD_BGS[i]);
    showToast("Background: " + BOARD_BG_NAMES[boardBg]);
  }

  /* Drawings are keyed per slide; on slides with panel-tabsets the
   * active tab combination extends the key, so every tab keeps its
   * own ink and undo history. Slides without tabsets keep the plain
   * "h.v" key (backwards compatible with stored drawings). While the
   * whiteboard is open, its page key takes over entirely. */
  function slideKey() {
    if (boardOn) return "board." + boardPage;
    var idx = deck.getIndices();
    var key = idx.h + "." + (idx.v || 0);
    var slide = deck.getCurrentSlide && deck.getCurrentSlide();
    if (slide) {
      var sets = slide.querySelectorAll(".panel-tabset");
      if (sets.length > 0) {
        var t = [];
        sets.forEach(function (ts) {
          var tabs = ts.querySelectorAll(
            "ul [role='tab'], ul .nav-link, ul > li > a");
          var act = 0;
          tabs.forEach(function (tb, i) {
            if (tb.getAttribute("aria-selected") === "true" ||
                tb.classList.contains("active")) act = i;
          });
          t.push(act);
        });
        key += "|t" + t.join(".");
      }
    }
    return key;
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
    invalidateLens();
    redraw();
    if (textEditor) placeEditor();
    positionSelBar();
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

  function curveCtrl(s) {
    // control point of a curved arrow (middle entry of 3 points)
    return s.points.length > 2 ? s.points[1] :
      [(s.points[0][0] + s.points[s.points.length - 1][0]) / 2,
       (s.points[0][1] + s.points[s.points.length - 1][1]) / 2];
  }

  function drawArrowHead(tip, ang, size) {
    var len = Math.max(10, size * 3.5);
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - len * Math.cos(ang - 0.45),
               tip[1] - len * Math.sin(ang - 0.45));
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - len * Math.cos(ang + 0.45),
               tip[1] - len * Math.sin(ang + 0.45));
  }

  function drawShape(s) {
    var a = s.points[0];
    var b = s.points[s.points.length - 1];
    ctx.beginPath();
    if (s.shape === "line" || s.shape === "arrow") {
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      if (s.shape === "arrow") {
        drawArrowHead(b,
          Math.atan2(b[1] - a[1], b[0] - a[0]), s.size);
      }
    } else if (s.shape === "curve") {
      var cc = curveCtrl(s);
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(cc[0], cc[1], b[0], b[1]);
      drawArrowHead(b,
        Math.atan2(b[1] - cc[1], b[0] - cc[0]), s.size);
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

  // friendly rounded annotation look, with system fallbacks
  var TEXT_FAMILY = "ui-rounded, 'SF Pro Rounded', 'Avenir Next', " +
    "'Trebuchet MS', 'Segoe UI', Roboto, sans-serif";
  var TEXT_FONT = "600 %px " + TEXT_FAMILY;

  function fontPx(size) {
    return Math.round(10 + size * 3);
  }

  function textFont(size, scale) {
    return TEXT_FONT.replace("%", String(fontPx(size) * (scale || 1)));
  }

  /* readable text color for a colored card background */
  function darkText(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#1e293b";
    var n = parseInt(m[1], 16);
    var lum = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) +
               0.114 * (n & 255)) / 255;
    return lum > 0.55 ? "#1e293b" : "#ffffff";
  }

  function drawText(s) {
    if (!s.text) return;
    var px = fontPx(s.size);
    var lh = Math.round(px * 1.3);
    ctx.font = textFont(s.size);
    ctx.textBaseline = "top";
    var lines = s.text.split("\n");
    var w = 0;
    for (var m = 0; m < lines.length; m++) {
      w = Math.max(w, ctx.measureText(lines[m]).width);
    }
    s._w = w;
    s._h = lines.length * lh;
    if (s.sticky) {
      // sticky note: rounded colored card behind the text
      var pad = px * 0.55;
      var x = s.points[0][0] - pad, y = s.points[0][1] - pad;
      var bw = w + pad * 2, bh = s._h + pad * 2;
      var r = Math.min(10, pad);
      ctx.save();
      ctx.shadowColor = "rgba(15, 23, 42, 0.28)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = s.color;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, bw, bh, r);
      else ctx.rect(x, y, bw, bh);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = darkText(s.color);
    } else {
      ctx.fillStyle = s.color;
    }
    for (var i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], s.points[0][0], s.points[0][1] + i * lh);
    }
  }

  function textBox(s) {
    var px = fontPx(s.size);
    var w = s._w != null ? s._w : (s.text || "").length * px * 0.6;
    var h = s._h != null ? s._h
      : (s.text || "").split("\n").length * Math.round(px * 1.3);
    var pad = s.sticky ? px * 0.55 : 0;
    return { x: s.points[0][0] - pad, y: s.points[0][1] - pad,
             w: w + pad * 2, h: h + pad * 2 };
  }

  /* pasted slide snapshots: two corner points spanning the image */
  function imageBox(s) {
    var a = s.points[0], b = s.points[1];
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
             w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  }

  function drawImageStroke(s) {
    if (!s._img) {
      s._img = new Image();
      s._img.onload = function () {
        invalidate();
        redraw();
      };
      s._img.src = s.src;
    }
    if (!s._img.complete || !s._img.naturalWidth) return;
    var b = imageBox(s);
    ctx.save();
    ctx.shadowColor = "rgba(15, 23, 42, 0.3)";
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 4;
    ctx.drawImage(s._img, b.x, b.y, b.w, b.h);
    ctx.restore();
    ctx.strokeStyle = "rgba(30, 41, 59, 0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
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
    if (s.tool === "image") {
      ctx.save();
      ctx.globalAlpha = 1;
      drawImageStroke(s);
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

  /* A trail is rendered as ONE filled variable-width outline (like
   * pen strokes): the width tapers with age, and a single fill means
   * no overlapping segment caps — no dots, perfectly smooth. */

  function drawTrail(arr, color, maxW, life, alpha) {
    var now = performance.now();
    var pts = [];
    for (var i = 0; i < arr.length; i++) {
      var age = (now - arr[i].t) / life;
      if (age >= 1) continue;
      var k = Math.pow(1 - age, 1.6); // eased taper
      pts.push({ x: arr[i].x, y: arr[i].y,
                 w: (maxW * k + 0.8) / 2 });
    }
    if (pts.length < 2) return;
    var left = [], right = [];
    for (var p = 0; p < pts.length; p++) {
      var a = pts[Math.max(0, p - 1)];
      var b = pts[Math.min(pts.length - 1, p + 1)];
      var dx = b.x - a.x, dy = b.y - a.y;
      var len = Math.hypot(dx, dy) || 1;
      var nx = -dy / len, ny = dx / len;
      left.push([pts[p].x + nx * pts[p].w, pts[p].y + ny * pts[p].w]);
      right.push([pts[p].x - nx * pts[p].w, pts[p].y - ny * pts[p].w]);
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (var j = 1; j < left.length - 1; j++) {
      ctx.quadraticCurveTo(left[j][0], left[j][1],
        (left[j][0] + left[j + 1][0]) / 2,
        (left[j][1] + left[j + 1][1]) / 2);
    }
    ctx.lineTo(left[left.length - 1][0], left[left.length - 1][1]);
    var hd = pts[pts.length - 1];
    ctx.arc(hd.x, hd.y, hd.w,
      Math.atan2(left[left.length - 1][1] - hd.y,
                 left[left.length - 1][0] - hd.x),
      Math.atan2(right[right.length - 1][1] - hd.y,
                 right[right.length - 1][0] - hd.x));
    for (var m = right.length - 1; m > 0; m--) {
      ctx.quadraticCurveTo(right[m][0], right[m][1],
        (right[m][0] + right[m - 1][0]) / 2,
        (right[m][1] + right[m - 1][1]) / 2);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawTrails() {
    // eraser: a soft slate wake following the ring
    drawTrail(laser.etrail, "#cbd5e1", 18, ERASER_LIFE, 0.4);
    // laser: wide soft glow underneath a bright core
    drawTrail(laser.trail, "#f43f5e", 12, LASER_LIFE, 0.22);
    drawTrail(laser.trail, "#f43f5e", 5, LASER_LIFE, 0.8);
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
    drawTrails();
    applyFrameTransform();
    if (current && current.points) drawStroke(current);
    validateSelection();
    drawSelectionBox();
  }

  function laserTick() {
    var now = performance.now();
    laser.trail = laser.trail.filter(function (p) {
      return now - p.t < LASER_LIFE;
    });
    laser.etrail = laser.etrail.filter(function (p) {
      return now - p.t < ERASER_LIFE;
    });
    redraw();
    laser.raf = (laser.trail.length > 0 || laser.etrail.length > 0)
      ? requestAnimationFrame(laserTick) : null;
  }

  /* light exponential smoothing keeps the trail fluid */
  function pushTrailPoint(arr, x, y) {
    var last = arr[arr.length - 1];
    if (last) {
      x = last.x + (x - last.x) * 0.55;
      y = last.y + (y - last.y) * 0.55;
    }
    arr.push({ x: x, y: y, t: performance.now() });
    if (!laser.raf) laser.raf = requestAnimationFrame(laserTick);
  }

  function pushLaserPoint(x, y) {
    pushTrailPoint(laser.trail, x, y);
    laser.dot.style.display = "block";
    laser.dot.style.left = x + "px";
    laser.dot.style.top = y + "px";
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
      var st = inverse ? cmd.before : cmd.after;
      cmd.stroke.text = st.text;
      cmd.stroke.size = st.size;
      cmd.stroke.points[0] = st.point.slice();
      cmd.stroke._w = cmd.stroke._h = null;
    } else if (cmd.type === "move") {
      cmd.stroke.points = (inverse ? cmd.from : cmd.to)
        .map(function (p) { return p.slice(); });
    } else if (cmd.type === "resize") {
      cmd.stroke.size = inverse ? cmd.before : cmd.after;
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
    } else if (s.shape === "curve") {
      var cc = curveCtrl(s);
      for (var v = 0; v <= 12; v++) {
        var t = v / 12, mt = 1 - t;
        out.push([
          mt * mt * a[0] + 2 * mt * t * cc[0] + t * t * b[0],
          mt * mt * a[1] + 2 * mt * t * cc[1] + t * t * b[1]
        ]);
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
      if (s.tool === "text" || s.tool === "image") {
        var b = s.tool === "text" ? textBox(s) : imageBox(s);
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
      else if (s.shape === "rect" || s.shape === "ellipse") snapBox(s);
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
    // generous slack: canvas and DOM font metrics can differ slightly
    ed.el.style.width = Math.ceil(w * 1.06 + px * 1.2) + "px";
    ed.el.style.height = Math.ceil(lines.length * px * 1.3 + 10) + "px";
    placeControls();
  }

  function placeControls() {
    var ed = textEditor;
    if (!ed || !ed.bar) return;
    var left = parseFloat(ed.el.style.left);
    var top = parseFloat(ed.el.style.top);
    var bw = ed.bar.offsetWidth || 190;
    var bh = ed.bar.offsetHeight || 48;
    // centered above the box, below it if there is no room
    var x = left + ed.el.offsetWidth / 2 - bw / 2;
    var y = top - bh - 12;
    if (y < 8) y = top + ed.el.offsetHeight + 12;
    x = Math.max(8, Math.min(window.innerWidth - bw - 8, x));
    y = Math.min(window.innerHeight - bh - 8, y);
    ed.bar.style.left = x + "px";
    ed.bar.style.top = y + "px";
  }

  function placeEditor() {
    var ed = textEditor;
    var f = slideFrame();
    var px = fontPx(ed.size) * f.scale;
    // border (1.5) + padding (4/6) offsets keep glyphs where they
    // will render once committed
    ed.el.style.left = (f.left + ed.x * f.scale - 7.5) + "px";
    ed.el.style.top = (f.top + ed.y * f.scale - 5.5) + "px";
    ed.el.style.fontFamily = TEXT_FAMILY;
    ed.el.style.fontWeight = "600";
    ed.el.style.fontSize = px + "px";
    ed.el.style.lineHeight = (px * 1.3) + "px";
    if (ed.sticky) {
      ed.el.style.background = ed.color;
      ed.el.style.color = darkText(ed.color);
      ed.el.style.caretColor = darkText(ed.color);
    } else {
      ed.el.style.background = "";
      ed.el.style.color = ed.color;
      ed.el.style.caretColor = ed.color;
    }
    ed.el.style.setProperty("--ink-text-tint", ed.color);
    measureEditor();
  }

  /* Corner controls on the editor: a drag handle to move the box and
   * plus/minus buttons stepping the font size through the size ring's
   * stops. mousedown is prevented so the textarea keeps its focus. */

  function stepSize(cur, dir) {
    var i = 0, best = Infinity;
    for (var k = 0; k < SIZES.length; k++) {
      var d = Math.abs(SIZES[k] - cur);
      if (d < best) { best = d; i = k; }
    }
    i = Math.max(0, Math.min(SIZES.length - 1, i + dir));
    return SIZES[i];
  }

  function buildEditorControls(ed) {
    // same look and placement as the shape selection bar
    var bar = document.createElement("div");
    bar.className = "ink-text-controls ink-sel-controls ink-ed-controls";
    bar.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });

    function btn(cls, svg, label) {
      var b = document.createElement("button");
      b.className = "ink-text-btn" + (cls ? " " + cls : "");
      b.innerHTML = svg;
      b.title = label;
      b.setAttribute("aria-label", label);
      bar.appendChild(b);
      return b;
    }

    function restyle(dir) {
      ed.size = stepSize(ed.size, dir);
      if (ed.isNew) {
        toolCfg.text.size = ed.size;
        saveSettings();
        syncBloom();
      }
      placeEditor();
      ed.el.focus();
    }

    var move = btn("ink-text-move", ICONS.grab, "Move");
    var minus = btn("", ICONS.minus, "Smaller text");
    var plus = btn("", ICONS.plus, "Larger text");
    var trash = btn("ink-text-trash", ICONS.trash, "Delete note");

    minus.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation(); restyle(-1);
    });
    plus.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation(); restyle(1);
    });
    trash.addEventListener("pointerdown", function (e) {
      e.preventDefault(); e.stopPropagation();
      // committing with empty text erases an existing note
      // (undoable) and simply discards a brand-new one
      ed.el.value = "";
      commitTextEditor();
      showToast("Note deleted");
    });

    move.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var f = slideFrame();
      var start = { px: e.clientX, py: e.clientY, x: ed.x, y: ed.y };
      try { move.setPointerCapture(e.pointerId); } catch (err) {}
      function mv(ev) {
        ed.x = start.x + (ev.clientX - start.px) / f.scale;
        ed.y = start.y + (ev.clientY - start.py) / f.scale;
        placeEditor();
      }
      function up() {
        move.removeEventListener("pointermove", mv);
        move.removeEventListener("pointerup", up);
        move.removeEventListener("pointercancel", up);
        ed.el.focus();
      }
      move.addEventListener("pointermove", mv);
      move.addEventListener("pointerup", up);
      move.addEventListener("pointercancel", up);
    });

    return bar;
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
      sticky: stroke ? !!stroke.sticky : tool === "note",
      x: stroke ? stroke.points[0][0] : x,
      y: stroke ? stroke.points[0][1] : y,
      size: stroke ? stroke.size : c.size,
      color: stroke ? stroke.color : c.color
    };
    ta.classList.toggle("ink-sticky-editor", textEditor.sticky);
    if (stroke) {
      ta.value = stroke.text;
      stroke._editing = true;
      invalidate();
      redraw();
    }
    textEditor.bar = buildEditorControls(textEditor);
    document.body.appendChild(ta);
    document.body.appendChild(textEditor.bar);
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
    ta.focus();
    if (stroke) ta.select();
  }

  function removeEditor() {
    var ed = textEditor;
    textEditor = null;
    if (ed.stroke) ed.stroke._editing = false;
    ed.el.remove();
    if (ed.bar) ed.bar.remove();
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
          sticky: ed.sticky || undefined,
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
      return;
    }
    var before = {
      text: ed.stroke.text, size: ed.stroke.size,
      point: ed.stroke.points[0].slice()
    };
    var after = { text: text, size: ed.size, point: [ed.x, ed.y] };
    if (before.text !== after.text || before.size !== after.size ||
        before.point[0] !== after.point[0] ||
        before.point[1] !== after.point[1]) {
      execute({ type: "edit", stroke: ed.stroke,
                before: before, after: after });
    }
  }

  /* ================= shape selection =================
   * With the shape tool active, tapping an existing shape selects it:
   * a dashed bounding box appears plus the same corner control bar
   * as text notes (move handle, stroke width +/- and delete).
   * Dragging a selected shape moves it; all operations are undoable. */

  var selected = null;
  var selBar = null;

  function strokeBBox(s) {
    var xs = s.points.map(function (p) { return p[0]; });
    var ys = s.points.map(function (p) { return p[1]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var pad = (s.size || 3) + 8;
    return { x: x0 - pad, y: y0 - pad,
             w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
  }

  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var l2 = dx * dx + dy * dy;
    var t = l2 === 0 ? 0 :
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  /* Hit test matching what users perceive as "the shape": the full
   * interior for rects and ellipses, the actual segment for lines. */
  function shapeHit(s, p, r) {
    var a = s.points[0];
    var b = s.points[s.points.length - 1];
    var pad = r + (s.size || 3);
    if (s.shape === "rect") {
      return p[0] >= Math.min(a[0], b[0]) - pad &&
             p[0] <= Math.max(a[0], b[0]) + pad &&
             p[1] >= Math.min(a[1], b[1]) - pad &&
             p[1] <= Math.max(a[1], b[1]) + pad;
    }
    if (s.shape === "ellipse") {
      var rx = Math.abs(b[0] - a[0]) / 2 + pad;
      var ry = Math.abs(b[1] - a[1]) / 2 + pad;
      var cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      var nx = (p[0] - cx) / (rx || 1), ny = (p[1] - cy) / (ry || 1);
      return nx * nx + ny * ny <= 1;
    }
    if (s.shape === "curve") {
      var pts = shapeSamplePoints(s);
      for (var k = 1; k < pts.length; k++) {
        if (segDist(p, pts[k - 1], pts[k]) <= pad) return true;
      }
      return false;
    }
    return segDist(p, a, b) <= pad;
  }

  /* hit test for any selectable stroke: shapes by geometry, pen and
   * highlighter strokes by distance to their polyline */
  function shapeAt(p, r) {
    var list = slideStrokes();
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      if (s.tool === "shape") {
        if (shapeHit(s, p, r)) return s;
      } else if (s.tool === "image") {
        var ib = imageBox(s);
        if (p[0] >= ib.x - r && p[0] <= ib.x + ib.w + r &&
            p[1] >= ib.y - r && p[1] <= ib.y + ib.h + r) return s;
      } else if (s.tool === "pen" || s.tool === "highlighter") {
        var pad = r + (s.tool === "highlighter"
          ? s.size * 2.2 : s.size / 2 + 2);
        var pts = s.points;
        if (pts.length === 1) {
          if (Math.hypot(pts[0][0] - p[0], pts[0][1] - p[1]) <= pad) {
            return s;
          }
          continue;
        }
        for (var k = 1; k < pts.length; k++) {
          if (segDist(p, pts[k - 1], pts[k]) <= pad) return s;
        }
      }
    }
    return null;
  }

  function positionSelBar() {
    if (!selected || !selBar) return;
    var f = slideFrame();
    var b = strokeBBox(selected);
    var bw = selBar.offsetWidth || 190;
    var bh = selBar.offsetHeight || 48;
    // centered above the selection box, below it if there is no room
    var x = f.left + (b.x + b.w / 2) * f.scale - bw / 2;
    var y = f.top + b.y * f.scale - bh - 12;
    if (y < 8) y = f.top + (b.y + b.h) * f.scale + 12;
    x = Math.max(8, Math.min(window.innerWidth - bw - 8, x));
    y = Math.min(window.innerHeight - bh - 8, y);
    selBar.style.left = x + "px";
    selBar.style.top = y + "px";
    positionSelHandles();
  }

  function buildSelBar() {
    selBar = document.createElement("div");
    selBar.className = "ink-text-controls ink-sel-controls";
    selBar.style.display = "none";
    selBar.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });

    function btn(cls, svg, label, onDown) {
      var b = document.createElement("button");
      b.className = "ink-text-btn" + (cls ? " " + cls : "");
      b.innerHTML = svg;
      b.title = label;
      b.setAttribute("aria-label", label);
      if (onDown) {
        b.addEventListener("pointerdown", function (e) {
          e.preventDefault(); e.stopPropagation(); onDown(e);
        });
      }
      selBar.appendChild(b);
      return b;
    }

    var move = btn("ink-text-move", ICONS.grab, "Move");
    btn("", ICONS.minus, "Thinner stroke", function () {
      if (!selected) return;
      execute({ type: "resize", stroke: selected,
                before: selected.size,
                after: stepSize(selected.size, -1) });
      positionSelBar();
    });
    btn("", ICONS.plus, "Thicker stroke", function () {
      if (!selected) return;
      execute({ type: "resize", stroke: selected,
                before: selected.size,
                after: stepSize(selected.size, 1) });
      positionSelBar();
    });
    btn("", ICONS.copy, "Duplicate (Cmd/Ctrl+C, V)", function () {
      if (selected) duplicateStroke(selected);
    });
    btn("ink-text-trash", ICONS.trash, "Delete shape", function () {
      if (!selected) return;
      var s = selected;
      deselect();
      execute({ type: "erase", items: [{
        index: slideStrokes().indexOf(s), stroke: s
      }] });
      showToast("Shape deleted");
    });

    move.addEventListener("pointerdown", function (e) {
      if (!selected) return;
      e.preventDefault();
      e.stopPropagation();
      var f = slideFrame();
      var s = selected;
      var start = { px: e.clientX, py: e.clientY,
                    pts: s.points.map(function (p) { return p.slice(); }) };
      try { move.setPointerCapture(e.pointerId); } catch (err) {}
      function mv(ev) {
        var dx = (ev.clientX - start.px) / f.scale;
        var dy = (ev.clientY - start.py) / f.scale;
        s.points = start.pts.map(function (p) {
          var q = p.slice(); q[0] += dx; q[1] += dy; return q;
        });
        invalidate();
        redraw();
        positionSelBar();
      }
      function up() {
        move.removeEventListener("pointermove", mv);
        move.removeEventListener("pointerup", up);
        move.removeEventListener("pointercancel", up);
        var h = slideHistory();
        h.done.push({ type: "move", stroke: s, from: start.pts,
          to: s.points.map(function (p) { return p.slice(); }) });
        if (h.done.length > HISTORY_LIMIT) h.done.shift();
        h.undone = [];
        persist();
        refreshHistoryButtons();
      }
      move.addEventListener("pointermove", mv);
      move.addEventListener("pointerup", up);
      move.addEventListener("pointercancel", up);
    });

    document.body.appendChild(selBar);
  }

  /* ---------- resize handles + curve control handle ---------- */

  var selHandles = null; // 4 corner squares
  var ctrlHandle = null; // curved arrow control point

  function rawBBox(s) {
    var xs = s.points.map(function (p) { return p[0]; });
    var ys = s.points.map(function (p) { return p[1]; });
    return { x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
             y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys) };
  }

  function buildSelHandles() {
    selHandles = [];
    for (var i = 0; i < 4; i++) {
      var h = document.createElement("div");
      h.className = "ink-sel-handle";
      h.dataset.corner = String(i); // 0 tl, 1 tr, 2 br, 3 bl
      h.style.display = "none";
      attachResize(h);
      document.body.appendChild(h);
      selHandles.push(h);
    }
    ctrlHandle = document.createElement("div");
    ctrlHandle.className = "ink-sel-handle ink-sel-ctrl";
    ctrlHandle.title = "Bend";
    ctrlHandle.style.display = "none";
    attachCtrlDrag(ctrlHandle);
    document.body.appendChild(ctrlHandle);
  }

  function attachResize(h) {
    h.addEventListener("pointerdown", function (e) {
      if (!selected) return;
      e.preventDefault();
      e.stopPropagation();
      var s = selected;
      var f = slideFrame();
      var b = rawBBox(s);
      var corner = Number(h.dataset.corner);
      // the corner opposite to the grabbed one stays fixed
      var ax = (corner === 1 || corner === 2) ? b.x0 : b.x1;
      var ay = (corner === 2 || corner === 3) ? b.y0 : b.y1;
      var start = {
        pts: s.points.map(function (p) { return p.slice(); }),
        w: (corner === 1 || corner === 2) ? b.x1 - b.x0 : b.x0 - b.x1,
        h: (corner === 2 || corner === 3) ? b.y1 - b.y0 : b.y0 - b.y1
      };
      try { h.setPointerCapture(e.pointerId); } catch (err) {}
      function mv(ev) {
        var q = toSlide(ev.clientX, ev.clientY, f);
        var sx = start.w ? (q[0] - ax) / start.w : 1;
        var sy = start.h ? (q[1] - ay) / start.h : 1;
        if (Math.abs(sx) < 0.05) sx = sx < 0 ? -0.05 : 0.05;
        if (Math.abs(sy) < 0.05) sy = sy < 0 ? -0.05 : 0.05;
        if (s.tool === "image") {
          // pasted slides keep their aspect ratio: uniform scale
          // from the drag distance along the box diagonal
          var d0 = Math.hypot(start.w, start.h) || 1;
          var d1 = Math.hypot(q[0] - ax, q[1] - ay);
          sx = sy = Math.max(0.05, d1 / d0);
        }
        s.points = start.pts.map(function (p) {
          var n = p.slice();
          n[0] = ax + (p[0] - ax) * sx;
          n[1] = ay + (p[1] - ay) * sy;
          return n;
        });
        invalidate();
        redraw();
        positionSelBar();
      }
      function up() {
        h.removeEventListener("pointermove", mv);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        pushMoveCmd(s, start.pts);
      }
      h.addEventListener("pointermove", mv);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
  }

  function attachCtrlDrag(h) {
    h.addEventListener("pointerdown", function (e) {
      if (!selected || selected.shape !== "curve") return;
      e.preventDefault();
      e.stopPropagation();
      var s = selected;
      var f = slideFrame();
      var start = s.points.map(function (p) { return p.slice(); });
      try { h.setPointerCapture(e.pointerId); } catch (err) {}
      function mv(ev) {
        var q = toSlide(ev.clientX, ev.clientY, f);
        s.points[1] = [q[0], q[1]];
        invalidate();
        redraw();
        positionSelBar();
      }
      function up() {
        h.removeEventListener("pointermove", mv);
        h.removeEventListener("pointerup", up);
        h.removeEventListener("pointercancel", up);
        pushMoveCmd(s, start);
      }
      h.addEventListener("pointermove", mv);
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
    });
  }

  var clipboard = null;

  function duplicateStroke(s) {
    var copy = JSON.parse(JSON.stringify(s, stripPrivate));
    copy.points = copy.points.map(function (p) {
      p[0] += 16;
      p[1] += 16;
      return p;
    });
    execute({ type: "add", stroke: copy });
    selectStroke(copy);
    showToast("Duplicated");
  }

  function pushMoveCmd(s, fromPts) {
    var to = s.points.map(function (p) { return p.slice(); });
    var same = fromPts.length === to.length &&
      fromPts.every(function (p, i) {
        return p[0] === to[i][0] && p[1] === to[i][1];
      });
    if (same) return;
    var hh = slideHistory();
    hh.done.push({ type: "move", stroke: s, from: fromPts, to: to });
    if (hh.done.length > HISTORY_LIMIT) hh.done.shift();
    hh.undone = [];
    persist();
    refreshHistoryButtons();
  }

  function positionSelHandles() {
    if (!selHandles) return;
    if (!selected) {
      selHandles.forEach(function (h) { h.style.display = "none"; });
      ctrlHandle.style.display = "none";
      return;
    }
    var f = slideFrame();
    var b = strokeBBox(selected);
    var xs = [b.x, b.x + b.w, b.x + b.w, b.x];
    var ys = [b.y, b.y, b.y + b.h, b.y + b.h];
    for (var i = 0; i < 4; i++) {
      selHandles[i].style.display = "block";
      selHandles[i].style.left =
        (f.left + xs[i] * f.scale) + "px";
      selHandles[i].style.top =
        (f.top + ys[i] * f.scale) + "px";
    }
    if (selected.tool === "shape" && selected.shape === "curve") {
      var cc = curveCtrl(selected);
      ctrlHandle.style.display = "block";
      ctrlHandle.style.left = (f.left + cc[0] * f.scale) + "px";
      ctrlHandle.style.top = (f.top + cc[1] * f.scale) + "px";
    } else {
      ctrlHandle.style.display = "none";
    }
  }

  function selectStroke(s) {
    if (!selBar) buildSelBar();
    if (!selHandles) buildSelHandles();
    selected = s;
    selBar.style.display = "flex";
    positionSelBar();
    positionSelHandles();
    redraw();
  }

  function deselect() {
    if (!selected) return;
    selected = null;
    if (selBar) selBar.style.display = "none";
    positionSelHandles();
    redraw();
  }

  /* dropped from the stroke list (erased, cleared, undone add)? */
  function validateSelection() {
    if (selected && slideStrokes().indexOf(selected) < 0) {
      selected = null;
      if (selBar) selBar.style.display = "none";
      positionSelHandles();
    }
  }

  function drawSelectionBox() {
    if (!selected) return;
    var f = slideFrame();
    var b = strokeBBox(selected);
    ctx.save();
    ctx.strokeStyle = "#0a84ff";
    ctx.lineWidth = 1.5 / f.scale;
    ctx.setLineDash([6 / f.scale, 4 / f.scale]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }

  /* ================= pointer handling ================= */

  var touchIds = [];
  var gestureUndo = false;

  function accepts(e) {
    return !(penOnly && e.pointerType !== "pen");
  }

  /* Targeted pass-through: selected deck widgets stay usable in draw
   * mode. The full hit-test stack is scanned (decks can carry their
   * own overlay canvases), skipping our ink canvas. */

  var CLICK_THROUGH_SEL =
    ".panel-tabset [role='tab'], .panel-tabset .nav-link, " +
    ".panel-tabset > ul > li > a, " +
    ".leaflet-control-container a, .leaflet-control-container button, " +
    ".maplibregl-ctrl button, .mapboxgl-ctrl button, " +
    ".ol-control button, " +
    "a[role='doc-biblioref'], a.footnote-ref, a.xref";

  /* Pass-through zones: while the pointer hovers one of these, the
   * ink canvas stops intercepting events entirely, so the widget
   * underneath gets REAL pointer interaction (hover styles, expand-
   * on-hover controls, tooltips, clicks). A document-level listener
   * re-arms the canvas once the pointer leaves the zone. */
  var PASS_ZONE_SEL =
    ".panel-tabset [role='tab'], .panel-tabset .nav-link, " +
    ".panel-tabset > ul, .nav-tabs, " +
    ".leaflet-control-container, " +
    ".mapboxgl-ctrl, .maplibregl-ctrl, .ol-control, " +
    "a[role='doc-biblioref'], a.footnote-ref, a.xref, " +
    "[data-tippy-root], .tippy-box";

  var passThrough = false;
  var passBlocked = []; // foreign overlays muted while a zone is live

  function setPass(on) {
    if (on === passThrough) return;
    passThrough = on;
    canvas.style.pointerEvents = (drawMode && !on) ? "auto" : "none";
  }

  /* Engage a pass-through zone at a point. Decks can carry their own
   * fullscreen overlay canvases (e.g. a bundled laser pointer) that
   * would swallow the forwarded events; any canvas sitting above the
   * zone widget in the hit stack is muted until the zone is left. */
  function engagePassAt(x, y) {
    var stack = document.elementsFromPoint(x, y);
    var blocked = [];
    var found = null;
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (el === canvas || !el.closest) continue;
      found = el.closest(PASS_ZONE_SEL);
      if (found) break;
      if (el.tagName === "CANVAS") blocked.push(el);
    }
    if (!found) return false;
    blocked.forEach(function (el) {
      passBlocked.push({ el: el, prev: el.style.pointerEvents });
      el.style.pointerEvents = "none";
    });
    setPass(true);
    return true;
  }

  function releasePass() {
    passBlocked.forEach(function (b) {
      b.el.style.pointerEvents = b.prev;
    });
    passBlocked = [];
    setPass(false);
  }

  function interactiveUnder(x, y, sel) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (el === canvas || !el.closest) continue;
      var hit = el.closest(sel);
      if (hit) return hit;
    }
    return null;
  }

  function pressureOf(e) {
    if (e.pointerType === "pen" && e.pressure > 0) return e.pressure;
    return 0.6;
  }

  function onPointerDown(e) {
    if (!drawMode || capturing) return;
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
    // taps on pass-through widgets (tab headers, map controls,
    // citation links) operate the widget instead of drawing
    var widget = interactiveUnder(e.clientX, e.clientY,
      CLICK_THROUGH_SEL);
    if (widget) {
      e.preventDefault();
      widget.click();
      setTimeout(function () {
        invalidate();
        redraw();
        refreshHistoryButtons();
      }, 50);
      return;
    }
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
      pushTrailPoint(laser.etrail, e.clientX, e.clientY);
      current = { tool: "eraser" };
      return;
    }
    if (tool === "laser") {
      pushLaserPoint(e.clientX, e.clientY);
      current = { tool: "laser" };
      return;
    }
    if (tool === "zoom") {
      current = { tool: "zoom" };
      ensureLensShot(function () {
        if (current && current.tool === "zoom") {
          moveLens(e.clientX, e.clientY);
        }
      });
      return;
    }
    // text notes are grabbable with the pen and shape tools too:
    // dragging one moves it instead of drawing over it (the
    // highlighter is exempt so notes can still be highlighted)
    if (tool === "text" || tool === "note" ||
        tool === "pen" || tool === "shape") {
      if ((tool === "text" || tool === "note") && textEditor) {
        // a tap while the editor is open just commits it
        commitTextEditor();
        return;
      }
      var tp = toSlide(e.clientX, e.clientY);
      var hitText = textAt(tp, 6 / slideFrame().scale);
      if (tool === "text" || tool === "note" || hitText) {
        current = {
          tool: "text", startX: e.clientX, startY: e.clientY,
          target: hitText,
          orig: hitText ? hitText.points[0].slice() : null,
          grabTool: tool,
          moved: false
        };
        return;
      }
    }
    if (tool === "shape") {
      var sp = toSlide(e.clientX, e.clientY);
      var hitShape = shapeAt(sp, 10 / slideFrame().scale);
      if (hitShape) {
        selectStroke(hitShape);
        current = {
          tool: "grab", target: hitShape,
          startX: e.clientX, startY: e.clientY,
          orig: hitShape.points.map(function (p) { return p.slice(); }),
          moved: false
        };
        return;
      }
      if (selected) deselect(); // tap on empty space: draw as usual
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
    if (!current && (tool === "pen" || tool === "shape" ||
        tool === "text" || tool === "note")) {
      // entering a pass-through zone hands the pointer to the deck
      // widget below (tabs, map controls, citation previews)
      if (engagePassAt(e.clientX, e.clientY)) return;
      // show a move cursor while hovering a grabbable item
      var hp = toSlide(e.clientX, e.clientY);
      var hf = slideFrame().scale;
      canvas.classList.toggle("ink-link-cursor",
        !!interactiveUnder(e.clientX, e.clientY, CLICK_THROUGH_SEL));
      canvas.classList.toggle("ink-move-cursor",
        !!textAt(hp, 6 / hf) ||
        (tool === "shape" && !!shapeAt(hp, 10 / hf)));
    }
    if (!current || !accepts(e)) return;
    e.preventDefault();
    if (current.tool === "eraser") {
      eraseAt(e.clientX, e.clientY);
      pushTrailPoint(laser.etrail, e.clientX, e.clientY);
      return;
    }
    if (current.tool === "laser") {
      pushLaserPoint(e.clientX, e.clientY);
      return;
    }
    if (current.tool === "zoom") {
      if (lens.shot || !window.html2canvas) {
        moveLens(e.clientX, e.clientY);
      }
      return;
    }
    if (current.tool === "grab") {
      // dragging a selected shape moves it live
      var gdx = e.clientX - current.startX;
      var gdy = e.clientY - current.startY;
      if (!current.moved && Math.hypot(gdx, gdy) > 6) {
        current.moved = true;
      }
      if (current.moved) {
        var gsc = slideFrame().scale;
        current.target.points = current.orig.map(function (p) {
          var q = p.slice();
          q[0] += gdx / gsc;
          q[1] += gdy / gsc;
          return q;
        });
        invalidate();
        redraw();
        positionSelBar();
      }
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
      var a0 = current.points[0];
      if (current.shape === "curve") {
        // auto control point: perpendicular offset from the middle,
        // adjustable later via the selection's control handle
        current.points = [a0,
          [(a0[0] + q[0]) / 2 - (q[1] - a0[1]) * 0.25,
           (a0[1] + q[1]) / 2 + (q[0] - a0[0]) * 0.25],
          [q[0], q[1]]];
      } else {
        current.points = [a0, [q[0], q[1]]];
      }
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
    if (current.tool === "zoom") {
      hideLens();
      current = null;
      return;
    }
    if (current.tool === "eraser") {
      commitEraseBatch();
      current = null;
      return;
    }
    if (current.tool === "grab") {
      var g = current;
      current = null;
      if (g.moved) {
        var gh = slideHistory();
        gh.done.push({ type: "move", stroke: g.target, from: g.orig,
          to: g.target.points.map(function (p) { return p.slice(); }) });
        if (gh.done.length > HISTORY_LIMIT) gh.done.shift();
        gh.undone = [];
        persist();
        refreshHistoryButtons();
      }
      return;
    }
    if (current.tool === "text") {
      var tcur = current;
      current = null;
      if (tcur.target && tcur.moved) {
        // record the finished move as one undoable command
        var th = slideHistory();
        th.done.push({ type: "move", stroke: tcur.target,
                       from: [tcur.orig],
                       to: [tcur.target.points[0].slice()] });
        if (th.done.length > HISTORY_LIMIT) th.done.shift();
        th.undone = [];
        persist();
        refreshHistoryButtons();
      } else if (tcur.grabTool !== "text" &&
                 tcur.grabTool !== "note") {
        // a grab that never moved, made with another tool: no-op
        redraw();
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
      // a fresh shape is selected right away so its controls
      // (move, stroke width, delete) are immediately visible
      if (stroke.tool === "shape") selectStroke(stroke);
    } else {
      current = null;
      redraw();
    }
  }

  /* ================= export ================= */

  /* PNG export captures the current slide WITH its ink on top (the
   * same rasteriser as the PDF export), not just the bare ink. */
  function exportPng() {
    if (!window.html2canvas) {
      // fallback: ink only, on white
      var bare = document.createElement("canvas");
      bare.width = canvas.width;
      bare.height = canvas.height;
      var bctx2 = bare.getContext("2d");
      bctx2.fillStyle = "#ffffff";
      bctx2.fillRect(0, 0, bare.width, bare.height);
      bctx2.drawImage(canvas, 0, 0);
      downloadPng(bare);
      return;
    }
    showToast("Rendering PNG…", 15000);
    commitTextEditor();
    deselect();
    closeBloom();
    hideMenu();
    var W = window.innerWidth, H = window.innerHeight;
    var cur = deck.getCurrentSlide();
    window.html2canvas(document.body, {
      scale: 2,
      useCORS: true,
      logging: false,
      width: W, height: H,
      windowWidth: W, windowHeight: H,
      ignoreElements: function (el) {
        if (el.matches && el.matches(PDF_IGNORE_SEL)) return true;
        return el.tagName === "SECTION" &&
               el !== cur &&
               !el.contains(cur) &&
               !cur.contains(el);
      }
    }).then(function (shot) {
      var out = document.createElement("canvas");
      out.width = shot.width;
      out.height = shot.height;
      var c2 = out.getContext("2d");
      c2.drawImage(shot, 0, 0);
      c2.drawImage(canvas, 0, 0, out.width, out.height);
      downloadPng(out);
    }).catch(function () {
      showToast("PNG export failed");
    });
  }

  function downloadPng(cv) {
    var a = document.createElement("a");
    a.download = "slide-" + slideKey().replace(/[|]/g, "-") +
      "-annotated.png";
    a.href = cv.toDataURL("image/png");
    a.click();
    showToast("Slide exported as PNG");
  }

  /* Export the whole deck as a standalone HTML file with every
   * slide's ink embedded: the document is cloned without the live
   * ink UI, the strokes are injected as a seed script that restore()
   * picks up, and every same-origin stylesheet, script and image is
   * inlined so the single downloaded file works anywhere. */

  function absUrl(ref, base) {
    try { return new URL(ref, base).href; } catch (e) { return ref; }
  }

  function fetchText(url) {
    return fetch(url).then(function (r) {
      return r.ok ? r.text() : null;
    }).catch(function () { return null; });
  }

  function fetchDataUri(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) return null;
      return r.blob().then(function (b) {
        return new Promise(function (resolve) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { resolve(null); };
          fr.readAsDataURL(b);
        });
      });
    }).catch(function () { return null; });
  }

  /* inline url(...) assets referenced by a stylesheet (fonts, images) */
  function inlineCssAssets(css, cssUrl) {
    var refs = [];
    css.replace(/url\((['"]?)([^)'"]+)\1\)/g, function (m, q, ref) {
      if (ref.indexOf("data:") !== 0 && refs.indexOf(ref) < 0) {
        refs.push(ref);
      }
      return m;
    });
    return Promise.all(refs.map(function (ref) {
      return fetchDataUri(absUrl(ref, cssUrl));
    })).then(function (uris) {
      refs.forEach(function (ref, i) {
        if (!uris[i]) return;
        css = css.split(ref).join(uris[i]);
      });
      return css;
    });
  }

  function exportHtml() {
    showToast("Preparing annotated HTML…", 4000);
    var clone = document.documentElement.cloneNode(true);
    // strip everything that scripts recreate at runtime — leaving
    // these in the clone would duplicate them when the exported
    // file boots (our UI, quarto menu, deck widgets like progress
    // indicators, laser pointers, chalkboards, tooltips)
    clone.querySelectorAll(
      "#ink-canvas, #ink-orb-root, #ink-toast, #ink-laser, " +
      "#ink-eraser-ring, .ink-text-editor, .ink-text-controls, " +
      ".ink-sel-handle, #ink-board, #ink-board-bar, " +
      ".slide-menu-wrapper, .slide-menu-button, " +
      ".progress-indicator, .indicator-settings-btn, " +
      ".indicator-settings-panel, .indicator-tooltip, " +
      "#laser-container, #laser-canvas, .cursor-dropdown, " +
      ".slide-chalkboard-buttons, .chalkboard-canvas, " +
      ".chalkboard-palette, " +
      "[data-tippy-root], .tippy-box, .glightbox-container"
    ).forEach(function (el) { el.remove(); });
    var body = clone.querySelector("body");
    body.classList.remove("ink-drawing");

    var seed = document.createElement("script");
    seed.textContent = "window.InkAnnotateSeed = " +
      JSON.stringify({
        id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        strokes: strokes
      }, stripPrivate).replace(/<\//g, "<\\/") + ";";
    // the seed must run before reveal initialises the plugin,
    // so it goes first in <head>, not at the end of <body>
    var head = clone.querySelector("head");
    head.insertBefore(seed, head.firstChild);

    var jobs = [];
    var linked = 0; // resources that could not be embedded

    // When inlining is impossible (file:// pages block local fetch,
    // cross-origin CDNs), rewrite the reference to an absolute URL so
    // the exported file still works wherever it is saved.

    clone.querySelectorAll("link[rel='stylesheet']")
      .forEach(function (link) {
        var url = absUrl(link.getAttribute("href"), document.baseURI);
        jobs.push(fetchText(url).then(function (css) {
          if (css == null) {
            link.setAttribute("href", url);
            linked++;
            return;
          }
          return inlineCssAssets(css, url).then(function (full) {
            var st = document.createElement("style");
            st.textContent = full;
            link.parentNode.replaceChild(st, link);
          });
        }));
      });

    clone.querySelectorAll("script[src]").forEach(function (sc) {
      var url = absUrl(sc.getAttribute("src"), document.baseURI);
      jobs.push(fetchText(url).then(function (js) {
        if (js == null) {
          sc.setAttribute("src", url);
          linked++;
          return;
        }
        sc.removeAttribute("src");
        sc.textContent = js.replace(/<\/script/gi, "<\\/script");
      }));
    });

    clone.querySelectorAll("img[src]").forEach(function (img) {
      var src = img.getAttribute("src");
      if (src.indexOf("data:") === 0) return;
      var url = absUrl(src, document.baseURI);
      jobs.push(fetchDataUri(url).then(function (uri) {
        if (uri) img.setAttribute("src", uri);
        else { img.setAttribute("src", url); linked++; }
      }));
    });

    Promise.all(jobs).then(function () {
      var blob = new Blob(["<!DOCTYPE html>\n" + clone.outerHTML],
        { type: "text/html" });
      var a = document.createElement("a");
      a.download = (document.title || "slides").replace(/\s+/g, "-") +
        "-annotated.html";
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      showToast(linked === 0
        ? "Annotated HTML exported (fully standalone)"
        : "Annotated HTML exported — some assets are linked " +
          "from their original location", 2600);
    });
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

  /* the overflow menu opens next to the More petal, clamped to the
   * viewport (a fixed offset overflows when the orb sits in a corner) */
  function toggleMenu() {
    if (menuEl.classList.contains("ink-visible")) {
      hideMenu();
      return;
    }
    menuEl.classList.add("ink-visible");
    var moreBtn = bloomEl.querySelector("[data-key='more']");
    var r = moreBtn.getBoundingClientRect();
    var mw = menuEl.offsetWidth || 200;
    var mh = menuEl.offsetHeight || 180;
    var W = window.innerWidth, H = window.innerHeight;
    var sx = r.left + r.width / 2 - mw / 2;
    var sy = r.top - mh - 12;
    if (sy < 8) sy = Math.min(r.bottom + 12, H - mh - 8);
    sx = Math.max(8, Math.min(W - mw - 8, sx));
    menuEl.style.left = (sx - orbPos.x) + "px";
    menuEl.style.top = (sy - orbPos.y) + "px";
    menuEl.style.transform = "none";
  }

  var dock = { classList: { add: function () {}, remove: function () {} } };

  /* ---------- icons ---------- */

  var ICONS = {
    pen: '<svg viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.9 1.9 3.8 3.8 1.9-1.9z"/></svg>',
    highlighter: '<svg viewBox="0 0 24 24"><path d="M4 21h16v2H4v-2zM17.7 2.9l3.4 3.4c.4.4.4 1 0 1.4l-9.6 9.6-4.8 1.4 1.4-4.8 9.6-9.6c.4-.4 1-.4 1.4 0z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M4 4h16v10.5L14.5 20H4V4zm10.6 14 3.9-3.9h-3.9V18z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="1.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5.5 15.5H4.8A1.8 1.8 0 0 1 3 13.7V4.8A1.8 1.8 0 0 1 4.8 3h8.9a1.8 1.8 0 0 1 1.8 1.8v.7" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M9 4.5 7.6 6.5H4.5A1.5 1.5 0 0 0 3 8v10a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V8a1.5 1.5 0 0 0-1.5-1.5h-3.1L15 4.5H9z"/><circle cx="12" cy="12.8" r="3.4" fill="#10121a"/></svg>',
    zoom: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M15 15l5.4 5.4" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M8 10.5h5M10.5 8v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    bg: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
    board: '<svg viewBox="0 0 24 24"><rect x="3" y="3.5" width="18" height="12.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 16v3.2M7.5 21.2l4.5-2 4.5 2M7 9.5c2-2.4 4 2.4 6 0s2.6-1.4 4-.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M14.6 5.2 8 12l6.6 6.8 1.5-1.4L10.9 12l5.2-5.4-1.5-1.4z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M9.4 5.2 16 12l-6.6 6.8-1.5-1.4L13.1 12 7.9 6.6l1.5-1.4z"/></svg>',
    github: '<svg viewBox="0 0 24 24"><path d="M12 1.8a10.2 10.2 0 0 0-3.22 19.88c.51.09.7-.22.7-.49v-1.72c-2.84.62-3.44-1.37-3.44-1.37-.46-1.18-1.13-1.49-1.13-1.49-.93-.63.07-.62.07-.62 1.03.07 1.57 1.05 1.57 1.05.91 1.57 2.39 1.12 2.97.85.09-.66.36-1.11.65-1.37-2.27-.26-4.65-1.13-4.65-5.04 0-1.11.4-2.02 1.05-2.74-.11-.26-.46-1.3.1-2.7 0 0 .86-.28 2.8 1.05a9.72 9.72 0 0 1 5.11 0c1.94-1.33 2.8-1.05 2.8-1.05.56 1.4.21 2.44.1 2.7.65.72 1.05 1.63 1.05 2.74 0 3.92-2.39 4.78-4.66 5.03.37.32.69.94.69 1.9v2.81c0 .27.18.59.7.49A10.2 10.2 0 0 0 12 1.8z"/></svg>',
    doc: '<svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM8 12h8v1.6H8V12zm0 3.4h8V17H8v-1.6z"/></svg>',
    layers: '<svg viewBox="0 0 24 24"><path d="M12 3 2 8.5 12 14l10-5.5L12 3zm-10 10 10 5.5L22 13l-2-1.1-8 4.4-8-4.4L2 13zm0 3.8 10 5.5 10-5.5-2-1.1-8 4.4-8-4.4-2 1.1z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h14V6H5zm2.5 3.5A1.5 1.5 0 1 1 9 11a1.5 1.5 0 0 1-1.5-1.5zM6.5 16.5 10 12l2.5 3 2-2.5 3.5 4h-11.5z"/></svg>',
    code: '<svg viewBox="0 0 24 24"><path d="M8.6 16.6 4 12l4.6-4.6L10 8.8 6.8 12 10 15.2l-1.4 1.4zm6.8 0L14 15.2 17.2 12 14 8.8l1.4-1.4L20 12l-4.6 4.6z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM6 8h12l-.9 12.1a2 2 0 0 1-2 1.9H8.9a2 2 0 0 1-2-1.9L6 8zm4 3v8h1.6v-8H10zm2.9 0v8h1.6v-8h-1.6z"/></svg>',
    grab: '<svg viewBox="0 0 24 24"><path d="M12 1.8 8.9 4.9l1.4 1.4l.7-.7V11H5.6l.7-.7L4.9 8.9 1.8 12l3.1 3.1 1.4-1.4-.7-.7H11v5.4l-.7-.7-1.4 1.4 3.1 3.1 3.1-3.1-1.4-1.4-.7.7V13h5.4l-.7.7 1.4 1.4 3.1-3.1-3.1-3.1-1.4 1.4.7.7H13V5.6l.7.7 1.4-1.4L12 1.8z"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
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
    curve: '<svg viewBox="0 0 24 24"><path d="M4 20C5 12 10 7 18 6" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M18 6l-5.4-.6M18 6l-1.2 5.2" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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

  function scrollViewActive() {
    var r = deck.getRevealElement();
    return !!(r && r.classList.contains("reveal-scroll"));
  }

  function setDrawMode(on) {
    if (on && scrollViewActive()) {
      showToast("Drawing is unavailable in scroll view");
      return;
    }
    if (on && deck.isOverview && deck.isOverview()) {
      deck.toggleOverview(false);
    }
    if (!on) {
      commitTextEditor();
      deselect();
      hideLens();
      if (boardOn) {
        boardOn = false;
        document.body.classList.remove("ink-board-on");
        syncBoardPetal();
        invalidate();
      }
    }
    drawMode = on;
    releasePass();
    passThrough = false;
    canvas.style.pointerEvents = on ? "auto" : "none";
    canvas.style.touchAction = on ? "none" : "auto";
    document.body.classList.toggle("ink-drawing", on);
    orbRoot.classList.toggle("ink-armed", on);
    // the orb is hidden outside draw mode unless the device is a
    // tablet, where it stays put so students can reach it without
    // knowing the D shortcut; it only appears via D, the burger menu
    // tool, or automatically on tablet-like devices
    orbRoot.classList.toggle("ink-shown", on || orbAlwaysVisible);
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
    if (t !== tool) {
      commitTextEditor();
      deselect();
    }
    tool = t;
    canvas.classList.toggle("ink-hide-cursor", t === "eraser");
    canvas.classList.toggle("ink-text-cursor",
      t === "text" || t === "note");
    canvas.classList.toggle("ink-zoom-cursor", t === "zoom");
    if (t !== "zoom") hideLens();
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
      (tool === "laser" ? "#f43f5e" : "#f43f5e");
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
     ["text", "Text (T)"], ["note", "Sticky note"],
     ["shape", "Shapes (S)"],
     ["eraser", "Eraser (E)"], ["laser", "Laser (L)"],
     ["zoom", "Magnifier"]].forEach(function (t) {
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

    [["arrow", "Arrow"], ["curve", "Curved arrow"], ["line", "Line"],
     ["rect", "Rectangle"], ["ellipse", "Ellipse"]].forEach(function (s) {
      petal({
        title: s[1], svg: ICONS[s[0]], cls: "ink-petal-shape",
        dataset: { ring: "shape", key: s[0] },
        onclick: function () { setShapeKind(s[0]); }
      });
    });

    petal({
      title: "Whiteboard", svg: ICONS.board,
      cls: "ink-petal-action",
      dataset: { ring: "action", key: "board" },
      onclick: function () { toggleBoard(!boardOn); }
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
      onclick: toggleMenu
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

    // actions sit on the size ring, just beyond the shared fan,
    // split evenly between the two flanks
    var acts = bloomEl.querySelectorAll("[data-ring='action']");
    var off = Math.max(FAN, toolSpan || FAN) / 2;
    var actAng = [];
    var leftN = Math.floor(acts.length / 2);
    for (var la = 0; la < leftN; la++) {
      actAng.push(base - off - 15 - la * 20);
    }
    for (var ra = 0; ra < acts.length - leftN; ra++) {
      actAng.push(base + off + 15 + ra * 20);
    }
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
      b.style.setProperty("--tint", toolCfg.shape.color);
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
      { group: "Clean up" },
      { key: "clear", label: "Clear this slide", icon: ICONS.eraser,
        desc: "Remove all ink from the current slide",
        confirm: true,
        empty: function () { return slideStrokes().length === 0; },
        fn: function () {
          clearSlide();
          showToast("Slide cleared");
        } },
      { key: "clearall", label: "Clear all slides", icon: ICONS.layers,
        desc: "Remove ink from the whole presentation",
        confirm: true,
        empty: function () {
          return Object.keys(strokes).every(function (k) {
            return strokes[k].length === 0;
          });
        },
        fn: function () {
          clearAllSlides();
          showToast("All slides cleared");
        } },
      { group: "Export" },
      { key: "export", label: "PNG image", icon: ICONS.image,
        desc: "This slide with its ink, as an image",
        fn: exportPng },
      { key: "exporthtml", label: "Annotated HTML",
        icon: ICONS.code,
        desc: "The whole deck with drawings, as one file",
        fn: exportHtml },
      { key: "exportpdf", label: "PDF document", icon: ICONS.doc,
        desc: "All slides with their ink, one page each",
        fn: exportPdf },
      { group: "Input" },
      { key: "penonly", label: "Pen-only input", icon: ICONS.pen,
        desc: "Ignore fingers, draw with a stylus only",
        fn: togglePenOnly, check: true },
      { group: "Sessions" },
      { key: "sessions", label: "Annotation sessions",
        icon: ICONS.layers,
        desc: "Switch or start a named set of drawings",
        fn: function () { showSessionDialog(null); } },
      { group: "About", hidden: !inkShowGithub },
      { key: "github", hidden: !inkShowGithub,
        label: "Ink on GitHub", icon: ICONS.github,
        desc: "ofurkancoban/QuartoInkExtension",
        fn: function () {
          window.open(
            "https://github.com/ofurkancoban/QuartoInkExtension",
            "_blank", "noopener");
        } }
    ];
    items.forEach(function (it) {
      if (it.hidden) return;
      if (it.group) {
        var g = document.createElement("div");
        g.className = "ink-menu-head";
        g.textContent = it.group;
        menuEl.appendChild(g);
        return;
      }
      var b = document.createElement("button");
      b.className = "ink-menu-item";
      b.dataset.inkMenu = it.key;
      b.innerHTML =
        "<span class='ink-menu-ico'>" + it.icon + "</span>" +
        "<span class='ink-menu-text'>" +
          "<span class='ink-menu-label'>" + it.label + "</span>" +
          "<span class='ink-menu-desc'>" + it.desc + "</span>" +
        "</span>" +
        "<span class='ink-check'>✓</span>";
      b.querySelector(".ink-check").style.visibility =
        (it.check && penOnly) ? "visible" : "hidden";
      var armTimer = null;
      function disarm() {
        clearTimeout(armTimer);
        armTimer = null;
        b.classList.remove("ink-menu-danger");
        b.querySelector(".ink-menu-label").textContent = it.label;
        b.querySelector(".ink-menu-desc").textContent = it.desc;
      }
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (it.confirm) {
          // destructive items ask for a second tap instead of a
          // blocking browser confirm dialog
          if (it.empty && it.empty()) {
            showToast("Nothing to clear");
            return;
          }
          if (armTimer) {
            disarm();
            hideMenu();
            it.fn();
          } else {
            b.classList.add("ink-menu-danger");
            b.querySelector(".ink-menu-label").textContent =
              "Tap again to confirm";
            b.querySelector(".ink-menu-desc").textContent =
              it.label + " cannot be redone from here, only via undo";
            armTimer = setTimeout(disarm, 2500);
          }
          return;
        }
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
      // rotating a tablet or resizing the window can change which
      // side of the tablet-detection heuristic the device falls on
      if (orbAutoTouchCfg) {
        orbAlwaysVisible = isTabletLike();
        if (!drawMode) {
          orbRoot.classList.toggle("ink-shown", orbAlwaysVisible);
        }
      }
    });
  }

  /* ---------- PDF export ----------
   * In reveal's print layout (?print-pdf) the live canvas cannot
   * work, so every slide gets its ink baked into an <img> overlay:
   * the drawings then survive the browser's print-to-PDF. */

  function buildPrintOverlays() {
    var w = deck.getConfig().width;
    var h = deck.getConfig().height;
    var dpr = 2;
    deck.getSlides().forEach(function (sl) {
      var idx = deck.getIndices(sl);
      var key = idx.h + "." + (idx.v || 0);
      var list = (strokes[key] || []).slice();
      // print shows every tabset on its first tab: include that
      // tab combination's ink as well
      var sets = sl.querySelectorAll(".panel-tabset");
      if (sets.length > 0) {
        var zeros = [];
        sets.forEach(function () { zeros.push(0); });
        list = list.concat(
          strokes[key + "|t" + zeros.join(".")] || []);
      }
      if (list.length === 0) return;
      if (sl.querySelector(".ink-print-overlay")) return;
      var cv = document.createElement("canvas");
      cv.width = w * dpr;
      cv.height = h * dpr;
      var c2 = cv.getContext("2d");
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      var main = ctx;
      ctx = c2;
      list.forEach(drawStroke);
      ctx = main;
      var img = document.createElement("img");
      img.className = "ink-print-overlay";
      img.src = cv.toDataURL("image/png");
      img.style.width = w + "px";
      img.style.height = h + "px";
      sl.style.position = "relative"; // anchor the overlay to the slide
      sl.appendChild(img);
    });
  }

  function initPrintMode() {
    restore();
    // inject before reveal's print layout restructures the DOM:
    // the overlays then travel with their slides into the pdf pages
    buildPrintOverlays();
    var done = false;
    function ready() {
      if (done) return;
      done = true;
      var auto = false;
      try {
        auto = sessionStorage.getItem("quarto-ink-print") === "1";
        sessionStorage.removeItem("quarto-ink-print");
      } catch (e) { /* ignore */ }
      if (auto) {
        window.addEventListener("afterprint", function () {
          // return to the normal presentation view
          location.href = location.href
            .replace(/[?&]print-pdf/g, "")
            .replace(/\?$/, "");
        });
        setTimeout(function () { window.print(); }, 800);
      }
    }
    deck.on("pdf-ready", ready);
    setTimeout(ready, 2500); // fallback if the event never fires
  }

  /* Real PDF export: every slide is rasterised with the bundled
   * html2canvas, its ink composited on top, and the pages are packed
   * into a downloadable PDF with the bundled jsPDF.
   *
   * Slides with panel-tabsets are visited tab by tab, in order, so
   * every tab (and its own ink layer) gets a page. For speed, all
   * inactive slides are excluded from rasterisation (html2canvas
   * otherwise walks the entire deck DOM for every single page). */

  function tabsetTabs(ts) {
    return ts.querySelectorAll(
      "ul [role='tab'], ul .nav-link, ul > li > a");
  }

  function tabCombos(slide) {
    var sets = slide.querySelectorAll(".panel-tabset");
    if (sets.length === 0) return [null];
    var combos = [[]];
    sets.forEach(function (ts) {
      var n = Math.max(1, tabsetTabs(ts).length);
      var next = [];
      combos.forEach(function (c) {
        for (var i = 0; i < n; i++) next.push(c.concat(i));
      });
      combos = next;
    });
    return combos.slice(0, 16); // sanity cap
  }

  function applyCombo(slide, combo) {
    if (!combo) return false;
    var sets = slide.querySelectorAll(".panel-tabset");
    var changed = false;
    sets.forEach(function (ts, si) {
      var tabs = tabsetTabs(ts);
      var want = tabs[combo[si]];
      if (want &&
          want.getAttribute("aria-selected") !== "true" &&
          !want.classList.contains("active")) {
        want.click();
        changed = true;
      }
    });
    return changed;
  }

  /* fixed overlay chrome that must never end up in the PDF: our own
   * UI plus common third-party deck widgets (laser pointers, progress
   * indicators, tooltips, lightboxes) */
  var PDF_IGNORE_SEL =
    "#ink-canvas, #ink-orb-root, #ink-toast, #ink-laser, " +
    "#ink-eraser-ring, .ink-text-editor, .ink-text-controls, " +
    ".ink-sel-handle, #ink-board-bar, " +
    "#laser-container, #laser-canvas, .cursor-dropdown, " +
    ".indicator-settings-btn, .indicator-settings-panel, " +
    ".indicator-tooltip, [data-tippy-root], .tippy-box, " +
    ".glightbox-container, .slide-menu-button, " +
    ".slide-chalkboard-buttons";

  function exportPdf() {
    if (!window.html2canvas || !window.jspdf) {
      // vendored libraries missing (e.g. legacy deck): fall back
      printPdf();
      return;
    }
    commitTextEditor();
    deselect();
    closeBloom();
    hideMenu();
    document.body.classList.add("ink-exporting");
    var slides = deck.getSlides();
    var orig = deck.getIndices();
    var origTransition = deck.getConfig().transition;
    deck.configure({ transition: "none" });
    var W = window.innerWidth, H = window.innerHeight;
    var fmt = [W, H];
    var ori = W >= H ? "l" : "p";
    var pdf = new window.jspdf.jsPDF({
      orientation: ori, unit: "px", format: fmt,
      hotfixes: ["px_scaling"]
    });

    // one page per slide + one per extra tab combination, in order,
    // then any non-empty whiteboard pages at the end
    var tasks = [];
    slides.forEach(function (sl) {
      tabCombos(sl).forEach(function (cb) {
        tasks.push({ slide: sl, combo: cb });
      });
    });
    var origBoard = boardOn, origBoardPage = boardPage;
    for (var bp = 0; bp < boardPages; bp++) {
      if ((strokes["board." + bp] || []).length > 0) {
        tasks.push({ board: bp });
      }
    }

    var i = 0;

    function setBoardCapture(on, page) {
      boardOn = on;
      if (page != null) boardPage = page;
      document.body.classList.toggle("ink-board-on", on);
      invalidate();
      redraw();
    }

    function finish(ok) {
      setBoardCapture(origBoard, origBoardPage);
      deck.slide(orig.h, orig.v || 0);
      deck.configure({ transition: origTransition });
      document.body.classList.remove("ink-exporting");
      if (ok) {
        pdf.save((document.title || "slides")
          .replace(/\s+/g, "-") + ".pdf");
        showToast("PDF exported (" + tasks.length + " pages)");
      } else {
        showToast("PDF export failed");
      }
    }

    function step() {
      if (i >= tasks.length) { finish(true); return; }
      showToast("Rendering PDF… " + (i + 1) + "/" + tasks.length,
        60000);
      var task = tasks[i];
      var switched = false;
      if (task.board != null) {
        setBoardCapture(true, task.board);
      } else {
        setBoardCapture(false, null);
        var idx = deck.getIndices(task.slide);
        deck.slide(idx.h, idx.v || 0);
        switched = applyCombo(task.slide, task.combo);
      }
      setTimeout(function () {
        var cur = deck.getCurrentSlide();
        window.html2canvas(document.body, {
          scale: 1.5,
          useCORS: true,
          logging: false,
          width: W, height: H,
          windowWidth: W, windowHeight: H,
          ignoreElements: function (el) {
            if (el.matches && el.matches(PDF_IGNORE_SEL)) return true;
            // skip every slide except the visible one: html2canvas
            // walking the whole deck is what made exports slow
            return el.tagName === "SECTION" &&
                   el !== cur &&
                   !el.contains(cur) &&
                   !cur.contains(el);
          }
        }).then(function (shot) {
          var out = document.createElement("canvas");
          out.width = shot.width;
          out.height = shot.height;
          var c2 = out.getContext("2d");
          c2.drawImage(shot, 0, 0);
          // the live ink canvas shows this slide+tab's drawings
          c2.drawImage(canvas, 0, 0, out.width, out.height);
          if (i > 0) pdf.addPage(fmt, ori);
          pdf.addImage(out.toDataURL("image/jpeg", 0.9),
            "JPEG", 0, 0, W, H);
          i++;
          step();
        }).catch(function () { finish(false); });
      }, switched ? 250 : 180);
    }
    step();
  }

  function printPdf() {
    try { sessionStorage.setItem("quarto-ink-print", "1"); }
    catch (e) { /* ignore */ }
    var parts = location.href.split("#");
    var url = parts[0] +
      (parts[0].indexOf("?") >= 0 ? "&" : "?") + "print-pdf";
    location.href = url + (parts[1] ? "#" + parts[1] : "");
  }

  /* ---------- magnifier lens ----------
   * Hold-to-magnify: while the zoom tool is pressed, a circular lens
   * follows the pointer showing a 2.2x view. The deck is rasterised
   * once per slide/tab/board state (with the shared html2canvas
   * pipeline) and cached; live ink is composited on top so fresh
   * strokes are magnified too. */

  var LENS_R = 120;      // lens radius, css px
  var LENS_ZOOM = 2.2;
  var LENS_SCALE = 2;    // snapshot resolution factor
  var lens = { el: null, cv: null, c2: null, shot: null, key: "" };

  function buildLens() {
    lens.el = document.createElement("div");
    lens.el.id = "ink-lens";
    lens.cv = document.createElement("canvas");
    lens.cv.width = LENS_R * 2 * LENS_SCALE;
    lens.cv.height = LENS_R * 2 * LENS_SCALE;
    lens.el.appendChild(lens.cv);
    lens.c2 = lens.cv.getContext("2d");
    document.body.appendChild(lens.el);
  }

  function lensKey() {
    return slideKey() + "|" + window.innerWidth + "x" +
      window.innerHeight + "|" + (boardOn ? boardBg : "s");
  }

  function invalidateLens() {
    lens.shot = null;
    lens.key = "";
  }

  function ensureLensShot(cb) {
    var key = lensKey();
    if (lens.shot && lens.key === key) { cb(); return; }
    if (!window.html2canvas) { cb(); return; }
    var cur = deck.getCurrentSlide();
    window.html2canvas(document.body, {
      scale: LENS_SCALE,
      useCORS: true,
      logging: false,
      width: window.innerWidth, height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      ignoreElements: function (el) {
        if (el.matches && el.matches(PDF_IGNORE_SEL)) return true;
        return el.tagName === "SECTION" &&
               el !== cur &&
               !el.contains(cur) &&
               !cur.contains(el);
      }
    }).then(function (shot) {
      lens.shot = shot;
      lens.key = key;
      cb();
    }).catch(function () { cb(); });
  }

  function moveLens(x, y) {
    if (!lens.el) return;
    lens.el.style.left = x + "px";
    lens.el.style.top = y + "px";
    lens.el.style.display = "block";
    var c2 = lens.c2;
    var out = LENS_R * 2 * LENS_SCALE;
    c2.clearRect(0, 0, out, out);
    var srcCss = (LENS_R * 2) / LENS_ZOOM; // css px shown in the lens
    if (lens.shot) {
      c2.drawImage(lens.shot,
        (x - srcCss / 2) * LENS_SCALE, (y - srcCss / 2) * LENS_SCALE,
        srcCss * LENS_SCALE, srcCss * LENS_SCALE,
        0, 0, out, out);
    } else {
      c2.fillStyle = "#fff";
      c2.fillRect(0, 0, out, out);
    }
    // live ink on top (canvas is devicePixelRatio scaled)
    var dpr = window.devicePixelRatio || 1;
    c2.drawImage(canvas,
      (x - srcCss / 2) * dpr, (y - srcCss / 2) * dpr,
      srcCss * dpr, srcCss * dpr,
      0, 0, out, out);
  }

  function hideLens() {
    if (lens.el) lens.el.style.display = "none";
  }

  /* ---------- whiteboard surface & page bar ---------- */

  function buildBoard() {
    boardEl = document.createElement("div");
    boardEl.id = "ink-board";
    document.body.appendChild(boardEl);

    boardBar = document.createElement("div");
    boardBar.id = "ink-board-bar";
    boardBar.className = "ink-text-controls ink-sel-controls";

    function btn(svg, label, fn) {
      var b = document.createElement("button");
      b.className = "ink-text-btn";
      b.innerHTML = svg;
      b.title = label;
      b.setAttribute("aria-label", label);
      b.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      boardBar.appendChild(b);
      return b;
    }

    btn(ICONS.prev, "Previous page", function () {
      setBoardPage(boardPage - 1);
    });
    boardLabel = document.createElement("span");
    boardLabel.className = "ink-board-label";
    boardBar.appendChild(boardLabel);
    btn(ICONS.next, "Next page", function () {
      setBoardPage(boardPage + 1);
    });
    btn(ICONS.plus, "New page", function () {
      boardPages++;
      setBoardPage(boardPages - 1);
      saveSettings();
    });
    btn(ICONS.bg, "Background (dots / squared / ruled / blank)",
      cycleBoardBg);
    btn(ICONS.camera, "Paste current slide onto this page",
      captureSlideToBoard);
    // deleting a page is destructive: it arms on the first tap and
    // deletes on a second tap within 2.5s
    var delArm = null;
    var delBtn = btn(ICONS.trash, "Delete this page", function () {
      if (delArm) {
        clearTimeout(delArm);
        delArm = null;
        delBtn.classList.remove("ink-armed-danger");
        deleteBoardPage();
      } else {
        delBtn.classList.add("ink-armed-danger");
        showToast("Tap again to delete this page");
        delArm = setTimeout(function () {
          delArm = null;
          delBtn.classList.remove("ink-armed-danger");
        }, 2500);
      }
    });
    delBtn.classList.add("ink-text-trash");
    btn(ICONS.close, "Close whiteboard", function () {
      toggleBoard(false);
    });
    document.body.appendChild(boardBar);
    applyBoardBg();
  }

  function refreshBoardBar() {
    if (boardLabel) {
      boardLabel.textContent = (boardPage + 1) + " / " + boardPages;
    }
  }

  /* remove the current page: later pages shift down; the last
   * remaining page is cleared instead of removed */
  function deleteBoardPage() {
    commitTextEditor();
    deselect();
    current = null;
    if (boardPages <= 1) {
      strokes["board.0"] = [];
      delete history["board.0"];
      showToast("Page cleared");
    } else {
      for (var p = boardPage; p < boardPages - 1; p++) {
        strokes["board." + p] = strokes["board." + (p + 1)] || [];
        delete history["board." + p];
      }
      delete strokes["board." + (boardPages - 1)];
      delete history["board." + (boardPages - 1)];
      boardPages--;
      if (boardPage >= boardPages) boardPage = boardPages - 1;
      showToast("Page deleted");
    }
    invalidate();
    invalidateLens();
    redraw();
    refreshBoardBar();
    refreshHistoryButtons();
    persist();
    saveSettings();
  }

  function setBoardPage(p) {
    if (p < 0 || p >= boardPages || p === boardPage) return;
    commitTextEditor();
    deselect();
    current = null;
    boardPage = p;
    invalidateLens();
    refreshBoardBar();
    invalidate();
    redraw();
    refreshHistoryButtons();
    saveSettings();
  }

  function toggleBoard(on) {
    if (on === boardOn) return;
    commitTextEditor();
    deselect();
    current = null;
    boardOn = on;
    invalidateLens();
    hideLens();
    if (on && !drawMode) setDrawMode(true);
    document.body.classList.toggle("ink-board-on", boardOn);
    refreshBoardBar();
    invalidate();
    redraw();
    refreshHistoryButtons();
    syncBoardPetal();
    showToast(boardOn
      ? "Whiteboard " + (boardPage + 1) + " / " + boardPages
      : "Back to slides");
  }

  /* rasterise the current slide (with its ink) and paste it onto
   * the active whiteboard page as a movable, resizable image. Input
   * is blocked during the capture so the board state cannot change
   * underneath the async rasteriser. */
  var capturing = false;

  function captureSlideToBoard() {
    if (!boardOn || !window.html2canvas || capturing) return;
    capturing = true;
    showToast("Capturing slide…", 8000);
    var wasBoard = boardOn;
    boardOn = false;
    document.body.classList.remove("ink-board-on");
    invalidate();
    redraw();

    function restoreBoard() {
      boardOn = drawMode ? wasBoard : false;
      document.body.classList.toggle("ink-board-on", boardOn);
      invalidate();
      invalidateLens();
      redraw();
      capturing = false;
    }
    var cur = deck.getCurrentSlide();
    var SC = 1.5;
    window.html2canvas(document.body, {
      scale: SC,
      useCORS: true,
      logging: false,
      width: window.innerWidth, height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      ignoreElements: function (el) {
        if (el.matches && el.matches(PDF_IGNORE_SEL)) return true;
        if (el.id === "ink-board") return true;
        return el.tagName === "SECTION" &&
               el !== cur &&
               !el.contains(cur) &&
               !cur.contains(el);
      }
    }).then(function (shot) {
      var sr = slidesEl.getBoundingClientRect();
      var out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(sr.width * SC));
      out.height = Math.max(1, Math.round(sr.height * SC));
      var c2 = out.getContext("2d");
      c2.drawImage(shot,
        sr.left * SC, sr.top * SC, sr.width * SC, sr.height * SC,
        0, 0, out.width, out.height);
      // slide ink lives on the live canvas (dpr scaled)
      var dpr = window.devicePixelRatio || 1;
      c2.drawImage(canvas,
        sr.left * dpr, sr.top * dpr, sr.width * dpr, sr.height * dpr,
        0, 0, out.width, out.height);
      var src = out.toDataURL("image/jpeg", 0.85);
      // back onto the board, then add the image in slide coords
      restoreBoard();
      if (!boardOn) {
        showToast("Capture cancelled");
        return;
      }
      var f = slideFrame();
      var slideW = sr.width / f.scale;
      var slideH = sr.height / f.scale;
      var w = slideW * 0.72;
      var h = w * (out.height / out.width);
      var x = (slideW - w) / 2;
      var y = Math.max(20, (slideH - h) / 2);
      // cascade repeated pastes so they never hide each other
      var existing = slideStrokes().filter(function (st) {
        return st.tool === "image";
      }).length;
      var offset = (existing % 8) * 28;
      var imgStroke = {
        tool: "image", src: src,
        points: [[x + offset, y + offset],
                 [x + w + offset, y + h + offset]]
      };
      execute({ type: "add", stroke: imgStroke });
      selectStroke(imgStroke);
      showToast("Slide pasted onto the board");
    }).catch(function () {
      restoreBoard();
      showToast("Capture failed");
    });
  }

  function syncBoardPetal() {
    if (!bloomEl) return;
    var b = bloomEl.querySelector("[data-key='board']");
    if (b) b.classList.toggle("ink-on", boardOn);
  }

  /* ---------- named sessions: switch, create, day prompt ----------
   * Annotation sets are day-aware: when the deck opens and the last
   * ink is from an earlier day, a gentle prompt offers to start a
   * fresh session. Naming is optional (defaults to the date). */

  var sessionDialog = null;

  function sessionName() {
    return session === "" ? "Default" : session;
  }

  function dateName(d) {
    d = d || new Date();
    return d.toISOString().slice(0, 10);
  }

  function switchSession(name) {
    if (name === session) return;
    commitTextEditor();
    deselect();
    current = null;
    persist();
    session = name;
    try { localStorage.setItem(docBase + ":session", session); }
    catch (e) { /* ignore */ }
    history = {};
    restore();
    invalidate();
    invalidateLens();
    redraw();
    refreshHistoryButtons();
    showToast("Session: " + sessionName());
  }

  function newSession(name) {
    name = String(name || "").trim() || dateName();
    if (name === "Default") name = dateName();
    var list = sessionList();
    if (list.indexOf(name) < 0) {
      list.push(name);
      saveSessionList(list);
    }
    switchSession(name);
  }

  function buildSessionDialog() {
    sessionDialog = document.createElement("div");
    sessionDialog.id = "ink-session-dialog";
    sessionDialog.style.display = "none";
    document.body.appendChild(sessionDialog);
  }

  function hideSessionDialog() {
    if (sessionDialog) sessionDialog.style.display = "none";
  }

  function showSessionDialog(fromDate) {
    if (!sessionDialog) buildSessionDialog();
    var d = sessionDialog;
    d.innerHTML = "";
    var title = document.createElement("div");
    title.className = "ink-session-title";
    title.textContent = fromDate
      ? "Your ink here is from " + dateName(fromDate) + "."
      : "Annotation sessions";
    d.appendChild(title);

    // existing sessions, tap to switch
    var names = [""].concat(sessionList());
    var listEl = document.createElement("div");
    listEl.className = "ink-session-list";
    names.forEach(function (n) {
      var b = document.createElement("button");
      b.className = "ink-session-item" +
        (n === session ? " ink-on" : "");
      b.textContent = (n === "" ? "Default" : n);
      b.addEventListener("click", function () {
        hideSessionDialog();
        switchSession(n);
      });
      listEl.appendChild(b);
    });
    d.appendChild(listEl);

    var row = document.createElement("div");
    row.className = "ink-session-row";
    var input = document.createElement("input");
    input.type = "text";
    input.className = "ink-session-input";
    input.placeholder = dateName() + " (optional name)";
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") startNew();
      if (e.key === "Escape") hideSessionDialog();
    });
    var go = document.createElement("button");
    go.className = "ink-session-new";
    go.setAttribute("data-ink-new", "");
    go.textContent = "Start new session";
    function startNew() {
      hideSessionDialog();
      newSession(input.value);
    }
    go.addEventListener("click", startNew);
    row.appendChild(input);
    row.appendChild(go);
    d.appendChild(row);

    var keep = document.createElement("button");
    keep.className = "ink-session-keep";
    keep.setAttribute("data-ink-keep", "");
    keep.textContent = fromDate
      ? "Keep drawing in “" + sessionName() + "”"
      : "Close";
    keep.addEventListener("click", hideSessionDialog);
    d.appendChild(keep);

    d.style.display = "flex";
  }

  /* on load: last ink from another day? offer a fresh session */
  function checkSessionPrompt() {
    if (window.InkAnnotateSeed) return;
    var ts = 0;
    try {
      ts = Number(localStorage.getItem(docKey() + ":ts")) || 0;
    } catch (e) { /* ignore */ }
    if (!ts) return;
    var hasInk = Object.keys(strokes).some(function (k) {
      return strokes[k].length > 0;
    });
    if (!hasInk) return;
    var then = new Date(ts);
    if (then.toDateString() === new Date().toDateString()) return;
    showSessionDialog(then);
  }

  /* ---------- burger menu (reveal-menu) integration ----------
   * Quarto's burger menu builds its Tools panel from config at init;
   * we append our own tool item once that list exists. */

  function addMenuTool() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var item = document.querySelector("li.slide-tool-item");
      var list = item && item.parentNode;
      if (!list) {
        if (tries > 40) clearInterval(timer); // no burger menu
        return;
      }
      clearInterval(timer);
      if (list.querySelector("[data-ink-tool]")) return;
      window.RevealMenuToolHandlers = window.RevealMenuToolHandlers || {};
      window.RevealMenuToolHandlers.toggleInk = function (event) {
        event.preventDefault();
        if (drawMode) {
          setDrawMode(false);
        } else {
          setDrawMode(true);
          openBloom();
        }
        try { deck.getPlugin("menu").closeMenu(); } catch (e) {}
      };
      var li = document.createElement("li");
      li.className = "slide-tool-item";
      li.dataset.item = String(list.children.length);
      li.setAttribute("data-ink-tool", "");
      li.innerHTML = "<a href=\"#\" " +
        "onclick=\"RevealMenuToolHandlers.toggleInk(event)\">" +
        "<kbd>d</kbd> Draw on Slides</a>";
      list.appendChild(li);
    }, 250);
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
    // while a pass-through zone is engaged the canvas receives no
    // events; watch the document to re-arm it once the pointer
    // leaves the zone
    document.addEventListener("pointermove", function (e) {
      if (!drawMode || !passThrough) return;
      if (!interactiveUnder(e.clientX, e.clientY, PASS_ZONE_SEL)) {
        releasePass();
      }
    }, true);
    // tab switches change the active ink layer: refresh after them
    document.addEventListener("click", function (e) {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest(
          ".panel-tabset [role='tab'], .panel-tabset .nav-link")) {
        cancelTextEditor();
        deselect();
        invalidateLens();
        current = null;
        setTimeout(function () {
          invalidate();
          redraw();
          refreshHistoryButtons();
        }, 60);
      }
    }, true);
    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
  }

  function onKeyOnce(e) {
    if (e.__inkHandled) return;
    e.__inkHandled = true;
    onKey(e);
  }

  function onKey(e) {
    // the deck may not be initialized yet (see the early listener
    // registration note below); nothing to do until it is
    if (!deck) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" ||
        e.target.isContentEditable) {
      return;
    }
    var k = e.key.toLowerCase();
    if (capturing) {
      showToast("Capturing slide…");
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) {
      // copy/paste for the selected stroke; other combos are the
      // browser's business
      if (drawMode && k === "c" && selected) {
        clipboard = JSON.parse(JSON.stringify(selected, stripPrivate));
        showToast("Copied");
      } else if (drawMode && k === "v" && clipboard) {
        e.preventDefault();
        var pasted = JSON.parse(JSON.stringify(clipboard));
        pasted.points = pasted.points.map(function (p) {
          p[0] += 16;
          p[1] += 16;
          return p;
        });
        execute({ type: "add", stroke: pasted });
        selectStroke(pasted);
        showToast("Pasted");
      }
      return;
    }
    if (k === "d") {
      if (drawMode) setDrawMode(false);
      else { setDrawMode(true); openBloom(); }
    }
    if (!drawMode) return;
    if (k === "escape") {
      if (boardOn) toggleBoard(false);
      else setDrawMode(false);
    }
    if (k === "z") undo();
    if (k === "y") redo();
    if (k === "p") setTool("pen");
    if (k === "h") setTool("highlighter");
    if (k === "t") setTool("text");
    if (k === "s") setTool("shape");
    if (k === "e") setTool("eraser");
    if (k === "l") setTool("laser");
  }

  /* Real key presses go to whatever element currently has focus. If
   * that's an embedded same-origin iframe (a leaflet/plotly widget,
   * an embedded chart), the keydown never reaches this window at
   * all — it's a separate document. Reach into every same-origin
   * iframe we can and forward its keydowns through onKeyOnce too. */
  var wiredFrames = new WeakSet();

  function wireIframe(f) {
    if (wiredFrames.has(f)) return;
    var w;
    try { w = f.contentWindow; } catch (e) { return; }
    if (!w) return;
    try {
      // touching .document throws for cross-origin frames
      if (!w.document) return;
    } catch (e) { return; }
    try {
      w.addEventListener("keydown", onKeyOnce, true);
      wiredFrames.add(f);
    } catch (e) { /* cross-origin after all: ignore */ }
  }

  function wireAllIframes() {
    document.querySelectorAll("iframe").forEach(function (f) {
      wireIframe(f);
      f.addEventListener("load", function () { wireIframe(f); });
    });
  }

  /* Keyboard listeners are registered the instant this script parses
   * (module load time), not inside init(). init() only runs once
   * Reveal reports ready, which is late: by then a deck's own inline
   * scripts may already have registered a window/capture keydown
   * listener that calls stopImmediatePropagation, silently eating D
   * before ink ever sees it. Registering here — as early as
   * possible, in the capture phase on window, which fires before
   * any bubble-phase or later-registered capture-phase listener —
   * closes that race. onKey() itself no-ops until deck exists. */
  window.addEventListener("keydown", onKeyOnce, true);
  document.addEventListener("keydown", onKeyOnce);

  return {
    id: "InkAnnotate",
    init: function (reveal) {
      deck = reveal;
      slidesEl = deck.getRevealElement().querySelector(".slides");
      if (/print-pdf/gi.test(window.location.search)) {
        initPrintMode(); // static ink overlays only, no live UI
        return;
      }
      // ---- user configuration from the deck's YAML ----
      // format: revealjs: ink: { colors: [...], default-tool: pen,
      //   board-background: grid, pen-only: true, github: false }
      var uc = deck.getConfig().ink || {};
      function copt(k) {
        if (uc[k] !== undefined) return uc[k];
        var camel = k.replace(/-([a-z])/g, function (_, c) {
          return c.toUpperCase();
        });
        return uc[camel];
      }
      var cols = copt("colors");
      if (Array.isArray(cols) && cols.length > 0) {
        COLORS = cols.slice(0, 12).map(String);
        var ci = function (i) { return Math.min(i, COLORS.length - 1); };
        toolCfg.pen.color = COLORS[0];
        toolCfg.text.color = COLORS[0];
        toolCfg.highlighter.color = COLORS[ci(2)];
        toolCfg.note.color = COLORS[ci(2)];
        toolCfg.shape.color = COLORS[ci(5)];
      }
      var dt = copt("default-tool");
      if (typeof dt === "string" && (toolCfg[dt] ||
          ["eraser", "laser", "zoom"].indexOf(dt) >= 0)) {
        tool = dt;
      }
      var bcfg = copt("board-background");
      if (BOARD_BGS.indexOf(bcfg) >= 0) boardBg = bcfg;
      if (copt("pen-only") === true) penOnly = true;
      inkShowGithub = copt("github") !== false;
      orbAutoTouchCfg = copt("auto-show-on-touch") !== false;
      orbAlwaysVisible = orbAutoTouchCfg && isTabletLike();
      var scfg = copt("session");
      if (typeof scfg === "string" && scfg.trim()) {
        session = scfg.trim() === "Default" ? "" : scfg.trim();
        var slist = sessionList();
        if (session && slist.indexOf(session) < 0) {
          slist.push(session);
          saveSessionList(slist);
        }
      }

      loadSettings();
      restore();
      buildCanvas();
      buildOrb();
      if (orbAlwaysVisible) {
        // tablet: show the orb right away, but stay out of drawing
        // mode until it's actually tapped or D is pressed
        orbRoot.classList.add("ink-shown");
      }
      buildBoard();
      buildLens();
      refreshBoardBar();
      addMenuTool();
      if (deck.registerKeyboardShortcut) {
        // shows up in reveal's keyboard help overlay (?)
        deck.registerKeyboardShortcut("D", "Toggle drawing (Ink)");
      }
      deck.on("slidechanged", function () {
        cancelTextEditor();
        deselect();
        invalidateLens();
        hideLens();
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
      // reveal's final layout can land after our first paint;
      // repaint once the deck reports ready so restored/seeded
      // ink is always positioned correctly on first load
      deck.on("ready", function () {
        invalidate();
        redraw();
      });
      // day-aware sessions: ask once the deck has settled
      setTimeout(checkSessionPrompt, 1500);
      // reach into embedded same-origin widgets (maps, charts) so D
      // still works when focus is inside one of their iframes
      wireAllIframes();
      new MutationObserver(function (muts) {
        for (var mi = 0; mi < muts.length; mi++) {
          var added = muts[mi].addedNodes;
          for (var ni = 0; ni < added.length; ni++) {
            var n = added[ni];
            if (n.tagName === "IFRAME") wireIframe(n);
            else if (n.querySelectorAll) {
              n.querySelectorAll("iframe").forEach(wireIframe);
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
      // auto-animate and transitions settle after slidechanged;
      // repaint when the final layout is in place
      deck.on("slidetransitionend", function () {
        invalidate();
        redraw();
      });
      // in overview the fullscreen ink canvas no longer lines up
      // with the shrunken slides: hide it and pause drawing
      deck.on("overviewshown", function () {
        setDrawMode(false);
        canvas.style.visibility = "hidden";
      });
      deck.on("overviewhidden", function () {
        canvas.style.visibility = "";
        invalidate();
        redraw();
      });
      // reveal 5 scroll view stacks slides vertically; slide-frame
      // math is meaningless there, so ink hides until it is left
      var wasScroll = scrollViewActive();
      new MutationObserver(function () {
        var scroll = scrollViewActive();
        if (scroll === wasScroll) return;
        wasScroll = scroll;
        if (scroll) {
          setDrawMode(false);
          canvas.style.visibility = "hidden";
        } else {
          canvas.style.visibility = "";
          invalidate();
          redraw();
        }
      }).observe(deck.getRevealElement(),
        { attributes: true, attributeFilter: ["class"] });
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
      exportHtml: exportHtml,
      exportPdf: exportPdf,
      exportPng: exportPng,
      toggleBoard: toggleBoard,
      setBoardPage: setBoardPage,
      setBoardBackground: setBoardBackground,
      deleteBoardPage: deleteBoardPage,
      sessionState: function () {
        return { active: sessionName(), list: sessionList() };
      },
      newSession: newSession,
      switchSession: switchSession,
      checkSessionPrompt: checkSessionPrompt,
      boardState: function () {
        return { on: boardOn, page: boardPage, pages: boardPages };
      },
      addBoardPage: function () {
        boardPages++;
        setBoardPage(boardPages - 1);
      },
      getStrokes: function () { return strokes; },
      getTool: function () { return tool; },
      captureSlideToBoard: captureSlideToBoard,
      duplicateSelected: function () {
        if (selected) duplicateStroke(selected);
      },
      storageKey: function () { return docKey(); },
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
