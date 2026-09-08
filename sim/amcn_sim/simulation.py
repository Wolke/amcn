"""Main simulation loop."""

from __future__ import annotations

import dataclasses
import json
import random
from pathlib import Path

from .agents import (DEADBEAT, TICKS_PER_DAY, WASHER, Agent, DebtEpisode,
                     build_population, credit_limit)
from .ledger import Ledger
from .market import Market
from .metrics import DailySnapshot, Report, finalize, median_price_in, render_text

SCENARIOS = {
    # name: (deadbeat_frac, washer_frac, expiry_cliff)
    "baseline":     (0.02, 0.02, False),
    "expiry_cliff": (0.02, 0.02, True),   # all quotas reset the same day
    "high_default": (0.15, 0.02, False),  # stress the credit-line policy
    "wash_heavy":   (0.02, 0.20, False),  # stress FR-061/062 diversity caps
}


def run(n_agents: int = 500, days: int = 84, seed: int = 42,
        scenario: str = "baseline", out_dir: str | None = None) -> Report:
    deadbeat_frac, washer_frac, expiry_cliff = SCENARIOS[scenario]
    rng = random.Random(seed)
    agents = {a.aid: a for a in build_population(
        n_agents, seed, deadbeat_frac, washer_frac, expiry_cliff)}
    ledger = Ledger()
    market = Market(ledger, random.Random(seed + 1))
    ticks = days * TICKS_PER_DAY
    report = Report(days=days, n_agents=n_agents)

    for a in agents.values():
        if a.behavior == DEADBEAT:
            # vanishes some time in the second half of the run
            a.exit_tick = rng.randrange(ticks // 3, ticks)

    for tick in range(ticks):
        for a in agents.values():
            if not a.online:
                continue
            # deadbeat exit: burn remaining credit then disappear (§16 threat 13)
            if a.exit_tick is not None and tick >= a.exit_tick:
                avail = credit_limit(a, tick) + ledger.balance(a.aid)
                if avail > 1.0:
                    market.post_shortfall(a, avail * 0.9, tick)  # final grab
                a.online = False
                continue
            if a.cycle_reset_due(tick):
                a.remaining_quota = a.quota_capacity  # unused quota expires
            demand = a.draw_demand(tick)
            if demand <= a.remaining_quota:
                a.remaining_quota -= demand
            else:
                shortfall = demand - a.remaining_quota
                a.remaining_quota = 0.0
                market.post_shortfall(a, shortfall, tick)  # UC-01
            if a.behavior == WASHER and tick % (TICKS_PER_DAY // 2) == 0:
                market.post_wash_task(a, tick)

        market.clear(agents, tick)

        # debt-episode tracking (per-day granularity is enough)
        if tick % TICKS_PER_DAY == 0:
            for a in agents.values():
                bal = ledger.balance(a.aid)
                in_ep = a.debt_episodes and a.debt_episodes[-1].end_tick is None
                if bal < -0.5 and not in_ep:
                    a.debt_episodes.append(DebtEpisode(start_tick=tick))
                elif bal >= 0 and in_ep:
                    a.debt_episodes[-1].end_tick = tick

            # write off agents gone ≥14 days with negative balance
            for a in agents.values():
                if (not a.online and a.exit_tick is not None
                        and tick - a.exit_tick >= 14 * TICKS_PER_DAY
                        and ledger.balance(a.aid) < 0):
                    ledger.write_off(tick, a.aid)

            day = tick // TICKS_PER_DAY
            debtors = [x for x in agents.values()
                       if ledger.balance(x.aid) < -0.5 and x.online]
            report.daily.append(DailySnapshot(
                day=day,
                fill_rate=(market.stats.matched / market.stats.posted
                           if market.stats.posted else 0.0),
                median_price=median_price_in(
                    market, tick - TICKS_PER_DAY, tick + 1),
                open_tasks=len(market.open_tasks),
                agents_in_debt=len(debtors),
                total_debt_cc=sum(-ledger.balance(x.aid) for x in debtors),
                total_credit_cc=sum(credit_limit(x, tick)
                                    for x in agents.values() if x.online),
                settled_cc_cum=market.stats.settled_cc,
            ))

    finalize(report, agents, ledger, market, ticks, credit_limit)

    if out_dir:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        summary = dataclasses.asdict(report)
        daily = summary.pop("daily")
        (out / f"{scenario}_summary.json").write_text(
            json.dumps(summary, indent=2, ensure_ascii=False))
        with (out / f"{scenario}_daily.csv").open("w") as fh:
            cols = [f.name for f in dataclasses.fields(DailySnapshot)]
            fh.write(",".join(cols) + "\n")
            for d in daily:
                fh.write(",".join(
                    "" if d[c] is None else f"{d[c]:.4f}" if isinstance(d[c], float)
                    else str(d[c]) for c in cols) + "\n")
    return report


def main(argv: list[str] | None = None) -> None:
    import argparse
    p = argparse.ArgumentParser(
        prog="amcn_sim",
        description="AMCN Phase 0 mutual-credit economy simulation (SDD §19)")
    p.add_argument("--agents", type=int, default=500)
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--scenario", choices=sorted(SCENARIOS), default="baseline")
    p.add_argument("--all-scenarios", action="store_true",
                   help="run every scenario and print a comparison")
    p.add_argument("--out", default="sim/out", help="output dir for json/csv")
    args = p.parse_args(argv)

    scenarios = sorted(SCENARIOS) if args.all_scenarios else [args.scenario]
    for sc in scenarios:
        rep = run(args.agents, args.days, args.seed, sc, args.out)
        print(render_text(rep, sc))
        print()


if __name__ == "__main__":
    main()
