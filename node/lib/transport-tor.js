// ITransport 實作 5：不需要對外開任何埠的傳輸（#89）。
//
// 這一支存在的理由是一個部署現實，而不是隱私需求：**必須有一方是可達的**。
// Hub 模型下那一方是 Hub，於是「跑一個節點」變成「把家裡的機器掛上公網」——
// 而實測那條路在真實家用網路上經常直接不可行（開發機所在的網路是雙層 NAT：
// 路由器的 WAN 是 192.168.1.103，上游那台沒有 UPnP 也進不去）。
//
// 換成 P2P 不會讓這個問題消失，只會換一個名字：libp2p 的答案是 relay ＋
// hole punching，也就是**還是有人要跑 relay**。換成鏈也不會——鏈解決的是
// 「目錄由誰託管」（而那件事一份簽署過的記錄放在任何靜態主機上就解決了，
// 見 lib/rendezvous.js），解決不了「兩台 NAT 後面的機器怎麼連上」，而且
// 每筆結算上鏈違反 NFR-009 與 P-04。
//
// onion service 正好對上這個形狀，而且對上的不只一項：
//   1. **零入向埠**。Hub 只聽 127.0.0.1，tor 的 rendezvous 負責把外面的人
//      帶進來，雙層 NAT／CGNAT 兩邊都不必設定。
//   2. **位址本身就是公鑰**（v3 onion ＝ ed25519 公鑰的編碼）。AMCN 本來就
//      要求客戶端釘 `hubPin`，所以這裡的信任錨與協定的信任錨是同一種東西，
//      不需要 CA 也不需要憑證。
//   3. 免費，而且沒有任何人要營運基礎設施。
//
// 代價要說清楚：延遲（電路約數百毫秒，所以 `AMCN_IDLE_TIMEOUT_MS` 之類的
// 值可能要放寬）、頻寬有限、以及**兩邊都要有 tor**（Hub 端要有 hidden
// service，客戶端只要有 SOCKS5 出口）。
//
// 實作上幾乎沒有新東西，這正是 ITransport 這個接縫的價值：
//   listen  完全沿用 tcp（綁 127.0.0.1，由 tor 轉進來）
//   dial    tcp 的 socket 換成「經 SOCKS5 連到 <addr>.onion:port」
// framing、信封版本閘門、handler 隔離全部仍然在 lib/channel.js 裡，所以
// 「換一個傳輸，帳必須一模一樣」這條斷言對它同樣成立（demo-transport.js）。
//
//   AMCN_TRANSPORT=tor
//   AMCN_TOR_SOCKS=127.0.0.1:9050   本機 tor 的 SOCKS5 出口（預設值）
'use strict';
const net = require('node:net');
const tcp = require('./transport-tcp');
const { createChannel } = require('./channel');

const name = 'tor';

const socksTarget = () => {
  const s = process.env.AMCN_TOR_SOCKS || '127.0.0.1:9050';
  const [host, port] = s.split(':');
  return { host: host || '127.0.0.1', port: Number(port || 9050) };
};

// 最小的 SOCKS5 CONNECT。刻意用 ATYP=0x03（domain name）而不是先自己解析
// 位址：`.onion` 在 DNS 裡不存在，**必須**讓 tor 去解，這也是「客戶端不需要
// 知道對方在哪」的原因。
function socksConnect({ host, port }, cb) {
  const via = socksTarget();
  const sock = net.connect(via.port, via.host);
  let stage = 'greet';
  const fail = (msg) => {
    sock.destroy();
    cb(new Error(`${msg}（SOCKS5 ${via.host}:${via.port}）`));
  };

  sock.on('error', (err) => {
    if (stage !== 'done') fail(`連不到本機的 tor：${err.message}`);
  });
  sock.on('connect', () => {
    // VER=5, NMETHODS=1, METHOD=0（無認證）
    sock.write(Buffer.from([0x05, 0x01, 0x00]));
  });
  sock.on('data', (buf) => {
    if (stage === 'greet') {
      if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('SOCKS5 交握被拒');
      stage = 'connect';
      const h = Buffer.from(host, 'utf8');
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]);
      sock.write(req);
      return;
    }
    if (stage === 'connect') {
      // REP=0x00 才是成功。其餘照 RFC1928 的意思翻成看得懂的話——一條
      // 「連不上」的連線與「tor 沒起來」是兩件不同的事，而它們從前長一樣。
      const rep = buf[1];
      if (rep !== 0x00) {
        const why = {
          0x01: 'SOCKS server 一般性失敗',
          0x02: '規則不允許',
          0x03: '網路不可達',
          0x04: '主機不可達（onion 位址不存在或服務沒開）',
          0x05: '連線被拒',
          0x06: 'TTL 過期',
          0x07: '不支援的命令',
          0x08: '不支援的位址型別',
        }[rep] || `未知的 SOCKS5 回應 0x${rep.toString(16)}`;
        return fail(why);
      }
      stage = 'done';
      // 後續的位元組就是對端的資料流，交回給呼叫端。
      sock.removeAllListeners('data');
      cb(null, sock);
    }
  });
}

// dial 必須**同步**回傳一個 Channel（呼叫端拿到就 .onMessage／.send），而
// SOCKS5 交握是非同步的。所以這裡直接用共用的 createChannel，並讓 write 在
// 交握完成前排隊——不是自己另做一套 framing：framing、信封版本閘門與 handler
// 隔離都必須是 lib/channel.js 的那一份，否則「換傳輸、帳一模一樣」那條斷言
// 就不再有意義（demo-transport.js）。
function dial({ port = 47180, host = '127.0.0.1' } = {}) {
  const queue = [];
  let sock = null, dead = false;
  const remote = `${host}:${port}`;

  const chan = createChannel({
    remote,
    write: (out) => {
      if (dead) return;
      if (sock) sock.write(out); else queue.push(out);
    },
    close: () => { dead = true; if (sock) sock.destroy(); },
    isClosed: () => dead || (sock ? sock.destroyed : false),
  });

  socksConnect({ host, port }, (err, s) => {
    if (err) {
      // 說出原因再關。一條被 tor 拒絕的連線與「tor 沒起來」是兩件事，
      // 而分不出來的人只會一直重試（#76 的同一個教訓）。
      console.error(`[wire] tor dial ${remote} 失敗：${err.message}`);
      dead = true;
      chan.emitClose();
      return;
    }
    sock = s;
    sock.on('error', (e) => {
      console.error(`[wire] tor socket error: ${e.code || e.message}`);
      sock.destroy();
    });
    sock.on('close', () => { dead = true; chan.emitClose(); });
    sock.on('data', (chunk) => chan.feed(chunk.toString('utf8')));
    for (const out of queue.splice(0)) sock.write(out);
  });

  return chan;
}

// 可達性探測：能不能經 tor 連上那個 onion。比 tcp 的版本慢得多（電路要建），
// 所以預設逾時放寬到 30 秒——`pilot-doctor` 之類的工具用同一個介面。
function probe({ port, host = '127.0.0.1', timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, timeoutMs);
    socksConnect({ host, port }, (err, s) => {
      if (done) { if (s) s.destroy(); return; }
      done = true; clearTimeout(t);
      if (s) s.destroy();
      // 探測回 false 而不說原因，就是 #76 那個教訓的另一個版本：
      // 「連不上」與「本機 tor 沒起來」是兩件事，而工具的價值就在分得出來。
      if (err) console.error(`[wire] tor probe ${host}:${port}：${err.message}`);
      resolve(!err);
    });
  });
}

module.exports = { name, listen: tcp.listen, dial, probe, socksConnect };
