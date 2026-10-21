/* ===========================================================================
 * main.js -- session state machine for the web implementation.
 *
 *   setup form -> trial list generated + audited -> fullscreen
 *   -> refresh measurement -> FREQUENCY PLAN CHECK (refuses to run on failure)
 *   -> photosensitivity notice -> instructions -> practice (with feedback)
 *   -> 20 blocks x 20 trials (attend-one and attend-both blocks in random
 *      order), self-paced breaks with feedback -> data download
 *
 * One trial:  ITI fixation (0.7-1.2 s) -> cue ring (0.8 s) -> fixation (0.5 s)
 *             -> 4.5 s red/blue dot stimulus, SPACE presses recorded throughout;
 *             sound (if any) only during the stimulus
 *
 * Mirrored by matlab/runCrossmodalSSVEP.m and +cmcore/runTrial.m.
 * =========================================================================== */
(function (root) {
  'use strict';

  var CFG = root.XMConfig;
  var D = root.XMDesign;
  var S = root.XMStim;
  var Data = root.XMData;

  var stage, ctx, overlay, W, H, CX, CY, DPR;
  var geom = null, ifi = null, refresh = null, plan = null, sched = null;
  var stimParams = null;              // stimulus settings from the setup form (Design.defaultStimParams)
  var audioCtx = null;
  var rec = null, meta = null;
  var colorOf = null, colorName = null, dimColorOf = null;
  var aborted = false;

  /* ------------------------------------------------------------------ canvas */
  function setupCanvas() {
    stage = document.getElementById('stage');
    overlay = document.getElementById('overlay');
    ctx = stage.getContext('2d', { alpha: false });
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    DPR = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    stage.width = Math.round(W * DPR);
    stage.height = Math.round(H * DPR);
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    CX = W / 2;
    CY = H / 2;
  }

  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  function clearStage() {
    ctx.fillStyle = rgb(CFG.BG_COLOR);
    ctx.fillRect(0, 0, W, H);
  }

  function disc(r, col) {
    ctx.fillStyle = rgb(col);
    ctx.beginPath();
    ctx.arc(CX, CY, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  /* Bullseye fixation (Thaler et al. 2013 style), the same construct as the
   * parent repo's optimalFixation.m. Mirrors +cmcomp/drawFixation.m. */
  function drawFixation() {
    var outer = geom.fixOuterPx, inner = geom.fixInnerPx;
    disc(outer / 2, CFG.FIX_COLOR);
    ctx.fillStyle = rgb(CFG.BG_COLOR);
    ctx.fillRect(CX - outer / 2, CY - inner / 2, outer, inner);
    ctx.fillRect(CX - inner / 2, CY - outer / 2, inner, outer);
    disc(inner / 2, CFG.FIX_COLOR);
  }

  /* Cue ring around fixation. attend-one: a full ring in the attended
   * array's colour. attend-both: CUE_N_SEGMENTS wedges alternating A/B
   * colour, segment 0 starting at 12 o'clock, clockwise (PTB FillArc's
   * convention). Mirrors +cmcomp/drawCue.m. */
  function drawCue(attend) {
    var ro = geom.cueOuterRadiusPx, ri = geom.cueInnerRadiusPx;
    if (attend === 'both') {
      var n = CFG.CUE_N_SEGMENTS, step = 2 * Math.PI / n;
      for (var i = 0; i < n; i++) {
        var a0 = -Math.PI / 2 + i * step;
        ctx.fillStyle = rgb(i % 2 === 0 ? colorOf.A : colorOf.B);
        ctx.beginPath();
        ctx.moveTo(CX, CY);
        ctx.arc(CX, CY, ro, a0, a0 + step);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      disc(ro, colorOf[attend]);
    }
    disc(ri, CFG.BG_COLOR);
    drawFixation();
  }

  /* All visible dots of frame f, in the trial's fixed random draw order.
   * dimA / dimB: draw that array in its luminance-dip colour (luminance-dip
   * layer on, during a target pulse's coherent window; DECISION 38). */
  function drawDots(dots, f, onA, onB, dimA, dimB) {
    var N = dots.nPerArray, base = f * dots.nTot, r = geom.dotDiamPx / 2;
    var clear2 = geom.clearRadiusPx * geom.clearRadiusPx;
    var colA = rgb(dimA ? dimColorOf.A : colorOf.A), colB = rgb(dimB ? dimColorOf.B : colorOf.B);
    for (var j = 0; j < dots.nTot; j++) {
      var idx = dots.drawOrder[j], isA = idx < N;
      if (isA ? !onA : !onB) { continue; }
      var px = dots.x[base + idx], py = dots.y[base + idx];
      if (px * px + py * py < clear2) { continue; }
      ctx.fillStyle = isA ? colA : colB;
      ctx.beginPath();
      ctx.arc(CX + px, CY + py, r, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  /* ------------------------------------------------------------------ input */
  /* e.timeStamp is a DOMHighResTimeStamp on the same clock as the rAF
   * timestamps, so RTs need no clock conversion. */
  var listeners = [];
  window.addEventListener('keydown', function (e) {
    if (e.code === CFG.KEY_QUIT) { aborted = true; }
    if (e.code === 'Space') { e.preventDefault(); }
    var t = e.timeStamp / 1000;
    for (var i = listeners.length - 1; i >= 0; i--) { listeners[i](e.code, t, e.repeat); }
  });

  function onKey(fn) {
    listeners.push(fn);
    return function () {
      var k = listeners.indexOf(fn);
      if (k >= 0) { listeners.splice(k, 1); }
    };
  }

  function waitKey(codes) {
    return new Promise(function (resolve) {
      var off = onKey(function (code, t, rep) {
        if (rep) { return; }
        if (code === CFG.KEY_QUIT || !codes || codes.indexOf(code) >= 0) {
          off();
          resolve({ code: code, time: t });
        }
      });
    });
  }

  /* ------------------------------------------------------------------ text */
  function showText(html, hint) {
    overlay.innerHTML = '<div class="sheet">' + html +
      (hint ? '<p class="hint">' + hint + '</p>' : '') + '</div>';
    overlay.style.display = 'flex';
  }

  function hideText() { overlay.style.display = 'none'; overlay.innerHTML = ''; }

  async function textScreen(html, hint, keys) {
    clearStage();
    showText(html, hint === undefined ? 'Press SPACE to continue' : hint);
    var k = await waitKey(keys || [CFG.KEY_CONTINUE]);
    hideText();
    return k;
  }

  /* ------------------------------------------------------------- frame loop */
  /* Advances exactly one frame index per animation frame -- the analogue of
   * one Screen('Flip') per iteration in MATLAB. drawFn(f, t) draws frame f;
   * t is that callback's rAF timestamp (s). Intervals > 1.5 ifi count as
   * dropped frames. */
  function runFrames(nFrames, drawFn) {
    return new Promise(function (resolve) {
      var times = new Float64Array(nFrames).fill(NaN);
      var f = 0, dropped = 0, prev = null, maxInt = 0;
      function tick(ts) {
        if (aborted) { resolve({ times: times, n: f, dropped: dropped, maxInt: maxInt, aborted: true }); return; }
        var t = ts / 1000;
        if (prev !== null) {
          if (t - prev > 1.5 * ifi) { dropped++; }
          if (t - prev > maxInt) { maxInt = t - prev; }
        }
        prev = t;
        clearStage();
        drawFn(f, t);
        times[f] = t;
        f++;
        if (f < nFrames) { requestAnimationFrame(tick); }
        else { resolve({ times: times, n: f, dropped: dropped, maxInt: maxInt, aborted: false }); }
      }
      requestAnimationFrame(tick);
    });
  }

  function measureRefresh() {
    return new Promise(function (resolve) {
      var ts = [], t0 = null;
      function tick(t) {
        if (t0 === null) { t0 = t; }
        ts.push(t);
        if (t - t0 < CFG.REFRESH_MEASURE_MS) { requestAnimationFrame(tick); return; }
        var d = [];
        for (var i = 1; i < ts.length; i++) { d.push(ts[i] - ts[i - 1]); }
        d.sort(function (a, b) { return a - b; });
        var hz = 1000 / d[Math.floor(d.length / 2)];
        resolve({ measured: hz, nominal: Math.round(hz), nSamples: ts.length });
      }
      requestAnimationFrame(tick);
    });
  }

  /* --------------------------------------------------------- audio timing */
  /* Context time at which audio is HEARD at performance time tPerfS.
   * getOutputTimestamp() already accounts for output latency. */
  function ctxTimeForPerf(tPerfS) {
    if (audioCtx.getOutputTimestamp) {
      var o = audioCtx.getOutputTimestamp();
      if (o && o.performanceTime > 0) {
        return o.contextTime + (tPerfS * 1000 - o.performanceTime) / 1000;
      }
    }
    var lat = audioCtx.outputLatency || audioCtx.baseLatency || 0;
    return audioCtx.currentTime + (tPerfS - performance.now() / 1000) - lat;
  }

  /* ------------------------------------------------------------------ trial */
  async function runTrial(trial, practice) {
    var fpt = plan.framesPerTick, nF = plan.stimFrames;
    var lag = CFG.WEB_DISPLAY_LAG_FRAMES * ifi;

    /* everything heavy happens before the ITI starts */
    var dots = S.precomputeDots(trial, plan, sched, geom, stimParams);
    var pips = S.pipSchedule(trial, sched, ifi);
    var buffer = pips.length ? S.makePipBuffer(audioCtx, pips, nF * ifi + 0.5) : null;
    var nIti = trial.iti_ticks * fpt, nCue = CFG.CUE_TICKS * fpt, nGap = CFG.GAP_TICKS * fpt;

    /* per-frame target flags: frames inside a target pulse's coherent window */
    var tA = new Uint8Array(nF), tB = new Uint8Array(nF), f;
    for (f = 0; f < nF; f++) {
      tA[f] = (sched.A.pulse[f] >= 0 && trial.tgt_A_pulses.indexOf(sched.A.pulse[f]) >= 0) ? 1 : 0;
      tB[f] = (sched.B.pulse[f] >= 0 && trial.tgt_B_pulses.indexOf(sched.B.pulse[f]) >= 0) ? 1 : 0;
    }
    var lum = stimParams.lumDipPct > 0;          // luminance-dip layer (DECISION 38)

    var row = {}, events = [];
    var src = null, plannedOnset = NaN, audioStartCtx = NaN;
    var stopAll = function () { if (src) { src.stop(); } };

    await runFrames(nIti, function () { drawFixation(); });
    if (aborted) { return null; }

    var cueRes = await runFrames(nCue, function () { drawCue(trial.attend); });
    if (aborted) { return null; }

    /* the pip train is scheduled on the FIRST gap frame, for the moment the
     * first stimulus frame is expected on screen -- 0.5 s of lead time */
    await runFrames(nGap, function (fr, t) {
      drawFixation();
      if (fr === 0 && buffer) {
        plannedOnset = t + nGap * ifi + lag;
        audioStartCtx = ctxTimeForPerf(plannedOnset);
        src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(audioCtx.destination);
        src.start(Math.max(audioStartCtx, audioCtx.currentTime));
      }
    });
    if (aborted) { stopAll(); return null; }

    var presses = [];
    var off = onKey(function (code, t, rep) {
      if (code === CFG.KEY_RESPOND && !rep) { presses.push(t); }
    });
    var res = await runFrames(nF, function (fr) {
      drawDots(dots, fr, sched.A.on[fr], sched.B.on[fr], lum && tA[fr], lum && tB[fr]);
      drawFixation();
    });
    off();
    clearStage();
    drawFixation();

    /* ---- timing: everything relative to estimated photon onset of frame 0 ---- */
    var tOn = res.times[0] + lag;
    var rel = function (f) { return (f < res.n) ? res.times[f] - res.times[0] : NaN; };
    var pressRel = presses.map(function (p) { return p - tOn; });
    var avOffset = buffer ? plannedOnset - tOn : NaN;

    /* ---- scoring ---- */
    var targets = [];
    D.ARRAYS.forEach(function (a) {
      trial['tgt_' + a + '_pulses'].forEach(function (k) {
        targets.push({ arr: a, pulse: k, onset_s: rel(sched[a].onsetFrames[k]) });
      });
    });
    var sc = D.scoreTrial(targets, trial.attend, pressRel);

    /* ---- events: pulses, pips, responses ---- */
    var base = { pid: meta.pid, practice: practice ? 1 : 0, trial: trial.trial };
    D.ARRAYS.forEach(function (a) {
      var halfWin = plan[a].winFrames / 2;     // t_peak_s = centre of the coherent window
      sched[a].onsetFrames.forEach(function (fr, k) {
        var ti = -1;
        for (var q = 0; q < targets.length; q++) { if (targets[q].arr === a && targets[q].pulse === k) { ti = q; } }
        events.push(Object.assign({}, base, {
          event: 'pulse', array: a, index: k, is_target: ti >= 0 ? 1 : 0, target_pulse: '',
          frame: fr, t_sched_s: fr / plan.refreshHz, t_actual_s: rel(fr),
          t_peak_s: rel(fr) + halfWin * ifi, rt_s: ti >= 0 ? sc.targetRts[ti] : '',
          outcome: ti >= 0 ? sc.targetOutcomes[ti] : ''
        }));
      });
    });
    pips.forEach(function (p) {
      events.push(Object.assign({}, base, {
        event: 'pip', array: trial.sound_match, index: p.pulse, is_target: '', target_pulse: '',
        frame: p.frame, t_sched_s: p.t_s, t_actual_s: p.t_s + avOffset, t_peak_s: '', rt_s: '', outcome: ''
      }));
    });
    sc.responseTimes.forEach(function (t, i) {
      var ti = sc.responseTarget[i];
      events.push(Object.assign({}, base, {
        event: 'response', array: ti >= 0 ? targets[ti].arr : '', index: i + 1, is_target: '',
        target_pulse: ti >= 0 ? targets[ti].pulse : '', frame: '', t_sched_s: '',
        t_actual_s: t, t_peak_s: '', rt_s: sc.responseRts[i], outcome: sc.responseOutcomes[i]
      }));
    });

    /* ---- per-frame log ---- */
    var tFlip = new Float64Array(nF);
    for (f = 0; f < nF; f++) { tFlip[f] = rel(f); }
    var frames = { pid: meta.pid, practice: practice ? 1 : 0, trial: trial.trial, t: tFlip,
                   onA: sched.A.on, onB: sched.B.on, pA: sched.A.pulse, pB: sched.B.pulse, tA: tA, tB: tB };

    /* ---- trial row ---- */
    var s = sc.summary;
    row = Object.assign({}, meta.rowBase, {
      practice: practice ? 1 : 0,
      trial: trial.trial, block: trial.block, block_type: trial.block_type, trial_in_block: trial.trial_in_block,
      cell: trial.cell, cond: trial.cond, attend: trial.attend,
      cue: trial.attend === 'both' ? colorName.A + '+' + colorName.B : colorName[trial.attend],
      sound_match: trial.sound_match,
      dir_A: trial.dir_A, dir_B: trial.dir_B,
      dir_A_name: CFG.DIR_NAMES[trial.dir_A], dir_B_name: CFG.DIR_NAMES[trial.dir_B],
      n_tgt: trial.n_tgt_A + trial.n_tgt_B, n_tgt_A: trial.n_tgt_A, n_tgt_B: trial.n_tgt_B,
      tgt_A_pulses: trial.tgt_A_pulses, tgt_B_pulses: trial.tgt_B_pulses,
      tgt_A_tilt_sign: trial.tgt_A_tilt_sign, tgt_B_tilt_sign: trial.tgt_B_tilt_sign,
      tgt_A_onset_s: targets.filter(function (t) { return t.arr === 'A'; }).map(function (t) { return t.onset_s; }),
      tgt_B_onset_s: targets.filter(function (t) { return t.arr === 'B'; }).map(function (t) { return t.onset_s; }),
      n_responses: pressRel.length,
      n_hits: s.n_hits, n_misses: s.n_misses, n_fa: s.n_fa, n_fa_unattended: s.n_fa_unattended,
      n_extra: s.n_extra, n_ambiguous: s.n_ambiguous,
      hits_A: s.hits_A, misses_A: s.misses_A, hits_B: s.hits_B, misses_B: s.misses_B,
      mean_rt_s: s.mean_rt_s,
      flicker_hz_A: refresh.measured / plan.A.flickerFrames, flicker_hz_B: refresh.measured / plan.B.flickerFrames,
      pulse_hz_A: refresh.measured / plan.A.pulseFrames, pulse_hz_B: refresh.measured / plan.B.pulseFrames,
      n_frames: res.n, n_dropped: res.dropped, max_frame_interval_ms: res.maxInt * 1000,
      t_cue_onset: cueRes.times[0], t_stim_onset: tOn,
      t_stim_offset: res.times[res.n - 1] + ifi + lag,
      n_pips: pips.length,
      audio_start_sched: audioStartCtx, av_offset_est_s: avOffset,
      iti_s: trial.iti_ticks / CFG.GRID_HZ, place_attempts: trial.place_attempts,
      dot_seed: trial.dot_seed, aborted: res.aborted ? 1 : 0
    });

    rec.addTrial(row, events, frames);
    return { row: row, summary: s };
  }

  /* -------------------------------------------------------- instruction copy */
  function colourWord(name) {
    return '<span style="color:' + rgb(CFG.COLORS[name]) + ';font-weight:600">' + name.toUpperCase() + '</span>';
  }

  /* What a target looks like: one phrase per active deviant layer
   * (DECISION 38). One layer keeps its own word ('strong sweep',
   * 'dimming', ...); several are called a 'change'. Mirrors
   * runCrossmodalSSVEP.m::targetWords. */
  function targetWords(sp) {
    var N = CFG.N_DOTS_PER_ARRAY, nBg = D.nCoherent(sp.cohBgPct, N), nTgt = D.nCoherent(sp.cohTgtPct, N);
    var parts = [];
    if (nTgt > nBg) {
      parts.push({ one: 'strong sweep', many: 'strong sweeps', what: 'make a <strong>stronger, clearer sweep</strong>' });
    }
    if (nTgt > 0 && sp.burstSpeedDegS !== sp.speedDegS) {
      var fast = sp.burstSpeedDegS > sp.speedDegS;
      parts.push({ one: fast ? 'fast sweep' : 'slow sweep', many: fast ? 'fast sweeps' : 'slow sweeps',
                   what: 'sweep <strong>' + (fast ? 'faster' : 'slower') + '</strong>' });
    }
    if (nTgt > 0 && sp.tiltDeg > 0) {
      parts.push({ one: 'tilted sweep', many: 'tilted sweeps',
                   what: 'sweep in a <strong>slightly different (tilted) direction</strong>' });
    }
    if (sp.lumDipPct > 0) {
      parts.push({ one: 'dimming', many: 'dimmings', what: 'become <strong>dimmer</strong>' });
    }
    var whats = parts.map(function (p) { return p.what; });
    var what = whats.length > 1 ? whats.slice(0, -1).join(', ') + ' and ' + whats[whats.length - 1] : whats[0];
    return { one: parts.length === 1 ? parts[0].one : 'change', many: parts.length === 1 ? parts[0].many : 'changes',
             what: 'the dots of one colour ' + what };
  }

  /* The deviant-event layers, for the display check. */
  function deviantText(sp) {
    var N = CFG.N_DOTS_PER_ARRAY, out = [];
    out.push('coherence ' + sp.cohTgtPct + '% (' + D.nCoherent(sp.cohTgtPct, N) + ' dots' +
             (D.nCoherent(sp.cohTgtPct, N) > D.nCoherent(sp.cohBgPct, N) ? ')' : ', = background: off)'));
    out.push('speed ' + sp.burstSpeedDegS + ' &deg;/s' + (sp.burstSpeedDegS !== sp.speedDegS ? '' : ' (= normal: off)'));
    out.push('luminance dip ' + (sp.lumDipPct > 0 ? sp.lumDipPct + '% (' + colorName.A + ' ' + dimColorOf.A.join(' ') +
             ', ' + colorName.B + ' ' + dimColorOf.B.join(' ') + ')' : 'off'));
    out.push('tilt ' + (sp.tiltDeg > 0 ? '&plusmn;' + sp.tiltDeg + '&deg; (random sign per event)' : 'off'));
    return out.join('<br>');
  }

  function instructionsHtml() {
    var w = targetWords(stimParams);
    return '<h2>Instructions</h2>' +
      '<p>You will see a cloud of small flickering dots &mdash; some ' + colourWord('red') +
      ', some ' + colourWord('blue') + ' &mdash; mixed together around a central dot. ' +
      '<strong>Keep your eyes on the central dot</strong> the whole time.</p>' +
      '<p>The dots of each colour drift in one direction among random jiggling. Every so ' +
      'often, ' + w.what + ' for a moment.</p>' +
      '<p>Press <kbd>SPACE</kbd> as quickly as you can whenever you see a ' + w.one + ' ' +
      '<strong>in the colour you are told to watch</strong>.</p>' +
      '<p>Before each trial a ring appears around the central dot:<br>' +
      'a ' + colourWord('red') + ' ring &rarr; watch red only, ignore blue<br>' +
      'a ' + colourWord('blue') + ' ring &rarr; watch blue only, ignore red<br>' +
      'a <strong>red-and-blue</strong> ring &rarr; watch both colours</p>' +
      '<p>On some trials you will also hear soft clicks. Just keep doing the same task.</p>';
  }

  function feedbackLine(sums) {
    var h = 0, n = 0, fa = 0;
    sums.forEach(function (s) { h += s.n_hits; n += s.n_hits + s.n_misses; fa += s.n_fa + s.n_fa_unattended; });
    var pct = n ? Math.round(100 * h / n) : 0, w = targetWords(stimParams);
    return '<p>You caught <strong>' + h + ' of ' + n + '</strong> ' + w.many + ' in the cued colour' +
           ' (' + pct + '%).<br>Presses with no ' + w.one + ' in the cued colour: <strong>' + fa + '</strong>.</p>';
  }

  /* Every setup-screen value as used (entered, or left at its default), plus
   * the fixed timing and design constants, as field / value / default /
   * source rows (DECISION 39). source: 'form' = on the setup screen,
   * 'derived' = computed from form values, 'fixed' = config constant.
   * Same fields, order and defaults as runCrossmodalSSVEP.m::setupRows. */
  function setupRows(form) {
    var st = form.stim, dp = form.design, T = CFG.GRID_HZ, rows = [], v;
    function add(field, value, def, source) { rows.push({ field: field, value: value, 'default': def, source: source }); }
    add('participant', form.participant, '', 'form');
    add('pid', form.pid, '', 'derived');
    add('color_map', form.colorMap, ((form.participant % 2) + 2) % 2, 'form');
    add('freq_plan', form.plan, CFG.FREQ_PLAN_DEFAULT, 'form');
    add('seed', form.seed, CFG.SEED_BASE + form.participant, 'form');
    add('practice_seed', form.seed + CFG.PRACTICE_SEED_OFFSET,
        CFG.SEED_BASE + form.participant + CFG.PRACTICE_SEED_OFFSET, 'derived');
    add('view_dist_cm', form.distCm, CFG.VIEW_DIST_CM_DEFAULT, 'form');
    add('screen_width_cm', form.widthCm, CFG.SCREEN_WIDTH_CM_DEFAULT, 'form');
    add('coh_bg_pct', st.cohBgPct, CFG.COH_BG_PCT_DEFAULT, 'form');
    add('coh_tgt_pct', st.cohTgtPct, CFG.COH_TGT_PCT_DEFAULT, 'form');
    add('duty_pct', st.dutyPct, CFG.DUTY_PCT_DEFAULT, 'form');
    add('speed_deg_s', st.speedDegS, CFG.DOT_SPEED_DEG_S_DEFAULT, 'form');
    add('burst_speed_deg_s', st.burstSpeedDegS, CFG.BURST_SPEED_DEG_S_DEFAULT, 'form');
    add('lum_dip_pct', st.lumDipPct, CFG.LUM_DIP_PCT_DEFAULT, 'form');
    add('tilt_deg', st.tiltDeg, CFG.TILT_DEG_DEFAULT, 'form');
    add('reset_motion', st.resetMotion ? 1 : 0, CFG.RESET_MOTION_DEFAULT ? 1 : 0, 'form');
    for (v = 0; v <= CFG.MAX_BURSTS; v++) { add('burst_pct_' + v, dp.burstPct[v], CFG.BURST_PCT_DEFAULT[v], 'form'); }
    add('n_one_blocks', dp.nOneBlocks, CFG.N_ONE_BLOCKS_DEFAULT, 'form');
    add('n_both_blocks', CFG.N_BLOCKS - dp.nOneBlocks, CFG.N_BLOCKS - CFG.N_ONE_BLOCKS_DEFAULT, 'derived');
    add('sound_on_pct', dp.soundOnPct, CFG.SOUND_ON_PCT_DEFAULT, 'form');
    add('n_blocks', CFG.N_BLOCKS, CFG.N_BLOCKS, 'fixed');
    add('block_trials', CFG.BLOCK_TRIALS, CFG.BLOCK_TRIALS, 'fixed');
    add('practice_n', CFG.PRACTICE_N, CFG.PRACTICE_N, 'fixed');
    add('iti_min_s', CFG.ITI_MIN_TICKS / T, CFG.ITI_MIN_TICKS / T, 'fixed');
    add('iti_max_s', (CFG.ITI_MIN_TICKS + CFG.ITI_JITTER_TICKS) / T, (CFG.ITI_MIN_TICKS + CFG.ITI_JITTER_TICKS) / T, 'fixed');
    add('cue_s', CFG.CUE_TICKS / T, CFG.CUE_TICKS / T, 'fixed');
    add('gap_s', CFG.GAP_TICKS / T, CFG.GAP_TICKS / T, 'fixed');
    add('stim_s', CFG.STIM_TICKS / T, CFG.STIM_TICKS / T, 'fixed');
    add('parity_id', CFG.PARITY_ID, CFG.PARITY_ID, 'fixed');
    return rows;
  }

  /* ------------------------------------------------------------------ session */
  async function startSession(form) {
    var errEl = document.getElementById('formErr');
    var trials, practice;
    try {
      trials = D.generateTrialList(form.seed, form.design).trials;
      D.assertTrialList(trials, form.design);
      practice = CFG.PRACTICE_N > 0
        ? D.practiceTrials(D.generateTrialList(form.seed + CFG.PRACTICE_SEED_OFFSET, form.design).trials,
                           CFG.PRACTICE_N)
        : [];
    } catch (e) {
      errEl.textContent = 'Trial list failed its audit: ' + e.message;
      return;
    }

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await audioCtx.resume();
    } catch (e) {
      errEl.textContent = 'Could not start audio: ' + e.message;
      return;
    }

    /* fullscreen on the document, not the canvas: #overlay is a sibling of
     * the canvas and every text screen would be hidden otherwise */
    try { await document.documentElement.requestFullscreen(); } catch (e) { /* carry on */ }
    document.getElementById('setup').style.display = 'none';
    document.getElementById('stage').style.display = 'block';
    document.body.style.cursor = 'none';
    setupCanvas();
    clearStage();
    showText('<p>Measuring the display&hellip;</p>', '');
    await new Promise(function (r) { setTimeout(r, 400); });
    refresh = await measureRefresh();
    hideText();

    /* ---- the harmonic relationship, checked against THIS display ---- */
    /* The display check no longer blocks the run. If the measured refresh does
     * not yield a valid frequency plan (e.g. a 30 Hz panel, which is not a
     * multiple of GRID_HZ), we snap to the nearest usable integer rate that IS
     * a multiple of GRID_HZ (at least GRID_HZ) and build the plan at that rate.
     * NOTE: on such a display the stimulus timing/flicker fidelity is NOT
     * guaranteed -- use a 120 Hz display for valid data. */
    var planHz = refresh.nominal;
    try {
      plan = D.frequencyPlan(form.plan, planHz, form.stim.dutyPct);
    } catch (e) {
      planHz = Math.max(CFG.GRID_HZ, Math.round(refresh.nominal / CFG.GRID_HZ) * CFG.GRID_HZ);
      plan = D.frequencyPlan(form.plan, planHz, form.stim.dutyPct);
      console.warn('[refresh] measured ' + refresh.measured.toFixed(2) + ' Hz does not fit the ' +
        'frequency plan; forcing plan refresh to ' + planHz + ' Hz. Stimulus timing is NOT valid ' +
        'on this display -- use a 120 Hz monitor for real data. (' + e.message + ')');
    }

    ifi = 1 / refresh.measured;
    stimParams = form.stim;
    geom = S.makeGeometry(form.widthCm / window.screen.width, form.distCm, ifi, stimParams);
    sched = D.stimulusSchedule(plan);

    var map = CFG.COLOR_MAPS[form.colorMap];
    colorName = { A: map.A, B: map.B };
    colorOf = { A: CFG.COLORS[map.A], B: CFG.COLORS[map.B] };
    dimColorOf = { A: S.dimmedColor(colorOf.A, stimParams.lumDipPct), B: S.dimmedColor(colorOf.B, stimParams.lumDipPct) };

    meta = {
      pid: form.pid, participant: form.participant, startedAt: new Date().toISOString(),
      parityId: CFG.PARITY_ID, platform: 'web', userAgent: navigator.userAgent,
      seed: form.seed, colorMap: form.colorMap, colorName: colorName,
      refresh: refresh, plan: plan, geometry: geom, stimParams: stimParams, designParams: form.design,
      dimColorOf: dimColorOf, setup: setupRows(form),
      nCoherent: { background: D.nCoherent(stimParams.cohBgPct, CFG.N_DOTS_PER_ARRAY),
                   target: D.nCoherent(stimParams.cohTgtPct, CFG.N_DOTS_PER_ARRAY) },
      audioSampleRate: audioCtx.sampleRate, audioBaseLatency: audioCtx.baseLatency || null,
      audioOutputLatency: audioCtx.outputLatency || null,
      screen: { cssWidth: window.screen.width, cssHeight: window.screen.height, dpr: DPR },
      config: CFG
    };
    meta.rowBase = {
      pid: form.pid, participant: form.participant, platform: 'web', seed: form.seed,
      color_map: form.colorMap, color_A: colorName.A, color_B: colorName.B,
      freq_plan: plan.name, refresh_nominal_hz: refresh.nominal, refresh_measured_hz: refresh.measured,
      coh_bg_pct: stimParams.cohBgPct, coh_tgt_pct: stimParams.cohTgtPct, duty_pct: stimParams.dutyPct,
      speed_deg_s: stimParams.speedDegS, burst_speed_deg_s: stimParams.burstSpeedDegS,
      lum_dip_pct: stimParams.lumDipPct, tilt_deg: stimParams.tiltDeg, reset_motion: stimParams.resetMotion ? 1 : 0,
      view_dist_cm: form.distCm, screen_width_cm: form.widthCm,
      burst_pct: form.design.burstPct, n_one_blocks: form.design.nOneBlocks, sound_on_pct: form.design.soundOnPct,
      win_frames_A: plan.A.winFrames, win_frames_B: plan.B.winFrames
    };
    rec = new Data.Recorder(meta);

    await textScreen('<h2>Display check</h2><table class="kv">' +
      '<tr><td>refresh</td><td>' + refresh.measured.toFixed(2) + ' Hz (nominal ' + refresh.nominal + ')</td></tr>' +
      '<tr><td>plan</td><td>' + plan.name + '</td></tr>' +
      '<tr><td>array A (' + colorName.A + ')</td><td>flicker ' + plan.A.flickerHz.toFixed(3) + ' Hz = ' +
        plan.A.harmonic + ' &times; pulse ' + plan.A.pulseHz.toFixed(3) + ' Hz</td></tr>' +
      '<tr><td>array B (' + colorName.B + ')</td><td>flicker ' + plan.B.flickerHz.toFixed(3) + ' Hz = ' +
        plan.B.harmonic + ' &times; pulse ' + plan.B.pulseHz.toFixed(3) + ' Hz</td></tr>' +
      '<tr><td>frames / cycle</td><td>A ' + plan.A.flickerFrames + ' (' + plan.A.onFrames + ' on), B ' +
        plan.B.flickerFrames + ' (' + plan.B.onFrames + ' on)</td></tr>' +
      '<tr><td>coherence</td><td>background ' + stimParams.cohBgPct + '% (' +
        D.nCoherent(stimParams.cohBgPct, CFG.N_DOTS_PER_ARRAY) + ' dots)</td></tr>' +
      '<tr><td>duty cycle</td><td>' + stimParams.dutyPct + '% &rarr; coherent window A ' + plan.A.winFrames +
        '/' + plan.A.pulseFrames + ' frames, B ' + plan.B.winFrames + '/' + plan.B.pulseFrames + ' frames</td></tr>' +
      '<tr><td>dot speed</td><td>normal ' + stimParams.speedDegS + ' &deg;/s</td></tr>' +
      '<tr><td>geometry</td><td>' + form.distCm + ' cm viewing distance, ' + form.widthCm + ' cm screen width</td></tr>' +
      '<tr><td>deviant event</td><td>' + deviantText(stimParams) + '</td></tr>' +
      '<tr><td>reset motion</td><td>' + (stimParams.resetMotion ? 'ON' : 'off') + '</td></tr>' +
      '<tr><td>blocks</td><td>' + form.design.nOneBlocks + ' attend-one + ' +
        (CFG.N_BLOCKS - form.design.nOneBlocks) + ' attend-both, ' + CFG.BLOCK_TRIALS + ' trials each; sound on ' +
        form.design.soundOnPct + '% of attend-both trials</td></tr>' +
      '<tr><td>bursts per trial</td><td>0: ' + form.design.burstPct[0] + '%, 1: ' + form.design.burstPct[1] +
        '%, 2: ' + form.design.burstPct[2] + '%, 3: ' + form.design.burstPct[3] + '%</td></tr>' +
      '<tr><td>audio</td><td>' + audioCtx.sampleRate + ' Hz</td></tr></table>',
      'Experimenter: press SPACE to continue, ESC to abort');

    if (!aborted) {
      await textScreen('<h2>Before we start</h2><p>This experiment shows <strong>flickering</strong> ' +
        'dots. If you have epilepsy, have ever had a seizure, or are sensitive to flashing light, ' +
        'please tell the experimenter now and do not continue.</p><p>Press <kbd>Esc</kbd> at any ' +
        'moment to stop.</p>');
    }
    if (!aborted) { await textScreen(instructionsHtml()); }

    /* ---- practice ---- */
    if (!aborted && practice.length) {
      await textScreen('<h2>Practice</h2><p>' + practice.length + ' practice trials, with feedback ' +
        'after each one.</p>');
      for (var p = 0; p < practice.length && !aborted; p++) {
        var pr = await runTrial(practice[p], true);
        if (!pr || aborted) { break; }
        await textScreen('<h2>Practice ' + (p + 1) + ' of ' + practice.length + '</h2>' +
                         feedbackLine([pr.summary]));
      }
      if (!aborted) {
        await textScreen('<h2>Main experiment</h2><p>That is the end of practice. There is no more ' +
          'feedback after each trial, but you will see how you did at each break.</p>' +
          '<p>' + CFG.N_BLOCKS + ' blocks of ' + (trials.length / CFG.N_BLOCKS) + ' trials.</p>');
      }
    }

    /* ---- main blocks ---- */
    var blockSums = [];
    for (var i = 0; i < trials.length && !aborted; i++) {
      var r = await runTrial(trials[i], false);
      if (!r) { break; }
      blockSums.push(r.summary);
      var last = (i === trials.length - 1) || (trials[i + 1].block !== trials[i].block);
      if (last && i < trials.length - 1 && !aborted) {
        await textScreen('<h2>Block ' + trials[i].block + ' of ' + CFG.N_BLOCKS + ' done</h2>' +
                         feedbackLine(blockSums) + '<p>Take a short rest.</p>');
        blockSums = [];
      }
    }

    /* ---- end ---- */
    document.body.style.cursor = '';
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (e) { /* ignore */ } }
    clearStage();
    showText('<h2>' + (aborted ? 'Session stopped' : 'Thank you!') + '</h2>' +
      '<p>' + rec.trials.filter(function (t) { return !t.practice; }).length + ' of ' + trials.length +
      ' trials recorded. The data files are downloading.</p>' +
      '<p><button id="dl">Download data again</button></p>', '');
    document.getElementById('dl').addEventListener('click', function () { rec.downloadAll(); });
    rec.downloadAll();
  }

  /* ------------------------------------------------------------------ setup form */
  function initForm() {
    var el = function (id) { return document.getElementById(id); };
    /* Numeric setup fields (coherence %, duty %, speeds, design settings). Number() not
     * parseFloat(): '60abc' must be rejected, not read as 60. An empty field
     * becomes NaN and fails validation. */
    var pctField = function (id) {
      var s = el(id).value.trim();
      return s === '' ? NaN : Number(s);
    };
    el('cfgParity').textContent = CFG.PARITY_ID;
    el('cfgTrials').textContent = CFG.nTrials() + ' trials in ' + CFG.N_BLOCKS + ' blocks of ' + CFG.BLOCK_TRIALS + ', ' +
      (CFG.STIM_TICKS / CFG.GRID_HZ).toFixed(1) + ' s stimulus, + ' + CFG.PRACTICE_N + ' practice';
    el('distCm').value = CFG.VIEW_DIST_CM_DEFAULT;
    el('widthCm').value = CFG.SCREEN_WIDTH_CM_DEFAULT;
    el('cohBgPct').value = CFG.COH_BG_PCT_DEFAULT;
    el('cohTgtPct').value = CFG.COH_TGT_PCT_DEFAULT;
    el('dutyPct').value = CFG.DUTY_PCT_DEFAULT;
    el('speedDegS').value = CFG.DOT_SPEED_DEG_S_DEFAULT;
    el('burstSpeedDegS').value = CFG.BURST_SPEED_DEG_S_DEFAULT;
    el('lumDipPct').value = CFG.LUM_DIP_PCT_DEFAULT;
    el('tiltDeg').value = CFG.TILT_DEG_DEFAULT;
    el('resetMotion').checked = CFG.RESET_MOTION_DEFAULT;
    for (var v = 0; v <= CFG.MAX_BURSTS; v++) { el('burstPct' + v).value = CFG.BURST_PCT_DEFAULT[v]; }
    el('nOneBlocks').value = CFG.N_ONE_BLOCKS_DEFAULT;
    el('soundOnPct').value = CFG.SOUND_ON_PCT_DEFAULT;

    el('participant').addEventListener('input', function () {
      var n = parseInt(el('participant').value, 10);
      if (!isNaN(n)) {
        el('colorMap').value = String(((n % 2) + 2) % 2);
        el('seed').value = String(CFG.SEED_BASE + n);
      }
    });

    el('startBtn').addEventListener('click', function () {
      var n = parseInt(el('participant').value, 10);
      var form = {
        participant: n,
        pid: 'P' + String(n).padStart(3, '0'),
        colorMap: parseInt(el('colorMap').value, 10),
        plan: el('plan').value,
        seed: parseInt(el('seed').value, 10),
        distCm: parseFloat(el('distCm').value),
        widthCm: parseFloat(el('widthCm').value),
        stim: { cohBgPct: pctField('cohBgPct'), cohTgtPct: pctField('cohTgtPct'), dutyPct: pctField('dutyPct'),
                speedDegS: pctField('speedDegS'), burstSpeedDegS: pctField('burstSpeedDegS'),
                lumDipPct: pctField('lumDipPct'), tiltDeg: pctField('tiltDeg'),
                resetMotion: el('resetMotion').checked },
        design: { burstPct: [pctField('burstPct0'), pctField('burstPct1'), pctField('burstPct2'), pctField('burstPct3')],
                  nOneBlocks: pctField('nOneBlocks'), soundOnPct: pctField('soundOnPct') }
      };
      var err = '';
      if (isNaN(n) || n < 0) { err = 'Enter a participant number (0 or more).'; }
      else if (!(form.distCm > 0)) { err = 'Enter the viewing distance in cm.'; }
      else if (!(form.widthCm > 0)) { err = 'Enter the visible screen width in cm.'; }
      else if (isNaN(form.seed)) { err = 'Seed must be a number.'; }
      else {
        var verr = D.validateStimParams(form.stim).concat(D.validateDesignParams(form.design));
        if (verr.length) { err = 'Invalid settings: ' + verr.join('; '); }
      }
      if (err) { el('formErr').textContent = err; return; }
      el('formErr').textContent = '';
      startSession(form);
    });
  }

  document.addEventListener('DOMContentLoaded', initForm);

})(window);
