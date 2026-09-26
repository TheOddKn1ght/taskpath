import { argon2id, argon2Verify } from 'hash-wasm';
import { randomBytes } from 'node:crypto';

// Argon2id verifier in PHC $argon2id$v=19$ format (m=65536, t=2, p=1),
// matching the verifiers issued before the Deno port. hash-wasm is pure
// WASM with no native dependencies.
export async function hashCredential(credential: string): Promise<string> {
  return argon2id({
    password: credential,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 65536,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function verifyCredential(credential: string, verifier: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: credential, hash: verifier });
  } catch {
    return false;
  }
}
