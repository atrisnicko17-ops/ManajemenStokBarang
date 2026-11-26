'use client';

import React, { useId, useMemo, useState } from 'react';
import {
  AlertOctagon,
  Download,
  FileSpreadsheet,
  Plus,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Upload,
  Wrench,
} from 'lucide-react';
import { serializeSafeCsv } from '@/domain/csv-xlsx-validator';
import type {
  AuditLogEntry,
  BatchBalance,
  BinLocation,
  ItemRecord,
  LedgerEntry,
  RequestType,
  StockRequest,
  TenantConfig,
  UserAccount,
  Warehouse,
} from '@/domain/types';
import { generateUuidV7 } from '@/domain/uuidv7';
import { initializeOrSeedLocalDB, localDB } from '@/offline/db';
import {
  importEmergencyOutboxDump,
  simulateConcurrentOfflineRaceCondition,
  voidCompletedLedgerEntry,
} from '@/offline/sync-worker';
import { ModalDialog } from './ModalDialog';

interface AdminControlTowerViewProps {
  tenant: TenantConfig;
  warehouse: Warehouse;
  adminUser: UserAccount;
  items: ReadonlyArray<ItemRecord>;
  balances: ReadonlyArray<BatchBalance>;
  bins: ReadonlyArray<BinLocation>;
  requests: ReadonlyArray<StockRequest>;
  ledger: ReadonlyArray<LedgerEntry>;
  auditLogs: ReadonlyArray<AuditLogEntry>;
  outboxCount: number;
  onOpenQrPrinter: () => void;
  onOpenBulkImport: () => void;
  onOpenOnboarding: () => void;
  onOpenTransaction: (mode: RequestType, itemId?: string) => void;
  onToast: (msg: string) => void;
}

function formatRupiah(amount: number): string {
  return `Rp ${Math.round(amount).toLocaleString('id-ID')}`;
}

