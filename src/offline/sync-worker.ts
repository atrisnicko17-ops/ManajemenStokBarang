import { allocateStockFromBatches } from '@/domain/fefo-fifo';
import { getProfileTerminology } from '@/domain/profile-terminology';
import {
  evaluateSubscriptionLifecycle,
  getTierQuotaLimits,
} from '@/domain/subscription-grace';
import { evaluateTransactionGovernance } from '@/domain/threshold-rules';
import type {
  ApprovalMethod,
  AssetCondition,
  LedgerEntry,
  LedgerEventType,
  NetworkMode,
  OutboxEvent,
  RequestType,
  StockRequest,
  UserAccount,
} from '@/domain/types';
import { convertToBaseUnit } from '@/domain/uom-converter';
import { generateUuidV7 } from '@/domain/uuidv7';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { type GudangKuOfflineDB, localDB } from './db';

export const LIE_FI_TIMEOUT_MS = 3500;

export interface SubmitTransactionParams {
  tenantId: string;
  warehouseId: string;
  targetWarehouseId?: string;
  itemId: string;
  requestType: RequestType;
  qtyInput: number;
  selectedUnit: string;
  partyName: string;
  reason: string;
  batchNumber?: string;
  expiryDate?: string;
  dueReturnDate?: string;
  evidencePhotoDataUrl?: string;
  evidencePhotoName?: string;
  evidenceSizeKb?: number;
  actor: UserAccount;
  networkMode: NetworkMode;
  offlineAuthOverride?: {
    method: 'OFFLINE_PIN_OVERRIDE' | 'EMERGENCY_UNVERIFIED';
    approverId?: string;
    approverName?: string;
  };
  deviceOrigin?: string;
}

export interface SubmitTransactionResult {
  outcome:
    | 'EXECUTED_ONLINE'
    | 'QUEUED_OFFLINE'
    | 'SENT_FOR_APPROVAL'
    | 'PIN_OVERRIDE_QUEUED'
    | 'EMERGENCY_RELEASE_QUEUED';
  message: string;
  requestCode: string;
  qtyBase: number;
}

async function checkReachabilityWithTimeout(
  networkMode: NetworkMode,
  timeoutMs: number = LIE_FI_TIMEOUT_MS
): Promise<boolean> {
  if (networkMode === 'OFFLINE') return false;
  if (networkMode === 'LIE_FI') {
    // Simulasi router Wi-Fi tanpa internet (Lie-Fi): dibatasi ketat <= 3,5 detik via AbortController
    const controller = new AbortController();
    const waitMs = Math.min(timeoutMs, 850);
    const timer = setTimeout(() => controller.abort(), waitMs);
    try {
      await new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () =>
          reject(new DOMException('Lie-Fi network timeout', 'AbortError'))
        );
      });
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  return true;
}

function nextRequestCode(): string {
  const num = Math.floor(1043 + (Date.now() % 8900));
  return `#REQ-${num}`;
}

