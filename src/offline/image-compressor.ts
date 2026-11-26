const MAX_RAW_FILE_BYTES = 10 * 1024 * 1024; // 10 MB batas input kamera HP
const TARGET_MAX_WIDTH_PX = 1024;
const TARGET_MAX_EVIDENCE_BYTES = 120 * 1024; // < 120 KB sesuai spesifikasi Storage Lifecycle

export interface CompressedMediaResult {
  dataUrl: string;
  mimeType: 'image/webp' | 'image/png';
  sizeKb: number;
  width: number;
  height: number;
  fileName: string;
}

/**
 * Memeriksa magic bytes asli file gambar (JPEG, PNG, WebP) untuk mencegah
 * penyelundupan file non-gambar dengan ekstensi palsu (OWASP Upload Hardening).
 */
export function verifyImageMagicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return true;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return true;
  }

  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }

  return false;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const base64Index = dataUrl.indexOf(',');
  if (base64Index < 0) return dataUrl.length;
  const base64Length = dataUrl.length - base64Index - 1;
  return Math.ceil((base64Length * 3) / 4);
}

export async function compressEvidencePhotoToWebp(
  file: File
): Promise<CompressedMediaResult> {
  if (file.size > MAX_RAW_FILE_BYTES) {
    throw new Error('Ukuran foto melebihi batas maksimal 10 MB.');
  }

  const headerBuffer = await file.slice(0, 16).arrayBuffer();
  if (!verifyImageMagicBytes(new Uint8Array(headerBuffer))) {
    throw new Error(
      'Format berkas tidak valid. Gunakan foto asli kamera berformat JPEG, PNG, atau WebP.'
    );
  }

  const bitmap = await createImageBitmap(file);
  const scale =
    bitmap.width > TARGET_MAX_WIDTH_PX ? TARGET_MAX_WIDTH_PX / bitmap.width : 1;
  const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
  const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Gagal menginisialisasi kanvas kompresi gambar.');
  }

  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();

  let quality = 0.75;
  let dataUrl = canvas.toDataURL('image/webp', quality);

  while (estimateDataUrlBytes(dataUrl) > TARGET_MAX_EVIDENCE_BYTES && quality > 0.35) {
    quality = Number((quality - 0.1).toFixed(2));
    dataUrl = canvas.toDataURL('image/webp', quality);
  }

  const finalBytes = estimateDataUrlBytes(dataUrl);
  const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');

  return {
    dataUrl,
    mimeType: 'image/webp',
    sizeKb: Math.max(1, Math.round(finalBytes / 1024)),
    width: targetWidth,
    height: targetHeight,
    fileName: `${baseName || 'BUKTI_RUSAK'}.webp`,
  };
}
