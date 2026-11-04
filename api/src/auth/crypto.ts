/** Kriptografski pomosnici: tokeni, AES-256-GCM za tajni vo bazata i kolacinja, TOTP (RFC 6238). */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Kluc od 32 bajti (APP_KEY_FILE, base64). */
export function parseKey(b64: string): Buffer {
  const k = Buffer.from(b64.trim(), "base64");
  if (k.length !== 32) throw new Error("APP_KEY mora da e 32 bajti (base64).");
  return k;
}

export function seal(key: Buffer, data: unknown, purpose: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(purpose));
  const enc = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

export function unseal<T>(key: Buffer, token: string | undefined, purpose: string): T | undefined {
  if (!token) return undefined;
  try {
    const b = Buffer.from(token, "base64url");
    const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    d.setAAD(Buffer.from(purpose));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ TOTP */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("Neispraven base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secretB32: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}

/** Proveruva kod vo prozorec +-1 period (30 s). Vrakja counter (za zastita od povtorna upotreba) ili null. */
export function verifyTotp(secretB32: string, code: string, now = Date.now(), lastUsedCounter = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const c = Math.floor(now / 30_000);
  for (const d of [0, -1, 1]) {
    const ctr = c + d;
    if (ctr <= lastUsedCounter) continue;
    const exp = Buffer.from(totpAt(secretB32, ctr));
    if (timingSafeEqual(exp, Buffer.from(code))) return ctr;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer = "eFaktura") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
