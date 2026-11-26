# Technical Blueprint: Skema Database SQL, Kebijakan RLS & Kontrak Sync Engine

**Nama Proyek:** GudangKu WMS (Multi-Tenant & Offline-First PWA)  
**Target Stack:** PostgreSQL (Supabase), Next.js PWA, Dexie.js (IndexedDB), Cloudflare R2  
**Status:** Ready for Backend & Database Migration  

---

## 1. Struktur Folder Proyek (Modular Architecture)

Agar pemisahan antara antarmuka pengguna (*UI*), logika bisnis (*Domain*), dan mesin penyimpanan lokal (*Offline Sync Engine*) tetap rapi serta mudah diuji:

```text
gudangku-wms/
├── src/
│   ├── app/                      # Next.js App Router (Halaman & API Route Handlers)
│   ├── components/               # Komponen UI (Scanner, SignaturePad, PinPad, Tables)
│   ├── domain/                   # Pure TypeScript Business Logic (Tanpa dependensi UI)
│   │   ├── uom-converter.ts      # Kalkulasi konversi satuan bertingkat ke Base Unit
│   │   ├── threshold-rules.ts    # Penentu apakah transaksi butuh Approval
│   │   └── pin-crypto.ts         # Verifikasi hash PIN offline (PBKDF2 / SHA-256)
│   ├── offline/                  # Offline-First Engine (Client-Side)
│   │   ├── db.ts                 # Skema Dexie.js (IndexedDB)
│   │   ├── sync-worker.ts        # Background Push/Pull Sync & Retry Exponential Backoff
│   │   └── image-compressor.ts   # Kompresi foto bukti kerusakan ke WebP (< 150 KB)
│   └── lib/
│       └── supabase/             # Client & Server Supabase helpers
├── supabase/
│   └── migrations/
│       ├── 001_init_schema.sql   # Tabel inti, Index, & View Operator (tanpa HPP)
│       ├── 002_rls_policies.sql  # Isolasi keamanan Multi-Tenant (Row-Level Security)
│       └── 003_sync_rpc.sql      # Fungsi atomik pemrosesan Sync Queue & Overdraft check
└── public/
    ├── manifest.json             # Konfigurasi PWA Installable
    └── templates/                # Template Excel (.xlsx) untuk Bulk Import SKU
```

---

## 2. Skrip Migrasi Database PostgreSQL (`001_init_schema.sql`)

Skrip ini mencakup seluruh tabel inti, dukungan *Multi-UOM*, pelacakan *Batch/FEFO*, dokumen persetujuan, *Immutable Event Ledger*, serta **Database View** yang menyembunyikan harga modal (HPP) dari staf lapangan.

