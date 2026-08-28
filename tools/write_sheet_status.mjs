#!/usr/bin/env node
import path from "node:path";
import {
  loadFixtureRows,
  loadGuardrails,
  parseArgs,
  printJson,
  readJsonFile,
  resolveDataRoot,
  resolveProjectRoot
} from "../src/cli.mjs";
import { normalizeRequestRow } from "../src/request_schema.mjs";
import { buildSheetStatusUpdate } from "../src/sheet_status.mjs";
import { writeJson } from "../src/manifest.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const fixturePath = path.resolve(projectRoot, args.fixture || "tests/fixtures/google_form_row.json");
const { guardrails } = await loadGuardrails(projectRoot, args);

try {
  const [row] = await loadFixtureRows(fixturePath);
  const request = normalizeRequestRow(row, {
    rowNumber: Number(args.rowNumber || 2),
    fixturePath,
    now: args.now
  });
  const manifest = args.manifest ? await readJsonFile(path.resolve(args.manifest)) : null;
  const status = args.status || manifest?.status || "new";
  const update = buildSheetStatusUpdate({
    request,
    status,
    dryRun: !args.writeSheet,
    errorMessage: args.errorMessage || "",
    now: args.now
  });
  const previewPath = path.join(dataRoot, "outputs", "requests", request.request_id, "sheet_update_preview.json");
  await writeJson(previewPath, update);

  if (!args.writeSheet) {
    printJson({
      ok: true,
      dry_run: true,
      message: "Google Sheets書き戻しは実行していません。--write-sheet と guardrails.sheet_write_enabled=true と人間確認が必要です。",
      sheet_update_preview_path: previewPath,
      diff: update.diff
    });
  } else {
    assertSheetWriteAllowed({ args, guardrails });
    throw new Error("Google Sheets write adapter is not configured in the scaffold milestone.");
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}

function assertSheetWriteAllowed({ args, guardrails }) {
  if (!guardrails.sheet_write_enabled) {
    throw new Error("--write-sheet requires guardrails.sheet_write_enabled=true.");
  }
  if (guardrails.require_human_review_before_sheet_write && !args.confirmHumanReviewed) {
    throw new Error("--write-sheet requires --confirm-human-reviewed.");
  }
}
