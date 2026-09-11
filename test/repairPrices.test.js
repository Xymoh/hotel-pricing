const test = require('node:test');
const assert = require('node:assert');

const { repairRow, repairAll } = require('../server/scripts/repairPrices');

const ALERT = {
  id: 1,
  currency: 'EUR',
  checkin: '2027-07-08',
  checkout: '2027-07-12', // 4 nights
  max_price: 150
};

// EUR 523.36 for the stay -> EUR 131/night.
const LINK = 'https://www.booking.com/hotel/de/kaiserswerth.html?sr_pri_blocks=816576101_401775398_2_2_0__52336';

test('a price divided by the night count twice is restored', () => {
  const row = { alert_id: 1, price: 33, url: LINK };

  assert.strictEqual(repairRow(row, ALERT), 'corrected');
  assert.strictEqual(row.price, 131);
  assert.strictEqual(row.price_basis, 'link');
});

test('the notification message is rewritten along with the price', () => {
  const row = {
    alert_id: 1,
    price: 33,
    url: LINK,
    message: '🏨 Hotel Kaiserswerth in Dusseldorf — EUR 33/night'
  };

  repairRow(row, ALERT);
  assert.strictEqual(row.message, '🏨 Hotel Kaiserswerth in Dusseldorf — EUR 131/night');
});

test('an already-correct row keeps its price but is still marked trusted', () => {
  const row = { alert_id: 1, price: 131, url: LINK };

  assert.strictEqual(repairRow(row, ALERT), 'corrected'); // newly trusted
  assert.strictEqual(row.price, 131);
  assert.strictEqual(row.price_basis, 'link');

  // Running it again is a no-op.
  assert.strictEqual(repairRow(row, ALERT), 'unchanged');
  assert.strictEqual(row.price, 131);
});

test('rows with no recoverable price are left exactly as they were', () => {
  const row = { alert_id: 1, price: 33, url: 'https://www.booking.com/hotel/de/x.html' };

  assert.strictEqual(repairRow(row, ALERT), 'skipped');
  assert.strictEqual(row.price, 33);
  assert.strictEqual(row.price_basis, undefined);

  const orphan = { alert_id: 99, price: 33, url: LINK };
  assert.strictEqual(repairRow(orphan, undefined), 'skipped');
  assert.strictEqual(orphan.price, 33);
});

test('repairing is idempotent and refreshes the alert headline price', () => {
  const db = {
    alerts: [{ ...ALERT, last_price: 33 }],
    price_history: [
      { alert_id: 1, price: 33, url: LINK, checked_at: '2026-09-11T13:20:36.314Z' },
      { alert_id: 1, price: 30, url: LINK, checked_at: '2026-09-10T13:20:36.314Z' }
    ],
    notifications: [{ alert_id: 1, price: 33, url: LINK, message: 'X — EUR 33/night' }]
  };

  repairAll(db);
  assert.deepStrictEqual(db.price_history.map(p => p.price), [131, 131]);
  assert.strictEqual(db.alerts[0].last_price, 131);

  const before = JSON.stringify(db);
  const second = repairAll(db);
  assert.strictEqual(JSON.stringify(db), before, 'second run must change nothing');
  assert.strictEqual(second.alerts, 0);
  assert.strictEqual(second['price history'].corrected, 0);
});
