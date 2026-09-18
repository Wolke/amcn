"""Metric computation for the Phase 0 report (SDD §19)."""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field

from .agents import TICKS_PER_DAY, Agent
from .ledger import INSURANCE, LOSS, TREASURY, Ledger
from .market import Market


@dataclass
class DailySnapshot:
    day: int
    fill_rate: float
    median_price: float | None
    open_tasks: int
    agents_in_debt: int
    total_debt_cc: float
    total_credit_cc: float
    settled_cc_cum: float
    # 貼著上限的 agent 比例。與 total_debt/total_credit 不同：後者是總量比，
    # 會被幾個健康帳戶稀釋；原型 soak 的特徵是「每一個人」都動不了，那只有
    # 逐帳戶看才看得到（登記簿 #61）。
    pinned_frac: float = 0.0


@dataclass
class Report:
    days: int = 0
    n_agents: int = 0
    fill_rate: float = 0.0
    expired_rate: float = 0.0
    mean_wait_hours: float = 0.0
    p95_wait_hours: float = 0.0
    gini_balances: float = 0.0
    mean_debt_cycle_days: float | None = None
    median_debt_cycle_days: float | None = None
    open_debt_episodes: int = 0
    bad_debt_cc: float = 0.0
    bad_debt_rate: float = 0.0          # written-off / settled
    settled_cc: float = 0.0
    wash_settled_cc: float = 0.0
    wash_share: float = 0.0
    credit_velocity_per_month: float = 0.0
    # Verification market (§4 #25)
    verifier_fees_cc: float = 0.0
    # 期末仍握在 verifier 手上的 CC。與 verifier_fees_cc（收入）不同：#62
    # 的問題不是他們賺多少，而是賺到的錢**留在那裡不動**，離開了交易流通。
    verifier_balance_cc: float = 0.0
    demurrage_collected_cc: float = 0.0
    # 退還給交易者的 Treasury 收入（#61／#71）。`sweep_size` 的
    # protocol_share_pct（(treasury + insurance) ÷ 結算量）扣掉這一項，才是
    # **真正永久離開流通**的金額——這個區別就是整條路徑要證明的東西。
    treasury_rebated_cc: float = 0.0
    insurance_released_cc: float = 0.0
    # 每個違約身分平均拿走多少、保證金沒收多少（#65）。單身分淨賺＝
    # took − seized，就是 Sybil 攻擊的每身分期望收益。
    defaults_n: int = 0
    default_took_avg_cc: float = 0.0
    default_seized_avg_cc: float = 0.0
    default_net_take_avg_cc: float = 0.0
    verifier_fee_share: float = 0.0        # fees / settled volume
    mean_verifier_revenue_cc: float = 0.0
    min_verifier_revenue_cc: float = 0.0
    canary_spend_cc: float = 0.0
    canary_share_of_volume: float = 0.0
    canary_caught: int = 0
    canary_missed: int = 0
    slashed_cc: float = 0.0
    honest_error_forgiven: int = 0  # canary failures under the evidence bar
    lazy_detect_rate: float | None = None  # slashes / lazy-verifier canary votes
    max_exposure_ratio: float | None = None  # single contract / stake (§4 #7)
    unmet_demand_units: float = 0.0
    failed_verifications: int = 0
    treasury_cc: float = 0.0
    insurance_income_cc: float = 0.0
    insurance_balance_cc: float = 0.0
    uncovered_bad_debt_cc: float = 0.0   # write-offs beyond insurance pool
    loss_cc: float = 0.0
    conservation_ok: bool = False
    trace_agent: str | None = None
    trace_lines: list[str] = field(default_factory=list)
    price_first_week: float | None = None
    price_last_week: float | None = None
    mean_credit_limit_honest: float = 0.0
    mean_credit_limit_honest_matched: float | None = None  # similar earnings cohort
    mean_credit_limit_washer: float | None = None
    daily: list[DailySnapshot] = field(default_factory=list)


