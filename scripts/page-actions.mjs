import { WebActionSession } from "../dist/web/actions.js";

const url = process.argv[2];
if (!url) throw new Error("usage: node scripts/page-actions.mjs <url>");
const session = new WebActionSession({ uploadUrl: url, logger: (level, message) => console.log(`[${level}] ${message}`) });
await session.start();
try {
  const page = session.pageHandle;
  await new Promise((resolve) => setTimeout(resolve, 2500));
  console.log("url", page.url());
  console.log("title", await page.title());
  const text = await page.evaluate(() => (document.body.innerText || "").replace(/\n+/g, " | ").slice(0, 500));
  console.log("text", text);
  const discovered = await session.discoverActions();
  console.log("chunks", discovered.chunkCount, "actions", discovered.actions.size);
  console.log([...discovered.actions.keys()].sort().join("\n"));
} finally {
  await session.close();
}
