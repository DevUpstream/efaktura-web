-- Забелешка 4 (17.11.2026): IBAN (MKkk + 15) = домашна сметка. Еден облик за споредба, дупли изводи и континуитет.
-- Не се брише ништо. Ред во partner_accounts што би станал дупликат останува како што е (не пречи: споредбата е нормализирана).
UPDATE "bank_statements" SET "own_account" = substr(x.d, 1, 3) || '-' || substr(x.d, 4, 10) || '-' || substr(x.d, 14, 2)
FROM (SELECT "id", regexp_replace(regexp_replace(upper("own_account"), '[\s-]', '', 'g'), '^MK\d{2}(\d{15})$', '\1') AS d
      FROM "bank_statements" WHERE "own_account" IS NOT NULL) x
WHERE x."id" = "bank_statements"."id" AND x.d ~ '^\d{15}$'
  AND "bank_statements"."own_account" <> substr(x.d, 1, 3) || '-' || substr(x.d, 4, 10) || '-' || substr(x.d, 14, 2);--> statement-breakpoint
UPDATE "partner_accounts" p SET "account" = substring(upper(p."account") from '^MK\d{2}(\d{15})$')
WHERE upper(p."account") ~ '^MK\d{2}\d{15}$'
  AND NOT EXISTS (SELECT 1 FROM "partner_accounts" q WHERE q."client_id" = p."client_id" AND q."account" = substring(upper(p."account") from '^MK\d{2}(\d{15})$'));
