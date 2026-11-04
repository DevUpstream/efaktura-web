/**
 * eFaktura - shema na bazata (PostgreSQL).
 * 1:1 so SharePoint listite od proektot FakturiUJP (docs/01..04-*-columns.md, scripts/06,07,12).
 * legacy_sp_id = ID na zapisot vo SharePoint (za migracija i sporedba).
 *
 * Pravila za integritet sto ne mozat vo Drizzle (triggeri) se vo drizzle/0001_integrity.sql.
 */
import { sql } from "drizzle-orm";
import {
  pgTable, pgEnum, serial, bigserial, integer, smallint, text, varchar, char, boolean, numeric,
  date, timestamp, jsonb, uuid, uniqueIndex, index, primaryKey, check,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });
const created = () => ts("created_at").notNull().defaultNow();
const updated = () => ts("updated_at").notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const amount4 = (name: string) => numeric(name, { precision: 18, scale: 4 });

/* ---------------------------------------------------------------- enumi */

/** Kodovi isti kako Doc_code vo tekot v5 (vleguvaat vo brojot na fakturata). */
export const docType = pgEnum("doc_type", ["INV", "AV", "OD", "KZ", "ST", "KR"]);
export const DOC_TYPE_LABEL: Record<(typeof docType.enumValues)[number], string> = {
  INV: "Фактура", AV: "Авансна фактура", OD: "Книжно одобрение",
  KZ: "Книжно задолжување", ST: "Сторно", KR: "Корекција",
};

export const invoiceStatus = pgEnum("invoice_status", [
  "draft", "to_issue", "issued", "json_exported", "sent_to_ujp", "rejected", "voided", "corrected", "cancelled_draft",
]);
export const INVOICE_STATUS_LABEL: Record<(typeof invoiceStatus.enumValues)[number], string> = {
  draft: "Нацрт", to_issue: "За издавање", issued: "Издадена", json_exported: "JSON извезен",
  sent_to_ujp: "Качена на УЈП", rejected: "Одбиена", voided: "Сторнирана", corrected: "Корегирана",
  cancelled_draft: "Откажан нацрт",
};

export const authProvider = pgEnum("auth_provider", ["entra", "local"]);
export const userRole = pgEnum("user_role", ["admin", "accountant"]);
export const itemType = pgEnum("item_type", ["goods", "service", "material", "product"]);
/** Vidovi artikli sto vodat zaliha (docs/07). */
export const STOCK_ITEM_TYPES = ["goods", "material", "product"] as const;
export const negativeStock = pgEnum("negative_stock", ["block", "warn"]);
export const stockDocKind = pgEnum("stock_doc_kind", ["receipt", "issue", "writeoff", "inventory", "transfer"]);
export const STOCK_DOC_CODE: Record<(typeof stockDocKind.enumValues)[number], string> = {
  receipt: "PR", issue: "IS", writeoff: "OT", inventory: "PO", transfer: "PN" };
export const purchaseStatus = pgEnum("purchase_status", ["draft", "posted", "voided"]);
export const paymentMethod = pgEnum("payment_method", ["bank", "cash", "card", "compensation", "other"]);
export const vatGroup = pgEnum("vat_group", ["DDV-A", "DDV-B", "DDV-V", "DDV-G"]);
export const vatImpact = pgEnum("vat_impact", ["STANDARD", "NULA", "OSLOBODEN", "PRENESEN"]);
export const reasonKind = pgEnum("reason_kind", ["void", "correction"]);
export const ujpAction = pgEnum("ujp_action", ["send", "status", "dry-run"]);
export const fileKind = pgEnum("file_kind", ["pdf", "json", "ujp_response", "logo"]);

/* ---------------------------------------------------------- korisnici */

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 254 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  provider: authProvider("provider").notNull(),
  entraOid: uuid("entra_oid"),                       // object id od Entra ID (samo za provider=entra)
  passwordHash: text("password_hash"),               // argon2id (samo za provider=local)
  totpSecretEnc: text("totp_secret_enc"),            // enkriptiran so klucot od serverot
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  totpLastCounter: integer("totp_last_counter").notNull().default(-1),   // ist kod ne se koristi dvapati
  role: userRole("role").notNull().default("accountant"),
  isActive: boolean("is_active").notNull().default(true),
  failedLogins: smallint("failed_logins").notNull().default(0),
  lockedUntil: ts("locked_until"),
  lastLoginAt: ts("last_login_at"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("users_email_uq").on(sql`lower(${t.email})`),
  uniqueIndex("users_entra_oid_uq").on(t.entraOid).where(sql`${t.entraOid} is not null`),
  // entra: bez lozinka (oid se vrzuva pri prva najava); local: bez oid (lozinkata se postavuva preku pokana)
  check("users_provider_ck", sql`(${t.provider} = 'entra' and ${t.passwordHash} is null and ${t.totpSecretEnc} is null)
                              or (${t.provider} = 'local' and ${t.entraOid} is null)`),
]);

