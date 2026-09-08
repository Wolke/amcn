"""AMCN Phase 0 economic simulation (SDD §19).

Simulates 100–10,000 agents exchanging inference capacity through a
mutual-credit ledger. No real model calls are made. The goal is to
falsify (or support) the risk assumptions in SDD §26:

- Do quota-exhausted agents find providers within acceptable wait times?
- Do negative balances get repaid once quotas reset?
- How much bad debt do deadbeat owners create under a given credit-line policy?
- Does month-end quota expiry crash prices?
- Does wash trading between colluding agents inflate credit lines?

Key outputs (SDD §19 Phase 0): fill rate, wait time, Gini, debt-cycle
duration, bad-debt rate, credit velocity.
"""

__version__ = "0.1.0"
