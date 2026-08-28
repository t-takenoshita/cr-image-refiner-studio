import path from "node:path";
import sharp from "sharp";

const DEFAULT_LOGO_OVERLAY_CONFIG = Object.freeze({
  max_width_ratio: 0.18,
  max_height_ratio: 0.1,
  margin: 32
});

export async function resizeImageToFinal(filePath, finalSize, options = {}) {
  const size = parseSize(finalSize);
  if (!size) {
    return {
      schema_version: "aicr-image-postprocess-resize-v1",
      status: "skipped",
      reason: "final_size is not configured",
      input_path: filePath,
      output_path: ""
    };
  }

  const outputPath = options.outputPath || buildDerivedPath(filePath, `_${size.width}x${size.height}`);
  await sharp(filePath)
    .resize(size.width, size.height, { fit: "fill" })
    .png()
    .toFile(outputPath);

  return {
    schema_version: "aicr-image-postprocess-resize-v1",
    status: "applied",
    input_path: filePath,
    output_path: outputPath,
    width: size.width,
    height: size.height,
    engine: "sharp"
  };
}

export async function applyNoteBandToImage(filePath, noteText, options = {}) {
  const metadata = await sharp(filePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error(`Could not read image dimensions for note band: ${filePath}`);

  const plan = buildNoteBandPlan({
    noteText,
    width,
    height,
    config: options.config || {},
    brandColorHex: options.brandColorHex || ""
  });
  if (plan.status !== "planned") {
    return {
      schema_version: "aicr-note-band-postprocess-v1",
      status: "skipped",
      reason: "required_note is empty",
      input_path: filePath,
      output_path: ""
    };
  }

  const svg = buildNoteBandSvg({
    width,
    height: plan.band_height,
    noteLines: plan.lines,
    style: plan.style
  });
  const outputPath = options.outputPath || buildDerivedPath(filePath, "_note");

  await sharp(filePath)
    .composite([
      {
        input: Buffer.from(svg),
        left: 0,
        top: height - plan.band_height
      }
    ])
    .png()
    .toFile(outputPath);

  return {
    schema_version: "aicr-note-band-postprocess-v1",
    status: "applied",
    input_path: filePath,
    output_path: outputPath,
    text: plan.text,
    text_exact_match_source: true,
    width,
    height,
    band_height: plan.band_height,
    band_top: plan.band_top,
    line_count: plan.lines.length,
    background_color: plan.style.backgroundColor,
    text_color: plan.style.textColor,
    engine: "sharp_svg_text"
  };
}

export function buildNoteBandPlan(options = {}) {
  const note = String(options.noteText || "").trim();
  const width = Number(options.width) || 0;
  const height = Number(options.height) || 0;
  if (!note) {
    return {
      schema_version: "aicr-note-band-plan-v1",
      status: "skipped",
      reason: "required_note is empty",
      text: "",
      width,
      height
    };
  }
  if (!width || !height) throw new Error("width and height are required to plan note band.");

  const style = resolveNoteBandStyle({
    config: options.config || {},
    brandColorHex: options.brandColorHex || ""
  });
  const layout = buildNoteBandLayout({ width, height, note, style });
  return {
    schema_version: "aicr-note-band-plan-v1",
    status: "planned",
    text: note,
    width,
    height,
    band_height: layout.bandHeight,
    band_top: height - layout.bandHeight,
    bottom_safe_area_percent: Math.ceil((layout.bandHeight / height) * 100),
    line_count: layout.lines.length,
    lines: layout.lines,
    style: layout.style
  };
}

export async function overlayLogoOnImage(filePath, logoInput, options = {}) {
  if (!logoInput?.image_url) {
    return {
      schema_version: "aicr-logo-overlay-postprocess-v1",
      status: "skipped",
      reason: "logo input image is empty",
      input_path: filePath,
      output_path: ""
    };
  }

  const metadata = await sharp(filePath).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error(`Could not read image dimensions for logo overlay: ${filePath}`);

  const config = {
    ...DEFAULT_LOGO_OVERLAY_CONFIG,
    ...(options.config || {})
  };
  const margin = toPositiveInteger(config.margin, DEFAULT_LOGO_OVERLAY_CONFIG.margin);
  const maxWidth = Math.max(1, Math.floor(width * Number(config.max_width_ratio || DEFAULT_LOGO_OVERLAY_CONFIG.max_width_ratio)));
  const maxHeight = Math.max(1, Math.floor(height * Number(config.max_height_ratio || DEFAULT_LOGO_OVERLAY_CONFIG.max_height_ratio)));
  const logoBuffer = decodeImageDataUrl(logoInput.image_url);
  const resizedLogo = await sharp(logoBuffer)
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: "inside",
      withoutEnlargement: true
    })
    .png()
    .toBuffer({ resolveWithObject: true });

  const logoWidth = resizedLogo.info.width;
  const logoHeight = resizedLogo.info.height;
  const requestedBackground = String(config.background_color || "").trim();
  const backgroundColor = requestedBackground === "auto"
    ? await chooseContrastingPlateColor(logoBuffer)
    : requestedBackground;
  const padding = backgroundColor ? Math.max(0, Number.parseInt(config.padding || "0", 10) || 0) : 0;
  const compositeWidth = logoWidth + padding * 2;
  const compositeHeight = logoHeight + padding * 2;
  const compositeInput = backgroundColor
    ? await sharp({
        create: {
          width: compositeWidth,
          height: compositeHeight,
          channels: 4,
          background: backgroundColor
        }
      })
        .composite([{ input: resizedLogo.data, left: padding, top: padding }])
        .png()
        .toBuffer()
    : resizedLogo.data;
  const noteBandHeight = Math.max(0, Number(options.noteBandHeight) || 0);
  const avoidNoteBand = options.avoidNoteBand === true && noteBandHeight > 0;
  const placement = options.placement || "bottom_right";
  const brandBarEnabled = placement === "top_brand_bar" || placement === "above_ad";
  const expandCanvas = placement === "above_ad";
  const requestedAlignment = String(config.alignment || "auto");
  const logoAspectRatio = logoWidth / Math.max(1, logoHeight);
  const resolvedAlignment = requestedAlignment === "auto"
    ? (logoAspectRatio >= 1.8 ? "left" : "center")
    : requestedAlignment;
  const brandBarHeight = brandBarEnabled
    ? Math.min(height - 1, Math.max(compositeHeight + margin * 2, Math.round(height * 0.15)))
    : 0;
  const position = brandBarEnabled
    ? {
        left: expandCanvas
          ? resolveHorizontalPosition({ width, itemWidth: compositeWidth, margin, alignment: resolvedAlignment })
          : margin,
        top: Math.max(0, Math.floor((brandBarHeight - compositeHeight) / 2))
      }
    : calculateLogoPosition({
        width,
        height,
        logoWidth: compositeWidth,
        logoHeight: compositeHeight,
        margin,
        placement,
        noteBandHeight,
        avoidNoteBand
      });
  const outputPath = options.outputPath || buildDerivedPath(filePath, "_logo");

  if (brandBarEnabled) {
    const content = expandCanvas
      ? await sharp(filePath).png().toBuffer()
      : await sharp(filePath).resize(width, height - brandBarHeight, { fit: "fill" }).png().toBuffer();
    const outputHeight = expandCanvas ? height + brandBarHeight : height;
    await sharp({ create: { width, height: outputHeight, channels: 4, background: backgroundColor || "#FFFFFF" } })
      .composite([
        { input: content, left: 0, top: brandBarHeight },
        { input: compositeInput, left: position.left, top: position.top }
      ])
      .png()
      .toFile(outputPath);
  } else {
    await sharp(filePath)
      .composite([{ input: compositeInput, left: position.left, top: position.top }])
      .png()
      .toFile(outputPath);
  }

  return {
    schema_version: "aicr-logo-overlay-postprocess-v1",
    status: "applied",
    input_path: filePath,
    output_path: outputPath,
    placement,
    adjusted_for_note_band: avoidNoteBand,
    note_band_height: noteBandHeight,
    note_band_top: noteBandHeight ? height - noteBandHeight : null,
    margin,
    canvas: { width, height: expandCanvas ? height + brandBarHeight : height },
    logo: {
      width: logoWidth,
      height: logoHeight,
      left: position.left + padding,
      top: position.top + padding,
      right: position.left + padding + logoWidth,
      bottom: position.top + padding + logoHeight
    },
    plate: backgroundColor
      ? {
          background_color: backgroundColor,
          selection_mode: requestedBackground === "auto" ? "automatic_contrast" : "fixed",
          padding,
          width: compositeWidth,
          height: compositeHeight,
          left: position.left,
          top: position.top
        }
      : null,
    brand_bar: brandBarEnabled
      ? {
          enabled: true,
          height: brandBarHeight,
          background_color: backgroundColor || "#FFFFFF",
          content_top: brandBarHeight,
          ad_width: width,
          ad_height: height,
          canvas_expanded: expandCanvas,
          logo_alignment: expandCanvas ? `top_${resolvedAlignment}` : "top_left",
          alignment_mode: requestedAlignment === "auto" ? "automatic_by_logo_aspect_ratio" : "fixed",
          overlap_possible: false
        }
      : null,
    fully_outside_note_band: avoidNoteBand ? position.top + compositeHeight <= height - noteBandHeight - margin : true,
    engine: "sharp_logo_overlay"
  };
}

