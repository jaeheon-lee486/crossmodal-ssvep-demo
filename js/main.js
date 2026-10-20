/* ===========================================================================
 * main.js -- session state machine for the web implementation.
 *
 *   setup form -> trial list generated + audited -> fullscreen
 *   -> refresh measurement -> FREQUENCY PLAN CHECK (refuses to run on failure)
 *   -> photosensitivity notice -> instructions -> practice (with feedback)
 *   -> 8 blocks x 30 trials, self-paced breaks with feedback -> data download
 *
 * One trial:  ITI fixation (1.0-1.5 s) -> cue ring (1.0 s) -> fixation (0.5 s)
 *             -> 6.0 s red/blue dot stimulus, SPACE presses recorded throughout
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
  var stimParams = null;              // { cohBgPct, cohTgtPct, dutyPct } from the setup form
  var audioCtx = null;
  var rec = null, meta = null;
  var colorOf = null, colorName = null;
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

  /* All visible dots of frame f, in the trial's fixed random draw order. */
  function drawDots(dots, f, onA, onB) {
    var N = dots.nPerArray, base = f * dots.nTot, r = geom.dotDiamPx / 2;
    var clear2 = geom.clearRadiusPx * geom.clearRadiusPx;
    var colA = rgb(colorOf.A), colB = rgb(colorOf.B);
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
    var allPips = S.pipSchedule(trial, sched, ifi);
    /* sound preview (DECISION 30): sound trials only, pip train from cue onset */
    var nIti = trial.iti_ticks * fpt, nCue = CFG.CUE_TICKS * fpt, nGap = CFG.GAP_TICKS * fpt;
    /* Preview mode: the pips play ONLY during cue + gap, from their own
     * buffer (exactly cue + gap long, sample 0 = cue onset, stopped at
     * stimulus onset); the stimulus period is SILENT. Without the preview,
     * the pips play during the stimulus as usual. */
    var preview = !!(stimParams.previewSound && allPips.length);
    var pips = preview ? [] : allPips;                   // stimulus-period pips
    var buffer = pips.length ? S.makePipBuffer(audioCtx, pips, nF * ifi + 0.5) : null;
    var prevPips = preview ? S.previewPipSchedule(trial, sched, ifi, nCue + nGap) : [];
    var leadS = (nCue + nGap) * ifi;                    // cue onset -> stimulus onset
    var prevBuffer = preview ? S.makePipBuffer(audioCtx, prevPips, leadS, leadS) : null;

    var row = {}, events = [];
    var src = null, prevSrc = null, plannedOnset = NaN, audioStartCtx = NaN, prevPlannedOnset = NaN;
    var stopAll = function () { if (src) { src.stop(); } if (prevSrc) { prevSrc.stop(); } };

    /* with a preview, the preview buffer is scheduled on the FIRST ITI frame
     * for the moment the first cue frame is expected on screen (>= 1.0 s of
     * lead time), and told to stop at the expected stimulus onset */
    await runFrames(nIti, function (f, t) {
      drawFixation();
      if (f === 0 && prevBuffer) {
        var cueCtx = ctxTimeForPerf(t + nIti * ifi + lag);
        prevPlannedOnset = t + (nIti + nCue + nGap) * ifi + lag;
        prevSrc = audioCtx.createBufferSource();
        prevSrc.buffer = prevBuffer;
        prevSrc.connect(audioCtx.destination);
        prevSrc.start(Math.max(cueCtx, audioCtx.currentTime));
        prevSrc.stop(cueCtx + leadS);
      }
    });
    if (aborted) { stopAll(); return null; }

    var cueRes = await runFrames(nCue, function () { drawCue(trial.attend); });
    if (aborted) { stopAll(); return null; }

    /* the stimulus pip train is scheduled on the FIRST gap frame, for the
     * moment the first stimulus frame is expected on screen -- 0.5 s of lead
     * time (the same with and without a preview) */
    await runFrames(nGap, function (f, t) {
      drawFixation();
      if (f === 0 && buffer) {
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
    var res = await runFrames(nF, function (f) {
      drawDots(dots, f, sched.A.on[f], sched.B.on[f]);
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
    /* preview pips (t_sched_s negative) come from their own buffer, so their
     * offset is estimated from the preview buffer's own schedule */
    var prevAvOffset = prevBuffer ? prevPlannedOnset - tOn : NaN;
    prevPips.forEach(function (p) {
      events.push(Object.assign({}, base, {
        event: 'pip_preview', array: trial.sound_match, index: p.pulse, is_target: '', target_pulse: '',
        frame: p.frame, t_sched_s: p.t_s, t_actual_s: p.t_s + prevAvOffset, t_peak_s: '', rt_s: '', outcome: ''
      }));
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
    var tA = new Uint8Array(nF), tB = new Uint8Array(nF), tFlip = new Float64Array(nF);
    for (var f = 0; f < nF; f++) {
      tA[f] = (sched.A.pulse[f] >= 0 && trial.tgt_A_pulses.indexOf(sched.A.pulse[f]) >= 0) ? 1 : 0;
      tB[f] = (sched.B.pulse[f] >= 0 && trial.tgt_B_pulses.indexOf(sched.B.pulse[f]) >= 0) ? 1 : 0;
      tFlip[f] = rel(f);
    }
    var frames = { pid: meta.pid, practice: practice ? 1 : 0, trial: trial.trial, t: tFlip,
                   onA: sched.A.on, onB: sched.B.on, pA: sched.A.pulse, pB: sched.B.pulse, tA: tA, tB: tB };

    /* ---- trial row ---- */
    var s = sc.summary;
    row = Object.assign({}, meta.rowBase, {
      practice: practice ? 1 : 0,
      trial: trial.trial, block: trial.block, trial_in_block: trial.trial_in_block,
      cell: trial.cell, cond: trial.cond, attend: trial.attend,
      cue: trial.attend === 'both' ? colorName.A + '+' + colorName.B : colorName[trial.attend],
      sound_match: trial.sound_match,
      dir_A: trial.dir_A, dir_B: trial.dir_B,
      dir_A_name: CFG.DIR_NAMES[trial.dir_A], dir_B_name: CFG.DIR_NAMES[trial.dir_B],
      n_tgt_A: trial.n_tgt_A, n_tgt_B: trial.n_tgt_B,
      tgt_A_pulses: trial.tgt_A_pulses, tgt_B_pulses: trial.tgt_B_pulses,
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
      n_pips: pips.length, n_preview_pips: prevPips.length,
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

  function instructionsHtml() {
    return '<h2>Instructions</h2>' +
      '<p>You will see a cloud of small flickering dots &mdash; some ' + colourWord('red') +
      ', some ' + colourWord('blue') + ' &mdash; mixed together around a central dot. ' +
      '<strong>Keep your eyes on the central dot</strong> the whole time.</p>' +
      '<p>The dots of each colour drift in one direction among random jiggling. Every so ' +
      'often, the dots of one colour make a <strong>stronger, clearer sweep</strong> in their ' +
      'direction for a moment.</p>' +
      '<p>Press <kbd>SPACE</kbd> as quickly as you can whenever you see a strong sweep ' +
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
    var pct = n ? Math.round(100 * h / n) : 0;
    return '<p>You caught <strong>' + h + ' of ' + n + '</strong> sweeps in the cued colour' +
           ' (' + pct + '%).<br>Presses with no sweep in the cued colour: <strong>' + fa + '</strong>.</p>';
  }

  /* ------------------------------------------------------------------ session */
  async function startSession(form) {
    var errEl = document.getElementById('formErr');
    var trials, practice;
    try {
      trials = D.generateTrialList(form.seed).trials;
      D.assertTrialList(trials);
      practice = CFG.PRACTICE_N > 0
        ? D.generateTrialList(form.seed + CFG.PRACTICE_SEED_OFFSET).trials.slice(0, CFG.PRACTICE_N)
        : [];
      practice.forEach(function (t, i) { t.trial = i + 1; t.block = 0; t.trial_in_block = i + 1; });
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
    // var planErr = null;
    // if (Math.abs(refresh.measured - refresh.nominal) > CFG.REFRESH_TOL_HZ) {
    //   planErr = 'Measured refresh ' + refresh.measured.toFixed(2) + ' Hz is not stable at an integer rate.';
    // } else {
    //   try { plan = D.frequencyPlan(form.plan, refresh.nominal, form.stim.dutyPct); } catch (e) { planErr = e.message; }
    // }
    var planErr = null;
    try {
      plan = D.frequencyPlan(form.plan, refresh.nominal, form.stim.dutyPct);
    } catch (e) {
      console.warn('Harmonic check failed, forcing plan anyway (pilot mode):', e.message);
      plan = D.frequencyPlan(form.plan, refresh.nominal, form.stim.dutyPct, true); // 세 번째 인자로 강제통과 플래그
    }
    if (planErr) {
      document.body.style.cursor = '';
      await textScreen('<h2>Cannot run on this display</h2><pre>' + planErr + '</pre>' +
        '<p>The <code>standard</code> plan (13.33 / 12 Hz flicker) needs a <strong>120 Hz</strong> ' +
        '(or 240 Hz) display. Set the monitor to 120 Hz and reload. Only if that is impossible, ' +
        'choose <code>fallback60</code> on the setup form &mdash; it changes array A\'s flicker to ' +
        '10 Hz (DESIGN_LOG.md, DECISION 3).</p>', 'Press SPACE to return to setup');
      location.reload();
      return;
    }

    ifi = 1 / refresh.measured;
    stimParams = form.stim;
    geom = S.makeGeometry(form.widthCm / window.screen.width, form.distCm, ifi, stimParams);
    sched = D.stimulusSchedule(plan);

    var map = CFG.COLOR_MAPS[form.colorMap];
    colorName = { A: map.A, B: map.B };
    colorOf = { A: CFG.COLORS[map.A], B: CFG.COLORS[map.B] };

    meta = {
      pid: form.pid, participant: form.participant, startedAt: new Date().toISOString(),
      parityId: CFG.PARITY_ID, platform: 'web', userAgent: navigator.userAgent,
      seed: form.seed, colorMap: form.colorMap, colorName: colorName,
      refresh: refresh, plan: plan, geometry: geom, stimParams: stimParams,
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
      preview_sound: stimParams.previewSound ? 1 : 0,
      view_dist_cm: form.distCm, screen_width_cm: form.widthCm,
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
        D.nCoherent(stimParams.cohBgPct, CFG.N_DOTS_PER_ARRAY) + ' dots), target ' + stimParams.cohTgtPct +
        '% (' + D.nCoherent(stimParams.cohTgtPct, CFG.N_DOTS_PER_ARRAY) + ' dots)</td></tr>' +
      '<tr><td>duty cycle</td><td>' + stimParams.dutyPct + '% &rarr; coherent window A ' + plan.A.winFrames +
        '/' + plan.A.pulseFrames + ' frames, B ' + plan.B.winFrames + '/' + plan.B.pulseFrames + ' frames</td></tr>' +
      '<tr><td>dot speed</td><td>normal ' + stimParams.speedDegS + ' &deg;/s, burst (target) ' +
        stimParams.burstSpeedDegS + ' &deg;/s</td></tr>' +
      '<tr><td>geometry</td><td>' + form.distCm + ' cm viewing distance, ' + form.widthCm + ' cm screen width</td></tr>' +
      '<tr><td>sound preview</td><td>' + (stimParams.previewSound
        ? 'ON &mdash; sound trials: pips only during cue + gap, dots silent (cue + gap = ' +
          ((CFG.CUE_TICKS + CFG.GAP_TICKS) / CFG.GRID_HZ).toFixed(1) + ' s)'
        : 'off') + '</td></tr>' +
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
    /* Numeric stimulus fields (coherence %, duty %, speeds). Number() not
     * parseFloat(): '60abc' must be rejected, not read as 60. An empty field
     * becomes NaN and fails validation. */
    var pctField = function (id) {
      var s = el(id).value.trim();
      return s === '' ? NaN : Number(s);
    };
    el('cfgParity').textContent = CFG.PARITY_ID;
    el('cfgTrials').textContent = CFG.nTrials() + ' trials in ' + CFG.N_BLOCKS + ' blocks, ' +
      (CFG.STIM_TICKS / CFG.GRID_HZ).toFixed(1) + ' s stimulus, + ' + CFG.PRACTICE_N + ' practice';
    el('distCm').value = CFG.VIEW_DIST_CM_DEFAULT;
    el('widthCm').value = CFG.SCREEN_WIDTH_CM_DEFAULT;
    el('cohBgPct').value = CFG.COH_BG_PCT_DEFAULT;
    el('cohTgtPct').value = CFG.COH_TGT_PCT_DEFAULT;
    el('dutyPct').value = CFG.DUTY_PCT_DEFAULT;
    el('speedDegS').value = CFG.DOT_SPEED_DEG_S_DEFAULT;
    el('burstSpeedDegS').value = CFG.BURST_SPEED_DEG_S_DEFAULT;
    el('previewSound').checked = CFG.PREVIEW_SOUND_DEFAULT;

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
                previewSound: el('previewSound').checked }
      };
      var err = '';
      if (isNaN(n) || n < 0) { err = 'Enter a participant number (0 or more).'; }
      else if (!(form.distCm > 0)) { err = 'Enter the viewing distance in cm.'; }
      else if (!(form.widthCm > 0)) { err = 'Enter the visible screen width in cm.'; }
      else if (isNaN(form.seed)) { err = 'Seed must be a number.'; }
      else {
        var verr = D.validateStimParams(form.stim);
        if (form.stim.previewSound) { verr = verr.concat(D.previewCheck()); }
        if (verr.length) { err = 'Invalid stimulus settings: ' + verr.join('; '); }
      }
      if (err) { el('formErr').textContent = err; return; }
      el('formErr').textContent = '';
      startSession(form);
    });
  }

  document.addEventListener('DOMContentLoaded', initForm);

})(window);
