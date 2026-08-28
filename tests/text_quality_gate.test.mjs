import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildVisionPayload,
  evaluateTextQualityGate,
  parseQualityGateJson,
  resolveTextQualityGateConfig
} from "../src/text_quality_gate.mjs";

test("resolves text quality gate config from guardrails and CLI override", () => {
  assert.equal(resolveTextQualityGateConfig({ text_quality_gate: { enabled: true } }).enabled, true);
  assert.equal(resolveTextQualityGateConfig({ text_quality_gate: { enabled: true } }, { qualityGate: false }).enabled, false);
  assert.equal(resolveTextQualityGateConfig({ text_quality_gate: { max_retries: 3 } }).max_retries, 3);
});

test("builds Responses vision payload with base64 image input", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-quality-gate-"));
  const imagePath = path.join(dir, "image.png");
  await fs.writeFile(imagePath, Buffer.from("fake-png"));

  const payload = await buildVisionPayload({
    imagePath,
    expectedText: "初回相談",
    variantId: "v1",
    variantIndex: 1,
    config: { model: "vision-test", max_output_tokens: 123 }
  });

  assert.equal(payload.model, "vision-test");
  assert.equal(payload.max_output_tokens, 123);
  assert.equal(payload.input[0].content[0].type, "input_text");
  assert.match(payload.input[0].content[0].text, /初回相談/);
  assert.equal(payload.input[0].content[1].type, "input_image");
  assert.match(payload.input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test("evaluates OpenAI vision response as OK without real network access", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-quality-gate-"));
  const imagePath = path.join(dir, "image.png");
  await fs.writeFile(imagePath, Buffer.from("fake-png"));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: "resp_test",
          output_text: '{"ok":true,"status":"ok","extracted_text":"初回相談","reason":"完全一致"}',
          usage: { total_tokens: 12 }
        })
    };
  };

  const result = await evaluateTextQualityGate({
    imagePath,
    expectedText: "初回相談",
    apiKey: "sk-test",
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(result.status, "ok");
  assert.equal(result.extracted_text, "初回相談");
  assert.deepEqual(result.usage, { total_tokens: 12 });
});

test("parses fenced JSON model output", () => {
  assert.deepEqual(parseQualityGateJson("```json\n{\"ok\":false,\"status\":\"ng\"}\n```"), {
    ok: false,
    status: "ng"
  });
});
