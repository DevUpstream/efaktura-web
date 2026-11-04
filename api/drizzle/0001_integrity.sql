-- 0001_integrity.sql - pravila za integritet sto ne mozat da se opisat vo Drizzle.
-- Bazata e poslednata linija na odbrana: i ako API-to ima greska, ovie pravila vazat.

-- 1) Samoreferenci i kruzni vrski -------------------------------------------------------------
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_advance_fk"
  FOREIGN KEY ("advance_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_related_fk"
  FOREIGN KEY ("related_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_logo_fk"
  FOREIGN KEY ("logo_file_id") REFERENCES "files"("id") ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

-- 2) Izolacija po klient na nivo na baza: kupuvacot i artiklot moraat da se od istiot klient ---
ALTER TABLE "partners" ADD CONSTRAINT "partners_id_client_uq" UNIQUE ("id", "client_id");
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_id_client_uq" UNIQUE ("id", "client_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_id_client_uq" UNIQUE ("id", "client_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_partner_client_fk"
  FOREIGN KEY ("partner_id", "client_id") REFERENCES "partners"("id", "client_id");
--> statement-breakpoint
ALTER TABLE "partner_prices" ADD CONSTRAINT "partner_prices_partner_client_fk"
  FOREIGN KEY ("partner_id", "client_id") REFERENCES "partners"("id", "client_id");
--> statement-breakpoint
ALTER TABLE "partner_prices" ADD CONSTRAINT "partner_prices_item_client_fk"
  FOREIGN KEY ("item_id", "client_id") REFERENCES "items"("id", "client_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_related_client_fk"
  FOREIGN KEY ("related_invoice_id", "client_id") REFERENCES "invoices"("id", "client_id");
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_advance_client_fk"
  FOREIGN KEY ("advance_invoice_id", "client_id") REFERENCES "invoices"("id", "client_id");
--> statement-breakpoint

-- 3) updated_at --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_updated_at BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER clients_updated_at BEFORE UPDATE ON "clients" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER partners_updated_at BEFORE UPDATE ON "partners" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER items_updated_at BEFORE UPDATE ON "items" FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
--> statement-breakpoint

-- 4) Izdadena faktura ne se menuva i ne se brise (ZDDV: samo storno ili korekcija) -------------
--    Po izdavanje smeat da se menuvaat samo statusot, porakata, UJP polinjata i vrskite do PDF/JSON.
CREATE OR REPLACE FUNCTION trg_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  editable  CONSTANT invoice_status[] := ARRAY['draft','to_issue']::invoice_status[];
  allowed   CONSTANT text[] := ARRAY['status','status_message','ujp_id','ujp_timestamp','ujp_qr_link',
                                      'ujp_status_code','ujp_status_name','ujp_sent_at','ujp_error',
                                      'pdf_file_id','json_file_id','updated_at','version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('draft','cancelled_draft') AND OLD.seq_no IS NULL THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Фактура % (%) не смее да се брише: издадена фактура се сторнира или коригира.',
      coalesce(OLD.number, OLD.id::text), OLD.status USING ERRCODE = 'P0001';
  END IF;

  NEW.updated_at := now();
  IF OLD.status = ANY (editable) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled_draft' THEN
    RAISE EXCEPTION 'Откажан нацрт не може да се менува.' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = ANY (editable) OR NEW.status = 'cancelled_draft' THEN
    RAISE EXCEPTION 'Издадена фактура % не може да се врати во нацрт.', OLD.number USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'Издадена фактура % не може да се менува (дозволени се само статус и податоци од УЈП).',
      OLD.number USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION trg_invoice_guard();
--> statement-breakpoint

-- 5) Stavki se menuvaat samo dodeka fakturata e nacrt -------------------------------------------
CREATE OR REPLACE FUNCTION trg_invoice_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inv_id integer := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  st invoice_status;
BEGIN
  SELECT status INTO st FROM invoices WHERE id = inv_id;
  -- pri kaskadno brisenje na nacrt, fakturata vekje ne postoi (nejzinoto brisenje e vekje provereno)
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Ставките на фактура % не можат да се менуваат (статус %).', inv_id, st USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'Ставка не може да се премести на друга фактура.' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION trg_invoice_line_guard();
--> statement-breakpoint

