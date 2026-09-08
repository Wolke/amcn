"""End-to-end simulation tests: short runs must satisfy the invariants
the Phase 0 report depends on (SDD §19, §20-4, §27 loop)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from amcn_sim.simulation import SCENARIOS, run


class TestSimulationRuns(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = run(n_agents=100, days=21, seed=7, scenario="baseline")

    def test_conservation_and_rebuild(self):
        """SDD §20-4: all balance changes reconstructible, Σ = 0."""
        self.assertTrue(self.report.conservation_ok)

    def test_market_actually_trades(self):
        self.assertGreater(self.report.settled_cc, 0.0)
        self.assertGreater(self.report.fill_rate, 0.0)
        self.assertLessEqual(self.report.fill_rate, 1.0)

    def test_debt_cycle_exists_and_closes(self):
        """§27 loop: someone went negative and came back to ≥ 0."""
        self.assertIsNotNone(self.report.mean_debt_cycle_days)
        self.assertGreater(self.report.mean_debt_cycle_days, 0.0)

    def test_same_seed_is_deterministic(self):
        again = run(n_agents=100, days=21, seed=7, scenario="baseline")
        self.assertAlmostEqual(again.settled_cc, self.report.settled_cc)
        self.assertEqual(again.failed_verifications,
                         self.report.failed_verifications)

    def test_bad_debt_never_negative(self):
        self.assertGreaterEqual(self.report.bad_debt_rate, 0.0)


class TestScenarios(unittest.TestCase):
    def test_all_scenarios_conserve(self):
        for name in SCENARIOS:
            rep = run(n_agents=60, days=14, seed=11, scenario=name)
            self.assertTrue(rep.conservation_ok, f"scenario {name}")

    def test_high_default_writes_off_debt(self):
        """§16 threat 13: vanished debtors become measured bad debt,
        and the write-off itself keeps the ledger conserved."""
        rep = run(n_agents=150, days=60, seed=3, scenario="high_default")
        self.assertTrue(rep.conservation_ok)
        self.assertGreater(rep.bad_debt_cc, 0.0)


if __name__ == "__main__":
    unittest.main()
