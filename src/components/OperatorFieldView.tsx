'use client';

import React, { useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  ClipboardList,
  Download,
  FileCheck2,
  PackageCheck,
  QrCode,
  RotateCcw,
  Search,
} from 'lucide-react';
import { getProfileTerminology } from '@/domain/profile-terminology';
import type {
  AssetCondition,
  BatchBalance,
  BinLocation,
  NetworkMode,
  OperatorItemView,
  RequestType,
  StockRequest,
  TenantConfig,
  UserAccount,
  Warehouse,
} from '@/domain/types';
import { formatStockWithLargestUom } from '@/domain/uom-converter';
import {
  exportEmergencyOutboxDump,
  returnBorrowedAsset,
} from '@/offline/sync-worker';

interface OperatorFieldViewProps {
  tenant: TenantConfig;
  warehouse: Warehouse;
  operator: UserAccount;
  items: ReadonlyArray<OperatorItemView>;
  balances: ReadonlyArray<BatchBalance>;
  bins: ReadonlyArray<BinLocation>;
  requests: ReadonlyArray<StockRequest>;
  outboxCount: number;
  networkMode: NetworkMode;
  onOpenScanner: () => void;
  onOpenTransaction: (mode: RequestType, itemId?: string) => void;
  onOpenBlindOpname: () => void;
  onOpenBastModal: (req: StockRequest) => void;
  onToast: (msg: string) => void;
}