-- 6) Dogovoreni ceni: periodite za ist kupuvac + artikl ne se preklopuvaat (docs/03) -----------
CREATE OR REPLACE FUNCTION trg_partner_price_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM partner_prices p
     WHERE p.client_id = NEW.client_id AND p.partner_id = NEW.partner_id AND p.item_id = NEW.item_id
       AND p.id <> coalesce(NEW.id, -1)
       AND daterange(p.valid_from, p.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')
  ) THEN
    RAISE EXCEPTION 'Периодот %–% се преклопува со постоечка договорена цена за овој купувач и артикл.',
      NEW.valid_from, NEW.valid_to USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER partner_prices_overlap BEFORE INSERT OR UPDATE ON "partner_prices"
  FOR EACH ROW EXECUTE FUNCTION trg_partner_price_overlap();
--> statement-breakpoint

-- 7) Dnevnicite i arhivata se samo za dodavanje ------------------------------------------------
CREATE OR REPLACE FUNCTION trg_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- vgnezdeno IF: plpgsql ne garantira skratena evaluacija, a drugite tabeli nemaat kolona kind
  IF TG_TABLE_NAME = 'files' AND TG_OP = 'DELETE' THEN
    IF OLD.kind = 'logo' THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Табелата % е само за додавање (% не е дозволено).', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION trg_append_only();
--> statement-breakpoint
CREATE TRIGGER ujp_log_append_only BEFORE UPDATE OR DELETE ON "ujp_log" FOR EACH ROW EXECUTE FUNCTION trg_append_only();
--> statement-breakpoint
CREATE TRIGGER files_append_only BEFORE UPDATE OR DELETE ON "files" FOR EACH ROW EXECUTE FUNCTION trg_append_only();
--> statement-breakpoint

-- 8) Pocetni podatoci: DDV stapki (scripts/03, 07) i shifri na pricini objaveni od UJP (scripts/10)
INSERT INTO vat_rates (code, name, ujp_code, vat_group, vat_impact, rate_pct, is_exempt, legal_basis, valid_from) VALUES
  ('S18', 'Општа стапка 18%', 'DDV-A', 'DDV-A', 'STANDARD', 18, false, 'ЗДДВ – општа стапка. Да се потврди.', '2000-01-01'),
  ('R10', 'Повластена стапка 10% (угостителски услуги)', 'DDV-V', 'DDV-V', 'STANDARD', 10, false, 'ЗДДВ – стапка за угостителски услуги. Да се потврди.', '2023-01-01'),
  ('R5',  'Повластена стапка 5%', 'DDV-B', 'DDV-B', 'STANDARD', 5, false, 'ЗДДВ – повластена стапка. Да се потврди.', '2000-01-01'),
  ('Z0',  'Ослободено со право на одбивка (0%)', NULL, 'DDV-G', NULL, 0, true, 'ЗДДВ – ослободување со право на одбивка (на пр. извоз). Да се наведе член.', '2000-01-01'),
  ('E0',  'Ослободено без право на одбивка (0%)', NULL, 'DDV-G', NULL, 0, true, 'ЗДДВ – ослободување без право на одбивка. Да се наведе член.', '2000-01-01'),
  ('NP',  'Не е ДДВ обврзник', 'DDV-G', 'DDV-G', 'NULA', 0, true, 'ДДВ не е пресметан согласно член 51 став 3 од ЗДДВ (шифрарник на УЈП, DDV-G).', '2000-01-01')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO ujp_reasons (code, name, kind) VALUES
  ('S-1', 'Погрешен купувач', 'void'),
  ('S-2', 'Поништување на договор', 'void'),
  ('S-3', 'Стоката е вратена во целост', 'void'),
  ('C01', 'Грешка во цена', 'correction'),
  ('C02', 'Грешка во количина', 'correction')
ON CONFLICT (code) DO NOTHING;
