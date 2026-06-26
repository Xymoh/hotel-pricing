const nodemailer = require('nodemailer');

let transporter = null;

function initTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log('Email notifications disabled (SMTP not configured)');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    }
  });

  return transporter;
}

async function sendEmail(notification, alert, matchingHotels) {
  const transport = initTransporter();
  if (!transport) return false;

  const recipientEmail = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER;
  if (!recipientEmail) return false;

  try {
    // Build hotel list HTML
    let hotelsHtml = '';
    if (matchingHotels && matchingHotels.length > 0) {
      hotelsHtml = matchingHotels.map((hotel, i) => {
        const geniusTag = hotel.hasGenius ? ' <span style="background:#febb02;color:#00224f;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:bold;">Genius</span>' : '';
        return `
          <tr style="border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 10px 12px; font-weight: 500;">${i + 1}. ${hotel.hotelName}${geniusTag}</td>
            <td style="padding: 10px 12px; text-align: right; font-weight: 700; color: #2563eb;">${alert.currency} ${hotel.perNightPrice}/night</td>
            <td style="padding: 10px 12px; text-align: center;"><a href="${hotel.url}" style="color: #2563eb; text-decoration: none;">View →</a></td>
          </tr>
        `;
      }).join('');
    } else {
      hotelsHtml = `
        <tr>
          <td style="padding: 10px 12px;">${notification.hotel_name}</td>
          <td style="padding: 10px 12px; text-align: right; font-weight: 700; color: #2563eb;">${alert.currency} ${notification.price}/night</td>
          <td style="padding: 10px 12px; text-align: center;"><a href="${notification.url}" style="color: #2563eb; text-decoration: none;">View →</a></td>
        </tr>
      `;
    }

    const count = matchingHotels ? matchingHotels.length : 1;
    const subject = `💰 ${count} hotel${count > 1 ? 's' : ''} found in ${alert.destination} within budget`;

    await transport.sendMail({
      from: `"Hotel Price Monitor" <${process.env.SMTP_USER}>`,
      to: recipientEmail,
      subject,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 650px; margin: 0 auto;">
          <h2 style="color: #2563eb;">🏨 Hotel Price Alert!</h2>
          <p style="color: #4b5563;">Found <strong>${count} hotel${count > 1 ? 's' : ''}</strong> in <strong>${alert.destination}</strong> within your budget of ${alert.currency} ${alert.max_price}/night.</p>
          
          <div style="background: #f8fafc; border-radius: 8px; margin: 16px 0; overflow: hidden; border: 1px solid #e2e8f0;">
            <table style="width: 100%; border-collapse: collapse;">
              <thead>
                <tr style="background: #f1f5f9;">
                  <th style="padding: 10px 12px; text-align: left; font-size: 12px; text-transform: uppercase; color: #64748b;">Hotel</th>
                  <th style="padding: 10px 12px; text-align: right; font-size: 12px; text-transform: uppercase; color: #64748b;">Price</th>
                  <th style="padding: 10px 12px; text-align: center; font-size: 12px; text-transform: uppercase; color: #64748b;">Link</th>
                </tr>
              </thead>
              <tbody>
                ${hotelsHtml}
              </tbody>
            </table>
          </div>
          
          <div style="background: #f0f9ff; padding: 14px 16px; border-radius: 8px; margin: 16px 0; font-size: 13px; color: #4b5563;">
            <strong>Search details:</strong> ${alert.checkin} → ${alert.checkout} · ${alert.adults} adults · ${alert.rooms} room${alert.rooms > 1 ? 's' : ''}
          </div>
          
          <a href="${notification.url}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 8px;">
            View All on Booking.com →
          </a>
          <p style="color: #9ca3af; margin-top: 24px; font-size: 11px;">
            Hotel Price Monitor · Monitoring ${alert.destination}
          </p>
        </div>
      `
    });

    console.log(`  📧 Email sent to ${recipientEmail} (${count} hotels)`);
    return true;
  } catch (err) {
    console.error('  Email failed:', err.message);
    return false;
  }
}

async function notify(notification, alert, matchingHotels) {
  // Send email with all matching hotels
  await sendEmail(notification, alert, matchingHotels);

  // Browser notification is handled via SSE on the frontend
  const count = matchingHotels ? matchingHotels.length : 1;
  console.log(`  🔔 ${count} hotel${count > 1 ? 's' : ''} within budget in ${alert.destination}`);
}

module.exports = { notify, sendEmail };
