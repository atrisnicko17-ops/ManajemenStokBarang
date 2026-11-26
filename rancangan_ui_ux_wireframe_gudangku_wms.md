# Rancangan UI/UX & Spesifikasi Wireframe — GudangKu WMS

**Versi Dokumen:** 1.0  
**Target Platform:** Mobile-First PWA (Android/iOS) & Desktop/Tablet Control Tower  
**Prinsip Desain:** *Thumb-Friendly Field Operations, Zero-Ambiguity Network Status, Role-Based Information Density*

---

## 1. Filosofi & Prinsip Pengalaman Pengguna (UX Principles)

1. **Kejelasan Status Jaringan Persisten (Zero-Ambiguity Sync State):**
   Staf di dalam gudang sering berpindah dari area ber-sinyal ke *dead-zone* tanpa sadar. *Header* aplikasi wajib mempertahankan bilah status jaringan yang kontras (**Hijau** = *Synced*, **Kuning** = *Syncing*, **Merah** = *Offline + Jumlah Antrean*).
2. **Ergonomi Satu Tangan (Thumb-Zone Optimization):**
   Pada tampilan *Mobile* (Staf Gudang), tombol aksi utama (**Scan QR/Barcode**) diletakkan di area jangkauan ibu jari dengan tinggi minimal `64px–72px`, menghindari elemen kecil yang sulit ditekan saat memegang barang.
3. **Pemisahan Kepadatan Informasi Berdasarkan Peran (Role-Calibrated Density):**
   * **Staf Gudang:** Antarmuka minimalis, ikon besar, tanpa angka finansial (HPP/nilai aset disembunyikan).
   * **Kepala Sekolah / Kepala Gudang:** Fokus pada kartu keputusan cepat (*Approval Cards*) dengan informasi konteks stok dan lampiran bukti foto dalam satu pandangan.
   * **Admin / Owner:** Tabel berdensitas tinggi (*data-dense*), grafik ringkasan, *Audit Trail*, dan alat administrasi massal.
4. **Adaptasi Terminologi Otomatis (Contextual Labeling):**
   Label antarmuka menyesuaikan profil *tenant* (`SCHOOL` vs `UMKM/DISTRIBUTOR`) tanpa mengubah struktur tata letak (*layout*).

---

## 2. Sistem Desain & Panduan Visual (Design System)

### 2.1. Palet Warna Semantik (Semantic Color Tokens)
| Peran Warna | Kode Hex | Penggunaan di Antarmuka |
| :--- | :--- | :--- |
| **Primary Brand (Royal Blue)** | `#2563EB` | Tombol utama (*Scan QR*, *Simpan*), transaksi *Outbound*, navigasi aktif. |
| **Success / Synced (Emerald)** | `#16A34A` | Status *Online/Synced*, status `APPROVED`, transaksi *Inbound*, tanda tangan BAST sah. |
| **Warning / Pending (Amber)** | `#D97706` | Status *Syncing*, dokumen `PENDING_APPROVAL`, peringatan *Stok Menipis*, tombol *PIN Override*. |
| **Danger / Offline (Crimson)** | `#DC2626` | Status *Offline Mode*, laporan *Write-off / Barang Rusak*, status `REJECTED`, anomali *Overdraft*. |
| **Neutral Surface (Slate)** | `#F8FAFC` / `#0F172A` | Latar kanvas aplikasi (`#F8FAFC`) dan *header* kontras tinggi (`#0F172A`). |

### 2.2. Tipografi & Skala Ukuran
* **Font Antarmuka Utama:** `Inter` (Sans-Serif) — keterbacaan tinggi pada layar kecil maupun tabel padat.
* **Font Kode & Angka Teknis:** `JetBrains Mono` (Monospace) — wajib digunakan untuk **Kode SKU, Lokasi Rak (`ZONA-A/RAK-01`), Nomor Tiket (`#REQ-1041`), dan Nominal Valuasi/Stok** agar angka sejajar lurus (*tabular figures*).

---

## 3. Arsitektur Informasi & Peta Navigasi (User Flow)

