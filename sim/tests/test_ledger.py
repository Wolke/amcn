"""Layer-1 correctness tests: the ledger can never lose or invent money.

Run:  python3 -m unittest discover -s sim/tests -v
(or:  python3 -m pytest sim/tests)
"""

import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from amcn_sim.ledger import (INSURANCE, LOSS, TREASURY, ConservationError,
                             Ledger, Posting)


class TestConservation(unittest.TestCase):
    def test_unbalanced_postings_rejected(self):
        led = Ledger()
        with self.assertRaises(ConservationError):
            led.post(0, "settlement", "bad", [
                Posting("agent:a", -10.0),
                Posting("agent:b", 9.0),  # 1 CC vanishes → must raise
            ])
        # rejected event must not leave partial state behind
        self.assertEqual(led.events, [])
        self.assertEqual(led.balances, {})

    def test_settle_moves_exact_amounts(self):
        led = Ledger()
        led.settle(1, "t1", "agent:a", "agent:b", price_cc=80.0, fee_cc=2.0)
        self.assertAlmostEqual(led.balance("agent:a"), -80.0)
        self.assertAlmostEqual(led.balance("agent:b"), 78.0)
        self.assertAlmostEqual(led.balance(TREASURY), 2.0)
        led.assert_conserved()

    def test_random_settlement_storm_stays_conserved(self):
        rng = random.Random(1234)
        led = Ledger()
        accounts = [f"agent:{i}" for i in range(20)]
        for tick in range(2000):
            a, b = rng.sample(accounts, 2)
            price = rng.uniform(0.5, 120.0)
            led.settle(tick, f"t{tick}", a, b, price, price * 0.025)
        led.assert_conserved()
        led.rebuild_and_verify()

    def test_write_off_absorbs_debt_and_conserves(self):
        led = Ledger()
        led.settle(1, "t1", "agent:dead", "agent:b", 50.0, 1.0)
        recovered = led.write_off(2, "agent:dead")
        self.assertAlmostEqual(recovered, 50.0)
        self.assertAlmostEqual(led.balance("agent:dead"), 0.0)
        self.assertAlmostEqual(led.balance(LOSS), -50.0)
        led.assert_conserved()

    def test_write_off_noop_on_non_negative(self):
        led = Ledger()
        led.settle(1, "t1", "agent:a", "agent:b", 10.0, 0.0)
        self.assertEqual(led.write_off(2, "agent:b"), 0.0)   # positive
        self.assertEqual(led.write_off(2, "agent:new"), 0.0)  # zero/unknown
        self.assertNotIn(LOSS, led.balances)

    def test_risk_fee_goes_to_insurance(self):
        led = Ledger()
        led.settle(1, "t1", "agent:a", "agent:b", 100.0, 2.5, risk_cc=2.0)
        self.assertAlmostEqual(led.balance("agent:b"), 95.5)
        self.assertAlmostEqual(led.balance(INSURANCE), 2.0)
        led.assert_conserved()

    def test_write_off_drains_insurance_before_loss(self):
        """Phase 0 finding F-2: insurance pool is the first absorber."""
        led = Ledger()
        led.settle(1, "t1", "agent:x", "agent:b", 100.0, 0.0, risk_cc=30.0)
        led.settle(2, "t2", "agent:dead", "agent:b", 50.0, 0.0, risk_cc=0.0)
        led.write_off(3, "agent:dead")   # debt 50, insurance holds 30
        self.assertAlmostEqual(led.balance("agent:dead"), 0.0)
        self.assertAlmostEqual(led.balance(INSURANCE), 0.0)   # fully drained
        self.assertAlmostEqual(led.balance(LOSS), -20.0)      # remainder
        led.assert_conserved()
        led.rebuild_and_verify()

    def test_rebuild_matches_running_balances(self):
        """NFR-006: balances must be a pure function of the event log."""
        led = Ledger()
        led.settle(1, "t1", "agent:a", "agent:b", 30.0, 1.0)
        led.settle(2, "t2", "agent:b", "agent:c", 15.0, 0.5)
        led.write_off(3, "agent:a")
        led.rebuild_and_verify()  # raises on any mismatch


if __name__ == "__main__":
    unittest.main()
