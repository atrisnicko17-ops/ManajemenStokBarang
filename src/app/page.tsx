'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CloudOff,
  RefreshCw,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  getProfileTerminology,
  getRoleDisplayLabel,
} from '@/domain/profile-terminology';
import { evaluateSubscriptionLifecycle } from '@/domain/subscription-grace';
import type {
  ItemRecord,
  NetworkMode,
  OperatorItemView,
  RequestType,
  StockRequest,
  UserRole,
} from '@/domain/types';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import {
  ensurePersistentBrowserStorage,
  initializeOrSeedLocalDB,
  localDB,
  stripCostPriceForNonAdmin,
} from '@/offline/db';
import { runOutboxSync } from '@/offline/sync-worker';
import { AdminControlTowerView } from '@/components/AdminControlTowerView';
import { ApproverInboxView } from '@/components/ApproverInboxView';
import { BastSignatureModal } from '@/components/BastSignatureModal';
import { BlindOpnameModal } from '@/components/BlindOpnameModal';
import { BulkImportModal } from '@/components/BulkImportModal';
import { CameraQrScannerModal } from '@/components/CameraQrScannerModal';
import { OnboardingWizardModal } from '@/components/OnboardingWizardModal';
import { OperatorFieldView } from '@/components/OperatorFieldView';
import { QrLabelPrinterModal } from '@/components/QrLabelPrinterModal';
import { TransactionSheetModal } from '@/components/TransactionSheetModal';

