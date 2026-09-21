"""Task market: posting, bidding, matching, execution, settlement.

Simplifications vs the real protocol (documented, per SDD §19 Phase 0):
- Matching is a per-tick batch auction instead of async P2P bidding.
- Verification collapses to a Bernoulli draw on provider quality;
  a failed verification means no settlement and counts as a dispute.
- One task = one provider (no partial fills; requesters split big
  demand into unit-sized tasks before posting).
"""

from __future__ import annotations

import hashlib
import random
from dataclasses import dataclass, field

from .agents import Agent, Verifier, credit_limit
from .ledger import Ledger

REF_PRICE = 1.0          # CC per unit: public reference cost (SDD §14.2)
FEE_RATE = 0.025         # base protocol fee → treasury (FR-057)
# Requester-side risk fee → insurance pool (Phase 0 finding F-2): thin/young
# identities pay more. Rates live on Market (risk_thin/risk_base) so sweeps
# can vary them; defaults 3% / 1%.
TASK_TTL_TICKS = 24      # unmatched tasks expire after 24h (EXPIRED)
MAX_TASK_UNITS = 4.0     # requesters chunk demand into ≤4-unit tasks


@dataclass
class Task:
    task_id: str
    requester: str
    units: float
    max_price_cc: float   # total budget for this task
    posted_tick: int
    is_wash: bool = False
    matched_tick: int | None = None
    settled: bool = False


@dataclass
class Offer:
    provider: str
    units_available: float
    ask_per_unit: float


@dataclass
class MarketStats:
    posted: int = 0
    matched: int = 0
    expired: int = 0
    failed_verification: int = 0
    settled_cc: float = 0.0
    wash_settled_cc: float = 0.0
    wait_ticks: list[int] = field(default_factory=list)
    prices_per_unit: list[tuple[int, float]] = field(default_factory=list)
    unmet_demand_units: float = 0.0


