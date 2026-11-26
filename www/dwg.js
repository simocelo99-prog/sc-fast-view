/* SC Fast View — DWG loader.
   Uses @mlightcad/libredwg-web 0.9.4 (LibreDWG compiled to WebAssembly).
   Files live in www/libredwg/ (wrapper + glue + .wasm, all local, no CDN):
     libredwg-web.js   — dist ESM wrapper (its "../wasm/..." import was
                         rewritten to "./libredwg-glue.js")
     libredwg-glue.js  — Emscripten glue (wasm/libredwg-web.js)
     libredwg-web.wasm — 7.5 MB, fetched only when a DWG is opened.
   API (per the installed 0.9.4 README / lib/libredwg.d.ts):
     LibreDwg.create() -> instance (singleton)
     dwg_read_data(arrayBuffer, Dwg_File_Type.DWG) -> Dwg_Data pointer
     convertEx(ptr) -> { database: DwgDatabase, stats: { unknownEntityCount } }
     dwg_free(ptr)
   All angles in DwgDatabase are in RADIANS (confirmed in the package's
   svgConverter: INSERT rotation is converted with * (180/Math.PI), and
   ARC angles are used directly with Math.cos/sin). The app expects degrees,
   so rotations are converted here.
   Exposes window.DWG = { open(arrayBuffer) -> Promise<doc> } where doc has
   the exact shape dxf.js produces: {entities, layers, layerMap, bounds}.
   Entity types match app.js: line, polyline, circle, text, point, group.
   Colors are ACI numbers so DXF.aciColor() resolves them like the DXF path.
   Not supported (skipped, counted in doc.dwgStats.skipped): DIMENSION,
   HATCH, XLINE, RAY, SOLID, 3DFACE, IMAGE, LEADER, MLEADER, TABLE, etc.
   Block entities are stored relative to the block base point in the file,
   same convention as dxf.js and the package's own SVG converter, so the
   base point is NOT subtracted on INSERT (matches dxf.js behaviour). */