```text
[Login / Pilih Workspace]
       │
       ├──► (Role: STAF GUDANG - Mobile PWA)
       │       ├──► Beranda (Scan QR CTA + 4 Aksi Cepat + Tiket Siap Serah)
       │       ├──► Kamera Pemindai QR/Barcode ──► Form Mutasi (Multi-UOM)
       │       │        ├──► [Rutin & Online] ──► Potong Stok Langsung
       │       │        ├──► [Butuh Approval & Online] ──► Kirim ke Approver (Stok Reserved)
       │       │        └──► [Butuh Approval & Offline] ──► PIN Override Supervisor / Antrean Outbox
       │       ├──► Tiket Approved ──► Layar Serah Terima & Tanda Tangan Digital (BAST)
       │       └──► Blind Stock Opname (Hitung Fisik Tanpa Lihat Saldo Sistem)
       │
       ├──► (Role: KEPALA SEKOLAH / KEPALA GUDANG - Mobile/Tablet)
       │       ├──► Approval Inbox (Filter: Permintaan Unit / Write-off Rusak / Selisih Opname)
       │       ├──► Detail Pengajuan ──► Lihat Foto Bukti & Revisi Jumlah ──► Approve / Reject
       │       └──► Kartu PIN Pribadi (6-Digit PIN untuk Otorisasi Offline di Gudang)
       │
       └──► (Role: ADMIN / OWNER - Desktop Control Tower)
               ├──► Dashboard Eksekutif (KPI Valuasi HPP, Stok Kritis, Status Perangkat Offline)
               ├──► Master Data SKU (Konversi Satuan, Bulk Import Excel, Generator Stiker QR)
               └──► Immutable Audit Trail (Log Event-Driven Ledger & Deteksi Overdraft)
```

---

## 4. Rincian Wireframe per Peran (Screen-by-Screen Blueprint)

### 4.1. Peran 1: Staf Gudang (Mobile PWA — Lebar Target `360px–430px`)

#### Layar 1A: Beranda Operasional Gudang (`Warehouse Home`)
```text
+-------------------------------------------------------+
| [LOGO] SMA Shine Nusantara / CV. Maju          [BD]   |
|        Gudang Utama                                   |
| +---------------------------------------------------+ |
| | 🟢 ONLINE • Tersinkronisasi                       | | <-- Sticky Network Bar
| +---------------------------------------------------+ |
+-------------------------------------------------------+
|                                                       |
|  +-------------------------------------------------+  |
|  |  [📷]  SCAN BARCODE / QR BARANG              >  |  | <-- Primary Thumb CTA (72px)
|  |        Cek rak, stok fisik, atau transaksi cepat|  |
|  +-------------------------------------------------+  |
|                                                       |
|  AKSI CEPAT GUDANG                                    |
|  +-----------------------+  +-----------------------+  |
|  | [↙️] Barang Masuk     |  | [↗️] Permintaan Unit  |  | <-- Label adaptif per profil
|  | Terima PO / Retur     |  | Pengambilan / Aset    |  |
|  +-----------------------+  +-----------------------+  |
|  +-----------------------+  +-----------------------+  |
|  | [⚠️] Lapor Rusak      |  | [📋] Stock Opname     |  |
|  | Write-off + Wajib Foto|  | Blind Count Rak       |  |
|  +-----------------------+  +-----------------------+  |
|                                                       |
|  TIKET DISETUJUI (SIAP SERAH)              [1 Tiket]  |
|  +-------------------------------------------------+  |
|  | #REQ-1039  [APPROVED]                           |  |
|  | Proyektor Epson EB-X500                         |  |
|  | Jumlah: 1 Unit • Lab IPA (Ibu Rina Wati)        |  |
|  | [ ✍️ Serahkan & Tanda Tangani (BAST) ]          |  |
|  +-------------------------------------------------+  |
|                                                       |
|  SALDO FISIK GUDANG (TANPA INFO HPP)                  |
|  +-------------------------------------------------+  |
|  | Kertas F4 75gr Sinar Dunia            42 Rim    |  |
|  | ZONA-A / RAK-01                     (10 dikunci)|  |
|  +-------------------------------------------------+  |
+-------------------------------------------------------+
```

#### Layar 1B: Pemindai Kamera QR/Barcode (`Camera Scanner Overlay`)
* **Komponen Utama:** *Viewfinder* rasio 1:1 dengan bingkai sudut hijau (`#22C55E`), animasi garis laser horizontal, tombol *toggle* lampu *flash/torch* HP untuk lorong gelap, dan kolom pencarian manual cepat di bagian bawah jika stiker rusak.