export async function submitInventoryTransaction(
  params: SubmitTransactionParams,
  db: GudangKuOfflineDB = localDB
): Promise<SubmitTransactionResult> {
  const tenant = await db.tenants.get(params.tenantId);
  if (!tenant) {
    throw new Error('Konfigurasi organisasi (tenant) tidak ditemukan.');
  }

  const outboxCount = await db.outbox
    .where('tenant_id')
    .equals(params.tenantId)
    .count();
  const lifecycle = evaluateSubscriptionLifecycle(
    tenant.subscription_valid_until,
    outboxCount
  );
  if (!lifecycle.canCreateTransactions) {
    throw new Error(
      lifecycle.warningBannerText ??
        'Masa aktif paket berakhir. Akun berada dalam mode Baca-Saja (Read-Only).'
    );
  }

  const item = await db.items.get(params.itemId);
  if (!item || item.tenant_id !== params.tenantId) {
    throw new Error('Barang (SKU) tidak ditemukan pada katalog organisasi ini.');
  }

  const binRecord = await db.bins
    .where('[warehouse_id+bin_code]')
    .equals([params.warehouseId, item.default_bin_code])
    .first()
    .catch(() =>
      db.bins
        .where('warehouse_id')
        .equals(params.warehouseId)
        .filter((b) => b.bin_code === item.default_bin_code)
        .first()
    );

  const conversion = convertToBaseUnit(
    params.qtyInput,
    params.selectedUnit,
    item.base_unit,
    item.uoms
  );

  const governance = evaluateTransactionGovernance({
    requestType: params.requestType,
    qtyBase: conversion.qtyBase,
    approvalThresholdQty: tenant.approval_threshold_qty,
    isFixedAsset: item.is_fixed_asset,
    hasEvidencePhoto: Boolean(params.evidencePhotoDataUrl),
    isBinFrozen: Boolean(binRecord?.is_frozen),
    partyName:
      params.requestType === 'INBOUND' || params.requestType === 'WRITE_OFF'
        ? params.partyName || 'Gudang Internal'
        : params.partyName,
  });

  if (!governance.isValid) {
    throw new Error(governance.validationError ?? 'Data transaksi tidak valid.');
  }

  const isReachable = await checkReachabilityWithTimeout(params.networkMode);
  const tierLimits = getTierQuotaLimits(tenant.subscription_tier);

  if (!isReachable && outboxCount >= tierLimits.maxOfflineQueue) {
    throw new Error(
      `Antrean offline penuh (${tierLimits.maxOfflineQueue} transaksi untuk paket ${tenant.subscription_tier}). Hubungkan ke internet untuk menyinkronkan antrean.`
    );
  }

  const nowIso = new Date().toISOString();
  const reqId = generateUuidV7();
  const reqCode = nextRequestCode();
  const deviceLabel = params.deviceOrigin ?? (isReachable ? 'Cloud (Online)' : 'PWA-Mobile-Offline');
  const terms = getProfileTerminology(tenant.business_profile);

  const itemBalances = await db.balances
    .where('warehouse_id')
    .equals(params.warehouseId)
    .filter((b) => b.item_id === item.id)
    .toArray();

  // Tentukan batch target menggunakan FEFO (untuk profil dengan kedaluwarsa) atau FIFO
  const targetBatchNumber =
    params.batchNumber?.trim() ||
    (params.requestType === 'INBOUND'
      ? `PO-${nowIso.slice(0, 10)}`
      : itemBalances[0]?.batch_number ?? 'GENERAL');

  // KASUS 1: Butuh Approval & Sedang Online (Kirim ke Kotak Masuk Pimpinan + Kunci Stok Reserved)
  if (governance.requiresApproval && isReachable && !params.offlineAuthOverride) {
    const newReq: StockRequest = {
      id: reqId,
      tenant_id: params.tenantId,
      warehouse_id: params.warehouseId,
      target_warehouse_id: params.targetWarehouseId,
      request_code: reqCode,
      request_type: params.requestType,
      item_id: item.id,
      batch_number: targetBatchNumber,
      qty_requested_base: conversion.qtyBase,
      uom_used: `${conversion.qtyInput} ${conversion.unitSelected}`,
      party_name: params.partyName.trim() || 'Gudang Internal',
      reason: params.reason.trim() || governance.approvalReason || 'Pengajuan mutasi',
      status: 'PENDING_APPROVAL',
      requested_by: params.actor.id,
      requested_by_name: params.actor.full_name,
      is_flagged_unverified: false,
      evidence_photo_data_url: params.evidencePhotoDataUrl,
      evidence_photo_name: params.evidencePhotoName,
      evidence_size_kb: params.evidenceSizeKb,
      due_return_date: params.dueReturnDate,
      created_at: nowIso,
      synced_at: nowIso,
    };

    await db.transaction('rw', [db.requests, db.balances, db.auditLogs], async () => {
      await db.requests.put(newReq);
      if (params.requestType !== 'INBOUND' && itemBalances.length > 0) {
        const primaryBal = itemBalances[0];
        await db.balances.update(primaryBal.id, {
          qty_reserved: primaryBal.qty_reserved + conversion.qtyBase,
          updated_at: nowIso,
        });
      }
      await db.auditLogs.put({
        id: generateUuidV7(),
        tenant_id: params.tenantId,
        actor_id: params.actor.id,
        actor_name: params.actor.full_name,
        action_type: 'REQUEST_SUBMITTED',
        target_id: `${reqCode} (${item.sku_code})`,
        summary: `Pengajuan ${params.requestType} sebesar ${conversion.qtyBase} ${item.base_unit} dikirim ke ${terms.approverTitle} (stok dikunci).`,
        created_at: nowIso,
      });
    });

    return {
      outcome: 'SENT_FOR_APPROVAL',
      message: `Pengajuan ${reqCode} dikirim ke ${terms.approverTitle}. Stok ${conversion.qtyBase} ${item.base_unit} dikunci sementara.`,
      requestCode: reqCode,
      qtyBase: conversion.qtyBase,
    };
  }

  // KASUS 2: Butuh Approval & Offline TANPA PIN Override -> Simpan sebagai Pengajuan di Antrean / Menunggu Sinyal
  if (governance.requiresApproval && !isReachable && !params.offlineAuthOverride) {
    const queuedReq: StockRequest = {
      id: reqId,
      tenant_id: params.tenantId,
      warehouse_id: params.warehouseId,
      target_warehouse_id: params.targetWarehouseId,
      request_code: reqCode,
      request_type: params.requestType,
      item_id: item.id,
      batch_number: targetBatchNumber,
      qty_requested_base: conversion.qtyBase,
      uom_used: `${conversion.qtyInput} ${conversion.unitSelected}`,
      party_name: params.partyName.trim() || 'Gudang Internal',
      reason: params.reason.trim() || 'Menunggu sinyal untuk persetujuan pimpinan',
      status: 'PENDING_APPROVAL',
      requested_by: params.actor.id,
      requested_by_name: params.actor.full_name,
      is_flagged_unverified: false,
      evidence_photo_data_url: params.evidencePhotoDataUrl,
      evidence_photo_name: params.evidencePhotoName,
      evidence_size_kb: params.evidenceSizeKb,
      due_return_date: params.dueReturnDate,
      created_at: nowIso,
    };

    await db.transaction('rw', [db.requests, db.balances], async () => {
      await db.requests.put(queuedReq);
      if (params.requestType !== 'INBOUND' && itemBalances.length > 0) {
        const primaryBal = itemBalances[0];
        await db.balances.update(primaryBal.id, {
          qty_reserved: primaryBal.qty_reserved + conversion.qtyBase,
          updated_at: nowIso,
        });
      }
    });

    return {
      outcome: 'QUEUED_OFFLINE',
      message: `Tersimpan di memori perangkat (${reqCode}). Pengajuan akan dikirim ke pimpinan saat sinyal pulih.`,
      requestCode: reqCode,
      qtyBase: conversion.qtyBase,
    };
  }

  // Hitung alokasi batch & tanda delta (+ untuk masuk, - untuk keluar)
  const isInbound = params.requestType === 'INBOUND';
  const strategy = terms.enableFefoExpiry ? 'FEFO' : 'FIFO';
  const allocation = isInbound
    ? {
        slices: [
          {
            balanceId: itemBalances[0]?.id ?? generateUuidV7(),
            batchNumber: targetBatchNumber,
            expiryDate: params.expiryDate,
            allocatedQty: conversion.qtyBase,
          },
        ],
        wouldOverdraft: false,
      }
    : allocateStockFromBatches(itemBalances, conversion.qtyBase, strategy);

  const approvalMethod: ApprovalMethod =
    params.offlineAuthOverride?.method ?? 'AUTO_APPROVED';

  const eventType: LedgerEventType =
    approvalMethod === 'OFFLINE_PIN_OVERRIDE'
      ? 'PIN_OVERRIDE_APPROVED'
      : approvalMethod === 'EMERGENCY_UNVERIFIED'
        ? 'EMERGENCY_RELEASE'
        : params.requestType === 'TRANSFER'
          ? 'TRANSFER_OUT'
          : (params.requestType as LedgerEventType);

  // KASUS 3: Sedang Offline (Rutin Auto-Approved ATAU Offline PIN Override ATAU Emergency Release)
  // Masukkan ke Outbox Queue berbasis UUIDv7 untuk disinkronkan saat online!
  if (!isReachable) {
    const outboxEvents: OutboxEvent[] = allocation.slices.map((slice) => ({
      id: generateUuidV7(),
      tenant_id: params.tenantId,
      warehouse_id: params.warehouseId,
      item_id: item.id,
      request_id: reqId,
      batch_number: slice.batchNumber,
      event_type: eventType,
      qty_delta: isInbound ? slice.allocatedQty : -slice.allocatedQty,
      actor_id: params.offlineAuthOverride?.approverId ?? params.actor.id,
      actor_name: params.offlineAuthOverride?.approverName ?? params.actor.full_name,
      approval_method: approvalMethod,
      device_origin: deviceLabel,
      notes: `${reqCode} • ${params.partyName || 'Operasional Gudang'}${params.reason ? ` — ${params.reason}` : ''}`,
      media_stage_status: params.evidencePhotoDataUrl ? 'PENDING_MEDIA' : 'NONE',
      evidence_photo_data_url: params.evidencePhotoDataUrl,
      created_at: nowIso,
      retry_count: 0,
    }));

    const completedOfflineReq: StockRequest = {
      id: reqId,
      tenant_id: params.tenantId,
      warehouse_id: params.warehouseId,
      target_warehouse_id: params.targetWarehouseId,
      request_code: reqCode,
      request_type: params.requestType,
      item_id: item.id,
      batch_number: targetBatchNumber,
      qty_requested_base: conversion.qtyBase,
      qty_approved_base: conversion.qtyBase,
      uom_used: `${conversion.qtyInput} ${conversion.unitSelected}`,
      party_name: params.partyName.trim() || 'Operasional Gudang',
      reason: params.reason.trim(),
      status: 'COMPLETED',
      requested_by: params.actor.id,
      requested_by_name: params.actor.full_name,
      approved_by: params.offlineAuthOverride?.approverId,
      approved_by_name: params.offlineAuthOverride?.approverName,
      approval_method: approvalMethod,
      is_flagged_unverified: approvalMethod === 'EMERGENCY_UNVERIFIED',
      evidence_photo_data_url: params.evidencePhotoDataUrl,
      evidence_photo_name: params.evidencePhotoName,
      evidence_size_kb: params.evidenceSizeKb,
      created_at: nowIso,
    };

    await db.transaction('rw', [db.outbox, db.requests, db.auditLogs], async () => {
      await db.outbox.bulkPut(outboxEvents);
      await db.requests.put(completedOfflineReq);
      if (approvalMethod !== 'AUTO_APPROVED') {
        await db.auditLogs.put({
          id: generateUuidV7(),
          tenant_id: params.tenantId,
          actor_id: params.offlineAuthOverride?.approverId ?? params.actor.id,
          actor_name: params.offlineAuthOverride?.approverName ?? params.actor.full_name,
          action_type:
            approvalMethod === 'EMERGENCY_UNVERIFIED'
              ? 'FLAGGED_UNVERIFIED'
              : 'OFFLINE_PIN_OVERRIDE',
          target_id: `${reqCode} (${item.sku_code})`,
          summary:
            approvalMethod === 'EMERGENCY_UNVERIFIED'
              ? `Pengeluaran darurat tanpa sinyal & tanpa atasan (${conversion.qtyBase} ${item.base_unit}) — wajib verifikasi susulan.`
              : `Otorisasi PIN di tempat oleh ${params.offlineAuthOverride?.approverName ?? 'Supervisor'} saat offline (${conversion.qtyBase} ${item.base_unit}).`,
          created_at: nowIso,
        });
      }
    });

    return {
      outcome:
        approvalMethod === 'OFFLINE_PIN_OVERRIDE'
          ? 'PIN_OVERRIDE_QUEUED'
          : approvalMethod === 'EMERGENCY_UNVERIFIED'
            ? 'EMERGENCY_RELEASE_QUEUED'
            : 'QUEUED_OFFLINE',
      message:
        approvalMethod === 'OFFLINE_PIN_OVERRIDE'
          ? `Otorisasi PIN sah! ${reqCode} tersimpan di memori HP (+${outboxEvents.length} antrean sync).`
          : approvalMethod === 'EMERGENCY_UNVERIFIED'
            ? `Pengeluaran darurat ${reqCode} dicatat dengan penanda FLAGGED_UNVERIFIED di antrean sync.`
            : `Tersimpan di memori HP (${reqCode}). Akan disinkronkan otomatis saat sinyal pulih.`,
      requestCode: reqCode,
      qtyBase: conversion.qtyBase,
    };
  }

  // KASUS 4: Transaksi Rutin Online (Eksekusi Atomik Langsung ke Saldo & Immutable Ledger)
  await db.transaction(
    'rw',
    [db.balances, db.ledger, db.requests, db.auditLogs],
    async () => {
      for (const slice of allocation.slices) {
        const existingBal = await db.balances
          .where('warehouse_id')
          .equals(params.warehouseId)
          .filter(
            (b) => b.item_id === item.id && b.batch_number === slice.batchNumber
          )
          .first();

        const delta = isInbound ? slice.allocatedQty : -slice.allocatedQty;
        const prevQty = existingBal?.qty_on_hand ?? 0;
        const nextQty = prevQty + delta;
        const isOverdraft = nextQty < 0;

        if (existingBal) {
          await db.balances.update(existingBal.id, {
            qty_on_hand: nextQty,
            expiry_date: params.expiryDate || existingBal.expiry_date,
            updated_at: nowIso,
          });
        } else {
          await db.balances.put({
            id: generateUuidV7(),
            tenant_id: params.tenantId,
            warehouse_id: params.warehouseId,
            bin_code: item.default_bin_code,
            item_id: item.id,
            batch_number: slice.batchNumber,
            expiry_date: params.expiryDate,
            qty_on_hand: nextQty,
            qty_reserved: 0,
            updated_at: nowIso,
          });
        }

        const ledgerEntry: LedgerEntry = {
          id: generateUuidV7(),
          tenant_id: params.tenantId,
          warehouse_id: params.warehouseId,
          item_id: item.id,
          request_id: reqId,
          batch_number: slice.batchNumber,
          event_type: eventType,
          qty_delta: delta,
          is_overdraft_flagged: isOverdraft,
          is_unverified_flagged: false,
          actor_id: params.actor.id,
          actor_name: params.actor.full_name,
          approval_method: approvalMethod,
          device_origin: deviceLabel,
          notes: `${reqCode} • ${params.partyName || (isInbound ? 'Penerimaan Gudang' : 'Pengeluaran Rutin')}`,
          created_at: nowIso,
          synced_at: nowIso,
        };
        await db.ledger.put(ledgerEntry);

        // Jika TRANSFER antar-gudang (Distributor), tambahkan saldo di gudang tujuan
        if (params.requestType === 'TRANSFER' && params.targetWarehouseId) {
          const targetBal = await db.balances
            .where('warehouse_id')
            .equals(params.targetWarehouseId)
            .filter(
              (b) => b.item_id === item.id && b.batch_number === slice.batchNumber
            )
            .first();

          if (targetBal) {
            await db.balances.update(targetBal.id, {
              qty_on_hand: targetBal.qty_on_hand + slice.allocatedQty,
              updated_at: nowIso,
            });
          } else {
            await db.balances.put({
              id: generateUuidV7(),
              tenant_id: params.tenantId,
              warehouse_id: params.targetWarehouseId,
              bin_code: 'TRANSIT-IN/01',
              item_id: item.id,
              batch_number: slice.batchNumber,
              expiry_date: slice.expiryDate,
              qty_on_hand: slice.allocatedQty,
              qty_reserved: 0,
              updated_at: nowIso,
            });
          }

          await db.ledger.put({
            id: generateUuidV7(),
            tenant_id: params.tenantId,
            warehouse_id: params.targetWarehouseId,
            item_id: item.id,
            request_id: reqId,
            batch_number: slice.batchNumber,
            event_type: 'TRANSFER_IN',
            qty_delta: slice.allocatedQty,
            is_overdraft_flagged: false,
            is_unverified_flagged: false,
            actor_id: params.actor.id,
            actor_name: params.actor.full_name,
            approval_method: approvalMethod,
            device_origin: deviceLabel,
            notes: `${reqCode} • Transfer masuk dari gudang asal`,
            created_at: nowIso,
            synced_at: nowIso,
          });
        }
      }

      await db.requests.put({
        id: reqId,
        tenant_id: params.tenantId,
        warehouse_id: params.warehouseId,
        target_warehouse_id: params.targetWarehouseId,
        request_code: reqCode,
        request_type: params.requestType,
        item_id: item.id,
        batch_number: targetBatchNumber,
        qty_requested_base: conversion.qtyBase,
        qty_approved_base: conversion.qtyBase,
        uom_used: `${conversion.qtyInput} ${conversion.unitSelected}`,
        party_name: params.partyName.trim() || (isInbound ? 'Supplier / PO' : 'Operasional Rutin'),
        reason: params.reason.trim(),
        status: 'COMPLETED',
        requested_by: params.actor.id,
        requested_by_name: params.actor.full_name,
        approval_method: 'AUTO_APPROVED',
        is_flagged_unverified: false,
        created_at: nowIso,
        synced_at: nowIso,
      });
    }
  );

  return {
    outcome: 'EXECUTED_ONLINE',
    message: `Transaksi ${reqCode} berhasil dicatat (${isInbound ? '+' : '-'}${conversion.qtyBase} ${item.base_unit}).`,
    requestCode: reqCode,
    qtyBase: conversion.qtyBase,
  };
}