/* ------------------------------------------------------------- klienti */

/** Podatoci za zaglavjeto i podnozjeto na PDF fakturata (format od UPSTREAM fakturata 2026/10/11). */
export interface PdfSettings {
  shortName?: string;            // golem naziv, npr. "УПСТРЕАМ ДООЕЛ"
  tagline?: string;              // nad nazivot, npr. "Друштво за производство, трговија и услуги"
  subtitle?: string;             // pod nazivot, npr. "увоз-извоз Крива Паланка"
  contactLine?: string;          // "upstream.mk | contact@upstream.mk | +389..."
  addressLines?: string[];       // edna adresa po red; "**tekst**" = zadebeleno
  bankAccounts?: { account: string; bank: string }[];
  invoiceTitle?: string;         // naslov za obicna faktura, npr. "Фактура-Испратница"
  signatory?: string;            // lice ovlasteno za potpisuvanje
  paymentNote?: string;          // "Рок на плаќање: Најдоцна до наведениот рок за плаќање."
  clausesTitle?: string;         // "УПСТРЕАМ ДООЕЛ го задржува правото ..."
  receiverDeclaration?: string;  // izjava pod "Примил"
  showReceivedBy?: boolean;      // "Примил (Име и Презиме, Потпис)" - za faktura-ispratnica
}

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  legacySpId: integer("legacy_sp_id").unique(),
  name: text("name").notNull(),
  edb: varchar("edb", { length: 13 }).notNull().unique(),
  embs: varchar("embs", { length: 8 }),
  vatNumber: varchar("vat_number", { length: 20 }),
  vatPayer: boolean("vat_payer").notNull().default(false),
  address: text("address").notNull(),
  city: text("city").notNull(),
  postalCode: varchar("postal_code", { length: 10 }),
  country: char("country", { length: 2 }).notNull().default("MK"),
  iban: varchar("iban", { length: 34 }),
  bankName: text("bank_name"),
  email: varchar("email", { length: 254 }),
  phone: varchar("phone", { length: 50 }),
  invoicePrefix: varchar("invoice_prefix", { length: 10 }).notNull().unique(),
  invoiceClauses: text("invoice_clauses"),
  pdfSettings: jsonb("pdf_settings").$type<PdfSettings>(),
  modules: text("modules").array().notNull().default(sql`'{invoices,crm}'::text[]`),
  negativeStock: negativeStock("negative_stock").notNull().default("block"),  // zaliha vo minus (docs/07)  // vkluceni moduli (src/domain/modules.ts)  // izgled na PDF fakturata (docs: Poставки на klientot)
  logoFileId: uuid("logo_file_id"),
  ujpRegistryAt: ts("ujp_registry_at"),              // "UJP ✓": polinjata od registarot se zaklucheni
  ujpRegistryNote: text("ujp_registry_note"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  check("clients_edb_ck", sql`${t.edb} ~ '^[0-9]{13}$'`),
  check("clients_prefix_ck", sql`${t.invoicePrefix} ~ '^[A-Z0-9]{1,10}$'`),
]);

export const clientAccess = pgTable("client_access", {
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  isActive: boolean("is_active").notNull().default(true),
  note: text("note"),
  modules: text("modules").array(),  // null = site moduli na klientot; inaku samo ovie
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.clientId, t.userId] }), index("client_access_user_ix").on(t.userId)]);

/* ---------------------------------------------------------- shifrarnici */