```sql
-- Aktifkan ekstensi UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. TABEL ORGANISASI / CLIENT SAAS (MULTI-TENANT)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    business_profile VARCHAR(20) NOT NULL CHECK (business_profile IN ('SCHOOL', 'UMKM', 'DISTRIBUTOR')),
    subscription_tier VARCHAR(20) NOT NULL DEFAULT 'FREE' CHECK (subscription_tier IN ('FREE', 'PRO', 'ENTERPRISE')),
    approval_threshold_qty INT NOT NULL DEFAULT 5, -- Batas maksimal pengeluaran rutin tanpa approval
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. TABEL PENGGUNA & HAK AKSES
CREATE TABLE users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'APPROVER', 'OPERATOR')),
    offline_pin_hash TEXT, -- Hash PBKDF2/SHA-256 untuk otorisasi offline di gudang
    offline_pin_salt TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_tenant ON users(tenant_id);

-- 3. TABEL GUDANG & LOKASI RAK (BIN LOCATION)
CREATE TABLE warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bin_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    bin_code VARCHAR(50) NOT NULL, -- Contoh: ZONA-A/RAK-01
    UNIQUE(warehouse_id, bin_code)
);

-- 4. MASTER BARANG (SKU)
CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sku_code VARCHAR(60) NOT NULL,
    barcode VARCHAR(100), -- Barcode pabrikan atau kode QR internal
    name VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    base_unit VARCHAR(30) NOT NULL, -- Satuan terkecil: Pcs, Rim, Botol, Gram
    min_stock INT NOT NULL DEFAULT 0,
    cost_price NUMERIC(15, 2) NOT NULL DEFAULT 0, -- HPP (Rahasia: hanya ADMIN)
    is_fixed_asset BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, sku_code)
);

CREATE INDEX idx_items_tenant_barcode ON items(tenant_id, barcode);
CREATE INDEX idx_items_updated_at ON items(tenant_id, updated_at);

-- 5. KONVERSI SATUAN BERTINGKAT (MULTI-UOM)
CREATE TABLE item_uoms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    unit_name VARCHAR(40) NOT NULL, -- Contoh: Box (5 Rim), Dus (24 Pcs)
    multiplier_to_base INT NOT NULL CHECK (multiplier_to_base >= 1)
);

-- 6. SALDO STOK PER GUDANG & BATCH (MENDUKUNG FIFO / FEFO)
CREATE TABLE inventory_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    bin_id UUID REFERENCES bin_locations(id),
    item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    batch_number VARCHAR(60) NOT NULL DEFAULT 'GENERAL',
    expiry_date DATE, -- Diisi untuk mode FEFO (UMKM/F&B/Obat)
    qty_on_hand INT NOT NULL DEFAULT 0,
    qty_reserved INT NOT NULL DEFAULT 0, -- Stok dikunci menunggu persetujuan
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(warehouse_id, item_id, batch_number)
);

-- 7. DOKUMEN PERMINTAAN & PERSETUJUAN (APPROVAL WORKFLOW)
CREATE TABLE stock_requests (
    id UUID PRIMARY KEY, -- Dibangkitkan di client (UUIDv7) untuk dukungan offline
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    request_code VARCHAR(40) NOT NULL,
    request_type VARCHAR(25) NOT NULL CHECK (request_type IN ('INBOUND', 'OUTBOUND', 'WRITE_OFF', 'OPNAME_ADJUSTMENT')),
    item_id UUID NOT NULL REFERENCES items(id),
    qty_requested_base INT NOT NULL,
    qty_approved_base INT,
    party_name VARCHAR(150), -- Pemohon / Unit / Pelanggan
    reason TEXT,
    status VARCHAR(25) NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED', 'VOIDED')),
    requested_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approval_method VARCHAR(30), -- 'AUTO_APPROVED', 'ONLINE_REMOTE', 'OFFLINE_PIN_OVERRIDE'
    evidence_photo_url TEXT,
    signature_url TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. BUKU BESAR MUTASI STOK (IMMUTABLE EVENT LEDGER)
CREATE TABLE stock_ledger (
    id UUID PRIMARY KEY, -- Client Idempotency UUIDv7 (mencegah duplikasi saat retry sync)
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id),
    item_id UUID NOT NULL REFERENCES items(id),
    request_id UUID REFERENCES stock_requests(id),
    batch_number VARCHAR(60) NOT NULL DEFAULT 'GENERAL',
    event_type VARCHAR(30) NOT NULL,
    qty_delta INT NOT NULL, -- Positif (+) masuk, Negatif (-) keluar
    is_overdraft_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    actor_id UUID REFERENCES users(id),
    approval_method VARCHAR(30),
    device_origin VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_tenant_created ON stock_ledger(tenant_id, created_at DESC);

-- 9. SECURE VIEW UNTUK STAF LAPANGAN (MENYEMBUNYIKAN KOLOM HPP / COST_PRICE)
CREATE VIEW v_items_operator AS
SELECT 
    id, tenant_id, sku_code, barcode, name, category, base_unit, min_stock, is_fixed_asset, updated_at
FROM items;
```

---

## 3. Kebijakan Isolasi Multi-Tenant (`002_rls_policies.sql`)

