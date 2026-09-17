"""Mutual credit ledger with strict conservation (SDD §14.1, FR-050..057).

Every posting set must sum to zero. Balances are derived purely from
postings, so the whole ledger can be rebuilt from the event log
(NFR-006). Special accounts:

- protocol:treasury  — collects base protocol fees (FR-057)
- protocol:insurance — collects risk fees; first line of bad-debt absorption
                       (Phase 0 finding F-2: base fee alone can't cover a
                       high-default population)
- protocol:loss      — absorbs write-offs beyond the insurance pool,
                       going negative itself so that Σ balances stays 0.
"""

from __future__ import annotations

from dataclasses import dataclass, field

TREASURY = "protocol:treasury"
INSURANCE = "protocol:insurance"
# 保管費的中繼帳戶（#66 的 redistribute 模式）。刻意與 Treasury 分開：收益
# 與回流是兩個不同的目的，混在同一個帳戶裡就分不出哪一筆錢在做哪件事。
DEMURRAGE_POOL = "protocol:demurrage"
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
               provider: str, price_cc: float, fee_cc: float,
               risk_cc: float = 0.0,
               verifier_payouts: list[tuple[str, float]] | None = None
               ) -> LedgerEvent:
        # Verifier compensation is an explicit posting, not a silent
        # deduction (§4 #5 / A⑦ / C⑤: it used to vanish from the journal
        # entry). It comes out of the provider's gross so the requester still
        # pays exactly the contract price.
        payouts = verifier_payouts or []
        verifier_total = sum(amt for _, amt in payouts)
        postings = [
            Posting(requester, -price_cc),
            Posting(provider, price_cc - fee_cc - risk_cc - verifier_total),
            Posting(TREASURY, fee_cc),
        ]
        if risk_cc > 0:
            postings.append(Posting(INSURANCE, risk_cc))
        postings.extend(Posting(aid, amt) for aid, amt in payouts)
        return self.post(tick, "settlement", contract_id, postings)

    def slash(self, tick: int, contract_id: str, verifier: str,
              amount_cc: float) -> LedgerEvent:
        """Canary failure: stake moves from the verifier to the insurance
        pool, which is what funds the next canary batch."""
        return self.post(tick, "slash", contract_id, [
            Posting(verifier, -amount_cc),
            Posting(INSURANCE, amount_cc),
        ])

    def canary_spend(self, tick: int, contract_id: str, provider: str,
                     price_cc: float,
                     verifier_payouts: list[tuple[str, float]] | None = None
                     ) -> LedgerEvent:
        """Treasury pays for a decoy task with a known answer (FR-083: marked
        as a test transaction, kept out of the real-volume statistics)."""
        payouts = verifier_payouts or []
        verifier_total = sum(amt for _, amt in payouts)
        postings = [
            Posting(TREASURY, -price_cc),
            Posting(provider, price_cc - verifier_total),
        ]
        postings.extend(Posting(aid, amt) for aid, amt in payouts)
        return self.post(tick, "canary", contract_id, postings)

    def write_off(self, tick: int, account: str) -> float:
        """Absorb a defaulted negative balance: insurance pool first,
        protocol:loss for the uncovered remainder."""
        bal = self.balances.get(account, 0.0)
        if bal >= 0:
            return 0.0
        debt = -bal
        from_ins = min(debt, max(0.0, self.balances.get(INSURANCE, 0.0)))
        postings = [Posting(account, debt)]
        if from_ins > 0:
            postings.append(Posting(INSURANCE, -from_ins))
        if debt - from_ins > 1e-12:
            postings.append(Posting(LOSS, -(debt - from_ins)))
        self.post(tick, "write_off", f"writeoff:{account}:{tick}", postings)
        return debt

    def demurrage(self, tick: int, account: str, amount: float,
                  dest: str) -> float:
        """保管費：對持有的正餘額收費，轉給 dest（登記簿 #66）。

        SDD §14.1 與 FR-051 的要求是「不得無來源鑄造正餘額」，這裡是搬移
        而非鑄造，Σ 仍為 0。FR-050 要求每筆變動有雙簽或**可驗證的協議事件**，
        而 final-architecture §2.2 把 demurrage 明列為 Hub 可執行的非雙簽
        分錄之一，條件是引用 Owner 加入網路時預簽的費率表 Grant——在模擬裡
        那個 Grant 是隱含的（所有 agent 視為已簽），在原型裡必須是真的。

        回傳實際收取的金額；正餘額不足時不收（不會把帳戶推成負的）。
        """
        bal = self.balances.get(account, 0.0)
        take = min(max(0.0, amount), max(0.0, bal))
        if take <= 1e-12:
            return 0.0
        self.post(tick, "demurrage", f"demurrage:{account}:{tick}",
                  [Posting(account, -take), Posting(dest, take)])
        return take

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
