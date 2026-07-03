# Send Email To Registered Users - Implementation Guide

This guide explains how to add a new **Send Email** admin navigation option below **Settings**. The feature lets an authenticated admin send one email campaign to every Firebase Auth user account that has an email address.

The current app is:

- Backend: `index.js` with Express routes mounted under `/api`
- Admin UI: `admin/index.html`
- Admin client logic: `admin/app.js`
- Styling: `admin/style.css`
- Auth source: Firebase Auth users, read by `admin.auth().listUsers()`

## Recommended Behavior

The admin should:

1. Open the new **Send Email** tab from the sidebar.
2. Enter a subject and message.
3. Preview how many users have email addresses.
4. Click **Send Email** once.
5. Backend sends the same message to all eligible users.

Use BCC batches instead of placing all users in `to`. This keeps recipient addresses private and avoids provider recipient limits.

## Install Email Dependency

Use Nodemailer because it works with normal SMTP providers.

```bash
npm install nodemailer
```

Optional, if you want local `.env` loading:

```bash
npm install dotenv
```

Then add this near the top of `index.js` before reading environment variables:

```js
require('dotenv').config();
```

If your host already injects environment variables, you do not need `dotenv`.

## Environment Variables

Do not hardcode SMTP passwords in the repo. Configure these on the server:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
EMAIL_FROM="KiduyuTV <no-reply@kiduyutv.com>"
EMAIL_REPLY_TO=support@kiduyutv.com
EMAIL_BATCH_SIZE=50
```

Notes:

- `SMTP_SECURE=false` is typical for port `587`.
- `SMTP_SECURE=true` is typical for port `465`.
- `EMAIL_BATCH_SIZE=50` is conservative. Increase only if your provider allows it.

## Backend Implementation

Add these helpers in `index.js`, after Firebase Admin initialization and before the admin routes.

```js
const nodemailer = require('nodemailer');

