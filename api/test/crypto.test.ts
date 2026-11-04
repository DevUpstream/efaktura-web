import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { base32Encode, seal, unseal, totpAt, verifyTotp } from "../src/auth/crypto.js";

describe("crypto", () => {
  it("TOTP = RFC 6238 test vektori (SHA1)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    // RFC 6238 Appendix B: T=59 -> 94287082, T=1111111109 -> 07081804 (8 cifri); 6 cifri = poslednite 6
    expect(totpAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(verifyTotp(secret, "287082", 59_000)).toBe(1);
    expect(verifyTotp(secret, "287082", 59_000, 1)).toBeNull(); // ist kod ne se koristi dvapati
    expect(verifyTotp(secret, "000000", 59_000)).toBeNull();
  });
  it("seal/unseal: namena i integritet", () => {
    const k = randomBytes(32);
    const s = seal(k, { a: 1 }, "x");
    expect(unseal(k, s, "x")).toEqual({ a: 1 });
    expect(unseal(k, s, "y")).toBeUndefined();
    expect(unseal(randomBytes(32), s, "x")).toBeUndefined();
    expect(unseal(k, s.slice(0, -2) + "AA", "x")).toBeUndefined();
  });
});
