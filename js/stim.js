/* ===========================================================================
 * stim.js -- geometry, dot-field precomputation, and the pip train.
 * Mirrored by matlab/+cmcomp/{makeGeometry, precomputeDots, makePipTrain}.m.
 *
 * Two dot arrays share ONE aperture. Global dot index 0..N-1 is array A,
 * N..2N-1 is array B. Colour is assigned per participant by the colour map
 * (A red / B blue, or swapped), so nothing in here knows about colour.
 * =========================================================================== */
(function (root) {
  'use strict';

  var CFG = root.XMConfig;
  var Minstd = root.XMMinstd;
  var ARRAYS = ['A', 'B'];

  /* Pixel geometry from the physical pixel size, viewing distance and the
   * measured frame interval. stimParams supplies the two dot speeds
   * (DECISION 29); omitted = config defaults. */
  function makeGeometry(pixelSizeCm, distCm, ifi, stimParams) {
    var sp = stimParams || root.XMDesign.defaultStimParams();
    var a2p = function (deg) { return CFG.angle2pix(deg, pixelSizeCm, distCm); };
    return {
      pixelSizeCm: pixelSizeCm,
      distCm: distCm,
      ifi: ifi,
      apertureRadiusPx: a2p(CFG.APERTURE_RADIUS_DEG),
      clearRadiusPx: a2p(CFG.FIX_CLEAR_RADIUS_DEG),
      dotDiamPx: a2p(CFG.DOT_DIAM_DEG),
      speedPxPerFrame: a2p(sp.speedDegS) * ifi,              // normal speed
      burstSpeedPxPerFrame: a2p(sp.burstSpeedDegS) * ifi,    // target-pulse coherent dots
      fixOuterPx: a2p(CFG.FIX_OUTER_DEG),
      fixInnerPx: a2p(CFG.FIX_INNER_DEG),
      cueInnerRadiusPx: a2p(CFG.CUE_INNER_RADIUS_DEG),
      cueOuterRadiusPx: a2p(CFG.CUE_OUTER_RADIUS_DEG)
    };
  }

  /* ---------------------------------------------------------------------------
   * precomputeDots -- every dot position for every frame, computed before the
   * trial starts so the frame loop only reads arrays.
   *
   * Per frame f (0-based), in this order (the RNG draw order is part of the
   * spec, so the MATLAB port follows it exactly):
   *   f == 0 : uniform positions in the disc (A then B), then a random draw
   *            order over all 2N dots, fixed for the trial.
   *   every f: for A then B, if a pulse STARTS at f, pick its coherent subset:
   *            the first nCoh entries of a fresh shuffle of 0..N-1, where
   *            nCoh = nCoherent(cohTgtPct) for a target pulse,
   *            nCoherent(cohBgPct) otherwise (DECISION 28).
   *   f > 0  : for A then B, draw N angles; a dot in the subset steps in the
   *            array's direction while frame f is inside the pulse's coherent
   *            window -- at the BURST speed if the pulse is a target, at the
   *            normal speed otherwise (DECISION 29). Every other dot steps in
   *            its own random direction at the normal speed. Then any dot
   *            outside the aperture respawns uniformly inside it (ascending
   *            index; r then theta).
   * The coherence step is abrupt: nCoh dots switch to the common direction on
   * the window's first frame and stay there to its last; outside the window
   * (duty cycle < 100 %) every dot moves randomly at the normal speed.
   * stimParams = { cohBgPct, cohTgtPct, dutyPct, speedDegS, burstSpeedDegS };
   * the duty cycle acts through plan/sched, the speeds through geom.
   * ------------------------------------------------------------------------ */
  function precomputeDots(trial, plan, sched, geom, stimParams) {
    var sp = stimParams || root.XMDesign.defaultStimParams();
    var N = CFG.N_DOTS_PER_ARRAY, nTot = 2 * N, nF = plan.stimFrames;
    var nBg = root.XMDesign.nCoherent(sp.cohBgPct, N), nTgt = root.XMDesign.nCoherent(sp.cohTgtPct, N);
    var R = geom.apertureRadiusPx, step = geom.speedPxPerFrame, burst = geom.burstSpeedPxPerFrame;
    var rng = new Minstd(trial.dot_seed);
    var x = new Float64Array(nF * nTot), y = new Float64Array(nF * nTot);
    var g, i, j, f, idx, cur, prev, rs, ths, angs, ang, r, th, dx, dy;

    var tgt = { A: trial.tgt_A_pulses, B: trial.tgt_B_pulses };
    var mask = [new Uint8Array(N), new Uint8Array(N)];
    var isTgt = [false, false];                      // is the current pulse of A / B a target?

    /* frame 0: uniform density over the disc, r = R*sqrt(u) */
    for (g = 0; g < 2; g++) {
      rs = rng.randArray(N);
      ths = rng.randArray(N);
      for (i = 0; i < N; i++) {
        idx = g * N + i;
        r = R * Math.sqrt(rs[i]);
        th = 2 * Math.PI * ths[i];
        x[idx] = r * Math.cos(th);
        y[idx] = r * Math.sin(th);
      }
    }
    var drawOrder = rng.shuffleIndices(nTot);

    for (f = 0; f < nF; f++) {
      /* coherent subsets, chosen at each pulse onset */
      for (g = 0; g < 2; g++) {
        var a = ARRAYS[g], k = sched[a].pulse[f];
        if (k >= 0 && (f === 0 || sched[a].pulse[f - 1] !== k)) {
          isTgt[g] = tgt[a].indexOf(k) >= 0;
          var nCoh = isTgt[g] ? nTgt : nBg;
          var perm = rng.shuffleIndices(N);
          for (i = 0; i < N; i++) { mask[g][i] = 0; }
          for (j = 0; j < nCoh; j++) { mask[g][perm[j]] = 1; }
        }
      }
      if (f === 0) { continue; }

      prev = (f - 1) * nTot;
      cur = f * nTot;
      for (g = 0; g < 2; g++) {
        var arr = ARRAYS[g];
        var active = sched[arr].pulse[f] >= 0;
        var cang = CFG.DIR_ANGLE_DEG[trial['dir_' + arr]] * Math.PI / 180;
        var cstep = isTgt[g] ? burst : step;         // coherent dots of a target pulse: burst speed
        dx = cstep * Math.cos(cang);
        dy = -cstep * Math.sin(cang);                // screen y points down
        angs = rng.randArray(N);
        for (i = 0; i < N; i++) {
          idx = g * N + i;
          if (active && mask[g][i]) {
            x[cur + idx] = x[prev + idx] + dx;
            y[cur + idx] = y[prev + idx] + dy;
          } else {
            ang = 2 * Math.PI * angs[i];
            x[cur + idx] = x[prev + idx] + step * Math.cos(ang);
            y[cur + idx] = y[prev + idx] - step * Math.sin(ang);
          }
        }
      }
      /* respawn, ascending global index so the draw sequence is fixed */
      for (idx = 0; idx < nTot; idx++) {
        if (Math.sqrt(x[cur + idx] * x[cur + idx] + y[cur + idx] * y[cur + idx]) > R) {
          r = R * Math.sqrt(rng.nextFloat());
          th = 2 * Math.PI * rng.nextFloat();
          x[cur + idx] = r * Math.cos(th);
          y[cur + idx] = r * Math.sin(th);
        }
      }
    }
    return { x: x, y: y, nTot: nTot, nPerArray: N, nFrames: nF, drawOrder: drawOrder };
  }

  /* ---------------------------------------------------------------------------
   * Pips: one per pulse of the MATCHED array (all pulses, not only targets --
   * the sound is a rhythm locked to that array, never a target cue). Time is
   * relative to stimulus onset and uses the MEASURED frame interval, so the
   * pips land on the frames that are actually shown.
   * ------------------------------------------------------------------------ */
  function pipSchedule(trial, sched, ifi) {
    if (trial.sound_match === 'none') { return []; }
    var on = sched[trial.sound_match].onsetFrames, out = [];
    for (var k = 0; k < on.length; k++) {
      out.push({ pulse: k, frame: on[k], t_s: on[k] * ifi + CFG.PIP_OFFSET_S });
    }
    return out;
  }

  /* Preview pips (DECISION 30): the matched array's pulse grid shifted back by
   * the preview span (cue + gap, previewFrames frames), for every pulse that
   * starts within the first previewFrames frames of the stimulus. Times are
   * relative to stimulus onset, so they are NEGATIVE; the last preview pip is
   * one pulse period before the first stimulus pip. */
  function previewPipSchedule(trial, sched, ifi, previewFrames) {
    if (trial.sound_match === 'none' || !(previewFrames > 0)) { return []; }
    var on = sched[trial.sound_match].onsetFrames, out = [];
    for (var k = 0; k < on.length && on[k] < previewFrames; k++) {
      var fr = on[k] - previewFrames;
      out.push({ pulse: k, frame: fr, t_s: fr * ifi + CFG.PIP_OFFSET_S });
    }
    return out;
  }

  /* Samples of one pip train, raised-cosine ramps; same formula as
   * +cmcomp/makePipTrain.m. Sample 0 is at stimulus onset - leadS (leadS > 0
   * when a preview is played, else 0). Returns a Float32Array. */
  function pipTrainSamples(pips, durS, fs, leadS) {
    var lead = leadS || 0;
    var nS = Math.round(durS * fs), out = new Float32Array(nS);
    var nP = Math.round(CFG.PIP_DUR_S * fs), nR = Math.round(CFG.PIP_RAMP_S * fs);
    for (var p = 0; p < pips.length; p++) {
      var s0 = Math.round((pips[p].t_s + lead) * fs);
      for (var j = 0; j < nP; j++) {
        var s = s0 + j;
        if (s < 0 || s >= nS) { continue; }
        var env = 1;
        if (j < nR) { env = 0.5 * (1 - Math.cos(Math.PI * j / nR)); }
        else if (j >= nP - nR) { env = 0.5 * (1 - Math.cos(Math.PI * (nP - 1 - j) / nR)); }
        out[s] += CFG.PIP_AMPLITUDE * env * Math.sin(2 * Math.PI * CFG.PIP_FREQ_HZ * j / fs);
      }
    }
    return out;
  }

  function makePipBuffer(audioCtx, pips, durS, leadS) {
    var fs = audioCtx.sampleRate;
    var data = pipTrainSamples(pips, durS, fs, leadS);
    var buf = audioCtx.createBuffer(2, data.length, fs);
    buf.getChannelData(0).set(data);
    buf.getChannelData(1).set(data);
    return buf;
  }

  root.XMStim = {
    makeGeometry: makeGeometry,
    precomputeDots: precomputeDots,
    pipSchedule: pipSchedule,
    previewPipSchedule: previewPipSchedule,
    pipTrainSamples: pipTrainSamples,
    makePipBuffer: makePipBuffer
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = root.XMStim; }

})(typeof window !== 'undefined' ? window : globalThis);
