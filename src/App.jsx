import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Papa from "papaparse";
import {
  Book, Upload, FileText, Layers, BarChart3, Settings as Cog,
  Plus, Trash2, Save, Download, X, Check, AlertTriangle, ArrowRight, Search,
  Pencil, ShieldCheck, Lock
} from "lucide-react";
// Capacitor plugins. All have web fallbacks, so this same file also runs in a
// plain browser (npm run dev). On the APK they use native storage / share.
import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
const IS_NATIVE = (() => { try { return Capacitor.isNativePlatform(); } catch { return false; } })();

/* =========================================================================
   FinBuddy: manage finances, the responsible way.
   Double-entry engine + bank import, hardened.
   Fixes vs v1: memoized balance engine, period-aware P&L / as-at BS,
   max+1 voucher numbering, paise rounding, voucher edit, bank de-dup,
   bank reconciliation, in-app modals (no prompt/confirm), debounced persist,
   audit trail, period lock, voucher-type validation, optional GST helper.
   ========================================================================= */

const C = {
  ink: "#0A2540", ink2: "#123A5E", paper: "#F5F7F4", card: "#FFFFFF",
  line: "#E3E8E1", gold: "#C8992E", goldSoft: "#F6EED6", text: "#1B2A38",
  sub: "#5A6B78", cr: "#9A3B2E", profit: "#1F7A45", loss: "#B23A2E",
};
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const CASHBANK = new Set(["cash", "bank"]);

/* ---------- money / format ---------- */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function inr(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  const neg = n < 0; let x = Math.abs(Number(n));
  const p = x.toFixed(2).split("."); let i = p[0];
  let last3 = i.slice(-3); let rest = i.slice(0, -3);
  if (rest) last3 = "," + last3;
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (neg ? "-" : "") + rest + last3 + "." + p[1];
}
const uid = () => Math.random().toString(36).slice(2, 9);
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ---------- seed masters (standard Indian chart of accounts, 28 groups) ---------- */
function seedGroups() {
  const g = (id, name, nature, pl, parent) => ({ id, name, nature, pl: pl || null, parent: parent || null });
  return [
    g("cap", "Capital Account", "Liability"), g("res", "Reserves & Surplus", "Liability", null, "cap"),
    g("ca", "Current Assets", "Asset"), g("bank", "Bank Accounts", "Asset", null, "ca"),
    g("cash", "Cash-in-hand", "Asset", null, "ca"), g("dep", "Deposits (Asset)", "Asset", null, "ca"),
    g("loanadv", "Loans & Advances (Asset)", "Asset", null, "ca"), g("stock", "Stock-in-hand", "Asset", null, "ca"),
    g("debtors", "Sundry Debtors", "Asset", null, "ca"), g("cl", "Current Liabilities", "Liability"),
    g("tax", "Duties & Taxes", "Liability", null, "cl"), g("prov", "Provisions", "Liability", null, "cl"),
    g("creditors", "Sundry Creditors", "Liability", null, "cl"), g("fa", "Fixed Assets", "Asset"),
    g("inv", "Investments", "Asset"), g("loanliab", "Loans (Liability)", "Liability"),
    g("bankod", "Bank OD A/c", "Liability", null, "loanliab"), g("secured", "Secured Loans", "Liability", null, "loanliab"),
    g("unsecured", "Unsecured Loans", "Liability", null, "loanliab"), g("suspense", "Suspense A/c", "Liability"),
    g("miscexp", "Misc. Expenses (Asset)", "Asset"),
    g("sales", "Sales Accounts", "Income", "Trading"), g("purchase", "Purchase Accounts", "Expense", "Trading"),
    g("dinc", "Direct Incomes", "Income", "Trading"), g("dexp", "Direct Expenses", "Expense", "Trading"),
    g("iinc", "Indirect Incomes", "Income", "PL"), g("iexp", "Indirect Expenses", "Expense", "PL"),
  ];
}
function seedLedgers() {
  const l = (name, group, ob = 0, drcr = "Dr") => ({ id: uid(), name, group, ob, drcr });
  return [
    l("Cash", "cash"), l("HDFC Bank", "bank"), l("Capital A/c", "cap", 0, "Cr"),
    l("Sales", "sales"), l("Purchases", "purchase"), l("Bank Charges", "iexp"),
    l("Salaries", "iexp"), l("Rent", "iexp"), l("Professional Fees", "iinc"),
    l("Interest Received", "iinc"), l("Sundry Debtors (control)", "debtors"), l("Sundry Creditors (control)", "creditors"),
  ];
}
function seedDb() {
  const fyStart = fyStartFor(todayStr());
  return {
    v: 2,
    company: { name: "My Company", fyStart, booksFrom: fyStart, lockDate: "", features: { gst: false } },
    groups: seedGroups(), ledgers: seedLedgers(), vouchers: [], rules: [], audit: [],
  };
}
function fyStartFor(date) {
  const d = new Date(date); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-04-01`;
}
function fyEndFor(fyStart) { return `${Number(fyStart.slice(0, 4)) + 1}-03-31`; }

/* ---------- storage (100% on-device, no cloud / no Claude) ----------
   Primary: Capacitor Preferences → native SharedPreferences on Android,
   localStorage on web. We also mirror to localStorage as a second copy.
   Every add/edit/delete calls persist(), so progress autosaves instantly. */
// Hosted demo build (VITE_DEMO=1): starts on synthetic sample books, under its own key.
const DEMO = import.meta.env.VITE_DEMO === "1";
const KEY = DEMO ? "finbuddy_demo_db_v2" : "finbuddy_db_v2";
async function loadDb() {
  try { const r = await Preferences.get({ key: KEY }); if (r && r.value) return migrate(JSON.parse(r.value)); } catch { /* best-effort */ }
  try { const ls = localStorage.getItem(KEY); if (ls) return migrate(JSON.parse(ls)); } catch { /* best-effort */ }
  return null;
}
async function demoDb() {
  const m = await import("../docs/demo-books.json");
  return migrate(structuredClone(m.default));
}
async function persist(db) {
  const s = JSON.stringify(db);
  try { await Preferences.set({ key: KEY, value: s }); } catch { /* best-effort */ }
  try { localStorage.setItem(KEY, s); } catch { /* best-effort */ }
}
function migrate(db) {
  if (!db.company.features) db.company.features = { gst: false };
  if (db.company.lockDate === undefined) db.company.lockDate = "";
  if (!db.audit) db.audit = [];
  return db;
}

/* ---------- ENGINE (single pass, memoized) ---------- */
function makeCalc(db) {
  const byLed = {};
  db.ledgers.forEach((l) => (byLed[l.id] = []));
  db.vouchers.forEach((v) => v.entries.forEach((e) => {
    if (byLed[e.ledger]) byLed[e.ledger].push({ date: v.date, dr: Number(e.dr) || 0, cr: Number(e.cr) || 0 });
  }));
  const opening = (id) => { const l = db.ledgers.find((x) => x.id === id); return l ? (l.drcr === "Cr" ? -1 : 1) * round2(Number(l.ob) || 0) : 0; };
  const closing = (id, to) => { let s = opening(id); for (const e of byLed[id] || []) if (!to || e.date <= to) s += e.dr - e.cr; return round2(s); };
  const movement = (id, from, to) => { let s = 0; for (const e of byLed[id] || []) if ((!from || e.date >= from) && (!to || e.date <= to)) s += e.dr - e.cr; return round2(s); };
  const openingImbalance = round2(db.ledgers.reduce((s, l) => s + opening(l.id), 0)); // should be 0
  return { byLed, opening, closing, movement, openingImbalance };
}
function computePL(db, calc, from, to) {
  const lines = { tradeDr: [], tradeCr: [], indDr: [], indCr: [] };
  let tradeDr = 0, tradeCr = 0, indDr = 0, indCr = 0;
  for (const l of db.ledgers) {
    const g = db.groups.find((x) => x.id === l.group); if (!g || !g.pl) continue;
    const mv = calc.movement(l.id, from, to);
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
// Cumulative net profit (books start .. to) — used to make the Balance Sheet tie across years.
function cumulativeProfit(db, calc, to) { return computePL(db, calc, null, to).netProfit; }

/* ---------- validation ---------- */
function validateVoucher(db, type, date, entries, lockDate, booksFrom) {
  const warn = [], err = [];
  const grpOf = (id) => db.ledgers.find((l) => l.id === id)?.group;
  const eff = entries.filter((e) => e.ledger && ((Number(e.dr) || 0) > 0 || (Number(e.cr) || 0) > 0));
  const totalDr = round2(eff.reduce((s, e) => s + (Number(e.dr) || 0), 0));
  const totalCr = round2(eff.reduce((s, e) => s + (Number(e.cr) || 0), 0));
  if (eff.length < 2) err.push("Need at least two ledger lines with amounts");
  if (Math.abs(totalDr - totalCr) > 0.005 || totalDr <= 0) err.push("Debit must equal Credit and be greater than zero");
  if (lockDate && date <= lockDate) err.push(`Period locked up to ${lockDate} — cannot post on/before this date`);
  const grps = eff.map((e) => grpOf(e.ledger));
  if (type === "Contra" && !grps.every((g) => CASHBANK.has(g))) err.push("Contra allows only Cash / Bank ledgers");
  if ((type === "Payment" || type === "Receipt") && !grps.some((g) => CASHBANK.has(g))) warn.push(`${type} normally includes a Cash/Bank ledger`);
  if (type === "Journal" && grps.some((g) => CASHBANK.has(g))) warn.push("Journal normally excludes Cash/Bank (use Payment/Receipt/Contra)");
  if (type === "Sales" && !grps.includes("sales")) warn.push("Sales voucher normally credits a Sales-group ledger");
  if (type === "Purchase" && !grps.includes("purchase")) warn.push("Purchase voucher normally debits a Purchase-group ledger");
  if (booksFrom && date < booksFrom) warn.push(`Date is before books beginning (${booksFrom})`);
  if (date > todayStr()) warn.push("Date is in the future");
  return { warn, err, totalDr, totalCr, balanced: err.length === 0 };
}

/* Phone-width screens get a compact icon rail instead of the full sidebar. */
const NARROW_MQ = "(max-width: 700px)";
function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(NARROW_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_MQ);
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/* =========================================================================
   APP
   ========================================================================= */
export default function App() {
  const [db, setDb] = useState(null);
  const [tab, setTab] = useState("dash");
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const narrow = useNarrow();
  const resolver = useRef(null);
  const dbRef = useRef(null);

  useEffect(() => { loadDb().then(async (d) => setDb(d || (DEMO ? await demoDb() : seedDb()))); }, []);
  useEffect(() => { dbRef.current = db; }, [db]);

  // Autosave: write to device storage immediately on every change.
  const save = useCallback((next) => { dbRef.current = next; setDb(next); persist(next); }, []);

  // Safety flush when the app is backgrounded or closed (Android minimise / tab hide).
  useEffect(() => {
    const flush = () => { if (dbRef.current) persist(dbRef.current); };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  const ui = useMemo(() => ({
    confirm: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "confirm", ...o }); }),
    prompt: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "prompt", value: o.default || "", ...o }); }),
    alert: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "alert", ...o }); }),
    show: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "content", ...o }); }),
  }), []);
  const closeModal = (val) => { const r = resolver.current; resolver.current = null; setModal(null); if (r) r(val); };

  const calc = useMemo(() => (db ? makeCalc(db) : null), [db]);

  // Keyboard shortcuts (F4–F9 pick voucher type on Vouchers tab)
  const [pendingType, setPendingType] = useState(null);
  useEffect(() => {
    const map = { F4: "Contra", F5: "Payment", F6: "Receipt", F7: "Journal", F8: "Sales", F9: "Purchase" };
    const h = (e) => { if (map[e.key]) { e.preventDefault(); setTab("vouchers"); setPendingType(map[e.key]); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (!db || !calc) return <div style={{ minHeight: 500, display: "grid", placeItems: "center", background: C.paper, color: C.sub, fontFamily: "system-ui" }}>Loading your books…</div>;

  const nav = [
    { id: "dash", label: "Dashboard", icon: BarChart3 }, { id: "vouchers", label: "Vouchers", icon: FileText },
    { id: "bank", label: "Bank Import", icon: Upload }, { id: "masters", label: "Masters", icon: Layers },
    { id: "reports", label: "Reports", icon: Book }, { id: "audit", label: "Audit Trail", icon: ShieldCheck },
    { id: "settings", label: "Settings", icon: Cog },
  ];

  return (
    <div className="fb-shell" style={{ fontFamily: "system-ui,-apple-system,Segoe UI,Roboto", color: C.text, background: C.paper, minHeight: 640, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.line}` }}>
      <div className="fb-shell-inner" style={{ display: "flex", minHeight: 640 }}>
        <aside style={{ width: narrow ? 56 : 208, background: C.ink, color: "#DCE6F0", display: "flex", flexDirection: "column", flexShrink: 0 }}>
          {narrow ? (
            <div style={{ padding: "16px 0 12px", textAlign: "center", fontWeight: 800, fontSize: 17, color: "#fff", borderBottom: "1px solid rgba(255,255,255,.08)" }}>F<span style={{ color: C.gold }}>B</span></div>
          ) : (
            <div style={{ padding: "18px 18px 14px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
              <div style={{ fontWeight: 800, fontSize: 18, color: "#fff" }}>Fin<span style={{ color: C.gold }}>Buddy</span></div>
              <div style={{ fontSize: 10, color: "#7E97AD", marginTop: 2, fontStyle: "italic", lineHeight: 1.35 }}>manage finances,<br />the responsible way</div>
              <div style={{ fontSize: 11, color: "#8FA6BC", marginTop: 8 }}>{db.company.name}</div>
            </div>
          )}
          <nav style={{ padding: narrow ? 6 : 8, flex: 1 }}>
            {nav.map((n) => { const Icon = n.icon; const a = tab === n.id; return (
              <button key={n.id} onClick={() => setTab(n.id)} title={n.label} aria-label={n.label} style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: narrow ? "center" : "flex-start", gap: 10, padding: narrow ? "11px 0" : "9px 12px", marginBottom: 2, borderRadius: 8, border: "none", cursor: "pointer", textAlign: "left", fontSize: 13.5, fontWeight: a ? 700 : 500, background: a ? C.gold : "transparent", color: a ? C.ink : "#C6D4E2" }}>
                <Icon size={narrow ? 19 : 16} />{!narrow && <> {n.label}</>}
              </button>); })}
          </nav>
          {!narrow && <div style={{ padding: 12, fontSize: 10.5, color: "#6E859C", borderTop: "1px solid rgba(255,255,255,.08)" }}>
            FY {db.company.fyStart.slice(0, 4)}–{Number(db.company.fyStart.slice(0, 4)) + 1}{db.company.lockDate ? ` · locked ≤ ${db.company.lockDate}` : ""}
          </div>}
        </aside>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {DEMO && (
            <div style={{ background: C.goldSoft, color: C.text, padding: "8px 16px", fontSize: 12.5, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderBottom: `1px solid ${C.line}` }}>
              <span><b>Live demo</b> with synthetic sample books. Changes stay in this browser only.</span>
              <a href={`${import.meta.env.BASE_URL}sample-bank-statement.csv`} download style={{ color: C.ink2, fontWeight: 600 }}>Sample bank CSV</a>
              <button onClick={async () => save(await demoDb())} style={{ border: `1px solid ${C.line}`, background: "#fff", borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}>Reset demo</button>
            </div>
          )}
          {Math.abs(calc.openingImbalance) > 0.005 && (
            <div style={{ background: "#FBEEDD", color: "#7A4E00", padding: "8px 16px", fontSize: 12.5, display: "flex", gap: 8, alignItems: "center", borderBottom: `1px solid ${C.line}` }}>
              <AlertTriangle size={14} /> Opening balances are out by ₹{inr(Math.abs(calc.openingImbalance))} {calc.openingImbalance > 0 ? "Dr" : "Cr"}. Trial Balance and Balance Sheet will not tie until this is corrected in Masters.
            </div>
          )}
          <div style={{ flex: 1, overflow: "auto", padding: narrow ? 12 : 20, paddingBottom: 70 }}>
            {tab === "dash" && <Dashboard db={db} calc={calc} setTab={setTab} />}
            {tab === "vouchers" && <Vouchers db={db} save={save} flash={flash} ui={ui} pendingType={pendingType} clearPending={() => setPendingType(null)} />}
            {tab === "bank" && <BankImport db={db} calc={calc} save={save} flash={flash} />}
            {tab === "masters" && <Masters db={db} calc={calc} save={save} flash={flash} ui={ui} />}
            {tab === "reports" && <Reports db={db} calc={calc} />}
            {tab === "audit" && <AuditTrail db={db} />}
            {tab === "settings" && <SettingsView db={db} save={save} flash={flash} ui={ui} />}
          </div>
          <FnBar setTab={setTab} setPendingType={setPendingType} narrow={narrow} />
        </main>
      </div>

      {toast && <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: C.ink, color: "#fff", padding: "10px 18px", borderRadius: 8, fontSize: 13, boxShadow: "0 6px 24px rgba(0,0,0,.25)", zIndex: 60 }}>{toast}</div>}
      {modal && <Modal modal={modal} onClose={closeModal} setModal={setModal} />}
    </div>
  );
}

