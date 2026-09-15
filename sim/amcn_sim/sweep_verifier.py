"""Verification-market sweep: price the verifier fee and the canary rate.

§4 #25: the node prototype ships a 4% verifier fee taken from proposal-C's
3–6% range, with nothing behind the choice — this simulator had no verifier
agents at all, so verifier revenue, the stake-to-exposure cap (#7) and the
audit rate's deterrence claim (#8) could not be tested. #20 is the cautionary
precedent: an unswept proposal number turned out to fail GATE-0 G3 under
stress once it was actually simulated.

The grid crosses fee x canary rate against an honest pool and a pool that is
one-third lazy (votes the expected majority without checking), and reports:

  verifier 最低淨收   a verification market only exists if the worst-paid
                      honest node still nets a positive return
  偷懶者被抓率        #8's deterrence claim, measured
  誠實者被沒收        the cost the canary imposes on ordinary competence
                      error, which proposal-C's design does not separate
                      from cheating
  經手/押金比         #7's cap of stake x 3
  G3/G4/G5            the standing GATE-0 criteria must still hold

Run:  cd sim && python3 -m amcn_sim.sweep_verifier [--agents 250] [--days 56]
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .simulation import run

FEES = [0.0, 0.02, 0.04, 0.06]
CANARIES = [0.0, 0.01, 0.03, 0.05]
LAZY = [0.0, 0.33]


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="amcn_sim.sweep_verifier")
    p.add_argument("--agents", type=int, default=250)
    p.add_argument("--days", type=int, default=56)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--out", default="out/sweep_verifier.csv")
    args = p.parse_args(argv)

    rows = []
    hdr = (f"{'fee':>5} {'canary':>7} {'lazy':>5} | {'G3':>4} {'G4':>4} {'G5':>4} | "
           f"{'V最低淨收':>9} {'V平均':>7} {'偷懶被抓':>8} {'誠實沒收':>8} "
           f"{'金絲雀%':>7} {'經手/押金':>9} {'成交%':>6} {'結算CC':>8}")
    print(hdr)
    print("-" * len(hdr))
    for lazy in LAZY:
        for fee in FEES:
            for can in CANARIES:
                rep = run(args.agents, args.days, args.seed, "baseline",
                          starter_cc=50.0, risk_thin=0.06, risk_base=0.02,
                          verifier_rate=fee, canary_rate=can,
                          verifier_lazy_frac=lazy)
                g3 = rep.bad_debt_cc <= rep.insurance_income_cc
                g4 = (rep.median_debt_cycle_days or 99) < 30
                g5 = rep.fill_rate >= 0.8
                # With no lazy verifiers, every slash is an honest node
                # punished for ordinary error.
                honest_slash = rep.slashed_cc if lazy == 0.0 else None
                det = ('n/a' if rep.lazy_detect_rate is None
                       else f"{rep.lazy_detect_rate * 100:.1f}%")
                print(f"{fee:>5.0%} {can:>7.0%} {lazy:>5.0%} | "
                      f"{'PASS' if g3 else 'FAIL':>4} "
                      f"{'PASS' if g4 else 'FAIL':>4} "
                      f"{'PASS' if g5 else 'FAIL':>4} | "
                      f"{rep.min_verifier_revenue_cc:>9.2f} "
                      f"{rep.mean_verifier_revenue_cc:>7.2f} "
                      f"{det:>8} "
                      f"{('-' if honest_slash is None else f'{honest_slash:.2f}'):>8} "
                      f"{rep.canary_share_of_volume * 100:>7.2f} "
                      f"{('n/a' if rep.max_exposure_ratio is None else f'{rep.max_exposure_ratio:.2f}'):>9} "
                      f"{rep.fill_rate * 100:>6.1f} {rep.settled_cc:>8.0f}")
                rows.append({
                    "verifier_rate": fee, "canary_rate": can,
                    "lazy_frac": lazy,
                    "g3_pass": g3, "g4_pass": g4, "g5_pass": g5,
                    "min_verifier_revenue_cc": round(rep.min_verifier_revenue_cc, 3),
                    "mean_verifier_revenue_cc": round(rep.mean_verifier_revenue_cc, 3),
                    "lazy_detect_rate": rep.lazy_detect_rate,
                    "slashed_cc": round(rep.slashed_cc, 3),
                    "canary_caught": rep.canary_caught,
                    "canary_missed": rep.canary_missed,
                    "canary_share_of_volume": round(rep.canary_share_of_volume, 5),
                    "max_exposure_ratio": rep.max_exposure_ratio,
                    "fill_rate": round(rep.fill_rate, 4),
                    "settled_cc": round(rep.settled_cc, 1),
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
