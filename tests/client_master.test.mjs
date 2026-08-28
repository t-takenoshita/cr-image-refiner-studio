import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyClientMasterToRequest,
  loadClientMasterContext,
  normalizeClientMasterRow
} from "../src/client_master.mjs";
import { normalizeRequestRow } from "../src/request_schema.mjs";
import { buildPromptPack } from "../src/prompt_builder.mjs";

const guardrails = {
  client_master: { enabled: true },
  brand_assets: {
    logo_insertion_enabled: true,
    required_note_band_enabled: true,
    default_logo_placement: "bottom_right",
    note_band: {
      use_brand_color_as_background: true
    }
  },
  policy: {}
};

test("normalizes client master rows", () => {
  const record = normalizeClientMasterRow(
    {
      "案件ID": "r-ladies",
      "案件名": "Rクリニックレディース",
      "ロゴ画像の参照(DriveファイルIDまたはURL)": "https://example.com/logo.png",
      "必須注釈の文言": "※自由診療です",
      "NG表現(カンマ区切り)": "マスターNG語, 禁止ワード",
      "ブランドカラー(HEX)": "12ab34",
      "備考": "テスト"
    },
    { rowNumber: 2 }
  );

  assert.equal(record.client_id, "r-ladies");
  assert.equal(record.client_name, "Rクリニックレディース");
  assert.equal(record.logo.source_type, "url");
  assert.equal(record.required_note, "※自由診療です");
  assert.deepEqual(record.ng_expressions, ["マスターNG語", "禁止ワード"]);
  assert.equal(record.brand_color_hex, "#12AB34");
});

test("applies matched client master to request, prompt pack, and policy gate", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-client-master-"));
  const masterCsvPath = path.join(dataRoot, "client_master.csv");
  await fs.writeFile(
    masterCsvPath,
    [
      "案件ID,案件名,ロゴ画像の参照(DriveファイルIDまたはURL),必須注釈の文言,NG表現(カンマ区切り),ブランドカラー(HEX),備考",
      "r-ladies,Rクリニックレディース,https://example.com/logo.png,※自由診療です,マスターNG語,#12AB34,テスト"
    ].join("\n")
  );

  const context = await loadClientMasterContext({
    projectRoot: process.cwd(),
    args: { clientMasterCsv: masterCsvPath },
    guardrails
  });
  const request = applyClientMasterToRequest(
    normalizeRequestRow(
      {
        "タイムスタンプ": "2026-07-07T10:00:00+09:00",
        "案件名": "Rクリニックレディース",
        "ターゲット": "30代女性",
        "オファー": "初回相談",
        "必須コピー": "マスターNG語"
      },
      { rowNumber: 2, now: "2026-07-07T10:00:00+09:00" }
    ),
    context,
    { guardrails }
  );

  assert.equal(request.client_master.matched, true);
  assert.ok(request.ng_expressions.includes("マスターNG語"));
  assert.equal(request.brand_assets.logo.enabled, true);
  assert.equal(request.brand_assets.required_note.text, "※自由診療です");

  const promptPack = await buildPromptPack(request, {
    guardrails,
    templatePath: path.resolve("config/prompt_templates/banner_variants.json"),
    now: "2026-07-07T10:00:00+09:00"
  });

  assert.equal(promptPack.client_master.matched, true);
  assert.equal(promptPack.brand_assets.required_note.text, "※自由診療です");
  assert.equal(promptPack.brand_assets.required_note.band_plan.status, "planned");
  assert.equal(promptPack.brand_assets.bottom_safe_area.prompt_enabled, true);
  assert.ok(promptPack.brand_assets.bottom_safe_area.bottom_percent > 0);
  assert.equal(promptPack.brand_assets.logo.adjusted_for_note_band, true);
  assert.equal(promptPack.request_policy_gate_result.status, "pass");
  assert.deepEqual(promptPack.request_policy_gate_result.findings, []);
  assert.ok(promptPack.variants[0].prompt.includes("ロゴ配置指定"));
  assert.ok(promptPack.variants[0].prompt.includes("下部セーフエリア"));
  assert.ok(promptPack.variants[0].prompt.includes("案件別NG表現: マスターNG語"));
  assert.equal(promptPack.variants[0].prompt.includes("案件別ブランドカラー"), false);
  assert.equal(promptPack.variants[0].prompt.includes("※自由診療です"), false);
});

