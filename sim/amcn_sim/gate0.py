"""GATE-0：全量模擬的八判準，經濟參數凍結前的最後一道（final-architecture §5 W3）。

**為什麼要重跑**：2026-09-08 那一輪凍結參數時，保證金（#65）、保管費（#66）、
流入費、沖銷瀑布、還債折價、雙角色人口都還不存在；而它只用**一個種子**，
而這一路反覆學到的是組間差異常常落在種子離散之內（#66 的掃描、#61 的 N=3）。

**判準的來源**：G1–G5 照 `phase0-results.md` 第二輪的定義。§5 W3 寫「八判準」
但只列了四個例子，所以 G6–G8 是我補的，理由寫在各自的 `why` 裡——其中兩個
來自 2026-09-21 的量測，那天才知道它們該被守。

Run:  cd sim && python3 -u -m amcn_sim.gate0
      python3 -u -m amcn_sim.gate0 --agents 500 --seeds 42 7 99
"""

from __future__ import annotations

import argparse
import csv
import statistics as stx
from pathlib import Path

from .simulation import run

SCENARIOS = ["baseline", "expiry_cliff", "high_default", "wash_heavy"]


def criteria(rep) -> list[tuple[str, bool | None, str, str]]:
    """回傳 (代號, 通過, 實測, 這一條在守什麼)。

    `通過` 是三態：True／False／**None ＝ 本情境不適用**。不適用不能算通過
    ——那正是這個專案一路抓到的形態（#76 的「未測到」與「違反」要分開）。
    例如 baseline 沒有洗量人口，G2 就沒有可比的對象。
    """
    tail = rep.daily[-7:] if len(rep.daily) >= 7 else rep.daily
    pinned = (sum(d.pinned_frac for d in tail) / len(tail) * 100) if tail else 0.0
    pos_total = rep.total_positive_cc
    price0 = rep.price_first_week or 0.0
    price1 = rep.price_last_week or 0.0
    drop = (100 * (price0 - price1) / price0) if price0 > 0 else 0.0
    return [
        ("G1 守恆＋可重建", rep.conservation_ok, str(rep.conservation_ok),
         "Σ=0 且帳可由簽署事件重建（§20-4）"),
        ("G2 洗量額度受抑",
         None if not rep.mean_credit_limit_honest_matched
         or not rep.mean_credit_limit_washer
         else rep.mean_credit_limit_washer
         <= rep.mean_credit_limit_honest_matched,
         "（本情境無洗量人口）" if not rep.mean_credit_limit_washer
         else f"洗量 {rep.mean_credit_limit_washer:.1f} vs 同活躍度誠實 "
              f"{(rep.mean_credit_limit_honest_matched or 0):.1f}",
         "F-1 反洗量折減：洗量不得換到比同活躍度誠實者更高的額度"),
        ("G3 壞帳 ≤ 風險費收入", rep.bad_debt_cc <= rep.insurance_income_cc,
         f"壞帳 {rep.bad_debt_cc:.0f} vs 保險收入 {rep.insurance_income_cc:.0f}",
         "保險池要付得起違約，否則虧損落到 protocol:loss"),
        ("G4 還債週期中位 <30 天",
         (rep.median_debt_cycle_days or 999) < 30,
         f"{rep.median_debt_cycle_days}", "負餘額要在計費週期內還得掉（§27 閉環）"),
        ("G5 成交率 ≥80%", rep.fill_rate >= 0.80, f"{rep.fill_rate:.3f}",
         "供需要撮合得起來，否則量到的是空市場"),
        # —— 以下三條是本輪補的 ——
        ("G6 到期崩價 <40%", abs(drop) < 40.0,
         f"首週 {price0:.3f} → 末週 {price1:.3f}（{drop:+.1f}%）",
         "§5 W3 點名「到期崩價幅度」但沒給門檻；40% 是先立一個可被推翻的值"),
        ("G7 首位持有者會輪替", rep.distinct_top_holders >= 2,
         f"{rep.distinct_top_holders} 個帳戶當過當日首位",
         "2026-09-21 才知道要守：瞬時佔比在「同一人永遠吸」與「每月換人」"
         "之下長得一樣，而後者是庫存、前者是水槽（#64）"),
        # G8 的第一版寫「最大留存 <100%」，而小規模煙霧測試四個情境全紅——
        # 它其實在問「最終首位是不是純淨賣方」，而 2026-09-21 才確認**集中只要
        # 會輪替就是庫存不是水槽**（#64，見 G7）。真正只進不出的是設計上不
        # 消費的 verifier，所以改成直接守那一條。
        ("G8 verifier 持有 ≤20% 正餘額",
         None if pos_total <= 0 else rep.verifier_balance_cc <= 0.20 * pos_total,
         f"verifier {rep.verifier_balance_cc:.0f} / 正餘額 {pos_total:.0f}"
         f"（{100*rep.verifier_balance_cc/pos_total:.1f}%）" if pos_total > 0
         else "（無正餘額）",
         "#62：verifier 賺費而從不購買，是唯一在設計上就不消費的角色。"
         "20% 是先立一個可被推翻的門檻；雙角色（#62 的 (a)）之下應為 0"),
    ]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.gate0")
    p.add_argument("--agents", type=int, default=500)
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--seeds", type=int, nargs="+", default=[42, 7, 99])
    p.add_argument("--dual-role", action="store_true")
    # 風險費是 G3 的已知旋鈕（2026-09-08 量到 6%/2% 能讓 high_default 通過）。
    # 做成參數而不是改預設：GATE-0 的用途是「哪一組參數能過」，不是「調到過」。
    p.add_argument("--risk-thin", type=float, default=None)
    p.add_argument("--risk-base", type=float, default=None)
    p.add_argument("--demand-drift-days", type=int, default=0)
    p.add_argument("--out", default="out/gate0.csv")
    args = p.parse_args(argv)

    print(f"GATE-0：{args.agents} agents × {args.days} 天 × {len(SCENARIOS)} 情境 "
          f"× {len(args.seeds)} 種子"
          f"{'（雙角色）' if args.dual_role else ''}"
          f"{f'（需求每 {args.demand_drift_days} 天漂移）' if args.demand_drift_days else ''}")
    print("每一格是「通過的種子數／總種子數」——一個種子過不算過。\n")

    rows, tally, seen_total = [], {}, {}
    names: list[str] = []
    for sc in SCENARIOS:
        per: dict[str, list[bool]] = {}
        detail: dict[str, list[str]] = {}
        for seed in args.seeds:
            rep = run(args.agents, args.days, seed, sc, starter_cc=50.0,
                      n_verifiers=max(3, args.agents // 50),
                      dual_role=args.dual_role,
                      demand_drift_days=args.demand_drift_days,
                      **({"risk_thin": args.risk_thin} if args.risk_thin else {}),
                      **({"risk_base": args.risk_base} if args.risk_base else {}))
            for name, ok, got, _why in criteria(rep):
                per.setdefault(name, []).append(ok)
                detail.setdefault(name, []).append(got)
            names = [c[0] for c in criteria(rep)]
        print(f"— {sc} —")
        for name in names:
            vals = per[name]
            n_na = sum(1 for v in vals if v is None)
            n_ok = sum(1 for v in vals if v is True)
            if n_na == len(vals):
                mark, n_ok = "不適用", -1
            else:
                mark = "PASS" if n_ok == len(vals) - n_na else (
                    "部分" if n_ok else "FAIL")
            shown = "—" if n_ok < 0 else f"{n_ok}/{len(vals) - n_na}"
            print(f"   {mark:>4} {shown:>5}  {name:<22} {detail[name][0]}")
            if n_ok >= 0:
                tally[name] = tally.get(name, 0) + n_ok
                seen_total[name] = seen_total.get(name, 0) + len(vals) - n_na
            rows.append({"scenario": sc, "criterion": name,
                         "seeds_passed": n_ok, "seeds": len(vals) - n_na,
                         "first_seed_value": detail[name][0]})
        print()

    full = [n for n in names
            if seen_total.get(n, 0) and tally.get(n, 0) == seen_total[n]]
    print(f"== 全數通過 {len(full)}/{len(names)} 條 ==")
    for n in names:
        tot = seen_total.get(n, 0)
        if not tot:
            print(f"   全程不適用：{n}")
        elif tally.get(n, 0) != tot:
            print(f"   未全過：{n}  {tally.get(n, 0)}/{tot}")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f"\n{len(rows)} 列 → {out}")


if __name__ == "__main__":
    main()
