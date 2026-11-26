import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { GudangKuOfflineDB, initializeOrSeedLocalDB } from '@/offline/db';
import {
  exportEmergencyOutboxDump,
  importEmergencyOutboxDump,
  runOutboxSync,
  simulateConcurrentOfflineRaceCondition,
  submitInventoryTransaction,
  voidCompletedLedgerEntry,
} from '@/offline/sync-worker';

describe('Field QA Chaos Testing — Offline Queue, Lie-Fi, Idempotency & Overdraft', () => {
  let testDb: GudangKuOfflineDB;

  beforeEach(async () => {
    testDb = new GudangKuOfflineDB(`TestGudangKu_${Date.now()}_${Math.random()}`);
    await initializeOrSeedLocalDB(testDb, true);
  });

  it('handles Lie-Fi (< 3.5s timeout) and idempotent mid-sync interruption across 20 transactions without double deduction', async () => {
    const operator = (await testDb.users.get('usr-sch-operator'))!;
    const initialBal = (await testDb.balances.get('bal-sch-marker'))!;
    expect(initialBal.qty_on_hand).toBe(50);

    // Uji Lie-Fi fallback < 3,5 detik
    const startMs = Date.now();
    const lieFiRes = await submitInventoryTransaction(
      {
        tenantId: 'tenant-school-01',
        warehouseId: 'wh-school-main',
        itemId: 'item-sch-marker',
        requestType: 'OUTBOUND',
        qtyInput: 1,
        selectedUnit: 'Pcs',
        partyName: 'Kelas X-A',
        reason: 'Spidol harian',
        actor: operator,
        networkMode: 'LIE_FI',
      },
      testDb
    );
    const elapsedMs = Date.now() - startMs;
    expect(elapsedMs).toBeLessThan(3500);
    expect(lieFiRes.outcome).toBe('QUEUED_OFFLINE');

    // Tambahkan 19 transaksi offline lagi sehingga total 20 antrean di Outbox
    for (let i = 0; i < 19; i++) {
      await submitInventoryTransaction(
        {
          tenantId: 'tenant-school-01',
          warehouseId: 'wh-school-main',
          itemId: 'item-sch-marker',
          requestType: 'OUTBOUND',
          qtyInput: 1,
          selectedUnit: 'Pcs',
          partyName: `Kelas X-${i}`,
          reason: 'Uji 20 antrean',
          actor: operator,
          networkMode: 'OFFLINE',
        },
        testDb
      );
    }

    const allQueued = await testDb.outbox.toArray();
    expect(allQueued).toHaveLength(20);

    // Simulasi koneksi terputus tepat di tengah proses sync (setelah 10 event pertama)
    const firstHalf = await runOutboxSync('tenant-school-01', 'ONLINE', testDb, {
      stopAfterCount: 10,
    });
    expect(firstHalf.processedCount).toBe(10);

    // Simulasi retry yang mengirim ulang event yang sudah terproses + sisa 10 event
    await testDb.outbox.bulkPut(allQueued.slice(0, 5));
    const secondHalf = await runOutboxSync('tenant-school-01', 'ONLINE', testDb);
    expect(secondHalf.processedCount).toBe(10);
    expect(secondHalf.skippedIdempotentCount).toBe(5);

    const finalBal = (await testDb.balances.get('bal-sch-marker'))!;
    // 50 dikurangi tepat 20 = 30 (tidak terpotong ganda menjadi 25!)
    expect(finalBal.qty_on_hand).toBe(30);
  });

  it('detects concurrent offline depletion and flags second transaction with FLAGGED_OVERDRAFT', async () => {
    const summary = await simulateConcurrentOfflineRaceCondition(
      'tenant-school-01',
      'wh-school-main',
      'item-sch-ink',
      testDb
    );

    expect(summary.processedCount).toBe(2);
    expect(summary.overdraftDetectedCount).toBe(1);

    const finalInkBal = (await testDb.balances.get('bal-sch-ink'))!;
    expect(finalInkBal.qty_on_hand).toBe(-2);

    const flaggedEntries = await testDb.ledger
      .filter((l) => l.item_id === 'item-sch-ink' && l.is_overdraft_flagged)
      .toArray();
    expect(flaggedEntries).toHaveLength(1);
  });

  it('preserves immutable ledger history on VOID by appending compensating VOID_REVERSAL', async () => {
    const admin = (await testDb.users.get('usr-sch-admin'))!;
    const beforeCount = await testDb.ledger.count();
    const targetLedgerId = '019367f0-0002-7000-8000-000000000002'; // -8 Rim Kertas F4

    await voidCompletedLedgerEntry(
      {
        ledgerId: targetLedgerId,
        voidReason: 'Koreksi salah input jumlah pengambilan TU',
        actor: admin,
      },
      testDb
    );

    const afterCount = await testDb.ledger.count();
    expect(afterCount).toBe(beforeCount + 1);

    // Baris asli tetap utuh (tidak terhapus)
    const originalStillExists = await testDb.ledger.get(targetLedgerId);
    expect(originalStillExists?.qty_delta).toBe(-8);

    // Saldo Kertas F4 pulih dari 42 menjadi 50
    const updatedF4 = (await testDb.balances.get('bal-sch-f4'))!;
    expect(updatedF4.qty_on_hand).toBe(50);
  });

  it('exports Emergency JSON Dump and blocks cross-tenant recovery injection', async () => {
    const operator = (await testDb.users.get('usr-sch-operator'))!;
    await submitInventoryTransaction(
      {
        tenantId: 'tenant-school-01',
        warehouseId: 'wh-school-main',
        itemId: 'item-sch-f4',
        requestType: 'OUTBOUND',
        qtyInput: 3,
        selectedUnit: 'Rim',
        partyName: 'Ruang Guru',
        reason: 'Offline darurat',
        actor: operator,
        networkMode: 'OFFLINE',
      },
      testDb
    );

    const jsonDump = await exportEmergencyOutboxDump('tenant-school-01', testDb);

    await expect(
      importEmergencyOutboxDump(jsonDump, 'tenant-umkm-01', testDb)
    ).rejects.toThrow(/Isolasi Multi-Tenant/);

    const recovered = await importEmergencyOutboxDump(
      jsonDump,
      'tenant-school-01',
      testDb
    );
    expect(recovered.processedCount).toBe(1);
  });
});
