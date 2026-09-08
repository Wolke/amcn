// Acceptance DSL (proposal B §9.4, FR-011/FR-040/FR-044).
// The assert set is fixed (and hashable) at TaskSpec time; providers can
// pre-run it before bidding; failures are machine-readable and point to
// the exact assert index.
//
// assert ops (ctx = {payload, output}):
//   sha256_eq            output === sha256(payload)
//   contains   {arg}     output includes arg
//   regex      {arg}     new RegExp(arg).test(output)
//   json_valid           output parses as JSON
//   json_has_keys {arg}  parsed output has all keys in arg[]
//   max_len    {arg}     output.length <= arg
'use strict';
const { sha256, canon } = require('./wire');

function runAssert(a, ctx) {
  switch (a.op) {
    case 'sha256_eq': return ctx.output === sha256(ctx.payload);
    case 'contains': return ctx.output.includes(a.arg);
    case 'regex': return new RegExp(a.arg).test(ctx.output);
    case 'json_valid': try { JSON.parse(ctx.output); return true; } catch { return false; }
    case 'json_has_keys': try {
      const o = JSON.parse(ctx.output);
      return a.arg.every((k) => k in o);
    } catch { return false; }
    case 'max_len': return ctx.output.length <= a.arg;
    default: return false; // unknown op never auto-passes
  }
}

function runAsserts(asserts, ctx) {
  const failures = [];
  asserts.forEach((a, i) => {
    if (!runAssert(a, ctx)) failures.push({ index: i, op: a.op, arg: a.arg ?? null });
  });
  return { pass: failures.length === 0, failures }; // FR-044 machine-readable
}

const assertsHash = (asserts) => sha256(canon(asserts));

module.exports = { runAsserts, assertsHash };
