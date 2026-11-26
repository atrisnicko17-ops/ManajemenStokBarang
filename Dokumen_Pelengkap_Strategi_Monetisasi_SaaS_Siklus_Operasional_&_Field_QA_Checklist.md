# Dokumen Pelengkap: Strategi Monetisasi SaaS, Siklus Operasional & Field QA Checklist
**Produk:** GudangKu WMS (Multi-Tenant, Offline-First, Multi-Profile)  
**Target Segmen:** UMKM / Retail, Distributor B2B, Sekolah / Instansi Pendidikan

---

## 1. Strategi Monetisasi & Manajemen Langganan SaaS

### A. Matriks Paket Layanan (Pricing Tiers)
| Fitur & Kapasitas | Starter (Gratis / Lead Magnet) | Pro (UMKM & Sekolah) | Enterprise (Distributor / Yayasan) |
| :--- | :--- | :--- | :--- |
| **Jumlah Gudang / Unit** | 1 Gudang | Hingga 3 Gudang | Tidak Terbatas (Multi-Cabang) |
| **Kapasitas Master SKU** | Maks. 100 SKU | Maks. 2.500 SKU | Tidak Terbatas |
| **Jumlah Pengguna (RBAC)** | 1 Admin | Hingga 5 Staf + 1 Approver | Tidak Terbatas + Custom Role |
| **Mode Offline & Sync Queue** | Dasar (Maks. 20 antrean) | Penuh + Offline PIN Override | Penuh + Prioritas Sync & Multi-PIN |
| **Profil Bisnis** | UMKM Dasar | UMKM / Sekolah (BAST & Pinjam Aset) | Semua Profil + Multi-Unit Yayasan |
| **Cetak Label & Dokumen** | Standar | Thermal 58/80mm + A4/F4 BAST | Custom Kop Surat & Watermark QR |
| **Audit Trail & Backup** | Riwayat 7 hari | Riwayat 1 tahun | Permanen + Webhook / API Integrasi |

### B. Mekanisme *Offline Subscription Grace Period*
Karena aplikasi digunakan di area gudang yang sering kehilangan sinyal, sistem langganan tidak boleh memblokir operasional secara mendadak saat perangkat sedang *offline*:
1. **Token Masa Aktif Lokal:** Saat perangkat terhubung ke internet, aplikasi menyimpan stempel waktu `subscription_valid_until` yang ditandatangani secara kriptografis oleh server.
2. **Toleransi 72 Jam (*Grace Period*):** Jika tanggal kedaluwarsa terlewati saat HP sedang *offline*, sistem tetap mengizinkan pencatatan transaksi keluar/masuk selama **72 jam** dengan banner peringatan kuning di bagian atas layar.
3. **Mode Read-Only Pasca-Tenggang:** Setelah masa tenggang habis dan perangkat berhasil menyinkronkan seluruh antrean tertunda ke server, akun otomatis beralih ke mode **Baca-Saja (Read-Only)**—data tetap aman dan bisa diekspor ke Excel/PDF, tetapi pembuatan transaksi baru dikunci hingga perpanjangan paket selesai.

---

## 2. Manajemen Siklus Media & Penyimpanan (*Storage Lifecycle*)

Foto bukti kerusakan barang (*write-off*) dan tanda tangan digital (*e-signature* BAST) berpotensi membengkakkan biaya penyimpanan *cloud* jika tidak dikendalikan sejak awal:

1. **Kompresi Wajib di Sisi Klien (Browser/HP):**
   * Foto dari kamera HP otomatis diubah ukurannya (*resize*) ke lebar maksimal `1024px` dan dikonversi ke format **WebP (kualitas 75%)** sebelum disimpan ke *IndexedDB* (target ukuran **< 120 KB per foto**).
   * Tanda tangan digital disimpan sebagai vektor ringan atau PNG transparan beresolusi `400x200px` (**< 25 KB**).
2. **Pemisahan Antrean Media (*Two-Stage Sync*):**
   * Saat sinyal lemah, aplikasi memprioritaskan pengiriman **data teks transaksi (JSON)** terlebih dahulu agar angka stok di pusat langsung akurat.
   * Unggahan file gambar dijadwalkan pada antrean latar belakang berikutnya menggunakan URL unggah langsung (*Presigned URL* ke Cloudflare R2 / Supabase Storage).
3. **Kebijakan Retensi Arsip:**
   * **Tier Starter:** Foto bukti disimpan selama 90 hari.
   * **Tier Pro & Enterprise:** Foto bukti disimpan aktif selama 1 tahun, lalu otomatis diarsipkan ke penyimpanan dingin (*Cold Storage*), sementara catatan teks transaksi dan nomor referensi di *Audit Trail* tetap tersimpan permanen.

---

## 3. Pemulihan Data Darurat (*Disaster Recovery* Perangkat Lapangan)

Risiko utama arsitektur *offline-first* adalah kerusakan fisik atau hilangnya perangkat staf saat masih menyimpan antrean transaksi yang belum terkirim ke *cloud*:

