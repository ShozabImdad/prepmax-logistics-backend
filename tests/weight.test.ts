// Unit tests for the chargeable-weight formula — verified against the exact
// worked example in the architecture plan (§5) and industry rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBoxWeights, shipmentChargeableKg } from "../src/lib/weight.js";

test("plan example: 40x30x30 cm ÷ 5000 = 7.2 kg volumetric", () => {
  const w = computeBoxWeights({ weightKg: 5, lengthCm: 40, widthCm: 30, heightCm: 30 }, 5000);
  assert.equal(w.volumetricKg, 7.2, "volumetric = 36000/5000");
  assert.equal(w.chargeableKg, 7.2, "chargeable = max(5, 7.2) = 7.2 (volumetric wins)");
});

test("actual weight wins when heavier than volumetric", () => {
  // small dense box: 10x10x10 = 1000/5000 = 0.2 kg volumetric, actual 3 kg
  const w = computeBoxWeights({ weightKg: 3, lengthCm: 10, widthCm: 10, heightCm: 10 }, 5000);
  assert.equal(w.volumetricKg, 0.2);
  assert.equal(w.chargeableKg, 3, "chargeable = max(3, 0.2) = 3 (actual wins)");
});

test("inches/lb divisor 139 is supported", () => {
  // 20x12x12 in ÷ 139 = 2880/139 ≈ 20.719 lb
  const w = computeBoxWeights({ weightKg: 10, lengthCm: 20, widthCm: 12, heightCm: 12 }, 139);
  assert.equal(w.volumetricKg, 20.719);
  assert.equal(w.chargeableKg, 20.719);
});

test("shipment total = sum of per-box chargeable weights", () => {
  const boxes = [
    { weightKg: 5, lengthCm: 40, widthCm: 30, heightCm: 30 }, // chargeable 7.2
    { weightKg: 3, lengthCm: 10, widthCm: 10, heightCm: 10 }, // chargeable 3
  ];
  assert.equal(shipmentChargeableKg(boxes, 5000), 10.2, "7.2 + 3 = 10.2");
});

test("zero dimensions => chargeable equals actual weight", () => {
  const w = computeBoxWeights({ weightKg: 2.5, lengthCm: 0, widthCm: 0, heightCm: 0 }, 5000);
  assert.equal(w.volumetricKg, 0);
  assert.equal(w.chargeableKg, 2.5);
});

test("invalid divisor throws", () => {
  assert.throws(() => computeBoxWeights({ weightKg: 1, lengthCm: 1, widthCm: 1, heightCm: 1 }, 0));
});