def gini(values: list[float]) -> float:
    """Gini over min-shifted values (handles negative balances)."""
    if not values:
        return 0.0
    shifted = sorted(v - min(values) for v in values)
    n = len(shifted)
    total = sum(shifted)
    if total == 0:
        return 0.0
    cum = 0.0
    for i, v in enumerate(shifted, 1):
        cum += i * v
    return (2 * cum) / (n * total) - (n + 1) / n


def median_price_in(market: Market, tick_lo: int, tick_hi: int) -> float | None:
    prices = [p for t, p in market.stats.prices_per_unit if tick_lo <= t < tick_hi]
    return statistics.median(prices) if prices else None


def finalize(report: Report, agents: dict[str, Agent], ledger: Ledger,
             market: Market, ticks: int, credit_limit_fn,
             defaults: list[dict] | None = None) -> Report:
    s = market.stats
    report.fill_rate = s.matched / s.posted if s.posted else 0.0
    report.expired_rate = s.expired / s.posted if s.posted else 0.0
    if s.wait_ticks:
        report.mean_wait_hours = statistics.mean(s.wait_ticks)
        sw = sorted(s.wait_ticks)
        report.p95_wait_hours = sw[int(0.95 * (len(sw) - 1))]
    report.gini_balances = gini(
        [ledger.balance(a.aid) for a in agents.values() if a.online])

    cycles = []
    open_eps = 0
    for a in agents.values():
        for ep in a.debt_episodes:
            if ep.end_tick is None:
                open_eps += 1
            else:
                cycles.append((ep.end_tick - ep.start_tick) / TICKS_PER_DAY)
    if cycles:
        report.mean_debt_cycle_days = statistics.mean(cycles)
        report.median_debt_cycle_days = statistics.median(cycles)
    report.open_debt_episodes = open_eps

    report.settled_cc = s.settled_cc
    report.wash_settled_cc = s.wash_settled_cc
    report.wash_share = s.wash_settled_cc / s.settled_cc if s.settled_cc else 0.0
    # total written off = the debtor-side postings of write_off events
    report.bad_debt_cc = sum(
        p.amount_cc for ev in ledger.events if ev.kind == "write_off"
        for p in ev.postings if p.amount_cc > 0)
    report.bad_debt_rate = report.bad_debt_cc / s.settled_cc if s.settled_cc else 0.0
    report.unmet_demand_units = s.unmet_demand_units
    report.failed_verifications = s.failed_verification
    report.treasury_cc = ledger.balance(TREASURY)
    report.insurance_income_cc = sum(
        p.amount_cc for ev in ledger.events if ev.kind == "settlement"
        for p in ev.postings if p.account == INSURANCE)
    report.insurance_balance_cc = ledger.balance(INSURANCE)
    report.uncovered_bad_debt_cc = max(0.0, -ledger.balance(LOSS))
    report.loss_cc = ledger.balance(LOSS)

    # Credit velocity: settled CC per 30 days / average outstanding debt.
    total_debt_now = sum(-ledger.balance(a.aid) for a in agents.values()
                         if ledger.balance(a.aid) < 0)
    months = max(ticks / (TICKS_PER_DAY * 30), 1e-9)
    report.credit_velocity_per_month = (
        (s.settled_cc / months) / total_debt_now if total_debt_now > 0 else 0.0)

    # Expiry-cliff price signal: first vs last week median price
    report.price_first_week = median_price_in(market, 0, 7 * TICKS_PER_DAY)
    report.price_last_week = median_price_in(
        market, ticks - 7 * TICKS_PER_DAY, ticks + 1)

    honest_pop = [a for a in agents.values()
                  if a.behavior == "honest" and a.online]
    washer_pop = [a for a in agents.values()
                  if a.behavior == "washer" and a.online]
    if honest_pop:
        report.mean_credit_limit_honest = statistics.mean(
            credit_limit_fn(a, ticks) for a in honest_pop)
    if washer_pop:
        report.mean_credit_limit_washer = statistics.mean(
            credit_limit_fn(a, ticks) for a in washer_pop)
        # G2's fair baseline: honest agents with comparable earned volume.
        # Comparing against all honest agents (incl. pure consumers who
        # never provided) understates honest credit and misreads the test.
        w_earned = statistics.mean(a.earned_cc for a in washer_pop)
        matched = [a for a in honest_pop if a.earned_cc >= 0.5 * w_earned]
        if matched:
            report.mean_credit_limit_honest_matched = statistics.mean(
                credit_limit_fn(a, ticks) for a in matched)

    try:
        ledger.assert_conserved()
        ledger.rebuild_and_verify()
        report.conservation_ok = True
    except Exception:
        report.conservation_ok = False
    # --- verification market (§4 #25) --------------------------------
    vs = [v for v in getattr(market, 'verifiers', [])]
    if defaults:
        report.defaults_n = len(defaults)
        report.default_took_avg_cc = statistics.mean(
            d["took_cc"] for d in defaults)
        report.default_seized_avg_cc = statistics.mean(
            d["seized_cc"] for d in defaults)
        report.default_net_take_avg_cc = statistics.mean(
            d["took_cc"] - d["seized_cc"] for d in defaults)
    report.verifier_fees_cc = market.verifier_fees_cc
    report.verifier_balance_cc = sum(
        max(0.0, ledger.balance(v.vid)) for v in getattr(market, 'verifiers', []) or [])
    report.demurrage_collected_cc = sum(
        p.amount_cc for ev in ledger.events if ev.kind == 'demurrage'
        for p in ev.postings if p.amount_cc > 0)
    report.treasury_rebated_cc = sum(
        p.amount_cc for ev in ledger.events if ev.kind == 'protocol_rebate'
        for p in ev.postings
        if p.amount_cc > 0
        and ev.contract_id.startswith('rebate:protocol:treasury'))
    report.insurance_released_cc = sum(
        p.amount_cc for ev in ledger.events if ev.kind == 'protocol_rebate'
        for p in ev.postings
        if p.amount_cc > 0
        and ev.contract_id.startswith('rebate:protocol:insurance'))
    report.verifier_fee_share = (market.verifier_fees_cc / report.settled_cc
                                 if report.settled_cc else 0.0)
    if vs:
        revs = [ledger.balance(v.vid) for v in vs]
        report.mean_verifier_revenue_cc = sum(revs) / len(revs)
        report.min_verifier_revenue_cc = min(revs)
        lazy_votes = sum(v.canary_seen for v in vs if v.lazy_prob > 0)
        lazy_caught = sum(v.canary_failed for v in vs if v.lazy_prob > 0)
        report.lazy_detect_rate = (lazy_caught / lazy_votes
                                   if lazy_votes else None)
        prices = [p for _, p in market.stats.prices_per_unit]
        if prices:
            worst = max(prices) * 48  # a large single contract
            report.max_exposure_ratio = max(
                v.exposure_ratio(worst) for v in vs)
    report.canary_spend_cc = market.canary_spend_cc
    report.canary_share_of_volume = (market.canary_spend_cc / report.settled_cc
                                     if report.settled_cc else 0.0)
    report.canary_caught = market.canary_caught
    report.canary_missed = market.canary_missed
    report.slashed_cc = market.slashed_cc
    report.honest_error_forgiven = getattr(market, 'honest_error_forgiven', 0)

    return report
