// Encryption for secrets kept in the database (customers' Unleashed API
// keys): AES-256-GCM with the MASTER_KEY from the server's environment.
//
// MASTER_KEY is 32 random bytes, base64 — make one with
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Losing it means every stored key has to be entered again; changing it
// needs a re-encryption step. Required in production; local dev and tests
// use a fixed development key.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const DEV_KEY = Buffer.alloc(32, 7);

export function masterKeyFrom(value) {
  if (!value) return DEV_KEY;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64-encoded.');
  return key;
}

// -> "v1.<iv>.<tag>.<ciphertext>" (base64url parts)
export function encrypt(plain, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decrypt(blob, key) {
  const [v, iv, tag, data] = String(blob || '').split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) throw new Error('Not an encrypted value.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
