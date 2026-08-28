import fs from "node:fs/promises";
import path from "node:path";
import { buildHeaderMapping, parseSpreadsheetUrl, rowsFromValues } from "./sheet_source.mjs";

const READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const DEFAULT_DATA_RANGE = "A1:AZ500";
const DEFAULT_HEADER_RANGE = "A1:AZ2";

export async function loadGoogleSheetsConfig(projectRoot, args = {}) {
  const configPath = path.resolve(args.googleSheetsConfig || path.join(projectRoot, "config", "google_sheets.example.json"));
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  return {
    configPath,
    source: parsed.google_form_response_sheet || parsed
  };
}

export function resolveGoogleCredentialPath(projectRoot, source = {}, args = {}) {
  const raw =
    args.googleCredentials ||
    process.env.AICR_GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    source.service_account_key_file ||
    "";
  if (!raw) return "";
  return resolveMaybeHome(path.isAbsolute(raw) ? raw : path.join(projectRoot, raw));
}

export async function preflightGoogleSheetsSource(options = {}) {
  const source = options.source || {};
  const credentialPath = options.credentialPath || "";
  const parsed = parseSpreadsheetUrl(source.spreadsheet_url || options.spreadsheetUrl);
  const gid = String(options.gid || source.gid || parsed.gid || "");

  const credentialStatus = await inspectCredentialFile(credentialPath);
  if (!credentialStatus.ok) {
    return {
      schema_version: "aicr-google-sheets-preflight-v1",
      ok: false,
      status: credentialStatus.status,
      reason: credentialStatus.reason,
      spreadsheet_id: parsed.spreadsheet_id,
      gid,
      credentials: credentialStatus.public,
      external_write_performed: false
    };
  }

  try {
    const sheets = options.sheets || await createSheetsClient({ credentialPath });
    const metadata = await getSpreadsheetMetadata(sheets, parsed.spreadsheet_id);
    const sheet = resolveSheet(metadata, { gid, sheetName: options.sheetName || source.sheet_name });
    const headerRange = options.headerRange || source.header_range || DEFAULT_HEADER_RANGE;
    const values = await getSheetValues(sheets, {
      spreadsheetId: parsed.spreadsheet_id,
      sheetName: sheet.title,
      range: headerRange
    });
    const headers = values[0] || [];
    const mapping = buildHeaderMapping(headers);

    return {
      schema_version: "aicr-google-sheets-preflight-v1",
      ok: true,
      status: "connected",
      spreadsheet_id: parsed.spreadsheet_id,
      gid: String(sheet.sheetId),
      sheet_name: sheet.title,
      header_range: headerRange,
      credentials: credentialStatus.public,
      external_write_performed: false,
      grid: sheet.grid,
      header_count: headers.length,
      row_count_read: values.length,
      headers,
      mapping
    };
  } catch (error) {
    return {
      schema_version: "aicr-google-sheets-preflight-v1",
      ok: false,
      status: classifyGoogleSheetsError(error),
      reason: safeGoogleErrorMessage(error),
      spreadsheet_id: parsed.spreadsheet_id,
      gid,
      credentials: credentialStatus.public,
      external_write_performed: false
    };
  }
}

export async function loadRowsFromGoogleSheetSource(options = {}) {
  const source = options.source || {};
  const credentialPath = options.credentialPath || "";
  const credentialStatus = await inspectCredentialFile(credentialPath);
  if (!credentialStatus.ok) {
    const error = new Error(credentialStatus.reason);
    error.code = credentialStatus.status;
    throw error;
  }

  const parsed = parseSpreadsheetUrl(source.spreadsheet_url || options.spreadsheetUrl);
  const gid = String(options.gid || source.gid || parsed.gid || "");
  const sheets = options.sheets || await createSheetsClient({ credentialPath });
  const metadata = await getSpreadsheetMetadata(sheets, parsed.spreadsheet_id);
  const sheet = resolveSheet(metadata, { gid, sheetName: options.sheetName || source.sheet_name });
  const range = options.range || source.data_range || DEFAULT_DATA_RANGE;
  const values = await getSheetValues(sheets, {
    spreadsheetId: parsed.spreadsheet_id,
    sheetName: sheet.title,
    range
  });
  const parsedRows = rowsFromValues(values);

  return {
    ...parsedRows,
    source_metadata: {
      spreadsheet_id: parsed.spreadsheet_id,
      gid: String(sheet.sheetId),
      sheet_name: sheet.title,
      range,
      row_count_read: values.length,
      external_write_performed: false
    }
  };
}

