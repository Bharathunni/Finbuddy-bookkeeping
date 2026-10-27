<p align="center">
  <img src="docs/brand/banner.png" alt="FinBuddy: manage finances, the responsible way" width="100%" />
</p>

<p align="center">
  <a href="https://bharathunni.github.io/Finbuddy-bookkeeping/"><img alt="Try it in your browser" src="https://img.shields.io/badge/Try%20it-in%20your%20browser-C8992E?style=for-the-badge&logo=googlechrome&logoColor=white"></a>
  <a href="https://github.com/bharathunni/finbuddy-bookkeeping/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/bharathunni/finbuddy-bookkeeping/ci.yml?branch=main&style=for-the-badge&label=build"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Android%207.0%2B-0A2540?style=for-the-badge&logo=android">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-0A2540?style=for-the-badge"></a>
</p>

# FinBuddy

**Manage finances, the responsible way.**

FinBuddy is an offline-first, double-entry bookkeeping app for Android, designed by a Chartered Accountant. It brings the discipline of professional accounting software (vouchers, groups, ledgers, trial balance, final accounts, audit trail, period lock) to a pocket-sized app, with zero cloud dependency. FinBuddy itself never sends your books anywhere.

It is built for freelancers, consultants, small business owners and finance-minded individuals who want real books, not a glorified expense tracker.