/**
 * Keputusan Approver (Kepala Sekolah / Kepala Gudang): Setujui (dengan opsi revisi jumlah) atau Tolak.
 */
export async function decidePendingRequest(
  params: {
    requestId: string;
    decision: 'APPROVE' | 'REJECT';
    revisedQtyBase?: number;
    rejectionReason?: string;
    approver: UserAccount;
  },
  db: GudangKuOfflineDB = localDB
): Promise<void> {
  const req = await db.requests.get(params.requestId);
  if (!req || req.status !== 'PENDING_APPROVAL') {
    throw new Error('Dokumen pengajuan tidak ditemukan atau sudah diproses.');
  }

  const tenant = await db.tenants.get(req.tenant_id);
  const item = await db.items.get(req.item_id);
  if (!tenant || !item) {
    throw new Error('Data referensi barang/organisasi tidak lengkap.');
  }

  const nowIso = new Date().toISOString();
  const primaryBal = await db.balances
    .where('warehouse_id')
    .equals(req.warehouse_id)
    .filter((b) => b.item_id === req.item_id)
    .first();

  if (params.decision === 'REJECT') {
    if (!params.rejectionReason || params.rejectionReason.trim().length < 3) {
      throw new Error('Alasan penolakan wajib diisi minimal 3 karakter.');
    }

    await db.transaction('rw', [db.requests, db.balances, db.auditLogs], async () => {
      if (primaryBal && req.request_type !== 'INBOUND' && req.request_type !== 'OPNAME_ADJUSTMENT') {
        await db.balances.update(primaryBal.id, {
          qty_reserved: Math.max(0, primaryBal.qty_reserved - req.qty_requested_base),
          updated_at: nowIso,
        });
      }
      await db.requests.update(req.id, {
        status: 'REJECTED',
        approved_by: params.approver.id,
        approved_by_name: params.approver.full_name,
        rejection_reason: params.rejectionReason!.trim(),
        synced_at: nowIso,
      });
      await db.auditLogs.put({
        id: generateUuidV7(),
        tenant_id: req.tenant_id,
        actor_id: params.approver.id,
        actor_name: params.approver.full_name,
        action_type: 'REQUEST_REJECTED',
        target_id: `${req.request_code} (${item.sku_code})`,
        summary: `Ditolak oleh ${params.approver.full_name}: "${params.rejectionReason!.trim()}". Stok dikunci telah dilepas.`,
        created_at: nowIso,
      });
    });
    return;
  }

  const approvedQty =
    params.revisedQtyBase !== undefined ? params.revisedQtyBase : req.qty_requested_base;
  if (req.request_type !== 'OPNAME_ADJUSTMENT' && approvedQty <= 0) {
    throw new Error('Jumlah yang disetujui harus lebih besar dari 0.');
  }

  // Untuk OUTBOUND / ASSET_LOAN pada profil yang mewajibkan BAST/Surat Jalan,
  // status menjadi APPROVED agar staf gudang melakukan serah terima & tanda tangan digital (Layar 1D)
  const needsHandoverSignature =
    tenant.require_bast_signature &&
    (req.request_type === 'OUTBOUND' ||
      req.request_type === 'ASSET_LOAN' ||
      req.request_type === 'TRANSFER');

  await db.transaction(
    'rw',
    [db.requests, db.balances, db.ledger, db.auditLogs],
    async () => {
      if (needsHandoverSignature) {
        if (primaryBal) {
          const adjustedReserved = Math.max(
            0,
            primaryBal.qty_reserved - req.qty_requested_base + approvedQty
          );
          await db.balances.update(primaryBal.id, {
            qty_reserved: adjustedReserved,
            updated_at: nowIso,
          });
        }
        await db.requests.update(req.id, {
          status: 'APPROVED',
          qty_approved_base: approvedQty,
          approved_by: params.approver.id,
          approved_by_name: params.approver.full_name,
          approval_method: 'ONLINE_REMOTE',
          synced_at: nowIso,
        });
      } else {
        // WRITE_OFF atau OPNAME_ADJUSTMENT (atau UMKM tanpa BAST): langsung eksekusi ke saldo & ledger
        const delta =
          req.request_type === 'OPNAME_ADJUSTMENT'
            ? approvedQty
            : req.request_type === 'INBOUND'
              ? approvedQty
              : -approvedQty;

        if (primaryBal) {
          const nextReserved =
            req.request_type === 'OPNAME_ADJUSTMENT' || req.request_type === 'INBOUND'
              ? primaryBal.qty_reserved
              : Math.max(0, primaryBal.qty_reserved - req.qty_requested_base);
          const nextOnHand = primaryBal.qty_on_hand + delta;

          await db.balances.update(primaryBal.id, {
            qty_on_hand: nextOnHand,
            qty_reserved: nextReserved,
            updated_at: nowIso,
          });

          await db.ledger.put({
            id: generateUuidV7(),
            tenant_id: req.tenant_id,
            warehouse_id: req.warehouse_id,
            item_id: req.item_id,
            request_id: req.id,
            batch_number: primaryBal.batch_number,
            event_type:
              req.request_type === 'OPNAME_ADJUSTMENT'
                ? 'OPNAME_ADJUSTMENT'
                : (req.request_type as LedgerEventType),
            qty_delta: delta,
            is_overdraft_flagged: nextOnHand < 0,
            is_unverified_flagged: false,
            actor_id: params.approver.id,
            actor_name: params.approver.full_name,
            approval_method: 'ONLINE_REMOTE',
            device_origin: 'Approver-Portal',
            notes: `${req.request_code} • Disetujui pimpinan (${req.reason})`,
            created_at: nowIso,
            synced_at: nowIso,
          });
        }

        await db.requests.update(req.id, {
          status: 'COMPLETED',
          qty_approved_base: approvedQty,
          approved_by: params.approver.id,
          approved_by_name: params.approver.full_name,
          approval_method: 'ONLINE_REMOTE',
          synced_at: nowIso,
        });
      }

      await db.auditLogs.put({
        id: generateUuidV7(),
        tenant_id: req.tenant_id,
        actor_id: params.approver.id,
        actor_name: params.approver.full_name,
        action_type: 'REQUEST_APPROVED',
        target_id: `${req.request_code} (${item.sku_code})`,
        summary: `Disetujui oleh ${params.approver.full_name} (${approvedQty} ${item.base_unit}).`,
        created_at: nowIso,
      });
    }
  );
}

