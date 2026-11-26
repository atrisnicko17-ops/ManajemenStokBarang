import Dexie, { type Table } from 'dexie';
import type {
  AuditLogEntry,
  BatchBalance,
  BinLocation,
  ItemRecord,
  LedgerEntry,
  OperatorItemView,
  OutboxEvent,
  StockRequest,
  TenantConfig,
  UserAccount,
  UserRole,
  Warehouse,
} from '@/domain/types';
import { buildInitialSeedDataset } from './seed-data';

export class GudangKuOfflineDB extends Dexie {
  tenants!: Table<TenantConfig, string>;
  users!: Table<UserAccount, string>;
  warehouses!: Table<Warehouse, string>;
  bins!: Table<BinLocation, string>;
  items!: Table<ItemRecord, string>;
  balances!: Table<BatchBalance, string>;
  requests!: Table<StockRequest, string>;
  ledger!: Table<LedgerEntry, string>;
  outbox!: Table<OutboxEvent, string>;
  auditLogs!: Table<AuditLogEntry, string>;

  constructor(dbName: string = 'GudangKuOfflineDB_v1') {
    super(dbName);
    this.version(1).stores({
      tenants: 'id, business_profile',
      users: 'id, tenant_id, role',
      warehouses: 'id, tenant_id, is_primary',
      bins: 'id, tenant_id, warehouse_id, bin_code',
      items: 'id, tenant_id, sku_code, barcode, name, updated_at',
      balances: 'id, tenant_id, warehouse_id, item_id, batch_number',
      requests: 'id, tenant_id, warehouse_id, status, request_type, created_at',
      ledger: 'id, tenant_id, warehouse_id, item_id, created_at',
      outbox: 'id, tenant_id, created_at, event_type',
      auditLogs: 'id, tenant_id, created_at, action_type',
    });
  }
}

export const localDB = new GudangKuOfflineDB();

export async function ensurePersistentBrowserStorage(): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.persist === 'function'
  ) {
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  }
  return false;
}

export async function initializeOrSeedLocalDB(
  db: GudangKuOfflineDB = localDB,
  forceReset: boolean = false
): Promise<void> {
  if (forceReset) {
    await db.transaction(
      'rw',
      [
        db.tenants,
        db.users,
        db.warehouses,
        db.bins,
        db.items,
        db.balances,
        db.requests,
        db.ledger,
        db.outbox,
        db.auditLogs,
      ],
      async () => {
        await Promise.all([
          db.tenants.clear(),
          db.users.clear(),
          db.warehouses.clear(),
          db.bins.clear(),
          db.items.clear(),
          db.balances.clear(),
          db.requests.clear(),
          db.ledger.clear(),
          db.outbox.clear(),
          db.auditLogs.clear(),
        ]);
      }
    );
  }

  const existingCount = await db.tenants.count();
  if (existingCount > 0) return;

  const seed = await buildInitialSeedDataset();
  await db.transaction(
    'rw',
    [
      db.tenants,
      db.users,
      db.warehouses,
      db.bins,
      db.items,
      db.balances,
      db.requests,
      db.ledger,
      db.auditLogs,
    ],
    async () => {
      await db.tenants.bulkPut(seed.tenants);
      await db.users.bulkPut(seed.users);
      await db.warehouses.bulkPut(seed.warehouses);
      await db.bins.bulkPut(seed.bins);
      await db.items.bulkPut(seed.items);
      await db.balances.bulkPut(seed.balances);
      await db.requests.bulkPut(seed.requests);
      await db.ledger.bulkPut(seed.ledger);
      await db.auditLogs.bulkPut(seed.auditLogs);
    }
  );
}

/**
 * Proyeksi data aman berbasis peran: menghapus properti `cost_price` (HPP)
 * secara eksplisit untuk seluruh peran non-ADMIN agar konsisten dengan kebijakan
 * column-level privilege di PostgreSQL.
 */
export function stripCostPriceForNonAdmin<T extends ItemRecord>(
  items: readonly T[],
  role: UserRole
): Array<ItemRecord | OperatorItemView> {
  if (role === 'ADMIN') {
    return [...items];
  }
  return items.map((item) => {
    const { cost_price: _hiddenCost, ...safeView } = item;
    void _hiddenCost;
    return safeView;
  });
}
