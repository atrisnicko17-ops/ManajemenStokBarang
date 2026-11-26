'use client';

import React, { useId, useState } from 'react';
import { ClipboardCheck, EyeOff, Lock, Unlock } from 'lucide-react';
import type {
  BinLocation,
  ItemRecord,
  OperatorItemView,
  UserAccount,
  Warehouse,
} from '@/domain/types';
import { localDB } from '@/offline/db';
import { submitBlindStockOpname } from '@/offline/sync-worker';
import { ModalDialog } from './ModalDialog';

interface BlindOpnameModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenantId: string;
  warehouse: Warehouse;
  items: ReadonlyArray<ItemRecord | OperatorItemView>;
  bins: ReadonlyArray<BinLocation>;
  actor: UserAccount;
  onResultToast: (msg: string) => void;
}

export function BlindOpnameModal({
  isOpen,
  onClose,
  tenantId,
  warehouse,
  items,
  bins,
  actor,
  onResultToast,
}: BlindOpnameModalProps) {
  const [selectedItemId, setSelectedItemId] = useState<string>('');
  const [physicalQty, setPhysicalQty] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const baseId = useId();

  const activeItem = items.find((i) => i.id === selectedItemId) ?? items[0];
  const binRecord = activeItem
    ? bins.find(
        (b) =>
          b.warehouse_id === warehouse.id &&
          b.bin_code === activeItem.default_bin_code
      )
    : undefined;

  const canFreezeRack = actor.role === 'ADMIN' || actor.role === 'APPROVER';

  const toggleRackFreeze = async () => {
    if (!binRecord) return;
    await localDB.bins.update(binRecord.id, {
      is_frozen: !binRecord.is_frozen,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeItem) return;
    const parsed = parseInt(physicalQty, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      setErrorMsg('Masukkan jumlah fisik aktual berupa angka bulat >= 0.');
      return;
    }

    try {
      const res = await submitBlindStockOpname({
        tenantId,
        warehouseId: warehouse.id,
        itemId: activeItem.id,
        physicalCountBase: parsed,
        notes,
        operator: actor,
      });

      if (res.discrepancy === 0) {
        onResultToast(
          `Audit fisik ${activeItem.sku_code} cocok 100% dengan catatan sistem. Tercatat di Audit Trail.`
        );
      } else {
        onResultToast(
          `Selisih terdeteksi (${res.discrepancy > 0 ? `+${res.discrepancy}` : res.discrepancy} ${activeItem.base_unit}). Draf Berita Acara ${res.requestCode} dikirim ke pimpinan.`
        );
      }
      setPhysicalQty('');
      setNotes('');
      setErrorMsg('');
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan hasil opname.');
    }
  };

  if (!activeItem) return null;

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Stock Opname — Blind Count Mode"
      subtitle="Angka stok sistem disembunyikan untuk menjamin objektivitas perhitungan fisik"
      maxWidthClass="max-w-lg"
    >
      <form method="POST" action="#blind-opname" onSubmit={handleSubmit} className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
          <EyeOff size={18} strokeWidth={1.5} className="shrink-0 text-slate-600 mt-0.5" />
          <p className="leading-relaxed">
            <strong>Mode hitung buta aktif:</strong> hitung fisik barang secara mandiri di rak{' '}
            <span className="font-mono-tech font-semibold text-slate-900">
              {activeItem.default_bin_code}
            </span>{' '}
            dalam satuan dasar <strong>{activeItem.base_unit}</strong>.
          </p>
        </div>

        <div>
          <label
            htmlFor={`${baseId}-item`}
            className="block text-xs font-medium text-slate-700 mb-1"
          >
            Barang yang dihitung <span aria-hidden="true">*</span>
          </label>
          <select
            id={`${baseId}-item`}
            name="item_id"
            value={activeItem.id}
            onChange={(e) => {
              setSelectedItemId(e.target.value);
              setErrorMsg('');
            }}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
          >
            {items.map((it) => (
              <option key={it.id} value={it.id}>
                {it.sku_code} — {it.name} ({it.default_bin_code})
              </option>
            ))}
          </select>
        </div>

        {binRecord && canFreezeRack && (
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs">
            <div>
              <span className="font-medium text-slate-800 block">
                Status rak {binRecord.bin_code}
              </span>
              <span className="text-slate-500">
                {binRecord.is_frozen
                  ? 'Transaksi keluar/masuk pada rak ini sedang dibekukan'
                  : 'Rak terbuka untuk mutasi reguler'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void toggleRackFreeze()}
              className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border px-3 font-medium transition-colors ${
                binRecord.is_frozen
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              {binRecord.is_frozen ? (
                <>
                  <Unlock size={15} strokeWidth={1.5} />
                  <span>Buka bekukan rak</span>
                </>
              ) : (
                <>
                  <Lock size={15} strokeWidth={1.5} />
                  <span>Freeze rak ini</span>
                </>
              )}
            </button>
          </div>
        )}

        <div>
          <label
            htmlFor={`${baseId}-count`}
            className="block text-xs font-medium text-slate-700 mb-1"
          >
            Hasil hitung fisik aktual ({activeItem.base_unit}){' '}
            <span aria-hidden="true">*</span>
          </label>
          <input
            id={`${baseId}-count`}
            name="physical_count"
            type="text"
            inputMode="numeric"
            required
            value={physicalQty}
            onChange={(e) => {
              setPhysicalQty(e.target.value.replace(/\D/g, ''));
              if (errorMsg) setErrorMsg('');
            }}
            placeholder={`Masukkan jumlah ${activeItem.base_unit} di rak`}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 font-mono-tech text-base font-semibold text-slate-900"
          />
        </div>

        <div>
          <label
            htmlFor={`${baseId}-notes`}
            className="block text-xs font-medium text-slate-700 mb-1"
          >
            Catatan temuan lapangan
          </label>
          <input
            id={`${baseId}-notes`}
            name="notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Contoh: 1 kotak ditemukan di rak atas"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
          />
        </div>

        {errorMsg && (
          <p role="alert" className="text-xs font-medium text-red-700">
            {errorMsg}
          </p>
        )}

        <button
          type="submit"
          className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
        >
          <ClipboardCheck size={18} strokeWidth={1.5} />
          <span>Kirim hasil hitung fisik</span>
        </button>
      </form>
    </ModalDialog>
  );
}
