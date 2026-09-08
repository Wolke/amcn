// Hub-side dynamic credit line — mirrors sim/amcn_sim/agents.py
// effective_contribution + credit_limit (GATE-0 round 2, findings F-1/F-4).
// Parameters per the sweep recommendation: starter 50 CC, risk fee 6%/2%.
//
// Prototype simplification: age factor fixed at 1 (a demo runs for
// seconds, not 30 days); production uses account age like the sim.
'use strict';

const STARTER_CC = Number(process.env.DEMO_STARTER_CC || 50);
const HARD_CAP_CC = 500;
const FEE_RATE = 0.025;
const RISK_THIN = 0.06;
const RISK_BASE = 0.02;

function newStats() {
  return {
    earnedBy: new Map(),  // payer did -> CC earned from them (net)
    paidTo: new Map(),    // provider did -> CC paid to them
    completed: 0,
    failed: 0,
  };
}

// E_eff: payer-concentration weighting, then a 20%-of-OTHERS cap so a
// single pair can never raise its own ceiling (fix for finding F-1).
function effectiveContribution(myDid, myStats, statsOf) {
  if (myStats.earnedBy.size === 0) return 0;
  const weighted = [];
  for (const [payer, v] of myStats.earnedBy) {
    let w = 1.0;
    const ps = statsOf(payer);
    if (ps) {
      const outTotal = [...ps.paidTo.values()].reduce((s, x) => s + x, 0);
      if (outTotal > 0) {
        w = Math.max(0, 1 - (ps.paidTo.get(myDid) || 0) / outTotal);
      }
    }
    weighted.push(v * w);
  }
  const total = weighted.reduce((s, x) => s + x, 0);
  return weighted.reduce((s, v) => s + Math.min(v, 0.20 * (total - v)), 0);
}

function creditLine(myDid, myStats, statsOf) {
  const contribution = Math.min(
    effectiveContribution(myDid, myStats, statsOf), 2000);
  const diversity = Math.min(1, myStats.earnedBy.size / 8);
  const done = myStats.completed + myStats.failed;
  const completionRate = done ? myStats.completed / done : 0.9; // prior
  const quality = 0.25 + 0.75 * completionRate;
  const line = (STARTER_CC + 0.35 * contribution * (0.3 + 0.7 * diversity))
    * quality;
  return Math.min(HARD_CAP_CC, Math.max(0, line));
}

function riskRate(myStats) {
  const thin = myStats.earnedBy.size + myStats.paidTo.size < 5 ||
    myStats.completed < 3;
  return thin ? RISK_THIN : RISK_BASE;
}

module.exports = {
  STARTER_CC, FEE_RATE, RISK_THIN, RISK_BASE,
  newStats, effectiveContribution, creditLine, riskRate,
};
