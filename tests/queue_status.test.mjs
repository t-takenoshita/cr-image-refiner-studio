import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRequestOutputDir, writeJson } from "../src/manifest.mjs";
import { buildQueueEntries, selectQueueEntries, summarizeQueueEntries } from "../src/queue_status.mjs";

const row = {
  "タイムスタンプ": "2026-06-15T10:00:00+09:00",
  "依頼者名": "記事部サンプル",
  "案件名": "FIN AGA 記事LP用バナー",
  "ターゲット": "薄毛が気になり始めた男性",
  "オファー": "初回相談",
  "必須コピー": "オンライン相談"
};

test("queue entries mark unseen rows as selectable", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-queue-"));
  const entries = await buildQueueEntries([row], { dataRoot, now: "2026-06-15T12:00:00+09:00" });
  const selected = selectQueueEntries(entries, { onlyNew: true, limit: 1 });
  const summary = summarizeQueueEntries(selected);

  assert.equal(selected.length, 1);
  assert.equal(summary[0].processing_state, "unseen");
  assert.equal(summary[0].already_seen, false);
});

test("queue entries skip rows with existing manifest when only-new is set", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-queue-"));
  const entries = await buildQueueEntries([row], { dataRoot, now: "2026-06-15T12:00:00+09:00" });
  const requestId = entries[0].request.request_id;
  const outputDir = getRequestOutputDir(dataRoot, requestId);
  await writeJson(path.join(outputDir, "manifest.json"), {
    request_id: requestId,
    status: "new",
    run_status: "dry_run_complete"
  });

  const refreshed = await buildQueueEntries([row], { dataRoot, now: "2026-06-15T12:00:00+09:00" });
  const selected = selectQueueEntries(refreshed, { onlyNew: true, limit: 1 });
  const all = summarizeQueueEntries(refreshed);

  assert.equal(selected.length, 0);
  assert.equal(all[0].processing_state, "prompted");
  assert.equal(all[0].already_seen, true);
});

test("queue entries mark failed manifests so automation can skip unsafe retries", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-queue-"));
  const entries = await buildQueueEntries([row], { dataRoot, now: "2026-06-15T12:00:00+09:00" });
  const requestId = entries[0].request.request_id;
  const outputDir = getRequestOutputDir(dataRoot, requestId);
  await writeJson(path.join(outputDir, "manifest.json"), {
    request_id: requestId,
    status: "error",
    run_status: "initial_draft_image2_safety_rejected",
    error: {
      category: "image2_safety_rejection"
    }
  });

  const refreshed = await buildQueueEntries([row], { dataRoot, now: "2026-06-15T12:00:00+09:00" });
  const summary = summarizeQueueEntries(refreshed);

  assert.equal(summary[0].processing_state, "failed");
  assert.equal(summary[0].failed, true);
  assert.equal(summary[0].already_seen, true);
});
