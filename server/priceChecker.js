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

    // Extract hotel data from the page
    const results = await page.evaluate((currency) => {
      const cards = document.querySelectorAll('[data-testid="property-card"]');
      const hotels = [];
      
      cards.forEach((card, i) => {
        if (i >= 10) return; // Check top 10 results
        
        const nameEl = card.querySelector('[data-testid="title"]');
        const hotelName = nameEl ? nameEl.textContent.trim() : '';
        
        // Try multiple selectors for price
        let priceText = '';
        const priceSelectors = [
          '[data-testid="price-and-discounted-price"]',
          '[class*="prco-valign-middle-helper"]',
          '[class*="price_display"]',
          'span[class*="price"]',
          '[data-testid="price-for-x-nights"]'
        ];
        
        for (const sel of priceSelectors) {
          const el = card.querySelector(sel);
          if (el && el.textContent.trim()) {
            priceText = el.textContent.trim();
            break;
          }
        }
        
        // If still no price, look for any element with currency symbol or number pattern
        if (!priceText) {
          const allSpans = card.querySelectorAll('span');
          for (const span of allSpans) {
            const text = span.textContent.trim();
            if (/[\d.,]+/.test(text) && (text.includes('€') || text.includes('$') || text.includes('£') || text.includes('zł') || text.includes('PLN') || text.includes('kr') || /^\s*\d/.test(text))) {
              priceText = text;
              break;
            }
          }
        }
        
        // Extract numeric price - handle "PLN 1,500" or "€150" or "1 440 zł" etc.
        // Remove currency symbols and text, keep digits, commas, dots, spaces
        let cleaned = priceText.replace(/[^\d.,\s]/g, '').trim();
        // Handle thousands separators: "1,440" or "1 440" or "1.440" (European)
        // If there's a comma followed by exactly 3 digits at end, it's a thousands separator
        // If there's a dot followed by exactly 2 digits at end, it's decimal
        cleaned = cleaned.replace(/\s/g, ''); // Remove spaces used as thousands sep
        // Determine if comma is thousands or decimal separator
        if (/,\d{3}$/.test(cleaned) && !cleaned.includes('.')) {
          // Comma is thousands separator (e.g., "1,440")
          cleaned = cleaned.replace(/,/g, '');
        } else if (/\.\d{3}$/.test(cleaned) && !cleaned.includes(',')) {
          // Dot is thousands separator (e.g., "1.440" European)
          cleaned = cleaned.replace(/\./g, '');
        } else {
          // Assume comma is decimal
          cleaned = cleaned.replace(',', '.');
        }
        const price = parseFloat(cleaned) || 0;
        
        // Get link
        const linkEl = card.querySelector('a[data-testid="title-link"]') || card.querySelector('a');
        let link = linkEl ? linkEl.href : '';
        
        // Check if Genius discount is shown
        const hasGenius = !!card.querySelector('[class*="genius"], [data-testid*="genius"]');
        
        if (hotelName && price > 0) {
          hotels.push({ hotelName, price, url: link, priceText, hasGenius });
        }
      });
      
      return hotels;
    }, alert.currency);

    console.log(`  Found ${results.length} hotels with prices`);

    if (results.length > 0) {
      // Booking.com shows TOTAL price for the stay in search results
      // Calculate per-night price
      const checkinDate = new Date(alert.checkin);
      const checkoutDate = new Date(alert.checkout);
      const nights = Math.max(1, Math.round((checkoutDate - checkinDate) / (1000 * 60 * 60 * 24)));
      
      const processedResults = results.map(r => {
        // Total price divided by nights = per night price
        const perNightPrice = Math.round(r.price / nights);
        return { ...r, perNightPrice };
      }).sort((a, b) => a.perNightPrice - b.perNightPrice);

      // Find all hotels within budget
      const matchingHotels = processedResults.filter(r => r.perNightPrice <= alert.max_price);
      const cheapest = processedResults[0];

      const geniusLabel = cheapest.hasGenius ? ' (Genius price)' : '';
      console.log(`  Cheapest: ${cheapest.hotelName} at ${alert.currency} ${cheapest.perNightPrice}/night${geniusLabel} (total: ${cheapest.price} for ${nights} nights)`);
      console.log(`  ${matchingHotels.length}/${processedResults.length} hotels within budget of ${alert.currency} ${alert.max_price}/night`);

      // Record cheapest price in history and update alert
      db.addPriceHistory(alert.id, cheapest.perNightPrice, cheapest.hotelName, cheapest.url);
      db.updateAlertPrice(alert.id, cheapest.perNightPrice);

      // Create notifications for ALL hotels within budget
      if (matchingHotels.length > 0) {
        const notifiedHotels = [];

        for (const hotel of matchingHotels) {
          const hotelGeniusLabel = hotel.hasGenius ? ' (Genius)' : '';
          const message = `🏨 ${hotel.hotelName} in ${alert.destination} — ${alert.currency} ${hotel.perNightPrice}/night${hotelGeniusLabel}`;
          const notification = db.addNotification(alert.id, hotel.hotelName, hotel.perNightPrice, hotel.url, message);

          // Broadcast via SSE
          if (global.broadcast) {
            global.broadcast(notification);
          }

          notifiedHotels.push({ hotelName: hotel.hotelName, price: hotel.perNightPrice, url: hotel.url, hasGenius: hotel.hasGenius });
        }

        // Send one summary email with all matching hotels
        const summaryNotification = {
          hotel_name: `${matchingHotels.length} hotels`,
          price: cheapest.perNightPrice,
          url: buildBookingUrl(alert),
          message: `Found ${matchingHotels.length} hotels in ${alert.destination} within your budget of ${alert.currency} ${alert.max_price}/night`
        };
        await notifier.notify(summaryNotification, alert, matchingHotels);

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
