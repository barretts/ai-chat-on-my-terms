/** Node-side crypto ports for the backup envelope (client = any Node host). */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { argon2id } from "@noble/hashes/argon2.js";
import { fromHex, toHex, type CryptoPorts } from "./index.ts";

export function nodeBackupCrypto(): CryptoPorts {
  return {
    randomBytes: (count) => new Uint8Array(randomBytes(count)),
    async deriveKey(passphrase, params) {
      const key = argon2id(passphrase, fromHex(params.saltHex), {
        t: params.iterations,
        m: params.memoryKiB,
        p: params.parallelism,
        dkLen: params.keyLengthBytes,
        maxmem: 2 * params.memoryKiB * 1024,
      });
      return key;
    },
    async encrypt(key, plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return {
        ivHex: toHex(new Uint8Array(iv)),
        tagHex: toHex(new Uint8Array(cipher.getAuthTag())),
        ciphertext: new Uint8Array(ciphertext),
      };
    },
    async decrypt(key, ivHex, tagHex, aad, ciphertext) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(ivHex, "hex"),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      return new Uint8Array(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      );
    },
  };
}