export const vatRates = pgTable("vat_rates", {
  id: serial("id").primaryKey(),
  legacySpId: integer("legacy_sp_id").unique(),
  code: varchar("code", { length: 10 }).notNull().unique(),
  name: text("name").notNull(),
  ujpCode: varchar("ujp_code", { length: 20 }),      // danocen indikator (UJP)
  vatGroup: vatGroup("vat_group"),
  vatImpact: vatImpact("vat_impact"),
  ratePct: numeric("rate_pct", { precision: 5, scale: 2 }).notNull(),
  isExempt: boolean("is_exempt").notNull().default(false),
  legalBasis: text("legal_basis"),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [check("vat_rates_pct_ck", sql`${t.ratePct} >= 0 and ${t.ratePct} <= 100`)]);

export const ujpReasons = pgTable("ujp_reasons", {
  code: varchar("code", { length: 10 }).primaryKey(),
  name: text("name").notNull(),
  kind: reasonKind("kind").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const partners = pgTable("partners", {
  id: serial("id").primaryKey(),
  legacySpId: integer("legacy_sp_id").unique(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  edb: varchar("edb", { length: 13 }),
  embs: varchar("embs", { length: 8 }),
  vatNumber: varchar("vat_number", { length: 20 }),
  address: text("address"),
  city: text("city"),
  postalCode: varchar("postal_code", { length: 10 }),
  country: char("country", { length: 2 }).notNull().default("MK"),
  email: varchar("email", { length: 254 }),
  phone: varchar("phone", { length: 50 }),
  ujpRegistryAt: ts("ujp_registry_at"),
  ujpRegistryNote: text("ujp_registry_note"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("partners_client_ix").on(t.clientId),
  uniqueIndex("partners_client_edb_uq").on(t.clientId, t.edb).where(sql`${t.edb} is not null`),
]);

export const items = pgTable("items", {
  id: serial("id").primaryKey(),
  legacySpId: integer("legacy_sp_id").unique(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  code: varchar("code", { length: 30 }).notNull(),
  name: text("name").notNull(),
  type: itemType("type").notNull().default("service"),
  trackLots: boolean("track_lots").notNull().default(false),  // lot / rok na traenje
  unit: varchar("unit", { length: 10 }).notNull(),
  unitPrice: amount4("unit_price").notNull(),
  vatRateId: integer("vat_rate_id").notNull().references(() => vatRates.id, { onDelete: "restrict" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("items_client_code_uq").on(t.clientId, t.code),
  check("items_price_ck", sql`${t.unitPrice} >= 0`),
]);

/** Dogovoreni ceni (docs/03). Periodite ne smeat da se preklopuvaat - trigger vo 0001_integrity.sql. */
export const partnerPrices = pgTable("partner_prices", {
  id: serial("id").primaryKey(),
  legacySpId: integer("legacy_sp_id").unique(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  partnerId: integer("partner_id").notNull().references(() => partners.id, { onDelete: "restrict" }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  price: amount4("price").notNull(),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to").notNull().default("2099-12-31"),
  note: text("note"),
  createdAt: created(),
}, (t) => [
  index("partner_prices_lookup_ix").on(t.clientId, t.partnerId, t.itemId, t.validFrom),
  check("partner_prices_price_ck", sql`${t.price} >= 0`),
  check("partner_prices_period_ck", sql`${t.validTo} >= ${t.validFrom}`),
]);

/* ---------------------------------------------------------- numeracija */

export const counters = pgTable("counters", {
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  docType: docType("doc_type").notNull(),
  year: smallint("year").notNull(),
  lastNo: integer("last_no").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.clientId, t.docType, t.year] })]);

/* ------------------------------------------------------------- fakturi */

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  legacySpId: integer("legacy_sp_id").unique(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  warehouseId: integer("warehouse_id"),  // od koj magacin (null = glavniot); FK vo 0007
  partnerId: integer("partner_id").notNull().references(() => partners.id, { onDelete: "restrict" }),
  docType: docType("doc_type").notNull().default("INV"),
  status: invoiceStatus("status").notNull().default("draft"),
  year: smallint("year").notNull(),
  seqNo: integer("seq_no"),                          // se dodeluva DURI pri izdavanje
  number: varchar("number", { length: 40 }),         // npr. MC-2026-00001, MC-OD-2026-00001

  issueDate: date("issue_date").notNull(),
  supplyDate: date("supply_date"),                   // avansna: bez datum na promet
  dueDate: date("due_date"),
  currency: char("currency", { length: 3 }).notNull().default("MKD"),
  exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }).notNull().default("1"),
  paymentMethod: paymentMethod("payment_method").notNull().default("bank"),

  netTotal: money("net_total").notNull().default("0"),
  vatTotal: money("vat_total").notNull().default("0"),
  grossTotal: money("gross_total").notNull().default("0"),
  lineCount: integer("line_count").notNull().default(0),
  advanceInvoiceId: integer("advance_invoice_id"),
  advanceAmount: money("advance_amount"),
  payableAmount: money("payable_amount"),            // round(gross, 0) - advance

  relatedInvoiceId: integer("related_invoice_id"),   // storno / odobrenie / zadolzuvanje / korekcija
  correctionReason: text("correction_reason"),
  voidReasonCode: varchar("void_reason_code", { length: 10 }).references(() => ujpReasons.code),
  correctionReasonCode: varchar("correction_reason_code", { length: 10 }).references(() => ujpReasons.code),
  clauses: text("clauses"),
  note: text("note"),

  // snimka na kupuvacot i prodavacot na denot na izdavanje
  buyerName: text("buyer_name"),
  buyerEdb: varchar("buyer_edb", { length: 13 }),
  buyerVatNumber: varchar("buyer_vat_number", { length: 20 }),
  buyerAddress: text("buyer_address"),
  buyerCity: text("buyer_city"),
  buyerCountry: char("buyer_country", { length: 2 }),
  sellerName: text("seller_name"),
  sellerEdb: varchar("seller_edb", { length: 13 }),
  sellerVatNumber: varchar("seller_vat_number", { length: 20 }),
  sellerAddress: text("seller_address"),
  sellerCity: text("seller_city"),
  sellerIban: varchar("seller_iban", { length: 34 }),
  sellerBank: text("seller_bank"),

  issuedBy: integer("issued_by").references(() => users.id),
  issuedAt: ts("issued_at"),
  statusMessage: text("status_message"),

  // UJP (go polni lokalniot agent)
  ujpId: varchar("ujp_id", { length: 40 }),          // EUID
  ujpTimestamp: ts("ujp_timestamp"),
  ujpQrLink: varchar("ujp_qr_link", { length: 255 }),
  ujpStatusCode: varchar("ujp_status_code", { length: 5 }),
  ujpStatusName: varchar("ujp_status_name", { length: 60 }),
  ujpSentAt: ts("ujp_sent_at"),
  ujpError: text("ujp_error"),

  pdfFileId: uuid("pdf_file_id"),
  jsonFileId: uuid("json_file_id"),

  createdBy: integer("created_by").references(() => users.id),
  createdAt: created(),
  updatedAt: updated(),
  version: integer("version").notNull().default(1), // optimisticko zaklucuvanje
}, (t) => [
  index("invoices_client_year_ix").on(t.clientId, t.year, t.status),
  index("invoices_partner_ix").on(t.partnerId),
  index("invoices_related_ix").on(t.relatedInvoiceId),
  index("invoices_ujp_pending_ix").on(t.status).where(sql`${t.status} = 'issued' and ${t.ujpId} is null`),
  uniqueIndex("invoices_seq_uq").on(t.clientId, t.docType, t.year, t.seqNo).where(sql`${t.seqNo} is not null`),
  uniqueIndex("invoices_number_uq").on(t.clientId, t.number).where(sql`${t.number} is not null`),
  uniqueIndex("invoices_ujp_id_uq").on(t.ujpId).where(sql`${t.ujpId} is not null`),
  check("invoices_issued_has_number_ck", sql`${t.status} in ('draft','to_issue','cancelled_draft') or (${t.seqNo} is not null and ${t.number} is not null)`),
  check("invoices_supply_ck", sql`${t.docType} = 'AV' or ${t.status} in ('draft','cancelled_draft') or ${t.supplyDate} is not null`),
  check("invoices_rate_ck", sql`${t.exchangeRate} > 0`),
]);

export const invoiceLines = pgTable("invoice_lines", {
  id: serial("id").primaryKey(),
  legacySpId: integer("legacy_sp_id").unique(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  lineNo: smallint("line_no").notNull(),
  itemId: integer("item_id").references(() => items.id, { onDelete: "restrict" }),
  description: text("description").notNull(),
  unit: varchar("unit", { length: 10 }).notNull(),
  qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
  unitPrice: amount4("unit_price").notNull(),
  discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  vatRateId: integer("vat_rate_id").notNull().references(() => vatRates.id, { onDelete: "restrict" }),
  vatRatePct: numeric("vat_rate_pct", { precision: 5, scale: 2 }).notNull(),   // snimka
  netAmount: amount4("net_amount").notNull(),
  vatAmount: amount4("vat_amount").notNull(),
  priceSource: varchar("price_source", { length: 80 }),
}, (t) => [
  uniqueIndex("invoice_lines_no_uq").on(t.invoiceId, t.lineNo),
  index("invoice_lines_item_ix").on(t.itemId),
  check("invoice_lines_discount_ck", sql`${t.discountPct} >= 0 and ${t.discountPct} <= 100`),
  check("invoice_lines_price_ck", sql`${t.unitPrice} >= 0`),
]);

/* ---------------------------------------------- datoteki, UJP, revizija */

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
  kind: fileKind("kind").notNull(),
  fileName: text("file_name").notNull(),
  contentType: varchar("content_type", { length: 100 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: char("sha256", { length: 64 }).notNull(), // kontrolna suma za arhiva 10 godini
  storagePath: text("storage_path").notNull(),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: created(),
}, (t) => [index("files_invoice_ix").on(t.invoiceId)]);

export const ujpLog = pgTable("ujp_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
  clientId: integer("client_id").references(() => clients.id, { onDelete: "restrict" }),
  action: ujpAction("action").notNull(),
  success: boolean("success").notNull().default(false),
  httpStatus: smallint("http_status"),
  euid: varchar("euid", { length: 40 }),
  message: text("message"),
  createdAt: created(),
}, (t) => [index("ujp_log_invoice_ix").on(t.invoiceId)]);

/** Kluchevi za lokalniot agent (se cuva samo SHA-256 hash). */
export const agentKeys = pgTable("agent_keys", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  keyHash: char("key_hash", { length: 64 }).notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  lastUsedAt: ts("last_used_at"),
  createdAt: created(),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: ts("at").notNull().defaultNow(),
  userId: integer("user_id").references(() => users.id),
  agentKeyId: integer("agent_key_id").references(() => agentKeys.id),
  clientId: integer("client_id"),
  entity: varchar("entity", { length: 40 }).notNull(),
  entityId: text("entity_id").notNull(),
  action: varchar("action", { length: 40 }).notNull(),
  changes: jsonb("changes"),
  ip: varchar("ip", { length: 45 }),
}, (t) => [index("audit_log_entity_ix").on(t.entity, t.entityId), index("audit_log_client_ix").on(t.clientId, t.at)]);

/* ------------------------------------------------------------- sesii */

/** Sesija: vo kolaceto e slucaen token, vo bazata samo negoviot SHA-256. */
export const sessions = pgTable("sessions", {
  idHash: char("id_hash", { length: 64 }).primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  mfaOk: boolean("mfa_ok").notNull().default(false),   // local: TOTP e potvrden; entra: MFA ja pravi Microsoft
  createdAt: created(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),               // apsoluten rok
  ip: varchar("ip", { length: 45 }),
  userAgent: varchar("user_agent", { length: 300 }),
}, (t) => [index("sessions_user_ix").on(t.userId)]);

export const tokenPurpose = pgEnum("token_purpose", ["invite", "reset"]);

/** Ednokratni tokeni (pokana / reset na lozinka). Se cuva samo SHA-256. */
export const userTokens = pgTable("user_tokens", {
  idHash: char("id_hash", { length: 64 }).primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  purpose: tokenPurpose("purpose").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: created(),
});

/* --------------------------------------------- registar na UJP (preku agentot) */

/** UJP e dostapen samo od dozvoleni IP adresi (ne od serverot) -> baranjata gi izvrsuva lokalniot agent. */
export const registryKind = pgEnum("registry_kind", ["lookup", "client", "partner"]);
export const registryStatus = pgEnum("registry_status", ["pending", "done", "error"]);

export interface UjpCompany {
  name: string; address: string; city: string; postalCode: string; vatNumber: string; embs: string; countryCode: string;
}

export const registryRequests = pgTable("ujp_registry_requests", {
  id: serial("id").primaryKey(),
  kind: registryKind("kind").notNull(),
  edb: varchar("edb", { length: 13 }).notNull(),             // koj se bara
  sellerEdb: varchar("seller_edb", { length: 13 }).notNull(), // X-EDB vo baranjeto kon UJP
  clientId: integer("client_id").references(() => clients.id, { onDelete: "cascade" }),
  partnerId: integer("partner_id").references(() => partners.id, { onDelete: "cascade" }),
  status: registryStatus("status").notNull().default("pending"),
  result: jsonb("result").$type<UjpCompany>(),
  error: text("error"),
  requestedBy: integer("requested_by").references(() => users.id),
  agentKeyId: integer("agent_key_id").references(() => agentKeys.id),
  createdAt: created(),
  doneAt: ts("done_at"),
}, (t) => [index("ujp_registry_pending_ix").on(t.status, t.createdAt)]);

/* ------------------------------------------------ kupuvaci: kontakti i istorija */

export const partnerContacts = pgTable("partner_contacts", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 200 }).notNull(),
  role: varchar("role", { length: 120 }),          // funkcija: smetkovoditel, nabavka, upravitel...
  phone: varchar("phone", { length: 50 }),
  mobile: varchar("mobile", { length: 50 }),
  email: varchar("email", { length: 254 }),
  isPrimary: boolean("is_primary").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [index("partner_contacts_partner_ix").on(t.partnerId)]);

export const noteKind = pgEnum("note_kind", ["call", "meeting", "email", "note"]);

/** Istorija na komunikacija so kupuvacot. Zapisite ne se menuvaat i ne se brisat (samo potsetnikot se zatvora). */
export const partnerNotes = pgTable("partner_notes", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").notNull().references(() => partners.id, { onDelete: "restrict" }),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").references(() => partnerContacts.id, { onDelete: "set null" }),
  kind: noteKind("kind").notNull().default("note"),
  text: text("text").notNull(),
  followUpAt: date("follow_up_at"),               // potsetnik: koga povtorno da se kontaktira
  followUpDoneAt: ts("follow_up_done_at"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: created(),
}, (t) => [
  index("partner_notes_partner_ix").on(t.partnerId, t.createdAt),
  index("partner_notes_followup_ix").on(t.clientId, t.followUpAt).where(sql`${t.followUpAt} is not null and ${t.followUpDoneAt} is null`),
]);

