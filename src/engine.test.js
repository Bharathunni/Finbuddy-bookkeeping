import { describe, it, expect } from "vitest";
import {
  round2, todayStr, isValidDate, fyStartFor, seedDb, migrate, backupError, makeCalc, computePL,
  cumulativeProfit, trialBalance, validateVoucher, parseNum, normDate, detectDateOrder, autoMap,
  statementRows, statementClosing, statementOpening, bankDupCounts, findDuplicates, matchRule,
} from "./engine.js";

const books = () => {
  const db = seedDb("2026-06-15");
  const id = (n) => db.ledgers.find((l) => l.name === n).id;
  return { db, id };
};
const v = (type, date, entries, narration = "") => ({ id: Math.random().toString(36).slice(2), type, date, no: 1, narration, entries });

describe("dates", () => {
  it("today is the local calendar date, not UTC", () => {
    // 00:30 IST on 27 Oct is 19:00 UTC on 26 Oct; a user in India must see the 27th.
    const d = new Date(2026, 9, 27, 0, 30);
    expect(todayStr(d)).toBe("2026-10-27");
  });
  it("validates real calendar dates", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2025-13-04")).toBe(false);
    expect(isValidDate("05 April 2025")).toBe(false);
  });
  it("financial year runs April to March", () => {
    expect(fyStartFor("2026-03-31")).toBe("2025-04-01");
    expect(fyStartFor("2026-04-01")).toBe("2026-04-01");
  });
});

describe("statement date parsing", () => {
  it.each([
    ["05/04/2025", "2025-04-05"], ["5-4-25", "2025-04-05"], ["2025-04-05 10:00", "2025-04-05"],
    ["05-Apr-2025", "2025-04-05"], ["05 April 2025", "2025-04-05"], ["05-Sept-2025", "2025-09-05"],
    ["05Apr25", "2025-04-05"], ["Apr 5, 2025", "2025-04-05"],
  ])("%s -> %s", (s, want) => expect(normDate(s)).toBe(want));
  it("rejects what it cannot read instead of guessing", () => {
    expect(normDate("04/13/2025")).toBe(""); // not a DD/MM date
    expect(normDate("5-Abc-25")).toBe(""); // used to become January
    expect(normDate("Opening balance")).toBe("");
  });
  it("detects MM/DD files and parses them", () => {
    const order = detectDateOrder(["04/03/2025", "04/13/2025"]);
    expect(order).toBe("mdy");
    expect(normDate("04/13/2025", order)).toBe("2025-04-13");
    expect(detectDateOrder(["13/04/2025", "04/03/2025"])).toBe("dmy");
  });
});

describe("statement amounts", () => {
  it("reads signs the way banks print them", () => {
    expect(parseNum("(1,234.50)")).toBe(-1234.5);
    expect(parseNum("1,234.56 Dr")).toBe(-1234.56);
    expect(parseNum("1,234.56 Cr")).toBe(1234.56);
    expect(parseNum("₹ 1,00,000.00")).toBe(100000);
    expect(parseNum("")).toBe(0);
  });
  it("supports a single Amount column with a Dr/Cr indicator", () => {
    const rows = [["Tran Date", "Particulars", "Amount", "Dr/Cr", "Balance"], ["01-04-2025", "SALARY", "50,000.00", "CR", "60,000.00"], ["02-04-2025", "RENT", "15,000.00", "DR", "45,000.00"]];
    const m = autoMap(rows[0]);
    const t = statementRows(rows, 0, m);
    expect(t.map((x) => [x.date, x.dir, x.amount])).toEqual([["2025-04-01", "in", 50000], ["2025-04-02", "out", 15000]]);
  });
  it("supports a signed Amount column (card statements)", () => {
    const rows = [["Date", "Description", "Amount"], ["03/04/2025", "AMAZON", "-2,499.00"], ["04/04/2025", "PAYMENT RECEIVED", "10,000.00"]];
    const t = statementRows(rows, 0, autoMap(rows[0]));
    expect(t.map((x) => [x.dir, x.amount])).toEqual([["out", 2499], ["in", 10000]]);
  });
  it("takes closing balance from the latest row whichever way the file is sorted", () => {
    const asc = [{ date: "2025-04-01", bal: 100 }, { date: "2025-04-30", bal: 900 }];
    expect(statementClosing(asc)).toBe(900);
    expect(statementClosing([...asc].reverse())).toBe(900);
  });
  it("derives the opening balance from the earliest row", () => {
    const asc = [{ date: "2025-04-01", dir: "out", amount: 100, bal: 900 }, { date: "2025-04-30", dir: "in", amount: 50, bal: 950 }];
    expect(statementOpening(asc)).toBe(1000);
    expect(statementOpening([...asc].reverse())).toBe(1000);
  });
});

