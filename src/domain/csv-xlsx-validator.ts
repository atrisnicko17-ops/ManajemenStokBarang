const DANGEROUS_FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Mencegah CSV Formula Injection (OWASP) saat file dibuka di Microsoft Excel / Google Sheets.
 */
export function sanitizeCsvCell(rawValue: string | number | boolean | null | undefined): string {
  if (rawValue === null || rawValue === undefined) return '';
  const text = String(rawValue);
  if (text.length === 0) return '';

  const guarded = DANGEROUS_FORMULA_PREFIXES.has(text[0]) ? `'${text}` : text;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

export function serializeSafeCsv(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>
): string {
  const headerLine = headers.map((h) => sanitizeCsvCell(h)).join(',');
  const dataLines = rows.map((row) => row.map((cell) => sanitizeCsvCell(cell)).join(','));
  return [headerLine, ...dataLines].join('\r\n');
}

export interface BulkImportDraftRow {
  rowNumber: number;
  sku_code: string;
  barcode: string;
  name: string;
  category: string;
  bin_code: string;
  base_unit: string;
  uom_name: string;
  uom_multiplier: string;
  min_stock: string;
  qty_initial: string;
  cost_price: string;
  is_fixed_asset: string;
  expiry_date: string;
  errors: string[];
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

export function validateBulkImportRows(
  rows: ReadonlyArray<Omit<BulkImportDraftRow, 'errors'>>,
  existingSkuCodes: ReadonlySet<string>
): BulkImportDraftRow[] {
  const seenInBatch = new Map<string, number>();

  return rows.map((row) => {
    const errors: string[] = [];
    const normalizedSku = row.sku_code.trim().toUpperCase();

    if (!normalizedSku) {
      errors.push('Kode SKU wajib diisi.');
    } else if (!/^[A-Z0-9._/-]{2,60}$/.test(normalizedSku)) {
      errors.push('Format SKU hanya boleh huruf, angka, titik, garis miring, atau strip.');
    } else {
      if (existingSkuCodes.has(normalizedSku)) {
        errors.push(`SKU "${normalizedSku}" sudah terdaftar di katalog aktif.`);
      }
      const prevRow = seenInBatch.get(normalizedSku);
      if (prevRow !== undefined) {
        errors.push(`Duplikat SKU dengan baris #${prevRow} di file ini.`);
      } else {
        seenInBatch.set(normalizedSku, row.rowNumber);
      }
    }

    if (row.name.trim().length < 2) {
      errors.push('Nama barang minimal 2 karakter.');
    }

    if (!row.base_unit.trim()) {
      errors.push('Satuan dasar (base_unit) wajib diisi.');
    }

    const uomMult = Number(row.uom_multiplier || '1');
    if (!Number.isInteger(uomMult) || uomMult < 1) {
      errors.push('Konversi satuan harus bilangan bulat >= 1.');
    }

    const minStock = Number(row.min_stock || '0');
    if (!Number.isInteger(minStock) || minStock < 0) {
      errors.push('Batas stok minimum harus bilangan bulat >= 0.');
    }

    const qtyInit = Number(row.qty_initial || '0');
    if (!Number.isInteger(qtyInit) || qtyInit < 0) {
      errors.push('Saldo awal harus bilangan bulat >= 0.');
    }

    const costPrice = Number(row.cost_price || '0');
    if (!Number.isFinite(costPrice) || costPrice < 0) {
      errors.push('HPP (cost_price) harus angka >= 0.');
    }

    if (row.expiry_date.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(row.expiry_date.trim())) {
      errors.push('Format tanggal kedaluwarsa harus YYYY-MM-DD.');
    }

    return {
      ...row,
      sku_code: normalizedSku || row.sku_code,
      errors,
    };
  });
}

export function parseCsvToBulkDraft(
  csvContent: string,
  existingSkuCodes: ReadonlySet<string>
): BulkImportDraftRow[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const delimiter = lines[0].includes('\t')
    ? '\t'
    : lines[0].includes(';') && !lines[0].includes(',')
      ? ';'
      : ',';

  const headers = splitDelimitedLine(lines[0], delimiter).map((h) =>
    h.toLowerCase().replace(/\s+/g, '_')
  );

  const colIdx = (name: string, fallback: number): number => {
    const idx = headers.indexOf(name);
    return idx >= 0 ? idx : fallback;
  };

  const rawRows: Array<Omit<BulkImportDraftRow, 'errors'>> = lines.slice(1).map((line, index) => {
    const cols = splitDelimitedLine(line, delimiter);
    return {
      rowNumber: index + 2,
      sku_code: cols[colIdx('sku_code', 0)] ?? '',
      barcode: cols[colIdx('barcode', 1)] ?? '',
      name: cols[colIdx('name', 2)] ?? '',
      category: cols[colIdx('category', 3)] ?? 'Umum',
      bin_code: cols[colIdx('bin_code', 4)] || 'ZONA-A/RAK-01',
      base_unit: cols[colIdx('base_unit', 5)] ?? '',
      uom_name: cols[colIdx('uom_name', 6)] || cols[colIdx('base_unit', 5)] || 'Pcs',
      uom_multiplier: cols[colIdx('uom_multiplier', 7)] || '1',
      min_stock: cols[colIdx('min_stock', 8)] || '0',
      qty_initial: cols[colIdx('qty_initial', 9)] || '0',
      cost_price: cols[colIdx('cost_price', 10)] || '0',
      is_fixed_asset: cols[colIdx('is_fixed_asset', 11)] || 'false',
      expiry_date: cols[colIdx('expiry_date', 12)] ?? '',
    };
  });

  return validateBulkImportRows(rawRows, existingSkuCodes);
}
