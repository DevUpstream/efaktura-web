import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./session";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { SetPassword } from "./pages/SetPassword";
import { Invoices } from "./pages/Invoices";
import { InvoiceEditor } from "./pages/InvoiceEditor";
import { Partners } from "./pages/Partners";
import { Items } from "./pages/Items";
import { Admin } from "./pages/Admin";
import { ClientSettings } from "./pages/ClientSettings";
import { Clients } from "./pages/Clients";
import { PartnerCard } from "./pages/PartnerCard";
import { Followups } from "./pages/Followups";
import { Recurring } from "./pages/Recurring";
import { PurchaseEditor, Purchases } from "./pages/Purchases";
import { BankExpenses, OpenItems, PaymentsList, Statements, StatementView } from "./pages/Payments";
import { BomEditor, Boms, WorkOrderEditor, WorkOrders } from "./pages/Production";
import { Stock, StockCard, StockDocNew, StockDocs, StockDocView } from "./pages/Stock";
import { Today } from "./pages/Today";
import { VatBooks } from "./pages/VatBooks";
import { Ledgers } from "./pages/Ledger";
import { CostCenters } from "./pages/CostCenters";
import { Dispatches } from "./pages/Dispatches";
import { Compensations, Dunning, Ios } from "./pages/Receivables";

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
        <Route path="today" element={<Today />} />
        <Route path="vat-books" element={<VatBooks />} />
        <Route path="cost-centers" element={<CostCenters />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="invoices/new" element={<InvoiceEditor />} />
        <Route path="invoices/:id" element={<InvoiceEditor />} />
        <Route path="partners" element={<Partners />} />
        <Route path="partners/:id" element={<PartnerCard />} />
        <Route path="followups" element={<Followups />} />
        <Route path="recurring" element={<Recurring />} />
        <Route path="purchases" element={<Purchases />} />
        <Route path="purchases/new" element={<PurchaseEditor />} />
        <Route path="purchases/:id" element={<PurchaseEditor />} />
        <Route path="stock" element={<Stock />} />
        <Route path="stock/card/:itemId" element={<StockCard />} />
        <Route path="stock/docs" element={<StockDocs />} />
        <Route path="stock/dispatches" element={<Dispatches />} />
        <Route path="stock/docs/new" element={<StockDocNew />} />
        <Route path="stock/docs/:docId" element={<StockDocView />} />
        <Route path="payments" element={<OpenItems direction="in" />} />
        <Route path="payments/out" element={<OpenItems direction="out" />} />
        <Route path="payments/list" element={<PaymentsList />} />
        <Route path="payments/statements" element={<Statements />} />
        <Route path="payments/statements/:id" element={<StatementView />} />
        <Route path="payments/expenses" element={<BankExpenses />} />
        <Route path="payments/ios" element={<Ios />} />
        <Route path="payments/compensations" element={<Compensations />} />
        <Route path="payments/dunning" element={<Dunning />} />
        <Route path="payments/ledgers" element={<Ledgers />} />
        <Route path="production" element={<WorkOrders />} />
        <Route path="production/new" element={<WorkOrderEditor />} />
        <Route path="production/:id" element={<WorkOrderEditor />} />
        <Route path="production/boms" element={<Boms />} />
        <Route path="production/boms/:productId" element={<BomEditor />} />
        <Route path="items" element={<Items />} />
        <Route path="admin" element={<Admin />} />
        <Route path="settings" element={<ClientSettings />} />
        <Route path="clients" element={<Clients />} />
        <Route index element={<Navigate to="today" replace />} />
      </Route>
      <Route path="*" element={first ? <Navigate to={`/c/${first.id}/today`} replace /> : <NoClients />} />
    </Routes>
  );
}

function NoClients() {
  const { me, logout } = useSession();
  return (
    <main className="center-card">
      <h1>Немате доделено фирми</h1>
      <p>Најавени сте како {me?.user?.email}. Побарајте од администраторот да ви додели пристап до фирма.</p>
      <button className="btn" onClick={logout}>Одјави се</button>
    </main>
  );
}

export function App() {
  return <SessionProvider><Gate /></SessionProvider>;
}
