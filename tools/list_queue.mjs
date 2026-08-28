#!/usr/bin/env node
import path from "node:path";
import { loadFixtureRows, parseArgs, printJson, resolveDataRoot, resolveProjectRoot } from "../src/cli.mjs";
import { loadRowsFromCsvPath } from "../src/sheet_source.mjs";
import { buildQueueEntries, selectQueueEntries, summarizeQueueEntries } from "../src/queue_status.mjs";

const args = parseArgs();
const projectRoot = resolveProjectRoot(import.meta.url);
const dataRoot = resolveDataRoot(projectRoot, args);
const fixturePath = path.resolve(projectRoot, args.fixture || "fixtures/google_form_row.json");

try {
  const loaded = args.csv ? await loadRowsFromCsvPath(args.csv) : { rows: await loadFixtureRows(fixturePath) };
  const entries = await buildQueueEntries(loaded.rows, {
    dataRoot,
    sourceKind: args.csv ? "csv" : "fixture",
    fixturePath: args.csv ? path.resolve(args.csv) : fixturePath,
    now: args.now
  });
  const selectedEntries = selectQueueEntries(entries, {
    onlyNew: args.onlyNew,
    statuses: args.status,
    limit: args.limit || entries.length
  });

  printJson({
    ok: true,
    dry_run: true,
    external_write_performed: false,
    input_path: args.csv ? path.resolve(args.csv) : fixturePath,
    input_type: args.csv ? "csv" : "json_fixture",
    data_root: dataRoot,
    scanned_count: entries.length,
    returned_count: selectedEntries.length,
    filters: {
      only_new: Boolean(args.onlyNew),
      status: args.status || null,
      limit: args.limit || null
    },
    rows: summarizeQueueEntries(selectedEntries)
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, code: error.code || null }, null, 2));
  process.exitCode = 1;
}
