import {
  deleteReleaseAsset,
  findReleaseByTag,
  githubRepository,
  listReleaseAssets
} from "../src/github_release_runtime.mjs";

const token = process.env.GITHUB_TOKEN || "";
const { owner, repo } = githubRepository();
const cutoff = Date.now() - 12 * 60 * 60 * 1000;

if (!token) throw new Error("GITHUB_TOKEN is missing.");
const release = await findReleaseByTag({
  owner,
  repo,
  tag: "cr-image-refiner-runtime",
  token
});
if (!release) {
  console.log("Runtime release does not exist; nothing to clean.");
  process.exit(0);
}

const assets = await listReleaseAssets({ owner, repo, releaseId: release.id, token });
const expired = assets.filter((asset) =>
  asset.name.startsWith("crir-") && new Date(asset.created_at).getTime() < cutoff
);

for (const asset of expired) {
  await deleteReleaseAsset({ owner, repo, assetId: asset.id, token });
  console.log(`Deleted expired asset: ${asset.name}`);
}

console.log(`Cleanup complete: ${expired.length} asset(s) deleted.`);
