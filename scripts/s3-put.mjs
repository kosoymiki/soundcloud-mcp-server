import { readFileSync, statSync } from "node:fs";

const policyFile = process.argv[2] ?? "sc-upload-policy.json";
const filePath = process.argv[3];
if (!filePath) {
  console.error("usage: node scripts/s3-put.mjs <policy.json> <file>");
  process.exit(1);
}
const policy = JSON.parse(readFileSync(policyFile, "utf8"));
const stat = statSync(filePath);
const buffer = readFileSync(filePath);
console.log("file", filePath, "size", stat.size, "policy_uid", policy.uid);

const excluded = new Set(["Content-Length", "Host", "Expect", "content-length", "host", "expect"]);
const headers = { "Content-Type": "audio/mpeg" };
for (const entry of policy.headers) {
  if (!excluded.has(entry.key) && entry.key && entry.value) headers[entry.key] = entry.value;
}
console.log("headers", JSON.stringify(headers, null, 2));

const started = Date.now();
const response = await fetch(policy.url, { method: policy.method || "PUT", headers, body: buffer });
const text = await response.text();
console.log("status", response.status, "elapsedMs", Date.now() - started);
console.log("etag", response.headers.get("etag"), "x-amz-id", response.headers.get("x-amz-id-2"));
console.log("body", text.slice(0, 600));
