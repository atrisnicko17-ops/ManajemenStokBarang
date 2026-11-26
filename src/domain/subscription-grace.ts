import type { SubscriptionTier } from './types';

export const OFFLINE_GRACE_PERIOD_HOURS = 72;

export interface TierQuotaLimits {
  maxWarehouses: number;
  maxSkus: number;
  maxOfflineQueue: number;
  allowOfflinePinOverride: boolean;
  allowBastAndAssetLoan: boolean;
}

const TIER_LIMITS: Record<SubscriptionTier, TierQuotaLimits> = {
  FREE: {
    maxWarehouses: 1,
    maxSkus: 100,
    maxOfflineQueue: 20,
    allowOfflinePinOverride: false,
    allowBastAndAssetLoan: false,
  },
  PRO: {
    maxWarehouses: 3,
    maxSkus: 2500,
    maxOfflineQueue: 2000,
    allowOfflinePinOverride: true,
    allowBastAndAssetLoan: true,
  },
  ENTERPRISE: {
    maxWarehouses: Number.MAX_SAFE_INTEGER,
    maxSkus: Number.MAX_SAFE_INTEGER,
    maxOfflineQueue: 10000,
    allowOfflinePinOverride: true,
    allowBastAndAssetLoan: true,
  },
};

export function getTierQuotaLimits(tier: SubscriptionTier): TierQuotaLimits {
  return TIER_LIMITS[tier];
}

export type SubscriptionAccessMode = 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY';

export interface SubscriptionLifecycleStatus {
  mode: SubscriptionAccessMode;
  canCreateTransactions: boolean;
  graceHoursRemaining: number;
  warningBannerText?: string;
}

/**
 * Mengevaluasi siklus masa aktif langganan SaaS di area tanpa sinyal:
 * - ACTIVE: sebelum tanggal kedaluwarsa.
 * - GRACE_PERIOD: hingga 72 jam setelah kedaluwarsa (tetap mengizinkan transaksi + banner kuning).
 * - READ_ONLY: lewat 72 jam DAN antrean lokal sudah 0 (data tetap aman untuk ekspor CSV/PDF,
 *   namun transaksi baru dikunci sampai paket diperpanjang).
 */
export function evaluateSubscriptionLifecycle(
  validUntilIso: string,
  pendingSyncCount: number,
  nowMs: number = Date.now()
): SubscriptionLifecycleStatus {
  const validUntilMs = Date.parse(validUntilIso);
  if (Number.isNaN(validUntilMs) || nowMs <= validUntilMs) {
    return {
      mode: 'ACTIVE',
      canCreateTransactions: true,
      graceHoursRemaining: OFFLINE_GRACE_PERIOD_HOURS,
    };
  }

  const graceDeadlineMs = validUntilMs + OFFLINE_GRACE_PERIOD_HOURS * 3600 * 1000;
  if (nowMs <= graceDeadlineMs) {
    const hoursLeft = Math.max(1, Math.ceil((graceDeadlineMs - nowMs) / (3600 * 1000)));
    return {
      mode: 'GRACE_PERIOD',
      canCreateTransactions: true,
      graceHoursRemaining: hoursLeft,
      warningBannerText: `Masa aktif langganan telah berakhir. Mode toleransi operasional gudang aktif selama ${hoursLeft} jam lagi sebelum beralih ke Baca-Saja.`,
    };
  }

  if (pendingSyncCount > 0) {
    return {
      mode: 'GRACE_PERIOD',
      canCreateTransactions: false,
      graceHoursRemaining: 0,
      warningBannerText: `Masa tenggang 72 jam habis. Selesaikan sinkronisasi ${pendingSyncCount} antrean lokal terlebih dahulu; pembuatan transaksi baru dikunci.`,
    };
  }

  return {
    mode: 'READ_ONLY',
    canCreateTransactions: false,
    graceHoursRemaining: 0,
    warningBannerText:
      'Akun berada dalam mode Baca-Saja (Read-Only). Seluruh data aman dan dapat diekspor ke CSV/PDF; perpanjang paket untuk mencatat mutasi baru.',
  };
}
