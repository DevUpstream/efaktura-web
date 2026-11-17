-- Praznenje na edna firma za povtoren vnes od pocetok (docs/19; odluka 17.11.2026 za UPSTREAM).
-- SE BRISAT: izlezni i vlezni fakturi, izvodi, plakjanja, kompenzacii, opomeni, magacinski dokumenti i zaliha,
--            artikli (so cenite, lotovi, seriski broevi, normativi, rabotni nalozi), povtoruvacki fakturi, troskovni mesta.
-- OSTANUVAAT: firmata i nejzinite postavki, PARTNERITE (so kontakti, beleski, ziro-smetki), MAGACINITE,
--             korisnicite i pristapot, revizijata (audit_log) i brojacite na fakturite (izdaden broj ne se koristi povtorno).
-- Se pusta preku purge-client-docs.sh (psql -v edb=...); skriptata na krajot dodava COMMIT ili ROLLBACK.
-- Samo ASCII (PowerShell / psql).
BEGIN;
CREATE TEMP TABLE purge_client ON COMMIT DROP AS SELECT id FROM clients WHERE edb = :'edb';
DO $$ BEGIN
  IF (SELECT count(*) FROM purge_client) <> 1 THEN RAISE EXCEPTION 'Firmata so toj EDB ne e najdena (ili ima povekje).'; END IF;
END $$;

