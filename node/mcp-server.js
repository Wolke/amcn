#!/usr/bin/env node
// MCP server: the demand-side entry point (§23.1, W7).
//
// proposal-B §23.1 adopts MCP for the Owner side so an existing Claude or
// self-built agent can use AMCN as a tool — "需求側整合成本最低的入口". Three
// tools: amcn_balance, amcn_publish_task, amcn_request_inference.
//
// This process holds no keys and no identity. It talks to a local Agent's
// Owner Console over 127.0.0.1 (FR-081), so signing, the keystore and the
// E2E envelope all stay inside the Agent process — P-02 is not weakened by
// adding this surface. It is a thin client, deliberately.
//
// Transport: JSON-RPC 2.0 over stdio, newline-delimited, protocol
// 2025-06-18. Zero dependencies.
//
// Run:  AMCN_CONSOLE=http://127.0.0.1:47203 node mcp-server.js
'use strict';

const PROTOCOL_VERSION = '2025-06-18';
const CONSOLE = (process.env.AMCN_CONSOLE || 'http://127.0.0.1:47203')
  .replace(/\/$/, '');
const SETTLE_TIMEOUT_MS = Number(process.env.AMCN_SETTLE_TIMEOUT_MS || 60000);
const POLL_MS = 400;

const TOOLS = [
  {
    name: 'amcn_balance',
    title: 'AMCN balance and credit line',
    description:
      'Read this agent\'s AMCN state: CC balance, dynamic credit line, ' +
      'target balance band, current strategy mode (normal/repay/spend) and ' +
      'settlement history. Use before spending to see how much credit is left.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'amcn_publish_task',
    title: 'Publish an AMCN task',
    description:
      'Publish a task to the AMCN market and return immediately with its ' +
      'task_id and contract_id. Acceptance criteria are mandatory (FR-011): ' +
      'a task with no completion condition cannot settle automatically. Use ' +
      'this when you do not want to wait for the result.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'string', description: 'The work to be done. Sent E2E-encrypted to the winning bidder only after award.' },
        units: { type: 'number', description: 'Size of the task in compute units.' },
        max_price_cc: { type: 'number', description: 'Highest price in CC this agent will pay. Bids above it are discarded.' },
        acceptance: { type: 'string', enum: ['dsl-local', 'judge-quorum'], description: 'dsl-local runs the assert set locally; judge-quorum also requires a verifier panel to attest.' },
        asserts: {
          type: 'array',
          description: 'Machine-checkable acceptance asserts, e.g. [{"op":"max_len","arg":2000}]. Note sha256_eq only works for deterministic providers.',
          items: {
            type: 'object',
            properties: { op: { type: 'string' }, arg: {} },
            required: ['op'],
          },
        },
        essential: { type: 'boolean', description: 'Default true. Mark false for optional consumption, which FR-055 pauses while the agent is repaying debt.' },
      },
      required: ['payload', 'units', 'max_price_cc', 'acceptance', 'asserts'],
      additionalProperties: false,
    },
  },
  {
    name: 'amcn_request_inference',
    title: 'Request inference through AMCN and wait',
    description:
      'Publish a task, wait for a provider to win it, execute it on their own ' +
      'machine with their own API key, pass acceptance and settle, then return ' +
      'the output. Blocks until settlement or timeout. This is the tool to use ' +
      'when your own quota is exhausted and you want someone else\'s compute.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: { type: 'string', description: 'The prompt or work item.' },
        units: { type: 'number', description: 'Size in compute units. Default 10.' },
        max_price_cc: { type: 'number', description: 'Price ceiling in CC. Default units * 1.2.' },
        acceptance: { type: 'string', enum: ['dsl-local', 'judge-quorum'], description: 'Default judge-quorum.' },
        asserts: {
          type: 'array',
          description: 'Default [{"op":"max_len","arg":4000}]. A real (non-deterministic) model will fail sha256_eq.',
          items: {
            type: 'object',
            properties: { op: { type: 'string' }, arg: {} },
            required: ['op'],
          },
        },
      },
      required: ['payload'],
      additionalProperties: false,
    },
  },
];

