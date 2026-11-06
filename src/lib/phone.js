'use strict';

// Normalises a country code + national number into E.164 (+<cc><number>).
// Returns null when the number is not plausible for the given country.
function toE164(countryCode, nationalNumber) {
  const cc = String(countryCode || '').replace(/\D/g, '');
  let num = String(nationalNumber || '').replace(/[\s\-().]/g, '');
  if (!/^\d{1,3}$/.test(cc) || !/^\d+$/.test(num)) return null;

  if (cc === '91') {
    num = num.replace(/^0+/, '');
    if (num.length === 12 && num.startsWith('91')) num = num.slice(2);
    if (!/^[6-9]\d{9}$/.test(num)) return null;
  } else {
    num = num.replace(/^0+/, '');
    if (num.length < 6 || num.length > 14) return null;
  }

  if (cc.length + num.length > 15) return null;
  return `+${cc}${num}`;
}

function maskPhone(e164) {
  const s = String(e164 || '');
  if (s.length < 6) return s;
  return s.slice(0, s.length - 10 > 0 ? s.length - 10 : 3) + '******' + s.slice(-4);
}

function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return email;
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
}

module.exports = { toE164, maskPhone, maskEmail };
