import { WebActionSession } from "../dist/web/actions.js";

const playlistUrn = process.argv[2];
const trackUrn = process.argv[3];
if (!playlistUrn || !trackUrn) {
  console.error("usage: node scripts/add-to-album-action.mjs <playlistUrn> <trackUrn>");
  process.exit(1);
}
const playlistId = playlistUrn.split(":").pop();

const session = new WebActionSession({
  uploadUrl: `https://soundcloud.com/n/album/${playlistId}`,
  logger: (level, message) => console.error(`[${level}] ${message}`),
});
await session.start();
try {
  const discovered = await session.discoverActions();
  console.log("actions", discovered.actions.size, "chunks", discovered.chunkCount);
  if (!discovered.actions.has("addToPlaylistAction")) {
    throw new Error("addToPlaylistAction not discovered");
  }
  const result = await session.call("addToPlaylistAction", { trackUrns: [trackUrn], playlistUrn });
  console.log("add result", JSON.stringify(result ?? null).slice(0, 500));
  const playlist = await session.apiGet(`/playlists/${playlistId}?t=${Date.now()}`);
  console.log("playlist", JSON.stringify({ title: playlist.title, tracks: (playlist.tracks ?? []).map((track) => ({ id: track.id, title: track.title, duration: track.full_duration })), artwork: playlist.artwork_url, permalink: playlist.permalink_url }, null, 2));
} finally {
  await session.close();
}