/* ------------------------------------------------- magacin (docs/07) */

export const warehouses = pgTable("warehouses", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  code: varchar("code", { length: 10 }).notNull(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: created(),
}, (t) => [
  uniqueIndex("warehouses_client_code_uq").on(t.clientId, t.code),
  uniqueIndex("warehouses_id_client_uq").on(t.id, t.clientId),
  uniqueIndex("warehouses_default_uq").on(t.clientId).where(sql`${t.isDefault}`),
]);

export const lots = pgTable("lots", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  lotNo: varchar("lot_no", { length: 50 }).notNull(),
  expiryDate: date("expiry_date"),
  createdAt: created(),
}, (t) => [uniqueIndex("lots_item_no_uq").on(t.itemId, t.lotNo)]);

/** Vlezni fakturi (od dobavuvaci). Knizenje -> priemnica (ako e vkluchen Magacin). */
export const purchaseInvoices = pgTable("purchase_invoices", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  partnerId: integer("partner_id").notNull().references(() => partners.id, { onDelete: "restrict" }),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
  status: purchaseStatus("status").notNull().default("draft"),
  year: smallint("year").notNull(),
  seqNo: integer("seq_no"),
  number: varchar("number", { length: 30 }),            // nas broj vo knigata na vlezni fakturi
  supplierNumber: varchar("supplier_number", { length: 60 }).notNull(),
  issueDate: date("issue_date").notNull(),
  receivedDate: date("received_date").notNull(),
  dueDate: date("due_date"),
  netTotal: money("net_total").notNull().default("0"),
  vatTotal: money("vat_total").notNull().default("0"),
  grossTotal: money("gross_total").notNull().default("0"),
  note: text("note"),
  version: integer("version").notNull().default(1),
  createdBy: integer("created_by").references(() => users.id),
  postedBy: integer("posted_by").references(() => users.id),
  postedAt: ts("posted_at"),
  voidedAt: ts("voided_at"),
  voidReason: text("void_reason"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  index("purchase_client_ix").on(t.clientId, t.receivedDate),
  uniqueIndex("purchase_seq_uq").on(t.clientId, t.year, t.seqNo),
  uniqueIndex("purchase_supplier_no_uq").on(t.clientId, t.partnerId, t.supplierNumber).where(sql`${t.status} <> 'voided'`),
]);

