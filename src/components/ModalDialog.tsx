'use client';

import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export interface ModalDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  maxWidthClass?: string;
  allowLightDismiss?: boolean;
  children: React.ReactNode;
}

/**
 * Komponen Modal berbasis elemen HTML5 <dialog> murni dengan `showModal()`.
 * Mematuhi standar modern-web-guidance: tanpa `role="dialog"` redundan,
 * tanpa penguncian `overflow: hidden` pada `body`, dan mereset `returnValue` saat tutup.
 */
export function ModalDialog({
  isOpen,
  onClose,
  title,
  subtitle,
  maxWidthClass = 'max-w-xl',
  allowLightDismiss = true,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  const pressedOutsideRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen && !dialog.open) {
      dialog.showModal();
    } else if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = '';
      onClose();
    };

    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
    };
  }, [onClose]);

  const isOutsideDialogRect = (e: React.PointerEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    );
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      {...(allowLightDismiss ? ({ closedby: 'any' } as Record<string, string>) : {})}
      className={maxWidthClass}
      onPointerDown={(e) => {
        if (!allowLightDismiss) return;
        pressedOutsideRef.current = isOutsideDialogRect(e);
      }}
      onPointerUp={(e) => {
        if (!allowLightDismiss) return;
        if (pressedOutsideRef.current && isOutsideDialogRect(e)) {
          dialogRef.current?.close();
        }
        pressedOutsideRef.current = false;
      }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 bg-slate-900 text-white rounded-t-[15px]">
        <div>
          <h1 id={titleId} className="text-base font-semibold leading-snug">
            {title}
          </h1>
          {subtitle && (
            <p className="text-xs text-slate-300 mt-0.5">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Tutup dialog"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <X size={18} strokeWidth={1.5} />
        </button>
      </div>
      <div className="overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}
