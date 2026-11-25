const PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function normalizeUsername(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9._-]/g, '');
}

export function validateUsername(raw: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = normalizeUsername(raw);
  if (!normalized || normalized.length < 3) {
    return {
      valid: false,
      normalized,
      error: 'O usuário deve ter pelo menos 3 caracteres (letras, números, ponto, _ ou -).',
    };
  }
  if (normalized.length > 32) {
    return {
      valid: false,
      normalized,
      error: 'O usuário deve ter no máximo 32 caracteres.',
    };
  }
  return { valid: true, normalized };
}

export function generateSaltHex(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function derivePbkdf2Hex(password: string, saltHex: string): Promise<string> {
  if (window.crypto?.subtle) {
    const encoder = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const saltBytes = hexToBytes(saltHex);
    const saltBuffer = saltBytes.buffer.slice(
      saltBytes.byteOffset,
      saltBytes.byteOffset + saltBytes.byteLength
    ) as ArrayBuffer;
    const derivedBits = await window.crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: saltBuffer,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );
    return bytesToHex(new Uint8Array(derivedBits));
  }

  // Fallback determinístico caso crypto.subtle não esteja disponível
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const combined = `${saltHex}:${password}`;
  for (let i = 0; i < combined.length; i++) {
    const ch = combined.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = generateSaltHex();
  const hash = await derivePbkdf2Hex(password, salt);
  return { hash, salt };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string): Promise<boolean> {
  if (!password || !salt || !expectedHash) return false;
  const computed = await derivePbkdf2Hex(password, salt);
  return timingSafeEqualHex(computed, expectedHash);
}
