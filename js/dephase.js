/*
 * dephase.js: the illustration in Section 1. Six classical spins in the
 * rotating frame, each precessing about the field (z) at its own offset.
 * Left panel: no pulses, the fan opens and stays open. Right panel: an
 * instantaneous 90-degree pulse about x, then about y, six times; the
 * field as the spins see it then points along +y, -x, -z, -y, +x, +z for
 * one window each, and the fan closes again at the end of every cycle up
 * to a residue of second order in offset times window.
 *
 * Everything on screen is computed: right-handed rotations of unit
 * 3-vectors, an orthographic projection with z up, SVG arrows drawn back
 * to front. Classic script: defines window.Dephase.
 */
(function (root) {
  'use strict';

  var N_SPINS = 6;
  var WINDOWS_PER_CYCLE = 6;
  var CYCLES_PER_LOOP = 2;
  var DELTA_MAX = 0.35;        /* radians of precession per window, largest offset */
  var WINDOW_MS = 550;
  var PULSE_MS = 260;
  var HOLD_MS = 1100;
  var ARROW = 92;              /* pixels per unit vector */
  var AZIMUTH = 45 * Math.PI / 180;
  var ELEVATION = 28 * Math.PI / 180;
  var W = 300, H = 250, CX = 150, CY = 132;

  /* Offsets, evenly spaced and symmetric about zero. */
  var deltas = [];
  for (var i = 0; i < N_SPINS; i++) {
    deltas.push(-DELTA_MAX + 2 * DELTA_MAX * i / (N_SPINS - 1));
  }

  /* ---- vectors and rotations ------------------------------------------ */

  function rotX(a, v) {
    var c = Math.cos(a), s = Math.sin(a);
    return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
  }
  function rotY(a, v) {
    var c = Math.cos(a), s = Math.sin(a);
    return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
  }
  function rotZ(a, v) {
    var c = Math.cos(a), s = Math.sin(a);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
  }
  function rotAbout(axis, a, v) {
    return axis === 'x' ? rotX(a, v) : rotY(a, v);
  }
  function pulseAxis(k) {       /* k = 0, 1, 2, ... */
    return k % 2 === 0 ? 'x' : 'y';
  }

  /* The field as the spins see it after k pulses: the lab z axis carried
     back through the pulses applied so far, U_rf^T z. */
  function fieldSeen(k) {
    var v = [0, 0, 1];
    for (var j = k - 1; j >= 0; j--) v = rotAbout(pulseAxis(j), -Math.PI / 2, v);
    return v;
  }
  function axisName(v) {
    var names = ['x', 'y', 'z'];
    for (var i = 0; i < 3; i++) {
      if (Math.abs(v[i]) > 0.999) return (v[i] > 0 ? '+' : '−') + names[i];
    }
    return '?';
  }

  /* The cycle closes: six pulses carry z back to z, and x and y likewise. */
  function cycleCloses() {
    var basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], err = 0;
    for (var b = 0; b < 3; b++) {
      var v = basis[b];
      for (var k = 0; k < WINDOWS_PER_CYCLE; k++) v = rotAbout(pulseAxis(k), Math.PI / 2, v);
      for (var i = 0; i < 3; i++) err = Math.max(err, Math.abs(v[i] - basis[b][i]));
    }
    return err < 1e-12;
  }

  /* ---- projection ------------------------------------------------------ */

  var ca = Math.cos(AZIMUTH), sa = Math.sin(AZIMUTH);
  var cb = Math.cos(ELEVATION), sb = Math.sin(ELEVATION);
  var RIGHT = [-sa, ca, 0];
  var UP = [-sb * ca, -sb * sa, cb];
  var TOWARD = [cb * ca, cb * sa, sb];

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function project(v) {
    return { x: CX + ARROW * dot(v, RIGHT), y: CY - ARROW * dot(v, UP), depth: dot(v, TOWARD) };
  }

  /* ---- SVG ------------------------------------------------------------- */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs, parent) {
    var e = document.createElementNS(SVG_NS, name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function fmt(x) { return (Math.round(x * 100) / 100).toString(); }

  function drawFrame(svg) {
    var g = el('g', { 'class': 'dp-frame' }, svg);
    /* equator: the unit circle in the xy plane */
    var d = '';
    for (var i = 0; i <= 72; i++) {
      var a = 2 * Math.PI * i / 72, p = project([Math.cos(a), Math.sin(a), 0]);
      d += (i ? ' L ' : 'M ') + fmt(p.x) + ' ' + fmt(p.y);
    }
    el('path', { 'class': 'dp-equator', d: d + ' Z' }, g);
    /* axes */
    var axes = [
      { v: [1, 0, 0], label: 'x' },
      { v: [0, 1, 0], label: 'y' },
      { v: [0, 0, 1], label: 'z, the field' }
    ];
    axes.forEach(function (ax) {
      var a = project([-1.2 * ax.v[0], -1.2 * ax.v[1], -1.2 * ax.v[2]]);
      var b = project([1.2 * ax.v[0], 1.2 * ax.v[1], 1.2 * ax.v[2]]);
      el('line', { 'class': 'dp-axis', x1: fmt(a.x), y1: fmt(a.y), x2: fmt(b.x), y2: fmt(b.y) }, g);
      var t = project([1.34 * ax.v[0], 1.34 * ax.v[1], 1.34 * ax.v[2]]);
      var text = el('text', { 'class': 'dp-axis-label', x: fmt(t.x), y: fmt(t.y + 4),
        'text-anchor': ax.label === 'y' ? 'start' : (ax.label === 'x' ? 'end' : 'middle') }, g);
      text.textContent = ax.label;
    });
  }

  function makeArrows(svg) {
    var g = el('g', { 'class': 'dp-spins' }, svg), arrows = [];
    for (var i = 0; i < N_SPINS; i++) {
      var a = el('g', { 'class': 'dp-spin dp-spin-' + i }, g);
      arrows.push({
        g: a,
        line: el('line', { 'class': 'dp-shaft', x1: CX, y1: CY, x2: CX, y2: CY }, a),
        head: el('polygon', { 'class': 'dp-head', points: '' }, a)
      });
    }
    return { g: g, arrows: arrows };
  }

  function drawArrows(set, spins) {
    var order = [];
    for (var i = 0; i < N_SPINS; i++) order.push({ i: i, p: project(spins[i]) });
    order.sort(function (a, b) { return a.p.depth - b.p.depth; });   /* far first */
    order.forEach(function (o) {
      var a = set.arrows[o.i], p = o.p;
      var dx = p.x - CX, dy = p.y - CY, len = Math.sqrt(dx * dx + dy * dy);
      var hx = 9, hy = 4;
      if (len < 1e-6) { dx = 1; dy = 0; len = 1; }
      var ux = dx / len, uy = dy / len;
      var bx = p.x - hx * ux, by = p.y - hx * uy;
      a.line.setAttribute('x2', fmt(p.x - 6 * ux));
      a.line.setAttribute('y2', fmt(p.y - 6 * uy));
      a.head.setAttribute('points',
        fmt(p.x) + ',' + fmt(p.y) + ' ' +
        fmt(bx - hy * uy) + ',' + fmt(by + hy * ux) + ' ' +
        fmt(bx + hy * uy) + ',' + fmt(by - hy * ux));
      set.g.appendChild(a.g);               /* re-append in depth order */
    });
  }

  /* ---- the loop -------------------------------------------------------- */

  function easeInOut(f) { return f < 0.5 ? 2 * f * f : 1 - 2 * (1 - f) * (1 - f); }

  function mount(rootEl) {
    if (!rootEl) return null;
    rootEl.innerHTML = '';
    if (!cycleCloses()) {
      if (root.console) root.console.error('dephase.js: the six-pulse cycle does not close');
    }

    var panels = document.createElement('div');
    panels.className = 'dp-panels';
    rootEl.appendChild(panels);

    function panel(title) {
      var box = document.createElement('div');
      box.className = 'dp-panel';
      var h = document.createElement('p');
      h.className = 'dp-title';
      h.textContent = title;
      box.appendChild(h);
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'dp-svg', role: 'img' }, box);
      drawFrame(svg);
      var set = makeArrows(svg);
      var status = document.createElement('p');
      status.className = 'dp-status';
      box.appendChild(status);
      panels.appendChild(box);
      return { svg: svg, set: set, status: status };
    }
    var left = panel('Left alone');
    var right = panel('Under pulses');
    left.svg.setAttribute('aria-label', 'Six spin arrows fanning out about the field axis with no pulses');
    right.svg.setAttribute('aria-label', 'Six spin arrows turned by pulses and closing up again at the end of each cycle');

    var controls = document.createElement('div');
    controls.className = 'dp-controls';
    var button = document.createElement('button');
    button.type = 'button';
    controls.appendChild(button);
    rootEl.appendChild(controls);

    /* State. The schedule per loop: for k in 0..11, pulse k (right panel
       only) then window k (both panels), then a hold, then a reset. The
       physical clock advances only during windows. */
    var spinsL, spinsR, startL, startR, mode, k, tMode;

    function reset() {
      spinsL = []; spinsR = []; startL = []; startR = [];
      for (var i = 0; i < N_SPINS; i++) {
        spinsL.push([1, 0, 0]); spinsR.push([1, 0, 0]);
        startL.push([1, 0, 0]); startR.push([1, 0, 0]);
      }
      mode = 'pulse'; k = 0; tMode = 0;
    }

    function setStatus() {
      var w = (k % WINDOWS_PER_CYCLE) + 1;
      var cycle = Math.floor(k / WINDOWS_PER_CYCLE) + 1;
      if (mode === 'hold') {
        left.status.textContent = 'after ' + k + ' windows: still spread';
        right.status.textContent = 'after ' + k + ' windows: closed again at the end of each cycle';
        return;
      }
      left.status.textContent = 'window ' + (k + 1) + ' of ' + (WINDOWS_PER_CYCLE * CYCLES_PER_LOOP);
      if (mode === 'pulse') {
        right.status.textContent = 'pulse about ' + pulseAxis(k);
      } else {
        right.status.textContent = 'window ' + w + ' of ' + WINDOWS_PER_CYCLE + ', cycle ' + cycle +
          ': field along ' + axisName(fieldSeen(k + 1)) + ' as the spins see it';
      }
    }

    function render() {
      drawArrows(left.set, spinsL);
      drawArrows(right.set, spinsR);
      setStatus();
    }

    function finishMode() {
      var i;
      if (mode === 'pulse') {
        for (i = 0; i < N_SPINS; i++) startR[i] = rotAbout(pulseAxis(k), Math.PI / 2, startR[i]);
        mode = 'window';
      } else if (mode === 'window') {
        for (i = 0; i < N_SPINS; i++) {
          startL[i] = rotZ(deltas[i], startL[i]);
          startR[i] = rotZ(deltas[i], startR[i]);
        }
        k += 1;
        mode = k < WINDOWS_PER_CYCLE * CYCLES_PER_LOOP ? 'pulse' : 'hold';
      } else {
        reset();
      }
      tMode = 0;
    }

    function advance(dt) {
      tMode += dt;
      var span = mode === 'pulse' ? PULSE_MS : (mode === 'window' ? WINDOW_MS : HOLD_MS);
      while (tMode >= span) {
        tMode -= span;
        finishMode();
        span = mode === 'pulse' ? PULSE_MS : (mode === 'window' ? WINDOW_MS : HOLD_MS);
      }
      var f = tMode / span, i;
      if (mode === 'pulse') {
        var a = easeInOut(f) * Math.PI / 2;
        for (i = 0; i < N_SPINS; i++) { spinsR[i] = rotAbout(pulseAxis(k), a, startR[i]); spinsL[i] = startL[i]; }
      } else if (mode === 'window') {
        for (i = 0; i < N_SPINS; i++) {
          spinsL[i] = rotZ(deltas[i] * f, startL[i]);
          spinsR[i] = rotZ(deltas[i] * f, startR[i]);
        }
      } else {
        for (i = 0; i < N_SPINS; i++) { spinsL[i] = startL[i]; spinsR[i] = startR[i]; }
      }
    }

    /* Jump to the end of the loop: the frame shown when motion is off. */
    function toEnd() {
      reset();
      while (mode !== 'hold') finishMode();
      advance(0);
    }

    var reduced = typeof root.matchMedia === 'function' &&
      root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var playing = !reduced, last = null, frame = null;

    function tick(now) {
      frame = null;
      if (!playing) return;
      if (last !== null) advance(Math.min(now - last, 100));
      last = now;
      render();
      frame = root.requestAnimationFrame(tick);
    }
    function play() {
      if (playing) return;
      playing = true; last = null;
      button.textContent = 'Pause';
      if (mode === 'hold' && tMode === 0 && k > 0) reset();
      frame = root.requestAnimationFrame(tick);
    }
    function pause() {
      playing = false;
      button.textContent = 'Play';
      if (frame !== null) { root.cancelAnimationFrame(frame); frame = null; }
    }
    button.addEventListener('click', function () { if (playing) pause(); else play(); });

    if (reduced) {
      toEnd();
      render();
      button.textContent = 'Play';
    } else {
      reset();
      advance(0);
      render();
      button.textContent = 'Pause';
      frame = root.requestAnimationFrame(tick);
    }

    return { play: play, pause: pause, fieldSeen: fieldSeen, axisName: axisName };
  }

  root.Dephase = { mount: mount, fieldSeen: fieldSeen, axisName: axisName, cycleCloses: cycleCloses };
})(typeof window !== 'undefined' ? window : this);
