import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getRequestOutputDir, writeJson } from "../src/manifest.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test.skip("legacy policy hold review flow", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-initial-draft-data-"));
  const csvPath = path.join(dataRoot, "policy_hold_requests.csv");
  await fs.writeFile(
    csvPath,
    [
      "タイムスタンプ,依頼者名,案件名,CR案の仮タイトル,ターゲット,訴求軸,オファー,必須コピー,入れたいビジュアル要素,この案がCPA/CVRに効きそうな理由",
      "2026-06-30T10:00:00+09:00,北上佳純,Rクリニックレディース,即効性,30代女性,理想変化,ボリュームアップ注射 9800円,最短3ヶ月で発毛効果を実感,右ななめ45度の方向に向かって微笑んでいる女性,すぐ生える期待感を持たせられるから",
      "2026-06-30T10:05:00+09:00,北上佳純,Rクリニックレディース,即効性2,30代女性,理想変化,ボリュームアップ注射 9800円,最短3ヶ月で発毛効果を実感,右ななめ45度の方向に向かって微笑んでいる女性,すぐ生える期待感を持たせられるから"
    ].join("\n")
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/run_initial_draft.mjs",
      "--csv",
      csvPath,
      "--data-root",
      dataRoot,
      "--only-new",
      "--include-prompted",
      "--limit",
      "2",
      "--execute",
      "--send-chatwork",
      "--guardrails",
      "config/guardrails.initial_draft.example.json",
      "--now",
      "2026-06-30T12:00:00+09:00"
    ],
    { cwd: repoRoot }
  );

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.processed_count, 2);
  assert.deepEqual(
    result.results.map((item) => item.status),
    ["review_required", "review_required"]
  );
  assert.deepEqual(result.results[0].image_paths, []);
  assert.equal(result.results[0].chatwork_message_id, null);

  const manifest = JSON.parse(await fs.readFile(result.results[0].manifest_path, "utf8"));
  const reviewRequired = JSON.parse(await fs.readFile(result.results[0].review_required_path, "utf8"));
  assert.equal(manifest.status, "policy_hold");
  assert.equal(manifest.run_status, "review_required");
  assert.equal(manifest.steps.image2_generation.status, "blocked");
  assert.equal(manifest.steps.chatwork_post.status, "blocked");
  assert.equal(reviewRequired.status, "review_required");
  assert.match(reviewRequired.reason, /policy_hold/);
});

test.skip("legacy policy hold queue flow", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-initial-draft-policy-skip-"));
  const csvPath = path.join(dataRoot, "policy_hold_then_next.csv");
  await fs.writeFile(
    csvPath,
    [
      "request_id,status,タイムスタンプ,依頼者名,案件名,CR案の仮タイトル,ターゲット,訴求軸,オファー,必須コピー,入れたいビジュアル要素,この案がCPA/CVRに効きそうな理由",
      "old_hold,new,2026-06-30T10:00:00+09:00,北上佳純,Rクリニックレディース,即効性,30代女性,理想変化,初回相談,絶対に変わる,人物写真,CVR改善",
      "next_hold,new,2026-06-30T10:05:00+09:00,北上佳純,Rクリニックレディース,即効性2,30代女性,理想変化,初回相談,絶対に変わる,人物写真,CVR改善"
    ].join("\n")
  );
  await writeJson(path.join(getRequestOutputDir(dataRoot, "old_hold"), "manifest.json"), {
    request_id: "old_hold",
    status: "policy_hold",
    run_status: "review_required"
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/run_initial_draft.mjs",
      "--csv",
      csvPath,
      "--data-root",
      dataRoot,
      "--only-new",
      "--include-prompted",
      "--limit",
      "1",
      "--execute",
      "--send-chatwork",
      "--guardrails",
      "config/guardrails.initial_draft.example.json",
      "--now",
      "2026-06-30T12:00:00+09:00"
    ],
    { cwd: repoRoot }
  );

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.selection.selected_count, 1);
  assert.equal(result.selection.selected_rows[0].request_id, "next_hold");
  assert.equal(result.processed_count, 1);
  assert.equal(result.results[0].request_id, "next_hold");
  assert.equal(result.results[0].status, "review_required");
});

