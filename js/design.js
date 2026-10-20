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

  /* ======================================================= trial generation */
  function maxRun(codes) {
    if (codes.length === 0) { return 0; }
    var best = 1, run = 1;
    for (var i = 1; i < codes.length; i++) {
      run = (codes[i] === codes[i - 1]) ? run + 1 : 1;
      if (run > best) { best = run; }
    }
    return best;
  }

  function numSort(a, b) { return a - b; }

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

  function generateTrialList(seed) {
    var rng = new Minstd(seed);
    var wsum = 0, c, i, j, v, b;
    for (i = 0; i < CFG.TGT_COUNT_WEIGHTS.length; i++) { wsum += CFG.TGT_COUNT_WEIGHTS[i]; }

    /* ---- 1. per cell: balanced target counts + direction pairs ---- */
    var perCell = [];
    for (c = 0; c < CFG.CELLS.length; c++) {
      var cell = CFG.CELLS[c], n = cell.n, base = [];
      for (v = 0; v < CFG.TGT_COUNT_VALUES.length; v++) {
        var cnt = Math.floor(n * CFG.TGT_COUNT_WEIGHTS[v] / wsum);
        for (j = 0; j < cnt; j++) { base.push(CFG.TGT_COUNT_VALUES[v]); }
      }
      var permA = rng.shuffleIndices(n);
      var permB = rng.shuffleIndices(n);
      var cellTrials = [];
      for (i = 0; i < n; i++) {
        var dA = 1 + rng.randInt(4);
        var others = [];
        for (j = 1; j <= 4; j++) { if (j !== dA) { others.push(j); } }
        var dB = others[rng.randInt(3)];          // dir_B != dir_A by construction
        cellTrials.push({
          cell: cell.code, cond: cell.name, attend: cell.attend, sound_match: cell.sound,
          dir_A: dA, dir_B: dB,
          n_tgt_A: base[permA[i]], n_tgt_B: base[permB[i]]
        });
      }
      perCell.push(cellTrials);
    }

    /* ---- 2. deal each cell into blocks in consecutive chunks ---- */
    var blocks = [];
    for (b = 0; b < CFG.N_BLOCKS; b++) { blocks.push([]); }
    for (c = 0; c < CFG.CELLS.length; c++) {
      var per = Math.floor(CFG.CELLS[c].n / CFG.N_BLOCKS);
      for (i = 0; i < perCell[c].length; i++) {
        blocks[Math.floor(i / per)].push(perCell[c][i]);
      }
    }

    /* ---- 3. shuffle within block, no more than MAX_RUN_SAME_CELL in a row ---- */
    var ordered = [], shuffleAttempts = [];
    for (b = 0; b < CFG.N_BLOCKS; b++) {
      var bt = blocks[b], seq = null, attempt, perm, codes;
      for (attempt = 1; attempt <= CFG.MAX_SHUFFLE_ATTEMPTS; attempt++) {
        perm = rng.shuffleIndices(bt.length);
        seq = [];
        codes = [];
        for (i = 0; i < perm.length; i++) { seq.push(bt[perm[i]]); codes.push(bt[perm[i]].cell); }
        if (maxRun(codes) <= CFG.MAX_RUN_SAME_CELL) { break; }
        seq = null;
      }
      if (seq === null) {
        throw new DesignError('block ' + (b + 1) + ': no valid order in ' +
                              CFG.MAX_SHUFFLE_ATTEMPTS + ' attempts');
      }
      shuffleAttempts.push(attempt);
      for (j = 0; j < seq.length; j++) {
        var t = shallowCopy(seq[j]);
        t.block = b + 1;
        t.trial_in_block = j + 1;
        ordered.push(t);
      }
    }

    /* ---- 4. per trial, in final order: targets, ITI, dot seed ---- */
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
      tr.place_attempts = res.attempts;
      tr.iti_ticks = CFG.ITI_MIN_TICKS + rng.randInt(CFG.ITI_JITTER_TICKS + 1);
      tr.dot_seed = CFG.DOT_SEED_BASE + tr.trial * CFG.DOT_SEED_STRIDE;
    }

    return { trials: ordered, shuffleAttempts: shuffleAttempts };
  }

  function shallowCopy(o) {
    var r = {};
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { r[k] = o[k]; } }
    return r;
  }

  /* ======================================================= assertions */
  /* Throws DesignError on ANY violation. Mirrors assert_trial_list. */
  function assertTrialList(trials) {
    function fail(msg) { throw new DesignError(msg); }
    var c, i, j, b, a, v, k;

    if (!(CFG.TGT_MIN_GAP_TICKS / CFG.GRID_HZ > CFG.RESP_WIN_MAX_S - CFG.RESP_WIN_MIN_S)) {
      fail('min target gap does not keep response windows disjoint');
    }
    if (CFG.TGT_MAX_ONSET_TICKS + CFG.RESP_WIN_MAX_S * CFG.GRID_HZ > CFG.STIM_TICKS + 1e-9) {
      fail('last eligible target response window extends past stimulus end');
    }
    if (trials.length !== CFG.nTrials()) {
      fail('expected ' + CFG.nTrials() + ' trials, got ' + trials.length);
    }

    var wsum = 0;
    for (i = 0; i < CFG.TGT_COUNT_WEIGHTS.length; i++) { wsum += CFG.TGT_COUNT_WEIGHTS[i]; }

    for (c = 0; c < CFG.CELLS.length; c++) {
      var cell = CFG.CELLS[c];
      var ct = trials.filter(function (t) { return t.cell === cell.code; });
      if (ct.length !== cell.n) { fail('cell ' + cell.code + ': ' + ct.length + ' trials, expected ' + cell.n); }
      for (i = 0; i < ct.length; i++) {
        if (ct[i].attend !== cell.attend || ct[i].sound_match !== cell.sound || ct[i].cond !== cell.name) {
          fail('trial ' + ct[i].trial + ': condition fields inconsistent with cell ' + cell.code);
        }
      }
      for (a = 0; a < ARRAYS.length; a++) {
        for (v = 0; v < CFG.TGT_COUNT_VALUES.length; v++) {
          var want = Math.floor(cell.n * CFG.TGT_COUNT_WEIGHTS[v] / wsum), got = 0;
          for (i = 0; i < ct.length; i++) {
            if (ct[i]['n_tgt_' + ARRAYS[a]] === CFG.TGT_COUNT_VALUES[v]) { got++; }
          }
          if (got !== want) {
            fail('cell ' + cell.code + ' array ' + ARRAYS[a] + ': ' + got + ' trials with ' +
                 CFG.TGT_COUNT_VALUES[v] + ' targets, expected ' + want);
          }
        }
      }
      for (b = 1; b <= CFG.N_BLOCKS; b++) {
        var nb = 0;
        for (i = 0; i < ct.length; i++) { if (ct[i].block === b) { nb++; } }
        if (nb !== cell.n / CFG.N_BLOCKS) {
          fail('cell ' + cell.code + ' block ' + b + ': ' + nb + ' trials, expected ' + (cell.n / CFG.N_BLOCKS));
        }
      }
    }

    for (b = 1; b <= CFG.N_BLOCKS; b++) {
      var codes = [];
      for (i = 0; i < trials.length; i++) { if (trials[i].block === b) { codes.push(trials[i].cell); } }
      if (maxRun(codes) > CFG.MAX_RUN_SAME_CELL) {
        fail('block ' + b + ': run of more than ' + CFG.MAX_RUN_SAME_CELL + ' identical cells');
      }
    }

    var elig = { A: eligiblePulses('A'), B: eligiblePulses('B') };
    for (i = 0; i < trials.length; i++) {
      var t = trials[i];
      if (!(t.dir_A >= 1 && t.dir_A <= 4 && t.dir_B >= 1 && t.dir_B <= 4)) {
        fail('trial ' + t.trial + ': direction out of range');
      }
      if (t.dir_A === t.dir_B) { fail('trial ' + t.trial + ': dir_A == dir_B'); }
      var onsets = [];
      for (a = 0; a < ARRAYS.length; a++) {
        var ks = t['tgt_' + ARRAYS[a] + '_pulses'];
        if (ks.length !== t['n_tgt_' + ARRAYS[a]]) {
          fail('trial ' + t.trial + ': ' + ks.length + ' ' + ARRAYS[a] + ' targets placed, ' +
               t['n_tgt_' + ARRAYS[a]] + ' required');
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
    'trial', 'block', 'trial_in_block', 'cell', 'cond', 'attend', 'sound_match',
    'dir_A', 'dir_B', 'n_tgt_A', 'n_tgt_B',
    'tgt_A_pulses', 'tgt_B_pulses', 'tgt_A_onset_ticks', 'tgt_B_onset_ticks',
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

  /* ======================================================= coherence (DECISION 28) */
  /* floor(x + 0.5) in all three ports (Python's round() is banker's rounding). */
  function roundHalfUp(x) { return Math.floor(x + 0.5); }

  /* Coherent frames per pulse: duty % of the pulse period, nearest frame. */
  function windowFrames(dutyPct, pulseFrames) { return roundHalfUp(dutyPct * pulseFrames / 100); }

  /* Dots in a pulse's coherent subset. */
  function nCoherent(pct, nDots) { return roundHalfUp(pct * nDots / 100); }

  function defaultStimParams() {
    return { cohBgPct: CFG.COH_BG_PCT_DEFAULT, cohTgtPct: CFG.COH_TGT_PCT_DEFAULT, dutyPct: CFG.DUTY_PCT_DEFAULT,
             speedDegS: CFG.DOT_SPEED_DEG_S_DEFAULT, burstSpeedDegS: CFG.BURST_SPEED_DEG_S_DEFAULT,
             previewSound: CFG.PREVIEW_SOUND_DEFAULT };
  }

  /* Setup-screen check of the five session-adjustable stimulus values
   * (DECISIONS 28-29). Returns a list of errors; [] = valid. Whether the duty
   * cycle gives >= 1 frame is checked later by planCheck R9, once the refresh
   * rate is known. Mirrors validate_stim_params and +cmcore/validateStimParams.m. */
  function validateStimParams(p) {
    var errs = [];
    var vals = [['background coherence', p.cohBgPct], ['target coherence', p.cohTgtPct], ['duty cycle', p.dutyPct],
                ['normal speed', p.speedDegS], ['burst speed', p.burstSpeedDegS]];
    vals.forEach(function (v) {
      if (typeof v[1] !== 'number' || !isFinite(v[1])) { errs.push('V1 ' + v[0] + ' must be a number'); }
    });
    if (errs.length) { return errs; }
    vals.slice(0, 2).forEach(function (v) {
      if (!(v[1] >= 0 && v[1] <= 100)) { errs.push('V2 ' + v[0] + ' ' + v[1] + '% is outside 0-100%'); }
    });
    if (!(p.dutyPct > 0 && p.dutyPct <= 100)) {
      errs.push('V3 duty cycle ' + p.dutyPct + '% must be above 0 and at most 100%');
    }
    if (!(p.cohTgtPct > p.cohBgPct)) {
      errs.push('V4 target coherence (' + p.cohTgtPct + '%) must be higher than background coherence (' +
                p.cohBgPct + '%), or targets cannot be told apart');
    }
    vals.slice(3).forEach(function (v) {
      if (!(v[1] > 0 && v[1] <= CFG.SPEED_MAX_DEG_S)) {
        errs.push('V5 ' + v[0] + ' ' + v[1] + ' deg/s must be above 0 and at most ' + CFG.SPEED_MAX_DEG_S + ' deg/s');
      }
    });
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

  /* Sound preview (DECISION 30): the pip train starts at cue onset and runs
   * across cue + gap, which must hold whole pulse periods of both arrays so
   * the rhythm continues seamlessly into the stimulus. Returns errors; [] = ok.
   * Mirrors preview_check and +cmcore/previewCheck.m. */
  function previewCheck() {
    var span = CFG.CUE_TICKS + CFG.GAP_TICKS, errs = [];
    ARRAYS.forEach(function (a) {
      if (span % CFG.PULSE_PERIOD_TICKS[a] !== 0) {
        errs.push('P1 cue + gap (' + span + ' ticks) is not a whole number of array ' + a +
                  ' pulse periods (' + CFG.PULSE_PERIOD_TICKS[a] + ' ticks)');
      }
    });
    return errs;
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
    maxRun: maxRun,
    generateTrialList: generateTrialList,
    assertTrialList: assertTrialList,
    CSV_COLUMNS: CSV_COLUMNS,
    toCsv: toCsv,
    windowFrames: windowFrames,
    nCoherent: nCoherent,
    defaultStimParams: defaultStimParams,
    validateStimParams: validateStimParams,
    planCheck: planCheck,
    frequencyPlan: frequencyPlan,
    previewCheck: previewCheck,
    stimulusSchedule: stimulusSchedule,
    scoreTrial: scoreTrial
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = root.XMDesign; }

})(typeof window !== 'undefined' ? window : globalThis);
