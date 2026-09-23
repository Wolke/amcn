// Provider Adapter (FR-031): OpenAI-compatible inference client.
// The API key stays in this process; only the completion result leaves.
//
// cfg: { baseUrl, model, apiKey, terms, attribution }
//   baseUrl set   → real HTTP call to {baseUrl}/v1/chat/completions
//   baseUrl unset → deterministic mock (sha256 of prompt), still key-gated
//
// ctx: { endUser, contractId } — present when this call is executing *someone
// else's* contract, absent when the node is doing its own work. That
// distinction is the whole reason the next two blocks exist.
//
// --- Why third-party work is gated and attributed (§4 #67, P-10) ---
//
// The key-lending proposal was checked against provider terms in
// docs/evaluation/key-lending-verification.md. Handing a key to a borrower is
// prohibited outright ("customers cannot buy, sell, or transfer API keys
// from, to, or with a third party"), which is why AMCN does not do it. What
// remains is a node serving another agent's request on its own key — and the
// same sentence that bans key transfer also says "resell or lease access to
// your account or any End User Account". The phrase *End User Account* is the
// tell: provider terms already contemplate a customer having end users. An
// application that serves identified end users is the ordinary, expected
// case; what is prohibited is sharing credentials and reselling access.
//
// So the compliant posture is not to make third-party traffic blend in — it
// is to make it *declared*. Two mechanisms, and note that a node hiding its
// traffic would do the exact opposite of both:
//
//   1. Attribution. Every upstream call made on behalf of another agent
//      carries that agent's DID as the end-user identifier. A DID is already
//      a hash of a public key, so it is stable and pseudonymous — it is
//      exactly what an abuse-attribution field wants, and it lets the node
//      owner match a provider's report back to a contract in their own
//      ledger.
//   2. A terms declaration. Serving third-party work on a real upstream
//      requires cfg.terms.attested — the node owner stating that their
//      agreement with that provider permits it.
//
// Being honest about (2): this is a declaration, not a verification. Nothing
// here can confirm the owner read their contract, and a checkbox anyone will
// tick is partly theatre. It is kept because P-10 pushes the burden to the
// node owner and this is what makes that push recorded and auditable rather
// than assumed — the config is the artifact. It does not make the underlying
// question (does serving third-party traffic count as reselling access?)
// resolved; see §3 of the verification document, which says it is unresolved.
'use strict';
const { sha256 } = require('./lib/wire');

// Only reached for third-party work on a real upstream: own work has no end
// user to attribute, and mock mode has no provider to be accountable to.
function requireTerms(cfg) {
  if (cfg.terms && cfg.terms.attested === true) return;
  throw new Error(
    'adapter: refusing to run another agent\'s request on this upstream — ' +
    'adapter.terms.attested is not set. Set it only if your agreement with ' +
    'this provider permits serving third-party requests (P-10, §4 #67; see ' +
    'docs/evaluation/key-lending-verification.md)');
}

// `user` has been in the OpenAI chat-completions schema for years, so
// third-party OpenAI-compatible servers tolerate it; `safety_identifier` is
// newer and a strict server may reject the unknown field, so it is opt-in.
// 'none' exists for a local model, where there is no upstream to be
// accountable to and no terms to comply with.
function attribute(body, cfg, ctx) {
  const mode = cfg.attribution || 'user';
  if (mode === 'none' || !ctx || !ctx.endUser) return body;
  const out = { ...body, user: ctx.endUser };
  if (mode === 'openai') out.safety_identifier = ctx.endUser;
  return out;
}

// 回傳 `{ content, usage }` 而不是只有字串。usage 是**成本**，而先前這一行
// 把它丟掉了（`return j.choices[0].message.content`）——於是「替別人做事花掉
// 多少自己的 token」在整個原型裡沒有任何地方知道。OpenAI-compatible 的回應
// 本來就帶 `usage`，所以這不是新功能，是**先前沒有收下已經送來的東西**。
// 拿不到 usage 的供應商由 lib/spend.js 估算，並標成估計值。
// Anthropic 的 Messages API **不是** OpenAI 相容的：路徑是 `/v1/messages`、
// 認證走 `x-api-key`＋`anthropic-version`、回應是 `content[]` 而不是
// `choices[]`、usage 的欄位叫 `input_tokens`／`output_tokens`。所以它是第二種
// 上游形狀，而不是換一個 baseUrl 就好——這一點寫錯的話，症狀會是「賣得出去
// 但拿不到 usage」，而那正好讓 #94 的花費上限變成裝飾。
//
// 刻意用原生 `fetch` 而不是官方 SDK：這個 repo 的硬規則是**零第三方相依**
// （CONTRIBUTING、CI 都守著它），而那條規則的理由是「clone 完不必 npm install
// 就能跑」——那正是推廣路徑的第一步。
async function anthropicComplete(cfg, prompt, ctx) {
  const base = cfg.baseUrl || 'https://api.anthropic.com';
  const body = {
    model: cfg.model || 'claude-opus-5',
    max_tokens: Number(cfg.maxTokens || 4096),
    messages: [{ role: 'user', content: prompt }],
  };
  // 第三方流量要**具名**而不是混進自己的用量裡（§4 #67）。Anthropic 這一側
  // 的欄位是 metadata.user_id，與 OpenAI 的 `user` 同一個用途。
  if (ctx && ctx.endUser && (cfg.attribution || 'user') !== 'none') {
    body.metadata = { user_id: ctx.endUser };
  }
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`adapter: provider HTTP ${res.status}`);
  }
  const j = await res.json();
  const content = (j.content || [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  // 欄位名對映：spend 帳目要的是 prompt/completion，而這一家叫 input/output。
  const usage = j.usage
    ? { prompt_tokens: j.usage.input_tokens, completion_tokens: j.usage.output_tokens }
    : null;
  return { content, usage };
}

async function complete(cfg, prompt, ctx = null) {
  if (!cfg.apiKey) throw new Error('adapter: no local API key resolved');
  // mock 模式沒有上游，所以也沒有成本：usage 明確是 null 而不是 0，
  // 「不知道」與「零」必須分得開。
  if (!cfg.baseUrl && cfg.api !== 'anthropic') {
    return { content: sha256(prompt), usage: null };
  }
  if (ctx && ctx.endUser) requireTerms(cfg);
  if (cfg.api === 'anthropic') return anthropicComplete(cfg, prompt, ctx);
  const body = attribute({
    model: cfg.model || 'demo-model',
    messages: [{ role: 'user', content: prompt }],
  }, cfg, ctx);
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`adapter: provider HTTP ${res.status}`);
  const j = await res.json();
  return { content: j.choices[0].message.content, usage: j.usage || null };
}

module.exports = { complete, attribute, requireTerms, anthropicComplete };
