/** Povici kon API-to. Sekoe baranje sto menuva go ima CSRF zaglavieto. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method, credentials: "same-origin",
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(method !== "GET" ? { "x-efaktura": "1" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : method !== "GET" && method !== "DELETE" ? "{}" : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiError(r.status, data?.error ?? "error", data?.message ?? `Грешка ${r.status}`);
  return data as T;
}
export const api = {
  get: <T>(u: string) => req<T>("GET", u),
  post: <T>(u: string, b?: unknown) => req<T>("POST", u, b ?? {}),
  put: <T>(u: string, b: unknown) => req<T>("PUT", u, b),
  patch: <T>(u: string, b: unknown) => req<T>("PATCH", u, b),
  del: <T>(u: string) => req<T>("DELETE", u),
};

/* --------------------------------------------------------------- tipovi */
export type DocType = "INV" | "AV" | "OD" | "KZ" | "ST" | "KR" | "PF";
export type Status = "draft" | "to_issue" | "issued" | "json_exported" | "sent_to_ujp" | "rejected" | "voided" | "corrected" | "cancelled_draft";
export interface ClientRef { id: number; name: string; edb: string; prefix: string; modules: string[]; costCenterMode?: "off" | "optional" | "required" }
export interface Me {
  authenticated: boolean; entra?: boolean; pending?: "totp" | "totp_setup" | null;
  user?: { id: number; email: string; displayName: string; role: "admin" | "accountant"; provider: "entra" | "local" };
  clients?: ClientRef[];
}
export interface Partner { id: number; name: string; edb: string | null; embs: string | null; vatNumber: string | null; address: string | null;
  city: string | null; postalCode: string | null; country: string; email: string | null; phone: string | null; bankAccount?: string | null; isActive: boolean; ujpRegistryAt: string | null;
  isCustomer: boolean; isSupplier: boolean }
export type ItemType = "goods" | "service" | "material" | "product";
export interface Item { id: number; code: string; name: string; type: ItemType; trackLots: boolean; unit: string; unitPrice: string; vatRateId: number; isActive: boolean }
export interface VatRate { id: number; code: string; name: string; ratePct: string; isActive: boolean }
export interface InvoiceRow { id: number; number: string | null; docType: DocType; status: Status; issueDate: string; dueDate: string | null;
  buyerName: string; netTotal: string; vatTotal: string; grossTotal: string; payableAmount: string | null;
  ujpId: string | null; ujpStatusName: string | null; ujpError: string | null; source?: string; ujpQrLink?: string | null; ujpSentAt?: string | null }
export interface Line { id?: number; itemId: number | null; description: string; unit: string; qty: string; unitPrice: string;
  discountPct: string; vatRateId: number; vatRatePct?: string; netAmount?: string; vatAmount?: string; priceSource: string | null;
  stockDocId?: number | null;   // stavka od ispratnica (docs/12)
  costCenterId?: number | null }   // TM na stavkata (docs/14)
export interface CostCenter { id: number; code: string; name: string; isActive: boolean }
export interface Invoice extends InvoiceRow { clientId: number; partnerId: number; warehouseId: number | null; costCenterId?: number | null; supplyDate: string | null; paymentMethod: string;
  note: string | null; clauses: string | null; version: number; lines: Line[]; advanceAmount: string | null; issuedAt: string | null;
  byRate: { vatRatePct: string; net: string; vat: string }[];
  relatedInvoiceId: number | null; relatedNumber: string | null; advanceInvoiceId: number | null; advanceNumber: string | null;
  correctionReason: string | null; voidReasonCode: string | null; correctionReasonCode: string | null;
  derived?: { id: number; number: string | null; docType: DocType; status: Status }[];
  sourceInvoiceId?: number | null; sourceNumber?: string | null; recurringId?: number | null;
  made?: { id: number; number: string | null; docType: DocType; status: Status }[] }
export type NoteKind = "call" | "meeting" | "email" | "note";
export interface Contact { id: number; partnerId: number; name: string; role: string | null; phone: string | null; mobile: string | null;
  email: string | null; isPrimary: boolean; isActive: boolean }
export interface Note { id: number; kind: NoteKind; text: string; contactId: number | null; followUpAt: string | null;
  followUpDoneAt: string | null; createdAt: string; author: string | null }
export interface PartnerCardData { partner: Partner & { note?: string | null }; contacts: Contact[]; notes: Note[];
  invoices: { id: number; number: string | null; docType: DocType; status: Status; issueDate: string; grossTotal: string; payableAmount: string | null }[] }
export interface FollowUp { id: number; partnerId: number; partnerName: string; kind: NoteKind; text: string; followUpAt: string;
  createdAt: string; author: string | null; overdue: boolean; isToday: boolean }
export interface Warehouse { id: number; clientId: number; code: string; name: string; isDefault: boolean; isActive: boolean }
