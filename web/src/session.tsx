import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "./api";

interface Session { me: Me | null; refresh: () => Promise<Me>; logout: () => Promise<void> }
const Ctx = createContext<Session>(null!);
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(async () => {
    const m = await api.get<Me>("/api/auth/me").catch(() => ({ authenticated: false }) as Me);
    setMe(m); return m;
  }, []);
  const logout = useCallback(async () => { await api.post("/api/auth/logout"); await refresh(); }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <Ctx.Provider value={{ me, refresh, logout }}>{children}</Ctx.Provider>;
}
