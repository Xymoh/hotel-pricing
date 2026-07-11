# 🏨 Hotel Price Monitor

Monitor hotel prices on Booking.com and get notified when they drop below your budget. You set the parameters, it watches the prices — you book manually when you're ready.

## Features

- **Search parameters** like Booking.com: destination, dates, adults, children, rooms, star rating
- **Price threshold alerts** — set your max budget per night
- **Automated checking** — prices checked every 30 minutes (configurable)
- **Multiple notifications**: browser push notifications + email (optional)
- **Price history** tracking for each alert
- **Manual check** button for immediate price lookup
- **Real-time updates** via Server-Sent Events

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Then open http://localhost:3000 in your browser.

## Configuration

Copy `.env.example` to `.env` and configure:

- **Email notifications** (optional): Set SMTP credentials for email alerts
- **Check interval**: How often to check prices (default: 30 minutes)
- **Port**: Server port (default: 3000)

### Gmail Setup (for email notifications)

1. Enable 2FA on your Google account
2. Generate an App Password: Google Account → Security → App passwords
3. Use your email as `SMTP_USER` and the app password as `SMTP_PASS`

## How It Works

1. You create a price alert with your travel parameters and maximum budget
2. The server periodically checks Booking.com for the cheapest hotels matching your criteria
3. When a price drops below your budget, you get notified (browser + email)
4. Click the booking link to go directly to the deal and book it yourself

## Important Notes

- This tool **only monitors and notifies** — it does not book anything
- Web scraping is subject to site structure changes; selectors may need updating
- Be respectful of Booking.com's servers — don't set intervals too low
- For personal use only

## Tech Stack

- **Backend**: Node.js, Express, node-cron
- **Scraping**: Puppeteer (headless Chrome) to bypass WAF protection
- **Frontend**: Vanilla HTML/CSS/JS (no build step needed)
- **Notifications**: Nodemailer (email) + Web Notifications API (browser) + SSE (real-time)

## Running checks even when your PC is off

This is a full-stack app (Express + Puppeteer + cron + email), so it can't run on
GitHub Pages (static hosting only, no server process to keep alive). Instead, a
[GitHub Actions workflow](.github/workflows/price-check.yml) runs the price check on a
schedule (every 30 minutes) in the cloud, for free, with no server to host or pay for:

1. **Add SMTP secrets**: repo Settings → Secrets and variables → Actions → New repository
   secret. Add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFICATION_EMAIL`
   (same values you'd put in `.env`).
2. **Manage alerts locally** via `npm start` and the dashboard at `http://localhost:3000`,
   same as before.
3. **After adding/editing/deleting an alert locally, sync it to the repo** so the scheduled
   check picks it up: `npm run sync` (commits & pushes `data/db.json`). Run `git pull`
   before starting the dashboard too, so you see price history/notifications the scheduled
   run collected while you were away.
4. The workflow also runs on demand: repo → Actions → "Hotel Price Check" → Run workflow.

Notes:
- `data/db.json` (alerts, price history, notifications) is committed to the repo so state
  persists between scheduled runs — this repo is public, so that data is publicly visible.
  Make the repo private if that's not okay for you.
- `data/booking-cookies.json` (Genius login session) is **never** committed — it's a
  credential, not data, and stays gitignored.
- The "Genius login" browser popup (`/api/genius/login`) opens a visible Chrome/Brave window
  for interactive login, which only works locally, not in the GitHub Actions runner.
- To get **Genius-discounted prices in the scheduled checks too**, add a `BOOKING_COOKIES_JSON`
  repo secret with the full contents of your local `data/booking-cookies.json` (created after
  logging in via the Genius button). The workflow writes it to the runner before each check —
  never committed to the repo, since it's a session credential. This gives real discounted
  prices as shown by Booking.com for your account, not a guessed/hardcoded percentage (Genius
  discounts vary per hotel, so a flat number would be inaccurate). Booking.com sessions expire
  after a while — if scheduled emails quietly go back to public pricing, redo the Genius login
  locally and update the secret with the new cookie file contents.
- Scheduled GitHub Actions runs can slip by several minutes under load, and auto-disable
  after 60 days with no commits to the repo (any commit, including `npm run sync`, resets
  that clock).
