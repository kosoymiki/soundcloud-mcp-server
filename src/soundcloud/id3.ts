/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * ID3v2 reader and writer. The reader accepts v2.2/2.3/2.4, the writer emits
 * v2.4 with UTF-8 text frames. Unknown frames are preserved on edit so that
 * editing a file does not silently destroy ReplayGain/PRIV/GEOB data.
 */

export interface Id3Artwork {
  mimeType: string;
  pictureType: number;
  description: string;
  data: Buffer;
}

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: string;
  track?: string;
  disc?: string;
  comment?: string;
  composer?: string;
  bpm?: string;
  isrc?: string;
  lyrics?: string;
  copyright?: string;
  publisher?: string;
  encodedBy?: string;
  artwork?: Id3Artwork;
  version?: string;
  warnings: string[];
}

export interface Id3Frame {
  id: string;
  flags: number;
  data: Buffer;
}

export interface Id3Document {
  major: number;
  version: string;
  frames: Id3Frame[];
  /** Byte offset where MPEG audio starts (0 when the file has no ID3v2 tag). */
  audioOffset: number;
  warnings: string[];
}

const TEXT_ENCODINGS = new Set([0, 1, 2, 3]);

const TEXT_FRAME_MAP: Record<string, keyof Id3Tags> = {
  TIT2: "title",
  TT2: "title",
  TPE1: "artist",
  TP1: "artist",
  TALB: "album",
  TAL: "album",
  TPE2: "albumArtist",
  TP2: "albumArtist",
  TCON: "genre",
  TCO: "genre",
  TDRC: "year",
  TYER: "year",
  TYE: "year",
  TRCK: "track",
  TRK: "track",
  TPOS: "disc",
  TPA: "disc",
  TCOM: "composer",
  TCM: "composer",
  TBPM: "bpm",
  TBP: "bpm",
  TSRC: "isrc",
  TRC: "isrc",
  TCOP: "copyright",
  TCR: "copyright",
  TPUB: "publisher",
  TPB: "publisher",
  TENC: "encodedBy",
  TEN: "encodedBy",
};

const V22_TO_V24: Record<string, string> = {
  TT2: "TIT2",
  TP1: "TPE1",
  TAL: "TALB",
  TP2: "TPE2",
  TCO: "TCON",
  TYE: "TYER",
  TRK: "TRCK",
  TPA: "TPOS",
  TCM: "TCOM",
  TBP: "TBPM",
  TRC: "TSRC",
  TCR: "TCOP",
  TPB: "TPUB",
  TEN: "TENC",
  COM: "COMM",
  PIC: "APIC",
  ULT: "USLT",
  TXX: "TXXX",
};

