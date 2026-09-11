const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { parseStayTotal, parsePriceText, perNightPriceFor } = require('../server/priceChecker');

// A real search-result link as Booking.com hands it out, trimmed to the parts
// that matter. The stay total lives in the last segment of sr_pri_blocks, in
// minor units: 52336 -> EUR 523.36 for the whole 4-night stay.
const KAISERSWERTH =
  'https://www.booking.com/hotel/de/kaiserswerth.html?checkin=2027-07-08&checkout=2027-07-12' +
  '&sr_pri_blocks=816576101_401775398_2_2_0__52336&from=searchresults';

// Same shape, but the price segment is not preceded by an empty one.
const DORMERO =
  'https://www.booking.com/hotel/de/dormero-dusseldorf.html?checkin=2027-07-08&checkout=2027-07-12' +
  '&sr_pri_blocks=6682618_94004448_0_2_0_732951_34953&from=searchresults';

test('parseStayTotal reads the stay total out of a booking link', () => {
  assert.strictEqual(parseStayTotal(KAISERSWERTH), 523.36);
  assert.strictEqual(parseStayTotal(DORMERO), 349.53);
});

test('parseStayTotal returns null when the link carries no usable price', () => {
  assert.strictEqual(parseStayTotal(''), null);
  assert.strictEqual(parseStayTotal(undefined), null);
  assert.strictEqual(parseStayTotal('https://www.booking.com/hotel/de/x.html?from=searchresults'), null);
  assert.strictEqual(parseStayTotal('https://x.test/?sr_pri_blocks=123_456_0_0_0__abc'), null);
  assert.strictEqual(parseStayTotal('https://x.test/?sr_pri_blocks=123_456_0_0_0__0'), null);
});

test('parsePriceText handles the currency and separator styles Booking renders', () => {
  assert.strictEqual(parsePriceText('€ 131'), 131);
  assert.strictEqual(parsePriceText('PLN 1,440'), 1440);
  assert.strictEqual(parsePriceText('1 440 zł'), 1440);
  assert.strictEqual(parsePriceText('1.440 zł'), 1440);          // European thousands separator
  assert.strictEqual(parsePriceText('1,440.50'), 1440.5);        // thousands + decimal
  assert.strictEqual(parsePriceText('1.440,50'), 1440.5);        // the European spelling of the same
  assert.strictEqual(parsePriceText('€131.99'), 131.99);
  assert.strictEqual(parsePriceText(''), 0);
  assert.strictEqual(parsePriceText('Sold out'), 0);
});

test('parsePriceText takes the current price when a struck-through one precedes it', () => {
  assert.strictEqual(parsePriceText('€ 262€ 131'), 131);
  assert.strictEqual(parsePriceText('€ 262 € 131'), 131);
});

test('a nightly rate on the card is not divided by the night count again', () => {
  // The regression: Booking showed EUR 131 (one night) and the checker reported
  // 131 / 4 = EUR 33/night, so every alert looked like a bargain.
  const hotel = { hotelName: 'Hotel Kaiserswerth', url: KAISERSWERTH, priceText: '€ 131', basisText: '€ 131' };
  const priced = perNightPriceFor(hotel, 4);

  assert.strictEqual(priced.perNightPrice, 131);
  assert.strictEqual(priced.stayTotal, 523.36);
  assert.strictEqual(priced.basis, 'link');
});

test('a stay total on the card gives the same answer as a nightly rate does', () => {
  const asTotal = perNightPriceFor(
    { hotelName: 'Hotel Kaiserswerth', url: KAISERSWERTH, priceText: '€ 523', basisText: '€ 523' }, 4);
  const asNightly = perNightPriceFor(
    { hotelName: 'Hotel Kaiserswerth', url: KAISERSWERTH, priceText: '€ 131', basisText: '€ 131' }, 4);

  assert.strictEqual(asTotal.perNightPrice, asNightly.perNightPrice);
});

test('without a link price, an explicit "for N nights" label is used', () => {
  const priced = perNightPriceFor(
    { hotelName: 'X', url: 'https://x.test/', priceText: '€ 524', basisText: '€ 524 for 4 nights, 2 adults' }, 4);

  assert.strictEqual(priced.perNightPrice, 131);
  assert.strictEqual(priced.basis, 'label');
});

test('without a link price, an explicit per-night label is used as-is', () => {
  const priced = perNightPriceFor(
    { hotelName: 'X', url: 'https://x.test/', priceText: '€ 131', basisText: '€ 131 per night' }, 4);

  assert.strictEqual(priced.perNightPrice, 131);
  assert.strictEqual(priced.basis, 'label');
});

test('an unlabelled price with no link price is skipped rather than guessed at', () => {
  assert.strictEqual(
    perNightPriceFor({ hotelName: 'X', url: 'https://x.test/', priceText: '€ 131', basisText: '€ 131' }, 4),
    null);
  assert.strictEqual(
    perNightPriceFor({ hotelName: 'X', url: '', priceText: '', basisText: '' }, 4),
    null);
});

// The strongest check available offline: every price this app has ever recorded
// came with the booking link it was scraped from, and those links still carry
// Booking's own price for the stay. Re-deriving each one must agree with the
// link, for all 332 entries.
test('recorded history re-derives consistently from the links it was scraped with', () => {
  const stored = require(path.join(__dirname, '..', 'data', 'db.json'));
  const alerts = Object.fromEntries(stored.alerts.map(a => [a.id, a]));
  const nightsFor = a => Math.max(1, Math.round((new Date(a.checkout) - new Date(a.checkin)) / 86400000));

  let checked = 0;
  for (const entry of stored.price_history) {
    const alert = alerts[entry.alert_id];
    if (!alert) continue;

    const nights = nightsFor(alert);
    const priced = perNightPriceFor(
      { hotelName: entry.hotel_name, url: entry.url, priceText: '', basisText: '' }, nights);

    assert.ok(priced, `no price derived for ${entry.hotel_name}`);
    assert.strictEqual(priced.perNightPrice, Math.round(parseStayTotal(entry.url) / nights));
    assert.ok(priced.perNightPrice > 0);
    checked++;
  }

  assert.ok(checked > 300, `expected the full history, only checked ${checked}`);
});
