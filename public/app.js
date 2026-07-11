const API_BASE = '';
const API_KEY_STORAGE_KEY = 'hotelPriceMonitorApiKey';

function getApiKey() {
  let key = localStorage.getItem(API_KEY_STORAGE_KEY);
  if (key === null) {
    key = window.prompt('Enter the app API key (leave blank if the server has none configured):') || '';
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
  }
  return key;
}

async function apiFetch(url, options = {}) {
  const key = getApiKey();
  const headers = { ...(options.headers || {}) };
  if (key) headers['x-api-key'] = key;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    showToast('Invalid API key — reload the page to re-enter it', 'error');
  }
  return res;
}

// State
let alerts = [];
let notifications = [];
let editingAlertId = null;

// DOM elements
const alertForm = document.getElementById('alert-form');
const alertsList = document.getElementById('alerts-list');
const notificationsList = document.getElementById('notifications-list');
const notificationsSection = document.getElementById('notifications-section');
const notificationBell = document.getElementById('notification-bell');
const notificationBadge = document.getElementById('notification-badge');
const checkNowBtn = document.getElementById('check-now-btn');
const formTitle = document.getElementById('form-title');
const formSubmitBtn = document.getElementById('form-submit-btn');
const formCancelBtn = document.getElementById('form-cancel-btn');
const destinationInput = document.getElementById('destination');
const autocompleteDropdown = document.getElementById('autocomplete-dropdown');
const destIdInput = document.getElementById('dest_id');
const destTypeInput = document.getElementById('dest_type');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setMinDates();
  loadAlerts();
  loadNotifications();
  loadGeniusStatus();
  loadEmailStatus();
  setupSSE();
  setupAutocomplete();
  requestNotificationPermission();
});

// ==================== AUTOCOMPLETE ====================

let autocompleteTimeout = null;
let autocompleteResults = [];
let activeAutocompleteIndex = -1;

function setupAutocomplete() {
  destinationInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();

    // Clear previous selection if user types
    destIdInput.value = '';
    destTypeInput.value = '';

    if (query.length < 2) {
      hideAutocomplete();
      return;
    }

    // Debounce requests
    clearTimeout(autocompleteTimeout);
    autocompleteTimeout = setTimeout(() => fetchSuggestions(query), 300);
  });

  destinationInput.addEventListener('keydown', (e) => {
    if (!autocompleteDropdown.classList.contains('visible')) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeAutocompleteIndex = Math.min(activeAutocompleteIndex + 1, autocompleteResults.length - 1);
      highlightAutocompleteItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeAutocompleteIndex = Math.max(activeAutocompleteIndex - 1, 0);
      highlightAutocompleteItem();
    } else if (e.key === 'Enter' && activeAutocompleteIndex >= 0) {
      e.preventDefault();
      selectAutocompleteItem(autocompleteResults[activeAutocompleteIndex]);
    } else if (e.key === 'Escape') {
      hideAutocomplete();
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.destination-group')) {
      hideAutocomplete();
    }
  });
}

async function fetchSuggestions(query) {
  try {
    const res = await apiFetch(`${API_BASE}/api/destinations?query=${encodeURIComponent(query)}`);
    autocompleteResults = await res.json();
    activeAutocompleteIndex = -1;

    if (autocompleteResults.length > 0) {
      renderAutocomplete();
    } else {
      hideAutocomplete();
    }
  } catch (err) {
    console.error('Autocomplete fetch error:', err);
    hideAutocomplete();
  }
}

function renderAutocomplete() {
  const typeIcons = {
    city: '🏙️',
    region: '🗺️',
    landmark: '📍',
    hotel: '🏨',
    airport: '✈️',
    district: '🏘️',
    country: '🌍'
  };

  autocompleteDropdown.innerHTML = autocompleteResults.map((item, i) => `
    <div class="autocomplete-item ${i === activeAutocompleteIndex ? 'active' : ''}" data-index="${i}">
      <span class="autocomplete-item-icon">${typeIcons[item.dest_type] || '📍'}</span>
      <div class="autocomplete-item-text">
        <div class="autocomplete-item-label">${escapeHtml(item.label)}</div>
        <div class="autocomplete-item-type">${item.dest_type || 'location'}${item.country ? ' · ' + item.country : ''}</div>
      </div>
    </div>
  `).join('');

  autocompleteDropdown.classList.add('visible');

  // Click handlers
  autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach(el => {
    el.addEventListener('click', () => {
      const index = parseInt(el.dataset.index);
      selectAutocompleteItem(autocompleteResults[index]);
    });
  });
}