async function chooseContrastingPlateColor(logoBuffer) {
  const { data, info } = await sharp(logoBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let weightedLuminance = 0;
  let totalAlpha = 0;
  const luminances = [];
  for (let index = 0; index < data.length; index += info.channels) {
    const alpha = data[index + 3] / 255;
    if (alpha < 0.05) continue;
    const luminance = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    weightedLuminance += luminance * alpha;
    totalAlpha += alpha;
    luminances.push(luminance);
  }
  let averageLuminance = totalAlpha ? weightedLuminance / totalAlpha : 255;
  const nearWhiteCount = luminances.filter((value) => value >= 245).length;
  const foreground = luminances.filter((value) => value < 235);
  if (nearWhiteCount > luminances.length * 0.6 && foreground.length) {
    averageLuminance = foreground.reduce((sum, value) => sum + value, 0) / foreground.length;
  }
  return averageLuminance >= 145 ? "#000000" : "#FFFFFF";
}

function resolveHorizontalPosition({ width, itemWidth, margin, alignment }) {
  if (alignment === "left") return margin;
  if (alignment === "right") return Math.max(margin, width - margin - itemWidth);
  return Math.max(0, Math.floor((width - itemWidth) / 2));
}

export function parseSize(value) {
  const match = String(value || "").match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  return {
    width: Number.parseInt(match[1], 10),
    height: Number.parseInt(match[2], 10)
  };
}

function calculateLogoPosition({ width, height, logoWidth, logoHeight, margin, placement, noteBandHeight, avoidNoteBand }) {
  const normalizedPlacement = String(placement || "bottom_right");
  const right = width - margin - logoWidth;
  const left = margin;
  const bottomLimit = avoidNoteBand ? height - noteBandHeight - margin : height - margin;
  const topLimit = margin;

  let x = normalizedPlacement.includes("left") ? left : right;
  let y = normalizedPlacement.includes("top") ? topLimit : bottomLimit - logoHeight;

  x = Math.max(margin, Math.min(x, width - margin - logoWidth));
  y = Math.max(margin, y);
  if (avoidNoteBand && y + logoHeight > height - noteBandHeight - margin) {
    y = height - noteBandHeight - margin - logoHeight;
  }
  if (y < margin) {
    throw new Error("Logo does not fit above the required note band with the configured logo size and margin.");
  }

  return {
    left: Math.round(x),
    top: Math.round(y)
  };
}

function decodeImageDataUrl(value) {
  const raw = String(value || "");
  const match = raw.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (!match) throw new Error("logo input image must be a data:image/* base64 URL for overlay.");
  return Buffer.from(match[1], "base64");
}

function buildNoteBandLayout({ width, height, note, style }) {
  const maxHeight = Math.min(
    toPositiveInteger(style.maxHeight, Math.floor(height * 0.3)),
    Math.max(1, height - 1)
  );
  const minHeight = Math.min(toPositiveInteger(style.minHeight, 72), maxHeight);
  let fontSize = toPositiveInteger(style.fontSize, 26);
  const minFontSize = toPositiveInteger(style.minFontSize, 18);
  const lineHeight = Number.isFinite(Number(style.lineHeight)) ? Number(style.lineHeight) : 1.35;
  const paddingX = toPositiveInteger(style.paddingX, 40);
  const paddingY = toPositiveInteger(style.paddingY, 18);

  while (fontSize >= minFontSize) {
    const maxUnits = Math.max(4, (width - paddingX * 2) / fontSize);
    const lines = wrapText(note, maxUnits);
    const contentHeight = Math.ceil(lines.length * fontSize * lineHeight);
    const bandHeight = Math.max(minHeight, paddingY * 2 + contentHeight);
    if (bandHeight <= maxHeight) {
      return {
        bandHeight,
        lines,
        style: {
          ...style,
          fontSize,
          lineHeight,
          paddingX,
          paddingY
        }
      };
    }
    fontSize -= 2;
  }

  throw new Error("Required note is too long to fit inside the configured note band without truncation.");
}

function buildNoteBandSvg({ width, height, noteLines, style }) {
  const yStart = style.paddingY + style.fontSize;
  const tSpans = noteLines
    .map((line, index) => {
      const y = index === 0 ? yStart : style.fontSize * style.lineHeight;
      const dyAttr = index === 0 ? `y="${y}"` : `dy="${y}"`;
      return `<tspan x="${style.paddingX}" ${dyAttr}>${escapeXml(line)}</tspan>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${style.backgroundColor}"/>`,
    `<text font-family="${escapeXml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${style.fontWeight}" fill="${style.textColor}" letter-spacing="0">${tSpans}</text>`,
    `</svg>`
  ].join("");
}

function resolveNoteBandStyle({ config, brandColorHex }) {
  const useBrandColor = config.use_brand_color_as_background === true && isHexColor(brandColorHex);
  const backgroundColor = useBrandColor
    ? brandColorHex
    : normalizeHexColor(config.background_color) || "#111111";
  const configuredTextColor = normalizeHexColor(config.text_color);
  const textColor = configuredTextColor || pickContrastingTextColor(backgroundColor);

  return {
    backgroundColor,
    textColor,
    fontFamily: config.font_family || "Hiragino Sans, Yu Gothic, Noto Sans CJK JP, sans-serif",
    fontWeight: config.font_weight || "700",
    fontSize: config.font_size || 26,
    minFontSize: config.min_font_size || 18,
    lineHeight: config.line_height || 1.35,
    minHeight: config.min_height || 72,
    maxHeight: config.max_height || 320,
    paddingX: config.horizontal_padding || 40,
    paddingY: config.vertical_padding || 18
  };
}

function wrapText(value, maxUnits) {
  const lines = [];
  for (const paragraph of String(value || "").split(/\r?\n/)) {
    let line = "";
    let units = 0;
    for (const char of [...paragraph]) {
      const charUnits = /[ -~]/.test(char) ? 0.56 : 1;
      if (line && units + charUnits > maxUnits) {
        lines.push(line);
        line = char;
        units = charUnits;
      } else {
        line += char;
        units += charUnits;
      }
    }
    if (line || paragraph === "") lines.push(line);
  }
  return lines.length ? lines : [""];
}

function buildDerivedPath(filePath, suffix) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}${suffix}${parsed.ext || ".png"}`);
}

function normalizeHexColor(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  return match ? `#${match[1].toUpperCase()}` : "";
}

function isHexColor(value) {
  return Boolean(normalizeHexColor(value));
}

function pickContrastingTextColor(backgroundColor) {
  const hex = normalizeHexColor(backgroundColor).slice(1);
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = rgb.map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  return luminance > 0.45 ? "#111111" : "#FFFFFF";
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
