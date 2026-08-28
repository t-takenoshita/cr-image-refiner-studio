import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { applyFormLogoToRequest, FORM_LOGOS } from "../src/form_logo.mjs";
import { loadLogoInputImage } from "../src/logo_asset.mjs";
import { buildPromptPack } from "../src/prompt_builder.mjs";
import { normalizeRequestRow } from "../src/request_schema.mjs";

test("maps every Google Form logo choice to a bundled image", async () => {
  for (const label of Object.keys(FORM_LOGOS)) {
    const request = applyFormLogoToRequest(normalizeRequestRow({ ロゴ: label }));
    assert.equal(request.logo_selection, label);
    assert.equal(request.brand_assets.logo.label, label);
    assert.equal(request.brand_assets.logo.placement, "above_ad");
    assert.equal(request.brand_assets.logo.max_width_ratio, 0.22);
    assert.equal(request.brand_assets.logo.max_height_ratio, 0.1);
    assert.equal(request.brand_assets.logo.alignment, "left");
    assert.equal(request.brand_assets.logo.plate_background_color, "auto");
    assert.equal(request.brand_assets.logo.postprocess_overlay_enabled, true);
    await fs.access(request.brand_assets.logo.reference);
    const input = await loadLogoInputImage(request.brand_assets.logo.reference);
    assert.equal(input.source_type, "local_file");
    assert.match(input.image_url, /^data:image\/png;base64,/);
  }
});

test("なし leaves logo overlay disabled", () => {
  const request = applyFormLogoToRequest(normalizeRequestRow({ ロゴ: "なし" }));
  assert.equal(request.logo_selection, "なし");
  assert.equal(request.brand_assets, undefined);
});

test("keeps the form logo source through prompt-pack conversion", async () => {
  const request = applyFormLogoToRequest(normalizeRequestRow({ ロゴ: "Rクリニック" }));
  const promptPack = await buildPromptPack(request, { guardrails: { policy_gate_enabled: false } });
  assert.equal(promptPack.brand_assets.logo.source, "google_form");
  assert.equal(promptPack.brand_assets.logo.label, "Rクリニック");
  assert.equal(promptPack.brand_assets.logo.plate_background_color, "auto");
  assert.equal(promptPack.brand_assets.logo.postprocess_overlay_enabled, true);
});