function highlightAutocompleteItem() {
  autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach((el, i) => {
    el.classList.toggle('active', i === activeAutocompleteIndex);
  });
}

function selectAutocompleteItem(item) {
  destinationInput.value = item.label;
  destIdInput.value = item.dest_id || '';
  destTypeInput.value = item.dest_type || '';
  hideAutocomplete();
}

function hideAutocomplete() {
  autocompleteDropdown.classList.remove('visible');
  autocompleteDropdown.innerHTML = '';
  autocompleteResults = [];
  activeAutocompleteIndex = -1;
}

// ==================== DATES ====================

function setMinDates() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('checkin').min = today;
  document.getElementById('checkout').min = today;

  document.getElementById('checkin').addEventListener('change', (e) => {
    document.getElementById('checkout').min = e.target.value;
  });
}

// ==================== NOTIFICATIONS ====================

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function setupSSE() {
  const key = getApiKey();
  const url = `${API_BASE}/api/events${key ? `?key=${encodeURIComponent(key)}` : ''}`;
  const eventSource = new EventSource(url);

  eventSource.onmessage = (event) => {
    const notification = JSON.parse(event.data);
    notifications.unshift(notification);
    renderNotifications();
    updateBadge();
    showToast(notification.message, 'success');
    showBrowserNotification(notification);
  };

  eventSource.onerror = () => {
    console.log('SSE connection lost, will reconnect...');
  };
}

function showBrowserNotification(notification) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('🏨 Hotel Deal Found!', {
      body: notification.message,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🏨</text></svg>',
      tag: `hotel-${notification.id}`
    });

    n.onclick = () => {
      if (notification.url) {
        window.open(notification.url, '_blank');
      }
      n.close();
    };
  }
}

// ==================== API CALLS ====================

async function loadAlerts() {
  try {
    const res = await apiFetch(`${API_BASE}/api/alerts`);
    alerts = await res.json();
    renderAlerts();
  } catch (err) {
    showToast('Failed to load alerts', 'error');
  }
}

async function loadNotifications() {
  try {
    const res = await apiFetch(`${API_BASE}/api/notifications`);
    notifications = await res.json();
    renderNotifications();
    updateBadge();
  } catch (err) {
    console.error('Failed to load notifications:', err);
  }
}