export function encodeSyncSafe(value: number): Buffer {
  return Buffer.from([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);
}

export function decodeSyncSafe(buffer: Buffer, offset: number): number {
  return (
    ((buffer[offset] ?? 0) & 0x7f) * 0x200000 +
    ((buffer[offset + 1] ?? 0) & 0x7f) * 0x4000 +
    ((buffer[offset + 2] ?? 0) & 0x7f) * 0x80 +
    ((buffer[offset + 3] ?? 0) & 0x7f)
  );
}

function deunsync(buffer: Buffer): Buffer {
  const out: number[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    out.push(buffer[index] as number);
    if (buffer[index] === 0xff && buffer[index + 1] === 0x00) index += 1;
  }
  return Buffer.from(out);
}

function decodeText(buffer: Buffer, encoding: number): string {
  if (buffer.length === 0) return "";
  try {
    if (encoding === 0) return buffer.toString("latin1").replace(/\0+$/g, "").trim();
    if (encoding === 3) return buffer.toString("utf8").replace(/\0+$/g, "").trim();
    if (encoding === 1) {
      if (buffer.length >= 2) {
        const bom = buffer.readUInt16LE(0);
        const rest = buffer.subarray(2);
        if (bom === 0xfeff) return rest.toString("utf16le").replace(/\0+$/g, "").trim();
        if (bom === 0xfffe) {
          const swapped = Buffer.from(rest);
          swapped.swap16();
          return swapped.toString("utf16le").replace(/\0+$/g, "").trim();
        }
      }
      return buffer.toString("utf16le").replace(/\0+$/g, "").trim();
    }
    const swapped = Buffer.from(buffer);
    if (swapped.length % 2 === 1) return swapped.toString("latin1").trim();
    swapped.swap16();
    return swapped.toString("utf16le").replace(/\0+$/g, "").trim();
  } catch {
    return "";
  }
}

function splitNullTerminated(buffer: Buffer, encoding: number): { head: string; rest: Buffer } {
  if (encoding === 1 || encoding === 2) {
    for (let index = 0; index + 1 < buffer.length; index += 2) {
      if (buffer[index] === 0 && buffer[index + 1] === 0) {
        return { head: decodeText(buffer.subarray(0, index), encoding), rest: buffer.subarray(index + 2) };
      }
    }
    return { head: decodeText(buffer, encoding), rest: Buffer.alloc(0) };
  }
  const index = buffer.indexOf(0);
  if (index === -1) return { head: decodeText(buffer, encoding), rest: Buffer.alloc(0) };
  return { head: decodeText(buffer.subarray(0, index), encoding), rest: buffer.subarray(index + 1) };
}

function normalizeFrameId(id: string, major: number): string | null {
  if (major !== 2) return id;
  return V22_TO_V24[id] ?? null;
}

export function parseId3Document(buffer: Buffer): Id3Document {
  const warnings: string[] = [];
  if (buffer.length < 10 || buffer.subarray(0, 3).toString("latin1") !== "ID3") {
    return { major: 0, version: "none", frames: [], audioOffset: 0, warnings: ["No ID3v2 header found"] };
  }

  const major = buffer[3] ?? 0;
  const flags = buffer[5] ?? 0;
  const declaredSize = decodeSyncSafe(buffer, 6);
  const tagEnd = Math.min(buffer.length, 10 + declaredSize);
  const hasFooter = (flags & 0x10) !== 0;
  const audioOffset = Math.min(buffer.length, 10 + declaredSize + (hasFooter ? 10 : 0));

  if ((flags & 0x40) !== 0) warnings.push("Extended ID3 header ignored");
  if (hasFooter) warnings.push("ID3v2 footer present; audio offset includes it");

  let body = buffer.subarray(10, tagEnd);
  if ((flags & 0x80) !== 0) {
    body = deunsync(body);
    warnings.push("Tag-level unsynchronisation removed");
  }

  let offset = 0;
  if ((flags & 0x40) !== 0) {
    if (body.length < 4) {
      return { major, version: `2.${major}`, frames: [], audioOffset, warnings };
    }
    const extendedSize = major === 4 ? decodeSyncSafe(body, 0) : body.readUInt32BE(0) + 4;
    offset += Math.max(4, extendedSize);
  }

  const frameHeaderSize = major === 2 ? 6 : 10;
  const idLength = major === 2 ? 3 : 4;
  const frames: Id3Frame[] = [];

  while (offset + frameHeaderSize <= body.length) {
    const rawId = body.subarray(offset, offset + idLength).toString("latin1");
    if (rawId.startsWith("\0") || !/^[A-Z0-9]+$/.test(rawId)) break;

    let size: number;
    let frameFlags = 0;
    if (major === 2) {
      size = ((body[offset + 3] ?? 0) << 16) | ((body[offset + 4] ?? 0) << 8) | (body[offset + 5] ?? 0);
    } else if (major === 4) {
      size = decodeSyncSafe(body, offset + 4);
      frameFlags = body.readUInt16BE(offset + 8);
    } else {
      size = body.readUInt32BE(offset + 4);
      frameFlags = body.readUInt16BE(offset + 8);
    }

    const dataStart = offset + frameHeaderSize;
    if (size <= 0 || dataStart + size > body.length) {
      warnings.push(`Frame ${rawId} is truncated or invalid`);
      break;
    }
    let data = body.subarray(dataStart, dataStart + size);

    // Skip compressed/encrypted frames rather than mis-parsing them.
    const compressed = major === 4 ? (frameFlags & 0x0008) !== 0 : (frameFlags & 0x0080) !== 0;
    const encrypted = major === 4 ? (frameFlags & 0x0004) !== 0 : (frameFlags & 0x0040) !== 0;
    const frameUnsync = major === 4 ? (frameFlags & 0x0002) !== 0 : false;
    if (compressed || encrypted) {
      warnings.push(`Frame ${rawId} is compressed/encrypted and was not decoded`);
    } else {
      if (frameUnsync) data = deunsync(data);
      const id = normalizeFrameId(rawId, major);
      if (id) frames.push({ id, flags: 0, data: Buffer.from(data) });
      else warnings.push(`ID3v2.2 frame ${rawId} has no v2.4 equivalent and was dropped`);
    }

    offset = dataStart + size;
  }

  return { major, version: major === 0 ? "none" : `2.${major}`, frames, audioOffset, warnings };
}

function applyTextFrame(tags: Id3Tags, id: string, data: Buffer): void {
  const key = TEXT_FRAME_MAP[id];
  if (!key) return;
  const encoding = data[0] ?? 0;
  if (!TEXT_ENCODINGS.has(encoding)) return;
  const value = decodeText(data.subarray(1), encoding).slice(0, 4000);
  if (value.length > 0) (tags as unknown as Record<string, unknown>)[key] = value;
}

function parseApic(data: Buffer): Id3Artwork | null {
  if (data.length < 4) return null;
  const encoding = data[0] ?? 0;
  const mimeSplit = splitNullTerminated(data.subarray(1), 0);
  const mimeType = mimeSplit.head || "image/jpeg";
  const pictureType = mimeSplit.rest[0] ?? 3;
  const descriptionSplit = splitNullTerminated(mimeSplit.rest.subarray(1), encoding);
  if (descriptionSplit.rest.length === 0) return null;
  return {
    mimeType: mimeType.includes("/") ? mimeType : "image/jpeg",
    pictureType,
    description: descriptionSplit.head,
    data: Buffer.from(descriptionSplit.rest),
  };
}

function parseComment(data: Buffer): { description: string; text: string } | null {
  if (data.length < 4) return null;
  const encoding = data[0] ?? 0;
  const split = splitNullTerminated(data.subarray(4), encoding);
  return { description: split.head, text: decodeText(split.rest, encoding) };
}

export function decodeFrameText(frame: Id3Frame): string {
  return decodeText(frame.data.subarray(1), frame.data[0] ?? 0);
}

export function decodeTags(document: Id3Document): Id3Tags {
  const tags: Id3Tags = { warnings: [...document.warnings] };
  if (document.major === 0) return tags;
  tags.version = document.version;

  for (const frame of document.frames) {
    try {
      if (TEXT_FRAME_MAP[frame.id]) {
        applyTextFrame(tags, frame.id, frame.data);
        continue;
      }
      if (frame.id === "APIC") {
        const artwork = parseApic(frame.data);
        if (artwork) tags.artwork = artwork;
        continue;
      }
      if (frame.id === "COMM") {
        const comment = parseComment(frame.data);
        if (comment) tags.comment = comment.text;
        continue;
      }
      if (frame.id === "USLT") {
        const lyrics = parseComment(frame.data);
        if (lyrics) tags.lyrics = lyrics.text;
        continue;
      }
      if (frame.id === "TXXX") {
        const split = splitNullTerminated(frame.data.subarray(1), frame.data[0] ?? 3);
        if (split.head.toLowerCase() === "isrc" && split.rest.length > 0) {
          tags.isrc = decodeText(split.rest, frame.data[0] ?? 3);
        }
      }
    } catch (error) {
      tags.warnings.push(
        `Frame ${frame.id} parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return tags;
}

export function parseId3(buffer: Buffer): Id3Tags {
  return decodeTags(parseId3Document(buffer));
}

// ── Writer ──────────────────────────────────────────────────────────────────

export function makeTextFrame(id: string, value: string): Id3Frame {
  return { id, flags: 0, data: Buffer.concat([Buffer.from([3]), Buffer.from(value, "utf8")]) };
}

export function makeCommentFrame(text: string, description = "", language = "eng"): Id3Frame {
  return {
    id: "COMM",
    flags: 0,
    data: Buffer.concat([
      Buffer.from([3]),
      Buffer.from(language.slice(0, 3).padEnd(3, " "), "latin1"),
      Buffer.from(description, "utf8"),
      Buffer.from([0]),
      Buffer.from(text, "utf8"),
    ]),
  };
}

export function makeLyricsFrame(text: string, description = "", language = "eng"): Id3Frame {
  return {
    id: "USLT",
    flags: 0,
    data: Buffer.concat([
      Buffer.from([3]),
      Buffer.from(language.slice(0, 3).padEnd(3, " "), "latin1"),
      Buffer.from(description, "utf8"),
      Buffer.from([0]),
      Buffer.from(text, "utf8"),
    ]),
  };
}

export function makeUserTextFrame(description: string, value: string): Id3Frame {
  return {
    id: "TXXX",
    flags: 0,
    data: Buffer.concat([
      Buffer.from([3]),
      Buffer.from(description, "utf8"),
      Buffer.from([0]),
      Buffer.from(value, "utf8"),
    ]),
  };
}

export function makeApicFrame(
  mimeType: string,
  data: Buffer,
  description = "",
  pictureType = 3
): Id3Frame {
  return {
    id: "APIC",
    flags: 0,
    data: Buffer.concat([
      Buffer.from([3]),
      Buffer.from(mimeType || "image/jpeg", "latin1"),
      Buffer.from([0, pictureType & 0xff]),
      Buffer.from(description, "utf8"),
      Buffer.from([0]),
      data,
    ]),
  };
}

/** Serialises frames into a complete ID3v2.4 tag (header + frames + padding). */
export function buildId3v24(frames: Id3Frame[], padding = 1024): Buffer {
  const chunks: Buffer[] = [];
  for (const frame of frames) {
    if (!/^[A-Z0-9]{4}$/.test(frame.id) || frame.data.length === 0) continue;
    const header = Buffer.alloc(10);
    header.write(frame.id, 0, "latin1");
    encodeSyncSafe(frame.data.length).copy(header, 4);
    header.writeUInt16BE(frame.flags & 0xffff, 8);
    chunks.push(header, frame.data);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.concat([
    Buffer.from("ID3", "latin1"),
    Buffer.from([4, 0, 0]),
    encodeSyncSafe(body.length + padding),
  ]);
  return Buffer.concat([header, body, Buffer.alloc(padding)]);
}

export interface Id3Edits {
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: string;
  track?: string;
  disc?: string;
  comment?: string;
  composer?: string;
  bpm?: string;
  isrc?: string;
  lyrics?: string;
  copyright?: string;
  publisher?: string;
  encodedBy?: string;
}

const EDIT_TO_FRAME: Array<[keyof Id3Edits, string]> = [
  ["title", "TIT2"],
  ["artist", "TPE1"],
  ["album", "TALB"],
  ["albumArtist", "TPE2"],
  ["genre", "TCON"],
  ["year", "TDRC"],
  ["track", "TRCK"],
  ["disc", "TPOS"],
  ["composer", "TCOM"],
  ["bpm", "TBPM"],
  ["isrc", "TSRC"],
  ["copyright", "TCOP"],
  ["publisher", "TPUB"],
  ["encodedBy", "TENC"],
];

export function applyId3Edits(
  document: Id3Document,
  edits: Id3Edits,
  artwork: { mimeType: string; data: Buffer; description?: string } | null | undefined,
  removeArtwork: boolean
): Id3Frame[] {
  const existing = decodeTags(document);
  const pick = (key: keyof Id3Edits): string | undefined => {
    const edited = edits[key];
    if (edited !== undefined) return edited.trim().length > 0 ? edited.trim() : undefined;
    const current = existing[key as keyof Id3Tags];
    return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
  };

  const commentEdited = edits.comment !== undefined;
  const lyricsEdited = edits.lyrics !== undefined;
  const removeArtworkFrame = removeArtwork || artwork !== undefined;
  const frames: Id3Frame[] = [];

  for (const frame of document.frames) {
    if (TEXT_FRAME_MAP[frame.id]) continue; // rebuilt from existing + edits
    if (frame.id === "APIC") {
      if (!removeArtworkFrame) frames.push(frame);
      continue;
    }
    if (frame.id === "COMM") {
      if (!commentEdited) frames.push(frame);
      continue;
    }
    if (frame.id === "USLT") {
      if (!lyricsEdited) frames.push(frame);
      continue;
    }
    if (frame.id === "TXXX") {
      const split = splitNullTerminated(frame.data.subarray(1), frame.data[0] ?? 3);
      if (split.head.toLowerCase() === "isrc") continue; // rebuilt below
      frames.push(frame);
      continue;
    }
    frames.push(frame);
  }

  for (const [key, id] of EDIT_TO_FRAME) {
    const value = pick(key);
    if (value) frames.push(makeTextFrame(id, value));
  }
  if (commentEdited) {
    const comment = pick("comment");
    if (comment) frames.push(makeCommentFrame(comment));
  }
  if (lyricsEdited) {
    const lyrics = pick("lyrics");
    if (lyrics) frames.push(makeLyricsFrame(lyrics));
  }
  const isrc = pick("isrc");
  if (isrc) frames.push(makeUserTextFrame("ISRC", isrc));
  if (artwork) {
    frames.push(makeApicFrame(artwork.mimeType, artwork.data, artwork.description ?? ""));
  }
  return frames;
}
