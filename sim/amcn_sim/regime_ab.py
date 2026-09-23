"""#90 的裁決用對照：新人的第一筆額度要「送」還是「買」。

一個旋鈕（starter）換成另一個機制（Treasury 向沒有紀錄的身分**購買**答案已知
的工作），而它們不能只比市場指標——**每一種體制被打穿的方式不一樣**：

  * 送額度怕的是「借了就走」：身分免費，所以無擔保的 starter 就是白拿的上界。
  * 買工作怕的是「交假東西」：攻擊者不需要信用，它要騙過驗收。

所以這裡對每一種體制都跑**兩種攻擊**，而不是各自挑一個好看的數字。三種子取
中位數，因為單一種子的離散比體制之間的差距還大（#50 的量測就踩過這個）。

    python3 -m amcn_sim.regime_ab              # 約 5 分鐘，輸出 out/regime_ab.csv
    python3 -m amcn_sim.regime_ab --agents 300 --days 84

判準不是「哪一欄好看」而是三件事一起成立：市場沒被殺掉（結算量）、壞帳有蓋住
（bad_debt vs 保險收入）、**而且每身分白拿趨近 0**（兩種攻擊都要）。
"""
from __future__ import annotations
import argparse
import csv
import os
import statistics

from .simulation import run

# 體制：只差在新人拿到什麼。其餘參數一律用候選組（風險費 6%/2%、雙角色），
# 否則比到的是參數而不是體制。
REGIMES = {
    "A 送額度 starter=50（目前常駐節點的預設）": dict(starter_cc=50.0),
    "B 零額度、什麼都不做": dict(starter_cc=0.0),
    "C 零額度＋入門採購 20（連續 3 次）": dict(
        starter_cc=0.0, onboarding_cap_cc=20.0, onboarding_total_cap_cc=40000.0,
        onboarding_streak_required=3),
    # 中間那一格：白拿的上界從 starter 直接讀得出來（送多少就是上界多少），
    # 所以「送一點點」不是折衷而是一個可以定價的選擇——列出來才不必用猜的。
    "D 小額 starter=10＋入門採購 20": dict(
        starter_cc=10.0, onboarding_cap_cc=20.0, onboarding_total_cap_cc=40000.0,
        onboarding_streak_required=3),
}

# 攻擊：N 是攻擊者的選擇變數（#50），這裡固定 20 個身分。
ATTACKS = {
    "無": dict(),
    "借了就走（產能≈0）": dict(sybil_n=20, sybil_capacity=0.001, sybil_quality=0.95),
    "交假東西（品質 0.1、產能 40u）": dict(sybil_n=20, sybil_capacity=40.0, sybil_quality=0.1),
}

BASE = dict(scenario="baseline", risk_thin=0.06, risk_base=0.02, dual_role=True)


def med(xs):
    return statistics.median(xs)


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--agents", type=int, default=200)
    p.add_argument("--days", type=int, default=56)
    p.add_argument("--seeds", type=int, nargs="+", default=[42, 7, 99])
    p.add_argument("--out", default="out/regime_ab.csv")
    args = p.parse_args(argv)

    rows = []
    for rname, rkw in REGIMES.items():
        for aname, akw in ATTACKS.items():
            got = []
            for seed in args.seeds:
                r = run(args.agents, args.days, seed, **BASE, **rkw, **akw)
                n = max(1, r.sybil_n)
                got.append(dict(
                    settled=r.settled_cc, fill=r.fill_rate,
                    bad=r.bad_debt_cc, bad_rate=r.bad_debt_rate,
                    wash=r.wash_share, ins=r.insurance_income_cc,
                    onb=r.onboarding_cc_spent, onb_ids=r.onboarding_identities,
                    # 白拿有兩條路：沖銷掉的負餘額，以及領到的入門採購。
                    # 分開列，因為它們是不同的洞（一個吃保險池、一個吃 Treasury）。
                    free_writeoff=r.sybil_written_off_cc / n,
                    free_onboarding=r.sybil_onboarding_cc / n,
                ))
            row = dict(regime=rname, attack=aname,
                       **{k: round(med([g[k] for g in got]), 3) for k in got[0]})
            row["free_total"] = round(row["free_writeoff"] + row["free_onboarding"], 3)
            rows.append(row)
            print(f"{rname:34s} | {aname:26s} "
                  f"結算 {row['settled']:8.1f} 成交率 {row['fill']:.3f} "
                  f"壞帳 {row['bad']:7.1f} 洗量佔比 {row['wash']:.3f} "
                  f"每身分白拿 {row['free_total']:6.2f}"
                  f"（沖銷 {row['free_writeoff']:.2f}／採購 {row['free_onboarding']:.2f}）"
                  f" 入門採購 {row['onb']:7.1f}/{int(row['onb_ids'])} 人")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\n→ {args.out}（{len(rows)} 列，{len(args.seeds)} 種子取中位數）")


if __name__ == "__main__":
    main()
