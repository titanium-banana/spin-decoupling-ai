/*
 * search.js: one search decision of the sequence designer, in plain
 * JavaScript.
 *
 * A decision grows a tree below the current prefix. Each node holds a
 * prior P (from the network's policy, or 1/8 without a network), a visit
 * count N, a total value W and, once expanded, eight children. The root
 * is expanded first and its child priors are mixed with Dirichlet noise,
 * P <- (1 - f) P + f noise, with alpha = 2 and f = 0.25. A simulation
 * descends while the node has children, choosing the child with the
 * largest
 *
 *   Q + P * sqrt(N_parent) / (N_child + 1)
 *         * (cInit + log10((N_parent + cBase + 1) / cBase)),
 *
 * Q = W / N (0 when unvisited), exact ties going to the larger action
 * index. A leaf with a full cycle (12 blocks) is scored by the exact
 * reward of one cycle; otherwise it is expanded with the network and its
 * value is used. The value is added to W, and 1 to N, of every node on
 * the path, the root included. After nSims simulations the action is
 * drawn from the root visit counts.
 *
 * Randomness comes only from the supplied generator (makeRng), so a
 * decision is reproducible given its seed.
 *
 * Classic script: defines window.Search; also exported for Node.
 */
(function (root) {
  'use strict';

  var ACTIONS = 8;
  var DEFAULTS = { cInit: 9.5, nSims: 500, cBase: 1000, alpha: 2,
                   fraction: 0.25, cycleLength: 12 };

  /* mulberry32: 32-bit state, returns uniforms in [0, 1). */
  function makeRng(seed) {
    var a = (seed === undefined ? 1 : seed) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* standard normal by Box-Muller (one value per call) */
  function normal(rng) {
    var u1 = 1 - rng();          /* (0, 1] so the log is finite */
    var u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /* Gamma(alpha, 1) by Marsaglia and Tsang; alpha < 1 by the boost. */
  function gamma(rng, alpha) {
    if (alpha < 1) {
      return gamma(rng, alpha + 1) * Math.pow(rng(), 1 / alpha);
    }
    var d = alpha - 1 / 3;
    var c = 1 / Math.sqrt(9 * d);
    for (;;) {
      var x, v;
      do {
        x = normal(rng);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      var u = rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function dirichlet(rng, alpha, n) {
    var out = new Array(n), total = 0;
    for (var i = 0; i < n; i++) { out[i] = gamma(rng, alpha); total += out[i]; }
    for (var j = 0; j < n; j++) out[j] /= total;
    return out;
  }

  function makeNode(prior) {
    return { prior: prior, visits: 0, total: 0, children: null };
  }

  function resolveSim(opts) {
    if (opts.sim) return opts.sim;
    if (root.PulseSim) return root.PulseSim;
    if (typeof require === 'function') return require('./sim.js');
    throw new Error('PulseSim is not loaded');
  }

  function resolvePolicyNet(opts) {
    if (opts.policyNet) return opts.policyNet;
    if (root.PolicyNet) return root.PolicyNet;
    if (typeof require === 'function') return require('./net.js');
    throw new Error('PolicyNet is not loaded');
  }

  /*
   * createDecision({ctx, net, prefix, cInit, nSims, rng}) -> decision
   *   net may be null (uniform priors, value 0).
   *   decision.step(k): run up to k more simulations; returns the state.
   *   decision.choose(): draw the action from the root visit counts.
   */
  function createDecision(opts) {
    var ctx = opts.ctx;
    var net = opts.net || null;
    var prefix = (opts.prefix || []).slice();
    var cInit = opts.cInit === undefined ? DEFAULTS.cInit : opts.cInit;
    var nSims = opts.nSims === undefined ? DEFAULTS.nSims : opts.nSims;
    var cBase = opts.cBase === undefined ? DEFAULTS.cBase : opts.cBase;
    var alpha = opts.alpha === undefined ? DEFAULTS.alpha : opts.alpha;
    var fraction = opts.fraction === undefined ? DEFAULTS.fraction : opts.fraction;
    var L = opts.cycleLength === undefined ? DEFAULTS.cycleLength : opts.cycleLength;
    var rng = opts.rng || makeRng(1);
    var sim = resolveSim(opts);
    var policyNet = net ? resolvePolicyNet(opts) : null;

    var root_ = makeNode(0);
    var nDone = 0;
    var bestReward = null, bestSeq = null;
    var terminalRoot = prefix.length >= L;
    var rootValue = 0;

    function expand(node, seq) {
      var priors, value;
      if (net) {
        var out = policyNet.evaluate(net, seq);
        priors = out.policy;
        value = out.value;
      } else {
        priors = new Float64Array(ACTIONS).fill(1 / ACTIONS);
        value = 0;
      }
      var children = new Array(ACTIONS);
      for (var a = 0; a < ACTIONS; a++) children[a] = makeNode(priors[a]);
      node.children = children;
      return value;
    }

    if (!terminalRoot) {
      rootValue = expand(root_, prefix);
      var noise = dirichlet(rng, alpha, ACTIONS);
      for (var a0 = 0; a0 < ACTIONS; a0++) {
        var child = root_.children[a0];
        child.prior = (1 - fraction) * child.prior + fraction * noise[a0];
      }
    }

    function selectChild(node) {
      var sqrtN = Math.sqrt(node.visits);
      var c = cInit + Math.log10((node.visits + cBase + 1) / cBase);
      var best = -Infinity, bestA = -1;
      for (var a = 0; a < ACTIONS; a++) {
        var ch = node.children[a];
        var q = ch.visits > 0 ? ch.total / ch.visits : 0;
        var u = q + ch.prior * sqrtN / (ch.visits + 1) * c;
        if (u >= best) { best = u; bestA = a; }
      }
      return bestA;
    }

    function simulate() {
      var node = root_;
      var path = [node];
      var seq = prefix.slice();
      while (node.children) {
        var a = selectChild(node);
        node = node.children[a];
        path.push(node);
        seq.push(a);
      }
      var value;
      if (seq.length >= L) {
        value = sim.reward(ctx, seq, 1);
        if (bestReward === null || value > bestReward) {
          bestReward = value;
          bestSeq = seq.slice();
        }
      } else {
        value = expand(node, seq);
      }
      for (var i = 0; i < path.length; i++) {
        path[i].total += value;
        path[i].visits += 1;
      }
    }

    function snapshot() {
      var visits = new Array(ACTIONS), priors = new Array(ACTIONS);
      for (var a = 0; a < ACTIONS; a++) {
        visits[a] = root_.children ? root_.children[a].visits : 0;
        priors[a] = root_.children ? root_.children[a].prior : 0;
      }
      return {
        done: terminalRoot || nDone >= nSims,
        nDone: nDone, nSims: nSims,
        visits: visits, priors: priors, rootValue: rootValue,
        bestReward: bestReward, bestSeq: bestSeq ? bestSeq.slice() : null
      };
    }

    function step(k) {
      var budget = k === undefined ? nSims : k;
      if (!terminalRoot) {
        while (budget > 0 && nDone < nSims) {
          simulate();
          nDone += 1;
          budget -= 1;
        }
      }
      return snapshot();
    }

    function choose() {
      var pi = new Array(ACTIONS).fill(0);
      if (terminalRoot) return { action: null, pi: pi };
      var total = 0;
      for (var a = 0; a < ACTIONS; a++) total += root_.children[a].visits;
      if (total === 0) return { action: null, pi: pi };
      for (var b = 0; b < ACTIONS; b++) pi[b] = root_.children[b].visits / total;
      var u = rng(), acc = 0, action = ACTIONS - 1;
      for (var c = 0; c < ACTIONS; c++) {
        acc += pi[c];
        if (u < acc) { action = c; break; }
      }
      return { action: action, pi: pi };
    }

    return {
      step: step, choose: choose, snapshot: snapshot,
      root: root_, prefix: prefix.slice(),
      cInit: cInit, nSims: nSims, cycleLength: L
    };
  }

  var Search = {
    defaults: DEFAULTS,
    makeRng: makeRng,
    normal: normal,
    gamma: gamma,
    dirichlet: dirichlet,
    createDecision: createDecision
  };

  root.Search = Search;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Search;
  }
})(typeof window !== 'undefined' ? window : globalThis);