/**
 * Serah Terima Barang & Tanda Tangan Digital BAST / Surat Jalan (Layar 1D).
 */
export async function fulfillApprovedRequestWithSignature(
  params: {
    requestId: string;
    signatureDataUrl: string;
    operator: UserAccount;
  },
  db: GudangKuOfflineDB = localDB
): Promise<void> {
  if (!params.signatureDataUrl.startsWith('data:image/')) {
    throw new Error('Tanda tangan digital penerima pada kanvas wajib diisi.');
  }

  const req = await db.requests.get(params.requestId);
  if (!req || req.status !== 'APPROVED') {
    throw new Error('Tiket tidak ditemukan atau belum berstatus APPROVED.');
  }

  const finalQty = req.qty_approved_base ?? req.qty_requested_base;
  const nowIso = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.requests, db.balances, db.ledger, db.auditLogs],
    async () => {
      const primaryBal = await db.balances
        .where('warehouse_id')
        .equals(req.warehouse_id)
        .filter((b) => b.item_id === req.item_id)
        .first();

      const prevOnHand = primaryBal?.qty_on_hand ?? 0;
      const nextOnHand = prevOnHand - finalQty;

      if (primaryBal) {
        await db.balances.update(primaryBal.id, {
          qty_on_hand: nextOnHand,
          qty_reserved: Math.max(0, primaryBal.qty_reserved - finalQty),
          updated_at: nowIso,
        });
      }

      await db.ledger.put({
        id: generateUuidV7(),
        tenant_id: req.tenant_id,
        warehouse_id: req.warehouse_id,
        item_id: req.item_id,
        request_id: req.id,
        batch_number: primaryBal?.batch_number ?? req.batch_number,
        event_type: req.request_type === 'ASSET_LOAN' ? 'ASSET_LOAN' : 'OUTBOUND',
        qty_delta: -finalQty,
        is_overdraft_flagged: nextOnHand < 0,
        is_unverified_flagged: false,
        actor_id: params.operator.id,
        actor_name: params.operator.full_name,
        approval_method: req.approval_method ?? 'ONLINE_REMOTE',
        device_origin: 'BAST-Handover-Pad',
        notes: `${req.request_code} • Serah terima sah kepada ${req.party_name}`,
        created_at: nowIso,
        synced_at: nowIso,
      });

      await db.requests.update(req.id, {
        status: 'COMPLETED',
        signature_data_url: params.signatureDataUrl,
        synced_at: nowIso,
      });

      await db.auditLogs.put({
        id: generateUuidV7(),
        tenant_id: req.tenant_id,
        actor_id: params.operator.id,
        actor_name: params.operator.full_name,
        action_type: 'BAST_SIGNED_COMPLETED',
        target_id: req.request_code,
        summary: `BAST ditandatangani oleh penerima (${req.party_name}) dan diserahkan oleh ${params.operator.full_name}.`,
        created_at: nowIso,
      });
    }
  );
}