class Market:
    def __init__(self, ledger: Ledger, rng: random.Random,
                 risk_thin: float = 0.03, risk_base: float = 0.01,
                 starter_cc: float = 20.0,
                 repay_discount: float = 0.35,
                 band_low_cl_frac: float | None = -0.15,
                 verifiers: list[Verifier] | None = None,
                 verifier_rate: float = 0.04,
                 canary_rate: float = 0.03,
                 slash_frac: float = 0.10,
                 slash_threshold: float = 0.25,
                 slash_min_samples: int = 5,
                 slash_min_failures: int = 3,
                 trace: str | None = None) -> None:
        self.ledger = ledger
        self.rng = rng
        self.open_tasks: list[Task] = []
        self.stats = MarketStats()
        self._task_seq = 0
        self.risk_thin = risk_thin
        self.risk_base = risk_base
        self.starter_cc = starter_cc
        # UC-02 repayment priority. The 0.35 default is what this simulator has
        # always used; proposal-B §8.4 says 10% and the node prototype shipped
        # 10%, so the two disagree — amcn_sim.sweep_repay exists to settle it
        # from the economics rather than from whichever document was read last.
        self.repay_discount = repay_discount
        # The band's low bound as a fraction of the live credit line,
        # recomputed per tick. -0.15 is the amcn_sim.sweep_repay result;
        # §8.4's -0.30 fails GATE-0 G4 under high_default at every discount
        # (median debt cycle 33-40d). Set None to fall back to the agent's
        # fixed target_balance_low.
        self.band_low_cl_frac = band_low_cl_frac
        # Verification market (§4 #25). An empty pool means every task settles
        # on the deterministic path alone, which is what this simulator did
        # before and what the `--no-verifiers` control run reproduces.
        self.verifiers: list[Verifier] = verifiers or []
        self.verifier_rate = verifier_rate
        self.canary_rate = canary_rate
        self.slash_frac = slash_frac
        # §4 #27: slashing on every canary failure taxes ordinary competence
        # error — with competence 0.94-0.995 a wrong PASS on known-bad work is
        # a certainty over enough samples, and a zero-cheater population still
        # lost 4.6% of verifier income. A lazy verifier fails 50-100% of the
        # canaries it sees while an honest one fails under ~6%, so a rate
        # threshold over a minimum sample separates them cleanly and a single
        # unlucky verdict costs nothing.
        self.slash_threshold = slash_threshold
        self.slash_min_samples = slash_min_samples
        # §4 #30: a rate threshold on a small denominator is not evidence. At
        # pool 90 each verifier saw only ~6 canaries, where 2 unlucky misses
        # is already 33% — and honest nodes started losing stake again (25.85
        # CC), re-opening #27 at scale. Requiring an absolute count as well
        # means a single run of bad luck cannot cross the bar, while a lazy
        # verifier failing half its canaries reaches 3 quickly.
        self.slash_min_failures = slash_min_failures
        self.honest_error_forgiven = 0
        self.canary_seq = 0
        self.canary_caught = 0
        self.canary_missed = 0
        self.canary_spend_cc = 0.0
        self.verifier_fees_cc = 0.0
        self.slashed_cc = 0.0
        self.trace = trace              # agent id whose diary we record
        self.trace_log: list[str] = []

    # --- verification market -------------------------------------------
    def panel_for(self, contract_id: str, seed: str, size: int = 3,
                  exclude: tuple[str, ...] = ()) -> list[Verifier]:
        """Same rule as node/lib/panel.js: sort the pool by
        sha256(seed + contract_id + id) and take the first `size`. The seed is
        a future checkpoint root in the protocol (§4 #6); here it stands in as
        an opaque per-contract value the requester does not choose."""
        # 當事人不得驗自己的合約。獨立 verifier 人口下這不可能發生（角色互斥），
        # 但雙角色下 pool 就是交易者本身——原型的 #62 階段 1 正是補這一條。
        live = [v for v in self.verifiers if v.online and v.vid not in exclude]
        if len(live) < size:
            return []
        keyed = sorted(live, key=lambda v: hashlib.sha256(
            (seed + contract_id + v.vid).encode()).hexdigest())
        return keyed[:size]

    def _verdicts(self, panel: list[Verifier], truth: bool,
                  expected_majority: bool) -> list[bool]:
        """A lazy verifier votes the expected majority without checking; an
        honest one checks and is right with probability `competence`."""
        out = []
        for v in panel:
            if self.rng.random() < v.lazy_prob:
                out.append(expected_majority)
            else:
                out.append(truth if self.rng.random() < v.competence
                           else not truth)
        return out

    def _pay_panel(self, panel: list[Verifier], price: float
                   ) -> list[tuple[str, float]]:
        if not panel:
            return []
        total = price * self.verifier_rate
        each = total / len(panel)
        for v in panel:
            v.earned_cc += each
            v.assignments += 1
        self.verifier_fees_cc += total
        return [(v.vid, each) for v in panel]

    def _risk_rate(self, a: Agent, tick: int) -> float:
        young = a.age_days(tick) < 30.0
        thin = len(a.counterparties) < 5
        return self.risk_thin if (young or thin) else self.risk_base

    def _tr(self, tick: int, msg: str) -> None:
        d, h = divmod(tick, 24)
        self.trace_log.append(f"D{d:02d} {h:02d}:00  {msg}")

    # --- demand side ----------------------------------------------------
    def post_shortfall(self, a: Agent, units: float, tick: int,
                       peers: dict[str, Agent] | None = None) -> None:
        """Agent's own quota ran out mid-work: borrow from the network
        within its credit line (UC-01, P-05)."""
        available_credit = (credit_limit(a, tick, peers, self.starter_cc)
                            + self.ledger.balance(a.aid))
        if a.aid == self.trace:
            self._tr(tick, f"額度耗盡，缺口 {units:.1f} units；"
                           f"可用信用 {available_credit:.1f} CC → 發布任務借用 (UC-01)")
        while units > 1e-6 and available_credit > 0.5:
            chunk = min(units, MAX_TASK_UNITS)
            budget = min(chunk * REF_PRICE * a.max_price_factor, available_credit)
            if budget < chunk * REF_PRICE * 0.5:
                break  # not enough credit left for a sane bid
            self._task_seq += 1
            self.open_tasks.append(Task(
                task_id=f"t{self._task_seq:08d}", requester=a.aid,
                units=chunk, max_price_cc=budget, posted_tick=tick))
            self.stats.posted += 1
            available_credit -= budget
            units -= chunk
        if units > 1e-6:
            self.stats.unmet_demand_units += units  # credit-constrained
            if a.aid == self.trace:
                self._tr(tick, f"信用不足：{units:.1f} units 需求發不出去")

    def post_wash_task(self, a: Agent, tick: int) -> None:
        """Colluding pair inflating volume (SDD §16 threat 7)."""
        self._task_seq += 1
        self.open_tasks.append(Task(
            task_id=f"w{self._task_seq:08d}", requester=a.aid,
            units=2.0, max_price_cc=2.0 * REF_PRICE * 1.5,
            posted_tick=tick, is_wash=True))
        self.stats.posted += 1

    # --- supply side ----------------------------------------------------
    def band_low(self, a: Agent, tick: int,
                 peers: dict[str, Agent] | None = None) -> float:
        if self.band_low_cl_frac is None:
            return a.target_balance_low
        return self.band_low_cl_frac * credit_limit(
            a, tick, peers, self.starter_cc)

    def collect_offers(self, agents: dict[str, Agent], tick: int) -> list[Offer]:
        offers = []
        for a in agents.values():
            if not a.online or a.remaining_quota < 1.0:
                continue
            bal = self.ledger.balance(a.aid)
            surplus = a.projected_surplus(tick)
            repaying = bal < self.band_low(a, tick, agents)  # UC-02
            if surplus < 1.0 and not repaying:
                continue
            if bal >= a.target_balance_high and not repaying:
                continue  # enough CC hoarded; stop supplying (SDD §14.4)
            # UC-03: discount grows as expiry nears and waste risk rises
            waste_risk = min(1.0, max(0.0, surplus / max(a.quota_capacity, 1.0)))
            expiry_urgency = max(0.0, 1.0 - a.days_to_expiry(tick) / a.cycle_days)
            discount = 0.45 * waste_risk * expiry_urgency
            if repaying:
                discount = max(discount, self.repay_discount)
            ask = max(REF_PRICE * (1 + a.min_margin) * (1 - discount),
                      REF_PRICE * 0.4)
            units = min(a.max_supply_per_tick,
                        a.remaining_quota - (0 if repaying else a.mean_daily_demand / 24))
            if units >= 1.0:
                offers.append(Offer(a.aid, units, ask))
        return offers

    def inject_canary(self, agents: dict[str, Agent], tick: int) -> None:
        """Treasury posts a decoy with a known answer (proposal-C §7, 2-5% of
        volume). A verifier that votes wrong on it is not merely unlucky —
        the answer was known — so it is slashed. This is what gives a lazy
        verifier a cost, and therefore what makes the fee rate priceable at
        all (§4 #8's deterrence claim rests on it).
        """
        if not self.verifiers:
            return
        # §4 #29: proposal-C §7 specifies canaries as 2-5% *of network volume*,
        # but this was a per-tick injection probability, which delivered
        # 0.5-1.3% instead — the configured number did not mean what the
        # proposal said. Now it is a target share and injection tracks it, so
        # `canary_rate=0.03` really is 3% of settled volume.
        real_volume = self.stats.settled_cc
        if real_volume <= 0:
            return  # nothing to sample yet
        share = self.canary_spend_cc / real_volume
        if share >= self.canary_rate:
            return
        # Jitter so the decoys do not land on a predictable cadence a
        # colluding verifier could learn.
        if self.rng.random() < 0.5:
            return
        candidates = [a for a in agents.values()
                      if a.online and a.remaining_quota >= 2.0]
        if not candidates:
            return
        provider = self.rng.choice(candidates)
        self.canary_seq += 1
        cid = f"canary{self.canary_seq:06d}"
        units = 2.0
        price = units * REF_PRICE
        panel = self.panel_for(cid, f"cp{tick // 4}",
                               exclude=(provider.aid,))
        if not panel:
            return
        # The decoy is planted as bad work, so the correct verdict is FAIL.
        # A lazy verifier voting the expected majority (PASS) is caught.
        verdicts = self._verdicts(panel, truth=False, expected_majority=True)
        provider.remaining_quota -= units
        payouts = self._pay_panel(panel, price)
        self.ledger.canary_spend(tick, cid, provider.aid, price,
                                 verifier_payouts=payouts)
        self.canary_spend_cc += price
        for v, verdict in zip(panel, verdicts):
            v.canary_seen += 1
            if verdict:  # voted PASS on known-bad work
                v.canary_failed += 1
                self.canary_caught += 1
                rate = v.canary_failed / v.canary_seen
                if (v.canary_seen < self.slash_min_samples
                        or v.canary_failed < self.slash_min_failures
                        or rate < self.slash_threshold):
                    # Below the evidence bar: recorded, not punished.
                    self.honest_error_forgiven += 1
                    continue
                amount = min(v.stake_cc * self.slash_frac,
                             max(self.ledger.balance(v.vid), 0.0))
                if amount > 0:
                    self.ledger.slash(tick, cid, v.vid, amount)
                    v.slashed_cc += amount
                    self.slashed_cc += amount
            else:
                self.canary_missed += 1

    # --- matching + execution -------------------------------------------
    def clear(self, agents: dict[str, Agent], tick: int) -> None:
        self.inject_canary(agents, tick)
        offers = self.collect_offers(agents, tick)
        offers.sort(key=lambda o: o.ask_per_unit)
        by_provider = {o.provider: o for o in offers}
        still_open: list[Task] = []
        self.open_tasks.sort(key=lambda t: t.posted_tick)

        for task in self.open_tasks:
            requester = agents[task.requester]
            if not requester.online:
                self.stats.expired += 1
                continue
            if task.is_wash:
                # wash pair always "matches" itself if partner has quota
                partner = agents.get(requester.wash_partner or "")
                if partner and partner.online and partner.remaining_quota >= task.units:
                    self._execute(task, requester, partner,
                                  task.units * REF_PRICE, tick, agents)
                continue
            chosen: Offer | None = None
            for o in offers:
                if o.units_available >= task.units and \
                        o.ask_per_unit * task.units <= task.max_price_cc and \
                        o.provider != task.requester:
                    chosen = o
                    break
            if chosen is None:
                if tick - task.posted_tick >= TASK_TTL_TICKS:
                    self.stats.expired += 1
                    self.stats.unmet_demand_units += task.units
                else:
                    still_open.append(task)
                continue
            chosen.units_available -= task.units
            price = chosen.ask_per_unit * task.units
            self._execute(task, requester, agents[chosen.provider], price,
                          tick, agents)
        self.open_tasks = [t for t in still_open]
        # drop fully-consumed offers for cleanliness (list rebuilt next tick)
        _ = by_provider

    def _execute(self, task: Task, requester: Agent, provider: Agent,
                 price: float, tick: int, agents: dict[str, Agent]) -> None:
        task.matched_tick = tick
        self.stats.matched += 1
        self.stats.wait_ticks.append(tick - task.posted_tick)
        provider.remaining_quota -= task.units
        truth = (self.rng.random() < provider.reliability and
                 self.rng.random() < provider.quality)
        # The panel decides what the network acts on, which is not always the
        # truth — that gap is the whole point of pricing verification.
        panel = self.panel_for(task.task_id, f"cp{tick // 4}",
                               exclude=(requester.aid, provider.aid))
        if panel:
            verdicts = self._verdicts(panel, truth, expected_majority=True)
            ok = sum(verdicts) >= 2
        else:
            ok = truth
        if not ok:
            # verification failed: no settlement (FR-051), dispute recorded
            provider.tasks_failed += 1
            provider.disputes += 1
            self.stats.failed_verification += 1
            # requester reposts once immediately (best-effort retry)
            self.post_shortfall(requester, task.units, tick, agents)
            return
        fee = price * FEE_RATE
        risk = price * self._risk_rate(requester, tick)
        payouts = self._pay_panel(panel, price)
        self.ledger.settle(tick, task.task_id, requester.aid, provider.aid,
                           price, fee, risk, verifier_payouts=payouts)
        provider.tasks_completed += 1
        provider.earned_cc += price - fee - risk
        requester.spent_cc += price
        provider.counterparties.add(requester.aid)
        requester.counterparties.add(provider.aid)
        provider.counterparty_volume[requester.aid] = \
            provider.counterparty_volume.get(requester.aid, 0.0) + (price - fee - risk)
        requester.paid_volume[provider.aid] = \
            requester.paid_volume.get(provider.aid, 0.0) + price
        self.stats.settled_cc += price
        if task.is_wash:
            self.stats.wash_settled_cc += price
        self.stats.prices_per_unit.append((tick, price / task.units))
        task.settled = True
        if self.trace in (requester.aid, provider.aid):
            role = "借入" if self.trace == requester.aid else "承接"
            other = provider.aid if role == "借入" else requester.aid
            bal = self.ledger.balance(self.trace)
            self._tr(tick, f"{role} {task.units:.1f} units @ {price/task.units:.2f}"
                           f"，對手 {other}，結算後餘額 {bal:+.1f} CC")
