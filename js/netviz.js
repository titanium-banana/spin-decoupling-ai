/*
 * netviz.js: the illustration "Inside the network" in Section 4. One
 * evaluation of the policy and value network is drawn stage by stage: the
 * one-hot tokens of a prefix (start token, then each chosen block) enter
 * the recurrent layer one at a time and the 64 hidden units change colour
 * with their activation; the ten residual layers of the trunk light up in
 * turn; the policy head shows the prior over the next block as eight bars
 * and the value head the predicted final reward as a number and a gauge.
 *
 * Every number on screen comes from PolicyNet.trace, which equals the
 * evaluation the live search uses. By default the panel follows the live
 * search in Figure 1 (window.demoHandle.state.prefix, polled); the viewer
 * can also build a prefix from the buttons, and switch between the trained
 * and the untrained network. Classic script: defines window.NetViz.
 */
(function (root) {
  'use strict';

  var HID = 64, FC = 32, ACT = 8, TOKENS = 9, CYCLE = 12;
  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  var TOKEN_MS = 650;          /* pause after each token enters the memory */
  var LAYER_MS = 170;          /* pause after each trunk layer lights up */
  var HEAD_MS = 250;           /* pause between the two heads */
  var POLL_MS = 300;           /* how often the live search is read */
  var DEMO_PREFIX = [2, 5, 0]; /* blocks fed on page load, one at a time */
  var VALUE_MAX = 12;          /* the gauge runs from 0 to this reward */
  var GAUGE_STEP = 4;          /* labelled every this many reward units */
  var POS = '42, 120, 214', NEG = '235, 104, 52';   /* the diverging scale */

  function h(doc, tag, attrs, text) {
    var e = doc.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(doc, name, attrs, parent) {
    var e = doc.createElementNS(SVG_NS, name);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* Colour of a cell for an activation v in [-1, 1]: blue for positive,
     orange for negative, transparent near zero; reads on light and dark. */
  function cellColour(v) {
    var a = Math.min(1, Math.abs(v));
    if (a < 0.02) return '';
    return 'rgba(' + (v > 0 ? POS : NEG) + ', ' + (0.12 + 0.88 * a).toFixed(3) + ')';
  }
  function paintCells(cells, values, scale) {
    for (var i = 0; i < cells.length; i++) {
      cells[i].style.backgroundColor = cellColour(values[i] / scale);
    }
  }
  function maxAbs(values) {
    var m = 0;
    for (var i = 0; i < values.length; i++) m = Math.max(m, Math.abs(values[i]));
    return m > 1e-9 ? m : 1;
  }
  function samePrefix(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function describe(prefix) {
    if (prefix.length === 0) return 'the start token only';
    var letters = [];
    for (var i = 0; i < prefix.length; i++) letters.push(LETTERS[prefix[i]]);
    return prefix.length + (prefix.length === 1 ? ' block (' : ' blocks (') + letters.join(' ') + ')';
  }

  function mount(rootEl, deps) {
    if (!rootEl) return null;
    var doc = rootEl.ownerDocument || root.document;
    try {
      return mountInner(rootEl, deps || {}, doc);
    } catch (err) {
      rootEl.innerHTML = '';
      rootEl.appendChild(h(doc, 'p', { 'class': 'demo-status' },
        'The illustration could not start: ' + (err && err.message ? err.message : String(err)) + '.'));
      return null;
    }
  }

  function mountInner(rootEl, deps, doc) {
    var Net = deps.PolicyNet;
    if (!Net || typeof Net.trace !== 'function') throw new Error('PolicyNet.trace is missing');
    var sources = { trained: deps.NET_TRAINED, untrained: deps.NET_UNTRAINED };
    if (!sources.trained || !sources.trained.params) throw new Error('the trained network is missing');
    var nets = {};
    function netFor(name) {
      if (!nets[name]) nets[name] = Net.create(sources[name].params);
      return nets[name];
    }

    rootEl.innerHTML = '';
    var stage = h(doc, 'div', { 'class': 'nv-stage' });
    rootEl.appendChild(stage);

    function row(label, cls) {
      var box = h(doc, 'div', { 'class': 'nv-row ' + cls });
      box.appendChild(h(doc, 'p', { 'class': 'nv-label' }, label));
      stage.appendChild(box);
      return box;
    }

    /* Input tokens: one slot per token, a column of nine one-hot cells. */
    var tokenRow = row('Input tokens, one at a time (one-hot, 9 values)', 'nv-row-tokens');
    var tokenStrip = h(doc, 'div', { 'class': 'nv-tokens' });
    tokenRow.appendChild(tokenStrip);
    var slots = [];
    for (var s = 0; s <= CYCLE; s++) {
      var slot = h(doc, 'div', { 'class': 'nv-token' });
      var col = h(doc, 'div', { 'class': 'nv-onehot' });
      var cells = [];
      for (var t = 0; t < TOKENS; t++) {
        var c = h(doc, 'span', { 'class': 'nv-cell' });
        col.appendChild(c);
        cells.push(c);
      }
      slot.appendChild(col);
      var cap = h(doc, 'span', { 'class': 'nv-token-label' }, '');
      slot.appendChild(cap);
      tokenStrip.appendChild(slot);
      slots.push({ el: slot, cells: cells, cap: cap });
    }

    /* Recurrent memory: 64 cells. */
    var memRow = row('Recurrent memory (64 units)', 'nv-row-memory');
    var memGrid = h(doc, 'div', { 'class': 'nv-grid nv-memory' });
    memRow.appendChild(memGrid);
    var memCells = [];
    for (var m = 0; m < HID; m++) {
      var mc = h(doc, 'span', { 'class': 'nv-cell' });
      memGrid.appendChild(mc);
      memCells.push(mc);
    }

    /* Trunk: ten rows of 32 cells, each labelled. */
    var trunkRow = row('Trunk layers (32 units each)', 'nv-row-trunk');
    var trunk = h(doc, 'div', { 'class': 'nv-trunk' });
    trunkRow.appendChild(trunk);
    var layerRows = [];
    for (var l = 0; l < 10; l++) {
      var lr = h(doc, 'div', { 'class': 'nv-layer' });
      lr.appendChild(h(doc, 'span', { 'class': 'nv-layer-label' }, 'fc' + (l + 1)));
      var lg = h(doc, 'div', { 'class': 'nv-grid nv-layer-cells' });
      lr.appendChild(lg);
      var lcells = [];
      for (var u = 0; u < FC; u++) {
        var lc = h(doc, 'span', { 'class': 'nv-cell' });
        lg.appendChild(lc);
        lcells.push(lc);
      }
      trunk.appendChild(lr);
      layerRows.push({ el: lr, cells: lcells });
    }

    /* Heads: policy bars and the value gauge. */
    var heads = h(doc, 'div', { 'class': 'nv-heads' });
    stage.appendChild(heads);
    var polBox = h(doc, 'div', { 'class': 'nv-row nv-head nv-head-policy' });
    polBox.appendChild(h(doc, 'p', { 'class': 'nv-label' }, 'Policy head: prior over the next block'));
    var PW = 240, PH = 96, BASE = 78;
    var polSvg = svgEl(doc, 'svg', { viewBox: '0 0 ' + PW + ' ' + PH, 'class': 'nv-svg', role: 'img',
      'aria-label': 'Eight bars, the probability the network gives each block A to H' }, polBox);
    svgEl(doc, 'line', { 'class': 'nv-base', x1: 8, y1: BASE + 0.5, x2: PW - 8, y2: BASE + 0.5 }, polSvg);
    var bars = [], barLabels = [];
    for (var a = 0; a < ACT; a++) {
      var bx = 8 + a * (PW - 16) / ACT;
      bars.push(svgEl(doc, 'rect', { 'class': 'nv-bar', x: bx + 5, y: BASE, width: (PW - 16) / ACT - 10, height: 0 }, polSvg));
      var lab = svgEl(doc, 'text', { 'class': 'nv-bar-label', x: bx + (PW - 16) / ACT / 2, y: BASE + 14, 'text-anchor': 'middle' }, polSvg);
      lab.textContent = LETTERS[a];
      barLabels.push(lab);
    }
    heads.appendChild(polBox);

    var valBox = h(doc, 'div', { 'class': 'nv-row nv-head nv-head-value' });
    valBox.appendChild(h(doc, 'p', { 'class': 'nv-label' }, 'Value head: predicted final reward'));
    var valNum = h(doc, 'p', { 'class': 'nv-value' }, '');
    valBox.appendChild(valNum);
    var GW = 240, GH = 26;
    var gaugeSvg = svgEl(doc, 'svg', { viewBox: '0 0 ' + GW + ' ' + GH, 'class': 'nv-svg nv-gauge', role: 'img',
      'aria-label': 'A gauge of the predicted final reward from 0 to ' + VALUE_MAX }, valBox);
    svgEl(doc, 'rect', { 'class': 'nv-gauge-track', x: 8, y: 4, width: GW - 16, height: 8, rx: 2 }, gaugeSvg);
    var gaugeFill = svgEl(doc, 'rect', { 'class': 'nv-gauge-fill', x: 8, y: 4, width: 0, height: 8, rx: 2 }, gaugeSvg);
    for (var g = 0; g <= VALUE_MAX; g += GAUGE_STEP) {
      var gx = 8 + (GW - 16) * g / VALUE_MAX;
      var gt = svgEl(doc, 'text', { 'class': 'nv-gauge-label', x: gx, y: 23,
        'text-anchor': g === 0 ? 'start' : (g === VALUE_MAX ? 'end' : 'middle') }, gaugeSvg);
      gt.textContent = String(g);
    }
    heads.appendChild(valBox);

    var status = h(doc, 'p', { 'class': 'nv-status' }, '');
    rootEl.appendChild(status);

    /* Controls: block buttons, clear, follow, replay, network select. */
    var controls = h(doc, 'div', { 'class': 'nv-controls' });
    var blockGroup = h(doc, 'span', { 'class': 'nv-group' });
    blockGroup.appendChild(h(doc, 'span', { 'class': 'nv-group-label' }, 'Add a block'));
    var blockButtons = [];
    LETTERS.forEach(function (letter, idx) {
      var b = h(doc, 'button', { type: 'button', 'class': 'nv-block' }, letter);
      b.addEventListener('click', function () { addBlock(idx); });
      blockGroup.appendChild(b);
      blockButtons.push(b);
    });
    var clearButton = h(doc, 'button', { type: 'button' }, 'Clear');
    clearButton.addEventListener('click', function () { setOwnPrefix([]); });
    blockGroup.appendChild(clearButton);
    controls.appendChild(blockGroup);
    var followButton = h(doc, 'button', { type: 'button', 'class': 'nv-follow' }, 'Follow the search');
    followButton.addEventListener('click', followSearch);
    controls.appendChild(followButton);
    var replayButton = h(doc, 'button', { type: 'button' }, 'Replay');
    replayButton.addEventListener('click', function () { feed(current.slice(), false); });
    controls.appendChild(replayButton);
    var netField = h(doc, 'label', { 'class': 'nv-field' }, 'Network ');
    var netSelect = h(doc, 'select', {});
    netSelect.appendChild(h(doc, 'option', { value: 'trained' }, 'trained'));
    if (sources.untrained && sources.untrained.params) {
      netSelect.appendChild(h(doc, 'option', { value: 'untrained' }, 'untrained'));
    }
    netSelect.addEventListener('change', function () {
      netName = netSelect.value;
      feed(current.slice(), false);
    });
    netField.appendChild(netSelect);
    controls.appendChild(netField);
    rootEl.appendChild(controls);

    /* ---- painting ------------------------------------------------------ */

    var reduced = typeof root.matchMedia === 'function' &&
      root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var netName = 'trained';
    var current = [];            /* the prefix shown */
    var following = true;        /* follows window.demoHandle while true */
    var lastSearchKey = null;    /* the search prefix last adopted or seen */
    var timers = [];
    var shown = null;            /* the trace currently painted in full */
    var pending = null;          /* {trace, prefix} of an animation under way */
    var intro = true;            /* the page-load demonstration still runs */

    function later(fn, ms) {
      if (reduced) { fn(); return; }
      timers.push(root.setTimeout(fn, ms));
    }
    function cancelTimers() {
      for (var i = 0; i < timers.length; i++) root.clearTimeout(timers[i]);
      timers = [];
    }
    function setStale(on) {
      trunk.classList.toggle('nv-stale', on);
      heads.classList.toggle('nv-stale', on);
    }

    function paintTokens(prefix, activeIndex) {
      for (var i = 0; i < slots.length; i++) {
        var slot = slots[i], present = i <= prefix.length;
        slot.el.classList.toggle('nv-token-empty', !present);
        slot.el.classList.toggle('nv-token-active', i === activeIndex);
        slot.el.classList.toggle('nv-token-future', present && activeIndex >= 0 && i > activeIndex);
        var token = i === 0 ? 0 : (present ? prefix[i - 1] + 1 : -1);
        for (var t = 0; t < TOKENS; t++) {
          slot.cells[t].classList.toggle('nv-on', present && t === token);
        }
        slot.cap.textContent = i === 0 ? 'start' : (present ? LETTERS[prefix[i - 1]] : '');
      }
    }
    function paintMemory(hvec) { paintCells(memCells, hvec, 1); }
    function paintLayer(l, values) {
      paintCells(layerRows[l].cells, values, maxAbs(values));
      layerRows[l].el.classList.remove('nv-stale');
    }
    function paintPolicy(policy) {
      var best = 0;
      for (var a = 1; a < ACT; a++) if (policy[a] > policy[best]) best = a;
      for (var b = 0; b < ACT; b++) {
        var hgt = Math.max(0.5, (BASE - 6) * policy[b]);
        bars[b].setAttribute('y', String(BASE - hgt));
        bars[b].setAttribute('height', String(hgt));
        bars[b].classList.toggle('nv-bar-best', b === best);
        barLabels[b].classList.toggle('nv-bar-best', b === best);
      }
      polBox.classList.remove('nv-stale');
      return best;
    }
    function paintValue(value) {
      var f = Math.max(0, Math.min(1, value / VALUE_MAX));
      gaugeFill.setAttribute('width', String((GW - 16) * f));
      valNum.textContent = value.toFixed(2);
      valBox.classList.remove('nv-stale');
    }
    function paintAll(trace, prefix) {
      paintTokens(prefix, -1);
      paintMemory(trace.steps[trace.steps.length - 1].h);
      for (var l = 0; l < trace.layers.length; l++) paintLayer(l, trace.layers[l]);
      paintPolicy(trace.policy);
      paintValue(trace.value);
      setStale(false);
      shown = trace;
      pending = null;
    }
    function sourceNote() {
      return following ? 'Following the live search.' : 'Your own prefix.';
    }
    function finalStatus(trace, prefix) {
      var best = 0;
      for (var a = 1; a < ACT; a++) if (trace.policy[a] > trace.policy[best]) best = a;
      status.textContent = sourceNote() + ' After ' + describe(prefix) + ', the ' + netName +
        ' network gives block ' + LETTERS[best] + ' the largest prior (' +
        (100 * trace.policy[best]).toFixed(0) + '%) and predicts a final reward of ' +
        trace.value.toFixed(2) + '.';
    }

    /* Feed a prefix. With fromStep > 0 only the tokens from that step on
       are animated (the memory before them is already on screen). */
    function feed(prefix, incremental) {
      cancelTimers();
      if (pending) paintAll(pending.trace, pending.prefix);
      var net = netFor(netName);
      var trace = Net.trace(net, prefix);
      var fromStep = 0;
      if (incremental && shown && shown.steps.length === trace.steps.length - 1) fromStep = trace.steps.length - 1;
      current = prefix.slice();
      updateControls();
      if (reduced) {
        paintAll(trace, prefix);
        finalStatus(trace, prefix);
        return;
      }
      pending = { trace: trace, prefix: prefix.slice() };
      setStale(true);
      if (fromStep === 0) {
        paintTokens(prefix, -1);
        paintMemory(new Float64Array(HID));
        for (var l = 0; l < layerRows.length; l++) layerRows[l].el.classList.add('nv-stale');
      }
      var delay = 0;
      var stepsLeft = trace.steps.length - fromStep;
      for (var i = fromStep; i < trace.steps.length; i++) {
        (function (step) {
          later(function () {
            paintTokens(prefix, step);
            paintMemory(trace.steps[step].h);
            status.textContent = sourceNote() + ' Token ' + (step + 1) + ' of ' + trace.steps.length +
              (step === 0 ? ' (start) enters' : ' (block ' + LETTERS[prefix[step - 1]] + ') enters') +
              ' the memory; the 64 units update.';
          }, delay);
        })(i);
        delay += TOKEN_MS;
      }
      if (stepsLeft > 0) delay += TOKEN_MS / 2;
      for (var j = 0; j < trace.layers.length; j++) {
        (function (layer) {
          later(function () {
            paintLayer(layer, trace.layers[layer]);
            status.textContent = sourceNote() + ' Trunk layer ' + (layer + 1) + ' of 10.';
          }, delay);
        })(j);
        delay += LAYER_MS;
      }
      later(function () {
        paintPolicy(trace.policy);
        status.textContent = sourceNote() + ' The policy head reads the trunk.';
      }, delay);
      delay += HEAD_MS;
      later(function () {
        paintValue(trace.value);
        paintTokens(prefix, -1);
        shown = trace;
        pending = null;
        finalStatus(trace, prefix);
      }, delay);
    }

    /* ---- sources of the prefix ----------------------------------------- */

    function updateControls() {
      for (var i = 0; i < blockButtons.length; i++) blockButtons[i].disabled = current.length >= CYCLE;
      followButton.disabled = following;
      followButton.classList.toggle('nv-active', following);
    }
    function setOwnPrefix(prefix, incremental) {
      following = false;
      intro = false;
      feed(prefix, !!incremental);
    }
    function addBlock(action) {
      if (current.length >= CYCLE) return;
      var next = current.slice();
      next.push(action);
      setOwnPrefix(next, true);
    }
    function searchPrefix() {
      var handle = root.demoHandle;
      if (!handle || !handle.state || !Array.isArray(handle.state.prefix)) return null;
      return handle.state.prefix.slice();
    }
    function followSearch() {
      following = true;
      intro = false;
      var p = searchPrefix() || [];
      lastSearchKey = p.join(',');
      feed(p, false);
    }
    function poll() {
      var p = searchPrefix();
      if (p === null) return;
      var key = p.join(',');
      if (key === lastSearchKey) return;
      lastSearchKey = key;
      if (!following) return;
      intro = false;
      var grewByOne = p.length === current.length + 1 && samePrefix(p.slice(0, current.length), current);
      feed(p, grewByOne);
    }
    var startingSearch = searchPrefix();
    lastSearchKey = startingSearch === null ? null : startingSearch.join(',');
    root.setInterval(poll, POLL_MS);

    /* Page load: the start token, then the demo blocks one after another. */
    if (reduced) {
      feed(DEMO_PREFIX.slice(), false);
    } else {
      feed([], false);
      var when = 0;
      for (var d = 1; d <= DEMO_PREFIX.length; d++) {
        when += TOKEN_MS * 2 + LAYER_MS * 10 + HEAD_MS * 2 + 900;
        (function (n) {
          root.setTimeout(function () {
            if (!intro || !samePrefix(current, DEMO_PREFIX.slice(0, n - 1))) return;
            feed(DEMO_PREFIX.slice(0, n), true);
          }, when);
        })(d);
      }
    }
    updateControls();

    return { feed: feed, followSearch: followSearch, setOwnPrefix: setOwnPrefix,
             getPrefix: function () { return current.slice(); } };
  }

  root.NetViz = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
