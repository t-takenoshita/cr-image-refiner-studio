#!/usr/bin/env node
import path from "node:path";
import {
  buildExternalFlags,
  loadFixtureRows,
  loadGuardrails,
  parseArgs,
  printJson,
  resolveDataRoot,
  resolveProjectRoot
} from "../src/cli.mjs";
import { processRequestRow } from "../src/pipeline.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const fixturePath = path.resolve(projectRoot, args.fixture || "tests/fixtures/google_form_row.json");
const { guardrails, guardrailsPath } = await loadGuardrails(projectRoot, args);

try {
  const [row] = await loadFixtureRows(fixturePath);
  const result = await processRequestRow(row, {
    dataRoot,
    guardrails,
    flags: buildExternalFlags(args),
    dryRun: args.dryRun !== false,
    rowNumber: Number(args.rowNumber || 2),
    fixturePath,
    templatePath: path.join(projectRoot, "config", "prompt_templates", "banner_variants.json"),
    now: args.now
  });

  printJson({
    ok: true,
    dry_run: result.manifest.dry_run,
    request_id: result.request.request_id,
    status: result.manifest.status,
    policy_gate: result.manifest.policy_gate_summary,
    prompt_pack_path: result.paths.promptPackPath,
    manifest_path: result.paths.manifestPath,
    sheet_update_preview_path: result.paths.sheetUpdatePreviewPath,
    guardrails_path: guardrailsPath
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}
