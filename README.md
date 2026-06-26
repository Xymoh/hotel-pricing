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