export const purchaseLines = pgTable("purchase_lines", {
  id: serial("id").primaryKey(),
  purchaseInvoiceId: integer("purchase_invoice_id").notNull().references(() => purchaseInvoices.id, { onDelete: "cascade" }),
  lineNo: smallint("line_no").notNull(),
  itemId: integer("item_id").references(() => items.id, { onDelete: "restrict" }),
  description: text("description").notNull(),
  unit: varchar("unit", { length: 10 }).notNull(),
  qty: amount4("qty").notNull(),
  unitPrice: amount4("unit_price").notNull(),
  discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  vatRateId: integer("vat_rate_id").notNull().references(() => vatRates.id, { onDelete: "restrict" }),
  vatRatePct: numeric("vat_rate_pct", { precision: 5, scale: 2 }).notNull(),
  netAmount: amount4("net_amount").notNull(),
  vatAmount: amount4("vat_amount").notNull(),
  allocate: boolean("allocate").notNull().default(false),   // zavisen trosok -> vo nabavnata cena
  lotNo: varchar("lot_no", { length: 50 }),
  expiryDate: date("expiry_date"),
  unitCost: amount4("unit_cost"),                            // presmetana pri knizenje
}, (t) => [
  uniqueIndex("purchase_lines_no_uq").on(t.purchaseInvoiceId, t.lineNo),
  check("purchase_lines_qty_ck", sql`${t.qty} > 0`),
  check("purchase_lines_price_ck", sql`${t.unitPrice} >= 0`),
]);

