'use client';

import React, { useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Upload } from 'lucide-react';
import {
  type BulkImportDraftRow,
  parseCsvToBulkDraft,
  validateBulkImportRows,
} from '@/domain/csv-xlsx-validator';
import { getTierQuotaLimits } from '@/domain/subscription-grace';
import type {
  ItemRecord,
  TenantConfig,
  UserAccount,
  Warehouse,
} from '@/domain/types';
import { generateUuidV7 } from '@/domain/uuidv7';
import { localDB } from '@/offline/db';
import { ModalDialog } from './ModalDialog';

interface BulkImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenant: TenantConfig;
  warehouse: Warehouse;
  existingItems: ReadonlyArray<ItemRecord>;
  actor: UserAccount;
  onImported: (msg: string) => void;
}

const DEMO_CSV_SAMPLE = `sku_code,barcode,name,category,bin_code,base_unit,uom_name,uom_multiplier,min_stock,qty_initial,cost_price,is_fixed_asset,expiry_date
ATK-PUL-01,899123459901,Pulpen Gel Hitam 0.5mm,ATK Kelas,ZONA-A/RAK-01,Pcs,Lusin,12,24,120,3500,false,
LAB-MIK-02,QR-LAB-MIK02,Mikroskop Binokuler XSZ-107,Aset Lab IPA,ZONA-B/LEMARI-02,Unit,Unit,1,1,6,2850000,true,`;

