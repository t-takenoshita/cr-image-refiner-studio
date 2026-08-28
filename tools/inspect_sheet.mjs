#!/usr/bin/env node
import path from "node:path";
import { parseArgs, printJson, resolveDataRoot, resolveProjectRoot } from "../src/cli.mjs";
import { ensureDataDirs, writeJson } from "../src/manifest.mjs";
import { inspectSheetSource, loadSourceConfig } from "../src/sheet_source.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);

try {
  const { source, configPath } = await loadSourceConfig(projectRoot, args);
  const inspection = await inspectSheetSource({
    source,
    sheetUrl: args.sheetUrl,
    gid: args.gid,
    range: args.range,
    csvPath: args.csv,
    storeSampleValues: args.includeSampleValues === true
  });
  await ensureDataDirs(dataRoot);
  const inspectionPath = path.join(dataRoot, "cache", "sheet_inspection.json");
  await writeJson(inspectionPath, inspection);

  printJson({
    ok: inspection.ok,
    dry_run: true,
    status: inspection.status,
    reason: inspection.reason || null,
    spreadsheet_id: inspection.spreadsheet_id,
    gid: inspection.gid,
    range: inspection.range,
    header_count: inspection.headers?.length || 0,
    processable: inspection.mapping?.processable ?? false,
    missing_required_request_fields: inspection.mapping?.missing_required_request_fields || [],
    recommended_columns_to_add: inspection.mapping?.recommended_columns_to_add || [],
    inspection_path: inspectionPath,
    source_config_path: configPath
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}
