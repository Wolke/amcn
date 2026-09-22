"""Main simulation loop."""

from __future__ import annotations

import dataclasses
import json
import random
from pathlib import Path

from .agents import (DEADBEAT, SYBIL, TICKS_PER_DAY, WASHER, Agent, DebtEpisode,
                     build_population, build_verifiers, credit_limit)
from .ledger import DEMURRAGE_POOL, INFLOW_POOL, INSURANCE, Ledger, Posting, TREASURY
from .market import Market
from .metrics import DailySnapshot, Report, finalize, median_price_in, render_text

SCENARIOS = {
    # name: (deadbeat_frac, washer_frac, expiry_cliff)
    "baseline":     (0.02, 0.02, False),
    "expiry_cliff": (0.02, 0.02, True),   # all quotas reset the same day
    "high_default": (0.15, 0.02, False),  # stress the credit-line policy
    "wash_heavy":   (0.02, 0.20, False),  # stress FR-061/062 diversity caps
}


def run(n_agents: int = 500, days: int = 84, seed: int = 42,
        scenario: str = "baseline", out_dir: str | None = None,
        starter_cc: float = 20.0, risk_thin: float = 0.03,
        risk_base: float = 0.01, deadbeat_frac: float | None = None,
        repay_discount: float = 0.35, band_low_cl_frac: float | None = -0.15,
        n_verifiers: int = 9, verifier_rate: float = 0.04,
        # 驗證是角色還是獨立物種（#62 階段 3／階段 4）。True 時 panel 從
        # 交易者裡抽，驗證費落在**會花錢**的帳戶上；False 是原本的獨立
        # verifier 人口。四小時原型量到兩者的吸收機制完全不同——留存率
        # 99.4% 對 23.0%——而模擬器先前只有前者，所以 #66 的兩個掃描都
        # 只測到存量型吸收端。
        dual_role: bool = False,
        # 需求漂移天數（#64）。0 ＝ 每個 agent 的利用率一生固定，也就是
        # 「永久淨賣方」是被指派的而不是長出來的。>0 讓它每 N 天重抽一次，
        # 這才是「今天接案、明天發案」的賞金獵人館。
        demand_drift_days: int = 0,
        # Sybil 攻擊（#50）：攻擊者控制的身分數，以及每個身分要付的保證金。
        # N 做成**參數**而不是人口比例——它是攻擊者的選擇變數，這正是既有
        # 模型量不到這件事的原因。
        sybil_n: int = 0,
        sybil_deposit_cc: float = 0.0,
        # verifier 棄置身分重開的週期（#38）。沒收要 `slash_min_samples` 次
        # 金絲雀樣本才可能發動，所以**第 5 次之前是免費的**；一個偷懶者只要
        # 在達標前換身分，就永遠罰不到。0 表示不換（原行為）。
        # 換身分在模型裡＝把金絲雀計數歸零而**保留已賺到的費用**——那正是
        # 「棄置身分」的意思：紀錄沒了，錢還在。
        verifier_churn_days: int = 0,
        # #38 的修法：未達 `slash_min_samples` 就棄置身分時，已託管的押注
        # **不退還**（轉入保險池）。這不是「懲罰」而是「保證金不退」——
        # 一個誠實退場的 verifier 只要待到樣本數達標就拿得回去。
        # 2026-09-21 量到每 2 天換一次身分即可完全逃掉沒收（188 → 5.7 CC），
        # 而身分是免費的（#50），所以那條路沒有成本。
        # **2026-09-22 預設改為 True**：原型已實作同一條規則（`stake_forfeit`
        # 事件，協定 v7 另附退還路徑），模擬器要模的是現行協定而不是修法前的
        # 版本。設為 False 可重現修法前的對照（那組 A／B 就是這樣量的）。
        stake_forfeit_on_churn: bool = True,
        # 需求枯竭：第 N 天之後全網需求掉到 20%。要驗「沒人發任務時會怎樣」
        # 就得先造出那個狀況——這正是「假設沒有人想發任務」那個問題。
        drought_day: int = 0,
        # 逆週期收購（§2.2「Treasury 啟動」）：治理上限與觸發門檻。當日結算量
        # 低於乾旱前基準的 trigger 倍時，Treasury 出面買，全部 tx_class=subsidy。
        counter_cyclical_cap_cc: float = 0.0,
        counter_cyclical_trigger: float = 0.5,
        canary_rate: float = 0.03, verifier_lazy_frac: float = 0.0,
        verifier_stake_cc: float = 50.0,
        # 保證金（#65）。deposit_cc 是每個 agent 抵押的金額；
        # deposit_deadbeats_only 用來回答「只有壞人會被沒收，好人只是被凍結
        # 資金」這個不對稱是否成立。
        deposit_cc: float = 0.0,
        deposit_ltv: float = 1.0,
        # 保管費（登記簿 #66）。rate 是每天對正餘額收取的比例；idle_days 只
        # 對「連續這麼多天沒有動過」的餘額收費（鼓勵流動），0 表示對所有正
        # 餘額收（純收益）。dest 決定它是回流還是抽稅：
        #   "treasury"    → 收益，但除非 Treasury 花出去就只是換一個吸收端
        #   "redistribute" → 依當期結算量分給活躍交易者，強制回流
        demurrage_rate: float = 0.0,
        demurrage_idle_days: int = 0,
        demurrage_dest: str = "treasury",
        # 淨流入費（#66 的流量側，由四小時原型的留存率量測導出）。
        # demurrage 收的是**持有量**，對「收 859 付 5、留存 99.4%」的 verifier
        # 對症；但 #62 階段 4 之後的累積者留存只有 23.0%（收 8,840 付 6,809），
        # 它把四分之三都花掉了，集中來自吞吐量不對稱——存量費要抽乾它就得
        # 追上淨流入速度。這條收的基數是「這一期餘額長了多少」：
        # 對高吞吐但會花錢的人近乎免費，對單調累積者正比於累積速度。
        inflow_fee_rate: float = 0.0,
        inflow_fee_dest: str = "treasury",
        # Treasury 退費（登記簿 #61／#71）。protocol 帳戶只進不出，所以它們
        # 持有的每一塊 CC 都是永久借出去的信用；在沒有結構性淨賣方的小網路
        # 裡，交易者的總負債因此隨成交量單調成長直到全部貼牆。這條路徑把已
        # 收取的費用還回去。frac 是每次退還 Treasury **超額部分**的比例，
        # reserve_cc 是留給金絲雀與 L_boot 補貼的準備金（§2.2 的「創世補貼
        # 額度」在模擬裡以準備金近似）。權重用**流出量**而非平均分：平均分
        # 會付給只累積的帳戶，那正是 #62／#64 的形態。
        treasury_rebate_frac: float = 0.0,
        treasury_rebate_days: int = 7,
        treasury_reserve_cc: float = 0.0,
        # 加權方式做成參數而不是由我斷言，理由與 #66 的 dest 模式相同——
        # 「該獎勵誰」是個經濟判斷，讓掃描回答比讓我猜可靠：
        #   outgoing → 依本期支出（獎勵流通，純累積者拿不到）
        #   gross    → 依本期雙向成交量（買賣都算）
        #   equal    → 本期有動過的帳戶均分
        treasury_rebate_weight: str = "outgoing",
        # 保險池釋放（#61／#71）。保險池只在違約時付出，所以健康的網路裡它
        # 永久累積——**一個只會成長的準備金就是稅**。規則是準備金目標對應
        # 曝險（未償負餘額總額），超過目標的部分退還。target_frac=0 表示
        # 關閉；0.5 表示「持有未償負債的一半」。
        insurance_target_frac: float = 0.0,
        trace: str | None = None) -> Report:
    sc_deadbeat, washer_frac, expiry_cliff = SCENARIOS[scenario]
    if deadbeat_frac is None:
        deadbeat_frac = sc_deadbeat
    rng = random.Random(seed)
    # 每個帳戶最後一次有分錄的 tick，供「閒置」保管費判斷用。
    # 每個帳戶最後一次**支出**的 tick。用支出而非任何分錄，見下方註解。
    last_move: dict[str, int] = {}
    # 本期（上次退費以來）每個帳戶的流出量，供 Treasury 退費加權用。
    out_volume: dict[str, float] = {}
    gross_volume: dict[str, float] = {}
    rebated_total = 0.0
    rebate_rounds = 0
    released_total = 0.0
    release_rounds = 0
    seen_events = 0
    defaults: list[dict] = []          # 每個違約身分拿走多少、賠掉多少
    agents = {a.aid: a for a in build_population(
        n_agents, seed, deadbeat_frac, washer_frac, expiry_cliff, demand_drift_days=demand_drift_days, sybil_n=sybil_n)}
    ledger = Ledger()
    if trace == "auto":  # pick a chronically under-provisioned honest agent
        trace = next((a.aid for a in agents.values()
                      if a.behavior == "honest"
                      and a.mean_daily_demand * a.cycle_days > a.quota_capacity),
                     None)
    if deposit_cc > 0:
        for a in agents.values():
            a.collateral_cc = deposit_cc
            a.collateral_ltv = deposit_ltv
    verifiers = build_verifiers(n_verifiers, seed,
                                agent_ids=(sorted(agents)[:n_verifiers] if dual_role else None),
                                lazy_frac=verifier_lazy_frac,
                                stake_cc=verifier_stake_cc)
    market = Market(ledger, random.Random(seed + 1),
                    risk_thin=risk_thin, risk_base=risk_base,
                    starter_cc=starter_cc, repay_discount=repay_discount,
                    band_low_cl_frac=band_low_cl_frac,
                    verifiers=verifiers, verifier_rate=verifier_rate,
                    canary_rate=canary_rate, trace=trace)
    ticks = days * TICKS_PER_DAY
    day_open: dict[str, float] = {}
    cc_spent = 0.0
    cc_seq = 0
    cc_last_volume = 0.0
    cc_pre_drought: list[float] = []
    report = Report(days=days, n_agents=n_agents)

    # 協同退場：同一天一起消失。分散退場會讓保險池有時間補充，而協同正是
    # 攻擊者能選的事——把它設成隨機等於替攻擊者做了一個不利的選擇。
    # 退場時點要留夠沖銷的時間（14 天）。第一版用 `randrange(ticks//3, ticks)`
    # 抽到 1981（全長 2016），沖銷落在模擬結束之後，於是**攻擊確實發生了、
    # 報表上卻是 0**——那不是「攻擊不划算」，是量測窗口把它切掉了。
    # 這與真實攻擊者的誘因也一致：太晚下手，沒收與沖銷都還沒結算完。
    sybil_exit = (rng.randrange(ticks // 4, max(ticks // 4 + 1,
                                ticks - 16 * TICKS_PER_DAY))
                  if sybil_n else None)
    for a in agents.values():
        if a.behavior == SYBIL:
            a.exit_tick = sybil_exit
            if sybil_deposit_cc > 0:
                # 折扣率要一起設，否則抵押 D 會解鎖 D 的額度（LTV=1），
                # 對打算違約的人是損益中性的——#65 量到的正是這一點。
                a.collateral_cc = sybil_deposit_cc
                a.collateral_ltv = deposit_ltv
        if a.behavior == DEADBEAT:
            # vanishes some time in the second half of the run
            a.exit_tick = rng.randrange(ticks // 3, ticks)

    for tick in range(ticks):
        for a in agents.values():
            if not a.online:
                continue
            # deadbeat exit: burn remaining credit then disappear (§16 threat 13)
            if a.exit_tick is not None and tick >= a.exit_tick:
                avail = credit_limit(a, tick, agents, market.starter_cc) \
                    + ledger.balance(a.aid)
                if avail > 1.0:
                    market.post_shortfall(a, avail * 0.9, tick, agents)  # final grab
                a.online = False
                continue
            if a.cycle_reset_due(tick):
                if a.aid == market.trace and tick > 0:
                    market._tr(tick, f"計費週期重置：作廢 {a.remaining_quota:.1f} "
                                     f"units，額度回到 {a.quota_capacity:.0f}；"
                                     f"餘額 {ledger.balance(a.aid):+.1f} CC"
                                     + ("（開始還債供應, UC-02）"
                                        if ledger.balance(a.aid)
                                        < market.band_low(a, tick, agents) else ""))
                a.remaining_quota = a.quota_capacity  # unused quota expires
            demand = a.draw_demand(tick)
            if demand <= a.remaining_quota:
                a.remaining_quota -= demand
            else:
                shortfall = demand - a.remaining_quota
                a.remaining_quota = 0.0
                market.post_shortfall(a, shortfall, tick, agents)  # UC-01
            if a.behavior == WASHER and tick % (TICKS_PER_DAY // 2) == 0:
                market.post_wash_task(a, tick)

        market.clear(agents, tick)

        # debt-episode tracking (per-day granularity is enough)
        if (verifier_churn_days > 0
                and tick > 0
                and tick % (verifier_churn_days * TICKS_PER_DAY) == 0):
            for v in verifiers:
                if v.lazy_prob <= 0:
                    continue
                # 棄置發生在**樣本數達標之前**才沒收——達標之後離開是正常
                # 退場，押注該退。門檻用 market 的 slash_min_samples，
                # 兩邊必須是同一個數，否則規則與偵測條件對不上。
                if (stake_forfeit_on_churn
                        and v.canary_seen < market.slash_min_samples):
                    bond = min(v.stake_cc * market.slash_frac,
                               max(ledger.balance(v.vid), 0.0))
                    if bond > 1e-9:
                        ledger.slash(tick, f"forfeit:{v.vid}:{tick}",
                                     v.vid, bond)
                        v.slashed_cc += bond
                        market.slashed_cc += bond
                v.canary_seen = 0
                v.canary_failed = 0
        if demand_drift_days > 0:
            for a in agents.values():
                a.maybe_drift(tick)
        if tick % TICKS_PER_DAY == 0:
            for a in agents.values():
                bal = ledger.balance(a.aid)
                in_ep = a.debt_episodes and a.debt_episodes[-1].end_tick is None
                if bal < -0.5 and not in_ep:
                    a.debt_episodes.append(DebtEpisode(start_tick=tick))
                elif bal >= 0 and in_ep:
                    a.debt_episodes[-1].end_tick = tick

            # 「最後有**流出**」，不是「最後有動過」。第一版記的是任何分錄，
            # 於是 verifier 每收一筆驗證費就算「有動」——儘管它的餘額只增不
            # 減。實測下來重分配模式對 verifier 持有量毫無作用（119±43 對
            # 116±36），就是這個定義錯誤造成的。#62 要抓的是「只進不出」，
            # 所以只有負向分錄才算動過。
            while seen_events < len(ledger.events):
                ev = ledger.events[seen_events]
                seen_events += 1
                for pg in ev.postings:
                    if pg.amount_cc < 0:
                        last_move[pg.account] = ev.tick
                        if ev.kind == "settlement":
                            out_volume[pg.account] = out_volume.get(
                                pg.account, 0.0) - pg.amount_cc
                    if ev.kind == "settlement" and pg.amount_cc > 0:
                        gross_volume[pg.account] = gross_volume.get(
                            pg.account, 0.0) + pg.amount_cc

            # --- 保管費（#66）-------------------------------------
            # 每天一次。對象是持有正餘額者，包含 verifier——#62 量到的正是
            # verifier 只進不出（原型 soak 每位 +11.9 CC），而保管費是否能把
            # 那些錢逼回市場，就是這個掃描要回答的。
            if demurrage_rate > 0:
                holders = [x.aid for x in agents.values()] + \
                          [v.vid for v in verifiers]
                charged = 0.0
                for acct in holders:
                    bal = ledger.balance(acct)
                    if bal <= 0:
                        continue
                    if demurrage_idle_days > 0:
                        last = last_move.get(acct, 0)
                        if tick - last < demurrage_idle_days * TICKS_PER_DAY:
                            continue      # 還在流動，不收
                    charged += ledger.demurrage(
                        tick, acct, bal * demurrage_rate,
                        TREASURY if demurrage_dest == "treasury" else DEMURRAGE_POOL)
                # redistribute: 依「本日有成交」分給活躍交易者，強制回流。
                # 沒有活躍者時留在池子裡等下一天，不憑空消失。
                if demurrage_dest != "treasury" and charged > 1e-9:
                    active = [x.aid for x in agents.values()
                              if x.online and last_move.get(x.aid, -1)
                              >= tick - TICKS_PER_DAY]
                    pool = ledger.balance(DEMURRAGE_POOL)
                    if active and pool > 1e-9:
                        share = pool / len(active)
                        ledger.post(tick, "demurrage_payout",
                                    f"demurrage_payout:{tick}",
                                    [Posting(DEMURRAGE_POOL, -pool)] +
                                    [Posting(a, share) for a in active])

            # --- 淨流入費（#66 流量側）-----------------------------
            # 基數是「這一天餘額長了多少」，所以把錢花出去的人幾乎不用付，
            # 而單調累積者付得與累積速度成正比。與 demurrage 分開收、分開
            # 記帳，因為兩者對應的是兩種不同的吸收端（留存率才分得開）。
            if inflow_fee_rate > 0:
                holders = [x.aid for x in agents.values()] + \
                          [v.vid for v in verifiers]
                charged_in = 0.0
                for acct in holders:
                    grew = ledger.balance(acct) - day_open.get(acct, 0.0)
                    if grew <= 1e-12:
                        continue
                    charged_in += ledger.inflow_fee(
                        tick, acct, grew * inflow_fee_rate,
                        TREASURY if inflow_fee_dest == "treasury" else INFLOW_POOL)
                if inflow_fee_dest != "treasury" and charged_in > 1e-9:
                    # 退給**本期有流出**的帳戶：付出去的人才拿得到，
                    # 否則又是付給純累積者（#66 第一版踩過的定義錯誤）。
                    active = [x.aid for x in agents.values()
                              if x.online and last_move.get(x.aid, -1)
                              >= tick - TICKS_PER_DAY]
                    pool = ledger.balance(INFLOW_POOL)
                    if active and pool > 1e-9:
                        share = pool / len(active)
                        ledger.post(tick, "inflow_fee_payout",
                                    f"inflow_fee_payout:{tick}",
                                    [Posting(INFLOW_POOL, -pool)] +
                                    [Posting(a, share) for a in active])
            # 這一天的期初餘額，供下一天算「長了多少」。放在收費之後，
            # 所以收走的那一筆不會被下一期重複計入。
            day_open = {a: ledger.balance(a)
                        for a in [x.aid for x in agents.values()]
                        + [v.vid for v in verifiers]}

            # --- Treasury 退費（#61／#71）---------------------------
            # 每 treasury_rebate_days 一次。只退「超過準備金的部分」，準備金
            # 留給金絲雀與 L_boot 補貼——把 Treasury 退到零會讓 §2.2 設計的
            # 另外兩條支出路徑無法運作，那是把一個問題換成另一個。
            if (treasury_rebate_frac > 0
                    and tick > 0
                    and tick % (treasury_rebate_days * TICKS_PER_DAY) == 0):
                excess = ledger.balance(TREASURY) - treasury_reserve_cc
                if excess > 1e-9:
                    budget = excess * treasury_rebate_frac
                    if treasury_rebate_weight == "equal":
                        movers = [x.aid for x in agents.values()
                                  if x.online and out_volume.get(x.aid, 0.0) > 0]
                        w = {a: 1.0 for a in movers}
                    else:
                        src = (out_volume if treasury_rebate_weight == "outgoing"
                               else gross_volume)
                        w = {x.aid: src.get(x.aid, 0.0)
                             for x in agents.values() if x.online
                             and src.get(x.aid, 0.0) > 0}
                    wsum = sum(w.values())
                    if wsum > 1e-9:
                        shares = {a: budget * v / wsum for a, v in w.items()}
                        paid = ledger.protocol_rebate(tick, TREASURY, shares)
                        if paid > 1e-9:
                            rebated_total += paid
                            rebate_rounds += 1
            # --- 保險池超額釋放（#61／#71）--------------------------
            # 與 Treasury 退費同一天、同一個加權，但來源不同：量測顯示保險池
            # 才是主要吸收端（模擬 N=50 持有 52.93 CC、原型 soak 75.90 CC，
            # 後者是 122.53 總吸收的 62%）。目標綁曝險而不是綁成交量：保險池
            # 存在是為了吸收違約，而可能違約的金額就是現在的未償負餘額。
            if (insurance_target_frac > 0
                    and tick > 0
                    and tick % (treasury_rebate_days * TICKS_PER_DAY) == 0):
                exposure = sum(-ledger.balance(x.aid) for x in agents.values()
                               if ledger.balance(x.aid) < 0)
                target = exposure * insurance_target_frac
                surplus = ledger.balance(INSURANCE) - target
                if surplus > 1e-9:
                    movers = {x.aid: out_volume.get(x.aid, 0.0)
                              for x in agents.values()
                              if x.online and out_volume.get(x.aid, 0.0) > 0}
                    wsum = sum(movers.values())
                    if wsum > 1e-9:
                        shares = {a: surplus * v / wsum
                                  for a, v in movers.items()}
                        paid = ledger.protocol_rebate(tick, INSURANCE, shares)
                        if paid > 1e-9:
                            released_total += paid
                            release_rounds += 1

            # 本期歸零，無論兩條路徑有沒有退成功——權重要反映「最近」而不是
            # 全期。放在兩個區塊之後而不是第一個裡面：保險池釋放單獨開啟時，
            # 第一版會讓權重從不歸零、累積整個 84 天。
            if ((treasury_rebate_frac > 0 or insurance_target_frac > 0)
                    and tick > 0
                    and tick % (treasury_rebate_days * TICKS_PER_DAY) == 0):
                out_volume.clear()
                gross_volume.clear()

            # write off agents gone ≥14 days with negative balance
            for a in agents.values():
                if (not a.online and a.exit_tick is not None
                        and tick - a.exit_tick >= 14 * TICKS_PER_DAY
                        and ledger.balance(a.aid) < 0):
                    # 違約前的負餘額就是這個身分實際「拿走」的價值；
                    # 保證金抵掉一部分，剩下的才是網路的損失（#65）。
                    took = -ledger.balance(a.aid)
                    ledger.write_off(tick, a.aid, a.collateral_cc)
                    seized = ledger.last_collateral_seized
                    defaults.append({"aid": a.aid, "took_cc": took,
                                     "collateral_cc": a.collateral_cc,
                                     "seized_cc": seized})

            day = tick // TICKS_PER_DAY

            # 乾旱：一次性把全網需求砍到 20%
            if drought_day and day == drought_day:
                for a in agents.values():
                    a.mean_daily_demand *= 0.2

            # 逆週期收購：Treasury 在補貼額度內補上消失的需求。
            # 買的是**真實的產能**（provider 要有 remaining_quota），所以它是
            # 需求而不是記帳花招；但它標 subsidy，不進市場指標——一個靠補貼
            # 撐起來的成交率不是市場數據（同 #63 的關聯方）。
            if counter_cyclical_cap_cc > 0:
                today = market.stats.settled_cc - cc_last_volume
                cc_last_volume = market.stats.settled_cc
                if not drought_day or day < drought_day:
                    cc_pre_drought.append(today)
                    if len(cc_pre_drought) > 14:
                        cc_pre_drought.pop(0)
                else:
                    base = (sum(cc_pre_drought) / len(cc_pre_drought)
                            if cc_pre_drought else 0.0)
                    want = min(base * counter_cyclical_trigger - today,
                               counter_cyclical_cap_cc - cc_spent)
                    sellers = [a for a in agents.values()
                               if a.online and a.remaining_quota >= 2.0]
                    rng.shuffle(sellers)
                    for a in sellers:
                        if want <= 1e-9:
                            break
                        units = min(a.remaining_quota, 4.0)
                        price = min(want, units * 1.0)
                        if price <= 1e-9:
                            break
                        cc_seq += 1
                        ledger.counter_cyclical(tick, f"cc{cc_seq:06d}",
                                                a.aid, price)
                        a.remaining_quota -= units
                        cc_spent += price
                        want -= price
            debtors = [x for x in agents.values()
                       if ledger.balance(x.aid) < -0.5 and x.online]
            report.daily.append(DailySnapshot(
                day=day,
                fill_rate=(market.stats.matched / market.stats.posted
                           if market.stats.posted else 0.0),
                median_price=median_price_in(
                    market, tick - TICKS_PER_DAY, tick + 1),
                open_tasks=len(market.open_tasks),
                agents_in_debt=len(debtors),
                total_debt_cc=sum(-ledger.balance(x.aid) for x in debtors),
                total_credit_cc=sum(credit_limit(x, tick, agents, market.starter_cc)
                                    for x in agents.values() if x.online),
                settled_cc_cum=market.stats.settled_cc,
                # 當日正餘額最高者。逐日記身分才分得出「同一人永遠吸」與
                # 「每天換人」——兩者的首位佔比長得一樣，意義相反（#64）。
                top_holder=max(
                    (x.aid for x in agents.values()
                     if ledger.balance(x.aid) > 0),
                    key=lambda a: ledger.balance(a), default=""),
                # 逐帳戶看「還剩多少可用額度」。原型 soak 的鎖死特徵是每一
                # 個交易者都貼在上限上（#61），而總量比會被健康帳戶稀釋，
                # 看不出那件事。
                pinned_frac=(
                    sum(1 for x in agents.values() if x.online
                        and -ledger.balance(x.aid)
                        >= 0.9 * max(1e-9, credit_limit(x, tick, agents,
                                                        market.starter_cc)))
                    / max(1, sum(1 for x in agents.values() if x.online))),
            ))

    finalize(report, agents, ledger, market, ticks,
             lambda a, t: credit_limit(a, t, agents, market.starter_cc),
             defaults=defaults)
    if market.trace:
        report.trace_agent = market.trace
        report.trace_lines = list(market.trace_log)

    if out_dir:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        summary = dataclasses.asdict(report)
        daily = summary.pop("daily")
        (out / f"{scenario}_summary.json").write_text(
            json.dumps(summary, indent=2, ensure_ascii=False))
        with (out / f"{scenario}_daily.csv").open("w") as fh:
            cols = [f.name for f in dataclasses.fields(DailySnapshot)]
            fh.write(",".join(cols) + "\n")
            for d in daily:
                fh.write(",".join(
                    "" if d[c] is None else f"{d[c]:.4f}" if isinstance(d[c], float)
                    else str(d[c]) for c in cols) + "\n")
    return report


def main(argv: list[str] | None = None) -> None:
    import argparse
    p = argparse.ArgumentParser(
        prog="amcn_sim",
        description="AMCN Phase 0 mutual-credit economy simulation (SDD §19)")
    p.add_argument("--agents", type=int, default=500)
    p.add_argument("--days", type=int, default=84)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--scenario", choices=sorted(SCENARIOS), default="baseline")
    p.add_argument("--all-scenarios", action="store_true",
                   help="run every scenario and print a comparison")
    p.add_argument("--out", default="sim/out", help="output dir for json/csv")
    p.add_argument("--trace", default=None, metavar="AGENT_ID",
                   help="print one agent's diary; 'auto' picks a chronically "
                        "under-provisioned honest agent")
    args = p.parse_args(argv)

    scenarios = sorted(SCENARIOS) if args.all_scenarios else [args.scenario]
    for sc in scenarios:
        rep = run(args.agents, args.days, args.seed, sc, args.out,
                  trace=args.trace)
        print(render_text(rep, sc))
        if rep.trace_lines:
            print(f"\n-- {rep.trace_agent} 的日記（{len(rep.trace_lines)} 條）--")
            for line in rep.trace_lines:
                print(line)
        print()


if __name__ == "__main__":
    main()
