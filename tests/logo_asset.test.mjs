import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDriveDownloadUrl,
  classifyLogoReference,
  extractDriveFileId,
  loadLogoInputImage
} from "../src/logo_asset.mjs";

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d
]);

test("extracts Drive file IDs and builds download URLs", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
  assert.equal(extractDriveFileId(`https://drive.google.com/file/d/${id}/view?usp=sharing`), id);
  assert.equal(classifyLogoReference(id), "drive_file_id");
  assert.equal(buildDriveDownloadUrl(id), `https://drive.google.com/uc?export=download&id=${id}`);
});

test("loads logo input image as data URL without exposing binary in summary", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: new Map([["content-type", "image/png"]]),
      arrayBuffer: async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength)
    };
  };

  const logoInput = await loadLogoInputImage("https://example.com/logo.png", { fetchImpl });

  assert.equal(calls[0], "https://example.com/logo.png");
  assert.equal(logoInput.input_type, "data_url");
  assert.equal(logoInput.source_type, "url");
  assert.equal(logoInput.mime_type, "image/png");
  assert.ok(logoInput.image_url.startsWith("data:image/png;base64,"));
});

test("rejects non-image logo fetches", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "text/html"]]),
    arrayBuffer: async () => Buffer.from("<html>login</html>").buffer
  });

  await assert.rejects(
    () => loadLogoInputImage("https://example.com/logo.png", { fetchImpl }),
    /did not return image content/
  );
});
