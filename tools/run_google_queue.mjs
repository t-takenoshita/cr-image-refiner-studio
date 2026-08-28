#!/usr/bin/env node
import path from "node:path";
import {
  buildExternalFlags,
  loadGuardrails,
  parseArgs,
  printJson,
  resolveDataRoot,
  resolveProjectRoot
} from "../src/cli.mjs";
import { processRequestRow } from "../src/pipeline.mjs";
import { buildQueueEntries, selectQueueEntries, summarizeQueueEntries } from "../src/queue_status.mjs";
import {
  loadGoogleSheetsConfig,
  loadRowsFromGoogleSheetSource,
  resolveGoogleCredentialPath
} from "../src/google_sheets_source.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const { guardrails, guardrailsPath } = await loadGuardrails(projectRoot, args);
const flags = buildExternalFlags(args);
const limit = Number.parseInt(args.limit || "1", 10);

try {
  const { configPath, source } = await loadGoogleSheetsConfig(projectRoot, args);
  const credentialPath = resolveGoogleCredentialPath(projectRoot, source, args);
  const loaded = await loadRowsFromGoogleSheetSource({
    source,
    credentialPath,
    gid: args.gid,
    sheetName: args.sheetName,
    range: args.range
  });
  const entries = await buildQueueEntries(loaded.rows, {
    dataRoot,
    sourceKind: "google_sheets",
    sheetId: loaded.source_metadata.spreadsheet_id,
    gid: loaded.source_metadata.gid,
    now: args.now
  });
  const selectedEntries = selectQueueEntries(entries, {
    onlyNew: args.onlyNew,
    statuses: args.status,
    limit: Number.isFinite(limit) ? limit : 1
  });
  const listOnly = Boolean(args.listOnly);
  const results = [];

  if (!listOnly) {
    for (const entry of selectedEntries) {
      const result = await processRequestRow(entry.row, {
        dataRoot,
        guardrails,
        flags,
        dryRun: args.dryRun !== false,
        rowNumber: entry.row_number,
        sourceKind: "google_sheets",
        sheetId: loaded.source_metadata.spreadsheet_id,
        gid: loaded.source_metadata.gid,
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
  }

  printJson({
    ok: true,
    dry_run: args.dryRun !== false,
    external_write_performed: false,
    list_only: listOnly,
    input_type: "google_sheets",
    source_config_path: configPath,
    spreadsheet_id: loaded.source_metadata.spreadsheet_id,
    gid: loaded.source_metadata.gid,
    sheet_name: loaded.source_metadata.sheet_name,
    range: loaded.source_metadata.range,
    row_count_read: loaded.source_metadata.row_count_read,
    data_root: dataRoot,
    guardrails_path: guardrailsPath,
    selection: {
      only_new: Boolean(args.onlyNew),
      status_filter: args.status || null,
      scanned_count: entries.length,
      selected_count: selectedEntries.length,
      selected_rows: summarizeQueueEntries(selectedEntries)
    },
    processed_count: results.length,
    results
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}
