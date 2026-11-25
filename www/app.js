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
  var settings = { bg: 'black', lineweight: false, fastRender: true };
  try {
    var saved = JSON.parse(localStorage.getItem('scfv-settings') || '{}');
    if (saved.bg) settings.bg = saved.bg;
    if (typeof saved.lineweight === 'boolean') settings.lineweight = saved.lineweight;
    if (typeof saved.fastRender === 'boolean') settings.fastRender = saved.fastRender;
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

  // home toast (created dynamically)
  var homeToast = document.createElement('div');
  homeToast.className = 'info-bar';
  homeToast.style.cssText = 'position:fixed;bottom:90px;right:12px;left:12px;z-index:30;display:none;';
  document.getElementById('screenHome').appendChild(homeToast);
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
  function s2wx(px) { return (px / dpr - state.ox) / state.scale; }
  function s2wy(py) { return -(py / dpr - state.oy) / state.scale; }

  function fitView() {
    if (!state.doc) return;
    var b = state.doc.bounds;
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
  function loadDXF(text, name, opts) {
    opts = opts || {};
    try {
      var doc = DXF.parse(text);
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
        if (opts.save !== false) saveToLibrary(name, text, opts.size || text.length);
      });
      showInfo('اتفتح ' + state.fileName + ' ✓');
    } catch (err) {
      showHomeToast('الملف ده مش DXF صحيح — جرّب ملف تاني');
    }
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
    if (/\.dwg$/i.test(f.name)) {
      showHomeToast('ملف DWG لازم يتحول DXF الأول — من أوتوكاد: Save As ← DXF، وبعدها افتحه هنا');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () { loadDXF(String(reader.result), f.name, { size: f.size }); };
    reader.readAsText(f);
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
      var req = indexedDB.open('scfastview', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('files', { keyPath: 'name' }); };
      req.onsuccess = function () { idb = req.result; resolve(true); };
      req.onerror = function () { resolve(false); };
    });
  }
  function saveToLibrary(name, text, size) {
    if (!idb || !name) return;
    try {
      var tx = idb.transaction('files', 'readwrite');
      var store = tx.objectStore('files');
      var getReq = store.get(name);
      getReq.onsuccess = function () {
        var prev = getReq.result || {};
        store.put({
          name: name, text: text, size: size || text.length,
          time: Date.now(), thumb: makeThumbnail(),
          favorite: !!prev.favorite, isDemo: name.indexOf('تجريبية') !== -1
        });
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
    fileListEl.innerHTML = '';
    homeEmptyEl.classList.toggle('hidden', rows.length > 0 || state.tab === 'favorites');
    if (state.tab === 'favorites' && !rows.length) {
      var emptyFav = document.createElement('div');
      emptyFav.className = 'empty-card';
      emptyFav.innerHTML = '<p class="empty-sub">مفيش ملفات مفضلة لسه — دوس على النجمة ⭐ جنب أي ملف</p>';
      fileListEl.appendChild(emptyFav);
      return;
    }
    rows.forEach(function (rec) {
      var card = document.createElement('button');
      card.className = 'file-card';
      var thumb = rec.thumb
        ? '<img class="file-thumb" src="' + rec.thumb + '" alt="">'
        : '<span class="file-thumb-placeholder">📐</span>';
      card.innerHTML = thumb +
        '<span class="file-meta"><span class="file-name">' + escapeHtml(rec.name) + '</span>' +
        '<span class="file-sub">' + fmtDate(rec.time) + ' &nbsp;' + fmtSize(rec.size) + '</span></span>' +
        '<span class="file-star' + (rec.favorite ? ' on' : '') + '" data-star="1">' + (rec.favorite ? '★' : '☆') + '</span>';
      card.addEventListener('click', function (ev) {
        if (ev.target.getAttribute('data-star')) {
          ev.stopPropagation();
          toggleFavorite(rec.name);
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
  document.getElementById('btnTheme').addEventListener('click', function () {
    settings.bg = settings.bg === 'black' ? 'white' : settings.bg === 'white' ? 'beige' : 'black';
    saveSettings();
    applySettingsUI();
    if (state.doc) buildLayersPanel();
    render();
  });

  // ---------- init ----------
  applySettingsUI();
  openDB().then(function () { loadLibrary(); });
  showScreen('home');
})();
