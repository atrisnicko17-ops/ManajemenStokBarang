import type { UomConversion } from './types';

export interface UomConversionResult {
  qtyInput: number;
  unitSelected: string;
  multiplier: number;
  qtyBase: number;
  baseUnit: string;
  summaryText: string;
}

export function convertToBaseUnit(
  qtyInput: number,
  selectedUnit: string,
  baseUnit: string,
  uoms: readonly UomConversion[]
): UomConversionResult {
  if (!Number.isFinite(qtyInput) || qtyInput <= 0 || !Number.isInteger(qtyInput)) {
    throw new Error('Jumlah barang harus berupa bilangan bulat positif.');
  }

  const normalizedSelected = selectedUnit.trim();
  const normalizedBase = baseUnit.trim();

  if (normalizedSelected.toLowerCase() === normalizedBase.toLowerCase()) {
    return {
      qtyInput,
      unitSelected: normalizedBase,
      multiplier: 1,
      qtyBase: qtyInput,
      baseUnit: normalizedBase,
      summaryText: `${qtyInput} ${normalizedBase}`,
    };
  }

  const matched = uoms.find(
    (u) => u.unit_name.trim().toLowerCase() === normalizedSelected.toLowerCase()
  );

  if (!matched || matched.multiplier_to_base < 1) {
    throw new Error(
      `Satuan "${normalizedSelected}" tidak ditemukan pada daftar konversi barang ini.`
    );
  }

  const qtyBase = qtyInput * matched.multiplier_to_base;
  return {
    qtyInput,
    unitSelected: matched.unit_name,
    multiplier: matched.multiplier_to_base,
    qtyBase,
    baseUnit: normalizedBase,
    summaryText: `${qtyInput} ${matched.unit_name} × ${matched.multiplier_to_base} = ${qtyBase} ${normalizedBase}`,
  };
}

export function formatStockWithLargestUom(
  qtyBase: number,
  baseUnit: string,
  uoms: readonly UomConversion[]
): string {
  if (qtyBase <= 0 || uoms.length === 0) {
    return `${qtyBase} ${baseUnit}`;
  }

  const sortedUoms = [...uoms]
    .filter((u) => u.multiplier_to_base > 1)
    .sort((a, b) => b.multiplier_to_base - a.multiplier_to_base);

  if (sortedUoms.length === 0) {
    return `${qtyBase} ${baseUnit}`;
  }

  const largest = sortedUoms[0];
  if (qtyBase < largest.multiplier_to_base) {
    return `${qtyBase} ${baseUnit}`;
  }

  const majorCount = Math.floor(qtyBase / largest.multiplier_to_base);
  const remainder = qtyBase % largest.multiplier_to_base;
  if (remainder === 0) {
    return `${qtyBase} ${baseUnit} (${majorCount} ${largest.unit_name})`;
  }
  return `${qtyBase} ${baseUnit} (${majorCount} ${largest.unit_name} + ${remainder} ${baseUnit})`;
}
