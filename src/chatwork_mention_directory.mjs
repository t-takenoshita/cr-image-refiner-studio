import { parseCsv } from "./sheet_source.mjs";

const NAME_HEADERS = new Set(["名前", "氏名", "記入者名", "担当者名"]);
const ACCOUNT_ID_HEADERS = new Set(["アカウントID", "ChatworkアカウントID", "chatwork_account_id"]);

export async function loadChatworkMentionDirectory(options = {}) {
  const spreadsheetId = String(options.spreadsheetId || "").trim();
  const sheetName = String(options.sheetName || "API通知").trim();
  if (!spreadsheetId) {
    return { ok: false, status: "spreadsheet_id_missing", sheet_name: sheetName, entries: [] };
  }

  const params = new URLSearchParams({ tqx: "out:csv", sheet: sheetName });
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?${params.toString()}`;
  const response = await (options.fetchImpl || fetch)(url, { method: "GET", redirect: "follow" });
  const csv = await response.text();
  if (!response.ok) {
    return { ok: false, status: `http_${response.status}`, sheet_name: sheetName, entries: [] };
  }

  const rows = parseCsv(csv).filter((row) => row.some((cell) => String(cell).trim()));
  const headers = rows[0] || [];
  const nameIndex = headers.findIndex((header) => NAME_HEADERS.has(String(header).trim()));
  const accountIdIndex = headers.findIndex((header) => ACCOUNT_ID_HEADERS.has(String(header).trim()));
  if (nameIndex < 0 || accountIdIndex < 0) {
    return { ok: false, status: "required_columns_missing", sheet_name: sheetName, entries: [] };
  }

  const entries = rows
    .slice(1)
    .map((row) => ({
      name: String(row[nameIndex] || "").trim(),
      account_id: String(row[accountIdIndex] || "").trim()
    }))
    .filter((entry) => entry.name && /^\d+$/.test(entry.account_id));

  return { ok: true, status: "loaded", sheet_name: sheetName, entries };
}

export function resolveChatworkMention(directory, requesterName) {
  const normalizedRequester = normalizeName(requesterName);
  if (!normalizedRequester) return null;
  const matches = (directory?.entries || []).filter((entry) => normalizeName(entry.name) === normalizedRequester);
  const uniqueAccountIds = [...new Set(matches.map((entry) => entry.account_id))];
  if (uniqueAccountIds.length !== 1) return null;
  const matched = matches.find((entry) => entry.account_id === uniqueAccountIds[0]);
  return {
    name: matched.name,
    account_id: matched.account_id,
    tag: `[To:${matched.account_id}] ${matched.name}さん`
  };
}

function normalizeName(value) {
  return String(value || "").normalize("NFKC").replace(/[\s　]+/g, "").trim();
}
