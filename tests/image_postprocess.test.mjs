import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { applyNoteBandToImage, buildNoteBandPlan, overlayLogoOnImage, resizeImageToFinal } from "../src/image_postprocess.mjs";

test("resizes with sharp and keeps required note output at final size", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-postprocess-"));
  const rawPath = path.join(dir, "raw.png");
  await sharp({
    create: {
      width: 1088,
      height: 1088,
      channels: 4,
      background: "#eeeeee"
    }
  })
    .png()
    .toFile(rawPath);

  const resize = await resizeImageToFinal(rawPath, "1080x1080");
  assert.equal(resize.status, "applied");
  const resizedMeta = await sharp(resize.output_path).metadata();
  assert.equal(resizedMeta.width, 1080);
  assert.equal(resizedMeta.height, 1080);

  const note = "※自由診療です。効果には個人差があります。";
  const noteBand = await applyNoteBandToImage(resize.output_path, note, {
    brandColorHex: "#12AB34",
    config: {
      use_brand_color_as_background: true,
      min_height: 72,
      max_height: 180
    }
  });
  const finalMeta = await sharp(noteBand.output_path).metadata();
  assert.equal(noteBand.status, "applied");
  assert.equal(noteBand.text, note);
  assert.equal(noteBand.background_color, "#12AB34");
  assert.equal(finalMeta.width, 1080);
  assert.equal(finalMeta.height, 1080);
});

test("overlays logo above required note band while keeping final size", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-logo-note-"));
  const basePath = path.join(dir, "base.png");
  await sharp({
    create: {
      width: 1080,
      height: 1080,
      channels: 4,
      background: "#eeeeee"
    }
  })
    .png()
    .toFile(basePath);

  const note = "※自由診療です。効果には個人差があります。";
  const noteBand = await applyNoteBandToImage(basePath, note, {
    brandColorHex: "#111111",
    config: {
      min_height: 90,
      max_height: 180
    }
  });
  const logoBuffer = await sharp({
    create: {
      width: 300,
      height: 120,
      channels: 4,
      background: "#FF0000"
    }
  })
    .png()
    .toBuffer();
  const logoOverlay = await overlayLogoOnImage(
    noteBand.output_path,
    {
      image_url: `data:image/png;base64,${logoBuffer.toString("base64")}`
    },
    {
      placement: "bottom_right",
      noteBandHeight: noteBand.band_height,
      avoidNoteBand: true,
      config: {
        max_width_ratio: 0.2,
        max_height_ratio: 0.12,
        margin: 32
      }
    }
  );

  const finalMeta = await sharp(logoOverlay.output_path).metadata();
  assert.equal(finalMeta.width, 1080);
  assert.equal(finalMeta.height, 1080);
  assert.equal(logoOverlay.status, "applied");
  assert.equal(logoOverlay.adjusted_for_note_band, true);
  assert.equal(logoOverlay.fully_outside_note_band, true);
  assert.ok(logoOverlay.logo.bottom <= logoOverlay.note_band_top - logoOverlay.margin);
});

test("plans note band safe area percentage without reading an image", () => {
  const plan = buildNoteBandPlan({
    noteText: "※自由診療です。効果には個人差があります。",
    width: 1080,
    height: 1080,
    config: {
      min_height: 90,
      max_height: 180
    },
    brandColorHex: "#111111"
  });

  assert.equal(plan.status, "planned");
  assert.ok(plan.band_height >= 90);
  assert.equal(plan.bottom_safe_area_percent, Math.ceil((plan.band_height / 1080) * 100));
});

test("automatically chooses a contrasting solid plate behind a logo", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-logo-plate-"));
  const basePath = path.join(dir, "base.png");
  await sharp({ create: { width: 400, height: 400, channels: 4, background: "#888888" } }).png().toFile(basePath);
  const whiteLogo = await sharp({ create: { width: 100, height: 40, channels: 4, background: "#FFFFFF" } }).png().toBuffer();
  const result = await overlayLogoOnImage(basePath, { image_url: `data:image/png;base64,${whiteLogo.toString("base64")}` }, {
    placement: "top_left",
    config: { max_width_ratio: 0.25, max_height_ratio: 0.1, margin: 16, background_color: "auto", padding: 12 }
  });
  assert.equal(result.plate.background_color, "#000000");
  assert.equal(result.plate.selection_mode, "automatic_contrast");
  assert.equal(result.plate.left, 16);
  assert.equal(result.plate.top, 16);
  assert.equal(result.logo.left, 28);
  assert.equal(result.logo.top, 28);
});

test("puts the logo in a separate top brand bar without covering generated content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-logo-brand-bar-"));
  const basePath = path.join(dir, "base.png");
  await sharp({ create: { width: 400, height: 400, channels: 4, background: "#FF0000" } }).png().toFile(basePath);
  const blackLogo = await sharp({ create: { width: 100, height: 40, channels: 4, background: "#000000" } }).png().toBuffer();
  const result = await overlayLogoOnImage(basePath, { image_url: `data:image/png;base64,${blackLogo.toString("base64")}` }, {
    placement: "top_brand_bar",
    config: { max_width_ratio: 0.25, max_height_ratio: 0.1, margin: 16, background_color: "auto", padding: 12 }
  });
  assert.equal(result.brand_bar.enabled, true);
  assert.equal(result.brand_bar.overlap_possible, false);
  assert.equal(result.brand_bar.background_color, "#FFFFFF");
  assert.ok(result.brand_bar.height >= result.plate.height + 32);
  assert.equal(result.brand_bar.content_top, result.brand_bar.height);
  const metadata = await sharp(result.output_path).metadata();
  assert.equal(metadata.width, 400);
  assert.equal(metadata.height, 400);
});

test("automatically aligns a compact logo above an unchanged square advertisement", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aicr-logo-above-ad-"));
  const basePath = path.join(dir, "base.png");
  await sharp({ create: { width: 400, height: 400, channels: 4, background: "#FF0000" } }).png().toFile(basePath);
  const logo = await sharp({ create: { width: 40, height: 80, channels: 4, background: "#000000" } }).png().toBuffer();
  const result = await overlayLogoOnImage(basePath, { image_url: `data:image/png;base64,${logo.toString("base64")}` }, {
    placement: "above_ad",
    config: { max_width_ratio: 0.25, max_height_ratio: 0.1, margin: 16, background_color: "auto", padding: 12 }
  });
  assert.equal(result.brand_bar.canvas_expanded, true);
  assert.equal(result.brand_bar.logo_alignment, "top_center");
  assert.equal(result.brand_bar.alignment_mode, "automatic_by_logo_aspect_ratio");
  assert.equal(result.brand_bar.ad_width, 400);
  assert.equal(result.brand_bar.ad_height, 400);
  assert.equal(result.logo.left, Math.floor((400 - result.plate.width) / 2) + 12);
  const metadata = await sharp(result.output_path).metadata();
  assert.equal(metadata.width, 400);
  assert.equal(metadata.height, 400 + result.brand_bar.height);
});
