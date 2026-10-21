/* ===========================================================================
 * design.js -- trial generation, the frequency-plan check, and scoring.
 *
 * A line-for-line port of reference/reference_design.py, which is the spec.
 * Mirrored by matlab/+cmcore/{generateTrialList, assertTrialList,
 * frequencyPlan, scoreTrial}.m. All three are checked against the golden
 * fixture by web/verify/verify.html and matlab/verifyDesign.m.
 *
 * ES5 only (no arrow functions, no let/const) so it runs from file:// in any
 * browser and could be executed by an ES5 interpreter for testing.
 * =========================================================================== */
(function (root) {
  'use strict';

  var CFG = root.XMConfig;
  var Minstd = root.XMMinstd;
  var ARRAYS = ['A', 'B'];

  function DesignError(msg) {
    this.name = 'DesignError';
    this.message = msg;
  }
  DesignError.prototype = Object.create(Error.prototype);

  /* ======================================================= pulse geometry */
  /* Independent of the duty cycle, so the trial list never depends on it. */
  function nPulses(arr) {
    return Math.floor((CFG.STIM_TICKS - CFG.PULSE_TAIL_TICKS - CFG.PULSE_PHASE_TICKS[arr]) /
                      CFG.PULSE_PERIOD_TICKS[arr]) + 1;
  }

  function pulseOnsetTicks(arr, k) {
    return CFG.PULSE_PHASE_TICKS[arr] + k * CFG.PULSE_PERIOD_TICKS[arr];
  }

  /* Pulses that may carry a target: inside the onset limits AND at least
   * TGT_MIN_OTHER_SEP_TICKS from every pulse of the other array. Without the
   * second rule, a target in the UNMATCHED array could land 17 ms from a
   * matched pulse and its pip, i.e. be effectively audio-synchronised too. */
  function eligiblePulses(arr) {
    var other = arr === 'A' ? 'B' : 'A';
    var nO = nPulses(other), out = [], k, j, t, d, dmin;
    for (k = 0; k < nPulses(arr); k++) {
      t = pulseOnsetTicks(arr, k);
      if (t < CFG.TGT_MIN_ONSET_TICKS || t > CFG.TGT_MAX_ONSET_TICKS) { continue; }
      dmin = Infinity;
      for (j = 0; j < nO; j++) {
        d = Math.abs(t - pulseOnsetTicks(other, j));
        if (d < dmin) { dmin = d; }
      }
      if (dmin < CFG.TGT_MIN_OTHER_SEP_TICKS) { continue; }
      out.push(k);
    }
    return out;
  }

  /* ======================================================= design settings (DECISIONS 34-35) */
  /* floor(x + 0.5) in all three ports (Python's round() is banker's rounding). */
  function roundHalfUp(x) { return Math.floor(x + 0.5); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function numSort(a, b) { return a - b; }

  function defaultDesignParams() {
    return { burstPct: CFG.BURST_PCT_DEFAULT.slice(), nOneBlocks: CFG.N_ONE_BLOCKS_DEFAULT,
             soundOnPct: CFG.SOUND_ON_PCT_DEFAULT };
  }

  /* Setup-screen check of the three trial-list settings. Returns a list of
   * errors; [] = valid. Mirrors validate_design_params and
   * +cmcore/validateDesignParams.m. */
  function validateDesignParams(dp) {
    var errs = [], v, bp = dp.burstPct, sum = 0, vals = [];
    for (v = 0; v <= CFG.MAX_BURSTS; v++) { vals.push(['% of trials with ' + v + ' burst(s)', bp[v]]); }
    vals.push(['attend-one blocks', dp.nOneBlocks], ['sound-on %', dp.soundOnPct]);
    vals.forEach(function (x) { if (!isNum(x[1])) { errs.push('D1 ' + x[0] + ' must be a number'); } });
    if (errs.length) { return errs; }
    for (v = 0; v <= CFG.MAX_BURSTS; v++) {
      if (!(bp[v] >= 0 && bp[v] <= 100)) {
        errs.push('D2 % of trials with ' + v + ' burst(s) (' + bp[v] + '%) is outside 0-100%');
      }
      sum += bp[v];
    }
    if (!errs.length && Math.abs(sum - 100) > 1e-6) {
      errs.push('D3 the burst-count percentages add up to ' + sum + '%, not 100%');
    }
    if (!(dp.soundOnPct >= 0 && dp.soundOnPct <= 100)) {
      errs.push('D4 sound-on ' + dp.soundOnPct + '% is outside 0-100%');
    }
    var n1 = dp.nOneBlocks;
    if (!(n1 === Math.floor(n1) && n1 >= 0 && n1 <= CFG.N_BLOCKS)) {
      errs.push('D5 attend-one blocks (' + n1 + ') must be a whole number from 0 to ' + CFG.N_BLOCKS);
    }
    return errs;
  }

  /* Trials per cell in each block, in session order: [{cellCode: count}].
   * Attend-one block: half cell 1, half cell 2. Attend-both block j (0-based
   * among the attend-both blocks): nS = round(BLOCK_TRIALS x soundOnPct/100)
   * sound trials split evenly between cells 4 and 5; an odd one goes to cell
   * 4 in even-numbered and to cell 5 in odd-numbered attend-both blocks. */
  function blockComposition(blockTypes, dp) {
    var out = [], j = 0, BT = CFG.BLOCK_TRIALS;
    var nS = roundHalfUp(BT * dp.soundOnPct / 100);
    blockTypes.forEach(function (bt) {
      var c = {};
      if (bt === 'one') { c[1] = BT / 2; c[2] = BT / 2; }
      else {
        var sA = Math.floor(nS / 2) + ((nS % 2 === 1 && j % 2 === 0) ? 1 : 0);
        c[3] = BT - nS; c[4] = sA; c[5] = nS - sA;
        j++;
      }
      out.push(c);
    });
    return out;
  }

  /* How many of n trials get 0, 1, 2, 3 bursts: n x pct/100 by largest
   * remainder (floors first; leftovers to the largest fractional parts, ties
   * to the smaller count). Ascending list, e.g. n 100, [0,90,10,0] -> 90 x 1,
   * 10 x 2. Mirrors burst_count_multiset. */
  function burstCountMultiset(n, pct) {
    var exact = [], base = [], idx = [], rem = n, v, i, out = [];
    for (v = 0; v < pct.length; v++) {
      exact.push(n * pct[v] / 100);
      base.push(Math.floor(exact[v]));
      rem -= base[v];
      idx.push(v);
    }
    idx.sort(function (p, q) { return ((exact[q] - base[q]) - (exact[p] - base[p])) || (p - q); });
    for (i = 0; i < rem; i++) { base[idx[i]]++; }
    for (v = 0; v < pct.length; v++) { for (i = 0; i < base[v]; i++) { out.push(v); } }
    return out;
  }

  /* ======================================================= trial generation */
  /* Slots ['A']*nA + ['B']*nB are visited in random order; each draws
   * uniformly from its array's eligible pulses that are >= TGT_MIN_GAP_TICKS
   * from every target already placed in EITHER array. A slot with no
   * candidate restarts the whole placement. */
  function placeTargets(rng, nA, nB) {
    var slots = [], i, s, a, k, t, ok, order, placed, cands, far, p, attempt;
    for (i = 0; i < nA; i++) { slots.push('A'); }
    for (i = 0; i < nB; i++) { slots.push('B'); }
    var elig = { A: eligiblePulses('A'), B: eligiblePulses('B') };

    for (attempt = 1; attempt <= CFG.MAX_PLACE_ATTEMPTS; attempt++) {
      order = rng.shuffleIndices(slots.length);
      placed = [];
      ok = true;
      for (s = 0; s < order.length; s++) {
        a = slots[order[s]];
        cands = [];
        for (i = 0; i < elig[a].length; i++) {
          k = elig[a][i];
          t = pulseOnsetTicks(a, k);
          far = true;
          for (p = 0; p < placed.length; p++) {
            if (Math.abs(t - placed[p].onset) < CFG.TGT_MIN_GAP_TICKS) { far = false; break; }
          }
          if (far) { cands.push(k); }
        }
        if (cands.length === 0) { ok = false; break; }
        k = cands[rng.randInt(cands.length)];
        placed.push({ arr: a, k: k, onset: pulseOnsetTicks(a, k) });
      }
      if (ok) { return { placed: placed, attempts: attempt }; }
    }
    throw new DesignError('target placement failed after ' + CFG.MAX_PLACE_ATTEMPTS + ' attempts');
  }

  /* The full N_BLOCKS x BLOCK_TRIALS list for design settings dp (omitted =
   * the config defaults). The RNG draw order is the spec (generate_trial_list):
   *   1. shuffle(N_BLOCKS) -> block order
   *   2. per cell, code order: shuffle(n) of the burst-count multiset; all of a
   *      trial's bursts go to ONE array (DECISION 37): the cued one in an
   *      attend-one cell (no draws); in an attend-both cell, for v = 1..3 the m
   *      trials with v bursts: randInt(2) for an odd m (odd one A/B), shuffle(m)
   *      of the A/B labels; per trial dir_A = 1 + randInt(4), dir_B = others[randInt(3)]
   *   3. deal into blocks (no draws)   4. shuffle within each block
   *   5. per trial: targets, one randInt(2) tilt sign per target (A's, then
   *      B's), ITI */
  function generateTrialList(seed, dp) {
    dp = dp || defaultDesignParams();
    var rng = new Minstd(seed);
    var c, i, j, b, q, code;

    /* ---- 1. block order ---- */
    var types0 = [];
    for (b = 0; b < CFG.N_BLOCKS; b++) { types0.push(b < dp.nOneBlocks ? 'one' : 'both'); }
    var blockTypes = rng.shuffleIndices(CFG.N_BLOCKS).map(function (p) { return types0[p]; });
    var comp = blockComposition(blockTypes, dp);
    var cellN = {};
    CFG.CELLS.forEach(function (cl) {
      cellN[cl.code] = 0;
      comp.forEach(function (bc) { cellN[cl.code] += bc[cl.code] || 0; });
    });

    /* ---- 2. per cell: bursts per trial, their arrays, directions ---- */
    var perCell = {};
    for (c = 0; c < CFG.CELLS.length; c++) {
      var cell = CFG.CELLS[c], n = cellN[cell.code];
      var base = burstCountMultiset(n, dp.burstPct);
      var permC = rng.shuffleIndices(n);
      var nb = [], arrOf = [];
      for (i = 0; i < n; i++) { nb.push(base[permC[i]]); arrOf.push(cell.attend); }   // attend-one: the cued array
      if (cell.attend === 'both') {
        for (var v = 1; v <= CFG.MAX_BURSTS; v++) {
          var ix = [];
          for (i = 0; i < n; i++) { if (nb[i] === v) { ix.push(i); } }
          var m = ix.length, labels = [];
          for (i = 0; i < Math.floor(m / 2); i++) { labels.push('A'); }
          for (i = 0; i < Math.floor(m / 2); i++) { labels.push('B'); }
          if (m % 2 === 1) { labels.push(rng.randInt(2) === 0 ? 'A' : 'B'); }
          var permL = rng.shuffleIndices(m);
          for (q = 0; q < m; q++) { arrOf[ix[q]] = labels[permL[q]]; }
        }
      }
      var cellTrials = [];
      for (i = 0; i < n; i++) {
        var dA = 1 + rng.randInt(4);
        var others = [];
        for (j = 1; j <= 4; j++) { if (j !== dA) { others.push(j); } }
        var dB = others[rng.randInt(3)];          // dir_B != dir_A by construction
        cellTrials.push({
          cell: cell.code, cond: cell.name, attend: cell.attend, sound_match: cell.sound,
          block_type: cell.blockType, dir_A: dA, dir_B: dB,
          n_tgt_A: arrOf[i] === 'A' ? nb[i] : 0, n_tgt_B: arrOf[i] === 'B' ? nb[i] : 0
        });
      }
      perCell[cell.code] = cellTrials;
    }

    /* ---- 3. deal cells into blocks ---- */
    var ptr = {}, blocks = [];
    CFG.CELLS.forEach(function (cl) { ptr[cl.code] = 0; });
    for (b = 0; b < CFG.N_BLOCKS; b++) {
      var bt = [];
      for (c = 0; c < CFG.CELLS.length; c++) {
        code = CFG.CELLS[c].code;
        for (i = 0; i < (comp[b][code] || 0); i++) { bt.push(perCell[code][ptr[code]++]); }
      }
      blocks.push(bt);
    }

    /* ---- 4. shuffle within block ---- */
    var ordered = [];
    for (b = 0; b < CFG.N_BLOCKS; b++) {
      var perm = rng.shuffleIndices(blocks[b].length);
      for (j = 0; j < perm.length; j++) {
        var t = shallowCopy(blocks[b][perm[j]]);
        t.block = b + 1;
        t.trial_in_block = j + 1;
        ordered.push(t);
      }
    }

    /* ---- 5. per trial, in final order: targets, tilt signs, ITI, dot seed ---- */
    var sign = function () { return rng.randInt(2) === 0 ? 1 : -1; };
    for (i = 0; i < ordered.length; i++) {
      var tr = ordered[i];
      var res = placeTargets(rng, tr.n_tgt_A, tr.n_tgt_B);
      tr.trial = i + 1;
      tr.tgt_A_pulses = [];
      tr.tgt_B_pulses = [];
      for (j = 0; j < res.placed.length; j++) {
        (res.placed[j].arr === 'A' ? tr.tgt_A_pulses : tr.tgt_B_pulses).push(res.placed[j].k);
      }
      tr.tgt_A_pulses.sort(numSort);
      tr.tgt_B_pulses.sort(numSort);
      tr.tgt_A_onset_ticks = tr.tgt_A_pulses.map(function (k) { return pulseOnsetTicks('A', k); });
      tr.tgt_B_onset_ticks = tr.tgt_B_pulses.map(function (k) { return pulseOnsetTicks('B', k); });
      tr.tgt_A_tilt_sign = tr.tgt_A_pulses.map(sign);
      tr.tgt_B_tilt_sign = tr.tgt_B_pulses.map(sign);
      tr.place_attempts = res.attempts;
      tr.iti_ticks = CFG.ITI_MIN_TICKS + rng.randInt(CFG.ITI_JITTER_TICKS + 1);
      tr.dot_seed = CFG.DOT_SEED_BASE + tr.trial * CFG.DOT_SEED_STRIDE;
    }

    return { trials: ordered, blockTypes: blockTypes, cellN: cellN };
  }

  function shallowCopy(o) {
    var r = {};
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { r[k] = o[k]; } }
    return r;
  }

  /* Practice: the first ceil(n/2) trials of the first attend-one block, then
   * the first floor(n/2) of the first attend-both block (all n from one type
   * if the other has no blocks), renumbered 1..n in block 0. Mirrors
   * practice_trials and +cmcore/practiceTrials.m. */
  function practiceTrials(trials, n) {
    function firstBlock(bt) {
      var b = -1;
      for (var i = 0; i < trials.length; i++) { if (trials[i].block_type === bt) { b = trials[i].block; break; } }
      return trials.filter(function (t) { return t.block === b; });
    }
    var one = firstBlock('one'), both = firstBlock('both');
    var nOne = one.length ? (both.length ? Math.floor((n + 1) / 2) : n) : 0;
    var out = one.slice(0, nOne).concat(both.slice(0, n - nOne)).map(shallowCopy);
    out.forEach(function (t, i) { t.trial = i + 1; t.block = 0; t.trial_in_block = i + 1; });
    return out;
  }

  /* ======================================================= assertions */
  /* Throws DesignError on ANY violation. Mirrors assert_trial_list. */
  function assertTrialList(trials, dp) {
    dp = dp || defaultDesignParams();
    function fail(msg) { throw new DesignError(msg); }
    function countOf(list, v) { return list.filter(function (x) { return x === v; }).length; }
    var c, i, j, b, a, k, v;

    if (!(CFG.TGT_MIN_GAP_TICKS / CFG.GRID_HZ > CFG.RESP_WIN_MAX_S - CFG.RESP_WIN_MIN_S)) {
      fail('min target gap does not keep response windows disjoint');
    }
    if (CFG.TGT_MAX_ONSET_TICKS + CFG.RESP_WIN_MAX_S * CFG.GRID_HZ > CFG.STIM_TICKS + 1e-9) {
      fail('last eligible target response window extends past stimulus end');
    }
    if (CFG.BLOCK_TRIALS % 2 !== 0) {
      fail('BLOCK_TRIALS must be even (attend-one blocks are half red, half blue cue)');
    }
    if (trials.length !== CFG.nTrials()) {
      fail('expected ' + CFG.nTrials() + ' trials, got ' + trials.length);
    }

    /* ---- blocks: type, size, composition ---- */
    var blockTypes = [];
    for (b = 1; b <= CFG.N_BLOCKS; b++) {
      var bt = trials.filter(function (t) { return t.block === b; });
      if (bt.length !== CFG.BLOCK_TRIALS) { fail('block ' + b + ': ' + bt.length + ' trials, expected ' + CFG.BLOCK_TRIALS); }
      var ty = bt[0].block_type;
      for (i = 0; i < bt.length; i++) {
        if (bt[i].block_type !== ty || (ty !== 'one' && ty !== 'both')) { fail('block ' + b + ': mixed or unknown block type'); }
        if (bt[i].trial_in_block !== i + 1) { fail('block ' + b + ': trial_in_block is not 1..' + CFG.BLOCK_TRIALS + ' in order'); }
      }
      blockTypes.push(ty);
    }
    if (countOf(blockTypes, 'one') !== dp.nOneBlocks) {
      fail(countOf(blockTypes, 'one') + ' attend-one blocks, expected ' + dp.nOneBlocks);
    }
    var comp = blockComposition(blockTypes, dp);
    for (b = 0; b < CFG.N_BLOCKS; b++) {
      for (c = 0; c < CFG.CELLS.length; c++) {
        var code = CFG.CELLS[c].code, got = 0;
        for (i = 0; i < trials.length; i++) { if (trials[i].block === b + 1 && trials[i].cell === code) { got++; } }
        if (got !== (comp[b][code] || 0)) {
          fail('block ' + (b + 1) + ' (' + blockTypes[b] + '): ' + got + ' trials of cell ' + code +
               ', expected ' + (comp[b][code] || 0));
        }
      }
    }

    /* ---- cells: fields, burst-count distribution, deviant array (DECISION 37) ---- */
    for (c = 0; c < CFG.CELLS.length; c++) {
      var cell = CFG.CELLS[c];
      var ct = trials.filter(function (t) { return t.cell === cell.code; });
      for (i = 0; i < ct.length; i++) {
        if (ct[i].attend !== cell.attend || ct[i].sound_match !== cell.sound || ct[i].cond !== cell.name ||
            ct[i].block_type !== cell.blockType) {
          fail('trial ' + ct[i].trial + ': condition fields inconsistent with cell ' + cell.code);
        }
      }
      var want = burstCountMultiset(ct.length, dp.burstPct);
      var have = ct.map(function (t) { return t.n_tgt_A + t.n_tgt_B; }).sort(numSort);
      if (have.join(',') !== want.join(',')) {
        var hc = [], wc = [];
        for (v = 0; v <= CFG.MAX_BURSTS; v++) { hc.push(countOf(have, v)); wc.push(countOf(want, v)); }
        fail('cell ' + cell.code + ': bursts-per-trial counts [' + hc + '], expected [' + wc + ']');
      }
      if (cell.attend !== 'both') {
        var other = cell.attend === 'A' ? 'B' : 'A';
        for (i = 0; i < ct.length; i++) {
          if (ct[i]['n_tgt_' + other] !== 0) {
            fail('trial ' + ct[i].trial + ': burst in the uncued array ' + other + ' (attend ' + cell.attend + ')');
          }
        }
      } else {
        for (v = 1; v <= CFG.MAX_BURSTS; v++) {
          var na = 0, nb = 0;
          for (i = 0; i < ct.length; i++) { if (ct[i].n_tgt_A === v) { na++; } if (ct[i].n_tgt_B === v) { nb++; } }
          if (Math.abs(na - nb) > 1) {
            fail('cell ' + cell.code + ': ' + na + ' trials with ' + v + ' burst(s) in A vs ' + nb +
                 ' in B (must differ by at most 1)');
          }
        }
      }
    }

    /* ---- trials ---- */
    var elig = { A: eligiblePulses('A'), B: eligiblePulses('B') };
    for (i = 0; i < trials.length; i++) {
      var t = trials[i];
      if (!(t.dir_A >= 1 && t.dir_A <= 4 && t.dir_B >= 1 && t.dir_B <= 4)) {
        fail('trial ' + t.trial + ': direction out of range');
      }
      if (t.dir_A === t.dir_B) { fail('trial ' + t.trial + ': dir_A == dir_B'); }
      if (t.n_tgt_A + t.n_tgt_B > CFG.MAX_BURSTS) { fail('trial ' + t.trial + ': more than ' + CFG.MAX_BURSTS + ' bursts'); }
      if (t.n_tgt_A > 0 && t.n_tgt_B > 0) { fail('trial ' + t.trial + ': bursts in both arrays'); }
      var onsets = [];
      for (a = 0; a < ARRAYS.length; a++) {
        var ks = t['tgt_' + ARRAYS[a] + '_pulses'], sg = t['tgt_' + ARRAYS[a] + '_tilt_sign'];
        if (ks.length !== t['n_tgt_' + ARRAYS[a]]) {
          fail('trial ' + t.trial + ': ' + ks.length + ' ' + ARRAYS[a] + ' targets placed, ' +
               t['n_tgt_' + ARRAYS[a]] + ' required');
        }
        if (sg.length !== ks.length || sg.some(function (x) { return x !== 1 && x !== -1; })) {
          fail('trial ' + t.trial + ': tilt signs of ' + ARRAYS[a] + ' must be one +1/-1 per target');
        }
        for (j = 0; j < ks.length; j++) {
          k = ks[j];
          if (elig[ARRAYS[a]].indexOf(k) < 0) {
            fail('trial ' + t.trial + ': pulse ' + ARRAYS[a] + k + ' is not eligible');
          }
          onsets.push(pulseOnsetTicks(ARRAYS[a], k));
        }
      }
      onsets.sort(numSort);
      for (j = 1; j < onsets.length; j++) {
        if (onsets[j] - onsets[j - 1] < CFG.TGT_MIN_GAP_TICKS) {
          fail('trial ' + t.trial + ': targets ' + (onsets[j] - onsets[j - 1]) + ' ticks apart (< ' +
               CFG.TGT_MIN_GAP_TICKS + ')');
        }
      }
      if (t.iti_ticks < CFG.ITI_MIN_TICKS || t.iti_ticks > CFG.ITI_MIN_TICKS + CFG.ITI_JITTER_TICKS) {
        fail('trial ' + t.trial + ': ITI out of range');
      }
    }
    return true;
  }

  var CSV_COLUMNS = [
    'trial', 'block', 'block_type', 'trial_in_block', 'cell', 'cond', 'attend', 'sound_match',
    'dir_A', 'dir_B', 'n_tgt_A', 'n_tgt_B',
    'tgt_A_pulses', 'tgt_B_pulses', 'tgt_A_onset_ticks', 'tgt_B_onset_ticks',
    'tgt_A_tilt_sign', 'tgt_B_tilt_sign',
    'place_attempts', 'iti_ticks', 'dot_seed'
  ];

  function toCsv(trials) {
    var lines = [CSV_COLUMNS.join(',')];
    for (var i = 0; i < trials.length; i++) {
      var row = [];
      for (var c = 0; c < CSV_COLUMNS.length; c++) {
        var v = trials[i][CSV_COLUMNS[c]];
        row.push(Array.isArray(v) ? v.join(';') : String(v));
      }
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  /* ======================================================= stimulus settings (DECISIONS 28-29, 33, 38) */
  /* Coherent frames per pulse: duty % of the pulse period, nearest frame. */
  function windowFrames(dutyPct, pulseFrames) { return roundHalfUp(dutyPct * pulseFrames / 100); }

  /* Dots in a pulse's coherent subset. */
  function nCoherent(pct, nDots) { return roundHalfUp(pct * nDots / 100); }

  function defaultStimParams() {
    return { cohBgPct: CFG.COH_BG_PCT_DEFAULT, cohTgtPct: CFG.COH_TGT_PCT_DEFAULT, dutyPct: CFG.DUTY_PCT_DEFAULT,
             speedDegS: CFG.DOT_SPEED_DEG_S_DEFAULT, burstSpeedDegS: CFG.BURST_SPEED_DEG_S_DEFAULT,
             lumDipPct: CFG.LUM_DIP_PCT_DEFAULT, tiltDeg: CFG.TILT_DEG_DEFAULT,
             resetMotion: CFG.RESET_MOTION_DEFAULT };
  }

  /* Setup-screen check of the session-adjustable stimulus settings.
   * Returns a list of errors; [] = valid. Whether the duty cycle gives >= 1
   * frame is checked later by planCheck R9, once the refresh rate is known.
   * V6 (DECISION 38): the deviant must differ from a background pulse in at
   * least one layer -- more coherent dots, a luminance dip, or (only if it has
   * coherent dots to carry them) a different speed or a tilt.
   * Mirrors validate_stim_params and +cmcore/validateStimParams.m. */
  function validateStimParams(p) {
    var errs = [];
    var vals = [['background coherence', p.cohBgPct], ['deviant coherence', p.cohTgtPct], ['duty cycle', p.dutyPct],
                ['normal speed', p.speedDegS], ['deviant speed', p.burstSpeedDegS],
                ['luminance dip', p.lumDipPct], ['tilt', p.tiltDeg]];
    vals.forEach(function (v) {
      if (!isNum(v[1])) { errs.push('V1 ' + v[0] + ' must be a number'); }
    });
    if (errs.length) { return errs; }
    vals.slice(0, 2).forEach(function (v) {
      if (!(v[1] >= 0 && v[1] <= 100)) { errs.push('V2 ' + v[0] + ' ' + v[1] + '% is outside 0-100%'); }
    });
    if (!(p.dutyPct > 0 && p.dutyPct <= 100)) {
      errs.push('V3 duty cycle ' + p.dutyPct + '% must be above 0 and at most 100%');
    }
    if (p.cohTgtPct < p.cohBgPct) {
      errs.push('V4 deviant coherence (' + p.cohTgtPct + '%) must not be lower than background coherence (' +
                p.cohBgPct + '%)');
    }
    vals.slice(3, 5).forEach(function (v) {
      if (!(v[1] > 0 && v[1] <= CFG.SPEED_MAX_DEG_S)) {
        errs.push('V5 ' + v[0] + ' ' + v[1] + ' deg/s must be above 0 and at most ' + CFG.SPEED_MAX_DEG_S + ' deg/s');
      }
    });
    if (!(p.lumDipPct >= 0 && p.lumDipPct <= 100)) {
      errs.push('V7 luminance dip ' + p.lumDipPct + '% must be 0 (off) to 100%');
    }
    if (!(p.tiltDeg >= 0 && p.tiltDeg <= CFG.TILT_MAX_DEG)) {
      errs.push('V8 tilt ' + p.tiltDeg + ' deg must be 0 (off) to ' + CFG.TILT_MAX_DEG + ' deg');
    }
    if (!errs.length) {
      var nBg = nCoherent(p.cohBgPct, CFG.N_DOTS_PER_ARRAY), nTgt = nCoherent(p.cohTgtPct, CFG.N_DOTS_PER_ARRAY);
      if (!(nTgt > nBg || p.lumDipPct > 0 ||
            (nTgt > 0 && (p.burstSpeedDegS !== p.speedDegS || p.tiltDeg > 0)))) {
        errs.push('V6 a deviant event would look exactly like a background pulse: raise its ' +
                  'coherence, change its speed, or set a luminance dip or tilt');
      }
    }
    return errs;
  }

  /* ======================================================= frequency plan */
  /* Returns { plan, errors }. errors.length === 0 means the plan is valid at
   * this NOMINAL refresh rate and duty cycle (default DUTY_PCT_DEFAULT). Rule
   * numbers R1-R9 match the reference and DESIGN_LOG.md section 3. */
  function planCheck(planName, refreshHz, dutyPct) {
    var errs = [], a, i, n;
    if (dutyPct === undefined) { dutyPct = CFG.DUTY_PCT_DEFAULT; }
    var P = CFG.FREQ_PLANS[planName];
    if (!P) { return { plan: null, errors: ['unknown frequency plan "' + planName + '"'] }; }
    var R = refreshHz;

    if (!(R > 0) || R !== Math.floor(R)) {
      return { plan: null, errors: ['R1 refresh ' + R + ' Hz is not a positive integer'] };
    }
    if (R % CFG.GRID_HZ !== 0) {
      return { plan: null, errors: ['R2 ' + R + ' Hz is not a multiple of ' + CFG.GRID_HZ +
        ' Hz: trial timing (1/' + CFG.GRID_HZ + ' s grid) is not a whole number of frames'] };
    }
    var fpt = R / CFG.GRID_HZ;
    var plan = { name: planName, refreshHz: R, framesPerTick: fpt,
                 stimFrames: CFG.STIM_TICKS * fpt, dutyPct: dutyPct };

    for (i = 0; i < ARRAYS.length; i++) {
      a = ARRAYS[i];
      var h = P.harm[a];
      var pf = CFG.PULSE_PERIOD_TICKS[a] * fpt;
      if (pf % h !== 0) {
        errs.push('R3 array ' + a + ': pulse period ' + pf + ' frames is not divisible by harmonic ' + h +
                  ' (flicker would need ' + (pf / h).toFixed(2) + ' frames/cycle)');
        continue;
      }
      var ff = pf / h;
      if (ff < 2) { errs.push('R3 array ' + a + ': flicker period ' + ff + ' frame(s) cannot carry on/off'); continue; }
      plan[a] = {
        harmonic: h,
        pulseFrames: pf,
        flickerFrames: ff,
        onFrames: Math.floor((ff + 1) / 2),          // ceil(ff/2)
        phaseFrames: CFG.PULSE_PHASE_TICKS[a] * fpt,
        pulseHz: R / pf,
        flickerHz: R / ff,
        winFrames: windowFrames(dutyPct, pf)
      };
    }
    if (errs.length) { return { plan: null, errors: errs }; }

    for (i = 0; i < ARRAYS.length; i++) {
      a = ARRAYS[i];
      var p = plan[a];
      if (Math.abs(p.flickerHz - P.flickerHz[a]) > CFG.FREQ_TOL) {
        errs.push('R4 array ' + a + ': derived flicker ' + p.flickerHz.toFixed(6) + ' Hz != declared ' +
                  P.flickerHz[a].toFixed(6) + ' Hz');
      }
      if (p.pulseFrames !== p.harmonic * p.flickerFrames ||
          Math.abs(p.flickerHz - p.harmonic * p.pulseHz) > CFG.FREQ_TOL) {
        errs.push('R5 array ' + a + ': flicker is not exactly ' + p.harmonic + ' x pulse');
      }
      if (!(p.winFrames >= 1 && p.winFrames <= p.pulseFrames)) {
        errs.push('R9 array ' + a + ': duty cycle ' + dutyPct + '% gives a ' + p.winFrames +
                  '-frame coherent window (must be 1..' + p.pulseFrames + ' frames)');
      }
    }

    if (Math.abs(plan.A.flickerHz - plan.B.flickerHz) < CFG.FREQ_TOL) { errs.push('R6 flicker frequencies of A and B are identical'); }
    if (Math.abs(plan.A.pulseHz - plan.B.pulseHz) < CFG.FREQ_TOL) { errs.push('R6 pulse frequencies of A and B are identical'); }

    var fund = {
      A: [['pulse', plan.A.pulseHz], ['flicker', plan.A.flickerHz]],
      B: [['pulse', plan.B.pulseHz], ['flicker', plan.B.flickerHz]]
    };
    var pairs = [['A', 'B'], ['B', 'A']], x, y, fx, fy, ix, iy;
    for (i = 0; i < pairs.length; i++) {
      x = pairs[i][0]; y = pairs[i][1];
      for (ix = 0; ix < 2; ix++) {
        for (iy = 0; iy < 2; iy++) {
          fx = fund[x][ix]; fy = fund[y][iy];
          for (n = 1; n <= CFG.MAX_CHECK_HARMONIC; n++) {
            if (Math.abs(fx[1] - n * fy[1]) < 1e-6) {
              errs.push('R7 ' + x + ' ' + fx[0] + ' (' + fx[1].toFixed(4) + ' Hz) = ' + n + ' x ' + y + ' ' + fy[0]);
            }
          }
        }
      }
    }

    var keys = ['flickerFrames', 'pulseFrames'];
    for (i = 0; i < ARRAYS.length; i++) {
      for (n = 0; n < keys.length; n++) {
        if (plan.stimFrames % plan[ARRAYS[i]][keys[n]] !== 0) {
          errs.push('R8 epoch ' + plan.stimFrames + ' frames is not a whole number of ' +
                    ARRAYS[i] + ' ' + keys[n] + ' periods');
        }
      }
    }

    /* informational: frequencies on BOTH arrays' harmonic series */
    var shared = [];
    for (ix = 0; ix < 2; ix++) {
      for (iy = 0; iy < 2; iy++) {
        var fa = fund.A[ix], fb = fund.B[iy];
        for (n = 1; n * fa[1] <= CFG.SHARED_HARMONIC_REPORT_MAX_HZ + 1e-9; n++) {
          var m = n * fa[1] / fb[1];
          if (Math.abs(m - Math.round(m)) < 1e-6) {
            shared.push({ hz: Math.round(n * fa[1] * 1e4) / 1e4,
                          label: 'A ' + fa[0] + ' x' + n + ' = B ' + fb[0] + ' x' + Math.round(m) });
          }
        }
      }
    }
    shared.sort(function (p1, p2) { return p1.hz - p2.hz || (p1.label < p2.label ? -1 : 1); });
    plan.sharedHarmonics = shared;

    return { plan: errs.length ? null : plan, errors: errs };
  }

  /* Throws with every violated rule listed. Called before the first trial. */
  function frequencyPlan(planName, refreshHz, dutyPct) {
    var r = planCheck(planName, refreshHz, dutyPct);
    if (r.errors.length) {
      throw new DesignError('FREQUENCY PLAN VIOLATION (' + planName + ' @ ' + refreshHz + ' Hz):\n  ' +
                            r.errors.join('\n  '));
    }
    return r.plan;
  }

  /* Per-frame flicker state and pulse membership. Identical on every trial:
   * phases are fixed relative to stimulus onset (DECISION 6). pulse[f] = k
   * while frame f is in pulse k's coherent window (frames o .. o + winFrames
   * - 1, cut at the end of the epoch), else -1. */
  function stimulusSchedule(plan) {
    var n = plan.stimFrames, out = {}, i, f, k, o;
    for (i = 0; i < ARRAYS.length; i++) {
      var a = ARRAYS[i], p = plan[a];
      var on = new Uint8Array(n), pulse = new Int16Array(n);
      for (f = 0; f < n; f++) {
        var ph = ((f - p.phaseFrames) % p.flickerFrames + p.flickerFrames) % p.flickerFrames;
        on[f] = ph < p.onFrames ? 1 : 0;
        pulse[f] = -1;
      }
      var onsets = [];
      for (k = 0; k < nPulses(a); k++) {
        o = p.phaseFrames + k * p.pulseFrames;
        onsets.push(o);
        for (f = o; f < Math.min(o + p.winFrames, n); f++) { pulse[f] = k; }
      }
      out[a] = { on: on, pulse: pulse, onsetFrames: onsets };
    }
    return out;
  }

  /* ======================================================= scoring */
  /* targets: [{arr, pulse, onset_s}], responses: press times (s) from
   * stimulus onset. A press is attributed to the target whose window
   * [onset + RESP_WIN_MIN_S, onset + RESP_WIN_MAX_S] contains it. Targets are
   * >= 1.0 s apart by construction, so windows are disjoint; 'ambiguous'
   * exists only as a defensive category. Mirrors score_trial. */
  function scoreTrial(targets, attend, responses) {
    function toDetect(arr) { return attend === 'both' || attend === arr; }
    var tg = targets.map(function (t) {
      return { arr: t.arr, pulse: t.pulse, onset_s: t.onset_s, responded: false, rt: NaN };
    });
    var resp = responses.slice().sort(numSort);
    var rOut = [], rIdx = [], rRt = [], i, j;

    for (i = 0; i < resp.length; i++) {
      var cand = [];
      for (j = 0; j < tg.length; j++) {
        var d = resp[i] - tg[j].onset_s;
        if (d >= CFG.RESP_WIN_MIN_S && d <= CFG.RESP_WIN_MAX_S) { cand.push(j); }
      }
      if (cand.length === 0) { rOut.push('fa'); rIdx.push(-1); rRt.push(NaN); }
      else if (cand.length > 1) { rOut.push('ambiguous'); rIdx.push(-1); rRt.push(NaN); }
      else {
        j = cand[0];
        var rt = resp[i] - tg[j].onset_s;
        rIdx.push(j); rRt.push(rt);
        if (tg[j].responded) { rOut.push('extra'); }
        else {
          tg[j].responded = true;
          tg[j].rt = rt;
          rOut.push(toDetect(tg[j].arr) ? 'hit' : 'fa_unattended');
        }
      }
    }

    var tOut = tg.map(function (t) {
      if (toDetect(t.arr)) { return t.responded ? 'hit' : 'miss'; }
      return t.responded ? 'unattended_responded' : 'unattended_ignored';
    });

    var s = { n_hits: 0, n_misses: 0, n_fa: 0, n_fa_unattended: 0, n_extra: 0, n_ambiguous: 0,
              hits_A: 0, misses_A: 0, hits_B: 0, misses_B: 0 };
    var rtSum = 0;
    for (i = 0; i < tOut.length; i++) {
      if (tOut[i] === 'hit') { s.n_hits++; s['hits_' + tg[i].arr]++; rtSum += tg[i].rt; }
      else if (tOut[i] === 'miss') { s.n_misses++; s['misses_' + tg[i].arr]++; }
    }
    for (i = 0; i < rOut.length; i++) {
      if (rOut[i] === 'fa') { s.n_fa++; }
      else if (rOut[i] === 'fa_unattended') { s.n_fa_unattended++; }
      else if (rOut[i] === 'extra') { s.n_extra++; }
      else if (rOut[i] === 'ambiguous') { s.n_ambiguous++; }
    }
    s.mean_rt_s = s.n_hits ? rtSum / s.n_hits : NaN;

    return { targetOutcomes: tOut, targetRts: tg.map(function (t) { return t.rt; }),
             responseOutcomes: rOut, responseTarget: rIdx, responseRts: rRt,
             responseTimes: resp, summary: s };
  }

  root.XMDesign = {
    DesignError: DesignError,
    ARRAYS: ARRAYS,
    nPulses: nPulses,
    pulseOnsetTicks: pulseOnsetTicks,
    eligiblePulses: eligiblePulses,
    defaultDesignParams: defaultDesignParams,
    validateDesignParams: validateDesignParams,
    blockComposition: blockComposition,
    burstCountMultiset: burstCountMultiset,
    generateTrialList: generateTrialList,
    practiceTrials: practiceTrials,
    assertTrialList: assertTrialList,
    CSV_COLUMNS: CSV_COLUMNS,
    toCsv: toCsv,
    windowFrames: windowFrames,
    nCoherent: nCoherent,
    defaultStimParams: defaultStimParams,
    validateStimParams: validateStimParams,
    planCheck: planCheck,
    frequencyPlan: frequencyPlan,
    stimulusSchedule: stimulusSchedule,
    scoreTrial: scoreTrial
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = root.XMDesign; }

})(typeof window !== 'undefined' ? window : globalThis);
