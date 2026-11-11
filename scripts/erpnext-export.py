#!/usr/bin/env python3
"""
Izvoz na shifrarnici od ERPNext (Next ERP) vo JSON za api/src/tools/import-erpnext.ts (docs/11).

  1. Bekapot (*-database.sql.gz) se vcituva vo LOKALEN MariaDB (nikogash na serverot na aplikacijata):
       mysql -e "create database erp character set utf8mb4"; zcat <bekap>-database.sql.gz | mysql erp
  2. python3 scripts/erpnext-export.py --db erp --out upstream-erpnext.json

Se izvezuva: kupuvaci + dobavuvaci (spoeni po EDB), adresa za fakturiranje, ziro-smetki, kontakti povrzani so partner,
artikli so prodazna cena (Standard Selling, bez DDV) i DDV stapka (Item Tax; bez stapka = 18 %).
NE se izvezuvaat: fakturi, plakjanja, zaliha, e-poshta, tajni (site_config ne se koristi).
Izlezot sodrzi licni podatoci (kontakti): ne se stava vo git.
"""
import argparse, hashlib, json, re, sys
from datetime import datetime, timezone
import pymysql

COUNTRY = {"Macedonia": "MK", "North Macedonia": "MK", "Bulgaria": "BG", "Serbia": "RS", "Albania": "AL", "Greece": "GR",
           "Kosovo": "XK", "Slovenia": "SI", "Croatia": "HR", "Germany": "DE", "Turkey": "TR"}
UNIT = {"Парче": "ком", "Nos": "ком", "Unit": "ком", "Кутија": "кут", "Месец": "месец", "Топ": "топ", "Час": "час"}


