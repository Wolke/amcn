"""淨流入費掃描：對**流量**收費能不能做到保管費對**存量**做不到的事。

起因是 2026-09-20 的四小時原型量測。兩種吸收端的期末分佈一樣（一個帳戶持有
全部正餘額），機制卻完全不同，而逐帳戶的**留存率＝淨額÷流入**才分得開：

  純 verifier          收 859  付    5  → 留存 99.4%   設計上不消費（存量問題）
  雙角色的累積者       收 8840 付 6809  → 留存 23.0%   花掉四分之三（流量問題）

保管費（#66）打的是存量，對前者對症；對後者，要抽乾它就得追上它的淨流入
速度。所以這裡收的基數是「這一期餘額長了多少」而不是「持有多少」——對高
吞吐但會花錢的人近乎免費，對單調累積者正比於累積速度。

兩個問題分開問，與 #66 同一個結構：
  1. 回流：它能不能提高流通、壓低貼上限比例？
  2. 收益 vs 抽稅：收進 Treasury 是不是只換一個吸收端（#61 量到 protocol
     帳戶只進不出）？所以 dest 有 treasury 與 redistribute 兩種。

**單一種子會騙人**：#66 的掃描發現組間差異完全落在種子離散之內。所以多種子
是預設而不是選項，輸出直接給平均與半幅，讓讀者自己判斷差異有沒有意義。

Run:  cd sim && python3 -u -m amcn_sim.sweep_inflow
"""

from __future__ import annotations

import argparse
import csv
import statistics as stx
from pathlib import Path

from .simulation import run

RATES = [0.0, 0.10, 0.25, 0.50]      # 對當期淨流入的比例
DESTS = [("treasury", "→Treasury"), ("redistribute", "→重分配")]
SIZES = [10, 50]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.sweep_inflow")
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--seeds", type=int, nargs="+", default=[42, 7, 99])
    p.add_argument("--out", default="out/sweep_inflow.csv")
    args = p.parse_args(argv)

    rows = []
    hdr = (f"{'N':>3} {'費率':>6} {'模式':>11} | {'結算CC':>14} {'流速':>11} "
           f"{'貼上限%':>12} {'verifier持有':>14} {'Gini':>11} {'收取CC':>8}")
    print(hdr)
    print("-" * len(hdr))
    for n in SIZES:
        for rate in RATES:
            for dest, label in DESTS:
                if rate == 0.0 and dest != DESTS[0][0]:
                    continue          # 零費率只需要一組對照
                acc: dict[str, list[float]] = {
                    k: [] for k in ("settled", "vel", "pinned", "vbal",
                                    "gini", "fee")}
                for seed in args.seeds:
                    rep = run(n, args.days, seed, "baseline",
                              starter_cc=50.0, deadbeat_frac=0.0,
                              n_verifiers=max(3, n // 10),
                              inflow_fee_rate=rate, inflow_fee_dest=dest)
                    tail = rep.daily[-7:] if len(rep.daily) >= 7 else rep.daily
                    acc["settled"].append(rep.settled_cc)
                    acc["vel"].append(rep.credit_velocity_per_month)
                    acc["pinned"].append(
                        sum(d.pinned_frac for d in tail) / len(tail) * 100
                        if tail else 0.0)
                    acc["vbal"].append(rep.verifier_balance_cc)
                    acc["gini"].append(rep.gini_balances)
                    acc["fee"].append(rep.inflow_fee_collected_cc)
                half = lambda xs: (max(xs) - min(xs)) / 2   # noqa: E731
                mean = {k: stx.mean(v) for k, v in acc.items()}
                shown = "（無流入費）" if rate == 0.0 else label
                print(f"{n:>3} {rate*100:>5.0f}% {shown:>11} | "
                      f"{mean['settled']:>8.0f}±{half(acc['settled']):<5.0f} "
                      f"{mean['vel']:>6.2f}±{half(acc['vel']):<4.2f} "
                      f"{mean['pinned']:>7.1f}±{half(acc['pinned']):<4.1f} "
                      f"{mean['vbal']:>8.1f}±{half(acc['vbal']):<5.1f} "
                      f"{mean['gini']:>6.3f}±{half(acc['gini']):<4.3f} "
                      f"{mean['fee']:>8.1f}")
                rows.append({
                    "n_agents": n, "rate_of_net_inflow": rate, "dest": dest,
                    "seeds": len(args.seeds),
                    "settled_cc_mean": round(mean["settled"], 1),
                    "settled_cc_halfspread": round(half(acc["settled"]), 1),
                    "velocity_mean": round(mean["vel"], 3),
                    "velocity_halfspread": round(half(acc["vel"]), 3),
                    "pinned_pct_mean": round(mean["pinned"], 2),
                    "pinned_pct_halfspread": round(half(acc["pinned"]), 2),
                    "verifier_balance_mean": round(mean["vbal"], 2),
                    "gini_mean": round(mean["gini"], 4),
                    "gini_halfspread": round(half(acc["gini"]), 4),
                    "inflow_fee_cc_mean": round(mean["fee"], 2),
                })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\n{len(rows)} 組 → {out}")


if __name__ == "__main__":
    main()
