// Pure helpers for turning what a Booking.com search card shows into a
// per-night price. Deliberately free of Puppeteer/DOM so the arithmetic can be
// unit tested (see priceParser.test.js) — reading the wrong number off a card
// is the failure mode that quietly sends alerts for prices that don't exist.

// Currency symbols/codes Booking.com renders in search results. Used to tell a
// price apart from the other numbers on a card (review scores, "2 adults",
// "1.2 km from centre").
const CURRENCY_MARKER =
  /€|\$|£|¥|₹|₺|zł|kr|Kč|Ft|R\$|CHF|PLN|EUR|USD|GBP|SEK|NOK|DKK|CZK|HUF|JPY|TRY|RON|BGN|UAH/i;

// Digit groups, allowing the separators Booking uses for thousands: plain
// space, NBSP, narrow NBSP, thin space, comma, dot.
const NUMBER_TOKEN = /\d[\d.,    ]*\d|\d/g;

function hasCurrencyMarker(text) {
  return CURRENCY_MARKER.test(String(text || ''));
}

// "1,440" / "1 440" / "1.440" / "149,50" -> number
function normalizeNumber(token) {
  const s = String(token).replace(/[\s   ]/g, '');
  let normalized;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    normalized = s.replace(/,/g, ''); // 1,440.50 -> 1440.50
  } else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    normalized = s.replace(/\./g, '').replace(',', '.'); // 1.440,50 -> 1440.50
  } else if (/^\d+,\d{3}$/.test(s)) {
    normalized = s.replace(',', ''); // 1,440 -> 1440
  } else {
    normalized = s.replace(',', '.'); // 149,50 -> 149.50
  }
  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

// Pull the price out of a card's price text. When a currency marker is present
// the number nearest to it wins, so "Price for 4 nights: € 660" reads 660 and
// not 4.
function parseMoney(text) {
  const str = String(text || '');
  const matches = [];
  NUMBER_TOKEN.lastIndex = 0;
  let m;
  while ((m = NUMBER_TOKEN.exec(str)) !== null) {
    const value = normalizeNumber(m[0]);
    if (value !== null && value > 0) matches.push({ value, index: m.index });
  }
  if (matches.length === 0) return null;

  const marker = CURRENCY_MARKER.exec(str);
  if (!marker) return matches[0].value;

  const markerIndex = marker.index;
  return matches.reduce((best, candidate) =>
    Math.abs(candidate.index - markerIndex) < Math.abs(best.index - markerIndex) ? candidate : best
  ).value;
}

// Every number that reads as money in a piece of card text. Used to compare a
// price against the other figure Booking prints beside it.
function parseAllMoney(text) {
  const str = String(text || '');
  if (!hasCurrencyMarker(str)) return [];
  const values = [];
  NUMBER_TOKEN.lastIndex = 0;
  let m;
  while ((m = NUMBER_TOKEN.exec(str)) !== null) {
    const value = normalizeNumber(m[0]);
    if (value !== null && value > 0) values.push(value);
  }
  return values;
}

// Whether the text around a price says it's a nightly rate or a whole-stay
// total. Only explicit wording counts: Booking also prints neutral labels like
// "4 nights, 2 adults" in both layouts, and guessing from those is what made
// prices wrong before.
function detectBasis(text) {
  const t = String(text || '').toLowerCase();
  if (/per night|\/\s*night|a night|nightly|pro nacht|za noc|par nuit|por noche|per notte/.test(t)) {
    return 'per_night';
  }
  if (/\btotal\b|\bgesamt|\brazem\b|price for \d+ nights?|for \d+ nights? total/.test(t)) {
    return 'total';
  }
  return 'unknown';
}

// Booking's card links carry the price of the offered block:
// "...&sr_pri_blocks=6061915_275602938_2_0_0__66063..." where the trailing
// number is the stay total in minor currency units (66063 -> 660.63).
function parseLinkTotal(url) {
  const m = /sr_pri_blocks=[^&]*__(\d+)/.exec(String(url || ''));
  if (!m) return 0;
  const minor = parseInt(m[1], 10);
  return Number.isFinite(minor) ? minor / 100 : 0;
}

