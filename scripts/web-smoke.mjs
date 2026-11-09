import { WebActionSession } from "../dist/web/actions.js";
import { WebUploader } from "../dist/web/upload.js";

const trackUrn = process.argv[2] ?? "";
const permalink = process.argv[3] ?? "";

const session = new WebActionSession({ logger: (level, message) => console.log(`[${level}] ${message}`) });
await session.start();
try {
  const discovered = await session.discoverActions();
  console.log("actions", discovered.actions.size, "chunks", discovered.chunkCount);
  if (trackUrn) {
    const info = await session.call("getTrackInfoAction", trackUrn);
    console.log("trackInfo", JSON.stringify(info).slice(0, 600));
  }
  if (permalink) {
    const uploader = new WebUploader(session);
    const track = await uploader.verifyPermalink(permalink);
    console.log("verifyPermalink", JSON.stringify(track && { urn: track.urn, title: track.title, state: track.state, permalink_url: track.permalink_url, duration: track.full_duration }));
  }
  if (!trackUrn && !permalink) {
    console.log("usage: node scripts/web-smoke.mjs [trackUrn] [permalink]");
  }
} finally {
  await session.close();
}
