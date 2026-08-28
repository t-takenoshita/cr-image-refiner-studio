import fs from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  buildHeaderMapping,
  buildPublicCsvUrl,
  inspectSheetSource,
  parseCsv,
  parseSpreadsheetUrl,
  rowsFromCsv
} from "../src/sheet_source.mjs";

test("parses spreadsheet URL and gid", () => {
  const parsed = parseSpreadsheetUrl(
    "https://docs.google.com/spreadsheets/d/1_C66pvuPhjD-ZAsMjniyW117R6MRkxOyNVylMGk3tEE/edit?gid=55285306#gid=55285306"
  );

  assert.equal(parsed.spreadsheet_id, "1_C66pvuPhjD-ZAsMjniyW117R6MRkxOyNVylMGk3tEE");
  assert.equal(parsed.gid, "55285306");
});

test("builds bounded public csv URL", () => {
  const url = buildPublicCsvUrl({
    spreadsheetId: "sheet123",
    gid: "456",
    range: "A1:AZ2"
  });

  assert.equal(url, "https://docs.google.com/spreadsheets/d/sheet123/gviz/tq?tqx=out%3Acsv&gid=456&range=A1%3AAZ2");
});

test("parses quoted CSV", () => {
  const rows = parseCsv('name,note\n"a,b","line 1\nline 2"\n');

  assert.deepEqual(rows, [
    ["name", "note"],
    ["a,b", "line 1\nline 2"]
  ]);
});

test("maps form headers to request fields and management column gaps", async () => {
  const csv = await fs.readFile(new URL("./fixtures/google_form_headers.csv", import.meta.url), "utf8");
  const headers = parseCsv(csv)[0];
  const mapping = buildHeaderMapping(headers);

  assert.equal(mapping.processable, true);
  assert.equal(mapping.request_field_mappings.project_name.header, "案件名");
  assert.equal(mapping.request_field_mappings.target_audience.header, "ターゲット");
  assert.ok(mapping.management_columns_missing.includes("request_id"));
  assert.ok(mapping.recommended_columns_to_add.includes("status"));
});

test("inspects local CSV fixture without storing sample values by default", async () => {
  const csvPath = fileURLToPath(new URL("./fixtures/google_form_headers.csv", import.meta.url));
  const inspection = await inspectSheetSource({
    sheetUrl: "https://docs.google.com/spreadsheets/d/example/edit?gid=123#gid=123",
    csvPath
  });

  assert.equal(inspection.ok, true);
  assert.equal(inspection.read_source, "local_csv_fixture");
  assert.equal(inspection.sample_row[1], "[redacted]");
  assert.equal(inspection.mapping.processable, true);
});

test("converts CSV rows into sheet-like row objects", async () => {
  const csv = await fs.readFile(new URL("./fixtures/google_form_headers.csv", import.meta.url), "utf8");
  const parsed = rowsFromCsv(csv);

  assert.equal(parsed.headers[0], "タイムスタンプ");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]["案件名"], "FIN AGA 記事LP用バナー");
});

test("returns auth-required status for private public-csv reads", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    headers: new Map([["content-type", "text/html"]]),
    text: async () => "<html>Sign in</html>"
  });
  const inspection = await inspectSheetSource({
    sheetUrl: "https://docs.google.com/spreadsheets/d/example/edit?gid=123#gid=123",
    fetchImpl: fakeFetch
  });

  assert.equal(inspection.ok, false);
  assert.equal(inspection.status, "auth_required_or_not_public");
});
