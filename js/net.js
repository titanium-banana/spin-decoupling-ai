/*
 * net.js: the policy and value network of the search, evaluated in plain
 * JavaScript from an exported PyTorch state_dict.
 *
 * Tokens are one-hot vectors of dimension 9: index 0 is the start token
 * and action a maps to index a + 1. A prefix p is the token sequence
 * [start, p_0 + 1, ..., p_k + 1]. The recurrent layer is a single-layer
 * GRU(9 -> 64) with PyTorch semantics (gate rows in the order r, z, n):
 *
 *   r = sigmoid(W_ir x + b_ir + W_hr h + b_hr)
 *   z = sigmoid(W_iz x + b_iz + W_hz h + b_hz)
 *   n = tanh(W_in x + b_in + r * (W_hn h + b_hn))
 *   h' = (1 - z) * n + z * h
 *
 * The last step's output feeds a residual trunk of ten fully connected
 * layers of width 32 and two heads: a softmax policy over 8 actions and a
 * scalar value. Hidden states are cached per prefix so that a prefix
 * extended by one action costs one GRU step.
 *
 * Classic script: defines window.PolicyNet; also exported for Node.
 */
(function (root) {
  'use strict';

  var IN = 9, HID = 64, FC = 32, ACT = 8;

  var SHAPES = {
    'gru.weight_ih_l0': [3 * HID, IN], 'gru.weight_hh_l0': [3 * HID, HID],
    'gru.bias_ih_l0': [3 * HID], 'gru.bias_hh_l0': [3 * HID],
    'fc1.weight': [FC, HID], 'fc1.bias': [FC],
    'policy.weight': [ACT, FC], 'policy.bias': [ACT],
    'value.weight': [1, FC], 'value.bias': [1]
  };
  for (var layer = 2; layer <= 10; layer++) {
    SHAPES['fc' + layer + '.weight'] = [FC, FC];
    SHAPES['fc' + layer + '.bias'] = [FC];
  }

  function sameShape(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function toArray(entry, name) {
    var expected = SHAPES[name];
    if (!entry || !entry.shape || !entry.data) {
      throw new Error('network parameter ' + name + ' is missing');
    }
    if (!sameShape(entry.shape, expected)) {
      throw new Error('network parameter ' + name + ' has shape [' +
                      entry.shape.join(',') + '], expected [' +
                      expected.join(',') + ']');
    }
    var size = 1;
    for (var i = 0; i < expected.length; i++) size *= expected[i];
    if (entry.data.length !== size) {
      throw new Error('network parameter ' + name + ' has ' +
                      entry.data.length + ' values, expected ' + size);
    }
    return Float64Array.from(entry.data);
  }

  /* create(paramsObj) -> net; paramsObj maps state_dict keys to
     {shape, data} with data flat and row-major. */
  function create(params) {
    var net = {
      wIh: toArray(params['gru.weight_ih_l0'], 'gru.weight_ih_l0'),
      wHh: toArray(params['gru.weight_hh_l0'], 'gru.weight_hh_l0'),
      bIh: toArray(params['gru.bias_ih_l0'], 'gru.bias_ih_l0'),
      bHh: toArray(params['gru.bias_hh_l0'], 'gru.bias_hh_l0'),
      fc: [null],
      policyW: toArray(params['policy.weight'], 'policy.weight'),
      policyB: toArray(params['policy.bias'], 'policy.bias'),
      valueW: toArray(params['value.weight'], 'value.weight'),
      valueB: toArray(params['value.bias'], 'value.bias'),
      cache: new Map(),
      cacheLimit: 65536
    };
    for (var l = 1; l <= 10; l++) {
      net.fc.push({ W: toArray(params['fc' + l + '.weight'], 'fc' + l + '.weight'),
                    b: toArray(params['fc' + l + '.bias'], 'fc' + l + '.bias') });
    }
    return net;
  }

  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  /* One GRU step from hidden h with the one-hot input at tokenIndex. */
  function gruStep(net, h, tokenIndex) {
    var wIh = net.wIh, wHh = net.wHh, bIh = net.bIh, bHh = net.bHh;
    var gi = new Float64Array(3 * HID);
    var gh = new Float64Array(3 * HID);
    for (var r = 0; r < 3 * HID; r++) {
      gi[r] = wIh[r * IN + tokenIndex] + bIh[r];
      var s = bHh[r];
      var row = r * HID;
      for (var k = 0; k < HID; k++) s += wHh[row + k] * h[k];
      gh[r] = s;
    }
    var out = new Float64Array(HID);
    for (var j = 0; j < HID; j++) {
      var rg = sigmoid(gi[j] + gh[j]);
      var zg = sigmoid(gi[HID + j] + gh[HID + j]);
      var ng = Math.tanh(gi[2 * HID + j] + rg * gh[2 * HID + j]);
      out[j] = (1 - zg) * ng + zg * h[j];
    }
    return out;
  }

  /* y = relu(W x + b [+ add]) */
  function dense(layer, x, add) {
    var W = layer.W, b = layer.b;
    var outDim = b.length, inDim = x.length;
    var y = new Float64Array(outDim);
    for (var i = 0; i < outDim; i++) {
      var s = b[i];
      var row = i * inDim;
      for (var k = 0; k < inDim; k++) s += W[row + k] * x[k];
      if (add) s += add[i];
      y[i] = s > 0 ? s : 0;
    }
    return y;
  }

  function heads(net, h) {
    var x = new Float64Array(HID);
    for (var i = 0; i < HID; i++) x[i] = h[i] > 0 ? h[i] : 0;
    var fc = net.fc;
    x = dense(fc[1], x);
    var y = dense(fc[2], x);
    x = dense(fc[3], y, x);
    y = dense(fc[4], x);
    x = dense(fc[5], y, x);
    y = dense(fc[6], x);
    y = dense(fc[7], y);
    x = dense(fc[8], y, x);
    var v = dense(fc[9], x);
    v = dense(fc[10], v);
    var value = net.valueB[0];
    for (var k = 0; k < FC; k++) value += net.valueW[k] * v[k];
    var logits = new Float64Array(ACT);
    var maxLogit = -Infinity;
    for (var a = 0; a < ACT; a++) {
      var s = net.policyB[a];
      for (var k2 = 0; k2 < FC; k2++) s += net.policyW[a * FC + k2] * x[k2];
      logits[a] = s;
      if (s > maxLogit) maxLogit = s;
    }
    var policy = new Float64Array(ACT), total = 0;
    for (var b = 0; b < ACT; b++) {
      policy[b] = Math.exp(logits[b] - maxLogit);
      total += policy[b];
    }
    for (var c = 0; c < ACT; c++) policy[c] /= total;
    return { policy: policy, value: value };
  }

  /* Cached entry {h, policy, value} for a prefix (array of actions). */
  function entryFor(net, prefix) {
    var key = prefix.join(',');
    var hit = net.cache.get(key);
    if (hit) return hit;
    var h;
    if (prefix.length === 0) {
      h = gruStep(net, new Float64Array(HID), 0);
    } else {
      var parent = entryFor(net, prefix.slice(0, prefix.length - 1));
      h = gruStep(net, parent.h, prefix[prefix.length - 1] + 1);
    }
    var out = heads(net, h);
    var entry = { h: h, policy: out.policy, value: out.value };
    if (net.cache.size >= net.cacheLimit) net.cache.clear();
    net.cache.set(key, entry);
    return entry;
  }

  /* evaluate(net, prefix) -> {policy: Float64Array(8), value: number} */
  function evaluate(net, prefix) {
    var entry = entryFor(net, prefix);
    return { policy: new Float64Array(entry.policy), value: entry.value };
  }

  function clearCache(net) { net.cache.clear(); }

  /* Consistency checks on a parameter set. */
  function selfTest(params) {
    var messages = [], ok = true;
    var net = create(params);
    var prefixes = [[], [3], [3, 5], [7, 7, 0, 1, 2, 3, 4, 5, 6, 7, 0]];
    for (var i = 0; i < prefixes.length; i++) {
      var out = evaluate(net, prefixes[i]);
      var sum = 0, finite = isFinite(out.value);
      for (var a = 0; a < ACT; a++) {
        sum += out.policy[a];
        if (!isFinite(out.policy[a]) || out.policy[a] < 0) finite = false;
      }
      if (!finite || Math.abs(sum - 1) > 1e-12) {
        ok = false;
        messages.push('FAIL policy of prefix [' + prefixes[i].join(',') +
                      '] is not a distribution');
      }
    }
    /* the cache must not change the answer */
    var fresh = create(params);
    var viaCache = evaluate(net, [3, 5]);
    var direct = evaluate(fresh, [3, 5]);
    var diff = Math.abs(viaCache.value - direct.value);
    for (var b = 0; b < ACT; b++) {
      diff = Math.max(diff, Math.abs(viaCache.policy[b] - direct.policy[b]));
    }
    if (diff > 1e-12) { ok = false; messages.push('FAIL cache mismatch'); }
    messages.push('network outputs finite, policies normalized, cache ' +
                  'consistent (diff ' + diff.toExponential(1) + ')');
    return { ok: ok, messages: messages };
  }

  /* Page self-test: run from the console or with ?selftest=1. */
  function runSelfTest() {
    var results = [], ok = true;
    var sim = root.PulseSim;
    var ens = root.ENSEMBLE;
    var site = root.SITE_DATA;
    function log(line) { results.push(line); if (root.console) root.console.log(line); }
    if (sim && ens) {
      var presets = (site && site.physicsPresets) || sim.presets;
      var names = Object.keys(presets);
      for (var i = 0; i < names.length; i++) {
        var r = sim.selfTest(ens.z, presets[names[i]]);
        ok = ok && r.ok;
        log('sim [' + names[i] + ']: ' + (r.ok ? 'ok' : 'FAIL') + ' | ' +
            r.messages.join(' | '));
      }
    } else {
      ok = false;
      log('sim: PulseSim or ENSEMBLE missing');
    }
    var nets = { trained: root.NET_TRAINED, untrained: root.NET_UNTRAINED };
    var labels = Object.keys(nets);
    for (var j = 0; j < labels.length; j++) {
      var data = nets[labels[j]];
      if (!data) { ok = false; log('net [' + labels[j] + ']: missing'); continue; }
      var t = selfTest(data.params);
      ok = ok && t.ok;
      log('net [' + labels[j] + ']: ' + (t.ok ? 'ok' : 'FAIL') + ' | ' +
          t.messages.join(' | '));
    }
    log('self-test ' + (ok ? 'passed' : 'FAILED'));
    return { ok: ok, lines: results };
  }

  var PolicyNet = {
    create: create,
    evaluate: evaluate,
    clearCache: clearCache,
    selfTest: selfTest,
    shapes: SHAPES
  };

  root.PolicyNet = PolicyNet;
  root.runSelfTest = runSelfTest;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PolicyNet;
  }
})(typeof window !== 'undefined' ? window : globalThis);