```sql
-- Fungsi helper mengambil tenant_id milik user yang sedang login
CREATE OR REPLACE FUNCTION get_auth_tenant_id()
RETURNS UUID AS $$
  SELECT tenant_id FROM users WHERE id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Aktifkan Row-Level Security pada seluruh tabel
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_uoms ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_ledger ENABLE ROW LEVEL SECURITY;

-- Kebijakan Isolasi Tenant (Pengguna hanya bisa membaca/menulis data organisasinya sendiri)
CREATE POLICY "tenant_isolation_items" ON items
  FOR ALL USING (tenant_id = get_auth_tenant_id());

CREATE POLICY "tenant_isolation_balances" ON inventory_balances
  FOR ALL USING (tenant_id = get_auth_tenant_id());

CREATE POLICY "tenant_isolation_requests" ON stock_requests
  FOR ALL USING (tenant_id = get_auth_tenant_id());

CREATE POLICY "tenant_isolation_ledger" ON stock_ledger
  FOR ALL USING (tenant_id = get_auth_tenant_id());
```

---

## 4. Fungsi Sinkronisasi Atomik Server (`003_sync_rpc.sql`)

Fungsi PostgreSQL ini dipanggil saat HP staf kembali *online*. Fungsi memproses daftar antrean mutasi satu per satu secara **idempoten** (mengabaikan ID yang sudah pernah masuk) dan otomatis mendeteksi jika terjadi selisih minus (*overdraft*) akibat transaksi bersamaan.

```sql
CREATE OR REPLACE FUNCTION process_offline_sync_batch(p_events JSONB)
RETURNS JSONB AS $$
DECLARE
    v_tenant_id UUID := get_auth_tenant_id();
    v_event JSONB;
    v_event_id UUID;
    v_item_id UUID;
    v_warehouse_id UUID;
    v_delta INT;
    v_current_qty INT;
    v_is_overdraft BOOLEAN;
    v_processed_count INT := 0;
BEGIN
    FOR v_event IN SELECT * FROM jsonb_array_elements(p_events)
    LOOP
        v_event_id := (v_event->>'id')::UUID;
        
        -- Cek Idempotency: Jika event sudah pernah diproses, lewati agar stok tidak terpotong 2x
        IF EXISTS (SELECT 1 FROM stock_ledger WHERE id = v_event_id) THEN
            CONTINUE;
        END IF;

        v_item_id := (v_event->>'item_id')::UUID;
        v_warehouse_id := (v_event->>'warehouse_id')::UUID;
        v_delta := (v_event->>'qty_delta')::INT;

        -- Kunci baris saldo stok (FOR UPDATE) untuk mencegah race condition antar perangkat
        SELECT qty_on_hand INTO v_current_qty
        FROM inventory_balances
        WHERE tenant_id = v_tenant_id AND warehouse_id = v_warehouse_id AND item_id = v_item_id
        FOR UPDATE;

        IF v_current_qty IS NULL THEN
            v_current_qty := 0;
            INSERT INTO inventory_balances (tenant_id, warehouse_id, item_id, qty_on_hand)
            VALUES (v_tenant_id, v_warehouse_id, v_item_id, 0);
        END IF;

        -- Deteksi apakah mutasi menyebabkan stok minus (Overdraft)
        v_is_overdraft := (v_current_qty + v_delta) < 0;

        -- Perbarui saldo fisik gudang
        UPDATE inventory_balances
        SET qty_on_hand = qty_on_hand + v_delta,
            updated_at = NOW()
        WHERE tenant_id = v_tenant_id AND warehouse_id = v_warehouse_id AND item_id = v_item_id;

        -- Catat permanen ke Immutable Event Ledger
        INSERT INTO stock_ledger (
            id, tenant_id, warehouse_id, item_id, event_type, qty_delta,
            is_overdraft_flagged, actor_id, approval_method, device_origin, created_at
        ) VALUES (
            v_event_id,
            v_tenant_id,
            v_warehouse_id,
            v_item_id,
            v_event->>'event_type',
            v_delta,
            v_is_overdraft,
            auth.uid(),
            v_event->>'approval_method',
            v_event->>'device_origin',
            (v_event->>'created_at')::TIMESTAMPTZ
        );

        v_processed_count := v_processed_count + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'processed_count', v_processed_count,
        'server_timestamp', NOW()
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 5. Kontrak API & Skema Penyimpanan Lokal (Dexie.js / IndexedDB)

### 5.1. Struktur Tabel Lokal di Perangkat HP (`src/offline/db.ts`)

```typescript
import Dexie, { Table } from 'dexie';

