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
import { loadRowsFromCsvPath } from "../src/sheet_source.mjs";
import { buildQueueEntries, selectQueueEntries, summarizeQueueEntries } from "../src/queue_status.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const fixturePath = path.resolve(projectRoot, args.fixture || "fixtures/google_form_row.json");
const { guardrails, guardrailsPath } = await loadGuardrails(projectRoot, args);
const flags = buildExternalFlags(args);
const limit = Number.parseInt(args.limit || "1", 10);

try {
  const loaded = args.csv ? await loadRowsFromCsvPath(args.csv) : { rows: await loadFixtureRows(fixturePath) };
  const rows = loaded.rows;
  const entries = await buildQueueEntries(rows, {
    dataRoot,
    sourceKind: args.csv ? "csv" : "fixture",
    fixturePath: args.csv ? path.resolve(args.csv) : fixturePath,
    now: args.now
  });
  const selectedEntries = selectQueueEntries(entries, {
    onlyNew: args.onlyNew,
    statuses: args.status,
    limit: Number.isFinite(limit) ? limit : 1
  });
  const results = [];

  for (const entry of selectedEntries) {
    const result = await processRequestRow(entry.row, {
      dataRoot,
      guardrails,
      flags,
      dryRun: args.dryRun !== false,
      rowNumber: entry.row_number,
      sourceKind: args.csv ? "csv" : "fixture",
      fixturePath: args.csv ? path.resolve(args.csv) : fixturePath,
      templatePath: path.join(projectRoot, "config", "prompt_templates", "banner_variants.json"),
      now: args.now
    });
    results.push({
      request_id: result.request.request_id,
      status: result.manifest.status,
      policy_gate: result.manifest.policy_gate_summary,
      prompt_pack_path: result.paths.promptPackPath,
      manifest_path: result.paths.manifestPath
    });
  }

  printJson({
    ok: true,
    dry_run: args.dryRun !== false,
    processed_count: results.length,
    input_path: args.csv ? path.resolve(args.csv) : fixturePath,
    input_type: args.csv ? "csv" : "json_fixture",
    data_root: dataRoot,
    guardrails_path: guardrailsPath,
    selection: {
      only_new: Boolean(args.onlyNew),
      status_filter: args.status || null,
      scanned_count: entries.length,
      selected_count: selectedEntries.length,
      selected_rows: summarizeQueueEntries(selectedEntries)
    },
    results
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}
