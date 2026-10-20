/* ===========================================================================
 * rng.js -- seeded PRNG, a direct port of reference/reference_design.py::Minstd
 *
 * Park-Miller MINSTD:  x = 16807 * x  mod (2^31 - 1)
 *
 * 16807 * 2147483646 = 3.6085e13 < 2^53, so the recurrence is EXACT in
 * IEEE-754 doubles and needs no integer wraparound -- which MATLAB cannot
 * express, because its integer types saturate. The same few lines are
 * therefore bit-identical in JavaScript, MATLAB and Python, which is what
 * makes the three trial lists match exactly.
 * =========================================================================== */
(function (root) {
  'use strict';

  function Minstd(seed) {
    var s = Math.floor(seed) % 2147483647;
    if (s <= 0) { s += 2147483646; }
    this._s = s;
  }

  /* uniform in [0, 1) */
  Minstd.prototype.nextFloat = function () {
    this._s = (this._s * 16807) % 2147483647;
    return (this._s - 1) / 2147483646;
  };

  /* n floats, generated in index order 0..n-1 */
  Minstd.prototype.randArray = function (n) {
    var out = new Array(n);
    for (var i = 0; i < n; i++) { out[i] = this.nextFloat(); }
    return out;
  };

  /* uniform integer in 0 .. n-1 */
  Minstd.prototype.randInt = function (n) {
    return Math.floor(this.nextFloat() * n);
  };

  /* Fisher-Yates over 0..n-1, descending. Returns 0-based indices.
   * The MATLAB port walks i = n:-1:2 over 1-based indices with randInt(i)+1,
   * which is the identical swap sequence. */
  Minstd.prototype.shuffleIndices = function (n) {
    var a = new Array(n), i, j, tmp;
    for (i = 0; i < n; i++) { a[i] = i; }
    for (i = n - 1; i > 0; i--) {
      j = this.randInt(i + 1);
      tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  };

  root.XMMinstd = Minstd;
  if (typeof module !== 'undefined' && module.exports) { module.exports = Minstd; }

})(typeof window !== 'undefined' ? window : globalThis);
