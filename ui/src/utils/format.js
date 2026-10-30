export const fmtInt = (n) => n.toLocaleString("en-US");
export const fmtPrice = (n, d = 6) => n.toFixed(d);
export const fmtMoney = (n) => `${n.toLocaleString("en-US")} xUDT`;
export const fmtTime = (d) => d.toLocaleTimeString("en-GB");
export const signed = (n) => `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
export const shortAddr = (a, head = 8, tail = 6) =>
  a.length > head + tail + 3 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;

/** Fixed-point bigint (e.g. shannons, token base units) → grouped decimal string. */
export function fmtUnits(value, decimals = 8, maxFractionDigits = 4) {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (abs / base).toLocaleString("en-US");
  let frac = decimals ? (abs % base).toString().padStart(decimals, "0").slice(0, maxFractionDigits) : "";
  frac = frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export const fmtCkb = (shannons, maxFractionDigits = 2) => `${fmtUnits(shannons, 8, maxFractionDigits)} CKB`;

/** Grouped number with up to `maxFractionDigits` decimals; "—" for null. */
export const fmtNum = (n, maxFractionDigits = 6) =>
  n === null || n === undefined || Number.isNaN(n)
    ? "—"
    : n.toLocaleString("en-US", { maximumFractionDigits: maxFractionDigits });

/** Price with enough decimals to stay meaningful for tiny values. */
export const fmtPriceAuto = (n) => {
  if (n === null || n === undefined) return "—";
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
};

/** Plain decimal string for an <input> value (no grouping). */
export const toInputNumber = (n) =>
  n === null || n === undefined ? "" : String(Number(n.toFixed(8)));
