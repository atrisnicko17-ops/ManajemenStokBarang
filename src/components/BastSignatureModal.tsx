'use client';

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Eraser, Printer } from 'lucide-react';
import { getProfileTerminology } from '@/domain/profile-terminology';
import type {
  ItemRecord,
  OperatorItemView,
  StockRequest,
  TenantConfig,
  UserAccount,
  Warehouse,
} from '@/domain/types';
import { fulfillApprovedRequestWithSignature } from '@/offline/sync-worker';
import { ModalDialog } from './ModalDialog';

interface BastSignatureModalProps {
  isOpen: boolean;
  onClose: () => void;
  request: StockRequest | null;
  item: ItemRecord | OperatorItemView | undefined;
  tenant: TenantConfig;
  warehouse: Warehouse;
  operator: UserAccount;
  onCompleted: (msg: string) => void;
}

export function BastSignatureModal({
  isOpen,
  onClose,
  request,
  item,
  tenant,
  warehouse,
  operator,
  onCompleted,
}: BastSignatureModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [savedSignatureUrl, setSavedSignatureUrl] = useState<string | undefined>();

  const terms = getProfileTerminology(tenant.business_profile);

  useEffect(() => {
    if (!isOpen) {
      setHasSignature(false);
      setErrorMsg('');
      setSavedSignatureUrl(undefined);
      return;
    }
    if (request?.signature_data_url) {
      setSavedSignatureUrl(request.signature_data_url);
      setHasSignature(true);
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0F172A';
  }, [isOpen, request]);

  if (!request || !item) return null;

  const isAlreadyCompleted = request.status === 'COMPLETED';
  const finalQty = request.qty_approved_base ?? request.qty_requested_base;

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isAlreadyCompleted) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const pt = getCanvasPoint(e);
    drawingRef.current = true;
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    setHasSignature(true);
    setErrorMsg('');
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || isAlreadyCompleted) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const pt = getCanvasPoint(e);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
  };

  const handlePointerUp = () => {
    drawingRef.current = false;
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleConfirmHandover = async () => {
    if (!hasSignature || !canvasRef.current) {
      setErrorMsg('Penerima wajib membubuhkan tanda tangan pada kotak kanvas.');
      return;
    }

    try {
      const dataUrl = canvasRef.current.toDataURL('image/png');
      await fulfillApprovedRequestWithSignature({
        requestId: request.id,
        signatureDataUrl: dataUrl,
        operator,
      });
      setSavedSignatureUrl(dataUrl);
      onCompleted(
        `${terms.handoverShortCode} ${request.request_code} sah ditandatangani. Stok dikunci (${finalQty} ${item.base_unit}) resmi dipotong.`
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Gagal menyimpan tanda tangan.'
      );
    }
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title={terms.handoverDocumentName}
      subtitle={`Nomor dokumen: ${request.request_code} • ${warehouse.name}`}
      maxWidthClass="max-w-xl"
    >
      <div className="space-y-4">
        <div
          id="printable-region"
          className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"
        >
          {/* Kop Surat */}
          <div className="border-b border-slate-200 pb-3 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-slate-500">
                {terms.handoverDocumentName}
              </p>
              <h2 className="text-base font-semibold text-slate-900">
                {tenant.name}
              </h2>
              <p className="text-xs text-slate-600">{warehouse.name}</p>
            </div>
            <div className="text-right">
              <span className="inline-block rounded-md bg-emerald-50 border border-emerald-200 px-2.5 py-1 font-mono-tech text-xs font-semibold text-emerald-800">
                {request.request_code}
              </span>
              <p className="font-mono-tech text-[11px] text-slate-500 mt-1">
                {new Date(request.created_at).toLocaleDateString('id-ID', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                })}
              </p>
            </div>
          </div>

          {/* Detail Barang */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="rounded-lg bg-slate-50 p-3 border border-slate-200/80">
              <span className="text-slate-500 block">Barang diserahkan</span>
              <strong className="text-sm text-slate-900 block mt-0.5">
                {item.name}
              </strong>
              <span className="font-mono-tech text-slate-600">
                SKU: {item.sku_code} • Rak: {item.default_bin_code}
              </span>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 border border-slate-200/80">
              <span className="text-slate-500 block">Jumlah disetujui</span>
              <strong className="font-mono-tech text-base text-slate-900 block mt-0.5">
                {finalQty} {item.base_unit}
              </strong>
              <span className="text-slate-600">
                Penerima: {request.party_name}
              </span>
            </div>
          </div>

          {request.due_return_date && (
            <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              Peminjaman aset tetap — wajib dikembalikan paling lambat:{' '}
              <strong className="font-mono-tech">{request.due_return_date}</strong>
            </p>
          )}

          {/* Area Tanda Tangan */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-700">
                Tanda tangan digital penerima ({request.party_name})
              </span>
              {!isAlreadyCompleted && !savedSignatureUrl && (
                <button
                  type="button"
                  onClick={clearSignature}
                  className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-slate-200 px-2.5 text-xs text-slate-600 hover:bg-slate-50"
                >
                  <Eraser size={14} strokeWidth={1.5} />
                  <span>Ulangi TTD</span>
                </button>
              )}
            </div>

            {savedSignatureUrl ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50/40 p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={savedSignatureUrl}
                  alt="Tanda tangan penerima sah"
                  width={400}
                  height={160}
                  decoding="async"
                  className="h-28 object-contain"
                />
                <span className="text-[11px] font-medium text-emerald-800 mt-1">
                  Tanda tangan digital sah • Diverifikasi oleh {operator.full_name}
                </span>
              </div>
            ) : (
              <canvas
                ref={canvasRef}
                width={400}
                height={180}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="w-full h-40 touch-none rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 cursor-crosshair"
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-200 text-xs text-slate-600">
            <div>
              <span className="block text-slate-400">Disetujui oleh</span>
              <strong className="text-slate-800">
                {request.approved_by_name ?? 'Pimpinan'}
              </strong>
            </div>
            <div className="text-right">
              <span className="block text-slate-400">Petugas penyerah</span>
              <strong className="text-slate-800">{operator.full_name}</strong>
            </div>
          </div>
        </div>

        {errorMsg && (
          <p role="alert" className="text-xs font-medium text-red-700">
            {errorMsg}
          </p>
        )}

        <div className="flex flex-wrap gap-2 justify-end">
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50"
          >
            <Printer size={18} strokeWidth={1.5} />
            <span>Cetak / simpan PDF ({terms.handoverShortCode})</span>
          </button>

          {!isAlreadyCompleted && !savedSignatureUrl && (
            <button
              type="button"
              onClick={() => void handleConfirmHandover()}
              className="inline-flex min-h-[48px] items-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              <CheckCircle2 size={18} strokeWidth={1.5} />
              <span>Konfirmasi serah terima & potong stok</span>
            </button>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
