"""保管費（demurrage）掃描：它能不能把正餘額逼回流通，以及它當收益的代價。

起因是 Owner 的提議（登記簿 #66）與同一天量到的三個缺口：#62（verifier 只進
不出，原型 soak 每位 +11.9 CC）、#64（結構性順差者累到 +73.97 CC、零流動）、
FR-056「正餘額無處可花」。§2.2 早就把 demurrage 列為 Hub 可執行的非雙簽分錄，
但費率從未定過，也沒有人量過它的效果。

兩個問題要分開回答：
  1. 回流：閒置保管費能不能提高流通速度、降低「貼上限」比例？
  2. 收益：收進 Treasury 的錢是收益還是只是換一個吸收端？

所以 dest 有兩種：treasury（收益）與 redistribute（分回活躍交易者）。
idle_days=0 表示對所有正餘額收（純抽稅），>0 表示只對不動的收（鼓勵流動）。

Run:  cd sim && python3 -u -m amcn_sim.sweep_demurrage
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .simulation import run

RATES = [0.0, 0.002, 0.005, 0.01]        # 每天對正餘額的比例
CONFIGS = [
    (0, "treasury", "全額→Treasury"),
    (3, "treasury", "閒置3天→Treasury"),
    (3, "redistribute", "閒置3天→重分配"),
]
SIZES = [10, 50]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.sweep_demurrage")
    p.add_argument("--days", type=int, default=84)
    # 多種子是預設，不是選項：單一種子下各組差異完全落在種子離散之內
    # （結算量 ±930–1220 CC，而組間差異只有數十），一組數字會讓讀者以為
    # 看到了效果。輸出直接給平均與半幅。
    p.add_argument("--seeds", type=int, nargs="+", default=[42, 7, 99])
    p.add_argument("--out", default="out/sweep_demurrage.csv")
    args = p.parse_args(argv)

    import statistics as stx
    rows = []
    hdr = (f"{'N':>3} {'費率/天':>7} {'模式':>16} | {'結算CC':>14} {'流速':>11} "
           f"{'貼上限%':>12} {'verifier持有':>14} {'保管費CC':>8}")
    print(hdr)
    print("-" * len(hdr))
    for n in SIZES:
        for rate in RATES:
            for idle, dest, label in CONFIGS:
                if rate == 0.0 and (idle, dest) != CONFIGS[0][:2]:
                    continue          # 零費率只需要一組對照
                acc = {k: [] for k in
                       ("settled", "vel", "pinned", "vbal", "dem")}
                for seed in args.seeds:
                    rep = run(n, args.days, seed, "baseline",
                              starter_cc=50.0, deadbeat_frac=0.0,
                              n_verifiers=max(3, n // 10),
                              demurrage_rate=rate, demurrage_idle_days=idle,
                              demurrage_dest=dest)
                    tail = rep.daily[-7:] if len(rep.daily) >= 7 else rep.daily
                    acc["settled"].append(rep.settled_cc)
                    acc["vel"].append(rep.credit_velocity_per_month)
                    acc["pinned"].append(
                        sum(d.pinned_frac for d in tail) / len(tail) * 100
                        if tail else 0.0)
                    acc["vbal"].append(rep.verifier_balance_cc)
                    acc["dem"].append(rep.demurrage_collected_cc)
                half = lambda xs: (max(xs) - min(xs)) / 2
                mean = {k: stx.mean(v) for k, v in acc.items()}
                shown = "（無保管費）" if rate == 0.0 else label
                print(f"{n:>3} {rate*100:>6.1f}% {shown:>16} | "
                      f"{mean['settled']:>8.0f}±{half(acc['settled']):<5.0f} "
                      f"{mean['vel']:>6.2f}±{half(acc['vel']):<4.2f} "
                      f"{mean['pinned']:>7.1f}±{half(acc['pinned']):<4.1f} "
                      f"{mean['vbal']:>8.1f}±{half(acc['vbal']):<5.1f} "
                      f"{mean['dem']:>8.1f}")
                rows.append({
                    "n_agents": n, "rate_per_day": rate,
                    "idle_days": idle, "dest": dest, "seeds": len(args.seeds),
                    "settled_cc_mean": round(mean["settled"], 1),
                    "settled_cc_halfspread": round(half(acc["settled"]), 1),
                    "velocity_mean": round(mean["vel"], 3),
                    "velocity_halfspread": round(half(acc["vel"]), 3),
                    "pinned_pct_mean": round(mean["pinned"], 2),
                    "verifier_balance_mean": round(mean["vbal"], 2),
                    "demurrage_cc_mean": round(mean["dem"], 2),
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
