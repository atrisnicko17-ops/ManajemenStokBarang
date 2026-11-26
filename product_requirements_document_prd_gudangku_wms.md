# Product Requirements Document (PRD)
**Nama Produk (Working Title):** GudangKu WMS (Modular Warehouse & Asset Management System)  
**Versi Dokumen:** 1.0  
**Status:** Ready for Engineering & UI/UX Design  
**Arsitektur Utama:** Multi-Tenant SaaS, Offline-First PWA, Event-Driven Inventory Ledger  

---

## 1. Ringkasan Eksekutif (Executive Summary)
**GudangKu WMS** adalah aplikasi manajemen stok barang gudang dan inventaris aset berbasis *Progressive Web App* (PWA) yang dirancang untuk berjalan mulus baik dalam kondisi **Online maupun Offline**. Produk ini menggunakan arsitektur *Multi-Tenant Modular* sehingga satu basis kode (*single codebase*) dapat melayani tiga segmen utama: **UMKM (Retail/Grosir/F&B)**, **Distributor B2B**, serta **Sekolah/Instansi Pemerintah/Yayasan** melalui pengaturan profil modul (*Feature Toggles*).

### Tujuan Utama Produk
1. Menghilangkan selisih stok fisik dan catatan (*inventory discrepancy*) melalui pencatatan *real-time* berbasis pemindaian QR/Barcode.
2. Menjamin kontinuitas operasional di area gudang tanpa sinyal internet (*dead-zone*) menggunakan penyimpanan lokal dan antrean sinkronisasi otomatis.
3. Menegakkan tata kelola dan kendali internal (*internal control*) melalui sistem persetujuan berjenjang (*Approval Workflow*) oleh Kepala Gudang, Kepala Sekolah, atau Pemilik Usaha.

---

## 2. Target Pengguna & Persona (User Personas)

| Peran (Role) | Segmen | Tanggung Jawab Utama | Hak Akses Kunci |
| :--- | :--- | :--- | :--- |
| **Owner / Kepala Sekolah / Direktur** | Semua Segmen | Pengawasan aset, analisis nilai stok, persetujuan tingkat tinggi. | Akses penuh, lihat HPP/nilai aset, *Approve* transaksi besar & *Write-off*. |
| **Kepala Gudang / Wakasek Sarpras** | Distributor, Sekolah | Mengatur operasional harian gudang, verifikasi *Stock Opname*, persetujuan permintaan barang. | *Approve* permintaan unit & *adjustment*, atur lokasi rak, *PIN Override* offline. |
| **Staf Gudang / Admin Logistik** | Semua Segmen | Melakukan *inbound*, *picking/outbound*, cetak label QR, dan hitung fisik *opname*. | Input mutasi stok & scan QR; **tidak bisa** melihat HPP atau menghapus transaksi. |
| **Pemohon / Guru / Salesman** | Sekolah, Distributor | Mengajukan permintaan barang habis pakai, peminjaman aset, atau pesanan pelanggan. | Buat draf permintaan (*Request*), lacak status *approval*, tanda tangan BAST. |

---

## 3. Profil Konfigurasi Segmen (Modular Feature Toggles)
Saat registrasi awal (*onboarding*), klien memilih profil organisasi yang secara otomatis menyesuaikan terminologi antarmuka dan mengaktifkan modul yang relevan:

1. **Profil UMKM (Retail, Grosir, F&B):**
   * **Modul Aktif:** Pelacakan *Batch & Expired Date* (metode FEFO), Konversi Satuan Bertingkat (Dus $\rightarrow$ Pack $\rightarrow$ Pcs), Peringatan Stok Minimum via WhatsApp/Notifikasi.
2. **Profil Distributor / B2B:**
   * **Modul Aktif:** Manajemen Multi-Gudang, Transfer Stok Antar-Cabang (*In-Transit Tracking*), Surat Jalan otomatis, Manajemen *Salesman* & Retur Supplier.
3. **Profil Sekolah / Instansi:**
   * **Modul Aktif:** Perubahan istilah *Outbound* menjadi **"Permintaan Unit/Divisi"**, Modul **Peminjaman Aset Tetap** (Proyektor, Alat Lab) lengkap dengan status kondisi (*Baik, Rusak Ringan, Rusak Berat*), serta generator **Berita Acara Serah Terima (BAST)** PDF.

---

## 4. Spesifikasi Fitur Fungsional (Functional Requirements)

