import { useState, useEffect, useMemo, useRef, useCallback, memo } from "react";
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
import {
  STATEMENT_GROUPS, round2, inr, uid, todayStr, localStamp, isValidDate, fyStartFor, fyLabel,
  seedDb, backupError, migrate, makeCalc, computePL, trialBalance, validateVoucher,
  balanceSheet, ledgerStatement, reportRows, toCsv,
  logEvent, balText, openingLockReason, regroupLockReason, lockLoosens,
  detectDateOrder, autoMap, statementRows, statementClosing, statementOpening, statementStart, addDays, statementEnd, bankDupCounts, findDuplicates, matchRule,
} from "./engine.js";
import { DEMO, KEY } from "./config.js";
import { encryptBackup, decryptBackup, isEncryptedBackup } from "./backupCrypto.js";
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
/* ---------- storage (100% on-device, no cloud / no Claude) ----------
   Primary: Capacitor Preferences → native SharedPreferences on Android,
   localStorage on web. We also mirror to localStorage as a second copy.
   Every add/edit/delete calls persist(), so progress autosaves instantly. */

// Returns the books, null when nothing is stored, or throws when something IS stored but
// cannot be read: starting a fresh company then would overwrite the real books on the next save.
async function loadDb() {
  const stored = [];
  try { const r = await Preferences.get({ key: KEY }); if (r && r.value) stored.push(r.value); } catch { /* storage unavailable */ }
  try { const ls = localStorage.getItem(KEY); if (ls) stored.push(ls); } catch { /* storage unavailable */ }
  for (const text of stored) {
    try { const d = JSON.parse(text); if (!backupError(d)) return migrate(d); } catch { /* try the other copy */ }
  }
  if (stored.length) throw new Error("Saved books on this device could not be read. Nothing has been overwritten.");
  return null;
}
async function demoDb() {
  const m = await import("../docs/demo-books.json");
  return migrate(structuredClone(m.default));
}
// Writes run one after another so an older snapshot can never land after a newer one.
// Resolves to "" on success, or a reason when NEITHER copy could be written.
let writeChain = Promise.resolve("");
function persist(db) {
  const s = JSON.stringify(db);
  writeChain = writeChain.then(async () => {
    let native = false, web = false, why = "";
    try { await Preferences.set({ key: KEY, value: s }); native = true; } catch (e) { why = e?.message || "device storage refused the write"; }
    try { localStorage.setItem(KEY, s); web = true; } catch (e) { why = why || e?.message || "browser storage is full"; }
    return native || web ? "" : why;
  });
  return writeChain;
}
/* Hand a file to the user: Android share sheet on the APK (save to Files / Drive / send),
   a normal download in the browser. Returns false when neither worked. */