// --- console client ------------------------------------------------------
async function consoleGet(path) {
  const res = await fetch(`${CONSOLE}${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`console ${path} -> ${res.status} ` +
      `${body && body.error ? body.error : ''}`.trim());
  }
  return body;
}

async function consolePost(path, payload) {
  const res = await fetch(`${CONSOLE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false) {
    throw new Error(`console ${path} -> ${res.status} ` +
      `${body && body.error ? body.error : ''}`.trim());
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tools ---------------------------------------------------------------
async function amcnBalance() {
  const s = await consoleGet('/status');
  return {
    did: s.did, name: s.name,
    balance_cc: s.balance_cc,
    credit_line_cc: s.credit_line_cc,
    spendable_cc: +(s.credit_line_cc + s.balance_cc).toFixed(4),
    strategy: s.strategy,
    settlements: s.settled.length,
  };
}

async function amcnPublishTask(args) {
  const posted = await consolePost('/post', {
    payload: args.payload,
    units: args.units,
    maxPriceCC: args.max_price_cc,
    acceptance: args.acceptance,
    asserts: args.asserts,
    essential: args.essential,
  });
  return {
    task_id: posted.task_id,
    contract_id: `c-${posted.task_id}`,
    note: 'Bidding and settlement continue in the background. ' +
      'Poll amcn_balance, or use amcn_request_inference to wait.',
  };
}

async function amcnRequestInference(args) {
  const units = args.units ?? 10;
  const posted = await amcnPublishTask({
    payload: args.payload,
    units,
    max_price_cc: args.max_price_cc ?? +(units * 1.2).toFixed(4),
    acceptance: args.acceptance ?? 'judge-quorum',
    asserts: args.asserts ?? [{ op: 'max_len', arg: 4000 }],
  });

  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let r;
    try {
      r = await consoleGet(
        `/result?contract_id=${encodeURIComponent(posted.contract_id)}`);
    } catch {
      continue; // not awarded yet — no contract exists to ask about
    }
    if (r.settled) {
      return {
        contract_id: posted.contract_id, provider: r.provider,
        output: r.output, cost_cc: r.delta_cc,
        balance_after_cc: (await consoleGet('/status')).balance_cc,
      };
    }
  }
  throw new Error(
    `no settlement for ${posted.contract_id} within ${SETTLE_TIMEOUT_MS}ms. ` +
    'The task may still settle later — check amcn_balance. Common causes: ' +
    'no provider is supplying, max_price_cc is below units x the going rate, ' +
    'or acceptance asserts are failing (sha256_eq against a real model).');
}

const HANDLERS = {
  amcn_balance: amcnBalance,
  amcn_publish_task: amcnPublishTask,
  amcn_request_inference: amcnRequestInference,
};

// --- JSON-RPC over stdio -------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) =>
  send({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    // Echo the client's version when we support it, else offer ours (spec
    // §Version Negotiation).
    const asked = params && params.protocolVersion;
    reply(id, {
      protocolVersion: asked === PROTOCOL_VERSION ? asked : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'amcn', title: 'AMCN Local Node', version: '0.1.0' },
      instructions:
        'AMCN is a mutual-credit compute exchange. This server acts for one ' +
        'local Agent, reached over its Owner Console. Balances are in CC; a ' +
        'negative balance within the credit line is normal and is repaid by ' +
        'providing work, not by paying cash.',
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return; // notifications carry no id and get no response
  }
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOLS }); return; }

  if (method === 'tools/call') {
    const name = params && params.name;
    const handler = HANDLERS[name];
    // Unknown tool is a protocol error; a tool that runs and fails is a
    // result with isError (spec §Error Handling).
    if (!handler) { replyError(id, -32602, `Unknown tool: ${name}`); return; }
    try {
      const out = await handler((params && params.arguments) || {});
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
        isError: false,
      });
    } catch (err) {
      reply(id, {
        content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null,
             error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // One bad request must not take the server down.
    dispatch(msg).catch((err) => {
      if (msg && msg.id !== undefined) {
        replyError(msg.id, -32603, `Internal error: ${err.message}`);
      }
    });
  }
});
process.stdin.on('end', () => process.exit(0));
