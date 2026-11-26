const PBKDF2_ITERATIONS = 100_000;
export const MAX_PIN_ATTEMPTS = 3;
export const PIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 menit

export interface PinLockoutState {
  failedAttempts: number;
  lockoutUntilMs: number | null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isSixDigitPin(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

/**
 * Menghasilkan hash 64-karakter hex (256-bit) menggunakan Web Crypto API PBKDF2-SHA256.
 * Berjalan murni di browser/Node >= 20 tanpa pustaka eksternal (< 50ms).
 */
export async function deriveOfflinePinHash(pin: string, salt: string): Promise<string> {
  if (!isSixDigitPin(pin)) {
    throw new Error('PIN otorisasi wajib terdiri dari tepat 6 digit angka.');
  }

  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    256
  );

  return bytesToHex(new Uint8Array(derivedBits));
}

/**
 * Perbandingan waktu konstan (constant-time comparison) untuk mencegah timing attack lokal.
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function verifyOfflinePin(
  candidatePin: string,
  expectedHashHex: string,
  salt: string
): Promise<boolean> {
  if (!isSixDigitPin(candidatePin) || !/^[a-f0-9]{64}$/.test(expectedHashHex)) {
    return false;
  }
  const computed = await deriveOfflinePinHash(candidatePin, salt);
  return constantTimeEqualHex(computed, expectedHashHex);
}

export function evaluatePinLockoutStatus(
  state: PinLockoutState,
  nowMs: number = Date.now()
): { isLocked: boolean; remainingSeconds: number; normalizedState: PinLockoutState } {
  if (state.lockoutUntilMs !== null && state.lockoutUntilMs > nowMs) {
    return {
      isLocked: true,
      remainingSeconds: Math.ceil((state.lockoutUntilMs - nowMs) / 1000),
      normalizedState: state,
    };
  }

  if (state.lockoutUntilMs !== null && state.lockoutUntilMs <= nowMs) {
    return {
      isLocked: false,
      remainingSeconds: 0,
      normalizedState: { failedAttempts: 0, lockoutUntilMs: null },
    };
  }

  return {
    isLocked: false,
    remainingSeconds: 0,
    normalizedState: state,
  };
}

export function recordPinVerificationResult(
  currentState: PinLockoutState,
  isSuccess: boolean,
  nowMs: number = Date.now()
): {
  nextState: PinLockoutState;
  triggeredSecurityLockout: boolean;
  attemptsRemaining: number;
} {
  const status = evaluatePinLockoutStatus(currentState, nowMs);
  if (status.isLocked) {
    return {
      nextState: status.normalizedState,
      triggeredSecurityLockout: false,
      attemptsRemaining: 0,
    };
  }

  if (isSuccess) {
    return {
      nextState: { failedAttempts: 0, lockoutUntilMs: null },
      triggeredSecurityLockout: false,
      attemptsRemaining: MAX_PIN_ATTEMPTS,
    };
  }

  const nextFailed = status.normalizedState.failedAttempts + 1;
  if (nextFailed >= MAX_PIN_ATTEMPTS) {
    return {
      nextState: {
        failedAttempts: nextFailed,
        lockoutUntilMs: nowMs + PIN_LOCKOUT_DURATION_MS,
      },
      triggeredSecurityLockout: true,
      attemptsRemaining: 0,
    };
  }

  return {
    nextState: {
      failedAttempts: nextFailed,
      lockoutUntilMs: null,
    },
    triggeredSecurityLockout: false,
    attemptsRemaining: MAX_PIN_ATTEMPTS - nextFailed,
  };
}
