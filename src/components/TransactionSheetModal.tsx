'use client';

import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  KeyRound,
  Minus,
  Plus,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { getProfileTerminology } from '@/domain/profile-terminology';
import { evaluateTransactionGovernance } from '@/domain/threshold-rules';
import type {
  BatchBalance,
  BinLocation,
  ItemRecord,
  NetworkMode,
  OperatorItemView,
  RequestType,
  TenantConfig,
  UserAccount,
  Warehouse,
} from '@/domain/types';
import { convertToBaseUnit } from '@/domain/uom-converter';
import { compressEvidencePhotoToWebp } from '@/offline/image-compressor';
import {
  submitInventoryTransaction,
  type SubmitTransactionResult,
} from '@/offline/sync-worker';
import { ModalDialog } from './ModalDialog';
import { OfflinePinModal } from './OfflinePinModal';

interface TransactionSheetModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialMode: RequestType;
  initialItemId?: string;
  tenant: TenantConfig;
  warehouse: Warehouse;
  allWarehouses: ReadonlyArray<Warehouse>;
  bins: ReadonlyArray<BinLocation>;
  items: ReadonlyArray<ItemRecord | OperatorItemView>;
  balances: ReadonlyArray<BatchBalance>;
  actor: UserAccount;
  approver: UserAccount | undefined;
  networkMode: NetworkMode;
  onSuccessToast: (res: SubmitTransactionResult) => void;
}

