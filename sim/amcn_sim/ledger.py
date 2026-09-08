"""Mutual credit ledger with strict conservation (SDD §14.1, FR-050..057).

Every posting set must sum to zero. Balances are derived purely from
postings, so the whole ledger can be rebuilt from the event log
(NFR-006). Special accounts:

- protocol:treasury  — collects transaction fees (FR-057)
- protocol:loss      — absorbs written-off negative balances (bad debt),
                       going negative itself so that Σ balances stays 0.
"""

from __future__ import annotations

from dataclasses import dataclass, field

TREASURY = "protocol:treasury"
LOSS = "protocol:loss"


@dataclass(frozen=True)
class Posting:
    account: str
    amount_cc: float


@dataclass(frozen=True)
class LedgerEvent:
    tick: int
    kind: str  # "settlement" | "write_off" | "starter_grant_revoked" | ...
    contract_id: str
    postings: tuple[Posting, ...]
    meta: dict = field(default_factory=dict, hash=False, compare=False)


class ConservationError(RuntimeError):
    pass


class Ledger:
    def __init__(self) -> None:
        self.events: list[LedgerEvent] = []
        self.balances: dict[str, float] = {}

    def post(self, tick: int, kind: str, contract_id: str,
             postings: list[Posting], meta: dict | None = None) -> LedgerEvent:
        total = sum(p.amount_cc for p in postings)
        if abs(total) > 1e-9:
            raise ConservationError(
                f"postings for {contract_id} sum to {total}, not 0")
        ev = LedgerEvent(tick, kind, contract_id, tuple(postings), meta or {})
        self.events.append(ev)
        for p in postings:
            self.balances[p.account] = self.balances.get(p.account, 0.0) + p.amount_cc
        return ev

    def settle(self, tick: int, contract_id: str, requester: str,
               provider: str, price_cc: float, fee_cc: float) -> LedgerEvent:
        return self.post(tick, "settlement", contract_id, [
            Posting(requester, -price_cc),
            Posting(provider, price_cc - fee_cc),
            Posting(TREASURY, fee_cc),
        ])

    def write_off(self, tick: int, account: str) -> float:
        """Absorb a defaulted negative balance into protocol:loss."""
        bal = self.balances.get(account, 0.0)
        if bal >= 0:
            return 0.0
        self.post(tick, "write_off", f"writeoff:{account}:{tick}", [
            Posting(account, -bal),
            Posting(LOSS, bal),
        ])
        return -bal

    def balance(self, account: str) -> float:
        return self.balances.get(account, 0.0)

    def assert_conserved(self) -> None:
        total = sum(self.balances.values())
        if abs(total) > 1e-6:
            raise ConservationError(f"ledger sum = {total}, expected 0")

    def rebuild_and_verify(self) -> None:
        """Prove NFR-006: balances are reconstructible from events alone."""
        rebuilt: dict[str, float] = {}
        for ev in self.events:
            for p in ev.postings:
                rebuilt[p.account] = rebuilt.get(p.account, 0.0) + p.amount_cc
        for acct, bal in self.balances.items():
            if abs(rebuilt.get(acct, 0.0) - bal) > 1e-6:
                raise ConservationError(f"rebuild mismatch on {acct}")
