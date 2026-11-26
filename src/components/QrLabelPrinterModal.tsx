'use client';

import React, { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import QRCode from 'qrcode';
import type { ItemRecord, OperatorItemView } from '@/domain/types';
import { ModalDialog } from './ModalDialog';

type PaperFormat = 'THERMAL_58' | 'THERMAL_80' | 'A4_GRID';

interface QrLabelPrinterModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ReadonlyArray<ItemRecord | OperatorItemView>;
  tenantName: string;
}

export function QrLabelPrinterModal({
  isOpen,
  onClose,
  items,
  tenantName,
}: QrLabelPrinterModalProps) {
  const [paperFormat, setPaperFormat] = useState<PaperFormat>('A4_GRID');
  const [qrSvgMap, setQrSvgMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isOpen) return;
    let active = true;

    async function renderQrs() {
      const entries = await Promise.all(
        items.map(async (it) => {
          const payload = it.barcode || it.sku_code;
          const svg = await QRCode.toString(payload, {
            type: 'svg',
            margin: 1,
            width: 112,
            color: { dark: '#0F172A', light: '#FFFFFF' },
          });
          return [it.id, `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`] as const;
        })
      );
      if (active) {
        setQrSvgMap(Object.fromEntries(entries));
      }
    }

    void renderQrs();
    return () => {
      active = false;
    };
  }, [isOpen, items]);

  const gridClass =
    paperFormat === 'THERMAL_58'
      ? 'max-w-[220px] mx-auto grid-cols-1'
      : paperFormat === 'THERMAL_80'
        ? 'max-w-[300px] mx-auto grid-cols-1'
        : 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3';

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Generator Stiker Label QR Barang"
      subtitle="Siap cetak untuk printer thermal Bluetooth 58mm/80mm maupun kertas stiker A4"
      maxWidthClass="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <fieldset className="flex flex-wrap gap-2">
            <legend className="visually-hidden">Ukuran kertas cetak label</legend>
            {(
              [
                { id: 'A4_GRID', label: 'Kertas stiker A4 (Grid)' },
                { id: 'THERMAL_80', label: 'Thermal 80mm' },
                { id: 'THERMAL_58', label: 'Thermal 58mm' },
              ] as Array<{ id: PaperFormat; label: string }>
            ).map((opt) => (
              <label
                key={opt.id}
                className={`inline-flex min-h-[44px] cursor-pointer items-center rounded-lg border px-3 text-xs font-medium transition-colors ${
                  paperFormat === opt.id
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="paper_format"
                  value={opt.id}
                  checked={paperFormat === opt.id}
                  onChange={() => setPaperFormat(opt.id)}
                  className="visually-hidden"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </fieldset>

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Printer size={16} strokeWidth={1.5} />
            <span>Cetak label sekarang</span>
          </button>
        </div>

        <div
          id="printable-region"
          className={`grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 ${gridClass}`}
        >
          {items.map((it) => (
            <div
              key={it.id}
              className="flex items-center gap-3 rounded-lg border border-slate-300 bg-white p-2.5"
            >
              {qrSvgMap[it.id] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrSvgMap[it.id]}
                  alt={`QR ${it.sku_code}`}
                  width={76}
                  height={76}
                  decoding="async"
                  className="h-[76px] w-[76px] shrink-0"
                />
              ) : (
                <div className="h-[76px] w-[76px] shrink-0 rounded bg-slate-100" />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-medium text-slate-500 truncate">
                  {tenantName}
                </p>
                <p className="font-mono-tech text-xs font-semibold text-slate-900 truncate">
                  {it.sku_code}
                </p>
                <p className="text-xs font-medium text-slate-800 line-clamp-2 leading-tight mt-0.5">
                  {it.name}
                </p>
                <p className="font-mono-tech text-[11px] text-slate-600 mt-1">
                  {it.default_bin_code}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ModalDialog>
  );
}
