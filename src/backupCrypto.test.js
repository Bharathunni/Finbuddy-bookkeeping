import { describe, it, expect } from "vitest";
import { encryptBackup, decryptBackup, isEncryptedBackup } from "./backupCrypto.js";

const ITER = 1000; // fast for tests; the app uses 600,000

describe("encrypted backup", () => {
  it("round-trips with the right passphrase and hides the content", async () => {
    const text = JSON.stringify({ company: { name: "Bharath ₹ personal" }, vouchers: [{ narration: "SALARY OCT" }] });
    const box = await encryptBackup(text, "correct horse battery", ITER);
    expect(isEncryptedBackup(box)).toBe(true);
    expect(JSON.stringify(box)).not.toContain("SALARY");
    expect(await decryptBackup(box, "correct horse battery")).toBe(text);
  });
  it("refuses a wrong passphrase", async () => {
    const box = await encryptBackup("{}", "right one", ITER);
    await expect(decryptBackup(box, "wrong one")).rejects.toThrow("Wrong passphrase");
  });
  it("refuses a tampered file", async () => {
    const box = await encryptBackup('{"a":1}', "pass phrase", ITER);
    const d = atob(box.data); const flipped = String.fromCharCode(d.charCodeAt(0) ^ 1) + d.slice(1);
    await expect(decryptBackup({ ...box, data: btoa(flipped) }, "pass phrase")).rejects.toThrow();
  });
  it("uses fresh salt and IV each time", async () => {
    const a = await encryptBackup("same", "p", ITER), b = await encryptBackup("same", "p", ITER);
    expect(a.salt).not.toBe(b.salt); expect(a.iv).not.toBe(b.iv); expect(a.data).not.toBe(b.data);
  });
});