### 4.1. Master Data & Katalog Barang (SKU)
* **Identitas & Barcode:** Mendukung pemindaian barcode pabrikan (EAN-13/UPC) serta fitur **Auto-Generate QR Code Internal** bagi barang tanpa barcode.
* **Cetak Label Massal:** Ekspor stiker QR Code ke format PDF siap cetak untuk kertas stiker A4/F4 maupun printer *thermal* Bluetooth (58mm / 80mm).
* **Konversi Satuan (Multi-UOM):** Seluruh stok disimpan dalam **Satuan Dasar Terkecil (Base Unit)** di database (misal: `pcs`), dengan tabel konversi dinamis (misal: `1 Karton = 24 Pcs`) pada form transaksi.
* **Lokasi Penyimpanan (Bin Location):** Struktur hierarki `Zona -> Rak -> Tingkat/Bin` untuk mempercepat pencarian barang.
* **Impor Massal (Bulk Import):** Unggah data katalog awal dan saldo stok melalui file `.xlsx` atau `.csv` dengan validasi otomatis.

### 4.2. Manajemen Pergerakan Stok (Inventory Ledger)
* **Barang Masuk (Inbound):** Pencatatan penerimaan dari Supplier (*Purchase Order*), Retur Pelanggan (layak jual), atau Transfer Masuk. Mendukung input nomor *batch* dan tanggal kedaluwarsa.
* **Barang Keluar (Outbound):** Pengeluaran barang berdasarkan metode **FIFO** (*First-In, First-Out*) atau **FEFO** (*First-Expired, First-Out*) otomatis.
* **Penghapusan & Retur (Write-Off & Return):** Pencatatan barang rusak, pecah, kadaluarsa, atau retur ke supplier. **Wajib melampirkan foto bukti** dari kamera perangkat.
* **Transaksi Immutable (Anti-Hapus):** Transaksi yang telah tersimpan tidak dapat diedit atau dihapus. Koreksi kesalahan hanya dapat dilakukan melalui mekanisme **Void / Pembatalan** yang tercatat dalam *Audit Trail*.

### 4.3. Alur Persetujuan Berjenjang (Approval Workflow)
Sistem menerapkan aturan ambang batas (*Threshold Rules*) yang dapat dikonfigurasi oleh Admin Tenant:
* **Auto-Approved:** Transaksi rutin di bawah batas nominal/kuantitas tertentu langsung diproses.
* **Pending Approval:** Transaksi di atas batas, permintaan aset sekolah, *write-off* barang rusak, *void* transaksi, dan penyesuaian selisih *Stock Opname* akan berstatus `PENDING_APPROVAL` dan mengunci stok sementara (*Reserved Stock*).
* **Otorisasi Jarak Jauh (Online):** Kepala Sekolah / Kepala Gudang menerima notifikasi dan dapat menyetujui (dengan opsi revisi jumlah) atau menolak disertai catatan alasan.
* **Otorisasi di Tempat (Offline Override):** Jika sinyal terputus namun atasan berada di gudang, persetujuan dapat dilakukan langsung di HP staf menggunakan **6-digit PIN Otorisasi Pribadi** atau pemindaian **Kartu ID QR Supervisor**.
* **Pengeluaran Darurat (Emergency Release):** Opsi pengeluaran tanpa sinyal dan tanpa atasan yang otomatis memicu peringatan prioritas tinggi (`FLAGGED_UNVERIFIED`) di *dashboard* pimpinan saat perangkat kembali *online*.

### 4.4. Stock Opname (Audit Fisik)
* **Blind Count Mode:** Staf lapangan hanya melihat nama barang dan lokasi rak tanpa mengetahui angka stok di sistem untuk mencegah manipulasi hitungan.
* **Freeze Stock Opsional:** Kemampuan membekukan transaksi keluar-masuk pada rak tertentu selama proses perhitungan berlangsung.
* **Berita Acara Penyesuaian:** Selisih antara fisik dan sistem otomatis membuat draf *Stock Adjustment* yang membutuhkan persetujuan Kepala Gudang / Kepala Sekolah sebelum saldo resmi diperbarui.

---

## 5. Arsitektur Teknis & Mekanisme *Offline-First*