export function AdminControlTowerView({
  tenant,
  warehouse,
  adminUser,
  items,
  balances,
  bins,
  requests,
  ledger,
  auditLogs,
  outboxCount,
  onOpenQrPrinter,
  onOpenBulkImport,
  onOpenOnboarding,
  onOpenTransaction,
  onToast,
}: AdminControlTowerViewProps) {
  const tableCaptionId = useId();
  const [voidTarget, setVoidTarget] = useState<LedgerEntry | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [isAddSkuOpen, setIsAddSkuOpen] = useState(false);
  const [newSkuCode, setNewSkuCode] = useState('');
  const [newSkuName, setNewSkuName] = useState('');
  const [newSkuUnit, setNewSkuUnit] = useState('Pcs');
  const [newSkuCost, setNewSkuCost] = useState('25000');
  const [newSkuMin, setNewSkuMin] = useState('5');

  const kpiMetrics = useMemo(() => {
    let totalValuation = 0;
    let criticalCount = 0;

    const itemRows = items.map((it) => {
      const itemBals = balances.filter(
        (b) => b.warehouse_id === warehouse.id && b.item_id === it.id
      );
      const onHand = itemBals.reduce((s, b) => s + b.qty_on_hand, 0);
      const reserved = itemBals.reduce((s, b) => s + b.qty_reserved, 0);
      const valuation = Math.max(0, onHand) * it.cost_price;
      totalValuation += valuation;
      if (onHand <= it.min_stock) criticalCount++;

      const binFrozen = Boolean(
        bins.find(
          (b) =>
            b.warehouse_id === warehouse.id && b.bin_code === it.default_bin_code
        )?.is_frozen
      );

      return { item: it, onHand, reserved, valuation, binFrozen };
    });

    const pendingApprovals = requests.filter(
      (r) => r.status === 'PENDING_APPROVAL'
    ).length;

    const anomalyCount = ledger.filter(
      (l) => l.is_overdraft_flagged || l.is_unverified_flagged
    ).length;

    return {
      totalValuation,
      criticalCount,
      pendingApprovals,
      anomalyCount,
      itemRows,
    };
  }, [items, balances, warehouse.id, bins, requests, ledger]);

  const handleExportSafeCsv = () => {
    const csv = serializeSafeCsv(
      [
        'Kode SKU',
        'Barcode',
        'Nama Barang',
        'Lokasi Rak',
        'Stok Fisik',
        'Dikunci',
        'Satuan Dasar',
        'HPP Satuan (Rp)',
        'Nilai Total (Rp)',
      ],
      kpiMetrics.itemRows.map(({ item, onHand, reserved, valuation }) => [
        item.sku_code,
        item.barcode,
        item.name,
        item.default_bin_code,
        onHand,
        reserved,
        item.base_unit,
        item.cost_price,
        valuation,
      ])
    );

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `valuasi-stok-${tenant.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    onToast('Laporan valuasi stok CSV (dilindungi anti-formula injection) berhasil diunduh.');
  };

  const handleSimulateOverdraft = async () => {
    const targetItem = items[1] ?? items[0];
    if (!targetItem) return;
    try {
      const res = await simulateConcurrentOfflineRaceCondition(
        tenant.id,
        warehouse.id,
        targetItem.id
      );
      onToast(
        `Simulasi selesai: ${res.processedCount} mutasi offline diproses berurutan, ${res.overdraftDetectedCount} ditandai FLAGGED_OVERDRAFT di Buku Besar.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal menjalankan simulasi.');
    }
  };

  const handleCycleSubscriptionState = async () => {
    const now = Date.now();
    const currentValid = Date.parse(tenant.subscription_valid_until);
    let nextValidIso: string;
    let label: string;

    if (currentValid > now) {
      // Pindah ke Grace Period (kedaluwarsa 12 jam lalu -> sisa 60 jam toleransi)
      nextValidIso = new Date(now - 12 * 3600 * 1000).toISOString();
      label = 'Simulasi Grace Period 72 Jam aktif (banner kuning peringatan langganan).';
    } else if (now - currentValid <= 72 * 3600 * 1000) {
      // Pindah ke Read-Only (kedaluwarsa 80 jam lalu)
      nextValidIso = new Date(now - 80 * 3600 * 1000).toISOString();
      label = 'Simulasi Mode Baca-Saja (Read-Only pasca-72 jam) aktif.';
    } else {
      // Pulihkan ke Aktif Normal (+30 hari)
      nextValidIso = new Date(now + 30 * 24 * 3600 * 1000).toISOString();
      label = 'Masa aktif langganan dipulihkan ke status Aktif (+30 hari).';
    }

    await localDB.tenants.update(tenant.id, {
      subscription_valid_until: nextValidIso,
    });
    onToast(label);
  };

  const handleManualRecoveryUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const summary = await importEmergencyOutboxDump(content, tenant.id);
      onToast(
        `Pemulihan darurat berhasil: ${summary.processedCount} diproses, ${summary.skippedIdempotentCount} duplikat dilewati.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal memulihkan JSON darurat.');
    }
  };

  const handleResetSimulation = async () => {
    await initializeOrSeedLocalDB(localDB, true);
    onToast('Seluruh data simulasi gudang telah dikembalikan ke kondisi awal.');
  };

  const handleConfirmVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidTarget) return;
    try {
      await voidCompletedLedgerEntry({
        ledgerId: voidTarget.id,
        voidReason,
        actor: adminUser,
      });
      onToast('Transaksi berhasil dibatalkan melalui jurnal pembalikan VOID_REVERSAL.');
      setVoidTarget(null);
      setVoidReason('');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal memproses VOID.');
    }
  };

  const handleCreateQuickSku = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = newSkuCode.trim().toUpperCase();
    if (code.length < 2 || newSkuName.trim().length < 2) {
      onToast('Kode SKU dan nama barang wajib diisi.');
      return;
    }
    const nowIso = new Date().toISOString();
    const id = generateUuidV7();
    await localDB.transaction('rw', [localDB.items, localDB.balances], async () => {
      await localDB.items.put({
        id,
        tenant_id: tenant.id,
        sku_code: code,
        barcode: `QR-${code}`,
        name: newSkuName.trim(),
        category: 'Umum',
        default_bin_code: 'ZONA-A/RAK-01',
        base_unit: newSkuUnit.trim() || 'Pcs',
        min_stock: parseInt(newSkuMin || '0', 10),
        cost_price: Number(newSkuCost || '0'),
        is_fixed_asset: false,
        asset_condition: 'BAIK',
        uoms: [],
        updated_at: nowIso,
      });
      await localDB.balances.put({
        id: generateUuidV7(),
        tenant_id: tenant.id,
        warehouse_id: warehouse.id,
        bin_code: 'ZONA-A/RAK-01',
        item_id: id,
        batch_number: 'GENERAL',
        qty_on_hand: 0,
        qty_reserved: 0,
        updated_at: nowIso,
      });
    });
    setNewSkuCode('');
    setNewSkuName('');
    setIsAddSkuOpen(false);
    onToast(`Master barang ${code} berhasil ditambahkan.`);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-14">
      {/* Baris Aksi Administrasi & Reset Simulasi */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Executive Control Tower
          </h2>
          <p className="text-xs text-slate-600">
            Pengawasan valuasi HPP, katalog Multi-UOM, dan buku besar mutasi anti-hapus
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setIsAddSkuOpen(true)}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus size={16} strokeWidth={1.5} />
            <span>Tambah SKU</span>
          </button>

          <button
            type="button"
            onClick={onOpenBulkImport}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <FileSpreadsheet size={16} strokeWidth={1.5} />
            <span>Impor CSV</span>
          </button>

          <button
            type="button"
            onClick={onOpenQrPrinter}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <QrCode size={16} strokeWidth={1.5} />
            <span>Cetak label QR</span>
          </button>

          <button
            type="button"
            onClick={handleExportSafeCsv}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <Download size={16} strokeWidth={1.5} />
            <span>Ekspor valuasi CSV</span>
          </button>

          <button
            type="button"
            onClick={onOpenOnboarding}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
          >
            <span>Workspace baru</span>
          </button>

          <button
            type="button"
            onClick={() => void handleResetSimulation()}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-100 px-3 text-xs font-medium text-slate-700 hover:bg-slate-200"
          >
            <RefreshCw size={15} strokeWidth={1.5} />
            <span>Reset data simulasi</span>
          </button>
        </div>
      </div>

      {/* 4 Kartu KPI Eksekutif (angka tabular-nums bersih tanpa dekorasi slop) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <span className="text-xs font-medium text-slate-500 block">
            Total nilai stok (HPP)
          </span>
          <strong className="font-mono-tech text-2xl font-semibold text-slate-900 block mt-1.5">
            {formatRupiah(kpiMetrics.totalValuation)}
          </strong>
          <span className="text-xs text-slate-500 block mt-1">
            Khusus peran Admin / Owner
          </span>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <span className="text-xs font-medium text-slate-500 block">
            SKU stok kritis
          </span>
          <strong
            className={`font-mono-tech text-2xl font-semibold block mt-1.5 ${
              kpiMetrics.criticalCount > 0 ? 'text-red-600' : 'text-slate-900'
            }`}
          >
            {kpiMetrics.criticalCount} SKU
          </strong>
          <span className="text-xs text-slate-500 block mt-1">
            Di bawah batas minimum gudang
          </span>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <span className="text-xs font-medium text-slate-500 block">
            Menunggu approval
          </span>
          <strong
            className={`font-mono-tech text-2xl font-semibold block mt-1.5 ${
              kpiMetrics.pendingApprovals > 0 ? 'text-amber-600' : 'text-slate-900'
            }`}
          >
            {kpiMetrics.pendingApprovals} dokumen
          </strong>
          <span className="text-xs text-slate-500 block mt-1">
            Ambang otomatis: &le; {tenant.approval_threshold_qty} unit dasar
          </span>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <span className="text-xs font-medium text-slate-500 block">
            Status antrean & anomali
          </span>
          <strong
            className={`font-mono-tech text-2xl font-semibold block mt-1.5 ${
              kpiMetrics.anomalyCount > 0
                ? 'text-red-600'
                : outboxCount > 0
                  ? 'text-amber-600'
                  : 'text-emerald-600'
            }`}
          >
            {kpiMetrics.anomalyCount > 0
              ? `${kpiMetrics.anomalyCount} anomali`
              : outboxCount > 0
                ? `${outboxCount} antrean`
                : 'Synced'}
          </strong>
          <span className="text-xs text-slate-500 block mt-1">
            Paket {tenant.subscription_tier} • {warehouse.name}
          </span>
        </div>
      </section>

      {/* Tabel Master Data SKU & Valuasi HPP (Responsive @container table) */}
      <section className="space-y-2.5">
        <div
          tabIndex={0}
          role="region"
          aria-labelledby={tableCaptionId}
          className="table-wrapper"
        >
          <table
            style={
              {
                '--label-2': '"Nama barang"',
                '--label-3': '"Lokasi rak"',
                '--label-4': '"Stok fisik"',
                '--label-5': '"HPP & valuasi"',
                '--label-6': '"Aksi"',
              } as React.CSSProperties
            }
          >
            <caption
              id={tableCaptionId}
              className="px-4 py-3 text-left text-xs font-semibold text-slate-700 border-b border-slate-200 bg-white"
            >
              Master data SKU, lokasi rak & valuasi HPP ({kpiMetrics.itemRows.length} barang)
            </caption>
            <thead>
              <tr className="text-left text-xs font-semibold text-slate-700 border-b border-slate-200">
                <th className="px-4 py-3">Kode SKU</th>
                <th className="px-4 py-3">Nama barang</th>
                <th className="px-4 py-3">Lokasi rak</th>
                <th className="px-4 py-3 text-right">Stok fisik</th>
                <th className="px-4 py-3 text-right">HPP & valuasi</th>
                <th className="px-4 py-3 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-xs">
              {kpiMetrics.itemRows.map(
                ({ item, onHand, reserved, valuation, binFrozen }) => {
                  const isCritical = onHand <= item.min_stock;
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70">
                      <th className="px-4 py-3 font-mono-tech font-semibold text-slate-900">
                        {item.sku_code}
                      </th>
                      <td data-col="2" className="px-4 py-3 text-slate-900">
                        <span className="font-medium">{item.name}</span>
                        {item.uoms.length > 0 && (
                          <span className="block text-[11px] text-slate-500 mt-0.5">
                            Multi-UOM:{' '}
                            {item.uoms
                              .map(
                                (u) =>
                                  `1 ${u.unit_name} = ${u.multiplier_to_base} ${item.base_unit}`
                              )
                              .join(', ')}
                          </span>
                        )}
                      </td>
                      <td data-col="3" className="px-4 py-3 font-mono-tech text-slate-700">
                        {item.default_bin_code}
                        {binFrozen && (
                          <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 font-sans text-[10px] font-medium text-red-700">
                            Beku
                          </span>
                        )}
                      </td>
                      <td data-col="4" className="px-4 py-3 text-right font-mono-tech">
                        <span
                          className={`font-semibold ${
                            isCritical ? 'text-red-600' : 'text-slate-900'
                          }`}
                        >
                          {onHand} {item.base_unit}
                        </span>
                        {reserved > 0 && (
                          <span className="block text-[11px] text-amber-700">
                            ({reserved} dikunci)
                          </span>
                        )}
                      </td>
                      <td data-col="5" className="px-4 py-3 text-right font-mono-tech">
                        <span className="text-slate-900 font-medium">
                          {formatRupiah(valuation)}
                        </span>
                        <span className="block text-[11px] text-slate-500">
                          @ {formatRupiah(item.cost_price)}
                        </span>
                      </td>
                      <td data-col="6" className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onOpenTransaction('INBOUND', item.id)}
                            className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            + PO
                          </button>
                          <button
                            type="button"
                            onClick={onOpenQrPrinter}
                            className="min-h-[36px] rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                          >
                            QR
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                }
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Panel Lab Pengujian Lapangan (Field QA Chaos & Disaster Recovery) */}
      <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
          <Wrench size={16} strokeWidth={1.5} className="text-slate-600" />
          <span>Panel Uji Ketahanan Lapangan & Disaster Recovery (Field QA Checklist)</span>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            onClick={() => void handleSimulateOverdraft()}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3.5 text-xs font-medium text-red-900 hover:bg-red-100"
          >
            <AlertOctagon size={15} strokeWidth={1.5} />
            <span>Simulasi 2 HP bentrok stok terakhir (FLAGGED_OVERDRAFT)</span>
          </button>

          <button
            type="button"
            onClick={() => void handleCycleSubscriptionState()}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3.5 text-xs font-medium text-amber-950 hover:bg-amber-100"
          >
            <ShieldAlert size={15} strokeWidth={1.5} />
            <span>Uji siklus Grace Period 72 Jam / Read-Only</span>
          </button>

          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-slate-50 px-3.5 text-xs font-medium text-slate-800 hover:bg-slate-100">
            <Upload size={15} strokeWidth={1.5} />
            <span>Manual Sync Recovery (unggah .json darurat)</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={handleManualRecoveryUpload}
              className="visually-hidden"
            />
          </label>
        </div>
      </section>

      {/* Immutable Audit Trail & Buku Besar Mutasi Stok */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 space-y-2.5">
          <h3 className="text-xs font-semibold text-slate-700">
            Immutable Event Ledger — Buku besar mutasi stok (anti-hapus)
          </h3>
          <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {ledger.slice(0, 12).map((entry) => {
              const it = items.find((i) => i.id === entry.item_id);
              const isPos = entry.qty_delta > 0;
              return (
                <div
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 p-3.5 text-xs"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-mono-tech text-[11px] font-medium text-slate-800">
                        {entry.event_type}
                      </span>
                      {entry.is_overdraft_flagged && (
                        <span className="rounded bg-red-600 px-2 py-0.5 font-mono-tech text-[11px] font-semibold text-white">
                          FLAGGED_OVERDRAFT
                        </span>
                      )}
                      {entry.is_unverified_flagged && (
                        <span className="rounded bg-amber-600 px-2 py-0.5 font-mono-tech text-[11px] font-semibold text-white">
                          FLAGGED_UNVERIFIED
                        </span>
                      )}
                      <span className="font-semibold text-slate-900">
                        {it?.name ?? entry.item_id}
                      </span>
                    </div>
                    <p className="text-slate-600">
                      Aktor: {entry.actor_name} • Asal: {entry.device_origin}
                      {entry.notes ? ` • ${entry.notes}` : ''}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    <span
                      className={`font-mono-tech text-sm font-semibold ${
                        isPos ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {isPos ? `+${entry.qty_delta}` : entry.qty_delta}{' '}
                      {it?.base_unit ?? ''}
                    </span>

                    {entry.event_type !== 'VOID_REVERSAL' && (
                      <button
                        type="button"
                        onClick={() => setVoidTarget(entry)}
                        className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-medium text-slate-700 hover:border-red-300 hover:text-red-700"
                      >
                        <RotateCcw size={13} strokeWidth={1.5} />
                        <span>Void</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="space-y-2.5">
          <h3 className="text-xs font-semibold text-slate-700">
            Log tata kelola & keamanan ({auditLogs.length})
          </h3>
          <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {auditLogs.slice(0, 8).map((log) => (
              <div key={log.id} className="p-3.5 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono-tech font-semibold text-slate-900">
                    {log.action_type}
                  </span>
                  <span className="font-mono-tech text-[11px] text-slate-400">
                    {new Date(log.created_at).toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <p className="text-slate-600 leading-relaxed">{log.summary}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* Dialog Konfirmasi VOID Transaksi */}
      <ModalDialog
        isOpen={Boolean(voidTarget)}
        onClose={() => setVoidTarget(null)}
        title="Pembatalan Transaksi (Prosedur VOID)"
        subtitle="Catatan asli tidak dihapus; sistem menerbitkan jurnal pembalikan VOID_REVERSAL"
        maxWidthClass="max-w-md"
      >
        <form method="POST" action="#void-entry" onSubmit={handleConfirmVoid} className="space-y-4">
          <div>
            <label
              htmlFor="void-reason-input"
              className="block text-xs font-medium text-slate-700 mb-1"
            >
              Alasan pembatalan resmi <span aria-hidden="true">*</span>
            </label>
            <input
              id="void-reason-input"
              type="text"
              required
              minLength={4}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Contoh: Salah pilih ukuran barang saat scan"
              className="w-full rounded-lg border border-slate-300 px-3 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setVoidTarget(null)}
              className="min-h-[44px] rounded-lg border border-slate-300 px-4 text-xs font-medium text-slate-700"
            >
              Batal
            </button>
            <button
              type="submit"
              className="min-h-[44px] rounded-lg bg-red-600 px-4 text-xs font-medium text-white hover:bg-red-700"
            >
              Terbitkan jurnal VOID
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Dialog Tambah SKU Cepat */}
      <ModalDialog
        isOpen={isAddSkuOpen}
        onClose={() => setIsAddSkuOpen(false)}
        title="Tambah Master Barang (SKU)"
        subtitle="Simpan identitas SKU dan satuan terkecil gudang"
        maxWidthClass="max-w-md"
      >
        <form method="POST" action="#create-sku" onSubmit={handleCreateQuickSku} className="space-y-3.5">
          <div>
            <label htmlFor="quick-sku-code" className="block text-xs font-medium text-slate-700 mb-1">
              Kode SKU <span aria-hidden="true">*</span>
            </label>
            <input
              id="quick-sku-code"
              type="text"
              required
              value={newSkuCode}
              onChange={(e) => setNewSkuCode(e.target.value)}
              placeholder="Contoh: ATK-MAP-01"
              className="w-full rounded-lg border border-slate-300 px-3 font-mono-tech text-sm"
            />
          </div>
          <div>
            <label htmlFor="quick-sku-name" className="block text-xs font-medium text-slate-700 mb-1">
              Nama barang <span aria-hidden="true">*</span>
            </label>
            <input
              id="quick-sku-name"
              type="text"
              required
              value={newSkuName}
              onChange={(e) => setNewSkuName(e.target.value)}
              placeholder="Contoh: Map Plastik Kancing F4"
              className="w-full rounded-lg border border-slate-300 px-3 text-sm"
            />
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label htmlFor="quick-sku-unit" className="block text-xs font-medium text-slate-700 mb-1">
                Satuan dasar
              </label>
              <input
                id="quick-sku-unit"
                type="text"
                value={newSkuUnit}
                onChange={(e) => setNewSkuUnit(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 text-sm"
              />
            </div>
            <div>
              <label htmlFor="quick-sku-min" className="block text-xs font-medium text-slate-700 mb-1">
                Stok min
              </label>
              <input
                id="quick-sku-min"
                type="text"
                inputMode="numeric"
                value={newSkuMin}
                onChange={(e) => setNewSkuMin(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-lg border border-slate-300 px-3 font-mono-tech text-sm"
              />
            </div>
            <div>
              <label htmlFor="quick-sku-cost" className="block text-xs font-medium text-slate-700 mb-1">
                HPP (Rp)
              </label>
              <input
                id="quick-sku-cost"
                type="text"
                inputMode="numeric"
                value={newSkuCost}
                onChange={(e) => setNewSkuCost(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-lg border border-slate-300 px-3 font-mono-tech text-sm"
              />
            </div>
          </div>
          <button
            type="submit"
            className="min-h-[48px] w-full rounded-lg bg-blue-600 text-sm font-medium text-white hover:bg-blue-700"
          >
            Simpan SKU baru
          </button>
        </form>
      </ModalDialog>
    </div>
  );
}