#### Layar 1C: Form Transaksi & Konversi Satuan (`Transaction Sheet`)
```text
+-------------------------------------------------------+
| OUTBOUND / PENGELUARAN                            [X] |
| Permintaan Unit / Barang Keluar                       |
+-------------------------------------------------------+
| PILIH BARANG / SKU                                    |
| [ ATK-F4-75 — Kertas F4 75gr Sinar Dunia          ▾ ] |
| +---------------------------------------------------+ |
| | Rak: ZONA-A / RAK-01          Tersedia: 42 Rim    | |
| +---------------------------------------------------+ |
|                                                       |
| JUMLAH                       SATUAN (MULTI-UOM)       |
| [ - ]   [  2  ]   [ + ]      [ Box (5 Rim)        ▾ ] |
|                                                       |
| +---------------------------------------------------+ |
| | Total Konversi Satuan Dasar:              10 Rim  | | <-- Kalkulasi Real-Time
| +---------------------------------------------------+ |
|                                                       |
| UNIT / GURU PEMOHON                                   |
| [ Panitia Ujian Akhir Semester                      ] |
|                                                       |
| [⚠️] Membutuhkan Persetujuan Kepala Sekolah           | <-- Muncul jika > threshold
|      Jumlah (10 Rim) melebihi batas rutin (> 5 Rim).  |
|                                                       |
| +---------------------------------------------------+ |
| | [🔑] Otorisasi Langsung di Tempat (PIN Kepsek)    | | <-- Jika Mode Offline
| +---------------------------------------------------+ |
| | Simpan ke Antrean Sync (Tunggu Sinyal)            | |
| +---------------------------------------------------+ |
+-------------------------------------------------------+
```

#### Layar 1D: Layar Serah Terima & Tanda Tangan Digital (`BAST Fulfillment`)
* **Komponen Utama:** Ringkasan nomor tiket (`#REQ-1039`), nama barang, jumlah final yang disetujui, area kanvas sentuh (*HTML5 Canvas Signature Pad*) dengan tombol *Ulangi TTD*, serta tombol konfirmasi yang memotong saldo `Reserved Stock` dan menerbitkan dokumen BAST PDF.

---

### 4.2. Peran 2: Kepala Sekolah / Kepala Gudang (Approver View)

#### Layar 2A: Kotak Masuk Persetujuan & Kartu PIN (`Approval Inbox`)
```text
+-----------------------------------------------------------------------+
| KEPALA SEKOLAH                                      [🔑 PIN Override] |
| Drs. Hendra Wijaya, M.Pd • SMA Shine Nusantara         PIN: 123456    |
+-----------------------------------------------------------------------+
| KOTAK MASUK PERSETUJUAN (2)                                           |
|                                                                       |
| +-------------------------------------------------------------------+ |
| | [⚠️ WRITE-OFF / BARANG RUSAK]  #REQ-1042 • 24 menit lalu          | |
| | Tinta Printer Epson 003 Hitam              Stok Fisik: 6 Botol    | |
| | Tujuan: Gudang Utama (Kerusakan Rak)                              | |
| | ----------------------------------------------------------------- | |
| | Jumlah Diajukan : 2 Botol                                         | |
| | Alasan          : Segel botol bocor saat pemindahan rak           | |
| | Bukti Foto      : [🖼️ IMG_BUKTI_01.JPG — Terverifikasi]           | |
| | ----------------------------------------------------------------- | |
| | Revisi Jumlah: [ 2 ] Botol          [ Tolak ]  [✓ Setujui Dokumen]| |
| +-------------------------------------------------------------------+ |
+-----------------------------------------------------------------------+
```

#### Layar 2B: Modal Otorisasi PIN di Tempat (`Offline Supervisor PIN Pad`)
* **Komponen Utama:** Indikator 6 titik PIN tersembunyi (`• • • • • •`), *keypad* numerik besar (`0–9`, `Clear`, `Backspace`) yang ramah sentuhan layar HP staf, dan validasi *hash* PIN lokal sehingga transaksi sah tanpa koneksi internet.

---

### 4.3. Peran 3: Admin / Owner (Desktop Control Tower — Lebar Target `1024px–1440px`)