describe("duplicate detection", () => {
  it("two identical statement lines with only one in the books leaves one to post", () => {
    const { db, id } = books();
    db.vouchers.push(v("Payment", "2026-05-01", [{ ledger: id("Cash"), dr: 2000, cr: 0 }, { ledger: id("HDFC Bank"), dr: 0, cr: 2000 }], "ATM WDL"));
    const txns = [{ id: "a", date: "2026-05-01", amount: 2000, narr: "ATM WDL" }, { id: "b", date: "2026-05-01", amount: 2000, narr: "ATM WDL" }];
    const dups = findDuplicates(txns, bankDupCounts(db), id("HDFC Bank"));
    expect([...dups]).toEqual(["a"]);
  });
  it("re-importing the same file flags every line", () => {
    const { db, id } = books();
    const narr = ["UPI-A", "UPI-A", "NEFT-B"];
    narr.forEach((n) => db.vouchers.push(v("Payment", "2026-05-01", [{ ledger: id("Rent"), dr: 500, cr: 0 }, { ledger: id("HDFC Bank"), dr: 0, cr: 500 }], n)));
    const txns = narr.map((n, i) => ({ id: String(i), date: "2026-05-01", amount: 500, narr: n }));
    expect(findDuplicates(txns, bankDupCounts(db), id("HDFC Bank")).size).toBe(3);
  });
});

describe("rules", () => {
  it("ignores a rule whose ledger was deleted", () => {
    const { db, id } = books();
    db.rules = [{ id: "r1", kw: "rent", ledger: "deleted" }, { id: "r2", kw: "rent", ledger: id("Rent") }];
    expect(matchRule(db, "NEFT RENT MAY")).toBe(id("Rent"));
    db.rules = [{ id: "r1", kw: "rent", ledger: "deleted" }];
    expect(matchRule(db, "NEFT RENT MAY")).toBe("");
  });
});

describe("backup restore", () => {
  it("rejects files that would crash the app", () => {
    expect(backupError(null)).not.toBe("");
    expect(backupError({ groups: [], ledgers: [], vouchers: "x" })).not.toBe("");
    expect(backupError({ groups: [], ledgers: [{ id: "a", name: "A" }], vouchers: [{ date: "2026-01-01" }] })).not.toBe("");
    expect(backupError(seedDb())).toBe("");
  });
  it("migrate fills every list the engine iterates", () => {
    const db = migrate({ groups: seedDb().groups.filter((g) => g.id !== "card"), ledgers: [] });
    expect(db.vouchers).toEqual([]); expect(db.rules).toEqual([]); expect(db.audit).toEqual([]);
    expect(db.groups.some((g) => g.id === "card")).toBe(true);
    expect(() => makeCalc(db)).not.toThrow();
  });
});

describe("voucher validation", () => {
  it("refuses a line with an amount but no ledger instead of dropping it", () => {
    const { db, id } = books();
    const r = validateVoucher(db, "Payment", "2026-06-01", [{ ledger: id("Rent"), dr: 1000 }, { ledger: id("Cash"), cr: 1000 }, { ledger: "", dr: 500 }], "", "", "2026-06-15");
    expect(r.balanced).toBe(false);
  });
  it("refuses an invalid date", () => {
    const { db, id } = books();
    expect(validateVoucher(db, "Payment", "", [{ ledger: id("Rent"), dr: 1 }, { ledger: id("Cash"), cr: 1 }], "", "", "2026-06-15").balanced).toBe(false);
  });
  it("allows a credit card in Contra (paying the card bill from bank)", () => {
    const { db, id } = books();
    db.ledgers.push({ id: "card1", name: "HDFC Credit Card", group: "card", ob: 0, drcr: "Cr" });
    expect(validateVoucher(db, "Contra", "2026-06-01", [{ ledger: "card1", dr: 1 }, { ledger: id("HDFC Bank"), cr: 1 }], "", "", "2026-06-15").err).toEqual([]);
  });
});

describe("reports", () => {
  it("balance sheet ties when an expense ledger has an opening balance (mid-year switch)", () => {
    const { db, id } = books();
    db.company.booksFrom = "2026-04-01";
    db.ledgers.find((l) => l.name === "Rent").ob = 50000;
    db.ledgers.find((l) => l.name === "Capital A/c").ob = 50000;
    const calc = makeCalc(db);
    expect(calc.openingImbalance).toBe(0);
    expect(cumulativeProfit(db, calc, "2027-03-31")).toBe(-50000);
    expect(computePL(db, calc, "2026-04-01", "2027-03-31").netProfit).toBe(-50000);
    expect(computePL(db, calc, "2027-04-01", "2028-03-31").netProfit).toBe(0); // counts in one year only
    void id;
  });
  it("trial balance shows only the current year's income and expenses, with earlier years b/f", () => {
    const { db, id } = books();
    db.company.booksFrom = "2025-04-01";
    db.vouchers.push(v("Payment", "2025-05-01", [{ ledger: id("Rent"), dr: 10000, cr: 0 }, { ledger: id("Cash"), dr: 0, cr: 10000 }]));
    db.vouchers.push(v("Payment", "2026-05-01", [{ ledger: id("Rent"), dr: 12000, cr: 0 }, { ledger: id("Cash"), dr: 0, cr: 12000 }]));
    const tb = trialBalance(db, makeCalc(db), "2027-03-31");
    const row = (n) => tb.rows.find((r) => r.name === n)?.bal;
    expect(row("Rent")).toBe(12000);
    expect(row("Profit & Loss A/c (b/f)")).toBe(10000); // last year's loss, Dr
    expect(row("Cash")).toBe(-22000);
    expect(round2(tb.dr - tb.cr)).toBe(0);
  });
});

