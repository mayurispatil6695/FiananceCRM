// Indian mobile numbers: keep the last 10 digits, must start with 6-9.
function normalizeMobile(value) {
  if (value === null || value === undefined) return null;
  let digits = String(value).replace(/\D/g, '');
  if (digits.length > 10 && (digits.startsWith('91') || digits.startsWith('0'))) {
    digits = digits.slice(-10);
  }
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  // dd/mm/yyyy or dd-mm-yyyy
  const m = String(value).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(year, Number(m[2]) - 1, Number(m[1]));
    return isNaN(d) ? null : d;
  }
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

module.exports = { normalizeMobile, toNumber, toDate };
