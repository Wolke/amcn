"""Credit-line algorithm tests (SDD §14.3, FR-053, FR-061/062).

The properties tested here are the ones the design leans on:
new identities get little credit, diverse verified contribution grows it,
concentrated (wash-style) volume must not grow it as fast, and the
network-wide hard cap holds.
"""

import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from amcn_sim.agents import TICKS_PER_DAY, Agent, credit_limit


def make_agent(aid="agent:t") -> Agent:
    return Agent(aid=aid, rng=random.Random(0))


class TestCreditLimit(unittest.TestCase):
    def test_new_identity_gets_bounded_starter(self):
        a = make_agent()
        limit = credit_limit(a, tick=0)
        self.assertGreater(limit, 0.0)      # P-05: some credit must exist
        self.assertLessEqual(limit, 20.0)   # Sybil cost: starter is small

    def test_age_alone_never_exceeds_starter_cap(self):
        """Sitting idle for a year must not mint credit (FR-053)."""
        a = make_agent()
        limit = credit_limit(a, tick=365 * TICKS_PER_DAY)
        self.assertLessEqual(limit, 20.0 * 1.01)

    def test_diverse_contribution_beats_concentrated(self):
        """FR-062: same earned volume, wash pair must get less credit."""
        tick = 60 * TICKS_PER_DAY
        diverse, washer = make_agent("agent:d"), make_agent("agent:w")
        for a in (diverse, washer):
            a.tasks_completed = 100
        for i in range(10):
            diverse.counterparties.add(f"agent:c{i}")
            diverse.counterparty_volume[f"agent:c{i}"] = 100.0
        washer.counterparties.add("agent:partner")
        washer.counterparty_volume["agent:partner"] = 1000.0
        self.assertGreater(credit_limit(diverse, tick),
                           2 * credit_limit(washer, tick))

    def test_disputes_shrink_credit(self):
        tick = 60 * TICKS_PER_DAY
        clean, disputed = make_agent("agent:ok"), make_agent("agent:bad")
        for a in (clean, disputed):
            a.tasks_completed = 90
            for i in range(8):
                a.counterparties.add(f"agent:c{i}")
                a.counterparty_volume[f"agent:c{i}"] = 50.0
        disputed.tasks_failed = 10
        disputed.disputes = 10
        self.assertLess(credit_limit(disputed, tick),
                        credit_limit(clean, tick))

    def test_mixed_wash_strategy_defeated(self):
        """Phase 0 finding F-1: wash pair that ALSO trades honestly must
        not out-credit a purely honest agent with the same total volume.
        Requires the T_flow weight, hence a peers dict."""
        tick = 60 * TICKS_PER_DAY
        honest = make_agent("agent:h")
        washer = make_agent("agent:w")
        partner = make_agent("agent:p")
        honest.tasks_completed = washer.tasks_completed = 100

        # honest: 1200 CC earned across 8 counterparties
        peers = {"agent:h": honest, "agent:w": washer, "agent:p": partner}
        for i in range(8):
            c = make_agent(f"agent:c{i}")
            peers[c.aid] = c
            honest.counterparties.add(c.aid)
            honest.counterparty_volume[c.aid] = 150.0
            c.paid_volume[honest.aid] = 150.0
            c.paid_volume["agent:elsewhere"] = 600.0  # diversified payers

        # washer: 1000 CC wash from partner + 200 CC honest from 4 others
        washer.counterparties.add(partner.aid)
        washer.counterparty_volume[partner.aid] = 1000.0
        partner.paid_volume[washer.aid] = 1000.0
        partner.paid_volume["agent:elsewhere"] = 100.0  # concentrated payer
        for i in range(4):
            c = peers[f"agent:c{i}"]
            washer.counterparties.add(c.aid)
            washer.counterparty_volume[c.aid] = 50.0
            c.paid_volume[washer.aid] = 50.0

        self.assertGreater(credit_limit(honest, tick, peers),
                           credit_limit(washer, tick, peers))

    def test_hard_cap_and_offline(self):
        a = make_agent()
        a.tasks_completed = 10_000
        for i in range(200):
            a.counterparties.add(f"agent:c{i}")
            a.counterparty_volume[f"agent:c{i}"] = 1_000.0
        self.assertLessEqual(credit_limit(a, 365 * TICKS_PER_DAY), 500.0)
        a.online = False
        self.assertEqual(credit_limit(a, 365 * TICKS_PER_DAY), 0.0)


if __name__ == "__main__":
    unittest.main()