test("initial draft retry can target a specific failed request id", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-initial-draft-data-"));
  const csvPath = path.join(dataRoot, "failed_requests.csv");
  await fs.writeFile(
    csvPath,
    [
      "request_id,status,タイムスタンプ,依頼者名,案件名,CR案の仮タイトル,ターゲット,訴求軸,オファー,必須コピー,入れたいビジュアル要素,この案がCPA/CVRに効きそうな理由",
      "old_failed,new,2026-06-18T10:00:00+09:00,三宅悠汰,JUNO痩身,古い失敗,30代女性,価格,初回相談,オンライン相談,清潔な人物写真,相談ハードルを下げる",
      "target_failed,new,2026-06-30T19:43:48+09:00,北上佳純,Rクリニックレディース,ポイント訴求_七夕,30代女性,価格/オファー,50000ポイントプレゼント,公式LINEにご登録のあなたへ,七夕モチーフ,緊急性でCVR改善"
    ].join("\n")
  );

  for (const requestId of ["old_failed", "target_failed"]) {
    await writeJson(path.join(getRequestOutputDir(dataRoot, requestId), "manifest.json"), {
      request_id: requestId,
      status: "error",
      run_status: "initial_draft_image2_failed"
    });
  }

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/run_initial_draft.mjs",
      "--csv",
      csvPath,
      "--data-root",
      dataRoot,
      "--only-new",
      "--include-prompted",
      "--retry-failed",
      "--request-id",
      "target_failed",
      "--limit",
      "1",
      "--guardrails",
      "config/guardrails.initial_draft.example.json",
      "--now",
      "2026-07-01T17:10:00+09:00"
    ],
    { cwd: repoRoot }
  );

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.selection.target_request_id, "target_failed");
  assert.equal(result.selection.selected_count, 1);
  assert.equal(result.selection.selected_rows[0].request_id, "target_failed");
  assert.equal(result.selection.selected_rows[0].row_number, 3);
  assert.equal(result.processed_count, 1);
  assert.equal(result.results[0].request_id, "target_failed");

  const oldManifest = JSON.parse(
    await fs.readFile(path.join(getRequestOutputDir(dataRoot, "old_failed"), "manifest.json"), "utf8")
  );
  assert.equal(oldManifest.status, "error");
});

test("initial draft dry-run records client master brand asset application", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-initial-draft-master-"));
  const csvPath = path.join(dataRoot, "requests.csv");
  const masterCsvPath = path.join(dataRoot, "client_master.csv");
  const guardrailsPath = path.join(dataRoot, "guardrails.master.json");
  await fs.writeFile(
    csvPath,
    [
      "タイムスタンプ,依頼者名,案件名,CR案の仮タイトル,ターゲット,訴求軸,オファー,必須コピー,入れたいビジュアル要素,この案がCPA/CVRに効きそうな理由",
      "2026-07-07T10:00:00+09:00,品質テスト,Rクリニックレディース,注釈テスト,30代女性,価格比較,初回限定,まずは相談,人物写真,クリック前理解を高める"
    ].join("\n")
  );
  await fs.writeFile(
    masterCsvPath,
    [
      "案件ID,案件名,ロゴ画像の参照(DriveファイルIDまたはURL),必須注釈の文言,NG表現(カンマ区切り),ブランドカラー(HEX),備考",
      "r-ladies,Rクリニックレディース,https://example.com/logo.png,※自由診療です,マスターNG語,#12AB34,テスト"
    ].join("\n")
  );
  const guardrails = JSON.parse(await fs.readFile(path.join(repoRoot, "config/guardrails.initial_draft.example.json"), "utf8"));
  guardrails.client_master.enabled = true;
  guardrails.brand_assets.logo_insertion_enabled = true;
  guardrails.brand_assets.required_note_band_enabled = true;
  await writeJson(guardrailsPath, guardrails);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/run_initial_draft.mjs",
      "--csv",
      csvPath,
      "--client-master-csv",
      masterCsvPath,
      "--data-root",
      dataRoot,
      "--only-new",
      "--limit",
      "1",
      "--guardrails",
      guardrailsPath,
      "--now",
      "2026-07-07T12:00:00+09:00"
    ],
    { cwd: repoRoot }
  );

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.execute, false);
  assert.equal(result.client_master.status, "loaded");
  assert.equal(result.client_master.record_count, 1);
  assert.equal(result.results[0].client_master.matched, true);
  assert.equal(result.results[0].brand_assets.logo.enabled, true);
  assert.equal(result.results[0].brand_assets.required_note.text, "※自由診療です");

  const plan = JSON.parse(await fs.readFile(result.results[0].plan_path, "utf8"));
  const manifest = JSON.parse(await fs.readFile(result.results[0].manifest_path, "utf8"));
  assert.equal(plan.client_master.matched, true);
  assert.equal(plan.brand_assets.required_note.text, "※自由診療です");
  assert.equal(plan.brand_assets.bottom_safe_area.prompt_enabled, true);
  assert.ok(plan.brand_assets.bottom_safe_area.bottom_percent > 0);
  assert.equal(plan.external_actions.logo_input_image.will_execute, false);
  assert.equal(plan.external_actions.required_note_band.will_execute, false);
  assert.equal(plan.external_actions.bottom_safe_area_prompt.applied, true);
  assert.equal(manifest.client_master.matched, true);
  assert.equal(manifest.brand_assets.brand_color.hex, "#12AB34");
});