> **[Try it in your browser](https://bharathunni.github.io/Finbuddy-bookkeeping/)**, no install. The hosted demo opens on synthetic sample books for a fictional firm; anything you change stays in your browser. Download the sample bank CSV from the demo banner, import it under **Bank Import**, post it, then import it again to watch every line get caught as a duplicate.

---

## Design decisions

**Every number is computed by explicit rules, not AI.** Books have to balance to the paisa and give the same answer every time, so nothing in FinBuddy is probabilistic or learned.

- **Duplicate detection is exact-match.** A bank line is a duplicate only if bank ledger, date, amount (to the paisa) and narration all match an existing Payment or Receipt. No fuzzy matching: a false "duplicate" silently drops a real transaction, which is worse than asking the user to look.
- **Reconciliation is arithmetic.** Book balance after posting is compared with the statement's closing balance; the app shows either "Reconciles" or the exact unaccounted difference in rupees.
- **Auto-categorisation is keyword rules the user writes** ("RENT" to Rent, "SALARY" to Salaries), visible and editable, never a model's guess.
- **Vouchers cannot post unless Dr = Cr**, and every create, edit and delete lands in the audit trail.

AI was used as leverage to build the app quickly. It is not in the runtime path.

---

## Screenshots

| Dashboard | Profit & Loss | Balance Sheet |
| :---: | :---: | :---: |
| <img src="docs/screenshots/dashboard-mobile.png" width="240" /> | <img src="docs/screenshots/profit-loss-mobile.png" width="240" /> | <img src="docs/screenshots/balance-sheet-mobile.png" width="240" /> |

| Voucher entry | Bank import | Audit trail |
| :---: | :---: | :---: |
| <img src="docs/screenshots/vouchers-mobile.png" width="240" /> | <img src="docs/screenshots/bank-import-mobile.png" width="240" /> | <img src="docs/screenshots/audit-trail-mobile.png" width="240" /> |

<details>
<summary>Tablet / desktop layout</summary>

<img src="docs/screenshots/dashboard.png" />
<img src="docs/screenshots/profit-loss.png" />
<img src="docs/screenshots/vouchers.png" />

</details>

---

## Features

### Accounting engine
- **True double-entry.** Every voucher must balance (Dr = Cr, to the paisa) before it can be posted.
- **Six voucher types** with type-specific validation: Contra, Payment, Receipt, Journal, Sales, Purchase. Contra is restricted to cash and bank ledgers; Payment, Receipt, Journal, Sales and Purchase raise warnings when they deviate from standard practice.
- **28 pre-seeded account groups** following the standard Indian chart of accounts, so every ledger lands correctly in the Trading Account, P&L or Balance Sheet.
- **Opening balance check.** The app flags any Dr/Cr mismatch in opening balances before it can corrupt the Trial Balance.
- **Paise-accurate arithmetic** with explicit rounding at every step to avoid floating-point drift.
- **Indian number formatting** (lakh / crore grouping: 12,34,567.00).

### Reports (computed live)
- **Trial Balance** as at any date, with a "Balanced" check. Income and expense ledgers show the current financial year only, with earlier years carried as Profit & Loss A/c (b/f).
- **Trading and Profit & Loss Account** for any period, with gross and net profit carried down correctly.
- **Balance Sheet** as at any date, with cumulative profit so it ties across financial years.
- **Ledger statement** with running balance.
- **Dashboard** showing cash and bank position, FY-to-date profit, debtors, creditors and recent activity.
- **Excel / CSV export** of the Trial Balance, P&L, Balance Sheet, any ledger and the Day Book. Amounts are plain numbers so the spreadsheet can total them; on Android the file goes to the share sheet.

### Bank statement import
- Import any bank's or credit card's **CSV** export. Date, narration, withdrawal, deposit and balance columns are auto-detected, as is a single signed **Amount** column with or without a separate `Dr/Cr` column. The header row and each column can be overridden.
- Understands common date formats (`dd/mm/yyyy`, `dd-Mon-yy`, `05 April 2025`, ISO). DD/MM vs MM/DD is detected from the file and can be switched. A line whose date cannot be read is flagged and never posted.
- Understands amount formats: `₹`, Indian commas, `Cr`/`Dr` suffixes, `(1,234.00)` negatives.
- Money out becomes a **Payment** voucher, money in a **Receipt** voucher. Bank, overdraft and **credit card** ledgers can all be imported into.
- **Duplicate detection** skips transactions already in your books, counting identical lines: two identical ₹2,000 ATM withdrawals with only one already booked leaves one to post.
- **Auto-categorisation rules** (keyword to ledger), so "RENT" or "SALARY" lines are pre-assigned.
- **Reconciliation** at both ends: statement opening against the books the day before, and statement closing against the books on the statement's last date, so a difference is traced to before or within the statement.

### Controls (the CA part)
- **Audit trail.** Every voucher create, edit and delete is logged with timestamp and full entry detail, as is every change to ledgers (create, rename, regroup, opening balance, delete), auto-rules, period lock, books-beginning date, GST setting, restore and reset. The log is never truncated.
- **Period lock.** Freeze books up to a date so filed periods cannot be altered: no vouchers on or before it, no opening balance changes, and no regrouping of ledgers used in the locked period. Clearing the lock or moving it earlier asks first and is logged.
- **Ledgers can be renamed or moved to another group** without touching vouchers.
- **Financial year aware.** April to March, rolling over by itself on 1 April, with a configurable books-beginning date.
- **Optional GST helper.** Builds the CGST/SGST or IGST split for Sales and Purchase vouchers from a taxable value and rate.

### Privacy and data
- **100% offline.** No account, no server, no analytics, no third-party SDKs.
- Data is stored on-device (Android SharedPreferences via Capacitor, mirrored to WebView storage) and **autosaves on every change**. If a save fails, the app says so instead of failing silently. If stored books ever cannot be read, the app offers them as a download instead of starting fresh over them.
- Android's own device backup (Google account backup) may include the app's data, like any other app's.
- **Restore** checks the backup file before touching your books and asks before replacing them.
- **Encrypted backup** (AES-256-GCM, key from your passphrase via PBKDF2-SHA256, 600,000 iterations) through the Android share sheet, so an off-device copy in Drive or email is unreadable without the passphrase. The passphrase is never stored. Plain JSON export is still available.

### Usability
- Responsive layout: full sidebar on tablets and desktop, compact icon rail on phones.
- Keyboard shortcuts **F4 to F9** for voucher types, familiar to Indian accountants.

---

## Try it / install

- **Browser (no install):** [bharathunni.github.io/Finbuddy-bookkeeping](https://bharathunni.github.io/Finbuddy-bookkeeping/). Synthetic sample books, stored only in your browser.
- **Android:** every CI run on `main` builds a debug APK, downloadable from the run's **Artifacts** (`FinBuddy-debug-apk`) on the [Actions tab](https://github.com/bharathunni/finbuddy-bookkeeping/actions/workflows/ci.yml). Sideload on Android 7.0 or later and allow installation from this source. Or build it yourself (below).
- **Your own data in the browser:** run `npm run dev` locally, then **Settings > Backup & data > Restore** with [`docs/demo-books.json`](docs/demo-books.json) or your own backup, and try importing [`docs/sample-bank-statement.csv`](docs/sample-bank-statement.csv).

---

## Tech stack

| Layer | Choice | Why |
| --- | --- | --- |
| UI | React 19 | Component model, hooks, memoised computation |
| Build | Vite 8 | Fast dev server and production bundling |
| Native shell | Capacitor 8 | Ships the web app as a real Android APK with native storage and share APIs |
| Storage | `@capacitor/preferences` | Native key-value storage, no database server |
| Files | `@capacitor/filesystem` + `@capacitor/share` | Backup export via the Android share sheet |
| CSV | PapaParse | Robust parsing of messy bank exports |
| Icons | lucide-react | Lightweight, consistent icon set |

### Architecture

```
src/engine.js          pure functions, unit-tested in src/engine.test.js
 ├─ Schema             backupError / migrate             validate untrusted input, versioned schema
 ├─ Engine             makeCalc (single pass, memoised) → opening / closing / movement per ledger
 │                     computePL, trialBalance           → Trading, P&L, Trial Balance, Balance Sheet
 ├─ Validation         validateVoucher                   → balance, dates, period lock, voucher-type rules
 └─ Statements         statementRows, findDuplicates     → CSV parsing, de-dup, reconciliation
src/App.jsx            storage (loadDb / persist) and views:
                       Dashboard · Vouchers · Bank Import · Masters · Reports · Audit Trail · Settings
src/ErrorBoundary.jsx  rescue screen: stored books offered as a download if anything crashes
```

The ledger engine indexes all voucher lines by ledger once per change and derives every report from that index. The Day Book and audit trail are paged and do not re-render while you type a voucher. Measured with 10,000 vouchers at 4x CPU throttling (roughly a mid-range phone): Vouchers screen opens in about 0.6 s, reports in about 0.15 s.

---

## Project structure

```
.
├── src/                 React application (App.jsx, entry point, global styles)
├── public/              Static web assets (favicon)
├── android/             Capacitor Android project (Gradle)
├── docs/
│   ├── brand/           Logo, mark and banner
│   ├── screenshots/     README screenshots
│   ├── demo-books.json  Synthetic sample company (loaded by the hosted demo)
│   └── sample-bank-statement.csv
├── capacitor.config.json
├── vite.config.js
└── package.json
```

---

## Build from source

**Prerequisites:** Node.js 20+, and for the APK: JDK 21 and Android Studio (or the Android SDK command-line tools).

```bash
git clone https://github.com/bharathunni/finbuddy-bookkeeping.git
cd finbuddy-bookkeeping
npm ci

# Run in the browser (hot reload)
npm run dev

# Lint, engine tests and production web build
npm run lint
npm test
npm run build

# Demo build, as hosted on GitHub Pages (opens on the sample books)
VITE_DEMO=1 npm run build
```

### Android APK

```bash
npm run android:sync    # vite build + copy web assets into android/
npm run android:open    # open in Android Studio, then Build > Build APK(s)

# or headless:
npm run android:apk     # outputs android/app/build/outputs/apk/debug/app-debug.apk
```

For a Play Store release build, create a keystore and configure `signingConfigs` in `android/app/build.gradle`, then run `./gradlew bundleRelease` inside `android/`.

---

## Roadmap

- [ ] Inventory (stock items, FIFO / weighted average valuation)
- [ ] Bill-wise outstanding and ageing for debtors and creditors
- [ ] GSTR-1 / GSTR-3B summary export
- [ ] PDF export of final accounts
- [ ] Automatic scheduled backup to user-chosen cloud storage
- [ ] Multi-company support

---

## Author

**Bharath Unni**, Chartered Accountant.
Designed the accounting model, validation rules and reporting logic, and built the app end to end.

## License

Released under the [MIT License](LICENSE).
