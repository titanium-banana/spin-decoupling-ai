/*
 * demo.js: Figure 1, the live search.
 *
 * Mounts into #demo the action buttons (one main button whose text follows
 * the state, Reset, and a toggle for picking the blocks by hand), a folded
 * Settings panel, the twelve slots of the sequence, a strip with the pulses
 * of the sequence so far on a time axis, the decision view (visit counts of
 * the search in progress against the prior the network assigned), the
 * progress line of the episode and, once the sequence is complete, its
 * reward beside the spins left alone and the reference sequences. The
 * search runs one decision at a time inside requestAnimationFrame, a few
 * simulations per frame, so the bars can be watched growing.
 *
 * States of the figure:
 *   idle     nothing running; slots may hold a prefix (Manual mode, or a
 *            prefix kept across a change of mode or physics)
 *   running  a decision advances every frame
 *   holding  a decision has just chosen its block; the bars stay for a
 *            moment with the chosen one at full strength
 *   paused   Pause pressed during running or holding
 *   done     twelve blocks; the reward and the reference bars are shown
 *
 * The main button reads Start (idle), Pause (running), Resume (paused),
 * Run again (done) and, in Manual mode with a partial sequence, Let the
 * search finish. Reset restores the default settings and the first seed.
 *
 * The page passes the globals it loaded (SITE_DATA, ENSEMBLE, NET_TRAINED,
 * NET_UNTRAINED, PulseSim, PolicyNet, Search) as `deps`. NET_UNTRAINED is
 * optional; a missing dependency other than NET_UNTRAINED produces a
 * one-line message inside the figure and no error. The
 * composed sequence is scored over two cycles (72 free-evolution windows), the
 * convention of the reference values in SITE_DATA.demoRefs.
 *
 * Classic script: defines window.Demo; also exported for Node.
 */
