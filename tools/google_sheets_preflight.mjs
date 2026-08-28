#!/usr/bin/env node
import path from "node:path";
import { parseArgs, printJson, resolveDataRoot, resolveProjectRoot } from "../src/cli.mjs";
import { appendLog, writeJson } from "../src/manifest.mjs";
import {
  loadGoogleSheetsConfig,
  preflightGoogleSheetsSource,
  resolveGoogleCredentialPath
} from "../src/google_sheets_source.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);

try {
  const { configPath, source } = await loadGoogleSheetsConfig(projectRoot, args);
  const credentialPath = resolveGoogleCredentialPath(projectRoot, source, args);
  const result = await preflightGoogleSheetsSource({
    source,
    credentialPath,
    gid: args.gid,
    sheetName: args.sheetName,
    headerRange: args.headerRange
  });
  const outputPath = path.join(dataRoot, "cache", "google_sheets_preflight.json");
  await writeJson(outputPath, {
    ...result,
    source_config_path: configPath,
    checked_at: new Date().toISOString()
  });
  await appendLog(dataRoot, {
    event: "google_sheets_preflight",
    ok: result.ok,
    status: result.status,
    spreadsheet_id: result.spreadsheet_id,
    gid: result.gid,
    output_path: outputPath,
    created_at: new Date().toISOString()
  });

  printJson({
    ok: result.ok,
    dry_run: true,
    external_write_performed: false,
    status: result.status,
    reason: result.reason || "",
    spreadsheet_id: result.spreadsheet_id,
    gid: result.gid,
    sheet_name: result.sheet_name || null,
    header_count: result.header_count || 0,
    processable: Boolean(result.mapping?.processable),
    missing_required_request_fields: result.mapping?.missing_required_request_fields || [],
    credentials: result.credentials,
    preflight_path: outputPath,
    source_config_path: configPath
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}
