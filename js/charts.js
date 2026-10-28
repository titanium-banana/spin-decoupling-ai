/*
 * charts.js: the four data figures of the page (Figures 7, 12, 16 and 18),
 * drawn as plain SVG from window.SITE_DATA.
 *
 * Each chart is drawn at the pixel width of its container, so labels keep
 * their 12 px size on any screen; a resize, an opened details or a change
 * of colour scheme redraws. Bars carry the class "bar", and a container
 * gains the class "in-view" the first time it scrolls into sight, so the
 * stylesheet can grow the bars once (skipped when the visitor prefers
 * reduced motion). Colours are read from the page's CSS custom
 * properties. Marks: bars 16 px thick on an 18 px pitch, square at the
 * baseline and rounded at the data end; lines 2 px; dots r = 4 with a
 * 2 px paper ring.
 *
 * Classic script: defines window.Charts; also exported for Node.
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var FONT = 12;      /* label size, px */
  var ROW = 18;       /* row pitch: bar plus a 2 px gap */
  var BAR = 16;       /* bar thickness */
  var ROUND = 3;      /* radius at the data end of a bar */
  var GROUP_GAP = 8;  /* vertical gap between category groups */
  var CHAR = 6.3;     /* estimated width of one character at 12 px */
  var CAT_VARS = {
    'Reference': '--cat-ref', 'FunSearch': '--cat-fun',
    'RL sequence': '--cat-rl', 'Archive pick': '--cat-pick',
    'Hand-assembled': '--cat-hand'
  };

  var C = {};             /* colours, read from the stylesheet at draw time */
  var lastData = null;
  var widths = {};        /* container id -> width used at the last draw */
  var listening = false;
  var tip = null;

  /* ---- helpers ---------------------------------------------------------- */

  function readColours() {
    var cs = root.getComputedStyle(document.documentElement);
    function get(name, fallback) {
      var v = cs.getPropertyValue(name);
      return (v && v.trim()) || fallback;
    }
    C = { paper: get('--paper', '#fff'), ink: get('--ink', '#111'),
          ink2: get('--ink-2', '#444'), muted: get('--muted', '#777'),
          rule: get('--rule', '#ddd'), accent: get('--accent', '#00693E'),
          cat: {} };
    Object.keys(CAT_VARS).forEach(function (cat) {
      C.cat[cat] = get(CAT_VARS[cat], C.ink2);
    });
  }

  function catColour(cat) { return C.cat[cat] || C.ink2; }

  /* The reference sequences' category. */
  function isReference(cat) { return cat === 'Reference'; }

  function catLabel(cat) { return cat; }

  /* Run names for display. The data labels a run "SED c=20.5 fixed"; the
     second run at a setting carries a letter after the constant, which is
     written out in words. `row` drops the alphabet for a row label and
     `full` keeps it for a tooltip. */
  function runName(label) {
    var m = /^(\S+)\s+c=([\d.]+)([a-z]?)\s+(\S+)$/.exec(label);
    if (!m) return { row: label.replace(/^\S+\s+/, ''), full: label };
    var row = 'c=' + m[2] + ' ' + m[4] + (m[3] ? ', second run' : '');
    return { row: row, full: m[1] + ' ' + row };
  }

  function el(parent, name, attrs) {
    var e = document.createElementNS(NS, name);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
      });
    }
    if (parent) parent.appendChild(e);
    return e;
  }

  function text(parent, x, y, str, attrs) {
    var a = { x: x, y: y, 'font-size': FONT, fill: C.muted };
    if (attrs) Object.keys(attrs).forEach(function (k) { a[k] = attrs[k]; });
    var t = el(parent, 'text', a);
    t.textContent = str;
    return t;
  }

  function hairline(parent, x1, y1, x2, y2, colour) {
    return el(parent, 'line', { x1: x1, y1: y1, x2: x2, y2: y2,
      stroke: colour || C.rule, 'stroke-width': 1, 'shape-rendering': 'crispEdges' });
  }

  function makeSvg(container, w, h, title) {
    container.textContent = '';
    var svg = el(container, 'svg', { viewBox: '0 0 ' + w + ' ' + h,
      width: '100%', role: 'img' });
    el(svg, 'title').textContent = title;
    return svg;
  }

  /* Width of a container in CSS pixels, remembered for the resize check. */
  function widthOf(container, fallback) {
    var w = container.clientWidth || fallback;
    w = Math.max(320, Math.round(w));
    widths[container.id] = w;
    return w;
  }

  function widthsChanged() {
    return Object.keys(widths).some(function (id) {
      var c = document.getElementById(id);
      return c && c.clientWidth && Math.abs(c.clientWidth - widths[id]) > 1;
    });
  }

  /* Round steps 1, 2, 2.5, 5 x 10^k giving about `target` intervals. */
  function ticks(lo, hi, target) {
    var raw = (hi - lo) / target;
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), m = raw / p;
    var step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, vals = [];
    for (var v = a; v <= b + step / 2; v += step) vals.push(+v.toFixed(10));
    return { lo: a, hi: b, values: vals };
  }

  function fmt(v) { return String(+v.toFixed(2)); }

  /* Greedy word wrap into lines of at most `maxChars` characters. */
  function wrap(str, maxChars) {
    var lines = [], line = '';
    str.split(/\s+/).forEach(function (w) {
      if (line && (line + ' ' + w).length > maxChars) { lines.push(line); line = w; }
      else line = line ? line + ' ' + w : w;
    });
    if (line) lines.push(line);
    return lines;
  }

  /* Centred axis label, kept inside the drawing and wrapped when too wide. */
  function axisLabel(parent, cx, y, str, W) {
    var lines = wrap(str, Math.floor((W - 8) / CHAR)), longest = 0;
    lines.forEach(function (l) { longest = Math.max(longest, l.length); });
    var half = longest * CHAR / 2;
    cx = Math.max(half + 4, Math.min(cx, W - half - 4));
    lines.forEach(function (line, i) {
      text(parent, cx, y + i * 14, line, { 'text-anchor': 'middle' });
    });
  }

  function axisLines(str, W) { return wrap(str, Math.floor((W - 8) / CHAR)).length; }

  /* Path of a horizontal bar from x0 (baseline, square) to x1 (rounded). */
  function hbar(x0, x1, y, t) {
    var r = Math.min(ROUND, Math.abs(x1 - x0) / 2, t / 2);
    var s = x1 >= x0 ? 1 : -1, sweep = x1 >= x0 ? 1 : 0;
    return 'M' + x0 + ',' + y + 'H' + (x1 - s * r) +
      'A' + r + ',' + r + ' 0 0 ' + sweep + ' ' + x1 + ',' + (y + r) +
      'V' + (y + t - r) +
      'A' + r + ',' + r + ' 0 0 ' + sweep + ' ' + (x1 - s * r) + ',' + (y + t) +
      'H' + x0 + 'Z';
  }

  /* Rows grouped by `category`; sets item.y and returns the rule positions. */
  function layoutRows(items, y0) {
    var y = y0, last = null, rules = [];
    items.forEach(function (it) {
      if (last !== null && it.category !== last) {
        rules.push(y + GROUP_GAP / 2);
        y += GROUP_GAP;
      }
      it.y = y;
      y += ROW;
      last = it.category;
    });
    return { end: y, rules: rules };
  }

  /* Invisible hit target that catches the pointer for a tooltip. */
  function hitRect(parent, x, y, w, h, label) {
    var r = el(parent, 'rect', { x: x, y: y, width: w, height: h,
      fill: 'transparent', 'pointer-events': 'all' });
    hover(r, label);
    return r;
  }

  /* ---- tooltip (one shared, positioned div) ----------------------------- */

  function tooltip() {
    if (tip) return tip;
    tip = document.createElement('div');
    var s = tip.style;
    s.position = 'absolute'; s.display = 'none'; s.pointerEvents = 'none';
    s.fontFamily = 'var(--sans, system-ui, sans-serif)'; s.fontSize = FONT + 'px';
    s.lineHeight = '1.3'; s.padding = '3px 7px'; s.whiteSpace = 'nowrap';
    s.background = 'var(--paper, #fff)'; s.color = 'var(--ink, #111)';
    s.border = '1px solid var(--rule, #ddd)'; s.zIndex = '10';
    document.body.appendChild(tip);
    return tip;
  }

  function moveTip(ev) {
    var t = tooltip();
    var maxLeft = root.scrollX + document.documentElement.clientWidth - t.offsetWidth - 8;
    t.style.left = Math.min(ev.pageX + 12, maxLeft) + 'px';
    t.style.top = (ev.pageY + 14) + 'px';
  }

  function hover(node, label) {
    node.addEventListener('mouseenter', function (ev) {
      var t = tooltip();
      t.textContent = label;
      t.style.display = 'block';
      moveTip(ev);
    });
    node.addEventListener('mousemove', moveTip);
    node.addEventListener('mouseleave', function () { tooltip().style.display = 'none'; });
  }

  /* ---- Figure 7: search gain per run ------------------------------------ */

  function drawGain(d) {
    var c = document.getElementById('fig7-chart');
    if (!c || !d.searchGain) return;
    var runs = d.searchGain, W = widthOf(c, 952), right = 20;
    var lo = 0, hi = 0, longest = 0;
    runs.forEach(function (r) {
      lo = Math.min(lo, r.gain); hi = Math.max(hi, r.gain);
      r.name = runName(r.runLabel);
      longest = Math.max(longest, r.name.row.length);
    });
    var left = Math.max(128, Math.round(longest * CHAR) + 12);
    var tk = ticks(lo, hi, 5);
    var plotW = W - left - right;
    function x(v) { return left + (v - tk.lo) / (tk.hi - tk.lo) * plotW; }

    /* Rows in data order, a small label above each alphabet group; the
       gridlines span the rows of a group and leave the label clear. */
    var y = 10, groups = [], g = null;
    runs.forEach(function (r) {
      if (!g || g.alphabet !== r.alphabet) {
        if (g) y += 10;
        g = { alphabet: r.alphabet, label: y + 12, y0: y + 20 };
        groups.push(g);
        y += 20;
      }
      r.y = y;
      y += ROW;
      g.y1 = y - 2;
    });
    var xLabel = 'gain in final reward (trained minus untrained network)';
    var axisY = y + 6, H = axisY + 24 + 14 * axisLines(xLabel, W);
    var svg = makeSvg(c, W, H, 'Gain in final reward from the trained network, one bar per run');

    groups.forEach(function (gr) {
      tk.values.forEach(function (v) { hairline(svg, x(v), gr.y0 - 2, x(v), gr.y1); });
      hairline(svg, x(0), gr.y0 - 2, x(0), gr.y1, C.ink2);
      var name = gr.alphabet === 'SED' ? 'SED alphabet, cycles of 12 blocks'
        : gr.alphabet === 'YXX' ? 'YXX alphabet, cycles of 8 blocks' : gr.alphabet;
      text(svg, 4, gr.label, name, { fill: C.ink2 });
    });
    tk.values.forEach(function (v) {
      text(svg, x(v), axisY + 15, fmt(v), { 'text-anchor': 'middle' });
    });
    axisLabel(svg, left + plotW / 2, axisY + 32, xLabel, W);
    runs.forEach(function (r) {
      text(svg, left - 8, r.y + BAR - 4, r.name.row, { 'text-anchor': 'end', fill: C.ink2 });
      el(svg, 'path', { d: hbar(x(0), x(r.gain), r.y, BAR), fill: C.accent,
        'class': r.gain < 0 ? 'bar neg' : 'bar' });
      hitRect(svg, left, r.y - 1, plotW, ROW, r.name.full);
    });
  }

  /* ---- Figure 12: scores on three banks --------------------------------- */

  function drawScores(d) {
    var c = document.getElementById('fig12-chart');
    if (!c || !d.scores) return;
    var W = widthOf(c, 952), labelW = 124, right = 8, gap = 18;
    var stacked = W < 600;
    var banks = d.banks || [];
    var hi = 0;
    Object.keys(d.scores).forEach(function (id) {
      d.scores[id].forEach(function (v) { hi = Math.max(hi, v); });
    });
    var tk = ticks(0, hi, 5);

    /* Rows: every sequence with a score, grouped in category order. */
    var items = [];
    d.categories.forEach(function (cat) {
      d.sequences.forEach(function (s) {
        if (s.category === cat && d.scores[s.id]) items.push({ seq: s, category: cat });
      });
    });
    var nRows = items.length, nRules = 0, lastCat = null;
    items.forEach(function (it) { if (lastCat !== null && it.category !== lastCat) nRules++; lastCat = it.category; });
    var rowsH = nRows * ROW + nRules * GROUP_GAP;

    var panelW = stacked ? W - labelW - right : (W - labelW - right - 2 * gap) / 3;
    var titleLines = 0;
    banks.forEach(function (b) { titleLines = Math.max(titleLines, wrap(b.label, Math.floor(panelW / CHAR)).length); });
    var titleH = titleLines * 14 + 10;
    var blockH = titleH + rowsH + 24;   /* title, rows and tick labels */
    var xLabel = 'reward over 216 microseconds (one point higher is ten times less error)';

    /* The best reference score on each bank, marked by a dashed line. */
    var bestRef = banks.map(function () { return -Infinity; });
    items.forEach(function (it) {
      if (!isReference(it.category)) return;
      d.scores[it.seq.id].forEach(function (v, b) {
        if (b < bestRef.length && v > bestRef[b]) bestRef[b] = v;
      });
    });

    /* Legend row: swatch and category name; wraps on narrow screens. */
    var legend = [], lx = 4, ly = 0;
    d.categories.forEach(function (cat) {
      var w = 15 + catLabel(cat).length * CHAR + 18;
      if (lx > 4 && lx + w > W - 4) { lx = 4; ly += 16; }
      legend.push({ cat: cat, x: lx, y: ly });
      lx += w;
    });
    var top = ly + 30;
    var lastAxisY = top + (stacked ? (banks.length - 1) * (blockH + 16) : 0) + titleH + rowsH + 2;
    var H = lastAxisY + 24 + 14 * axisLines(xLabel, W);
    var svg = makeSvg(c, W, H, 'Reward of each sequence on three simulated conditions, grouped by category');
    legend.forEach(function (it) {
      el(svg, 'rect', { x: it.x, y: it.y + 5, width: 10, height: 10, fill: catColour(it.cat) });
      text(svg, it.x + 15, it.y + 14, catLabel(it.cat), { fill: C.ink2 });
    });

    banks.forEach(function (bank, b) {
      var px = labelW + (stacked ? 0 : b * (panelW + gap));
      var py = top + (stacked ? b * (blockH + 16) : 0);
      function x(v) { return px + (v - tk.lo) / (tk.hi - tk.lo) * panelW; }
      wrap(bank.label, Math.floor(panelW / CHAR)).forEach(function (line, i) {
        text(svg, px, py + 12 + i * 14, line, { fill: C.ink2 });
      });
      var lay = layoutRows(items, py + titleH), axisY = lay.end + 2;
      tk.values.forEach(function (v) {
        hairline(svg, x(v), py + titleH - 4, x(v), axisY);
        text(svg, x(v), axisY + 15, fmt(v), { 'text-anchor': 'middle' });
      });
      lay.rules.forEach(function (ry) {
        hairline(svg, (stacked || b === 0) ? 4 : px, ry, px + panelW, ry);
      });
      items.forEach(function (it) {
        if (stacked || b === 0) {
          text(svg, labelW - 8, it.y + BAR - 4, it.seq.name, { 'text-anchor': 'end', fill: C.ink2 });
        }
        el(svg, 'path', { d: hbar(x(0), x(d.scores[it.seq.id][b]), it.y, BAR),
          fill: catColour(it.category), 'class': 'bar' });
        hitRect(svg, px, it.y - 1, panelW, ROW, it.seq.name + ', ' + catLabel(it.category));
      });
      if (isFinite(bestRef[b])) {
        el(svg, 'line', { x1: x(bestRef[b]), y1: py + titleH - 4, x2: x(bestRef[b]), y2: axisY,
          stroke: C.muted, 'stroke-width': 1, 'stroke-dasharray': '4 3' });
      }
    });
    axisLabel(svg, labelW + (W - labelW - right) / 2, lastAxisY + 32, xLabel, W);
  }

  /* ---- Figure 16: rollouts at first appearance -------------------------- */

  function drawFirstSeen(d) {
    var c = document.getElementById('fig16-chart');
    if (!c || !d.firstSeen) return;
    var W = widthOf(c, 952), left = 128, right = 20, top = 14, xmax = 300000;
    var plotW = W - left - right;
    function x(v) { return left + Math.min(v, xmax) / xmax * plotW; }

    var present = {}, byId = {};
    d.firstSeen.forEach(function (f) { present[f.seqId] = true; });
    var items = [];
    d.categories.forEach(function (cat) {
      d.sequences.forEach(function (s) {
        if (s.category === cat && present[s.id]) { var it = { seq: s, category: cat }; items.push(it); byId[s.id] = it; }
      });
    });
    var lay = layoutRows(items, top), axisY = lay.end + 4, H = axisY + 38;
    var svg = makeSvg(c, W, H, 'Rollout count at which each sequence first appeared in a run');

    for (var v = 0; v <= xmax; v += 50000) {
      hairline(svg, x(v), 8, x(v), axisY);
      text(svg, x(v), axisY + 15, v === 0 ? '0' : (v / 1000) + 'k', { 'text-anchor': 'middle' });
    }
    text(svg, left + plotW / 2, axisY + 32, 'rollouts', { 'text-anchor': 'middle' });
    lay.rules.forEach(function (ry) { hairline(svg, 4, ry, W - right, ry); });
    items.forEach(function (it) {
      text(svg, left - 8, it.y + BAR - 4, it.seq.name, { 'text-anchor': 'end', fill: C.ink2 });
    });
    d.firstSeen.forEach(function (f) {
      var it = byId[f.seqId];
      if (!it) return;
      var cx = x(f.rollouts), cy = it.y + ROW / 2;
      el(svg, 'circle', { cx: cx, cy: cy, r: 4, fill: catColour(it.category),
        stroke: C.paper, 'stroke-width': 2, 'paint-order': 'stroke' });
      var hit = el(svg, 'circle', { cx: cx, cy: cy, r: 10, fill: 'transparent', 'pointer-events': 'all' });
      hover(hit, runName(f.runLabel).full);
    });
  }

  /* ---- Figure 18: FunSearch trajectory ---------------------------------- */

  function drawFunsearch(d) {
    var c = document.getElementById('fig18-chart');
    if (!c || !d.funsearch || !d.funsearch.trajectory) return;
    var traj = d.funsearch.trajectory;
    var W = widthOf(c, 748), H = 240, left = 48, right = 16, top = 12, bottom = 40;
    var plotW = W - left - right, plotH = H - top - bottom;
    var n = traj.length, ymax = 5;
    traj.forEach(function (r) { ymax = Math.max(ymax, Math.ceil(r.score)); });
    var xmax = Math.max(n - 1, 1);
    function x(i) { return left + i / xmax * plotW; }
    function y(v) { return top + (1 - Math.max(0, v) / ymax) * plotH; }
    var svg = makeSvg(c, W, H, 'Score of each evaluation and the running best in the small FunSearch loop');

    for (var v = 0; v <= ymax; v++) {
      hairline(svg, left, y(v), left + plotW, y(v));
      text(svg, left - 8, y(v) + 4, String(v), { 'text-anchor': 'end' });
    }
    ticks(0, xmax, 6).values.forEach(function (v) {
      if (v > xmax) return;
      text(svg, x(v), top + plotH + 15, fmt(v), { 'text-anchor': 'middle' });
    });
    hairline(svg, left, top + plotH, left + plotW, top + plotH, C.ink2);
    text(svg, left + plotW / 2, H - 6, 'evaluation', { 'text-anchor': 'middle' });
    text(svg, 12, top + plotH / 2, 'score (simplified physics)',
      { 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + (top + plotH / 2) + ')' });

    var path = '';
    traj.forEach(function (r, i) {
      path += i === 0 ? 'M' + x(0) + ',' + y(r.best) : 'H' + x(i) + 'V' + y(r.best);
    });
    el(svg, 'path', { d: path, fill: 'none', stroke: catColour('FunSearch'),
      'stroke-width': 2, 'stroke-linejoin': 'round' });
    traj.forEach(function (r, i) {
      el(svg, 'circle', { cx: x(i), cy: y(r.score), r: 2.5, fill: C.muted });
    });
    var colW = plotW / Math.max(n, 1);
    traj.forEach(function (r, i) {
      /* The hover names the evaluation; the score is read from the axis, as
         elsewhere on the page. */
      var label = 'evaluation ' + i;
      hitRect(svg, x(i) - colW / 2, top, colW, plotH, label);
    });
  }

  /* ---- reveal on first sight -------------------------------------------- */

  /* Each chart container gains "in-view" once, when it first scrolls into
     sight; the stylesheet grows the bars from zero under that class. With
     reduced motion preferred, or without IntersectionObserver, the class is
     added at once and the bars are drawn in their final state. */
  function watchReveal() {
    var charts = document.querySelectorAll('.chart');
    var mq = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)');
    function show(c) { c.classList.add('in-view'); }
    if (!root.IntersectionObserver || (mq && mq.matches)) {
      Array.prototype.forEach.call(charts, show);
      return;
    }
    var io = new root.IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { show(e.target); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    Array.prototype.forEach.call(charts, function (c) { io.observe(c); });
  }

  /* ---- entry point ------------------------------------------------------ */

  function drawAll(data) {
    if (!data || typeof document === 'undefined') return;
    lastData = data;
    readColours();
    drawGain(data);
    drawScores(data);
    drawFirstSeen(data);
    drawFunsearch(data);
    if (!listening) {
      listening = true;
      var timer = null;
      function redrawIfResized() { if (widthsChanged()) drawAll(lastData); }
      function onResize() {
        clearTimeout(timer);
        timer = setTimeout(redrawIfResized, 150);
      }
      root.addEventListener('resize', onResize);
      /* A page drawn in a hidden tab measured zero widths; redraw when shown. */
      document.addEventListener('visibilitychange', onResize);
      /* A chart inside a closed details measured no width either; redraw as
         soon as the details opens, so the reveal grows bars of the right size. */
      Array.prototype.forEach.call(document.querySelectorAll('details'), function (dt) {
        dt.addEventListener('toggle', redrawIfResized);
      });
      var mq = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) mq.addEventListener('change', function () { drawAll(lastData); });
      watchReveal();
    }
  }

  var Charts = { drawAll: drawAll };
  root.Charts = Charts;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Charts;
  }
})(typeof window !== 'undefined' ? window : globalThis);
