import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useSession } from "../session";

export function Layout() {
  const { me, logout } = useSession();
  const { clientId } = useParams();
  const nav = useNavigate();
  const client = me?.clients?.find((c) => String(c.id) === clientId);
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
          <NavLink to={`/c/${client.id}/partners`}>Купувачи</NavLink>
          <NavLink to={`/c/${client.id}/items`}>Артикли и услуги</NavLink>
          <NavLink to={`/c/${client.id}/settings`}>Поставки и PDF</NavLink>
          {me!.user!.role === "admin" && <NavLink to={`/c/${client.id}/admin`} className="menu-admin">Корисници и пристап</NavLink>}
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
