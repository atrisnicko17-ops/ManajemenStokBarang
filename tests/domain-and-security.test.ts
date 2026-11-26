import { describe, expect, it } from 'vitest';
import {
  parseCsvToBulkDraft,
  sanitizeCsvCell,
  serializeSafeCsv,
} from '@/domain/csv-xlsx-validator';
import { allocateStockFromBatches } from '@/domain/fefo-fifo';
import {
  deriveOfflinePinHash,
  evaluatePinLockoutStatus,
  recordPinVerificationResult,
  verifyOfflinePin,
} from '@/domain/pin-crypto';
import { evaluateSubscriptionLifecycle } from '@/domain/subscription-grace';
import { evaluateTransactionGovernance } from '@/domain/threshold-rules';
import type { BatchBalance, ItemRecord } from '@/domain/types';
import { convertToBaseUnit } from '@/domain/uom-converter';
import { generateUuidV7 } from '@/domain/uuidv7';
import { stripCostPriceForNonAdmin } from '@/offline/db';
import { verifyImageMagicBytes } from '@/offline/image-compressor';

describe('Domain Logic & OWASP Security Hardening', () => {
  it('converts Multi-UOM quantities accurately to Base Unit', () => {
    const res = convertToBaseUnit(2, 'Box (5 Rim)', 'Rim', [
      { unit_name: 'Box (5 Rim)', multiplier_to_base: 5 },
    ]);
    expect(res.qtyBase).toBe(10);
    expect(res.multiplier).toBe(5);
    expect(() => convertToBaseUnit(0, 'Rim', 'Rim', [])).toThrow();
  });

  it('allocates FEFO batches by earliest expiry date and skips expired batches', () => {
    const batches: BatchBalance[] = [
      {
        id: 'b-expired',
        tenant_id: 't1',
        warehouse_id: 'w1',
        bin_code: 'A1',
        item_id: 'i1',
        batch_number: 'EXP-OLD',
        expiry_date: '2026-01-01',
        qty_on_hand: 10,
        qty_reserved: 0,
        updated_at: '2025-12-01T00:00:00Z',
      },
      {
        id: 'b-later',
        tenant_id: 't1',
        warehouse_id: 'w1',
        bin_code: 'A1',
        item_id: 'i1',
        batch_number: 'BATCH-LATER',
        expiry_date: '2027-06-01',
        qty_on_hand: 20,
        qty_reserved: 0,
        updated_at: '2026-10-01T00:00:00Z',
      },
      {
        id: 'b-sooner',
        tenant_id: 't1',
        warehouse_id: 'w1',
        bin_code: 'A1',
        item_id: 'i1',
        batch_number: 'BATCH-SOONER',
        expiry_date: '2026-12-15',
        qty_on_hand: 8,
        qty_reserved: 0,
        updated_at: '2026-10-05T00:00:00Z',
      },
    ];

    const plan = allocateStockFromBatches(batches, 12, 'FEFO', '2026-11-26');
    expect(plan.skippedExpiredBatches).toEqual(['EXP-OLD']);
    expect(plan.wouldOverdraft).toBe(false);
    expect(plan.slices).toEqual([
      {
        balanceId: 'b-sooner',
        batchNumber: 'BATCH-SOONER',
        expiryDate: '2026-12-15',
        allocatedQty: 8,
      },
      {
        balanceId: 'b-later',
        batchNumber: 'BATCH-LATER',
        expiryDate: '2027-06-01',
        allocatedQty: 4,
      },
    ]);
  });

  it('enforces approval thresholds, rack freeze, and mandatory photo on WRITE_OFF', () => {
    const routine = evaluateTransactionGovernance({
      requestType: 'OUTBOUND',
      qtyBase: 4,
      approvalThresholdQty: 5,
      isFixedAsset: false,
      hasEvidencePhoto: false,
      isBinFrozen: false,
      partyName: 'TU Sekolah',
    });
    expect(routine.isValid).toBe(true);
    expect(routine.requiresApproval).toBe(false);

    const overThreshold = evaluateTransactionGovernance({
      requestType: 'OUTBOUND',
      qtyBase: 10,
      approvalThresholdQty: 5,
      isFixedAsset: false,
      hasEvidencePhoto: false,
      isBinFrozen: false,
      partyName: 'Panitia UAS',
    });
    expect(overThreshold.isValid).toBe(true);
    expect(overThreshold.requiresApproval).toBe(true);

    const writeOffNoPhoto = evaluateTransactionGovernance({
      requestType: 'WRITE_OFF',
      qtyBase: 2,
      approvalThresholdQty: 5,
      isFixedAsset: false,
      hasEvidencePhoto: false,
      isBinFrozen: false,
      partyName: 'Gudang',
    });
    expect(writeOffNoPhoto.isValid).toBe(false);
    expect(writeOffNoPhoto.validationError).toContain('Wajib lampirkan foto bukti');

    const frozenRack = evaluateTransactionGovernance({
      requestType: 'OUTBOUND',
      qtyBase: 1,
      approvalThresholdQty: 5,
      isFixedAsset: false,
      hasEvidencePhoto: false,
      isBinFrozen: true,
      partyName: 'Unit A',
    });
    expect(frozenRack.isValid).toBe(false);
  });

  it('verifies PBKDF2 6-digit offline PIN and triggers 15-minute lockout on 3rd failure', async () => {
    const salt = 'unit-test-salt';
    const hash = await deriveOfflinePinHash('123456', salt);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await verifyOfflinePin('123456', hash, salt)).toBe(true);
    expect(await verifyOfflinePin('999999', hash, salt)).toBe(false);

    const now = 1_700_000_000_000;
    let state = { failedAttempts: 0, lockoutUntilMs: null as number | null };

    const r1 = recordPinVerificationResult(state, false, now);
    expect(r1.triggeredSecurityLockout).toBe(false);
    expect(r1.attemptsRemaining).toBe(2);
    state = r1.nextState;

    const r2 = recordPinVerificationResult(state, false, now + 1000);
    expect(r2.triggeredSecurityLockout).toBe(false);
    expect(r2.attemptsRemaining).toBe(1);
    state = r2.nextState;

    const r3 = recordPinVerificationResult(state, false, now + 2000);
    expect(r3.triggeredSecurityLockout).toBe(true);
    expect(r3.attemptsRemaining).toBe(0);

    const checkLocked = evaluatePinLockoutStatus(r3.nextState, now + 5000);
    expect(checkLocked.isLocked).toBe(true);
    expect(checkLocked.remainingSeconds).toBeGreaterThan(890);

    const checkAfter15Min = evaluatePinLockoutStatus(
      r3.nextState,
      now + 2000 + 15 * 60 * 1000 + 1
    );
    expect(checkAfter15Min.isLocked).toBe(false);
  });

  it('enforces 72-hour offline subscription grace period and read-only transition', () => {
    const validUntil = '2026-11-20T00:00:00.000Z';
    const validMs = Date.parse(validUntil);

    const active = evaluateSubscriptionLifecycle(validUntil, 0, validMs - 3600_000);
    expect(active.mode).toBe('ACTIVE');
    expect(active.canCreateTransactions).toBe(true);

    const grace = evaluateSubscriptionLifecycle(
      validUntil,
      3,
      validMs + 24 * 3600_000
    );
    expect(grace.mode).toBe('GRACE_PERIOD');
    expect(grace.canCreateTransactions).toBe(true);
    expect(grace.graceHoursRemaining).toBe(48);

    const readOnly = evaluateSubscriptionLifecycle(
      validUntil,
      0,
      validMs + 75 * 3600_000
    );
    expect(readOnly.mode).toBe('READ_ONLY');
    expect(readOnly.canCreateTransactions).toBe(false);
  });

  it('sanitizes CSV formula injection, validates bulk import, and checks magic bytes & HPP isolation', () => {
    expect(sanitizeCsvCell('=HYPERLINK("http://evil")')).toBe(
      '\'"\'=HYPERLINK(""http://evil"")"'
        .replace(/^\'"\'/, '"\'=')
        .slice(0, 0) || '"\'=HYPERLINK(""http://evil"")"'
    );
    expect(sanitizeCsvCell('+SUM(A1:A2)')).toBe("'+SUM(A1:A2)");
    expect(sanitizeCsvCell('@cmd')).toBe("'@cmd");

    const csvOut = serializeSafeCsv(['SKU', 'Notes'], [['ATK-01', '=1+1']]);
    expect(csvOut).toContain("'=1+1");

    const draft = parseCsvToBulkDraft(
      'sku_code,barcode,name,category,bin_code,base_unit,uom_name,uom_multiplier,min_stock,qty_initial,cost_price,is_fixed_asset,expiry_date\nATK-DUP,,Barang A,ATK,R1,Pcs,Pcs,1,0,10,5000,false,\nATK-DUP,,Barang B,ATK,R1,Pcs,Pcs,1,0,-5,5000,false,',
      new Set()
    );
    expect(draft[0].errors).toHaveLength(0);
    expect(draft[1].errors.length).toBeGreaterThanOrEqual(2);

    // Magic bytes check
    expect(
      verifyImageMagicBytes(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
      )
    ).toBe(true);
    expect(
      verifyImageMagicBytes(new TextEncoder().encode('<script>alert(1)</script>'))
    ).toBe(false);

    // HPP Isolation check
    const sampleItem: ItemRecord = {
      id: 'i1',
      tenant_id: 't1',
      sku_code: 'SKU-1',
      barcode: '123',
      name: 'Rahasia HPP',
      category: 'Umum',
      default_bin_code: 'R1',
      base_unit: 'Pcs',
      min_stock: 1,
      cost_price: 99000,
      is_fixed_asset: false,
      asset_condition: 'BAIK',
      uoms: [],
      updated_at: new Date().toISOString(),
    };

    const operatorProjection = stripCostPriceForNonAdmin([sampleItem], 'OPERATOR');
    expect('cost_price' in operatorProjection[0]).toBe(false);

    const adminProjection = stripCostPriceForNonAdmin([sampleItem], 'ADMIN');
    expect((adminProjection[0] as ItemRecord).cost_price).toBe(99000);

    // Chronological UUIDv7 ordering
    const idEarlier = generateUuidV7(1_700_000_001_000);
    const idLater = generateUuidV7(1_700_000_005_000);
    expect(idEarlier < idLater).toBe(true);
  });
});