export function OperatorFieldView({
  tenant,
  warehouse,
  operator,
  items,
  balances,
  bins,
  requests,
  outboxCount,
  onOpenScanner,
  onOpenTransaction,
  onOpenBlindOpname,
  onOpenBastModal,
  onToast,
}: OperatorFieldViewProps) {
  const terms = getProfileTerminology(tenant.business_profile);
  const [searchQuery, setSearchQuery] = useState('');
  const [returnConditions, setReturnConditions] = useState<
    Record<string, AssetCondition>
  >({});
  const searchId = useId();

  const approvedReadyRequests = useMemo(
    () =>
      requests.filter(
        (r) => r.warehouse_id === warehouse.id && r.status === 'APPROVED'
      ),
    [requests, warehouse.id]
  );

  const activeAssetLoans = useMemo(
    () =>
      requests.filter(
        (r) =>
          r.warehouse_id === warehouse.id &&
          r.request_type === 'ASSET_LOAN' &&
          r.status === 'COMPLETED' &&
          !r.returned_condition
      ),
    [requests, warehouse.id]
  );

  const stockRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return items
      .filter((it) => {
        if (!q) return true;
        return (
          it.sku_code.toLowerCase().includes(q) ||
          it.name.toLowerCase().includes(q) ||
          it.default_bin_code.toLowerCase().includes(q) ||
          it.barcode.toLowerCase().includes(q)
        );
      })
      .map((it) => {
        const itemBals = balances.filter(
          (b) => b.warehouse_id === warehouse.id && b.item_id === it.id
        );
        const onHand = itemBals.reduce((s, b) => s + b.qty_on_hand, 0);
        const reserved = itemBals.reduce((s, b) => s + b.qty_reserved, 0);
        const earliestExpiry = itemBals
          .map((b) => b.expiry_date)
          .filter((d): d is string => Boolean(d))
          .sort()[0];
        const binFrozen = Boolean(
          bins.find(
            (b) =>
              b.warehouse_id === warehouse.id &&
              b.bin_code === it.default_bin_code
          )?.is_frozen
        );
        return {
          item: it,
          onHand,
          reserved,
          earliestExpiry,
          binFrozen,
        };
      });
  }, [items, balances, warehouse.id, searchQuery, bins]);

  const handleDownloadEmergencyDump = async () => {
    const json = await exportEmergencyOutboxDump(tenant.id);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gudangku-emergency-outbox-${tenant.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    onToast('Berkas Emergency JSON Dump berhasil diunduh untuk pemulihan darurat.');
  };

  const handleReturnAsset = async (req: StockRequest) => {
    const condition = returnConditions[req.id] ?? 'BAIK';
    try {
      await returnBorrowedAsset({
        requestId: req.id,
        returnedCondition: condition,
        operator,
      });
      onToast(
        `Aset pada tiket ${req.request_code} telah diterima kembali dalam kondisi ${condition}.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal memproses pengembalian.');
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6 pb-12">
      {/* Primary Thumb-Friendly Scan CTA (72px height) */}
      <button
        type="button"
        onClick={onOpenScanner}
        className="flex min-h-[72px] w-full items-center justify-between gap-4 rounded-2xl bg-blue-600 px-5 py-4 text-left text-white shadow-sm transition-colors hover:bg-blue-700 active:scale-[0.99]"
      >
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15">
            <QrCode size={22} strokeWidth={1.5} />
          </div>
          <div>
            <span className="block text-base font-semibold leading-tight">
              Scan barcode / QR barang
            </span>
            <span className="block text-xs text-blue-100 mt-0.5">
              Cek lokasi rak, stok fisik, atau catat mutasi cepat
            </span>
          </div>
        </div>
        <ArrowUpRight size={20} strokeWidth={1.5} className="shrink-0 text-blue-100" />
      </button>

      {/* 4 Aksi Cepat Gudang */}
      <section aria-labelledby="quick-actions-heading" className="space-y-2.5">
        <h2
          id="quick-actions-heading"
          className="text-xs font-semibold text-slate-600"
        >
          Aksi cepat gudang
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onOpenTransaction('INBOUND')}
            className="flex min-h-[68px] flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 text-left transition-colors hover:border-emerald-600 hover:bg-emerald-50/30"
          >
            <div className="flex items-center gap-2 text-emerald-700">
              <ArrowDownLeft size={18} strokeWidth={1.5} />
              <span className="text-sm font-semibold text-slate-900">
                Barang masuk
              </span>
            </div>
            <span className="text-xs text-slate-500 mt-1">
              Terima PO / retur layak
            </span>
          </button>

          <button
            type="button"
            onClick={() => onOpenTransaction('OUTBOUND')}
            className="flex min-h-[68px] flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 text-left transition-colors hover:border-blue-600 hover:bg-blue-50/30"
          >
            <div className="flex items-center gap-2 text-blue-600">
              <ArrowUpRight size={18} strokeWidth={1.5} />
              <span className="text-sm font-semibold text-slate-900">
                {terms.outboundActionTitle}
              </span>
            </div>
            <span className="text-xs text-slate-500 mt-1">
              {terms.outboundActionSubtitle}
            </span>
          </button>

          <button
            type="button"
            onClick={() => onOpenTransaction('WRITE_OFF')}
            className="flex min-h-[68px] flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 text-left transition-colors hover:border-red-600 hover:bg-red-50/30"
          >
            <div className="flex items-center gap-2 text-red-600">
              <AlertTriangle size={18} strokeWidth={1.5} />
              <span className="text-sm font-semibold text-slate-900">
                Lapor rusak
              </span>
            </div>
            <span className="text-xs text-slate-500 mt-1">
              Write-off + wajib foto
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenBlindOpname}
            className="flex min-h-[68px] flex-col justify-between rounded-xl border border-slate-200 bg-white p-3.5 text-left transition-colors hover:border-slate-500 hover:bg-slate-50"
          >
            <div className="flex items-center gap-2 text-slate-700">
              <ClipboardList size={18} strokeWidth={1.5} />
              <span className="text-sm font-semibold text-slate-900">
                Stock opname
              </span>
            </div>
            <span className="text-xs text-slate-500 mt-1">
              Blind count tanpa lihat saldo
            </span>
          </button>
        </div>
      </section>

      {/* Opsi Pemulihan Darurat jika ada Antrean Offline */}
      {outboxCount > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-amber-950">
            <p className="font-semibold">
              {outboxCount} mutasi tersimpan di antrean memori perangkat
            </p>
            <p className="text-amber-800 mt-0.5">
              Jika modul sinyal HP rusak, ekspor antrean JSON untuk dipulihkan Admin.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleDownloadEmergencyDump()}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-amber-400 bg-white px-3 text-xs font-medium text-amber-950 hover:bg-amber-100"
          >
            <Download size={15} strokeWidth={1.5} />
            <span>Ekspor antrean (.json)</span>
          </button>
        </section>
      )}

      {/* Tiket Disetujui — Siap Serah Terima & TTD BAST */}
      {approvedReadyRequests.length > 0 && (
        <section aria-labelledby="ready-tickets-heading" className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h2
              id="ready-tickets-heading"
              className="text-xs font-semibold text-slate-600"
            >
              Tiket disetujui — siap serah ({terms.handoverShortCode})
            </h2>
            <span className="font-mono-tech text-xs font-medium text-emerald-700">
              {approvedReadyRequests.length} tiket
            </span>
          </div>

          <div className="space-y-2.5">
            {approvedReadyRequests.map((req) => {
              const it = items.find((i) => i.id === req.item_id);
              const qty = req.qty_approved_base ?? req.qty_requested_base;
              return (
                <div
                  key={req.id}
                  className="rounded-xl border border-emerald-200 bg-white p-4 space-y-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-tech text-xs font-semibold text-slate-900">
                      {req.request_code}
                    </span>
                    <span className="rounded-md bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                      Disetujui pimpinan
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {it?.name ?? 'Barang'}
                    </p>
                    <p className="text-xs text-slate-600 mt-0.5">
                      Jumlah:{' '}
                      <strong className="font-mono-tech text-slate-900">
                        {qty} {it?.base_unit ?? 'Unit'}
                      </strong>{' '}
                      • {req.party_name}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenBastModal(req)}
                    className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-colors hover:bg-emerald-700"
                  >
                    <FileCheck2 size={18} strokeWidth={1.5} />
                    <span>
                      Serahkan & tanda tangani ({terms.handoverShortCode})
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Pengembalian Aset Tetap Dipinjam (Profil Sekolah) */}
      {terms.enableFixedAssetLoan && activeAssetLoans.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-xs font-semibold text-slate-600">
            Peminjaman aset tetap aktif (belum kembali)
          </h2>
          <div className="space-y-2.5">
            {activeAssetLoans.map((loan) => {
              const it = items.find((i) => i.id === loan.item_id);
              return (
                <div
                  key={loan.id}
                  className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono-tech font-semibold text-slate-900">
                      {loan.request_code} • {it?.sku_code}
                    </span>
                    {loan.due_return_date && (
                      <span className="font-mono-tech text-slate-500">
                        Jatuh tempo: {loan.due_return_date}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-slate-900">
                    {it?.name} — {loan.party_name}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label={`Kondisi pengembalian aset ${loan.request_code}`}
                      value={returnConditions[loan.id] ?? 'BAIK'}
                      onChange={(e) =>
                        setReturnConditions((prev) => ({
                          ...prev,
                          [loan.id]: e.target.value as AssetCondition,
                        }))
                      }
                      className="flex-1 rounded-lg border border-slate-300 bg-white px-3 text-xs text-slate-900"
                    >
                      <option value="BAIK">Kondisi kembali: Baik</option>
                      <option value="RUSAK_RINGAN">Kondisi kembali: Rusak ringan</option>
                      <option value="RUSAK_BERAT">Kondisi kembali: Rusak berat</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleReturnAsset(loan)}
                      className="inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 text-xs font-medium text-white hover:bg-slate-800"
                    >
                      <RotateCcw size={15} strokeWidth={1.5} />
                      <span>Terima kembali</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Daftar Saldo Fisik Gudang (Tanpa Informasi Finansial / HPP) */}
      <section aria-labelledby="physical-stock-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2
            id="physical-stock-heading"
            className="text-xs font-semibold text-slate-600"
          >
            Saldo fisik gudang (tanpa info HPP)
          </h2>
          <span className="font-mono-tech text-xs text-slate-500">
            {stockRows.length} SKU
          </span>
        </div>

        <search>
          <form
            action="#filter-stock"
            method="GET"
            onSubmit={(e) => e.preventDefault()}
            className="relative"
          >
            <label htmlFor={searchId} className="visually-hidden">
              Cari barang atau lokasi rak
            </label>
            <Search
              size={18}
              strokeWidth={1.5}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              id={searchId}
              name="q"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Cari nama barang, SKU, atau rak"
              className="w-full rounded-xl border border-slate-300 bg-white pl-10 pr-4 text-sm text-slate-900"
            />
          </form>
        </search>

        <div className="space-y-2.5">
          {stockRows.map(({ item, onHand, reserved, earliestExpiry, binFrozen }) => {
            const isLow = onHand <= item.min_stock;
            return (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono-tech text-xs font-medium text-slate-500">
                      {item.sku_code}
                    </span>
                    {item.is_fixed_asset && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700">
                        Aset tetap ({item.asset_condition})
                      </span>
                    )}
                    {binFrozen && (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                        Rak beku
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-slate-900 truncate mt-0.5">
                    {item.name}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 mt-1">
                    <span className="font-mono-tech">{item.default_bin_code}</span>
                    {earliestExpiry && (
                      <span className="font-mono-tech text-amber-700">
                        ED: {earliestExpiry}
                      </span>
                    )}
                  </div>
                </div>

                <div className="text-right shrink-0 space-y-1.5">
                  <div>
                    <span
                      className={`font-mono-tech text-sm font-semibold block ${
                        isLow ? 'text-red-600' : 'text-slate-900'
                      }`}
                    >
                      {formatStockWithLargestUom(onHand, item.base_unit, item.uoms)}
                    </span>
                    {reserved > 0 && (
                      <span className="font-mono-tech text-[11px] text-amber-700 block">
                        ({reserved} dikunci)
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onOpenTransaction(
                        item.is_fixed_asset && terms.enableFixedAssetLoan
                          ? 'ASSET_LOAN'
                          : 'OUTBOUND',
                        item.id
                      )
                    }
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-800 hover:border-blue-600 hover:bg-blue-50 hover:text-blue-800"
                  >
                    <PackageCheck size={15} strokeWidth={1.5} />
                    <span>Transaksi</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