describe("audit and lock over masters", async () => {
  const { logEvent, openingLockReason, regroupLockReason, lockLoosens } = await import("./engine.js");
  it("logs master events newest first without dropping earlier ones", () => {
    const { db } = books();
    db.audit = Array.from({ length: 900 }, (_, i) => ({ id: String(i) }));
    const a = logEvent(db, "edit", "Ledger: Rent", "Opening 0.00 Dr → 5,000.00 Dr", new Date(2026, 9, 27, 9, 5, 7));
    expect(a).toHaveLength(901);
    expect(a[0]).toMatchObject({ kind: "master", action: "edit", subject: "Ledger: Rent", ts: "2026-10-27 09:05:07" });
  });
  it("blocks opening balance edits while a lock is set", () => {
    const { db } = books();
    expect(openingLockReason(db)).toBe("");
    db.company.lockDate = "2026-06-30";
    expect(openingLockReason(db)).not.toBe("");
  });
  it("blocks regrouping a ledger that has entries in the locked period", () => {
    const { db, id } = books();
    db.company.lockDate = "2026-06-30";
    const rent = db.ledgers.find((l) => l.name === "Rent");
    expect(regroupLockReason(db, rent)).toBe("");
    db.vouchers.push(v("Payment", "2026-07-01", [{ ledger: id("Rent"), dr: 1, cr: 0 }, { ledger: id("Cash"), dr: 0, cr: 1 }]));
    expect(regroupLockReason(db, rent)).toBe(""); // after the lock: fine
    db.vouchers.push(v("Payment", "2026-06-01", [{ ledger: id("Rent"), dr: 1, cr: 0 }, { ledger: id("Cash"), dr: 0, cr: 1 }]));
    expect(regroupLockReason(db, rent)).not.toBe("");
  });
  it("treats clearing or moving the lock earlier as loosening", () => {
    expect(lockLoosens("2026-06-30", "")).toBe(true);
    expect(lockLoosens("2026-06-30", "2026-03-31")).toBe(true);
    expect(lockLoosens("2026-06-30", "2026-09-30")).toBe(false);
    expect(lockLoosens("", "2026-06-30")).toBe(false);
  });
});

describe("CSV export", async () => {
  const { toCsv, reportRows, balanceSheet, ledgerStatement } = await import("./engine.js");
  it("escapes commas, quotes and formula-like text", () => {
    const csv = toCsv([["a,b", 'say "hi"', "=HYPERLINK(1)", "-500.00", "plain"]]);
    expect(csv).toBe('﻿"a,b","say ""hi""","=HYPERLINK(1)",-500.00,plain\r\n');
  });
  it("exports reports whose totals match the on-screen engine", () => {
    const { db, id } = books();
    db.ledgers.find((l) => l.name === "Capital A/c").ob = 100000;
    db.ledgers.find((l) => l.name === "HDFC Bank").ob = 100000;
    db.vouchers.push(v("Payment", "2026-05-01", [{ ledger: id("Rent"), dr: 12000, cr: 0 }, { ledger: id("HDFC Bank"), dr: 0, cr: 12000 }], "Rent, May"));
    const calc = makeCalc(db);
    const tb = reportRows("tb", db, calc, { to: "2026-06-30" });
    expect(tb.at(-1)).toEqual(["Total", "", "100000.00", "100000.00"]);
    expect(balanceSheet(db, calc, "2026-06-30").diff).toBe(0);
    const bs = reportRows("bs", db, calc, { to: "2026-06-30" });
    expect(bs.find((r) => r[0] === "Assets" && r[1].startsWith("Profit"))).toEqual(["Assets", "Profit & Loss A/c (Loss)", "12000.00"]);
    expect(ledgerStatement(db, id("HDFC Bank"), "2026-06-30").closing).toBe(88000);
    const lr = reportRows("ledger", db, calc, { to: "2026-06-30", ledgerId: id("HDFC Bank") });
    expect(lr.at(-1)).toEqual(["", "Closing Balance", "", "", "", "", "88000.00", "Dr"]);
    const dbk = reportRows("daybook", db, calc, {});
    expect(dbk.slice(-2)).toEqual([["2026-05-01", "Payment", 1, "Rent", "12000.00", "", "Rent, May"], ["2026-05-01", "Payment", 1, "HDFC Bank", "", "12000.00", ""]]);
  });
});