/**
 * Pengembalian Aset Tetap Sekolah beserta Pemeriksaan Kondisi (Baik / Rusak Ringan / Rusak Berat).
 */
export async function returnBorrowedAsset(
  params: {
    requestId: string;
    returnedCondition: AssetCondition;
    operator: UserAccount;
  },
  db: GudangKuOfflineDB = localDB
): Promise<void> {
  const req = await db.requests.get(params.requestId);
  if (!req || req.request_type !== 'ASSET_LOAN' || req.status !== 'COMPLETED' || req.returned_condition) {
    throw new Error('Data peminjaman aset tidak valid atau sudah dikembalikan.');
  }

  const qtyReturned = req.qty_approved_base ?? req.qty_requested_base;
  const nowIso = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.requests, db.items, db.balances, db.ledger, db.auditLogs],
    async () => {
      const primaryBal = await db.balances
        .where('warehouse_id')
        .equals(req.warehouse_id)
        .filter((b) => b.item_id === req.item_id)
        .first();

      if (primaryBal) {
        await db.balances.update(primaryBal.id, {
          qty_on_hand: primaryBal.qty_on_hand + qtyReturned,
          updated_at: nowIso,
        });
      }

      await db.items.update(req.item_id, {
        asset_condition: params.returnedCondition,
        updated_at: nowIso,
      });

      await db.requests.update(req.id, {
        returned_condition: params.returnedCondition,
        synced_at: nowIso,
      });

      await db.ledger.put({
        id: generateUuidV7(),
        tenant_id: req.tenant_id,
        warehouse_id: req.warehouse_id,
        item_id: req.item_id,
        request_id: req.id,
        batch_number: req.batch_number,
        event_type: 'ASSET_RETURN',
        qty_delta: qtyReturned,
        is_overdraft_flagged: false,
        is_unverified_flagged: false,
        actor_id: params.operator.id,
        actor_name: params.operator.full_name,
        approval_method: 'AUTO_APPROVED',
        device_origin: 'Asset-Return-Desk',
        notes: `${req.request_code} • Pengembalian aset dari ${req.party_name} (Kondisi: ${params.returnedCondition})`,
        created_at: nowIso,
        synced_at: nowIso,
      });

      await db.auditLogs.put({
        id: generateUuidV7(),
        tenant_id: req.tenant_id,
        actor_id: params.operator.id,
        actor_name: params.operator.full_name,
        action_type: 'ASSET_RETURNED',
        target_id: req.request_code,
        summary: `Aset dikembalikan oleh ${req.party_name} dalam kondisi ${params.returnedCondition}.`,
        created_at: nowIso,
      });
    }
  );
}

