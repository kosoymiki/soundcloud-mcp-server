import { WebActionSession } from "../dist/web/actions.js";
import { WebUploader } from "../dist/web/upload.js";

const oldTrackId = process.argv[2];
const filePath = process.argv[3];
const title = process.argv[4];
const durationSeconds = Number(process.argv[5] ?? 0);
const albumUrn = process.argv[6];
if (!oldTrackId || !filePath || !title) throw new Error("usage: node replace-track.mjs <oldTrackId> <file> <title> <duration> [albumUrn]");

const session = new WebActionSession({ logger: (level, message) => console.error(`[${level}] ${message}`) });
await session.start();
try {
  const cookies = await session.pageHandle.cookies("https://soundcloud.com");
  const token = cookies.find((c) => c.name === "oauth_token")?.value || "";
  const del = await session.pageHandle.evaluate(
    async (authToken, trackId) => {
      const response = await fetch(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=yNSW5UvBmb1A5j7qPUtIMuB9Itx3jsOC`, {
        method: "DELETE",
        headers: { Authorization: `OAuth ${authToken}`, Accept: "application/json" },
        credentials: "include",
      });
      return { status: response.status, body: (await response.text()).slice(0, 200) };
    },
    token,
    oldTrackId
  );
  console.log("delete_old", JSON.stringify(del));
  if (!(del.status >= 200 && del.status < 300)) throw new Error("old track delete failed");

  const uploader = new WebUploader(session);
  const upload = await uploader.upload({
    filePath,
    title,
    artist: "aero",
    ...(durationSeconds > 0 ? { durationSeconds } : {}),
  });
  const urn = upload.track?.urn;
  console.log("upload", JSON.stringify({ uid: upload.uid, track: upload.track, urn }).slice(0, 600));

  if (albumUrn && urn) {
    const playlistId = albumUrn.split(":").pop();
    await session.navigate(`https://soundcloud.com/n/album/${playlistId}`);
    await uploader.addTrackToAlbum(urn, albumUrn);
    console.log("album_added", JSON.stringify({ urn, albumUrn }));
  }
} finally {
  await session.close();
}
