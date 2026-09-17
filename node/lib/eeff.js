// Hub-side dynamic credit line — mirrors sim/amcn_sim/agents.py
// effective_contribution + credit_limit (GATE-0 round 2, findings F-1/F-4).
// Parameters per the sweep recommendation: starter 50 CC, risk fee 6%/2%.
//
// The age ramp is real now (E5): the hub passes a factor derived from when
// the DID first registered. Harnesses compress the ramp so a demo still runs
// in seconds — see HUB_AGE_RAMP_MS.
'use strict';

const STARTER_CC = Number(process.env.DEMO_STARTER_CC || 50);
const HARD_CAP_CC = 500;
const FEE_RATE = 0.025;
const RISK_THIN = 0.06;
const RISK_BASE = 0.02;
// Verifier compensation, as a share of the contract price, split equally
// across the selected panel (§4 #5: 驗證費在旗艦分錄中憑空消失). Taken out of
// the provider's gross, not added on top: the requester's posting must equal
// the price it pre-authorised, or forced settlement's pre_auth check breaks.
// 4% is the midpoint of proposal-C's 3–6% and is NOT simulation-backed — the
// simulator has no verifier agents, so this rate has no GATE-0 evidence yet.
const VERIFIER_RATE = 0.04;

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

// ageFactor ∈ [0,1] ramps the bootstrap line, exactly as the simulator does
// (`credit_limit` in sim/amcn_sim/agents.py): a brand-new account gets half
// the starter, reaching the full amount as the account ages. The prototype
// used to fix this at 1, which the cross-language comparison (E5) showed was
// the *entire* divergence between the two implementations — a constant 25 CC
// on every step, i.e. day-zero credit at twice the intended bootstrap.
//
// It also settles what §2.2's "L_boot 上限 25 CC" meant: not a stale value
// contradicting GATE-0's starter of 50, but the effective line at t=0 with
// that starter. Both numbers were right; #1 conflated them, and so did my
// ruling on it.
function creditLine(myDid, myStats, statsOf, ageFactor = 1) {
  const contribution = Math.min(
    effectiveContribution(myDid, myStats, statsOf), 2000);
  const diversity = Math.min(1, myStats.earnedBy.size / 8);
  const done = myStats.completed + myStats.failed;
  const completionRate = done ? myStats.completed / done : 0.9; // prior
  const quality = 0.25 + 0.75 * completionRate;
  const age = Math.max(0, Math.min(1, ageFactor));
  const line = (STARTER_CC * (0.5 + 0.5 * age)
    + 0.35 * contribution * (0.3 + 0.7 * diversity)) * quality;
  return Math.min(HARD_CAP_CC, Math.max(0, line));
}

function riskRate(myStats) {
  const thin = myStats.earnedBy.size + myStats.paidTo.size < 5 ||
    myStats.completed < 3;
  return thin ? RISK_THIN : RISK_BASE;
}

module.exports = {
  STARTER_CC, FEE_RATE, RISK_THIN, RISK_BASE, VERIFIER_RATE,
  newStats, effectiveContribution, creditLine, riskRate,
};
