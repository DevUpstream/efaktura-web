/** Grешkite od proverkata (zod) -> jasna poraka na makedonski, so pole i stavka ("Ставка 2: опис"). */
import type { ZodIssue } from "zod";

const FIELD: Record<string, string> = {
  partnerId: "купувач / партнер", issueDate: "датум на издавање", supplyDate: "датум на промет", dueDate: "рок за плаќање",
  paymentMethod: "начин на плаќање", docType: "вид на документ", lines: "ставки", description: "опис", unit: "единечна мерка", qty: "количина",
  unitPrice: "цена", discountPct: "попуст", vatRateId: "ДДВ стапка", itemId: "артикл", advanceAmount: "износ на аванс", advanceInvoiceId: "авансна фактура",
  warehouseId: "магацин", name: "назив", edb: "ЕДБ", email: "е-пошта", code: "шифра", amount: "износ", payDate: "датум", reason: "причина",
  supplierNumber: "број кај добавувачот", receivedDate: "датум на прием", docDate: "датум", productItemId: "производ", account: "жиро-сметка",
};

function fieldOf(path: (string | number)[]) {
  const i = path.findIndex((p) => typeof p === "number");
  const last = [...path].reverse().find((p) => typeof p === "string") as string | undefined;
  const label = last ? FIELD[last] ?? last : "податок";
  return i > 0 && path[i - 1] === "lines" ? `Ставка ${(path[i] as number) + 1}: ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
}

function what(issue: ZodIssue) {
  switch (issue.code) {
    case "invalid_type": return issue.received === "undefined" || issue.received === "null" ? "задолжително" : "не е во добар облик";
    case "too_small": return issue.type === "string" ? "задолжително" : issue.type === "array" ? "додајте барем една" : issue.type === "number"
      ? (Number(issue.minimum) === 0 && !issue.inclusive ? "изберете / внесете вредност поголема од 0" : `најмалку ${issue.minimum}`) : "премалку";
    case "too_big": return issue.type === "string" ? `најмногу ${issue.maximum} знаци` : `најмногу ${issue.maximum}`;
    case "invalid_string": return "не е во добар облик";
    case "invalid_enum_value": return "непозната вредност";
    default: return issue.message && !/^(Required|Invalid|Expected|Number must)/.test(issue.message) ? issue.message : "не е исправно";
  }
}

export function zodMessage(issues: ZodIssue[]) {
  const parts = [...new Set(issues.slice(0, 6).map((i) => `${fieldOf(i.path)}: ${what(i)}`))];
  return parts.length ? `Проверете: ${parts.join("; ")}.` : "Неисправни податоци.";
}