#### Layar 3A: Dashboard Eksekutif, Master SKU & Audit Trail
```text
+-----------------------------------------------------------------------------------+
| EXECUTIVE CONTROL TOWER                                    [Reset Data Simulasi]  |
| SMA Shine Nusantara / CV. Maju Distribusi Nusantara                               |
+-----------------------------------------------------------------------------------+
| +-------------------+ +-------------------+ +-------------------+ +-------------+ |
| | TOTAL NILAI STOK  | | SKU STOK KRITIS   | | MENUNGGU APPROVAL | | STATUS HP   | |
| | Rp 65.100.000     | | 1 SKU             | | 2 Dokumen         | | Synced      | |
| +-------------------+ +-------------------+ +-------------------+ +-------------+ |
|                                                                                   |
| MASTER DATA SKU, LOKASI RAK & VALUASI HPP                                         |
| +------------+--------------------------+---------------+------------+----------+ |
| | Kode SKU   | Nama Barang              | Lokasi Rak    | Fisik      | Aksi     | |
| +------------+--------------------------+---------------+------------+----------+ |
| | ATK-F4-75  | Kertas F4 75gr           | ZONA-A/RAK-01 | 42 Rim     | [QR]     | |
| | ATK-TNT-BK | Tinta Printer Epson 003  | ZONA-A/RAK-03 | 6 Botol    | [QR][PO] | |
| +------------+--------------------------+---------------+------------+----------+ |
|                                                                                   |
| IMMUTABLE AUDIT TRAIL (BUKU BESAR MUTASI STOK)                                    |
| +-------------------------------------------------------------------------------+ |
| | [PIN_OVERRIDE_APPROVED] Tinta Printer (-2 Botol) • Aktor: Kepsek • Offline    | |
| | [INBOUND] Kertas F4 75gr (+50 Rim) • Aktor: Budi (Staf) • Cloud (Online)      | |
| +-------------------------------------------------------------------------------+ |
+-----------------------------------------------------------------------------------+
```

---

## 5. Matriks Perilaku Interaksi (State & Edge-Case Matrix)

| Skenario Lapangan | Kondisi Jaringan | Perilaku Antarmuka (UI Feedback) | Perubahan Status Data |
| :--- | :--- | :--- | :--- |
| **Scan QR / Transaksi Rutin (`<= 5 unit`)** | `ONLINE` | Toast hijau *"Transaksi berhasil dicatat"*, saldo langsung berkurang. | Langsung masuk ke `stock_ledger` di Cloud. |
| **Scan QR / Transaksi Rutin (`<= 5 unit`)** | `OFFLINE` | Toast kuning *"Tersimpan di memori HP"*, lencana antrean bertambah (`+1 Queue`). | Disimpan di IndexedDB `offlineQueue`. |
| **Pengajuan Besar / Barang Rusak** | `ONLINE` | Tombol utama berwarna Amber: *"Kirim Pengajuan ke Pimpinan"*. | Stok dipindah ke `qty_reserved`, status `PENDING_APPROVAL`. |
| **Pengajuan Besar / Barang Rusak** | `OFFLINE` | Muncul dua opsi: **Otorisasi PIN di Tempat** atau **Simpan ke Antrean Sync**. | Jika via PIN, stok langsung terpotong & tercatat sebagai `OFFLINE_PIN_OVERRIDE`. |
| **Lapor Barang Rusak Tanpa Foto** | `ONLINE / OFFLINE` | Tombol simpan ditolak dengan pesan error merah: *"Wajib lampirkan foto bukti!"*. | Mencegah pengiriman data (*client-side validation*). |
| **Perangkat Kembali Online** | `OFFLINE -> ONLINE` | Bilah atas berubah kuning (*"SYNCING..."*) selama ~1.5 detik, lalu kembali hijau. | Seluruh `offlineQueue` dikirim berurutan (UUIDv7) ke server pusat. |

---

## 6. Spesifikasi Responsivitas & Aksesibilitas

* **Target Ukuran Sentuh (Touch Target):** Seluruh tombol interaktif pada layar *Mobile* memiliki dimensi minimal `44px × 44px` dengan jarak antar-tombol minimal `8px` untuk mencegah salah tekan (*mis-tap*).
* **Kontras Pencahayaan Gudang:** Menggunakan rasio kontras teks minimal **7:1 (WCAG AAA)** pada label status jaringan dan informasi stok agar tetap terbaca jelas di bawah pencahayaan lampu gudang yang redup maupun silau matahari di area bongkar muat (*loading dock*).
* **Dukungan Cetak Fisik (Print Media Query):** Modal pratinjau label stiker QR dirancang kompatibel dengan ukuran kertas gulung *thermal* `58mm` / `80mm` maupun stiker label grid `A4`.