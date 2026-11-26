/* SC Fast View — CAD viewer with a DWG FastView-style home screen.
   Depends on DXF (www/dxf.js). Plain script, no build step. */
(function () {
  'use strict';

  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var fileInput = document.getElementById('fileInput');
  var fileNameEl = document.getElementById('fileName');
  var infoBar = document.getElementById('infoBar');
  var layersSheet = document.getElementById('layersSheet');
  var layersList = document.getElementById('layersList');
  var measureLabel = document.getElementById('measureLabel');
  var fileListEl = document.getElementById('fileList');
  var homeEmptyEl = document.getElementById('homeEmpty');

  var dpr = Math.max(1, window.devicePixelRatio || 1);

  // ---------- settings (persisted) ----------
  var settings = { bg: 'black', lineweight: false, fastRender: true, fitAll: false, measureUnit: 'm' };
  try {
    var saved = JSON.parse(localStorage.getItem('scfv-settings') || '{}');
    if (saved.bg) settings.bg = saved.bg;
    if (typeof saved.lineweight === 'boolean') settings.lineweight = saved.lineweight;
    if (typeof saved.fastRender === 'boolean') settings.fastRender = saved.fastRender;
    if (typeof saved.fitAll === 'boolean') settings.fitAll = saved.fitAll;
    if (saved.measureUnit) settings.measureUnit = saved.measureUnit;
  } catch (e) { /* ignore */ }
  function saveSettings() {
    try { localStorage.setItem('scfv-settings', JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  var state = {
    doc: null,
    fileName: '',
    scale: 1, ox: 0, oy: 0,
    hiddenLayers: {},
    measureMode: false,
    measurePts: [],
    measureTotal: 0,
    selected: null,
    searchHighlight: null,
    screen: 'home',
    tab: 'recent',
    search: '',
    typeFilter: 'all',
    library: [],
    // Professional toolbar tools (like DWG FastView):
    // null | 'measure' | 'dimension' | 'annotate' | 'draw' | 'edit'
    tool: null,
    // Annotation sub-tools (the bar inside Annotation, like the real app):
    // 'sketch' | 'arrow' | 'text' | 'revcloud' | 'recording' | 'image'
    annotateSub: 'text',
    annotations: [],   // {x, y, text} in world coords — saved per file
    strokes: [],       // {color, pts: [[x,y],...]} — saved per file
    dimensions: [],    // {a: [x,y], b: [x,y], dist} — saved per file
    arrows: [],        // {a: [x,y], b: [x,y]} — saved per file
    revclouds: [],     // {box: [x0,y0,x1,y1]} — saved per file
    recordings: [],    // {x, y, audio: dataURL, dur} — saved per file
    images: [],        // {x, y, data: dataURL} — saved per file
    dimPending: null,
    drawColor: '#EF4444',
    currentStroke: null,
    pendingArrow: null,
    pendingBox: null,
    pendingImagePoint: null,
    pendingAudioPoint: null,
    recording: null,        // {recorder, startTime, secs, timer}
    playingRecording: null, // {item, audio}
    currentImage: null,
    imageCache: {},
    editMoveArmed: false,
    editDrag: null,
    pendingNote: null,
    undoStack: [],
    redoStack: []
  };

  function isDarkBg() { return settings.bg === 'black'; }
  function bgColor() {
    return settings.bg === 'white' ? '#FFFFFF'
      : settings.bg === 'beige' ? '#F5EEDD' : '#121212';
  }
  function fgColor() { return isDarkBg() ? '#FFFFFF' : '#000000'; }
  function gridColor() { return isDarkBg() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'; }
  function lineWidth() { return (settings.lineweight ? 2.4 : 1.1) * dpr; }

  function resize() {
    var r = canvas.parentElement.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    render();
  }
  window.addEventListener('resize', resize);

  // ---------- screens ----------
  function showScreen(name) {
    state.screen = name;
    document.getElementById('screenHome').classList.toggle('hidden', name !== 'home');
    document.getElementById('screenViewer').classList.toggle('hidden', name !== 'viewer');
    document.getElementById('screenSettings').classList.toggle('hidden', name !== 'settings');
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-nav') === name);
    });
    if (name !== 'viewer') {
      layersSheet.classList.remove('open');
      if (typeof closeSearchSheet === 'function') closeSearchSheet();
      if (typeof closeInfoSheet === 'function') closeInfoSheet();
      if (typeof setTool === 'function') setTool(null);
    }
    if (name === 'viewer') requestAnimationFrame(resize);
    if (name === 'home') renderLibrary();
  }

  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      var target = b.getAttribute('data-nav');
      if (target === 'viewer' && !state.doc) {
        showHomeToast('افتح ملف من الرئيسية الأول، أو جرّب الرسمة التجريبية');
        return;
      }
      showScreen(target);
    });
  });
  document.getElementById('btnBack').addEventListener('click', function () { showScreen('home'); });
  document.getElementById('btnBackSettings').addEventListener('click', function () { showScreen('home'); });
  // Tapping the file name opens the file-info sheet (what the parser found,
  // what was skipped, bounds, saved view, fit used) — the diagnostic view
  // for "the drawing looks incomplete" reports.
  fileNameEl.addEventListener('click', function () { showFileInfo(); });

  // App toast (created dynamically). It must live on document.body, not
  // inside the home screen: a toast shown while the user is in Settings (or
  // the viewer) would otherwise be invisible, because its parent screen is
  // hidden — that is why tapping "تحقق" in Settings seemed to do nothing.
  // It uses its own .app-toast class (a small pill): the old code reused
  // .info-bar, whose `top: 12px` plus the inline `bottom: 90px` stretched
  // it into a full-screen dark overlay — ugly and unprofessional.
  var homeToast = document.createElement('div');
  homeToast.className = 'app-toast';
  homeToast.style.display = 'none';
  document.body.appendChild(homeToast);
  var homeToastTimer = null;
  function showHomeToast(msg) {
    homeToast.textContent = msg;
    homeToast.style.display = 'block';
    clearTimeout(homeToastTimer);
    homeToastTimer = setTimeout(function () { homeToast.style.display = 'none'; }, 4500);
  }

  // Full-screen loading overlay while a DWG opens. A big DWG takes real
  // time to parse (the engine converts every object), so the user must see
  // that the app is working — not a home screen with a small toast.
  function showLoading(name, size) {
    document.getElementById('loadingTitle').textContent = 'جارٍ فتح ' + (name || 'الملف') + '…';
    var sub = size ? fmtSize(size) : '';
    if (size && size > 10 * 1048576) sub += ' — ملف كبير، ممكن ياخد شوية وقت، استنى شوية';
    document.getElementById('loadingSub').textContent = sub;
    document.getElementById('loadingOverlay').classList.remove('hidden');
  }
  function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }

  // ---------- color resolution ----------
  // Per-frame cache: resolving a color does a layer lookup per entity, and
  // a huge file has hundreds of thousands of entities. Cleared each render.
  var colorCache = {};
  function resolveColor(ent) {
    var key = (ent.color === undefined || ent.color === null ? 256 : ent.color) + '|' + (ent.layer || '0');
    var cached = colorCache[key];
    if (cached !== undefined) return cached;
    var c = DXF.aciColor(ent.color, isDarkBg());
    if (c) { colorCache[key] = c; return c; }
    var layer = state.doc && state.doc.layerMap ? state.doc.layerMap[ent.layer] : null;
    if (layer) {
      var lc = DXF.aciColor(layer.color, isDarkBg());
      if (lc) { colorCache[key] = lc; return lc; }
    }
    var fg = fgColor();
    colorCache[key] = fg;
    return fg;
  }

  // ---------- transform ----------
  function w2sx(x) { return (x * state.scale + state.ox) * dpr; }
  function w2sy(y) { return (-y * state.scale + state.oy) * dpr; }
  // Screen (CSS px) -> world. All callers pass CSS pixels (clientX/clientY,
  // getBoundingClientRect), so there is NO /dpr here: w2sx/w2sy already
  // convert the other way (world -> device px). Dividing by dpr here shrank
  // the fast-render culling rect on phones with dpr>1 and culled most of
  // the drawing — that is why B2.dwg rendered only in the top part.
  function s2wx(px) { return (px - state.ox) / state.scale; }
  function s2wy(py) { return -(py - state.oy) / state.scale; }

  // Fit the main drawing. Real fiber drawings have a dense plan plus long
  // sparse routes running far away — fitting the full bounds shrinks the plan
  // into a corner. (An earlier density-grid fit was removed: it finds the
  // DENSEST cluster, and on the 29MB file that is the cable tangle, not the
  // plan — v1.6.9 still opened on the tangle for exactly this reason.)
  function fitBounds() {
    var b = state.doc.bounds;
    if (settings.fitAll) return b;
    // Huge files: the density grid costs more than it helps — plain bounds.
    if ((state.doc.entities || []).length > 100000) return b;
    // Percentile bounds (1%-99%) over each entity's bounding-box corners:
    // frame where the bulk of the geometry is. The density grid was the
    // wrong tool here — it finds the DENSEST cluster, and on this file that
    // is the 971-unit cable tangle, so v1.6.9 still opened on the tangle.
    // Percentiles do not care how dense a spot is; they just cut off the
    // far-out minority on each side, so the box covers the plan and the
    // tangle together. Using bbox corners (2 points per entity) means one
    // long entity cannot dominate the percentile the way 200 sampled
    // points along it could, and no size filter is needed — which matters,
    // because the median entity here is a tiny tangle segment, so a
    // median-based filter would wrongly drop the plan's own lines.
    var xs = [], ys = [];
    (state.doc.entities || []).forEach(function (g) {
      var eb = entityBounds(g);
      if (eb) { xs.push(eb.minX, eb.maxX); ys.push(eb.minY, eb.maxY); }
    });
    if (xs.length < 10) return b;
    xs.sort(function (a, c) { return a - c; });
    ys.sort(function (a, c) { return a - c; });
    function pct(arr, q) { return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * q)))]; }
    var box = { minX: pct(xs, 0.01), maxX: pct(xs, 0.99), minY: pct(ys, 0.01), maxY: pct(ys, 0.99) };
    if (!(box.maxX > box.minX) || !(box.maxY > box.minY)) return b;
    // 10% padding around the region
    var mx = (box.maxX - box.minX) * 0.1, my = (box.maxY - box.minY) * 0.1;
    var rx0 = Math.max(b.minX, box.minX - mx), rx1 = Math.min(b.maxX, box.maxX + mx);
    var ry0 = Math.max(b.minY, box.minY - my), ry1 = Math.min(b.maxY, box.maxY + my);
    if (!(rx1 > rx0) || !(ry1 > ry0)) return b;
    return { minX: rx0, minY: ry0, maxX: rx1, maxY: ry1 };
  }

  // Saved view from the DWG file (*Active VPORT): the framing AutoCAD had
  // when the file was saved. It is only a fallback now — on this file it is
  // a 971-unit window inside 38.6M-unit bounds, a zoomed-in detail of the
  // cable tangle, not the plan. fitView trusts it only when it frames a
  // substantial part of the percentile-fit region (see fitView below).
  function savedViewBounds() {
    var sv = state.doc && state.doc.savedView;
    if (!sv || !isFinite(sv.cx) || !isFinite(sv.cy) || !isFinite(sv.height) || !(sv.height > 0)) return null;
    var r = canvas.parentElement.getBoundingClientRect();
    var aspect = (sv.aspect && isFinite(sv.aspect) && sv.aspect > 0)
      ? sv.aspect : (r.width > 2 && r.height > 2 ? r.width / r.height : 1);
    var w = sv.height * aspect, h = sv.height;
    var box = { minX: sv.cx - w / 2, maxX: sv.cx + w / 2, minY: sv.cy - h / 2, maxY: sv.cy + h / 2 };
    var b = state.doc.bounds;
    // sanity: the saved view must overlap the drawing at all
    if (box.maxX < b.minX || box.minX > b.maxX || box.maxY < b.minY || box.minY > b.maxY) return null;
    return box;
  }

  // How many entities lie entirely outside a box (their bbox does not
  // touch it at all). Used by fitView: a few strays outside the fit box
  // are junk to ignore, but a substantial number means the outer content
  // is real plan content (buildings, roads spread over the site), not junk.
  function countOutside(box) {
    var n = 0;
    (state.doc.entities || []).forEach(function (g) {
      var eb = entityBounds(g);
      if (eb && (eb.maxX < box.minX || eb.minX > box.maxX || eb.maxY < box.minY || eb.minY > box.maxY)) n++;
    });
    return n;
  }
  function fitView() {
    if (!state.doc) return;
    var b, kind;
    if (settings.fitAll) {
      b = state.doc.bounds; kind = 'full';
    } else {
      // The percentile fit finds the plan; the saved view is only a fallback.
      // The saved view used to win unconditionally, and on this file it is
      // a 971-unit window inside 38.6M-unit bounds (0.0036% of the drawing
      // height) — a zoomed-in detail of the cable tangle, not the plan —
      // so the app opened on the tangle while other viewers show the plan.
      // (A bound-less file — e.g. an empty DXF opened from another app —
      // has nothing to fit; leave the view alone.)
      var fb = state.doc.bounds;
      if (!fb || !isFinite(fb.minX) || !isFinite(fb.maxX) || !isFinite(fb.minY) || !isFinite(fb.maxY)) { state.fitKind = 'percentile'; return; }
      b = fitBounds(); kind = 'percentile';
      // v1.7.0 proved the percentile box is NOT the plan here: it frames
      // the fiber zone (3.62M x 3.37M units — the bulk of the entities),
      // while the site plan (buildings, roads) is sparse but spread over
      // the full 38.6M bounds. The percentile does its job; the job is
      // wrong for this file. So: if a substantial number of entities lie
      // entirely outside the percentile box, that outer content is the
      // real plan — frame the whole drawing instead, like DWG FastView
      // (Zoom Extents). A handful of strays (below the threshold) are
      // still ignored, so one far-out entity cannot shrink the plan.
      var outside = countOutside(b);
      state.fitOutside = outside;
      var total = (state.doc.entities || []).length;
      var need = Math.max(4, Math.floor(total * 0.001));
      if (outside >= need) {
        b = fb; kind = 'full';
      } else {
        var cbArea = (b.maxX - b.minX) * (b.maxY - b.minY);
        var fbArea = (fb.maxX - fb.minX) * (fb.maxY - fb.minY);
        var sv = savedViewBounds();
        if (cbArea < fbArea * 0.5) {
          // the percentile fit found a concentrated region: show the whole plan
          // there. Use the saved view only when it frames a substantial part
          // of that region (a tiny saved window is a detail view, not the plan).
          if (sv) {
            var svArea = (sv.maxX - sv.minX) * (sv.maxY - sv.minY);
            var overlaps = !(sv.maxX < b.minX || sv.minX > b.maxX || sv.maxY < b.minY || sv.minY > b.maxY);
            if (overlaps && svArea >= cbArea * 0.25 && svArea <= cbArea * 4) { b = sv; kind = 'saved'; }
          }
        } else if (sv) {
          // percentile did not concentrate (uniform file) — the saved view is
          // the better guess; otherwise the full bounds below.
          b = sv; kind = 'saved';
        } else {
          b = fb; kind = 'full';
        }
      }
    }
    state.fitKind = kind;
    // remember the box the fit actually chose, so the file-info sheet can
    // show it (diagnosing a wrong fit from a screenshot needs this number)
    state.fitBox = b;
    // an empty or bound-less file has nothing to fit — leave the view alone
    if (!b || !isFinite(b.minX) || !isFinite(b.maxX) || !isFinite(b.minY) || !isFinite(b.maxY)) return;
    var r = canvas.parentElement.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var bw = Math.max(b.maxX - b.minX, 0.001);
    var bh = Math.max(b.maxY - b.minY, 0.001);
    state.scale = Math.min(r.width / bw, r.height / bh) * 0.92;
    var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    state.ox = r.width / 2 - cx * state.scale;
    state.oy = r.height / 2 + cy * state.scale;
    render();
  }

  // ---------- viewport culling (fast render for big files) ----------
  function entityVisible(g, x0, y0, x1, y1) {
    // Bounds-based culling (O(1) once the bounds are cached). The old
    // polyline check scanned every point per frame, and it wrongly culled a
    // long segment that crossed the view with no vertex inside it.
    var b = entityBounds(g);
    if (!b) return false;
    return !(b.maxX < x0 || b.minX > x1 || b.maxY < y0 || b.minY > y1);
  }

  // True when the entity is smaller than ~1.5 device pixels on screen in
  // both directions — invisible at the current zoom, so skip drawing it.
  // Text is judged by its height (its bounds are a single point), and
  // points are always drawn (fixed screen-size cross).
  function isTooSmall(g) {
    if (!g || g.type === 'point') return false;
    if (g.type === 'text') return g.h < 1.5 / (state.scale * dpr);
    var b = entityBounds(g);
    if (!b) return false;
    var t = 1.5 / (state.scale * dpr);
    return (b.maxX - b.minX) < t && (b.maxY - b.minY) < t;
  }

  // ---------- drawing ----------
  function drawEntity(g) {
    if (!g || g._deleted) return;
    if (g.type === 'group') {
      if (isTooSmall(g)) return;
      g.items.forEach(drawEntity);
      return;
    }
    if (state.hiddenLayers[g.layer]) return;
    if (isTooSmall(g)) return;
    ctx.strokeStyle = resolveColor(g);
    ctx.fillStyle = resolveColor(g);
    ctx.lineWidth = lineWidth();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (g.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(w2sx(g.x1), w2sy(g.y1));
      ctx.lineTo(w2sx(g.x2), w2sy(g.y2));
      ctx.stroke();
    } else if (g.type === 'polyline') {
      if (!g.points || g.points.length < 2) return;
      var pts = g.points, n = pts.length;
      // LOD: at low zoom, consecutive points are sub-pixel apart. Draw a
      // subset — at most ~1 point per screen pixel along the polyline's
      // extent — so a 100k-point polyline costs ~1k lineTo calls, not 100k.
      // Zooming in raises the stride back to 1 (full detail).
      var step = 1;
      if (n > 100) {
        var b = g._box || entityBounds(g);
        if (b) {
          var ext = Math.max(b.maxX - b.minX, b.maxY - b.minY);
          var screenPx = ext * state.scale * dpr;
          if (screenPx > 0) step = Math.max(1, Math.floor(n / Math.max(1, screenPx)));
        }
      }
      ctx.beginPath();
      for (var k = 0; k < n; k += step) {
        if (k === 0) ctx.moveTo(w2sx(pts[k][0]), w2sy(pts[k][1]));
        else ctx.lineTo(w2sx(pts[k][0]), w2sy(pts[k][1]));
      }
      // always end at the last point so the line reaches its true end
      if (step > 1 && (n - 1) % step !== 0) ctx.lineTo(w2sx(pts[n - 1][0]), w2sy(pts[n - 1][1]));
      if (g.closed) ctx.closePath();
      ctx.stroke();
    } else if (g.type === 'circle') {
      ctx.beginPath();
      ctx.arc(w2sx(g.cx), w2sy(g.cy), Math.max(0.5, g.r * state.scale * dpr), 0, Math.PI * 2);
      ctx.stroke();
    } else if (g.type === 'text') {
      var fs = Math.max(9, g.h * state.scale * dpr);
      ctx.font = fs + 'px sans-serif';
      ctx.save();
      ctx.translate(w2sx(g.x), w2sy(g.y));
      ctx.rotate(-(g.rot * Math.PI) / 180);
      ctx.textBaseline = 'alphabetic';
      g.str.split('\n').forEach(function (line, k) {
        ctx.fillText(line, 0, k * fs * 1.2);
      });
      ctx.restore();
    } else if (g.type === 'point') {
      var s = 3 * dpr;
      var x = w2sx(g.x), y = w2sy(g.y);
      ctx.beginPath();
      ctx.moveTo(x - s, y); ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s); ctx.lineTo(x, y + s);
      ctx.stroke();
    }
  }

  function drawGrid() {
    var r = canvas.parentElement.getBoundingClientRect();
    ctx.strokeStyle = gridColor();
    ctx.lineWidth = 1;
    var step = 50 * dpr;
    ctx.beginPath();
    for (var x = 0; x < r.width * dpr; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, r.height * dpr); }
    for (var y = 0; y < r.height * dpr; y += step) { ctx.moveTo(0, y); ctx.lineTo(r.width * dpr, y); }
    ctx.stroke();
  }

  function drawMeasure() {
    if (!state.measurePts.length) return;
    ctx.strokeStyle = '#FFB020';
    ctx.fillStyle = '#FFB020';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    state.measurePts.forEach(function (p, k) {
      var x = w2sx(p[0]), y = w2sy(p[1]);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      ctx.moveTo(x + 5 * dpr, y); ctx.arc(x, y, 5 * dpr, 0, Math.PI * 2);
    });
    ctx.stroke();
    if (state.measurePts.length >= 2) {
      var last = state.measurePts[state.measurePts.length - 1];
      var label = fmtDist(state.measureTotal);
      ctx.font = 'bold ' + Math.round(14 * dpr) + 'px sans-serif';
      var tw = ctx.measureText(label).width;
      var lx = w2sx(last[0]) + 10 * dpr, ly = w2sy(last[1]) - 10 * dpr;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(lx - 4 * dpr, ly - 14 * dpr, tw + 8 * dpr, 20 * dpr);
      ctx.fillStyle = '#FFB020';
      ctx.fillText(label, lx, ly + 2 * dpr);
    }
  }

  function drawSearchHighlight() {
    var h = state.searchHighlight;
    if (!h || Date.now() > h.until) return;
    var x = w2sx(h.x), y = w2sy(h.y);
    ctx.strokeStyle = '#4F46E5';
    ctx.fillStyle = 'rgba(79, 70, 229, .25)';
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath(); ctx.arc(x, y, 20 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, 4 * dpr, 0, Math.PI * 2); ctx.fill();
  }

  // ---------- markup overlays: dimensions, freehand, notes, selection ----------
  function arrowHead(x, y, ang) {
    var s = 9 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - s * Math.cos(ang - 0.42), y - s * Math.sin(ang - 0.42));
    ctx.lineTo(x - s * Math.cos(ang + 0.42), y - s * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  function drawDimension(d) {
    var ax = w2sx(d.a[0]), ay = w2sy(d.a[1]);
    var bx = w2sx(d.b[0]), by = w2sy(d.b[1]);
    var dx = bx - ax, dy = by - ay;
    var len = Math.hypot(dx, dy);
    if (len < 1) return;
    var nx = -dy / len, ny = dx / len;
    var off = 18 * dpr;
    var x1 = ax + nx * off, y1 = ay + ny * off;
    var x2 = bx + nx * off, y2 = by + ny * off;
    var ang = Math.atan2(dy, dx);
    ctx.strokeStyle = '#38BDF8';
    ctx.fillStyle = '#38BDF8';
    ctx.lineWidth = 1.6 * dpr;
    // extension lines (from the measured points out to the dimension line)
    ctx.beginPath();
    ctx.moveTo(ax, ay); ctx.lineTo(x1 + nx * 6 * dpr, y1 + ny * 6 * dpr);
    ctx.moveTo(bx, by); ctx.lineTo(x2 + nx * 6 * dpr, y2 + ny * 6 * dpr);
    ctx.stroke();
    // dimension line + arrowheads at both ends
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.stroke();
    arrowHead(x1, y1, ang + Math.PI);
    arrowHead(x2, y2, ang);
    // distance text (constant screen size) in a dark pill
    var label = fmtDist(d.dist);
    ctx.font = 'bold ' + Math.round(12 * dpr) + 'px sans-serif';
    var tw = ctx.measureText(label).width;
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    ctx.fillStyle = 'rgba(15, 23, 42, .88)';
    ctx.fillRect(mx - tw / 2 - 6 * dpr, my - 10 * dpr, tw + 12 * dpr, 20 * dpr);
    ctx.fillStyle = '#38BDF8';
    ctx.textAlign = 'center';
    ctx.fillText(label, mx, my + 4 * dpr);
    ctx.textAlign = 'left';
  }

  // Revision cloud: arcs along the perimeter of a world-coords box,
  // drawn in screen space so the arcs stay a readable size at any zoom.
  function drawRevcloud(box) {
    var x0 = w2sx(box[0]), y0 = w2sy(box[3]);
    var x1 = w2sx(box[2]), y1 = w2sy(box[1]);
    var w = x1 - x0, h = y1 - y0;
    if (w < 4 || h < 4) return;
    var r = Math.max(7 * dpr, Math.min(18 * dpr, Math.min(w, h) / 6));
    ctx.strokeStyle = '#22C55E';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    // top edge (left -> right, bulging up)
    var x = x0;
    while (x < x1) { var cx = Math.min(x + r, x1); ctx.arc((x + cx) / 2, y0, (cx - x) / 2, Math.PI, 0); x = cx; }
    // right edge (top -> bottom, bulging right)
    var y = y0;
    while (y < y1) { var cy = Math.min(y + r, y1); ctx.arc(x1, (y + cy) / 2, (cy - y) / 2, -Math.PI / 2, Math.PI / 2); y = cy; }
    // bottom edge (right -> left, bulging down)
    x = x1;
    while (x > x0) { var cx2 = Math.max(x - r, x0); ctx.arc((x + cx2) / 2, y1, (x - cx2) / 2, 0, Math.PI); x = cx2; }
    // left edge (bottom -> top, bulging left)
    y = y1;
    while (y > y0) { var cy2 = Math.max(y - r, y0); ctx.arc(x0, (y + cy2) / 2, (y - cy2) / 2, Math.PI / 2, Math.PI * 1.5); y = cy2; }
    ctx.stroke();
  }

  function drawOverlays() {
    var k;
    // dimensions
    for (k = 0; k < state.dimensions.length; k++) drawDimension(state.dimensions[k]);
    // arrows (red) + the one being dragged right now
    function drawArrow(a) {
      var ax = w2sx(a.a[0]), ay = w2sy(a.a[1]);
      var bx = w2sx(a.b[0]), by = w2sy(a.b[1]);
      if (Math.hypot(bx - ax, by - ay) < 2) return;
      ctx.strokeStyle = '#EF4444';
      ctx.fillStyle = '#EF4444';
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.stroke();
      arrowHead(bx, by, Math.atan2(by - ay, bx - ax));
    }
    for (k = 0; k < state.arrows.length; k++) drawArrow(state.arrows[k]);
    if (state.pendingArrow) drawArrow(state.pendingArrow);
    // revision clouds (green arcs around a box) + the one being dragged
    for (k = 0; k < state.revclouds.length; k++) drawRevcloud(state.revclouds[k].box);
    if (state.pendingBox) {
      var pb = state.pendingBox;
      ctx.strokeStyle = '#22C55E';
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.strokeRect(w2sx(Math.min(pb.x0, pb.x1)), w2sy(Math.max(pb.y0, pb.y1)),
        Math.abs(pb.x1 - pb.x0) * state.scale * dpr, Math.abs(pb.y1 - pb.y0) * state.scale * dpr);
      ctx.setLineDash([]);
      drawRevcloud([Math.min(pb.x0, pb.x1), Math.min(pb.y0, pb.y1), Math.max(pb.x0, pb.x1), Math.max(pb.y0, pb.y1)]);
    }
    // freehand strokes (plus the one being drawn right now)
    function strokePath(s) {
      if (!s.pts || s.pts.length < 2) return;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 3 * dpr;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      s.pts.forEach(function (p, i) {
        if (i === 0) ctx.moveTo(w2sx(p[0]), w2sy(p[1]));
        else ctx.lineTo(w2sx(p[0]), w2sy(p[1]));
      });
      ctx.stroke();
    }
    for (k = 0; k < state.strokes.length; k++) strokePath(state.strokes[k]);
    if (state.currentStroke) strokePath(state.currentStroke);
    // voice-note pins (red circle + mic) and image pins (thumbnail)
    for (k = 0; k < state.recordings.length; k++) {
      var rc = state.recordings[k];
      var rx = w2sx(rc.x), ry = w2sy(rc.y);
      ctx.fillStyle = '#EF4444';
      ctx.beginPath(); ctx.arc(rx, ry, 13 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = Math.round(14 * dpr) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🎙️', rx, ry + 5 * dpr);
      ctx.textAlign = 'left';
      if (rc.dur) {
        ctx.font = 'bold ' + Math.round(11 * dpr) + 'px sans-serif';
        var durTxt = Math.floor(rc.dur / 60) + ':' + ('0' + (rc.dur % 60)).slice(-2);
        var dw = ctx.measureText(durTxt).width;
        ctx.fillStyle = 'rgba(15, 23, 42, .88)';
        ctx.fillRect(rx + 16 * dpr, ry - 9 * dpr, dw + 10 * dpr, 18 * dpr);
        ctx.fillStyle = '#fff';
        ctx.fillText(durTxt, rx + 21 * dpr, ry + 4 * dpr);
      }
    }
    for (k = 0; k < state.images.length; k++) {
      var im = state.images[k];
      var ix = w2sx(im.x), iy = w2sy(im.y);
      var thumb = state.imageCache[im.data];
      if (typeof Image !== 'undefined' && !thumb) {
        thumb = new Image();
        thumb.onload = function () { render(); };
        thumb.src = im.data;
        state.imageCache[im.data] = thumb;
      }
      if (thumb && thumb.complete && thumb.naturalWidth) {
        var ts = 64 * dpr;
        ctx.save();
        ctx.beginPath();
        ctx.rect(ix - ts / 2, iy - ts / 2, ts, ts);
        ctx.clip();
        ctx.drawImage(thumb, ix - ts / 2, iy - ts / 2, ts, ts);
        ctx.restore();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2 * dpr;
        ctx.strokeRect(ix - ts / 2, iy - ts / 2, ts, ts);
      } else {
        ctx.fillStyle = '#3B82F6';
        ctx.beginPath(); ctx.arc(ix, iy, 13 * dpr, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = Math.round(13 * dpr) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🖼️', ix, iy + 5 * dpr);
        ctx.textAlign = 'left';
      }
    }
    // note pins (numbered) + their text in a dark pill
    for (k = 0; k < state.annotations.length; k++) {
      var a = state.annotations[k];
      var x = w2sx(a.x), y = w2sy(a.y);
      ctx.fillStyle = '#FBBF24';
      ctx.beginPath(); ctx.arc(x, y, 11 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111827';
      ctx.font = 'bold ' + Math.round(12 * dpr) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(k + 1), x, y + 4 * dpr);
      ctx.textAlign = 'left';
      ctx.font = Math.round(12 * dpr) + 'px sans-serif';
      var tw = ctx.measureText(a.text).width;
      ctx.fillStyle = 'rgba(15, 23, 42, .88)';
      ctx.fillRect(x + 14 * dpr, y - 10 * dpr, tw + 12 * dpr, 20 * dpr);
      ctx.fillStyle = '#FBBF24';
      ctx.fillText(a.text, x + 20 * dpr, y + 4 * dpr);
    }
    // selected entity highlight (edit mode): dashed bounding box
    if (state.tool === 'edit' && state.selected) {
      var b = entityBounds(state.selected);
      if (b) {
        ctx.strokeStyle = '#4F46E5';
        ctx.lineWidth = 2 * dpr;
        ctx.setLineDash([6 * dpr, 5 * dpr]);
        ctx.strokeRect(w2sx(b.minX), w2sy(b.maxY), (b.maxX - b.minX) * state.scale * dpr, (b.maxY - b.minY) * state.scale * dpr);
        ctx.setLineDash([]);
      }
    }
  }

  // Coalesced render for continuous gestures (pan, pinch, wheel): a drag
  // fires dozens of pointermove events, and a full vector render of a huge
  // file takes real time — rendering synchronously on every move queued up
  // seconds of work and the view felt frozen. Now at most one render runs
  // per animation frame.
  var renderQueued = false;
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      render();
    });
  }

  function render() {
    var r = canvas.parentElement.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    colorCache = {};
    ctx.fillStyle = bgColor();
    ctx.fillRect(0, 0, r.width * dpr, r.height * dpr);
    drawGrid();
    if (state.doc) {
      var x0 = s2wx(0), y0 = s2wy(r.height), x1 = s2wx(r.width), y1 = s2wy(0);
      state.doc.entities.forEach(function (g) {
        if (settings.fastRender && !entityVisible(g, x0, y0, x1, y1)) return;
        drawEntity(g);
      });
    }
    drawMeasure();
    drawSearchHighlight();
    drawOverlays();
  }

  function fmtNum(n) {
    return (Math.round(n * 100) / 100).toLocaleString('en-US');
  }
  // Measurement units: the drawing's base unit, converted to meters
  // for display (the user asked for distances in meters).
  var UNIT_TO_M = { m: 1, mm: 0.001, cm: 0.01, ft: 0.3048, in: 0.0254 };
  function toMeters(d) { return d * (UNIT_TO_M[settings.measureUnit] || 1); }
  function fmtDist(d) { return fmtNum(toMeters(d)) + ' م'; }
  function fmtSize(bytes) {
    if (bytes >= 1048576) return (Math.round(bytes / 1048576 * 100) / 100) + 'MB';
    if (bytes >= 1024) return Math.round(bytes / 1024) + 'KB';
    return bytes + 'B';
  }
  function fmtDate(t) {
    var d = new Date(t);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ---------- file loading ----------
  // Shared display path for any parsed doc (DXF or DWG).
  function loadDoc(doc, name, opts) {
    opts = opts || {};
    state.doc = doc;
    state.fileName = name || 'رسم بدون اسم';
    state.fileSize = opts.size || 0;
    // Cache every entity's bounds once (cheap math, one pass) so per-frame
    // culling and the sub-pixel skip are O(1) instead of re-scanning points.
    (doc.entities || []).forEach(function (g) { entityBounds(g); });
    state.hiddenLayers = {};
    state.measurePts = [];
    state.measureTotal = 0;
    state.selected = null;
    // fresh markup state for the new file (saved markups load below)
    state.tool = null;
    state.annotateSub = 'text';
    state.annotations = [];
    state.strokes = [];
    state.dimensions = [];
    state.arrows = [];
    state.revclouds = [];
    state.recordings = [];
    state.images = [];
    state.dimPending = null;
    state.currentStroke = null;
    state.pendingArrow = null;
    state.pendingBox = null;
    state.pendingImagePoint = null;
    state.pendingAudioPoint = null;
    state.imageCache = {};
    stopPlayback();
    if (state.recording) stopRecording();
    state.editMoveArmed = false;
    state.editDrag = null;
    state.pendingNote = null;
    state.undoStack = [];
    state.redoStack = [];
    updateUndoButtons();
    hideEditBar();
    closeNoteSheet();
    closeImageViewer();
    document.getElementById('drawPalette').classList.add('hidden');
    document.getElementById('annotateBar').classList.add('hidden');
    fileNameEl.textContent = state.fileName + ' — ' + doc.entities.length + ' عنصر';
    buildLayersPanel();
    searchIndex = null; // built lazily on the first search, not at open time
    closeSearchSheet();
    showScreen('viewer');
    hideLoading();
    loadMarkups(name);
    requestAnimationFrame(function () {
      resize();
      fitView();
      if (opts.save !== false) {
        // Save the file to the library after the viewer is interactive,
        // so a big (multi-MB) write does not stall the first view.
        setTimeout(function () { saveToLibrary(name, opts.saveData, opts.size || 0, opts.isDwg); }, 1500);
      }
    });
    showInfo('اتفتح ' + state.fileName + ' ✓');
  }

  function loadDXF(text, name, opts) {
    opts = opts || {};
    try {
      var doc = DXF.parse(text);
      loadDoc(doc, name, { save: opts.save, size: opts.size || text.length, saveData: text, isDwg: false });
    } catch (err) {
      showHomeToast('الملف ده مش DXF صحيح — جرّب ملف تاني');
    }
  }

  function loadDWG(arrayBuffer, name, opts) {
    opts = opts || {};
    showLoading(name, opts.size || arrayBuffer.byteLength);
    // Let the loading overlay paint before the heavy parse blocks the thread.
    requestAnimationFrame(function () {
      setTimeout(function () {
        DWG.open(arrayBuffer).then(function (doc) {
          loadDoc(doc, name, { save: opts.save, size: opts.size || arrayBuffer.byteLength, saveData: arrayBuffer, isDwg: true });
          if (doc.dwgStats && doc.dwgStats.skipped && Object.keys(doc.dwgStats.skipped).length) {
            showInfo('اتفتح ' + name + ' ✓ — بعض العناصر (أبعاد، تظليل…) مش مدعومة ومتعرضتش');
          }
        }).catch(function (err) {
          hideLoading();
          showHomeToast('مش قادر أفتح ملف DWG ده — ' + (err && err.message ? err.message : 'ملف تالف أو نسخة غير مدعومة'));
        });
      }, 30);
    });
  }

  function makeThumbnail() {
    try {
      var small = document.createElement('canvas');
      small.width = 168; small.height = 128;
      var sctx = small.getContext('2d');
      sctx.fillStyle = bgColor();
      sctx.fillRect(0, 0, 168, 128);
      sctx.drawImage(canvas, 0, 0, 168, 128);
      return small.toDataURL('image/jpeg', 0.7);
    } catch (e) { return ''; }
  }

  function openFilePicker() { fileInput.click(); }

  function handlePickedFile(f) {
    if (!f) return;
    var reader = new FileReader();
    if (/\.dwg$/i.test(f.name)) {
      reader.onload = function () { loadDWG(reader.result, f.name, { size: f.size }); };
      reader.readAsArrayBuffer(f);
    } else {
      reader.onload = function () { loadDXF(String(reader.result), f.name, { size: f.size }); };
      reader.readAsText(f);
    }
    fileInput.value = '';
  }

  fileInput.addEventListener('change', function () {
    handlePickedFile(fileInput.files && fileInput.files[0]);
  });

  // A DWG/DXF opened with the app from another app (WhatsApp, Files, ...):
  // Android launches us with a VIEW intent; the native IntentFile plugin
  // reads the file's bytes and name, and we open it like a picked file.
  function base64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function checkIntentFile() {
    callNativePlugin('IntentFile', 'getIntentFile').then(function (res) {
      if (!res || !res.dataBase64) return;
      var name = res.name || 'file.dwg';
      var bytes = base64ToBytes(res.dataBase64);
      if (/\.dwg$/i.test(name)) {
        loadDWG(bytes.buffer, name, { size: bytes.length });
      } else if (/\.dxf$/i.test(name)) {
        loadDXF(new TextDecoder().decode(bytes), name, { size: bytes.length });
      }
    }).catch(function () { /* no intent file — normal launch */ });
  }

  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    handlePickedFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });

  function loadDemo() {
    fetch('demo.dxf')
      .then(function (res) { return res.text(); })
      .then(function (txt) { loadDXF(txt, 'رسمة تجريبية — شقة', { size: txt.length }); })
      .catch(function () { showHomeToast('مش قادر أفتح الرسمة التجريبية'); });
  }

  // ---------- library (IndexedDB) ----------
  var idb = null;
  function openDB() {
    return new Promise(function (resolve) {
      var req = indexedDB.open('scfastview', 3);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'name' });
        // 'wasm' holds the DWG engine (libredwg-web.wasm) once, so a future
        // small APK can load it from here instead of bundling it again.
        if (!db.objectStoreNames.contains('wasm')) db.createObjectStore('wasm', { keyPath: 'name' });
        // 'markups' holds the user's notes, freehand and dimensions per file.
        if (!db.objectStoreNames.contains('markups')) db.createObjectStore('markups', { keyPath: 'name' });
      };
      req.onsuccess = function () { idb = req.result; resolve(true); };
      req.onerror = function () { resolve(false); };
    });
  }
  // Save the current file's markups (notes, strokes, dimensions, arrows,
  // clouds, voice notes, photos) so they are still there when the file is
  // opened again. Move/delete edits are session-only: they live on the
  // parsed entities, which are rebuilt on load.
  function saveMarkups() {
    if (!idb || !state.fileName || !state.doc) return;
    try {
      var tx = idb.transaction('markups', 'readwrite');
      tx.objectStore('markups').put({
        name: state.fileName,
        annotations: state.annotations,
        strokes: state.strokes,
        dimensions: state.dimensions,
        arrows: state.arrows,
        revclouds: state.revclouds,
        recordings: state.recordings,
        images: state.images
      });
    } catch (e) { /* ignore */ }
  }
  function loadMarkups(name) {
    if (!idb || !name) return;
    try {
      var tx = idb.transaction('markups', 'readonly');
      var req = tx.objectStore('markups').get(name);
      req.onsuccess = function () {
        var rec = req.result;
        if (rec) {
          state.annotations = rec.annotations || [];
          state.strokes = rec.strokes || [];
          state.dimensions = rec.dimensions || [];
          state.arrows = rec.arrows || [];
          state.revclouds = rec.revclouds || [];
          state.recordings = rec.recordings || [];
          state.images = rec.images || [];
          render();
        }
      };
    } catch (e) { /* ignore */ }
  }
  // data: DXF text (string) or DWG raw bytes (ArrayBuffer). isDwg flags which.
  function saveToLibrary(name, data, size, isDwg) {
    if (!idb || !name) return;
    try {
      var tx = idb.transaction('files', 'readwrite');
      var store = tx.objectStore('files');
      var getReq = store.get(name);
      getReq.onsuccess = function () {
        var prev = getReq.result || {};
        var rec = {
          name: name, size: size || 0,
          time: Date.now(), thumb: makeThumbnail(),
          favorite: !!prev.favorite, isDemo: name.indexOf('تجريبية') !== -1,
          isDwg: !!isDwg
        };
        if (isDwg) rec.data = data; else rec.text = data;
        store.put(rec);
        loadLibrary();
      };
    } catch (e) { /* ignore */ }
  }
  function loadLibrary() {
    if (!idb) return;
    try {
      var tx = idb.transaction('files', 'readonly');
      var req = tx.objectStore('files').getAll();
      req.onsuccess = function () {
        state.library = req.result || [];
        renderLibrary();
      };
    } catch (e) { /* ignore */ }
  }
  // Save the bundled DWG engine (libredwg-web.wasm, ~8 MB) into the app's
  // storage once, in the background, from the local APK assets (no network).
  // The next version's APK will not bundle the engine, so its update
  // download becomes small (~1.5 MB) and the engine loads from here.
  function cacheWasmEngine() {
    if (!idb) return;
    try {
      var tx = idb.transaction('wasm', 'readonly');
      var get = tx.objectStore('wasm').get('libredwg-web.wasm');
      get.onsuccess = function () {
        if (get.result) return; // already cached
        fetch('libredwg/libredwg-web.wasm').then(function (res) {
          if (!res.ok) return null;
          return res.arrayBuffer();
        }).then(function (buf) {
          if (!buf) return;
          try {
            var tx2 = idb.transaction('wasm', 'readwrite');
            tx2.objectStore('wasm').put({ name: 'libredwg-web.wasm', data: buf, size: buf.byteLength, savedAt: Date.now() });
          } catch (e) { /* ignore */ }
        }).catch(function () { /* ignore — DWG still opens from the bundled engine */ });
      };
    } catch (e) { /* ignore */ }
  }
  function toggleFavorite(name) {
    if (!idb) return;
    try {
      var tx = idb.transaction('files', 'readwrite');
      var store = tx.objectStore('files');
      var req = store.get(name);
      req.onsuccess = function () {
        var rec = req.result;
        if (!rec) return;
        rec.favorite = !rec.favorite;
        store.put(rec);
        loadLibrary();
      };
    } catch (e) { /* ignore */ }
  }

  function renderLibrary() {
    var rows = state.library.slice();
    if (state.tab === 'favorites') rows = rows.filter(function (r) { return r.favorite; });
    else if (state.tab === 'drawings') rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
    else rows.sort(function (a, b) { return b.time - a.time; });
    // بحث داخل التطبيق + فلتر نوع الملف
    var hasFilter = state.search !== '' || state.typeFilter !== 'all';
    if (state.typeFilter === 'dwg') rows = rows.filter(function (r) { return r.isDwg; });
    else if (state.typeFilter === 'dxf') rows = rows.filter(function (r) { return !r.isDwg; });
    if (state.search !== '') {
      var q = state.search;
      rows = rows.filter(function (r) { return String(r.name).toLowerCase().indexOf(q) !== -1; });
    }
    fileListEl.innerHTML = '';
    homeEmptyEl.classList.toggle('hidden', rows.length > 0 || state.tab === 'favorites' || hasFilter);
    if (state.tab === 'favorites' && !rows.length) {
      var emptyFav = document.createElement('div');
      emptyFav.className = 'empty-card';
      emptyFav.innerHTML = '<p class="empty-sub">مفيش ملفات مفضلة لسه — دوس على النجمة ⭐ جنب أي ملف</p>';
      fileListEl.appendChild(emptyFav);
      return;
    }
    if (!rows.length && hasFilter) {
      var emptySearch = document.createElement('div');
      emptySearch.className = 'search-empty';
      emptySearch.innerHTML = 'مفيش نتائج مطابقة لـ <b>«' + escapeHtml(state.search || '') + '»</b><br>جرّب اسم تاني أو غيّر الفلتر';
      fileListEl.appendChild(emptySearch);
      return;
    }
    rows.forEach(function (rec) {
      var card = document.createElement('button');
      card.className = 'file-card';
      var thumb = rec.thumb
        ? '<img class="file-thumb" src="' + rec.thumb + '" alt="">'
        : '<span class="file-thumb-placeholder">📐</span>';
      var typeBadge = rec.isDwg
        ? '<span class="file-type dwg">DWG</span>'
        : '<span class="file-type dxf">DXF</span>';
      card.innerHTML = thumb +
        '<span class="file-meta"><span class="file-name">' + escapeHtml(rec.name) + '</span>' +
        '<span class="file-sub">' + fmtDate(rec.time) + ' &nbsp;' + fmtSize(rec.size) + '</span>' + typeBadge + '</span>' +
        '<span class="file-star' + (rec.favorite ? ' on' : '') + '" data-star="1">' + (rec.favorite ? '★' : '☆') + '</span>';
      card.addEventListener('click', function (ev) {
        if (ev.target.getAttribute('data-star')) {
          ev.stopPropagation();
          toggleFavorite(rec.name);
          return;
        }
        if (rec.isDwg) {
          if (!rec.data) { showHomeToast('الملف ده مش متخزن — افتحه تاني من موبايلك'); return; }
          loadDWG(rec.data, rec.name, { save: false });
          return;
        }
        if (!rec.text) { showHomeToast('الملف ده مش متخزن — افتحه تاني من موبايلك'); return; }
        loadDXF(rec.text, rec.name, { save: false });
      });
      fileListEl.appendChild(card);
    });
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      state.tab = t.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function (x) {
        x.classList.toggle('active', x === t);
      });
      renderLibrary();
    });
  });

  // ---------- بحث داخل التطبيق + فلتر النوع ----------
  var searchInputEl = document.getElementById('searchInput');
  var clearSearchEl = document.getElementById('btnClearSearch');
  if (searchInputEl) {
    searchInputEl.addEventListener('input', function () {
      state.search = searchInputEl.value.trim().toLowerCase();
      clearSearchEl.classList.toggle('hidden', !searchInputEl.value);
      renderLibrary();
    });
  }
  if (clearSearchEl) {
    clearSearchEl.addEventListener('click', function () {
      searchInputEl.value = '';
      state.search = '';
      clearSearchEl.classList.add('hidden');
      renderLibrary();
      searchInputEl.focus();
    });
  }
  document.querySelectorAll('#typeChips .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      state.typeFilter = c.getAttribute('data-type');
      document.querySelectorAll('#typeChips .chip').forEach(function (x) {
        x.classList.toggle('active', x === c);
      });
      renderLibrary();
    });
  });

  // ---------- layers panel ----------
  // Layer names from PDF-converted files are Chinese (the converter names
  // them PDF_文字 / PDF_几何图形 / PDF_实体填充). Show them in Arabic
  // instead — the internal name stays untouched, so toggling and search
  // keep working exactly as before.
  var LAYER_CN_WORDS = [
    ['PDF_几何图形', 'رسوم PDF'],
    ['PDF_文字', 'نصوص PDF'],
    ['PDF_实体填充', 'تعبئة PDF'],
    ['几何图形', 'رسوم'],
    ['文字', 'نصوص'],
    ['实体填充', 'تعبئة']
  ];
  function displayLayerName(name) {
    var out = String(name || '');
    LAYER_CN_WORDS.forEach(function (pair) {
      out = out.split(pair[0]).join(pair[1]);
    });
    return out;
  }

  function buildLayersPanel() {
    layersList.innerHTML = '';
    if (!state.doc) return;
    state.doc.layers.forEach(function (layer) {
      var row = document.createElement('label');
      row.className = 'layer-row';
      var dot = DXF.aciColor(layer.color, isDarkBg()) || fgColor();
      row.innerHTML =
        '<span class="layer-dot" style="background:' + dot + '"></span>' +
        '<span class="layer-name">' + escapeHtml(displayLayerName(layer.name)) + '</span>' +
        '<input type="checkbox" ' + (state.hiddenLayers[layer.name] ? '' : 'checked') + '>';
      row.querySelector('input').addEventListener('change', function (ev) {
        state.hiddenLayers[layer.name] = !ev.target.checked;
        render();
      });
      layersList.appendChild(row);
    });
  }

  // ---------- معلومات الملف (تشخيص: دوس على اسم الملف فوق) ----------
  // Shows what the parser actually found in the open file — mapped
  // entities, skipped types with counts, drawing bounds, saved view, and
  // which fit was used. This is how a "the drawing looks incomplete"
  // report is diagnosed in the field: the numbers say whether content was
  // skipped (e.g. fills), or the fit zoomed to the wrong region.
  var infoSheetEl = document.getElementById('infoSheet');
  var infoListEl = document.getElementById('infoList');
  function infoRow(k, v) {
    return '<div class="info-row"><span class="info-k">' + escapeHtml(k) + '</span>' +
      '<span class="info-v">' + escapeHtml(String(v)) + '</span></div>';
  }
  function buildInfoSheet() {
    if (!infoListEl || !state.doc) return;
    var doc = state.doc;
    var html = '';
    html += infoRow('الملف', state.fileName || '');
    html += infoRow('الحجم', state.fileSize ? fmtSize(state.fileSize) : '—');
    html += infoRow('عناصر معروضة', (doc.entities || []).length);
    if (doc.dwgStats) {
      html += infoRow('إجمالي عناصر الملف', doc.dwgStats.total);
      var sk = doc.dwgStats.skipped || {};
      var keys = Object.keys(sk).sort(function (a, b) { return sk[b] - sk[a]; });
      if (keys.length) {
        html += infoRow('عناصر متخطية (مش مدعومة)', keys.slice(0, 8).map(function (k) {
          return k + ': ' + sk[k];
        }).join('، '));
      } else {
        html += infoRow('عناصر متخطية (مش مدعومة)', 'مفيش — كل حاجة اتعرضت');
      }
    }
    var b = doc.bounds;
    if (b && isFinite(b.minX)) {
      html += infoRow('أبعاد الرسمة', fmtNum(b.maxX - b.minX) + ' × ' + fmtNum(b.maxY - b.minY));
    }
    html += infoRow('العرض المحفوظ في الملف', doc.savedView ? 'موجود (ارتفاع ' + fmtNum(doc.savedView.height) + ')' : 'مفيش');
    html += infoRow('الملاءمة المستخدمة', state.fitKind === 'saved' ? 'العرض المحفوظ' : state.fitKind === 'full' ? 'حدود الرسمة كلها' : 'أغلب الرسمة');
    if (state.fitBox && isFinite(state.fitBox.minX)) {
      html += infoRow('منطقة العرض', fmtNum(state.fitBox.maxX - state.fitBox.minX) + ' × ' + fmtNum(state.fitBox.maxY - state.fitBox.minY));
    }
    if (state.fitOutside != null) {
      html += infoRow('عناصر خارج منطقة العرض', state.fitOutside);
    }
    html += infoRow('عدد الطبقات', (doc.layers || []).length);
    infoListEl.innerHTML = html;
  }
  function showFileInfo() {
    if (!state.doc) return;
    closeSearchSheet();
    layersSheet.classList.remove('open');
    buildInfoSheet();
    infoSheetEl.classList.add('open');
  }
  function closeInfoSheet() {
    if (infoSheetEl) infoSheetEl.classList.remove('open');
  }

  // ---------- بحث داخل الرسمة (نصوص + طبقات) ----------
  var searchIndex = null; // { texts: [{str,x,y,layer}], layers: [{name,count,box}] }
  var searchSheetEl = document.getElementById('searchSheet');
  var searchInputViewerEl = document.getElementById('searchInputViewer');
  var searchResultsEl = document.getElementById('searchResults');
  var searchCountEl = document.getElementById('searchCount');

  function collectTexts(list, out) {
    list.forEach(function (g) {
      if (!g) return;
      if (g.type === 'group') { collectTexts(g.items || [], out); return; }
      if (g.type === 'text' && g.str && String(g.str).trim() !== '') {
        out.push({ str: String(g.str), x: g.x, y: g.y, layer: g.layer || '' });
      }
    });
  }
  // Entity bounds, cached on the entity (g._box). A polyline with thousands
  // of points used to be re-scanned on EVERY frame (culling, search, fit),
  // which is what froze the viewer on huge files. The cache is filled once
  // at open time; moving an entity (edit) clears it.
  function entityBounds(g) {
    if (!g) return null;
    if (g._box) return g._box;
    var b = null;
    if (g.type === 'line') b = { minX: Math.min(g.x1, g.x2), maxX: Math.max(g.x1, g.x2), minY: Math.min(g.y1, g.y2), maxY: Math.max(g.y1, g.y2) };
    else if (g.type === 'polyline') {
      (g.points || []).forEach(function (p) {
        if (!b) b = { minX: p[0], maxX: p[0], minY: p[1], maxY: p[1] };
        b.minX = Math.min(b.minX, p[0]); b.maxX = Math.max(b.maxX, p[0]);
        b.minY = Math.min(b.minY, p[1]); b.maxY = Math.max(b.maxY, p[1]);
      });
    }
    else if (g.type === 'circle') b = { minX: g.cx - g.r, maxX: g.cx + g.r, minY: g.cy - g.r, maxY: g.cy + g.r };
    else if (g.type === 'text' || g.type === 'point') b = { minX: g.x, maxX: g.x, minY: g.y, maxY: g.y };
    else if (g.type === 'group') {
      (g.items || []).forEach(function (it) {
        var ib = entityBounds(it);
        if (ib) b = b ? unionBox(b, ib) : ib;
      });
    }
    if (b) g._box = b;
    return b;
  }
  function unionBox(a, b) {
    return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) };
  }
  // Build the search index on first use (not at open time): on a huge file
  // it is a full pass over every entity, and most opens never search.
  function ensureSearchIndex() {
    if (!searchIndex && state.doc) buildSearchIndex();
  }
  function buildSearchIndex() {
    searchIndex = null;
    if (!state.doc) return;
    var texts = [];
    collectTexts(state.doc.entities || [], texts);
    var layers = {};
    (state.doc.entities || []).forEach(function (g) {
      var name = g.layer || '0';
      if (!layers[name]) layers[name] = { name: name, count: 0, box: null };
      layers[name].count++;
      var b = entityBounds(g);
      if (b) layers[name].box = layers[name].box ? unionBox(layers[name].box, b) : b;
    });
    var layerList = Object.keys(layers).map(function (k) { return layers[k]; });
    layerList.sort(function (a, b) { return b.count - a.count; });
    searchIndex = { texts: texts, layers: layerList };
  }
  function closeSearchSheet() {
    searchSheetEl.classList.remove('open');
    document.getElementById('btnSearch').classList.remove('active');
  }
  function openSearchSheet() {
    if (!state.doc) { showInfo('افتح ملف الأول عشان تبحث فيه'); return; }
    layersSheet.classList.remove('open');
    searchSheetEl.classList.add('open');
    document.getElementById('btnSearch').classList.add('active');
    runSearch(searchInputViewerEl.value);
    setTimeout(function () { searchInputViewerEl.focus(); }, 250);
  }
  function runSearch(q) {
    q = (q || '').trim().toLowerCase();
    searchResultsEl.innerHTML = '';
    document.getElementById('btnClearSearchViewer').classList.toggle('hidden', !searchInputViewerEl.value);
    ensureSearchIndex();
    if (!searchIndex) { searchCountEl.textContent = 'مفيش رسمة مفتوحة'; return; }
    if (!q) {
      searchCountEl.textContent = searchIndex.texts.length + ' نص في الرسمة — اكتب كلمة للبحث';
      return;
    }
    var textHits = [];
    for (var i = 0; i < searchIndex.texts.length && textHits.length < 50; i++) {
      if (searchIndex.texts[i].str.toLowerCase().indexOf(q) !== -1) textHits.push(searchIndex.texts[i]);
    }
    var layerHits = [];
    for (var j = 0; j < searchIndex.layers.length && layerHits.length < 10; j++) {
      var L = searchIndex.layers[j];
      // match the original name AND the Arabic display name
      if (L.box && (L.name.toLowerCase().indexOf(q) !== -1 ||
          displayLayerName(L.name).toLowerCase().indexOf(q) !== -1)) layerHits.push(L);
    }
    var total = textHits.length + layerHits.length;
    searchCountEl.textContent = total ? ('لقيت ' + total + ' نتيجة') : 'مفيش نتائج مطابقة';
    if (!total) {
      var hint = document.createElement('div');
      hint.className = 'search-hint';
      hint.textContent = 'جرّب كلمة تانية — مثال: TB019';
      searchResultsEl.appendChild(hint);
      return;
    }
    textHits.forEach(function (t) {
      var row = document.createElement('button');
      row.className = 'search-result';
      row.innerHTML = '<span class="res-ico">🔤</span><span class="res-text">' + escapeHtml(t.str) + '</span><span class="res-sub">' + escapeHtml(displayLayerName(t.layer)) + '</span>';
      row.addEventListener('click', function () { jumpToPoint(t.x, t.y, t.str); });
      searchResultsEl.appendChild(row);
    });
    layerHits.forEach(function (L) {
      var row = document.createElement('button');
      row.className = 'search-result';
      row.innerHTML = '<span class="res-ico">🧱</span><span class="res-text">' + escapeHtml(displayLayerName(L.name)) + '</span><span class="res-sub">طبقة • ' + L.count + ' عنصر</span>';
      row.addEventListener('click', function () { fitToBox(L.box); });
      searchResultsEl.appendChild(row);
    });
  }
  function jumpToPoint(x, y, label) {
    var r = canvas.parentElement.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var targetScale = Math.max(state.scale, r.width / 60);
    state.scale = targetScale;
    state.ox = r.width / 2 - x * state.scale;
    state.oy = r.height / 2 + y * state.scale;
    state.searchHighlight = { x: x, y: y, until: Date.now() + 3500 };
    closeSearchSheet();
    render();
    setTimeout(render, 3600);
    if (label) showHomeToast('📍 ' + label);
  }
  function fitToBox(b) {
    var r = canvas.parentElement.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var bw = Math.max(b.maxX - b.minX, 0.001);
    var bh = Math.max(b.maxY - b.minY, 0.001);
    state.scale = Math.min(r.width / bw, r.height / bh) * 0.92;
    var cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    state.ox = r.width / 2 - cx * state.scale;
    state.oy = r.height / 2 + cy * state.scale;
    closeSearchSheet();
    render();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------- measure & tap ----------
  function entityLength(g) {
    if (g.type === 'line') return Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
    if (g.type === 'polyline') {
      var L = 0;
      for (var k = 0; k < g.points.length - 1; k++) {
        L += Math.hypot(g.points[k + 1][0] - g.points[k][0], g.points[k + 1][1] - g.points[k][1]);
      }
      return L;
    }
    if (g.type === 'circle') return 2 * Math.PI * g.r;
    return null;
  }

  function distToEntity(g, wx, wy) {
    if (!g || g._deleted) return Infinity;
    function seg(px, py, x1, y1, x2, y2) {
      var dx = x2 - x1, dy = y2 - y1;
      var len2 = dx * dx + dy * dy;
      var t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }
    if (g.type === 'line') return seg(wx, wy, g.x1, g.y1, g.x2, g.y2);
    if (g.type === 'polyline') {
      var best = Infinity;
      for (var k = 0; k < g.points.length - 1; k++) {
        best = Math.min(best, seg(wx, wy, g.points[k][0], g.points[k][1], g.points[k + 1][0], g.points[k + 1][1]));
      }
      return best;
    }
    if (g.type === 'circle') return Math.abs(Math.hypot(wx - g.cx, wy - g.cy) - g.r);
    if (g.type === 'text' || g.type === 'point') return Math.hypot(wx - g.x, wy - g.y);
    if (g.type === 'group') {
      var m = Infinity;
      g.items.forEach(function (it) { m = Math.min(m, distToEntity(it, wx, wy)); });
      return m;
    }
    return Infinity;
  }

  function describeEntity(g) {
    var label = { line: 'خط', polyline: 'خط متعدد', circle: 'دائرة', text: 'نص', point: 'نقطة', group: 'مجموعة' }[g.type] || g.type;
    var s = label + ' — طبقة ' + g.layer;
    var L = entityLength(g);
    if (L !== null) s += ' — الطول ' + fmtNum(L);
    if (g.type === 'circle') s += ' — نصف القطر ' + fmtNum(g.r);
    if (g.type === 'text') s += ' — "' + g.str + '"';
    return s;
  }

  function handleTap(wx, wy) {
    if (!state.doc) return;
    // --- measure: tap points, chain the total distance ---
    if (state.tool === 'measure') {
      state.measurePts.push([wx, wy]);
      if (state.measurePts.length >= 2) {
        var a = state.measurePts[state.measurePts.length - 2];
        var b = state.measurePts[state.measurePts.length - 1];
        state.measureTotal += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      measureLabel.textContent = state.measurePts.length < 2
        ? 'دوس على نقطة تانية'
        : 'المسافة: ' + fmtDist(state.measureTotal) + ' — دوس تاني عشان تكمّل';
      render();
      return;
    }
    // --- dimension: two taps = one persistent dimension line ---
    if (state.tool === 'dimension') {
      if (!state.dimPending) {
        state.dimPending = [wx, wy];
        measureLabel.textContent = 'دوس على النقطة التانية للبُعد';
      } else {
        var p1 = state.dimPending, p2 = [wx, wy];
        var dim = { a: p1, b: p2, dist: Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) };
        state.dimensions.push(dim);
        pushUndo({ type: 'add-dimension', item: dim });
        state.dimPending = null;
        measureLabel.textContent = 'البُعد: ' + fmtDist(dim.dist);
        saveMarkups();
      }
      render();
      return;
    }
    // --- annotate: sub-tools ---
    if (state.tool === 'annotate') {
      var tapSx = wx * state.scale + state.ox;
      var tapSy = -wy * state.scale + state.oy;
      function pinHit(px, py) {
        return Math.hypot(px * state.scale + state.ox - tapSx, -py * state.scale + state.oy - tapSy) <= 26;
      }
      // recording pins: tap to play / stop (any annotate sub-mode)
      for (var ri = 0; ri < state.recordings.length; ri++) {
        if (pinHit(state.recordings[ri].x, state.recordings[ri].y)) {
          togglePlayback(state.recordings[ri]);
          return;
        }
      }
      // image pins: tap to view (any annotate sub-mode)
      for (var ii = 0; ii < state.images.length; ii++) {
        if (pinHit(state.images[ii].x, state.images[ii].y)) {
          openImageViewer(state.images[ii]);
          return;
        }
      }
      if (state.annotateSub === 'text') {
        // tap a note pin to delete it, tap empty space to add a note
        for (var i = 0; i < state.annotations.length; i++) {
          var an = state.annotations[i];
          if (pinHit(an.x, an.y)) {
            state.annotations.splice(i, 1);
            pushUndo({ type: 'delete-annotation', item: an, index: i });
            showHomeToast('تم حذف الملاحظة: ' + an.text);
            saveMarkups();
            render();
            return;
          }
        }
        state.pendingNote = { x: wx, y: wy };
        document.getElementById('noteInput').value = '';
        noteSheetEl.classList.add('open');
        setTimeout(function () { document.getElementById('noteInput').focus(); }, 250);
        return;
      }
      if (state.annotateSub === 'recording') {
        startRecordingAt(wx, wy);
        return;
      }
      if (state.annotateSub === 'image') {
        openImagePickerAt(wx, wy);
        return;
      }
      // sketch / arrow / revcloud are drag-based — taps do nothing
      return;
    }
    // --- edit: tap an entity to select it ---
    if (state.tool === 'edit') {
      var bestE = nearestEntity(wx, wy);
      if (bestE) {
        state.selected = bestE;
        showEditBar();
        showInfo(describeEntity(bestE));
      } else {
        state.selected = null;
        hideEditBar();
        infoBar.classList.add('hidden');
      }
      render();
      return;
    }
    // --- draw: taps do nothing (drawing is by dragging) ---
    if (state.tool === 'draw') return;
    // --- view mode: tap an entity to see its info ---
    var best = nearestEntity(wx, wy);
    if (best) {
      state.selected = best;
      showInfo(describeEntity(best));
    } else {
      state.selected = null;
      infoBar.classList.add('hidden');
    }
  }

  function nearestEntity(wx, wy) {
    if (!state.doc) return null;
    var tol = 12 / state.scale;
    var best = null, bestD = Infinity;
    state.doc.entities.forEach(function (g) {
      if (state.hiddenLayers[g.layer] || g._deleted) return;
      var d = distToEntity(g, wx, wy);
      if (d < bestD) { bestD = d; best = g; }
    });
    return (best && bestD <= tol) ? best : null;
  }

  // ---------- pointer: pan / pinch / tap / draw / arrow / revcloud ----------
  var pointers = new Map();
  var pinchStart = 0, pinchScale = 1;
  var downPos = null, downTime = 0, moved = 0;

  function isSketching() {
    return state.tool === 'draw' || (state.tool === 'annotate' && state.annotateSub === 'sketch');
  }

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      downPos = { x: e.clientX, y: e.clientY };
      downTime = Date.now();
      moved = 0;
      var r = canvas.getBoundingClientRect();
      var wx = s2wx(e.clientX - r.left), wy = s2wy(e.clientY - r.top);
      if (isSketching()) {
        // freehand: a drag draws, panning is off in this mode
        state.currentStroke = { color: state.drawColor, pts: [[wx, wy]] };
      } else if (state.tool === 'annotate' && state.annotateSub === 'arrow') {
        state.pendingArrow = { a: [wx, wy], b: [wx, wy] };
      } else if (state.tool === 'annotate' && state.annotateSub === 'revcloud') {
        state.pendingBox = { x0: wx, y0: wy, x1: wx, y1: wy };
      } else if (state.tool === 'edit' && state.editMoveArmed && state.selected) {
        state.editDrag = { g: state.selected, lastX: wx, lastY: wy, dx: 0, dy: 0 };
      }
    } else if (pointers.size === 2) {
      // pinch zoom cancels any in-progress stroke, arrow, cloud or move
      state.currentStroke = null;
      state.pendingArrow = null;
      state.pendingBox = null;
      state.editDrag = null;
      var pts = Array.from(pointers.values());
      pinchStart = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchScale = state.scale;
    }
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    var prev = pointers.get(e.pointerId);
    var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      moved += Math.abs(dx) + Math.abs(dy);
      if (state.currentStroke) {
        var r = canvas.getBoundingClientRect();
        var wx = s2wx(e.clientX - r.left), wy = s2wy(e.clientY - r.top);
        var pts = state.currentStroke.pts;
        var last = pts[pts.length - 1];
        if (Math.hypot(wx - last[0], wy - last[1]) > 0.5 / state.scale) pts.push([wx, wy]);
        requestRender();
      } else if (state.pendingArrow) {
        var ra = canvas.getBoundingClientRect();
        state.pendingArrow.b = [s2wx(e.clientX - ra.left), s2wy(e.clientY - ra.top)];
        requestRender();
      } else if (state.pendingBox) {
        var rb = canvas.getBoundingClientRect();
        state.pendingBox.x1 = s2wx(e.clientX - rb.left);
        state.pendingBox.y1 = s2wy(e.clientY - rb.top);
        requestRender();
      } else if (state.editDrag) {
        var r2 = canvas.getBoundingClientRect();
        var wx2 = s2wx(e.clientX - r2.left), wy2 = s2wy(e.clientY - r2.top);
        var ddx = wx2 - state.editDrag.lastX, ddy = wy2 - state.editDrag.lastY;
        translateEntity(state.editDrag.g, ddx, ddy);
        state.editDrag.dx += ddx;
        state.editDrag.dy += ddy;
        state.editDrag.lastX = wx2;
        state.editDrag.lastY = wy2;
        requestRender();
      } else {
        state.ox += dx;
        state.oy += dy;
        requestRender();
      }
    } else if (pointers.size === 2) {
      var pts2 = Array.from(pointers.values());
      var dist = Math.hypot(pts2[0].x - pts2[1].x, pts2[0].y - pts2[1].y);
      if (pinchStart > 0) {
        var r3 = canvas.getBoundingClientRect();
        var cx = (pts2[0].x + pts2[1].x) / 2 - r3.left;
        var cy = (pts2[0].y + pts2[1].y) / 2 - r3.top;
        var ns = pinchScale * dist / pinchStart;
        var wx3 = s2wx(cx), wy3 = s2wy(cy);
        state.scale = Math.max(0.001, ns);
        state.ox = cx - wx3 * state.scale;
        state.oy = cy + wy3 * state.scale;
        requestRender();
      }
    }
  });

  function endPointer(e) {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    if (pointers.size === 0) {
      if (state.currentStroke) {
        var s = state.currentStroke;
        state.currentStroke = null;
        if (s.pts.length >= 2) {
          state.strokes.push(s);
          pushUndo({ type: 'add-stroke', item: s });
          saveMarkups();
        }
        render();
      } else if (state.pendingArrow) {
        var ar = state.pendingArrow;
        state.pendingArrow = null;
        if (Math.hypot(ar.b[0] - ar.a[0], ar.b[1] - ar.a[1]) > 2 / state.scale) {
          state.arrows.push(ar);
          pushUndo({ type: 'add-arrow', item: ar });
          saveMarkups();
        }
        render();
      } else if (state.pendingBox) {
        var bx = state.pendingBox;
        state.pendingBox = null;
        var bw = Math.abs(bx.x1 - bx.x0), bh = Math.abs(bx.y1 - bx.y0);
        if (bw > 2 / state.scale && bh > 2 / state.scale) {
          var cloud = { box: [Math.min(bx.x0, bx.x1), Math.min(bx.y0, bx.y1), Math.max(bx.x0, bx.x1), Math.max(bx.y0, bx.y1)] };
          state.revclouds.push(cloud);
          pushUndo({ type: 'add-revcloud', item: cloud });
          saveMarkups();
        }
        render();
      } else if (state.editDrag) {
        var d = state.editDrag;
        state.editDrag = null;
        if (Math.abs(d.dx) > 1e-9 || Math.abs(d.dy) > 1e-9) {
          pushUndo({ type: 'move-entity', g: d.g, dx: d.dx, dy: d.dy });
        }
        state.editMoveArmed = false;
        updateEditBar();
        render();
      } else if (downPos && Date.now() - downTime < 400 && moved < 12) {
        var r = canvas.getBoundingClientRect();
        handleTap(s2wx(e.clientX - r.left), s2wy(e.clientY - r.top));
      }
    }
    if (pointers.size < 2) pinchStart = 0;
    downPos = null;
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect();
    var cx = e.clientX - r.left, cy = e.clientY - r.top;
    var wx = s2wx(cx), wy = s2wy(cy);
    var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.scale = Math.max(0.001, state.scale * factor);
    state.ox = cx - wx * state.scale;
    state.oy = cy + wy * state.scale;
    requestRender();
  }, { passive: false });

  // ---------- toolbar ----------
  function showInfo(msg) {
    infoBar.textContent = msg;
    infoBar.classList.remove('hidden');
    clearTimeout(showInfo._t);
    showInfo._t = setTimeout(function () { infoBar.classList.add('hidden'); }, 4000);
  }

  document.getElementById('btnOpenHome').addEventListener('click', openFilePicker);
  document.getElementById('btnDemoHome').addEventListener('click', loadDemo);
  document.getElementById('btnFab').addEventListener('click', openFilePicker);
  document.getElementById('btnSearch').addEventListener('click', function () {
    if (searchSheetEl.classList.contains('open')) closeSearchSheet();
    else openSearchSheet();
  });
  document.getElementById('btnCloseSearch').addEventListener('click', closeSearchSheet);
  document.getElementById('btnCloseInfo').addEventListener('click', closeInfoSheet);
  searchInputViewerEl.addEventListener('input', function () { runSearch(searchInputViewerEl.value); });
  document.getElementById('btnClearSearchViewer').addEventListener('click', function () {
    searchInputViewerEl.value = '';
    runSearch('');
    searchInputViewerEl.focus();
  });
  document.getElementById('btnFit').addEventListener('click', fitView);
  document.getElementById('btnZoomIn').addEventListener('click', function () {
    var r = canvas.parentElement.getBoundingClientRect();
    var cx = r.width / 2, cy = r.height / 2;
    var wx = s2wx(cx), wy = s2wy(cy);
    state.scale *= 1.25;
    state.ox = cx - wx * state.scale;
    state.oy = cy + wy * state.scale;
    render();
  });
  document.getElementById('btnZoomOut').addEventListener('click', function () {
    var r = canvas.parentElement.getBoundingClientRect();
    var cx = r.width / 2, cy = r.height / 2;
    var wx = s2wx(cx), wy = s2wy(cy);
    state.scale /= 1.25;
    state.ox = cx - wx * state.scale;
    state.oy = cy + wy * state.scale;
    render();
  });
  document.getElementById('btnLayers').addEventListener('click', function () {
    if (!state.doc) { showInfo('افتح ملف الأول عشان تشوف الطبقات'); return; }
    layersSheet.classList.toggle('open');
  });
  document.getElementById('btnCloseLayers').addEventListener('click', function () {
    layersSheet.classList.remove('open');
  });
  document.getElementById('btnMeasure').addEventListener('click', function () {
    if (!state.doc) { showInfo('افتح ملف الأول عشان تقيس'); return; }
    setTool('measure');
  });
  document.getElementById('btnClearMeasure').addEventListener('click', function () {
    state.measurePts = [];
    state.measureTotal = 0;
    measureLabel.textContent = 'دوس على أول نقطة';
    render();
  });

  // ---------- professional toolbar: tools, undo/redo, edit, notes, draw ----------
  var noteSheetEl = document.getElementById('noteSheet');
  var editBarEl = document.getElementById('editBar');

  function translateEntity(g, dx, dy) {
    if (!g) return;
    delete g._box; // bounds change with the move — recomputed on next use
    if (g.type === 'line') { g.x1 += dx; g.y1 += dy; g.x2 += dx; g.y2 += dy; }
    else if (g.type === 'polyline') { (g.points || []).forEach(function (p) { p[0] += dx; p[1] += dy; }); }
    else if (g.type === 'circle') { g.cx += dx; g.cy += dy; }
    else if (g.type === 'text' || g.type === 'point') { g.x += dx; g.y += dy; }
    else if (g.type === 'group') { (g.items || []).forEach(function (it) { translateEntity(it, dx, dy); }); }
  }

  function removeFrom(arr, item) {
    var i = arr.indexOf(item);
    if (i !== -1) arr.splice(i, 1);
  }

  function updateUndoButtons() {
    document.getElementById('btnUndo').disabled = !state.undoStack.length;
    document.getElementById('btnRedo').disabled = !state.redoStack.length;
  }
  function pushUndo(action) {
    state.undoStack.push(action);
    state.redoStack = [];
    updateUndoButtons();
  }
  function applyAction(a, isUndo) {
    if (a.type === 'add-annotation') {
      if (isUndo) removeFrom(state.annotations, a.item); else state.annotations.push(a.item);
      saveMarkups();
    } else if (a.type === 'delete-annotation') {
      if (isUndo) state.annotations.splice(a.index, 0, a.item); else removeFrom(state.annotations, a.item);
      saveMarkups();
    } else if (a.type === 'add-stroke') {
      if (isUndo) removeFrom(state.strokes, a.item); else state.strokes.push(a.item);
      saveMarkups();
    } else if (a.type === 'clear-strokes') {
      if (isUndo) state.strokes = a.items.slice(); else state.strokes = [];
      saveMarkups();
    } else if (a.type === 'add-dimension') {
      if (isUndo) removeFrom(state.dimensions, a.item); else state.dimensions.push(a.item);
      saveMarkups();
    } else if (a.type === 'add-arrow') {
      if (isUndo) removeFrom(state.arrows, a.item); else state.arrows.push(a.item);
      saveMarkups();
    } else if (a.type === 'add-revcloud') {
      if (isUndo) removeFrom(state.revclouds, a.item); else state.revclouds.push(a.item);
      saveMarkups();
    } else if (a.type === 'add-recording') {
      if (isUndo) removeFrom(state.recordings, a.item); else state.recordings.push(a.item);
      saveMarkups();
    } else if (a.type === 'delete-recording') {
      if (isUndo) state.recordings.splice(a.index, 0, a.item); else removeFrom(state.recordings, a.item);
      saveMarkups();
    } else if (a.type === 'add-image') {
      if (isUndo) removeFrom(state.images, a.item); else state.images.push(a.item);
      saveMarkups();
    } else if (a.type === 'delete-image') {
      if (isUndo) state.images.splice(a.index, 0, a.item); else removeFrom(state.images, a.item);
      saveMarkups();
    } else if (a.type === 'delete-entity') {
      a.g._deleted = !isUndo;
    } else if (a.type === 'move-entity') {
      translateEntity(a.g, isUndo ? -a.dx : a.dx, isUndo ? -a.dy : a.dy);
    }
  }
  function doUndo() {
    var a = state.undoStack.pop();
    if (!a) return;
    applyAction(a, true);
    state.redoStack.push(a);
    updateUndoButtons();
    render();
  }
  function doRedo() {
    var a = state.redoStack.pop();
    if (!a) return;
    applyAction(a, false);
    state.undoStack.push(a);
    updateUndoButtons();
    render();
  }
  document.getElementById('btnUndo').addEventListener('click', doUndo);
  document.getElementById('btnRedo').addEventListener('click', doRedo);

  function showEditBar() {
    editBarEl.classList.remove('hidden');
    updateEditBar();
  }
  function hideEditBar() {
    editBarEl.classList.add('hidden');
    state.editMoveArmed = false;
  }
  function updateEditBar() {
    document.getElementById('btnEditMove').classList.toggle('active', state.editMoveArmed);
  }
  document.getElementById('btnEditMove').addEventListener('click', function () {
    state.editMoveArmed = !state.editMoveArmed;
    updateEditBar();
    showHomeToast(state.editMoveArmed ? 'اسحب العنصر لنقله' : 'تم إلغاء النقل');
  });
  document.getElementById('btnEditDelete').addEventListener('click', function () {
    if (!state.selected) return;
    var g = state.selected;
    g._deleted = true;
    pushUndo({ type: 'delete-entity', g: g });
    state.selected = null;
    hideEditBar();
    showHomeToast('تم حذف العنصر');
    render();
  });
  document.getElementById('btnEditCancel').addEventListener('click', function () {
    state.selected = null;
    hideEditBar();
    render();
  });

  function closeNoteSheet() {
    noteSheetEl.classList.remove('open');
    state.pendingNote = null;
  }
  document.getElementById('btnCloseNote').addEventListener('click', closeNoteSheet);
  document.getElementById('btnSaveNote').addEventListener('click', function () {
    var text = document.getElementById('noteInput').value.trim();
    if (!text) { showHomeToast('اكتب الملاحظة الأول'); return; }
    if (!state.pendingNote) { closeNoteSheet(); return; }
    var ann = { x: state.pendingNote.x, y: state.pendingNote.y, text: text };
    state.annotations.push(ann);
    pushUndo({ type: 'add-annotation', item: ann });
    saveMarkups();
    closeNoteSheet();
    render();
  });

  document.querySelectorAll('#drawPalette .color-dot').forEach(function (b) {
    b.addEventListener('click', function () {
      state.drawColor = b.getAttribute('data-color');
      document.querySelectorAll('#drawPalette .color-dot').forEach(function (x) {
        x.classList.toggle('selected', x === b);
      });
    });
  });
  document.getElementById('btnClearStrokes').addEventListener('click', function () {
    if (!state.strokes.length) return;
    var old = state.strokes.slice();
    state.strokes = [];
    pushUndo({ type: 'clear-strokes', items: old });
    saveMarkups();
    render();
  });

  // ---------- voice notes (recording sub-tool) ----------
  var recordBarEl = document.getElementById('recordBar');
  var recordPlayBarEl = document.getElementById('recordPlayBar');

  // Call a native plugin. First try Capacitor's low-level nativePromise
  // directly: it routes by plugin name and does NOT depend on PluginHeaders
  // (which may not list a manually registered plugin). If that is
  // unavailable, fall back to the registerPlugin proxy.
  function callNativePlugin(plugin, method, options) {
    var cap = window.Capacitor;
    if (cap && typeof cap.nativePromise === 'function') {
      return cap.nativePromise(plugin, method, options || {});
    }
    if (cap && cap.registerPlugin) {
      var P = cap.registerPlugin(plugin);
      if (P && typeof P[method] === 'function') return P[method](options || {});
    }
    return Promise.reject(new Error('no native plugin'));
  }
  function callRecorder(method, options) { return callNativePlugin('VoiceRecorder', method, options); }

  function startRecordingAt(wx, wy) {
    if (state.recording) { stopRecording(); return; }
    // try the native recorder first; if it is not available, the call
    // rejects and startNativeRecording falls back to the WebView mic
    startNativeRecording(wx, wy);
  }

  function startNativeRecording(wx, wy) {
    callRecorder('hasPermission').then(function (res) {
      if (res && res.granted) return true;
      return callRecorder('requestPermission').then(function (r2) { return !!(r2 && r2.granted); });
    }).then(function (granted) {
      if (!granted) {
        showHomeToast('التسجيل محتاج إذن الميكروفون');
        state.pendingAudioPoint = { x: wx, y: wy };
        document.getElementById('audioInput').click();
        return;
      }
      return callRecorder('startRecording').then(function () {
        var rec = { native: true, point: [wx, wy], startTime: Date.now(), secs: 0, timer: null };
        state.recording = rec;
        showRecordBar(rec);
      });
    }).catch(function () {
      // native path failed — fall back to the WebView mic
      startWebRecording(wx, wy);
    });
  }
  function showRecordBar(rec) {
    recordBarEl.classList.remove('hidden');
    document.getElementById('recordTimer').textContent = '0:00';
    rec.timer = setInterval(function () {
      rec.secs = Math.floor((Date.now() - rec.startTime) / 1000);
      document.getElementById('recordTimer').textContent =
        Math.floor(rec.secs / 60) + ':' + ('0' + (rec.secs % 60)).slice(-2);
      if (rec.secs >= 60) stopRecording(); // cap: 60 seconds per note
    }, 500);
  }

  function startWebRecording(wx, wy) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showHomeToast('التسجيل الصوتي مش متاح على الجهاز ده');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mr;
      try { mr = new MediaRecorder(stream); } catch (e) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        showHomeToast('التسجيل الصوتي مش متاح على الجهاز ده');
        return;
      }
      var rec = { recorder: mr, point: [wx, wy], startTime: Date.now(), secs: 0, timer: null };
      var chunks = [];
      mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
      mr.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        var blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        var reader = new FileReader();
        reader.onload = function () {
          var item = { x: rec.point[0], y: rec.point[1], audio: reader.result, dur: rec.secs };
          state.recordings.push(item);
          pushUndo({ type: 'add-recording', item: item });
          saveMarkups();
          render();
        };
        reader.readAsDataURL(blob);
      };
      state.recording = rec;
      mr.start();
      showRecordBar(rec);
    }).catch(function (err) {
      // Show the real error so the next report names it, then fall back to
      // attaching an existing recording (e.g. from the phone's voice
      // recorder) at the same point.
      var name = (err && err.name) ? err.name : 'خطأ';
      showHomeToast('الميكروفون مش شغال (' + name + ') — اختار تسجيل جاهز من موبايلك');
      state.pendingAudioPoint = { x: wx, y: wy };
      document.getElementById('audioInput').click();
    });
  }
  // Attach an existing audio file (fallback when the mic path fails, or
  // when the user recorded the note in the phone's voice recorder app).
  document.getElementById('audioInput').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f || !state.pendingAudioPoint) return;
    var point = state.pendingAudioPoint;
    var reader = new FileReader();
    reader.onload = function () {
      var item = { x: point.x, y: point.y, audio: reader.result, dur: 0 };
      // best effort: read the clip length for the pin label
      try {
        var probe = new Audio(reader.result);
        probe.addEventListener('loadedmetadata', function () {
          item.dur = Math.round(probe.duration || 0);
          render();
        });
      } catch (e) { /* ignore */ }
      state.recordings.push(item);
      pushUndo({ type: 'add-recording', item: item });
      saveMarkups();
      state.pendingAudioPoint = null;
      showHomeToast('تم إرفاق التسجيل الصوتي');
      render();
    };
    reader.readAsDataURL(f);
  });

  function stopRecording() {
    if (!state.recording) return;
    var rec = state.recording;
    clearInterval(rec.timer);
    recordBarEl.classList.add('hidden');
    state.recording = null;
    if (rec.native) {
      callRecorder('stopRecording').then(function (res) {
        var item = {
          x: rec.point[0], y: rec.point[1],
          audio: 'data:' + (res.mimeType || 'audio/mp4') + ';base64,' + res.recordDataBase64,
          dur: Math.round((res.msDuration || 0) / 1000)
        };
        state.recordings.push(item);
        pushUndo({ type: 'add-recording', item: item });
        saveMarkups();
        render();
      }).catch(function () {
        showHomeToast('التسجيل كان قصير أوي — جرّب تاني');
      });
      return;
    }
    try { if (rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch (e) { /* ignore */ }
  }
  document.getElementById('btnStopRecord').addEventListener('click', stopRecording);

  function togglePlayback(item) {
    if (state.playingRecording && state.playingRecording.item === item) { stopPlayback(); return; }
    stopPlayback();
    var audio = new Audio(item.audio);
    audio.onended = function () { stopPlayback(); };
    audio.play().catch(function () { showHomeToast('مش قادر أشغّل التسجيل'); });
    state.playingRecording = { item: item, audio: audio };
    recordPlayBarEl.classList.remove('hidden');
  }
  function stopPlayback() {
    if (state.playingRecording) {
      try { state.playingRecording.audio.pause(); } catch (e) { /* ignore */ }
      state.playingRecording = null;
    }
    recordPlayBarEl.classList.add('hidden');
  }
  document.getElementById('btnStopPlayback').addEventListener('click', stopPlayback);
  document.getElementById('btnDeleteRecording').addEventListener('click', function () {
    if (!state.playingRecording) return;
    var item = state.playingRecording.item;
    var idx = state.recordings.indexOf(item);
    stopPlayback();
    if (idx !== -1) {
      state.recordings.splice(idx, 1);
      pushUndo({ type: 'delete-recording', item: item, index: idx });
      saveMarkups();
      showHomeToast('تم حذف التسجيل');
      render();
    }
  });

  // ---------- attached photos (image sub-tool) ----------
  var imageViewerEl = document.getElementById('imageViewer');
  var imageViewerImgEl = document.getElementById('imageViewerImg');

  function openImagePickerAt(wx, wy) {
    state.pendingImagePoint = { x: wx, y: wy };
    document.getElementById('imageInput').click();
  }
  document.getElementById('imageInput').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f || !state.pendingImagePoint) return;
    var point = state.pendingImagePoint;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        // downscale so the stored note stays small (max 480px, JPEG 0.75)
        var max = 480, sc = Math.min(1, max / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * sc));
        cv.height = Math.max(1, Math.round(img.height * sc));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        var item = { x: point.x, y: point.y, data: cv.toDataURL('image/jpeg', 0.75) };
        state.images.push(item);
        pushUndo({ type: 'add-image', item: item });
        saveMarkups();
        state.pendingImagePoint = null;
        render();
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  });
  function openImageViewer(item) {
    state.currentImage = item;
    imageViewerImgEl.src = item.data;
    imageViewerEl.classList.remove('hidden');
  }
  function closeImageViewer() {
    imageViewerEl.classList.add('hidden');
    state.currentImage = null;
  }
  document.getElementById('btnCloseImage').addEventListener('click', closeImageViewer);
  document.getElementById('btnDeleteImage').addEventListener('click', function () {
    if (!state.currentImage) return;
    var item = state.currentImage;
    var idx = state.images.indexOf(item);
    closeImageViewer();
    if (idx !== -1) {
      state.images.splice(idx, 1);
      pushUndo({ type: 'delete-image', item: item, index: idx });
      saveMarkups();
      showHomeToast('تم حذف الصورة');
      render();
    }
  });

  // --- measurement unit (the drawing's base unit; distances display in meters) ---
  function setMeasureUnit(u) {
    settings.measureUnit = u;
    saveSettings();
    document.querySelectorAll('#unitPicker .unit-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-unit') === u);
    });
    if (state.measurePts.length >= 2) {
      measureLabel.textContent = 'المسافة: ' + fmtDist(state.measureTotal) + ' — دوس تاني عشان تكمّل';
    } else if (state.dimensions.length > 0) {
      measureLabel.textContent = 'البُعد: ' + fmtDist(state.dimensions[state.dimensions.length - 1].dist);
    }
    render();
  }
  document.querySelectorAll('#unitPicker .unit-btn').forEach(function (b) {
    b.addEventListener('click', function () { setMeasureUnit(b.getAttribute('data-unit')); });
  });
  // mark the saved unit as active on load
  document.querySelectorAll('#unitPicker .unit-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-unit') === settings.measureUnit);
  });

  function setTool(t) {
    if (t === state.tool) t = null;
    // clear the previous tool's transient state
    state.measureMode = false;
    state.measurePts = [];
    state.measureTotal = 0;
    measureLabel.textContent = '';
    state.dimPending = null;
    state.currentStroke = null;
    state.pendingArrow = null;
    state.pendingBox = null;
    state.editMoveArmed = false;
    state.editDrag = null;
    if (state.tool === 'edit') { state.selected = null; hideEditBar(); }
    closeNoteSheet();
    if (state.recording) stopRecording();
    state.tool = t;
    if (t === 'measure') {
      state.measureMode = true;
      measureLabel.textContent = 'دوس على أول نقطة';
    }
    if (t === 'annotate') {
      document.getElementById('annotateBar').classList.remove('hidden');
      setAnnotateSub(state.annotateSub || 'text');
    } else {
      document.getElementById('annotateBar').classList.add('hidden');
    }
    // unit picker shows only while measuring or dimensioning
    document.getElementById('unitPicker').classList.toggle('hidden', !(t === 'measure' || t === 'dimension'));
    document.getElementById('btnAnnotate').classList.toggle('active', t === 'annotate');
    document.getElementById('btnDraw').classList.toggle('active', t === 'draw');
    document.getElementById('btnEdit').classList.toggle('active', t === 'edit');
    document.getElementById('btnMeasure').classList.toggle('active', t === 'measure');
    document.getElementById('btnDimension').classList.toggle('active', t === 'dimension');
    updateDrawPalette();
    document.getElementById('btnClearMeasure').classList.toggle('hidden', t !== 'measure');
    render();
  }

  // The draw color palette shows for the Draw tool and for the Sketch
  // sub-tool inside Annotation (where it floats above the annotate bar).
  function updateDrawPalette() {
    var show = state.tool === 'draw' ||
      (state.tool === 'annotate' && state.annotateSub === 'sketch');
    var pal = document.getElementById('drawPalette');
    pal.classList.toggle('hidden', !show);
    pal.classList.toggle('above-annotate', state.tool === 'annotate' && state.annotateSub === 'sketch');
  }

  var ANNOTATE_HINTS = {
    sketch: 'ارسم بإصبعك على الرسمة',
    arrow: 'اسحب من نقطة لنقطة عشان ترسم سهم',
    text: 'دوس على مكان الملاحظة',
    revcloud: 'اسحب مستطيل حوالين المنطقة اللي عايز تعلّم عليها',
    recording: 'دوس على مكان التسجيل الصوتي — ودوس على الدبوس الأحمر عشان تسمعه',
    image: 'دوس على مكان الصورة — ودوس على الصورة عشان تكبّرها'
  };
  function setAnnotateSub(sub) {
    state.annotateSub = sub;
    document.querySelectorAll('#annotateBar .sub-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-sub') === sub);
    });
    measureLabel.textContent = ANNOTATE_HINTS[sub] || '';
    updateDrawPalette();
    render();
  }
  document.querySelectorAll('#annotateBar .sub-btn').forEach(function (b) {
    b.addEventListener('click', function () { setAnnotateSub(b.getAttribute('data-sub')); });
  });
  document.getElementById('btnAnnotate').addEventListener('click', function () {
    if (!state.doc) { showInfo('افتح ملف الأول عشان تضيف ملاحظة'); return; }
    setTool('annotate');
  });
  document.getElementById('btnDraw').addEventListener('click', function () {
    if (!state.doc) { showInfo('افتح ملف الأول عشان ترسم'); return; }
    setTool('draw');
  });
  document.getElementById('btnEdit').addEventListener('click', function () {
    if (!state.doc) { showInfo('افتح ملف الأول عشان تعدّل'); return; }
    setTool('edit');
  });
  document.getElementById('btnDimension').addEventListener('click', function () {
    if (!state.doc) { showInfo('افتح ملف الأول عشان تقيس بُعد'); return; }
    setTool('dimension');
  });

  // ---------- settings UI ----------
  function applySettingsUI() {
    document.querySelectorAll('#bgChoices .bg-choice').forEach(function (b) {
      b.classList.toggle('selected', b.getAttribute('data-bg') === settings.bg);
    });
    document.getElementById('optLineweight').checked = settings.lineweight;
    document.getElementById('optFastRender').checked = settings.fastRender;
    document.getElementById('optFitAll').checked = settings.fitAll;
    document.getElementById('versionLabel').textContent = 'الإصدار الحالي: ' + APP_VERSION.version;
  }
  document.querySelectorAll('#bgChoices .bg-choice').forEach(function (b) {
    b.addEventListener('click', function () {
      settings.bg = b.getAttribute('data-bg');
      saveSettings();
      applySettingsUI();
      if (state.doc) buildLayersPanel();
      render();
    });
  });
  document.getElementById('optLineweight').addEventListener('change', function (ev) {
    settings.lineweight = ev.target.checked;
    saveSettings();
    render();
  });
  document.getElementById('optFastRender').addEventListener('change', function (ev) {
    settings.fastRender = ev.target.checked;
    saveSettings();
    render();
  });
  document.getElementById('optFitAll').addEventListener('change', function (ev) {
    settings.fitAll = ev.target.checked;
    saveSettings();
    if (state.doc) fitView();
  });
  document.getElementById('btnTheme').addEventListener('click', function () {
    settings.bg = settings.bg === 'black' ? 'white' : settings.bg === 'white' ? 'beige' : 'black';
    saveSettings();
    applySettingsUI();
    if (state.doc) buildLayersPanel();
    render();
  });

  // ---------- in-app updates ----------
  // The app checks GitHub Releases for a newer version and offers a one-tap
  // download from inside the app. The repo must be public for the check to
  // work without a login. Keep APP_VERSION in sync with www/version.json.
  var APP_VERSION = { version: '1.7.1', code: 27 };
  var UPDATE_API = 'https://api.github.com/repos/simocelo99-prog/sc-fast-view/releases/latest';
  var pendingUpdateUrl = '';

  function parseReleaseCode(tag) {
    if (!tag) return 0;
    var m = String(tag).match(/v?(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
  function checkForUpdates(manual) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    fetch(UPDATE_API, { signal: controller.signal, headers: { 'Accept': 'application/vnd.github+json' } })
      .then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('no release');
        return res.json();
      })
      .then(function (rel) {
        var code = parseReleaseCode(rel.tag_name);
        if (code > APP_VERSION.code) {
          var apk = null;
          (rel.assets || []).forEach(function (a) {
            if (/\.apk$/i.test(a.name)) apk = a;
          });
          pendingUpdateUrl = apk ? apk.browser_download_url : rel.html_url;
          // إشعار صغير فقط (سناكبار) — من غير بانر كبير ومن غير توست تاني
          document.getElementById('updateText').textContent =
            'تحديث جديد ' + (rel.tag_name || '') + ' متاح';
          document.getElementById('updateBanner').classList.remove('hidden');
        } else if (manual) {
          showHomeToast('إنت على أحدث إصدار ✓ (' + APP_VERSION.version + ')');
        }
      })
      .catch(function () {
        if (manual) showHomeToast('تعذّر التحقق من التحديثات — اتأكد من النت وحاول تاني');
      });
  }
  document.getElementById('btnUpdate').addEventListener('click', function () {
    if (pendingUpdateUrl) window.open(pendingUpdateUrl, '_blank');
  });
  document.getElementById('btnDismissUpdate').addEventListener('click', function () {
    document.getElementById('updateBanner').classList.add('hidden');
  });
  document.getElementById('btnCheckUpdate').addEventListener('click', function () {
    checkForUpdates(true);
  });

  // ---------- init ----------
  applySettingsUI();
  updateUndoButtons();
  openDB().then(function () { loadLibrary(); cacheWasmEngine(); });
  showScreen('home');
  checkForUpdates(false);
  checkIntentFile(); // open a DWG/DXF shared with the app from another app

  // Debug handle for automated checks (harmless in production).
  window.__scfv = {
    state: state, setTool: setTool, setAnnotateSub: setAnnotateSub, handleTap: handleTap,
    translateEntity: translateEntity, doUndo: doUndo, doRedo: doRedo, pushUndo: pushUndo,
    loadDoc: loadDoc, render: render, saveMarkups: saveMarkups, loadMarkups: loadMarkups,
    togglePlayback: togglePlayback, openImageViewer: openImageViewer,
    startRecordingAt: startRecordingAt, setMeasureUnit: setMeasureUnit,
    checkIntentFile: checkIntentFile, loadDWG: loadDWG, ensureSearchIndex: ensureSearchIndex,
    entityBounds: entityBounds, isTooSmall: isTooSmall, requestRender: requestRender,
    showFileInfo: showFileInfo, closeInfoSheet: closeInfoSheet, buildInfoSheet: buildInfoSheet
  };
})();
