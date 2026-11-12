/**
 * Low-stock helpers.
 *
 * Stock is always tracked in meters: `length_m` is the length of one unit
 * (a roll or a piece) and `quantity` is how many units are on hand, so the
 * figure comparable with `min_stock_level` (also meters) is their product.
 * Comparing `quantity` alone flagged a single 100 m roll as critical when the
 * limit was 5, and made every meter-based item look short of stock.
 */
const round3 = (value) => Math.round((Number(value) || 0) * 1000) / 1000;

export const totalStockMeters = ({ length_m = 0, quantity = 0 } = {}) =>
  round3((Number(length_m) || 0) * (Number(quantity) || 0));

export const isLowStock = (item = {}) =>
  totalStockMeters(item) <= (Number(item.min_stock_level) || 0);

/** SQL twin of `isLowStock` for use inside Sequelize `where` clauses. */
export const LOW_STOCK_SQL =
  "COALESCE(length_m, 0) * COALESCE(quantity, 0) <= COALESCE(min_stock_level, 0)";

/**
 * A dismissed alert must come back once stock recovers above the limit and
 * then drops again; otherwise the first dismissal hides every future shortage.
 */
export const shouldRearmAlert = (item = {}) =>
  Boolean(item.alert_dismissed_at) && !isLowStock(item);
