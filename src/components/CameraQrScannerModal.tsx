'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { Camera, Flashlight, QrCode, Search } from 'lucide-react';
import type { ItemRecord, OperatorItemView } from '@/domain/types';
import { ModalDialog } from './ModalDialog';

interface CameraQrScannerModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ReadonlyArray<ItemRecord | OperatorItemView>;
  onDetectedItem: (item: ItemRecord | OperatorItemView) => void;
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

export function CameraQrScannerModal({
  isOpen,
  onClose,
  items,
  onDetectedItem,
}: CameraQrScannerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraHint, setCameraHint] = useState<string>(
    'Arahkan kamera ke stiker QR/Barcode pada barang atau rak'
  );
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [manualQuery, setManualQuery] = useState('');
  const searchInputId = useId();

  useEffect(() => {
    if (!isOpen) {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setCameraActive(false);
      setTorchOn(false);
      return;
    }

    let cancelled = false;
    let rafId: number | null = null;

    async function startCamera() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setCameraHint('Kamera tidak tersedia di perangkat ini — gunakan tombol simulasi scan atau pencarian cepat di bawah');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setCameraActive(true);

        const track = stream.getVideoTracks()[0];
        if (track && typeof track.getCapabilities === 'function') {
          const caps = track.getCapabilities() as MediaTrackCapabilities & {
            torch?: boolean;
          };
          setTorchSupported(Boolean(caps.torch));
        }

        const DetectorCtor = (
          window as unknown as {
            BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
          }
        ).BarcodeDetector;

        if (DetectorCtor) {
          const detector = new DetectorCtor({
            formats: ['qr_code', 'ean_13', 'code_128', 'upc_a'],
          });

          const scanFrame = async () => {
            if (cancelled || !videoRef.current) return;
            try {
              const codes = await detector.detect(videoRef.current);
              if (codes.length > 0) {
                const raw = codes[0].rawValue.trim().toUpperCase();
                const found = items.find(
                  (it) =>
                    it.barcode.toUpperCase() === raw ||
                    it.sku_code.toUpperCase() === raw
                );
                if (found) {
                  onDetectedItem(found);
                  onClose();
                  return;
                }
              }
            } catch {
              // Abaikan frame belum siap
            }
            rafId = requestAnimationFrame(scanFrame);
          };
          rafId = requestAnimationFrame(scanFrame);
        }
      } catch {
        setCameraHint(
          'Izin kamera belum diberikan — pilih barang melalui tombol simulasi stiker QR atau pencarian kode di bawah'
        );
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [isOpen, items, onDetectedItem, onClose]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const nextTorch = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: nextTorch } as MediaTrackConstraintSet],
      });
      setTorchOn(nextTorch);
    } catch {
      setCameraHint('Lampu senter tidak didukung oleh modul kamera peramban ini');
    }
  };

  const filteredItems = items.filter((item) => {
    const q = manualQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      item.sku_code.toLowerCase().includes(q) ||
      item.barcode.toLowerCase().includes(q) ||
      item.name.toLowerCase().includes(q) ||
      item.default_bin_code.toLowerCase().includes(q)
    );
  });

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Pemindai QR & Barcode Gudang"
      subtitle="Deteksi cepat < 800ms dengan dukungan lampu lorong gelap"
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-4">
        {/* 1:1 Viewfinder */}
        <div className="relative mx-auto aspect-square max-w-[260px] overflow-hidden rounded-xl bg-slate-950 border border-slate-800">
          <video
            ref={videoRef}
            playsInline
            muted
            className="h-full w-full object-cover"
          />
          {!cameraActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center text-slate-300">
              <Camera size={28} strokeWidth={1.5} className="mb-2 text-slate-400" />
              <p className="text-xs leading-relaxed">{cameraHint}</p>
            </div>
          )}

          {/* Bingkai sudut hijau (#16A34A / #22C55E) */}
          <div className="pointer-events-none absolute inset-4">
            <div className="absolute left-0 top-0 h-6 w-6 border-l-4 border-t-4 border-emerald-500 rounded-tl-md" />
            <div className="absolute right-0 top-0 h-6 w-6 border-r-4 border-t-4 border-emerald-500 rounded-tr-md" />
            <div className="absolute bottom-0 left-0 h-6 w-6 border-b-4 border-l-4 border-emerald-500 rounded-bl-md" />
            <div className="absolute bottom-0 right-0 h-6 w-6 border-b-4 border-r-4 border-emerald-500 rounded-br-md" />
            <div className="scanner-laser-line h-0.5 w-full bg-emerald-400/90" />
          </div>

          {/* Tombol Lampu Senter (Torch) */}
          <button
            type="button"
            onClick={toggleTorch}
            disabled={!torchSupported}
            aria-pressed={torchOn}
            className={`absolute bottom-3 right-3 inline-flex min-h-[44px] items-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors ${
              torchOn
                ? 'bg-amber-600 text-white'
                : 'bg-slate-900/85 text-slate-200 border border-slate-700 hover:bg-slate-800 disabled:opacity-50'
            }`}
          >
            <Flashlight size={16} strokeWidth={1.5} />
            {torchOn ? 'Senter menyala' : 'Lampu senter'}
          </button>
        </div>

        {/* Simulasi Tap Scan Instan untuk QA di PC/Laptop tanpa stiker fisik */}
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium text-slate-600 mb-2">
            Simulasi pindai stiker barang (klik untuk uji alur scan instan)
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {items.slice(0, 4).map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => {
                  onDetectedItem(it);
                  onClose();
                }}
                className="flex min-h-[48px] items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-blue-600 hover:bg-blue-50/40"
              >
                <QrCode size={18} strokeWidth={1.5} className="shrink-0 text-blue-600" />
                <div className="min-w-0">
                  <div className="font-mono-tech text-xs font-medium text-slate-900 truncate">
                    {it.sku_code}
                  </div>
                  <div className="text-xs text-slate-600 truncate">{it.name}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Pencarian Manual Jika Stiker Rusak */}
        <search>
          <form
            action="#scan-manual"
            method="GET"
            onSubmit={(e) => {
              e.preventDefault();
              if (filteredItems.length > 0) {
                onDetectedItem(filteredItems[0]);
                onClose();
              }
            }}
            className="space-y-2"
          >
            <label
              htmlFor={searchInputId}
              className="block text-xs font-medium text-slate-700"
            >
              Stiker terkelupas? Cari manual kode SKU, barcode, atau rak
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search
                  size={18}
                  strokeWidth={1.5}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                />
                <input
                  id={searchInputId}
                  name="q"
                  type="search"
                  value={manualQuery}
                  onChange={(e) => setManualQuery(e.target.value)}
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="search"
                  placeholder="Contoh: ATK-F4-75 atau ZONA-A"
                  className="w-full rounded-lg border border-slate-300 bg-white pl-10 pr-3 text-sm text-slate-900"
                />
              </div>
              <button
                type="submit"
                className="min-h-[48px] rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700"
              >
                Pilih
              </button>
            </div>
          </form>
        </search>
      </div>
    </ModalDialog>
  );
}