export function TransactionSheetModal({
  isOpen,
  onClose,
  initialMode,
  initialItemId,
  tenant,
  warehouse,
  allWarehouses,
  bins,
  items,
  balances,
  actor,
  approver,
  networkMode,
  onSuccessToast,
}: TransactionSheetModalProps) {
  const terms = getProfileTerminology(tenant.business_profile);

  const [requestType, setRequestType] = useState<RequestType>(initialMode);
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [qtyInput, setQtyInput] = useState<number>(1);
  const [selectedUnit, setSelectedUnit] = useState<string>('');
  const [partyName, setPartyName] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [batchNumber, setBatchNumber] = useState<string>('');
  const [expiryDate, setExpiryDate] = useState<string>('');
  const [dueReturnDate, setDueReturnDate] = useState<string>('');
  const [targetWarehouseId, setTargetWarehouseId] = useState<string>('');
  const [evidenceDataUrl, setEvidenceDataUrl] = useState<string | undefined>();
  const [evidenceFileName, setEvidenceFileName] = useState<string | undefined>();
  const [evidenceSizeKb, setEvidenceSizeKb] = useState<number | undefined>();
  const [formError, setFormError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPinModalOpen, setIsPinModalOpen] = useState(false);

  const baseId = useId();

  useEffect(() => {
    if (!isOpen) return;
    setRequestType(initialMode);
    const defaultItem =
      items.find((i) => i.id === initialItemId) ?? items[0];
    setSelectedItemId(defaultItem?.id ?? '');
    setSelectedUnit(defaultItem?.base_unit ?? '');
    setQtyInput(1);
    setPartyName('');
    setReason('');
    setBatchNumber('');
    setExpiryDate('');
    setDueReturnDate('');
    const otherWh = allWarehouses.find((w) => w.id !== warehouse.id);
    setTargetWarehouseId(otherWh?.id ?? '');
    setEvidenceDataUrl(undefined);
    setEvidenceFileName(undefined);
    setEvidenceSizeKb(undefined);
    setFormError('');
  }, [isOpen, initialMode, initialItemId, items, allWarehouses, warehouse.id]);

  const activeItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? items[0],
    [items, selectedItemId]
  );

  useEffect(() => {
    if (activeItem) {
      setSelectedUnit(activeItem.base_unit);
      if (activeItem.is_fixed_asset && requestType === 'OUTBOUND' && terms.enableFixedAssetLoan) {
        setRequestType('ASSET_LOAN');
      }
    }
  }, [activeItem, requestType, terms.enableFixedAssetLoan]);

  const itemStockSummary = useMemo(() => {
    if (!activeItem) return { onHand: 0, reserved: 0, available: 0 };
    const matching = balances.filter(
      (b) => b.warehouse_id === warehouse.id && b.item_id === activeItem.id
    );
    const onHand = matching.reduce((s, b) => s + b.qty_on_hand, 0);
    const reserved = matching.reduce((s, b) => s + b.qty_reserved, 0);
    return { onHand, reserved, available: onHand - reserved };
  }, [activeItem, balances, warehouse.id]);

  const conversionPreview = useMemo(() => {
    if (!activeItem) return null;
    try {
      return convertToBaseUnit(
        Math.max(1, qtyInput),
        selectedUnit || activeItem.base_unit,
        activeItem.base_unit,
        activeItem.uoms
      );
    } catch {
      return null;
    }
  }, [activeItem, qtyInput, selectedUnit]);

  const isBinFrozen = useMemo(() => {
    if (!activeItem) return false;
    return Boolean(
      bins.find(
        (b) =>
          b.warehouse_id === warehouse.id &&
          b.bin_code === activeItem.default_bin_code
      )?.is_frozen
    );
  }, [activeItem, bins, warehouse.id]);

  const governancePreview = useMemo(() => {
    if (!activeItem || !conversionPreview) return null;
    return evaluateTransactionGovernance({
      requestType,
      qtyBase: conversionPreview.qtyBase,
      approvalThresholdQty: tenant.approval_threshold_qty,
      isFixedAsset: activeItem.is_fixed_asset,
      hasEvidencePhoto: Boolean(evidenceDataUrl),
      isBinFrozen,
      partyName:
        requestType === 'INBOUND' || requestType === 'WRITE_OFF'
          ? partyName || 'Gudang'
          : partyName || 'Pemohon',
    });
  }, [
    activeItem,
    conversionPreview,
    requestType,
    tenant.approval_threshold_qty,
    evidenceDataUrl,
    isBinFrozen,
    partyName,
  ]);

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormError('');
    try {
      const compressed = await compressEvidencePhotoToWebp(file);
      setEvidenceDataUrl(compressed.dataUrl);
      setEvidenceFileName(compressed.fileName);
      setEvidenceSizeKb(compressed.sizeKb);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Gagal memproses foto bukti.'
      );
    }
  };

  const injectSampleEvidenceForDemo = () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#0F172A"/><text x="28" y="130" fill="#F8FAFC" font-family="monospace" font-size="16">FOTO KAMERA TERKOMPRESI WEBP</text><text x="28" y="164" fill="#22C55E" font-family="monospace" font-size="13">SKU: ${activeItem?.sku_code ?? ''} • 42 KB (< 120 KB)</text></svg>`;
    setEvidenceDataUrl(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
    setEvidenceFileName(`BUKTI_${activeItem?.sku_code ?? 'ITEM'}.webp`);
    setEvidenceSizeKb(42);
    setFormError('');
  };

  const executeSubmit = async (
    override?: {
      method: 'OFFLINE_PIN_OVERRIDE' | 'EMERGENCY_UNVERIFIED';
      approverId?: string;
      approverName?: string;
    }
  ) => {
    if (!activeItem) return;
    setFormError('');
    setIsSubmitting(true);
    try {
      const res = await submitInventoryTransaction({
        tenantId: tenant.id,
        warehouseId: warehouse.id,
        targetWarehouseId:
          requestType === 'TRANSFER' ? targetWarehouseId : undefined,
        itemId: activeItem.id,
        requestType,
        qtyInput,
        selectedUnit: selectedUnit || activeItem.base_unit,
        partyName,
        reason,
        batchNumber,
        expiryDate: expiryDate || undefined,
        dueReturnDate: dueReturnDate || undefined,
        evidencePhotoDataUrl: evidenceDataUrl,
        evidencePhotoName: evidenceFileName,
        evidenceSizeKb,
        actor,
        networkMode,
        offlineAuthOverride: override,
      });
      onSuccessToast(res);
      onClose();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Gagal menyimpan transaksi.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!activeItem) return null;

  const isOfflineLike = networkMode !== 'ONLINE';
  const needsApproval = Boolean(governancePreview?.requiresApproval);

  const modalTitle =
    requestType === 'INBOUND'
      ? 'Barang masuk (Inbound)'
      : requestType === 'WRITE_OFF'
        ? 'Lapor barang rusak / kadaluarsa (Write-off)'
        : requestType === 'ASSET_LOAN'
          ? 'Peminjaman aset tetap sekolah'
          : requestType === 'TRANSFER'
            ? 'Transfer stok antar-gudang'
            : terms.outboundActionTitle;

  return (
    <>
      <ModalDialog
        isOpen={isOpen}
        onClose={onClose}
        title={modalTitle}
        subtitle={`${warehouse.name} • Satuan dasar penyimpanan: ${activeItem.base_unit}`}
        maxWidthClass="max-w-lg"
      >
        <form
          method="POST"
          action="#submit-transaction"
          onSubmit={(e) => {
            e.preventDefault();
            void executeSubmit();
          }}
          className="space-y-4"
        >
          {/* Pemilih Jenis Mutasi Cepat */}
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-slate-700">
              Jenis pergerakan stok
            </legend>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(
                [
                  { id: 'INBOUND', label: 'Masuk' },
                  { id: 'OUTBOUND', label: terms.outboundActionTitle },
                  { id: 'WRITE_OFF', label: 'Lapor rusak' },
                  ...(terms.enableFixedAssetLoan
                    ? [{ id: 'ASSET_LOAN' as RequestType, label: 'Pinjam aset' }]
                    : []),
                  ...(terms.enableMultiWarehouseTransfer &&
                  allWarehouses.length > 1
                    ? [{ id: 'TRANSFER' as RequestType, label: 'Transfer cabang' }]
                    : []),
                ] as Array<{ id: RequestType; label: string }>
              ).map((opt) => (
                <label
                  key={opt.id}
                  className={`flex min-h-[44px] cursor-pointer items-center justify-center rounded-lg border px-2.5 py-1.5 text-center text-xs font-medium transition-colors ${
                    requestType === opt.id
                      ? 'border-blue-600 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="request_type"
                    value={opt.id}
                    checked={requestType === opt.id}
                    onChange={() => {
                      setRequestType(opt.id);
                      setFormError('');
                    }}
                    className="visually-hidden"
                  />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Pilih Barang / SKU */}
          <div>
            <label
              htmlFor={`${baseId}-item`}
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Pilih barang / SKU <span aria-hidden="true">*</span>
            </label>
            <select
              id={`${baseId}-item`}
              name="item_id"
              value={activeItem.id}
              onChange={(e) => {
                setSelectedItemId(e.target.value);
                setFormError('');
              }}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
            >
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.sku_code} — {it.name}
                </option>
              ))}
            </select>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
              <span className="text-slate-600">
                Rak:{' '}
                <strong className="font-mono-tech text-slate-900">
                  {activeItem.default_bin_code}
                </strong>
                {isBinFrozen && (
                  <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-red-700 font-medium">
                    Dibekukan (Opname)
                  </span>
                )}
              </span>
              <span className="text-slate-600">
                Tersedia:{' '}
                <strong className="font-mono-tech text-slate-900">
                  {itemStockSummary.available} {activeItem.base_unit}
                </strong>
                {itemStockSummary.reserved > 0 && (
                  <span className="ml-1 text-amber-700 font-mono-tech">
                    ({itemStockSummary.reserved} dikunci)
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Jumlah & Konversi Satuan Bertingkat (Multi-UOM) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                htmlFor={`${baseId}-qty`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Jumlah <span aria-hidden="true">*</span>
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQtyInput((q) => Math.max(1, q - 1))}
                  aria-label="Kurangi jumlah"
                  className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
                >
                  <Minus size={18} strokeWidth={1.5} />
                </button>
                <input
                  id={`${baseId}-qty`}
                  name="qty"
                  type="text"
                  inputMode="numeric"
                  value={String(qtyInput)}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value.replace(/\D/g, ''), 10);
                    setQtyInput(Number.isNaN(parsed) ? 1 : Math.max(1, parsed));
                    setFormError('');
                  }}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 text-center font-mono-tech text-base font-semibold text-slate-900"
                />
                <button
                  type="button"
                  onClick={() => setQtyInput((q) => q + 1)}
                  aria-label="Tambah jumlah"
                  className="inline-flex min-h-[48px] min-w-[48px] items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
                >
                  <Plus size={18} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            <div>
              <label
                htmlFor={`${baseId}-uom`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Satuan transaksi (Multi-UOM)
              </label>
              <select
                id={`${baseId}-uom`}
                name="uom"
                value={selectedUnit}
                onChange={(e) => setSelectedUnit(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value={activeItem.base_unit}>
                  {activeItem.base_unit} (Satuan dasar ×1)
                </option>
                {activeItem.uoms.map((u) => (
                  <option key={u.unit_name} value={u.unit_name}>
                    {u.unit_name} (×{u.multiplier_to_base} {activeItem.base_unit})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Kalkulasi Real-Time ke Satuan Dasar */}
          {conversionPreview && (
            <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50/70 px-3.5 py-2.5 text-xs">
              <span className="font-medium text-slate-700">
                Total konversi satuan dasar
              </span>
              <span className="font-mono-tech text-sm font-semibold text-blue-800">
                {conversionPreview.qtyBase} {activeItem.base_unit}
              </span>
            </div>
          )}

          {/* Gudang Tujuan jika TRANSFER */}
          {requestType === 'TRANSFER' && (
            <div>
              <label
                htmlFor={`${baseId}-target-wh`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Gudang cabang tujuan <span aria-hidden="true">*</span>
              </label>
              <select
                id={`${baseId}-target-wh`}
                name="target_warehouse_id"
                value={targetWarehouseId}
                onChange={(e) => setTargetWarehouseId(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                {allWarehouses
                  .filter((w) => w.id !== warehouse.id)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} — {w.address}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {/* Batch & Kedaluwarsa untuk Inbound */}
          {requestType === 'INBOUND' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor={`${baseId}-batch`}
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Nomor batch / lot PO
                </label>
                <input
                  id={`${baseId}-batch`}
                  name="batch_number"
                  type="text"
                  value={batchNumber}
                  onChange={(e) => setBatchNumber(e.target.value)}
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="Contoh: BATCH-NOV26"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 font-mono-tech text-sm"
                />
              </div>
              <div>
                <label
                  htmlFor={`${baseId}-exp`}
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Tanggal kedaluwarsa (FEFO)
                </label>
                <input
                  id={`${baseId}-exp`}
                  name="expiry_date"
                  type="date"
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 font-mono-tech text-sm"
                />
              </div>
            </div>
          )}

          {/* Pemohon / Supplier / Unit */}
          <div>
            <label
              htmlFor={`${baseId}-party`}
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              {requestType === 'INBOUND'
                ? 'Nama supplier / nomor PO'
                : requestType === 'WRITE_OFF'
                  ? 'Lokasi temuan kerusakan'
                  : terms.partyFieldLabel}{' '}
              {(requestType === 'OUTBOUND' || requestType === 'ASSET_LOAN') && (
                <span aria-hidden="true">*</span>
              )}
            </label>
            <input
              id={`${baseId}-party`}
              name="party_name"
              type="text"
              value={partyName}
              onChange={(e) => {
                setPartyName(e.target.value);
                if (formError) setFormError('');
              }}
              placeholder={
                requestType === 'INBOUND'
                  ? 'Contoh: PT Sinar Maju — PO #409'
                  : requestType === 'WRITE_OFF'
                    ? 'Contoh: Rak ZONA-A/RAK-03'
                    : terms.partyPlaceholder
              }
              className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
            />
          </div>

          {requestType === 'ASSET_LOAN' && (
            <div>
              <label
                htmlFor={`${baseId}-due`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Rencana tanggal pengembalian aset
              </label>
              <input
                id={`${baseId}-due`}
                name="due_return_date"
                type="date"
                value={dueReturnDate}
                onChange={(e) => setDueReturnDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 font-mono-tech text-sm"
              />
            </div>
          )}

          {/* Catatan / Alasan */}
          <div>
            <label
              htmlFor={`${baseId}-reason`}
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Catatan / alasan mutasi
            </label>
            <input
              id={`${baseId}-reason`}
              name="reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                requestType === 'WRITE_OFF'
                  ? 'Contoh: Kemasan bocor saat bongkar muat'
                  : 'Keperluan operasional'
              }
              className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
            />
          </div>

          {/* Bukti Foto Wajib untuk WRITE_OFF */}
          {requestType === 'WRITE_OFF' && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">
                  Foto bukti kerusakan (wajib kompresi WebP &lt; 120 KB) *
                </span>
                {evidenceSizeKb && (
                  <span className="font-mono-tech text-xs font-medium text-emerald-700">
                    {evidenceSizeKb} KB • Siap
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg bg-slate-900 px-3.5 text-xs font-medium text-white hover:bg-slate-800">
                  <Camera size={16} strokeWidth={1.5} />
                  <span>Ambil / pilih foto kamera</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    onChange={handlePhotoUpload}
                    className="visually-hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={injectSampleEvidenceForDemo}
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  <span>Gunakan sampel foto uji QA</span>
                </button>
              </div>

              {evidenceDataUrl && (
                <div className="overflow-hidden rounded-lg border border-slate-200 bg-white p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={evidenceDataUrl}
                    alt="Pratinjau bukti barang rusak"
                    width={320}
                    height={200}
                    decoding="async"
                    className="h-32 w-full object-contain rounded"
                  />
                </div>
              )}
            </div>
          )}

          {/* Banner Peringatan Threshold Persetujuan */}
          {needsApproval && governancePreview?.approvalReason && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-950 flex items-start gap-2.5">
              <AlertTriangle
                size={18}
                strokeWidth={1.5}
                className="shrink-0 text-amber-700 mt-0.5"
              />
              <div className="text-xs leading-relaxed">
                <p className="font-semibold">
                  Membutuhkan persetujuan {terms.approverTitle}
                </p>
                <p className="text-amber-900 mt-0.5">
                  {governancePreview.approvalReason}
                </p>
              </div>
            </div>
          )}

          {formError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-medium text-red-800 flex items-center gap-2"
            >
              <ShieldAlert size={16} strokeWidth={1.5} className="shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          {/* Tombol Aksi Kontekstual (Online vs Offline + Rutin vs Butuh Approval) */}
          <div className="space-y-2 pt-1">
            {needsApproval && isOfflineLike ? (
              <>
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    if (requestType === 'WRITE_OFF' && !evidenceDataUrl) {
                      setFormError('Wajib lampirkan foto bukti kerusakan/kadaluarsa!');
                      return;
                    }
                    setIsPinModalOpen(true);
                  }}
                  className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
                >
                  <KeyRound size={18} strokeWidth={1.5} />
                  <span>Otorisasi langsung di tempat (PIN {terms.approverTitle})</span>
                </button>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  <span>Simpan pengajuan ke antrean sync (tunggu sinyal)</span>
                </button>

                {requestType !== 'WRITE_OFF' && (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() =>
                      void executeSubmit({
                        method: 'EMERGENCY_UNVERIFIED',
                      })
                    }
                    className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-medium text-red-800 transition-colors hover:bg-red-100"
                  >
                    <AlertTriangle size={15} strokeWidth={1.5} />
                    <span>
                      Pengeluaran darurat tanpa atasan (tandai FLAGGED_UNVERIFIED)
                    </span>
                  </button>
                )}
              </>
            ) : needsApproval ? (
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
              >
                <Send size={18} strokeWidth={1.5} />
                <span>Kirim pengajuan ke {terms.approverTitle}</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSubmitting}
                className={`inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                  requestType === 'INBOUND'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                <CheckCircle2 size={18} strokeWidth={1.5} />
                <span>
                  {isOfflineLike
                    ? 'Simpan ke antrean memori HP (Offline)'
                    : 'Simpan & perbarui saldo stok'}
                </span>
              </button>
            )}
          </div>
        </form>
      </ModalDialog>

      <OfflinePinModal
        isOpen={isPinModalOpen}
        onClose={() => setIsPinModalOpen(false)}
        tenantId={tenant.id}
        warehouseId={warehouse.id}
        approver={approver}
        operator={actor}
        networkMode={networkMode}
        approverTitle={terms.approverTitle}
        onAuthorized={(authorizedUser) => {
          void executeSubmit({
            method: 'OFFLINE_PIN_OVERRIDE',
            approverId: authorizedUser.id,
            approverName: authorizedUser.full_name,
          });
        }}
      />
    </>
  );
}