/* ---------- Modal (replaces prompt/confirm/alert; sandbox-safe) ---------- */
function Modal({ modal, onClose, setModal }) {
  const isPrompt = modal.kind === "prompt";
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(10,37,64,.45)", display: "grid", placeItems: "center", zIndex: 70 }} onClick={() => onClose(isPrompt ? null : false)}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: modal.kind === "content" ? 560 : 400, maxWidth: "92vw", boxShadow: "0 20px 60px rgba(0,0,0,.3)", overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.line}`, fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {modal.title || "Confirm"} <button onClick={() => onClose(isPrompt ? null : false)} style={iconBtn}><X size={16} /></button>
        </div>
        <div style={{ padding: 18 }}>
          {modal.message && <div style={{ fontSize: 13.5, color: C.text, lineHeight: 1.5, marginBottom: isPrompt ? 12 : 0 }}>{modal.message}</div>}
          {modal.kind === "content" && modal.node}
          {isPrompt && <input autoFocus value={modal.value} onChange={(e) => setModal({ ...modal, value: e.target.value })} onKeyDown={(e) => e.key === "Enter" && onClose(modal.value)} style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 14 }} placeholder={modal.placeholder || ""} />}
        </div>
        {modal.kind !== "content" && (
          <div style={{ padding: "12px 18px", borderTop: `1px solid ${C.line}`, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {modal.kind !== "alert" && <Btn tone="ghost" size="sm" onClick={() => onClose(isPrompt ? null : false)}>Cancel</Btn>}
            <Btn tone={modal.danger ? "danger" : "primary"} size="sm" onClick={() => onClose(isPrompt ? modal.value : true)}>{modal.ok || "OK"}</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- function-key bar ---------- */
function FnBar({ setTab, setPendingType, narrow }) {
  const keys = [["F4", "Contra"], ["F5", "Payment"], ["F6", "Receipt"], ["F7", "Journal"], ["F8", "Sales"], ["F9", "Purchase"]];
  return (
    <div style={{ display: "flex", background: C.ink2, borderTop: `2px solid ${C.gold}` }}>
      {keys.map(([k, l]) => (
        <button key={k} onClick={() => { setTab("vouchers"); setPendingType(l); }} style={{ flex: 1, padding: "8px 4px", background: "transparent", border: "none", borderRight: "1px solid rgba(255,255,255,.08)", cursor: "pointer", color: "#CFDDEC", fontSize: 11.5 }}>
          {!narrow && <><span style={{ color: C.gold, fontWeight: 700 }}>{k}</span> </>}{l}
        </button>
      ))}
    </div>
  );
}

/* ---------- primitives ---------- */
function Card({ title, right, children, pad = 16 }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 16, minWidth: 0 }}>
      {title && <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${C.line}` }}><div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>{right}</div>}
      <div style={{ padding: pad, overflowX: "auto" }}>{children}</div>
    </div>
  );
}
function Btn({ children, onClick, tone = "primary", size = "md", disabled }) {
  const styles = { primary: { background: C.gold, color: C.ink, border: "none" }, ghost: { background: "transparent", color: C.ink, border: `1px solid ${C.line}` }, danger: { background: "#fff", color: C.loss, border: `1px solid ${C.loss}` }, dark: { background: C.ink, color: "#fff", border: "none" } }[tone];
  return <button onClick={onClick} disabled={disabled} style={{ ...styles, opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer", padding: size === "sm" ? "5px 10px" : "8px 14px", borderRadius: 8, fontSize: size === "sm" ? 12.5 : 13.5, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}>{children}</button>;
}
const num = { fontFamily: mono, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const th = { textAlign: "left", padding: "8px 10px", fontSize: 11.5, color: C.sub, fontWeight: 700, borderBottom: `1px solid ${C.line}`, textTransform: "uppercase", letterSpacing: 0.4 };
const td = { padding: "7px 10px", fontSize: 13, borderBottom: `1px solid ${C.line}` };
const iconBtn = { background: "transparent", border: "none", cursor: "pointer", padding: 4, display: "inline-flex" };
function Select({ value, onChange, children, style }) { return <select value={value} onChange={onChange} style={{ padding: "6px 8px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 13, background: "#fff", color: C.text, ...style }}>{children}</select>; }
function Input(props) { return <input {...props} style={{ padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: 7, fontSize: 13, ...(props.style || {}) }} />; }
function H({ title, sub }) { return <div style={{ marginBottom: 16 }}><div style={{ fontSize: 20, fontWeight: 800, color: C.ink }}>{title}</div>{sub && <div style={{ fontSize: 13, color: C.sub, marginTop: 2 }}>{sub}</div>}</div>; }
function Lbl({ children }) { return <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 3 }}>{children}</div>; }
function Empty({ msg }) { return <div style={{ padding: 24, textAlign: "center", color: C.sub, fontSize: 13 }}>{msg}</div>; }
function Pill({ children, tone }) { const map = { ok: { bg: "#E3F3E8", c: C.profit }, warn: { bg: "#FBEEDD", c: "#8A5A00" }, bad: { bg: "#FBE4E1", c: C.loss }, undefined: { bg: C.goldSoft, c: "#7A5E12" } }; const s = map[tone] || map.undefined; return <span style={{ background: s.bg, color: s.c, padding: "2px 8px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{children}</span>; }
function ledName(db, id) { return db.ledgers.find((l) => l.id === id)?.name || "—"; }
function natureColor(n) { return n === "Asset" ? "#2A6EBB" : n === "Liability" ? C.cr : n === "Income" ? C.profit : "#8A5A00"; }
function LedgerPicker({ db, value, onChange, exclude, style }) {
  const groups = db.groups.filter((g) => db.ledgers.some((l) => l.group === g.id));
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} style={{ minWidth: 170, ...(style || {}) }}>
      <option value="">Select ledger…</option>
      {groups.map((g) => <optgroup key={g.id} label={g.name}>{db.ledgers.filter((l) => l.group === g.id && l.id !== exclude).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup>)}
    </Select>
  );
}

/* ---------- audit helper ---------- */
function pushAudit(db, action, v, note) {
  const entry = { id: uid(), ts: new Date().toISOString(), action, vtype: v.type, no: v.no, date: v.date, amount: round2(v.entries.reduce((s, e) => s + (Number(e.dr) || 0), 0)), note: note || "", detail: v.entries.map((e) => `${e.dr ? "Dr" : "Cr"} ${ledName(db, e.ledger)} ${inr(e.dr || e.cr)}`).join(" · ") };
  return [entry, ...db.audit].slice(0, 800);
}
const nextNo = (db, type) => db.vouchers.filter((v) => v.type === type).reduce((m, v) => Math.max(m, v.no || 0), 0) + 1;

/* =========================================================================
   DASHBOARD
   ========================================================================= */
function Dashboard({ db, calc, setTab }) {
  const to = todayStr();
  const pl = useMemo(() => computePL(db, calc, db.company.fyStart, to), [db, calc, to]);
  const cash = db.ledgers.filter((l) => CASHBANK.has(l.group)).reduce((s, l) => s + calc.closing(l.id, to), 0);
  const debtors = db.ledgers.filter((l) => l.group === "debtors").reduce((s, l) => s + calc.closing(l.id, to), 0);
  const creditors = db.ledgers.filter((l) => l.group === "creditors").reduce((s, l) => s + Math.max(0, -calc.closing(l.id, to)), 0);
  const tiles = [
    { label: "Cash & Bank", v: cash, color: C.profit },
    { label: `Net P/(L) FY${db.company.fyStart.slice(2, 4)}`, v: pl.netProfit, color: pl.netProfit >= 0 ? C.profit : C.loss, sign: true },
    { label: "Sundry Debtors", v: debtors, color: C.text },
    { label: "Sundry Creditors", v: creditors, color: C.cr },
  ];
  const recent = [...db.vouchers].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  return (
    <div>
      <H title="Dashboard" sub={`As on ${to}`} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, marginBottom: 16 }}>
        {tiles.map((t) => <div key={t.label} style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 12, color: C.sub, marginBottom: 6 }}>{t.label}</div>
          <div style={{ ...num, fontSize: 22, fontWeight: 700, color: t.color }}>{t.sign && t.v < 0 ? "(" : ""}₹{inr(Math.abs(t.v))}{t.sign && t.v < 0 ? ")" : ""}</div>
        </div>)}
      </div>
      <div className="fb-split" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <Card title="Recent vouchers" right={<Btn size="sm" tone="ghost" onClick={() => setTab("vouchers")}>Day Book <ArrowRight size={13} /></Btn>}>
          {recent.length === 0 ? <Empty msg="No vouchers yet. Post one or import a bank statement." /> :
            <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
              {recent.map((v) => <tr key={v.id}><td style={{ ...td, whiteSpace: "nowrap" }}>{v.date}</td><td style={td}><Pill>{v.type}</Pill></td><td style={{ ...td, color: C.sub }}>{v.narration || v.entries.map((e) => ledName(db, e.ledger)).join(", ")}</td><td style={{ ...td, ...num }}>{inr(v.entries.reduce((s, e) => s + (Number(e.dr) || 0), 0))}</td></tr>)}
            </tbody></table>}
        </Card>
        <Card title="Quick actions">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Btn tone="dark" onClick={() => setTab("bank")}><Upload size={15} /> Import bank statement</Btn>
            <Btn tone="ghost" onClick={() => setTab("vouchers")}><Plus size={15} /> New voucher</Btn>
            <Btn tone="ghost" onClick={() => setTab("reports")}><Book size={15} /> View reports</Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* =========================================================================
   VOUCHERS  (create + edit + validation + lock + audit + GST helper)
   ========================================================================= */
const VT = ["Contra", "Payment", "Receipt", "Journal", "Sales", "Purchase"];
function Vouchers({ db, save, flash, ui, pendingType, clearPending }) {
  const [type, setType] = useState("Payment");
  const [date, setDate] = useState(todayStr());
  const [narration, setNarration] = useState("");
  const [rows, setRows] = useState([{ ledger: "", dr: "", cr: "" }, { ledger: "", dr: "", cr: "" }]);
  const [editingId, setEditingId] = useState(null);
  const [q, setQ] = useState("");

  // One-shot handoff of the voucher type picked via F4-F9 in the parent.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { if (pendingType) { setType(pendingType); clearPending(); } }, [pendingType]);

  const vres = validateVoucher(db, type, date, rows, db.company.lockDate, db.company.booksFrom);
  const setRow = (i, patch) => setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows([...rows, { ledger: "", dr: "", cr: "" }]);
  const delRow = (i) => setRows(rows.filter((_, idx) => idx !== i));
  const reset = () => { setRows([{ ledger: "", dr: "", cr: "" }, { ledger: "", dr: "", cr: "" }]); setNarration(""); setEditingId(null); };

  const commit = () => {
    if (!vres.balanced) return flash(vres.err[0]);
    const entries = rows.filter((r) => r.ledger && ((Number(r.dr) || 0) > 0 || (Number(r.cr) || 0) > 0)).map((r) => ({ ledger: r.ledger, dr: round2(Number(r.dr) || 0), cr: round2(Number(r.cr) || 0) }));
    if (editingId) {
      const old = db.vouchers.find((v) => v.id === editingId);
      if (old && db.company.lockDate && old.date <= db.company.lockDate) return flash("Original voucher is in a locked period");
      const nv = { ...old, type, date, narration, entries };
      const audit = pushAudit(db, "edit", nv, `was: ${old.entries.map((e) => `${e.dr ? "Dr" : "Cr"} ${ledName(db, e.ledger)} ${inr(e.dr || e.cr)}`).join(" · ")}`);
      save({ ...db, vouchers: db.vouchers.map((v) => (v.id === editingId ? nv : v)), audit });
      flash(`${type} #${nv.no} updated`);
    } else {
      const v = { id: uid(), type, date, no: nextNo(db, type), narration, entries };
      save({ ...db, vouchers: [...db.vouchers, v], audit: pushAudit(db, "create", v) });
      flash(`${type} #${v.no} posted`);
    }
    reset();
  };
  const startEdit = (v) => { setEditingId(v.id); setType(v.type); setDate(v.date); setNarration(v.narration || ""); setRows(v.entries.map((e) => ({ ledger: e.ledger, dr: e.dr || "", cr: e.cr || "" }))); window.scrollTo?.(0, 0); };
  const del = async (v) => {
    if (db.company.lockDate && v.date <= db.company.lockDate) return flash("Voucher is in a locked period");
    const ok = await ui.confirm({ title: "Delete voucher", message: `Delete ${v.type} #${v.no} dated ${v.date}? This is logged in the audit trail.`, danger: true, ok: "Delete" });
    if (!ok) return;
    save({ ...db, vouchers: db.vouchers.filter((x) => x.id !== v.id), audit: pushAudit(db, "delete", v) });
    flash("Voucher deleted");
  };

  const dayBook = [...db.vouchers].filter((v) => !q || (v.narration || "").toLowerCase().includes(q.toLowerCase()) || v.entries.some((e) => ledName(db, e.ledger).toLowerCase().includes(q.toLowerCase()))).sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <div>
      <H title="Vouchers" sub="Every voucher must balance. Type rules and period lock are enforced. Edits and deletes are audit-logged." />
      <Card title={editingId ? "Edit voucher" : "Voucher entry"} right={<Pill tone={vres.balanced ? "ok" : "bad"}>{vres.balanced ? "Balanced" : "Unbalanced"}</Pill>}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <Select value={type} onChange={(e) => setType(e.target.value)}>{VT.map((t) => <option key={t}>{t}</option>)}</Select>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <div style={{ fontSize: 12, color: C.sub }}>{editingId ? `#${db.vouchers.find((v) => v.id === editingId)?.no}` : `No. ${nextNo(db, type)}`}</div>
          {editingId && <Btn tone="ghost" size="sm" onClick={reset}>Cancel edit</Btn>}
        </div>

        {db.company.features?.gst && (type === "Sales" || type === "Purchase") && <GstHelper db={db} type={type} onBuild={setRows} flash={flash} save={save} />}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Ledger</th><th style={{ ...th, textAlign: "right", width: 150 }}>Debit</th><th style={{ ...th, textAlign: "right", width: 150 }}>Credit</th><th style={{ ...th, width: 34 }}></th></tr></thead>
          <tbody>
            {rows.map((r, i) => <tr key={i}>
              <td style={td}><LedgerPicker db={db} value={r.ledger} onChange={(v) => setRow(i, { ledger: v })} /></td>
              <td style={td}><Input type="number" value={r.dr} onChange={(e) => setRow(i, { dr: e.target.value, cr: "" })} style={{ ...num, width: 130 }} placeholder="0.00" /></td>
              <td style={td}><Input type="number" value={r.cr} onChange={(e) => setRow(i, { cr: e.target.value, dr: "" })} style={{ ...num, width: 130 }} placeholder="0.00" /></td>
              <td style={td}>{rows.length > 2 && <button onClick={() => delRow(i)} style={iconBtn}><Trash2 size={14} color={C.loss} /></button>}</td>
            </tr>)}
            <tr><td style={{ ...td, fontWeight: 700, textAlign: "right", color: C.sub }}>Total</td><td style={{ ...td, ...num, fontWeight: 700 }}>{inr(vres.totalDr)}</td><td style={{ ...td, ...num, fontWeight: 700 }}>{inr(vres.totalCr)}</td><td style={td}></td></tr>
          </tbody>
        </table>

        {(vres.err.length > 0 || vres.warn.length > 0) && (
          <div style={{ marginTop: 10 }}>
            {vres.err.map((e, i) => <div key={i} style={{ fontSize: 12, color: C.loss, display: "flex", gap: 6, alignItems: "center" }}><AlertTriangle size={12} /> {e}</div>)}
            {vres.warn.map((w, i) => <div key={i} style={{ fontSize: 12, color: "#8A5A00", display: "flex", gap: 6, alignItems: "center" }}><AlertTriangle size={12} /> {w} <span style={{ color: C.sub }}>(allowed)</span></div>)}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Btn tone="ghost" size="sm" onClick={addRow}><Plus size={14} /> Add line</Btn>
          <Input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Narration" style={{ flex: 1, minWidth: 200 }} />
          <Btn onClick={commit} disabled={!vres.balanced}><Save size={15} /> {editingId ? "Update voucher" : "Post voucher"}</Btn>
        </div>
      </Card>

      <Card title="Day Book" right={<div style={{ position: "relative" }}><Search size={14} style={{ position: "absolute", left: 8, top: 8, color: C.sub }} /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" style={{ paddingLeft: 26, width: 180 }} /></div>}>
        {dayBook.length === 0 ? <Empty msg="No vouchers match." /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Date</th><th style={th}>Type · No.</th><th style={th}>Particulars</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={{ ...th, width: 60 }}></th></tr></thead>
            <tbody>
              {dayBook.map((v) => { const locked = db.company.lockDate && v.date <= db.company.lockDate; return (
                <tr key={v.id}>
                  <td style={{ ...td, verticalAlign: "top" }}>{v.date}{locked && <Lock size={11} color={C.sub} style={{ marginLeft: 4 }} />}</td>
                  <td style={{ ...td, verticalAlign: "top" }}><Pill>{v.type}</Pill> <span style={{ color: C.sub, fontSize: 12 }}>#{v.no}</span></td>
                  <td style={td}>
                    {v.entries.map((e, ix) => <div key={ix} style={{ fontSize: 12.5, color: e.dr ? C.text : C.cr }}>{e.dr ? "Dr " : "   Cr "}{ledName(db, e.ledger)} <span style={{ ...num, color: C.sub }}>{inr(e.dr || e.cr)}</span></div>)}
                    {v.narration && <div style={{ fontSize: 11.5, color: C.sub, fontStyle: "italic", marginTop: 2 }}>{v.narration}</div>}
                  </td>
                  <td style={{ ...td, ...num, verticalAlign: "top" }}>{inr(v.entries.reduce((s, e) => s + (Number(e.dr) || 0), 0))}</td>
                  <td style={{ ...td, verticalAlign: "top" }}>
                    {!locked && <><button onClick={() => startEdit(v)} style={iconBtn}><Pencil size={13} color={C.ink2} /></button><button onClick={() => del(v)} style={iconBtn}><Trash2 size={14} color={C.loss} /></button></>}
                  </td>
                </tr>); })}
            </tbody>
          </table>}
      </Card>
    </div>
  );
}

/* ---------- GST helper (only when enabled) ---------- */
function ensureGstLedgers(db) {
  const need = db.company.features?.gst ? ["Output CGST", "Output SGST", "Output IGST", "Input CGST", "Input SGST", "Input IGST"] : [];
  const missing = need.filter((n) => !db.ledgers.some((l) => l.name === n));
  if (!missing.length) return db;
  const add = missing.map((name) => ({ id: uid(), name, group: "tax", ob: 0, drcr: "Cr" }));
  return { ...db, ledgers: [...db.ledgers, ...add] };
}
function GstHelper({ db, type, onBuild, flash }) {
  const [party, setParty] = useState("");
  const [main, setMain] = useState("");
  const [taxable, setTaxable] = useState("");
  const [rate, setRate] = useState("18");
  const [inter, setInter] = useState(false);
  const led = (name) => db.ledgers.find((l) => l.name === name)?.id || "";
  const build = () => {
    const t = round2(Number(taxable) || 0), r = Number(rate) || 0;
    if (!party || !main || t <= 0) return flash("Pick party, main ledger and a taxable amount");
    const tax = round2(t * r / 100), half = round2(tax / 2), otherHalf = round2(tax - half), total = round2(t + tax);
    let rows;
    if (type === "Sales") {
      rows = inter
        ? [{ ledger: party, dr: total, cr: "" }, { ledger: main, dr: "", cr: t }, { ledger: led("Output IGST"), dr: "", cr: tax }]
        : [{ ledger: party, dr: total, cr: "" }, { ledger: main, dr: "", cr: t }, { ledger: led("Output CGST"), dr: "", cr: half }, { ledger: led("Output SGST"), dr: "", cr: otherHalf }];
    } else {
      rows = inter
        ? [{ ledger: main, dr: t, cr: "" }, { ledger: led("Input IGST"), dr: tax, cr: "" }, { ledger: party, dr: "", cr: total }]
        : [{ ledger: main, dr: t, cr: "" }, { ledger: led("Input CGST"), dr: half, cr: "" }, { ledger: led("Input SGST"), dr: otherHalf, cr: "" }, { ledger: party, dr: "", cr: total }];
    }
    onBuild(rows.filter((x) => x.ledger));
  };
  const partyGroup = type === "Sales" ? "debtors" : "creditors";
  const mainGroup = type === "Sales" ? "sales" : "purchase";
  return (
    <div style={{ background: C.goldSoft, border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: "#7A5E12" }}>GST helper — builds the tax-split entries for you</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div><Lbl>{type === "Sales" ? "Debtor" : "Creditor"}</Lbl>
          <Select value={party} onChange={(e) => setParty(e.target.value)}><option value="">Select…</option>{db.ledgers.filter((l) => l.group === partyGroup).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></div>
        <div><Lbl>{type === "Sales" ? "Sales" : "Purchase"} ledger</Lbl>
          <Select value={main} onChange={(e) => setMain(e.target.value)}><option value="">Select…</option>{db.ledgers.filter((l) => l.group === mainGroup).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></div>
        <div><Lbl>Taxable value</Lbl><Input type="number" value={taxable} onChange={(e) => setTaxable(e.target.value)} style={{ ...num, width: 110 }} placeholder="0.00" /></div>
        <div><Lbl>Rate %</Lbl><Select value={rate} onChange={(e) => setRate(e.target.value)}>{["0", "5", "12", "18", "28"].map((x) => <option key={x}>{x}</option>)}</Select></div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, marginBottom: 6 }}><input type="checkbox" checked={inter} onChange={(e) => setInter(e.target.checked)} /> Inter-state (IGST)</label>
        <Btn size="sm" onClick={build}>Build entries</Btn>
      </div>
    </div>
  );
}

/* =========================================================================
   BANK IMPORT  (header override, de-dup, reconciliation, audit)
   ========================================================================= */
function parseNum(s) { if (s == null) return 0; const t = String(s).replace(/[₹,\s]/g, "").replace(/(cr|dr)$/i, "").trim(); const n = parseFloat(t); return isNaN(n) ? 0 : round2(n); }
function normDate(s) {
  if (!s) return ""; s = String(s).trim();
  const mo = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" }; let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) { let [, d, mm, y] = m; if (y.length === 2) y = "20" + y; return `${y}-${mm.padStart(2, "0")}-${d.padStart(2, "0")}`; }
  if ((m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{2,4})/))) { let [, d, mm, y] = m; if (y.length === 2) y = "20" + y; return `${y}-${mo[mm.toLowerCase()] || "01"}-${d.padStart(2, "0")}`; }
  return s;
}
function bankDupSet(db) {
  const set = new Set();
  db.vouchers.forEach((v) => { if (v.type !== "Receipt" && v.type !== "Payment") return; v.entries.forEach((e) => { const g = db.ledgers.find((l) => l.id === e.ledger)?.group; if (CASHBANK.has(g)) set.add(`${e.ledger}|${v.date}|${round2((Number(e.dr) || 0) + (Number(e.cr) || 0))}|${(v.narration || "").trim().toLowerCase()}`); }); });
  return set;
}
function BankImport({ db, calc, save, flash }) {
  const [rawRows, setRawRows] = useState(null);
  const [headerIdx, setHeaderIdx] = useState(0);
  const [map, setMap] = useState({ date: -1, narr: -1, wd: -1, dep: -1, bal: -1 });
  const [bankLedger, setBankLedger] = useState(db.ledgers.find((l) => l.group === "bank")?.id || "");
  const [txns, setTxns] = useState([]);
  const fileRef = useRef();
  const bankLedgers = db.ledgers.filter((l) => l.group === "bank");
  const dupSet = useMemo(() => bankDupSet(db), [db]);

  const autoMap = (headers) => { const h = headers.map((x) => String(x || "").toLowerCase()); const find = (...k) => h.findIndex((c) => k.some((x) => c.includes(x))); return { date: find("txn date", "value date", "date"), narr: find("narration", "description", "particular", "remark", "detail"), wd: find("withdrawal", "debit", "paid out", "dr amount"), dep: find("deposit", "credit", "paid in", "cr amount"), bal: find("balance") }; };
  const ingest = (rows) => { let h = 0; for (let i = 0; i < Math.min(rows.length, 30); i++) { const j = rows[i].join(" ").toLowerCase(); if (/date/.test(j) && /(narration|description|particular|withdraw|deposit|debit|credit|amount|balance)/.test(j)) { h = i; break; } } setRawRows(rows); setHeaderIdx(h); const m = autoMap(rows[h] || []); setMap(m); build(rows, h, m); };
  const build = (rows, h, m) => { const out = []; for (let i = h + 1; i < rows.length; i++) { const r = rows[i]; if (!r || r.every((c) => !String(c).trim())) continue; const wd = m.wd >= 0 ? parseNum(r[m.wd]) : 0, dep = m.dep >= 0 ? parseNum(r[m.dep]) : 0; if (!wd && !dep) continue; const narr = m.narr >= 0 ? String(r[m.narr] || "").trim() : ""; out.push({ id: uid(), date: normDate(m.date >= 0 ? r[m.date] : ""), narr, amount: wd || dep, dir: wd ? "out" : "in", bal: m.bal >= 0 ? parseNum(r[m.bal]) : null, counter: matchRule(db, narr), include: true }); } setTxns(out); };

  const onFile = (e) => { const f = e.target.files[0]; if (!f) return; Papa.parse(f, { skipEmptyLines: true, complete: (res) => { if (res.data?.length) ingest(res.data); else flash("Could not read file"); } }); };
  const onPaste = (text) => { const res = Papa.parse(text.trim(), { skipEmptyLines: true }); if (res.data?.length) ingest(res.data); };
  const remap = (f, idx) => { const m = { ...map, [f]: idx }; setMap(m); if (rawRows) build(rawRows, headerIdx, m); };
  const setHeader = (idx) => { setHeaderIdx(idx); const m = autoMap(rawRows[idx] || []); setMap(m); build(rawRows, idx, m); };
  const setTxn = (id, patch) => setTxns(txns.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const isDup = (t) => bankLedger && dupSet.has(`${bankLedger}|${t.date}|${round2(t.amount)}|${t.narr.trim().toLowerCase()}`);
  const chosen = txns.filter((t) => t.include && t.counter && t.amount > 0 && !isDup(t));
  const dupCount = txns.filter((t) => isDup(t) && t.include).length;

  // reconciliation
  const stmtClosing = useMemo(() => { const withBal = txns.filter((t) => t.bal != null); return withBal.length ? withBal[withBal.length - 1].bal : null; }, [txns]);
  const netSelected = chosen.reduce((s, t) => s + (t.dir === "in" ? t.amount : -t.amount), 0);
  const bookAfter = bankLedger ? round2(calc.closing(bankLedger, null) + netSelected) : null;

  const postAll = () => {
    if (!bankLedger) return flash("Pick a bank ledger");
    if (!chosen.length) return flash("No rows ready (assign counter ledgers; duplicates are skipped)");
    if (db.company.lockDate && chosen.some((t) => t.date <= db.company.lockDate)) return flash(`Some rows fall in the locked period (≤ ${db.company.lockDate})`);
    let counters = {}; db.vouchers.forEach((v) => { counters[v.type] = Math.max(counters[v.type] || 0, v.no || 0); });
    const newV = chosen.map((t) => { const type = t.dir === "in" ? "Receipt" : "Payment"; counters[type] = (counters[type] || 0) + 1;
      const entries = t.dir === "in" ? [{ ledger: bankLedger, dr: t.amount, cr: 0 }, { ledger: t.counter, dr: 0, cr: t.amount }] : [{ ledger: t.counter, dr: t.amount, cr: 0 }, { ledger: bankLedger, dr: 0, cr: t.amount }];
      return { id: uid(), type, date: t.date, no: counters[type], narration: t.narr, entries }; });
    let audit = db.audit; newV.forEach((v) => (audit = pushAudit({ ...db, audit }, "create", v, "bank import")));
    save({ ...db, vouchers: [...db.vouchers, ...newV], audit });
    flash(`${newV.length} vouchers posted${dupCount ? ` · ${dupCount} duplicates skipped` : ""}`);
    setTxns(txns.filter((t) => !(t.include && t.counter && !isDup(t))));
  };

  return (
    <div>
      <H title="Bank Import" sub="Withdrawal → Payment (Cr Bank). Deposit → Receipt (Dr Bank). Duplicates are detected and skipped; statement balance is reconciled." />

      <Card title="1 · Load statement">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
            <Btn tone="dark" onClick={() => fileRef.current?.click()}><Upload size={15} /> Choose CSV</Btn>
            <div style={{ fontSize: 11.5, color: C.sub, marginTop: 6, maxWidth: 230 }}>Metadata rows above the table are auto-skipped. Dates are read as DD/MM/YYYY (Indian).</div>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>…or paste CSV / tab-separated rows</div>
            <textarea onBlur={(e) => e.target.value.trim() && onPaste(e.target.value)} placeholder={"Date,Narration,Withdrawal,Deposit,Balance\n05/04/2025,UPI-ZOMATO,450,,12000"} style={{ width: "100%", height: 66, border: `1px solid ${C.line}`, borderRadius: 8, padding: 8, fontFamily: mono, fontSize: 12 }} />
          </div>
        </div>
      </Card>

      {rawRows && (
        <Card title="2 · Map columns" right={<div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}><span style={{ color: C.sub }}>Bank ledger</span><Select value={bankLedger} onChange={(e) => setBankLedger(e.target.value)}><option value="">Select…</option>{bankLedgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></div>}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, fontSize: 12.5, color: C.sub }}>
            Header row:
            <Select value={headerIdx} onChange={(e) => setHeader(Number(e.target.value))}>{rawRows.slice(0, 30).map((r, i) => <option key={i} value={i}>Row {i + 1}: {r.slice(0, 4).join(" | ").slice(0, 40)}</option>)}</Select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
            {[["date", "Date"], ["narr", "Narration"], ["wd", "Withdrawal (out)"], ["dep", "Deposit (in)"], ["bal", "Balance"]].map(([f, lbl]) => <div key={f}><Lbl>{lbl}</Lbl><Select value={map[f]} onChange={(e) => remap(f, Number(e.target.value))} style={{ width: "100%" }}><option value={-1}>—</option>{(rawRows[headerIdx] || []).map((h, i) => <option key={i} value={i}>{String(h || `Col ${i + 1}`).slice(0, 24)}</option>)}</Select></div>)}
          </div>
        </Card>
      )}

      {txns.length > 0 && (
        <Card title={`3 · Review & assign ledgers (${chosen.length} ready${dupCount ? `, ${dupCount} dup` : ""})`} right={<Btn onClick={postAll} disabled={!bankLedger || !chosen.length}><Check size={15} /> Post {chosen.length} vouchers</Btn>}>
          {(stmtClosing != null && bookAfter != null) && (
            <div style={{ display: "flex", gap: 16, fontSize: 12.5, marginBottom: 10, padding: "8px 10px", background: C.paper, borderRadius: 8, flexWrap: "wrap" }}>
              <span>Statement closing: <b style={num}>₹{inr(stmtClosing)}</b></span>
              <span>Book bank after posting selected: <b style={num}>₹{inr(bookAfter)}</b></span>
              <Pill tone={Math.abs(stmtClosing - bookAfter) < 0.01 ? "ok" : "warn"}>{Math.abs(stmtClosing - bookAfter) < 0.01 ? "Reconciles" : `Diff ₹${inr(stmtClosing - bookAfter)}`}</Pill>
            </div>
          )}
          <div style={{ maxHeight: 340, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={{ ...th, width: 30 }}></th><th style={th}>Date</th><th style={th}>Narration</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Type</th><th style={th}>Counter ledger</th></tr></thead>
              <tbody>
                {txns.map((t) => { const dup = isDup(t); return (
                  <tr key={t.id} style={{ opacity: t.include && !dup ? 1 : 0.5 }}>
                    <td style={td}><input type="checkbox" checked={t.include && !dup} disabled={dup} onChange={(e) => setTxn(t.id, { include: e.target.checked })} /></td>
                    <td style={td}>{t.date}</td>
                    <td style={{ ...td, maxWidth: 220, fontSize: 12 }}>{t.narr} {dup && <Pill tone="bad">Duplicate</Pill>}</td>
                    <td style={{ ...td, ...num, color: t.dir === "out" ? C.cr : C.profit }}>{inr(t.amount)}</td>
                    <td style={td}><Pill tone={t.dir === "in" ? "ok" : "warn"}>{t.dir === "in" ? "Receipt" : "Payment"}</Pill></td>
                    <td style={td}><LedgerPicker db={db} value={t.counter} onChange={(v) => setTxn(t.id, { counter: v })} exclude={bankLedger} /></td>
                  </tr>); })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: C.sub, marginTop: 8 }}>Tip: build reusable keyword→ledger rules under Masters ▸ Auto-rules so repeat narrations auto-fill.</div>
        </Card>
      )}
    </div>
  );
}
function matchRule(db, narr) { const n = (narr || "").toLowerCase(); const hit = db.rules.find((r) => r.ledger && r.kw && n.includes(r.kw)); return hit ? hit.ledger : ""; }

/* =========================================================================
   MASTERS
   ========================================================================= */
function Masters({ db, calc, save, flash, ui }) {
  const [sub, setSub] = useState("ledgers");
  const [name, setName] = useState(""); const [group, setGroup] = useState("iexp"); const [ob, setOb] = useState(""); const [drcr, setDrcr] = useState("Dr");
  const addLedger = () => {
    if (!name.trim()) return flash("Enter a ledger name");
    if (db.ledgers.some((l) => l.name.toLowerCase() === name.trim().toLowerCase())) return flash("Ledger already exists");
    save({ ...db, ledgers: [...db.ledgers, { id: uid(), name: name.trim(), group, ob: round2(Number(ob) || 0), drcr }] });
    setName(""); setOb(""); flash("Ledger created");
  };
  const delLedger = async (l) => {
    if (db.vouchers.some((v) => v.entries.some((e) => e.ledger === l.id))) return flash("Ledger is used in vouchers — cannot delete");
    const ok = await ui.confirm({ title: "Delete ledger", message: `Delete "${l.name}"?`, danger: true, ok: "Delete" }); if (!ok) return;
    save({ ...db, ledgers: db.ledgers.filter((x) => x.id !== l.id) });
  };
  const editOb = async (l) => {
    const val = await ui.prompt({ title: "Opening balance", message: `${l.name} — enter opening balance (negative = Cr)`, default: String((l.drcr === "Cr" ? -1 : 1) * (l.ob || 0)) });
    if (val == null) return; const n = round2(Number(val) || 0);
    save({ ...db, ledgers: db.ledgers.map((x) => (x.id === l.id ? { ...x, ob: Math.abs(n), drcr: n < 0 ? "Cr" : "Dr" } : x)) });
  };
  const grouped = db.groups.map((g) => ({ g, leds: db.ledgers.filter((l) => l.group === g.id) })).filter((x) => x.leds.length);

  return (
    <div>
      <H title="Masters" sub="Groups fix P&L vs Balance-Sheet placement. Ledgers carry balances and opening figures." />
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {[["ledgers", "Ledgers"], ["groups", "Groups"], ["rules", "Auto-rules"]].map(([id, l]) => <button key={id} onClick={() => setSub(id)} style={{ padding: "6px 14px", borderRadius: 20, border: `1px solid ${sub === id ? C.gold : C.line}`, background: sub === id ? C.goldSoft : "#fff", color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{l}</button>)}
      </div>

      {sub === "ledgers" && <>
        <Card title="Create ledger">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div><Lbl>Name</Lbl><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Electricity" style={{ width: 200 }} /></div>
            <div><Lbl>Under group</Lbl><Select value={group} onChange={(e) => setGroup(e.target.value)}>{db.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></div>
            <div><Lbl>Opening bal</Lbl><Input type="number" value={ob} onChange={(e) => setOb(e.target.value)} style={{ ...num, width: 120 }} placeholder="0.00" /></div>
            <div><Lbl>Dr / Cr</Lbl><Select value={drcr} onChange={(e) => setDrcr(e.target.value)}><option>Dr</option><option>Cr</option></Select></div>
            <Btn onClick={addLedger}><Plus size={15} /> Add</Btn>
          </div>
          {Math.abs(calc.openingImbalance) > 0.005 && <div style={{ marginTop: 10, fontSize: 12, color: "#8A5A00" }}>Opening balances currently out by ₹{inr(Math.abs(calc.openingImbalance))} {calc.openingImbalance > 0 ? "Dr" : "Cr"} — post the difference to Capital or Suspense.</div>}
        </Card>
        <Card title={`Chart of accounts (${db.ledgers.length} ledgers)`}>
          {grouped.map(({ g, leds }) => <div key={g.id} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{g.name} <span style={{ color: natureColor(g.nature), fontWeight: 600 }}>· {g.nature}</span></div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
              {leds.map((l) => { const bal = calc.closing(l.id, null); return (
                <tr key={l.id}>
                  <td style={{ ...td, width: "50%" }}>{l.name}</td>
                  <td style={{ ...td, color: C.sub, fontSize: 12, cursor: "pointer" }} onClick={() => editOb(l)}>{l.ob ? `Op ${inr(l.ob)} ${l.drcr}` : <span style={{ color: "#9AA" }}>set opening</span>}</td>
                  <td style={{ ...td, ...num, fontWeight: 600 }}>{inr(Math.abs(bal))} {bal >= 0 ? "Dr" : "Cr"}</td>
                  <td style={{ ...td, width: 30 }}><button onClick={() => delLedger(l)} style={iconBtn}><Trash2 size={13} color={C.loss} /></button></td>
                </tr>); })}
            </tbody></table>
          </div>)}
        </Card>
      </>}

      {sub === "groups" && <Card title="Groups (standard Indian chart of accounts)">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Group</th><th style={th}>Nature</th><th style={th}>Under</th><th style={th}>P&L role</th></tr></thead>
          <tbody>{db.groups.map((g) => <tr key={g.id}><td style={{ ...td, paddingLeft: g.parent ? 26 : 10, fontWeight: g.parent ? 400 : 600 }}>{g.name}</td><td style={{ ...td, color: natureColor(g.nature) }}>{g.nature}</td><td style={{ ...td, color: C.sub }}>{g.parent ? db.groups.find((x) => x.id === g.parent)?.name : "Primary"}</td><td style={{ ...td, color: C.sub }}>{g.pl === "Trading" ? "Trading A/c" : g.pl === "PL" ? "Profit & Loss" : "—"}</td></tr>)}</tbody>
        </table>
      </Card>}

      {sub === "rules" && <RulesEditor db={db} save={save} flash={flash} />}
    </div>
  );
}
function RulesEditor({ db, save, flash }) {
  const [kw, setKw] = useState(""); const [led, setLed] = useState("");
  const add = () => { if (!kw.trim() || !led) return flash("Enter keyword and ledger"); save({ ...db, rules: [...db.rules, { id: uid(), kw: kw.trim().toLowerCase(), ledger: led }] }); setKw(""); setLed(""); flash("Rule added"); };
  const del = (id) => save({ ...db, rules: db.rules.filter((r) => r.id !== id) });
  const active = db.rules.filter((r) => r.ledger);
  return (
    <Card title="Auto-categorisation rules" right={<span style={{ fontSize: 12, color: C.sub }}>First matching keyword wins</span>}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14 }}>
        <div><Lbl>If narration contains</Lbl><Input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="e.g. zomato" style={{ width: 180 }} /></div>
        <div><Lbl>Post to ledger</Lbl><LedgerPicker db={db} value={led} onChange={setLed} /></div>
        <Btn onClick={add}><Plus size={15} /> Add rule</Btn>
      </div>
      {active.length === 0 ? <Empty msg="No rules yet." /> :
        <table style={{ width: "100%", borderCollapse: "collapse" }}><thead><tr><th style={th}>Keyword</th><th style={th}>Ledger</th><th style={{ ...th, width: 30 }}></th></tr></thead>
          <tbody>{active.map((r) => <tr key={r.id}><td style={{ ...td, fontFamily: mono }}>{r.kw}</td><td style={td}>{ledName(db, r.ledger)}</td><td style={td}><button onClick={() => del(r.id)} style={iconBtn}><Trash2 size={13} color={C.loss} /></button></td></tr>)}</tbody>
        </table>}
    </Card>
  );
}

/* =========================================================================
   REPORTS  (period selector; P&L = period, BS = as-at, TB = as-at)
   ========================================================================= */
function Reports({ db, calc }) {
  const [rep, setRep] = useState("tb");
  const [from, setFrom] = useState(db.company.fyStart);
  const [to, setTo] = useState(fyEndFor(db.company.fyStart) > todayStr() ? todayStr() : fyEndFor(db.company.fyStart));
  return (
    <div>
      <H title="Reports" sub="Computed live. Profit & Loss is period-bound; Balance Sheet and Trial Balance are as-at the To date." />
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        {[["tb", "Trial Balance"], ["pl", "Profit & Loss"], ["bs", "Balance Sheet"], ["ledger", "Ledger"]].map(([id, l]) => <button key={id} onClick={() => setRep(id)} style={{ padding: "6px 14px", borderRadius: 20, border: `1px solid ${rep === id ? C.gold : C.line}`, background: rep === id ? C.goldSoft : "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", color: C.text }}>{l}</button>)}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.sub }}>
          {rep === "pl" && <>From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></>}
          {rep === "pl" ? "To" : "As on"} <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      {rep === "tb" && <TrialBalance db={db} calc={calc} to={to} />}
      {rep === "pl" && <ProfitLoss db={db} calc={calc} from={from} to={to} />}
      {rep === "bs" && <BalanceSheet db={db} calc={calc} to={to} />}
      {rep === "ledger" && <LedgerReport db={db} to={to} />}
    </div>
  );
}
function TrialBalance({ db, calc, to }) {
  const rows = db.ledgers.map((l) => ({ l, bal: calc.closing(l.id, to) })).filter((r) => Math.abs(r.bal) > 0.005);
  const dr = round2(rows.filter((r) => r.bal >= 0).reduce((s, r) => s + r.bal, 0));
  const cr = round2(rows.filter((r) => r.bal < 0).reduce((s, r) => s - r.bal, 0));
  return (
    <Card title="Trial Balance" right={<Pill tone={Math.abs(dr - cr) < 0.01 ? "ok" : "bad"}>{Math.abs(dr - cr) < 0.01 ? "Balanced" : `Diff ₹${inr(dr - cr)}`}</Pill>}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={th}>Ledger</th><th style={th}>Group</th><th style={{ ...th, textAlign: "right" }}>Debit</th><th style={{ ...th, textAlign: "right" }}>Credit</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.l.id}><td style={td}>{r.l.name}</td><td style={{ ...td, color: C.sub, fontSize: 12 }}>{db.groups.find((g) => g.id === r.l.group)?.name}</td><td style={{ ...td, ...num }}>{r.bal >= 0 ? inr(r.bal) : ""}</td><td style={{ ...td, ...num }}>{r.bal < 0 ? inr(-r.bal) : ""}</td></tr>)}
          <tr style={{ borderTop: `2px solid ${C.ink}` }}><td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total</td><td style={{ ...td, ...num, fontWeight: 700 }}>{inr(dr)}</td><td style={{ ...td, ...num, fontWeight: 700 }}>{inr(cr)}</td></tr>
        </tbody>
      </table>
    </Card>
  );
}
function ProfitLoss({ db, calc, from, to }) {
  const p = useMemo(() => computePL(db, calc, from, to), [db, calc, from, to]);
  const gp = p.grossProfit;
  return (
    <>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>Period: {from} to {to}</div>
      <Card title="Trading Account">
        <div className="fb-split" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <Side title="Dr — Purchases & Direct Expenses" lines={p.lines.tradeDr} extra={gp > 0 ? <tr><td style={{ ...td, color: C.profit, fontWeight: 700 }}>Gross Profit c/d</td><td style={{ ...td, ...num, color: C.profit, fontWeight: 700 }}>{inr(gp)}</td></tr> : null} />
          <Side title="Cr — Sales & Direct Incomes" lines={p.lines.tradeCr} extra={gp < 0 ? <tr><td style={{ ...td, color: C.loss, fontWeight: 700 }}>Gross Loss c/d</td><td style={{ ...td, ...num, color: C.loss, fontWeight: 700 }}>{inr(-gp)}</td></tr> : null} />
        </div>
      </Card>
      <Card title="Profit & Loss Account">
        <div className="fb-split" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <Side title="Dr — Indirect Expenses" lines={p.lines.indDr} extra={<>{gp < 0 && <tr><td style={{ ...td, color: C.loss }}>Gross Loss b/d</td><td style={{ ...td, ...num }}>{inr(-gp)}</td></tr>}{p.netProfit > 0 && <tr><td style={{ ...td, color: C.profit, fontWeight: 700 }}>Net Profit</td><td style={{ ...td, ...num, color: C.profit, fontWeight: 700 }}>{inr(p.netProfit)}</td></tr>}</>} />
          <Side title="Cr — Indirect Incomes" lines={p.lines.indCr} extra={<>{gp > 0 && <tr><td style={{ ...td, color: C.profit }}>Gross Profit b/d</td><td style={{ ...td, ...num }}>{inr(gp)}</td></tr>}{p.netProfit < 0 && <tr><td style={{ ...td, color: C.loss, fontWeight: 700 }}>Net Loss</td><td style={{ ...td, ...num, color: C.loss, fontWeight: 700 }}>{inr(-p.netProfit)}</td></tr>}</>} />
        </div>
        <div style={{ marginTop: 14, textAlign: "right", fontSize: 15, fontWeight: 700, color: p.netProfit >= 0 ? C.profit : C.loss }}>Net {p.netProfit >= 0 ? "Profit" : "Loss"}: ₹{inr(Math.abs(p.netProfit))}</div>
      </Card>
    </>
  );
}
function Side({ title, lines, extra }) {
  return <div><div style={{ fontSize: 12, fontWeight: 700, color: C.sub, marginBottom: 6 }}>{title}</div><table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>{lines.map((x, i) => <tr key={i}><td style={{ ...td, fontSize: 12.5 }}>{x.name}</td><td style={{ ...td, ...num }}>{inr(x.v)}</td></tr>)}{extra}</tbody></table></div>;
}
function Col({ title, lines, tail, plug, grand }) {
  return <div>
    <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
    <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
      {lines.map((x, i) => <tr key={i}><td style={td}>{x.name}</td><td style={{ ...td, ...num }}>{inr(x.v)}</td></tr>)}
      {tail}{plug}
      <tr style={{ borderTop: `2px solid ${C.ink}` }}><td style={{ ...td, fontWeight: 700 }}>Total</td><td style={{ ...td, ...num, fontWeight: 700 }}>{inr(grand)}</td></tr>
    </tbody></table>
  </div>;
}
function BalanceSheet({ db, calc, to }) {
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
  let liabTotal = round2(liab.reduce((s, x) => s + x.v, 0) + (np > 0 ? np : 0));
  let assetTotal = round2(assets.reduce((s, x) => s + x.v, 0) + (np < 0 ? -np : 0));
  const diff = round2(liabTotal - assetTotal);
  const grand = Math.max(liabTotal, assetTotal);
  return (
    <Card title="Balance Sheet" right={<Pill tone={Math.abs(diff) < 0.01 ? "ok" : "bad"}>{Math.abs(diff) < 0.01 ? "Balanced" : `Diff ₹${inr(diff)}`}</Pill>}>
      <div className="fb-split" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <Col title="Liabilities" lines={liab} grand={grand} tail={np > 0 ? <tr><td style={{ ...td, color: C.profit }}>Profit & Loss A/c</td><td style={{ ...td, ...num, color: C.profit }}>{inr(np)}</td></tr> : null} plug={diff < -0.005 ? <tr><td style={{ ...td, color: C.loss }}>Difference in Balance Sheet</td><td style={{ ...td, ...num, color: C.loss }}>{inr(-diff)}</td></tr> : null} />
        <Col title="Assets" lines={assets} grand={grand} tail={np < 0 ? <tr><td style={{ ...td, color: C.loss }}>Profit & Loss A/c (Loss)</td><td style={{ ...td, ...num, color: C.loss }}>{inr(-np)}</td></tr> : null} plug={diff > 0.005 ? <tr><td style={{ ...td, color: C.loss }}>Difference in Balance Sheet</td><td style={{ ...td, ...num, color: C.loss }}>{inr(diff)}</td></tr> : null} />
      </div>
      {Math.abs(diff) > 0.005 && <div style={{ marginTop: 10, fontSize: 12, color: C.loss }}>Sheet does not tie — usually an unbalanced opening balance. Fix it in Masters.</div>}
    </Card>
  );
}
function LedgerReport({ db, to }) {
  const [id, setId] = useState(db.ledgers[0]?.id || "");
  const led = db.ledgers.find((l) => l.id === id);
  const opening = led ? (led.drcr === "Cr" ? -1 : 1) * (Number(led.ob) || 0) : 0;
  const entries = [];
  db.vouchers.filter((v) => !to || v.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((v) => v.entries.forEach((e) => { if (e.ledger === id) entries.push({ date: v.date, type: v.type, no: v.no, narr: v.narration, dr: e.dr, cr: e.cr }); }));
  let run = opening;
  return (
    <Card title="Ledger" right={<LedgerPicker db={db} value={id} onChange={setId} />}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={th}>Date</th><th style={th}>Particulars</th><th style={{ ...th, textAlign: "right" }}>Debit</th><th style={{ ...th, textAlign: "right" }}>Credit</th><th style={{ ...th, textAlign: "right" }}>Balance</th></tr></thead>
        <tbody>
          <tr><td style={td} colSpan={4}><i style={{ color: C.sub }}>Opening Balance</i></td><td style={{ ...td, ...num }}>{inr(Math.abs(opening))} {opening >= 0 ? "Dr" : "Cr"}</td></tr>
          {entries.map((e, i) => { run = round2(run + (Number(e.dr) || 0) - (Number(e.cr) || 0)); return <tr key={i}><td style={td}>{e.date}</td><td style={{ ...td, fontSize: 12 }}>{e.type} #{e.no}{e.narr ? ` · ${e.narr}` : ""}</td><td style={{ ...td, ...num }}>{e.dr ? inr(e.dr) : ""}</td><td style={{ ...td, ...num }}>{e.cr ? inr(e.cr) : ""}</td><td style={{ ...td, ...num, color: C.sub }}>{inr(Math.abs(run))} {run >= 0 ? "Dr" : "Cr"}</td></tr>; })}
          <tr style={{ borderTop: `2px solid ${C.ink}` }}><td style={{ ...td, fontWeight: 700 }} colSpan={4}>Closing Balance</td><td style={{ ...td, ...num, fontWeight: 700 }}>{inr(Math.abs(run))} {run >= 0 ? "Dr" : "Cr"}</td></tr>
        </tbody>
      </table>
    </Card>
  );
}

/* =========================================================================
   AUDIT TRAIL  (statutory edit-log spirit)
   ========================================================================= */
function AuditTrail({ db }) {
  return (
    <div>
      <H title="Audit Trail" sub="Immutable log of every create, edit and delete — the edit-log Indian accounting software must retain." />
      <Card title={`${db.audit.length} events`}>
        {db.audit.length === 0 ? <Empty msg="No activity yet." /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Timestamp</th><th style={th}>Action</th><th style={th}>Voucher</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Detail</th></tr></thead>
            <tbody>{db.audit.map((a) => <tr key={a.id}>
              <td style={{ ...td, fontFamily: mono, fontSize: 11.5 }}>{a.ts.replace("T", " ").slice(0, 19)}</td>
              <td style={td}><Pill tone={a.action === "delete" ? "bad" : a.action === "edit" ? "warn" : "ok"}>{a.action}</Pill></td>
              <td style={td}>{a.vtype} #{a.no} · {a.date}</td>
              <td style={{ ...td, ...num }}>{inr(a.amount)}</td>
              <td style={{ ...td, fontSize: 11.5, color: C.sub }}>{a.note ? `${a.note} → ` : ""}{a.detail}</td>
            </tr>)}</tbody>
          </table>}
      </Card>
    </div>
  );
}

/* =========================================================================
   SETTINGS  (company, lock, GST toggle, backup with fallback, reset)
   ========================================================================= */
function SettingsView({ db, save, flash, ui }) {
  const fileRef = useRef();
  const [name, setName] = useState(db.company.name);
  const setCompany = (patch) => save({ ...db, company: { ...db.company, ...patch } });

  const toggleGst = (on) => { let next = { ...db, company: { ...db.company, features: { ...db.company.features, gst: on } } }; if (on) next = ensureGstLedgers(next); save(next); flash(on ? "GST enabled — helper appears on Sales/Purchase, tax ledgers created" : "GST disabled"); };

  const exportJson = async () => {
    const text = JSON.stringify(db, null, 2);
    const filename = `finbuddy-backup-${todayStr()}.json`;
    // On the APK: write a real .json file, then open Android's share sheet so you
    // can save it to Files / Drive / send it to another device.
    if (IS_NATIVE) {
      try {
        const res = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
        await Share.share({ title: "FinBuddy backup", text: "FinBuddy books backup", url: res.uri, dialogTitle: "Save or send your backup" });
        flash("Backup file ready — choose where to save");
        return;
      } catch { /* fall through to copyable text */ }
    } else {
      try { const blob = new Blob([text], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); flash("Backup downloaded"); return; }
      catch { /* fall through */ }
    }
    ui.show({ title: "Backup JSON (copy & save)", node: <BackupText text={text} /> });
  };
  const importJson = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { const d = JSON.parse(r.result); if (d.groups && d.ledgers) { save(migrate(d)); flash("Backup restored"); } else flash("Invalid file"); } catch { flash("Could not parse file"); } }; r.readAsText(f); };
  const reset = async () => { const ok = await ui.confirm({ title: "Reset company", message: "Erase all ledgers, vouchers and audit log, and start a fresh company? Export a backup first.", danger: true, ok: "Erase everything" }); if (ok) { save(seedDb()); flash("Reset done"); } };

  return (
    <div>
      <H title="Settings" sub="All data is stored on this device and autosaves on every change. Uninstalling wipes it — export a JSON backup to move your books to another device." />
      <Card title="Company & financial year">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div><Lbl>Name</Lbl><Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setCompany({ name: name || "My Company" })} style={{ width: 220 }} /></div>
          <div><Lbl>FY start</Lbl><Input type="date" value={db.company.fyStart} onChange={(e) => setCompany({ fyStart: e.target.value })} /></div>
          <div><Lbl>Books beginning</Lbl><Input type="date" value={db.company.booksFrom} onChange={(e) => setCompany({ booksFrom: e.target.value })} /></div>
        </div>
      </Card>
      <Card title="Period lock" right={<Lock size={15} color={C.sub} />}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div><Lbl>Freeze all vouchers on/before</Lbl><Input type="date" value={db.company.lockDate || ""} onChange={(e) => setCompany({ lockDate: e.target.value })} /></div>
          {db.company.lockDate && <Btn size="sm" tone="ghost" onClick={() => setCompany({ lockDate: "" })}>Clear lock</Btn>}
        </div>
        <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>Locked-period vouchers cannot be posted, edited or deleted — use this after finalising/filing a period.</div>
      </Card>
      <Card title="GST (optional)">
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5 }}>
          <input type="checkbox" checked={!!db.company.features?.gst} onChange={(e) => toggleGst(e.target.checked)} />
          Enable GST helper on Sales / Purchase vouchers (auto CGST/SGST/IGST split)
        </label>
        <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>Off by default. Enabling only adds a helper and six tax ledgers; it does not force GST on any voucher.</div>
      </Card>
      <Card title="Backup & data">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn tone="dark" onClick={exportJson}><Download size={15} /> Export JSON</Btn>
          <input ref={fileRef} type="file" accept="application/json" onChange={importJson} style={{ display: "none" }} />
          <Btn tone="ghost" onClick={() => fileRef.current?.click()}><Upload size={15} /> Restore</Btn>
          <Btn tone="danger" onClick={reset}><AlertTriangle size={15} /> Reset company</Btn>
        </div>
        <div style={{ marginTop: 12, fontSize: 12.5, color: C.sub }}>{db.ledgers.length} ledgers · {db.vouchers.length} vouchers · {db.rules.filter((r) => r.ledger).length} rules · {db.audit.length} audit events</div>
      </Card>
    </div>
  );
}
function BackupText({ text }) {
  const ref = useRef();
  return <div>
    <textarea ref={ref} readOnly value={text} style={{ width: "100%", height: 220, fontFamily: mono, fontSize: 11, border: `1px solid ${C.line}`, borderRadius: 8, padding: 8 }} />
    <div style={{ marginTop: 8 }}><Btn size="sm" onClick={() => { ref.current.select(); try { document.execCommand("copy"); } catch { /* best-effort */ } }}>Select & copy</Btn></div>
  </div>;
}
