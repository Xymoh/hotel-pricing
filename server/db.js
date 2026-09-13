const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'db.json');

// Default database structure
const DEFAULT_DB = {
  alerts: [],
  price_history: [],
  notifications: [],
  nextId: { alerts: 1, price_history: 1, notifications: 1 }
};

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function readDb() {
  ensureDataDir();
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify(DEFAULT_DB, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  return JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
}

function writeDb(data) {
  ensureDataDir();
  fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

function initialize() {
  readDb(); // Creates file if it doesn't exist
  console.log('Database initialized (JSON file storage)');
}

function getAllAlerts() {
  const db = readDb();
  return db.alerts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getActiveAlerts() {
  const db = readDb();
  return db.alerts.filter(a => a.active);
}

function createAlert(data) {
  const {
    destination, checkin, checkout, adults, children,
    rooms, max_price, currency, star_rating, sort_by,
    dest_id, dest_type
  } = data;

  if (!destination || !checkin || !checkout || !max_price) {
    throw new Error('Missing required fields: destination, checkin, checkout, max_price');
  }

  const db = readDb();
  const alert = {
    id: db.nextId.alerts++,
    destination,
    dest_id: dest_id || '',
    dest_type: dest_type || '',
    checkin,
    checkout,
    adults: parseInt(adults) || 2,
    children: parseInt(children) || 0,
    rooms: parseInt(rooms) || 1,
    max_price: parseFloat(max_price),
    currency: currency || 'EUR',
    star_rating: star_rating || '',
    sort_by: sort_by || 'price',
    active: 1,
    last_checked: null,
    last_price: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  db.alerts.push(alert);
  writeDb(db);
  return alert;
}

function deleteAlert(id) {
  const db = readDb();
  const numId = parseInt(id);
  db.alerts = db.alerts.filter(a => a.id !== numId);
  db.price_history = db.price_history.filter(p => p.alert_id !== numId);
  db.notifications = db.notifications.filter(n => n.alert_id !== numId);
  writeDb(db);
}

function updateAlert(id, data) {
  const db = readDb();
  const numId = parseInt(id);
  const alert = db.alerts.find(a => a.id === numId);
  if (!alert) return null;

  const {
    destination, dest_id, dest_type, checkin, checkout,
    adults, children, rooms, max_price, currency, star_rating, sort_by
  } = data;

  if (destination) alert.destination = destination;
  if (dest_id !== undefined) alert.dest_id = dest_id;
  if (dest_type !== undefined) alert.dest_type = dest_type;
  if (checkin) alert.checkin = checkin;
  if (checkout) alert.checkout = checkout;
  if (adults !== undefined) alert.adults = parseInt(adults) || 2;
  if (children !== undefined) alert.children = parseInt(children) || 0;
  if (rooms !== undefined) alert.rooms = parseInt(rooms) || 1;
  if (max_price) alert.max_price = parseFloat(max_price);
  if (currency) alert.currency = currency;
  if (star_rating !== undefined) alert.star_rating = star_rating;
  if (sort_by) alert.sort_by = sort_by;
  alert.updated_at = new Date().toISOString();

  writeDb(db);
  return alert;
}

function toggleAlert(id) {
  const db = readDb();
  const numId = parseInt(id);
  const alert = db.alerts.find(a => a.id === numId);
  if (alert) {
    alert.active = alert.active ? 0 : 1;
    alert.updated_at = new Date().toISOString();
    writeDb(db);
  }
  return alert;
}

function updateAlertPrice(id, price) {
  const db = readDb();
  const numId = parseInt(id);
  const alert = db.alerts.find(a => a.id === numId);
  if (alert) {
    alert.last_price = price;
    alert.last_checked = new Date().toISOString();
    alert.updated_at = new Date().toISOString();
    // A price came back, so whatever the previous check complained about is
    // resolved.
    alert.last_error = null;
    alert.last_error_at = null;
    alert.consecutive_failures = 0;
    writeDb(db);
  }
}

// Record a check that produced no usable price. Without this a check that
// silently returns nothing leaves no trace at all - the alert keeps its old
// last_checked/last_price and looks healthy while it has in fact stopped being
// monitored.
function recordCheckFailure(id, reason) {
  const db = readDb();
  const numId = parseInt(id);
  const alert = db.alerts.find(a => a.id === numId);
  if (!alert) return null;

  const now = new Date().toISOString();
  alert.last_checked = now;
  alert.last_error = String(reason || 'Unknown error').slice(0, 300);
  alert.last_error_at = now;
  alert.consecutive_failures = (alert.consecutive_failures || 0) + 1;
  alert.updated_at = now;
  writeDb(db);
  return alert;
}

function addPriceHistory(alertId, price, hotelName, url, meta = {}) {
  const db = readDb();
  const entry = {
    id: db.nextId.price_history++,
    alert_id: parseInt(alertId),
    price,
    hotel_name: hotelName,
    url,
    // price is per night; total_price/nights record what the stay actually
    // costs, and price_basis how the per-night figure was derived.
    total_price: meta.total_price ?? null,
    nights: meta.nights ?? null,
    price_basis: meta.price_basis ?? null,
    checked_at: new Date().toISOString()
  };
  db.price_history.push(entry);

  // Keep only last 200 entries per alert to avoid file bloat
  const alertEntries = db.price_history.filter(p => p.alert_id === parseInt(alertId));
  if (alertEntries.length > 200) {
    const toRemove = alertEntries.slice(0, alertEntries.length - 200);
    const removeIds = new Set(toRemove.map(e => e.id));
    db.price_history = db.price_history.filter(p => !removeIds.has(p.id));
  }

  writeDb(db);
}

function getPriceHistory(alertId) {
  const db = readDb();
  const numId = parseInt(alertId);
  return db.price_history
    .filter(p => p.alert_id === numId)
    .sort((a, b) => new Date(b.checked_at) - new Date(a.checked_at))
    .slice(0, 50);
}

function addNotification(alertId, hotelName, price, url, message, meta = {}) {
  const db = readDb();
  const notification = {
    id: db.nextId.notifications++,
    alert_id: parseInt(alertId),
    hotel_name: hotelName,
    price,
    url,
    message,
    total_price: meta.total_price ?? null,
    nights: meta.nights ?? null,
    price_basis: meta.price_basis ?? null,
    is_read: 0,
    created_at: new Date().toISOString()
  };
  db.notifications.push(notification);
  writeDb(db);
  return notification;
}

// Lowest price ever notified per hotel name for an alert, derived from
// notification history - used to skip re-notifying about a hotel unless
// it's new or has dropped to a new lower price.
//
// Notifications without price_basis were recorded before prices were read
// correctly (a nightly rate was divided by the stay length a second time, so
// they sit at roughly 1/nights of the real price). Comparing against those
// would suppress every genuine alert, so they're ignored as a baseline.
function getNotifiedMinPrices(alertId) {
  const db = readDb();
  const numId = parseInt(alertId);
  const minPrices = {};
  db.notifications
    .filter(n => n.alert_id === numId && n.price_basis)
    .forEach(n => {
      if (!(n.hotel_name in minPrices) || n.price < minPrices[n.hotel_name]) {
        minPrices[n.hotel_name] = n.price;
      }
    });
  return minPrices;
}

function getNotifications() {
  const db = readDb();
  return db.notifications
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 100);
}

function markNotificationRead(id) {
  const db = readDb();
  const numId = parseInt(id);
  const notification = db.notifications.find(n => n.id === numId);
  if (notification) {
    notification.is_read = 1;
    writeDb(db);
  }
}

module.exports = {
  initialize,
  getAllAlerts,
  getActiveAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  toggleAlert,
  updateAlertPrice,
  recordCheckFailure,
  addPriceHistory,
  getPriceHistory,
  addNotification,
  getNotifiedMinPrices,
  getNotifications,
  markNotificationRead
};
