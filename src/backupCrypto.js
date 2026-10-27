/* Passphrase-encrypted backups: AES-256-GCM with a key from PBKDF2-SHA256.
   Uses the platform's Web Crypto (Android WebView, browsers, Node), no extra library.
   The passphrase is never stored; lose it and the backup cannot be opened. */

export const ENC_FORMAT = "finbuddy-encrypted-backup";
const ITERATIONS = 600000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
const enc = new TextEncoder(), dec = new TextDecoder();

const b64 = (buf) => { let s = ""; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export function isEncryptedBackup(d) { return !!d && typeof d === "object" && d.format === ENC_FORMAT; }

export async function encryptBackup(text, passphrase, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return { format: ENC_FORMAT, v: 1, kdf: "PBKDF2-SHA256", iterations, cipher: "AES-256-GCM", salt: b64(salt), iv: b64(iv), data: b64(data) };
}

// Throws "Wrong passphrase or damaged file" when the passphrase is wrong or the file was altered
// (GCM authenticates the data, so a tampered backup never decrypts to garbage).
export async function decryptBackup(obj, passphrase) {
  if (!isEncryptedBackup(obj) || obj.v !== 1) throw new Error("Unsupported encrypted backup");
  const iterations = Number(obj.iterations);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000000) throw new Error("Damaged encrypted backup");
  try {
    const key = await deriveKey(passphrase, unb64(obj.salt), iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(obj.iv) }, key, unb64(obj.data));
    return dec.decode(plain);
  } catch {
    throw new Error("Wrong passphrase or damaged file");
  }
}
