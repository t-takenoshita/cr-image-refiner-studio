import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const password = process.env.SITE_PASSWORD || "";
const outputPath = path.resolve(process.argv[2] || "_site/site-auth-config.json");
const iterations = 310_000;

if (!password) throw new Error("SITE_PASSWORD repository secret is missing.");

const salt = crypto.randomBytes(16);
const verifier = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
const config = {
  version: 1,
  algorithm: "PBKDF2-SHA256",
  iterations,
  salt: salt.toString("base64"),
  verifier: verifier.toString("base64")
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(config)}\n`, { mode: 0o644 });
console.log(`Created Pages authentication config at ${outputPath}.`);
