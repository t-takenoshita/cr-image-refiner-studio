import fs from "node:fs/promises";
import path from "node:path";
import { FIELD_ALIASES, MANAGEMENT_COLUMNS } from "./request_schema.mjs";

const REQUIRED_REQUEST_FIELDS = Object.freeze([
  "project_name",
  "target_audience",
  "offer",
  "required_copy"
]);

export function parseSpreadsheetUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("spreadsheet URL or ID is required.");

  const idMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const spreadsheetId = idMatch?.[1] || (raw.includes("/") ? "" : raw);
  const gidMatch = raw.match(/[?#&]gid=([0-9]+)/);
  if (!spreadsheetId) throw new Error("Could not parse spreadsheet ID.");

  return {
    spreadsheet_id: spreadsheetId,
    gid: gidMatch?.[1] || null
  };
}

export function buildPublicCsvUrl({ spreadsheetId, gid, range = "A1:AZ2" }) {
  const params = new URLSearchParams({
    tqx: "out:csv"
  });
  if (gid) params.set("gid", gid);
  if (range) params.set("range", range);
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?${params.toString()}`;
}

export async function inspectSheetSource(options = {}) {
  const source = options.source || {};
  const sheetUrl = options.sheetUrl || source.spreadsheet_url;
  const parsed = parseSpreadsheetUrl(sheetUrl);
  const gid = String(options.gid || source.gid || parsed.gid || "");
  const range = options.range || source.header_range || "A1:AZ2";
  const storeSampleValues = Boolean(options.storeSampleValues ?? source.store_sample_values);
  const csvPath = options.csvPath ? path.resolve(options.csvPath) : null;

  const csvRead = csvPath
    ? await readLocalCsv(csvPath)
    : await readPublicSheetCsv({
        spreadsheetId: parsed.spreadsheet_id,
        gid,
        range,
        fetchImpl: options.fetchImpl
      });

  if (!csvRead.ok) {
    return {
      schema_version: "aicr-sheet-inspection-v1",
      ok: false,
      status: csvRead.status,
      reason: csvRead.reason,
      spreadsheet_id: parsed.spreadsheet_id,
      gid,
      range,
      public_csv_url: csvRead.public_csv_url || null,
      external_write_performed: false,
      headers: [],
      mapping: null
    };
  }

  const rows = parseCsv(csvRead.csv).filter((row) => row.some((cell) => cell.trim()));
  const headers = rows[0] || [];
  const sampleRow = rows[1] || [];
  const mapping = buildHeaderMapping(headers);

  return {
    schema_version: "aicr-sheet-inspection-v1",
    ok: true,
    status: "inspected",
    spreadsheet_id: parsed.spreadsheet_id,
    gid,
    range,
    read_source: csvPath ? "local_csv_fixture" : "public_csv",
    public_csv_url: csvRead.public_csv_url || null,
    external_write_performed: false,
    row_count_read: rows.length,
    headers,
    sample_row: storeSampleValues ? sampleRow : redactRow(sampleRow),
    mapping
  };
}

export async function loadSourceConfig(projectRoot, args = {}) {
  const configPath = path.resolve(args.sources || path.join(projectRoot, "config", "sources.example.json"));
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  return {
    configPath,
    source: parsed.google_form_response_sheet
  };
}

export async function readPublicSheetCsv({ spreadsheetId, gid, range, fetchImpl = fetch }) {
  const publicCsvUrl = buildPublicCsvUrl({ spreadsheetId, gid, range });
  let response;
  try {
    response = await fetchImpl(publicCsvUrl, {
      method: "GET",
      redirect: "follow"
    });
  } catch (error) {
    return {
      ok: false,
      status: "fetch_failed",
      reason: error.message,
      public_csv_url: publicCsvUrl
    };
  }

  const contentType = response.headers?.get?.("content-type") || "";
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: "auth_required_or_not_public",
        reason: `HTTP ${response.status}. Reauthenticate Google Drive or provide an exported CSV fixture.`,
        public_csv_url: publicCsvUrl
      };
    }
    return {
      ok: false,
      status: "http_error",
      reason: `HTTP ${response.status}`,
      public_csv_url: publicCsvUrl
    };
  }
  if (looksLikeAuthOrHtml(text, contentType)) {
    return {
      ok: false,
      status: "auth_required_or_not_public",
      reason: "The sheet could not be read as public CSV. Reauthenticate Google Drive or provide an exported CSV fixture.",
      public_csv_url: publicCsvUrl
    };
  }
  return {
    ok: true,
    csv: text,
    public_csv_url: publicCsvUrl
  };
}

export function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function rowsFromCsv(csv) {
  const rows = parseCsv(csv).filter((row) => row.some((cell) => cell.trim()));
  return rowsFromValues(rows);
}

export function rowsFromValues(values) {
  const rows = values.filter((row) => row.some((cell) => String(cell || "").trim()));
  const headers = rows[0] || [];
  const dataRows = rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, row[index] || ""]))
  );
  return {
    headers,
    rows: dataRows
  };
}

export async function loadRowsFromCsvPath(csvPath) {
  const csv = await fs.readFile(path.resolve(csvPath), "utf8");
  return rowsFromCsv(csv);
}

export async function loadRowsFromPublicSheetSource(options = {}) {
  const source = options.source || {};
  const parsed = parseSpreadsheetUrl(source.spreadsheet_url || options.spreadsheetUrl);
  const gid = String(options.gid || source.gid || parsed.gid || "");
  const range = options.range || source.data_range || "A1:AZ500";
  const csvRead = await readPublicSheetCsv({
    spreadsheetId: parsed.spreadsheet_id,
    gid,
    range,
    fetchImpl: options.fetchImpl
  });
  if (!csvRead.ok) {
    const error = new Error(csvRead.reason);
    error.code = csvRead.status;
    error.publicCsvUrl = csvRead.public_csv_url;
    throw error;
  }
  const parsedRows = rowsFromCsv(csvRead.csv);
  return {
    ...parsedRows,
    source_metadata: {
      spreadsheet_id: parsed.spreadsheet_id,
      gid,
      sheet_name: source.sheet_name || "",
      range,
      row_count_read: parsedRows.rows.length + 1,
      read_source: "public_csv",
      public_csv_url: csvRead.public_csv_url,
      external_write_performed: false
    }
  };
}

export function buildHeaderMapping(headers) {
  const normalizedHeaderMap = new Map(
    headers.map((header, index) => [normalizeHeader(header), { header, index }])
  );
  const requestFieldMappings = {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const match = aliases
      .map((alias) => normalizedHeaderMap.get(normalizeHeader(alias)))
      .find(Boolean);
    if (match) {
      requestFieldMappings[field] = {
        header: match.header,
        column_index: match.index,
        column_letter: columnNumberToLetter(match.index + 1)
      };
    }
  }

  const managementPresent = MANAGEMENT_COLUMNS.filter((column) => normalizedHeaderMap.has(normalizeHeader(column)));
  const managementMissing = MANAGEMENT_COLUMNS.filter((column) => !normalizedHeaderMap.has(normalizeHeader(column)));
  const missingRequiredRequestFields = REQUIRED_REQUEST_FIELDS.filter((field) => !requestFieldMappings[field]);
  const matchedHeaders = new Set(Object.values(requestFieldMappings).map((mapping) => mapping.header));
  const unknownHeaders = headers.filter((header) => header && !matchedHeaders.has(header) && !MANAGEMENT_COLUMNS.includes(header));

  return {
    request_field_mappings: requestFieldMappings,
    required_request_fields: REQUIRED_REQUEST_FIELDS,
    missing_required_request_fields: missingRequiredRequestFields,
    management_columns_present: managementPresent,
    management_columns_missing: managementMissing,
    recommended_columns_to_add: managementMissing,
    unknown_headers: unknownHeaders,
    processable: missingRequiredRequestFields.length === 0
  };
}

export function columnNumberToLetter(columnNumber) {
  let n = columnNumber;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

async function readLocalCsv(csvPath) {
  return {
    ok: true,
    csv: await fs.readFile(csvPath, "utf8"),
    public_csv_url: null
  };
}

function redactRow(row) {
  return row.map((value) => (value ? "[redacted]" : ""));
}

function looksLikeAuthOrHtml(text, contentType) {
  const trimmed = text.trim().slice(0, 300).toLowerCase();
  return (
    contentType.includes("text/html") ||
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.includes("accounts.google.com") ||
    trimmed.includes("sign in")
  );
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}
