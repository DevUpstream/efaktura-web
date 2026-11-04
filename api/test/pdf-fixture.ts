
import { renderInvoicePdf } from "../src/domain/pdf.js";
import { calcLine } from "../src/domain/calc.js";
const mk = (lineNo: number, itemId: number, description: string, unit: string, qty: number, price: string, vat: number) => {
  const r = calcLine({ qty, unitPrice: price, vatRatePct: vat });
  return { id: lineNo, legacySpId: null, invoiceId: 1, lineNo, itemId, description, unit, qty: String(qty), unitPrice: price,
    discountPct: "0", vatRateId: 1, vatRatePct: String(vat), netAmount: r.netAmount, vatAmount: r.vatAmount, priceSource: null } as any;
};
const client: any = { name: "УПСТРЕАМ Д.О.О.Е.Л. УВОЗ-ИЗВОЗ КРИВА ПАЛАНКА", edb: "4015023508550", embs: "7696531", vatNumber: "MK4015023508550",
  address: "СВ.ЈОАКИМ ОСОГОВСКИ 69/9", city: "КРИВА ПАЛАНКА", postalCode: "1330", iban: null, bankName: null,
  invoiceClauses: "За ненавремено плаќање пресметуваме законска казнена камата.\nСогласно Законот за финансиска дисциплина, Доверителот има право на надомест за доцнење при исполнување на првичната обврска во износ од 3000ден доколку првичната обврска не е исполнета во договорените рокови.\nВо случај на девалвација, Ве задолжуваме за процентот на девалвација.\nВо случај на промена на курсот на странската валута ЕУР според НБРСМ, за повеќе од 1% споредено со денот на издавање на фактурата, го задржуваме правото на корекција на фактурата според новиот курс при што ќе Ви се издаде книжно задолжување за курсната разлика на неплатениот износ од фактурата.\nРекламации по основ на оваа фактура се примаат во рок од 5 дена од нејзино издавање.\nЗа спорови по основ на оваа фактура надлежен е Основен суд Скопје 2.",
  pdfSettings: { shortName: "УПСТРЕАМ ДООЕЛ", tagline: "Друштво за производство, трговија и услуги", subtitle: "увоз-извоз Крива Паланка",
    contactLine: "upstream.mk | contact@upstream.mk | +389.70.369.969",
    addressLines: ["ул. Св. Јоаким Осоговски бр. 69/9, 1330 Крива Паланка, Р. С. МАКЕДОНИЈА", "**ул. Ринхини бр. 4а, 1060 Скопје, Р. С. МАКЕДОНИЈА**"],
    bankAccounts: [{ account: "210076965310159", bank: "НЛБ Банка АД Скопје" }, { account: "200004115053690", bank: "Стопанска Банка АД Скопје" }],
    invoiceTitle: "Фактура-Испратница", signatory: "Горан Цветковски", paymentNote: "Рок на плаќање: Најдоцна до наведениот рок за плаќање.",
    clausesTitle: "УПСТРЕАМ ДООЕЛ го задржува правото да направи измена на износот на фактурата во следните случаи:",
    receiverDeclaration: "Јас горепотпишаниот, под морална одговорност, изјавувам дека ги превземав производите наведени во оваа фактура нови, неоштетени и во видена исправна состојба.",
    showReceivedBy: true } };
const inv: any = { docType: "INV", number: "UPSTRI-2026-00001", issueDate: "2026-10-30", supplyDate: "2026-10-30", dueDate: "2026-11-14",
  buyerName: "ДЕЛИШЕС КОМЕРЦ увоз извоз ДООЕЛ", buyerAddress: "с.Дрмени", buyerCity: "Ресен", buyerCountry: "MK", buyerEdb: "4024016505642",
  buyerVatNumber: null, advanceAmount: null, clauses: null, note: null, ujpQrLink: null };
const lines = [mk(1, 1, "BROTHER Label printer TD4520TN 300dpi", "парче", 1, "23809.52", 5), mk(2, 2, "Самолеплива етикета 50x70 ДТ", "парче", 40000, "0.41", 18)];
export { mk, client, inv, lines };
