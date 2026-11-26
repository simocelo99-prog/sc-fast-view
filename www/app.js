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
  var settings = { bg: 'black', lineweight: false, fastRender: true, fitAll: false };
  try {
    var saved = JSON.parse(localStorage.getItem('scfv-settings') || '{}');
    if (saved.bg) settings.bg = saved.bg;
    if (typeof saved.lineweight === 'boolean') settings.lineweight = saved.lineweight;
    if (typeof saved.fastRender === 'boolean') settings.fastRender = saved.fastRender;
    if (typeof saved.fitAll === 'boolean') settings.fitAll = saved.fitAll;
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
    screen: 'home',
    tab: 'recent',
    search: '',
    typeFilter: 'all',
    library: []
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

  // ---------- color resolution ----------
  function resolveColor(ent) {
    var c = DXF.aciColor(ent.color, isDarkBg());
    if (c) return c;
    var layer = state.doc && state.doc.layerMap ? state.doc.layerMap[ent.layer] : null;
    if (layer) {
      var lc = DXF.aciColor(layer.color, isDarkBg());
      if (lc) return lc;
    }
    return fgColor();
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
  // into a corner. Two ideas make the fit find the plan:
  //  1. Size filter: drop entities far larger than the typical entity (the
  //     long routes) from the fit computation. They stay in the drawing.
  //  2. Two-stage density grid: a coarse 25x25 grid finds the dense region,
  //     then a finer grid inside it tightens the box, so the box is not stuck
  //     at one coarse cell wide. Counting is per-entity (each entity counts
  //     once per cell it touches).
  function collectFitEntities() {
    var entities = [];
    function ptsFor(g) {
      var pts = [];
      function pt(x, y) { if (isFinite(x) && isFinite(y)) pts.push([x, y]); }
      if (g.type === 'line') { pt(g.x1, g.y1); pt(g.x2, g.y2); }
      else if (g.type === 'polyline') {
        var step = g.points.length > 200 ? Math.ceil(g.points.length / 200) : 1;
        for (var k = 0; k < g.points.length; k += step) pt(g.points[k][0], g.points[k][1]);
      }
      else if (g.type === 'circle') { pt(g.cx - g.r, g.cy - g.r); pt(g.cx + g.r, g.cy + g.r); }
      else if (g.type === 'text' || g.type === 'point') pt(g.x, g.y);
      return pts;
    }
    function walk(g) {
      if (!g) return;
      if (g.type === 'group') { g.items.forEach(walk); return; }
      var pts = ptsFor(g);
      if (pts.length) entities.push(pts);
    }
    state.doc.entities.forEach(walk);
    return entities;
  }
  function entitySize(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) {
      if (p[0] < x0) x0 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[0] > x1) x1 = p[0];
      if (p[1] > y1) y1 = p[1];
    });
    return Math.max(x1 - x0, y1 - y0);
  }
  // Bounding box of the cells holding at least `frac` of the densest cell's
  // entity count, over the given bounds. Returns null when nothing qualifies.
  function denseBox(ents, b, frac) {
    var GX = 25, GY = 25;
    var bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    if (!(bw > 0) || !(bh > 0)) return null;
    var counts = new Array(GX * GY);
    for (var c = 0; c < counts.length; c++) counts[c] = 0;
    var maxC = 0;
    ents.forEach(function (pts) {
      var seen = {};
      pts.forEach(function (p) {
        var cx = Math.min(GX - 1, Math.max(0, Math.floor((p[0] - b.minX) / bw * GX)));
        var cy = Math.min(GY - 1, Math.max(0, Math.floor((p[1] - b.minY) / bh * GY)));
        var idx = cy * GX + cx;
        if (!seen[idx]) {
          seen[idx] = 1;
          counts[idx]++;
          if (counts[idx] > maxC) maxC = counts[idx];
        }
      });
    });
    if (!maxC) return null;
    var threshold = Math.max(2, Math.ceil(maxC * frac));
    var x0 = GX, x1 = -1, y0 = GY, y1 = -1, any = false;
    for (var j = 0; j < GX * GY; j++) {
      if (counts[j] >= threshold) {
        var gx = j % GX, gy = Math.floor(j / GX);
        if (gx < x0) x0 = gx;
        if (gx > x1) x1 = gx;
        if (gy < y0) y0 = gy;
        if (gy > y1) y1 = gy;
        any = true;
      }
    }
    if (!any) return null;
    return {
      minX: b.minX + (x0 / GX) * bw, maxX: b.minX + ((x1 + 1) / GX) * bw,
      minY: b.minY + (y0 / GY) * bh, maxY: b.minY + ((y1 + 1) / GY) * bh
    };
  }
  function fitBounds() {
    var b = state.doc.bounds;
    if (settings.fitAll) return b;
    var ents = collectFitEntities();
    if (ents.length < 5) return b;
    // size filter: keep entities up to 8x the median entity size
    var sizes = ents.map(entitySize).sort(function (a, c) { return a - c; });
    var median = sizes[Math.floor(sizes.length / 2)] || 0;
    var kept = ents;
    if (median > 0) {
      var limit = median * 8;
      kept = ents.filter(function (pts) { return entitySize(pts) <= limit; });
      if (kept.length < 5) kept = ents;
    }
    var box = denseBox(kept, b, 0.05);
    if (!box) return b;
    var refined = denseBox(kept, box, 0.01);
    if (refined) box = refined;
    // 10% padding around the dense region
    var mx = (box.maxX - box.minX) * 0.1, my = (box.maxY - box.minY) * 0.1;
    var rx0 = Math.max(b.minX, box.minX - mx), rx1 = Math.min(b.maxX, box.maxX + mx);
    var ry0 = Math.max(b.minY, box.minY - my), ry1 = Math.min(b.maxY, box.maxY + my);
    if (!(rx1 > rx0) || !(ry1 > ry0)) return b;
    return { minX: rx0, minY: ry0, maxX: rx1, maxY: ry1 };
  }

  // Saved view from the DWG file (*Active VPORT): the framing AutoCAD had
  // when the file was saved — usually the plan filling the screen. Used as
  // the initial view when it is sane; otherwise the density fit takes over.
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

  function fitView() {
    if (!state.doc) return;
    var b = (!settings.fitAll && savedViewBounds()) || fitBounds();
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
    if (g.type === 'line') {
      return !(Math.max(g.x1, g.x2) < x0 || Math.min(g.x1, g.x2) > x1 ||
               Math.max(g.y1, g.y2) < y0 || Math.min(g.y1, g.y2) > y1);
    }
    if (g.type === 'polyline') {
      for (var k = 0; k < g.points.length; k++) {
        if (g.points[k][0] >= x0 && g.points[k][0] <= x1 &&
            g.points[k][1] >= y0 && g.points[k][1] <= y1) return true;
      }
      return false;
    }
    if (g.type === 'circle') {
      return g.cx + g.r >= x0 && g.cx - g.r <= x1 && g.cy + g.r >= y0 && g.cy - g.r <= y1;
    }
    if (g.type === 'text' || g.type === 'point') {
      return g.x >= x0 && g.x <= x1 && g.y >= y0 && g.y <= y1;
    }
    if (g.type === 'group') {
      for (var i = 0; i < g.items.length; i++) {
        if (entityVisible(g.items[i], x0, y0, x1, y1)) return true;
      }
      return false;
    }
    return true;
  }

  // ---------- drawing ----------
  function drawEntity(g) {
    if (!g) return;
    if (g.type === 'group') {
      g.items.forEach(drawEntity);
      return;
    }
    if (state.hiddenLayers[g.layer]) return;
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
      ctx.beginPath();
      g.points.forEach(function (p, k) {
        if (k === 0) ctx.moveTo(w2sx(p[0]), w2sy(p[1]));
        else ctx.lineTo(w2sx(p[0]), w2sy(p[1]));
      });
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
      var label = fmtNum(state.measureTotal) + ' وحدة';
      ctx.font = 'bold ' + Math.round(14 * dpr) + 'px sans-serif';
      var tw = ctx.measureText(label).width;
      var lx = w2sx(last[0]) + 10 * dpr, ly = w2sy(last[1]) - 10 * dpr;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(lx - 4 * dpr, ly - 14 * dpr, tw + 8 * dpr, 20 * dpr);
      ctx.fillStyle = '#FFB020';
      ctx.fillText(label, lx, ly + 2 * dpr);
    }
  }

  function render() {
    var r = canvas.parentElement.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
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
  }

  function fmtNum(n) {
    return (Math.round(n * 100) / 100).toLocaleString('en-US');
  }
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
    state.hiddenLayers = {};
    state.measurePts = [];
    state.measureTotal = 0;
    state.selected = null;
    fileNameEl.textContent = state.fileName + ' — ' + doc.entities.length + ' عنصر';
    buildLayersPanel();
    showScreen('viewer');
    requestAnimationFrame(function () {
      resize();
      fitView();
      if (opts.save !== false) saveToLibrary(name, opts.saveData, opts.size || 0, opts.isDwg);
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
    showHomeToast('جارٍ فتح ملف DWG…');
    DWG.open(arrayBuffer).then(function (doc) {
      loadDoc(doc, name, { save: opts.save, size: opts.size || arrayBuffer.byteLength, saveData: arrayBuffer, isDwg: true });
      if (doc.dwgStats && doc.dwgStats.skipped && Object.keys(doc.dwgStats.skipped).length) {
        showInfo('اتفتح ' + name + ' ✓ — بعض العناصر (أبعاد، تظليل…) مش مدعومة ومتعرضتش');
      }
    }).catch(function (err) {
      showHomeToast('مش قادر أفتح ملف DWG ده — ' + (err && err.message ? err.message : 'ملف تالف أو نسخة غير مدعومة'));
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
      var req = indexedDB.open('scfastview', 2);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'name' });
        // 'wasm' holds the DWG engine (libredwg-web.wasm) once, so a future
        // small APK can load it from here instead of bundling it again.
        if (!db.objectStoreNames.contains('wasm')) db.createObjectStore('wasm', { keyPath: 'name' });
      };
      req.onsuccess = function () { idb = req.result; resolve(true); };
      req.onerror = function () { resolve(false); };
    });
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
  function buildLayersPanel() {
    layersList.innerHTML = '';
    if (!state.doc) return;
    state.doc.layers.forEach(function (layer) {
      var row = document.createElement('label');
      row.className = 'layer-row';
      var dot = DXF.aciColor(layer.color, isDarkBg()) || fgColor();
      row.innerHTML =
        '<span class="layer-dot" style="background:' + dot + '"></span>' +
        '<span class="layer-name">' + escapeHtml(layer.name) + '</span>' +
        '<input type="checkbox" ' + (state.hiddenLayers[layer.name] ? '' : 'checked') + '>';
      row.querySelector('input').addEventListener('change', function (ev) {
        state.hiddenLayers[layer.name] = !ev.target.checked;
        render();
      });
      layersList.appendChild(row);
    });
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
    if (state.measureMode) {
      state.measurePts.push([wx, wy]);
      if (state.measurePts.length >= 2) {
        var a = state.measurePts[state.measurePts.length - 2];
        var b = state.measurePts[state.measurePts.length - 1];
        state.measureTotal += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      measureLabel.textContent = state.measurePts.length < 2
        ? 'دوس على نقطة تانية'
        : 'المسافة: ' + fmtNum(state.measureTotal) + ' وحدة — دوس تاني عشان تكمّل';
      render();
      return;
    }
    if (!state.doc) return;
    var tol = 12 / state.scale;
    var best = null, bestD = Infinity;
    state.doc.entities.forEach(function (g) {
      if (state.hiddenLayers[g.layer]) return;
      var d = distToEntity(g, wx, wy);
      if (d < bestD) { bestD = d; best = g; }
    });
    if (best && bestD <= tol) {
      state.selected = best;
      showInfo(describeEntity(best));
    } else {
      state.selected = null;
      infoBar.classList.add('hidden');
    }
  }

  // ---------- pointer: pan / pinch / tap ----------
  var pointers = new Map();
  var pinchStart = 0, pinchScale = 1;
  var downPos = null, downTime = 0, moved = 0;

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      downPos = { x: e.clientX, y: e.clientY };
      downTime = Date.now();
      moved = 0;
    } else if (pointers.size === 2) {
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
      state.ox += dx;
      state.oy += dy;
      render();
    } else if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (pinchStart > 0) {
        var r = canvas.getBoundingClientRect();
        var cx = (pts[0].x + pts[1].x) / 2 - r.left;
        var cy = (pts[0].y + pts[1].y) / 2 - r.top;
        var ns = pinchScale * dist / pinchStart;
        var wx = s2wx(cx), wy = s2wy(cy);
        state.scale = Math.max(0.001, ns);
        state.ox = cx - wx * state.scale;
        state.oy = cy + wy * state.scale;
        render();
      }
    }
  });

  function endPointer(e) {
    if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
    if (pointers.size === 0 && downPos && Date.now() - downTime < 400 && moved < 12) {
      var r = canvas.getBoundingClientRect();
      handleTap(s2wx(e.clientX - r.left), s2wy(e.clientY - r.top));
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
    render();
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
  document.getElementById('btnDemo2').addEventListener('click', loadDemo);
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
    state.measureMode = !state.measureMode;
    state.measurePts = [];
    state.measureTotal = 0;
    document.getElementById('btnMeasure').classList.toggle('active', state.measureMode);
    measureLabel.textContent = state.measureMode ? 'دوس على أول نقطة' : '';
    document.getElementById('btnClearMeasure').classList.toggle('hidden', !state.measureMode);
    render();
  });
  document.getElementById('btnClearMeasure').addEventListener('click', function () {
    state.measurePts = [];
    state.measureTotal = 0;
    measureLabel.textContent = 'دوس على أول نقطة';
    render();
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
  var APP_VERSION = { version: '1.4.2', code: 11 };
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
  openDB().then(function () { loadLibrary(); cacheWasmEngine(); });
  showScreen('home');
  checkForUpdates(false);
})();
