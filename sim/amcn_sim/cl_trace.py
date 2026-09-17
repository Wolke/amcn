"""重放共用流水，輸出每一步的信用額度（紅隊盤點 E5）。

存在的理由：`sim/amcn_sim/agents.py` 與 `node/lib/eeff.js` 是同一條公式的
兩份手抄實作，而登記簿三次出現「數字打架」都是這個形態（#1、#20、#25）。
讀程式碼不算數——兩邊重放同一組流水，逐步比對數字。

用法： python3 -m amcn_sim.cl_trace sim/fixtures/cl-flows.json
"""
from __future__ import annotations

import json
import random
import sys

from .agents import Agent, credit_limit


def trace(fixture: dict) -> dict:
    starter = float(fixture.get("starter_cc", 50))
    names = fixture["agents"]
    # tick 0 for everyone: the age factor is then identical across agents, so
    # any divergence from the node side is the formula, not the clock.
    peers = {n: Agent(aid=n, rng=random.Random(0), joined_tick=0) for n in names}
    steps = []
    for i, f in enumerate(fixture["flows"]):
        payer, payee, amt = peers[f["payer"]], peers[f["payee"]], float(f["amount"])
        payee.counterparty_volume[payer.aid] = \
            payee.counterparty_volume.get(payer.aid, 0.0) + amt
        payer.paid_volume[payee.aid] = payer.paid_volume.get(payee.aid, 0.0) + amt
        payee.tasks_completed += 1
        payee.counterparties.add(payer.aid)
        steps.append({
            "step": i + 1,
            "flow": f"{f['payer']}->{f['payee']}:{amt}",
            "cl": {n: round(credit_limit(peers[n], 0, peers, starter), 6)
                   for n in names},
        })
    return {"impl": "sim/amcn_sim/agents.py", "starter_cc": starter, "steps": steps}


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "sim/fixtures/cl-flows.json"
    with open(path, encoding="utf-8") as fh:
        print(json.dumps(trace(json.load(fh)), ensure_ascii=False))