export default function GudangKuHomePage() {
  const [ready, setReady] = useState(false);
  const [activeTenantId, setActiveTenantId] = useState('tenant-school-01');
  const [activeWarehouseId, setActiveWarehouseId] = useState('');
  const [activeRole, setActiveRole] = useState<UserRole>('OPERATOR');
  const [networkMode, setNetworkMode] = useState<NetworkMode>('ONLINE');
  const [isSyncing, setIsSyncing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // State Modals
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [txModalState, setTxModalState] = useState<{
    open: boolean;
    mode: RequestType;
    itemId?: string;
  }>({ open: false, mode: 'OUTBOUND' });
  const [isOpnameOpen, setIsOpnameOpen] = useState(false);
  const [bastTargetRequest, setBastTargetRequest] =
    useState<StockRequest | null>(null);
  const [isQrPrinterOpen, setIsQrPrinterOpen] = useState(false);
  const [isBulkImportOpen, setIsBulkImportOpen] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMessage(msg);
  };

  useEffect(() => {
    if (!toastMessage) return;
    const t = setTimeout(() => setToastMessage(null), 5000);
    return () => clearTimeout(t);
  }, [toastMessage]);

  useEffect(() => {
    let mounted = true;
    async function bootstrap() {
      await initializeOrSeedLocalDB(localDB, false);
      await ensurePersistentBrowserStorage();

      if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      }

      if (!navigator.onLine) {
        setNetworkMode('OFFLINE');
      }

      if (mounted) setReady(true);
    }
    void bootstrap();

    const onOnline = () => setNetworkMode('ONLINE');
    const onOffline = () => setNetworkMode('OFFLINE');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    // Real-time Supabase Auth session expiry watcher (static-supabase-owasp-hardening)
    const supabase = getSupabaseBrowserClient();
    const authSub = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        setActiveRole('OPERATOR');
      }
    });

    return () => {
      mounted = false;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      authSub?.data.subscription.unsubscribe();
    };
  }, []);

  const allTenants = useLiveQuery(() => localDB.tenants.toArray(), [], []);
  const activeTenant = useMemo(
    () => allTenants.find((t) => t.id === activeTenantId) ?? allTenants[0],
    [allTenants, activeTenantId]
  );

  const tenantWarehouses = useLiveQuery(
    () =>
      activeTenant
        ? localDB.warehouses.where('tenant_id').equals(activeTenant.id).toArray()
        : [],
    [activeTenant?.id],
    []
  );

  const activeWarehouse = useMemo(
    () =>
      tenantWarehouses.find((w) => w.id === activeWarehouseId) ??
      tenantWarehouses.find((w) => w.is_primary) ??
      tenantWarehouses[0],
    [tenantWarehouses, activeWarehouseId]
  );

  const tenantUsers = useLiveQuery(
    () =>
      activeTenant
        ? localDB.users.where('tenant_id').equals(activeTenant.id).toArray()
        : [],
    [activeTenant?.id],
    []
  );

  const tenantBins = useLiveQuery(
    () =>
      activeTenant
        ? localDB.bins.where('tenant_id').equals(activeTenant.id).toArray()
        : [],
    [activeTenant?.id],
    []
  );

  const rawTenantItems = useLiveQuery(
    () =>
      activeTenant
        ? localDB.items.where('tenant_id').equals(activeTenant.id).toArray()
        : [],
    [activeTenant?.id],
    []
  );

  const tenantBalances = useLiveQuery(
    () =>
      activeTenant
        ? localDB.balances.where('tenant_id').equals(activeTenant.id).toArray()
        : [],
    [activeTenant?.id],
    []
  );

  const tenantRequests = useLiveQuery(
    () =>
      activeTenant
        ? localDB.requests
            .where('tenant_id')
            .equals(activeTenant.id)
            .reverse()
            .sortBy('created_at')
        : [],
    [activeTenant?.id],
    []
  );

  const tenantLedger = useLiveQuery(
    () =>
      activeTenant
        ? localDB.ledger
            .where('tenant_id')
            .equals(activeTenant.id)
            .reverse()
            .sortBy('created_at')
        : [],
    [activeTenant?.id],
    []
  );

  const tenantAuditLogs = useLiveQuery(
    () =>
      activeTenant
        ? localDB.auditLogs
            .where('tenant_id')
            .equals(activeTenant.id)
            .reverse()
            .sortBy('created_at')
        : [],
    [activeTenant?.id],
    []
  );

  const outboxEvents = useLiveQuery(
    () =>
      activeTenant
        ? localDB.outbox.where('tenant_id').equals(activeTenant.id).toArray()
        : [],
    [activeTenant?.id],
    []
  );

  // Otomatis sinkronisasi antrean Outbox saat beralih kembali ke ONLINE
  useEffect(() => {
    if (!activeTenant || networkMode !== 'ONLINE' || outboxEvents.length === 0) {
      return;
    }
    let cancelled = false;
    async function triggerAutoSync() {
      setIsSyncing(true);
      await new Promise((r) => setTimeout(r, 850));
      try {
        const summary = await runOutboxSync(activeTenant!.id, 'ONLINE', localDB);
        if (!cancelled && summary.processedCount > 0) {
          showToast(
            `Sinkronisasi selesai: ${summary.processedCount} mutasi offline berhasil masuk ke buku besar pusat${
              summary.overdraftDetectedCount > 0
                ? ` (${summary.overdraftDetectedCount} ditandai FLAGGED_OVERDRAFT)`
                : ''
            }.`
          );
        }
      } catch {
        // Tetap di outbox
      } finally {
        if (!cancelled) setIsSyncing(false);
      }
    }
    void triggerAutoSync();
    return () => {
      cancelled = true;
    };
  }, [networkMode, activeTenant, outboxEvents.length]);

  const roleSafeItems = useMemo(
    () => stripCostPriceForNonAdmin(rawTenantItems, activeRole),
    [rawTenantItems, activeRole]
  );

  const currentUser = useMemo(() => {
    return (
      tenantUsers.find((u) => u.role === activeRole) ??
      tenantUsers[0] ?? {
        id: 'fallback-user',
        tenant_id: activeTenant?.id ?? '',
        full_name: 'Pengguna Gudang',
        title: 'Staf',
        role: activeRole,
        is_active: true,
      }
    );
  }, [tenantUsers, activeRole, activeTenant?.id]);

  const approverUser = useMemo(
    () => tenantUsers.find((u) => u.role === 'APPROVER'),
    [tenantUsers]
  );

  if (!ready || !activeTenant || !activeWarehouse) {
    return (
      <div className="min-h-dvh bg-slate-50 flex items-center justify-center p-6">
        <div className="text-center space-y-2">
          <Boxes size={28} strokeWidth={1.5} className="mx-auto text-blue-600" />
          <p className="text-sm font-medium text-slate-700">
            Memuat basis data lokal GudangKu WMS...
          </p>
        </div>
      </div>
    );
  }

  const terms = getProfileTerminology(activeTenant.business_profile);
  const subLifecycle = evaluateSubscriptionLifecycle(
    activeTenant.subscription_valid_until,
    outboxEvents.length
  );

  const syncBarStyle = isSyncing
    ? 'bg-amber-600 text-white'
    : networkMode === 'ONLINE'
      ? 'bg-emerald-700 text-white'
      : 'bg-red-700 text-white';

  return (
    <div className="min-h-dvh flex flex-col bg-slate-50">
      {/* Header Kontras Tinggi (#0F172A) */}
      <header className="sticky top-0 z-30 bg-slate-900 text-white shadow-sm">
        <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white">
              <Boxes size={20} strokeWidth={1.5} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold tracking-tight">
                  GudangKu WMS
                </span>
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-300">
                  {terms.profileLabel}
                </span>
              </div>
              <p className="text-xs text-slate-300">
                {activeTenant.name} • {activeWarehouse.name}
              </p>
            </div>
          </div>

          {/* Kontrol Simulasi Workspace, Gudang, Peran, & Jaringan */}
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="workspace-select" className="visually-hidden">
              Pilih organisasi tenant
            </label>
            <select
              id="workspace-select"
              value={activeTenant.id}
              onChange={(e) => {
                setActiveTenantId(e.target.value);
                setActiveWarehouseId('');
              }}
              className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-xs text-white"
            >
              {allTenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.business_profile})
                </option>
              ))}
            </select>

            {tenantWarehouses.length > 1 && (
              <>
                <label htmlFor="warehouse-select" className="visually-hidden">
                  Pilih cabang gudang
                </label>
                <select
                  id="warehouse-select"
                  value={activeWarehouse.id}
                  onChange={(e) => setActiveWarehouseId(e.target.value)}
                  className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-xs text-white"
                >
                  {tenantWarehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </>
            )}

            <label htmlFor="role-select" className="visually-hidden">
              Pilih peran pengguna
            </label>
            <select
              id="role-select"
              value={activeRole}
              onChange={(e) => setActiveRole(e.target.value as UserRole)}
              className="min-h-[40px] rounded-lg border border-blue-500/60 bg-slate-800 px-2.5 text-xs font-medium text-white"
            >
              <option value="OPERATOR">
                Peran: {getRoleDisplayLabel('OPERATOR', activeTenant.business_profile)}
              </option>
              <option value="APPROVER">
                Peran: {getRoleDisplayLabel('APPROVER', activeTenant.business_profile)}
              </option>
              <option value="ADMIN">
                Peran: {getRoleDisplayLabel('ADMIN', activeTenant.business_profile)}
              </option>
              {tenantUsers.some((u) => u.role === 'REQUESTER') && (
                <option value="REQUESTER">
                  Peran: {getRoleDisplayLabel('REQUESTER', activeTenant.business_profile)}
                </option>
              )}
            </select>

            <label htmlFor="network-select" className="visually-hidden">
              Kondisi jaringan gudang
            </label>
            <select
              id="network-select"
              value={networkMode}
              onChange={(e) => setNetworkMode(e.target.value as NetworkMode)}
              className="min-h-[40px] rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-xs text-slate-200"
            >
              <option value="ONLINE">Sinyal: Online</option>
              <option value="LIE_FI">Sinyal: Lie-Fi (Router tanpa internet)</option>
              <option value="OFFLINE">Sinyal: Offline (Dead-zone)</option>
            </select>
          </div>
        </div>

        {/* Sticky Network Status Bar (Zero-Ambiguity Sync State >= 7:1 contrast, min-h-[42px] Zero CLS) */}
        <div className={`min-h-[42px] px-4 py-2 transition-colors ${syncBarStyle}`}>
          <div className="mx-auto max-w-7xl flex flex-wrap items-center justify-between gap-2 text-xs font-medium">
            <div className="flex items-center gap-2">
              {isSyncing ? (
                <>
                  <RefreshCw size={15} strokeWidth={1.5} className="animate-spin" />
                  <span>
                    Syncing... Mengirim antrean mutasi UUIDv7 ke server pusat
                  </span>
                </>
              ) : networkMode === 'ONLINE' ? (
                <>
                  <Wifi size={15} strokeWidth={1.5} />
                  <span>
                    Online • Tersinkronisasi ({currentUser.full_name})
                  </span>
                </>
              ) : networkMode === 'LIE_FI' ? (
                <>
                  <CloudOff size={15} strokeWidth={1.5} />
                  <span>
                    Lie-Fi terdeteksi (timeout &le; 3,5 detik) • Antrean lokal:{' '}
                    <strong className="font-mono-tech">{outboxEvents.length}</strong>
                  </span>
                </>
              ) : (
                <>
                  <WifiOff size={15} strokeWidth={1.5} />
                  <span>
                    Mode Offline • Antrean Outbox:{' '}
                    <strong className="font-mono-tech">{outboxEvents.length}</strong>
                    {outboxEvents.length > 0
                      ? ' — Jangan hapus cache/data browser sebelum sinkronisasi selesai'
                      : ''}
                  </span>
                </>
              )}
            </div>

            {outboxEvents.length > 0 && networkMode === 'ONLINE' && !isSyncing && (
              <button
                type="button"
                onClick={() => {
                  setIsSyncing(true);
                  void runOutboxSync(activeTenant.id, 'ONLINE').finally(() =>
                    setIsSyncing(false)
                  );
                }}
                className="rounded bg-white/20 px-2.5 py-1 text-xs font-semibold text-white hover:bg-white/30"
              >
                Sinkronkan sekarang
              </button>
            )}
          </div>
        </div>

        {/* Banner Peringatan Offline Subscription Grace Period / Read-Only */}
        {subLifecycle.warningBannerText && (
          <div
            className={`px-4 py-2 text-xs font-medium ${
              subLifecycle.mode === 'READ_ONLY'
                ? 'bg-red-950 text-red-100 border-t border-red-800'
                : 'bg-amber-100 text-amber-950 border-t border-amber-300'
            }`}
          >
            <div className="mx-auto max-w-7xl flex items-center gap-2">
              <AlertTriangle size={15} strokeWidth={1.5} className="shrink-0" />
              <span>{subLifecycle.warningBannerText}</span>
            </div>
          </div>
        )}
      </header>

      {/* Toast Feedback Aksesibel (aria-live="polite") */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 right-5 z-40 max-w-md rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-xs font-medium text-white shadow-lg flex items-center gap-2.5"
        >
          <CheckCircle2
            size={18}
            strokeWidth={1.5}
            className="shrink-0 text-emerald-400"
          />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Konten Utama Berdasarkan Peran (RBAC) */}
      <main className="flex-1 px-4 pt-6">
        {activeRole === 'ADMIN' ? (
          <AdminControlTowerView
            tenant={activeTenant}
            warehouse={activeWarehouse}
            adminUser={currentUser}
            items={rawTenantItems as ItemRecord[]}
            balances={tenantBalances}
            bins={tenantBins}
            requests={tenantRequests}
            ledger={tenantLedger}
            auditLogs={tenantAuditLogs}
            outboxCount={outboxEvents.length}
            onOpenQrPrinter={() => setIsQrPrinterOpen(true)}
            onOpenBulkImport={() => setIsBulkImportOpen(true)}
            onOpenOnboarding={() => setIsOnboardingOpen(true)}
            onOpenTransaction={(mode, itemId) =>
              setTxModalState({ open: true, mode, itemId })
            }
            onToast={showToast}
          />
        ) : activeRole === 'APPROVER' ? (
          <ApproverInboxView
            tenant={activeTenant}
            approver={currentUser}
            items={roleSafeItems as OperatorItemView[]}
            balances={tenantBalances}
            requests={tenantRequests}
            onOpenBastPreview={(req) => setBastTargetRequest(req)}
            onToast={showToast}
          />
        ) : (
          <OperatorFieldView
            tenant={activeTenant}
            warehouse={activeWarehouse}
            operator={currentUser}
            items={roleSafeItems as OperatorItemView[]}
            balances={tenantBalances}
            bins={tenantBins}
            requests={tenantRequests}
            outboxCount={outboxEvents.length}
            networkMode={networkMode}
            onOpenScanner={() => setIsScannerOpen(true)}
            onOpenTransaction={(mode, itemId) =>
              setTxModalState({ open: true, mode, itemId })
            }
            onOpenBlindOpname={() => setIsOpnameOpen(true)}
            onOpenBastModal={(req) => setBastTargetRequest(req)}
            onToast={showToast}
          />
        )}
      </main>

      {/* Modals Lintas Peran */}
      <CameraQrScannerModal
        isOpen={isScannerOpen}
        onClose={() => setIsScannerOpen(false)}
        items={roleSafeItems}
        onDetectedItem={(item) => {
          setTxModalState({
            open: true,
            mode:
              item.is_fixed_asset && terms.enableFixedAssetLoan
                ? 'ASSET_LOAN'
                : 'OUTBOUND',
            itemId: item.id,
          });
        }}
      />

      <TransactionSheetModal
        isOpen={txModalState.open}
        onClose={() => setTxModalState((prev) => ({ ...prev, open: false }))}
        initialMode={txModalState.mode}
        initialItemId={txModalState.itemId}
        tenant={activeTenant}
        warehouse={activeWarehouse}
        allWarehouses={tenantWarehouses}
        bins={tenantBins}
        items={roleSafeItems}
        balances={tenantBalances}
        actor={currentUser}
        approver={approverUser}
        networkMode={networkMode}
        onSuccessToast={(res) => showToast(res.message)}
      />

      <BlindOpnameModal
        isOpen={isOpnameOpen}
        onClose={() => setIsOpnameOpen(false)}
        tenantId={activeTenant.id}
        warehouse={activeWarehouse}
        items={roleSafeItems}
        bins={tenantBins}
        actor={currentUser}
        onResultToast={showToast}
      />

      <BastSignatureModal
        isOpen={Boolean(bastTargetRequest)}
        onClose={() => setBastTargetRequest(null)}
        request={bastTargetRequest}
        item={rawTenantItems.find((i) => i.id === bastTargetRequest?.item_id)}
        tenant={activeTenant}
        warehouse={activeWarehouse}
        operator={currentUser}
        onCompleted={(msg) => {
          showToast(msg);
          setBastTargetRequest(null);
        }}
      />

      <QrLabelPrinterModal
        isOpen={isQrPrinterOpen}
        onClose={() => setIsQrPrinterOpen(false)}
        items={roleSafeItems}
        tenantName={activeTenant.name}
      />

      <BulkImportModal
        isOpen={isBulkImportOpen}
        onClose={() => setIsBulkImportOpen(false)}
        tenant={activeTenant}
        warehouse={activeWarehouse}
        existingItems={rawTenantItems}
        actor={currentUser}
        onImported={showToast}
      />

      <OnboardingWizardModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onTenantCreated={(newId, msg) => {
          setActiveTenantId(newId);
          setActiveWarehouseId('');
          showToast(msg);
        }}
      />
    </div>
  );
}
