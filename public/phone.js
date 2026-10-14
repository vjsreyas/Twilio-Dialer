// Phone number helpers shared by the server (require) and the browser (window.Phone).
// Any country is accepted. Numbers without a + get the default country code you pick.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Phone = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // [dialing code, name]. The first few are shown at the top of the country picker.
  const COUNTRIES = [
    ['44', 'United Kingdom'], ['1', 'US / Canada'], ['91', 'India'], ['61', 'Australia'], ['971', 'UAE'],
    ['353', 'Ireland'], ['64', 'New Zealand'], ['65', 'Singapore'], ['27', 'South Africa'],
    ['49', 'Germany'], ['33', 'France'], ['31', 'Netherlands'], ['32', 'Belgium'], ['34', 'Spain'],
    ['39', 'Italy'], ['41', 'Switzerland'], ['43', 'Austria'], ['45', 'Denmark'], ['46', 'Sweden'],
    ['47', 'Norway'], ['48', 'Poland'], ['351', 'Portugal'], ['358', 'Finland'], ['30', 'Greece'],
    ['90', 'Turkey'], ['972', 'Israel'], ['966', 'Saudi Arabia'], ['974', 'Qatar'], ['973', 'Bahrain'],
    ['968', 'Oman'], ['965', 'Kuwait'], ['20', 'Egypt'], ['234', 'Nigeria'], ['254', 'Kenya'],
    ['92', 'Pakistan'], ['880', 'Bangladesh'], ['94', 'Sri Lanka'], ['977', 'Nepal'], ['60', 'Malaysia'],
    ['62', 'Indonesia'], ['63', 'Philippines'], ['66', 'Thailand'], ['84', 'Vietnam'], ['852', 'Hong Kong'],
    ['86', 'China'], ['81', 'Japan'], ['82', 'South Korea'], ['55', 'Brazil'], ['52', 'Mexico'],
    ['54', 'Argentina'], ['57', 'Colombia'], ['56', 'Chile'], ['7', 'Russia / Kazakhstan'],
  ];
  const BY_LENGTH = COUNTRIES.slice().sort((a, b) => b[0].length - a[0].length);

  // Returns +E.164 or null.
  //   "+44 7700 900123", "0044 7700 900123", "447700900123"  -> +447700900123
  //   "07700 900123" or "7700900123" with defaultCode 44     -> +447700900123
  function normalize(raw, defaultCode) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s || /^\d(\.\d+)?e\+?\d+$/i.test(s)) return null; // Excel scientific notation lost digits
    s = s.split(/[/;|,]|\bor\b/i)[0];                         // "num1 / num2" -> first number
    s = s.replace(/\(0\)/g, '');                              // "+44 (0)20 ..." -> "+44 20 ..."
    s = s.replace(/\s*(ext\.?|extension|x)\s*\d+\s*$/i, '');  // drop extensions
    s = s.replace(/^[^\d+]+/, '');                            // "Tel: +44..." -> "+44..."
    const plus = s.startsWith('+');
    let d = s.replace(/\D/g, '');
    const code = String(defaultCode || '').replace(/\D/g, '');
    if (!plus) {
      if (d.startsWith('00')) d = d.slice(2);
      else if (d.startsWith('0')) { if (!code) return null; d = code + d.replace(/^0+/, ''); }
      else if (d.length <= 10) { if (!code) return null; d = code + d; }
      // 11+ digits with no leading 0: assume the country code is already there.
    }
    return /^[1-9]\d{7,14}$/.test(d) ? '+' + d : null;
  }

  function countryOf(e164) {
    const s = String(e164 || '');
    for (const [code, name] of BY_LENGTH) if (s.startsWith('+' + code)) return name;
    return '';
  }

  return { normalize, countryOf, COUNTRIES };
});
