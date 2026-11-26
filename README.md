# GudangKu WMS — Modular Multi-Tenant & Offline-First PWA

Sistem manajemen stok gudang dan inventaris aset berbasis **Progressive Web App (PWA)** yang dirancang untuk tetap beroperasi penuh di area tanpa sinyal internet (*dead-zone*) bagi tiga segmen: **Sekolah/Yayasan**, **UMKM (Retail/F&B)**, dan **Distributor B2B**.

## Fitur Utama yang Telah Diimplementasikan
1. **Multi-Tenant & Adaptasi Profil Otomatis (`SCHOOL`, `UMKM`, `DISTRIBUTOR`):** Menyesuaikan terminologi antarmuka, pelacakan kedaluwarsa **FEFO/FIFO**, konversi satuan bertingkat (**Multi-UOM**), transfer antar-gudang, serta modul **Peminjaman Aset Tetap** dan cetak **BAST**.
2. **Arsitektur Offline-First (Dexie.js IndexedDB + Service Worker):**
   - Antrean mutasi berbasis **RFC 9562 UUIDv7** yang idempoten saat koneksi terputus-nyambung.
   - Deteksi *Lie-Fi* (Wi-Fi tanpa internet) otomatis dalam **&le; 3,5 detik** tanpa membekukan layar.
   - Deteksi bentrok stok minus antar-perangkat dengan penanda **`FLAGGED_OVERDRAFT`**.
   - Fitur **Emergency JSON Dump** dan **Manual Sync Recovery** untuk pemulihan perangkat rusak.
3. **Tata Kelola & Keamanan Berlapis (OWASP & PostgreSQL Hardened):**
   - Persetujuan berjenjang (*Online Remote*, *Offline 6-Digit PIN Override* berbasis Web Crypto `PBKDF2` `< 50ms` dengan kunci 15 menit setelah 3x salah, serta *Emergency Release*).
   - Isolasi ketat kolom HPP (`cost_price`) dari peran non-Admin baik di level aplikasi maupun *Column-Level Privilege* PostgreSQL + `security_invoker = true` View.
   - Buku besar mutasi anti-hapus (*Immutable Ledger*) yang dikawal trigger database dan prosedur pembalikan **`VOID_REVERSAL`**.
   - Kompresi foto bukti barang rusak ke **WebP (`< 120 KB`)** dengan verifikasi *magic bytes* asli, serta sanitasi anti-*CSV Formula Injection*.

## Cara Menjalankan Secara Lokal

```bash
# 1. Jalankan server pengembangan (langsung aktif dengan Sandbox Lokal 3 Segmen)
npm run dev

# 2. Jalankan pemeriksaan tipe TypeScript & seluruh pengujian otomatis (Unit + Chaos QA)
npm run typecheck
npm test

# 3. Bangun paket produksi
npm run build
```

## Menghubungkan ke Cloud Supabase
1. Salin `.env.example` menjadi `.env.local` dan isi `NEXT_PUBLIC_SUPABASE_URL` serta `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. Jalankan keempat berkas migrasi di folder `supabase/migrations/` secara berurutan (`001` hingga `004`) pada proyek Supabase Anda.
