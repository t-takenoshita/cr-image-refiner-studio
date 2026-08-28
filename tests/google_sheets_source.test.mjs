import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  loadRowsFromGoogleSheetSource,
  preflightGoogleSheetsSource,
  quoteSheetName,
  resolveSheet
} from "../src/google_sheets_source.mjs";

const dummyCredentialPath = fileURLToPath(import.meta.url);

function fakeSheets(values = []) {
  return {
    spreadsheets: {
      get: async () => ({
        data: {
          spreadsheetId: "sheet123",
          properties: { title: "AICR requests" },
          sheets: [
            {
              properties: {
                sheetId: 55285306,
                title: "フォームの回答 1",
                index: 0,
                gridProperties: {
                  rowCount: 1000,
                  columnCount: 52
                }
              }
            }
          ]
        }
      }),
      values: {
        get: async (request) => {
          assert.equal(request.spreadsheetId, "1_C66pvuPhjD-ZAsMjniyW117R6MRkxOyNVylMGk3tEE");
          assert.equal(request.range, "'フォームの回答 1'!A1:AZ500");
          return { data: { values } };
        }
      }
    }
  };
}

test("quotes sheet names safely", () => {
  assert.equal(quoteSheetName("フォームの回答 1"), "'フォームの回答 1'");
  assert.equal(quoteSheetName("O'Reilly"), "'O''Reilly'");
});

test("resolves sheet by gid from metadata", () => {
  const resolved = resolveSheet(
    {
      sheets: [
        { properties: { sheetId: 1, title: "Other" } },
        { properties: { sheetId: 55285306, title: "フォームの回答 1" } }
      ]
    },
    { gid: "55285306" }
  );

  assert.equal(resolved.title, "フォームの回答 1");
  assert.equal(resolved.sheetId, 55285306);
});

test("loads rows from Google Sheets values using the shared row schema", async () => {
  const values = [
    ["タイムスタンプ", "記入者名", "案件名", "狙うターゲット", "オファーの見せ方", "訴求の一言コピー"],
    ["2026/06/15 14:00:00", "記事部", "JUNO痩身", "20代後半女性", "初回限定", "夏前に相談"]
  ];
  const loaded = await loadRowsFromGoogleSheetSource({
    source: {
      spreadsheet_url: "https://docs.google.com/spreadsheets/d/1_C66pvuPhjD-ZAsMjniyW117R6MRkxOyNVylMGk3tEE/edit?gid=55285306#gid=55285306",
      gid: "55285306"
    },
    credentialPath: dummyCredentialPath,
    sheets: fakeSheets(values)
  });

  assert.equal(loaded.headers[2], "案件名");
  assert.equal(loaded.rows.length, 1);
  assert.equal(loaded.rows[0]["案件名"], "JUNO痩身");
  assert.equal(loaded.source_metadata.sheet_name, "フォームの回答 1");
});

test("preflight stops safely when credentials are missing", async () => {
  const result = await preflightGoogleSheetsSource({
    source: {
      spreadsheet_url: "https://docs.google.com/spreadsheets/d/example/edit?gid=123#gid=123"
    },
    credentialPath: "/tmp/aicr-factory-missing-service-account.json"
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "credentials_missing");
  assert.equal(result.external_write_performed, false);
  assert.equal(result.credentials.file_exists, false);
});
