"""Repayment-policy sweep: settle the 還債折價 and target-band arguments.

W7 delivered the repayment scheduler and target band (FR-055 / UC-02), and
three sources disagreed on its two numbers:

  repay discount   proposal-B §8.4 says 10%; this simulator has always used
                   35%; node/lib/strategy.js shipped 10% from the proposal.
  band low bound   §8.4 says -0.3 x CL; this simulator used a fixed -5.0 CC.

CLAUDE.md makes the simulation the regression gate for economic parameters,
so the numbers come from here rather than from whichever document was read
last. The grid crosses discount x band definition and reports the GATE-0
criteria plus the two liquidity metrics §8.4 asks about: credit velocity and
median debt-cycle days.

Run:  cd sim && python3 -m amcn_sim.sweep_repay [--agents 400] [--days 84]
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .simulation import run

DISCOUNTS = [0.0, 0.10, 0.20, 0.35, 0.50]
# None = the simulator's historical fixed target_balance_low; the fractions
# are §8.4's "low = frac x CL", which is what the node computes.
BANDS: list[tuple[float | None, str]] = [
    (None, "fixed"),
    (-0.15, "-0.15CL"),
    (-0.30, "-0.30CL"),
]
SCENARIOS = ["baseline", "high_default"]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.sweep_repay")
    p.add_argument("--agents", type=int, default=400)
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--out", default="out/sweep_repay.csv")
    args = p.parse_args(argv)

    rows = []
    hdr = (f"{'scenario':>12} {'disc':>5} {'band':>8} | "
           f"{'G3':>4} {'G4':>4} {'G5':>4} | {'還債d中位':>9} {'流速x':>6} "
           f"{'成交%':>6} {'壞帳%':>6} {'保險%':>6} {'結算CC':>8} {'末週價':>6}")
    print(hdr)
    print("-" * len(hdr))
    for scenario in SCENARIOS:
        for frac, band_label in BANDS:
            for disc in DISCOUNTS:
                rep = run(args.agents, args.days, args.seed, scenario,
                          starter_cc=50.0, risk_thin=0.06, risk_base=0.02,
                          repay_discount=disc, band_low_cl_frac=frac)
                g3 = rep.bad_debt_cc <= rep.insurance_income_cc
                g4 = (rep.median_debt_cycle_days or 99) < 30
                g5 = rep.fill_rate >= 0.8
                ins_pct = (rep.insurance_income_cc / rep.settled_cc * 100
                           if rep.settled_cc else 0.0)
                print(f"{scenario:>12} {disc:>5.0%} {band_label:>8} | "
                      f"{'PASS' if g3 else 'FAIL':>4} "
                      f"{'PASS' if g4 else 'FAIL':>4} "
                      f"{'PASS' if g5 else 'FAIL':>4} | "
                      f"{rep.median_debt_cycle_days or -1:>9.1f} "
                      f"{rep.credit_velocity_per_month:>6.2f} "
                      f"{rep.fill_rate*100:>6.1f} "
                      f"{rep.bad_debt_rate*100:>6.2f} {ins_pct:>6.2f} "
                      f"{rep.settled_cc:>8.0f} "
                      f"{(rep.price_last_week or 0):>6.2f}")
                rows.append({
                    "scenario": scenario,
                    "repay_discount": disc,
                    "band_low": band_label,
                    "g3_pass": g3, "g4_pass": g4, "g5_pass": g5,
                    "median_debt_days": rep.median_debt_cycle_days,
                    "credit_velocity_per_month":
                        round(rep.credit_velocity_per_month, 4),
                    "fill_rate": round(rep.fill_rate, 4),
                    "bad_debt_pct": round(rep.bad_debt_rate * 100, 3),
                    "insurance_pct": round(ins_pct, 3),
                    "settled_cc": round(rep.settled_cc, 1),
                    "price_last_week": rep.price_last_week,
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