test("initial draft dry-run keeps logo and note features inert when brand asset flags are off", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-initial-draft-master-off-"));
  const csvPath = path.join(dataRoot, "requests.csv");
  const masterCsvPath = path.join(dataRoot, "client_master.csv");
  const guardrailsPath = path.join(dataRoot, "guardrails.master-off.json");
  await fs.writeFile(
    csvPath,
    [
      "タイムスタンプ,依頼者名,案件名,CR案の仮タイトル,ターゲット,訴求軸,オファー,必須コピー,入れたいビジュアル要素,この案がCPA/CVRに効きそうな理由",
      "2026-07-07T10:00:00+09:00,品質テスト,Rクリニックレディース,OFFテスト,30代女性,価格比較,初回限定,まずは相談,人物写真,クリック前理解を高める"
    ].join("\n")
  );
  await fs.writeFile(
    masterCsvPath,
    [
      "案件ID,案件名,ロゴ画像の参照(DriveファイルIDまたはURL),必須注釈の文言,NG表現(カンマ区切り),ブランドカラー(HEX),備考",
      "r-ladies,Rクリニックレディース,https://example.com/logo.png,※自由診療です,マスターNG語,#12AB34,テスト"
    ].join("\n")
  );
  const guardrails = JSON.parse(await fs.readFile(path.join(repoRoot, "config/guardrails.initial_draft.example.json"), "utf8"));
  guardrails.client_master.enabled = true;
  guardrails.brand_assets.logo_insertion_enabled = false;
  guardrails.brand_assets.required_note_band_enabled = false;
  guardrails.brand_assets.brand_color_prompt_enabled = false;
  await writeJson(guardrailsPath, guardrails);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/run_initial_draft.mjs",
      "--csv",
      csvPath,
      "--client-master-csv",
      masterCsvPath,
      "--data-root",
      dataRoot,
      "--only-new",
      "--limit",
      "1",
      "--guardrails",
      guardrailsPath,
      "--now",
      "2026-07-07T12:00:00+09:00"
    ],
    { cwd: repoRoot }
  );

  const result = JSON.parse(stdout);
  const plan = JSON.parse(await fs.readFile(result.results[0].plan_path, "utf8"));
  const promptPack = JSON.parse(await fs.readFile(result.results[0].prompt_pack_path, "utf8"));
  const prompt = promptPack.variants[0].prompt;

  assert.equal(result.results[0].client_master.matched, true);
  assert.equal(result.results[0].brand_assets.logo.available, true);
  assert.equal(result.results[0].brand_assets.logo.enabled, false);
  assert.equal(result.results[0].brand_assets.required_note.available, true);
  assert.equal(result.results[0].brand_assets.required_note.enabled, false);
  assert.equal(plan.external_actions.logo_input_image.will_execute, false);
  assert.equal(plan.external_actions.required_note_band.will_execute, false);
  assert.equal(prompt.includes("ロゴ配置指定"), false);
  assert.equal(prompt.includes("注釈帯予約"), false);
  assert.equal(prompt.includes("案件別ブランドカラー"), false);
  assert.equal(prompt.includes("※自由診療です"), false);
});

