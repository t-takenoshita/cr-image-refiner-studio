import fs from "node:fs/promises";
import path from "node:path";
import { loadRowsFromGoogleSheetSource, resolveGoogleCredentialPath } from "./google_sheets_source.mjs";
import { loadRowsFromCsvPath, loadRowsFromPublicSheetSource } from "./sheet_source.mjs";
import { normalizeString, readAlias, splitList } from "./request_schema.mjs";

export const CLIENT_MASTER_FIELD_ALIASES = Object.freeze({
  client_id: ["案件ID", "案件id", "client_id", "project_id"],
  client_name: ["案件名", "client_name", "project_name", "クライアント名", "商材名"],
  logo_reference: [
    "ロゴ画像の参照(DriveファイルIDまたはURL)",
    "ロゴ画像の参照",
    "ロゴ画像",
    "ロゴURL",
    "ロゴDriveファイルID",
    "logo_reference",
    "logo_url",
    "logo_file_id"
  ],
  required_note: ["必須注釈の文言", "必須注釈", "注釈文言", "注釈", "required_note"],
  ng_expressions: ["NG表現(カンマ区切り)", "NG表現", "NGワード", "禁止表現", "ng_expressions"],
  brand_color: ["ブランドカラー(HEX)", "ブランドカラー", "brand_color", "brand_color_hex"],
  notes: ["備考", "notes", "メモ"]
});

export async function loadClientMasterContext(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const args = options.args || {};
  const guardrails = options.guardrails || {};
  const feature = guardrails.client_master || {};
  const explicitConfig = typeof args.clientMaster === "string" ? args.clientMaster : "";
  const enabled = Boolean(args.clientMaster || args.clientMasterCsv || feature.enabled);

  if (!enabled) {
    return {
      schema_version: "aicr-client-master-context-v1",
      enabled: false,
      status: "disabled",
      records: [],
      index: buildClientMasterIndex([]),
      warnings: []
    };
  }

  const settings = await resolveClientMasterSettings(projectRoot, {
    ...args,
    clientMasterConfig: args.clientMasterConfig || explicitConfig
  }, feature);

  if (!settings.local_csv_path && !settings.source?.spreadsheet_url) {
    return buildUnavailableContext({
      status: "not_configured",
      settings,
      warnings: ["client_master.enabled=true but no client master sheet or local CSV is configured."]
    });
  }

  const loaded = await loadClientMasterRows({
    projectRoot,
    args,
    settings
  });
  if (!loaded.ok) {
    return buildUnavailableContext({
      status: loaded.status,
      settings,
      warnings: [loaded.reason]
    });
  }

  const records = loaded.rows
    .map((row, index) => normalizeClientMasterRow(row, { rowNumber: index + 2 }))
    .filter((record) => record.client_id || record.client_name);
  const index = buildClientMasterIndex(records);
  const warnings = [...(loaded.warnings || []), ...index.warnings];

  return {
    schema_version: "aicr-client-master-context-v1",
    enabled: true,
    status: "loaded",
    config_path: settings.config_path || null,
    source_kind: loaded.source_kind,
    source_metadata: loaded.source_metadata || null,
    records,
    index,
    warnings
  };
}

