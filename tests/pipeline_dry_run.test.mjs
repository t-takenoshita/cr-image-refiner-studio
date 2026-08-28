import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { processRequestRow } from "../src/pipeline.mjs";

const fixture = JSON.parse(
  await fs.readFile(new URL("./fixtures/google_form_row.json", import.meta.url), "utf8")
);
const guardrails = JSON.parse(
  await fs.readFile(new URL("../config/guardrails.example.json", import.meta.url), "utf8")
);

test("dry-run writes prompt_pack, manifest, and sheet update preview without external side effects", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-factory-"));
  const result = await processRequestRow(fixture, {
    dataRoot,
    guardrails,
    flags: {},
    dryRun: true,
    rowNumber: 2,
    fixturePath: "tests/fixtures/google_form_row.json",
    templatePath: path.resolve("config/prompt_templates/banner_variants.json"),
    now: "2026-06-15T12:00:00+09:00"
  });

  const promptPackRaw = await fs.readFile(result.paths.promptPackPath, "utf8");
  const manifestRaw = await fs.readFile(result.paths.manifestPath, "utf8");
  const sheetPreviewRaw = await fs.readFile(result.paths.sheetUpdatePreviewPath, "utf8");
  const promptPack = JSON.parse(promptPackRaw);
  const manifest = JSON.parse(manifestRaw);
  const sheetPreview = JSON.parse(sheetPreviewRaw);

  assert.equal(promptPack.variants.length, 4);
  assert.equal(manifest.dry_run, true);
  assert.equal(manifest.steps.image2_generation.status, "skipped");
  assert.equal(manifest.steps.drive_save.status, "skipped");
  assert.equal(manifest.steps.chatwork_post.status, "skipped");
  assert.equal(manifest.steps.sheet_write.status, "skipped");
  assert.equal(sheetPreview.dry_run, true);
});

test("external flags stay blocked unless guardrails explicitly enable them", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-factory-"));
  await assert.rejects(
    processRequestRow(fixture, {
      dataRoot,
      guardrails,
      flags: { generateImages: true },
      dryRun: false,
      rowNumber: 2,
      fixturePath: "tests/fixtures/google_form_row.json",
      templatePath: path.resolve("config/prompt_templates/banner_variants.json"),
      now: "2026-06-15T12:00:00+09:00"
    }),
    /--generate-images requires guardrails.image2_generation_enabled=true/
  );
});

test("unmatched client master warning is written to manifest and JSONL log", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-factory-unmatched-master-"));
  const clientMasterContext = {
    enabled: true,
    status: "loaded",
    records: [],
    index: { byName: new Map(), byId: new Map(), warnings: [] },
    warnings: []
  };

  const result = await processRequestRow(
    {
      ...fixture,
      "案件名": "未登録案件"
    },
    {
      dataRoot,
      guardrails: {
        ...guardrails,
        client_master: { enabled: true }
      },
      flags: {},
      dryRun: true,
      clientMasterContext,
      rowNumber: 2,
      fixturePath: "tests/fixtures/google_form_row.json",
      templatePath: path.resolve("config/prompt_templates/banner_variants.json"),
      now: "2026-06-15T12:00:00+09:00"
    }
  );

  const manifest = JSON.parse(await fs.readFile(result.paths.manifestPath, "utf8"));
  const logLines = (await fs.readFile(result.paths.logPath, "utf8")).trim().split("\n");
  const logEvent = JSON.parse(logLines.at(-1));

  assert.equal(manifest.client_master.matched, false);
  assert.ok(manifest.client_master.warnings.some((warning) => warning.includes("no master record")));
  assert.ok(manifest.steps.normalize_request.warnings.some((warning) => warning.includes("no master record")));
  assert.equal(logEvent.client_master.matched, false);
  assert.ok(logEvent.warnings.some((warning) => warning.includes("no master record")));
});
