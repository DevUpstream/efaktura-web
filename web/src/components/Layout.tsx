import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, type FollowUp } from "../api";
import { useSession } from "../session";

export function Layout() {
  const { me, logout } = useSession();
  const { clientId } = useParams();
  const nav = useNavigate();
  const client = me?.clients?.find((c) => String(c.id) === clientId);
  const crm = !!client?.modules.includes("crm");
  const loc = useLocation();
  const [fu, setFu] = useState<{ n: number; late: boolean }>({ n: 0, late: false });
  useEffect(() => {
    if (!client || !crm) return setFu({ n: 0, late: false });
    const get = () => api.get<FollowUp[]>(`/api/clients/${client.id}/followups?days=0`)
      .then((r) => setFu({ n: r.length, late: r.some((x) => x.overdue) }), () => undefined);
    void get();
    window.addEventListener("followups-changed", get);
    return () => window.removeEventListener("followups-changed", get);
  }, [client?.id, crm, loc.pathname]);
  if (!client) return <div className="center-card"><h1>Клиентот не е достапен</h1><p>Немате пристап или клиентот не постои.</p></div>;

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">е-Фактура</div>
        <label className="client-pick">
          <span className="sr-only">Клиент</span>
          <select value={client.id} onChange={(e) => nav(`/c/${e.target.value}/invoices`)}>
            {me!.clients!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div className="seal" aria-label="Податоци за клиентот">
          <span className="seal-prefix">{client.prefix}</span>
          <span className="seal-edb">ЕДБ<br />{client.edb}</span>
        </div>
        <nav className="menu">
          <NavLink to={`/c/${client.id}/invoices`} end>Фактури</NavLink>
          {client.modules.includes("incoming") && <NavLink to={`/c/${client.id}/purchases`}>Влезни фактури</NavLink>}
          {client.modules.includes("payments") && <NavLink to={`/c/${client.id}/payments`}>Плаќања и наплата</NavLink>}
          {client.modules.includes("warehouse") && <NavLink to={`/c/${client.id}/stock`}>Магацин</NavLink>}
          {client.modules.includes("production") && <NavLink to={`/c/${client.id}/production`}>Производство</NavLink>}
          <NavLink to={`/c/${client.id}/partners`}>{client.modules.includes("incoming") ? "Купувачи и добавувачи" : "Купувачи"}</NavLink>
          {crm && <NavLink to={`/c/${client.id}/followups`}>Потсетници{fu.n > 0 && <span className={`badge ${fu.late ? "late" : ""}`} aria-label={`${fu.n} за денес`}>{fu.n}</span>}</NavLink>}
          <NavLink to={`/c/${client.id}/items`}>Артикли и услуги</NavLink>
          <NavLink to={`/c/${client.id}/settings`}>Поставки и PDF</NavLink>
          {me!.user!.role === "admin" && <NavLink to={`/c/${client.id}/clients`} className="menu-admin">Клиенти (фирми)</NavLink>}
          {me!.user!.role === "admin" && <NavLink to={`/c/${client.id}/admin`}>Корисници и пристап</NavLink>}
        </nav>
        <div className="who">
          <span>{me!.user!.displayName}</span>
          <span className="muted">{me!.user!.role === "admin" ? "Администратор" : "Сметководител"}</span>
          <button className="link" onClick={logout}>Одјави се</button>
        </div>
      </aside>
      <main className="main"><Outlet context={client} /></main>
    </div>
  );
}
