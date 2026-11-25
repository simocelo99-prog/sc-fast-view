/* SC Fast View — DXF parser (ASCII DXF).
   Works in the browser and in Node (for tests).
   Parses: TABLES/LAYER, BLOCKS, ENTITIES.
   Entities: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC, ELLIPSE,
   SPLINE, TEXT, MTEXT, POINT, INSERT, DIMENSION (via its block).
   Geometry is normalized to simple shapes for the canvas renderer. */
(function (root) {
  'use strict';

  function parsePairs(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      if (isNaN(code)) continue;
      pairs.push([code, lines[i + 1] !== undefined ? lines[i + 1] : '']);
    }
    return pairs;
  }

  function num(v, d) {
    const n = parseFloat(v);
    return isNaN(n) ? (d === undefined ? 0 : d) : n;
  }

  // Arc points for a polyline segment with bulge.
  // bulge = tan(includedAngle / 4); positive = arc to the left of p1->p2.
  function bulgePoints(x1, y1, x2, y2, bulge) {
    const pts = [];
    if (!bulge || Math.abs(bulge) < 1e-6) return pts;
    const dx = x2 - x1, dy = y2 - y1;
    const chord = Math.hypot(dx, dy);
    if (chord < 1e-9) return pts;
    const theta = 4 * Math.atan(bulge); // included angle, signed
    const r = chord / (2 * Math.sin(theta / 2));
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    // distance from chord midpoint to center
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    // unit perpendicular to the left of p1->p2
    const px = -dy / chord, py = dx / chord;
    const sign = bulge > 0 ? 1 : -1;
    // For positive bulge the center is to the right of travel (arc bulges left).
    const cx = mx - sign * h * px;
    const cy = my - sign * h * py;
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    let a2 = Math.atan2(y2 - cy, x2 - cx);
    let sweep = a2 - a1;
    // positive bulge => counter-clockwise travel
    if (bulge > 0 && sweep < 0) sweep += Math.PI * 2;
    if (bulge < 0 && sweep > 0) sweep -= Math.PI * 2;
    const n = Math.max(4, Math.min(32, Math.ceil(Math.abs(sweep) / (Math.PI / 16))));
    for (let i = 1; i < n; i++) {
      const a = a1 + (sweep * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function arcPoints(cx, cy, r, a1deg, a2deg) {
    let a1 = (a1deg * Math.PI) / 180;
    let a2 = (a2deg * Math.PI) / 180;
    if (a2 < a1) a2 += Math.PI * 2;
    const sweep = a2 - a1;
    const n = Math.max(8, Math.min(64, Math.ceil(Math.abs(sweep) / (Math.PI / 16))));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = a1 + (sweep * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return pts;
  }

  function ellipsePoints(cx, cy, mx, my, ratio, startParam, endParam) {
    const majorLen = Math.hypot(mx, my);
    if (majorLen < 1e-9) return [];
    const ux = mx / majorLen, uy = my / majorLen;
    const vx = -uy, vy = ux;
    const minorLen = majorLen * ratio;
    let t1 = startParam, t2 = endParam;
    if (t2 < t1) t2 += Math.PI * 2;
    const sweep = t2 - t1;
    const n = Math.max(8, Math.min(64, Math.ceil(Math.abs(sweep) / (Math.PI / 16))));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = t1 + (sweep * i) / n;
      const x = cx + majorLen * Math.cos(t) * ux + minorLen * Math.sin(t) * vx;
      const y = cy + majorLen * Math.cos(t) * uy + minorLen * Math.sin(t) * vy;
      pts.push([x, y]);
    }
    return pts;
  }

  // ACI color index -> CSS color (null = resolve from layer/foreground).
  function aciColor(n, darkBg) {
    if (n === undefined || n === null) return null;
    if (n === 256) return null; // BYLAYER
    if (n === 0) return darkBg ? '#FFFFFF' : '#000000'; // BYBLOCK fallback
    const map = {
      1: '#FF0000', 2: '#FFFF00', 3: '#00FF00', 4: '#00FFFF',
      5: '#0000FF', 6: '#FF00FF', 7: darkBg ? '#FFFFFF' : '#000000',
      8: '#808080', 9: '#C0C0C0'
    };
    if (map[n]) return map[n];
    if (n >= 250 && n <= 255) {
      const g = Math.round(255 - (n - 250) * 51);
      return 'rgb(' + g + ',' + g + ',' + g + ')';
    }
    if (n >= 10 && n <= 249) {
      const hue = ((n - 10) % 24) * 15;
      return 'hsl(' + hue + ', 80%, 55%)';
    }
    return null;
  }

  function parseDXF(text) {
    const pairs = parsePairs(text);
    const doc = { layers: [], blocks: {}, entities: [] };
    const layerMap = {};
    let i = 0;

    function readEntity() {
      // pairs[i] is [0, TYPE]; collect codes until next [0, ...]
      const type = pairs[i][1].trim();
      const e = { type: type, layer: '0', color: 256, codes: {} };
      i++;
      while (i < pairs.length && pairs[i][0] !== 0) {
        const c = pairs[i][0], v = pairs[i][1];
        if (c === 8) e.layer = String(v).trim();
        else if (c === 62) e.color = parseInt(v, 10);
        else if (c === 6) e.linetype = String(v).trim();
        if (!e.codes[c]) e.codes[c] = [];
        e.codes[c].push(v);
        i++;
      }
      return e;
    }

    function one(code, d) {
      const arr = current.codes[code];
      if (!arr || !arr.length) return d;
      return arr[0];
    }
    let current = null;

    while (i < pairs.length) {
      const code = pairs[i][0], val = String(pairs[i][1]).trim();
      if (code === 0 && val === 'SECTION') {
        i++;
        const secName = pairs[i] && pairs[i][0] === 2 ? String(pairs[i][1]).trim() : '';
        i++;
        if (secName === 'TABLES') {
          while (i < pairs.length && !(pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'ENDSEC')) {
            if (pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'LAYER') {
              const layer = { name: '0', color: 7 };
              i++;
              while (i < pairs.length && pairs[i][0] !== 0) {
                if (pairs[i][0] === 2) layer.name = String(pairs[i][1]).trim();
                if (pairs[i][0] === 62) layer.color = parseInt(pairs[i][1], 10);
                i++;
              }
              doc.layers.push(layer);
              layerMap[layer.name] = layer;
            } else {
              i++;
            }
          }
        } else if (secName === 'BLOCKS') {
          while (i < pairs.length && !(pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'ENDSEC')) {
            if (pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'BLOCK') {
              i++;
              let name = '';
              const bx = { x: 0, y: 0 };
              while (i < pairs.length && pairs[i][0] !== 0) {
                if (pairs[i][0] === 2) name = String(pairs[i][1]).trim();
                if (pairs[i][0] === 10) bx.x = num(pairs[i][1]);
                if (pairs[i][0] === 20) bx.y = num(pairs[i][1]);
                i++;
              }
              const ents = [];
              while (i < pairs.length && !(pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'ENDBLK')) {
                if (pairs[i][0] === 0) {
                  current = readEntity();
                  const g = entityToGeometry(current);
                  if (g) ents.push(g);
                } else i++;
              }
              if (name) doc.blocks[name] = { base: bx, entities: ents };
            } else {
              i++;
            }
          }
        } else if (secName === 'ENTITIES') {
          while (i < pairs.length && !(pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'ENDSEC')) {
            if (pairs[i][0] === 0) {
              const t = String(pairs[i][1]).trim();
              if (t === 'POLYLINE') {
                current = readEntity();
                const polyEnt = current;
                const closed = (num(one(70), 0) & 1) === 1;
                const pts = [];
                const bulges = [];
                while (i < pairs.length && !(pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'SEQEND')) {
                  if (pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'VERTEX') {
                    const v = readEntity();
                    current = v;
                    pts.push([num(one(10)), num(one(20))]);
                    bulges.push(num(one(42), 0));
                  } else i++;
                }
                const geo = polylineGeometry(pts, bulges, closed, polyEnt);
                if (geo) doc.entities.push(geo);
              } else {
                current = readEntity();
                const g = entityToGeometry(current);
                if (g) doc.entities.push(g);
              }
            } else i++;
          }
        } else {
          // skip other sections
          while (i < pairs.length && !(pairs[i][0] === 0 && String(pairs[i][1]).trim() === 'ENDSEC')) i++;
        }
      } else {
        i++;
      }
    }

    if (!doc.layers.length) doc.layers.push({ name: '0', color: 7 });
    if (!layerMap['0']) layerMap['0'] = { name: '0', color: 7 };
    doc.layerMap = layerMap;
    doc.bounds = computeBounds(doc.entities);
    return doc;

    // ---- helpers (use `current` raw entity) ----
    function entityToGeometry(e) {
      const layer = e.layer || '0';
      const color = e.color === undefined ? 256 : e.color;
      const base = { layer: layer, color: color };
      const get = (c, d) => {
        const arr = e.codes[c];
        return arr && arr.length ? arr[0] : d;
      };
      const getN = (c, d) => num(get(c, d), d === undefined ? 0 : d);
      switch (e.type) {
        case 'LINE':
          return Object.assign(base, {
            type: 'line',
            x1: getN(10), y1: getN(20), x2: getN(11), y2: getN(21)
          });
        case 'LWPOLYLINE': {
          const pts = [];
          const bulges = [];
          const xs = e.codes[10] || [], ys = e.codes[20] || [], bs = e.codes[42] || [];
          for (let k = 0; k < xs.length; k++) {
            pts.push([num(xs[k]), num(ys[k] || 0)]);
            bulges.push(num(bs[k] || 0, 0));
          }
          const closed = (getN(70, 0) & 1) === 1;
          return polylineGeometry(pts, bulges, closed, e);
        }
        case 'CIRCLE': {
          const r = getN(40, 0);
          if (r <= 0) return null;
          return Object.assign(base, { type: 'circle', cx: getN(10), cy: getN(20), r: r });
        }
        case 'ARC': {
          const r = getN(40, 0);
          if (r <= 0) return null;
          return Object.assign(base, {
            type: 'polyline',
            points: arcPoints(getN(10), getN(20), r, getN(50, 0), getN(51, 360)),
            closed: false
          });
        }
        case 'ELLIPSE': {
          const pts = ellipsePoints(
            getN(10), getN(20), getN(11), getN(21), getN(40, 1),
            num(get(41, 0)), num(get(42, Math.PI * 2))
          );
          if (!pts.length) return null;
          return Object.assign(base, { type: 'polyline', points: pts, closed: Math.abs(num(get(42, 0)) - num(get(41, 0)) - Math.PI * 2) < 0.01 });
        }
        case 'SPLINE': {
          const fitX = e.codes[11] || [], fitY = e.codes[21] || [];
          const ctlX = e.codes[10] || [], ctlY = e.codes[20] || [];
          const srcX = fitX.length ? fitX : ctlX;
          const srcY = fitX.length ? fitY : ctlY;
          const pts = [];
          for (let k = 0; k < srcX.length; k++) pts.push([num(srcX[k]), num(srcY[k] || 0)]);
          if (pts.length < 2) return null;
          return Object.assign(base, { type: 'polyline', points: pts, closed: (getN(70, 0) & 1) === 1 });
        }
        case 'TEXT': {
          const str = String(get(1, ''));
          return Object.assign(base, {
            type: 'text', x: getN(10), y: getN(20), h: getN(40, 1),
            rot: getN(50, 0), str: str
          });
        }
        case 'MTEXT': {
          let str = '';
          (e.codes[3] || []).forEach(function (s) { str += s; });
          (e.codes[1] || []).forEach(function (s) { str += s; });
          str = str.replace(/\\P/g, '\n').replace(/\\[A-Za-z][^;]*;/g, '');
          let rot = 0;
          if (e.codes[11] && e.codes[11].length) {
            rot = Math.atan2(num(e.codes[21] ? e.codes[21][0] : 0), num(e.codes[11][0])) * 180 / Math.PI;
          }
          return Object.assign(base, {
            type: 'text', x: getN(10), y: getN(20), h: getN(40, 1), rot: rot, str: str
          });
        }
        case 'POINT':
          return Object.assign(base, { type: 'point', x: getN(10), y: getN(20) });
        case 'INSERT': {
          const name = String(get(2, '')).trim();
          const blk = doc.blocks[name];
          if (!blk) return null;
          const sx = getN(41, 1), sy = getN(42, 1);
          const rot = (getN(50, 0) * Math.PI) / 180;
          const ox = getN(10), oy = getN(20);
          const cos = Math.cos(rot), sin = Math.sin(rot);
          const out = [];
          blk.entities.forEach(function (g) {
            const t = transformGeometry(g, function (x, y) {
              const X = x * sx, Y = y * sy;
              return [ox + X * cos - Y * sin, oy + X * sin + Y * cos];
            }, sx, sy);
            if (t) out.push(t);
          });
          if (!out.length) return null;
          return { type: 'group', layer: layer, color: color, items: out };
        }
        case 'DIMENSION': {
          const name = String(get(2, '')).trim();
          const blk = doc.blocks[name];
          if (!blk) return null;
          const ox = getN(10), oy = getN(20);
          const out = [];
          blk.entities.forEach(function (g) {
            const t = transformGeometry(g, function (x, y) { return [ox + x, oy + y]; }, 1, 1);
            if (t) out.push(t);
          });
          if (!out.length) return null;
          return { type: 'group', layer: layer, color: color, items: out };
        }
        default:
          return null;
      }
    }

    function polylineGeometry(pts, bulges, closed, e) {
      if (pts.length < 2) return null;
      const out = [];
      for (let k = 0; k < pts.length - 1; k++) {
        out.push(pts[k]);
        const b = bulges[k] || 0;
        if (b) {
          const extra = bulgePoints(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], b);
          extra.forEach(function (p) { out.push(p); });
        }
      }
      out.push(pts[pts.length - 1]);
      return {
        type: 'polyline', layer: (e && e.layer) || '0',
        color: e && e.color !== undefined ? e.color : 256,
        points: out, closed: !!closed
      };
    }

    function transformGeometry(g, fn, sx, sy) {
      if (!g) return null;
      const copy = Object.assign({}, g);
      if (g.type === 'line') {
        const a = fn(g.x1, g.y1), b = fn(g.x2, g.y2);
        copy.x1 = a[0]; copy.y1 = a[1]; copy.x2 = b[0]; copy.y2 = b[1];
        return copy;
      }
      if (g.type === 'polyline') {
        copy.points = g.points.map(function (p) { return fn(p[0], p[1]); });
        return copy;
      }
      if (g.type === 'circle') {
        if (Math.abs(sx - sy) < 1e-6) {
          const c = fn(g.cx, g.cy);
          copy.cx = c[0]; copy.cy = c[1]; copy.r = g.r * Math.abs(sx);
          return copy;
        }
        // non-uniform scale -> sample as polyline
        const pts = arcPoints(g.cx, g.cy, g.r, 0, 360).map(function (p) { return fn(p[0], p[1]); });
        return { type: 'polyline', layer: g.layer, color: g.color, points: pts, closed: true };
      }
      if (g.type === 'text') {
        const p = fn(g.x, g.y);
        copy.x = p[0]; copy.y = p[1];
        copy.h = g.h * Math.abs(sx);
        return copy;
      }
      if (g.type === 'point') {
        const p = fn(g.x, g.y);
        copy.x = p[0]; copy.y = p[1];
        return copy;
      }
      if (g.type === 'group') {
        copy.items = g.items.map(function (it) { return transformGeometry(it, fn, sx, sy); }).filter(Boolean);
        return copy.items.length ? copy : null;
      }
      return null;
    }

    function computeBounds(entities) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      function pt(x, y) {
        if (!isFinite(x) || !isFinite(y)) return;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      function walk(g) {
        if (!g) return;
        if (g.type === 'line') { pt(g.x1, g.y1); pt(g.x2, g.y2); }
        else if (g.type === 'polyline') g.points.forEach(function (p) { pt(p[0], p[1]); });
        else if (g.type === 'circle') { pt(g.cx - g.r, g.cy - g.r); pt(g.cx + g.r, g.cy + g.r); }
        else if (g.type === 'text') { pt(g.x, g.y); pt(g.x + g.str.length * g.h * 0.6, g.y + g.h); }
        else if (g.type === 'point') pt(g.x, g.y);
        else if (g.type === 'group') g.items.forEach(walk);
      }
      entities.forEach(walk);
      if (!isFinite(minX)) return { minX: -10, minY: -10, maxX: 10, maxY: 10 };
      return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
    }
  }

  root.DXF = { parse: parseDXF, aciColor: aciColor };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.DXF;
})(typeof self !== 'undefined' ? self : globalThis);
