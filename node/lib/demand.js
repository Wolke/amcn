// Own-quota and demand model — the unattended trigger for UC-01 (W8).
//
// UC-01 step 1 is "Requester Agent 偵測主要模型額度已耗盡": the loop starts
// because the agent noticed its own quota ran out, not because a timetable
// fired or an Owner asked. §6.2 puts "逐筆找任務" on the list of things
// normal trading must not require a human for, and §20-8 wants publish, bid,
// select, execute and settle to happen inside Owner Policy with no per-item
// operation. Until now node/agent.js only published from a scripted
// `posts: [{atMs, ...}]` array, which is a script wearing a policy's clothes.
//
// Quota is denominated in the same compute units as tasks and prices, so a
// shortfall converts directly into a task size.
'use strict';

// Deterministic PRNG so an unattended run is reproducible: the demo asserts
// on the loop happening, and a flaky trigger would make that assertion lie.
// mulberry32.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// policy.quota: { capacityUnits, cycleMs } — the Owner's own model quota and
// how often the provider resets it. Unused quota expires at reset, which is
// what makes UC-03's expiry discount meaningful later.
function newQuota(policy, now = Date.now()) {
  const q = (policy && policy.quota) || {};
  const capacity = q.capacityUnits != null ? q.capacityUnits : 60;
  const cycleMs = q.cycleMs != null ? q.cycleMs : 8000;
  // Staggering reset phases is load-bearing, not cosmetic: with capacity
  // close to demand, the market only clears because somebody has just reset
  // (surplus to sell) while somebody else is near empty (a shortfall to buy).
  // Aligned cycles make every agent deficient at the same moment and nothing
  // trades. The simulator staggers the same way via cycle_offset_days.
  const offsetMs = q.cycleOffsetMs != null ? q.cycleOffsetMs : 0;
  return {
    capacity, cycleMs, offsetMs,
    remaining: capacity,
    resetAt: now + cycleMs - (offsetMs % cycleMs),
    cycles: 0,
    consumedUnits: 0,
    expiredUnits: 0,
    shortfallUnits: 0,
    exhaustions: 0,
  };
}

// Returns units that expired, or null when no reset was due.
function maybeReset(quota, now = Date.now()) {
  if (now < quota.resetAt) return null;
  const expired = quota.remaining;
  quota.expiredUnits += expired;
  quota.remaining = quota.capacity;
  quota.resetAt = now + quota.cycleMs;
  quota.cycles += 1;
  return expired;
}

// policy.demand: { meanUnits, burstProb, burstMultiplier } drawn per tick.
function drawDemand(rng, policy) {
  const d = (policy && policy.demand) || {};
  const mean = d.meanUnits != null ? d.meanUnits : 10;
  const burstProb = d.burstProb != null ? d.burstProb : 0.15;
  const mult = d.burstMultiplier != null ? d.burstMultiplier : 3;
  // Spread around the mean so exhaustion timing is not a fixed cadence.
  const base = mean * (0.6 + 0.8 * rng());
  const units = rng() < burstProb ? base * mult : base;
  return +units.toFixed(3);
}

// Split a demand draw into what own quota covers and what must be bought.
// The shortfall is UC-01's trigger.
function consume(quota, units) {
  const local = Math.min(quota.remaining, units);
  const shortfall = +(units - local).toFixed(3);
  quota.remaining = +(quota.remaining - local).toFixed(3);
  quota.consumedUnits = +(quota.consumedUnits + local).toFixed(3);
  if (shortfall > 0) {
    quota.shortfallUnits = +(quota.shortfallUnits + shortfall).toFixed(3);
    quota.exhaustions += 1;
  }
  return { local, shortfall };
}

// UC-01 steps 2-3: the shortfall becomes a task only within the Owner's
// budget and only if the credit line can carry it. Returns the task shape or
// a reason it was withheld, so the console can explain an idle agent.
function planPurchase(shortfall, { balance, creditLine, policy }) {
  const budget = (policy && policy.budget) || {};
  const maxPricePerUnit = budget.maxPricePerUnit != null
    ? budget.maxPricePerUnit : 1.3;
  const minUnits = budget.minUnits != null ? budget.minUnits : 1;
  // A burst can produce a shortfall larger than any single provider's spare
  // quota, and the protocol has no partial fill, so cap one task's size and
  // let the next tick buy the rest.
  const maxUnits = budget.maxUnitsPerTask != null
    ? budget.maxUnitsPerTask : Infinity;
  if (shortfall < minUnits) {
    return { withheld: `shortfall ${shortfall}u below minUnits ${minUnits}` };
  }
  const wanted = Math.min(shortfall, maxUnits);
  const maxPriceCC = +(wanted * maxPricePerUnit).toFixed(4);
  // Spendable credit, not the whole line: a negative balance already used it.
  const spendable = +(creditLine + balance).toFixed(4);
  if (maxPriceCC > spendable) {
    const affordable = Math.floor(spendable / maxPricePerUnit);
    if (affordable < minUnits) {
      return { withheld: `credit line exhausted (spendable ${spendable} CC)` };
    }
    return {
      units: affordable,
      maxPriceCC: +(affordable * maxPricePerUnit).toFixed(4),
      trimmed: true,
    };
  }
  return { units: wanted, maxPriceCC, trimmed: wanted < shortfall };
}

module.exports = {
  makeRng, seedFrom, newQuota, maybeReset, drawDemand, consume, planPurchase,
};