export async function createSheetsClient(options = {}) {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({
    keyFile: options.credentialPath,
    scopes: options.scopes || [READONLY_SCOPE]
  });
  return google.sheets({ version: "v4", auth });
}

export async function getSpreadsheetMetadata(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))"
  });
  return response.data;
}

export async function getSheetValues(sheets, options = {}) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: options.spreadsheetId,
    range: `${quoteSheetName(options.sheetName)}!${options.range}`,
    valueRenderOption: "FORMATTED_VALUE"
  });
  return response.data.values || [];
}

export function resolveSheet(metadata, options = {}) {
  const sheets = metadata?.sheets || [];
  const gid = options.gid ? String(options.gid) : "";
  const sheetName = String(options.sheetName || "").trim();

  const match =
    (gid && sheets.find((sheet) => String(sheet.properties?.sheetId) === gid)) ||
    (sheetName && sheets.find((sheet) => sheet.properties?.title === sheetName)) ||
    (sheets.length === 1 ? sheets[0] : null);

  if (!match?.properties) {
    const available = sheets.map((sheet) => ({
      sheet_id: sheet.properties?.sheetId,
      title: sheet.properties?.title
    }));
    const error = new Error(`Could not resolve target sheet. Set gid or sheet_name. Available sheets: ${JSON.stringify(available)}`);
    error.code = "AICR_GOOGLE_SHEET_NOT_RESOLVED";
    throw error;
  }

  return {
    sheetId: match.properties.sheetId,
    title: match.properties.title,
    index: match.properties.index,
    grid: {
      row_count: match.properties.gridProperties?.rowCount ?? null,
      column_count: match.properties.gridProperties?.columnCount ?? null
    }
  };
}

export function quoteSheetName(sheetName) {
  const raw = String(sheetName || "");
  if (!raw) throw new Error("sheetName is required.");
  return `'${raw.replace(/'/g, "''")}'`;
}

export async function inspectCredentialFile(credentialPath) {
  if (!credentialPath) {
    return {
      ok: false,
      status: "credentials_missing",
      reason: "Set AICR_GOOGLE_SERVICE_ACCOUNT_KEY_FILE or google_form_response_sheet.service_account_key_file.",
      public: {
        path_configured: false,
        file_exists: false
      }
    };
  }

  try {
    const stat = await fs.stat(credentialPath);
    return {
      ok: true,
      status: "credentials_present",
      reason: "",
      public: {
        path_configured: true,
        file_exists: true,
        path: credentialPath,
        size_bytes: stat.size
      }
    };
  } catch (error) {
    return {
      ok: false,
      status: "credentials_missing",
      reason: `Credential file not found: ${credentialPath}`,
      public: {
        path_configured: true,
        file_exists: false,
        path: credentialPath
      }
    };
  }
}

export function classifyGoogleSheetsError(error) {
  const status = error?.code || error?.response?.status;
  if (status === 401) return "unauthorized";
  if (status === 403) return "permission_denied_or_sheet_not_shared";
  if (status === 404) return "spreadsheet_or_sheet_not_found";
  if (String(error?.code || "").startsWith("AICR_")) return error.code;
  return "google_sheets_read_failed";
}

export function safeGoogleErrorMessage(error) {
  const message = error?.errors?.[0]?.message || error?.response?.data?.error?.message || error?.message || String(error);
  return String(message).replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, "[redacted private key]");
}

function resolveMaybeHome(value) {
  const raw = String(value || "");
  if (raw === "~") return process.env.HOME || raw;
  if (raw.startsWith("~/")) return path.join(process.env.HOME || "", raw.slice(2));
  return raw;
}