export interface LocalItem {
  id: string;
  sku_code: string;
  barcode?: string;
  name: string;
  bin_code: string;
  base_unit: string;
  min_stock: number;
  qty_on_hand: number;
  qty_reserved: number;
  uoms: { unit_name: string; multiplier_to_base: number }[];
  updated_at: string;
}

export interface SyncOutboxEvent {
  id: string; // UUIDv7 (Idempotency Key)
  warehouse_id: string;
  item_id: string;
  event_type: 'INBOUND' | 'OUTBOUND' | 'WRITE_OFF' | 'PIN_OVERRIDE_APPROVED';
  qty_delta: number;
  approval_method: string;
  device_origin: string;
  local_photo_blob?: Blob; // Foto bukti WebP sebelum diunggah ke R2
  created_at: string;
  retry_count: number;
}

export class GudangKuLocalDB extends Dexie {
  items!: Table<LocalItem, string>;
  outbox!: Table<SyncOutboxEvent, string>;

  constructor() {
    super('GudangKuOfflineDB');
    this.version(1).stores({
      items: 'id, sku_code, barcode, name, updated_at',
      outbox: 'id, created_at, event_type'
    });
  }
}

export const localDB = new GudangKuLocalDB();
```

### 5.2. Alur Sinkronisasi Dua Arah (Push-Then-Pull Protocol)

1. **Langkah 1 — Upload Media Tertunda:** Jika ada `local_photo_blob` di dalam `outbox`, unggah terlebih dahulu ke *bucket* Cloudflare R2 / Supabase Storage dan ganti dengan URL publiknya.
2. **Langkah 2 — Push Outbox Events:** Kirim seluruh array `outbox` ke fungsi RPC `process_offline_sync_batch`. Setelah server mengembalikan `status: 'SUCCESS'`, hapus item yang telah terproses dari `localDB.outbox`.
3. **Langkah 3 — Delta Pull:** Ambil pembaruan master SKU dan saldo terbaru dari server sejak `last_synced_at` terakhir untuk memperbarui `localDB.items`.

---

## 6. Spesifikasi Keamanan PIN Offline (`src/domain/pin-crypto.ts`)

* **Penyimpanan Hash:** PIN 6-digit Kepala Sekolah/Kepala Gudang **tidak pernah disimpan dalam bentuk teks asli**. Saat perangkat *online*, server mengirimkan `offline_pin_hash` dan `offline_pin_salt`.
* **Verifikasi Lokal:** Menggunakan **Web Crypto API (`crypto.subtle.digest('SHA-256', ...)` / `PBKDF2`)** bawaan peramban sehingga verifikasi berjalan dalam waktu `< 50 ms` tanpa pustaka eksternal.
* **Proteksi Brute-Force Offline:**
  * Maksimal **3 kali percobaan salah** berturut-turut.
  * Pada kegagalan ke-3, tombol *PIN Override* dikunci selama **15 menit** (`lockout_until` disimpan di `localStorage`) dan mencatat *event* `SECURITY_PIN_LOCKOUT` ke dalam antrean `outbox` untuk diaudit Admin.

---

## 7. Checklist Verifikasi Sebelum Mulai Coding (Pre-Flight Checklist)

- [ ] **Akun & Proyek Supabase:** Buat proyek PostgreSQL dan jalankan skrip `001`, `002`, dan `003` pada *SQL Editor*.
- [ ] **Storage Bucket:** Buat *bucket* privat `evidence-media` untuk menyimpan foto kerusakan (*write-off*) dan gambar tanda tangan BAST.
- [ ] **Konfigurasi PWA:** Siapkan ikon aplikasi (`192x192` dan `512x512`) serta aktifkan `Serwist` / `next-pwa` untuk *pre-caching* halaman utama.
- [ ] **Seed Data Pengujian:** Masukkan minimal 1 *tenant* profil `SCHOOL` dan 1 *tenant* profil `UMKM` lengkap dengan 1 akun `ADMIN`, 1 akun `APPROVER` (PIN: `123456`), dan 1 akun `OPERATOR`.