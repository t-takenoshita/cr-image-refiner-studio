#!/usr/bin/env node
import path from "node:path";
import { parseArgs, loadFixtureRows, loadGuardrails, printJson, resolveDataRoot, resolveProjectRoot } from "../src/cli.mjs";
import { normalizeRequestRow } from "../src/request_schema.mjs";
import { buildPromptPack } from "../src/prompt_builder.mjs";
import { ensureDataDirs, getRequestOutputDir, writeJson } from "../src/manifest.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const fixturePath = path.resolve(projectRoot, args.fixture || "fixtures/google_form_row.json");
const { guardrails, guardrailsPath } = await loadGuardrails(projectRoot, args);

try {
  const [row] = await loadFixtureRows(fixturePath);
  const request = normalizeRequestRow(row, {
    rowNumber: 2,
    fixturePath,
    now: args.now
  });
  const promptPack = await buildPromptPack(request, {
    guardrails,
    templatePath: path.join(projectRoot, "config", "prompt_templates", "banner_variants.json"),
    now: args.now
  });
  const outputDir = getRequestOutputDir(dataRoot, request.request_id);
  const promptPackPath = path.join(outputDir, "prompt_pack.json");
  await ensureDataDirs(dataRoot);
  await writeJson(promptPackPath, promptPack);

  printJson({
    ok: true,
    dry_run: true,
    request_id: request.request_id,
    variant_count: promptPack.variants.length,
    prompt_pack_path: promptPackPath,
    guardrails_path: guardrailsPath
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
