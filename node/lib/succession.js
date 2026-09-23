// 排序器接手，而**不必複製私鑰**（#95）。
//
// 在這個檔案之前，接手長這樣：`standby-hub.sh` 用**同一個 `HUB_SEED`** 在第二
// 台機器上起來，所以它是同一個 DID，釘住它的 client 就會跟上。那個腳本自己
// 老實寫著代價：「排序器的私鑰從此存在兩台機器上」。於是「離線時整個網路互相
// 接手」在字面上等於「每一個可能接手的人都有那把私鑰」——那不是可以推廣的
// 形狀。升格也是人手動跑的，防分叉靠 runbook 的一句話（「M1 不得再接回同一
// 網段」），不是協定。
//
// 已經成立的那一半別浪費：帳本可以由簽署產物**驗證式**重建（`demo-rebuild.js`：
// 另一個進程、另一個埠、竄改被拒），所以接手的人**不需要信任任何人**；而
// client 每次重連都重新解析（#40），所以它們**願意**跟著走。缺的只有兩件：
// **誰接手**，以及**client 憑什麼相信他**。
//
// 這裡做的是第二件：一份**事先簽好**的授權。現任 Hub 簽 `{successor, priority}`，
// 而「事先」是整個設計的關鍵——簽它的人可以在之後離線，憑證仍然驗得過。
// client 釘的還是原本那個 DID，但它接受「能從被釘住的 DID 走到你」的後繼者。
// 這與 §2.2 已裁決的 Identity 層是同一種東西（UCAN 委派鏈），只是委派的對象
// 是「排序器這個角色」。
//
// **不宣稱的**：這是有紀錄的 failover，不是共識。兩個後繼者同時升格＝分叉，
// 靠 `priority` 的錯開與「後繼者必須延伸它驗過的最後一個 checkpoint」壓低機率，
// 剩下的要人判（分叉偵測本身已經有了，#69c／#72）。
'use strict';
const { sign, verify } = require('./wire');
const { didOf } = require('./discovery');

// 委派鏈的長度上限。深度存在的理由是後繼者也會需要它自己的後繼者；上限存在的
// 理由是「一條夠長的鏈」等於沒有 pin。
const MAX_DEPTH = Number(process.env.AMCN_SUCCESSION_MAX_DEPTH || 3);

function cert(hubId, { successor, priority = 1, notBeforeMs = 0, note = null }) {
  const body = { type: 'hub_succession', pub: hubId.pub, successor,
                 priority, not_before_ms: notBeforeMs, note, ts: Date.now() };
  return { ...body, sig: sign(hubId.privateKey, body) };
}

// 一張憑證自己站不站得住（簽章、形狀）。它**不**回答「這張憑證與我釘的人有
// 什麼關係」——那是 chain() 的事，而把兩者混在一起正是「一張有效簽章就放行」
// 這類漏洞的來源（#75／S20 的同一個教訓）。
function checkCert(c) {
  if (!c || c.type !== 'hub_succession') return null;
  if (typeof c.successor !== 'string' || !c.successor.startsWith('did:')) return null;
  if (typeof c.pub !== 'string' || typeof c.sig !== 'string') return null;
  const { sig, ...body } = c;
  try {
    if (!verify(c.pub, body, sig)) return null;
  } catch { return null; }
  return { issuer: didOf(c.pub), successor: c.successor,
           priority: Number(c.priority) || 1,
           notBeforeMs: Number(c.not_before_ms) || 0, ts: c.ts };
}

// 從 `from`（被釘住的 DID）能不能走到 `to`（記錄的簽署者）。
// 回傳走過的路徑（不含起點），或 null。
function chain(certs, { from, to, now = Date.now() }) {
  if (!Array.isArray(certs) || !from || !to) return null;
  const valid = certs.map(checkCert).filter(Boolean);
  // 寬度優先：路徑短的先找到，而短的路徑就是「被釘住的人直接授權的人」。
  let frontier = [{ did: from, path: [] }];
  const seen = new Set([from]);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const c of valid) {
        if (c.issuer !== node.did) continue;
        // not_before 是給人用的閘門（「我離線 5 分鐘不代表要換人」），
        // 憑證本身在那之前就存在、也驗得過，只是還不能用。
        if (c.notBeforeMs && now < c.notBeforeMs) continue;
        if (c.successor === to) {
          return [...node.path, { from: c.issuer, to: c.successor, priority: c.priority }];
        }
        if (seen.has(c.successor)) continue;
        seen.add(c.successor);
        next.push({ did: c.successor,
                    path: [...node.path, { from: c.issuer, to: c.successor, priority: c.priority }] });
      }
    }
    if (!next.length) return null;
    frontier = next;
  }
  return null;
}

// 我（`me`）有沒有被授權接手，以及我的優先序是多少（數字小的先升格，用來錯開
// 兩個待命機的升格時間——同時升格＝分叉）。
function authorityFor(certs, { pin, me, now = Date.now() }) {
  const path = chain(certs, { from: pin, to: me, now });
  if (!path) return null;
  return { path, depth: path.length, priority: path.at(-1).priority };
}

module.exports = { cert, checkCert, chain, authorityFor, MAX_DEPTH };
