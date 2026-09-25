import { RequestError } from './errors.js';
import { apiRequest, fileRequest } from './api-client.js';
import { validateConfig } from './crypto.js';
import { encodeFile, fileManifest, FILE_MAX, type FileEnvelope } from './file-format.js';
import type { Envelope, ReminderMetadata, PushStatus, VaultConfig } from './types.js';

interface Login { userId: string; credential: string; revision: number }
interface Setup { userId: string; token: string; config: VaultConfig; credential: string }
interface PasswordChange { currentCredential: string; credential: string; config: VaultConfig; revision: number }
interface SyncBatch { cursor?:string | null; workspaceKey: string; changes: Envelope[]; reminders?: ReminderMetadata[] }

export const authApi = {
  async configuration(userId: string): Promise<VaultConfig | null> {
    const result = await apiRequest<{ config: unknown }>('/api/auth/config?userId=' + encodeURIComponent(userId), 'GET', undefined, userId);
    return result.config === null ? null : validateConfig(result.config);
  },
  async setup(input: Setup): Promise<void> {
    await apiRequest('/api/auth/setup', 'POST', input, input.userId);
  },
  async login(input: Login): Promise<void> {
    await apiRequest('/api/auth/login', 'POST', input, input.userId);
  },
  async logout(userId: string | null): Promise<void> {
    await apiRequest('/api/auth/logout', 'POST', {}, userId);
  },
  async changePassword(userId: string, input: PasswordChange): Promise<void> {
    await apiRequest('/api/auth/password', 'POST', input, userId);
  },
};

// Capture the account once. A later account switch must never retarget queued
// requests. Lifecycle/revision guards remain with the callers that own state.
export function accountApi(userId: string | null) {
  if (!userId) throw new Error('Select an account first.');
  const id = userId;
  return {
    // acceptEncrypted validates the snapshot against local vault/queue state.
    async sync(batch: SyncBatch): Promise<unknown> {
      const posting = batch.changes.length || batch.reminders?.length;
      const response = await apiRequest('/api/sync' + (!posting && batch.cursor ? '?cursor=' + encodeURIComponent(batch.cursor) : ''), posting ? 'POST' : 'GET', posting ? {
        workspaceKey: batch.workspaceKey, changes: batch.changes,
        ...(batch.reminders?.length ? { reminders: batch.reminders } : {}),
      } : undefined, id, {'X-Taskpath-Sync':'2'});
      if (!response || typeof response !== 'object' || !('protocol' in response) || response.protocol !== 2) {
        throw new RequestError('Update Taskpath on the server and reload the app to sync. Local encrypted changes remain saved.',426);
      }
      return response;
    },
    async claimReminders(tokens: string[]): Promise<string[]> {
      const result = await apiRequest<{ tokens: unknown }>('/api/reminders/claim', 'POST', { tokens }, id);
      if (!Array.isArray(result.tokens) || !result.tokens.every(token => typeof token === 'string')) throw new Error('Invalid reminder response.');
      return result.tokens;
    },
    push: {
      async status(): Promise<PushStatus> {
        const value = await apiRequest<PushStatus>('/api/push', 'GET', undefined, id);
        if (!value || typeof value.available !== 'boolean' || !(value.publicKey === null || typeof value.publicKey === 'string') ||
          !Array.isArray(value.subscriptionIds) || !value.subscriptionIds.every(item => typeof item === 'string')) throw new Error('Invalid notification response.');
        return value;
      },
      async subscribe(subscription: PushSubscriptionJSON): Promise<void> {
        await apiRequest('/api/push', 'POST', { subscription }, id);
      },
      async unsubscribe(subscriptionId: string): Promise<void> {
        await apiRequest('/api/push', 'DELETE', { id: subscriptionId }, id);
      },
    },
    files: {
      async manifest(vaultId: string) {
        return fileManifest(await (await fileRequest('', 'GET', undefined, id)).json(), id, vaultId);
      },
      async upload(envelope: FileEnvelope, ciphertext: Uint8Array<ArrayBuffer>): Promise<void> {
        await fileRequest('', 'PUT', encodeFile(envelope, ciphertext), id);
      },
      async rename(envelope: FileEnvelope): Promise<void> {
        await fileRequest('/' + encodeURIComponent(envelope.fileId), 'PATCH', JSON.stringify(envelope), id);
      },
      async delete(fileId: string): Promise<void> {
        await fileRequest('/' + encodeURIComponent(fileId), 'DELETE', '{}', id);
      },
      async download(fileId: string, originalBytes: number): Promise<Uint8Array<ArrayBuffer>> {
        if (!Number.isSafeInteger(originalBytes) || originalBytes < 0 || originalBytes > FILE_MAX) throw new Error('Invalid encrypted file length.');
        const response = await fileRequest('/' + encodeURIComponent(fileId), 'GET', undefined, id);
        const reader = response.body?.getReader(), data = new Uint8Array(originalBytes + 16);
        let offset = 0;
        if (reader) while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (offset + value.length > data.length) { await reader.cancel(); throw new Error('Invalid encrypted file length.'); }
          data.set(value, offset); offset += value.length;
        }
        if (offset !== data.length) throw new Error('Incomplete file download.');
        return data;
      },
    },
  };
}
