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
    joined_tick: int = 0
    online: bool = True
    earned_cc: float = 0.0
    spent_cc: float = 0.0
    tasks_completed: int = 0
    tasks_failed: int = 0
    disputes: int = 0
    counterparties: set[str] = field(default_factory=set)
    counterparty_volume: dict[str, float] = field(default_factory=dict)
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

    def diverse_contribution(self) -> float:
        """Earned CC, discounted for counterparty concentration (FR-062).

        Volume with any single counterparty above 25% of total is ignored,
        which is what caps wash-trading pairs.
        """
        total = sum(self.counterparty_volume.values())
        if total <= 0:
            return 0.0
        cap = 0.25 * total
        return sum(min(v, cap) for v in self.counterparty_volume.values())

    # --- per-tick draws -------------------------------------------------
    def cycle_reset_due(self, tick: int) -> bool:
        day = tick // TICKS_PER_DAY
        return (day - self.cycle_offset_days) % self.cycle_days == 0 and tick % TICKS_PER_DAY == 0

    def days_to_expiry(self, tick: int) -> float:
        day = tick / TICKS_PER_DAY
        into = (day - self.cycle_offset_days) % self.cycle_days
        return self.cycle_days - into

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


def credit_limit(a: Agent, tick: int, starter_cc: float = 20.0) -> float:
    """Simulable credit-line algorithm (SDD §14.3).

    credit_limit = f(age, verified contribution, completion rate,
                     counterparty diversity, dispute rate)

    Starter line is treasury-capped and small; growth requires diverse,
    verified contribution — a deliberate Sybil/wash-trading cost.
    """
    if not a.online:
        return 0.0
    age_factor = min(1.0, a.age_days(tick) / 30.0)          # ramps over 30 days
    contribution = min(a.diverse_contribution(), 2000.0)
    diversity = min(1.0, len(a.counterparties) / 8.0)
    quality_factor = 0.25 + 0.75 * a.completion_rate()
    dispute_penalty = max(0.0, 1.0 - 4.0 * a.dispute_rate())
    earned_line = 0.35 * contribution * (0.3 + 0.7 * diversity)
    limit = (starter_cc * (0.5 + 0.5 * age_factor) + earned_line) \
        * quality_factor * dispute_penalty
    return max(0.0, min(limit, 500.0))                       # hard network cap


def build_population(n: int, seed: int, deadbeat_frac: float,
                     washer_frac: float, expiry_cliff: bool) -> list[Agent]:
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
