const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const notifier = require('./notifier');

// Find Chrome executable
const CHROME_PATH = process.env.CHROME_PATH || 
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Cookies file for Booking.com session (Genius discounts)
const COOKIES_FILE = path.join(__dirname, '..', 'data', 'booking-cookies.json');

// How long to wait for Booking to stop redirecting before reading the page,
// and how long the URL must hold still to count as settled.
const SETTLE_TIMEOUT_MS = 20000;
const URL_STABLE_MS = 2000;
const EXTRACT_ATTEMPTS = 3;

let browser = null;

async function getBrowser() {
  if (browser && browser.connected) {
    return browser;
  }
  
  browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ]
  });
  
  return browser;
}

async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

// Load Booking.com cookies for Genius pricing
async function loadCookies(page) {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log(`  Loaded ${cookies.length} cookies (Genius pricing enabled)`);
        return true;
      }
    }
  } catch (err) {
    console.log(`  Could not load cookies: ${err.message}`);
  }
  console.log('  No Booking.com cookies found - showing public prices (no Genius discounts)');
  return false;
}

// ---------------------------------------------------------------------------
// Price parsing
// ---------------------------------------------------------------------------

// Booking's result-card link carries its own price for the whole stay in minor
// units, as the last segment of sr_pri_blocks
// (...&sr_pri_blocks=<hotel>_<block>_<n>_<n>_<n>__<total>). That number is
// unambiguous, which the rendered price text is not: Booking renders the stay
// total in some responses and the nightly rate in others, with no change to the
// markup around it. Treating the rendered number as a total and dividing it by
// the night count is what produced alerts roughly `nights` times cheaper than
// the real price.
function parseStayTotal(url) {
  const match = /[?&]sr_pri_blocks=([^&]+)/.exec(url || '');
  if (!match) return null;

  const segments = decodeURIComponent(match[1]).split('_');
  const last = segments[segments.length - 1];
  if (!/^\d+$/.test(last)) return null;

  const total = parseInt(last, 10) / 100;
  return Number.isFinite(total) && total > 0 ? total : null;
}

// Read the number out of a rendered price, e.g. "€ 262 € 131" -> 131. When a
// card shows a struck-through price next to the current one both end up in the
// same text node, and the current price is always the last of the two.
function parsePriceText(text) {
  const tokens = String(text || '').match(/\d[\d.,\u00a0 ]*\d|\d/g);
  if (!tokens || tokens.length === 0) return 0;

  let cleaned = tokens[tokens.length - 1].replace(/[\u00a0 ]/g, '');

  // Whichever of . or , comes last is the decimal separator if 1-2 digits
  // follow it; every other . or , is a thousands separator.
  const decimalPos = Math.max(cleaned.lastIndexOf('.'), cleaned.lastIndexOf(','));
  const trailingDigits = decimalPos === -1 ? -1 : cleaned.length - decimalPos - 1;
  if (trailingDigits === 1 || trailingDigits === 2) {
    cleaned = cleaned.slice(0, decimalPos).replace(/[.,]/g, '') + '.' + cleaned.slice(decimalPos + 1);
  } else {
    cleaned = cleaned.replace(/[.,]/g, '');
  }

  return parseFloat(cleaned) || 0;
}

// Fallback for cards whose link has no sr_pri_blocks: Booking labels the price
// block with what it covers ("for 4 nights", "per night"). Only an explicit
// label counts - guessing here is the original bug.
function nightsFromLabel(text) {
  const match = /(\d+)\s*(?:nights?|nocy|noce|n[äa]chte|nacht)\b/i.exec(text || '');
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return n > 0 && n <= 365 ? n : null;
}

function isPerNightLabel(text) {
  return /per night|\/\s*night|a night|per noc|za noc|pro nacht/i.test(text || '');
}