export function BulkImportModal({
  isOpen,
  onClose,
  tenant,
  warehouse,
  existingItems,
  actor,
  onImported,
}: BulkImportModalProps) {
  const [draftRows, setDraftRows] = useState<BulkImportDraftRow[]>([]);
  const [statusError, setStatusError] = useState('');

  const existingSkuSet = useMemo(
    () => new Set(existingItems.map((i) => i.sku_code.toUpperCase())),
    [existingItems]
  );

  const loadCsvString = (text: string) => {
    setStatusError('');
    const parsed = parseCsvToBulkDraft(text, existingSkuSet);
    if (parsed.length === 0) {
      setStatusError('Berkas CSV kosong atau tidak memiliki baris data.');
      return;
    }
    setDraftRows(parsed);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    loadCsvString(text);
  };

  const updateCell = (
    idx: number,
    field: keyof Omit<BulkImportDraftRow, 'rowNumber' | 'errors'>,
    value: string
  ) => {
    const updated = draftRows.map((r, i) =>
      i === idx ? { ...r, [field]: value } : r
    );
    const revalidated = validateBulkImportRows(
      updated.map(({ errors: _e, ...rest }) => {
        void _e;
        return rest;
      }),
      existingSkuSet
    );
    setDraftRows(revalidated);
  };

  const errorCount = draftRows.reduce((acc, r) => acc + r.errors.length, 0);

  const handleCommitImport = async () => {
    if (draftRows.length === 0 || errorCount > 0) return;

    const limits = getTierQuotaLimits(tenant.subscription_tier);
    if (existingItems.length + draftRows.length > limits.maxSkus) {
      setStatusError(
        `Melebihi kuota paket ${tenant.subscription_tier} (maksimal ${limits.maxSkus} SKU).`
      );
      return;
    }

    const nowIso = new Date().toISOString();
    await localDB.transaction(
      'rw',
      [localDB.items, localDB.balances, localDB.ledger, localDB.auditLogs],
      async () => {
        for (const row of draftRows) {
          const itemId = generateUuidV7();
          const mult = parseInt(row.uom_multiplier || '1', 10);
          const uoms =
            mult > 1 && row.uom_name.trim()
              ? [{ unit_name: row.uom_name.trim(), multiplier_to_base: mult }]
              : [];

          await localDB.items.put({
            id: itemId,
            tenant_id: tenant.id,
            sku_code: row.sku_code.trim().toUpperCase(),
            barcode: row.barcode.trim() || `QR-${row.sku_code.trim().toUpperCase()}`,
            name: row.name.trim(),
            category: row.category.trim() || 'Umum',
            default_bin_code: row.bin_code.trim() || 'ZONA-A/RAK-01',
            base_unit: row.base_unit.trim(),
            min_stock: parseInt(row.min_stock || '0', 10),
            cost_price: Number(row.cost_price || '0'),
            is_fixed_asset: row.is_fixed_asset.trim().toLowerCase() === 'true',
            asset_condition: 'BAIK',
            uoms,
            updated_at: nowIso,
          });

          const initQty = parseInt(row.qty_initial || '0', 10);
          await localDB.balances.put({
            id: generateUuidV7(),
            tenant_id: tenant.id,
            warehouse_id: warehouse.id,
            bin_code: row.bin_code.trim() || 'ZONA-A/RAK-01',
            item_id: itemId,
            batch_number: 'SALDO-AWAL',
            expiry_date: row.expiry_date.trim() || undefined,
            qty_on_hand: initQty,
            qty_reserved: 0,
            updated_at: nowIso,
          });

          if (initQty > 0) {
            await localDB.ledger.put({
              id: generateUuidV7(),
              tenant_id: tenant.id,
              warehouse_id: warehouse.id,
              item_id: itemId,
              batch_number: 'SALDO-AWAL',
              event_type: 'INBOUND',
              qty_delta: initQty,
              is_overdraft_flagged: false,
              is_unverified_flagged: false,
              actor_id: actor.id,
              actor_name: actor.full_name,
              approval_method: 'AUTO_APPROVED',
              device_origin: 'Bulk-CSV-Import',
              notes: 'Migrasi saldo awal katalog',
              created_at: nowIso,
              synced_at: nowIso,
            });
          }
        }

        await localDB.auditLogs.put({
          id: generateUuidV7(),
          tenant_id: tenant.id,
          actor_id: actor.id,
          actor_name: actor.full_name,
          action_type: 'BULK_IMPORT_SKU',
          target_id: `${draftRows.length} SKU`,
          summary: `Impor massal ${draftRows.length} barang baru ke ${warehouse.name}.`,
          created_at: nowIso,
        });
      }
    );

    const count = draftRows.length;
    setDraftRows([]);
    onImported(`Berhasil mengimpor ${count} SKU beserta saldo awal ke katalog.`);
    onClose();
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Impor Massal Katalog SKU & Saldo Awal"
      subtitle="Validator otomatis memeriksa duplikasi SKU, angka HPP, dan format satuan langsung di layar"
      maxWidthClass="max-w-4xl"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700">
            <Upload size={16} strokeWidth={1.5} />
            <span>Unggah berkas .csv / Excel CSV</span>
            <input
              type="file"
              accept=".csv,.tsv,text/csv"
              onChange={handleFileChange}
              className="visually-hidden"
            />
          </label>

          <button
            type="button"
            onClick={() => loadCsvString(DEMO_CSV_SAMPLE)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <span>Muat contoh data migrasi (2 SKU)</span>
          </button>

          <a
            href="/templates/template_impor_sku_gudangku.csv"
            download
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            <Download size={15} strokeWidth={1.5} />
            <span>Unduh template CSV</span>
          </a>
        </div>

        {statusError && (
          <p role="alert" className="text-xs font-medium text-red-700">
            {statusError}
          </p>
        )}

        {draftRows.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700">
                Pratinjau {draftRows.length} baris (klik sel untuk perbaiki langsung tanpa unggah ulang)
              </span>
              {errorCount > 0 ? (
                <span className="inline-flex items-center gap-1 font-medium text-red-700">
                  <AlertCircle size={15} strokeWidth={1.5} />
                  <span>{errorCount} masalah perlu diperbaiki</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-medium text-emerald-700">
                  <CheckCircle2 size={15} strokeWidth={1.5} />
                  <span>Seluruh baris valid</span>
                </span>
              )}
            </div>

            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100 text-slate-700">
                  <tr>
                    <th className="p-2.5">Kode SKU</th>
                    <th className="p-2.5">Nama barang</th>
                    <th className="p-2.5">Satuan dasar</th>
                    <th className="p-2.5">Saldo awal</th>
                    <th className="p-2.5">HPP (Rp)</th>
                    <th className="p-2.5">Status validasi</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {draftRows.map((row, idx) => {
                    const hasErr = row.errors.length > 0;
                    return (
                      <tr
                        key={row.rowNumber}
                        className={hasErr ? 'bg-red-50/70' : 'bg-white'}
                      >
                        <td className="p-2">
                          <input
                            type="text"
                            aria-label={`Kode SKU baris ${row.rowNumber}`}
                            value={row.sku_code}
                            onChange={(e) =>
                              updateCell(idx, 'sku_code', e.target.value)
                            }
                            className="w-32 rounded border border-slate-300 bg-white px-2 py-1 font-mono-tech text-xs"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            aria-label={`Nama barang baris ${row.rowNumber}`}
                            value={row.name}
                            onChange={(e) => updateCell(idx, 'name', e.target.value)}
                            className="w-44 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            aria-label={`Satuan dasar baris ${row.rowNumber}`}
                            value={row.base_unit}
                            onChange={(e) =>
                              updateCell(idx, 'base_unit', e.target.value)
                            }
                            className="w-20 rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            aria-label={`Saldo awal baris ${row.rowNumber}`}
                            value={row.qty_initial}
                            onChange={(e) =>
                              updateCell(idx, 'qty_initial', e.target.value)
                            }
                            className="w-20 rounded border border-slate-300 bg-white px-2 py-1 font-mono-tech text-xs"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            aria-label={`HPP baris ${row.rowNumber}`}
                            value={row.cost_price}
                            onChange={(e) =>
                              updateCell(idx, 'cost_price', e.target.value)
                            }
                            className="w-24 rounded border border-slate-300 bg-white px-2 py-1 font-mono-tech text-xs"
                          />
                        </td>
                        <td className="p-2">
                          {hasErr ? (
                            <ul className="text-[11px] font-medium text-red-700 space-y-0.5">
                              {row.errors.map((err, i) => (
                                <li key={i}>{err}</li>
                              ))}
                            </ul>
                          ) : (
                            <span className="text-[11px] font-medium text-emerald-700">
                              Siap disimpan
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={errorCount > 0}
                onClick={() => void handleCommitImport()}
                className="inline-flex min-h-[48px] items-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                <CheckCircle2 size={18} strokeWidth={1.5} />
                <span>Simpan {draftRows.length} SKU ke database</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </ModalDialog>
  );
}
