/** Moduli po klient: administratorot odlucuva koi moduli gi ima sekoja firma i koi od niv gi gleda sekoj korisnik. */
export const MODULES = [
  { key: "invoices", name: "Излезни фактури", core: true, ready: true, requires: [] },
  { key: "crm", name: "Купувачи: контакти, историја, потсетници", core: false, ready: true, requires: [] },
  { key: "payments", name: "Плаќања и наплата", core: false, ready: false, requires: [] },
  { key: "incoming", name: "Влезни фактури", core: false, ready: true, requires: [] },
  { key: "warehouse", name: "Магацин", core: false, ready: true, requires: [] },
  { key: "production", name: "Производство", core: false, ready: false, requires: ["warehouse"] },
] as const;
export type ModuleKey = (typeof MODULES)[number]["key"];
export const MODULE_KEYS = MODULES.map((m) => m.key) as [ModuleKey, ...ModuleKey[]];
export const DEFAULT_MODULES: ModuleKey[] = ["invoices", "crm"];

/** Proverka na izbor za klient: osnovniot modul e sekogas vklucen, zavisnostite moraat da se vkluceni. */
export function normalizeClientModules(sel: readonly string[]): { modules: ModuleKey[]; error?: string } {
  const set = new Set<string>(sel);
  MODULES.filter((m) => m.core).forEach((m) => set.add(m.key));
  for (const m of MODULES) {
    if (!set.has(m.key)) continue;
    const miss = m.requires.filter((r) => !set.has(r));
    if (miss.length) return { modules: [], error: `„${m.name}“ бара и: ${miss.map((r) => MODULES.find((x) => x.key === r)!.name).join(", ")}.` };
  }
  return { modules: MODULE_KEYS.filter((k) => set.has(k)) };
}

/** Moduli sto korisnikot gi gleda za klientot: modulite na klientot, ograniceni so izborot za korisnikot (null = site). */
export function effectiveModules(clientModules: readonly string[], role: "admin" | "accountant", userModules: readonly string[] | null | undefined): ModuleKey[] {
  const base = MODULE_KEYS.filter((k) => clientModules.includes(k));
  if (role === "admin" || !userModules) return base;
  return base.filter((k) => MODULES.find((m) => m.key === k)!.core || userModules.includes(k));
}
