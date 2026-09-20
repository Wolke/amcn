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
INFLOW_POOL = "protocol:inflow_fee"
# 保證金託管帳戶。抵押時為負（持有人把 CC 移進來即形成該帳戶的負餘額側），
# 沒收時沖銷——與 Treasury 分開，因為它不是收入。
COLLATERAL = "protocol:collateral"
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

    def write_off(self, tick: int, account: str,
                  collateral_cc: float = 0.0) -> float:
        """Absorb a defaulted negative balance: 保證金 → 保險池 → protocol:loss.

        保證金先賠（登記簿 #65）：它是抵押品，存在的目的就是在這一刻被拿走。
        順序重要——先扣保證金才看得出保險池真正承擔了多少。
        """
        bal = self.balances.get(account, 0.0)
        if bal >= 0:
            return 0.0
        debt = -bal
        from_col = min(debt, max(0.0, collateral_cc))
        self.last_collateral_seized = from_col
        if from_col > 0:
            # 保證金由持有人提供，記為對該帳戶的抵扣：Σ 仍為 0。
            self.post(tick, "collateral_seized", f"collateral:{account}:{tick}",
                      [Posting(account, from_col), Posting(COLLATERAL, -from_col)])
            debt -= from_col
            if debt <= 1e-12:
                return from_col
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

    def inflow_fee(self, tick: int, account: str, amount: float,
                   dest: str) -> float:
        """對**當期淨流入**收費，轉給 dest（登記簿 #66 的流量側）。

        為什麼需要一條與 demurrage 分開的路徑：四小時原型量到兩種吸收端，
        期末分佈一樣（一個帳戶持有全部正餘額），機制卻完全不同——用逐帳戶
        的**留存率＝淨額÷流入**才分得開。純 verifier 收 859 付 5、留存
        99.4%，它是**存量**問題，demurrage 對症；#62 階段 4 之後的累積者收
        8,840 付 6,809、留存 23.0%，它把四分之三都花掉了，集中來自**吞吐量
        不對稱**——那是**流量**問題，而存量費要抽乾它就得追上淨流入速度。

        所以這裡收的基數是「這一期餘額長了多少」而不是「持有多少」：
        對高吞吐但把錢花掉的參與者近乎免費，對單調累積者則正比於它累積的
        速度。Σ 仍為 0（搬移而非鑄造，FR-051），且與 demurrage 同樣屬
        §2.2 列舉的非雙簽 posting，需要預簽的費率表 Grant。

        回傳實際收取的金額；正餘額不足時不收（不會把帳戶推成負的）。
        """
        bal = self.balances.get(account, 0.0)
        take = min(max(0.0, amount), max(0.0, bal))
        if take <= 1e-12:
            return 0.0
        self.post(tick, "inflow_fee", f"inflow_fee:{account}:{tick}",
                  [Posting(account, -take), Posting(dest, take)])
        return take

    def protocol_rebate(self, tick: int, source: str,
                        shares: dict[str, float]) -> float:
        """把 protocol 帳戶累積的餘額退還給活躍交易者（登記簿 #61／#71）。

        為什麼需要這條路徑：protocol 帳戶只進不出，意味著它們持有的每一塊 CC
        都是**永久借出去的信用**。所以在沒有結構性淨賣方的小網路裡，交易者的
        總負債只會隨成交量單調成長，直到全部貼上信用上限——成交量被
        `Σ額度 ÷ 費率` 封頂。原型 40 分鐘 soak 正是這個結局（最後 12 分鐘
        零成交，三人全部貼牆）。

        §2.2「Treasury 啟動」把回流列為設計的一部分（金絲雀、逆週期收購、
        L_boot 補貼），條件是計入有治理上限的創世補貼額度、全部
        tx_class=subsidy。這裡實作的是其中最直接的一種：退還已收取的費用。

        與 demurrage 的差別要講清楚：demurrage 是**向持有者收費**（#66 量到
        那只是把一個吸收端換成另一個），這條是**把已收的費用還出去**。方向
        相反，目的也不同。

        **第一版只針對 Treasury，而量測打掉了那個選擇**：模擬器裡 Treasury
        在 N=3／10／50 全部是**負的**（金絲雀支出大於費收），真正累積的是保險
        池與 verifier 持有量；原型 soak 的 122.53 CC 裡保險池佔 75.90（62%），
        因為三個 agent 永遠是 thin、每筆 6% 進保險池。所以這個方法取
        `source` 而不是寫死 Treasury——「哪個帳戶在吸」是實測問題。

        Σ=0 仍然成立（搬移而非鑄造，FR-051）。回傳實際退還的總額。
        """
        total = sum(max(0.0, v) for v in shares.values())
        bal = self.balances.get(source, 0.0)
        if total <= 1e-12 or bal <= 1e-12:
            return 0.0
        if total > bal:            # 不得讓來源帳戶因退費而轉負
            scale = bal / total
            shares = {k: v * scale for k, v in shares.items()}
            total = bal
        self.post(tick, "protocol_rebate", f"rebate:{source}:{tick}",
                  [Posting(source, -total)] +
                  [Posting(a, v) for a, v in shares.items() if v > 1e-12])
        return total

    # 上一次 write_off 沒收到的保證金金額。呼叫端要分辨「保證金賠掉多少」
    # 與「保險池賠掉多少」，而 write_off 的回傳值是總吸收額。
    last_collateral_seized: float = 0.0

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
