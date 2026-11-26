'use client';

import React, { useId, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { deriveOfflinePinHash, isSixDigitPin } from '@/domain/pin-crypto';
import { getProfileTerminology } from '@/domain/profile-terminology';
import type { BusinessProfile, SubscriptionTier } from '@/domain/types';
import { generateUuidV7 } from '@/domain/uuidv7';
import { localDB } from '@/offline/db';
import { ModalDialog } from './ModalDialog';

interface OnboardingWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTenantCreated: (tenantId: string, msg: string) => void;
}

export function OnboardingWizardModal({
  isOpen,
  onClose,
  onTenantCreated,
}: OnboardingWizardModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [orgName, setOrgName] = useState('');
  const [profile, setProfile] = useState<BusinessProfile>('SCHOOL');
  const [tier, setTier] = useState<SubscriptionTier>('PRO');
  const [thresholdQty, setThresholdQty] = useState('5');
  const [approverName, setApproverName] = useState('');
  const [supervisorPin, setSupervisorPin] = useState('123456');
  const [seedMode, setSeedMode] = useState<'SANDBOX' | 'EMPTY'>('SANDBOX');
  const [errorMsg, setErrorMsg] = useState('');
  const baseId = useId();

  const terms = getProfileTerminology(profile);

  const handleFinish = async () => {
    if (orgName.trim().length < 3) {
      setErrorMsg('Nama organisasi minimal 3 karakter.');
      setStep(1);
      return;
    }
    if (!isSixDigitPin(supervisorPin)) {
      setErrorMsg('PIN otorisasi wajib 6 digit angka.');
      setStep(2);
      return;
    }

    const tenantId = `tenant-${generateUuidV7().slice(0, 8)}`;
    const warehouseId = `wh-${generateUuidV7().slice(0, 8)}`;
    const salt = `salt-${tenantId}`;
    const pinHash = await deriveOfflinePinHash(supervisorPin, salt);
    const nowIso = new Date().toISOString();
    const validUntil = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    await localDB.transaction(
      'rw',
      [
        localDB.tenants,
        localDB.users,
        localDB.warehouses,
        localDB.bins,
        localDB.items,
        localDB.balances,
      ],
      async () => {
        await localDB.tenants.put({
          id: tenantId,
          name: orgName.trim(),
          business_profile: profile,
          subscription_tier: tier,
          approval_threshold_qty: Math.max(0, parseInt(thresholdQty || '5', 10)),
          subscription_valid_until: validUntil,
          require_bast_signature: profile !== 'UMKM',
        });

        await localDB.users.bulkPut([
          {
            id: `usr-adm-${tenantId}`,
            tenant_id: tenantId,
            full_name: `Admin ${orgName.trim()}`,
            title: terms.adminTitle,
            role: 'ADMIN',
            is_active: true,
          },
          {
            id: `usr-app-${tenantId}`,
            tenant_id: tenantId,
            full_name: approverName.trim() || `Pimpinan ${orgName.trim()}`,
            title: terms.approverTitle,
            role: 'APPROVER',
            offline_pin_hash: pinHash,
            offline_pin_salt: salt,
            qr_supervisor_token: `SUP-${tenantId.toUpperCase()}`,
            is_active: true,
          },
          {
            id: `usr-opr-${tenantId}`,
            tenant_id: tenantId,
            full_name: 'Staf Gudang Utama',
            title: terms.operatorTitle,
            role: 'OPERATOR',
            is_active: true,
          },
        ]);

        await localDB.warehouses.put({
          id: warehouseId,
          tenant_id: tenantId,
          name: 'Gudang Utama',
          address: orgName.trim(),
          is_primary: true,
        });

        await localDB.bins.put({
          id: `bin-${tenantId}-01`,
          tenant_id: tenantId,
          warehouse_id: warehouseId,
          bin_code: 'ZONA-A/RAK-01',
          description: 'Rak Utama',
          is_frozen: false,
        });

        if (seedMode === 'SANDBOX') {
          const itemId = generateUuidV7();
          await localDB.items.put({
            id: itemId,
            tenant_id: tenantId,
            sku_code: 'SKU-AWAL-01',
            barcode: '8990001112223',
            name:
              profile === 'SCHOOL'
                ? 'Kertas HVS A4 80gr Operasional'
                : profile === 'UMKM'
                  ? 'Kopi Arabika House Blend 1Kg'
                  : 'Karton Air Mineral 600ml',
            category: 'Katalog Awal',
            default_bin_code: 'ZONA-A/RAK-01',
            base_unit: profile === 'SCHOOL' ? 'Rim' : 'Pcs',
            min_stock: 5,
            cost_price: 52000,
            is_fixed_asset: false,
            asset_condition: 'BAIK',
            uoms: [{ unit_name: 'Box', multiplier_to_base: 5 }],
            updated_at: nowIso,
          });

          await localDB.balances.put({
            id: generateUuidV7(),
            tenant_id: tenantId,
            warehouse_id: warehouseId,
            bin_code: 'ZONA-A/RAK-01',
            item_id: itemId,
            batch_number: 'AWAL-01',
            qty_on_hand: 25,
            qty_reserved: 0,
            updated_at: nowIso,
          });
        }
      }
    );

    setOrgName('');
    setStep(1);
    onTenantCreated(
      tenantId,
      `Workspace "${orgName.trim()}" (${terms.profileLabel}) siap dioperasikan.`
    );
    onClose();
  };

  return (
    <ModalDialog
      isOpen={isOpen}
      onClose={onClose}
      title="Setup Organisasi Baru (Zero-Friction Onboarding)"
      subtitle="Konfigurasi modul adaptif, ambang persetujuan, dan PIN offline dalam < 2 menit"
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-5">
        <nav aria-label="Progress onboarding">
          <ol className="grid grid-cols-3 gap-2 text-xs">
            {[
              { s: 1, label: '1. Profil organisasi' },
              { s: 2, label: '2. Aturan & PIN' },
              { s: 3, label: '3. Data awal' },
            ].map((item) => (
              <li
                key={item.s}
                aria-current={step === item.s ? 'step' : undefined}
                className={`rounded-lg border px-2.5 py-2 font-medium text-center ${
                  step === item.s
                    ? 'border-blue-600 bg-blue-50 text-blue-800'
                    : step > item.s
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}
              >
                {item.label}
              </li>
            ))}
          </ol>
        </nav>

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label
                htmlFor={`${baseId}-org`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Nama sekolah / toko / perusahaan <span aria-hidden="true">*</span>
              </label>
              <input
                id={`${baseId}-org`}
                name="org_name"
                type="text"
                value={orgName}
                onChange={(e) => {
                  setOrgName(e.target.value);
                  setErrorMsg('');
                }}
                placeholder="Contoh: SMK Negeri 4 Nusantara"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
              />
            </div>

            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-slate-700">
                Pilih profil segmen bisnis
              </legend>
              {(
                [
                  {
                    id: 'SCHOOL',
                    title: 'Sekolah / Yayasan / Instansi',
                    desc: 'Istilah Permintaan Unit, Peminjaman Aset Tetap, dan cetak BAST PDF',
                  },
                  {
                    id: 'UMKM',
                    title: 'UMKM / Retail / F&B',
                    desc: 'Pelacakan tanggal kedaluwarsa FEFO dan konversi satuan bertingkat',
                  },
                  {
                    id: 'DISTRIBUTOR',
                    title: 'Distributor / Gudang B2B',
                    desc: 'Multi-gudang cabang, transfer stok, dan Surat Jalan pengiriman',
                  },
                ] as Array<{ id: BusinessProfile; title: string; desc: string }>
              ).map((opt) => (
                <label
                  key={opt.id}
                  className={`block cursor-pointer rounded-xl border p-3 transition-colors ${
                    profile === opt.id
                      ? 'border-blue-600 bg-blue-50/70'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="business_profile"
                      value={opt.id}
                      checked={profile === opt.id}
                      onChange={() => setProfile(opt.id)}
                      className="accent-blue-600"
                    />
                    <span className="text-sm font-medium text-slate-900">
                      {opt.title}
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 mt-1 pl-6">{opt.desc}</p>
                </label>
              ))}
            </fieldset>

            <div>
              <label
                htmlFor={`${baseId}-tier`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Paket langganan SaaS
              </label>
              <select
                id={`${baseId}-tier`}
                value={tier}
                onChange={(e) => setTier(e.target.value as SubscriptionTier)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
              >
                <option value="FREE">Starter (Gratis — Maks 100 SKU, 1 Gudang)</option>
                <option value="PRO">Pro (UMKM & Sekolah — 2.500 SKU, PIN Offline & BAST)</option>
                <option value="ENTERPRISE">Enterprise (Distributor & Yayasan — Multi-Gudang Unlimited)</option>
              </select>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label
                htmlFor={`${baseId}-approver`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Nama pejabat penyetuju ({terms.approverTitle})
              </label>
              <input
                id={`${baseId}-approver`}
                type="text"
                value={approverName}
                onChange={(e) => setApproverName(e.target.value)}
                placeholder="Contoh: Dra. Sri Wahyuni, M.Pd"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor={`${baseId}-thresh`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                Batas pengeluaran rutin otomatis tanpa approval (satuan dasar)
              </label>
              <input
                id={`${baseId}-thresh`}
                type="text"
                inputMode="numeric"
                value={thresholdQty}
                onChange={(e) =>
                  setThresholdQty(e.target.value.replace(/\D/g, ''))
                }
                className="w-full rounded-lg border border-slate-300 bg-white px-3 font-mono-tech text-sm"
              />
            </div>

            <div>
              <label
                htmlFor={`${baseId}-pin`}
                className="block text-xs font-medium text-slate-700 mb-1"
              >
                PIN otorisasi offline 6-digit (disimpan sebagai hash PBKDF2)
              </label>
              <input
                id={`${baseId}-pin`}
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={supervisorPin}
                onChange={(e) =>
                  setSupervisorPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="w-full rounded-lg border border-slate-300 bg-white px-3 font-mono-tech text-base tracking-widest"
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <fieldset className="space-y-2.5">
            <legend className="text-xs font-medium text-slate-700">
              Pilih sumber katalog awal
            </legend>
            <label
              className={`block cursor-pointer rounded-xl border p-3.5 ${
                seedMode === 'SANDBOX'
                  ? 'border-blue-600 bg-blue-50/70'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="seed_mode"
                  checked={seedMode === 'SANDBOX'}
                  onChange={() => setSeedMode('SANDBOX')}
                  className="accent-blue-600"
                />
                <span className="text-sm font-medium text-slate-900">
                  Sertakan barang contoh siap simulasi (Sandbox)
                </span>
              </div>
              <p className="text-xs text-slate-600 mt-1 pl-6">
                Langsung mencoba alur scan QR, konversi satuan, dan persetujuan dalam 10 detik
              </p>
            </label>

            <label
              className={`block cursor-pointer rounded-xl border p-3.5 ${
                seedMode === 'EMPTY'
                  ? 'border-blue-600 bg-blue-50/70'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="seed_mode"
                  checked={seedMode === 'EMPTY'}
                  onChange={() => setSeedMode('EMPTY')}
                  className="accent-blue-600"
                />
                <span className="text-sm font-medium text-slate-900">
                  Mulai kosong (impor dari template CSV nanti)
                </span>
              </div>
            </label>
          </fieldset>
        )}

        {errorMsg && (
          <p role="alert" className="text-xs font-medium text-red-700">
            {errorMsg}
          </p>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-slate-200">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft size={16} strokeWidth={1.5} />
              <span>Sebelumnya</span>
            </button>
          ) : (
            <span />
          )}

          {step < 3 ? (
            <button
              type="button"
              onClick={() => {
                if (step === 1 && orgName.trim().length < 3) {
                  setErrorMsg('Nama organisasi minimal 3 karakter.');
                  return;
                }
                setErrorMsg('');
                setStep((s) => (s === 1 ? 2 : 3));
              }}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700"
            >
              <span>Lanjut</span>
              <ArrowRight size={16} strokeWidth={1.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleFinish()}
              className="inline-flex min-h-[48px] items-center gap-2 rounded-lg bg-emerald-600 px-5 text-sm font-medium text-white hover:bg-emerald-700"
            >
              <CheckCircle2 size={18} strokeWidth={1.5} />
              <span>Aktifkan workspace</span>
            </button>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
