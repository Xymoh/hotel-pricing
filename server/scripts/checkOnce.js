// Standalone entry point for running a single price check without the Express
// server - used by the GitHub Actions schedule so checks happen even when
// nobody's machine is running the app.
require('dotenv').config();
const priceChecker = require('../priceChecker');

(async () => {
  console.log(`[${new Date().toISOString()}] Running scheduled price check...`);
  try {
    const results = await priceChecker.checkAllAlerts();
    const found = results.filter(r => r.found);
    const failed = results.filter(r => r.error);
    console.log(`Checked ${results.length} alert(s), ${found.length} within budget.`);

    // Call out alerts that produced no price at all. Without this a monitor can
    // stop working for weeks with nothing in the run log to show it.
    if (failed.length > 0) {
      console.log(`::warning::${failed.length} of ${results.length} alert(s) produced no price this run`);
      for (const result of failed) {
        console.log(`::warning title=No price for ${result.destination}::${result.error}`);
      }
    }
  } catch (err) {
    console.error('Price check failed:', err.message);
    process.exit(1);
  }
})();
