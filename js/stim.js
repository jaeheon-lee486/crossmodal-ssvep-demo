/* ===========================================================================
 * stim.js -- geometry, dot-field precomputation, and the pip train.
 * Mirrored by matlab/+cmcomp/{makeGeometry, precomputeDots, makePipTrain,
 * dimmedColor}.m.
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
      burstSpeedPxPerFrame: a2p(sp.burstSpeedDegS) * ifi,    // coherent dots of a deviant (target) pulse
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
   *            nCoherent(cohBgPct) otherwise (DECISIONS 28, 38).
   *   f > 0  : for A then B, draw N angles; a dot in the subset steps in the
   *            pulse's coherent direction while frame f is inside the pulse's
   *            coherent window; every other dot steps in its own random
   *            direction at the normal speed. Then any dot outside the
   *            aperture respawns uniformly inside it (ascending index; r then
   *            theta).
   * A TARGET (deviant) pulse always uses the deviant coherence (cohTgtPct),
   * moves its coherent dots at the deviant speed, and rotates their
   * direction by tilt sign x tiltDeg (signs from the trial list, one per
   * target). The layers are independent (DECISION 38): any of them equal to
   * the background (or tiltDeg 0) changes nothing, and with all of them so
   * the dots are exactly those of a background pulse. The luminance dip is
   * applied when drawing (main.js), not here.
   * Reset motion (DECISION 33, stimParams.resetMotion): on the first frame
   * after a coherent window, every dot's accumulated coherent displacement
   * from that window is subtracted, so the subset jumps back to where its
   * coherent sweep began (plus that frame's ordinary step). A dot that
   * respawns loses its accumulated displacement. No extra RNG draws.
   * stimParams = { cohBgPct, cohTgtPct, dutyPct, speedDegS, burstSpeedDegS,
   * lumDipPct, tiltDeg, resetMotion }; the duty cycle acts through
   * plan/sched, the speeds through geom.
   * ------------------------------------------------------------------------ */
  function precomputeDots(trial, plan, sched, geom, stimParams) {
    var sp = stimParams || root.XMDesign.defaultStimParams();
    var N = CFG.N_DOTS_PER_ARRAY, nTot = 2 * N, nF = plan.stimFrames;
    var nBg = root.XMDesign.nCoherent(sp.cohBgPct, N), nTgt = root.XMDesign.nCoherent(sp.cohTgtPct, N);
    var R = geom.apertureRadiusPx, step = geom.speedPxPerFrame, burst = geom.burstSpeedPxPerFrame;
    var rng = new Minstd(trial.dot_seed);
    var x = new Float64Array(nF * nTot), y = new Float64Array(nF * nTot);
    var accX = new Float64Array(nTot), accY = new Float64Array(nTot);   // coherent displacement (reset mode)
    var g, i, j, f, idx, cur, prev, rs, ths, angs, ang, r, th;

    var tgt = { A: trial.tgt_A_pulses, B: trial.tgt_B_pulses };
    var sgn = { A: trial.tgt_A_tilt_sign, B: trial.tgt_B_tilt_sign };
    var mask = [new Uint8Array(N), new Uint8Array(N)];
    var cdx = [0, 0], cdy = [0, 0];                  // coherent step of the current pulse of A / B

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
      /* coherent subsets and steps, chosen at each pulse onset */
      for (g = 0; g < 2; g++) {
        var a = ARRAYS[g], k = sched[a].pulse[f];
        if (k >= 0 && (f === 0 || sched[a].pulse[f - 1] !== k)) {
          var ti = tgt[a].indexOf(k), isTgt = ti >= 0;
          var nCoh = isTgt ? nTgt : nBg;
          var perm = rng.shuffleIndices(N);
          for (i = 0; i < N; i++) { mask[g][i] = 0; }
          for (j = 0; j < nCoh; j++) { mask[g][perm[j]] = 1; }
          var cang = CFG.DIR_ANGLE_DEG[trial['dir_' + a]];
          if (isTgt) { cang += sgn[a][ti] * sp.tiltDeg; }
          cang *= Math.PI / 180;
          var cstep = isTgt ? burst : step;
          cdx[g] = cstep * Math.cos(cang);
          cdy[g] = -cstep * Math.sin(cang);          // screen y points down
        }
      }
      if (f === 0) { continue; }

      prev = (f - 1) * nTot;
      cur = f * nTot;
      for (g = 0; g < 2; g++) {
        var arr = ARRAYS[g];
        var active = sched[arr].pulse[f] >= 0;
        var reset = sp.resetMotion && sched[arr].pulse[f - 1] >= 0 && sched[arr].pulse[f] !== sched[arr].pulse[f - 1];
        angs = rng.randArray(N);
        for (i = 0; i < N; i++) {
          idx = g * N + i;
          var coh = active && mask[g][i];
          if (coh) {
            x[cur + idx] = x[prev + idx] + cdx[g];
            y[cur + idx] = y[prev + idx] + cdy[g];
          } else {
            ang = 2 * Math.PI * angs[i];
            x[cur + idx] = x[prev + idx] + step * Math.cos(ang);
            y[cur + idx] = y[prev + idx] - step * Math.sin(ang);
          }
          if (reset) {                               // undo the window that just ended
            x[cur + idx] -= accX[idx];
            y[cur + idx] -= accY[idx];
            accX[idx] = 0;
            accY[idx] = 0;
          }
          if (coh) { accX[idx] += cdx[g]; accY[idx] += cdy[g]; }
        }
      }
      /* respawn, ascending global index so the draw sequence is fixed */
      for (idx = 0; idx < nTot; idx++) {
        if (Math.sqrt(x[cur + idx] * x[cur + idx] + y[cur + idx] * y[cur + idx]) > R) {
          r = R * Math.sqrt(rng.nextFloat());
          th = 2 * Math.PI * rng.nextFloat();
          x[cur + idx] = r * Math.cos(th);
          y[cur + idx] = r * Math.sin(th);
          accX[idx] = 0;
          accY[idx] = 0;
        }
      }
    }
    return { x: x, y: y, nTot: nTot, nPerArray: N, nFrames: nF, drawOrder: drawOrder };
  }

  /* Luminance-dip colour of a deviant event (DECISIONS 36, 38): rgb with its
   * LINEAR-light luminance reduced by dipPct %, assuming the sRGB transfer
   * function (the same nominal-sRGB assumption as DECISION 19), rounded to
   * whole 0-255 values. Mirrors +cmcomp/dimmedColor.m. */
  function dimmedColor(rgb, dipPct) {
    return rgb.map(function (v) {
      var c = v / 255;
      var lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      lin *= 1 - dipPct / 100;
      c = lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
      return Math.floor(255 * c + 0.5);
    });
  }

  /* ---------------------------------------------------------------------------
   * Pips: one per pulse of the MATCHED array (all pulses, not only targets --
   * the sound is a rhythm locked to that array, never a target cue). Time is
   * relative to stimulus onset and uses the MEASURED frame interval, so the
   * pips land on the frames that are actually shown. Sound plays only during
   * the stimulus (the cue-period preview of DECISION 30 was removed, DECISION 31).
   * ------------------------------------------------------------------------ */
  function pipSchedule(trial, sched, ifi) {
    if (trial.sound_match === 'none') { return []; }
    var on = sched[trial.sound_match].onsetFrames, out = [];
    for (var k = 0; k < on.length; k++) {
      out.push({ pulse: k, frame: on[k], t_s: on[k] * ifi + CFG.PIP_OFFSET_S });
    }
    return out;
  }

  /* Samples of one pip train, raised-cosine ramps; same formula as
   * +cmcomp/makePipTrain.m. Sample 0 is at stimulus onset. Returns a
   * Float32Array. */
  function pipTrainSamples(pips, durS, fs) {
    var nS = Math.round(durS * fs), out = new Float32Array(nS);
    var nP = Math.round(CFG.PIP_DUR_S * fs), nR = Math.round(CFG.PIP_RAMP_S * fs);
    for (var p = 0; p < pips.length; p++) {
      var s0 = Math.round(pips[p].t_s * fs);
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

  function makePipBuffer(audioCtx, pips, durS) {
    var fs = audioCtx.sampleRate;
    var data = pipTrainSamples(pips, durS, fs);
    var buf = audioCtx.createBuffer(2, data.length, fs);
    buf.getChannelData(0).set(data);
    buf.getChannelData(1).set(data);
    return buf;
  }

  root.XMStim = {
    makeGeometry: makeGeometry,
    precomputeDots: precomputeDots,
    dimmedColor: dimmedColor,
    pipSchedule: pipSchedule,
    pipTrainSamples: pipTrainSamples,
    makePipBuffer: makePipBuffer
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = root.XMStim; }

})(typeof window !== 'undefined' ? window : globalThis);