export function applyClientMasterToRequest(request, context, options = {}) {
  if (!context?.enabled) return request;

  const lookupValue = request.project?.name || "";
  const application = {
    schema_version: "aicr-client-master-application-v1",
    enabled: true,
    matched: false,
    lookup_field: "project.name",
    lookup_value: lookupValue,
    source_status: context.status,
    record: null,
    ng_expressions: [],
    warnings: []
  };

  if (context.status !== "loaded") {
    const warning = `client_master unavailable: ${context.status}`;
    application.warnings.push(warning);
    addValidationWarning(request, warning);
    request.client_master = application;
    return request;
  }

  const record = findClientMasterRecord(context, lookupValue);
  if (!record) {
    const warning = `client_master: no master record matched project.name "${lookupValue || "(empty)"}".`;
    application.warnings.push(warning);
    addValidationWarning(request, warning);
    request.client_master = application;
    return request;
  }

  const brandConfig = resolveBrandAssetsConfig(options.guardrails || {});
  const logoAvailable = Boolean(record.logo.reference);
  const noteAvailable = Boolean(record.required_note);
  const brandColorAvailable = Boolean(record.brand_color_hex);

  application.matched = true;
  application.record = {
    client_id: record.client_id,
    client_name: record.client_name,
    row_number: record.source.row_number
  };
  application.ng_expressions = [...record.ng_expressions];
  application.warnings.push(...record.validation.warnings);

  request.ng_expressions = uniqueStrings([...(request.ng_expressions || []), ...record.ng_expressions]);
  request.client_master = application;
  request.brand_assets = {
    schema_version: "aicr-brand-assets-v1",
    logo: {
      available: logoAvailable,
      enabled: logoAvailable && brandConfig.logo_insertion_enabled === true,
      reference: record.logo.reference,
      source_type: record.logo.source_type,
      placement: brandConfig.default_logo_placement || "bottom_right",
      avoid_note_band_enabled: brandConfig.logo_avoid_note_band_enabled === true,
      api_input_required: logoAvailable && brandConfig.logo_insertion_enabled === true,
      prompt_instruction_enabled: logoAvailable && brandConfig.logo_insertion_enabled === true,
      postprocess_overlay_enabled:
        logoAvailable &&
        brandConfig.logo_insertion_enabled === true &&
        brandConfig.logo_avoid_note_band_enabled === true
    },
    required_note: {
      available: noteAvailable,
      enabled: noteAvailable && brandConfig.required_note_band_enabled === true,
      text: record.required_note,
      source: "client_master"
    },
    brand_color: {
      available: brandColorAvailable,
      hex: record.brand_color_hex,
      use_for_note_band: brandConfig.note_band?.use_brand_color_as_background === true,
      prompt_enabled: brandConfig.brand_color_prompt_enabled === true
    },
    notes: record.notes
  };

  for (const warning of record.validation.warnings) addValidationWarning(request, warning);
  return request;
}

export function normalizeClientMasterRow(row, options = {}) {
  const brandColorRaw = normalizeString(readAlias(row, CLIENT_MASTER_FIELD_ALIASES.brand_color));
  const brandColorHex = normalizeHexColor(brandColorRaw);
  const logoReference = normalizeString(readAlias(row, CLIENT_MASTER_FIELD_ALIASES.logo_reference));
  const warnings = [];
  if (brandColorRaw && !brandColorHex) {
    warnings.push(`client_master: invalid brand_color HEX "${brandColorRaw}".`);
  }

  return {
    schema_version: "aicr-client-master-record-v1",
    client_id: normalizeString(readAlias(row, CLIENT_MASTER_FIELD_ALIASES.client_id)),
    client_name: normalizeString(readAlias(row, CLIENT_MASTER_FIELD_ALIASES.client_name)),
    source: {
      row_number: options.rowNumber ?? null
    },
    logo: {
      reference: logoReference,
      source_type: classifyLogoReference(logoReference)
    },
    required_note: normalizeString(readAlias(row, CLIENT_MASTER_FIELD_ALIASES.required_note)),
    ng_expressions: splitList(readAlias(row, CLIENT_MASTER_FIELD_ALIASES.ng_expressions)),
    brand_color_hex: brandColorHex,
    notes: normalizeString(readAlias(row, CLIENT_MASTER_FIELD_ALIASES.notes)),
    validation: {
      ok: warnings.length === 0,
      warnings
    }
  };
}

export function findClientMasterRecord(context, projectName) {
  const key = normalizeLookupKey(projectName);
  if (!key) return null;
  return context.index.byName.get(key) || context.index.byId.get(key) || null;
}

export function buildClientMasterIndex(records) {
  const byName = new Map();
  const byId = new Map();
  const warnings = [];

  for (const record of records) {
    const nameKey = normalizeLookupKey(record.client_name);
    if (nameKey) {
      if (byName.has(nameKey)) warnings.push(`client_master duplicate client_name: ${record.client_name}`);
      else byName.set(nameKey, record);
    }
    const idKey = normalizeLookupKey(record.client_id);
    if (idKey) {
      if (byId.has(idKey)) warnings.push(`client_master duplicate client_id: ${record.client_id}`);
      else byId.set(idKey, record);
    }
  }

  return { byName, byId, warnings };
}

export function summarizeClientMasterContext(context) {
  if (!context) return null;
  return {
    enabled: Boolean(context.enabled),
    status: context.status,
    source_kind: context.source_kind || null,
    record_count: context.records?.length || 0,
    warnings: context.warnings || []
  };
}

export function resolveBrandAssetsConfig(guardrails = {}) {
  return {
    logo_insertion_enabled: guardrails.brand_assets?.logo_insertion_enabled === true,
    required_note_band_enabled: guardrails.brand_assets?.required_note_band_enabled === true,
    brand_color_prompt_enabled: guardrails.brand_assets?.brand_color_prompt_enabled === true,
    logo_avoid_note_band_enabled: guardrails.brand_assets?.logo_avoid_note_band_enabled !== false,
    bottom_safe_area_prompt_enabled: guardrails.brand_assets?.bottom_safe_area_prompt_enabled !== false,
    default_logo_placement: guardrails.brand_assets?.default_logo_placement || "bottom_right",
    logo_overlay: guardrails.brand_assets?.logo_overlay || {},
    note_band: guardrails.brand_assets?.note_band || {}
  };
}

