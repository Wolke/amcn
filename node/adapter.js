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

async function complete(cfg, prompt, ctx = null) {
  if (!cfg.apiKey) throw new Error('adapter: no local API key resolved');
  if (!cfg.baseUrl) return sha256(prompt); // mock mode
  if (ctx && ctx.endUser) requireTerms(cfg);
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
  return j.choices[0].message.content;
}

module.exports = { complete, attribute, requireTerms };