def tax_id(v):
    """'MK4030008051675' -> edb 4030008051675 + DDV broj; '4030...' -> samo edb; 'BG130948460' -> stranski DDV broj."""
    t = re.sub(r"\s", "", v or "").upper().replace("МК", "MK")
    if re.fullmatch(r"\d{13}", t):
        return t, None
    m = re.fullmatch(r"MK(\d{13})", t)
    if m:
        return m.group(1), t
    return None, (t or None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="erp")
    ap.add_argument("--socket", default="/run/mysqld/mysqld.sock")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    con = pymysql.connect(unix_socket=a.socket, user="root", database=a.db, charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor)
    cur = con.cursor()
    q = lambda sql, *p: (cur.execute(sql, p), cur.fetchall())[1]

    company = q("select company_name, tax_id from tabCompany")
    if len(company) != 1:
        sys.exit("Ochekuvana e tocno edna firma vo ERPNext.")
    c_edb, _ = tax_id(company[0]["tax_id"])

    links = {}
    for r in q("select parent, parenttype, link_doctype, link_name from `tabDynamic Link` where parenttype in ('Address','Contact')"):
        links.setdefault((r["link_doctype"], r["link_name"]), []).append((r["parenttype"], r["parent"]))
    addr = {r["name"]: r for r in q("select * from tabAddress where disabled=0")}
    cont = {r["name"]: r for r in q("select * from tabContact")}
    banks = {}
    for r in q("select party_type, party, bank_account_no from `tabBank Account` where is_company_account=0 and coalesce(disabled,0)=0"):
        d = re.sub(r"\D", "", r["bank_account_no"] or "")
        if len(d) == 15:
            banks.setdefault((r["party_type"], r["party"]), set()).add(d)

    partners, by_key, warnings = [], {}, []
    rows = [("Customer", r) for r in q("select name, customer_name nm, tax_id, customer_primary_address pa, customer_primary_contact pc, email_id, mobile_no, disabled from tabCustomer")]
    rows += [("Supplier", r) for r in q("select name, supplier_name nm, tax_id, supplier_primary_address pa, supplier_primary_contact pc, email_id, mobile_no, disabled from tabSupplier")]
    for kind, r in rows:
        edb, vat = tax_id(r["tax_id"])
        if edb == c_edb:
            continue  # nashata firma
        key = edb or ("name", re.sub(r"\s+", " ", r["nm"].strip().upper()))
        p = by_key.get(key)
        if not p:
            p = {"ref": f"{kind}:{r['name']}", "name": re.sub(r"\s+", " ", r["nm"].strip()), "edb": edb, "vatNumber": vat, "country": "MK",
                 "address": None, "city": None, "postalCode": None, "email": None, "phone": None, "isCustomer": False, "isSupplier": False,
                 "isActive": not r["disabled"], "accounts": [], "contacts": []}
            by_key[key] = p
            partners.append(p)
        elif kind == p["ref"].split(":")[0]:
            # ist EDB na dva razlicni kupuvaci (ili dobavuvaci) = greshka vo ERPNext: vtoriot ne se vnesuva
            warnings.append(f"Ист ЕДБ {edb}: „{p['name']}“ и „{r['nm']}“. Се внесува само првиот; вториот провери го рачно.")
            continue
        p["isCustomer" if kind == "Customer" else "isSupplier"] = True
        if not r["disabled"]:
            p["isActive"] = True
        p["vatNumber"] = p["vatNumber"] or vat
        # adresa: primarna, inaku prva za fakturiranje, inaku bilo koja
        cands = [addr[n] for t, n in links.get((kind, r["name"]), []) if t == "Address" and n in addr]
        pick = addr.get(r["pa"]) or next((x for x in cands if x.get("is_primary_address")), None) \
            or next((x for x in cands if x["address_type"] == "Billing"), None) or (cands[0] if cands else None)
        if pick and not p["address"]:
            p["address"] = ", ".join(x.strip() for x in [pick["address_line1"], pick.get("address_line2")] if x and x.strip())
            p["city"] = (pick["city"] or "").strip() or None
            p["postalCode"] = re.sub(r"\D", "", pick.get("pincode") or "")[:10] or None
            cc = COUNTRY.get(pick["country"] or "Macedonia")
            if not cc:
                warnings.append(f"{p['name']}: непозната држава „{pick['country']}“ → MK.")
            p["country"] = cc or "MK"
            p["email"] = p["email"] or (pick.get("email_id") or None)
            p["phone"] = p["phone"] or (pick.get("phone") or None)
        p["email"] = p["email"] or (r["email_id"] or None)
        p["phone"] = p["phone"] or (r["mobile_no"] or None)
        for acc in sorted(banks.get((kind, r["name"]), [])):
            if acc not in p["accounts"]:
                p["accounts"].append(acc)
        for t, n in links.get((kind, r["name"]), []):
            if t != "Contact" or n not in cont:
                continue
            c = cont[n]
            name = " ".join(x.strip() for x in [c.get("first_name"), c.get("last_name")] if x and x.strip()) or (c.get("email_id") or "").strip()
            if not name or any(x["name"] == name for x in p["contacts"]):
                continue
            p["contacts"].append({"name": name[:200], "role": (c.get("designation") or None), "phone": c.get("phone") or None,
                                  "mobile": c.get("mobile_no") or None, "email": c.get("email_id") or None, "isPrimary": n == r["pc"]})
    for p in partners:
        if p["edb"] is None and p["country"] == "MK":
            warnings.append(f"{p['name']}: нема ЕДБ.")

    vat = {r["parent"]: r["t"] for r in q("select parent, max(item_tax_template) t from `tabItem Tax` where parenttype='Item' group by parent")}
    rate = {r["parent"]: float(r["tax_rate"]) for r in q("select parent, tax_rate from `tabItem Tax Template Detail`")}
    price = {r["item_code"]: float(r["price_list_rate"]) for r in q(
        "select item_code, price_list_rate from `tabItem Price` where price_list='Standard Selling' and currency='MKD' order by valid_from")}
    items, codes = [], set()
    for r in q("select name, item_code, item_name, is_stock_item, stock_uom, disabled from tabItem where has_variants=0 order by item_code"):
        code = r["item_code"].strip()
        if len(code) > 30:
            code = code[:25].rstrip() + "-" + hashlib.sha1(code.encode()).hexdigest()[:4].upper()
        if code.upper() in codes:
            sys.exit(f"Двојна шифра по скратување: {code}")
        codes.add(code.upper())
        unit = UNIT.get(r["stock_uom"], (r["stock_uom"] or "ком")[:10].lower())
        items.append({"ref": r["name"], "code": code, "name": re.sub(r"\s+", " ", (r["item_name"] or r["item_code"]).strip()),
                      "type": "goods" if r["is_stock_item"] else "service", "unit": unit,
                      "vatPct": rate.get(vat.get(r["name"]), 18.0), "price": price.get(r["item_code"]), "isActive": not r["disabled"]})

    out = {"format": "erpnext-masterdata/1", "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "company": {"name": company[0]["company_name"], "edb": c_edb}, "partners": partners, "items": items, "warnings": warnings}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"{a.out}: {len(partners)} партнери ({sum(p['isCustomer'] for p in partners)} купувачи, {sum(p['isSupplier'] for p in partners)} добавувачи), "
          f"{sum(len(p['accounts']) for p in partners)} сметки, {sum(len(p['contacts']) for p in partners)} контакти, "
          f"{len(items)} артикли ({sum(i['price'] is not None for i in items)} со цена).")
    for w in warnings:
        print("  !", w)


if __name__ == "__main__":
    main()
