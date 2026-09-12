// Run with: npm test   (node --test)
const test = require('node:test');
const assert = require('node:assert');

const {
  parseMoney,
  parseAllMoney,
  basisFromNeighbours,
  detectBasis,
  parseLinkTotal,
  nightsBetween,
  resolveStayPrice,
  simplifyDestination,
  hasCurrencyMarker
} = require('./priceParser');

test('parseMoney handles the separators Booking.com uses', () => {
  assert.strictEqual(parseMoney('€ 165'), 165);
  assert.strictEqual(parseMoney('€165.16'), 165.16);
  assert.strictEqual(parseMoney('€ 1,440'), 1440);
  assert.strictEqual(parseMoney('1 440 zł'), 1440);
  assert.strictEqual(parseMoney('1 440 zł'), 1440);
  assert.strictEqual(parseMoney('PLN 1.440'), 1440);
  assert.strictEqual(parseMoney('149,50 zł'), 149.5);
  assert.strictEqual(parseMoney('€ 1,234.56'), 1234.56);
  assert.strictEqual(parseMoney('1.234,56 €'), 1234.56);
});

test('parseMoney picks the number next to the currency marker', () => {
  assert.strictEqual(parseMoney('Price for 4 nights: € 660'), 660);
  assert.strictEqual(parseMoney('€ 660 total for 4 nights'), 660);
});

test('non-price card text is rejected by the currency check', () => {
  // These are the numbers that used to be picked up as prices by the
  // "any span with a digit" fallback.
  for (const text of ['4 nights, 2 adults', '8.9 Excellent', '1.2 km from centre', '2 beds']) {
    assert.strictEqual(hasCurrencyMarker(text), false, text);
  }
});

test('detectBasis only trusts explicit wording', () => {
  assert.strictEqual(detectBasis('€ 165 per night'), 'per_night');
  assert.strictEqual(detectBasis('€ 660 total'), 'total');
  assert.strictEqual(detectBasis('Price for 4 nights: € 660'), 'total');
  // Neutral label Booking shows in both layouts - must not be read as a total.
  assert.strictEqual(detectBasis('4 nights, 2 adults\n€ 165'), 'unknown');
});

test('parseLinkTotal reads the stay total out of a card link', () => {
  const url =
    'https://www.booking.com/hotel/de/hotelfahrhaus.html?checkin=2027-07-08&checkout=2027-07-12' +
    '&sr_pri_blocks=6061915_275602938_2_0_0__66063&from=searchresults';
  assert.strictEqual(parseLinkTotal(url), 660.63);
  assert.strictEqual(parseLinkTotal('https://www.booking.com/hotel/de/moon.html'), 0);
});

test('nightsBetween counts nights, not days', () => {
  assert.strictEqual(nightsBetween('2027-07-08', '2027-07-12'), 4);
  assert.strictEqual(nightsBetween('2027-06-17', '2027-06-20'), 3);
  assert.strictEqual(nightsBetween('2027-06-17', '2027-06-17'), 1);
});

// Regression cases taken from real notifications in data/db.json, where the
// stay total in the card link proves what the price should have been.
test('per-night prices are no longer divided by the stay length again', () => {
  // Fährhaus Hotel am Rhein, 4 nights, link total €660.63.
  // The card showed the nightly rate (€165); the old code reported €41/night.
  const resolved = resolveStayPrice(
    { displayedPrice: 165, basis: 'unknown', linkTotal: 660.63 },
    4
  );
  assert.strictEqual(resolved.perNightPrice, 165);
  assert.strictEqual(resolved.totalPrice, 661);
  assert.strictEqual(resolved.priceBasis, 'link-total');

  // Bahn-Hotel, 4 nights, link total €2220.56 - was alerted as €139/night
  // against a €150 budget when the real rate is €555/night.
  const bahn = resolveStayPrice({ displayedPrice: 555, linkTotal: 2220.56 }, 4);
  assert.strictEqual(bahn.perNightPrice, 555);

  // Hotel Włoski, Poznań, 3 nights, link total 1935.40 PLN.
  const wloski = resolveStayPrice({ displayedPrice: 645, linkTotal: 1935.4 }, 3);
  assert.strictEqual(wloski.perNightPrice, 645);
  assert.strictEqual(wloski.totalPrice, 1935);
});

