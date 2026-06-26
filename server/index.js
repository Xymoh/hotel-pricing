require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const db = require('./db');
const priceChecker = require('./priceChecker');
const notifier = require('./notifier');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Initialize database
db.initialize();

// API Routes

// Destination autocomplete - uses OpenStreetMap Nominatim for reliable city lookup
app.get('/api/destinations', async (req, res) => {
  const { query } = req.query;
  if (!query || query.length < 2) {
    return res.json([]);
  }

  try {
    const axios = require('axios');
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: query,
        format: 'json',
        limit: 8,
        addressdetails: 1,
        'accept-language': 'en'
      },
      headers: {
        'User-Agent': 'HotelPriceMonitor/1.0 (personal project)',
        'Accept': 'application/json'
      },
      timeout: 5000
    });

    // Filter and format results - prefer cities, towns, and regions
    const results = response.data
      .filter(item => {
        const type = item.addresstype || item.type;
        return ['city', 'town', 'village', 'administrative', 'state', 'country', 'suburb', 'district', 'municipality'].includes(type);
      })
      .map(item => {
        const address = item.address || {};
        const cityName = address.city || address.town || address.village || address.municipality || item.name;
        const country = address.country || '';
        const region = address.state || address.county || '';
        const type = item.addresstype || item.type;

        // Determine dest_type for display
        let dest_type = 'city';
        if (['state', 'country'].includes(type)) dest_type = 'region';
        else if (['suburb', 'district'].includes(type)) dest_type = 'district';

        // Build a clean label
        let label = item.name;
        if (region && region !== item.name) label += `, ${region}`;
        if (country && country !== item.name) label += `, ${country}`;

        return {
          label,
          dest_id: item.osm_id ? String(item.osm_id) : '',
          dest_type,
          city_name: cityName,
          country,
          region
        };
      })
      // Deduplicate by label
      .filter((item, index, self) => self.findIndex(i => i.label === item.label) === index)
      .slice(0, 6);

    res.json(results);
  } catch (err) {
    console.error('Autocomplete error:', err.message);
    res.json([]);
  }
});

// Get all alerts
app.get('/api/alerts', (req, res) => {
  try {
    const alerts = db.getAllAlerts();
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new alert
app.post('/api/alerts', (req, res) => {
  try {
    const alert = db.createAlert(req.body);
    res.status(201).json(alert);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete an alert
app.delete('/api/alerts/:id', (req, res) => {
  try {
    db.deleteAlert(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update an alert
app.put('/api/alerts/:id', (req, res) => {
  try {
    const alert = db.updateAlert(req.params.id, req.body);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json(alert);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Toggle alert active/inactive
app.patch('/api/alerts/:id/toggle', (req, res) => {
  try {
    const alert = db.toggleAlert(req.params.id);
    res.json(alert);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get price history for an alert
app.get('/api/alerts/:id/history', (req, res) => {
  try {
    const history = db.getPriceHistory(req.params.id);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all notifications
app.get('/api/notifications', (req, res) => {
  try {
    const notifications = db.getNotifications();
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark notification as read
app.patch('/api/notifications/:id/read', (req, res) => {
  try {
    db.markNotificationRead(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual price check trigger
app.post('/api/check-now', async (req, res) => {
  try {
    const results = await priceChecker.checkAllAlerts();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Genius / Cookie management
// Genius login state tracking
let geniusLoginInProgress = false;
let geniusLoginResult = null;

app.get('/api/genius/status', (req, res) => {
  res.json({ 
    enabled: priceChecker.hasGeniusCookies(),
    loginInProgress: geniusLoginInProgress,
    lastLoginResult: geniusLoginResult
  });
});

app.post('/api/genius/login', async (req, res) => {
  if (geniusLoginInProgress) {
    return res.status(409).json({ error: 'Login already in progress. Complete or close the open browser window.' });
  }
  
  try {
    geniusLoginInProgress = true;
    geniusLoginResult = null;
    
    res.json({ message: 'Browser window opened. Please log into your Booking.com account. The window will close automatically after login.' });
    
    // Run in background since it waits for user interaction
    priceChecker.exportCookiesFromLogin().then(result => {
      geniusLoginResult = result;
      geniusLoginInProgress = false;
      console.log('Genius login result:', result);
    }).catch(err => {
      geniusLoginResult = { success: false, error: err.message };
      geniusLoginInProgress = false;
    });
  } catch (err) {
    geniusLoginInProgress = false;
    res.status(500).json({ error: err.message });
  }
});

// Import cookies directly (from browser extension export like "EditThisCookie")
app.post('/api/genius/cookies', (req, res) => {
  try {
    const cookies = req.body;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({ error: 'Provide an array of cookies' });
    }
    
    const fs = require('fs');
    const path = require('path');
    const cookiesFile = path.join(__dirname, '..', 'data', 'booking-cookies.json');
    const dataDir = path.dirname(cookiesFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(cookiesFile, JSON.stringify(cookies, null, 2));
    
    res.json({ success: true, cookieCount: cookies.length, message: 'Cookies saved. Genius discounts will be applied on next check.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/genius/cookies', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const cookiesFile = path.join(__dirname, '..', 'data', 'booking-cookies.json');
    if (fs.existsSync(cookiesFile)) fs.unlinkSync(cookiesFile);
    res.json({ success: true, message: 'Cookies removed. Will use public prices.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint for real-time notifications
const clients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

function broadcastNotification(notification) {
  const data = JSON.stringify(notification);
  clients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// Make broadcast available to other modules
app.locals.broadcast = broadcastNotification;
global.broadcast = broadcastNotification;

// Schedule price checking
const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES) || 30;
const cronExpression = `*/${intervalMinutes} * * * *`;

cron.schedule(cronExpression, async () => {
  console.log(`[${new Date().toISOString()}] Running scheduled price check...`);
  try {
    await priceChecker.checkAllAlerts();
  } catch (err) {
    console.error('Scheduled check failed:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Hotel Price Monitor running at http://localhost:${PORT}`);
  console.log(`Price checks scheduled every ${intervalMinutes} minutes`);
});
