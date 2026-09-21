"""Agent population model.

One CC == the reference value of one abstract "compute unit" (roughly a
frontier-model request of average size). Quotas, demand, task sizes and
prices are all denominated in units/CC so the economics stay legible.

Behavior types (adversarial scenarios, SDD §14.4 / §16):
- honest     — normal supply/demand behavior
- deadbeat   — borrows up to its credit line, then leaves the network
- washer     — trades in a closed pair to inflate contribution stats
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field

HONEST = "honest"
DEADBEAT = "deadbeat"
WASHER = "washer"

TICKS_PER_DAY = 24  # 1 tick = 1 hour


@dataclass
class Verifier:
    """A staked verification node (proposal-C §7, final-architecture §2.2).

    The node prototype has had verifiers since Phase 1, but this simulator
    did not, which is why the 4% verifier fee it ships has no GATE-0
    evidence behind it (§4 #25). Modelled here so the rate, the stake floor
    and the canary rate can be swept instead of asserted.
    """

    vid: str
    stake_cc: float = 50.0
    # Probability of reaching the correct verdict when it actually checks.
    competence: float = 0.98
    # A lazy verifier skips the work and votes with whatever it expects the
    # majority to say. Commit-reveal is what makes that a gamble rather than
    # a free ride, so here it means "votes without checking".
    lazy_prob: float = 0.0
    earned_cc: float = 0.0
    assignments: int = 0
    canary_seen: int = 0
    canary_failed: int = 0
    slashed_cc: float = 0.0
    online: bool = True

    def exposure_ratio(self, contract_price: float) -> float:
        """§4 #7: single-contract exposure against stake. The integrated
        ruling caps handled value at stake x 3."""
        return contract_price / self.stake_cc if self.stake_cc else float("inf")


def build_verifiers(n: int, seed: int, lazy_frac: float = 0.0,
                    stake_cc: float = 50.0,
                    agent_ids: list[str] | None = None) -> list[Verifier]:
    r = random.Random(seed + 9001)
    out = []
    n_lazy = int(n * lazy_frac)
    for i in range(n):
        # `agent_ids` 給定時，驗證是**角色**而不是獨立物種（#62 階段 3 在原型
        # 的形狀）：panel 從交易者裡抽，驗證費因此落在會花錢的帳戶上。
        # 沒給就是原本的獨立 verifier 人口——那是留存 99.4% 的純吸收端。
        out.append(Verifier(
            vid=(agent_ids[i] if agent_ids else f"verifier:{i:04d}"),
            stake_cc=stake_cc * r.uniform(0.8, 1.6),
            competence=r.uniform(0.94, 0.995),
            lazy_prob=0.0,
        ))
    idx = list(range(n))
    r.shuffle(idx)
    for i in idx[:n_lazy]:
        out[i].lazy_prob = r.uniform(0.5, 1.0)
    return out


@dataclass
class DebtEpisode:
    start_tick: int
    end_tick: int | None = None  # None = still in debt


@dataclass
class Agent:
    aid: str
    rng: random.Random
    behavior: str = HONEST

    # Quota model: capacity units per billing cycle, expires unused.
    quota_capacity: float = 300.0
    cycle_days: int = 30
    cycle_offset_days: int = 0          # staggers reset dates across agents
    remaining_quota: float = 0.0

    # Demand model: mean own-consumption per day, in units.
    mean_daily_demand: float = 8.0
    # 需求會不會隨時間改變（#64 的模型限制）。原本 `mean_daily_demand` 一生
    # 只指派一次，於是抽到低利用率的 agent 是**永久**淨賣方——而「永久低需求
    # 者會永久累積」離重述輸入很近。賞金獵人館的實際形態是今天接案、明天發案，
    # 所以需求要能漂移。0 表示不漂移（原行為）。
    demand_drift_days: int = 0
    base_demand: float = 0.0
    burst_prob_per_day: float = 0.02    # emergency spike (UC-01 trigger)
    burst_multiplier: float = 5.0

    # Quality / reliability of this agent as a provider.
    reliability: float = 0.97           # completes accepted work
    quality: float = 0.95               # passes verification

    # Policy (owner-set, SDD §6.2): pricing and balance targets.
    min_margin: float = 0.05            # never sell below cost*(1+min_margin)
    max_price_factor: float = 1.8       # never buy above ref*(this)
    target_balance_low: float = -5.0    # start repaying below this
    target_balance_high: float = 60.0   # stop supplying above this
    max_supply_per_tick: float = 6.0

    # Adversarial params
    wash_partner: str | None = None
    exit_tick: int | None = None        # deadbeats: tick they vanish

    # --- runtime stats (feed the credit-line algorithm, SDD §14.3) ---
    # INV-C1 的 collateral 項（登記簿 #65，Owner 提議的保證金）。存在於
    # 不變式裡很久了，但模擬器與原型都沒有實作，所以「保證金能不能壓住
    # Sybil」從來沒有被算過。
    collateral_cc: float = 0.0
    collateral_ltv: float = 1.0        # 抵押折扣：解鎖額度 ÷ 抵押金額

    joined_tick: int = 0
    online: bool = True
    earned_cc: float = 0.0
    spent_cc: float = 0.0
    tasks_completed: int = 0
    tasks_failed: int = 0
    disputes: int = 0
    counterparties: set[str] = field(default_factory=set)
    counterparty_volume: dict[str, float] = field(default_factory=dict)
    paid_volume: dict[str, float] = field(default_factory=dict)  # spend per provider
    debt_episodes: list[DebtEpisode] = field(default_factory=list)
    pending_burst_units: float = 0.0

    def age_days(self, tick: int) -> float:
        return (tick - self.joined_tick) / TICKS_PER_DAY

    def completion_rate(self) -> float:
        done = self.tasks_completed + self.tasks_failed
        return self.tasks_completed / done if done else 0.9  # neutral prior

    def dispute_rate(self) -> float:
        done = self.tasks_completed + self.tasks_failed
        return self.disputes / done if done else 0.0

    def effective_contribution(self, peers: dict[str, "Agent"] | None = None) -> float:
        """E_eff (proposal C, adopted after Phase 0 finding F-1).

        Round-1 flaw: capping each counterparty at 25% of *total* volume
        lets wash volume inflate its own ceiling (mixed wash strategy won).
        Two fixes, applied in order:

        1. T_flow proxy: earnings from a payer are weighted by how spread
           that payer's own spending is. A wash partner who sends most of
           its outflow to me contributes almost nothing.
        2. Per-counterparty cap of 20% of the sum of all *other*
           counterparties' weighted volume — the cap base excludes the
           counterparty itself, so pumping one pair can never raise the
           pair's own ceiling.
        """
        if not self.counterparty_volume:
            return 0.0
        weighted: dict[str, float] = {}
        for c, v in self.counterparty_volume.items():
            w = 1.0
            if peers is not None and c in peers:
                payer = peers[c]
                out_total = sum(payer.paid_volume.values())
                if out_total > 0:
                    share_to_me = payer.paid_volume.get(self.aid, 0.0) / out_total
                    w = max(0.0, 1.0 - share_to_me)
            weighted[c] = v * w
        total_w = sum(weighted.values())
        return sum(min(v, 0.20 * (total_w - v)) for v in weighted.values())

    # --- per-tick draws -------------------------------------------------
    def cycle_reset_due(self, tick: int) -> bool:
        day = tick // TICKS_PER_DAY
        return (day - self.cycle_offset_days) % self.cycle_days == 0 and tick % TICKS_PER_DAY == 0

    def days_to_expiry(self, tick: int) -> float:
        day = tick / TICKS_PER_DAY
        into = (day - self.cycle_offset_days) % self.cycle_days
        return self.cycle_days - into

    def maybe_drift(self, tick: int) -> None:
        """週期性重抽利用率：同一個 agent 在不同期間可以是買方或賣方。"""
        if self.demand_drift_days <= 0 or self.base_demand <= 0:
            return
        if tick % (self.demand_drift_days * TICKS_PER_DAY) != 0:
            return
        self.mean_daily_demand = self.base_demand * self.rng.choice(
            [0.3, 0.5, 0.8, 0.8, 1.0, 1.3])

    def draw_demand(self, tick: int) -> float:
        """Own consumption this tick, in units (lognormal-ish, hourly)."""
        if tick % TICKS_PER_DAY == 0 and self.rng.random() < self.burst_prob_per_day:
            self.pending_burst_units += self.mean_daily_demand * self.burst_multiplier
        base = self.mean_daily_demand / TICKS_PER_DAY
        d = base * math.exp(self.rng.gauss(0, 0.6)) * 0.85
        if self.pending_burst_units > 0:
            take = min(self.pending_burst_units, self.mean_daily_demand / 4)
            self.pending_burst_units -= take
            d += take
        return d

    def expected_remaining_demand(self, tick: int) -> float:
        return self.mean_daily_demand * self.days_to_expiry(tick)

    def projected_surplus(self, tick: int) -> float:
        return self.remaining_quota - 1.2 * self.expected_remaining_demand(tick)


def credit_limit(a: Agent, tick: int, peers: dict[str, Agent] | None = None,
                 starter_cc: float = 20.0) -> float:
    """Simulable credit-line algorithm (SDD §14.3, E_eff per proposal C).

    credit_limit = f(age, E_eff contribution, completion rate,
                     counterparty diversity, dispute rate)

    Starter line is treasury-capped and small; growth requires diverse,
    trust-flow-weighted contribution — a deliberate Sybil/wash cost.
    """
    if not a.online:
        return 0.0
    age_factor = min(1.0, a.age_days(tick) / 30.0)          # ramps over 30 days
    contribution = min(a.effective_contribution(peers), 2000.0)
    diversity = min(1.0, len(a.counterparties) / 8.0)
    quality_factor = 0.25 + 0.75 * a.completion_rate()
    dispute_penalty = max(0.0, 1.0 - 4.0 * a.dispute_rate())
    earned_line = 0.35 * contribution * (0.3 + 0.7 * diversity)
    # 保證金不乘 quality：它是真實抵押品，不該因為帳戶年輕或紀錄少而打折。
    # 這也讓下面那個算式變得明顯——保證金把上限抬高的幅度**正好等於**它自己，
    # 所以對一個打算違約的人來說它是損益中性的：抵押 D、借走 D+L_boot、
    # 違約、賠掉 D，淨賺 L_boot。真正限制 Sybil 的是無擔保的那一段。
    # collateral_ltv < 1 是抵押折扣：抵押 D 只解鎖 D×ltv 的額度。LTV=1（原本
    # 的寫法）對打算違約的人是損益中性的——抵押 D、借走 D+L_boot、違約、賠掉
    # D，淨賺 L_boot。折扣才讓違約變成虧損：淨賺 = L_boot − D×(1−ltv)。
    limit = (starter_cc * (0.5 + 0.5 * age_factor) + earned_line) \
        * quality_factor * dispute_penalty \
        + a.collateral_cc * a.collateral_ltv
    return max(0.0, min(limit, 500.0))                       # hard network cap


def build_population(n: int, seed: int, deadbeat_frac: float,
                     washer_frac: float, expiry_cliff: bool,
                     demand_drift_days: int = 0) -> list[Agent]:
    """Heterogeneous population: over-provisioned suppliers, balanced
    users, and under-provisioned chronic requesters."""
    rng = random.Random(seed)
    agents: list[Agent] = []
    n_dead = int(n * deadbeat_frac)
    n_wash = int(n * washer_frac) // 2 * 2  # pairs
    for i in range(n):
        r = random.Random(rng.random())
        capacity = r.choice([150.0, 300.0, 300.0, 600.0, 1200.0])
        utilization = r.choice([0.3, 0.5, 0.8, 0.8, 1.0, 1.3])
        cycle = r.choice([7, 30, 30, 30])
        a = Agent(
            aid=f"agent:{i:05d}",
            rng=r,
            quota_capacity=capacity,
            cycle_days=cycle,
            # expiry_cliff: everyone resets the same day → month-end crash test
            cycle_offset_days=0 if expiry_cliff else r.randrange(cycle),
            mean_daily_demand=capacity / cycle * utilization,
            demand_drift_days=demand_drift_days,
            base_demand=capacity / cycle,
            burst_prob_per_day=r.uniform(0.01, 0.05),
            burst_multiplier=r.uniform(3.0, 6.0),
            reliability=r.uniform(0.92, 0.995),
            quality=r.uniform(0.88, 0.99),
            min_margin=r.uniform(0.02, 0.15),
            max_price_factor=r.uniform(1.3, 2.2),
            target_balance_high=r.uniform(30.0, 120.0),
        )
        a.remaining_quota = a.quota_capacity * r.uniform(0.2, 1.0)
        agents.append(a)

    idx = list(range(n))
    rng.shuffle(idx)
    for i in idx[:n_dead]:
        agents[i].behavior = DEADBEAT
    wash_ids = [i for i in idx[n_dead:n_dead + n_wash]]
    for j in range(0, len(wash_ids) - 1, 2):
        a, b = agents[wash_ids[j]], agents[wash_ids[j + 1]]
        a.behavior = b.behavior = WASHER
        a.wash_partner, b.wash_partner = b.aid, a.aid
    return agents
