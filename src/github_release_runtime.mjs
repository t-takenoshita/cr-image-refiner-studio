const API_VERSION = "2022-11-28";

export function githubRepository(value = process.env.GITHUB_REPOSITORY || "") {
  const [owner, repo] = value.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repo.");
  return { owner, repo };
}

export async function findReleaseByTag({ owner, repo, tag, token, fetchImpl = fetch }) {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
    { token, fetchImpl }
  );
  const releases = await response.json();
  return releases.find((release) => release.tag_name === tag) || null;
}

export async function listReleaseAssets({ owner, repo, releaseId, token, fetchImpl = fetch }) {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100`,
    { token, fetchImpl }
  );
  return response.json();
}

export async function downloadReleaseAsset({ owner, repo, assetId, token, fetchImpl = fetch }) {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`,
    { token, fetchImpl, headers: { Accept: "application/octet-stream" } }
  );
  return Buffer.from(await response.arrayBuffer());
}

export async function uploadReleaseAsset({
  owner,
  repo,
  releaseId,
  name,
  bytes,
  contentType = "application/octet-stream",
  token,
  fetchImpl = fetch
}) {
  const response = await githubFetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      token,
      fetchImpl,
      headers: { "Content-Type": contentType },
      body: bytes
    }
  );
  return response.json();
}

export async function deleteReleaseAsset({ owner, repo, assetId, token, fetchImpl = fetch }) {
  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/releases/assets/${assetId}`,
    { method: "DELETE", token, fetchImpl }
  );
}

export async function replaceReleaseAsset(options) {
  const assets = await listReleaseAssets(options);
  const existing = assets.find((asset) => asset.name === options.name);
  if (existing) await deleteReleaseAsset({ ...options, assetId: existing.id });
  return uploadReleaseAsset(options);
}

export async function createGitBlob({ owner, repo, bytes, token, fetchImpl = fetch }) {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
    {
      method: "POST",
      token,
      fetchImpl,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: Buffer.from(bytes).toString("base64"), encoding: "base64" })
    }
  );
  return response.json();
}

export async function downloadGitBlob({ owner, repo, sha, token, fetchImpl = fetch }) {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`,
    { token, fetchImpl }
  );
  const body = await response.json();
  if (body.encoding !== "base64" || !body.content) throw new Error("Git blob response did not contain base64 data.");
  return Buffer.from(String(body.content).replace(/\s+/g, ""), "base64");
}

async function githubFetch(url, options = {}) {
  if (!options.token) throw new Error("GitHub token is missing.");
  const response = await options.fetchImpl(url, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "cr-image-refiner-actions",
      ...options.headers
    },
    body: options.body
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return response;
}