(function (root) {
  'use strict';

  var loadPromise = null;
  var FileTypeDWG = 0; // Dwg_File_Type.DWG

  // Read the cached DWG engine (saved in the app's storage by an earlier
  // version). Resolves null when there is no cache yet — never rejects.
  function getCachedWasm() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open('scfastview');
        req.onsuccess = function () {
          try {
            var db = req.result;
            if (!db.objectStoreNames.contains('wasm')) { resolve(null); return; }
            var get = db.transaction('wasm', 'readonly').objectStore('wasm').get('libredwg-web.wasm');
            get.onsuccess = function () {
              resolve(get.result && get.result.data ? get.result.data : null);
            };
            get.onerror = function () { resolve(null); };
          } catch (e) { resolve(null); }
        };
        req.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  // The DWG engine as a release asset: used only when the app has no cached
  // engine and no bundled one (small APK). Same file in every release.
  var WASM_RELEASE_URL = 'https://github.com/simocelo99-prog/sc-fast-view/releases/latest/download/libredwg-web.wasm';

  // Save downloaded engine bytes into the app's storage (best effort).
  function putCachedWasm(buf) {
    try {
      var req = indexedDB.open('scfastview');
      req.onsuccess = function () {
        try {
          var db = req.result;
          if (!db.objectStoreNames.contains('wasm')) return;
          db.transaction('wasm', 'readwrite').objectStore('wasm')
            .put({ name: 'libredwg-web.wasm', data: buf, size: buf.byteLength, savedAt: Date.now() });
        } catch (e) { /* ignore */ }
      };
    } catch (e) { /* ignore */ }
  }

  // Download the engine once from the release (only for a fresh install of
  // a small APK, or when the cache missed). Returns ArrayBuffer or null.
  function downloadWasmEngine() {
    return fetch(WASM_RELEASE_URL).then(function (res) {
      if (!res.ok) return null;
      return res.arrayBuffer();
    }).then(function (buf) {
      if (buf) putCachedWasm(buf);
      return buf;
    }).catch(function () { return null; });
  }

  function createFromBytes(mod, bytes) {
    return mod.createModule({ wasmBinary: bytes }).then(function (inst) {
      return mod.LibreDwg.createByWasmInstance(inst);
    });
  }

  // 1) cached engine, 2) bundled file, 3) download once from the release.
  function tryCreate(mod, bytes) {
    var chain = bytes
      ? createFromBytes(mod, bytes).catch(function () { return mod.LibreDwg.create(); })
      : mod.LibreDwg.create();
    return chain.catch(function () {
      return downloadWasmEngine().then(function (dl) {
        if (!dl) throw new Error('تعذّر تحميل محرك DWG — اتأكد من النت وحاول تاني');
        return createFromBytes(mod, dl);
      });
    });
  }

  function loadLib() {
    if (loadPromise) return loadPromise;
    loadPromise = import('./libredwg/libredwg-web.js').then(function (mod) {
      FileTypeDWG = mod.Dwg_File_Type.DWG;
      return getCachedWasm().then(function (bytes) { return tryCreate(mod, bytes); });
    });
    return loadPromise;
  }

  function rad2deg(r) { return (r * 180) / Math.PI; }
  function num(v, d) {
    var n = parseFloat(v);
    return isNaN(n) ? (d === undefined ? 0 : d) : n;
  }

  // ---- geometry helpers (same math as dxf.js) ----
  function bulgePoints(x1, y1, x2, y2, bulge) {
    var pts = [];
    if (!bulge || Math.abs(bulge) < 1e-6) return pts;
    var dx = x2 - x1, dy = y2 - y1;
    var chord = Math.hypot(dx, dy);
    if (chord < 1e-9) return pts;
    var theta = 4 * Math.atan(bulge);
    var r = chord / (2 * Math.sin(theta / 2));
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    var h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    var px = -dy / chord, py = dx / chord;
    var sign = bulge > 0 ? 1 : -1;
    var cx = mx - sign * h * px;
    var cy = my - sign * h * py;
    var a1 = Math.atan2(y1 - cy, x1 - cx);
    var a2 = Math.atan2(y2 - cy, x2 - cx);
    var sweep = a2 - a1;
    if (bulge > 0 && sweep < 0) sweep += Math.PI * 2;
    if (bulge < 0 && sweep > 0) sweep -= Math.PI * 2;
    var n = Math.max(4, Math.min(32, Math.ceil(Math.abs(sweep) / (Math.PI / 16))));
    for (var i = 1; i < n; i++) {
      var a = a1 + (sweep * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function arcPointsRad(cx, cy, r, a1, a2) {
    if (a2 < a1) a2 += Math.PI * 2;
    var sweep = a2 - a1;
    var n = Math.max(8, Math.min(64, Math.ceil(Math.abs(sweep) / (Math.PI / 16))));
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var a = a1 + (sweep * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function ellipsePoints(cx, cy, mx, my, ratio, t1, t2) {
    var majorLen = Math.hypot(mx, my);
    if (majorLen < 1e-9) return [];
    var ux = mx / majorLen, uy = my / majorLen;
    var vx = -uy, vy = ux;
    var minorLen = majorLen * ratio;
    if (t2 < t1) t2 += Math.PI * 2;
    var sweep = t2 - t1;
    var n = Math.max(8, Math.min(64, Math.ceil(Math.abs(sweep) / (Math.PI / 16))));
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var t = t1 + (sweep * i) / n;
      var x = cx + majorLen * Math.cos(t) * ux + minorLen * Math.sin(t) * vx;
      var y = cy + majorLen * Math.cos(t) * uy + minorLen * Math.sin(t) * vy;
      pts.push([x, y]);
    }
    return pts;
  }

  // de Boor evaluation of a B-spline (used for SPLINE without fit points).
  function deBoor(pts, knots, degree, t, weights) {
    var n = pts.length - 1, p = degree;
    var k = p;
    while (k < n && t >= knots[k + 1]) k++;
    var d = [];
    for (var j = 0; j <= p; j++) {
      var pt = pts[k - p + j];
      var w = weights ? num(weights[k - p + j], 1) : 1;
      d.push([pt.x * w, pt.y * w, w]);
    }
    for (var r = 1; r <= p; r++) {
      for (var jj = p; jj >= r; jj--) {
        var i = k - p + jj;
        var denom = knots[i + p - r + 1] - knots[i];
        var a = denom === 0 ? 0 : (t - knots[i]) / denom;
        d[jj][0] = (1 - a) * d[jj - 1][0] + a * d[jj][0];
        d[jj][1] = (1 - a) * d[jj - 1][1] + a * d[jj][1];
        d[jj][2] = (1 - a) * d[jj - 1][2] + a * d[jj][2];
      }
    }
    var wEnd = d[p][2] || 1;
    return [d[p][0] / wEnd, d[p][1] / wEnd];
  }

  function bsplinePoints(controlPoints, degree, knots, weights) {
    var n = controlPoints.length - 1, p = degree;
    if (n < 1) return [];
    if (n < p || !knots || knots.length < n + p + 2) {
      return controlPoints.map(function (pt) { return [pt.x, pt.y]; });
    }
    var t0 = knots[p], t1 = knots[n + 1];
    if (!(t1 > t0)) return controlPoints.map(function (pt) { return [pt.x, pt.y]; });
    var pts = [];
    var SEG = 32;
    for (var i = 0; i <= SEG; i++) {
      var t = t0 + ((t1 - t0) * i) / SEG;
      if (i === SEG) t = t1 - 1e-9; // stay inside the last span
      pts.push(deBoor(controlPoints, knots, p, t, weights));
    }
    return pts;
  }

  function cleanMText(s) {
    return String(s || '').replace(/\\P/g, '\n').replace(/\\[A-Za-z][^;]*;/g, '');
  }

  function polylineFromVertices(verts, closed, base) {
    if (!verts || verts.length < 2) return null;
    var out = [];
    for (var k = 0; k < verts.length - 1; k++) {
      out.push([verts[k].x, verts[k].y]);
      var b = verts[k].bulge || 0;
      if (b) {
        bulgePoints(verts[k].x, verts[k].y, verts[k + 1].x, verts[k + 1].y, b)
          .forEach(function (p) { out.push(p); });
      }
    }
    out.push([verts[verts.length - 1].x, verts[verts.length - 1].y]);
    return {
      type: 'polyline', layer: base.layer, color: base.color,
      points: out, closed: !!closed
    };
  }

  // Same transform rules as dxf.js transformGeometry, plus text rotation
  // is rotated by the insert rotation (dxf.js leaves it unrotated).
  function transformGeometry(g, fn, sx, sy, rotDeg) {
    if (!g) return null;
    var copy = Object.assign({}, g);
    if (g.type === 'line') {
      var a = fn(g.x1, g.y1), b = fn(g.x2, g.y2);
      copy.x1 = a[0]; copy.y1 = a[1]; copy.x2 = b[0]; copy.y2 = b[1];
      return copy;
    }
    if (g.type === 'polyline') {
      copy.points = g.points.map(function (p) { return fn(p[0], p[1]); });
      return copy;
    }
    if (g.type === 'circle') {
      if (Math.abs(sx - sy) < 1e-6) {
        var c = fn(g.cx, g.cy);
        copy.cx = c[0]; copy.cy = c[1]; copy.r = g.r * Math.abs(sx);
        return copy;
      }
      var pts = arcPointsRad(g.cx, g.cy, g.r, 0, Math.PI * 2).map(function (p) { return fn(p[0], p[1]); });
      return { type: 'polyline', layer: g.layer, color: g.color, points: pts, closed: true };
    }
    if (g.type === 'text') {
      var p = fn(g.x, g.y);
      copy.x = p[0]; copy.y = p[1];
      copy.h = g.h * Math.abs(sx);
      copy.rot = (g.rot || 0) + (rotDeg || 0);
      return copy;
    }
    if (g.type === 'point') {
      var pp = fn(g.x, g.y);
      copy.x = pp[0]; copy.y = pp[1];
      return copy;
    }
    if (g.type === 'group') {
      copy.items = g.items.map(function (it) { return transformGeometry(it, fn, sx, sy, rotDeg); }).filter(Boolean);
      return copy.items.length ? copy : null;
    }
    return null;
  }

  // ---- entity mapping ----
  function colorIndexOf(e) {
    var c = e.colorIndex;
    if (c === undefined || c === null) return 256; // BYLAYER
    return c;
  }

  function mapEntity(e, ctx, depth, stack) {
    if (!e || !e.type) return null;
    if (e.isVisible === false) return null;
    if (e.isInPaperSpace) return null;
    var ci = colorIndexOf(e);
    if (ci < 0) return null; // layer turned off
    var base = { layer: e.layer || '0', color: ci };
    var g;
    switch (e.type) {
      case 'LINE':
        if (!e.startPoint || !e.endPoint) return null;
        return Object.assign(base, {
          type: 'line',
          x1: e.startPoint.x, y1: e.startPoint.y,
          x2: e.endPoint.x, y2: e.endPoint.y
        });
      case 'LWPOLYLINE':
        return polylineFromVertices(e.vertices, (e.flag & 1) === 1, base);
      case 'POLYLINE2D':
        return polylineFromVertices(e.vertices, (e.flag & 1) === 1, base);
      case 'POLYLINE3D':
        if (e.flag & 64) { ctx.skipped['POLYLINE3D(POLYFACE)'] = (ctx.skipped['POLYLINE3D(POLYFACE)'] || 0) + 1; return null; }
        return polylineFromVertices(e.vertices, (e.flag & 1) === 1, base);
      case 'CIRCLE': {
        var r = num(e.radius, 0);
        if (r <= 0 || !e.center) return null;
        return Object.assign(base, { type: 'circle', cx: e.center.x, cy: e.center.y, r: r });
      }
      case 'ARC': {
        var ar = num(e.radius, 0);
        if (ar <= 0 || !e.center) return null;
        return Object.assign(base, {
          type: 'polyline',
          points: arcPointsRad(e.center.x, e.center.y, ar, num(e.startAngle, 0), num(e.endAngle, Math.PI * 2)),
          closed: false
        });
      }
      case 'ELLIPSE': {
        if (!e.center || !e.majorAxisEndPoint) return null;
        var pts = ellipsePoints(
          e.center.x, e.center.y,
          e.majorAxisEndPoint.x, e.majorAxisEndPoint.y,
          num(e.axisRatio, 1), num(e.startAngle, 0), num(e.endAngle, Math.PI * 2)
        );
        if (!pts.length) return null;
        var sweep = num(e.endAngle, Math.PI * 2) - num(e.startAngle, 0);
        return Object.assign(base, {
          type: 'polyline', points: pts,
          closed: Math.abs(Math.abs(sweep) - Math.PI * 2) < 0.01
        });
      }
      case 'SPLINE': {
        var spts = null;
        if (e.fitPoints && e.fitPoints.length >= 2) {
          spts = e.fitPoints.map(function (p) { return [p.x, p.y]; });
        } else if (e.controlPoints && e.controlPoints.length >= 2) {
          spts = bsplinePoints(e.controlPoints, num(e.degree, 3), e.knots, e.weights);
        }
        if (!spts || spts.length < 2) return null;
        return Object.assign(base, {
          type: 'polyline', points: spts, closed: (e.flag & 1) === 1
        });
      }
      case 'TEXT': {
        if (!e.startPoint) return null;
        return Object.assign(base, {
          type: 'text', x: e.startPoint.x, y: e.startPoint.y,
          h: num(e.textHeight, 1) || 1, rot: rad2deg(num(e.rotation, 0)),
          str: String(e.text || '')
        });
      }
      case 'MTEXT': {
        if (!e.insertionPoint) return null;
        return Object.assign(base, {
          type: 'text', x: e.insertionPoint.x, y: e.insertionPoint.y,
          h: num(e.textHeight, 1) || 1, rot: rad2deg(num(e.rotation, 0)),
          str: cleanMText(e.text)
        });
      }
      case 'POINT':
        if (!e.position) return null;
        return Object.assign(base, { type: 'point', x: e.position.x, y: e.position.y });
      case 'INSERT':
        return expandInsert(e, ctx, depth, stack);
      default:
        ctx.skipped[e.type] = (ctx.skipped[e.type] || 0) + 1;
        return null;
    }
  }

  function expandInsert(ins, ctx, depth, stack) {
    var name = String(ins.name || '').trim();
    var blk = ctx.blocks[name];
    if (!blk || !blk.entities || !blk.entities.length) {
      ctx.skipped['INSERT:' + (name || '?')] = (ctx.skipped['INSERT:' + (name || '?')] || 0) + 1;
      return null;
    }
    if (depth > 8 || stack.indexOf(name) !== -1) {
      ctx.skipped['INSERT:cycle/depth'] = (ctx.skipped['INSERT:cycle/depth'] || 0) + 1;
      return null;
    }
    var sx = num(ins.xScale, 1) || 1, sy = num(ins.yScale, 1) || 1;
    var rot = num(ins.rotation, 0); // radians
    var rotDeg = rad2deg(rot);
    var cos = Math.cos(rot), sin = Math.sin(rot);
    var ox = ins.insertionPoint ? ins.insertionPoint.x : 0;
    var oy = ins.insertionPoint ? ins.insertionPoint.y : 0;
    var cols = Math.max(1, Math.round(num(ins.columnCount, 1)) || 1);
    var rows = Math.max(1, Math.round(num(ins.rowCount, 1)) || 1);
    var colSp = num(ins.columnSpacing, 0), rowSp = num(ins.rowSpacing, 0);
    var newStack = stack.concat([name]);
    var out = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        // array offsets along the (rotated) insert X/Y axes
        var ax = ox + (c * colSp) * cos - (r * rowSp) * sin;
        var ay = oy + (c * colSp) * sin + (r * rowSp) * cos;
        blk.entities.forEach(function (be) {
          var g = mapEntity(be, ctx, depth + 1, newStack);
          if (!g) return;
          var t = transformGeometry(g, function (x, y) {
            var X = x * sx, Y = y * sy;
            return [ax + X * cos - Y * sin, ay + X * sin + Y * cos];
          }, sx, sy, rotDeg);
          if (t) out.push(t);
        });
        // block attributes render as text at their own positions
        (ins.attribs || []).forEach(function (at) {
          if (!at || !at.text || !at.startPoint) return;
          var tg = {
            type: 'text', layer: at.layer || ins.layer || '0',
            color: colorIndexOf(at), x: at.startPoint.x, y: at.startPoint.y,
            h: num(at.textHeight, 1) || 1, rot: rad2deg(num(at.rotation, 0)),
            str: String(at.text)
          };
          var t2 = transformGeometry(tg, function (x, y) {
            var X = x * sx, Y = y * sy;
            return [ax + X * cos - Y * sin, ay + X * sin + Y * cos];
          }, sx, sy, rotDeg);
          if (t2) out.push(t2);
        });
      }
    }
    if (!out.length) return null;
    return {
      type: 'group', layer: ins.layer || '0', color: colorIndexOf(ins),
      items: out
    };
  }

  function mapDatabase(db, stats) {
    var layers = [];
    var layerMap = {};
    var layerEntries = (db.tables && db.tables.LAYER && db.tables.LAYER.entries) || [];
    layerEntries.forEach(function (l) {
      var layer = {
        name: String(l.name || '0'),
        color: (l.colorIndex === undefined || l.colorIndex === null) ? 7 : l.colorIndex
      };
      layers.push(layer);
      layerMap[layer.name] = layer;
    });
    if (!layers.length) {
      layers.push({ name: '0', color: 7 });
      layerMap['0'] = layers[0];
    }
    if (!layerMap['0']) layerMap['0'] = { name: '0', color: 7 };

    var blocks = {};
    var blockEntries = (db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || [];
    blockEntries.forEach(function (b) {
      blocks[b.name] = { entities: b.entities || [] };
    });

    var ctx = { blocks: blocks, skipped: {} };
    var entities = [];
    // Accumulate the bounds in the same pass that maps the entities —
    // a separate bounds walk over hundreds of thousands of entities
    // would be a second full pass we do not need.
    var bminX = Infinity, bminY = Infinity, bmaxX = -Infinity, bmaxY = -Infinity;
    function bpt(x, y) {
      if (!isFinite(x) || !isFinite(y)) return;
      if (x < bminX) bminX = x;
      if (y < bminY) bminY = y;
      if (x > bmaxX) bmaxX = x;
      if (y > bmaxY) bmaxY = y;
    }
    function bwalk(g) {
      if (!g) return;
      if (g.type === 'line') { bpt(g.x1, g.y1); bpt(g.x2, g.y2); }
      else if (g.type === 'polyline') g.points.forEach(function (p) { bpt(p[0], p[1]); });
      else if (g.type === 'circle') { bpt(g.cx - g.r, g.cy - g.r); bpt(g.cx + g.r, g.cy + g.r); }
      else if (g.type === 'text') { bpt(g.x, g.y); bpt(g.x + g.str.length * g.h * 0.6, g.y + g.h); }
      else if (g.type === 'point') bpt(g.x, g.y);
      else if (g.type === 'group') g.items.forEach(bwalk);
    }
    (db.entities || []).forEach(function (e) {
      var g = mapEntity(e, ctx, 0, []);
      if (g) { entities.push(g); bwalk(g); }
    });
    var bounds = (!isFinite(bminX))
      ? { minX: -10, minY: -10, maxX: 10, maxY: 10 }
      : { minX: bminX, minY: bminY, maxX: bmaxX, maxY: bmaxY };

    var doc = {
      entities: entities,
      layers: layers,
      layerMap: layerMap,
      bounds: bounds
    };
    doc.dwgStats = {
      total: (db.entities || []).length,
      skipped: ctx.skipped,
      unknownEntityCount: stats ? stats.unknownEntityCount || 0 : 0
    };
    // Saved view: the *Active VPORT holds the view AutoCAD had when the file
    // was saved (VIEWCTR + VIEWSIZE). That is the framing the file's author
    // saw — usually the plan filling the screen — while the raw bounds span
    // far-out junk. app.js uses it as the initial view when it is sane.
    try {
      var vports = (db.tables && db.tables.VPORT && db.tables.VPORT.entries) || [];
      var active = null;
      vports.forEach(function (v) {
        if (!active && v.name === '*Active') active = v;
      });
      if (!active && vports.length) active = vports[0];
      if (active && active.center && isFinite(active.center.x) && isFinite(active.center.y)
        && isFinite(active.viewHeight) && active.viewHeight > 0) {
        var aspect = (isFinite(active.aspectRatio) && active.aspectRatio > 0)
          ? active.aspectRatio : 0;
        doc.savedView = {
          cx: active.center.x, cy: active.center.y,
          height: active.viewHeight, aspect: aspect
        };
      }
    } catch (e) { /* no saved view — app.js falls back to the density fit */ }
    return doc;
  }

  function open(arrayBuffer) {
    if (!arrayBuffer || !(arrayBuffer instanceof ArrayBuffer)) {
      return Promise.reject(new Error('DWG.open needs an ArrayBuffer'));
    }
    // DWG magic: every version since R11 starts with "AC1" + 3 digits
    // (AC1009 = R11/R12, AC1015 = R2000, AC1021 = R2004, AC1024 = R2010,
    //  AC1027 = R2013, AC1032 = R2018). The wrapper only warns on a bad
    //  file (error 2048) and still returns an empty database, so reject
    //  non-DWG bytes here instead of showing an empty viewer.
    var head = new Uint8Array(arrayBuffer, 0, Math.min(6, arrayBuffer.byteLength));
    var magic = '';
    for (var i = 0; i < head.length; i++) magic += String.fromCharCode(head[i]);
    if (!/^AC1\d{3}/.test(magic)) {
      return Promise.reject(new Error('الملف ده مش DWG — تأكد إن الملف سليم'));
    }
    return loadLib().then(function (lib) {
      var ptr = lib.dwg_read_data(arrayBuffer, FileTypeDWG);
      if (!ptr) throw new Error('ملف DWG غير صالح أو تالف');
      try {
        var res = lib.convertEx(ptr);
        return mapDatabase(res.database, res.stats);
      } finally {
        lib.dwg_free(ptr);
      }
    });
  }

  root.DWG = { open: open };
})(typeof self !== 'undefined' ? self : globalThis);