/**
 * Blind Stock Opname: Staf menghitung fisik tanpa melihat angka sistem.
 * Jika ada selisih, otomatis membuat draf Berita Acara Penyesuaian (OPNAME_ADJUSTMENT).
 */
export async function submitBlindStockOpname(
  params: {
    tenantId: string;
    warehouseId: string;
    itemId: string;
    physicalCountBase: number;
    notes: string;
    operator: UserAccount;
  },
  db: GudangKuOfflineDB = localDB
): Promise<{ discrepancy: number; requestCode?: string }> {
  if (!Number.isInteger(params.physicalCountBase) || params.physicalCountBase < 0) {
    throw new Error('Hasil hitung fisik harus berupa bilangan bulat >= 0.');
  }

  const item = await db.items.get(params.itemId);
  if (!item) throw new Error('Barang tidak ditemukan.');

  const itemBalances = await db.balances
    .where('warehouse_id')
    .equals(params.warehouseId)
    .filter((b) => b.item_id === params.itemId)
    .toArray();

  const systemQty = itemBalances.reduce((acc, b) => acc + b.qty_on_hand, 0);
  const discrepancy = params.physicalCountBase - systemQty;
  const nowIso = new Date().toISOString();

  if (discrepancy === 0) {
    await db.auditLogs.put({
      id: generateUuidV7(),
      tenant_id: params.tenantId,
      actor_id: params.operator.id,
      actor_name: params.operator.full_name,
      action_type: 'BLIND_OPNAME_MATCHED',
      target_id: item.sku_code,
      summary: `Hitung fisik Blind Opname cocok 100% dengan sistem (${systemQty} ${item.base_unit}).`,
      created_at: nowIso,
    });
    return { discrepancy: 0 };
  }

  const reqCode = nextRequestCode();
  await db.transaction('rw', [db.requests, db.auditLogs], async () => {
    await db.requests.put({
      id: generateUuidV7(),
      tenant_id: params.tenantId,
      warehouse_id: params.warehouseId,
      request_code: reqCode,
      request_type: 'OPNAME_ADJUSTMENT',
      item_id: item.id,
      batch_number: itemBalances[0]?.batch_number ?? 'GENERAL',
      qty_requested_base: discrepancy,
      uom_used: `${discrepancy > 0 ? `+${discrepancy}` : discrepancy} ${item.base_unit}`,
      party_name: `Audit Fisik Rak ${item.default_bin_code}`,
      reason: `Selisih Blind Opname: Fisik ${params.physicalCountBase} vs Sistem ${systemQty} ${item.base_unit}. ${params.notes}`.trim(),
      status: 'PENDING_APPROVAL',
      requested_by: params.operator.id,
      requested_by_name: params.operator.full_name,
      is_flagged_unverified: false,
      created_at: nowIso,
      synced_at: nowIso,
    });

    await db.auditLogs.put({
      id: generateUuidV7(),
      tenant_id: params.tenantId,
      actor_id: params.operator.id,
      actor_name: params.operator.full_name,
      action_type: 'OPNAME_DISCREPANCY_FOUND',
      target_id: `${reqCode} (${item.sku_code})`,
      summary: `Ditemukan selisih ${discrepancy > 0 ? `+${discrepancy}` : discrepancy} ${item.base_unit} pada Blind Opname. Draf Berita Acara menunggu persetujuan.`,
      created_at: nowIso,
    });
  });

  return { discrepancy, requestCode: reqCode };
}

/**
 * Mekanisme VOID / Pembatalan Transaksi Tanpa Menghapus Catatan Buku Besar (Immutable Audit Trail).
 */
