// Dimensional / chargeable weight — the verified courier formula (plan §5).
//
//   volumetric (per box) = (L × W × H) / divisor    [cm/kg divisor = 5000]
//   chargeable (per box) = max(actual weight, volumetric weight)
//   shipment total       = sum of each box's chargeable weight
//
// Matches how DHL / FedEx / UPS bill: the greater of actual vs. volumetric,
// evaluated per package, then summed. Rounded to 3 decimals (grams).

export interface BoxDims {
  weightKg: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface BoxWeights {
  volumetricKg: number;
  chargeableKg: number;
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** Volumetric + chargeable weight for a single box. */
export function computeBoxWeights(box: BoxDims, divisor: number): BoxWeights {
  if (divisor <= 0) throw new Error("volumetric divisor must be > 0");
  const volume = box.lengthCm * box.widthCm * box.heightCm;
  const volumetric = round3(volume / divisor);
  const actual = round3(box.weightKg);
  const chargeable = round3(Math.max(actual, volumetric));
  return { volumetricKg: volumetric, chargeableKg: chargeable };
}

/** Total chargeable weight across all boxes (sum of per-box chargeable). */
export function shipmentChargeableKg(boxes: BoxDims[], divisor: number): number {
  const total = boxes.reduce((sum, b) => sum + computeBoxWeights(b, divisor).chargeableKg, 0);
  return round3(total);
}
