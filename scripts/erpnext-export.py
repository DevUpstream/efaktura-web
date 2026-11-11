#!/usr/bin/env python3
"""
Izvoz na shifrarnici od ERPNext (Next ERP) vo JSON za api/src/tools/import-erpnext.ts (docs/11).

  1. Bekapot (*-database.sql.gz) se vcituva vo LOKALEN MariaDB (nikogash na serverot na aplikacijata):
       mysql -e "create database erp character set utf8mb4"; zcat <bekap>-database.sql.gz | mysql erp
  2. python3 scripts/erpnext-export.py --db erp --out upstream-erpnext.json
  3. (vlezni fakturi, docs/11) python3 scripts/erpnext-export.py --db erp --out upstream-erpnext.json \
       --purchases upstream-purchases.json --files-from <raspakuvan private-files.tar>/upstream/private/files --files-prefix upstream-files
     -> upstream-purchases.json + upstream-files-1.json, -2.json ... (prilozi, do ~15 MB po datoteka)

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
    ap.add_argument("--purchases")
    ap.add_argument("--files-from")
    ap.add_argument("--files-prefix")
    ap.add_argument("--no-payments", action="store_true", help="bez plakjanja (gi zatvoraat izvodite)")
    ap.add_argument("--sales", help="izlezni fakturi (podneseni) -> JSON")
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
    items, codes, code_of = [], set(), {}
    for r in q("select name, item_code, item_name, is_stock_item, stock_uom, disabled from tabItem where has_variants=0 order by item_code"):
        code = r["item_code"].strip()
        if len(code) > 30:
            code = code[:25].rstrip() + "-" + hashlib.sha1(code.encode()).hexdigest()[:4].upper()
        if code.upper() in codes:
            sys.exit(f"Двојна шифра по скратување: {code}")
        codes.add(code.upper())
        code_of[r["name"]] = code
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
    if a.purchases:
        export_purchases(q, a, code_of, c_edb)
    if a.sales:
        export_sales(q, a, code_of, c_edb)


def export_sales(q, a, code_of, c_edb):
    """Izlezni fakturi: samo podneseni (docstatus=1). Storniranite (docstatus=2) ne vazat -> samo se navedeni vo izveshtajot."""
    cus = {r["name"]: r for r in q("select name, customer_name, tax_id from tabCustomer")}
    taxes = {r["parent"]: json.loads(r["item_wise_tax_detail"] or "{}") for r in q(
        "select parent, item_wise_tax_detail from `tabSales Taxes and Charges` where parenttype='Sales Invoice'")}
    lines = {}
    for r in q("select parent, idx, item_code, item_name, qty, uom, price_list_rate, discount_percentage, rate, net_amount from `tabSales Invoice Item` order by parent, idx"):
        lines.setdefault(r["parent"], []).append(r)
    out, warn = [], []
    for p in q("select * from `tabSales Invoice` where docstatus=1 order by posting_date, name"):
        if p["currency"] != "MKD" or p["is_return"]:
            sys.exit(f"{p['name']}: девизна или поврат – не е поддржано.")
        c = cus[p["customer"]]
        edb, _ = tax_id(c["tax_id"])
        ls = []
        for l in lines[p["name"]]:
            rate = taxes.get(p["name"], {}).get(l["item_code"], [None])[0]
            if rate is None:
                sys.exit(f"{p['name']}: нема ДДВ стапка за {l['item_code']}")
            qty, net = float(l["qty"]), float(l["net_amount"])
            plr, disc = float(l["price_list_rate"] or 0), float(l["discount_percentage"] or 0)
            # popust kako vo ERPNext ako dava ist iznos; inaku neto cena bez popust
            unet = plr - round(plr * disc / 100, 4)
            if not (disc > 0 and plr > 0 and abs(round(qty * unet, 4) - net) < 0.005):
                plr, disc = float(l["rate"]), 0.0
                if abs(round(qty * plr, 4) - net) >= 0.005:
                    # cena so vklucen DDV (included_in_print_rate): neto cena = neto iznos / kolicina
                    plr = round(net / qty, 4)
                    if abs(round(qty * plr, 2) - round(net, 2)) >= 0.005:
                        warn.append(f"{p['name']} ставка {l['idx']}: {qty} × {plr} ≠ {net}")
            ls.append({"itemCode": code_of.get(l["item_code"]), "description": re.sub(r"\s+", " ", (l["item_name"] or l["item_code"]).strip()),
                       "unit": UNIT.get(l["uom"], (l["uom"] or "ком")[:10].lower()), "qty": qty, "unitPrice": plr, "discountPct": disc,
                       "net": net, "vatPct": float(rate)})
        out.append({"ref": p["name"], "customerRef": p["customer"], "customerEdb": edb, "customerName": c["customer_name"].strip(),
                    "issueDate": str(p["posting_date"]), "dueDate": str(p["due_date"]) if p["due_date"] else None,
                    "net": float(p["net_total"]), "vat": float(p["total_taxes_and_charges"]), "gross": float(p["grand_total"]),
                    "payable": float(p["rounded_total"] or p["grand_total"]), "lines": ls})
    cancelled = [r["name"] for r in q("select name from `tabSales Invoice` where docstatus=2 order by name")]
    doc = {"format": "erpnext-sales/1", "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "company": {"edb": c_edb}, "invoices": out, "cancelled": cancelled}
    with open(a.sales, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    print(f"{a.sales}: {len(out)} излезни фактури ({sum(len(x['lines']) for x in out)} ставки); сторнирани во ERPNext (не се внесуваат): {len(cancelled)}.")
    for w in warn:
        print("  !", w)


def export_purchases(q, a, code_of, c_edb):
    """Vlezni fakturi (samo podneseni, bez storniranite), plakjanja kon niv i prilozi."""
    sup = {r["name"]: r for r in q("select name, supplier_name, tax_id from tabSupplier")}
    taxes = {r["parent"]: json.loads(r["item_wise_tax_detail"] or "{}") for r in q(
        "select parent, item_wise_tax_detail from `tabPurchase Taxes and Charges` where parenttype='Purchase Invoice'")}
    lines = {}
    for r in q("select parent, idx, item_code, item_name, qty, uom, rate, net_amount from `tabPurchase Invoice Item` order by parent, idx"):
        lines.setdefault(r["parent"], []).append(r)
    out, files = [], []
    for p in q("select * from `tabPurchase Invoice` where docstatus=1 order by posting_date, name"):
        s_ = sup[p["supplier"]]
        edb, _ = tax_id(s_["tax_id"])
        ls = []
        for l in lines[p["name"]]:
            rate = taxes.get(p["name"], {}).get(l["item_code"], [None])[0]
            if rate is None and p["name"] not in taxes and not float(p["total_taxes_and_charges"] or 0):
                rate = 0.0  # bez DDV red i bez DDV = dobavuvacot ne e DDV obvrznik
            if rate is None:
                sys.exit(f"{p['name']}: нема ДДВ стапка за {l['item_code']}")
            ls.append({"itemCode": code_of.get(l["item_code"]), "description": re.sub(r"\s+", " ", (l["item_name"] or l["item_code"]).strip()),
                       "unit": UNIT.get(l["uom"], (l["uom"] or "ком")[:10].lower()), "qty": float(l["qty"]), "unitPrice": float(l["rate"]),
                       "net": float(l["net_amount"]), "vatPct": float(rate)})
        note = None
        if any(l["net"] < 0 or l["unitPrice"] < 0 for l in ls):
            note = "ЗА ПРОВЕРКА: во ERPNext фактурата има негативни ставки (кредит од добавувачот); внесена е како збирна ставка по ДДВ стапка. Оригинални ставки: " + "; ".join(
                f"{l['description']} {l['qty']:g} × {l['unitPrice']:.2f} = {l['net']:.2f} ({l['vatPct']:g}%)" for l in ls)
            # negativni stavki (kredit od dobavuvacot): aplikacijata nema negativni ceni -> zbirna stavka po DDV stapka
            by = {}
            for l in ls:
                by[l["vatPct"]] = by.get(l["vatPct"], 0) + l["net"]
            ls = [{"itemCode": None, "description": f"Збирна ставка по ERPNext {p['name']} (вклучени кредити од добавувачот)", "unit": "ком",
                   "qty": 1.0, "unitPrice": round(n, 4), "net": round(n, 4), "vatPct": v} for v, n in by.items()]
        out.append({"ref": p["name"], "supplierRef": p["supplier"], "supplierEdb": edb, "supplierName": s_["supplier_name"].strip(),
                    "supplierNumber": (p["bill_no"] or "").strip() or p["name"], "issueDate": str(p["bill_date"] or p["posting_date"]),
                    "receivedDate": str(p["posting_date"]), "dueDate": str(p["due_date"]) if p["due_date"] else None,
                    "net": float(p["net_total"]), "vat": float(p["total_taxes_and_charges"]), "gross": float(p["grand_total"]),
                    "payable": float(p["rounded_total"] or p["grand_total"]), "note": note, "lines": ls})
        if a.files_from:
            for f in q("select name, file_name, file_url from tabFile where attached_to_doctype='Purchase Invoice' and attached_to_name=%s", p["name"]):
                files.append((p["name"], f))
    refs = {x["ref"] for x in out}
    pays = []
    for e in ([] if a.no_payments else q("select * from `tabPayment Entry` where docstatus=1 and payment_type='Pay' and party_type='Supplier' order by posting_date, name")):
        al = [{"ref": r["reference_name"], "amount": float(r["allocated_amount"])} for r in q(
            "select reference_name, allocated_amount from `tabPayment Entry Reference` where parent=%s and reference_doctype='Purchase Invoice'", e["name"])
            if r["reference_name"] in refs]
        pays.append({"ref": e["name"], "supplierRef": e["party"], "date": str(e["posting_date"]), "amount": float(e["paid_amount"]),
                     "reference": (e["reference_no"] or "").strip() or None, "allocations": al})
    doc = {"format": "erpnext-purchases/1", "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "company": {"edb": c_edb}, "purchases": out, "payments": pays}
    with open(a.purchases, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=1)
    print(f"{a.purchases}: {len(out)} влезни фактури ({sum(len(x['lines']) for x in out)} ставки), {len(pays)} плаќања.")
    if a.files_from and a.files_prefix:
        import base64, os
        chunk, size, n, missing = [], 0, 0, []
        def flush():
            nonlocal chunk, size, n
            if not chunk:
                return
            n += 1
            with open(f"{a.files_prefix}-{n}.json", "w", encoding="utf-8") as fh:
                json.dump({"format": "erpnext-files/1", "company": {"edb": c_edb}, "files": chunk}, fh, ensure_ascii=False)
            print(f"  {a.files_prefix}-{n}.json: {len(chunk)} прилози, {size / 1048576:.1f} MB")
            chunk, size = [], 0
        for ref, f in files:
            path = os.path.join(a.files_from, os.path.basename(f["file_url"] or ""))
            if not os.path.isfile(path):
                missing.append(f"{ref}: {f['file_name']}")
                continue
            data = open(path, "rb").read()
            if size + len(data) > 15 * 1048576:
                flush()
            chunk.append({"purchaseRef": ref, "fileName": f["file_name"], "data": base64.b64encode(data).decode()})
            size += len(data)
        flush()
        for m in missing:
            print("  ! нема датотека:", m)


if __name__ == "__main__":
    main()