### 5.1. Prinsip Penyimpanan Lokal (Client-Side Cache & Queue)
Perangkat pengguna (HP/Tablet/PC) **bukan bertindak sebagai server fisik bagi perangkat lain**, melainkan sebagai *Local Source of Truth* mandiri untuk perangkat tersebut:
1. **Service Worker (Serwist/Workbox):** Menyimpan seluruh aset antarmuka (HTML, CSS, JS, ikon) agar aplikasi terbuka instan dalam kondisi tanpa internet.
2. **Local Database (IndexedDB via Dexie.js):** Menyimpan salinan katalog SKU, daftar lokasi rak, aturan konversi satuan, saldo stok terakhir, dan kredensial PIN *offline* terenkripsi.
3. **Outbox / Sync Queue:** Setiap transaksi saat *offline* dicatat sebagai *event* mutasi dengan pengenal unik **UUIDv7** (berbasis urutan waktu) dan stempel waktu lokal (*timestamp*).

### 5.2. Sinkronisasi & Resolusi Konflik (Event-Driven Sync)
* Aplikasi **tidak mengirimkan angka stok akhir** (menghindari penimpaan data antar-perangkat), melainkan mengirimkan *event* perubahan (contoh: `DELTA: -5 PCS`).
* Saat koneksi internet pulih, *Background Sync Worker* mengirimkan antrean mutasi ke server secara berurutan.
* **Penanganan Stok Minus Akibat Transaksi Bersamaan:** Jika dua staf mengeluarkan barang terakhir secara bersamaan saat *offline*, server tetap menerima kedua transaksi agar data lapangan tidak hilang, namun menandai transaksi kedua dengan status **`FLAGGED_OVERDRAFT`** untuk ditinjau Kepala Gudang.

### 5.3. Rekomendasi *Tech Stack*
* **Frontend:** Next.js (App Router), TypeScript, Tailwind CSS, PWA Manifest.
* **Offline & Scanner:** Dexie.js (IndexedDB), Serwist (Service Worker), `zxing-js` / `html5-qrcode` (Kamera Barcode/QR).
* **Backend & Database:** PostgreSQL (Supabase) dengan *Row-Level Security* (RLS) untuk isolasi data *multi-tenant*.
* **Storage & Dokumen:** Cloudflare R2 / Supabase Storage (foto bukti barang rusak & tanda tangan digital), `@react-pdf/renderer` (cetak Surat Jalan, BAST, dan Label QR).

---

## 6. Rancangan Skema Basis Data (Core Database Schema)

Berikut adalah struktur tabel utama pada PostgreSQL (dan cerminan skemanya pada IndexedDB):

```sql
-- 1. Organisasi / Klien SaaS
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    business_profile VARCHAR(30) NOT NULL CHECK (business_profile IN ('UMKM', 'DISTRIBUTOR', 'SCHOOL')),
    subscription_tier VARCHAR(30) DEFAULT 'FREE',
    settings JSONB DEFAULT '{}', -- Menyimpan aturan threshold approval, fitur aktif
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Pengguna & Hak Akses
CREATE TABLE users (
    id UUID PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    full_name VARCHAR(120) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('OWNER', 'HEAD_WAREHOUSE', 'STAFF', 'REQUESTER')),
    offline_pin_hash VARCHAR(255), -- Hash PIN 6-digit untuk otorisasi offline di tempat
    is_active BOOLEAN DEFAULT TRUE
);

-- 3. Lokasi Gudang & Rak
CREATE TABLE warehouses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    address TEXT
);

CREATE TABLE bin_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL, -- Contoh: ZONA-A-RAK01-B2
    description VARCHAR(150)
);

-- 4. Master Barang (SKU)
CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    sku_code VARCHAR(80) NOT NULL,
    barcode VARCHAR(100), -- Barcode pabrikan atau QR internal
    name VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    base_unit VARCHAR(30) NOT NULL, -- Satuan terkecil: pcs, gram, ml
    min_stock_threshold INT DEFAULT 0,
    cost_price NUMERIC(15,2) DEFAULT 0, -- Disembunyikan dari role STAFF
    is_fixed_asset BOOLEAN DEFAULT FALSE, -- TRUE untuk inventaris pinjam-pakai sekolah
    image_url TEXT,
    UNIQUE(tenant_id, sku_code)
);

-- 5. Konversi Satuan (Multi-UOM)
CREATE TABLE item_uom_conversions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    unit_name VARCHAR(30) NOT NULL, -- Contoh: Dus, Lusin, Box
    multiplier_to_base INT NOT NULL -- Contoh: 12 (jika 1 Lusin = 12 Pcs)
);

-- 6. Saldo Stok per Gudang & Batch (FEFO/FIFO)
CREATE TABLE inventory_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id) ON DELETE CASCADE,
    bin_id UUID REFERENCES bin_locations(id),
    item_id UUID REFERENCES items(id) ON DELETE CASCADE,
    batch_number VARCHAR(80) DEFAULT 'DEFAULT',
    expiry_date DATE,
    qty_on_hand INT NOT NULL DEFAULT 0,
    qty_reserved INT NOT NULL DEFAULT 0 -- Stok dikunci menunggu approval
);

-- 7. Dokumen Permintaan & Persetujuan (Approval Header)
CREATE TABLE stock_requests (
    id UUID PRIMARY KEY, -- Menggunakan UUIDv7 dari client untuk dukungan offline
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id),
    request_number VARCHAR(50) NOT NULL,
    request_type VARCHAR(30) NOT NULL CHECK (request_type IN ('INBOUND', 'OUTBOUND', 'ASSET_LOAN', 'WRITE_OFF', 'ADJUSTMENT', 'TRANSFER')),
    status VARCHAR(30) NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'COMPLETED', 'VOIDED')),
    requested_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approval_method VARCHAR(30), -- 'ONLINE_REMOTE', 'OFFLINE_PIN_OVERRIDE', 'AUTO_APPROVED', 'EMERGENCY_UNVERIFIED'
    rejection_reason TEXT,
    evidence_photo_url TEXT,
    digital_signature_url TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Buku Besar Mutasi Stok (Immutable Event Ledger)
CREATE TABLE stock_ledger (
    id UUID PRIMARY KEY, -- UUIDv7
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    warehouse_id UUID REFERENCES warehouses(id),
    item_id UUID REFERENCES items(id),
    request_id UUID REFERENCES stock_requests(id),
    batch_number VARCHAR(80),
    qty_delta INT NOT NULL, -- Positif (+) untuk masuk, Negatif (-) untuk keluar
    is_overdraft_flagged BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id),
    device_id VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL
);
```