function nightsBetween(checkin, checkout) {
  const ms = new Date(checkout).getTime() - new Date(checkin).getTime();
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function withinTolerance(a, b, tolerance = 0.2) {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}

// A Booking.com card prints both figures - the nightly rate and the total for
// the stay - so the other number in the same block identifies which one was
// picked up. This is a better signal than the card's wording: a "total" label
// usually belongs to that other number rather than to the price itself.
function basisFromNeighbours(displayedPrice, contextValues, nights) {
  const stayNights = Math.max(1, Math.round(nights) || 1);
  if (stayNights === 1 || !(displayedPrice > 0) || !Array.isArray(contextValues)) return 'unknown';

  const near = target => contextValues.some(value => withinTolerance(value, target, 0.08));
  if (near(displayedPrice * stayNights)) return 'per_night';
  if (near(displayedPrice / stayNights)) return 'total';
  return 'unknown';
}

// Booking.com shows the nightly rate on some searches and the whole-stay total
// on others, so the number on the card can't be read on its own — dividing it
// by the stay length unconditionally (what this app used to do) under-reports
// a nightly rate by a factor of `nights`.
//
// Resolution order:
//  1. The stay total embedded in the card's own booking link, when it agrees
//     with either reading of the displayed number. The agreement check keeps a
//     currency without minor units (JPY, HUF) or a changed link format from
//     silently scaling the price by 100.
//  2. The other price printed beside it on the card (a nightly rate sits next
//     to the stay total, and vice versa).
//  3. An explicit "per night" / "total" label on the card.
//  4. Read it as a nightly rate — Booking's default search layout — because
//     over-reporting is recoverable while under-reporting sends an alert for a
//     price that isn't bookable.
function resolveStayPrice({ displayedPrice, basis = 'unknown', linkTotal = 0, contextValues = [] }, nights) {
  const stayNights = Math.max(1, Math.round(nights) || 1);
  const displayed = Number(displayedPrice) || 0;
  const neighbourBasis = basisFromNeighbours(displayed, contextValues, stayNights);

  let total;
  let source;
  if (linkTotal > 0 && (withinTolerance(linkTotal, displayed * stayNights) || withinTolerance(linkTotal, displayed))) {
    total = linkTotal;
    source = 'link-total';
  } else if (neighbourBasis === 'per_night') {
    total = displayed * stayNights;
    source = 'neighbour-per-night';
  } else if (neighbourBasis === 'total') {
    total = displayed;
    source = 'neighbour-total';
  } else if (basis === 'total') {
    total = displayed;
    source = 'card-total';
  } else if (basis === 'per_night') {
    total = displayed * stayNights;
    source = 'card-per-night';
  } else {
    total = displayed * stayNights;
    source = 'assumed-per-night';
  }

  return {
    perNightPrice: Math.round(total / stayNights),
    totalPrice: Math.round(total),
    priceBasis: source
  };
}

// Alerts store the destination as the label the autocomplete produced
// ("Poznan, Greater Poland Voivodeship, Poland"), which comes from
// OpenStreetMap — as does dest_id, an OSM id Booking.com can't use. Booking's
// free-text search doesn't always resolve the middle administrative part, and
// when it doesn't the search page comes back with no property cards at all, so
// retry with the "City, Country" form it handles reliably.
function simplifyDestination(destination) {
  const parts = String(destination || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  return `${parts[0]}, ${parts[parts.length - 1]}`;
}

module.exports = {
  hasCurrencyMarker,
  normalizeNumber,
  parseMoney,
  parseAllMoney,
  basisFromNeighbours,
  detectBasis,
  parseLinkTotal,
  nightsBetween,
  resolveStayPrice,
  simplifyDestination
};
