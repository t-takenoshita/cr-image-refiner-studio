import { test } from "node:test";
import assert from "node:assert/strict";
import { runPolicyGate } from "../src/policy_gate.mjs";

test("repository policy gate stays disabled", () => {
  const result = runPolicyGate();

  assert.equal(result.mode, "disabled");
  assert.equal(result.status, "pass");
  assert.equal(result.risk_level, "none");
  assert.deepEqual(result.checked_categories, []);
  assert.deepEqual(result.findings, []);
});
