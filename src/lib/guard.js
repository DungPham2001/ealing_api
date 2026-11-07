/**
 * PII filter (spec 2.8) for every free-text field: email, phone, payment card (Luhn), SSN,
 * long account-like numbers, tax id (EIN). Returns the `kind` of the first rule broken, or null.
 * kinds: email | phone | card | ssn | account | tax_id
 * Fields flagged `contact` (company email / phone / website of vendors & partners) may hold an email / phone.
 */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const EIN = /\b\d{2}-\d{7}\b/;
const CARD = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;
const LONG_DIGITS = /\d{9,}/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?<![\d])(?:\+?\d{1,2}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;

const luhn = (digits) => {
  let total = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
    alt = !alt;
  }
  return total % 10 === 0;
};

function check(text, { contact = false } = {}) {
  if (typeof text !== 'string' || !text) return null;
  if (SSN.test(text)) return 'ssn';
  if (EIN.test(text)) return 'tax_id';
  for (const m of text.match(CARD) || []) {
    const d = m.replace(/\D/g, '');
    if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'card';
  }
  if (LONG_DIGITS.test(text)) return 'account';
  if (contact) return null;
  if (EMAIL.test(text)) return 'email';
  if (PHONE.test(text)) return 'phone';
  return null;
}

module.exports = { check };