// Work out what one night actually costs for a single result card. Returns null
// when the card gives us no trustworthy basis - we skip those rather than guess.
function perNightPriceFor(hotel, nights) {
  const stayTotal = parseStayTotal(hotel.url);
  const displayed = parsePriceText(hotel.priceText);

  if (stayTotal !== null) {
    const perNight = stayTotal / nights;

    // Cross-check the rendered price against the link so we hear about it if
    // Booking ever changes either one, instead of silently drifting again.
    if (displayed > 0) {
      const near = (a, b) => Math.abs(a - b) <= Math.max(1, b * 0.02);
      if (!near(displayed, stayTotal) && !near(displayed, perNight)) {
        console.log(`  ⚠️  ${hotel.hotelName}: shown price "${hotel.priceText}" matches neither the stay total (${stayTotal.toFixed(2)}) nor the nightly rate (${perNight.toFixed(2)}) - trusting the booking link`);
      }
    }

    return { perNightPrice: Math.round(perNight), stayTotal, basis: 'link' };
  }

  if (displayed > 0) {
    const labelNights = nightsFromLabel(hotel.basisText);
    if (labelNights) {
      return { perNightPrice: Math.round(displayed / labelNights), stayTotal: displayed, basis: 'label' };
    }
    if (isPerNightLabel(hotel.basisText)) {
      return { perNightPrice: Math.round(displayed), stayTotal: displayed * nights, basis: 'label' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Page handling
// ---------------------------------------------------------------------------

// Runs inside the page. It only collects raw facts - what the price means is
// decided in Node, where it can be cross-checked against the booking link.
function scrapeCards() {
  const cards = document.querySelectorAll('[data-testid="property-card"]');

  return Array.prototype.slice.call(cards, 0, 10).map(card => {
    const nameEl = card.querySelector('[data-testid="title"]');
    const hotelName = nameEl ? nameEl.textContent.trim() : '';

    const linkEl = card.querySelector('a[data-testid="title-link"]') || card.querySelector('a');
    const priceEl = card.querySelector('[data-testid="price-and-discounted-price"]');

    // Keep the text around the price too - that's where Booking says whether
    // the figure covers one night or the whole stay.
    const priceBlock = priceEl || card.querySelector('[data-testid="price-for-x-nights"]');
    const basisScope = priceBlock ? (priceBlock.parentElement || priceBlock) : null;

    return {
      hotelName,
      url: linkEl ? linkEl.href : '',
      priceText: priceEl ? priceEl.textContent.trim() : '',
      basisText: basisScope ? basisScope.textContent.trim().slice(0, 200) : '',
      hasGenius: !!card.querySelector('[class*="genius"], [data-testid*="genius"]')
    };
  }).filter(hotel => hotel.hotelName);
}

// Booking re-navigates a few seconds after the first paint whenever it resolves
// a free-text destination into its canonical search URL. page.evaluate racing
// that redirect throws "Execution context was destroyed", which is why the
// Poznan alert failed on every single run. Wait for the URL to stop moving and
// the cards to be present before reading the DOM.
async function settlePage(page) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let lastUrl = page.url();
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    await page.waitForSelector('[data-testid="property-card"]', { timeout: 5000 }).catch(() => {});

    let currentUrl = lastUrl;
    try {
      currentUrl = page.url();
    } catch {
      // Context torn down mid-navigation; treat as "still moving".
    }

    if (currentUrl !== lastUrl) {
      console.log(`  Page redirected to ${currentUrl}, waiting for it to settle...`);
      lastUrl = currentUrl;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= URL_STABLE_MS) {
      const ready = await page
        .evaluate(() => document.querySelectorAll('[data-testid="property-card"]').length > 0)
        .catch(() => false);
      if (ready) return true;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return false;
}

function isNavigationError(err) {
  return /Execution context was destroyed|Cannot find context|Target closed|detached Frame|frame got detached/i.test(err.message || '');
}

// Extract the result cards, retrying when a late redirect tears the page out
// from under us instead of failing the whole alert.
async function extractHotels(page) {
  for (let attempt = 1; attempt <= EXTRACT_ATTEMPTS; attempt++) {
    const settled = await settlePage(page);
    if (!settled) {
      console.log(`  Page never settled (attempt ${attempt}/${EXTRACT_ATTEMPTS}), extracting what's there...`);
    }

    try {
      return await page.evaluate(scrapeCards);
    } catch (err) {
      if (!isNavigationError(err) || attempt === EXTRACT_ATTEMPTS) throw err;
      console.log(`  Page navigated mid-extraction (attempt ${attempt}/${EXTRACT_ATTEMPTS}), retrying...`);
    }
  }

  return [];
}

function buildBookingUrl(alert) {
  const baseUrl = 'https://www.booking.com/searchresults.html';
  const params = new URLSearchParams({
    ss: alert.destination,
    checkin: alert.checkin,
    checkout: alert.checkout,
    group_adults: alert.adults.toString(),
    no_rooms: alert.rooms.toString(),
    group_children: alert.children.toString(),
    selected_currency: alert.currency || 'EUR',
    order: alert.sort_by === 'price' ? 'price' : 'popularity'
  });

  // Add star rating filter if specified
  if (alert.star_rating) {
    const stars = alert.star_rating.split(',');
    stars.forEach(star => {
      params.append('nflt', `class=${star}`);
    });
  }

  return `${baseUrl}?${params.toString()}`;
}

async function checkAlert(alert) {
  const url = buildBookingUrl(alert);
  console.log(`Checking: ${alert.destination} (${alert.checkin} to ${alert.checkout})`);
  console.log(`  URL: ${url}`);

  let page = null;
  
  try {
    const b = await getBrowser();
    page = await b.newPage();
    
    // Set viewport and user agent to appear as a regular browser
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Remove automation indicators
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });

    // Load cookies BEFORE navigating (for Genius discounts)
    await loadCookies(page);

    // Navigate and wait for content to load
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for the WAF challenge to resolve (if present) - it usually auto-redirects
    const currentUrl = page.url();
    if (currentUrl.includes('challenge') || (await page.title().catch(() => '')) === '') {
      console.log('  WAF challenge detected, waiting for resolution...');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    // Dismiss cookie banner if present. Done before extracting, so that any
    // re-render it triggers is absorbed by the settle step below.
    await page.click('[id*="accept"], [class*="cookie"] button, #onetrust-accept-btn-handler')
      .catch(() => {});

    // Extract hotel data from the page
    const results = await extractHotels(page);

    console.log(`  Found ${results.length} hotels`);

    if (results.length > 0) {
      const checkinDate = new Date(alert.checkin);
      const checkoutDate = new Date(alert.checkout);
      const nights = Math.max(1, Math.round((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24)));

      const processedResults = [];
      const unpriced = [];

      for (const hotel of results) {
        const priced = perNightPriceFor(hotel, nights);
        if (priced && priced.perNightPrice > 0) {
          processedResults.push({ ...hotel, ...priced });
        } else {
          unpriced.push(hotel.hotelName);
        }
      }

      processedResults.sort((a, b) => a.perNightPrice - b.perNightPrice);

      if (unpriced.length > 0) {
        console.log(`  Skipped ${unpriced.length} hotel(s) with no readable price: ${unpriced.join(', ')}`);
      }

      // Every card being unreadable means the page changed shape on us. Report
      // it as a failed check rather than as "no deals today", which would look
      // identical from the dashboard.
      if (processedResults.length === 0) {
        return { found: false, error: `Found ${results.length} hotels but could not read a price for any of them` };
      }

      // Find all hotels within budget
      const matchingHotels = processedResults.filter(r => r.perNightPrice <= alert.max_price);
      const cheapest = processedResults[0];

      const geniusLabel = cheapest.hasGenius ? ' (Genius price)' : '';
      console.log(`  Cheapest: ${cheapest.hotelName} at ${alert.currency} ${cheapest.perNightPrice}/night${geniusLabel} (total: ${cheapest.stayTotal.toFixed(2)} for ${nights} nights, from ${cheapest.basis})`);
      console.log(`  ${matchingHotels.length}/${processedResults.length} hotels within budget of ${alert.currency} ${alert.max_price}/night`);

      // Record cheapest price in history and update alert
      db.addPriceHistory(alert.id, cheapest.perNightPrice, cheapest.hotelName, cheapest.url, cheapest.basis);
      db.updateAlertPrice(alert.id, cheapest.perNightPrice);

      // Only notify about hotels that are new or have dropped below the
      // lowest price we already notified about, so a check doesn't re-blast
      // the same matches it already told you about every 30 minutes.
      const notifiedMinPrices = db.getNotifiedMinPrices(alert.id);
      const newHotels = matchingHotels.filter(hotel => {
        const prevMin = notifiedMinPrices[hotel.hotelName];
        return prevMin === undefined || hotel.perNightPrice < prevMin;
      });

      if (newHotels.length > 0) {
        const notifiedHotels = [];

        for (const hotel of newHotels) {
          const hotelGeniusLabel = hotel.hasGenius ? ' (Genius)' : '';
          const message = `🏨 ${hotel.hotelName} in ${alert.destination} — ${alert.currency} ${hotel.perNightPrice}/night${hotelGeniusLabel}`;
          const notification = db.addNotification(alert.id, hotel.hotelName, hotel.perNightPrice, hotel.url, message, hotel.basis);

          // Broadcast via SSE
          if (global.broadcast) {
            global.broadcast(notification);
          }

          notifiedHotels.push({ hotelName: hotel.hotelName, price: hotel.perNightPrice, url: hotel.url, hasGenius: hotel.hasGenius });
        }

        // Send one summary email with only the new/lower-priced hotels
        const summaryNotification = {
          hotel_name: `${newHotels.length} hotels`,
          price: cheapest.perNightPrice,
          url: buildBookingUrl(alert),
          message: `Found ${newHotels.length} new hotel${newHotels.length > 1 ? 's' : ''} in ${alert.destination} within your budget of ${alert.currency} ${alert.max_price}/night`
        };
        await notifier.notify(summaryNotification, alert, newHotels);

        return { found: true, matches: notifiedHotels.length, hotels: notifiedHotels };
      }

      return { found: false, cheapest: cheapest.perNightPrice, hotelName: cheapest.hotelName };
    }

    // Debug: save page content for troubleshooting
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log(`  Page title: "${title}"`);
    console.log(`  Body preview: ${bodyText.substring(0, 200)}`);
    console.log(`  No results parsed for ${alert.destination}.`);
    
    return { found: false, error: 'No results parsed - page may not have loaded properly' };

  } catch (err) {
    console.error(`  Error checking ${alert.destination}:`, err.message);
    return { found: false, error: err.message };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function checkAllAlerts() {
  const alerts = db.getActiveAlerts();
  const results = [];

  for (const alert of alerts) {
    // Check if dates are still in the future
    if (new Date(alert.checkin) < new Date()) {
      console.log(`  Skipping expired alert for ${alert.destination} (checkin: ${alert.checkin})`);
      continue;
    }

    const result = await checkAlert(alert);
    results.push({ alertId: alert.id, destination: alert.destination, ...result });

    // Record failures against the alert too. Without this a permanently broken
    // check is indistinguishable from one that just never finds a deal: the
    // alert simply keeps showing whatever it last saw, which is how the Poznan
    // alert sat dead for weeks.
    if (result.error) {
      db.recordCheckFailure(alert.id, result.error);
    }

    // Random delay between checks (3-6 seconds) to be respectful
    const delay = 3000 + Math.random() * 3000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // Close browser after all checks to free resources
  await closeBrowser();

  return results;
}

// Export cookies from a logged-in Booking.com session
// Opens a visible Chrome window for the user to log in
async function exportCookiesFromLogin() {
  let loginBrowser = null;
  
  try {
    // Launch browser in visible mode for login
    loginBrowser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false, // Visible so user can log in
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1200,900'
      ]
    });
    
    const loginPage = await loginBrowser.newPage();
    await loginPage.setViewport({ width: 1200, height: 900 });
    
    // Go to Booking.com sign-in page
    await loginPage.goto('https://account.booking.com/sign-in', { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    console.log('=== Genius Login ===');
    console.log('Browser window opened. Please log into your Booking.com account.');
    console.log('Waiting up to 5 minutes for login to complete...');
    
    // Poll for login success — check for session cookies
    // Booking.com sets various cookies upon successful authentication
    const startTime = Date.now();
    const TIMEOUT = 5 * 60 * 1000; // 5 minutes
    let loggedIn = false;
    
    while (Date.now() - startTime < TIMEOUT) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        // Check if browser was closed by user
        if (!loginBrowser.connected) {
          throw new Error('Browser was closed before login completed');
        }

        const cookies = await loginPage.cookies('https://www.booking.com');
        const cookieNames = cookies.map(c => c.name);
        
        // Check for authentication cookies that indicate successful login
        const hasAuth = cookieNames.some(name => 
          name.includes('bkng_sso_auth') || 
          name.includes('bkng_sso_session') ||
          name.includes('login_token') ||
          name === 'bkng_auth_profile'
        );
        
        if (hasAuth) {
          loggedIn = true;
          break;
        }
        
        // Also check by navigating — if we can reach the account page
        const currentUrl = loginPage.url();
        if (currentUrl.includes('mysettings') || currentUrl.includes('mydashboard') || 
            (currentUrl === 'https://www.booking.com/' && cookies.length > 10)) {
          loggedIn = true;
          break;
        }
      } catch (e) {
        if (e.message.includes('closed') || e.message.includes('disconnected')) {
          throw new Error('Browser was closed before login completed');
        }
      }
    }
    
    if (!loggedIn) {
      throw new Error('Login timed out after 5 minutes');
    }
    
    // Navigate to booking.com main page to collect all relevant cookies
    await loginPage.goto('https://www.booking.com/', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Collect all booking.com cookies
    const allCookies = await loginPage.cookies(
      'https://www.booking.com',
      'https://account.booking.com',
      'https://secure.booking.com'
    );
    
    // Save cookies
    const dataDir = path.dirname(COOKIES_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(allCookies, null, 2));
    
    console.log(`✅ Login successful! Saved ${allCookies.length} cookies.`);
    console.log('Genius discounts will now be applied to price checks.');
    
    await loginBrowser.close();
    return { success: true, cookieCount: allCookies.length };
    
  } catch (err) {
    console.error('❌ Genius login failed:', err.message);
    if (loginBrowser && loginBrowser.connected) {
      await loginBrowser.close().catch(() => {});
    }
    return { success: false, error: err.message };
  }
}

function hasGeniusCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
      return Array.isArray(cookies) && cookies.length > 0;
    }
  } catch {}
  return false;
}

// Clean up on process exit
process.on('exit', () => closeBrowser());
process.on('SIGINT', async () => { await closeBrowser(); process.exit(); });
process.on('SIGTERM', async () => { await closeBrowser(); process.exit(); });

module.exports = {
  checkAllAlerts,
  checkAlert,
  buildBookingUrl,
  exportCookiesFromLogin,
  hasGeniusCookies,
  // exported for tests
  extractHotels,
  parseStayTotal,
  parsePriceText,
  perNightPriceFor
};
