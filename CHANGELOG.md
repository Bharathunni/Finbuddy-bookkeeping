# Changelog

All notable changes to FinBuddy are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Restoring a malformed backup no longer leaves the app on a blank screen at every launch. Backups are checked first, and the app asks before replacing your books.
- If stored books cannot be read, the app shows a rescue screen with a download instead of starting a fresh company that would overwrite them.
- Save failures are shown instead of being silently ignored, and writes are kept in order.
- "Today" uses the device's local date; in India it was the previous day until 05:30.
- Bank import: dates that cannot be read are flagged and never posted (previously `04/13/2025` posted as month 13 and unknown months became January). MM/DD files are detected.
- Bank import: `(1,234.00)` and `Dr`-suffixed balances read as negative; reconciliation is taken from the latest row whichever way the file is sorted, and as at the statement's last date.
- Duplicate detection counts identical lines, so a genuine second identical transaction is no longer dropped.
- Auto-rules pointing to a deleted ledger no longer post vouchers against it; deleting a ledger removes its rules.
- Opening balances on income / expense ledgers are included in profit, so the Balance Sheet ties after a mid-year switch.
- Trial Balance shows income and expenses for the current financial year with earlier years carried as Profit & Loss A/c (b/f).
- Dashboard, reports and the sidebar follow the current financial year instead of a stored year that never rolled over.
- Changing a voucher's type while editing gives it the next number in the new series.
- GST helper: CGST and SGST are each computed at half the rate, so they are always equal.
- Audit trail is no longer truncated at 800 entries; timestamps are local time.
- Vouchers screen took 6.5 s to open and 0.6 s per keystroke with 2,000 vouchers on a phone-class CPU; the Day Book is now paged and memoised (0.6 s to open with 10,000 vouchers). Audit trail is paged too.
- `@capacitor/android` 8.5.3 fixes GHSA-rvm3-566m-v7fv (critical).

### Added
- Audit trail now records changes to ledgers, opening balances, auto-rules, period lock, books-beginning date, company name, GST setting, restore and reset.
- Encrypted backup: AES-256-GCM with a passphrase-derived key; restore detects encrypted files and asks for the passphrase.
- Excel / CSV export of Trial Balance, P&L, Balance Sheet, ledger statements and the Day Book.
- Rename a ledger or move it to another group from Masters.
- Period lock now also blocks opening balance changes and regrouping ledgers used in the locked period; clearing it or moving it earlier asks for confirmation.
- Credit Cards group; card and overdraft ledgers can be imported into, used in Contra, and show as "Cards & OD owed" on the dashboard.
- Single-column Amount statements, with or without a Dr/Cr column.
- Statement opening balance check, so a difference is traced to before or within the statement.
- Engine moved to `src/engine.js` with Vitest unit tests, run in CI.

## [1.0.0] - 2026-10-03

First public release.

### Added
- Double-entry voucher engine: Contra, Payment, Receipt, Journal, Sales, Purchase with balance and voucher-type validation.
- 28 standard Indian account groups and editable ledgers with opening balances.
- Live reports: Trial Balance, Trading and Profit & Loss Account, Balance Sheet, Ledger statement, Dashboard.
- Bank statement CSV import with column auto-detection, duplicate detection, keyword rules and reconciliation.
- Audit trail of every create, edit and delete.
- Period lock and financial-year settings.
- Optional GST helper (CGST/SGST or IGST split).
- On-device storage with autosave, JSON backup and restore via the Android share sheet.
- Responsive layout with a compact icon rail on phones.
- FinBuddy brand: logo, adaptive launcher icon and splash screen.
- Browser demo build (`VITE_DEMO=1`) that opens on synthetic sample books, hosted on GitHub Pages.
