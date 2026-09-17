"""Main simulation loop."""

from __future__ import annotations

import dataclasses
import json
import random
from pathlib import Path

from .agents import (DEADBEAT, TICKS_PER_DAY, WASHER, Agent, DebtEpisode,
                     build_population, build_verifiers, credit_limit)
from .ledger import DEMURRAGE_POOL, INSURANCE, Ledger, Posting, TREASURY
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
        repay_discount: float = 0.35, band_low_cl_frac: float | None = -0.15,
        n_verifiers: int = 9, verifier_rate: float = 0.04,
        canary_rate: float = 0.03, verifier_lazy_frac: float = 0.0,
        verifier_stake_cc: float = 50.0,
        # 保證金（#65）。deposit_cc 是每個 agent 抵押的金額；
        # deposit_deadbeats_only 用來回答「只有壞人會被沒收，好人只是被凍結
        # 資金」這個不對稱是否成立。
        deposit_cc: float = 0.0,
        deposit_ltv: float = 1.0,
        # 保管費（登記簿 #66）。rate 是每天對正餘額收取的比例；idle_days 只
        # 對「連續這麼多天沒有動過」的餘額收費（鼓勵流動），0 表示對所有正
        # 餘額收（純收益）。dest 決定它是回流還是抽稅：
        #   "treasury"    → 收益，但除非 Treasury 花出去就只是換一個吸收端
        #   "redistribute" → 依當期結算量分給活躍交易者，強制回流
        demurrage_rate: float = 0.0,
        demurrage_idle_days: int = 0,
        demurrage_dest: str = "treasury",
        trace: str | None = None) -> Report:
    sc_deadbeat, washer_frac, expiry_cliff = SCENARIOS[scenario]
    if deadbeat_frac is None:
        deadbeat_frac = sc_deadbeat
    rng = random.Random(seed)
    # 每個帳戶最後一次有分錄的 tick，供「閒置」保管費判斷用。
    # 每個帳戶最後一次**支出**的 tick。用支出而非任何分錄，見下方註解。
    last_move: dict[str, int] = {}
    seen_events = 0
    defaults: list[dict] = []          # 每個違約身分拿走多少、賠掉多少
    agents = {a.aid: a for a in build_population(
        n_agents, seed, deadbeat_frac, washer_frac, expiry_cliff)}
    ledger = Ledger()
    if trace == "auto":  # pick a chronically under-provisioned honest agent
        trace = next((a.aid for a in agents.values()
                      if a.behavior == "honest"
                      and a.mean_daily_demand * a.cycle_days > a.quota_capacity),
                     None)
    if deposit_cc > 0:
        for a in agents.values():
            a.collateral_cc = deposit_cc
            a.collateral_ltv = deposit_ltv
    verifiers = build_verifiers(n_verifiers, seed,
                                lazy_frac=verifier_lazy_frac,
                                stake_cc=verifier_stake_cc)
    market = Market(ledger, random.Random(seed + 1),
                    risk_thin=risk_thin, risk_base=risk_base,
                    starter_cc=starter_cc, repay_discount=repay_discount,
                    band_low_cl_frac=band_low_cl_frac,
                    verifiers=verifiers, verifier_rate=verifier_rate,
                    canary_rate=canary_rate, trace=trace)
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
                                        if ledger.balance(a.aid)
                                        < market.band_low(a, tick, agents) else ""))
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

            # 「最後有**流出**」，不是「最後有動過」。第一版記的是任何分錄，
            # 於是 verifier 每收一筆驗證費就算「有動」——儘管它的餘額只增不
            # 減。實測下來重分配模式對 verifier 持有量毫無作用（119±43 對
            # 116±36），就是這個定義錯誤造成的。#62 要抓的是「只進不出」，
            # 所以只有負向分錄才算動過。
            while seen_events < len(ledger.events):
                ev = ledger.events[seen_events]
                seen_events += 1
                for pg in ev.postings:
                    if pg.amount_cc < 0:
                        last_move[pg.account] = ev.tick

            # --- 保管費（#66）-------------------------------------
            # 每天一次。對象是持有正餘額者，包含 verifier——#62 量到的正是
            # verifier 只進不出（原型 soak 每位 +11.9 CC），而保管費是否能把
            # 那些錢逼回市場，就是這個掃描要回答的。
            if demurrage_rate > 0:
                holders = [x.aid for x in agents.values()] + \
                          [v.vid for v in verifiers]
                charged = 0.0
                for acct in holders:
                    bal = ledger.balance(acct)
                    if bal <= 0:
                        continue
                    if demurrage_idle_days > 0:
                        last = last_move.get(acct, 0)
                        if tick - last < demurrage_idle_days * TICKS_PER_DAY:
                            continue      # 還在流動，不收
                    charged += ledger.demurrage(
                        tick, acct, bal * demurrage_rate,
                        TREASURY if demurrage_dest == "treasury" else DEMURRAGE_POOL)
                # redistribute: 依「本日有成交」分給活躍交易者，強制回流。
                # 沒有活躍者時留在池子裡等下一天，不憑空消失。
                if demurrage_dest != "treasury" and charged > 1e-9:
                    active = [x.aid for x in agents.values()
                              if x.online and last_move.get(x.aid, -1)
                              >= tick - TICKS_PER_DAY]
                    pool = ledger.balance(DEMURRAGE_POOL)
                    if active and pool > 1e-9:
                        share = pool / len(active)
                        ledger.post(tick, "demurrage_payout",
                                    f"demurrage_payout:{tick}",
                                    [Posting(DEMURRAGE_POOL, -pool)] +
                                    [Posting(a, share) for a in active])

            # write off agents gone ≥14 days with negative balance
            for a in agents.values():
                if (not a.online and a.exit_tick is not None
                        and tick - a.exit_tick >= 14 * TICKS_PER_DAY
                        and ledger.balance(a.aid) < 0):
                    # 違約前的負餘額就是這個身分實際「拿走」的價值；
                    # 保證金抵掉一部分，剩下的才是網路的損失（#65）。
                    took = -ledger.balance(a.aid)
                    ledger.write_off(tick, a.aid, a.collateral_cc)
                    seized = ledger.last_collateral_seized
                    defaults.append({"aid": a.aid, "took_cc": took,
                                     "collateral_cc": a.collateral_cc,
                                     "seized_cc": seized})

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
                # 逐帳戶看「還剩多少可用額度」。原型 soak 的鎖死特徵是每一
                # 個交易者都貼在上限上（#61），而總量比會被健康帳戶稀釋，
                # 看不出那件事。
                pinned_frac=(
                    sum(1 for x in agents.values() if x.online
                        and -ledger.balance(x.aid)
                        >= 0.9 * max(1e-9, credit_limit(x, tick, agents,
                                                        market.starter_cc)))
                    / max(1, sum(1 for x in agents.values() if x.online))),
            ))

    finalize(report, agents, ledger, market, ticks,
             lambda a, t: credit_limit(a, t, agents, market.starter_cc),
             defaults=defaults)
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
