import { describe, expect, it } from "@effect/vitest";
import { decryptPoolBundle, encryptPoolBundle } from "./vaultCrypto.ts";

describe("vaultCrypto", () => {
  it("encrypts and decrypts pool sync bundles with AES-256-GCM", async () => {
    const payload = JSON.stringify({ pools: { main: { displayName: "ChatGPT" } } });
    const bundle = await encryptPoolBundle(payload, "super-secret-passphrase", 123456);
    expect(bundle.version).toBe(1);
    expect(bundle.ciphertextBase64).not.toContain("ChatGPT");
    const decoded = await decryptPoolBundle(bundle, "super-secret-passphrase");
    expect(decoded).toBe(payload);
  });

  it("rejects wrong passphrase", async () => {
    const bundle = await encryptPoolBundle("hello", "right-pass", 123456);
    await expect(decryptPoolBundle(bundle, "wrong-pass")).rejects.toThrow();
  });
});
