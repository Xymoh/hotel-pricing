const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const notifier = require('./notifier');
const {
  parseMoney,
  parseAllMoney,
  hasCurrencyMarker,
  detectBasis,
  parseLinkTotal,
  nightsBetween,
  resolveStayPrice,
  simplifyDestination
} = require('./priceParser');

// Find Chrome executable
const CHROME_PATH = process.env.CHROME_PATH || 
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Cookies file for Booking.com session (Genius discounts)
const COOKIES_FILE = path.join(__dirname, '..', 'data', 'booking-cookies.json');

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

function buildBookingUrl(alert, destinationOverride) {
  const baseUrl = 'https://www.booking.com/searchresults.html';
  const params = new URLSearchParams({
    ss: destinationOverride || alert.destination,
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

// Load a search page and return the raw text of every plausible price on each
// property card. Deliberately does no parsing: turning card text into a
// per-night price happens in Node (priceParser) where it can be unit tested.
async function scrapeCards(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for the WAF challenge to resolve (if present) - it usually auto-redirects
  const currentUrl = page.url();
  if (currentUrl.includes('challenge') || (await page.title()) === '') {
    console.log('  WAF challenge detected, waiting for resolution...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  }

  // Wait for property cards to appear
  await page.waitForSelector('[data-testid="property-card"], [class*="property-card"]', {
    timeout: 20000
  }).catch(() => {
    console.log('  Waiting for property cards timed out, trying to extract what we have...');
  });

  // Give a bit more time for prices to render
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Dismiss cookie banner if present
  await page.click('[id*="accept"], [class*="cookie"] button, #onetrust-accept-btn-handler')
    .catch(() => {});

  return page.evaluate(() => {
    const PRICE_SELECTORS = [
      '[data-testid="price-and-discounted-price"]',
      '[data-testid="price-for-x-nights"]',
      '[class*="prco-valign-middle-helper"]',
      '[class*="price_display"]',
      'span[class*="price"]'
    ];

    // Cheap filter so we don't ship every span on the card to Node. The real
    // currency check and number parsing live in priceParser.
    const LOOKS_LIKE_PRICE = /[€$£¥₹]|zł|PLN|EUR|USD|GBP|CHF|SEK|NOK|DKK|CZK|HUF/i;

    // Text surrounding a price, which is where Booking says whether the number
    // is a nightly rate or the total for the stay.
    const contextOf = el => {
      const container = el.closest('[data-testid="availability-rate-information"]') ||
        (el.parentElement && el.parentElement.parentElement) || el.parentElement || el;
      return (container.innerText || '').replace(/\s+/g, ' ').slice(0, 200);
    };

    const cards = Array.from(document.querySelectorAll('[data-testid="property-card"]')).slice(0, 10);

    return cards.map(card => {
      const nameEl = card.querySelector('[data-testid="title"]');
      const candidates = [];
      const add = el => {
        const text = (el.textContent || '').trim();
        if (text && candidates.length < 40) candidates.push({ text, context: contextOf(el) });
      };

      PRICE_SELECTORS.forEach(sel => card.querySelectorAll(sel).forEach(add));
      card.querySelectorAll('span').forEach(el => {
        if (LOOKS_LIKE_PRICE.test(el.textContent || '')) add(el);
      });

      const linkEl = card.querySelector('a[data-testid="title-link"]') || card.querySelector('a');

      return {
        hotelName: nameEl ? nameEl.textContent.trim() : '',
        candidates,
        url: linkEl ? linkEl.href : '',
        hasGenius: !!card.querySelector('[class*="genius"], [data-testid*="genius"]')
      };
    });
  });
}

// First candidate on a card that actually reads as money. Requiring a currency
// marker keeps review scores ("8.9"), distances ("1.2 km") and occupancy labels
// ("4 nights, 2 adults") from being mistaken for prices.
function pickPrice(card) {
  for (const candidate of card.candidates) {
    if (!hasCurrencyMarker(candidate.text)) continue;
    const displayedPrice = parseMoney(candidate.text);
    if (!displayedPrice || displayedPrice <= 0) continue;
    return {
      displayedPrice,
      priceText: candidate.text,
      basis: detectBasis(`${candidate.text} ${candidate.context}`),
      contextValues: parseAllMoney(candidate.context)
    };
  }
  return null;
}

async function checkAlert(alert) {
  const nights = nightsBetween(alert.checkin, alert.checkout);
  console.log(`Checking: ${alert.destination} (${alert.checkin} to ${alert.checkout}, ${nights} night${nights > 1 ? 's' : ''})`);

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

    // Booking.com doesn't always resolve the full autocomplete label (it comes
    // from OpenStreetMap, not Booking), and when it doesn't, the search page
    // comes back with no property cards at all. Retry with "City, Country"
    // before giving up instead of silently recording nothing.
    const attempts = [alert.destination];
    const simplified = simplifyDestination(alert.destination);
    if (simplified) attempts.push(simplified);

    let cards = [];
    for (const destination of attempts) {
      const url = buildBookingUrl(alert, destination);
      console.log(`  URL: ${url}`);
      cards = await scrapeCards(page, url);
      if (cards.length > 0) {
        if (destination !== alert.destination) {
          console.log(`  Note: no results for the full destination label, used "${destination}" instead`);
        }
        break;
      }
      console.log(`  No property cards found for "${destination}"`);
    }

    const hotels = [];
    for (const card of cards) {
      const picked = pickPrice(card);
      if (!card.hotelName || !picked) continue;

      const { perNightPrice, totalPrice, priceBasis } = resolveStayPrice({
        displayedPrice: picked.displayedPrice,
        basis: picked.basis,
        linkTotal: parseLinkTotal(card.url),
        contextValues: picked.contextValues
      }, nights);

      hotels.push({
        hotelName: card.hotelName,
        url: card.url,
        hasGenius: card.hasGenius,
        priceText: picked.priceText,
        perNightPrice,
        totalPrice,
        priceBasis
      });
    }
    hotels.sort((a, b) => a.perNightPrice - b.perNightPrice);

    console.log(`  Read prices for ${hotels.length} of ${cards.length} hotels`);

    if (hotels.length === 0) {
      // Never leave a failed check invisible: without this an alert can stop
      // producing results for weeks while the dashboard only shows a stale
      // "last checked" time.
      const title = await page.title();
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      console.log(`  Page title: "${title}"`);
      console.log(`  Body preview: ${bodyText.substring(0, 200)}`);

      const reason = cards.length === 0
        ? 'No property cards on the search page - destination may not resolve on Booking.com, or the request was blocked'
        : 'Property cards found, but no price could be read from them - page markup may have changed';
      console.log(`  ⚠️  ${alert.destination}: ${reason}`);
      db.recordCheckFailure(alert.id, reason);

      return { found: false, error: reason };
    }

    const cheapest = hotels[0];
    const matchingHotels = hotels.filter(r => r.perNightPrice <= alert.max_price);

    const geniusLabel = cheapest.hasGenius ? ' (Genius price)' : '';
    console.log(`  Cheapest: ${cheapest.hotelName} at ${alert.currency} ${cheapest.perNightPrice}/night${geniusLabel} (total: ${cheapest.totalPrice} for ${nights} night${nights > 1 ? 's' : ''}, read as ${cheapest.priceBasis}, card showed "${cheapest.priceText}")`);
    console.log(`  ${matchingHotels.length}/${hotels.length} hotels within budget of ${alert.currency} ${alert.max_price}/night`);

    // Record cheapest price in history and update alert
    db.addPriceHistory(alert.id, cheapest.perNightPrice, cheapest.hotelName, cheapest.url, {
      total_price: cheapest.totalPrice,
      nights,
      price_basis: cheapest.priceBasis
    });
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
        const message = `🏨 ${hotel.hotelName} in ${alert.destination} — ${alert.currency} ${hotel.perNightPrice}/night${hotelGeniusLabel} (${alert.currency} ${hotel.totalPrice} total for ${nights} night${nights > 1 ? 's' : ''})`;
        const notification = db.addNotification(alert.id, hotel.hotelName, hotel.perNightPrice, hotel.url, message, {
          total_price: hotel.totalPrice,
          nights,
          price_basis: hotel.priceBasis
        });

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
      await notifier.notify(summaryNotification, alert, newHotels, nights);

      return { found: true, matches: notifiedHotels.length, hotels: notifiedHotels };
    }

    return { found: false, cheapest: cheapest.perNightPrice, hotelName: cheapest.hotelName };

  } catch (err) {
    console.error(`  Error checking ${alert.destination}:`, err.message);
    db.recordCheckFailure(alert.id, err.message);
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

module.exports = { checkAllAlerts, checkAlert, buildBookingUrl, exportCookiesFromLogin, hasGeniusCookies };