test("initial draft dry-run can disable only note-band logo adjustment and safe-area prompt", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-initial-draft-safearea-off-"));
  const csvPath = path.join(dataRoot, "requests.csv");
  const masterCsvPath = path.join(dataRoot, "client_master.csv");
  const guardrailsPath = path.join(dataRoot, "guardrails.safearea-off.json");
  await fs.writeFile(
    csvPath,
    [
      "タイムスタンプ,依頼者名,案件名,CR案の仮タイトル,ターゲット,訴求軸,オファー,必須コピー,入れたいビジュアル要素,この案がCPA/CVRに効きそうな理由",
      "2026-07-07T10:00:00+09:00,品質テスト,Rクリニックレディース,セーフエリアOFF,30代女性,価格比較,初回限定,まずは相談,人物写真,クリック前理解を高める"
    ].join("\n")
  );
  await fs.writeFile(
    masterCsvPath,
    [
      "案件ID,案件名,ロゴ画像の参照(DriveファイルIDまたはURL),必須注釈の文言,NG表現(カンマ区切り),ブランドカラー(HEX),備考",
      "r-ladies,Rクリニックレディース,https://example.com/logo.png,※自由診療です,マスターNG語,#12AB34,テスト"
    ].join("\n")
  );
  const guardrails = JSON.parse(await fs.readFile(path.join(repoRoot, "config/guardrails.initial_draft.example.json"), "utf8"));
  guardrails.client_master.enabled = true;
  guardrails.brand_assets.logo_insertion_enabled = true;
  guardrails.brand_assets.required_note_band_enabled = true;
  guardrails.brand_assets.logo_avoid_note_band_enabled = false;
  guardrails.brand_assets.bottom_safe_area_prompt_enabled = false;
  await writeJson(guardrailsPath, guardrails);

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/run_initial_draft.mjs",
      "--csv",
      csvPath,
      "--client-master-csv",
      masterCsvPath,
      "--data-root",
      dataRoot,
      "--only-new",
      "--limit",
      "1",
      "--guardrails",
      guardrailsPath,
      "--now",
      "2026-07-07T12:00:00+09:00"
    ],
    { cwd: repoRoot }
  );

  const result = JSON.parse(stdout);
  const plan = JSON.parse(await fs.readFile(result.results[0].plan_path, "utf8"));
  const promptPack = JSON.parse(await fs.readFile(result.results[0].prompt_pack_path, "utf8"));
  const prompt = promptPack.variants[0].prompt;

  assert.equal(promptPack.brand_assets.logo.enabled, true);
  assert.equal(promptPack.brand_assets.required_note.enabled, true);
  assert.equal(promptPack.brand_assets.logo.adjusted_for_note_band, false);
  assert.equal(promptPack.brand_assets.bottom_safe_area, null);
  assert.equal(plan.external_actions.logo_note_band_avoidance.will_execute, false);
  assert.equal(plan.external_actions.bottom_safe_area_prompt.applied, false);
  assert.equal(prompt.includes("下部セーフエリア"), false);
  assert.ok(prompt.includes("注釈帯予約"));
});