async function resolveClientMasterSettings(projectRoot, args = {}, feature = {}) {
  const configPath = resolveOptionalPath(
    projectRoot,
    args.clientMasterConfig || feature.config_path || path.join("config", "client_master.example.json")
  );
  let parsed = {};
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch (error) {
    if (args.clientMasterConfig || feature.config_path) throw error;
  }

  const source = parsed.client_master_sheet || parsed.google_client_master_sheet || parsed.source || {};
  return {
    config_path: parsed.schema_version ? configPath : null,
    read_mode: args.clientMasterSource || source.read_mode || feature.read_mode || "public-csv-or-google-sheets",
    local_csv_path: resolveOptionalPath(projectRoot, args.clientMasterCsv || source.local_csv_path || ""),
    source
  };
}

async function loadClientMasterRows({ projectRoot, args, settings }) {
  if (settings.local_csv_path) {
    try {
      const loaded = await loadRowsFromCsvPath(settings.local_csv_path);
      return {
        ok: true,
        source_kind: "csv",
        rows: loaded.rows,
        source_metadata: {
          path: settings.local_csv_path,
          row_count_read: loaded.rows.length + 1,
          external_write_performed: false
        }
      };
    } catch (error) {
      return {
        ok: false,
        status: "client_master_csv_read_failed",
        reason: error.message
      };
    }
  }

  const mode = settings.read_mode;
  if (mode === "public-csv" || mode === "public-csv-or-google-sheets") {
    try {
      const loaded = await loadRowsFromPublicSheetSource({
        source: settings.source,
        gid: args.clientMasterGid || settings.source.gid,
        range: args.clientMasterRange || settings.source.data_range || "A1:G500"
      });
      return {
        ok: true,
        source_kind: "public_google_sheet",
        rows: loaded.rows,
        source_metadata: loaded.source_metadata
      };
    } catch (error) {
      if (mode === "public-csv") {
        return {
          ok: false,
          status: error.code || "client_master_public_csv_failed",
          reason: error.message
        };
      }
    }
  }

  try {
    const credentialPath = resolveGoogleCredentialPath(projectRoot, settings.source, args);
    const loaded = await loadRowsFromGoogleSheetSource({
      source: settings.source,
      credentialPath,
      gid: args.clientMasterGid || settings.source.gid,
      sheetName: args.clientMasterSheetName || settings.source.sheet_name,
      range: args.clientMasterRange || settings.source.data_range || "A1:G500"
    });
    return {
      ok: true,
      source_kind: "google_sheets",
      rows: loaded.rows,
      source_metadata: loaded.source_metadata
    };
  } catch (error) {
    return {
      ok: false,
      status: error.code || "client_master_google_sheets_failed",
      reason: error.message
    };
  }
}

function buildUnavailableContext({ status, settings, warnings }) {
  return {
    schema_version: "aicr-client-master-context-v1",
    enabled: true,
    status,
    config_path: settings.config_path || null,
    source_kind: null,
    source_metadata: null,
    records: [],
    index: buildClientMasterIndex([]),
    warnings
  };
}

function normalizeLookupKey(value) {
  return normalizeString(value).toLowerCase().replace(/\s+/g, "");
}

function normalizeHexColor(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : "";
}

function classifyLogoReference(value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  if (/^data:image\//i.test(raw)) return "data_url";
  if (/\/file\/d\/[a-zA-Z0-9_-]+/.test(raw) || /[?&]id=[a-zA-Z0-9_-]+/.test(raw)) return "drive_file_id";
  if (/^https?:\/\//i.test(raw)) return "url";
  if (/^[a-zA-Z0-9_-]{20,}$/.test(raw)) return "drive_file_id";
  return "unknown";
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(normalizeString).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function addValidationWarning(request, warning) {
  request.validation = request.validation || { ok: true, errors: [], warnings: [] };
  request.validation.warnings = request.validation.warnings || [];
  if (!request.validation.warnings.includes(warning)) request.validation.warnings.push(warning);
}

function resolveOptionalPath(projectRoot, value) {
  const raw = normalizeString(value);
  if (!raw) return "";
  if (raw === "~") return process.env.HOME || raw;
  const expanded = raw.startsWith("~/") ? path.join(process.env.HOME || "", raw.slice(2)) : raw;
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}
