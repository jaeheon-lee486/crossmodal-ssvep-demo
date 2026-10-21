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
    PARITY_ID: 'XM-PARAM-2026-10-21b',

    /* ------------------------------------------------------ display */
    BG_COLOR: [0, 0, 0],
    VIEW_DIST_CM_DEFAULT: 60,         // setup-form default (DECISION 29)
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
    STIM_TICKS: 270,                  // 4.5 s stimulus epoch (DECISION 32; was 360 = 6.0 s)
    CUE_TICKS: 48,                    // 0.8 s cue (DECISION 32; was 60 = 1.0 s)
    GAP_TICKS: 30,                    // 0.5 s fixation between cue and stimulus (unchanged)
    ITI_MIN_TICKS: 42,                // 0.7 s ... (DECISION 32; was 60 = 1.0 s)
    ITI_JITTER_TICKS: 30,             // ... + 0..0.5 s = 0.7-1.2 s, drawn in the trial list

    /* ------------------------------------------------------ coherence pulses (DECISION 4-6) */
    PULSE_PERIOD_TICKS: { A: 18, B: 15 },   // 0.300 s = 3.333 Hz, 0.250 s = 4.000 Hz
    PULSE_PHASE_TICKS:  { A: 0,  B: 1 },    // B's stream starts 1/60 s after A's
    PULSE_TAIL_TICKS: 6,                    // last pulse starts >= 100 ms before the end (was
                                            //   PULSE_WIN_TICKS; kept so the trial list is unchanged)

    /* ------------------------------------------------------ stimulus settings (DECISIONS 28-29, 33, 38)
     * Defaults for the stimulus values on the setup screen. They change what
     * is drawn, never the trial list. Checked by Design.validateStimParams.
     * A deviant event (target pulse) carries four independent layers, all
     * active at once when set; a layer equal to the background (or 0) is off. */
    COH_BG_PCT_DEFAULT: 70,           // % of an array's dots coherent in a background pulse
    COH_TGT_PCT_DEFAULT: 70,          // % coherent in a DEVIANT pulse (may equal the background)
    DUTY_PCT_DEFAULT: 100,            // coherent window as % of the pulse period
    DOT_SPEED_DEG_S_DEFAULT: 7.0,     // normal speed
    BURST_SPEED_DEG_S_DEFAULT: 7.0,   // coherent dots of a DEVIANT pulse (may equal the normal speed)
    SPEED_MAX_DEG_S: 40,              // validation ceiling for both speeds
    LUM_DIP_PCT_DEFAULT: 40,          // deviant array's luminance drop, % (linear light); 0 = off
    TILT_DEG_DEFAULT: 0,              // deviant pulse direction rotated by +/- this; 0 = off
    TILT_MAX_DEG: 90,
    RESET_MOTION_DEFAULT: true,       // DECISION 33: coherent displacement undone at window end

    /* ------------------------------------------------------ targets + scoring (DECISION 9-11) */
    TGT_MIN_ONSET_TICKS: 60,          // no target before 1.0 s
    TGT_MAX_ONSET_TICKS: 216,         // none after 3.6 s (= 4.5 s - 0.9 s; was 306 = 5.1 s)
    TGT_MIN_GAP_TICKS: 60,            // >= 1.0 s between any two targets
    TGT_MIN_OTHER_SEP_TICKS: 3,       // target pulse >= 50 ms from every other-array pulse
    RESP_WIN_MIN_S: 0.15,
    RESP_WIN_MAX_S: 0.90,

    /* ------------------------------------------------------ trial list (DECISIONS 13-14, 34-35)
     * Keep identical to reference_design.py and +cmcfg/config.m. Block type
     * 'one' = attend-one (red / blue cue, never sound); 'both' = attend-both
     * (neutral cue, sound on SOUND_ON_PCT of trials). The *_DEFAULT values are
     * the setup-screen defaults of the three design settings. */
    N_BLOCKS: 20,
    BLOCK_TRIALS: 20,
    N_ONE_BLOCKS_DEFAULT: 10,         // attend-one blocks; the rest are attend-both
    SOUND_ON_PCT_DEFAULT: 50,         // % of an attend-both block's trials with sound
    BURST_PCT_DEFAULT: [0, 90, 10, 0],   // % of trials with 0, 1, 2, 3 bursts (targets), all in ONE array (DECISION 37)
    MAX_BURSTS: 3,
    CELLS: [
      { code: 1, name: 'attend_A_silent',    attend: 'A',    sound: 'none', blockType: 'one' },
      { code: 2, name: 'attend_B_silent',    attend: 'B',    sound: 'none', blockType: 'one' },
      { code: 3, name: 'attend_both_silent', attend: 'both', sound: 'none', blockType: 'both' },
      { code: 4, name: 'attend_both_soundA', attend: 'both', sound: 'A',    blockType: 'both' },
      { code: 5, name: 'attend_both_soundB', attend: 'both', sound: 'B',    blockType: 'both' }
    ],
    MAX_PLACE_ATTEMPTS: 1000,
    DOT_SEED_BASE: 700000,
    DOT_SEED_STRIDE: 7919,
    DEFAULT_SEED: 12345,              // golden fixture seed; real runs: SEED_BASE + participant number
    SEED_BASE: 100000,
    PRACTICE_N: 6,                    // 0 disables practice; half attend-one, half attend-both (DECISION 15)
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
    WEB_DISPLAY_LAG_FRAMES: 1,        // web only: rAF timestamp -> photons estimate

    /* ------------------------------------------------------ keys */
    KEY_RESPOND: 'Space',
    KEY_QUIT: 'Escape',
    KEY_CONTINUE: 'Space'
  };

  /* ------------------------------------------------------------------ derived */
  CONFIG.nTrials = function () { return CONFIG.N_BLOCKS * CONFIG.BLOCK_TRIALS; };

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
