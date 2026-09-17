"""最小可行網路規模：N × 費率 → 經濟觸底時間（登記簿 #61）。

起因是原型的 40 分鐘無人 soak：292 筆結算後三個交易者全部貼著信用上限、
最後 12 分鐘零成交。手續費每筆帶走 8.5% 且永不回流，而 F-1 的反洗量折減
在對手極少時幾乎把 E_eff 壓成零——抽乾速度快過額度成長，必然鎖死。

GATE-0 跑 400 個 agent 時多樣性足夠，這個效應應該弱得多，但**從來沒有人
量過它與 N 的關係**。這支掃描回答的就是：多小算太小，以及費率把那條線推
到哪裡。零費率組是對照——如果它不鎖死，機制就確定是抽乾而不是別的東西。

Run:  cd sim && python3 -u -m amcn_sim.sweep_size
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .simulation import run

SIZES = [3, 5, 10, 25, 50, 100]
# (risk_thin, risk_base, fee-ish label)。零費率是對照組，不是候選參數。
FEES = [(0.0, 0.0, "0%/0%"), (0.03, 0.01, "3%/1%"), (0.06, 0.02, "6%/2%")]
QUIET_DAYS = 5          # 連續幾天幾乎沒有新結算就算觸底


def deadlock_day(daily, quiet_days: int = QUIET_DAYS) -> int | None:
    """第一天之後連續 quiet_days 天累計結算幾乎不動 → 視為觸底。

    用「幾乎不動」而不是「完全不動」，因為單筆殘餘交易不代表市場還活著。
    """
    if len(daily) < quiet_days + 2:
        return None
    total = daily[-1].settled_cc_cum or 1.0
    eps = total * 0.002                     # 每天 <0.2% 的成長視為停滯
    for i in range(1, len(daily) - quiet_days):
        window = daily[i:i + quiet_days + 1]
        if window[-1].settled_cc_cum - window[0].settled_cc_cum < eps * quiet_days:
            # 只在已經有實質交易之後才算觸底，否則會把暖機期誤判成鎖死
            if window[0].settled_cc_cum > total * 0.05:
                return window[0].day
    return None


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.sweep_size")
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--out", default="out/sweep_size.csv")
    args = p.parse_args(argv)

    rows = []
    hdr = (f"{'N':>4} {'費率':>7} | {'觸底日':>6} {'期末成交%':>9} "
           f"{'額度用盡%':>9} {'貼上限%':>8} {'protocol佔比%':>12} "
           f"{'結算CC':>9} {'還債d':>6}")
    print(hdr)
    print("-" * len(hdr))
    for n in SIZES:
        for r_thin, r_base, label in FEES:
            rep = run(n, args.days, args.seed, "baseline",
                      starter_cc=50.0, risk_thin=r_thin, risk_base=r_base,
                      deadbeat_frac=0.0,          # 沒有違約者：只看抽乾效應
                      n_verifiers=max(3, n // 10))
            daily = rep.daily
            dl = deadlock_day(daily)
            last = daily[-1] if daily else None
            # 額度用盡程度：期末總負債 ÷ 總信用額度
            util = (last.total_debt_cc / last.total_credit_cc * 100
                    if last and last.total_credit_cc else 0.0)
            # protocol 帳戶吸走了多少（相對於結算量）
            proto = ((rep.treasury_cc + rep.insurance_balance_cc) / rep.settled_cc * 100
                     if rep.settled_cc else 0.0)
            tail = daily[-7:] if len(daily) >= 7 else daily
            tail_fill = sum(d.fill_rate for d in tail) / len(tail) * 100 if tail else 0.0
            pinned = (sum(d.pinned_frac for d in tail) / len(tail) * 100
                      if tail else 0.0)
            print(f"{n:>4} {label:>7} | {str(dl) if dl else '—':>6} "
                  f"{tail_fill:>9.1f} {util:>9.1f} {pinned:>8.1f} {proto:>12.1f} "
                  f"{rep.settled_cc:>9.0f} "
                  f"{(rep.median_debt_cycle_days or -1):>6.0f}")
            rows.append({
                "n_agents": n, "fee": label, "deadlock_day": dl,
                "tail_fill_pct": round(tail_fill, 2),
                "credit_utilisation_pct": round(util, 2),
                "pinned_pct": round(pinned, 2),
                "protocol_share_pct": round(proto, 2),
                "settled_cc": round(rep.settled_cc, 1),
                "median_debt_days": rep.median_debt_cycle_days,
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
