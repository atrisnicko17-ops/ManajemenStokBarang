import type { BusinessProfile, UserRole } from './types';

export interface ProfileTerminology {
  profileLabel: string;
  outboundActionTitle: string;
  outboundActionSubtitle: string;
  partyFieldLabel: string;
  partyPlaceholder: string;
  approverTitle: string;
  adminTitle: string;
  operatorTitle: string;
  requesterTitle: string;
  handoverDocumentName: string;
  handoverShortCode: string;
  enableFefoExpiry: boolean;
  enableFixedAssetLoan: boolean;
  enableMultiWarehouseTransfer: boolean;
}

const TERMINOLOGY_MAP: Record<BusinessProfile, ProfileTerminology> = {
  SCHOOL: {
    profileLabel: 'Sekolah / Yayasan / Instansi',
    outboundActionTitle: 'Permintaan unit',
    outboundActionSubtitle: 'Pengambilan barang & pinjam aset',
    partyFieldLabel: 'Unit / guru pemohon',
    partyPlaceholder: 'Contoh: Lab IPA — Ibu Rina Wati',
    approverTitle: 'Kepala Sekolah / Wakasek Sarpras',
    adminTitle: 'Yayasan / Admin Inventaris',
    operatorTitle: 'Staf Gudang Sarpras',
    requesterTitle: 'Guru / Unit Pemohon',
    handoverDocumentName: 'Berita Acara Serah Terima (BAST)',
    handoverShortCode: 'BAST',
    enableFefoExpiry: false,
    enableFixedAssetLoan: true,
    enableMultiWarehouseTransfer: false,
  },
  UMKM: {
    profileLabel: 'UMKM / Retail / F&B',
    outboundActionTitle: 'Barang keluar',
    outboundActionSubtitle: 'Penjualan / produksi FEFO',
    partyFieldLabel: 'Tujuan / pelanggan / dapur',
    partyPlaceholder: 'Contoh: Outlet Cabang Pasar Baru',
    approverTitle: 'Kepala Toko / Supervisor',
    adminTitle: 'Pemilik Usaha (Owner)',
    operatorTitle: 'Staf Gudang / Kasir',
    requesterTitle: 'Staf Produksi',
    handoverDocumentName: 'Bukti Pengeluaran Barang',
    handoverShortCode: 'BPB',
    enableFefoExpiry: true,
    enableFixedAssetLoan: false,
    enableMultiWarehouseTransfer: false,
  },
  DISTRIBUTOR: {
    profileLabel: 'Distributor / Grosir B2B',
    outboundActionTitle: 'Pengiriman B2B',
    outboundActionSubtitle: 'Picking & Surat Jalan cabang',
    partyFieldLabel: 'Toko pelanggan / cabang tujuan',
    partyPlaceholder: 'Contoh: Toko Sinar Jaya — Salesman Andi',
    approverTitle: 'Kepala Gudang Logistik',
    adminTitle: 'Direktur Operasional',
    operatorTitle: 'Admin Logistik / Picker',
    requesterTitle: 'Salesman B2B',
    handoverDocumentName: 'Surat Jalan Pengiriman (DO)',
    handoverShortCode: 'SJ-DO',
    enableFefoExpiry: true,
    enableFixedAssetLoan: false,
    enableMultiWarehouseTransfer: true,
  },
};

export function getProfileTerminology(profile: BusinessProfile): ProfileTerminology {
  return TERMINOLOGY_MAP[profile];
}

export function getRoleDisplayLabel(role: UserRole, profile: BusinessProfile): string {
  const terms = TERMINOLOGY_MAP[profile];
  switch (role) {
    case 'ADMIN':
      return terms.adminTitle;
    case 'APPROVER':
      return terms.approverTitle;
    case 'OPERATOR':
      return terms.operatorTitle;
    case 'REQUESTER':
      return terms.requesterTitle;
  }
}
