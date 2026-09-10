export const UNIT = 10n ** 18n;
export function d(value) {
  if (typeof value !== 'string' || !/^-?\d+(\.\d{1,18})?$/.test(value)) throw new Error('INVALID_DECIMAL');
  const negative = value.startsWith('-'); const [whole, fraction = ''] = value.replace('-', '').split('.');
  return (BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, '0'))) * (negative ? -1n : 1n);
}
export function f(value) {
  const sign = value < 0n ? '-' : ''; const n = value < 0n ? -value : value;
  const fraction = (n % UNIT).toString().padStart(18, '0').replace(/0+$/, '');
  return sign + (n / UNIT).toString() + (fraction ? '.' + fraction : '');
}
export const mul = (a, b) => a * b / UNIT;
export const div = (a, b) => { if (b <= 0n) throw new Error('INVALID_DIVISOR'); return a * UNIT / b; };
export const floorStep = (a, step) => { if (a < 0n || step <= 0n) throw new Error('INVALID_INCREMENT'); return a / step * step; };
export const ceilStep = (a, step) => { if (a < 0n || step <= 0n) throw new Error('INVALID_INCREMENT'); return (a + step - 1n) / step * step; };
export const min = (a, b) => a < b ? a : b;
export const abs = a => a < 0n ? -a : a;