/** Magacinski dokumenti. Ne se menuvaat i ne se brisat - ispravka so nov (storno) dokument. */
export const stockDocs = pgTable("stock_docs", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  kind: stockDocKind("kind").notNull(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  toWarehouseId: integer("to_warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
  year: smallint("year").notNull(),
  seqNo: integer("seq_no").notNull(),
  number: varchar("number", { length: 30 }).notNull(),
  docDate: date("doc_date").notNull(),
  purchaseInvoiceId: integer("purchase_invoice_id").references(() => purchaseInvoices.id, { onDelete: "restrict" }),
  invoiceId: integer("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
  reversesDocId: integer("reverses_doc_id"),
  note: text("note"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: created(),
}, (t) => [
  uniqueIndex("stock_docs_seq_uq").on(t.clientId, t.kind, t.year, t.seqNo),
  uniqueIndex("stock_docs_reverses_uq").on(t.reversesDocId).where(sql`${t.reversesDocId} is not null`),
  index("stock_docs_client_ix").on(t.clientId, t.docDate),
  index("stock_docs_invoice_ix").on(t.invoiceId),
]);

/** Kniga na dvizenja: zalihata e zbir od ovie zapisi. qty i value so znak (+ vlez, - izlez). */
export const stockMoves = pgTable("stock_moves", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  docId: integer("doc_id").notNull().references(() => stockDocs.id, { onDelete: "restrict" }),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  lotId: integer("lot_id").references(() => lots.id, { onDelete: "restrict" }),
  qty: amount4("qty").notNull(),
  unitCost: amount4("unit_cost").notNull(),
  value: amount4("value").notNull(),
  balanceQty: amount4("balance_qty").notNull(),     // sostojba po dvizenjeto (za kartica)
  balanceValue: amount4("balance_value").notNull(),
  createdAt: created(),
}, (t) => [
  index("stock_moves_card_ix").on(t.warehouseId, t.itemId, t.id),
  index("stock_moves_doc_ix").on(t.docId),
  check("stock_moves_qty_ck", sql`${t.qty} <> 0`),
]);

/** Momentalna sostojba po magacin i artikl (se azurira vo istata transakcija so dvizenjeto). */
export const stockBalances = pgTable("stock_balances", {
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  itemId: integer("item_id").notNull().references(() => items.id, { onDelete: "restrict" }),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  qty: amount4("qty").notNull().default("0"),
  value: amount4("value").notNull().default("0"),
  lastCost: amount4("last_cost").notNull().default("0"),
}, (t) => [primaryKey({ columns: [t.warehouseId, t.itemId] }), index("stock_balances_client_ix").on(t.clientId)]);

export const lotBalances = pgTable("lot_balances", {
  lotId: integer("lot_id").notNull().references(() => lots.id, { onDelete: "restrict" }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  qty: amount4("qty").notNull().default("0"),
}, (t) => [primaryKey({ columns: [t.lotId, t.warehouseId] })]);

export const stockCounters = pgTable("stock_counters", {
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "restrict" }),
  kind: varchar("kind", { length: 20 }).notNull(),   // stock_doc_kind ili "purchase"
  year: smallint("year").notNull(),
  lastNo: integer("last_no").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.clientId, t.kind, t.year] })]);