1. **Perlindungan Penghapusan Cache Browser:**
   * Aplikasi memanggil `navigator.storage.persist()` saat login pertama agar sistem operasi ponsel tidak membersihkan *IndexedDB* secara otomatis saat memori penuh.
   * Menampilkan peringatan keras pada menu pengaturan browser/aplikasi apabila `pending_sync_count > 0`.
2. **Fitur Ekspor Antrean Darurat (*Emergency JSON Dump*):**
   * Tersedia di menu **Riwayat Sync > Opsi Darurat > Ekspor Antrean Lokal (.json)**.
   * Jika modul Wi-Fi/seluler pada HP gudang rusak total namun layar masih menyala, staf dapat mengekspor antrean mutasi terenkripsi tersebut dan mengirimkannya via Bluetooth atau kabel USB ke laptop Admin untuk diunggah melalui fitur **Manual Sync Recovery** di *Control Tower*.

---

## 4. Alur Onboarding Klien & Migrasi Data (*Zero-Friction Setup*)

Agar klien baru (sekolah maupun UMKM/distributor) dapat mulai beroperasi dalam waktu kurang dari 5 menit:

### Langkah 1: Wizard Pemilihan Profil (Saat Registrasi Tenant)
1. **Pilih Tipe Organisasi:**
   * *Sekolah / Yayasan / Instansi* (Mengaktifkan istilah Unit/Divisi, BAST, dan Peminjaman Aset).
   * *UMKM / Toko Retail / F&B* (Mengaktifkan konversi satuan dus-pcs dan pelacakan FEFO).
   * *Distributor / Gudang B2B* (Mengaktifkan Surat Jalan, PO, dan transfer multi-gudang).
2. **Atur Kebijakan Persetujuan:** Aktifkan/nonaktifkan syarat persetujuan Kepala Sekolah atau Kepala Gudang beserta penetapan **PIN Otorisasi 6-Digit**.
3. **Pilih Sumber Data Awal:**
   * *Impor dari Excel (.xlsx/.csv)* menggunakan template baku.
   * *Gunakan Data Contoh (Sandbox)* untuk simulasi internal sebelum penggunaan nyata.

### Langkah 2: Validator Impor Excel Cerdas
* Sistem memeriksa duplikasi `SKU`, format angka stok/HPP, serta kesesuaian nama satuan sebelum menyimpan ke database.
* Baris yang bermasalah ditandai merah pada tabel pratinjau agar admin dapat langsung memperbaikinya di layar tanpa perlu mengunggah ulang berkali-kali.

---

## 5. Daftar Periksa Pengujian Lapangan (*Field QA & Chaos Testing Checklist*)

Sebelum aplikasi dirilis ke lingkungan produksi (*production*), seluruh skenario berikut wajib lulus pengujian pada perangkat Android kelas menengah (RAM 4–6 GB):

### A. Pengujian Konektivitas & Sinkronisasi
- [ ] **Airplane Mode Total:** Aplikasi tetap dapat dibuka dari ikon *Home Screen* PWA setelah browser ditutup paksa (*force close*) dalam kondisi tanpa internet.
- [ ] **Skenario *Lie-Fi* (Wi-Fi Tanpa Internet):** Ketika terhubung ke router yang kabel internetnya dicabut, aplikasi beralih ke mode antrean lokal dalam waktu maksimal **3,5 detik** tanpa layar membeku (*infinite loading*).
- [ ] **Idempotensi Jaringan Putus-Nyambung:** Memutus koneksi internet tepat di tengah proses *sync* 20 transaksi tidak menyebabkan pemotongan stok ganda saat jaringan tersambung kembali.
- [ ] **Resolusi Bentrok Stok (*Race Condition*):** Dua perangkat melakukan *outbound* secara *offline* atas sisa stok terakhir yang sama; saat keduanya *online*, server memproses berurutan dan memunculkan status `FLAGGED_OVERDRAFT` di *Audit Trail*.

### B. Pengujian Keamanan & Kontrol Internal
- [ ] **Isolasi HPP Staf Lapangan:** Memeriksa tab *Network / DevTools* pada akun ber-role `OPERATOR` memastikan kolom `cost_price` (harga modal) tidak pernah dikirimkan oleh API server.
- [ ] **Kunci Percobaan PIN Offline:** Memasukkan PIN salah sebanyak 3 kali berturut-turut saat mode *offline* mengunci modal *PIN Override* selama 15 menit dan mencatat log pelanggaran ke *Sync Queue*.
- [ ] **Immutability Audit Log:** Memastikan tidak ada tombol maupun endpoint API yang dapat menghapus atau mengubah riwayat transaksi yang sudah berstatus `COMPLETED` (hanya bisa melalui alur `VOID` dengan persetujuan atasan).

### C. Pengujian Ergonomi Gudang
- [ ] **Pemindaian di Pencahayaan Redup:** Tombol lampu senter (*Torch/Flashlight*) pada pemindai kamera web berfungsi normal saat memindai stiker QR di rak bagian dalam.
- [ ] **Keterbacaan Stiker Cetak:** Hasil cetak label QR menggunakan printer *thermal* 58mm maupun kertas stiker A4 dapat dipindai dalam waktu kurang dari **1,5 detik**.