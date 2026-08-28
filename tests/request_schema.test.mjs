import fs from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MANAGEMENT_COLUMNS, STATUS_VALUES, normalizeRequestRow } from "../src/request_schema.mjs";

const fixture = JSON.parse(
  await fs.readFile(new URL("./fixtures/google_form_row.json", import.meta.url), "utf8")
);

test("normalizes a Google Form row into an AICR request", () => {
  const request = normalizeRequestRow(fixture, {
    rowNumber: 2,
    fixturePath: "tests/fixtures/google_form_row.json",
    now: "2026-06-15T12:00:00+09:00"
  });

  assert.match(request.request_id, /^aicr_20260615_[a-f0-9]{10}$/);
  assert.equal(request.status, "new");
  assert.equal(request.project.name, "FIN AGA 記事LP用バナー");
  assert.equal(request.learning_feedback.auto_register_learning, false);
  assert.equal(request.validation.ok, true);
});

test("normalizes current AICR form headers", () => {
  const row = {
    "タイムスタンプ": "2026/06/12 14:08:34",
    "記入者名": "壬生千尋",
    "案件ID": "tcb-nose",
    "案件名": "TCB鼻",
    "CR案の仮タイトル": "BAのCR",
    "狙うターゲット": "20代前半",
    "訴求軸": "理想変化",
    "訴求の一言コピー": "忘れ鼻アプデ術",
    "刺したい欲求・不安・比較軸": "鼻の悪目立ちする印象を無くしたい",
    "オファーの見せ方": "クーポン適用で最大無料",
    "デザインテイスト": "雑誌/記事風, ビフォーアフター風, 韓国/トレンド風",
    "入れたいビジュアル要素": "鼻のBA",
    "入れたい文言・数字・権威付け": "ノー加工で生きていける！？",
    "この案がCPA/CVRに効きそうな理由": "BA推し"
  };
  const request = normalizeRequestRow(row, {
    rowNumber: 2,
    now: "2026-06-15T12:00:00+09:00"
  });

  assert.equal(request.requester.name, "壬生千尋");
  assert.equal(request.project.id, "tcb-nose");
  assert.equal(request.project.name, "TCB鼻");
  assert.equal(request.creative_title, "BAのCR");
  assert.equal(request.target_audience, "20代前半");
  assert.equal(request.offer, "クーポン適用で最大無料");
  assert.equal(request.visual_elements, "鼻のBA");
});

test("exports required management columns and status values", () => {
  for (const column of ["request_id", "status", "locked_at", "image_4_url", "adoption_status", "feedback"]) {
    assert.ok(MANAGEMENT_COLUMNS.includes(column));
  }
  for (const status of ["new", "generated", "posted", "policy_hold"]) {
    assert.ok(STATUS_VALUES.includes(status));
  }
});
