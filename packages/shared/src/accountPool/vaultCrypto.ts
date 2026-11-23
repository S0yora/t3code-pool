import type { ProviderPoolEncryptedBundle } from "@t3tools/contracts";

const PBKDF2_ITERATIONS = 120_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(value, "base64");
    const copy = new Uint8Array(new ArrayBuffer(buf.byteLength));
    copy.set(buf);
    return copy;
  }
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function deriveAesKey(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  const encoded = new TextEncoder().encode(passphrase);
  const keyMaterial = await crypto.subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptPoolBundle(
  plaintextJson: string,
  passphrase: string,
  updatedAtMs: number,
): Promise<ProviderPoolEncryptedBundle> {
  const salt = new Uint8Array(new ArrayBuffer(SALT_BYTES));
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
  crypto.getRandomValues(salt);
  crypto.getRandomValues(iv);

  const key = await deriveAesKey(passphrase, salt);
  const plaintextBytes = new TextEncoder().encode(plaintextJson);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBytes);

  return {
    version: 1,
    updatedAtMs,
    saltBase64: toBase64(salt),
    ivBase64: toBase64(iv),
    ciphertextBase64: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptPoolBundle(
  bundle: ProviderPoolEncryptedBundle,
  passphrase: string,
): Promise<string> {
  const salt = fromBase64(bundle.saltBase64);
  const iv = fromBase64(bundle.ivBase64);
  const ciphertext = fromBase64(bundle.ciphertextBase64);
  const key = await deriveAesKey(passphrase, salt);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
