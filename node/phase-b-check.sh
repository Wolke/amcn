#!/bin/bash
# 拔線演練的驗收：把接手之後的帳與拔線前的基準逐項比對。
#
# 在**接手的那台**（M2）上跑，因為 M1 已經不可達。基準檔隨 repo 帶過來，
# 不是從 M1 現撈——演練當下 M1 正是拿不到的那台。
#
# 用法：  ./phase-b-check.sh [hub host] [hub port]
set -u
cd "$(dirname "$0")"
HOST="${1:-127.0.0.1}"
PORT="${2:-47180}"
BASE="../docs/evaluation/pilot-phase-b-baseline.json"

node -e '
const fs=require("fs");
const t=require("./lib/transport").get("tcp");
const {fetchLedger}=require("./lib/ledgerfetch");
const inv=require("./lib/invariants");
const [host,port,basePath]=[process.argv[1],Number(process.argv[2]),process.argv[3]];
const base=JSON.parse(fs.readFileSync(basePath,"utf8"));
let pass=0, fail=0, unknown=0;
const ok=(n,c,d)=>{ if(c===null){unknown++;console.log("  未測到  "+n+(d?" — "+d:""));}
  else {c?pass++:fail++;console.log("  "+(c?"PASS":"FAIL")+"    "+n+(d?" — "+d:""));} };

const c=t.dial({host,port});
const bail=setTimeout(()=>{
  console.log("\n接手的 Hub 完全沒有回應 —— 這不是「帳有問題」，是「它沒起來」。");
  console.log("看 logs/standby-hub.log：REFUSING to start 表示匯入驗證沒過（#78），那是正確的拒絕。");
  process.exit(2);
},20000);

fetchLedger(c,{timeoutMs:18000}).then((m)=>{
  clearTimeout(bail); try{c.close();}catch{}
  const mt=m.metrics||{}, cps=m.checkpoints||[];
  const sigma=Object.values(m.balances).reduce((a,b)=>a+b,0);
  console.log("\n=== 拔線演練驗收（基準 "+base.at+"）===");
  // 接手的 Hub 與原本的**是同一個 DID**（同 seed，那正是 pin 能自動跟上的
  // 原因），所以這支腳本分不出自己連到哪一台。在 M1 上跑它一樣會全過，
  // 而那什麼都沒證明。把查詢對象印出來，讓紀錄自己說話。
  console.log("查詢對象 "+host+":"+port+"  —— 必須是**接手的那台**（M2），"+
    "在 M1 上跑這支會全過但毫無意義\n");
  ok("接手的 Hub 有回應並交出完整帳本", true, m.receipts.length+" 筆收據");
  ok("歷史沒有倒退（收據數 >= 拔線前）", m.receipts.length>=base.receipts,
     base.receipts+" → "+m.receipts.length);
  const kept=(m.receipts||[]).some(r=>r.receipt.contract_id===base.last_contract_id);
  ok("拔線前最後一筆仍在帳上（筆數會說謊，#74）", kept, base.last_contract_id);
  ok("Σ 仍為 0", Math.abs(sigma)<1e-6, sigma.toFixed(9));
  const v=inv.checkLedger(m);
  ok("七項不變式全數通過", v.length===0, v.length?v.slice(0,2).join("；"):"零違反");
  const resumed=m.receipts.length-base.receipts;
  ok("接手後有新的成交（交易真的恢復了）", resumed>0, "新增 "+resumed+" 筆");
  const seq=cps.length?cps.at(-1).cp.seq:null;
  ok("checkpoint 序號延續而非重來", seq!==null&&seq>=base.checkpoint_seq,
     base.checkpoint_seq+" → "+seq);
  const cls=m.credit_lines||{};
  // **被拔線那台上的 agent 不會出現在這裡，那是演練的設計而不是失敗。**
  // 第一版斷言「四個都在」，於是真機演練紅在 m1/m1b 缺席——可是它們正在
  // 那台被隔離的機器上，不可能回來。要問的是：餘額有沒有留著（有，帳是
  // 完整的），以及**跟得上的那些**有沒有跟上。
  const survived=Object.entries(base.accounts).filter(([d])=>cls[d]!==undefined);
  const absent=Object.entries(base.accounts).filter(([d])=>cls[d]===undefined);
  ok("跟得上的 agent 都重新註冊了（在被隔離那台上的不算）", survived.length>0,
     survived.length+" 個跟上"+(absent.length?
       "；"+absent.length+" 個缺席（"+absent.map(([d])=>d.slice(10,17)).join(",")+
       "）——應該正好是被拔線那台上的":""));
  const kept=absent.every(([d])=>m.balances[d]!==undefined);
  ok("缺席者的餘額仍在帳上（身分不在線，不等於歷史不見）", kept,
     absent.length?absent.map(([d])=>d.slice(10,17)+" "+(m.balances[d]??"不見了")).join("  ")
                  :"本輪無缺席者");
  console.log("\n  帳戶 拔線前 → 現在");
  for(const [d,b] of Object.entries(base.accounts)){
    const now=m.balances[d];
    console.log("    "+d.slice(10,17)+"  "+b.bal.toFixed(2)+"/"+b.cl.toFixed(1)+
      "  →  "+(now===undefined?"（不見了）":now.toFixed(2)+"/"+(cls[d]||0).toFixed(1)));
  }
  console.log("\n  還債 "+mt.repayment_episodes+" 次（拔線前 "+base.repay_episodes+
    "）｜成交率 "+mt.fill_rate+"｜深度 "+mt.avg_bids_per_task);
  console.log("\n結果："+pass+" PASS / "+fail+" FAIL"+(unknown?" / "+unknown+" 未測到":""));
  console.log("\n還有兩項只有你能記：(a) 需要手動重啟幾個 process、花多久；"+
    "(b) 拔線當下卡在 VERIFYING 的合約後來怎麼收場。");
  process.exit(fail?1:0);
}).catch((e)=>{ clearTimeout(bail);
  console.log("取帳失敗："+e.message); process.exit(2); });
' "$HOST" "$PORT" "$BASE"