def render_text(r: Report, scenario: str) -> str:
    def f(x, nd=2):
        return "n/a" if x is None else f"{x:.{nd}f}"
    lines = [
        f"=== AMCN Phase 0 simulation — scenario: {scenario} ===",
        f"agents: {r.n_agents}   days: {r.days}",
        "",
        "-- 市場流動性 --",
        f"任務成交率 (fill rate)        : {r.fill_rate*100:.1f}%",
        f"任務過期率 (expired)          : {r.expired_rate*100:.1f}%",
        f"平均等待時間                  : {f(r.mean_wait_hours)} 小時 (P95 {f(r.p95_wait_hours)} h)",
        f"信用不足未發布需求            : {r.unmet_demand_units:.0f} units",
        f"驗收失敗次數                  : {r.failed_verifications}",
        "",
        "-- 信用循環 --",
        f"總結算量                      : {r.settled_cc:,.0f} CC",
        f"Credit velocity (月結算/未償) : {f(r.credit_velocity_per_month)}x",
        "",
        "-- 驗證市場 --",
        f"Verifier 費用 / 佔結算量        : {f(r.verifier_fees_cc)} CC / {f(r.verifier_fee_share*100)}%",
        f"Verifier 平均 / 最低淨收入      : {f(r.mean_verifier_revenue_cc)} / {f(r.min_verifier_revenue_cc)} CC",
        f"金絲雀支出 / 佔結算量           : {f(r.canary_spend_cc)} CC / {f(r.canary_share_of_volume*100)}%",
        f"金絲雀抓到 / 漏掉               : {r.canary_caught} / {r.canary_missed}",
        f"沒收押金總額                    : {f(r.slashed_cc)} CC",
        f"未達證據門檻而寬恕的失敗        : {r.honest_error_forgiven} 次",
        f"偷懶者被抓率                    : {'n/a' if r.lazy_detect_rate is None else f(r.lazy_detect_rate*100)+'%'}",
        f"單筆最大經手/押金比 (§4 #7 ≤3)  : {'n/a' if r.max_exposure_ratio is None else f(r.max_exposure_ratio)}",
        f"還債週期 平均/中位            : {f(r.mean_debt_cycle_days,1)} / {f(r.median_debt_cycle_days,1)} 天",
        f"期末仍負債的 episodes         : {r.open_debt_episodes}",
        "",
        "-- 風險 --",
        f"壞帳 (written off)            : {r.bad_debt_cc:,.0f} CC  ({r.bad_debt_rate*100:.2f}% of settled)",
        f"餘額 Gini                     : {r.gini_balances:.3f}",
        f"洗量結算佔比                  : {r.wash_share*100:.2f}%",
        f"誠實 Agent 平均信用額度       : {r.mean_credit_limit_honest:.1f} CC"
        f"（同活躍度組 {f(r.mean_credit_limit_honest_matched,1)}）",
        f"洗量 Agent 平均信用額度       : {f(r.mean_credit_limit_washer,1)} CC",
        "",
        "-- 價格 --",
        f"首週單位中位價                : {f(r.price_first_week)} CC/unit",
        f"末週單位中位價                : {f(r.price_last_week)} CC/unit",
        "",
        "-- 帳務 --",
        f"Treasury（基本費 2.5%）       : {r.treasury_cc:,.1f} CC",
        f"保險池收入 / 期末餘額         : {r.insurance_income_cc:,.1f} / {r.insurance_balance_cc:,.1f} CC",
        f"未覆蓋壞帳 (Loss)             : {r.uncovered_bad_debt_cc:,.1f} CC",
        f"守恆 Σ=0 且事件可重建         : {'PASS' if r.conservation_ok else 'FAIL'}",
        "",
        "-- GATE-0 判準 --",
        f"G1 守恆與事件重建             : {'PASS' if r.conservation_ok else 'FAIL'}",
        f"G2 洗量額度 ≤ 同活躍度誠實組  : "
        + ("n/a" if r.mean_credit_limit_washer is None else
           ("PASS" if r.mean_credit_limit_washer <=
            (r.mean_credit_limit_honest_matched
             if r.mean_credit_limit_honest_matched is not None
             else r.mean_credit_limit_honest) * 1.05 else "FAIL")),
        f"G3 壞帳 ≤ 保險池收入          : "
        + ("PASS" if r.bad_debt_cc <= r.insurance_income_cc else "FAIL"),
        f"G4 還債週期中位 < 30 天       : "
        + ("n/a" if r.median_debt_cycle_days is None else
           ("PASS" if r.median_debt_cycle_days < 30 else "FAIL")),
        f"G5 成交率 ≥ 80%               : {'PASS' if r.fill_rate >= 0.8 else 'FAIL'}",
    ]
    return "\n".join(lines)
