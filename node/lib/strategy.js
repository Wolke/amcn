// Target balance band + repayment scheduler (FR-055, UC-02) — W7.
//
// proposal-B §8.4, carried into final-architecture §5 W7: every node's policy
// holds `target_band: [low, high]`, default [-0.3 * CL, +100]. Below low the
// node switches to repayment priority — it discounts its own supply so it wins
// work, and pauses non-essential consumption; above high it stops discounting
// and lets consumption run. UC-02 step 4: income lowers the negative balance
// "until it is back inside the target band", so the band, not zero, is the
// target.
//
// §20-10 needs 平均還債時間, so an episode below the band is timed from the
// settlement that pushed the node under to the one that brings it back.
'use strict';

const DEFAULT_HIGH_CC = 100;
const LOW_CL_FRACTION = -0.3;
const REPAY_DISCOUNT = 0.10;

// Band from policy, falling back to the §8.4 defaults. low is derived from the
// live credit line, so it moves as the line does.
function bandFor(cfg, creditLine) {
  const t = (cfg.policy && cfg.policy.target_band) || [];
  const low = t[0] != null ? t[0] : +(LOW_CL_FRACTION * creditLine).toFixed(4);
  const high = t[1] != null ? t[1] : DEFAULT_HIGH_CC;
  return { low, high };
}

function modeFor(balance, { low, high }) {
  if (balance < low) return 'repay';
  if (balance > high) return 'spend';
  return 'normal';
}

// Only repayment discounts. §8.4 also allows "降價出清" above the band, but
// that competes with the node's own consumption priority there, so the
// prototype leaves spend-mode pricing alone rather than guessing.
function priceFor(basePricePerUnit, mode) {
  return mode === 'repay'
    ? +(basePricePerUnit * (1 - REPAY_DISCOUNT)).toFixed(6)
    : basePricePerUnit;
}

// Non-essential consumption pauses while repaying. Posts are essential unless
// the Owner marks them otherwise, so existing configs keep their behaviour.
function mayPost(post, mode) {
  return mode !== 'repay' || post.essential !== false;
}

function newTracker() {
  return { since: null, episodes: [] };
}

// Call on every mode transition. Returns the closed episode's duration in ms,
// or null when nothing closed.
function trackTransition(tracker, mode, now = Date.now()) {
  if (mode === 'repay') {
    if (tracker.since === null) tracker.since = now;
    return null;
  }
  if (tracker.since === null) return null;
  const elapsed = now - tracker.since;
  tracker.since = null;
  tracker.episodes.push(elapsed);
  return elapsed;
}

function avgRepaymentMs(tracker) {
  if (!tracker.episodes.length) return null;
  const total = tracker.episodes.reduce((a, b) => a + b, 0);
  return Math.round(total / tracker.episodes.length);
}

module.exports = {
  DEFAULT_HIGH_CC, LOW_CL_FRACTION, REPAY_DISCOUNT,
  bandFor, modeFor, priceFor, mayPost,
  newTracker, trackTransition, avgRepaymentMs,
};
