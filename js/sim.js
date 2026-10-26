/*
 * sim.js: exact evaluator for pulsed spin-decoupling sequences.
 *
 * Small dense complex matrices, d = 2^N with N <= 4. Every propagator is
 * exp(-i A) for a Hermitian A, computed by scaling and squaring with a
 * Taylor series (see expmHermitian). Units: couplings, shifts and offsets
 * are the evaluator's scaled constants and multiply time in seconds
 * directly (no 2 pi anywhere): a shift or offset value is in units of
 * 2 rad/s = 1/pi Hz, a coupling value in units of 4 rad/s = 2/pi Hz, for
 * the Hamiltonian written with spin-1/2 operators.
 *
 * Conventions:
 *   - Site 0 is the most significant bit of the Kronecker product.
 *   - Hsys = sum_i (offset_m + cs_i) sigma_z^i
 *            + sum_{i<j} D_ij (2 sz_i sz_j - sx_i sx_j - sy_i sy_j)
 *     with the Pauli matrices (no factor 0.5).
 *   - Collective X = sum_i 0.5 sigma_x^i, Y likewise.
 *   - A pi/2 pulse about +-X or +-Y runs Hsys*pw +- A*(1+rot)*pi/2 and is
 *     wrapped by phase-transient rotations of pt*pi/2 about the
 *     orthogonal transverse axis (X by +Y, -X by -Y, Y by -X, -Y by +X).
 *   - A block is three subpulses, each followed by the free interval
 *     tau - pw; the third subpulse 'D' is free evolution for pw.
 *   - Reward R = -log10(1 - mean_m F_m + 1e-15), F = (|tr U|^2 + d)/(d(d+1))
 *     clipped to [0, 1].
 *
 * Classic script: defines window.PulseSim; also exported for Node.
 */