CREATE TEMP VIEW purge_now AS
  SELECT 1 AS n, 'izlezni fakturi' AS tabela, (SELECT count(*) FROM invoices x WHERE x.client_id IN (SELECT id FROM purge_client)) AS broj
  UNION ALL SELECT 2, 'vlezni fakturi', (SELECT count(*) FROM purchase_invoices x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 3, 'izvodi', (SELECT count(*) FROM bank_statements x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 4, 'stavki na izvodi', (SELECT count(*) FROM bank_statement_lines x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 5, 'plakjanja', (SELECT count(*) FROM payments x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 6, 'kompenzacii', (SELECT count(*) FROM compensations x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 7, 'opomeni', (SELECT count(*) FROM dunning_letters x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 8, 'magacinski dokumenti', (SELECT count(*) FROM stock_docs x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 9, 'rabotni nalozi', (SELECT count(*) FROM work_orders x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 10, 'artikli', (SELECT count(*) FROM items x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 11, 'povtoruvacki fakturi', (SELECT count(*) FROM recurring_invoices x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 12, 'troskovni mesta', (SELECT count(*) FROM cost_centers x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 13, 'PARTNERI (ostanuvaat)', (SELECT count(*) FROM partners x WHERE x.client_id IN (SELECT id FROM purge_client))
  UNION ALL SELECT 14, 'MAGACINI (ostanuvaat)', (SELECT count(*) FROM warehouses x WHERE x.client_id IN (SELECT id FROM purge_client));
CREATE TEMP TABLE purge_before ON COMMIT DROP AS SELECT * FROM purge_now;
CREATE TEMP TABLE purge_inv ON COMMIT DROP AS SELECT id FROM invoices WHERE client_id IN (SELECT id FROM purge_client);
CREATE TEMP TABLE purge_docs ON COMMIT DROP AS SELECT id FROM stock_docs WHERE client_id IN (SELECT id FROM purge_client);

-- zastitite (trigeri) se isklucuvaat samo vo ovaa transakcija
ALTER TABLE invoices DISABLE TRIGGER invoices_guard;
ALTER TABLE invoice_lines DISABLE TRIGGER invoice_lines_guard;
ALTER TABLE purchase_invoices DISABLE TRIGGER purchase_invoices_guard;
ALTER TABLE purchase_lines DISABLE TRIGGER purchase_lines_guard;
ALTER TABLE purchase_files DISABLE TRIGGER purchase_files_guard;
ALTER TABLE payments DISABLE TRIGGER payments_guard;
ALTER TABLE payment_allocations DISABLE TRIGGER payment_allocations_append_only;
ALTER TABLE stock_docs DISABLE TRIGGER stock_docs_append_only;
ALTER TABLE stock_moves DISABLE TRIGGER stock_moves_append_only;
ALTER TABLE files DISABLE TRIGGER files_append_only;
ALTER TABLE ujp_log DISABLE TRIGGER ujp_log_append_only;
ALTER TABLE work_orders DISABLE TRIGGER work_orders_guard;
ALTER TABLE work_order_lines DISABLE TRIGGER work_order_lines_guard;

-- plakjanja, izvodi, kompenzacii, opomeni
DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE client_id IN (SELECT id FROM purge_client));
DELETE FROM bank_statements WHERE client_id IN (SELECT id FROM purge_client);          -- stavkite: cascade
DELETE FROM bank_statement_lines WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM compensations WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM payments WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM dunning_letters WHERE client_id IN (SELECT id FROM purge_client);
-- UJP redica, log i datoteki na fakturite
DELETE FROM ujp_jobs WHERE invoice_id IN (SELECT id FROM purge_inv);
DELETE FROM ujp_log WHERE invoice_id IN (SELECT id FROM purge_inv);
DELETE FROM files WHERE invoice_id IN (SELECT id FROM purge_inv);
DELETE FROM recurring_invoices WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM purge_inv);              -- pred ispratnicite (stock_doc_id)
-- magacin
DELETE FROM serial_moves WHERE doc_id IN (SELECT id FROM purge_docs);
DELETE FROM serial_numbers WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM stock_moves WHERE doc_id IN (SELECT id FROM purge_docs);
UPDATE stock_docs SET reverses_doc_id = NULL WHERE id IN (SELECT id FROM purge_docs);
DELETE FROM stock_docs WHERE id IN (SELECT id FROM purge_docs);
DELETE FROM stock_balances WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM lot_balances WHERE lot_id IN (SELECT id FROM lots WHERE client_id IN (SELECT id FROM purge_client));
DELETE FROM work_orders WHERE client_id IN (SELECT id FROM purge_client);              -- stavkite: cascade
-- dokumenti
DELETE FROM invoices WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM purchase_invoices WHERE client_id IN (SELECT id FROM purge_client);        -- stavki i prilozi: cascade
-- artikli i se sto zavisi od niv
DELETE FROM partner_prices WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM supplier_item_map WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM boms WHERE client_id IN (SELECT id FROM purge_client);                     -- stavkite: cascade
DELETE FROM lots WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM items WHERE client_id IN (SELECT id FROM purge_client);
DELETE FROM cost_centers WHERE client_id IN (SELECT id FROM purge_client);
-- vnatresni broevi (VF, priemnici, ispratnici, nalozi) od pocetok; brojacite na fakturite ostanuvaat
DELETE FROM stock_counters WHERE client_id IN (SELECT id FROM purge_client);

ALTER TABLE invoices ENABLE TRIGGER invoices_guard;
ALTER TABLE invoice_lines ENABLE TRIGGER invoice_lines_guard;
ALTER TABLE purchase_invoices ENABLE TRIGGER purchase_invoices_guard;
ALTER TABLE purchase_lines ENABLE TRIGGER purchase_lines_guard;
ALTER TABLE purchase_files ENABLE TRIGGER purchase_files_guard;
ALTER TABLE payments ENABLE TRIGGER payments_guard;
ALTER TABLE payment_allocations ENABLE TRIGGER payment_allocations_append_only;
ALTER TABLE stock_docs ENABLE TRIGGER stock_docs_append_only;
ALTER TABLE stock_moves ENABLE TRIGGER stock_moves_append_only;
ALTER TABLE files ENABLE TRIGGER files_append_only;
ALTER TABLE ujp_log ENABLE TRIGGER ujp_log_append_only;
ALTER TABLE work_orders ENABLE TRIGGER work_orders_guard;
ALTER TABLE work_order_lines ENABLE TRIGGER work_order_lines_guard;

-- zapis vo revizijata (ostanuva)
INSERT INTO audit_log (client_id, entity, entity_id, action, changes)
SELECT p.id, 'client', p.id::text, 'purge_documents',
       jsonb_build_object('reason', 'povtoren vnes od pocetok (docs/19)',
                          'deleted', (SELECT jsonb_object_agg(tabela, broj) FROM purge_before WHERE tabela NOT LIKE '%ostanuvaat%'))
FROM purge_client p;

SELECT b.tabela, b.broj AS pred, n.broj AS posle FROM purge_before b JOIN purge_now n USING (n) ORDER BY n;
DROP VIEW purge_now;
