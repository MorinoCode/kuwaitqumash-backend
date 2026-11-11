/**
 * Fabric stock mathematics.
 *
 * Stock of one inventory row is: `quantity` rolls (units) x `length_m` meters each.
 * Sales cut meters from those rolls; refunds put the meters back.
 * Both helpers are pure so they can be unit-tested without a database.
 */

const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

const toMeters = (value) => {
  const meters = Number(value);
  return Number.isFinite(meters) && meters > 0 ? meters : 0;
};

const toUnits = (value) => {
  const units = parseInt(value, 10);
  return Number.isFinite(units) && units > 0 ? units : 1;
};

/**
 * Deduct a sale line from stock, cutting `metersPerUnit` from `units` rolls.
 * Returns `{ ok: false }` when the requested meters exceed what is in stock.
 */
export const applySaleToStock = (
  { length_m = 0, quantity = 0 } = {},
  metersPerUnit,
  units,
) => {
  const perRoll = Math.max(0, Number(length_m) || 0);
  const rolls = Math.max(0, parseInt(quantity, 10) || 0);
  const availableMeters = round3(perRoll * rolls);
  const soldMeters = round3(toMeters(metersPerUnit) * toUnits(units));

  if (soldMeters <= 0) {
    return { ok: false, reason: "invalid-meters", availableMeters, soldMeters };
  }
  if (soldMeters > availableMeters + 0.001) {
    return { ok: false, reason: "insufficient", availableMeters, soldMeters };
  }

  const remainingMeters = round3(Math.max(0, availableMeters - soldMeters));

  if (remainingMeters <= 0) {
    return {
      ok: true,
      quantity: 0,
      length_m: 0,
      status: "Sold",
      availableMeters,
      soldMeters,
      remainingMeters: 0,
    };
  }

  const rollsLeft = Math.min(
    Math.max(1, rolls),
    Math.max(1, Math.ceil(remainingMeters / Math.max(perRoll, 0.001))),
  );

  return {
    ok: true,
    quantity: rollsLeft,
    length_m: round3(remainingMeters / rollsLeft),
    status: "In Stock",
    availableMeters,
    soldMeters,
    remainingMeters,
  };
};

/**
 * Put refunded meters back into stock, keeping roll count consistent.
 */
export const applyRefundToStock = (
  { length_m = 0, quantity = 0 } = {},
  metersPerUnit,
  units,
) => {
  const perRoll = Math.max(0, Number(length_m) || 0);
  const rolls = Math.max(0, parseInt(quantity, 10) || 0);
  const restoredMeters = round3(toMeters(metersPerUnit) * toUnits(units));

  const totalMeters = round3(perRoll * rolls + restoredMeters);
  if (totalMeters <= 0) {
    return { quantity: 0, length_m: 0, restoredMeters: 0, totalMeters: 0 };
  }

  // A partial refund tops the existing roll back up; whole rolls add to the count.
  const wholeRolls = perRoll > 0 ? Math.floor(restoredMeters / perRoll) : 0;
  const newQuantity =
    rolls > 0
      ? Math.max(1, rolls + wholeRolls)
      : Math.max(
          1,
          Math.ceil(totalMeters / Math.max(toMeters(metersPerUnit), totalMeters)),
        );

  return {
    quantity: newQuantity,
    length_m: round3(totalMeters / newQuantity),
    restoredMeters,
    totalMeters,
  };
};
