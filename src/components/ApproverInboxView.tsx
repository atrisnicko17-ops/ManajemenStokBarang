'use client';

import React, { useMemo, useState } from 'react';
import {
  Check,
  FileText,
  KeyRound,
  ShieldCheck,
  X,
} from 'lucide-react';
import { deriveOfflinePinHash, isSixDigitPin } from '@/domain/pin-crypto';
import { getProfileTerminology } from '@/domain/profile-terminology';
import type {
  BatchBalance,
  OperatorItemView,
  StockRequest,
  TenantConfig,
  UserAccount,
} from '@/domain/types';
import { localDB } from '@/offline/db';
import { decidePendingRequest } from '@/offline/sync-worker';

type FilterTab = 'ALL' | 'OUTBOUND' | 'WRITE_OFF' | 'OPNAME_ADJUSTMENT';

interface ApproverInboxViewProps {
  tenant: TenantConfig;
  approver: UserAccount;
  items: ReadonlyArray<OperatorItemView>;
  balances: ReadonlyArray<BatchBalance>;
  requests: ReadonlyArray<StockRequest>;
  onOpenBastPreview: (req: StockRequest) => void;
  onToast: (msg: string) => void;
}

export function ApproverInboxView({
  tenant,
  approver,
  items,
  balances,
  requests,
  onOpenBastPreview,
  onToast,
}: ApproverInboxViewProps) {
  const terms = getProfileTerminology(tenant.business_profile);
  const [filterTab, setFilterTab] = useState<FilterTab>('ALL');
  const [revisedQtyMap, setRevisedQtyMap] = useState<Record<string, string>>({});
  const [rejectReasonMap, setRejectReasonMap] = useState<Record<string, string>>({});
  const [newPin, setNewPin] = useState('');
  const [showPinEditor, setShowPinEditor] = useState(false);

  const pendingRequests = useMemo(() => {
    return requests
      .filter((r) => r.status === 'PENDING_APPROVAL')
      .filter((r) => {
        if (filterTab === 'ALL') return true;
        if (filterTab === 'OUTBOUND') {
          return (
            r.request_type === 'OUTBOUND' ||
            r.request_type === 'ASSET_LOAN' ||
            r.request_type === 'TRANSFER'
          );
        }
        return r.request_type === filterTab;
      });
  }, [requests, filterTab]);

  const recentResolved = useMemo(
    () =>
      requests
        .filter((r) => r.status !== 'PENDING_APPROVAL')
        .slice(0, 6),
    [requests]
  );

  const handleDecision = async (
    req: StockRequest,
    decision: 'APPROVE' | 'REJECT'
  ) => {
    try {
      const rawRevised = revisedQtyMap[req.id];
      const revisedNum =
        rawRevised !== undefined && rawRevised.trim() !== ''
          ? parseInt(rawRevised, 10)
          : req.qty_requested_base;

      await decidePendingRequest({
        requestId: req.id,
        decision,
        revisedQtyBase: revisedNum,
        rejectionReason: rejectReasonMap[req.id] || 'Stok diprioritaskan untuk unit lain',
        approver,
      });

      onToast(
        decision === 'APPROVE'
          ? `Dokumen ${req.request_code} disetujui (${revisedNum} unit).`
          : `Dokumen ${req.request_code} ditolak dan stok dikunci telah dilepas.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Gagal memproses keputusan.');
    }
  };

  const handleUpdatePin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSixDigitPin(newPin)) {
      onToast('PIN baru wajib terdiri dari tepat 6 digit angka.');
      return;
    }
    const salt = approver.offline_pin_salt || `salt-${approver.id}`;
    const hash = await deriveOfflinePinHash(newPin, salt);
    await localDB.users.update(approver.id, {
      offline_pin_hash: hash,
      offline_pin_salt: salt,
    });
    setNewPin('');
    setShowPinEditor(false);
    onToast('PIN otorisasi offline 6-digit berhasil diperbarui secara kriptografis.');
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      {/* Kartu Identitas & PIN Otorisasi Offline Pimpinan */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-slate-500">
              Pejabat penyetuju ({terms.approverTitle})
            </p>
            <h2 className="text-base font-semibold text-slate-900">
              {approver.full_name}
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              Kartu ID QR Supervisor:{' '}
              <span className="font-mono-tech font-medium text-slate-800">
                {approver.qr_supervisor_token ?? 'SUP-ACTIVE'}
              </span>{' '}
              • PIN default sandbox:{' '}
              <span className="font-mono-tech font-semibold text-amber-800">
                123456
              </span>
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowPinEditor((v) => !v)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
          >
            <KeyRound size={16} strokeWidth={1.5} />
            <span>Ubah PIN offline 6-digit</span>
          </button>
        </div>

        {showPinEditor && (
          <form
            method="POST"
            action="#update-pin"
            onSubmit={handleUpdatePin}
            className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100"
          >
            <label htmlFor="new-supervisor-pin" className="text-xs font-medium text-slate-700">
              PIN 6-digit baru:
            </label>
            <input
              id="new-supervisor-pin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={newPin}
              onChange={(e) =>
                setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
              placeholder="6 digit angka"
              className="w-40 rounded-lg border border-slate-300 px-3 font-mono-tech text-sm"
            />
            <button
              type="submit"
              className="min-h-[48px] rounded-lg bg-slate-900 px-4 text-xs font-medium text-white hover:bg-slate-800"
            >
              Simpan hash PIN
            </button>
          </form>
        )}
      </section>

      {/* Filter Kotak Masuk Persetujuan */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Kotak masuk persetujuan ({pendingRequests.length})
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                { id: 'ALL', label: 'Semua' },
                { id: 'OUTBOUND', label: terms.outboundActionTitle },
                { id: 'WRITE_OFF', label: 'Write-off rusak' },
                { id: 'OPNAME_ADJUSTMENT', label: 'Selisih opname' },
              ] as Array<{ id: FilterTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setFilterTab(tab.id)}
                className={`min-h-[40px] rounded-lg px-3 text-xs font-medium transition-colors ${
                  filterTab === tab.id
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {pendingRequests.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
            <ShieldCheck
              size={28}
              strokeWidth={1.5}
              className="mx-auto text-emerald-600 mb-2"
            />
            <p className="text-sm font-medium text-slate-900">
              Seluruh pengajuan telah ditinjau
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Tidak ada dokumen yang menunggu persetujuan pada kategori ini
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {pendingRequests.map((req) => {
              const item = items.find((i) => i.id === req.item_id);
              const totalOnHand = balances
                .filter(
                  (b) =>
                    b.warehouse_id === req.warehouse_id && b.item_id === req.item_id
                )
                .reduce((s, b) => s + b.qty_on_hand, 0);

              const badgeStyle =
                req.request_type === 'WRITE_OFF'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : req.request_type === 'OPNAME_ADJUSTMENT'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : 'border-blue-200 bg-blue-50 text-blue-800';

              const currentRevised =
                revisedQtyMap[req.id] ?? String(req.qty_requested_base);

              return (
                <article
                  key={req.id}
                  className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-md border px-2.5 py-0.5 text-xs font-medium ${badgeStyle}`}
                      >
                        {req.request_type.replace('_', ' ')}
                      </span>
                      <span className="font-mono-tech text-xs font-semibold text-slate-900">
                        {req.request_code}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500">
                      Diajukan oleh {req.requested_by_name}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-start justify-between gap-4 border-y border-slate-100 py-3">
                    <div>
                      <h3 className="text-base font-semibold text-slate-900">
                        {item?.name ?? 'Barang'}
                      </h3>
                      <p className="text-xs text-slate-600 mt-0.5">
                        Tujuan / unit: <strong>{req.party_name}</strong>
                      </p>
                      <p className="text-xs text-slate-600 mt-1">
                        Alasan: {req.reason || '—'}
                      </p>
                    </div>
                    <div className="text-right">
                      <span className="text-xs text-slate-500 block">
                        Stok fisik gudang
                      </span>
                      <strong className="font-mono-tech text-sm text-slate-900">
                        {totalOnHand} {item?.base_unit ?? 'Unit'}
                      </strong>
                      <span className="font-mono-tech text-xs text-amber-800 block mt-0.5">
                        Diajukan: {req.qty_requested_base} {item?.base_unit ?? 'Unit'}
                      </span>
                    </div>
                  </div>

                  {/* Lampiran Bukti Foto Kerusakan */}
                  {req.evidence_photo_data_url && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-700">
                          Lampiran bukti foto: {req.evidence_photo_name ?? 'BUKTI.WEBP'}
                        </span>
                        {req.evidence_size_kb && (
                          <span className="font-mono-tech text-emerald-700">
                            {req.evidence_size_kb} KB • Terverifikasi
                          </span>
                        )}
                      </div>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={req.evidence_photo_data_url}
                        alt={`Bukti foto ${req.request_code}`}
                        width={420}
                        height={220}
                        decoding="async"
                        className="h-36 w-full object-contain rounded-lg bg-slate-900"
                      />
                    </div>
                  )}

                  {/* Kontrol Revisi Jumlah, Alasan Tolak & Tombol Keputusan */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div>
                      <label
                        htmlFor={`rev-${req.id}`}
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Revisi jumlah disetujui ({item?.base_unit ?? 'Unit'})
                      </label>
                      <input
                        id={`rev-${req.id}`}
                        type="text"
                        inputMode="numeric"
                        value={currentRevised}
                        onChange={(e) =>
                          setRevisedQtyMap((prev) => ({
                            ...prev,
                            [req.id]: e.target.value.replace(/[^0-9-]/g, ''),
                          }))
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 font-mono-tech text-sm font-semibold"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`rej-${req.id}`}
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Catatan alasan (jika ditolak)
                      </label>
                      <input
                        id={`rej-${req.id}`}
                        type="text"
                        value={rejectReasonMap[req.id] ?? ''}
                        onChange={(e) =>
                          setRejectReasonMap((prev) => ({
                            ...prev,
                            [req.id]: e.target.value,
                          }))
                        }
                        placeholder="Contoh: Kurangi jumlah pengambilan"
                        className="w-full rounded-lg border border-slate-300 px-3 text-xs"
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap justify-end gap-2.5">
                    <button
                      type="button"
                      onClick={() => void handleDecision(req, 'REJECT')}
                      className="inline-flex min-h-[48px] items-center gap-1.5 rounded-lg border border-red-200 bg-white px-4 text-sm font-medium text-red-700 hover:bg-red-50"
                    >
                      <X size={18} strokeWidth={1.5} />
                      <span>Tolak</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => void handleDecision(req, 'APPROVE')}
                      className="inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-emerald-600 px-5 text-sm font-medium text-white hover:bg-emerald-700"
                    >
                      <Check size={18} strokeWidth={1.5} />
                      <span>Setujui dokumen</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Dokumen Terbaru yang Telah Diputuskan */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-semibold text-slate-600">
          Riwayat dokumen & arsip {terms.handoverShortCode} terbaru
        </h2>
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
          {recentResolved.map((req) => {
            const it = items.find((i) => i.id === req.item_id);
            return (
              <div
                key={req.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3.5 text-xs"
              >
                <div>
                  <span className="font-mono-tech font-semibold text-slate-900">
                    {req.request_code}
                  </span>{' '}
                  • <strong className="text-slate-800">{it?.name}</strong> (
                  <span className="font-mono-tech">
                    {req.qty_approved_base ?? req.qty_requested_base} {it?.base_unit}
                  </span>
                  )
                  <p className="text-slate-500 mt-0.5">
                    {req.party_name} • Status: <strong>{req.status}</strong>
                  </p>
                </div>
                {(req.status === 'APPROVED' || req.status === 'COMPLETED') && (
                  <button
                    type="button"
                    onClick={() => onOpenBastPreview(req)}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <FileText size={14} strokeWidth={1.5} />
                    <span>Lihat {terms.handoverShortCode}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
