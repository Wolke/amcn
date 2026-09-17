"""保證金掃描：推廣額度要多大、保證金要多少、折扣率要多低（登記簿 #65）。

起因是 Owner 的提議：「上線應該要有保證金制度，避免太多人用了都不還造成大量
壞帳；這個保證金我可以自己先發當推廣，可能就 $10」。以全案錨定 1 CC =
US$0.05 計，$10 = 200 CC，是現行 L_boot 參數（50 CC）的四倍。

#50 記的前置是「身分創建要變成內生的攻擊者決策」。這裡用模擬器既有的
deadbeat 族群當攻擊者代理——它們正是「用掉額度然後消失」，而 deadbeat_frac
就是攻擊規模的旋鈕。每個違約身分的 **淨賺 = 拿走 − 保證金沒收**，那就是
Sybil 攻擊的每身分期望收益。

要回答的是三件事：
  1. $10 的推廣額度在沒有保證金時安全嗎？
  2. 等額保證金夠不夠？
  3. 折扣率（LTV，抵押 D 只解鎖 D×ltv）需要多低？

Run:  cd sim && python3 -u -m amcn_sim.sweep_deposit
"""

from __future__ import annotations

import argparse
import csv
import statistics
from pathlib import Path

from .simulation import run

# 50 CC = 現行參數（$2.50）；200 CC ≈ Owner 提議的 $10
STARTERS = [50.0, 200.0]
DEPOSITS = [0.0, 100.0, 200.0]
LTVS = [1.0, 0.5]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.sweep_deposit")
    p.add_argument("--agents", type=int, default=50)
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--deadbeat", type=float, default=0.15)
    p.add_argument("--seeds", type=int, nargs="+", default=[42, 7, 99])
    p.add_argument("--out", default="out/sweep_deposit.csv")
    args = p.parse_args(argv)

    rows = []
    hdr = (f"{'starter':>7} {'保證金':>6} {'LTV':>5} | {'每身分淨賺CC':>14} "
           f"{'壞帳%':>11} {'G3':>4} {'成交%':>11} {'期末額度':>9}")
    print(hdr)
    print("-" * len(hdr))
    for starter in STARTERS:
        for dep in DEPOSITS:
            for ltv in (LTVS if dep > 0 else [1.0]):
                net, bad, fill, g3, lines = [], [], [], [], []
                for seed in args.seeds:
                    r = run(args.agents, args.days, seed, "baseline",
                            starter_cc=starter, deadbeat_frac=args.deadbeat,
                            n_verifiers=max(3, args.agents // 10),
                            deposit_cc=dep, deposit_ltv=ltv)
                    net.append(r.default_net_take_avg_cc)
                    bad.append(r.bad_debt_rate * 100)
                    fill.append(r.fill_rate * 100)
                    g3.append(r.bad_debt_cc <= r.insurance_income_cc)
                    lines.append(r.daily[-1].total_credit_cc if r.daily else 0.0)
                half = lambda xs: (max(xs) - min(xs)) / 2
                m = statistics.mean
                print(f"{starter:>7.0f} {dep:>6.0f} {ltv:>5.2f} | "
                      f"{m(net):>7.1f}±{half(net):<6.1f} "
                      f"{m(bad):>5.2f}±{half(bad):<4.2f} "
                      f"{sum(g3)}/{len(g3):<2} "
                      f"{m(fill):>5.1f}±{half(fill):<4.1f} "
                      f"{m(lines):>9.0f}")
                rows.append({
                    "starter_cc": starter, "deposit_cc": dep, "ltv": ltv,
                    "seeds": len(args.seeds),
                    "net_take_per_default_cc": round(m(net), 2),
                    "net_take_halfspread": round(half(net), 2),
                    "bad_debt_pct": round(m(bad), 3),
                    "g3_pass_count": sum(g3),
                    "fill_rate_pct": round(m(fill), 2),
                    "total_credit_cc": round(m(lines), 1),
                })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\n{len(rows)} 組 → {out}")
    print("推導出的規則：淨賺 ≈ L_boot(t=0) − 保證金×(1−LTV)，")
    print("               所以 保證金 ≥ starter×0.5 ÷ (1−LTV) 時攻擊無利可圖。")


if __name__ == "__main__":
    main()