test("safe-area prompt and logo note-band avoidance can be disabled independently", async () => {
  const safeAreaOnlyPromptPack = await buildPromptPackForClientMaster({
    logo_avoid_note_band_enabled: false
  });
  assert.equal(safeAreaOnlyPromptPack.brand_assets.logo.adjusted_for_note_band, false);
  assert.equal(safeAreaOnlyPromptPack.brand_assets.bottom_safe_area.prompt_enabled, true);
  assert.ok(safeAreaOnlyPromptPack.variants[0].prompt.includes("下部セーフエリア"));

  const logoAvoidanceOnlyPromptPack = await buildPromptPackForClientMaster({
    bottom_safe_area_prompt_enabled: false
  });
  assert.equal(logoAvoidanceOnlyPromptPack.brand_assets.logo.adjusted_for_note_band, true);
  assert.equal(logoAvoidanceOnlyPromptPack.brand_assets.bottom_safe_area, null);
  assert.equal(logoAvoidanceOnlyPromptPack.variants[0].prompt.includes("下部セーフエリア"), false);
  assert.ok(logoAvoidanceOnlyPromptPack.variants[0].prompt.includes("注釈帯の上端より上"));
});

test("does not add note safe-area prompt when required note is empty", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-client-master-empty-note-"));
  const masterCsvPath = path.join(dataRoot, "client_master.csv");
  await fs.writeFile(
    masterCsvPath,
    [
      "案件ID,案件名,ロゴ画像の参照(DriveファイルIDまたはURL),必須注釈の文言,NG表現(カンマ区切り),ブランドカラー(HEX),備考",
      "r-ladies,Rクリニックレディース,https://example.com/logo.png,,マスターNG語,#12AB34,テスト"
    ].join("\n")
  );

  const context = await loadClientMasterContext({
    projectRoot: process.cwd(),
    args: { clientMasterCsv: masterCsvPath },
    guardrails
  });
  const request = applyClientMasterToRequest(
    normalizeRequestRow(
      {
        "タイムスタンプ": "2026-07-07T10:00:00+09:00",
        "案件名": "Rクリニックレディース",
        "ターゲット": "30代女性",
        "オファー": "初回相談",
        "必須コピー": "まずは相談"
      },
      { rowNumber: 2, now: "2026-07-07T10:00:00+09:00" }
    ),
    context,
    { guardrails }
  );
  const promptPack = await buildPromptPack(request, {
    guardrails,
    templatePath: path.resolve("config/prompt_templates/banner_variants.json"),
    now: "2026-07-07T10:00:00+09:00"
  });

  assert.equal(promptPack.brand_assets.required_note.available, false);
  assert.equal(promptPack.brand_assets.required_note.enabled, false);
  assert.equal(promptPack.brand_assets.bottom_safe_area, null);
  assert.equal(promptPack.brand_assets.logo.adjusted_for_note_band, false);
  assert.equal(promptPack.variants[0].prompt.includes("下部セーフエリア"), false);
});

test("falls back when no client master record matches", async () => {
  const context = {
    enabled: true,
    status: "loaded",
    records: [],
    index: { byName: new Map(), byId: new Map(), warnings: [] },
    warnings: []
  };
  const request = applyClientMasterToRequest(
    normalizeRequestRow(
      {
        "タイムスタンプ": "2026-07-07T10:00:00+09:00",
        "案件名": "未登録案件",
        "ターゲット": "30代女性",
        "オファー": "初回相談",
        "必須コピー": "まずは相談"
      },
      { rowNumber: 2, now: "2026-07-07T10:00:00+09:00" }
    ),
    context,
    { guardrails }
  );

  assert.equal(request.client_master.matched, false);
  assert.equal(request.brand_assets, undefined);
  assert.ok(request.validation.warnings.some((warning) => warning.includes("no master record")));
});

async function buildPromptPackForClientMaster(brandAssetOverrides = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-client-master-flags-"));
  const masterCsvPath = path.join(dataRoot, "client_master.csv");
  await fs.writeFile(
    masterCsvPath,
    [
      "案件ID,案件名,ロゴ画像の参照(DriveファイルIDまたはURL),必須注釈の文言,NG表現(カンマ区切り),ブランドカラー(HEX),備考",
      "r-ladies,Rクリニックレディース,https://example.com/logo.png,※自由診療です,マスターNG語,#12AB34,テスト"
    ].join("\n")
  );

  const localGuardrails = {
    ...guardrails,
    brand_assets: {
      ...guardrails.brand_assets,
      ...brandAssetOverrides
    }
  };
  const context = await loadClientMasterContext({
    projectRoot: process.cwd(),
    args: { clientMasterCsv: masterCsvPath },
    guardrails: localGuardrails
  });
  const request = applyClientMasterToRequest(
    normalizeRequestRow(
      {
        "タイムスタンプ": "2026-07-07T10:00:00+09:00",
        "案件名": "Rクリニックレディース",
        "ターゲット": "30代女性",
        "オファー": "初回相談",
        "必須コピー": "まずは相談"
      },
      { rowNumber: 2, now: "2026-07-07T10:00:00+09:00" }
    ),
    context,
    { guardrails: localGuardrails }
  );

  return buildPromptPack(request, {
    guardrails: localGuardrails,
    templatePath: path.resolve("config/prompt_templates/banner_variants.json"),
    now: "2026-07-07T10:00:00+09:00"
  });
}
