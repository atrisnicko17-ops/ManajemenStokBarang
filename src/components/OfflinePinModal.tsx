'use client';

import React, { useEffect, useId, useState } from 'react';
import { Delete, KeyRound, Lock, QrCode, ShieldAlert } from 'lucide-react';
import {
  evaluatePinLockoutStatus,
  isSixDigitPin,
  type PinLockoutState,
  recordPinVerificationResult,
  verifyOfflinePin,
} from '@/domain/pin-crypto';
import type { NetworkMode, UserAccount } from '@/domain/types';
import { recordSecurityPinLockoutEvent } from '@/offline/sync-worker';
import { ModalDialog } from './ModalDialog';

const LOCKOUT_STORAGE_KEY_PREFIX = 'gudangku_pin_lockout_';

interface OfflinePinModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenantId: string;
  warehouseId: string;
  approver: UserAccount | undefined;
  operator: UserAccount;
  networkMode: NetworkMode;
  approverTitle: string;
  onAuthorized: (approver: UserAccount) => void;
}

export function OfflinePinModal({
  isOpen,
  onClose,
  tenantId,
  warehouseId,
  approver,
  operator,
  networkMode,
  approverTitle,
  onAuthorized,
}: OfflinePinModalProps) {
  const [pinInput, setPinInput] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [lockoutState, setLockoutState] = useState<PinLockoutState>({
    failedAttempts: 0,
    lockoutUntilMs: null,
  });
  const [nowTick, setNowTick] = useState(() => Date.now());
  const pinFieldId = useId();
  const errorId = useId();

  const storageKey = `${LOCKOUT_STORAGE_KEY_PREFIX}${tenantId}`;

  useEffect(() => {
    if (!isOpen) {
      setPinInput('');
      setErrorMsg('');
      return;
    }
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as PinLockoutState;
        setLockoutState(parsed);
      }
    } catch {
      // Abaikan jika storage terbatas
    }
  }, [isOpen, storageKey]);

  const lockEvaluation = evaluatePinLockoutStatus(lockoutState, nowTick);

  useEffect(() => {
    if (!isOpen || !lockEvaluation.isLocked) return;
    const interval = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isOpen, lockEvaluation.isLocked]);

  const persistLockout = (next: PinLockoutState) => {
    setLockoutState(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Abaikan
    }
  };

  const handleVerifyPin = async (candidate: string) => {
    if (!approver || !approver.offline_pin_hash || !approver.offline_pin_salt) {
      setErrorMsg(`Akun ${approverTitle} belum memiliki konfigurasi PIN offline.`);
      return;
    }

    const currentLock = evaluatePinLockoutStatus(lockoutState, Date.now());
    if (currentLock.isLocked) return;

    if (!isSixDigitPin(candidate)) {
      setErrorMsg('Masukkan tepat 6 digit angka PIN otorisasi.');
      return;
    }

    const valid = await verifyOfflinePin(
      candidate,
      approver.offline_pin_hash,
      approver.offline_pin_salt
    );

    const outcome = recordPinVerificationResult(lockoutState, valid, Date.now());
    persistLockout(outcome.nextState);

    if (valid) {
      setPinInput('');
      setErrorMsg('');
      onAuthorized(approver);
      onClose();
      return;
    }

    setPinInput('');
    if (outcome.triggeredSecurityLockout) {
      await recordSecurityPinLockoutEvent({
        tenantId,
        warehouseId,
        actor: operator,
        networkMode,
      });
      setErrorMsg(
        'Salah PIN 3 kali berturut-turut. Otorisasi dikunci selama 15 menit dan dilaporkan ke Audit Trail.'
      );
    } else {
      setErrorMsg(
        `PIN tidak cocok. Sisa kesempatan: ${outcome.attemptsRemaining} percobaan.`
      );
    }
  };

  const appendDigit = (digit: string) => {
    if (lockEvaluation.isLocked) return;
    if (errorMsg) setErrorMsg('');
    const next = (pinInput + digit).slice(0, 6);
    setPinInput(next);
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title={`Otorisasi di Tempat (${approverTitle})`}
      subtitle={
        approver
          ? `${approver.full_name} • Verifikasi kriptografi PBKDF2 lokal (< 50ms)`
          : 'Verifikasi PIN 6-Digit Supervisor'
      }
      maxWidthClass="max-w-md"
    >
      <div className="space-y-4">
        {lockEvaluation.isLocked ? (
          <div
            role="alert"
            className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-900 space-y-1.5"
          >
            <div className="flex items-center gap-2 font-semibold text-sm">
              <Lock size={18} strokeWidth={1.5} className="text-red-600" />
              <span>PIN Override dikunci sementara</span>
            </div>
            <p className="text-xs leading-relaxed">
              Terdeteksi 3 kali percobaan salah. Silakan tunggu{' '}
              <span className="font-mono-tech font-semibold">
                {Math.floor(lockEvaluation.remainingSeconds / 60)}:
                {String(lockEvaluation.remainingSeconds % 60).padStart(2, '0')}
              </span>{' '}
              menit. Pelanggaran telah dicatat sebagai{' '}
              <code className="font-mono-tech">SECURITY_PIN_LOCKOUT</code>.
            </p>
          </div>
        ) : (
          <form
            method="POST"
            action="#verify-offline-pin"
            onSubmit={(e) => {
              e.preventDefault();
              void handleVerifyPin(pinInput);
            }}
            className="space-y-4"
          >
            <div>
              <label
                htmlFor={pinFieldId}
                className="block text-xs font-medium text-slate-700 mb-2"
              >
                Masukkan 6-digit PIN pribadi {approverTitle} (demo sandbox:{' '}
                <span className="font-mono-tech font-semibold text-slate-900">
                  123456
                </span>
                )
              </label>

              {/* Indikator 6 Titik Visual */}
              <div
                aria-hidden="true"
                className="flex items-center justify-center gap-3 py-2 mb-2"
              >
                {[0, 1, 2, 3, 4, 5].map((idx) => {
                  const filled = idx < pinInput.length;
                  return (
                    <span
                      key={idx}
                      className={`h-4 w-4 rounded-full border transition-colors ${
                        filled
                          ? 'border-amber-600 bg-amber-600'
                          : 'border-slate-300 bg-slate-100'
                      }`}
                    />
                  );
                })}
              </div>

              {/* Single-field accessible input sesuai modern-web-guidance forms */}
              <input
                id={pinFieldId}
                name="supervisor_pin"
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={pinInput}
                onChange={(e) => {
                  const cleaned = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setPinInput(cleaned);
                  if (errorMsg) setErrorMsg('');
                }}
                aria-invalid={errorMsg ? 'true' : undefined}
                aria-describedby={errorMsg ? errorId : undefined}
                placeholder="Ketik 6 digit PIN"
                className="w-full rounded-lg border border-slate-300 px-3 text-center font-mono-tech text-lg tracking-widest text-slate-900"
              />

              {errorMsg && (
                <p
                  id={errorId}
                  role="alert"
                  className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-700"
                >
                  <ShieldAlert size={16} strokeWidth={1.5} className="shrink-0" />
                  <span>{errorMsg}</span>
                </p>
              )}
            </div>

            {/* Keypad Numerik Sentuh Layar HP Staf (>= 52px touch targets) */}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                <button
                  key={digit}
                  type="button"
                  onClick={() => appendDigit(digit)}
                  className="min-h-[52px] rounded-lg border border-slate-200 bg-slate-50 font-mono-tech text-lg font-semibold text-slate-900 transition-colors hover:bg-slate-100 active:bg-slate-200"
                >
                  {digit}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setPinInput('');
                  setErrorMsg('');
                }}
                className="min-h-[52px] rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
              >
                Bersihkan
              </button>
              <button
                type="button"
                onClick={() => appendDigit('0')}
                className="min-h-[52px] rounded-lg border border-slate-200 bg-slate-50 font-mono-tech text-lg font-semibold text-slate-900 transition-colors hover:bg-slate-100 active:bg-slate-200"
              >
                0
              </button>
              <button
                type="button"
                onClick={() => setPinInput((p) => p.slice(0, -1))}
                aria-label="Hapus satu digit"
                className="inline-flex min-h-[52px] items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-100"
              >
                <Delete size={18} strokeWidth={1.5} />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 pt-1">
              <button
                type="submit"
                className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 text-sm font-medium text-white transition-colors hover:bg-amber-700"
              >
                <KeyRound size={18} strokeWidth={1.5} />
                <span>Sahkan dengan PIN Supervisor</span>
              </button>

              {approver?.qr_supervisor_token && (
                <button
                  type="button"
                  onClick={() => {
                    onAuthorized(approver);
                    onClose();
                  }}
                  className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  <QrCode size={16} strokeWidth={1.5} />
                  <span>Simulasi pindai Kartu ID QR Supervisor</span>
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </ModalDialog>
  );
}
