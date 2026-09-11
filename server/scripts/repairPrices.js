// One-off repair for price history and notifications recorded before the
// per-night price fix.
//
// Until that fix, the checker treated whatever number the search-result card
// showed as the total for the stay and divided it by the night count. Booking
// renders the nightly rate about four times out of five, so most stored prices
// are `nights` times lower than the real one. That matters beyond cosmetics:
// getNotifiedMinPrices() uses stored notification prices to decide what counts
// as "new or cheaper", so the bogus lows would suppress alerts at correct
// prices. It ignores unmarked rows for that reason; repairing them corrects
// the numbers and brings them back into play.
//
// Every stored row kept the booking link it came from, and those links carry
// Booking's own price for the stay, so the real per-night price can be
// recomputed offline. Rows whose link has no price are left untouched.
//
// Usage: npm run repair-prices [-- --dry-run]
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parseStayTotal } = require('../priceChecker');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'db.json');

function nightsFor(alert) {
  return Math.max(1, Math.round((new Date(alert.checkout) - new Date(alert.checkin)) / 86400000));
}

// Rewrite one stored row in place. Returns 'corrected', 'unchanged' or
// 'skipped' so the caller can report what happened.
function repairRow(row, alert) {
  if (!alert) return 'skipped';

  const stayTotal = parseStayTotal(row.url);
  if (stayTotal === null) return 'skipped';

  const corrected = Math.round(stayTotal / nightsFor(alert));

  // Marking the row as link-derived is what lets getNotifiedMinPrices() trust
  // it again, so it happens whether or not the number itself moved.
  const wasTrusted = !!row.price_basis;
  row.price_basis = 'link';

  if (corrected === row.price) return wasTrusted ? 'unchanged' : 'corrected';

  // Keep the message in step with the price it describes.
  if (typeof row.message === 'string') {
    row.message = row.message.replace(
      `${alert.currency} ${row.price}/night`,
      `${alert.currency} ${corrected}/night`
    );
  }
  row.price = corrected;
  return 'corrected';
}

function repairAll(db) {
  const alerts = Object.fromEntries(db.alerts.map(a => [a.id, a]));
  const summary = {};

  for (const [label, rows] of [['price history', db.price_history], ['notifications', db.notifications]]) {
    const counts = { corrected: 0, unchanged: 0, skipped: 0 };
    for (const row of rows) counts[repairRow(row, alerts[row.alert_id])]++;
    summary[label] = counts;
  }

  // Re-point each alert's headline price at its most recent corrected reading.
  let refreshedAlerts = 0;
  for (const alert of db.alerts) {
    const latest = db.price_history
      .filter(p => p.alert_id === alert.id)
      .sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at))[0];

    if (latest && alert.last_price !== latest.price) {
      alert.last_price = latest.price;
      refreshedAlerts++;
    }
  }
  summary.alerts = refreshedAlerts;

  return summary;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

  console.log(`Repairing ${DB_FILE}${dryRun ? ' (dry run)' : ''}`);
  const summary = repairAll(db);

  let changed = summary.alerts;
  for (const label of ['price history', 'notifications']) {
    const c = summary[label];
    changed += c.corrected;
    console.log(`  ${label}: ${c.corrected} corrected, ${c.unchanged} already right, ${c.skipped} left alone (no price in link)`);
  }
  console.log(`  alerts: ${summary.alerts} last_price value(s) refreshed`);

  if (dryRun) {
    console.log('Dry run - nothing written.');
  } else if (changed === 0) {
    console.log('Nothing to repair.');
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    console.log('Done. Commit data/db.json to keep the corrected history.');
  }
}

if (require.main === module) main();

module.exports = { repairRow, repairAll, nightsFor };