(function (root) {
  'use strict';

  var REWARD_EPSILON = 1e-15;
  var TAYLOR_ORDER = 18;
  var SCALE_LIMIT = 0.25;

  /* The eight blocks in engine order (the order the network was trained
     on): two pi/2 pulses then a bare delay. */
  var SED_TOKENS = [
    ['X', 'Y', 'D'], ['X', '-Y', 'D'], ['-X', 'Y', 'D'], ['-X', '-Y', 'D'],
    ['Y', 'X', 'D'], ['Y', '-X', 'D'], ['-Y', 'X', 'D'], ['-Y', '-X', 'D']
  ];

  var presets = {
    ideal: { N: 3, E: 5, cs: 0, dipolar: 1000, pulseWidth: 1e-6, tau: 3e-6,
             rot: 0, pt: 0, offsetSd: 0 },
    errors: { N: 3, E: 5, cs: 100, dipolar: 3000, pulseWidth: 1e-6, tau: 3e-6,
              rot: 0.015, pt: 0.01, offsetSd: 10 }
  };

  /* ---- complex matrices: {n, re, im}, row-major ---------------------- */

  function cmZero(n) {
    return { n: n, re: new Float64Array(n * n), im: new Float64Array(n * n) };
  }

  function cmEye(n) {
    var m = cmZero(n);
    for (var i = 0; i < n; i++) m.re[i * n + i] = 1;
    return m;
  }

  function cmCopy(a) {
    return { n: a.n, re: new Float64Array(a.re), im: new Float64Array(a.im) };
  }

  /* c = a * b (matrix product); c must not alias a or b. */
  function cmMulInto(c, a, b) {
    var n = a.n;
    var are = a.re, aim = a.im, bre = b.re, bim = b.im, cre = c.re, cim = c.im;
    for (var i = 0; i < n; i++) {
      var ri = i * n;
      for (var j = 0; j < n; j++) { cre[ri + j] = 0; cim[ri + j] = 0; }
      for (var k = 0; k < n; k++) {
        var xr = are[ri + k], xi = aim[ri + k];
        if (xr === 0 && xi === 0) continue;
        var rk = k * n;
        for (var j2 = 0; j2 < n; j2++) {
          var yr = bre[rk + j2], yi = bim[rk + j2];
          cre[ri + j2] += xr * yr - xi * yi;
          cim[ri + j2] += xr * yi + xi * yr;
        }
      }
    }
    return c;
  }

  function cmMul(a, b) {
    return cmMulInto(cmZero(a.n), a, b);
  }

  /* a + s * b, s real; new matrix. */
  function cmAddScaled(a, b, s) {
    var m = cmZero(a.n);
    for (var i = 0; i < m.re.length; i++) {
      m.re[i] = a.re[i] + s * b.re[i];
      m.im[i] = a.im[i] + s * b.im[i];
    }
    return m;
  }

  function cmScale(a, s) {
    var m = cmZero(a.n);
    for (var i = 0; i < m.re.length; i++) {
      m.re[i] = s * a.re[i];
      m.im[i] = s * a.im[i];
    }
    return m;
  }

  /* Kronecker product of a (p x p) and b (q x q). */
  function cmKron(a, b) {
    var p = a.n, q = b.n, n = p * q;
    var m = cmZero(n);
    for (var i = 0; i < p; i++) {
      for (var j = 0; j < p; j++) {
        var ar = a.re[i * p + j], ai = a.im[i * p + j];
        if (ar === 0 && ai === 0) continue;
        for (var k = 0; k < q; k++) {
          for (var l = 0; l < q; l++) {
            var br = b.re[k * q + l], bi = b.im[k * q + l];
            var row = i * q + k, col = j * q + l;
            m.re[row * n + col] = ar * br - ai * bi;
            m.im[row * n + col] = ar * bi + ai * br;
          }
        }
      }
    }
    return m;
  }

  /* Maximum absolute row sum (the infinity norm). */
  function cmNormInf(a) {
    var n = a.n, best = 0;
    for (var i = 0; i < n; i++) {
      var s = 0;
      for (var j = 0; j < n; j++) {
        s += Math.hypot(a.re[i * n + j], a.im[i * n + j]);
      }
      if (s > best) best = s;
    }
    return best;
  }

  /* max |(U U^dagger - I)_ij| */
  function unitarityError(u) {
    var n = u.n, best = 0;
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        var sr = 0, si = 0;
        for (var k = 0; k < n; k++) {
          var ar = u.re[i * n + k], ai = u.im[i * n + k];
          var br = u.re[j * n + k], bi = -u.im[j * n + k];
          sr += ar * br - ai * bi;
          si += ar * bi + ai * br;
        }
        if (i === j) sr -= 1;
        var e = Math.hypot(sr, si);
        if (e > best) best = e;
      }
    }
    return best;
  }

  /*
   * exp(-i A) for Hermitian A. Let M = -i A / 2^s with s chosen so that
   * the infinity norm of M is at most SCALE_LIMIT; the Taylor series of
   * exp(M) to order TAYLOR_ORDER is then accurate to well below double
   * precision, and the result is squared s times.
   */
  function expmHermitian(a) {
    var n = a.n;
    var norm = cmNormInf(a);
    var s = 0;
    while (norm > SCALE_LIMIT) { norm /= 2; s += 1; }
    var scale = Math.pow(2, -s);
    /* M = -i A * scale: re(M) = im(A) * scale, im(M) = -re(A) * scale */
    var m = cmZero(n);
    for (var i = 0; i < n * n; i++) {
      m.re[i] = a.im[i] * scale;
      m.im[i] = -a.re[i] * scale;
    }
    var sum = cmEye(n);
    var term = cmEye(n);
    var scratch = cmZero(n);
    for (var k = 1; k <= TAYLOR_ORDER; k++) {
      cmMulInto(scratch, term, m);
      var inv = 1 / k;
      for (var t = 0; t < n * n; t++) {
        term.re[t] = scratch.re[t] * inv;
        term.im[t] = scratch.im[t] * inv;
        sum.re[t] += term.re[t];
        sum.im[t] += term.im[t];
      }
    }
    for (var q = 0; q < s; q++) {
      cmMulInto(scratch, sum, sum);
      var swap = sum; sum = scratch; scratch = swap;
    }
    return sum;
  }

  /* ---- spin operators ------------------------------------------------ */

  function pauli(which) {
    var m = cmZero(2);
    if (which === 'x') { m.re[1] = 1; m.re[2] = 1; }
    else if (which === 'y') { m.im[1] = -1; m.im[2] = 1; }
    else if (which === 'z') { m.re[0] = 1; m.re[3] = -1; }
    else { m.re[0] = 1; m.re[3] = 1; }
    return m;
  }

  /* single on the given sites, identity elsewhere; site 0 is the MSB. */
  function siteOperator(single, sites, N) {
    var op = cmEye(1);
    var id2 = pauli('i');
    for (var index = 0; index < N; index++) {
      op = cmKron(op, sites.indexOf(index) >= 0 ? single : id2);
    }
    return op;
  }

  function collective(which, N) {
    var d = 1 << N;
    var total = cmZero(d);
    var half = cmScale(pauli(which), 0.5);
    for (var site = 0; site < N; site++) {
      total = cmAddScaled(total, siteOperator(half, [site], N), 1);
    }
    return total;
  }

  function clip(x, lo, hi) {
    return x < lo ? lo : (x > hi ? hi : x);
  }

  /*
   * Hamiltonians of the E ensemble members from the normals z, laid out
   * as in data/ensemble.js: member m uses z[m*(N+N*N) .. +N) for the
   * chemical shifts and the next N*N for the dipolar matrix (row-major
   * N x N, only i < j used); the last E values are the offset normals.
   */
  function buildHamiltonians(z, preset) {
    var N = preset.N, E = preset.E, d = 1 << N;
    var block = N + N * N;
    if (z.length < E * block + E) {
      throw new Error('ensemble normals: need ' + (E * block + E) +
                      ' values, got ' + z.length);
    }
    var sz = [], sxx = {}, syy = {}, szz = {};
    for (var i = 0; i < N; i++) sz.push(siteOperator(pauli('z'), [i], N));
    for (var a = 0; a < N; a++) {
      for (var b = a + 1; b < N; b++) {
        var key = a + ',' + b;
        szz[key] = siteOperator(pauli('z'), [a, b], N);
        sxx[key] = siteOperator(pauli('x'), [a, b], N);
        syy[key] = siteOperator(pauli('y'), [a, b], N);
      }
    }
    var cs = preset.cs, dip = preset.dipolar;
    var out = [];
    for (var m = 0; m < E; m++) {
      var base = m * block;
      var offset = preset.offsetSd * z[E * block + m];
      var H = cmZero(d);
      for (var s = 0; s < N; s++) {
        var shift = clip(cs * z[base + s], -1.5 * cs, 1.5 * cs);
        H = cmAddScaled(H, sz[s], offset + shift);
      }
      for (var p = 0; p < N; p++) {
        for (var q = p + 1; q < N; q++) {
          var zi = z[base + N + p * N + q];
          var D = clip(dip + 0.25 * dip * zi, 0.5 * dip, 1.5 * dip);
          var k = p + ',' + q;
          H = cmAddScaled(H, szz[k], 2 * D);
          H = cmAddScaled(H, sxx[k], -D);
          H = cmAddScaled(H, syy[k], -D);
        }
      }
      out.push(H);
    }
    return out;
  }

  /* The component unitaries of one member. */
  function buildComponents(H, X, Y, preset, wraps) {
    var pw = preset.pulseWidth, tau = preset.tau, rot = preset.rot;
    var amp = (1 + rot) * Math.PI / 2;
    var Hpw = cmScale(H, pw);
    function central(axis, sign) {
      return expmHermitian(cmAddScaled(Hpw, axis, sign * amp));
    }
    function sandwich(w, c) { return cmMul(w, cmMul(c, w)); }
    return {
      'D': expmHermitian(Hpw),
      'X': sandwich(wraps.ty, central(X, 1)),
      '-X': sandwich(wraps.tym, central(X, -1)),
      'Y': sandwich(wraps.txm, central(Y, 1)),
      '-Y': sandwich(wraps.tx, central(Y, -1)),
      'delay': expmHermitian(cmScale(H, tau - pw))
    };
  }

  function buildBlocks(comp) {
    var d = comp.delay.n;
    var blocks = [];
    for (var a = 0; a < SED_TOKENS.length; a++) {
      var u = cmEye(d);
      var token = SED_TOKENS[a];
      for (var s = 0; s < token.length; s++) {
        u = cmMul(comp[token[s]], u);
        u = cmMul(comp.delay, u);
      }
      blocks.push(u);
    }
    return blocks;
  }

  /*
   * build(z, preset) -> ctx with
   *   ctx.H[m], ctx.X, ctx.Y, ctx.components[m], ctx.blocks[m][a],
   *   ctx.cache (Map of prefix products keyed by seq.join(',')).
   */
  function build(z, preset) {
    var N = preset.N, E = preset.E, d = 1 << N;
    var H = buildHamiltonians(z, preset);
    var X = collective('x', N);
    var Y = collective('y', N);
    var ptAmp = Math.PI / 2 * preset.pt;
    var wraps = {
      ty: expmHermitian(cmScale(Y, ptAmp)),
      tym: expmHermitian(cmScale(Y, -ptAmp)),
      tx: expmHermitian(cmScale(X, ptAmp)),
      txm: expmHermitian(cmScale(X, -ptAmp))
    };
    var components = [], blocks = [];
    for (var m = 0; m < E; m++) {
      var comp = buildComponents(H[m], X, Y, preset, wraps);
      components.push(comp);
      blocks.push(buildBlocks(comp));
    }
    return {
      preset: preset, N: N, E: E, d: d, z: z,
      H: H, X: X, Y: Y, wraps: wraps,
      components: components, blocks: blocks,
      cache: new Map(), cacheLimit: 4096
    };
  }

  /* Product of the blocks of seq for every member (later blocks on the
     left), memoized per prefix in ctx.cache. */
  function prefixProduct(ctx, seq) {
    if (seq.length === 0) {
      var eye = [];
      for (var m = 0; m < ctx.E; m++) eye.push(cmEye(ctx.d));
      return eye;
    }
    var key = seq.join(',');
    var hit = ctx.cache.get(key);
    if (hit) return hit;
    var parent = prefixProduct(ctx, seq.slice(0, seq.length - 1));
    var last = seq[seq.length - 1];
    var out = [];
    for (var e = 0; e < ctx.E; e++) {
      out.push(cmMul(ctx.blocks[e][last], parent[e]));
    }
    if (ctx.cache.size >= ctx.cacheLimit) ctx.cache.clear();
    ctx.cache.set(key, out);
    return out;
  }

  function fidelity(u) {
    var n = u.n, tr = 0, ti = 0;
    for (var i = 0; i < n; i++) { tr += u.re[i * n + i]; ti += u.im[i * n + i]; }
    var f = (tr * tr + ti * ti + n) / (n * (n + 1));
    return clip(f, 0, 1);
  }

  function rewardOfUnitaries(us) {
    var mean = 0;
    for (var m = 0; m < us.length; m++) mean += fidelity(us[m]);
    mean /= us.length;
    return -Math.log10(1 - mean + REWARD_EPSILON);
  }

  /* reward(ctx, seq, cycles): R of seq repeated `cycles` times. */
  function reward(ctx, seq, cycles) {
    var n = (cycles === undefined) ? 1 : cycles;
    var one = prefixProduct(ctx, seq);
    var us = one;
    for (var c = 1; c < n; c++) {
      var next = [];
      for (var m = 0; m < one.length; m++) next.push(cmMul(one[m], us[m]));
      us = next;
    }
    return rewardOfUnitaries(us);
  }

  /* Reward of free evolution for nTau delays and no pulses. */
  function freeEvolutionReward(ctx, nTau) {
    var us = [];
    for (var m = 0; m < ctx.E; m++) {
      us.push(expmHermitian(cmScale(ctx.H[m], nTau * ctx.preset.tau)));
    }
    return rewardOfUnitaries(us);
  }

  /* Unitarity of every component and block, plus a few sanity checks. */
  function selfTest(z, preset) {
    var messages = [], ok = true;
    var ctx = build(z, preset);
    var worst = 0;
    var names = ['D', 'X', '-X', 'Y', '-Y', 'delay'];
    for (var m = 0; m < ctx.E; m++) {
      for (var i = 0; i < names.length; i++) {
        worst = Math.max(worst, unitarityError(ctx.components[m][names[i]]));
      }
      for (var a = 0; a < 8; a++) {
        worst = Math.max(worst, unitarityError(ctx.blocks[m][a]));
      }
    }
    messages.push('unitarity error of components and blocks: ' +
                  worst.toExponential(2));
    if (!(worst < 1e-10)) { ok = false; messages.push('FAIL unitarity'); }
    /* exp(-i * 0) is the identity */
    var eyeErr = unitarityError(expmHermitian(cmZero(ctx.d)));
    if (!(eyeErr < 1e-15)) { ok = false; messages.push('FAIL expm(0)'); }
    /* a pi/2 pulse followed by its inverse (without wraps, ideal) */
    var r = reward(ctx, [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3], 1);
    if (!isFinite(r)) { ok = false; messages.push('FAIL reward not finite'); }
    messages.push('sample reward ' + r.toFixed(4));
    return { ok: ok, maxUnitarityError: worst, messages: messages };
  }

  var PulseSim = {
    presets: presets,
    tokens: SED_TOKENS,
    build: build,
    reward: reward,
    prefixProduct: prefixProduct,
    freeEvolutionReward: freeEvolutionReward,
    expmHermitian: expmHermitian,
    unitarityError: unitarityError,
    selfTest: selfTest,
    cm: { zero: cmZero, eye: cmEye, copy: cmCopy, mul: cmMul,
          addScaled: cmAddScaled, scale: cmScale, kron: cmKron,
          normInf: cmNormInf }
  };

  root.PulseSim = PulseSim;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PulseSim;
  }
})(typeof window !== 'undefined' ? window : globalThis);
