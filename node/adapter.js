// Provider Adapter (FR-031): OpenAI-compatible inference client.
// The API key stays in this process; only the completion result leaves.
//
// cfg: { baseUrl, model, apiKey }
//   baseUrl set   → real HTTP call to {baseUrl}/v1/chat/completions
//   baseUrl unset → deterministic mock (sha256 of prompt), still key-gated
'use strict';
const { sha256 } = require('./lib/wire');

async function complete(cfg, prompt) {
  if (!cfg.apiKey) throw new Error('adapter: no local API key resolved');
  if (!cfg.baseUrl) return sha256(prompt); // mock mode
  const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model || 'demo-model',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`adapter: provider HTTP ${res.status}`);
  const j = await res.json();
  return j.choices[0].message.content;
}

module.exports = { complete };
