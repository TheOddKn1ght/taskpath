import { test, expect } from 'bun:test';
import { createVault, derive, unlockVault, replacePassword, encryptChange, decryptEnvelope, validateKdf, validatePassword, newKdf, base64, random, unbase64 } from '../public/crypto.js';
import { ClientStore } from './client-helpers';
const password = '  密码 with exact spaces!  ';
const vault = await createVault(password);
const client = new ClientStore();
client.create({ title: 'DISTINCTIVE PRIVATE TITLE', notes: 'Private notes', tags: ['private'], reminderAt: '2026-10-01T12:00:00Z' });
const change = client.record.pending[0];

test('PBKDF2/HKDF uses separate authentication and wrapping purposes and exact password contents', async () => {
  const a = await derive(password, vault.config.kdf), b = await derive(password, vault.config.kdf);
  expect(a.credential).toBe(b.credential);
  expect(a.wrappingKey.extractable).toBe(false);
  expect((await derive(password.trim(), vault.config.kdf)).credential).not.toBe(a.credential);
  const fake = await crypto.subtle.importKey('raw', unbase64(a.credential), 'AES-GCM', false, ['decrypt']);
  await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(vault.config.wrappedKey.nonce) }, fake, unbase64(vault.config.wrappedKey.ciphertext))).rejects.toThrow();
  expect(vault.key.extractable).toBe(false);
  await expect(crypto.subtle.exportKey('raw', vault.key)).rejects.toThrow();
});
test('unsupported KDF parameters and password bounds fail before derivation', () => {
  for (const kdf of [{ ...newKdf(), iterations: 1 }, { ...newKdf(), iterations: 600001 }, { ...newKdf(), hash: 'SHA-1' }, { ...newKdf(), salt: base64(random(15)) }, { ...newKdf(), version: 2 }]) expect(() => validateKdf(kdf)).toThrow();
  for (const value of ['short', 'x'.repeat(1025), '\ud800'.repeat(15)]) expect(() => validatePassword(value)).toThrow();
  validatePassword('😀'.repeat(1024));
});
test('vault wrapping unlocks with correct password and rejects wrong password or substituted metadata', async () => {
  const unlocked = await unlockVault(password, vault.config);
  expect(unlocked.key.extractable).toBe(false);
  await expect(unlockVault('a different wrong password', vault.config)).rejects.toThrow();
  await expect(unlockVault(password, { ...vault.config, vaultId: crypto.randomUUID() })).rejects.toThrow();
});
test('AES-GCM round trip, fresh nonces, and authenticated metadata prevent tampering and record substitution', async () => {
  const a = await encryptChange(vault.key, vault.config.vaultId, change), b = await encryptChange(vault.key, vault.config.vaultId, change);
  expect(a.nonce).not.toBe(b.nonce); expect(a.ciphertext).not.toBe(b.ciphertext);
  expect(JSON.stringify(a)).not.toContain(change.task.title);
  expect(await decryptEnvelope(vault.key, vault.config.vaultId, a)).toEqual(change.task);
  for (const patch of [{ taskId: 'different' }, { changeId: 'different' }, { editedAt: '2026-01-01T00:00:00.000Z' }, { version: 2 }, { vaultId: 'other' }, { nonce: base64(random(12)) }, { ciphertext: base64(random(unbase64(a.ciphertext).length)) }]) await expect(decryptEnvelope(vault.key, vault.config.vaultId, { ...a, ...patch })).rejects.toThrow();
});
test('password change rewraps the same data key without changing task ciphertext', async () => {
  const encrypted = await encryptChange(vault.key, vault.config.vaultId, change);
  const replacement = await replacePassword(password, 'new password from a manager', vault.config);
  expect(replacement.config.kdf.salt).not.toBe(vault.config.kdf.salt);
  expect(replacement.config.revision).toBe(2);
  expect(replacement.credential).not.toBe(vault.credential);
  const next = await unlockVault('new password from a manager', replacement.config);
  expect(await decryptEnvelope(next.key, vault.config.vaultId, encrypted)).toEqual(change.task);
  await expect(unlockVault(password, replacement.config)).rejects.toThrow();
  // An already copied key remains usable, as documented.
  expect(await decryptEnvelope(vault.key, vault.config.vaultId, encrypted)).toEqual(change.task);
});