test('parseAllMoney collects the figures printed around a price', () => {
  // innerText of a real Booking rate block, nightly-rate layout.
  assert.deepStrictEqual(parseAllMoney('4 nights, 2 adults € 170 € 682 total'), [4, 2, 170, 682]);
  // No currency anywhere means no prices.
  assert.deepStrictEqual(parseAllMoney('4 nights, 2 adults'), []);
});

test('the figure printed beside a price identifies what the price is', () => {
  // "€ 170" next to "€ 682 total" over 4 nights -> 170 is the nightly rate.
  assert.strictEqual(basisFromNeighbours(170, [4, 2, 170, 682], 4), 'per_night');
  // "€ 682" next to "€ 170 per night" -> 682 is the stay total.
  assert.strictEqual(basisFromNeighbours(682, [4, 2, 682, 170], 4), 'total');
  assert.strictEqual(basisFromNeighbours(170, [170], 4), 'unknown');
  // One-night stays make the two readings the same thing.
  assert.strictEqual(basisFromNeighbours(170, [170, 170], 1), 'unknown');
});

test('the neighbouring figure outranks a misleading card label', () => {
  // Booking's nightly-rate layout puts the word "total" on the *other* number,
  // so reading the wording alone divides a nightly rate by the stay length.
  const resolved = resolveStayPrice(
    { displayedPrice: 170, basis: 'total', linkTotal: 0, contextValues: [4, 2, 170, 682] },
    4
  );
  assert.strictEqual(resolved.perNightPrice, 170);
  assert.strictEqual(resolved.priceBasis, 'neighbour-per-night');

  // And a real stay total still resolves to the nightly rate.
  const total = resolveStayPrice(
    { displayedPrice: 1341, basis: 'unknown', linkTotal: 0, contextValues: [3, 2, 1341, 447] },
    3
  );
  assert.strictEqual(total.perNightPrice, 447);
  assert.strictEqual(total.priceBasis, 'neighbour-total');
});

test('a card that really shows the stay total is still divided by nights', () => {
  const resolved = resolveStayPrice(
    { displayedPrice: 1341, basis: 'total', linkTotal: 1341 },
    3
  );
  assert.strictEqual(resolved.perNightPrice, 447);
  assert.strictEqual(resolved.totalPrice, 1341);
  assert.strictEqual(resolved.priceBasis, 'link-total');

  // Same card without a usable link price: the explicit label decides.
  const labelled = resolveStayPrice({ displayedPrice: 1341, basis: 'total', linkTotal: 0 }, 3);
  assert.strictEqual(labelled.perNightPrice, 447);
  assert.strictEqual(labelled.priceBasis, 'card-total');
});

test('an implausible link price is ignored rather than trusted', () => {
  // A currency with no minor units (or a changed link format) would otherwise
  // scale the price by 100.
  const resolved = resolveStayPrice({ displayedPrice: 165, basis: 'per_night', linkTotal: 6.6 }, 4);
  assert.strictEqual(resolved.perNightPrice, 165);
  assert.strictEqual(resolved.priceBasis, 'card-per-night');
});

test('an unlabelled price is read as nightly, never as a total', () => {
  const resolved = resolveStayPrice({ displayedPrice: 165, basis: 'unknown', linkTotal: 0 }, 4);
  assert.strictEqual(resolved.perNightPrice, 165);
  assert.strictEqual(resolved.totalPrice, 660);
  assert.strictEqual(resolved.priceBasis, 'assumed-per-night');
});

test('single-night stays are unaffected by the basis', () => {
  for (const basis of ['unknown', 'total', 'per_night']) {
    assert.strictEqual(resolveStayPrice({ displayedPrice: 120, basis }, 1).perNightPrice, 120);
  }
});

test('simplifyDestination falls back to "City, Country"', () => {
  assert.strictEqual(
    simplifyDestination('Poznan, Greater Poland Voivodeship, Poland'),
    'Poznan, Poland'
  );
  assert.strictEqual(
    simplifyDestination('Dusseldorf, North Rhine-Westphalia, Germany'),
    'Dusseldorf, Germany'
  );
  assert.strictEqual(simplifyDestination('Poznan, Poland'), null);
  assert.strictEqual(simplifyDestination('Paris'), null);
});
