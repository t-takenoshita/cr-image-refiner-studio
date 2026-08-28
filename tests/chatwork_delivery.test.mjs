import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialDraftChatworkPayload,
  sendChatworkDelivery
} from "../src/chatwork_delivery.mjs";

test("builds compact initial draft Chatwork payload with files", () => {
  const payload = buildInitialDraftChatworkPayload({
    promptPack: {
      request_id: "aicr_20260615_test",
      request_summary: {
        project_name: "JUNO痩身",
        creative_title: "1部位だけ",
        target_audience: "韓国美容に関心がある層",
        appeal: "理想変化",
        offer: "理想像を大きく見せる"
      }
    },
    images: [
      { variant_index: 1, variant_id: "v1", local_path: "/tmp/v1.png" },
      { variant_index: 2, variant_id: "v2", local_path: "/tmp/v2.png" }
    ],
    toAll: true,
    policyStatus: "warn"
  });

  assert.match(payload.message, /^\[toall\]/);
  assert.match(payload.message, /画像1: v1/);
  assert.match(payload.message, /修正対応は自動再生成せず/);
  assert.deepEqual(payload.files, ["/tmp/v1.png", "/tmp/v2.png"]);
});

test("shows the selected form logo in the Chatwork message", () => {
  const payload = buildInitialDraftChatworkPayload({
    promptPack: { request_id: "req-logo", request_summary: { project_name: "案件", logo_selection: "JUNO" } },
    images: []
  });
  assert.match(payload.message, /選択ロゴ: JUNO/);
});

test("uses a personal mention instead of toall", () => {
  const payload = buildInitialDraftChatworkPayload({
    promptPack: { request_id: "req-mention", request_summary: { project_name: "案件" } },
    mention: { tag: "[To:123456] 山田太郎さん" },
    toAll: true,
    images: []
  });
  assert.match(payload.message, /^\[To:123456\] 山田太郎さん/);
  assert.doesNotMatch(payload.message, /\[toall\]/i);
});

test("marks human-reviewed policy hold posts in initial draft payload", () => {
  const payload = buildInitialDraftChatworkPayload({
    promptPack: {
      request_id: "aicr_20260630_hold",
      request_summary: {
        project_name: "Rクリニックレディース"
      }
    },
    images: [{ variant_index: 1, variant_id: "v1", local_path: "/tmp/v1.png" }],
    toAll: false,
    policyStatus: "hold",
    humanReviewed: true
  });

  assert.match(payload.message, /policy_gate: hold/);
  assert.match(payload.message, /policy_holdを人間確認済みとして初稿送信/);
});

test("posts message and files through injectable fetch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-chatwork-"));
  const file = path.join(dir, "image.png");
  await fs.writeFile(file, "fake");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const payload = url.endsWith("/messages")
      ? { message_id: "m1" }
      : { file_id: 123 };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload)
    };
  };

  const result = await sendChatworkDelivery({
    roomId: "442334168",
    token: "cw-test",
    message: "hello",
    files: [file],
    fetchImpl
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/messages$/);
  assert.match(calls[1].url, /\/files$/);
  assert.equal(result.message_id, "m1");
  assert.deepEqual(result.file_ids, [123]);
});
