import { hash, verify } from "@node-rs/argon2";

// argon2id, OWASP: m=19 MiB, t=2, p=1 (serverot ima 1 GB RAM)
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
const DUMMY = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$K2a0y8Ndq8T3t5bJpKZ6qkF1wqvDqzvJ8pUu0cXvH0Y";

export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return "Лозинката мора да има најмалку 12 знаци.";
  if (pw.length > 200) return "Лозинката е предолга.";
  if (new Set(pw).size < 6) return "Лозинката е премногу едноставна.";
  return null;
}

export const hashPassword = (pw: string) => hash(pw, OPTS);

/** Ako nema hash, sepak trosi isto vreme (da ne se otkriva dali smetkata postoi). */
export async function verifyPassword(hashed: string | null | undefined, pw: string): Promise<boolean> {
  try { return await verify(hashed ?? DUMMY, pw) && !!hashed; } catch { return false; }
}