---

## 7. Kebutuhan Non-Fungsional (Non-Functional Requirements)
1. **Kecepatan Pemindaian (Scan Latency):** Pembacaan QR/Barcode via kamera HP harus mendeteksi kode dalam waktu **< 800 milidetik** pada pencahayaan standar gudang (dilengkapi tombol *toggle* lampu *flash/torch* HP).
2. **Kapasitas Penyimpanan Offline:** Database lokal IndexedDB harus mampu menyimpan minimal **10.000 SKU** dan **2.000 antrean transaksi offline** tanpa menurunkan performa *rendering* antarmuka.
3. **Keamanan & Isolasi Data:** Seluruh kueri API wajib melewati autentikasi JWT dengan kebijakan *Row-Level Security* (RLS) sehingga satu *tenant* mustahil mengakses data *tenant* lain.
4. **Indikator Status Sinkronisasi Persisten:** *Header* aplikasi wajib menampilkan indikator warna jaringan (*Online/Syncing/Offline*) dan jumlah transaksi dalam antrean *Outbox* disertai peringatan agar pengguna tidak menghapus *cache/data* peramban sebelum proses *sync* selesai.

---

## 8. Peta Jalan Pengembangan (MVP Roadmap)

### Fase 1: Fondasi Core & Offline Engine (Minggu 1–3)
* Setup proyek Next.js PWA + Supabase + Skema PostgreSQL & RLS.
* Implementasi mesin penyimpanan lokal (Dexie.js) dan antrean sinkronisasi berbasis UUIDv7.
* Fitur Master Data SKU, Konversi Satuan, dan Cetak Label QR Code.

### Fase 2: Transaksi Gudang & Mobile Scanner (Minggu 4–6)
* Integrasi pemindai kamera HP (*Inbound*, *Outbound*, dan Pencarian Cepat).
* Implementasi logika pemotongan stok FIFO & FEFO (*Batch & Expired Date*).
* Fitur *Bulk Import* Excel untuk migrasi data klien baru.

### Fase 3: Tata Kelola, Approval, & Profil Segmen (Minggu 7–9)
* Sistem *Approval Workflow* berjenjang (Online Remote & Offline PIN Override).
* Modul *Blind Stock Opname* dan *Write-off* barang rusak wajib foto.
* Kustomisasi tampilan profil **Sekolah/Instansi** (Peminjaman Aset & Cetak BAST PDF) serta **Distributor** (Surat Jalan & Multi-Gudang).

### Fase 4: Monetisasi SaaS & Peluncuran (Minggu 10–12)
* Halaman *Onboarding* mandiri, pembatasan kuota paket (*Free, Pro, Enterprise*), dan integrasi *payment gateway* langganan.
* Pengujian beban (*stress test*) sinkronisasi *offline-to-online* secara bersamaan.