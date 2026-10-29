/*
 * kiosk.js: self-running mode for a big screen, index.html?kiosk=1.
 *
 * Without the kiosk parameter this file does nothing. With it, the page
 * scrolls to Figure 1, the body gets the class "kiosk" (css/site.css hides
 * the contents rail and widens the figure a little) and the live search is
 * kept going: it starts as soon as the figure is mounted, holds every
 * finished sequence on screen for a few seconds, then runs again with the
 * next seed, switching the physics between ideal and with errors from one
 * episode to the next. A search left idle, paused or in Manual mode for
 * about ten seconds is started again, so the loop never stalls. The rest
 * of the page stays as it is and can still be scrolled and used.
 *
 *   ?kiosk=1              slow search, the figure's default
 *   ?kiosk=1&speed=fast   the figure's fast setting
 */
(function () {
  'use strict';

  var POLL_MS = 250;          /* how often the figure's state is looked at */
  var SHOW_RESULT_MS = 6000;  /* a finished sequence stays this long */
  var STALL_MS = 10000;       /* idle, paused or Manual this long: start again */
  var PRESET_CYCLE = ['ideal', 'errors'];

  var query = window.location && window.location.search ? window.location.search : '';
  var kiosk = /(?:^|[?&])kiosk=(?!0(?:&|$))[^&]+/.test(query);
  if (!kiosk) return;
  var speedMatch = /(?:^|[?&])speed=(slow|fast)(?:&|$)/.exec(query);
  var speed = speedMatch ? speedMatch[1] : null;

  if (document.body) document.body.classList.add('kiosk');

  function scrollToFigure() {
    var fig = document.getElementById('fig1');
    if (fig && typeof fig.scrollIntoView === 'function') fig.scrollIntoView({ block: 'start' });
  }
  scrollToFigure();
  window.addEventListener('load', function () { setTimeout(scrollToFigure, 50); });

  /* Presets to alternate between, limited to the ones the page defines. */
  var presets = PRESET_CYCLE.filter(function (id) {
    return window.SITE_DATA && window.SITE_DATA.physicsPresets &&
      window.SITE_DATA.physicsPresets[id];
  });

  function nextPreset(current) {
    if (presets.length < 2) return null;
    var i = presets.indexOf(current);
    return presets[(i + 1) % presets.length];
  }

  function setSelect(id, value) {
    var sel = document.getElementById(id);
    if (sel && sel.value !== value) sel.value = value;
  }

  var handle = null;
  var lastPhase = null, phaseSince = 0, speedApplied = false;

  function begin(now) {
    var state = handle.state;
    if (state.mode !== 'search' && typeof handle.setMode === 'function') handle.setMode('search');
    if (!speedApplied && speed) {
      state.speed = speed;
      setSelect('demo-speed', speed);
      speedApplied = true;
    }
    handle.start();
    lastPhase = handle.state.phase;
    phaseSince = now;
  }

  /* After the result has been shown: next physics, next seed, go. */
  function again(now) {
    if (handle.state.mode !== 'search' && typeof handle.setMode === 'function') handle.setMode('search');
    var next = nextPreset(handle.state.preset);
    if (next) {
      handle.reset();
      handle.setPreset(next);
      setSelect('demo-physics', next);
    }
    handle.runAgain();
    lastPhase = handle.state.phase;
    phaseSince = now;
  }

  function poll() {
    try {
      if (!handle) {
        if (!window.demoHandle || !window.demoHandle.state) return;
        handle = window.demoHandle;
        begin(Date.now());
        return;
      }
      var now = Date.now();
      var phase = handle.state.phase;
      if (phase !== lastPhase) { lastPhase = phase; phaseSince = now; }
      var waited = now - phaseSince;
      if (phase === 'done') {
        if (waited >= SHOW_RESULT_MS) again(now);
      } else if (phase === 'idle' || phase === 'paused' || handle.state.mode !== 'search') {
        if (waited >= STALL_MS) begin(now);
      }
    } catch (err) {
      /* the figure reports its own errors; the loop simply tries again */
      lastPhase = null;
    }
  }

  setInterval(poll, POLL_MS);
})();
