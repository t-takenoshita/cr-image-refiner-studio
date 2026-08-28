import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const FORM_LOGOS = Object.freeze({
  "TCB白": "assets/logos/tcb-white.png",
  "TCB虹色": "assets/logos/tcb-rainbow.png",
  "TCB白下": "assets/logos/tcb-white-bottom.png",
  JUNO: "assets/logos/juno.png",
  "men'sTCB": "assets/logos/mens-tcb.png",
  "ATOMクリニック黒": "assets/logos/atom-black.png",
  "ATOMクリニック白": "assets/logos/atom-white.png",
  "Rクリニック": "assets/logos/r-clinic.png"
});

export function applyFormLogoToRequest(request) {
  const selection = String(request?.logo_selection || "").trim();
  if (!selection || selection === "なし") return request;

  const relativePath = FORM_LOGOS[selection];
  if (!relativePath) {
    request.validation?.warnings?.push(`フォームのロゴ「${selection}」に対応する画像がありません。`);
    return request;
  }

  request.brand_assets = request.brand_assets || { schema_version: "aicr-brand-assets-v1" };
  request.brand_assets.logo = {
    available: true,
    enabled: true,
    label: selection,
    reference: path.join(PROJECT_ROOT, relativePath),
    source_type: "local_file",
    placement: "above_ad",
    plate_background_color: "auto",
    plate_padding: 16,
    max_width_ratio: 0.22,
    max_height_ratio: 0.1,
    margin: 24,
    alignment: "left",
    avoid_note_band_enabled: false,
    api_input_required: false,
    prompt_instruction_enabled: false,
    postprocess_overlay_enabled: true,
    source: "google_form"
  };
  return request;
}
