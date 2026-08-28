import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImage2ApiPayload, buildImage2EditApiPayload, generateImage2File } from "../src/image2_api.mjs";

test("builds OpenAI image generation payload with safe defaults", () => {
  const payload = buildImage2ApiPayload("日本語広告バナー", { quality: "low" });

  assert.equal(payload.model, "gpt-image-2");
  assert.equal(payload.prompt, "日本語広告バナー");
  assert.equal(payload.n, 1);
  assert.equal(payload.size, "1088x1088");
  assert.equal(payload.output_format, "png");
  assert.equal(payload.quality, "low");
});

test("builds OpenAI image edit payload when logo input images are provided", () => {
  const payload = buildImage2EditApiPayload("ロゴを右下に配置", { quality: "medium" }, [
    { image_url: "data:image/png;base64,ZmFrZQ==" }
  ]);

  assert.equal(payload.model, "gpt-image-2");
  assert.equal(payload.prompt, "ロゴを右下に配置");
  assert.equal(payload.n, 1);
  assert.equal(payload.images.length, 1);
  assert.equal(payload.images[0].image_url, "data:image/png;base64,ZmFrZQ==");
  assert.equal(payload.input_fidelity, undefined);
});

test("writes generated base64 image without real network access", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-image2-"));
  const out = path.join(dir, "out.png");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          created: 1781500000,
          data: [{ b64_json: Buffer.from("fake-png").toString("base64") }],
          usage: { total_tokens: 10 }
        })
    };
  };

  const result = await generateImage2File({
    prompt: "画像を作る",
    outputPath: out,
    apiKey: "sk-test",
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(JSON.parse(calls[0].options.body).prompt, "画像を作る");
  assert.equal(await fs.readFile(out, "utf8"), "fake-png");
  assert.equal(result.bytes_written, 8);
  assert.deepEqual(result.usage, { total_tokens: 10 });
});

test("retries transient image API failures but not successful responses", async () => {
  let calls = 0;
  const result = await generateImage2File({
    apiKey: "sk-test",
    prompt: "test",
    outputPath: path.join(await fs.mkdtemp(path.join(os.tmpdir(), "aicr-image-retry-")), "image.png"),
    config: { max_transient_retries: 2 },
    sleepImpl: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 503, text: async () => "temporary upstream error" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from("png").toString("base64") }] })
      };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.transient_retry_count, 1);
});

test("uses image edit endpoint when input images are supplied", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-image2-edit-"));
  const out = path.join(dir, "out.png");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: [{ b64_json: Buffer.from("fake-edit-png").toString("base64") }],
          usage: { total_tokens: 22 }
        })
    };
  };

  const result = await generateImage2File({
    prompt: "ロゴを右下に配置",
    outputPath: out,
    apiKey: "sk-test",
    inputImages: [{ image_url: "data:image/png;base64,ZmFrZQ==" }],
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.openai.com/v1/images/edits");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.images[0].image_url, "data:image/png;base64,ZmFrZQ==");
  assert.equal(await fs.readFile(out, "utf8"), "fake-edit-png");
  assert.equal(result.mode, "image_edit");
  assert.equal(result.input_image_count, 1);
});
