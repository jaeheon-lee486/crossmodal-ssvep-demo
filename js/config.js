/* ===========================================================================
 * config.js -- every parameter of the web implementation.
 *
 * SOURCE OF TRUTH, COPY 1 of 2. matlab/+cmcfg/config.m holds the same values
 * under camelCase names, and reference/reference_design.py holds the subset
 * that decides the trial list. If you change a value here, change it there,
 * and bump PARITY_ID in both. See DESIGN_LOG.md for why each value is what it
 * is (DECISION numbers are given inline).
 *
 * TIME UNITS. Trial-level timing is in TICKS of 1/60 s (GRID_HZ). A tick is a
 * whole number of frames at 60, 120 and 240 Hz, which is what lets the same
 * trial list run unchanged at any of them. Frames per tick = refresh / 60.
 * =========================================================================== */
(function (root) {
  'use strict';

  var CONFIG = {
    PARITY_ID: 'XM-PARAM-2026-10-20e',

    /* ------------------------------------------------------ display */
    BG_COLOR: [0, 0, 0],
    VIEW_DIST_CM_DEFAULT: 40,         // setup-form default (DECISION 29; was 60)
    SCREEN_WIDTH_CM_DEFAULT: 60,      // setup-form default (DECISION 29; was an empty field)
    REFRESH_TOL_HZ: 1.0,              // measured refresh must be within this of an integer
    REFRESH_MEASURE_MS: 1500,

    /* ------------------------------------------------------ frequency plan
     * DECISION 1-3. A plan is the integer harmonic per array: flicker period =
     * pulse period / harmonic, so "flicker = harmonic x pulse" holds by
     * construction and is re-checked at run time by Design.planCheck against
     * the ACTUAL refresh rate. 'standard' is the advisor's design and needs a
     * 120 Hz (or 240 Hz) display. 'fallback60' changes array A's flicker from
     * 13.33 to 10 Hz so the design fits a 60 Hz display -- it is never chosen
     * automatically. */
    FREQ_PLAN_DEFAULT: 'standard',
    FREQ_PLANS: {
      standard:   { harm: { A: 4, B: 3 }, flickerHz: { A: 40 / 3, B: 12 } },
      fallback60: { harm: { A: 3, B: 3 }, flickerHz: { A: 10,     B: 12 } }
    },
    MAX_CHECK_HARMONIC: 10,
    SHARED_HARMONIC_REPORT_MAX_HZ: 60,
    FREQ_TOL: 1e-9,

    /* ------------------------------------------------------ trial timing (ticks of 1/60 s) */
    GRID_HZ: 60,
    STIM_TICKS: 360,                  // 6.0 s stimulus epoch (DECISION 7)
    CUE_TICKS: 60,                    // 1.0 s cue
    GAP_TICKS: 30,                    // 0.5 s fixation between cue and stimulus
    ITI_MIN_TICKS: 60,                // 1.0 s ...
    ITI_JITTER_TICKS: 30,             // ... + 0..0.5 s, drawn in the trial list

    /* ------------------------------------------------------ coherence pulses (DECISION 4-6) */
    PULSE_PERIOD_TICKS: { A: 18, B: 15 },   // 0.300 s = 3.333 Hz, 0.250 s = 4.000 Hz
    PULSE_PHASE_TICKS:  { A: 0,  B: 1 },    // B's stream starts 1/60 s after A's
    PULSE_TAIL_TICKS: 6,                    // last pulse starts >= 100 ms before the end (was
                                            //   PULSE_WIN_TICKS; kept so the trial list is unchanged)

    /* ------------------------------------------------------ coherence + speed (DECISION 28-29)
     * Defaults for the five stimulus values on the setup screen. They change
     * what is drawn, never the trial list. Checked by Design.validateStimParams. */
    COH_BG_PCT_DEFAULT: 50,           // % of an array's dots coherent in a background pulse (was 60)
    COH_TGT_PCT_DEFAULT: 95,          // % coherent in a TARGET pulse (was 80)
    DUTY_PCT_DEFAULT: 50,             // coherent window as % of the pulse period (was 100)
    DOT_SPEED_DEG_S_DEFAULT: 5.0,     // normal speed: every dot except target-pulse coherent dots
    BURST_SPEED_DEG_S_DEFAULT: 5.0,   // speed of the coherent dots in a TARGET pulse (independent value)
    SPEED_MAX_DEG_S: 40,              // validation ceiling for both speeds

    /* ------------------------------------------------------ targets + scoring (DECISION 9-11) */
    TGT_MIN_ONSET_TICKS: 60,          // no target before 1.0 s
    TGT_MAX_ONSET_TICKS: 306,         // none after 5.1 s
    TGT_MIN_GAP_TICKS: 60,            // >= 1.0 s between any two targets
    TGT_MIN_OTHER_SEP_TICKS: 3,       // target pulse >= 50 ms from every other-array pulse
    RESP_WIN_MIN_S: 0.15,
    RESP_WIN_MAX_S: 0.90,

    /* ------------------------------------------------------ trial list (DECISION 12-14)
     * Keep identical to reference_design.py and +cmcfg/config.m */
    N_BLOCKS: 8,
    CELLS: [
      { code: 1, name: 'attend_A_silent',    attend: 'A',    sound: 'none', n: 40 },
      { code: 2, name: 'attend_B_silent',    attend: 'B',    sound: 'none', n: 40 },
      { code: 3, name: 'attend_both_silent', attend: 'both', sound: 'none', n: 80 },
      { code: 4, name: 'attend_both_soundA', attend: 'both', sound: 'A',    n: 40 },
      { code: 5, name: 'attend_both_soundB', attend: 'both', sound: 'B',    n: 40 }
    ],
    TGT_COUNT_VALUES: [0, 1, 2],
    TGT_COUNT_WEIGHTS: [1, 2, 1],
    MAX_RUN_SAME_CELL: 3,
    MAX_SHUFFLE_ATTEMPTS: 1000,
    MAX_PLACE_ATTEMPTS: 1000,
    DOT_SEED_BASE: 700000,
    DOT_SEED_STRIDE: 7919,
    DEFAULT_SEED: 12345,              // golden fixture seed; real runs: SEED_BASE + participant number
    SEED_BASE: 100000,
    PRACTICE_N: 6,                    // 0 disables the practice block (DECISION 15)
    PRACTICE_SEED_OFFSET: 999,

    /* ------------------------------------------------------ dots (DECISION 16-18) */
    APERTURE_RADIUS_DEG: 5.0,
    FIX_CLEAR_RADIUS_DEG: 0.75,       // dots are not drawn inside this radius
    N_DOTS_PER_ARRAY: 100,
    DOT_DIAM_DEG: 0.3,
    /* dot speeds: DOT_SPEED_DEG_S_DEFAULT / BURST_SPEED_DEG_S_DEFAULT above */
    DIR_NAMES: ['none', 'up', 'right', 'down', 'left'],
    DIR_ANGLE_DEG: [null, 90, 0, 270, 180],   // maths convention; y is flipped at draw time

    /* ------------------------------------------------------ colour (DECISION 19-20)
     * Nominally equiluminant on an sRGB display: linear luminance of
     * [158 0 0] = 0.0727, of [0 0 255] = 0.0722. Calibrate per participant
     * with flicker photometry before EEG -- see open questions. */
    COLORS: { red: [158, 0, 0], blue: [0, 0, 255] },
    COLOR_MAPS: [
      { A: 'red',  B: 'blue' },       // map 0: the advisor's assignment
      { A: 'blue', B: 'red' }         // map 1: swapped; participant number mod 2
    ],

    /* ------------------------------------------------------ fixation + cue (DECISION 21) */
    FIX_COLOR: [190, 190, 190],
    FIX_OUTER_DEG: 0.6,               // diameter
    FIX_INNER_DEG: 0.2,               // diameter
    CUE_INNER_RADIUS_DEG: 0.7,        // radii (FIX_* sizes above are diameters)
    CUE_OUTER_RADIUS_DEG: 1.1,
    CUE_N_SEGMENTS: 8,                // attend-both ring: 8 alternating segments

    /* ------------------------------------------------------ sound (DECISION 22-23) */
    PIP_FREQ_HZ: 1000,
    PIP_DUR_S: 0.025,
    PIP_RAMP_S: 0.005,                // raised-cosine on and off
    PIP_AMPLITUDE: 0.1,               // digital; ~ -20 dBFS. Calibrate SPL.
    PIP_OFFSET_S: 0.0,                // pip onset relative to pulse onset
    PREVIEW_SOUND_DEFAULT: false,     // setup toggle (DECISION 30): in sound trials, start the pip
                                      //   train at cue onset, i.e. across cue + gap (1.5 s)
    WEB_DISPLAY_LAG_FRAMES: 1,        // web only: rAF timestamp -> photons estimate

    /* ------------------------------------------------------ keys */
    KEY_RESPOND: 'Space',
    KEY_QUIT: 'Escape',
    KEY_CONTINUE: 'Space'
  };

  /* ------------------------------------------------------------------ derived */
  CONFIG.nTrials = function () {
    var n = 0;
    for (var i = 0; i < CONFIG.CELLS.length; i++) { n += CONFIG.CELLS[i].n; }
    return n;
  };

  CONFIG.cellByCode = function (code) {
    for (var i = 0; i < CONFIG.CELLS.length; i++) {
      if (CONFIG.CELLS[i].code === code) { return CONFIG.CELLS[i]; }
    }
    return null;
  };

  /* visual degrees -> pixels, same formula as the parent repo's angle2pix */
  CONFIG.angle2pix = function (deg, pixelSizeCm, distCm) {
    return 2 * distCm * Math.tan(deg * Math.PI / 360) / pixelSizeCm;
  };

  root.XMConfig = CONFIG;
  if (typeof module !== 'undefined' && module.exports) { module.exports = CONFIG; }

})(typeof window !== 'undefined' ? window : globalThis);
