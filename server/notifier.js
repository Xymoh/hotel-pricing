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

async function sendEmail(notification, alert) {
  const transport = initTransporter();
  if (!transport) return false;

  const recipientEmail = process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER;
  if (!recipientEmail) return false;

  try {
    await transport.sendMail({
      from: `"Hotel Price Monitor" <${process.env.SMTP_USER}>`,
      to: recipientEmail,
      subject: `💰 Hotel Deal: ${notification.hotel_name} - ${alert.currency} ${notification.price}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2563eb;">🏨 Hotel Price Alert!</h2>
          <div style="background: #f0f9ff; padding: 20px; border-radius: 8px; margin: 16px 0;">
            <h3 style="margin-top: 0;">${notification.hotel_name}</h3>
            <p><strong>Price:</strong> ${alert.currency} ${notification.price}/night</p>
            <p><strong>Your max budget:</strong> ${alert.currency} ${alert.max_price}/night</p>
            <p><strong>Destination:</strong> ${alert.destination}</p>
            <p><strong>Dates:</strong> ${alert.checkin} → ${alert.checkout}</p>
            <p><strong>Guests:</strong> ${alert.adults} adults, ${alert.children} children</p>
            <p><strong>Rooms:</strong> ${alert.rooms}</p>
          </div>
          <a href="${notification.url}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 12px;">
            View on Booking.com →
          </a>
          <p style="color: #6b7280; margin-top: 24px; font-size: 12px;">
            This is an automated alert from Hotel Price Monitor. You set up monitoring for ${alert.destination}.
          </p>
        </div>
      `
    });

    console.log(`  📧 Email sent to ${recipientEmail}`);
    return true;
  } catch (err) {
    console.error('  Email failed:', err.message);
    return false;
  }
}

async function notify(notification, alert) {
  // Always try email
  await sendEmail(notification, alert);

  // Browser notification is handled via SSE on the frontend
  console.log(`  🔔 Notification: ${notification.message}`);
}

module.exports = { notify, sendEmail };