test("initial draft quality gate retries only the failed variant and records results", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-initial-draft-quality-"));
  const cursorPath = path.join(dataRoot, "state", "initial_draft_cursor.json");
  const csvPath = path.join(dataRoot, "quality_gate_requests.csv");
  const guardrailsPath = path.join(dataRoot, "guardrails.quality.json");
  const preloadPath = path.join(dataRoot, "mock_openai_fetch.mjs");
  await fs.writeFile(
    csvPath,
    [
      "タイムスタンプ,依頼者名,案件名,CR案の仮タイトル,ターゲット,訴求軸,オファー,必須コピー,入れたいビジュアル要素,この案がCPA/CVRに効きそうな理由",
      "2026-07-06T10:00:00+09:00,品質テスト,健康食品A,コピー検品,30代女性,価格比較,初回限定,初回相談,商品写真と人物,クリック前理解を高める"
    ].join("\n")
  );
  const guardrails = JSON.parse(await fs.readFile(path.join(repoRoot, "config/guardrails.initial_draft.example.json"), "utf8"));
  guardrails.image2_api.final_size = "";
  guardrails.creative_prompt_json = { enabled: false };
  guardrails.text_quality_gate = {
    enabled: false,
    model: "vision-test",
    max_retries: 1,
    max_output_tokens: 100
  };
  await writeJson(guardrailsPath, guardrails);
  await fs.writeFile(
    preloadPath,
    [
      "let variantOneQualityCalls = 0;",
      "globalThis.fetch = async (url, options = {}) => {",
      "  const target = String(url);",
      "  if (target.endsWith('/images/generations')) {",
      "    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from('fake-png').toString('base64') }], usage: { total_tokens: 5 } }) };",
      "  }",
      "  if (target.endsWith('/responses')) {",
      "    const body = JSON.parse(options.body || '{}');",
      "    const prompt = body.input?.[0]?.content?.[0]?.text || '';",
      "    const isVariantOne = prompt.includes('variant_index: 1');",
      "    if (isVariantOne) variantOneQualityCalls += 1;",
      "    const ok = !isVariantOne || variantOneQualityCalls > 1;",
      "    return { ok: true, status: 200, text: async () => JSON.stringify({ output_text: JSON.stringify({ ok, status: ok ? 'ok' : 'ng', extracted_text: ok ? '初回相談' : '初回相謎', reason: ok ? '完全一致' : '誤字' }), usage: { total_tokens: 7 } }) };",
      "  }",
      "  throw new Error(`unexpected fetch ${target}`);",
      "};"
    ].join("\n")
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      preloadPath,
      "tools/run_initial_draft.mjs",
      "--csv",
      csvPath,
      "--data-root",
      dataRoot,
      "--cursor-file",
      cursorPath,
      "--initial-cursor-row",
      "1",
      "--only-new",
      "--include-prompted",
      "--limit",
      "1",
      "--execute",
      "--quality-gate",
      "--guardrails",
      guardrailsPath,
      "--now",
      "2026-07-06T12:00:00+09:00"
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test"
      },
      maxBuffer: 1024 * 1024 * 8
    }
  );

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.processed_count, 1);
  assert.equal(result.results[0].status, "generated");
  assert.equal(result.results[0].quality_gate_summary.status, "ok");
  assert.equal(result.results[0].quality_gate_summary.retry_count, 1);

  const generation = JSON.parse(await fs.readFile(result.results[0].generation_result_path, "utf8"));
  assert.equal(generation.image_generation_concurrency, 2);
  assert.equal(generation.external_actions.text_quality_gate_executed, true);
  assert.equal(generation.text_quality_gate_summary.checked_count, 4);
  assert.equal(generation.text_quality_gate_summary.retry_count, 1);
  assert.equal(generation.images[0].text_quality_gate.status, "ok");
  assert.equal(generation.images[0].text_quality_gate.attempts.length, 2);
  assert.equal(generation.images[1].text_quality_gate.attempts.length, 1);

  const manifest = JSON.parse(await fs.readFile(result.results[0].manifest_path, "utf8"));
  assert.equal(manifest.text_quality_gate_summary.status, "ok");
  assert.equal(manifest.steps.text_quality_gate.retry_count, 1);

  const cursor = JSON.parse(await fs.readFile(cursorPath, "utf8"));
  assert.equal(cursor.last_processed_row, 2);
});
