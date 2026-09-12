import type { Kdf, VaultConfig, Envelope, Change, IdentifiedRecord } from './types.js';
// Versioned wire format shared with the server. Secrets are derived only in pages.
const utf8 = new TextEncoder();
const decode = new TextDecoder('utf-8', { fatal: true });
export const FORMAT = 1;
export const validUserId = (id: unknown): id is string => typeof id === 'string' && /^u_[a-f0-9]{32}$/.test(id);
export const PROFILE_ID = '_profile';
export function normalizeNickname(value: unknown) {
  if (typeof value !== 'string' || !value.isWellFormed() || /[\p{Cc}]/u.test(value) || [...value.trim()].length > 40) throw new Error('Use a nickname of up to 40 characters without control characters.');
  return value.trim().normalize('NFC');
}
export const ITERATIONS = 600000;
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const base64 = (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) => btoa(Array.from(new Uint8Array(bytes), b => String.fromCharCode(b)).join(''));
export function unbase64(value: unknown, length?: number) {
  if (typeof value !== 'string' || value.length > 131072 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid encrypted format.');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) throw new Error('Invalid encrypted length.');
  return bytes;
}
export function exact<K extends string>(value: unknown, keys: K[]): asserts value is Record<K, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.some(key => key === k)) || keys.some(k => !(k in value))) throw new Error('Unsupported encrypted format.');
}
export const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,80}$/.test(id);
export function validateKdf(kdf: unknown): Kdf {
  exact(kdf, ['version', 'algorithm', 'hash', 'iterations', 'salt']);
  if (kdf.version !== 1 || kdf.algorithm !== 'PBKDF2' || kdf.hash !== 'SHA-256' || kdf.iterations !== ITERATIONS) throw new Error('Unsupported password derivation parameters.');
  unbase64(kdf.salt, 16);
  return kdf as Kdf;
}
export const newKdf = (): Kdf => ({ version: 1, algorithm: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: base64(random(16)) });
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 1024 || !password.isWellFormed()) throw new Error('Use 15–1,024 characters for your password.');
}
export async function derive(password: string, kdf: Kdf) {
  validateKdf(kdf); validatePassword(password);
  const input = utf8.encode(password);
  try {
    const source = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    const master = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(kdf.salt), iterations: ITERATIONS }, source, 256));
    try {
      const hkdf = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
      const params = (purpose: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8.encode(`taskpath:v1:${purpose}`) });
      const auth = await crypto.subtle.deriveBits(params('authentication'), hkdf, 256);
      const wrappingKey = await crypto.subtle.deriveKey(params('vault-wrapping'), hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      return { credential: base64(auth), wrappingKey };
    } finally { master.fill(0); }
  } finally { input.fill(0); }
}
export async function importVault(raw: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const wrapAAD = (vaultId: string, kdf: Kdf) => utf8.encode(JSON.stringify(['taskpath:v1:vault', vaultId, validateKdf(kdf)]));
export async function wrapVault(raw: Uint8Array<ArrayBuffer>, wrappingKey: CryptoKey, vaultId: string, kdf: Kdf) {
  const nonce = random(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128, additionalData: wrapAAD(vaultId, kdf) }, wrappingKey, raw);
  return { nonce: base64(nonce), ciphertext: base64(ciphertext) };
}
export function validateConfig(config: unknown): VaultConfig {
  exact(config, ['vaultId', 'revision', 'kdf', 'wrappedKey']);
  if (!validId(config.vaultId) || !Number.isSafeInteger(config.revision) || typeof config.revision !== 'number' || config.revision < 1) throw new Error('Unsupported vault configuration.');
  validateKdf(config.kdf);
  exact(config.wrappedKey, ['nonce', 'ciphertext']);
  unbase64(config.wrappedKey.nonce, 12); unbase64(config.wrappedKey.ciphertext, 48);
  return config as VaultConfig;
}
export async function unwrapRaw(wrappingKey: CryptoKey, config: VaultConfig) {
  validateConfig(config);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(config.wrappedKey.nonce), tagLength: 128, additionalData: wrapAAD(config.vaultId, config.kdf) }, wrappingKey, unbase64(config.wrappedKey.ciphertext)));
}
export async function unlockVault(password: string, config: VaultConfig) {
  validateConfig(config);
  const derived = await derive(password, config.kdf);
  const raw = await unwrapRaw(derived.wrappingKey, config);
  try { return { key: await importVault(raw), credential: derived.credential }; }
  finally { raw.fill(0); }
}
export async function createVault(password: string, vaultId: string = crypto.randomUUID()) {
  const kdf = newKdf();
  const derived = await derive(password, kdf);
  const raw = random(32);
  try {
    return { config: { vaultId, revision: 1, kdf, wrappedKey: await wrapVault(raw, derived.wrappingKey, vaultId, kdf) }, credential: derived.credential, key: await importVault(raw) };
  } finally { raw.fill(0); }
}
export async function replacePassword(currentPassword: string, password: string, config: VaultConfig) {
  validateConfig(config);
  const current = await derive(currentPassword, config.kdf);
  const raw = await unwrapRaw(current.wrappingKey, config);
  try {
    const kdf = newKdf(), next = await derive(password, kdf);
    return { currentCredential: current.credential, credential: next.credential,
      config: { vaultId: config.vaultId, revision: config.revision + 1, kdf, wrappedKey: await wrapVault(raw, next.wrappingKey, config.vaultId, kdf) } };
  } finally { raw.fill(0); }
}
export function validateEnvelope(envelope: unknown, vaultId: string): Envelope {
  exact(envelope, ['version', 'vaultId', 'taskId', 'editedAt', 'changeId', 'nonce', 'ciphertext']);
  if (envelope.version !== FORMAT || envelope.vaultId !== vaultId || !validId(envelope.taskId) || !validId(envelope.changeId) || typeof envelope.editedAt !== 'string' || !Number.isFinite(Date.parse(envelope.editedAt)) || new Date(envelope.editedAt).toISOString() !== envelope.editedAt) throw new Error('Invalid encrypted task metadata.');
  unbase64(envelope.nonce, 12);
  const bytes = unbase64(envelope.ciphertext);
  if (bytes.length < 17 || bytes.length > 65536) throw new Error('Encrypted task is too large or incomplete.');
  return envelope as Envelope;
}
const taskAAD = (e: Envelope) => utf8.encode(JSON.stringify(['taskpath:task', e.version, e.vaultId, e.taskId, e.editedAt, e.changeId]));
export async function encryptChange<T extends {id:string}>(key: CryptoKey, vaultId: string, change: Change<T>) {
  const envelope: Envelope = { version: FORMAT, vaultId, taskId: change.task.id, editedAt: change.editedAt, changeId: change.changeId, nonce: base64(random(12)), ciphertext: '' };
  envelope.ciphertext = base64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: unbase64(envelope.nonce), tagLength: 128, additionalData: taskAAD(envelope) }, key, utf8.encode(JSON.stringify(change.task))));
  return validateEnvelope(envelope, vaultId);
}
export async function decryptEnvelope(key: CryptoKey, vaultId: string, input: unknown) {
  const envelope = validateEnvelope(input, vaultId);
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(envelope.nonce), tagLength: 128, additionalData: taskAAD(envelope) }, key, unbase64(envelope.ciphertext)));
  try {
    const task: unknown = JSON.parse(decode.decode(raw));
    if (!task || typeof task !== 'object' || !('id' in task) || !('updatedAt' in task)) throw new Error('Encrypted task identity mismatch.');
    if (task.id !== envelope.taskId || task.updatedAt !== envelope.editedAt) throw new Error('Encrypted task identity mismatch.');
    return task as IdentifiedRecord;
  } finally { raw.fill(0); }
}
