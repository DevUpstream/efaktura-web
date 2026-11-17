"""Izvodi Stopanska (PDF, pdftotext -layout) -> lista izvodi so stavki. Proverka: pocetna + priliv - odliv = nova."""
import re, subprocess, sys, json
from decimal import Decimal as D
def amt(s): return D(s.replace(".", "").replace(",", "."))
def parse(path):
    txt = subprocess.run(["pdftotext", "-layout", path, "-"], capture_output=True, text=True).stdout
    out, cur, row = [], None, None
    for ln in txt.split("\n"):
        m = re.search(r"Број на извод:\s*(\d+)", ln)
        if m:
            cur = dict(no=m.group(1), lines=[]); out.append(cur); row = None; continue
        m = re.search(r"за:\s*(\d\d)/(\d\d)/(\d{4})", ln)
        if m and cur is not None and "date" not in cur: cur["date"] = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        m = re.search(r"Број на сметка\s*:\s*(\d{15})", ln)
        if m and cur is not None: cur["account"] = m.group(1)
        for k, lab in (("opening", "Почетна состојба"), ("debit", "Долгува"), ("credit", "Побарува"), ("closing", "Нова состојба")):
            m = re.match(rf"\s+{lab}\s+([\d.]+,\d\d)", ln)
            if m and cur is not None: cur[k] = str(amt(m.group(1))); row = None
        m = re.match(r"^\s*(\d+)\.\s+(.*?)\s{2,}(\d)\s+([\d.]+,\d\d)\s+([\d.]+,\d\d)\s+(\d{3})\s+(.*)$", ln)
        if m and cur is not None:
            no, name, way, dr, cr, code, rest = m.groups()
            row = dict(lineNo=int(no), nameParts=[name.strip()], debit=str(amt(dr)), credit=str(amt(cr)), code=code, first=rest, cont=[])
            cur["lines"].append(row); continue
        if row is not None and ln.strip():
            row["cont"].append(ln)
    for st in out:
        for r in st["lines"]:
            allt = " ".join([r["first"]] + r["cont"])
            acc = re.findall(r"(?<!\d)(\d{15})(?!\d)", " ".join(r["cont"]))
            r["account"] = acc[0] if acc else ""
            tx = re.findall(r"\b(FT\d{10,}|N\d+\.INT\.\d\.\d+)\b", allt)
            r["txId"] = tx[0] if tx else ""
            # ime: levata kolona od prodolzenijata (do 22 znaci), bez smetkata
            for c in r["cont"]:
                left = c[:22].strip()
                if left and not re.fullmatch(r"\d{15}", left) and not re.fullmatch(r"\d+", left): r["nameParts"].append(left)
            r["name"] = re.sub(r"\s+", " ", " ".join(r["nameParts"])).strip()
            text = re.sub(r"\s+", " ", " ".join([r["first"]] + [c[22:] for c in r["cont"]])).strip()
            text = re.sub(r"\b(FT\d{10,}|N\d+\.INT\.\d\.\d+|\d{10})\b", "", text)
            r["purpose"] = re.sub(r"\s+", " ", text).strip()[:300]
            for k in ("nameParts", "first", "cont"): del r[k]
        dr = sum(D(r["debit"]) for r in st["lines"]); cr = sum(D(r["credit"]) for r in st["lines"])
        st["check"] = str(D(st["opening"]) + cr - dr - D(st["closing"]))
        assert dr == D(st["debit"]) and cr == D(st["credit"]) and st["check"] == "0.00", (st["no"], dr, cr, st)
    return out
if __name__ == "__main__":
    res = []
    for p in sys.argv[1:]: res += parse(p)
    prev = None
    for st in res:
        if prev is not None: assert prev == st["opening"], ("kontinuitet", st["no"])
        prev = st["closing"]
    json.dump(res, sys.stdout, ensure_ascii=False, indent=1)
