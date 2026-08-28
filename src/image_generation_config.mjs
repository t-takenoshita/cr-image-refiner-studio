export const DEFAULT_IMAGE_SIZE = "1088x1088";
export const DEFAULT_IMAGE_QUALITY = "medium";

const QUALITY_OPTIONS = new Set(["low", "medium", "high", "auto"]);

export function normalizeImageGenerationConfig(config = {}) {
  const quality = String(config.quality || DEFAULT_IMAGE_QUALITY).toLowerCase();
  if (!QUALITY_OPTIONS.has(quality)) throw new Error("画像品質の指定が不正です。");

  const size = String(config.size || DEFAULT_IMAGE_SIZE).toLowerCase();
  if (size === "auto") return { size, quality };

  const match = size.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) throw new Error("画像サイズの指定が不正です。");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const pixels = width * height;

  if (
    longEdge > 3840
    || width % 16 !== 0
    || height % 16 !== 0
    || longEdge / shortEdge > 3
    || pixels < 655_360
    || pixels > 8_294_400
  ) {
    throw new Error("画像サイズがGPT Image 2の対応範囲外です。");
  }

  return { size: `${width}x${height}`, quality };
}

export function imageSizePrompt(size) {
  if (!size || size === "auto") return "画像サイズと縦横比は指示内容に最適なものを選ぶ。";
  const [width, height] = String(size).split("x").map(Number);
  const orientation = width === height ? "正方形" : width > height ? "横長" : "縦長";
  return `出力は${size}pxの${orientation}画像。この縦横比を優先し、全要素が自然に収まるよう構図を最適化する。`;
}
