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
    console.log(`Checked ${results.length} alert(s), ${found.length} within budget.`);
  } catch (err) {
    console.error('Price check failed:', err.message);
    process.exit(1);
  }
})();