async function deliverFile(filename, text, mime, title) {
  if (IS_NATIVE) {
    try {
      const res = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title, text: title, url: res.uri, dialogTitle: `Save or send: ${filename}` });
      return true;
    } catch { return false; }
  }
  try {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000); return true;
  } catch { return false; }
}
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "report";
async function exportCsv(kind, db, calc, opts, flash) {
  const label = { tb: "trial-balance", pl: "profit-loss", bs: "balance-sheet", ledger: `ledger-${slug(db.ledgers.find((l) => l.id === opts.ledgerId)?.name)}`, daybook: "day-book" }[kind];
  const ok = await deliverFile(`${slug(db.company.name)}-${label}-${opts.to || todayStr()}.csv`, toCsv(reportRows(kind, db, calc, opts)), "text/csv", "FinBuddy report");
  flash(ok ? (IS_NATIVE ? "Report ready, choose where to save" : "Report downloaded (opens in Excel)") : "Could not export the report");
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
  const [saveError, setSaveError] = useState("");
  const [loadError, setLoadError] = useState(null);
  const narrow = useNarrow();
  const resolver = useRef(null);
  const dbRef = useRef(null);

  useEffect(() => { loadDb().then(async (d) => setDb(d || (DEMO ? await demoDb() : seedDb())), setLoadError); }, []);
  useEffect(() => { dbRef.current = db; }, [db]);

  // Autosave: write to device storage immediately on every change.
  const save = useCallback((next) => { dbRef.current = next; setDb(next); persist(next).then(setSaveError); }, []);

  // Safety flush when the app is backgrounded or closed (Android minimise / tab hide).
  useEffect(() => {
    const flush = () => { if (dbRef.current) persist(dbRef.current).then(setSaveError); };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", onVis); };
  }, []);
  const flash = useCallback((m) => { setToast(m); setTimeout(() => setToast(null), 2400); }, []);

  const closeModal = useCallback((val) => { const r = resolver.current; resolver.current = null; setModal(null); if (r) r(val); }, []);
  const ui = useMemo(() => ({
    close: closeModal,
    confirm: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "confirm", ...o }); }),
    prompt: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "prompt", value: o.default || "", ...o }); }),
    alert: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "alert", ...o }); }),
    show: (o) => new Promise((res) => { resolver.current = res; setModal({ kind: "content", ...o }); }),
  }), [closeModal]);

  const calc = useMemo(() => (db ? makeCalc(db) : null), [db]);

  // Keyboard shortcuts (F4–F9 pick voucher type on Vouchers tab)
  const [pendingType, setPendingType] = useState(null);
  useEffect(() => {
    const map = { F4: "Contra", F5: "Payment", F6: "Receipt", F7: "Journal", F8: "Sales", F9: "Purchase" };
    const h = (e) => { if (map[e.key]) { e.preventDefault(); setTab("vouchers"); setPendingType(map[e.key]); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (loadError) throw loadError; // ErrorBoundary offers the stored books as a download
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
            FY {fyLabel(fyStartFor(todayStr()))}{db.company.lockDate ? ` · locked ≤ ${db.company.lockDate}` : ""}
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
          {saveError && (
            <div role="alert" style={{ background: "#FBE4E1", color: C.loss, padding: "8px 16px", fontSize: 12.5, display: "flex", gap: 8, alignItems: "center", borderBottom: `1px solid ${C.line}` }}>
              <AlertTriangle size={14} /> <span><b>Not saved.</b> Your last change could not be written to this device ({saveError}). Export a backup from Settings now.</span>
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
            {tab === "reports" && <Reports db={db} calc={calc} flash={flash} />}
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
  const entry = { id: uid(), ts: localStamp(), action, vtype: v.type, no: v.no, date: v.date, amount: round2(v.entries.reduce((s, e) => s + (Number(e.dr) || 0), 0)), note: note || "", detail: v.entries.map((e) => `${e.dr ? "Dr" : "Cr"} ${ledName(db, e.ledger)} ${inr(e.dr || e.cr)}`).join(" · ") };
  return [entry, ...db.audit];
}
const nextNo = (db, type) => db.vouchers.filter((v) => v.type === type).reduce((m, v) => Math.max(m, v.no || 0), 0) + 1;

/* =========================================================================
   DASHBOARD
   ========================================================================= */
function Dashboard({ db, calc, setTab }) {
  const to = todayStr();
  const fy = fyStartFor(to);
  const pl = useMemo(() => computePL(db, calc, fy, to), [db, calc, fy, to]);
  const cash = db.ledgers.filter((l) => l.group === "cash" || l.group === "bank").reduce((s, l) => s + calc.closing(l.id, to), 0);
  const cardDues = db.ledgers.filter((l) => l.group === "card" || l.group === "bankod").reduce((s, l) => s - calc.closing(l.id, to), 0);
  const debtors = db.ledgers.filter((l) => l.group === "debtors").reduce((s, l) => s + calc.closing(l.id, to), 0);
  const creditors = db.ledgers.filter((l) => l.group === "creditors").reduce((s, l) => s + Math.max(0, -calc.closing(l.id, to)), 0);
  const tiles = [
    { label: "Cash & Bank", v: cash, color: C.profit },
    { label: `Net P/(L) FY ${fyLabel(fy)}`, v: pl.netProfit, color: pl.netProfit >= 0 ? C.profit : C.loss, sign: true },
    { label: "Sundry Debtors", v: debtors, color: C.text },
    { label: "Sundry Creditors", v: creditors, color: C.cr },
    ...(db.ledgers.some((l) => l.group === "card" || l.group === "bankod") ? [{ label: "Cards & OD owed", v: cardDues, color: C.cr }] : []),
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
      const nv = { ...old, type, date, narration, entries, no: type === old.type ? old.no : nextNo(db, type) };
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
  const startEdit = useCallback((v) => { setEditingId(v.id); setType(v.type); setDate(v.date); setNarration(v.narration || ""); setRows(v.entries.map((e) => ({ ledger: e.ledger, dr: e.dr || "", cr: e.cr || "" }))); window.scrollTo?.(0, 0); }, []);
  const del = useCallback(async (v) => {
    if (db.company.lockDate && v.date <= db.company.lockDate) return flash("Voucher is in a locked period");
    const ok = await ui.confirm({ title: "Delete voucher", message: `Delete ${v.type} #${v.no} dated ${v.date}? This is logged in the audit trail.`, danger: true, ok: "Delete" });
    if (!ok) return;
    save({ ...db, vouchers: db.vouchers.filter((x) => x.id !== v.id), audit: pushAudit(db, "delete", v) });
    flash("Voucher deleted");
  }, [db, ui, save, flash]);


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

      <DayBook db={db} onEdit={startEdit} onDelete={del} flash={flash} />
    </div>
  );
}

/* Day Book: memoised so typing in the voucher form does not re-render it, and paged so a
   phone never builds thousands of rows at once. */
const PAGE = 100;
const DayBook = memo(function DayBook({ db, onEdit, onDelete, flash }) {
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const list = useMemo(() => {
    const name = new Map(db.ledgers.map((l) => [l.id, l.name]));
    const n = q.trim().toLowerCase();
    const hit = (v) => !n || (v.narration || "").toLowerCase().includes(n) || v.entries.some((e) => (name.get(e.ledger) || "").toLowerCase().includes(n));
    const out = db.vouchers.filter(hit).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.no || 0) - (a.no || 0)));
    return { out, name };
  }, [db, q]);
  const shown = list.out.slice(0, limit);
  return (
    <Card title="Day Book" right={<div style={{ display: "flex", gap: 8, alignItems: "center" }}><Btn size="sm" tone="ghost" onClick={() => exportCsv("daybook", db, null, {}, flash)}><Download size={14} /> CSV</Btn><div style={{ position: "relative" }}><Search size={14} style={{ position: "absolute", left: 8, top: 8, color: C.sub }} /><Input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Search" style={{ paddingLeft: 26, width: 150 }} /></div></div>}>
      {list.out.length === 0 ? <Empty msg="No vouchers match." /> : <>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Date</th><th style={th}>Type · No.</th><th style={th}>Particulars</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={{ ...th, width: 60 }}></th></tr></thead>
          <tbody>
            {shown.map((v) => { const locked = db.company.lockDate && v.date <= db.company.lockDate; return (
              <tr key={v.id}>
                <td style={{ ...td, verticalAlign: "top" }}>{v.date}{locked && <Lock size={11} color={C.sub} style={{ marginLeft: 4 }} />}</td>
                <td style={{ ...td, verticalAlign: "top" }}><Pill>{v.type}</Pill> <span style={{ color: C.sub, fontSize: 12 }}>#{v.no}</span></td>
                <td style={td}>
                  {v.entries.map((e, ix) => <div key={ix} style={{ fontSize: 12.5, color: e.dr ? C.text : C.cr }}>{e.dr ? "Dr " : "   Cr "}{list.name.get(e.ledger) || "—"} <span style={{ ...num, color: C.sub }}>{inr(e.dr || e.cr)}</span></div>)}
                  {v.narration && <div style={{ fontSize: 11.5, color: C.sub, fontStyle: "italic", marginTop: 2 }}>{v.narration}</div>}
                </td>
                <td style={{ ...td, ...num, verticalAlign: "top" }}>{inr(v.entries.reduce((s, e) => s + (Number(e.dr) || 0), 0))}</td>
                <td style={{ ...td, verticalAlign: "top" }}>
                  {!locked && <><button onClick={() => onEdit(v)} style={iconBtn} aria-label={`Edit ${v.type} ${v.no}`}><Pencil size={13} color={C.ink2} /></button><button onClick={() => onDelete(v)} style={iconBtn} aria-label={`Delete ${v.type} ${v.no}`}><Trash2 size={14} color={C.loss} /></button></>}
                </td>
              </tr>); })}
          </tbody>
        </table>
        <MoreRows shown={shown.length} total={list.out.length} onMore={() => setLimit(limit + PAGE * 2)} />
      </>}
    </Card>
  );
});
function MoreRows({ shown, total, onMore }) {
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, fontSize: 12, color: C.sub }}>
    <span>Showing {shown} of {total}</span>
    {shown < total && <Btn size="sm" tone="ghost" onClick={onMore}>Show {Math.min(PAGE * 2, total - shown)} more</Btn>}
  </div>;
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
    // CGST and SGST are each levied at half the rate on the taxable value, so they are always equal.
    const half = round2(t * r / 200), otherHalf = half, tax = inter ? round2(t * r / 100) : round2(half * 2), total = round2(t + tax);
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
function BankImport({ db, calc, save, flash }) {
  const [rawRows, setRawRows] = useState(null);
  const [headerIdx, setHeaderIdx] = useState(0);
  const [map, setMap] = useState({ date: -1, narr: -1, wd: -1, dep: -1, bal: -1, amt: -1, type: -1 });
  const [order, setOrder] = useState("dmy");
  const stmtLedgers = db.ledgers.filter((l) => STATEMENT_GROUPS.has(l.group));
  const [bankLedger, setBankLedger] = useState(stmtLedgers[0]?.id || "");
  const [txns, setTxns] = useState([]);
  const fileRef = useRef();
  const dupCounts = useMemo(() => bankDupCounts(db), [db]);

  const build = (rows, h, m, ord) => setTxns(statementRows(rows, h, m, ord).map((t) => ({ ...t, id: uid(), counter: matchRule(db, t.narr), include: true })));
  const ingest = (rows) => {
    let h = 0;
    for (let i = 0; i < Math.min(rows.length, 30); i++) { const j = rows[i].join(" ").toLowerCase(); if (/date/.test(j) && /(narration|description|particular|withdraw|deposit|debit|credit|amount|balance)/.test(j)) { h = i; break; } }
    const m = autoMap(rows[h] || []);
    const ord = detectDateOrder(m.date >= 0 ? rows.slice(h + 1).map((r) => r[m.date]) : []);
    setRawRows(rows); setHeaderIdx(h); setMap(m); setOrder(ord); build(rows, h, m, ord);
  };
  const onFile = (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; Papa.parse(f, { skipEmptyLines: true, complete: (res) => { if (res.data?.length) ingest(res.data); else flash("Could not read file"); } }); };
  const onPaste = (text) => { const res = Papa.parse(text.trim(), { skipEmptyLines: true }); if (res.data?.length) ingest(res.data); };
  const remap = (f, idx) => { const m = { ...map, [f]: idx }; setMap(m); if (rawRows) build(rawRows, headerIdx, m, order); };
  const setHeader = (idx) => { const m = autoMap(rawRows[idx] || []); setHeaderIdx(idx); setMap(m); build(rawRows, idx, m, order); };
  const changeOrder = (ord) => { setOrder(ord); if (rawRows) build(rawRows, headerIdx, map, ord); };
  const setTxn = (id, patch) => setTxns(txns.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const dups = useMemo(() => findDuplicates(txns, dupCounts, bankLedger), [txns, dupCounts, bankLedger]);
  const badDate = (t) => !isValidDate(t.date);
  const chosen = txns.filter((t) => t.include && t.counter && t.amount > 0 && !dups.has(t.id) && !badDate(t));
  const dupCount = txns.filter((t) => dups.has(t.id)).length;
  const badCount = txns.filter(badDate).length;

  // Reconciliation, as at the statement's last date (later vouchers in the books are not on this statement).
  const stmtClosing = useMemo(() => statementClosing(txns), [txns]);
  const stmtTo = useMemo(() => statementEnd(txns), [txns]);
  const netSelected = chosen.reduce((s, t) => s + (t.dir === "in" ? t.amount : -t.amount), 0);
  const bookAfter = bankLedger && stmtTo ? round2(calc.closing(bankLedger, stmtTo) + netSelected) : null;
  const stmtOpening = useMemo(() => statementOpening(txns), [txns]);
  const stmtFrom = useMemo(() => statementStart(txns), [txns]);
  const bookOpening = bankLedger && stmtFrom ? calc.closing(bankLedger, addDays(stmtFrom, -1)) : null;
  const openingDiff = stmtOpening != null && bookOpening != null ? round2(stmtOpening - bookOpening) : 0;
  const unassigned = txns.filter((t) => t.include && !t.counter && !dups.has(t.id) && !badDate(t)).length;

  const postAll = () => {
    if (!bankLedger) return flash("Pick a bank / card ledger");
    if (!chosen.length) return flash("No rows ready (assign counter ledgers; duplicates and bad dates are skipped)");
    if (db.company.lockDate && chosen.some((t) => t.date <= db.company.lockDate)) return flash(`Some rows fall in the locked period (≤ ${db.company.lockDate})`);
    let counters = {}; db.vouchers.forEach((v) => { counters[v.type] = Math.max(counters[v.type] || 0, v.no || 0); });
    const newV = chosen.map((t) => { const type = t.dir === "in" ? "Receipt" : "Payment"; counters[type] = (counters[type] || 0) + 1;
      const entries = t.dir === "in" ? [{ ledger: bankLedger, dr: t.amount, cr: 0 }, { ledger: t.counter, dr: 0, cr: t.amount }] : [{ ledger: t.counter, dr: t.amount, cr: 0 }, { ledger: bankLedger, dr: 0, cr: t.amount }];
      return { id: uid(), type, date: t.date, no: counters[type], narration: t.narr, entries }; });
    let audit = db.audit; newV.forEach((v) => (audit = pushAudit({ ...db, audit }, "create", v, "bank import")));
    save({ ...db, vouchers: [...db.vouchers, ...newV], audit });
    flash(`${newV.length} vouchers posted${dupCount ? ` · ${dupCount} duplicates skipped` : ""}`);
    const posted = new Set(chosen.map((t) => t.id));
    setTxns(txns.filter((t) => !posted.has(t.id)));
  };

  const cols = map.wd >= 0 || map.dep >= 0 || map.amt < 0
    ? [["date", "Date"], ["narr", "Narration"], ["wd", "Withdrawal (out)"], ["dep", "Deposit (in)"], ["bal", "Balance"], ["amt", "Amount (single column)"]]
    : [["date", "Date"], ["narr", "Narration"], ["amt", "Amount"], ["type", "Dr / Cr column"], ["bal", "Balance"], ["wd", "Withdrawal (out)"], ["dep", "Deposit (in)"]];

  return (
    <div>
      <H title="Bank Import" sub="Bank or credit card statement. Money out → Payment, money in → Receipt. Duplicates are detected and skipped; statement balance is reconciled." />

      <Card title="1 · Load statement">
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
            <Btn tone="dark" onClick={() => fileRef.current?.click()}><Upload size={15} /> Choose CSV</Btn>
            <div style={{ fontSize: 11.5, color: C.sub, marginTop: 6, maxWidth: 230 }}>Metadata rows above the table are auto-skipped. Date format (DD/MM or MM/DD) is detected from the file.</div>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 12, color: C.sub, marginBottom: 4 }}>…or paste CSV / tab-separated rows</div>
            <textarea onBlur={(e) => e.target.value.trim() && onPaste(e.target.value)} placeholder={"Date,Narration,Withdrawal,Deposit,Balance\n05/04/2025,UPI-ZOMATO,450,,12000"} style={{ width: "100%", height: 66, border: `1px solid ${C.line}`, borderRadius: 8, padding: 8, fontFamily: mono, fontSize: 12 }} />
          </div>
        </div>
      </Card>

      {rawRows && (
        <Card title="2 · Map columns" right={<div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}><span style={{ color: C.sub }}>Account</span><Select value={bankLedger} onChange={(e) => setBankLedger(e.target.value)}><option value="">Select…</option>{stmtLedgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></div>}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, fontSize: 12.5, color: C.sub, flexWrap: "wrap" }}>
            Header row:
            <Select value={headerIdx} onChange={(e) => setHeader(Number(e.target.value))} style={{ maxWidth: "100%" }}>{rawRows.slice(0, 30).map((r, i) => <option key={i} value={i}>Row {i + 1}: {r.slice(0, 4).join(" | ").slice(0, 40)}</option>)}</Select>
            Dates:
            <Select value={order} onChange={(e) => changeOrder(e.target.value)}><option value="dmy">DD/MM/YYYY</option><option value="mdy">MM/DD/YYYY</option></Select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
            {cols.map(([f, lbl]) => <div key={f}><Lbl>{lbl}</Lbl><Select value={map[f]} onChange={(e) => remap(f, Number(e.target.value))} style={{ width: "100%" }}><option value={-1}>—</option>{(rawRows[headerIdx] || []).map((h, i) => <option key={i} value={i}>{String(h || `Col ${i + 1}`).slice(0, 24)}</option>)}</Select></div>)}
          </div>
          {stmtLedgers.length === 0 && <div style={{ marginTop: 10, fontSize: 12, color: C.loss }}>No bank or card ledger yet. Create one in Masters under Bank Accounts or Credit Cards.</div>}
        </Card>
      )}

      {txns.length > 0 && (
        <Card title={`3 · Review & assign ledgers (${chosen.length} ready${dupCount ? `, ${dupCount} dup` : ""}${badCount ? `, ${badCount} bad date` : ""})`} right={<Btn onClick={postAll} disabled={!bankLedger || !chosen.length}><Check size={15} /> Post {chosen.length} vouchers</Btn>}>
          {(stmtOpening != null && bookOpening != null) && (
            <div style={{ display: "flex", gap: 16, fontSize: 12.5, marginBottom: 6, padding: "8px 10px", background: C.paper, borderRadius: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>Statement opening: <b style={num}>₹{inr(stmtOpening)}</b></span>
              <span>Books on {addDays(stmtFrom, -1)}: <b style={num}>₹{inr(bookOpening)}</b></span>
              <Pill tone={Math.abs(openingDiff) < 0.01 ? "ok" : "warn"}>{Math.abs(openingDiff) < 0.01 ? "Opening agrees" : `Diff ₹${inr(openingDiff)} from before this statement`}</Pill>
            </div>
          )}
          {(stmtClosing != null && bookAfter != null) && (
            <div style={{ display: "flex", gap: 16, fontSize: 12.5, marginBottom: 10, padding: "8px 10px", background: C.paper, borderRadius: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>Statement closing ({stmtTo}): <b style={num}>₹{inr(stmtClosing)}</b></span>
              <span>Books on {stmtTo} after posting selected: <b style={num}>₹{inr(bookAfter)}</b></span>
              <Pill tone={Math.abs(stmtClosing - bookAfter) < 0.01 ? "ok" : "warn"}>{Math.abs(stmtClosing - bookAfter) < 0.01 ? "Reconciles" : `Diff ₹${inr(stmtClosing - bookAfter)}`}</Pill>
              {unassigned > 0 && Math.abs(stmtClosing - bookAfter) >= 0.01 && <span style={{ color: C.sub }}>{unassigned} line{unassigned > 1 ? "s" : ""} still need a counter ledger</span>}
            </div>
          )}
          {badCount > 0 && <div style={{ fontSize: 12, color: C.loss, marginBottom: 8, display: "flex", gap: 6, alignItems: "center" }}><AlertTriangle size={12} /> {badCount} line{badCount > 1 ? "s have dates" : " has a date"} that could not be read. Check the Date column and the DD/MM setting above; these lines will not post.</div>}
          <div style={{ maxHeight: 340, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={{ ...th, width: 30 }}></th><th style={th}>Date</th><th style={th}>Narration</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Type</th><th style={th}>Counter ledger</th></tr></thead>
              <tbody>
                {txns.map((t) => { const dup = dups.has(t.id), bad = badDate(t); return (
                  <tr key={t.id} style={{ opacity: t.include && !dup && !bad ? 1 : 0.5 }}>
                    <td style={td}><input type="checkbox" aria-label="Include line" checked={t.include && !dup && !bad} disabled={dup || bad} onChange={(e) => setTxn(t.id, { include: e.target.checked })} /></td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: bad ? C.loss : C.text }}>{bad ? (t.rawDate || "no date") : t.date}</td>
                    <td style={{ ...td, maxWidth: 220, fontSize: 12 }}>{t.narr} {dup && <Pill tone="bad">Duplicate</Pill>}{bad && <Pill tone="bad">Bad date</Pill>}</td>
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

/* =========================================================================
   MASTERS
   ========================================================================= */
function Masters({ db, calc, save, flash, ui }) {
  const [sub, setSub] = useState("ledgers");
  const [name, setName] = useState(""); const [group, setGroup] = useState("iexp"); const [ob, setOb] = useState(""); const [drcr, setDrcr] = useState("Dr");
  const addLedger = () => {
    if (!name.trim()) return flash("Enter a ledger name");
    if (db.ledgers.some((l) => l.name.toLowerCase() === name.trim().toLowerCase())) return flash("Ledger already exists");
    const l = { id: uid(), name: name.trim(), group, ob: round2(Number(ob) || 0), drcr };
    save({ ...db, ledgers: [...db.ledgers, l], audit: logEvent(db, "create", `Ledger: ${l.name}`, `Under ${grpName(db, group)}${l.ob ? `, opening ${balText(l.ob, drcr)}` : ""}`) });
    setName(""); setOb(""); flash("Ledger created");
  };
  const delLedger = async (l) => {
    if (db.vouchers.some((v) => v.entries.some((e) => e.ledger === l.id))) return flash("Ledger is used in vouchers — cannot delete");
    const rules = db.rules.filter((r) => r.ledger === l.id).length;
    const ok = await ui.confirm({ title: "Delete ledger", message: `Delete "${l.name}"?${rules ? ` ${rules} auto-rule${rules > 1 ? "s" : ""} posting to it will be removed too.` : ""}`, danger: true, ok: "Delete" }); if (!ok) return;
    save({ ...db, ledgers: db.ledgers.filter((x) => x.id !== l.id), rules: db.rules.filter((r) => r.ledger !== l.id), audit: logEvent(db, "delete", `Ledger: ${l.name}`, `Was under ${grpName(db, l.group)}${l.ob ? `, opening ${balText(l.ob, l.drcr)}` : ""}${rules ? `; ${rules} auto-rule${rules > 1 ? "s" : ""} removed` : ""}`) });
  };
  const editOb = async (l) => {
    const locked = openingLockReason(db); if (locked) return ui.alert({ title: "Opening balance locked", message: locked });
    const val = await ui.prompt({ title: "Opening balance", message: `${l.name}: enter opening balance (negative = Cr)`, default: String((l.drcr === "Cr" ? -1 : 1) * (l.ob || 0)) });
    if (val == null) return;
    const n = Number(String(val).replace(/[,\s₹]/g, ""));
    if (!isFinite(n)) return flash("Enter a number, e.g. 25000 or -25000");
    const nb = round2(n), next = { ob: Math.abs(nb), drcr: nb < 0 ? "Cr" : "Dr" };
    if (next.ob === round2(Number(l.ob) || 0) && (next.drcr === l.drcr || !next.ob)) return;
    save({ ...db, ledgers: db.ledgers.map((x) => (x.id === l.id ? { ...x, ...next } : x)), audit: logEvent(db, "edit", `Ledger: ${l.name}`, `Opening ${balText(l.ob, l.drcr)} → ${balText(next.ob, next.drcr)}`) });
  };
  const editLedger = (l) => ui.show({ title: "Edit ledger", node: <LedgerEditor db={db} ledger={l} onDone={(patch) => {
    ui.close();
    if (!patch) return;
    const changes = [];
    if (patch.name !== l.name) changes.push(`Renamed "${l.name}" → "${patch.name}"`);
    if (patch.group !== l.group) changes.push(`Moved ${grpName(db, l.group)} → ${grpName(db, patch.group)}`);
    if (!changes.length) return;
    save({ ...db, ledgers: db.ledgers.map((x) => (x.id === l.id ? { ...x, ...patch } : x)), audit: logEvent(db, "edit", `Ledger: ${patch.name}`, changes.join("; ")) });
    flash("Ledger updated");
  }} /> });
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
                  <td style={{ ...td, width: 60, whiteSpace: "nowrap" }}><button onClick={() => editLedger(l)} style={iconBtn} aria-label={`Edit ${l.name}`} title="Rename / change group"><Pencil size={13} color={C.ink2} /></button><button onClick={() => delLedger(l)} style={iconBtn} aria-label={`Delete ${l.name}`}><Trash2 size={13} color={C.loss} /></button></td>
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
function grpName(db, id) { return db.groups.find((g) => g.id === id)?.name || "—"; }
function LedgerEditor({ db, ledger, onDone }) {
  const [name, setName] = useState(ledger.name);
  const [group, setGroup] = useState(ledger.group);
  const lockReason = regroupLockReason(db, ledger);
  const n = name.trim();
  const clash = db.ledgers.some((x) => x.id !== ledger.id && x.name.toLowerCase() === n.toLowerCase());
  const err = !n ? "Enter a name" : clash ? "Another ledger already has this name" : "";
  return <div>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div><Lbl>Name</Lbl><Input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 220 }} autoFocus /></div>
      <div><Lbl>Under group</Lbl><Select value={group} onChange={(e) => setGroup(e.target.value)} style={{ maxWidth: 220 }}>{(lockReason ? db.groups.filter((g) => g.id === ledger.group) : db.groups).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></div>
    </div>
    {lockReason && <div style={{ fontSize: 12, color: "#8A5A00", marginTop: 8 }}>{lockReason}</div>}
    {err && <div style={{ fontSize: 12, color: C.loss, marginTop: 8 }}>{err}</div>}
    <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>Existing vouchers follow the ledger automatically. The change is recorded in the audit trail.</div>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
      <Btn tone="ghost" size="sm" onClick={() => onDone(null)}>Cancel</Btn>
      <Btn size="sm" disabled={!!err} onClick={() => onDone({ name: n, group })}>Save</Btn>
    </div>
  </div>;
}
function RulesEditor({ db, save, flash }) {
  const [kw, setKw] = useState(""); const [led, setLed] = useState("");
  const add = () => {
    if (!kw.trim() || !led) return flash("Enter keyword and ledger");
    const r = { id: uid(), kw: kw.trim().toLowerCase(), ledger: led };
    save({ ...db, rules: [...db.rules, r], audit: logEvent(db, "create", "Auto-rule", `"${r.kw}" → ${ledName(db, led)}`) }); setKw(""); setLed(""); flash("Rule added");
  };
  const del = (id) => { const r = db.rules.find((x) => x.id === id); save({ ...db, rules: db.rules.filter((x) => x.id !== id), audit: logEvent(db, "delete", "Auto-rule", `"${r?.kw}" → ${ledName(db, r?.ledger)}`) }); };
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
function Reports({ db, calc, flash }) {
  const [rep, setRep] = useState("tb");
  const [from, setFrom] = useState(() => fyStartFor(todayStr()));
  const [to, setTo] = useState(() => todayStr());
  const [ledgerId, setLedgerId] = useState(db.ledgers[0]?.id || "");
  return (
    <div>
      <H title="Reports" sub="Computed live. Profit & Loss is period-bound; Balance Sheet and Trial Balance are as-at the To date." />
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        {[["tb", "Trial Balance"], ["pl", "Profit & Loss"], ["bs", "Balance Sheet"], ["ledger", "Ledger"]].map(([id, l]) => <button key={id} onClick={() => setRep(id)} style={{ padding: "6px 14px", borderRadius: 20, border: `1px solid ${rep === id ? C.gold : C.line}`, background: rep === id ? C.goldSoft : "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", color: C.text }}>{l}</button>)}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: C.sub }}>
          {rep === "pl" && <>From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></>}
          {rep === "pl" ? "To" : "As on"} <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Btn size="sm" tone="ghost" onClick={() => exportCsv(rep, db, calc, { from, to, ledgerId }, flash)}><Download size={14} /> Excel / CSV</Btn>
        </div>
      </div>
      {rep === "tb" && <TrialBalance db={db} calc={calc} to={to} />}
      {rep === "pl" && <ProfitLoss db={db} calc={calc} from={from} to={to} />}
      {rep === "bs" && <BalanceSheet db={db} calc={calc} to={to} />}
      {rep === "ledger" && <LedgerReport db={db} to={to} id={ledgerId} setId={setLedgerId} />}
    </div>
  );
}
function TrialBalance({ db, calc, to }) {
  const { rows, dr, cr, fy } = useMemo(() => trialBalance(db, calc, to), [db, calc, to]);
  return (
    <Card title={`Trial Balance as on ${to}`} right={<Pill tone={Math.abs(dr - cr) < 0.01 ? "ok" : "bad"}>{Math.abs(dr - cr) < 0.01 ? "Balanced" : `Diff ₹${inr(dr - cr)}`}</Pill>}>
      <div style={{ fontSize: 12, color: C.sub, marginBottom: 8 }}>Income and expense ledgers show FY {fyLabel(fy)} only; earlier years are carried in Profit &amp; Loss A/c (b/f).</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={th}>Ledger</th><th style={th}>Group</th><th style={{ ...th, textAlign: "right" }}>Debit</th><th style={{ ...th, textAlign: "right" }}>Credit</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}><td style={td}>{r.name}</td><td style={{ ...td, color: C.sub, fontSize: 12 }}>{r.group}</td><td style={{ ...td, ...num }}>{r.bal > 0 ? inr(r.bal) : ""}</td><td style={{ ...td, ...num }}>{r.bal < 0 ? inr(-r.bal) : ""}</td></tr>)}
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
  const { liab, assets, np, diff, grand } = useMemo(() => balanceSheet(db, calc, to), [db, calc, to]);
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
function LedgerReport({ db, to, id, setId }) {
  const { opening, rows: entries, closing: run } = useMemo(() => ledgerStatement(db, id, to), [db, id, to]);
  return (
    <Card title="Ledger" right={<LedgerPicker db={db} value={id} onChange={setId} />}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><th style={th}>Date</th><th style={th}>Particulars</th><th style={{ ...th, textAlign: "right" }}>Debit</th><th style={{ ...th, textAlign: "right" }}>Credit</th><th style={{ ...th, textAlign: "right" }}>Balance</th></tr></thead>
        <tbody>
          <tr><td style={td} colSpan={4}><i style={{ color: C.sub }}>Opening Balance</i></td><td style={{ ...td, ...num }}>{inr(Math.abs(opening))} {opening >= 0 ? "Dr" : "Cr"}</td></tr>
          {entries.map((e, i) => <tr key={i}><td style={td}>{e.date}</td><td style={{ ...td, fontSize: 12 }}>{e.type} #{e.no}{e.narr ? ` · ${e.narr}` : ""}</td><td style={{ ...td, ...num }}>{e.dr ? inr(e.dr) : ""}</td><td style={{ ...td, ...num }}>{e.cr ? inr(e.cr) : ""}</td><td style={{ ...td, ...num, color: C.sub }}>{inr(Math.abs(e.bal))} {e.bal >= 0 ? "Dr" : "Cr"}</td></tr>)}
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
  const [limit, setLimit] = useState(PAGE);
  return (
    <div>
      <H title="Audit Trail" sub="Every voucher create, edit and delete, and every change to ledgers, opening balances, rules, period lock and settings. Never truncated." />
      <Card title={`${db.audit.length} events`}>
        {db.audit.length === 0 ? <Empty msg="No activity yet." /> :
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>Timestamp</th><th style={th}>Action</th><th style={th}>What</th><th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>Detail</th></tr></thead>
            <tbody>{db.audit.slice(0, limit).map((a) => <tr key={a.id}>
              <td style={{ ...td, fontFamily: mono, fontSize: 11.5 }}>{a.ts.includes("T") ? localStamp(new Date(a.ts)) : a.ts}</td>
              <td style={td}><Pill tone={a.action === "delete" ? "bad" : a.action === "edit" ? "warn" : "ok"}>{a.action}</Pill></td>
              <td style={td}>{a.kind === "master" ? a.subject : `${a.vtype} #${a.no} · ${a.date}`}</td>
              <td style={{ ...td, ...num }}>{a.kind === "master" ? "" : inr(a.amount)}</td>
              <td style={{ ...td, fontSize: 11.5, color: C.sub }}>{a.note ? `${a.note} → ` : ""}{a.detail}</td>
            </tr>)}</tbody>
          </table>}
        {db.audit.length > 0 && <MoreRows shown={Math.min(limit, db.audit.length)} total={db.audit.length} onMore={() => setLimit(limit + PAGE * 2)} />}
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
  const setCompany = (patch, subject, detail) => save({ ...db, company: { ...db.company, ...patch }, audit: logEvent(db, "edit", subject, detail) });
  const setLock = async (next) => {
    const old = db.company.lockDate || "";
    if (next === old) return;
    if (lockLoosens(old, next)) {
      const ok = await ui.confirm({ title: next ? "Move period lock earlier" : "Clear period lock", message: `This reopens ${next ? `${next} to ${old}` : `everything up to ${old}`} for posting, editing and deleting. The change is recorded in the audit trail.`, danger: true, ok: next ? "Move lock" : "Clear lock" });
      if (!ok) return;
    }
    setCompany({ lockDate: next }, "Period lock", `${old ? `Locked up to ${old}` : "No lock"} → ${next ? `locked up to ${next}` : "no lock"}`);
  };
  const setBooksFrom = (next) => { const old = db.company.booksFrom || ""; if (next && next !== old) setCompany({ booksFrom: next }, "Books beginning", `${old || "not set"} → ${next}`); };

  const toggleGst = (on) => { let next = { ...db, company: { ...db.company, features: { ...db.company.features, gst: on } }, audit: logEvent(db, "edit", "GST helper", on ? "Enabled" : "Disabled") }; if (on) next = ensureGstLedgers(next); save(next); flash(on ? "GST enabled — helper appears on Sales/Purchase, tax ledgers created" : "GST disabled"); };

  const exportEncrypted = async () => {
    const pass = await ui.show({ title: "Encrypted backup", node: <PassphraseForm confirm onDone={ui.close} /> });
    if (!pass) return;
    flash("Encrypting…");
    const box = await encryptBackup(JSON.stringify(db), pass);
    const ok = await deliverFile(`finbuddy-backup-${todayStr()}-encrypted.json`, JSON.stringify(box), "application/json", "FinBuddy encrypted backup");
    flash(ok ? (IS_NATIVE ? "Encrypted backup ready, choose where to save" : "Encrypted backup downloaded") : "Could not save the backup");
  };
  const exportJson = async () => {
    const text = JSON.stringify(db, null, 2);
    const filename = `finbuddy-backup-${todayStr()}.json`;
    if (await deliverFile(filename, text, "application/json", "FinBuddy books backup")) return flash(IS_NATIVE ? "Backup file ready, choose where to save" : "Backup downloaded");
    ui.show({ title: "Backup JSON (copy & save)", node: <BackupText text={text} /> });
  };
  const importJson = (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      let d; try { d = JSON.parse(r.result); } catch { return ui.alert({ title: "Restore failed", message: "This file is not valid JSON. Your books were not changed." }); }
      if (isEncryptedBackup(d)) {
        const pass = await ui.show({ title: "Encrypted backup", node: <PassphraseForm onDone={ui.close} /> });
        if (!pass) return;
        try { d = JSON.parse(await decryptBackup(d, pass)); }
        catch (err) { return ui.alert({ title: "Restore failed", message: `${err.message}. Your books were not changed.` }); }
      }
      const why = backupError(d);
      if (why) return ui.alert({ title: "Restore failed", message: `${why}. Your books were not changed.` });
      const ok = await ui.confirm({ title: "Restore backup", message: `Replace your current books (${db.vouchers.length} vouchers) with this backup (${(d.vouchers || []).length} vouchers, ${d.company?.name || "unnamed"})? Export a backup of the current books first if you may need them.`, danger: true, ok: "Replace books" });
      if (!ok) return;
      const restored = migrate(d);
      restored.audit = logEvent(restored, "edit", "Books restored", `From backup file ${f.name} (${restored.vouchers.length} vouchers). Replaced books had ${db.vouchers.length} vouchers.`);
      save(restored); flash("Backup restored");
    };
    r.readAsText(f);
  };
  const reset = async () => { const ok = await ui.confirm({ title: "Reset company", message: "Erase all ledgers, vouchers and audit log, and start a fresh company? Export a backup first.", danger: true, ok: "Erase everything" }); if (ok) { const fresh = seedDb(); fresh.audit = logEvent(fresh, "delete", "Company reset", `Previous books "${db.company.name}" had ${db.vouchers.length} vouchers and ${db.ledgers.length} ledgers`); save(fresh); flash("Reset done"); } };

  return (
    <div>
      <H title="Settings" sub="All data is stored on this device and autosaves on every change. Uninstalling wipes it, so keep an encrypted backup somewhere safe (Drive, email to yourself) and use it to move your books to another device." />
      <Card title="Company & financial year">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div><Lbl>Name</Lbl><Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { const n = name.trim() || "My Company"; if (n !== db.company.name) setCompany({ name: n }, "Company name", `"${db.company.name}" → "${n}"`); }} style={{ width: 220 }} /></div>
          <div><Lbl>Books beginning</Lbl><Input type="date" value={db.company.booksFrom} onChange={(e) => setBooksFrom(e.target.value)} /></div>
        </div>
        <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>Financial year runs April to March and moves to the new year by itself on 1 April. Current: FY {fyLabel(fyStartFor(todayStr()))}.</div>
      </Card>
      <Card title="Period lock" right={<Lock size={15} color={C.sub} />}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div><Lbl>Freeze all vouchers on/before</Lbl><Input type="date" value={db.company.lockDate || ""} onChange={(e) => setLock(e.target.value)} /></div>
          {db.company.lockDate && <Btn size="sm" tone="ghost" onClick={() => setLock("")}>Clear lock</Btn>}
        </div>
        <div style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>Locked-period vouchers cannot be posted, edited or deleted, and opening balances cannot change. Use this after finalising or filing a period. Clearing or moving the lock earlier asks first and is logged.</div>
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
          <Btn tone="dark" onClick={exportEncrypted}><Lock size={15} /> Encrypted backup</Btn>
          <Btn tone="ghost" onClick={exportJson}><Download size={15} /> Plain JSON</Btn>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={importJson} style={{ display: "none" }} />
          <Btn tone="ghost" onClick={() => fileRef.current?.click()}><Upload size={15} /> Restore</Btn>
          <Btn tone="danger" onClick={reset}><AlertTriangle size={15} /> Reset company</Btn>
        </div>
        <div style={{ marginTop: 12, fontSize: 12.5, color: C.sub }}>{db.ledgers.length} ledgers · {db.vouchers.length} vouchers · {db.rules.filter((r) => r.ledger).length} rules · {db.audit.length} audit events</div>
      </Card>
    </div>
  );
}
function PassphraseForm({ confirm, onDone }) {
  const [p1, setP1] = useState(""); const [p2, setP2] = useState("");
  const err = !p1 ? "" : confirm && p1.length < 8 ? "Use at least 8 characters" : confirm && p2 && p1 !== p2 ? "Passphrases do not match" : "";
  const ready = p1 && !err && (!confirm || p1 === p2);
  const submit = () => ready && onDone(p1);
  return <div>
    <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5, marginBottom: 10 }}>{confirm ? "Choose a passphrase. It is never stored: without it this backup cannot be opened by anyone, including you." : "Enter the passphrase this backup was made with."}</div>
    <Lbl>Passphrase</Lbl><Input type="password" autoFocus value={p1} onChange={(e) => setP1(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={{ width: "100%" }} />
    {confirm && <div style={{ marginTop: 8 }}><Lbl>Repeat passphrase</Lbl><Input type="password" value={p2} onChange={(e) => setP2(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} style={{ width: "100%" }} /></div>}
    {err && <div style={{ fontSize: 12, color: C.loss, marginTop: 8 }}>{err}</div>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
      <Btn tone="ghost" size="sm" onClick={() => onDone(null)}>Cancel</Btn>
      <Btn size="sm" disabled={!ready} onClick={submit}>{confirm ? "Encrypt & save" : "Unlock"}</Btn>
    </div>
  </div>;
}
function BackupText({ text }) {
  const ref = useRef();
  return <div>
    <textarea ref={ref} readOnly value={text} style={{ width: "100%", height: 220, fontFamily: mono, fontSize: 11, border: `1px solid ${C.line}`, borderRadius: 8, padding: 8 }} />
    <div style={{ marginTop: 8 }}><Btn size="sm" onClick={() => { ref.current.select(); try { document.execCommand("copy"); } catch { /* best-effort */ } }}>Select & copy</Btn></div>
  </div>;
}