(function (root) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  var ACTIONS = 8;
  var CYCLE = 12;
  var SIMS_PER_FRAME = { slow: 8, fast: 120 };   /* simulations per frame */
  var HOLD_MS = { slow: 500, fast: 150 };        /* pause after a decision */
  var LANDED_MS = 600;        /* a filled slot carries class "landed" this long */
  var GROW_MS = 400;          /* the "this sequence" result bar grows this long */
  var SEED_BASE = 20260807;   /* seed of run k is SEED_BASE + k */
  var AXIS_MAX = 12;          /* reward axis of the result chart */
  var MIN_WIDTH = 280, MAX_WIDTH = 760, FALLBACK_WIDTH = 560;
  var BAR = 16, ROW = 18;     /* result chart: bar thickness and row pitch */
  /* The pulse strip under the slots. One block in microseconds, as in the
     Section 1 sketch: a pulse, a free interval, a pulse, a free interval,
     then the wait; which axes the two pulses turn about comes from the
     simulator's block table (PulseSim.tokens). */
  var PULSE_US = 1, FREE_US = 2, WAIT_US = 3;
  var BLOCK_US = 2 * (PULSE_US + FREE_US) + WAIT_US;   /* 9 */
  var CYCLE_US = CYCLE * BLOCK_US;                      /* 108 */
  var TL_PULSE_H = 18;        /* px, a pulse rectangle; above or below the axis */
  var TL_MIN_PULSE_W = 3;     /* px, so a 1 us pulse stays visible when narrow */
  var TL_LEGEND = ['x in green, y in blue;', 'below the line means the negative axis'];
  var C_OPTIONS = [4, 9.5, 15, 20.5];
  var SIM_OPTIONS = [100, 250, 500];
  var CATEGORY_CLASS = {
    'Reference': 'demo-cat-ref', 'FunSearch': 'demo-cat-fun',
    'RL sequence': 'demo-cat-rl', 'Archive pick': 'demo-cat-pick',
    'Hand-assembled': 'demo-cat-hand'
  };
  var LEGEND = 'Each block, A to H, is a fixed pair of 90-degree pulses ' +
    'followed by a free-evolution window. The simulator is the one used ' +
    'in training: 3 spins, 5 ensemble members.';
  var MISSING_TEXT = 'The live search could not load all its files. ' +
    'Reload the page to try again.';
  var MANUAL_TEXT = { search: 'Pick the blocks yourself', manual: 'Back to the search' };

  /* ---- DOM helpers ------------------------------------------------------ */

  function setAttrs(e, attrs) {
    if (!attrs) return e;
    Object.keys(attrs).forEach(function (k) {
      if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    });
    return e;
  }

  function h(doc, tag, attrs, text) {
    var e = doc.createElement(tag);
    setAttrs(e, attrs);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function s(doc, tag, attrs, text) {
    var e = doc.createElementNS(SVG_NS, tag);
    setAttrs(e, attrs);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function clear(e) {
    while (e.firstChild) e.removeChild(e.firstChild);
  }

  function makeSelect(doc, id, options, value) {
    var sel = h(doc, 'select', { id: id });
    options.forEach(function (opt) {
      var o = h(doc, 'option', { value: String(opt.value) }, opt.label);
      if (String(opt.value) === String(value)) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    });
    sel.value = String(value);
    return sel;
  }

  function labelled(doc, text, control) {
    var l = h(doc, 'label', { 'class': 'demo-field' });
    l.appendChild(doc.createTextNode(text + ' '));
    l.appendChild(control);
    return l;
  }

  function fmt(x, digits) {
    return Number(x).toFixed(digits);
  }

  /* The pulses of one block, read from the simulator's block table: the
     pulse entries of a row are 90-degree turns about that axis, and the
     remaining entry is the bare delay that ends the block. Returns the
     axes in order as '+x', '-x', '+y' or '-y'; an unknown block gives []. */
  var PULSE_AXIS = { 'X': '+x', '-X': '-x', 'Y': '+y', '-Y': '-y' };

  function blockPulses(tokens, action) {
    var row = tokens && tokens[action];
    var axes = [];
    if (!row) return axes;
    for (var i = 0; i < row.length; i++) {
      if (PULSE_AXIS[row[i]]) axes.push(PULSE_AXIS[row[i]]);
    }
    return axes;
  }

  /* ---- mount ------------------------------------------------------------ */

  function mount(container, deps) {
    if (!container) return null;
    var doc = container.ownerDocument || root.document;
    try {
      return mountInner(container, deps || {}, doc);
    } catch (err) {
      clear(container);
      container.appendChild(h(doc, 'p', { 'class': 'demo-status' },
        'The live search could not start: ' +
        (err && err.message ? err.message : String(err)) + '.'));
      return null;
    }
  }

  function mountInner(container, deps, doc) {
    var SITE = deps.SITE_DATA, ENS = deps.ENSEMBLE;
    var Sim = deps.PulseSim, Net = deps.PolicyNet, Srch = deps.Search;
    var nets = {};
    if (deps.NET_TRAINED && deps.NET_TRAINED.params) nets.trained = deps.NET_TRAINED.params;
    if (deps.NET_UNTRAINED && deps.NET_UNTRAINED.params) nets.untrained = deps.NET_UNTRAINED.params;

    var missing = [];
    if (!SITE || !SITE.physicsPresets || !SITE.demoRefs) missing.push('SITE_DATA');
    if (!ENS || !ENS.z) missing.push('ENSEMBLE');
    if (!nets.trained) missing.push('NET_TRAINED');
    if (!Sim || typeof Sim.build !== 'function') missing.push('PulseSim');
    if (!Net || typeof Net.evaluate !== 'function') missing.push('PolicyNet');
    if (!Srch || typeof Srch.createDecision !== 'function') missing.push('Search');
    clear(container);
    if (missing.length) {
      container.appendChild(h(doc, 'p', { 'class': 'demo-status',
        'data-missing': missing.join(' ') }, MISSING_TEXT));
      return null;
    }

    var presets = SITE.physicsPresets;
    var presetIds = Object.keys(presets);
    var PRESET_LABEL = { ideal: 'training, no errors', errors: 'the ranking condition' };

    /* lazily built, once per preset and per network */
    var ctxCache = {}, netCache = {}, freeCache = {};
    function ctxFor(preset) {
      if (!ctxCache[preset]) ctxCache[preset] = Sim.build(ENS.z, presets[preset]);
      return ctxCache[preset];
    }
    function netFor(kind) {
      if (kind === 'none' || !nets[kind]) return null;
      if (!netCache[kind]) netCache[kind] = Net.create(nets[kind]);
      return netCache[kind];
    }
    /* reward of the spins left alone for 72 windows, the "no pulses" row */
    function freeRewardFor(preset) {
      if (!(preset in freeCache)) {
        freeCache[preset] = Sim.freeEvolutionReward(ctxFor(preset), 72);
      }
      return freeCache[preset];
    }
    function categoryOf(seqId) {
      var list = SITE.sequences || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === seqId) return list[i].category;
      }
      return null;
    }

    /* The settings Reset restores; the first run after Reset replays the
       first seed. */
    var DEFAULTS = {
      prior: nets.trained ? 'trained' : (nets.untrained ? 'untrained' : 'none'),
      cInit: 9.5,
      nSims: 500,
      speed: 'slow',
      preset: presets.ideal ? 'ideal' : presetIds[0]
    };

    /* Build the first context and network now, so that broken data is
       reported by the mount guard and the first Start is instant. */
    var state = {
      mode: 'search',            /* 'search' | 'manual' */
      prior: DEFAULTS.prior,
      cInit: DEFAULTS.cInit,
      nSims: DEFAULTS.nSims,
      speed: DEFAULTS.speed,
      preset: DEFAULTS.preset,
      phase: 'idle',             /* idle | running | holding | paused | done */
      pausedPhase: null,
      prefix: [],
      decision: null,
      decisionNet: null,
      snap: null,
      chosen: null,
      landed: -1,                /* slot flashed by the last decision, or -1 */
      rng: null,
      runCounter: 0,
      simsBefore: 0,             /* simulations of the completed decisions */
      xNow: 0,
      best: null,                /* best one-cycle reward scored this episode */
      progress: [],              /* [{x, y}] where the best improved */
      result: null,              /* {reward, preset, fresh} */
      raf: 0,
      holdUntil: 0,
      width: FALLBACK_WIDTH
    };

    ctxFor(state.preset);
    netFor(state.prior);

    /* ---- build the DOM ------------------------------------------------- */

    var inner = h(doc, 'div', { 'class': 'demo-inner' });
    container.appendChild(inner);

    /* row 1: the action buttons */
    var actions = h(doc, 'div', { 'class': 'demo-actions' });
    var startBtn = h(doc, 'button', { type: 'button', id: 'demo-start',
      'class': 'demo-primary' }, 'Start');
    var resetBtn = h(doc, 'button', { type: 'button', id: 'demo-reset' }, 'Reset');
    var manualBtn = h(doc, 'button', { type: 'button', id: 'demo-manual' },
      MANUAL_TEXT.search);
    actions.appendChild(startBtn);
    actions.appendChild(resetBtn);
    actions.appendChild(manualBtn);
    inner.appendChild(actions);

    /* the settings fold; its summary notes the values that differ from
       the defaults */
    var settings = h(doc, 'details', { 'class': 'demo-settings' });
    var summary = h(doc, 'summary', null, 'Settings');
    var settingsNote = h(doc, 'span', { 'class': 'demo-settings-note' });
    summary.appendChild(settingsNote);
    settings.appendChild(summary);
    var controls = h(doc, 'div', { 'class': 'demo-controls' });
    var priorOptions = [];
    if (nets.trained) priorOptions.push({ value: 'trained', label: 'trained' });
    if (nets.untrained) priorOptions.push({ value: 'untrained', label: 'untrained' });
    priorOptions.push({ value: 'none', label: 'none' });
    var priorSel = makeSelect(doc, 'demo-prior', priorOptions, state.prior);
    var cSel = makeSelect(doc, 'demo-c', C_OPTIONS.map(function (c) {
      return { value: c, label: String(c) };
    }), state.cInit);
    var simsSel = makeSelect(doc, 'demo-sims', SIM_OPTIONS.map(function (n) {
      return { value: n, label: String(n) };
    }), state.nSims);
    var speedSel = makeSelect(doc, 'demo-speed',
      [{ value: 'slow', label: 'slow' }, { value: 'fast', label: 'fast' }], state.speed);
    var physicsSel = makeSelect(doc, 'demo-physics', presetIds.map(function (id) {
      return { value: id, label: PRESET_LABEL[id] || id };
    }), state.preset);
    controls.appendChild(labelled(doc, 'network', priorSel));
    controls.appendChild(labelled(doc, 'exploration constant c', cSel));
    controls.appendChild(labelled(doc, 'simulations per decision', simsSel));
    controls.appendChild(labelled(doc, 'speed', speedSel));
    controls.appendChild(labelled(doc, 'physics', physicsSel));
    settings.appendChild(controls);
    inner.appendChild(settings);

    /* row 2: the twelve slots and, in Manual mode, the palette */
    var slotsRow = h(doc, 'div', { 'class': 'demo-slots', id: 'demo-slots',
      role: 'group', 'aria-label': 'the sequence' });
    var slots = [];
    for (var i = 0; i < CYCLE; i++) {
      var slot = h(doc, 'button', { type: 'button', 'class': 'demo-slot',
        'data-index': i, disabled: 'disabled' });
      slot.addEventListener('click', slotClick(i));
      slots.push(slot);
      slotsRow.appendChild(slot);
    }
    inner.appendChild(slotsRow);

    /* row 2b: the pulses of the sequence so far on a time axis; left out when
       the simulator has no block table to read them from */
    var TOKENS = Sim.tokens && Sim.tokens.length === ACTIONS ? Sim.tokens : null;
    var tlSvg = null;
    if (TOKENS) {
      inner.appendChild(h(doc, 'p', { 'class': 'demo-row-label' }, 'the pulses of this sequence'));
      tlSvg = s(doc, 'svg', { id: 'demo-timeline', 'class': 'demo-timeline', role: 'img',
        'aria-label': 'the pulses of the sequence so far on a time axis' });
      inner.appendChild(tlSvg);
    }

    var palette = h(doc, 'div', { 'class': 'demo-palette', id: 'demo-palette' });
    var blockBtns = [];
    for (var a = 0; a < ACTIONS; a++) {
      var b = h(doc, 'button', { type: 'button', 'class': 'demo-block',
        'data-action': a, title: 'add block ' + LETTERS[a] }, LETTERS[a]);
      b.addEventListener('click', blockClick(a));
      blockBtns.push(b);
      palette.appendChild(b);
    }
    palette.hidden = true;
    inner.appendChild(palette);

    /* row 3: the decision view */
    var decisionWrap = h(doc, 'div', { 'class': 'demo-decision' });
    var decSvg = s(doc, 'svg', { id: 'demo-bars', role: 'img',
      'aria-label': 'visits to each block at this decision' });
    decisionWrap.appendChild(decSvg);
    var decText = h(doc, 'p', { 'class': 'demo-text', id: 'demo-decision-text' });
    var decStep = h(doc, 'span', { 'class': 'demo-decision-step' });
    var decSims = h(doc, 'span', { 'class': 'demo-decision-sims' });
    var decValue = h(doc, 'span', { 'class': 'demo-decision-value' });
    decText.appendChild(decStep);
    decText.appendChild(decSims);
    decText.appendChild(decValue);
    decisionWrap.appendChild(decText);
    inner.appendChild(decisionWrap);

    /* row 4: the progress line */
    var progressWrap = h(doc, 'div', { 'class': 'demo-progress' });
    var progSvg = s(doc, 'svg', { id: 'demo-progress', role: 'img',
      'aria-label': 'best reward found so far, one cycle' });
    progressWrap.appendChild(progSvg);
    inner.appendChild(progressWrap);

    /* row 5: the result */
    var resultWrap = h(doc, 'div', { 'class': 'demo-result', id: 'demo-result' });
    var resultText = h(doc, 'p', { 'class': 'demo-text demo-result-text',
      id: 'demo-result-text' });
    var resultSvg = s(doc, 'svg', { id: 'demo-result-chart', role: 'img',
      'aria-label': 'reward of this sequence beside the spins left alone, the standard sequences and our sequences' });
    resultWrap.appendChild(resultText);
    resultWrap.appendChild(resultSvg);
    resultWrap.hidden = true;
    inner.appendChild(resultWrap);

    inner.appendChild(h(doc, 'p', { 'class': 'demo-legend' }, LEGEND));
    var status = h(doc, 'p', { 'class': 'demo-status', id: 'demo-status' });
    inner.appendChild(status);

    /* ---- the frame loop ------------------------------------------------ */

    var requestFrame = typeof root.requestAnimationFrame === 'function' ?
      function (f) { return root.requestAnimationFrame(f); } :
      function (f) { return setTimeout(function () { f(Date.now()); }, 16); };
    var cancelFrame = typeof root.cancelAnimationFrame === 'function' ?
      function (id) { root.cancelAnimationFrame(id); } :
      function (id) { clearTimeout(id); };

    function schedule() {
      if (!state.raf) state.raf = requestFrame(frame);
    }

    function stopLoop() {
      if (state.raf) { cancelFrame(state.raf); state.raf = 0; }
    }

    function frame(now) {
      state.raf = 0;
      if (state.phase !== 'running' && state.phase !== 'holding') return;
      try {
        if (state.phase === 'holding') {
          if (now < state.holdUntil) { schedule(); return; }
          startDecision();
        }
        var snap = state.decision.step(SIMS_PER_FRAME[state.speed] || 8);
        state.snap = snap;
        recordProgress(snap);
        if (snap.done) completeDecision(now);
        drawDecision();
        drawProgress();
        if (state.phase === 'running' || state.phase === 'holding') schedule();
      } catch (err) {
        stopLoop();
        state.decision = null;
        state.phase = 'idle';
        setStatus('The search stopped: ' +
          (err && err.message ? err.message : String(err)) + '.');
        updateControls();
      }
    }

    function seedOf(counter) {
      return (SEED_BASE + counter) >>> 0;
    }

    function startDecision() {
      var net = netFor(state.prior);
      if (!state.rng) state.rng = Srch.makeRng(seedOf(state.runCounter));
      state.decisionNet = net;
      state.decision = Srch.createDecision({
        ctx: ctxFor(state.preset), net: net, prefix: state.prefix,
        cInit: state.cInit, nSims: state.nSims, rng: state.rng
      });
      state.snap = state.decision.snapshot();
      state.chosen = null;
      state.phase = 'running';
      drawSlots();
      updateControls();
    }

    function completeDecision(now) {
      var pick = state.decision.choose();
      state.simsBefore += state.decision.nSims;
      state.xNow = state.simsBefore;
      state.decision = null;
      state.chosen = pick.action;
      if (pick.action === null) {
        state.phase = 'idle';
        setStatus('The search made no visits; press Start to try again.');
        updateControls();
        return;
      }
      state.prefix.push(pick.action);
      markLanded(state.prefix.length - 1);
      drawSlots();
      if (state.prefix.length >= CYCLE) {
        finish();
        drawResult();
        updateControls();
      } else {
        state.phase = 'holding';
        state.holdUntil = now + (HOLD_MS[state.speed] || 300);
        updateControls();
      }
    }

    function recordProgress(snap) {
      var x = state.simsBefore + snap.nDone;
      if (snap.bestReward !== null && snap.bestReward !== undefined &&
          (state.best === null || snap.bestReward > state.best)) {
        state.best = snap.bestReward;
        state.progress.push({ x: x, y: state.best });
      }
      state.xNow = x;
    }

    /* Scores the full sequence; the caller draws. A fresh result grows its
       bar once in drawResult. */
    function finish() {
      stopLoop();
      var ctx = ctxFor(state.preset);
      var reward = Sim.reward(ctx, state.prefix, 2);
      state.result = { reward: reward, preset: state.preset, fresh: true };
      state.phase = 'done';
      setStatus('');
    }

    /* The slot that just received a block flashes for LANDED_MS. */
    var landedTimer = 0;

    function clearLanded() {
      if (landedTimer) { clearTimeout(landedTimer); landedTimer = 0; }
      state.landed = -1;
    }

    function markLanded(index) {
      clearLanded();
      state.landed = index;
      landedTimer = setTimeout(function () {
        landedTimer = 0;
        state.landed = -1;
        drawSlots();
      }, LANDED_MS);
    }

    /* ---- actions ------------------------------------------------------- */

    function start() {
      if (state.mode !== 'search') return;
      if (state.phase === 'paused') {
        state.phase = state.pausedPhase === 'holding' ? 'holding' : 'running';
        state.pausedPhase = null;
        setStatus('');
        schedule();
        updateControls();
        return;
      }
      if (state.phase !== 'idle') return;
      if (state.prefix.length >= CYCLE) {
        finish();
        drawResult();
        updateControls();
        return;
      }
      setStatus('');
      startDecision();
      schedule();
    }

    function pause() {
      if (state.phase !== 'running' && state.phase !== 'holding') return;
      state.pausedPhase = state.phase;
      state.phase = 'paused';
      stopLoop();
      setStatus('paused');
      updateControls();
    }

    function reset() {
      stopLoop();
      clearLanded();
      state.prefix = [];
      state.decision = null;
      state.decisionNet = null;
      state.snap = null;
      state.chosen = null;
      state.rng = null;
      state.simsBefore = 0;
      state.xNow = 0;
      state.best = null;
      state.progress = [];
      state.result = null;
      state.phase = 'idle';
      state.pausedPhase = null;
      setStatus('');
      drawAll();
    }

    /* Reset: default settings, the first seed, the fold closed, Manual
       mode left, then a plain reset. */
    function resetAll() {
      stopLoop();
      state.mode = 'search';
      state.prior = DEFAULTS.prior;
      state.cInit = DEFAULTS.cInit;
      state.nSims = DEFAULTS.nSims;
      state.speed = DEFAULTS.speed;
      state.preset = DEFAULTS.preset;
      priorSel.value = state.prior;
      cSel.value = String(state.cInit);
      simsSel.value = String(state.nSims);
      speedSel.value = state.speed;
      physicsSel.value = state.preset;
      state.runCounter = 0;
      settings.open = false;
      reset();
    }

    function runAgain() {
      state.runCounter += 1;
      reset();
      if (state.mode === 'search') start();
    }

    function setMode(mode) {
      if (mode === state.mode) return;
      stopLoop();
      state.mode = mode;
      state.decision = null;
      state.decisionNet = null;
      state.snap = null;
      state.chosen = null;
      if (state.phase !== 'done') state.phase = 'idle';
      state.pausedPhase = null;
      setStatus('');
      drawAll();
    }

    function toggleManual() {
      setMode(state.mode === 'manual' ? 'search' : 'manual');
    }

    function setPreset(preset) {
      if (!presets[preset] || preset === state.preset) return;
      stopLoop();
      state.preset = preset;
      state.decision = null;
      state.decisionNet = null;
      state.snap = null;
      state.chosen = null;
      state.simsBefore = 0;
      state.xNow = 0;
      state.best = null;
      state.progress = [];
      state.pausedPhase = null;
      setStatus('');
      if (state.prefix.length >= CYCLE) {
        finish();
        drawAll();
      } else {
        state.result = null;
        state.phase = 'idle';
        drawAll();
      }
    }

    function addBlock(action) {
      if (state.mode !== 'manual' || state.prefix.length >= CYCLE) return;
      state.prefix.push(action);
      state.result = null;
      state.snap = null;
      state.chosen = null;
      if (state.prefix.length >= CYCLE) {
        finish();
        drawAll();
      } else {
        state.phase = 'idle';
        drawAll();
      }
    }

    function clearFrom(index) {
      if (state.mode !== 'manual' || index >= state.prefix.length) return;
      stopLoop();
      clearLanded();
      state.prefix = state.prefix.slice(0, index);
      state.result = null;
      state.decision = null;
      state.snap = null;
      state.chosen = null;
      state.phase = 'idle';
      setStatus('');
      drawAll();
    }

    function letSearchFinish() {
      if (state.prefix.length >= CYCLE) return;
      setMode('search');
      start();
    }

    /* The main button does what its text says. */
    function mainAction() {
      if (state.mode === 'manual') {
        if (state.prefix.length < CYCLE) {
          letSearchFinish();
        } else {
          /* a full hand-built sequence: "Run again" starts a fresh search */
          setMode('search');
          runAgain();
        }
        return;
      }
      if (state.phase === 'running' || state.phase === 'holding') {
        pause();
      } else if (state.phase === 'paused') {
        start();
      } else if (state.phase === 'done') {
        runAgain();
      } else {
        start();
      }
    }

    /* Handlers run outside the frame loop; an error in one is shown in
       the status line and goes no further. */
    function guarded(fn) {
      return function () {
        try {
          fn.apply(null, arguments);
        } catch (err) {
          stopLoop();
          state.decision = null;
          if (state.phase !== 'done') state.phase = 'idle';
          setStatus('The search stopped: ' +
            (err && err.message ? err.message : String(err)) + '.');
          updateControls();
        }
      };
    }

    function slotClick(index) {
      return guarded(function () { clearFrom(index); });
    }

    function blockClick(action) {
      return guarded(function () { addBlock(action); });
    }

    /* ---- drawing ------------------------------------------------------- */

    function measure() {
      var w = inner.clientWidth || container.clientWidth || 0;
      if (!w || w < MIN_WIDTH) w = w ? MIN_WIDTH : FALLBACK_WIDTH;
      return Math.min(MAX_WIDTH, Math.round(w));
    }

    function setStatus(text) {
      status.textContent = text || '';
    }

    function drawSlots() {
      var active = (state.phase === 'running' || state.phase === 'paused') &&
        state.decision ? state.prefix.length : -1;
      for (var i = 0; i < CYCLE; i++) {
        var filled = i < state.prefix.length;
        var el = slots[i];
        el.textContent = filled ? LETTERS[state.prefix[i]] : '';
        el.className = 'demo-slot' + (filled ? ' filled' : '') +
          (i === active ? ' active' : '') +
          (filled && i === state.landed ? ' landed' : '');
        el.disabled = !(state.mode === 'manual' && filled);
        el.title = filled ? ('slot ' + (i + 1) + ': block ' + LETTERS[state.prefix[i]] +
          (state.mode === 'manual' ? ' (click to clear from here)' : '')) :
          ('slot ' + (i + 1) + ', empty');
      }
      drawTimeline();
    }

    var tlKey = null;   /* (width, prefix) of the drawn pulse strip */

    /* The pulse strip: a time axis over the whole cycle, a hairline at
       every block boundary and a labelled tick every three blocks, and for
       each placed block its two pulses as rectangles, 1 us wide on the
       axis (at least TL_MIN_PULSE_W px), standing above the axis for a
       positive axis and hanging below it for a negative one. Redrawn only
       when the width or the prefix changes, so the fade of a newly placed
       block runs once. Empty slots draw nothing. */
    function drawTimeline() {
      if (!tlSvg) return;
      var W = state.width;
      var key = W + '|' + state.prefix.join(',');
      if (key === tlKey) return;
      tlKey = key;
      var left = 12, right = 12, top = 6;
      var span = W - left - right;
      var base = top + TL_PULSE_H;             /* the time axis */
      var labelY = base + TL_PULSE_H + 12;     /* baseline of the tick labels */
      var legendY = labelY + 13;
      var oneLine = span >= 400;               /* the legend fits one line */
      var H = oneLine ? legendY + 4 : legendY + 17;
      clear(tlSvg);
      setAttrs(tlSvg, { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
      function x(t) { return left + span * t / CYCLE_US; }
      for (var b = 0; b <= CYCLE; b++) {
        var major = b % 3 === 0;
        var bx = fmt(x(b * BLOCK_US), 1);
        var half = major ? 5 : 3;
        tlSvg.appendChild(s(doc, 'line', { 'class': major ? 'tl-tick' : 'tl-hair',
          x1: bx, y1: base - half, x2: bx, y2: base + half, 'shape-rendering': 'crispEdges' }));
        if (major) {
          tlSvg.appendChild(s(doc, 'text', { x: bx, y: labelY, 'class': 'demo-muted',
            'text-anchor': b === 0 ? 'start' : (b === CYCLE ? 'end' : 'middle') },
            String(b * BLOCK_US) + (b === CYCLE ? '\u00a0\u00b5s' : '')));
        }
      }
      tlSvg.appendChild(s(doc, 'line', { 'class': 'tl-base', x1: left, y1: base,
        x2: W - right, y2: base, 'shape-rendering': 'crispEdges' }));
      var pulseW = fmt(Math.max(TL_MIN_PULSE_W, x(PULSE_US) - x(0)), 1);
      var fade = state.landed >= 0 && state.landed === state.prefix.length - 1 &&
                 !reducedMotion();
      for (var i = 0; i < state.prefix.length; i++) {
        var axes = blockPulses(TOKENS, state.prefix[i]);
        for (var k = 0; k < axes.length; k++) {
          var name = axes[k];
          var t = i * BLOCK_US + k * (PULSE_US + FREE_US);
          var up = name.charAt(0) !== '-';
          var rect = s(doc, 'rect', { 'class': 'tl-pulse tl-' + name.charAt(1) +
            (fade && i === state.landed ? ' tl-new' : ''),
            x: fmt(x(t), 1), y: up ? base - TL_PULSE_H : base,
            width: pulseW, height: TL_PULSE_H });
          rect.appendChild(s(doc, 'title', null, 'slot ' + (i + 1) + ', block ' +
            LETTERS[state.prefix[i]] + ', pulse ' + (k + 1) + ': 90 degrees about ' + name));
          tlSvg.appendChild(rect);
        }
      }
      if (oneLine) {
        tlSvg.appendChild(s(doc, 'text', { x: W - right, y: legendY, 'text-anchor': 'end',
          'class': 'demo-muted' }, TL_LEGEND[0] + ' ' + TL_LEGEND[1]));
      } else {
        tlSvg.appendChild(s(doc, 'text', { x: W - right, y: legendY, 'text-anchor': 'end',
          'class': 'demo-muted' }, TL_LEGEND[0]));
        tlSvg.appendChild(s(doc, 'text', { x: W - right, y: legendY + 13, 'text-anchor': 'end',
          'class': 'demo-muted' }, TL_LEGEND[1]));
      }
    }

    /* What the decision view shows: the decision in progress, the one
       just completed, or a preview of the prior for the current prefix. */
    function viewData() {
      var visits = [], priors = [], a;
      if (state.snap) {
        return { visits: state.snap.visits, priors: state.snap.priors,
                 rootValue: state.snap.rootValue, nDone: state.snap.nDone,
                 nSims: state.snap.nSims, hasNet: !!state.decisionNet,
                 chosen: state.chosen };
      }
      var value = 0, hasNet = false, policy = null;
      if (state.prefix.length < CYCLE) {
        var net = netFor(state.prior);
        if (net) {
          var out = Net.evaluate(net, state.prefix);
          policy = out.policy;
          value = out.value;
          hasNet = true;
        }
      }
      for (a = 0; a < ACTIONS; a++) {
        visits.push(0);
        priors.push(policy ? policy[a] : (state.prefix.length < CYCLE ? 1 / ACTIONS : 0));
      }
      return { visits: visits, priors: priors, rootValue: value, nDone: 0,
               nSims: state.nSims, hasNet: hasNet, chosen: null };
    }

    var dec = null;   /* geometry and elements of the decision view */

    function layoutDecision() {
      var W = state.width, H = 150, left = 10, right = 10, top = 14, bottom = 22;
      clear(decSvg);
      setAttrs(decSvg, { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
      var slotW = (W - left - right) / ACTIONS;
      var barW = Math.max(6, Math.round(slotW * 0.5));
      dec = { base: H - bottom, areaH: H - bottom - top, bars: [], ticks: [],
              titles: [], labels: [] };
      decSvg.appendChild(s(doc, 'line', { 'class': 'demo-axis', x1: left,
        y1: dec.base, x2: W - right, y2: dec.base, 'shape-rendering': 'crispEdges' }));
      for (var a = 0; a < ACTIONS; a++) {
        var x = left + a * slotW + (slotW - barW) / 2;
        var bar = s(doc, 'rect', { 'class': 'demo-bar', x: x, y: dec.base,
          width: barW, height: 0 });
        var title = s(doc, 'title', null, 'block ' + LETTERS[a]);
        bar.appendChild(title);
        var tick = s(doc, 'line', { 'class': 'demo-tick', x1: x - 3,
          y1: dec.base, x2: x + barW + 3, y2: dec.base, 'shape-rendering': 'crispEdges' });
        var label = s(doc, 'text', { x: x + barW / 2, y: H - 6,
          'text-anchor': 'middle' }, LETTERS[a]);
        decSvg.appendChild(bar);
        decSvg.appendChild(tick);
        decSvg.appendChild(label);
        dec.bars.push(bar);
        dec.ticks.push(tick);
        dec.titles.push(title);
        dec.labels.push(label);
      }
    }

    function drawDecision() {
      if (!dec) layoutDecision();
      var v = viewData();
      var scale = 1, a;
      for (a = 0; a < ACTIONS; a++) {
        scale = Math.max(scale, v.visits[a], v.priors[a] * v.nSims);
      }
      for (a = 0; a < ACTIONS; a++) {
        var hgt = v.visits[a] / scale * dec.areaH;
        setAttrs(dec.bars[a], { y: dec.base - hgt, height: hgt,
          'class': 'demo-bar' + (v.chosen === a ? ' chosen' : '') });
        var ty = dec.base - v.priors[a] * v.nSims / scale * dec.areaH;
        setAttrs(dec.ticks[a], { y1: ty, y2: ty });
        dec.titles[a].textContent = 'block ' + LETTERS[a] + ': ' + v.visits[a] +
          ' visits, prior ' + fmt(v.priors[a], 2);
        dec.labels[a].setAttribute('class', v.chosen === a ? 'demo-label-chosen' : '');
      }
      var k = state.decision ? state.prefix.length + 1 :
        (state.chosen !== null ? state.prefix.length : 0);
      decStep.textContent = k > 0 ? 'decision ' + k + ' of ' + CYCLE : '';
      decSims.textContent = 'simulations: ' + v.nDone + ' / ' + v.nSims;
      decValue.textContent = v.hasNet ?
        'network’s estimate for this prefix: ' + fmt(v.rootValue, 1) : '';
    }

    var progKey = null;   /* (width, yMax, xMax) of the drawn grid */
    var progPath = null;
    var prog = null;

    function drawProgress() {
      var W = state.width, H = 120, left = 34, right = 12, top = 8, bottom = 22;
      var remaining = Math.max(0, CYCLE - state.prefix.length);
      var xMax = Math.max(1, state.xNow, state.simsBefore + remaining * state.nSims);
      /* the reward axis: 0 to 6 or 8 in steps of 2, 0 to 12 or 16 in steps of 4 */
      var top_ = state.best === null ? 0 : state.best + 1;
      var yMax = 6, yStep = 2;
      if (top_ > 6) { yMax = 8; }
      if (top_ > 8) { yMax = Math.min(16, 4 * Math.ceil(top_ / 4)); yStep = 4; }
      var key = W + ':' + yMax + ':' + xMax;
      if (key !== progKey) {
        progKey = key;
        clear(progSvg);
        setAttrs(progSvg, { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
        prog = {
          x: function (v) { return left + (W - left - right) * v / xMax; },
          y: function (v) { return top + (H - top - bottom) * (1 - v / yMax); }
        };
        for (var g = 0; g <= yMax; g += yStep) {
          var gy = prog.y(g);
          progSvg.appendChild(s(doc, 'line', { 'class': g === 0 ? 'demo-axis' : 'demo-grid',
            x1: left, y1: gy, x2: W - right, y2: gy, 'shape-rendering': 'crispEdges' }));
          progSvg.appendChild(s(doc, 'text', { x: left - 5, y: gy + 4,
            'text-anchor': 'end' }, String(g)));
        }
        progSvg.appendChild(s(doc, 'text', { x: W - right, y: H - 5,
          'text-anchor': 'end', 'class': 'demo-muted' },
          'simulations, ' + Math.round(xMax) + ' in all'));
        progPath = s(doc, 'path', { 'class': 'demo-line', d: '' });
        progSvg.appendChild(progPath);
      }
      var pts = state.progress;
      if (!pts.length) { progPath.setAttribute('d', ''); return; }
      var d = 'M' + fmt(prog.x(pts[0].x), 1) + ' ' + fmt(prog.y(pts[0].y), 1);
      for (var i = 1; i < pts.length; i++) {
        d += 'H' + fmt(prog.x(pts[i].x), 1) + 'V' + fmt(prog.y(pts[i].y), 1);
      }
      d += 'H' + fmt(prog.x(Math.max(state.xNow, pts[pts.length - 1].x)), 1);
      progPath.setAttribute('d', d);
    }

    function drawResult() {
      var res = state.result;
      resultWrap.hidden = !res;
      clear(resultSvg);
      if (!res) { resultText.textContent = ''; return; }
      var grow = !!res.fresh;
      res.fresh = false;
      var r = res.reward;
      resultText.textContent = 'reward of this sequence over two repetitions: ' + (r > AXIS_MAX ?
        'above ' + AXIS_MAX + ' (beyond the simulator’s precision)' : fmt(r, 2));
      var refs = SITE.demoRefs[res.preset] || [];
      var rows = [
        { name: 'no pulses', reward: freeRewardFor(res.preset), cls: 'demo-bar-free',
          style: 'fill: var(--muted)', labelCls: 'demo-muted' },
        { name: 'this sequence', reward: r, cls: 'demo-bar-this',
          labelCls: 'demo-label-this', grow: grow }
      ];
      refs.forEach(function (ref) {
        rows.push({ name: ref.name, reward: ref.reward72,
          cls: CATEGORY_CLASS[categoryOf(ref.seqId)] || 'demo-cat-ref' });
      });
      var W = state.width, top = 6;
      var labelW = Math.min(150, Math.max(112, Math.round(W * 0.36)));
      var x0 = labelW + 8, x1 = W - 12;
      var axisY = top + rows.length * ROW + 4, H = axisY + 34;
      setAttrs(resultSvg, { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
      function x(v) { return x0 + (x1 - x0) * Math.min(Math.max(v, 0), AXIS_MAX) / AXIS_MAX; }
      for (var t = 0; t <= AXIS_MAX; t += 2) {
        resultSvg.appendChild(s(doc, 'line', { 'class': t === 0 ? 'demo-axis' : 'demo-grid',
          x1: x(t), y1: top, x2: x(t), y2: axisY, 'shape-rendering': 'crispEdges' }));
        resultSvg.appendChild(s(doc, 'text', { x: x(t), y: axisY + 14,
          'text-anchor': 'middle' }, String(t)));
      }
      resultSvg.appendChild(s(doc, 'line', { 'class': 'demo-axis', x1: x0, y1: axisY,
        x2: x1, y2: axisY, 'shape-rendering': 'crispEdges' }));
      var growing = null;
      rows.forEach(function (row, i) {
        var y = top + i * ROW;
        resultSvg.appendChild(s(doc, 'text', { x: labelW, y: y + 13,
          'text-anchor': 'end', 'class': row.labelCls || '' }, row.name));
        var len = Math.max(0, x(row.reward) - x0);
        var bar = s(doc, 'rect', { 'class': 'demo-ref ' + row.cls, x: x0,
          y: y + (ROW - BAR) / 2, width: row.grow ? 0 : len, height: BAR,
          style: row.style });
        bar.appendChild(s(doc, 'title', null, row.name));
        resultSvg.appendChild(bar);
        if (row.grow) growing = { bar: bar, width: len };
      });
      resultSvg.appendChild(s(doc, 'text', { x: x1, y: H - 4, 'text-anchor': 'end',
        'class': 'demo-muted' }, 'reward over 72 windows'));
      if (growing) growBar(growing.bar, growing.width);
    }

    /* The "this sequence" bar grows from empty to its length over GROW_MS
       with an ease-out, as a tween of the width attribute (a CSS transition
       on an SVG attribute does not run in every browser). Readers who ask
       for reduced motion get the final width at once. */
    var growTimer = 0;

    function reducedMotion() {
      try {
        return typeof root.matchMedia !== 'function' ||
          root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch (err) {
        return true;
      }
    }

    function growBar(bar, width) {
      if (growTimer) { cancelFrame(growTimer); growTimer = 0; }
      if (reducedMotion() || width <= 0) {
        bar.setAttribute('width', width);
        return;
      }
      var t0 = null;
      function tick(now) {
        growTimer = 0;
        if (bar.parentNode !== resultSvg) return;   /* redrawn meanwhile */
        if (t0 === null) t0 = now;
        var u = Math.min(1, (now - t0) / GROW_MS);
        var eased = 1 - (1 - u) * (1 - u);
        bar.setAttribute('width', width * eased);
        if (u < 1) growTimer = requestFrame(tick);
      }
      growTimer = requestFrame(tick);
    }

    /* The values in the settings fold that differ from the defaults. */
    function settingsNoteText() {
      var parts = [];
      if (state.prior !== DEFAULTS.prior) {
        parts.push(state.prior === 'none' ? 'no network' : state.prior + ' network');
      }
      if (state.cInit !== DEFAULTS.cInit) parts.push('c ' + state.cInit);
      if (state.nSims !== DEFAULTS.nSims) parts.push(state.nSims + ' simulations');
      if (state.speed !== DEFAULTS.speed) parts.push(state.speed);
      if (state.preset !== DEFAULTS.preset) parts.push(PRESET_LABEL[state.preset] || state.preset);
      return parts.join(', ');
    }

    function updateControls() {
      var running = state.phase === 'running' || state.phase === 'holding';
      var busy = running || state.phase === 'paused';
      var manual = state.mode === 'manual';
      var full = state.prefix.length >= CYCLE;
      var label = 'Start';
      if (manual) label = full ? 'Run again' : (state.prefix.length ? 'Let the search finish' : 'Start');
      else if (state.phase === 'done') label = 'Run again';
      else if (running) label = 'Pause';
      else if (state.phase === 'paused') label = 'Resume';
      startBtn.textContent = label;
      startBtn.disabled = false;
      resetBtn.disabled = false;
      manualBtn.textContent = manual ? MANUAL_TEXT.manual : MANUAL_TEXT.search;
      physicsSel.disabled = busy;
      palette.hidden = !manual;
      for (var a = 0; a < ACTIONS; a++) blockBtns[a].disabled = full;
      settingsNote.textContent = settingsNoteText();
    }

    function drawAll() {
      state.width = measure();
      dec = null;
      progKey = null;
      drawSlots();
      drawDecision();
      drawProgress();
      drawResult();
      updateControls();
    }

    /* ---- wire the controls --------------------------------------------- */

    priorSel.addEventListener('change', guarded(function () {
      state.prior = priorSel.value;
      if (!state.snap) drawDecision();
      updateControls();
    }));
    cSel.addEventListener('change', guarded(function () {
      state.cInit = parseFloat(cSel.value);
      updateControls();
    }));
    simsSel.addEventListener('change', guarded(function () {
      state.nSims = parseInt(simsSel.value, 10);
      if (!state.snap) drawDecision();
      drawProgress();
      updateControls();
    }));
    speedSel.addEventListener('change', guarded(function () {
      state.speed = speedSel.value;
      updateControls();
    }));
    physicsSel.addEventListener('change', guarded(function () { setPreset(physicsSel.value); }));
    startBtn.addEventListener('click', guarded(mainAction));
    resetBtn.addEventListener('click', guarded(resetAll));
    manualBtn.addEventListener('click', guarded(toggleManual));

    var resizeTimer = 0;
    if (typeof root.addEventListener === 'function') {
      root.addEventListener('resize', function () {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
          resizeTimer = 0;
          if (measure() !== state.width) drawAll();
        }, 150);
      });
    }

    drawAll();

    /* ---- self-test hook (index.html?selftest=1) ------------------------ */

    var search = root.location && root.location.search ? root.location.search : '';
    if (/(?:^|[?&])selftest=1(?:&|$)/.test(search) && typeof root.runSelfTest === 'function') {
      var pre = h(doc, 'pre', { 'class': 'demo-selftest', id: 'demo-selftest' });
      try {
        var r = root.runSelfTest();
        pre.textContent = (r && r.lines ? r.lines.join('\n') : String(r));
      } catch (err) {
        pre.textContent = 'self-test failed: ' + (err && err.message ? err.message : err);
      }
      inner.appendChild(pre);
    }

    /* A small handle, mostly for checks outside a browser. */
    return {
      state: state,
      start: start, pause: pause, reset: reset, resetAll: resetAll, runAgain: runAgain,
      mainAction: mainAction, toggleManual: toggleManual,
      setMode: setMode, setPreset: setPreset, addBlock: addBlock,
      clearFrom: clearFrom, letSearchFinish: letSearchFinish,
      frame: frame, redraw: drawAll
    };
  }

  var Demo = { mount: mount, blockPulses: blockPulses };

  root.Demo = Demo;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Demo;
  }
})(typeof window !== 'undefined' ? window : globalThis);
