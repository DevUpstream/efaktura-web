import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./session";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { SetPassword } from "./pages/SetPassword";
import { Invoices } from "./pages/Invoices";
import { InvoiceEditor } from "./pages/InvoiceEditor";
import { Partners } from "./pages/Partners";
import { Items } from "./pages/Items";

function Gate() {
  const { me } = useSession();
  const loc = useLocation();
  if (loc.pathname === "/set-password") return <SetPassword />;
  if (!me) return <div className="boot" aria-busy="true" />;
  if (!me.authenticated || me.pending) return <Login />;
  const first = me.clients?.[0];
  return (
    <Routes>
      <Route path="/c/:clientId" element={<Layout />}>
        <Route path="invoices" element={<Invoices />} />
        <Route path="invoices/new" element={<InvoiceEditor />} />
        <Route path="invoices/:id" element={<InvoiceEditor />} />
        <Route path="partners" element={<Partners />} />
        <Route path="items" element={<Items />} />
        <Route index element={<Navigate to="invoices" replace />} />
      </Route>
      <Route path="*" element={first ? <Navigate to={`/c/${first.id}/invoices`} replace /> : <NoClients />} />
    </Routes>
  );
}

function NoClients() {
  const { me, logout } = useSession();
  return (
    <main className="center-card">
      <h1>Немате доделено клиенти</h1>
      <p>Најавени сте како {me?.user?.email}. Побарајте од администраторот да ви додели пристап до клиент.</p>
      <button className="btn" onClick={logout}>Одјави се</button>
    </main>
  );
}

export function App() {
  return <SessionProvider><Gate /></SessionProvider>;
}
