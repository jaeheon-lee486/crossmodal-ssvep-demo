/* ===========================================================================
 * data.js -- recording and export. Three long-format tables plus a session
 * JSON, with the SAME column names as the MATLAB export
 * (+cmcore/dataColumns.m). Schema documented in DESIGN_LOG.md section 9.
 *
 *   trials.csv : one row per trial (condition, scoring summary, timing QC)
 *   events.csv : one row per pulse, pip, and key press (all timestamps)
 *   frames.csv : one row per stimulus frame (flicker state, pulse, flip time)
 *   session.json : config snapshot, frequency plan, display measurement
 *
 * trials + events are autosaved to localStorage after every trial; frames are
 * too large for localStorage (~216k rows) and live in memory until download.
 * =========================================================================== */
(function (root) {
  'use strict';

  var TRIAL_COLUMNS = [
    'pid', 'participant', 'platform', 'practice', 'seed', 'color_map', 'color_A', 'color_B',
    'freq_plan', 'refresh_nominal_hz', 'refresh_measured_hz',
    'coh_bg_pct', 'coh_tgt_pct', 'duty_pct', 'win_frames_A', 'win_frames_B',
    'speed_deg_s', 'burst_speed_deg_s', 'lum_dip_pct', 'tilt_deg', 'reset_motion',
    'view_dist_cm', 'screen_width_cm', 'burst_pct', 'n_one_blocks', 'sound_on_pct',
    'trial', 'block', 'block_type', 'trial_in_block', 'cell', 'cond', 'attend', 'cue', 'sound_match',
    'dir_A', 'dir_B', 'dir_A_name', 'dir_B_name',
    'n_tgt', 'n_tgt_A', 'n_tgt_B', 'tgt_A_pulses', 'tgt_B_pulses', 'tgt_A_onset_s', 'tgt_B_onset_s',
    'tgt_A_tilt_sign', 'tgt_B_tilt_sign',
    'n_responses', 'n_hits', 'n_misses', 'n_fa', 'n_fa_unattended', 'n_extra', 'n_ambiguous',
    'hits_A', 'misses_A', 'hits_B', 'misses_B', 'mean_rt_s',
    'flicker_hz_A', 'flicker_hz_B', 'pulse_hz_A', 'pulse_hz_B',
    'n_frames', 'n_dropped', 'max_frame_interval_ms',
    't_cue_onset', 't_stim_onset', 't_stim_offset',
    'n_pips', 'audio_start_sched', 'av_offset_est_s',
    'iti_s', 'place_attempts', 'dot_seed', 'aborted'
  ];

  var EVENT_COLUMNS = [
    'pid', 'practice', 'trial', 'event', 'array', 'index', 'is_target', 'target_pulse',
    'frame', 't_sched_s', 't_actual_s', 't_peak_s', 'rt_s', 'outcome'
  ];

  var FRAME_COLUMNS = [
    'pid', 'practice', 'trial', 'frame', 't_flip_s', 'on_A', 'on_B', 'pulse_A', 'pulse_B', 'tgt_A', 'tgt_B'
  ];

  /* setup.csv: one row per setup value (DECISION 39) */
  var SETUP_COLUMNS = ['field', 'value', 'default', 'source'];

  function fmt(v) {
    if (v === null || v === undefined) { return ''; }
    if (typeof v === 'number') {
      if (isNaN(v)) { return 'NaN'; }
      return Number.isInteger(v) ? String(v) : v.toFixed(6);
    }
    if (Array.isArray(v)) { return v.map(function (e) { return typeof e === 'number' && !Number.isInteger(e) ? e.toFixed(6) : String(e); }).join(';'); }
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function rowsToCsv(cols, rows) {
    var out = [cols.join(',')];
    for (var i = 0; i < rows.length; i++) {
      var r = [];
      for (var c = 0; c < cols.length; c++) { r.push(fmt(rows[i][cols[c]])); }
      out.push(r.join(','));
    }
    return out.join('\n') + '\n';
  }

  function Recorder(meta) {
    this.meta = meta;
    this.trials = [];
    this.events = [];
    this.frameBlocks = [];             // per trial: {pid, practice, trial, t, onA, onB, pA, pB, tA, tB}
    this.key = 'xm_autosave_' + meta.pid + '_' + meta.startedAt;
  }

  Recorder.prototype.addTrial = function (row, events, frames) {
    this.trials.push(row);
    for (var i = 0; i < events.length; i++) { this.events.push(events[i]); }
    if (frames) { this.frameBlocks.push(frames); }
    this.autosave();
  };

  Recorder.prototype.autosave = function () {
    try {
      localStorage.setItem(this.key, JSON.stringify({ meta: this.meta, trials: this.trials, events: this.events }));
    } catch (e) { /* storage full or blocked: in-memory copy still downloads */ }
  };

  Recorder.prototype.framesCsv = function () {
    var out = [FRAME_COLUMNS.join(',')];
    for (var b = 0; b < this.frameBlocks.length; b++) {
      var F = this.frameBlocks[b];
      for (var f = 0; f < F.t.length; f++) {
        out.push([F.pid, F.practice, F.trial, f, isNaN(F.t[f]) ? 'NaN' : F.t[f].toFixed(6),
                  F.onA[f], F.onB[f], F.pA[f], F.pB[f], F.tA[f], F.tB[f]].join(','));
      }
    }
    return out.join('\n') + '\n';
  };

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  Recorder.prototype.downloadAll = function () {
    var base = 'xm_' + this.meta.pid + '_' + this.meta.startedAt.replace(/[:.]/g, '-');
    download(base + '_trials.csv', rowsToCsv(TRIAL_COLUMNS, this.trials));
    download(base + '_events.csv', rowsToCsv(EVENT_COLUMNS, this.events));
    download(base + '_frames.csv', this.framesCsv());
    download(base + '_setup.csv', rowsToCsv(SETUP_COLUMNS, this.meta.setup || []));
    download(base + '_session.json', JSON.stringify(this.meta, null, 2), 'application/json');
  };

  root.XMData = {
    TRIAL_COLUMNS: TRIAL_COLUMNS,
    EVENT_COLUMNS: EVENT_COLUMNS,
    FRAME_COLUMNS: FRAME_COLUMNS,
    SETUP_COLUMNS: SETUP_COLUMNS,
    rowsToCsv: rowsToCsv,
    Recorder: Recorder
  };

})(typeof window !== 'undefined' ? window : globalThis);
