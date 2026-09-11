const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');

const { extractHotels, perNightPriceFor } = require('../server/priceChecker');

// Booking's own price for the stay: EUR 523.36 across 4 nights = EUR 131/night.
const LINK = 'https://www.booking.com/hotel/de/kaiserswerth.html' +
  '?checkin=2027-07-08&checkout=2027-07-12&sr_pri_blocks=816576101_401775398_2_2_0__52336';

// A stand-in for a Booking search-results page, with the card markup the
// scraper keys off. `shown` is what the card displays - the whole point is that
// Booking sometimes puts the nightly rate there and sometimes the stay total.
function resultsPage(shown, redirectAfterMs) {
  const redirect = redirectAfterMs
    ? `<script>setTimeout(() => location.replace('/search?settled=1'), ${redirectAfterMs});</script>`
    : '';

  return `<!doctype html><html><body>
    <div data-testid="property-card">
      <div data-testid="title">Hotel Kaiserswerth</div>
      <a data-testid="title-link" href="${LINK}">Hotel Kaiserswerth</a>
      <div class="price-block">
        <span data-testid="price-and-discounted-price">&euro; ${shown}</span>
        <div data-testid="price-for-x-nights">4 nights, 2 adults</div>
      </div>
    </div>
    ${redirect}
  </body></html>`;
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  return candidates.find(p => p && fs.existsSync(p));
}

const CHROME = findChrome();
const NIGHTS = 4;

test('a late redirect no longer loses the whole check', { skip: CHROME ? false : 'no Chrome available' }, async (t) => {
  const puppeteer = require('puppeteer-core');

  // Serves a page that re-navigates 1.5s after first paint, the way Booking
  // does when it resolves a free-text destination into its canonical URL. That
  // redirect is what made every Poznan check fail with "Execution context was
  // destroyed, most likely because of a navigation".
  const server = http.createServer((req, res) => {
    const settled = req.url.includes('settled=1');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(resultsPage('131', settled ? 0 : 1500));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  t.after(async () => {
    await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  });

  const page = await browser.newPage();
  await page.goto(`${base}/search`, { waitUntil: 'networkidle2' });

  const hotels = await extractHotels(page);

  assert.strictEqual(hotels.length, 1);
  assert.strictEqual(hotels[0].hotelName, 'Hotel Kaiserswerth');
  assert.ok(hotels[0].url.includes('sr_pri_blocks'), 'the booking link must survive');
  assert.strictEqual(page.url(), `${base}/search?settled=1`, 'the redirect did happen');
});

test('a card showing the nightly rate and one showing the stay total agree', { skip: CHROME ? false : 'no Chrome available' }, async (t) => {
  const puppeteer = require('puppeteer-core');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(resultsPage(req.url.includes('total') ? '523' : '131'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  t.after(async () => {
    await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  });

  const priceFor = async (variant) => {
    const page = await browser.newPage();
    await page.goto(`${base}/search?${variant}`, { waitUntil: 'networkidle2' });
    const [hotel] = await extractHotels(page);
    await page.close();
    return perNightPriceFor(hotel, NIGHTS).perNightPrice;
  };

  const nightlyVariant = await priceFor('nightly');
  const totalVariant = await priceFor('total');

  // The regression: the nightly variant used to come out as 131/4 = 33.
  assert.strictEqual(nightlyVariant, 131);
  assert.strictEqual(totalVariant, 131);
});

// Deterministic cover for the retry path - a real browser can't be made to
// navigate exactly during the evaluate call on cue. settlePage probes the page
// with its own small function, so the fake tells the two apart by name and only
// fails the scrape itself.
function fakePage(onScrape) {
  return {
    url: () => 'http://example.test/search',
    waitForSelector: async () => ({}),
    evaluate: async (fn) => (fn && fn.name === 'scrapeCards' ? onScrape() : true)
  };
}

test('extraction retries when the page navigates mid-read', async () => {
  let attempts = 0;
  const page = fakePage(() => {
    attempts++;
    if (attempts === 1) {
      throw new Error('Execution context was destroyed, most likely because of a navigation.');
    }
    return [{ hotelName: 'Hotel Kaiserswerth', url: LINK, priceText: '', basisText: '' }];
  });

  const hotels = await extractHotels(page);

  assert.strictEqual(attempts, 2, 'the scrape itself should have been retried once');
  assert.strictEqual(hotels.length, 1);
  assert.strictEqual(perNightPriceFor(hotels[0], NIGHTS).perNightPrice, 131);
});

test('extraction gives up on an error that is not a navigation', async () => {
  let attempts = 0;
  const page = fakePage(() => {
    attempts++;
    throw new Error('some other failure');
  });

  await assert.rejects(() => extractHotels(page), /some other failure/);
  assert.strictEqual(attempts, 1, 'a non-navigation error should not be retried');
});