async function createAlert(data) {
  try {
    const res = await apiFetch(`${API_BASE}/api/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }

    const alert = await res.json();
    alerts.unshift(alert);
    renderAlerts();
    showToast(`Alert created for ${alert.destination}!`, 'success');
    return alert;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

async function updateAlertApi(id, data) {
  try {
    const res = await apiFetch(`${API_BASE}/api/alerts/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }

    const updated = await res.json();
    const idx = alerts.findIndex(a => a.id === id);
    if (idx !== -1) alerts[idx] = updated;
    renderAlerts();
    showToast(`Alert updated for ${updated.destination}!`, 'success');
    return updated;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

async function deleteAlert(id) {
  if (!confirm('Delete this alert?')) return;

  try {
    await apiFetch(`${API_BASE}/api/alerts/${id}`, { method: 'DELETE' });
    alerts = alerts.filter(a => a.id !== id);
    renderAlerts();
    showToast('Alert deleted', 'info');
  } catch (err) {
    showToast('Failed to delete alert', 'error');
  }
}

async function toggleAlert(id) {
  try {
    const res = await apiFetch(`${API_BASE}/api/alerts/${id}/toggle`, { method: 'PATCH' });
    const updated = await res.json();
    const idx = alerts.findIndex(a => a.id === id);
    if (idx !== -1) alerts[idx] = updated;
    renderAlerts();
  } catch (err) {
    showToast('Failed to toggle alert', 'error');
  }
}

async function checkNow() {
  checkNowBtn.disabled = true;
  checkNowBtn.innerHTML = '<span class="spinner"></span> Checking...';

  try {
    const res = await apiFetch(`${API_BASE}/api/check-now`, { method: 'POST' });
    const data = await res.json();

    if (data.results) {
      const found = data.results.filter(r => r.found);
      if (found.length > 0) {
        const totalHotels = found.reduce((sum, r) => sum + (r.matches || 1), 0);
        showToast(`Found ${totalHotels} hotel${totalHotels > 1 ? 's' : ''} within your budget!`, 'success');
      } else {
        showToast('No deals below your budget right now', 'info');
      }
    }

    await loadAlerts();
    await loadNotifications();
  } catch (err) {
    showToast('Price check failed', 'error');
  } finally {
    checkNowBtn.disabled = false;
    checkNowBtn.innerHTML = '🔄 Check Now';
  }
}

// ==================== EDIT FUNCTIONALITY ====================

function editAlert(id) {
  const alert = alerts.find(a => a.id === id);
  if (!alert) return;

  editingAlertId = id;

  // Fill form with alert data
  destinationInput.value = alert.destination;
  destIdInput.value = alert.dest_id || '';
  destTypeInput.value = alert.dest_type || '';
  document.getElementById('checkin').value = alert.checkin;
  document.getElementById('checkout').value = alert.checkout;
  document.getElementById('adults').value = alert.adults;
  document.getElementById('children').value = alert.children;
  document.getElementById('rooms').value = alert.rooms;
  document.getElementById('max_price').value = alert.max_price;
  document.getElementById('currency').value = alert.currency;
  document.getElementById('star_rating').value = alert.star_rating;
  document.getElementById('sort_by').value = alert.sort_by;

  // Update form UI
  formTitle.textContent = '✏️ Edit Price Alert';
  formSubmitBtn.textContent = '💾 Save Changes';
  formCancelBtn.style.display = 'inline-flex';

  // Scroll to form
  document.querySelector('.form-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEdit() {
  editingAlertId = null;
  alertForm.reset();
  document.getElementById('adults').value = '2';
  document.getElementById('children').value = '0';
  document.getElementById('rooms').value = '1';
  destIdInput.value = '';
  destTypeInput.value = '';

  formTitle.textContent = 'Create Price Alert';
  formSubmitBtn.textContent = '➕ Create Alert';
  formCancelBtn.style.display = 'none';
}

// ==================== EVENT LISTENERS ====================

alertForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData(alertForm);
  const data = Object.fromEntries(formData.entries());
  delete data.edit_id; // Remove internal field

  // Validate dates
  if (data.checkin >= data.checkout) {
    showToast('Check-out must be after check-in', 'error');
    return;
  }

  if (editingAlertId) {
    // Update existing alert
    await updateAlertApi(editingAlertId, data);
    cancelEdit();
  } else {
    // Create new alert
    await createAlert(data);
    alertForm.reset();
    document.getElementById('adults').value = '2';
    document.getElementById('children').value = '0';
    document.getElementById('rooms').value = '1';
    destIdInput.value = '';
    destTypeInput.value = '';
  }
});

checkNowBtn.addEventListener('click', checkNow);

notificationBell.addEventListener('click', () => {
  notificationsSection.style.display =
    notificationsSection.style.display === 'none' ? 'block' : 'none';
});

// ==================== RENDER ====================

function renderAlerts() {
  if (alerts.length === 0) {
    alertsList.innerHTML = '<p class="empty-state">No alerts yet. Create one above to start monitoring prices.</p>';
    return;
  }

  alertsList.innerHTML = alerts.map(alert => {
    const lastPriceClass = alert.last_price && alert.last_price <= alert.max_price ? 'below-budget' : '';
    const inactiveClass = !alert.active ? 'inactive' : '';

    return `
      <div class="alert-item ${inactiveClass}">
        <div class="alert-info">
          <div class="alert-destination">${escapeHtml(alert.destination)}</div>
          <div class="alert-details">
            <span>📅 ${alert.checkin} → ${alert.checkout}</span>
            <span>👥 ${alert.adults} adults${alert.children > 0 ? `, ${alert.children} children` : ''}</span>
            <span>🚪 ${alert.rooms} room${alert.rooms > 1 ? 's' : ''}</span>
            ${alert.star_rating ? `<span>⭐ ${alert.star_rating} star${alert.star_rating.includes(',') ? 's' : ''}</span>` : ''}
          </div>
        </div>
        <div class="alert-price">
          <span class="alert-max-price">${alert.currency} ${alert.max_price}/night max</span>
          ${alert.last_price ? `<span class="alert-last-price ${lastPriceClass}">Last: ${alert.currency} ${alert.last_price}</span>` : '<span class="alert-last-price">Not checked yet</span>'}
          ${alert.last_checked ? `<span class="alert-last-price">Checked: ${timeAgo(alert.last_checked)}</span>` : ''}
        </div>
        <div class="alert-actions">
          <button class="toggle-btn" onclick="editAlert(${alert.id})" title="Edit">
            ✏️
          </button>
          <button class="toggle-btn" onclick="toggleAlert(${alert.id})" title="${alert.active ? 'Pause' : 'Resume'}">
            ${alert.active ? '⏸️' : '▶️'}
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteAlert(${alert.id})">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderNotifications() {
  if (notifications.length === 0) {
    notificationsSection.style.display = 'none';
    return;
  }

  notificationsList.innerHTML = notifications.map(n => `
    <div class="notification-item ${n.is_read ? 'read' : ''}">
      <span class="notification-message">${escapeHtml(n.message)}</span>
      <span class="notification-time">${timeAgo(n.created_at)}</span>
      ${n.url ? `<a href="${escapeHtml(n.url)}" target="_blank" class="notification-link">Book →</a>` : ''}
    </div>
  `).join('');
}

function updateBadge() {
  const unread = notifications.filter(n => !n.is_read).length;
  if (unread > 0) {
    notificationBadge.textContent = unread > 99 ? '99+' : unread;
    notificationBadge.style.display = 'inline';
  } else {
    notificationBadge.style.display = 'none';
  }
}

// ==================== EMAIL ====================

async function loadEmailStatus() {
  try {
    const res = await apiFetch(`${API_BASE}/api/email/status`);
    const data = await res.json();
    const statusEl = document.getElementById('email-status');

    if (data.configured) {
      statusEl.innerHTML = `<span class="genius-badge active">✅ Configured — sending to ${escapeHtml(data.notification_email)}</span>`;
      // Pre-fill form
      document.getElementById('smtp_host').value = data.smtp_host;
      document.getElementById('smtp_user').value = data.smtp_user;
      document.getElementById('notification_email').value = data.notification_email;
    } else {
      statusEl.innerHTML = '<span class="genius-badge inactive">Not configured — no emails will be sent</span>';
    }
  } catch (err) {
    console.error('Failed to load email status:', err);
  }
}

async function saveEmailConfig() {
  const config = {
    smtp_host: document.getElementById('smtp_host').value.trim(),
    smtp_port: parseInt(document.getElementById('smtp_port').value) || 587,
    smtp_user: document.getElementById('smtp_user').value.trim(),
    smtp_pass: document.getElementById('smtp_pass').value.trim(),
    notification_email: document.getElementById('notification_email').value.trim()
  };

  if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) {
    showToast('Fill in SMTP host, email, and password', 'error');
    return;
  }

  try {
    const res = await apiFetch(`${API_BASE}/api/email/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    const data = await res.json();
    if (res.ok) {
      showToast('Email settings saved!', 'success');
      document.getElementById('smtp_pass').value = '';
      loadEmailStatus();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Failed to save email config', 'error');
  }
}

async function testEmail() {
  try {
    const res = await apiFetch(`${API_BASE}/api/email/test`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Failed to send test email', 'error');
  }
}

// ==================== GENIUS ====================

async function loadGeniusStatus() {
  try {
    const res = await apiFetch(`${API_BASE}/api/genius/status`);
    const data = await res.json();
    const statusEl = document.getElementById('genius-status');
    const removeBtn = document.getElementById('genius-remove-btn');
    const loginBtn = document.getElementById('genius-login-btn');
    
    if (data.loginInProgress) {
      statusEl.innerHTML = '<span class="genius-badge pending">⏳ Login in progress — complete in the browser window...</span>';
      loginBtn.disabled = true;
      loginBtn.textContent = '⏳ Waiting for login...';
      removeBtn.style.display = 'none';
    } else if (data.enabled) {
      statusEl.innerHTML = '<span class="genius-badge active">✅ Connected — Genius Level 3 prices enabled</span>';
      loginBtn.disabled = false;
      loginBtn.textContent = '🔑 Re-login';
      removeBtn.style.display = 'inline-flex';
    } else {
      statusEl.innerHTML = '<span class="genius-badge inactive">Not connected — showing public prices only</span>';
      loginBtn.disabled = false;
      loginBtn.textContent = '🔑 Connect Booking.com Account';
      removeBtn.style.display = 'none';
    }
  } catch (err) {
    console.error('Failed to load Genius status:', err);
  }
}

async function geniusLogin() {
  const loginBtn = document.getElementById('genius-login-btn');
  
  try {
    const res = await apiFetch(`${API_BASE}/api/genius/login`, { method: 'POST' });
    const data = await res.json();
    
    if (!res.ok) {
      showToast(data.error, 'error');
      return;
    }
    
    showToast('A Chrome window has been opened. Log into Booking.com with your Genius account.', 'info');
    loginBtn.disabled = true;
    loginBtn.textContent = '⏳ Waiting for login...';
    
    // Poll for completion
    const pollInterval = setInterval(async () => {
      try {
        const statusRes = await apiFetch(`${API_BASE}/api/genius/status`);
        const status = await statusRes.json();
        
        if (!status.loginInProgress) {
          clearInterval(pollInterval);
          loadGeniusStatus();
          
          if (status.enabled) {
            showToast('Genius account connected! Your Level 3 discounts will now be applied.', 'success');
          } else if (status.lastLoginResult && !status.lastLoginResult.success) {
            showToast(`Login failed: ${status.lastLoginResult.error}`, 'error');
          }
        }
      } catch (e) {
        // Network error, keep polling
      }
    }, 2000);
    
    // Stop polling after 6 minutes (give login 5 min + buffer)
    setTimeout(() => {
      clearInterval(pollInterval);
      loadGeniusStatus();
    }, 360000);
    
  } catch (err) {
    showToast('Failed to start login process', 'error');
    loginBtn.disabled = false;
  }
}

async function geniusImportCookies() {
  const textarea = document.getElementById('genius-cookies-input');
  const text = textarea.value.trim();
  
  if (!text) {
    showToast('Please paste the cookies JSON first', 'error');
    return;
  }
  
  try {
    const cookies = JSON.parse(text);
    const res = await apiFetch(`${API_BASE}/api/genius/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cookies)
    });
    
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      textarea.value = '';
      loadGeniusStatus();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Invalid JSON format. Please export cookies as JSON array.', 'error');
  }
}

async function geniusRemove() {
  if (!confirm('Disconnect Genius account? You will see public prices only.')) return;
  
  try {
    await apiFetch(`${API_BASE}/api/genius/cookies`, { method: 'DELETE' });
    loadGeniusStatus();
    showToast('Genius account disconnected', 'info');
  } catch (err) {
    showToast('Failed to disconnect', 'error');
  }
}

// ==================== UTILITIES ====================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  // Handle both "2026-06-26T10:52:45.882Z" and "2026-06-26T10:52:45.882"
  const date = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  if (isNaN(date.getTime())) return 'unknown';
  
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
