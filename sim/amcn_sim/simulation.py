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
        scenario: str = "baseline", out_dir: str | None = None,
        starter_cc: float = 20.0, risk_thin: float = 0.03,
        risk_base: float = 0.01, deadbeat_frac: float | None = None,
        trace: str | None = None) -> Report:
    sc_deadbeat, washer_frac, expiry_cliff = SCENARIOS[scenario]
    if deadbeat_frac is None:
        deadbeat_frac = sc_deadbeat
    rng = random.Random(seed)
    agents = {a.aid: a for a in build_population(
        n_agents, seed, deadbeat_frac, washer_frac, expiry_cliff)}
    ledger = Ledger()
    if trace == "auto":  # pick a chronically under-provisioned honest agent
        trace = next((a.aid for a in agents.values()
                      if a.behavior == "honest"
                      and a.mean_daily_demand * a.cycle_days > a.quota_capacity),
                     None)
    market = Market(ledger, random.Random(seed + 1),
                    risk_thin=risk_thin, risk_base=risk_base,
                    starter_cc=starter_cc, trace=trace)
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
                avail = credit_limit(a, tick, agents, market.starter_cc) \
                    + ledger.balance(a.aid)
                if avail > 1.0:
                    market.post_shortfall(a, avail * 0.9, tick, agents)  # final grab
                a.online = False
                continue
            if a.cycle_reset_due(tick):
                if a.aid == market.trace and tick > 0:
                    market._tr(tick, f"計費週期重置：作廢 {a.remaining_quota:.1f} "
                                     f"units，額度回到 {a.quota_capacity:.0f}；"
                                     f"餘額 {ledger.balance(a.aid):+.1f} CC"
                                     + ("（開始還債供應, UC-02）"
                                        if ledger.balance(a.aid) < a.target_balance_low else ""))
                a.remaining_quota = a.quota_capacity  # unused quota expires
            demand = a.draw_demand(tick)
            if demand <= a.remaining_quota:
                a.remaining_quota -= demand
            else:
                shortfall = demand - a.remaining_quota
                a.remaining_quota = 0.0
                market.post_shortfall(a, shortfall, tick, agents)  # UC-01
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
                total_credit_cc=sum(credit_limit(x, tick, agents, market.starter_cc)
                                    for x in agents.values() if x.online),
                settled_cc_cum=market.stats.settled_cc,
            ))

    finalize(report, agents, ledger, market, ticks,
             lambda a, t: credit_limit(a, t, agents, market.starter_cc))
    if market.trace:
        report.trace_agent = market.trace
        report.trace_lines = list(market.trace_log)

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
    p.add_argument("--trace", default=None, metavar="AGENT_ID",
                   help="print one agent's diary; 'auto' picks a chronically "
                        "under-provisioned honest agent")
    args = p.parse_args(argv)

    scenarios = sorted(SCENARIOS) if args.all_scenarios else [args.scenario]
    for sc in scenarios:
        rep = run(args.agents, args.days, args.seed, sc, args.out,
                  trace=args.trace)
        print(render_text(rep, sc))
        if rep.trace_lines:
            print(f"\n-- {rep.trace_agent} 的日記（{len(rep.trace_lines)} 條）--")
            for line in rep.trace_lines:
                print(line)
        print()


if __name__ == "__main__":
    main()
