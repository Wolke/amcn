"""Parameter sweep: find the pass/fail boundary of the GATE-0 criteria
across starter credit × risk-fee schedule × deadbeat share
(phase0-results.md round-2 TODO #3).

Run:  cd sim && python3 -m amcn_sim.sweep [--agents 400] [--days 84]
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .simulation import run

STARTERS = [10.0, 20.0, 50.0]
RISKS = [(0.03, 0.01, "3%/1%"), (0.06, 0.02, "6%/2%")]
DEADBEATS = [0.05, 0.15, 0.30]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.sweep")
    p.add_argument("--agents", type=int, default=400)
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--out", default="out/sweep.csv")
    args = p.parse_args(argv)

    rows = []
    hdr = (f"{'starter':>7} {'risk':>6} {'deadbeat':>8} | "
           f"{'G3':>4} {'G4':>4} {'G5':>4} | {'壞帳%':>6} {'保險%':>6} "
           f"{'還債d':>5} {'成交%':>5} {'結算CC':>8} {'未發布u':>8}")
    print(hdr)
    print("-" * len(hdr))
    for starter in STARTERS:
        for r_thin, r_base, r_label in RISKS:
            for db in DEADBEATS:
                rep = run(args.agents, args.days, args.seed, "baseline",
                          starter_cc=starter, risk_thin=r_thin,
                          risk_base=r_base, deadbeat_frac=db)
                g3 = rep.bad_debt_cc <= rep.insurance_income_cc
                g4 = (rep.median_debt_cycle_days or 99) < 30
                g5 = rep.fill_rate >= 0.8
                bad_pct = rep.bad_debt_rate * 100
                ins_pct = (rep.insurance_income_cc / rep.settled_cc * 100
                           if rep.settled_cc else 0.0)
                print(f"{starter:>7.0f} {r_label:>6} {db:>7.0%} | "
                      f"{'PASS' if g3 else 'FAIL':>4} "
                      f"{'PASS' if g4 else 'FAIL':>4} "
                      f"{'PASS' if g5 else 'FAIL':>4} | "
                      f"{bad_pct:>6.2f} {ins_pct:>6.2f} "
                      f"{rep.median_debt_cycle_days or -1:>5.0f} "
                      f"{rep.fill_rate*100:>5.1f} {rep.settled_cc:>8.0f} "
                      f"{rep.unmet_demand_units:>8.0f}")
                rows.append({
                    "starter_cc": starter, "risk": r_label, "deadbeat": db,
                    "g3_pass": g3, "g4_pass": g4, "g5_pass": g5,
                    "bad_debt_pct": round(bad_pct, 3),
                    "insurance_pct": round(ins_pct, 3),
                    "median_debt_days": rep.median_debt_cycle_days,
                    "fill_rate": round(rep.fill_rate, 4),
                    "settled_cc": round(rep.settled_cc, 1),
                    "unmet_units": round(rep.unmet_demand_units, 0),
                    "conservation": rep.conservation_ok,
                })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\nCSV → {out}")


if __name__ == "__main__":
    main()