function getEmailTransporter() {
  const port = Number(process.env.SMTP_PORT || 587);

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function verifyAdminToken(idToken) {
  if (!idToken) {
    const err = new Error('Missing idToken.');
    err.statusCode = 400;
    throw err;
  }

  const decoded = await admin.auth().verifyIdToken(idToken);
  const adminDoc = await admin.firestore().collection('admins').doc(decoded.uid).get();

  if (!adminDoc.exists) {
    const err = new Error('Not an admin.');
    err.statusCode = 403;
    throw err;
  }

  return decoded;
}

async function listAllUsersWithEmails() {
  const emails = new Set();
  let pageToken;

  do {
    const result = await admin.auth().listUsers(1000, pageToken);

    for (const user of result.users) {
      if (user.email && !user.disabled) {
        emails.add(user.email.toLowerCase());
      }
    }

    pageToken = result.pageToken;
  } while (pageToken);

  return Array.from(emails).sort();
}
```

Important: `verifyAdminToken` checks both Firebase Auth and the Firestore `admins` collection. Your current `/admin/verify` route already checks the `admins` collection, but many other admin routes only verify the token. For this email route, keep the stricter check.

## Backend Preview Route

Add this route near the other admin routes in `index.js`.

```js
router.get('/admin/email/recipients', async (req, res) => {
  try {
    await verifyAdminToken(req.query.idToken);

    const emails = await listAllUsersWithEmails();

    return res.json({
      success: true,
      count: emails.length
    });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/email/recipients', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});
```

This route only returns the count. Avoid returning all addresses to the browser unless you truly need it.

## Backend Send Route

Add this route near the preview route.

```js
router.post('/admin/email/send', async (req, res) => {
  try {
    const { idToken, subject, messageText, messageHtml } = req.body;
    const adminUser = await verifyAdminToken(idToken);

    const cleanSubject = typeof subject === 'string' ? subject.trim() : '';
    const cleanText = typeof messageText === 'string' ? messageText.trim() : '';
    const cleanHtml = typeof messageHtml === 'string' ? messageHtml.trim() : '';

    if (!cleanSubject) {
      return res.status(400).json({ error: 'Email subject is required.' });
    }

    if (!cleanText && !cleanHtml) {
      return res.status(400).json({ error: 'Email message is required.' });
    }

    const requiredEnv = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
    const missingEnv = requiredEnv.filter(key => !process.env[key]);
    if (missingEnv.length) {
      return res.status(500).json({ error: `Missing email config: ${missingEnv.join(', ')}` });
    }

    const recipients = await listAllUsersWithEmails();
    if (!recipients.length) {
      return res.status(400).json({ error: 'No registered users with email addresses found.' });
    }

    const batchSize = Number(process.env.EMAIL_BATCH_SIZE || 50);
    const batches = chunkArray(recipients, batchSize);
    const transporter = getEmailTransporter();

    const results = [];

    for (const batch of batches) {
      const info = await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM,
        to: process.env.EMAIL_FROM,
        bcc: batch,
        subject: cleanSubject,
        text: cleanText || undefined,
        html: cleanHtml || undefined
      });

      results.push({
        messageId: info.messageId,
        accepted: info.accepted?.length || 0,
        rejected: info.rejected?.length || 0
      });
    }

    log('info', 'admin/email/send completed', {
      adminUid: adminUser.uid,
      recipientCount: recipients.length,
      batchCount: batches.length,
      subject: cleanSubject
    });

    return res.json({
      success: true,
      recipientCount: recipients.length,
      batchCount: batches.length,
      results
    });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/email/send', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});
```

Why `to: process.env.EMAIL_FROM` and `bcc: batch`?

- Users do not see each other's addresses.
- The provider receives one message per batch.
- The admin still performs one send action from the UI.

## Add Sidebar Navigation

In `admin/index.html`, add this block directly below the existing Settings nav item:

```html
<a href="#" class="nav-item" data-tab="sendEmail">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="5" width="18" height="14" rx="2"/>
    <polyline points="3 7 12 13 21 7"/>
  </svg>
  Send Email
</a>
```

The important part is `data-tab="sendEmail"`. The existing tab logic will open a section with ID `sendEmailTab`.

## Add Send Email Tab HTML

In `admin/index.html`, add this section after `settingsTab` and before the toast/dialog markup.

```html
<section id="sendEmailTab" class="tab-content">
  <div class="tab-header">
    <h2>Send Email</h2>
    <p class="tab-subtitle">Send one email campaign to all registered users with email addresses</p>
  </div>

  <div class="settings-section">
    <h3>Email Campaign</h3>
    <p class="settings-desc">
      Recipients are collected from Firebase Auth users with an email address. Emails are sent using BCC batches.
    </p>

    <div class="settings-info">
      <div class="info-item">
        <span class="info-label">Eligible recipients:</span>
        <code id="emailRecipientCount">Loading...</code>
      </div>
    </div>

    <div class="form-group">
      <label for="emailSubject">Subject</label>
      <input type="text" id="emailSubject" placeholder="Important update from KiduyuTV" autocomplete="off">
    </div>

    <div class="form-group">
      <label for="emailMessageText">Plain Text Message</label>
      <textarea id="emailMessageText" rows="8" placeholder="Write the email message..."></textarea>
    </div>

    <div class="form-group">
      <label for="emailMessageHtml">HTML Message Optional</label>
      <textarea id="emailMessageHtml" rows="8" placeholder="<p>Write optional HTML email content...</p>"></textarea>
    </div>

    <div class="settings-actions">
      <button id="refreshEmailRecipients" class="btn-secondary" type="button">Refresh Count</button>
      <button id="clearEmailForm" class="btn-secondary" type="button">Clear</button>
      <button id="sendEmailToUsers" class="btn-primary" type="button">Send Email</button>
    </div>
  </div>
</section>
```

## Add Textarea Styling

`admin/style.css` already styles `.form-group input`. Add textarea styles beside that block:

```css
.form-group textarea {
  width: 100%;
  padding: 12px 16px;
  background: #1a1d23;
  border: 1px solid #2a2e38;
  border-radius: 8px;
  color: #E6E6E6;
  font-size: 14px;
  font-family: inherit;
  resize: vertical;
  min-height: 140px;
  box-sizing: border-box;
}

.form-group textarea:focus {
  border-color: #E50914;
  outline: none;
}
```

## Add Admin Client Logic

In `admin/app.js`, update the tab navigation block so the count loads when the new tab opens:

```js
if (tab === 'sendEmail') loadEmailRecipientCount();
```

Place it near the existing checks:

```js
if (tab === 'analytics') loadAnalytics();
if (tab === 'currentSettings') loadCurrentSettings();
if (tab === 'users') loadUsers();
if (tab === 'sendEmail') loadEmailRecipientCount();
if (tab === 'settings') {
  checkApiStatus();
  ['streaming', 'api', 'ads', 'filters', 'network', 'features', 'app_packagenames', 'home_dialog'].forEach(loadConfigSection);
  loadProviders();
}
```

Then add these functions before the init section:

```js
async function loadEmailRecipientCount() {
  const $count = document.getElementById('emailRecipientCount');
  if (!$count) return;

  $count.textContent = 'Loading...';

  try {
    const data = await apiCall('GET', `/admin/email/recipients?idToken=${encodeURIComponent(idToken)}`);
    $count.textContent = `${data.count || 0} users`;
  } catch (err) {
    $count.textContent = 'Failed to load';
    showToast(err.message, 'error');
  }
}

function clearEmailForm() {
  const subject = document.getElementById('emailSubject');
  const text = document.getElementById('emailMessageText');
  const html = document.getElementById('emailMessageHtml');

  if (subject) subject.value = '';
  if (text) text.value = '';
  if (html) html.value = '';
  if (subject) subject.focus();
}

async function sendEmailToUsers() {
  const $btn = document.getElementById('sendEmailToUsers');
  const subject = document.getElementById('emailSubject')?.value.trim() || '';
  const messageText = document.getElementById('emailMessageText')?.value.trim() || '';
  const messageHtml = document.getElementById('emailMessageHtml')?.value.trim() || '';

  if (!subject) {
    showToast('Email subject is required', 'error');
    return;
  }

  if (!messageText && !messageHtml) {
    showToast('Email message is required', 'error');
    return;
  }

  const confirmed = await showConfirm(
    'Send Email',
    'Send this email to all registered users with email addresses?'
  );

  if (!confirmed) return;

  const original = $btn ? $btn.innerHTML : '';

  try {
    if ($btn) {
      $btn.disabled = true;
      $btn.textContent = 'Sending...';
    }

    const result = await apiCall('POST', '/admin/email/send', {
      idToken,
      subject,
      messageText,
      messageHtml
    });

    showToast(`Email sent to ${result.recipientCount} users`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if ($btn) {
      $btn.disabled = false;
      $btn.innerHTML = original;
    }
  }
}

document.getElementById('refreshEmailRecipients')?.addEventListener('click', loadEmailRecipientCount);
document.getElementById('clearEmailForm')?.addEventListener('click', clearEmailForm);
document.getElementById('sendEmailToUsers')?.addEventListener('click', sendEmailToUsers);
```

## Validation And Safety

Add these safeguards before using the feature in production:

- Require admin verification through the Firestore `admins` collection.
- Keep SMTP secrets in environment variables only.
- Use BCC, never `to: recipients`.
- Add a confirmation dialog before sending.
- Log who sent the email, when, subject, recipient count, and batch count.
- Consider adding a cooldown so an admin cannot accidentally send repeated campaigns.
- If this is marketing email, include unsubscribe instructions and only email users who consented to marketing.

## Optional: Save Email Campaign History

You can write a record to Firestore after each send:

```js
await admin.firestore().collection('emailCampaigns').add({
  subject: cleanSubject,
  recipientCount: recipients.length,
  batchCount: batches.length,
  sentByUid: adminUser.uid,
  sentAt: admin.firestore.FieldValue.serverTimestamp()
});
```

This makes it easier to audit what was sent.

## Test Checklist

1. Run syntax checks:

```bash
node --check index.js
node --check admin/app.js
```

2. Start the server:

```bash
npm start
```

3. Log in as an admin.
4. Confirm the **Send Email** item appears below **Settings**.
5. Open the tab and verify the recipient count loads.
6. Try sending with an empty subject and confirm validation blocks it.
7. Send a test message using a staging SMTP account.
8. Check provider logs for accepted and rejected recipients.
9. Confirm recipients cannot see each other's addresses.

## Files To Change

- `package.json`: add `nodemailer`, optionally `dotenv`
- `index.js`: add SMTP helper, admin verification helper, recipient count route, send route
- `admin/index.html`: add sidebar nav item and `sendEmailTab`
- `admin/app.js`: load recipient count and submit the email form
- `admin/style.css`: add textarea styling if needed

