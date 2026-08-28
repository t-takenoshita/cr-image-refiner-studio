import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = coerceArgValue(inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = coerceArgValue(next);
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function resolveProjectRoot(metaUrl) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}

export function resolveDataRoot(projectRoot, args = {}) {
  return path.resolve(
    args.dataRoot ||
      process.env.AICR_FACTORY_DATA_ROOT ||
      path.join(projectRoot, "..", "AICR_Factory_data")
  );
}

export async function readJsonFile(filePath) {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  return JSON.parse(raw);
}

export async function loadGuardrails(projectRoot, args = {}) {
  const guardrailsPath = path.resolve(
    args.guardrails || path.join(projectRoot, "config", "guardrails.example.json")
  );
  const guardrails = await readJsonFile(guardrailsPath);
  return {
    guardrails,
    guardrailsPath
  };
}

export async function loadFixtureRows(fixturePath) {
  const parsed = await readJsonFile(fixturePath);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function buildExternalFlags(args = {}) {
  return {
    generateImages: Boolean(args.generateImages),
    uploadDrive: Boolean(args.uploadDrive),
    sendChatwork: Boolean(args.send),
    writeSheet: Boolean(args.writeSheet),
    confirmHumanReviewed: Boolean(args.confirmHumanReviewed)
  };
}

export function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function coerceArgValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}
