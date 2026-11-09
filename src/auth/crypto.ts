/*
 * Copyright (C) 2026 soundcloud-mcp-server contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function b64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromB64url(value: string): Buffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

export function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

export function sha256b64url(value: string | Buffer): string {
  return b64url(sha256(value));
}

export function randomToken(bytes = 32, prefix = ""): string {
  return `${prefix}${b64url(randomBytes(bytes))}`;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256 pair. Verifier is 64 random bytes encoded base64url (86 chars). */
export function pkcePair(): PkcePair {
  const verifier = b64url(randomBytes(64));
  const challenge = sha256b64url(verifier);
  return { verifier, challenge };
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (verifier.length < 43 || verifier.length > 128) return false;
  return timingSafeEqualString(sha256b64url(verifier), challenge);
}

const SEAL_VERSION = "v1";

/** AES-256-GCM authenticated encryption, output: v1.<iv>.<tag>.<ciphertext>. */
export function seal(plaintext: string, key: Buffer, aad?: string): string {
  if (key.length !== 32) throw new Error("seal() requires a 32-byte key");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEAL_VERSION, b64url(iv), b64url(tag), b64url(ciphertext)].join(".");
}

export function open(sealed: string, key: Buffer, aad?: string): string {
  if (key.length !== 32) throw new Error("open() requires a 32-byte key");
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) {
    throw new Error("Malformed sealed value");
  }
  const iv = fromB64url(parts[1] as string);
  const tag = fromB64url(parts[2] as string);
  const ciphertext = fromB64url(parts[3] as string);
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Malformed sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export interface SignedValue {
  payload: string;
  signature: string;
}

export function signValue(payload: string, key: Buffer): string {
  const encoded = b64url(Buffer.from(payload, "utf8"));
  const signature = b64url(createHmac("sha256", key).update(encoded).digest());
  return `${encoded}.${signature}`;
}

export function verifySignedValue(signed: string, key: Buffer, maxAgeMs = 10 * 60_000): SignedValue | null {
  const parts = signed.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  const expected = b64url(createHmac("sha256", key).update(encoded).digest());
  if (!timingSafeEqualString(signature, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const exp = (parsed as { exp?: unknown }).exp;
  if (typeof exp !== "number" || exp < Date.now() || exp > Date.now() + maxAgeMs) return null;
  return { payload: encoded, signature };
}

export function hashToken(token: string): string {
  return sha256(token).toString("hex");
}
