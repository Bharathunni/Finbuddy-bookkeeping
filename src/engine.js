/* =========================================================================
   FinBuddy engine: pure functions only (no React, no Capacitor), so every
   rule that decides a number can be unit-tested. App.jsx renders; this computes.
   ========================================================================= */

export const CASHBANK = new Set(["cash", "bank", "bankod", "card"]); // ledgers that behave like money accounts
export const STATEMENT_GROUPS = new Set(["bank", "bankod", "card"]); // ledgers a bank / card statement can be imported into

/* ---------- money / format ---------- */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export function inr(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  const neg = n < 0; let x = Math.abs(Number(n));
  const p = x.toFixed(2).split("."); let i = p[0];
  let last3 = i.slice(-3); let rest = i.slice(0, -3);
  if (rest) last3 = "," + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (neg ? "-" : "") + rest + last3 + "." + p[1];
}
export const uid = () => Math.random().toString(36).slice(2, 9);

/* ---------- dates (all YYYY-MM-DD strings in the device's local time) ---------- */
const pad2 = (n) => String(n).padStart(2, "0");
// Local calendar date. toISOString() is UTC, which in India is "yesterday" until 05:30.
export function todayStr(now = new Date()) { return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`; }
export function localStamp(now = new Date()) { return `${todayStr(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`; }
export function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
export function addDays(s, n) { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
// Indian financial year: April to March.
export function fyStartFor(date) { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)); return `${m >= 4 ? y : y - 1}-04-01`; }
export function fyEndFor(fyStart) { return `${Number(fyStart.slice(0, 4)) + 1}-03-31`; }
export function fyLabel(fyStart) { const y = Number(fyStart.slice(0, 4)); return `${y}-${String(y + 1).slice(2)}`; }

/* ---------- seed masters (standard Indian chart of accounts) ---------- */
export function seedGroups() {
  const g = (id, name, nature, pl, parent) => ({ id, name, nature, pl: pl || null, parent: parent || null });
  return [
    g("cap", "Capital Account", "Liability"), g("res", "Reserves & Surplus", "Liability", null, "cap"),
    g("ca", "Current Assets", "Asset"), g("bank", "Bank Accounts", "Asset", null, "ca"),
    g("cash", "Cash-in-hand", "Asset", null, "ca"), g("dep", "Deposits (Asset)", "Asset", null, "ca"),
    g("loanadv", "Loans & Advances (Asset)", "Asset", null, "ca"), g("stock", "Stock-in-hand", "Asset", null, "ca"),
    g("debtors", "Sundry Debtors", "Asset", null, "ca"), g("cl", "Current Liabilities", "Liability"),
    g("tax", "Duties & Taxes", "Liability", null, "cl"), g("prov", "Provisions", "Liability", null, "cl"),
    g("creditors", "Sundry Creditors", "Liability", null, "cl"), g("card", "Credit Cards", "Liability", null, "cl"),
    g("fa", "Fixed Assets", "Asset"),
    g("inv", "Investments", "Asset"), g("loanliab", "Loans (Liability)", "Liability"),
    g("bankod", "Bank OD A/c", "Liability", null, "loanliab"), g("secured", "Secured Loans", "Liability", null, "loanliab"),
    g("unsecured", "Unsecured Loans", "Liability", null, "loanliab"), g("suspense", "Suspense A/c", "Liability"),
    g("miscexp", "Misc. Expenses (Asset)", "Asset"),
    g("sales", "Sales Accounts", "Income", "Trading"), g("purchase", "Purchase Accounts", "Expense", "Trading"),
    g("dinc", "Direct Incomes", "Income", "Trading"), g("dexp", "Direct Expenses", "Expense", "Trading"),
    g("iinc", "Indirect Incomes", "Income", "PL"), g("iexp", "Indirect Expenses", "Expense", "PL"),
  ];
}
export function seedLedgers() {
  const l = (name, group, ob = 0, drcr = "Dr") => ({ id: uid(), name, group, ob, drcr });
  return [
    l("Cash", "cash"), l("HDFC Bank", "bank"), l("Capital A/c", "cap", 0, "Cr"),
    l("Sales", "sales"), l("Purchases", "purchase"), l("Bank Charges", "iexp"),
    l("Salaries", "iexp"), l("Rent", "iexp"), l("Professional Fees", "iinc"),
    l("Interest Received", "iinc"), l("Sundry Debtors (control)", "debtors"), l("Sundry Creditors (control)", "creditors"),
  ];
}
export function seedDb(today = todayStr()) {
  const fyStart = fyStartFor(today);
  return {
    v: 3,
    company: { name: "My Company", fyStart, booksFrom: fyStart, lockDate: "", features: { gst: false } },
    groups: seedGroups(), ledgers: seedLedgers(), vouchers: [], rules: [], audit: [],
  };
}

/* ---------- schema: validate untrusted input, then fill defaults ---------- */
// Returns an error message, or "" when the object is safe to load as books.
export function backupError(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "Not a FinBuddy backup";
  if (!Array.isArray(d.groups) || !Array.isArray(d.ledgers)) return "Backup has no groups / ledgers";
  for (const k of ["vouchers", "rules", "audit"]) if (d[k] !== undefined && !Array.isArray(d[k])) return `Backup "${k}" is not a list`;
  if (d.company !== undefined && (typeof d.company !== "object" || d.company === null)) return "Backup company details are invalid";
  for (const l of d.ledgers) if (!l || typeof l.id !== "string" || typeof l.name !== "string") return "Backup has a ledger without id / name";
  for (const v of d.vouchers || []) {
    if (!v || !Array.isArray(v.entries) || typeof v.date !== "string") return "Backup has a voucher without date / entries";
  }
  return "";
}
export function migrate(db) {
  const base = seedDb();
  db.company = { ...base.company, ...(db.company || {}) };
  if (!db.company.features) db.company.features = { gst: false };
  if (db.company.lockDate === undefined || db.company.lockDate === null) db.company.lockDate = "";
  for (const k of ["vouchers", "rules", "audit"]) if (!Array.isArray(db[k])) db[k] = [];
  // v3: Credit Cards group, so card statements can be imported and card dues show as a liability.
  if (!db.groups.some((g) => g.id === "card")) {
    const card = base.groups.find((g) => g.id === "card");
    const at = db.groups.findIndex((g) => g.id === "creditors");
    db.groups = at >= 0 ? [...db.groups.slice(0, at + 1), card, ...db.groups.slice(at + 1)] : [...db.groups, card];
  }
  db.v = 3;
  return db;
}

/* ---------- ENGINE (single pass, memoized) ---------- */
export function makeCalc(db) {
  const ledgerById = new Map(db.ledgers.map((l) => [l.id, l]));
  const groupById = new Map(db.groups.map((g) => [g.id, g]));
  const byLed = {};
  db.ledgers.forEach((l) => (byLed[l.id] = []));
  db.vouchers.forEach((v) => v.entries.forEach((e) => {
    if (byLed[e.ledger]) byLed[e.ledger].push({ date: v.date, dr: Number(e.dr) || 0, cr: Number(e.cr) || 0 });
  }));
  const opening = (id) => { const l = ledgerById.get(id); return l ? (l.drcr === "Cr" ? -1 : 1) * round2(Number(l.ob) || 0) : 0; };
  const closing = (id, to) => { let s = opening(id); for (const e of byLed[id] || []) if (!to || e.date <= to) s += e.dr - e.cr; return round2(s); };
  const movement = (id, from, to) => { let s = 0; for (const e of byLed[id] || []) if ((!from || e.date >= from) && (!to || e.date <= to)) s += e.dr - e.cr; return round2(s); };
  const openingImbalance = round2(db.ledgers.reduce((s, l) => s + opening(l.id), 0)); // should be 0
  const isPL = (id) => !!groupById.get(ledgerById.get(id)?.group)?.pl;
  return { byLed, ledgerById, groupById, opening, closing, movement, openingImbalance, isPL };
}
// Opening balances on income / expense ledgers are figures earned or spent before books
// beginning (e.g. switching over mid-year). They are treated as dated on the books-beginning
// date, so they count in exactly one financial year.
function plOpeningIn(db, from, to) {
  const b = db.company.booksFrom || "";
  return (!from || (!!b && from <= b)) && (!to || !b || to >= b);
}
export function computePL(db, calc, from, to) {
  const lines = { tradeDr: [], tradeCr: [], indDr: [], indCr: [] };
  let tradeDr = 0, tradeCr = 0, indDr = 0, indCr = 0;
  const withOpening = plOpeningIn(db, from, to);
  for (const l of db.ledgers) {
    const g = calc.groupById.get(l.group); if (!g || !g.pl) continue;
    const mv = round2(calc.movement(l.id, from, to) + (withOpening ? calc.opening(l.id) : 0));
    if (Math.abs(mv) < 0.005) continue;
    if (g.pl === "Trading") {
      if (g.nature === "Expense") { tradeDr = round2(tradeDr + mv); lines.tradeDr.push({ name: l.name, v: mv }); }
      else { tradeCr = round2(tradeCr - mv); lines.tradeCr.push({ name: l.name, v: -mv }); }
    } else {
      if (g.nature === "Expense") { indDr = round2(indDr + mv); lines.indDr.push({ name: l.name, v: mv }); }
      else { indCr = round2(indCr - mv); lines.indCr.push({ name: l.name, v: -mv }); }
    }
  }
  const grossProfit = round2(tradeCr - tradeDr);
  const netProfit = round2(grossProfit + indCr - indDr);
  return { tradeDr, tradeCr, indDr, indCr, grossProfit, netProfit, lines };
}
// Cumulative net profit (books start .. to): used to make the Balance Sheet tie across years.
export function cumulativeProfit(db, calc, to) { return computePL(db, calc, null, to).netProfit; }

/* Trial Balance as at `to`. Income and expense ledgers show only the financial year that
   contains `to`; earlier years' result is carried as one "Profit & Loss A/c" line, the way
   books are closed at 31 March. */
export function trialBalance(db, calc, to) {
  const fy = fyStartFor(to);
  const rows = [];
  for (const l of db.ledgers) {
    const bal = calc.isPL(l.id)
      ? round2(calc.movement(l.id, fy, to) + (plOpeningIn(db, fy, to) ? calc.opening(l.id) : 0))
      : calc.closing(l.id, to);
    if (Math.abs(bal) > 0.005) rows.push({ id: l.id, name: l.name, group: calc.groupById.get(l.group)?.name || "", bal });
  }
  const bf = cumulativeProfit(db, calc, addDays(fy, -1));
  if (Math.abs(bf) > 0.005) rows.unshift({ id: "_pl_bf", name: "Profit & Loss A/c (b/f)", group: "Previous years' result", bal: -bf });
  const dr = round2(rows.filter((r) => r.bal > 0).reduce((s, r) => s + r.bal, 0));
  const cr = round2(rows.filter((r) => r.bal < 0).reduce((s, r) => s - r.bal, 0));
  return { rows, dr, cr, fy };
}
/* ---------- validation ---------- */
export function validateVoucher(db, type, date, entries, lockDate, booksFrom, today = todayStr()) {
  const warn = [], err = [];
  const grpOf = (id) => db.ledgers.find((l) => l.id === id)?.group;
  const amt = (e) => (Number(e.dr) || 0) > 0 || (Number(e.cr) || 0) > 0;
  const eff = entries.filter((e) => e.ledger && amt(e));
  const totalDr = round2(eff.reduce((s, e) => s + (Number(e.dr) || 0), 0));
  const totalCr = round2(eff.reduce((s, e) => s + (Number(e.cr) || 0), 0));
  if (!isValidDate(date)) err.push("Enter a valid date");
  if (entries.some((e) => !e.ledger && amt(e))) err.push("A line has an amount but no ledger");
  if (eff.length < 2) err.push("Need at least two ledger lines with amounts");
  if (Math.abs(totalDr - totalCr) > 0.005 || totalDr <= 0) err.push("Debit must equal Credit and be greater than zero");
  if (lockDate && date <= lockDate) err.push(`Period locked up to ${lockDate}: cannot post on/before this date`);
  const grps = eff.map((e) => grpOf(e.ledger));
  if (type === "Contra" && !grps.every((g) => CASHBANK.has(g))) err.push("Contra allows only Cash / Bank / Card ledgers");
  if ((type === "Payment" || type === "Receipt") && !grps.some((g) => CASHBANK.has(g))) warn.push(`${type} normally includes a Cash/Bank ledger`);
  if (type === "Journal" && grps.some((g) => CASHBANK.has(g))) warn.push("Journal normally excludes Cash/Bank (use Payment/Receipt/Contra)");
  if (type === "Sales" && !grps.includes("sales")) warn.push("Sales voucher normally credits a Sales-group ledger");
  if (type === "Purchase" && !grps.includes("purchase")) warn.push("Purchase voucher normally debits a Purchase-group ledger");
  if (booksFrom && date < booksFrom) warn.push(`Date is before books beginning (${booksFrom})`);
  if (date > today) warn.push("Date is in the future");
  return { warn, err, totalDr, totalCr, balanced: err.length === 0 };
}

/* ---------- bank / card statement parsing ---------- */
// Signed number. "(1,234.50)", "-1234.50" and "1,234.50 Dr" are negative; "Cr" and "₹" are ignored.
export function parseNum(s) {
  if (s == null) return 0;
  let t = String(s).replace(/[₹,\s]/g, "").replace(/^inr/i, "").trim();
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/dr\.?$/i.test(t)) { neg = true; t = t.replace(/dr\.?$/i, ""); }
  t = t.replace(/cr\.?$/i, "");
  const n = parseFloat(t);
  if (isNaN(n)) return 0;
  return round2(neg ? -Math.abs(n) : n);
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Returns YYYY-MM-DD, or "" when the text is not a real date. order: "dmy" (Indian) or "mdy".
export function normDate(s, order = "dmy") {
  if (s == null) return ""; s = String(s).trim();
  const y4 = (y) => (y.length === 2 ? "20" + y : y);
  const out = (y, mo, d) => { const r = `${y}-${pad2(mo)}-${pad2(d)}`; return isValidDate(r) ? r : ""; };
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/))) return out(m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/))) {
    const [a, b] = [+m[1], +m[2]];
    return order === "mdy" ? out(y4(m[3]), a, b) : out(y4(m[3]), b, a);
  }
  if ((m = s.match(/^(\d{1,2})[-/ ]?([A-Za-z]{3,9})\.?[-/ ,]*(\d{4}|\d{2})(?!\d)/))) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? out(y4(m[3]), mo, +m[1]) : "";
  }
  if ((m = s.match(/^([A-Za-z]{3,9})\.?[ -](\d{1,2}),?[ -](\d{4})(?!\d)/))) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return mo ? out(m[3], mo, +m[2]) : "";
  }
  return "";
}
// Decides DD/MM vs MM/DD from the data itself: any first part > 12 proves DD/MM, any second part > 12 proves MM/DD.
export function detectDateOrder(values) {
  let dmy = false, mdy = false;
  for (const v of values) {
    const m = String(v ?? "").trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/); if (!m) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  return mdy && !dmy ? "mdy" : "dmy";
}
export function autoMap(headers) {
  const h = headers.map((x) => String(x || "").toLowerCase().trim());
  const find = (...k) => h.findIndex((c) => k.some((x) => c.includes(x)));
  const findExact = (...k) => h.findIndex((c) => k.includes(c));
  const m = {
    date: find("txn date", "transaction date", "tran date", "value date", "date"),
    narr: find("narration", "description", "particular", "remark", "detail"),
    wd: find("withdrawal", "debit", "paid out", "dr amount"),
    dep: find("deposit", "credit", "paid in", "cr amount"),
    bal: find("balance"),
    amt: -1, type: -1,
  };
  // Single signed "Amount" column, optionally with a separate Dr/Cr indicator column (Axis, Kotak, card statements).
  if (m.wd < 0 && m.dep < 0) {
    m.amt = find("amount");
    m.type = findExact("dr/cr", "cr/dr", "dr / cr", "type", "debit/credit", "transaction type", "txn type");
  }
  return m;
}
const DIR_OUT = /^(dr|debit|d|withdrawal|w|paid out)\.?$/i, DIR_IN = /^(cr|credit|c|deposit|paid in)\.?$/i;
export function statementRows(rows, h, m, order = "dmy") {
  const out = [];
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || r.every((c) => !String(c ?? "").trim())) continue;
    let amount = 0, dir = "";
    if (m.wd >= 0 || m.dep >= 0) {
      const wd = m.wd >= 0 ? Math.abs(parseNum(r[m.wd])) : 0, dep = m.dep >= 0 ? Math.abs(parseNum(r[m.dep])) : 0;
      if (wd) { amount = wd; dir = "out"; } else if (dep) { amount = dep; dir = "in"; }
    } else if (m.amt >= 0) {
      const raw = String(r[m.amt] ?? ""); const n = parseNum(raw); const ind = m.type >= 0 ? String(r[m.type] ?? "").trim() : "";
      amount = Math.abs(n);
      if (DIR_OUT.test(ind)) dir = "out"; else if (DIR_IN.test(ind)) dir = "in";
      else if (/cr\.?\s*$/i.test(raw)) dir = "in";
      else dir = n < 0 ? "out" : "in";
    }
    if (!amount) continue;
    const rawDate = m.date >= 0 ? r[m.date] : "";
    out.push({
      row: i, date: normDate(rawDate, order), rawDate: String(rawDate ?? "").trim(),
      narr: m.narr >= 0 ? String(r[m.narr] ?? "").trim() : "",
      amount: round2(amount), dir, bal: m.bal >= 0 && String(r[m.bal] ?? "").trim() !== "" ? parseNum(r[m.bal]) : null,
    });
  }
  return out;
}
// Closing balance as per statement: the balance on the latest row, whichever way the file is sorted.
export function statementClosing(txns) {
  const withBal = txns.filter((t) => t.bal != null && t.date); if (!withBal.length) return null;
  const desc = withBal[0].date > withBal[withBal.length - 1].date;
  return desc ? withBal[0].bal : withBal[withBal.length - 1].bal;
}
// Opening balance as per statement: the earliest row's balance with that row's own movement taken back out.
export function statementOpening(txns) {
  const withBal = txns.filter((t) => t.bal != null && t.date); if (!withBal.length) return null;
  const desc = withBal[0].date > withBal[withBal.length - 1].date;
  const t = desc ? withBal[withBal.length - 1] : withBal[0];
  return round2(t.bal - (t.dir === "in" ? t.amount : -t.amount));
}
export function statementStart(txns) { return txns.reduce((m, t) => (t.date && (!m || t.date < m) ? t.date : m), ""); }
export function statementEnd(txns) { return txns.reduce((m, t) => (t.date && t.date > m ? t.date : m), ""); }

/* ---------- duplicate detection (exact match, counted) ---------- */
const dupKey = (ledger, date, amount, narr) => `${ledger}|${date}|${round2(amount)}|${(narr || "").trim().toLowerCase()}`;
// How many existing Payment / Receipt lines in the books carry each key.
export function bankDupCounts(db) {
  const groupOf = new Map(db.ledgers.map((l) => [l.id, l.group]));
  const counts = new Map();
  db.vouchers.forEach((v) => {
    if (v.type !== "Receipt" && v.type !== "Payment") return;
    v.entries.forEach((e) => {
      if (!CASHBANK.has(groupOf.get(e.ledger))) return;
      const k = dupKey(e.ledger, v.date, (Number(e.dr) || 0) + (Number(e.cr) || 0), v.narration);
      counts.set(k, (counts.get(k) || 0) + 1);
    });
  });
  return counts;
}
/* Ids of statement lines already in the books. Each booked voucher absorbs at most one
   statement line, so two identical lines with only one in the books leave one to post. */
export function findDuplicates(txns, counts, bankLedger) {
  const left = new Map(counts), dups = new Set();
  if (!bankLedger) return dups;
  for (const t of txns) {
    const k = dupKey(bankLedger, t.date, t.amount, t.narr); const n = left.get(k) || 0;
    if (n > 0) { dups.add(t.id); left.set(k, n - 1); }
  }
  return dups;
}

/* ---------- rules ---------- */
export function matchRule(db, narr) {
  const n = (narr || "").toLowerCase();
  const exists = new Set(db.ledgers.map((l) => l.id));
  const hit = db.rules.find((r) => r.ledger && r.kw && exists.has(r.ledger) && n.includes(r.kw));
  return hit ? hit.ledger : "";
}

/* ---------- audit events for masters and settings ---------- */
// Voucher events carry vtype / no / amount; these carry a subject ("Ledger: Rent", "Period lock").
export function logEvent(db, action, subject, detail, now = new Date()) {
  return [{ id: uid(), ts: localStamp(now), kind: "master", action, subject, detail }, ...(db.audit || [])];
}
export const balText = (ob, drcr) => `${inr(round2(Number(ob) || 0))} ${drcr || "Dr"}`;

/* ---------- period lock over masters ----------
   An opening balance sits before every period, so changing it rewrites locked periods.
   Regrouping moves a ledger between P&L and Balance Sheet heads, which also rewrites them
   if the ledger carries an opening balance or a voucher on or before the lock date. */
export function openingLockReason(db) {
  return db.company.lockDate ? `Books are locked up to ${db.company.lockDate}; an opening balance changes every locked period. Clear the period lock first.` : "";
}
export function regroupLockReason(db, ledger) {
  const lock = db.company.lockDate; if (!lock) return "";
  const used = (Number(ledger.ob) || 0) !== 0 || db.vouchers.some((v) => v.date <= lock && v.entries.some((e) => e.ledger === ledger.id));
  return used ? `${ledger.name} has entries in the locked period (up to ${lock}); moving it to another group would change those reports. Clear the period lock first.` : "";
}
// Moving the lock earlier or clearing it reopens filed periods, so it needs an explicit confirmation.
export function lockLoosens(oldLock, newLock) { return !!oldLock && (!newLock || newLock < oldLock); }

/* ---------- Balance Sheet and ledger statement ---------- */
export function balanceSheet(db, calc, to) {
  const np = cumulativeProfit(db, calc, to); // cumulative so it ties across years
  const bsGroups = db.groups.filter((g) => !g.pl);
  const collect = (nature) => {
    const out = [];
    for (const g of bsGroups.filter((x) => x.nature === nature && !x.parent)) {
      const kids = [g, ...db.groups.filter((x) => x.parent === g.id)]; let sum = 0;
      for (const k of kids) for (const l of db.ledgers.filter((x) => x.group === k.id)) { const bal = calc.closing(l.id, to); sum += nature === "Asset" ? bal : -bal; }
      if (Math.abs(sum) > 0.005) out.push({ name: g.name, v: round2(sum) });
    }
    return out;
  };
  const liab = collect("Liability"), assets = collect("Asset");
  const liabTotal = round2(liab.reduce((s, x) => s + x.v, 0) + (np > 0 ? np : 0));
  const assetTotal = round2(assets.reduce((s, x) => s + x.v, 0) + (np < 0 ? -np : 0));
  const diff = round2(liabTotal - assetTotal);
  return { liab, assets, np, liabTotal, assetTotal, diff, grand: Math.max(liabTotal, assetTotal) };
}
export function ledgerStatement(db, id, to) {
  const led = db.ledgers.find((l) => l.id === id);
  const opening = led ? (led.drcr === "Cr" ? -1 : 1) * round2(Number(led.ob) || 0) : 0;
  const rows = []; let run = opening;
  db.vouchers.filter((v) => !to || v.date <= to).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).forEach((v) => v.entries.forEach((e) => {
    if (e.ledger !== id) return;
    const dr = Number(e.dr) || 0, cr = Number(e.cr) || 0; run = round2(run + dr - cr);
    rows.push({ date: v.date, type: v.type, no: v.no, narr: v.narration || "", dr, cr, bal: run });
  }));
  return { opening, rows, closing: run };
}

/* ---------- CSV export (opens in Excel / Sheets) ---------- */
// Amounts are written as plain numbers (1234.50, no lakh commas) so the spreadsheet can add them up.
export const csvNum = (n) => (n === "" || n == null ? "" : round2(n).toFixed(2));
export function toCsv(rows) {
  const cell = (c) => { const t = c == null ? "" : String(c); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) && isNaN(Number(t)) ? `"${t.replace(/"/g, '""')}"` : t; };
  // Leading BOM so Excel reads ₹ and other UTF-8 text correctly.
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
const drCr = (b) => [b > 0 ? csvNum(b) : "", b < 0 ? csvNum(-b) : ""];
export function reportRows(kind, db, calc, { from, to, ledgerId } = {}) {
  const head = (title, period) => [[db.company.name], [title], [period], []];
  if (kind === "tb") {
    const t = trialBalance(db, calc, to);
    return [...head("Trial Balance", `As on ${to}`), ["Ledger", "Group", "Debit", "Credit"], ...t.rows.map((r) => [r.name, r.group, ...drCr(r.bal)]), ["Total", "", csvNum(t.dr), csvNum(t.cr)]];
  }
  if (kind === "pl") {
    const p = computePL(db, calc, from, to);
    const sec = (label, lines) => lines.map((x) => [label, x.name, csvNum(x.v)]);
    return [...head("Trading and Profit & Loss Account", `${from} to ${to}`), ["Section", "Ledger", "Amount"],
      ...sec("Trading Dr: Purchases & Direct Expenses", p.lines.tradeDr), ...sec("Trading Cr: Sales & Direct Incomes", p.lines.tradeCr),
      ["Gross " + (p.grossProfit >= 0 ? "Profit" : "Loss"), "", csvNum(Math.abs(p.grossProfit))],
      ...sec("P&L Dr: Indirect Expenses", p.lines.indDr), ...sec("P&L Cr: Indirect Incomes", p.lines.indCr),
      ["Net " + (p.netProfit >= 0 ? "Profit" : "Loss"), "", csvNum(Math.abs(p.netProfit))]];
  }
  if (kind === "bs") {
    const b = balanceSheet(db, calc, to);
    const out = [...head("Balance Sheet", `As on ${to}`), ["Side", "Head", "Amount"], ...b.liab.map((x) => ["Liabilities", x.name, csvNum(x.v)])];
    if (b.np > 0) out.push(["Liabilities", "Profit & Loss A/c", csvNum(b.np)]);
    out.push(...b.assets.map((x) => ["Assets", x.name, csvNum(x.v)]));
    if (b.np < 0) out.push(["Assets", "Profit & Loss A/c (Loss)", csvNum(-b.np)]);
    out.push(["Total liabilities", "", csvNum(b.liabTotal)], ["Total assets", "", csvNum(b.assetTotal)]);
    if (Math.abs(b.diff) > 0.005) out.push(["Difference", "", csvNum(b.diff)]);
    return out;
  }
  if (kind === "ledger") {
    const led = db.ledgers.find((l) => l.id === ledgerId); const s = ledgerStatement(db, ledgerId, to);
    return [...head(`Ledger: ${led?.name || ""}`, `Up to ${to}`), ["Date", "Voucher", "No.", "Narration", "Debit", "Credit", "Balance", "Dr/Cr"],
      ["", "Opening Balance", "", "", "", "", csvNum(Math.abs(s.opening)), s.opening >= 0 ? "Dr" : "Cr"],
      ...s.rows.map((r) => [r.date, r.type, r.no, r.narr, r.dr ? csvNum(r.dr) : "", r.cr ? csvNum(r.cr) : "", csvNum(Math.abs(r.bal)), r.bal >= 0 ? "Dr" : "Cr"]),
      ["", "Closing Balance", "", "", "", "", csvNum(Math.abs(s.closing)), s.closing >= 0 ? "Dr" : "Cr"]];
  }
  if (kind === "daybook") {
    const name = new Map(db.ledgers.map((l) => [l.id, l.name]));
    const out = [...head("Day Book", from || to ? `${from || "start"} to ${to || "date"}` : "All vouchers"), ["Date", "Voucher", "No.", "Ledger", "Debit", "Credit", "Narration"]];
    [...db.vouchers].filter((v) => (!from || v.date >= from) && (!to || v.date <= to)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .forEach((v) => v.entries.forEach((e, i) => out.push([v.date, v.type, v.no, name.get(e.ledger) || "", Number(e.dr) ? csvNum(e.dr) : "", Number(e.cr) ? csvNum(e.cr) : "", i === 0 ? v.narration || "" : ""])));
    return out;
  }
  return [];
}
