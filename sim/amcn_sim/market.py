"""Task market: posting, bidding, matching, execution, settlement.

Simplifications vs the real protocol (documented, per SDD §19 Phase 0):
- Matching is a per-tick batch auction instead of async P2P bidding.
- Verification collapses to a Bernoulli draw on provider quality;
  a failed verification means no settlement and counts as a dispute.
- One task = one provider (no partial fills; requesters split big
  demand into unit-sized tasks before posting).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

from .agents import Agent, credit_limit
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
                 trace: str | None = None) -> None:
        self.ledger = ledger
        self.rng = rng
        self.open_tasks: list[Task] = []
        self.stats = MarketStats()
        self._task_seq = 0
        self.risk_thin = risk_thin
        self.risk_base = risk_base
        self.starter_cc = starter_cc
        self.trace = trace              # agent id whose diary we record
        self.trace_log: list[str] = []

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
    def collect_offers(self, agents: dict[str, Agent], tick: int) -> list[Offer]:
        offers = []
        for a in agents.values():
            if not a.online or a.remaining_quota < 1.0:
                continue
            bal = self.ledger.balance(a.aid)
            surplus = a.projected_surplus(tick)
            repaying = bal < a.target_balance_low  # UC-02: work off debt
            if surplus < 1.0 and not repaying:
                continue
            if bal >= a.target_balance_high and not repaying:
                continue  # enough CC hoarded; stop supplying (SDD §14.4)
            # UC-03: discount grows as expiry nears and waste risk rises
            waste_risk = min(1.0, max(0.0, surplus / max(a.quota_capacity, 1.0)))
            expiry_urgency = max(0.0, 1.0 - a.days_to_expiry(tick) / a.cycle_days)
            discount = 0.45 * waste_risk * expiry_urgency
            if repaying:
                discount = max(discount, 0.35)
            ask = max(REF_PRICE * (1 + a.min_margin) * (1 - discount),
                      REF_PRICE * 0.4)
            units = min(a.max_supply_per_tick,
                        a.remaining_quota - (0 if repaying else a.mean_daily_demand / 24))
            if units >= 1.0:
                offers.append(Offer(a.aid, units, ask))
        return offers

    # --- matching + execution -------------------------------------------
    def clear(self, agents: dict[str, Agent], tick: int) -> None:
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
        ok = (self.rng.random() < provider.reliability and
              self.rng.random() < provider.quality)
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
        self.ledger.settle(tick, task.task_id, requester.aid, provider.aid,
                           price, fee, risk)
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
