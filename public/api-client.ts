import { RequestError } from './errors.js';
import { selectedAccount } from './persistence.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

// Shared by pages and workers. Callers own validation, encryption, account
// lifecycle checks and retries; transport never changes local state.
function request(path: string, method: HttpMethod, body: BodyInit | undefined,
  userId: string | null, contentType: string, timeout: number): Promise<Response> {
  return fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(method === 'GET' ? {} : { 'Content-Type': contentType }),
      ...(userId ? { 'X-Taskpath-User': userId } : {}),
    },
    body,
    signal: AbortSignal.timeout(timeout),
  });
}

export async function apiRequest<T = unknown>(path: string, method: HttpMethod = 'GET',
  body?: unknown, userId = selectedAccount()): Promise<T> {
  const response = await request(path, method, body === undefined ? undefined : JSON.stringify(body),
    userId, 'application/json', 12000);
  if (!response.ok) {
    let message = response.status === 401
      ? 'Sign in to sync. Encrypted changes are saved on this device.'
      : 'Could not complete the request. Your encrypted changes are safe on this device.';
    try {
      const value: unknown = await response.json();
      if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') {
        message = value.error || message;
      }
    } catch { /* A proxy may return a non-JSON error. */ }
    throw new RequestError(message, response.status);
  }
  return response.json();
}

// Preserve binary bodies and leave successful download streams unread so sync
// can enforce encrypted file lengths without buffering an unbounded response.
export async function fileRequest(path: string, method: HttpMethod = 'GET',
  body?: BodyInit, userId = selectedAccount()): Promise<Response> {
  const response = await request('/api/files' + path, method, body, userId,
    method === 'PUT' ? 'application/octet-stream' : 'application/json', 60000);
  if (!response.ok) {
    await response.body?.cancel();
    throw new RequestError(response.status === 401 ? 'Sign in to sync files.'
      : response.status === 507 ? 'Waiting for space'
      : `File transfer failed (${response.status}). Retry when online.`, response.status);
  }
  return response;
}
