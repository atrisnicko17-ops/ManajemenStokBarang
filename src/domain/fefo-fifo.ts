import type { BatchBalance } from './types';

export type AllocationStrategy = 'FEFO' | 'FIFO';

export interface BatchAllocationSlice {
  balanceId: string;
  batchNumber: string;
  expiryDate?: string;
  allocatedQty: number;
}

export interface AllocationPlan {
  slices: BatchAllocationSlice[];
  totalAllocated: number;
  unfulfilledQty: number;
  wouldOverdraft: boolean;
  skippedExpiredBatches: string[];
}

/**
 * Mengalokasikan pemotongan stok berdasarkan metode FEFO (First-Expired, First-Out)
 * atau FIFO (First-In, First-Out). Batch yang telah melewati tanggal kedaluwarsa
 * dilewati secara otomatis untuk pengeluaran reguler agar tidak terkirim ke pelanggan/unit.
 */
export function allocateStockFromBatches(
  batches: readonly BatchBalance[],
  requiredBaseQty: number,
  strategy: AllocationStrategy,
  referenceDateIso: string = new Date().toISOString().slice(0, 10)
): AllocationPlan {
  if (!Number.isInteger(requiredBaseQty) || requiredBaseQty <= 0) {
    throw new Error('Kuantitas alokasi harus berupa bilangan bulat lebih dari nol.');
  }

  const skippedExpiredBatches: string[] = [];
  const eligible: BatchBalance[] = [];

  for (const batch of batches) {
    const isExpired =
      Boolean(batch.expiry_date) && batch.expiry_date! < referenceDateIso;
    if (isExpired && strategy === 'FEFO') {
      if (batch.qty_on_hand - batch.qty_reserved > 0) {
        skippedExpiredBatches.push(batch.batch_number);
      }
      continue;
    }
    eligible.push(batch);
  }

  const sorted = [...eligible].sort((a, b) => {
    if (strategy === 'FEFO') {
      const expA = a.expiry_date ?? '9999-12-31';
      const expB = b.expiry_date ?? '9999-12-31';
      if (expA !== expB) return expA.localeCompare(expB);
    }
    return a.updated_at.localeCompare(b.updated_at);
  });

  const slices: BatchAllocationSlice[] = [];
  let remaining = requiredBaseQty;

  for (const batch of sorted) {
    if (remaining <= 0) break;
    const available = Math.max(0, batch.qty_on_hand - batch.qty_reserved);
    if (available <= 0) continue;

    const take = Math.min(available, remaining);
    slices.push({
      balanceId: batch.id,
      batchNumber: batch.batch_number,
      expiryDate: batch.expiry_date,
      allocatedQty: take,
    });
    remaining -= take;
  }

  // Jika terjadi pengeluaran darurat/offline melebihi stok tercatat, bebankan selisih
  // pada batch utama dengan penanda overdraft agar tercatat di Immutable Ledger
  if (remaining > 0) {
    const fallbackBatch = sorted[0] ?? batches[0];
    if (fallbackBatch) {
      const existingSlice = slices.find((s) => s.balanceId === fallbackBatch.id);
      if (existingSlice) {
        existingSlice.allocatedQty += remaining;
      } else {
        slices.push({
          balanceId: fallbackBatch.id,
          batchNumber: fallbackBatch.batch_number,
          expiryDate: fallbackBatch.expiry_date,
          allocatedQty: remaining,
        });
      }
    }
    return {
      slices,
      totalAllocated: requiredBaseQty,
      unfulfilledQty: remaining,
      wouldOverdraft: true,
      skippedExpiredBatches,
    };
  }

  return {
    slices,
    totalAllocated: requiredBaseQty,
    unfulfilledQty: 0,
    wouldOverdraft: false,
    skippedExpiredBatches,
  };
}
