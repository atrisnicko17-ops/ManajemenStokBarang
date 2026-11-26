import type { RequestType } from './types';

export interface GovernanceEvaluationInput {
  requestType: RequestType;
  qtyBase: number;
  approvalThresholdQty: number;
  isFixedAsset: boolean;
  hasEvidencePhoto: boolean;
  isBinFrozen: boolean;
  partyName: string;
}

export interface GovernanceDecision {
  isValid: boolean;
  validationError?: string;
  requiresApproval: boolean;
  approvalReason?: string;
}

export function evaluateTransactionGovernance(
  input: GovernanceEvaluationInput
): GovernanceDecision {
  if (input.isBinFrozen && input.requestType !== 'OPNAME_ADJUSTMENT') {
    return {
      isValid: false,
      validationError:
        'Lokasi rak sedang dibekukan (Freeze Stock) karena proses Stock Opname berlangsung.',
      requiresApproval: false,
    };
  }

  if (input.qtyBase <= 0 && input.requestType !== 'OPNAME_ADJUSTMENT') {
    return {
      isValid: false,
      validationError: 'Jumlah transaksi harus lebih besar dari 0.',
      requiresApproval: false,
    };
  }

  if (input.requestType === 'WRITE_OFF' && !input.hasEvidencePhoto) {
    return {
      isValid: false,
      validationError: 'Wajib lampirkan foto bukti kerusakan/kadaluarsa!',
      requiresApproval: true,
    };
  }

  if (
    (input.requestType === 'OUTBOUND' || input.requestType === 'ASSET_LOAN') &&
    input.partyName.trim().length < 2
  ) {
    return {
      isValid: false,
      validationError: 'Nama unit/pemohon atau tujuan pengeluaran wajib diisi.',
      requiresApproval: false,
    };
  }

  if (input.requestType === 'WRITE_OFF') {
    return {
      isValid: true,
      requiresApproval: true,
      approvalReason: 'Penghapusan barang rusak/kadaluarsa (Write-off) wajib disetujui pimpinan.',
    };
  }

  if (input.requestType === 'ASSET_LOAN' || input.isFixedAsset) {
    return {
      isValid: true,
      requiresApproval: true,
      approvalReason: 'Peminjaman / pengeluaran aset tetap memerlukan otorisasi pimpinan.',
    };
  }

  if (input.requestType === 'OPNAME_ADJUSTMENT') {
    return {
      isValid: true,
      requiresApproval: true,
      approvalReason: 'Selisih Stock Opname memerlukan persetujuan Berita Acara Penyesuaian.',
    };
  }

  if (input.requestType === 'VOID_COMPENSATION') {
    return {
      isValid: true,
      requiresApproval: true,
      approvalReason: 'Pembatalan transaksi selesai (Void) wajib diotorisasi pimpinan.',
    };
  }

  if (
    (input.requestType === 'OUTBOUND' || input.requestType === 'TRANSFER') &&
    input.qtyBase > input.approvalThresholdQty
  ) {
    return {
      isValid: true,
      requiresApproval: true,
      approvalReason: `Jumlah (${input.qtyBase}) melebihi batas pengeluaran rutin (> ${input.approvalThresholdQty}).`,
    };
  }

  return {
    isValid: true,
    requiresApproval: false,
  };
}
