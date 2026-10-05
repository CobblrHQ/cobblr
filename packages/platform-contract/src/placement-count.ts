export function placementConsumption(placements: number, attritionPercent: number): number {
  if (!Number.isSafeInteger(placements) || placements < 0 || !Number.isFinite(attritionPercent) || attritionPercent < 0 || attritionPercent > 100) throw new Error("Give a whole placement count and an attrition percentage between 0 and 100.");
  // Decimal percentages must not round a mathematically whole loss up again.
  const [mantissa, exponentText] = attritionPercent.toString().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const scale = fraction.length - Number(exponentText ?? 0);
  const digits = BigInt(`${whole}${fraction}`);
  const numerator = scale < 0 ? digits * 10n ** BigInt(-scale) : digits;
  const denominator = 100n * 10n ** BigInt(Math.max(0, scale));
  const loss = (BigInt(placements) * numerator + denominator - 1n) / denominator;
  const consumed = Number(BigInt(placements) + loss);
  if (!Number.isSafeInteger(consumed)) throw new Error("The placement count is too large.");
  return consumed;
}