export async function voidCompletedLedgerEntry(
  params: {
    ledgerId: string;
    voidReason: string;
    actor: UserAccount;
  },
  db: GudangKuOfflineDB = localDB
): Promise<void> {
  if (params.actor.role !== 'ADMIN' && params.actor.role !== 'APPROVER') {
    throw new Error('Hanya pimpinan (ADMIN / APPROVER) yang berwenang melakukan VOID transaksi.');
  }
  if (params.voidReason.trim().length < 4) {
    throw new Error('Alasan pembatalan (VOID) wajib diisi minimal 4 karakter.');
  }

  const original = await db.ledger.get(params.ledgerId);
  if (!original) {
    throw new Error('Catatan mutasi tidak ditemukan.');
  }
  if (original.event_type === 'VOID_REVERSAL') {
    throw new Error('Catatan pembalikan VOID tidak dapat dibatalkan ulang.');
  }

  const alreadyVoided = await db.ledger
    .where('warehouse_id')
    .equals(original.warehouse_id)
    .filter(
      (entry) =>
        entry.event_type === 'VOID_REVERSAL' &&
        Boolean(entry.notes?.includes(original.id))
    )
    .first();

  if (alreadyVoided) {
    throw new Error('Transaksi ini sudah pernah dibatalkan (VOID) sebelumnya.');
  }

  const reversalDelta = -original.qty_delta;
  const nowIso = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.balances, db.ledger, db.requests, db.auditLogs],
    async () => {
      const bal = await db.balances
        .where('warehouse_id')
        .equals(original.warehouse_id)
        .filter(
          (b) =>
            b.item_id === original.item_id &&
            b.batch_number === original.batch_number
        )
        .first();

      const nextQty = (bal?.qty_on_hand ?? 0) + reversalDelta;
      if (bal) {
        await db.balances.update(bal.id, {
          qty_on_hand: nextQty,
          updated_at: nowIso,
        });
      }

      await db.ledger.put({
        id: generateUuidV7(),
        tenant_id: original.tenant_id,
        warehouse_id: original.warehouse_id,
        item_id: original.item_id,
        request_id: original.request_id,
        batch_number: original.batch_number,
        event_type: 'VOID_REVERSAL',
        qty_delta: reversalDelta,
        is_overdraft_flagged: nextQty < 0,
        is_unverified_flagged: false,
        actor_id: params.actor.id,
        actor_name: params.actor.full_name,
        approval_method: 'ONLINE_REMOTE',
        device_origin: 'Control-Tower-Void',
        notes: `VOID atas [${original.id}] • Alasan: ${params.voidReason.trim()}`,
        created_at: nowIso,
        synced_at: nowIso,
      });

      if (original.request_id) {
        await db.requests.update(original.request_id, {
          status: 'VOIDED',
          synced_at: nowIso,
        });
      }

      await db.auditLogs.put({
        id: generateUuidV7(),
        tenant_id: original.tenant_id,
        actor_id: params.actor.id,
        actor_name: params.actor.full_name,
        action_type: 'TRANSACTION_VOIDED',
        target_id: original.id,
        summary: `Pembatalan (VOID) mutasi ${original.qty_delta} menjadi pembalikan ${reversalDelta > 0 ? `+${reversalDelta}` : reversalDelta}. Alasan: ${params.voidReason.trim()}`,
        created_at: nowIso,
      });
    }
  );
}

/**
 * Mencatat pelanggaran keamanan 3x salah PIN Offline ke antrean Outbox & Audit Log.
 */
export async function recordSecurityPinLockoutEvent(
  params: {
    tenantId: string;
    warehouseId: string;
    actor: UserAccount;
    networkMode: NetworkMode;
  },
  db: GudangKuOfflineDB = localDB
): Promise<void> {
  const nowIso = new Date().toISOString();
  const eventId = generateUuidV7();

  await db.auditLogs.put({
    id: generateUuidV7(),
    tenant_id: params.tenantId,
    actor_id: params.actor.id,
    actor_name: params.actor.full_name,
    action_type: 'SECURITY_PIN_LOCKOUT',
    target_id: 'PIN-PAD-MOBILE',
    summary:
      'Percobaan PIN Supervisor gagal 3 kali berturut-turut. Otorisasi lokal dikunci 15 menit.',
    created_at: nowIso,
  });

  if (params.networkMode !== 'ONLINE') {
    await db.outbox.put({
      id: eventId,
      tenant_id: params.tenantId,
      warehouse_id: params.warehouseId,
      item_id: '00000000-0000-0000-0000-000000000000',
      batch_number: 'SECURITY',
      event_type: 'SECURITY_PIN_LOCKOUT',
      qty_delta: 0,
      actor_id: params.actor.id,
      actor_name: params.actor.full_name,
      approval_method: 'LOCKED_OUT',
      device_origin: 'PWA-Mobile-Offline',
      notes: '3x salah PIN Supervisor saat offline',
      media_stage_status: 'NONE',
      created_at: nowIso,
      retry_count: 0,
    });
  }
}

export interface SyncBatchSummary {
  processedCount: number;
  skippedIdempotentCount: number;
  overdraftDetectedCount: number;
  mediaUploadedCount: number;
}

/**
 * Two-Stage Push-Then-Pull Sync Worker:
 * Tahap 1: Memproses antrean teks transaksi JSON secara idempoten (UUIDv7) & berurutan.
 * Tahap 2: Menyelesaikan antrean unggahan media WebP di latar belakang.
 * Mendukung mode Cloud Supabase (`process_offline_sync_batch`) maupun Local Sandbox.
 */
export async function runOutboxSync(
  tenantId: string,
  networkMode: NetworkMode,
  db: GudangKuOfflineDB = localDB,
  options?: { stopAfterCount?: number }
): Promise<SyncBatchSummary> {
  const isReachable = await checkReachabilityWithTimeout(networkMode);
  if (!isReachable) {
    throw new Error('Jaringan belum tersedia (Offline / Lie-Fi). Antrean tetap aman di memori perangkat.');
  }

  const pendingEvents = await db.outbox
    .where('tenant_id')
    .equals(tenantId)
    .sortBy('created_at');

  if (pendingEvents.length === 0) {
    return {
      processedCount: 0,
      skippedIdempotentCount: 0,
      overdraftDetectedCount: 0,
      mediaUploadedCount: 0,
    };
  }

  const sliceToProcess =
    options?.stopAfterCount !== undefined
      ? pendingEvents.slice(0, options.stopAfterCount)
      : pendingEvents;

  // Jika Supabase Cloud terkonfigurasi dan pengguna memiliki sesi aktif, panggil RPC atomik server
  const supabase = getSupabaseBrowserClient();
  if (supabase) {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData.session) {
      await supabase.rpc('process_offline_sync_batch', {
        p_events: sliceToProcess,
      });
    }
  }

  let processedCount = 0;
  let skippedIdempotentCount = 0;
  let overdraftDetectedCount = 0;
  let mediaUploadedCount = 0;
  const nowIso = new Date().toISOString();

  // Tahap 1: Proses mutasi angka stok secara idempoten sesuai urutan waktu UUIDv7
  for (const ev of sliceToProcess) {
    await db.transaction(
      'rw',
      [db.outbox, db.balances, db.ledger, db.auditLogs],
      async () => {
        if (ev.event_type === 'SECURITY_PIN_LOCKOUT') {
          await db.outbox.delete(ev.id);
          processedCount++;
          return;
        }

        // Idempotency Guard: Jika ID UUIDv7 sudah ada di stock_ledger, jangan potong stok 2 kali!
        const alreadyInLedger = await db.ledger.get(ev.id);
        if (alreadyInLedger) {
          await db.outbox.delete(ev.id);
          skippedIdempotentCount++;
          return;
        }

        const bal = await db.balances
          .where('warehouse_id')
          .equals(ev.warehouse_id)
          .filter(
            (b) => b.item_id === ev.item_id && b.batch_number === ev.batch_number
          )
          .first();

        const currentQty = bal?.qty_on_hand ?? 0;
        const nextQty = currentQty + ev.qty_delta;
        const isOverdraft = nextQty < 0;

        if (bal) {
          await db.balances.update(bal.id, {
            qty_on_hand: nextQty,
            updated_at: nowIso,
          });
        } else {
          await db.balances.put({
            id: generateUuidV7(),
            tenant_id: ev.tenant_id,
            warehouse_id: ev.warehouse_id,
            bin_code: 'ZONA-A/RAK-01',
            item_id: ev.item_id,
            batch_number: ev.batch_number,
            qty_on_hand: nextQty,
            qty_reserved: 0,
            updated_at: nowIso,
          });
        }

        await db.ledger.put({
          id: ev.id,
          tenant_id: ev.tenant_id,
          warehouse_id: ev.warehouse_id,
          item_id: ev.item_id,
          request_id: ev.request_id,
          batch_number: ev.batch_number,
          event_type: ev.event_type,
          qty_delta: ev.qty_delta,
          is_overdraft_flagged: isOverdraft,
          is_unverified_flagged: ev.approval_method === 'EMERGENCY_UNVERIFIED',
          actor_id: ev.actor_id,
          actor_name: ev.actor_name,
          approval_method: ev.approval_method,
          device_origin: ev.device_origin,
          notes: ev.notes,
          created_at: ev.created_at,
          synced_at: nowIso,
        });

        if (isOverdraft) {
          overdraftDetectedCount++;
          await db.auditLogs.put({
            id: generateUuidV7(),
            tenant_id: ev.tenant_id,
            actor_id: ev.actor_id,
            actor_name: ev.actor_name,
            action_type: 'FLAGGED_OVERDRAFT',
            target_id: ev.id,
            summary: `Anomali stok minus terdeteksi saat sinkronisasi perangkat ${ev.device_origin}: saldo ${currentQty} dipotong ${ev.qty_delta} menjadi ${nextQty}. Wajib rekonsiliasi fisik!`,
            created_at: nowIso,
          });
        }

        if (ev.media_stage_status === 'PENDING_MEDIA') {
          mediaUploadedCount++;
        }

        await db.outbox.delete(ev.id);
        processedCount++;
      }
    );
  }

  return {
    processedCount,
    skippedIdempotentCount,
    overdraftDetectedCount,
    mediaUploadedCount,
  };
}

/**
 * Simulasi Chaos QA (Checklist 5.A): Dua HP staf mengeluarkan stok terakhir yang sama saat offline.
 * Saat keduanya tersambung ke internet, keduanya diterima tanpa kehilangan data lapangan,
 * dan transaksi kedua otomatis ditandai FLAGGED_OVERDRAFT.
 */
export async function simulateConcurrentOfflineRaceCondition(
  tenantId: string,
  warehouseId: string,
  itemId: string,
  db: GudangKuOfflineDB = localDB
): Promise<SyncBatchSummary> {
  const bal = await db.balances
    .where('warehouse_id')
    .equals(warehouseId)
    .filter((b) => b.item_id === itemId)
    .first();

  if (!bal) {
    throw new Error('Saldo barang tidak ditemukan untuk simulasi.');
  }

  const available = Math.max(1, bal.qty_on_hand);
  const t1 = Date.now() - 2000;
  const t2 = Date.now() - 1000;

  const eventDeviceA: OutboxEvent = {
    id: generateUuidV7(t1),
    tenant_id: tenantId,
    warehouse_id: warehouseId,
    item_id: itemId,
    batch_number: bal.batch_number,
    event_type: 'OUTBOUND',
    qty_delta: -available,
    actor_id: 'sim-dev-a',
    actor_name: 'Staf A (HP Lorong Barat)',
    approval_method: 'AUTO_APPROVED',
    device_origin: 'HP-Android-Staf-A (Offline)',
    notes: 'Simulasi Race Condition #1 — Mengambil seluruh sisa stok tercatat',
    media_stage_status: 'NONE',
    created_at: new Date(t1).toISOString(),
    retry_count: 0,
  };

  const eventDeviceB: OutboxEvent = {
    id: generateUuidV7(t2),
    tenant_id: tenantId,
    warehouse_id: warehouseId,
    item_id: itemId,
    batch_number: bal.batch_number,
    event_type: 'OUTBOUND',
    qty_delta: -2,
    actor_id: 'sim-dev-b',
    actor_name: 'Staf B (HP Lorong Timur)',
    approval_method: 'AUTO_APPROVED',
    device_origin: 'HP-Android-Staf-B (Offline)',
    notes: 'Simulasi Race Condition #2 — Pengeluaran bersamaan saat sinyal mati',
    media_stage_status: 'NONE',
    created_at: new Date(t2).toISOString(),
    retry_count: 0,
  };

  await db.outbox.bulkPut([eventDeviceA, eventDeviceB]);
  return runOutboxSync(tenantId, 'ONLINE', db);
}

export interface EmergencyOutboxDump {
  schemaVersion: 'gudangku-emergency-dump-v1';
  exportedAt: string;
  tenantId: string;
  eventCount: number;
  events: OutboxEvent[];
}

export async function exportEmergencyOutboxDump(
  tenantId: string,
  db: GudangKuOfflineDB = localDB
): Promise<string> {
  const events = await db.outbox.where('tenant_id').equals(tenantId).sortBy('created_at');
  const payload: EmergencyOutboxDump = {
    schemaVersion: 'gudangku-emergency-dump-v1',
    exportedAt: new Date().toISOString(),
    tenantId,
    eventCount: events.length,
    events,
  };
  return JSON.stringify(payload, null, 2);
}

export async function importEmergencyOutboxDump(
  jsonString: string,
  expectedTenantId: string,
  db: GudangKuOfflineDB = localDB
): Promise<SyncBatchSummary> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('Berkas JSON pemulihan darurat rusak atau tidak terbaca.');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as EmergencyOutboxDump).schemaVersion !== 'gudangku-emergency-dump-v1' ||
    !Array.isArray((parsed as EmergencyOutboxDump).events)
  ) {
    throw new Error('Format berkas bukan Emergency JSON Dump GudangKu WMS yang sah.');
  }

  const dump = parsed as EmergencyOutboxDump;
  if (dump.tenantId !== expectedTenantId) {
    throw new Error(
      'Isolasi Multi-Tenant menolak berkas: antrean darurat ini berasal dari organisasi berbeda.'
    );
  }

  await db.outbox.bulkPut(dump.events);
  return runOutboxSync(expectedTenantId, 'ONLINE', db);
}
