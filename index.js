const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// ── INITIALISE FIREBASE ADMIN ─────────────────────────────────────

//const serviceAccount = require('/home1/sflatran/keys/serviceAccountKey.json');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://kiduyutvfinal-default-rtdb.firebaseio.com'
});

// ── FILE LOGGING ─────────────────────────────────────────────────

const LOG_FILE = path.join(__dirname, 'logs.log');
const ENV_FILE = path.join(__dirname, '.env');

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level.toUpperCase()}] ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}\n`;
  fs.appendFileSync(LOG_FILE, entry);
  if (level === 'error') console.error(entry.trim());
  else console.log(entry.trim());
}

// Ensure log file exists
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');

// ── EXPRESS SETUP ─────────────────────────────────────────────────

const app = express();
const APP_BASE_PATH = '/api';
app.use(cors());
app.use(express.json());

// Serve admin panel at the root — https://sflatransport.com/api/


// ── MIDDLEWARE: request logging ───────────────────────────────────

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 400 ? 'warn' : 'info';
    log(level, `${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
  });
  next();
});

app.get(`${APP_BASE_PATH}/ic_banner.png`, (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'ic_banner.png'));
});

const publicIndexFile = path.join(__dirname, 'public', 'index.html');

function sendPublicLandingPage(req, res) {
  res.set('Cache-Control', 'no-store');
  res.sendFile(publicIndexFile);
}

// Public KiduyuTV landing page and companion pages.
app.get('/', (req, res) => res.redirect(302, `${APP_BASE_PATH}/`));
app.get([APP_BASE_PATH, `${APP_BASE_PATH}/`, `${APP_BASE_PATH}/index.html`], sendPublicLandingPage);
app.get(`${APP_BASE_PATH}/privacy.html`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.use(APP_BASE_PATH, express.static(path.join(__dirname, 'public')));

// ── ROUTER ───────────────────────────────────────────────────────

const router = express.Router();
const GITHUB_RELEASES_API_URL = 'https://api.github.com/repos/kiduyu-klaus/KiduyuTv_final/releases/latest';
const APK_BANNER_IMAGE_URL = 'ic_banner.png';
const APK_LINK_CACHE_TTL_MS = 5 * 60 * 1000;
let latestApkLinksCache = null;

function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function verifyAdminToken(idToken) {
  if (!idToken) {
    throw createHttpError(400, 'Missing idToken.');
  }

  const decoded = await admin.auth().verifyIdToken(idToken);
  const adminDoc = await admin.firestore().collection('admins').doc(decoded.uid).get();

  if (!adminDoc.exists) {
    throw createHttpError(403, 'Not an admin.');
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
        emails.add(user.email.trim().toLowerCase());
      }
    }

    pageToken = result.pageToken;
  } while (pageToken);

  return Array.from(emails).sort();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function getEmailTransporter() {
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === undefined
    ? port === 465
    : ['true', '1', 'yes', 'on'].includes(String(process.env.SMTP_SECURE).toLowerCase());
  const requireTLS = ['true', '1', 'yes', 'on'].includes(String(process.env.SMTP_REQUIRE_TLS || '').toLowerCase());

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function validateEmailConfig() {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'];
  return required.filter(key => !process.env[key]);
}

const EMAIL_CONFIG_PUBLIC_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_REQUIRE_TLS',
  'SMTP_USER',
  'EMAIL_FROM',
  'EMAIL_REPLY_TO',
  'EMAIL_BATCH_SIZE',
  'EMAIL_UNSUBSCRIBE_URL',
  'PUBLIC_BASE_URL',
  'APK_BANNER_IMAGE_URL',
  'GITHUB_RELEASES_API_URL'
];

function getEmailConfigForAdmin() {
  let fileConfig = {};
  if (fs.existsSync(ENV_FILE)) {
    fileConfig = dotenv.parse(fs.readFileSync(ENV_FILE, 'utf8'));
  }

  const config = {};
  for (const key of EMAIL_CONFIG_PUBLIC_KEYS) {
    config[key] = fileConfig[key] !== undefined ? fileConfig[key] : (process.env[key] || '');
  }
  const smtpPassword = fileConfig.SMTP_PASS !== undefined ? fileConfig.SMTP_PASS : process.env.SMTP_PASS;
  config.SMTP_PASS_CONFIGURED = !!smtpPassword;
  return config;
}

function parseConfigBoolean(value) {
  return value === true || value === 1 || ['true', '1', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function cleanEmailConfigPayload(body) {
  const stringValue = (key, maxLength = 2048) => {
    const value = typeof body[key] === 'string' ? body[key].trim() : '';
    if (value.length > maxLength) throw createHttpError(400, `${key} is too long.`);
    return value;
  };
  const integerValue = (key, fallback, min, max) => {
    const raw = body[key] === '' || body[key] === undefined || body[key] === null ? fallback : body[key];
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw createHttpError(400, `${key} must be an integer between ${min} and ${max}.`);
    }
    return String(value);
  };
  const optionalHttpUrl = (key) => {
    const value = stringValue(key);
    if (!value) return '';
    let url;
    try { url = new URL(value); } catch (_) { throw createHttpError(400, `${key} must be a valid URL.`); }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw createHttpError(400, `${key} must use http or https.`);
    }
    return value;
  };

  const updates = {
    SMTP_HOST: stringValue('SMTP_HOST', 255),
    SMTP_PORT: integerValue('SMTP_PORT', 587, 1, 65535),
    SMTP_SECURE: String(parseConfigBoolean(body.SMTP_SECURE)),
    SMTP_REQUIRE_TLS: String(parseConfigBoolean(body.SMTP_REQUIRE_TLS)),
    SMTP_USER: stringValue('SMTP_USER', 512),
    EMAIL_FROM: stringValue('EMAIL_FROM', 512),
    EMAIL_REPLY_TO: stringValue('EMAIL_REPLY_TO', 512),
    EMAIL_BATCH_SIZE: integerValue('EMAIL_BATCH_SIZE', 50, 1, 100),
    EMAIL_UNSUBSCRIBE_URL: stringValue('EMAIL_UNSUBSCRIBE_URL'),
    PUBLIC_BASE_URL: optionalHttpUrl('PUBLIC_BASE_URL'),
    APK_BANNER_IMAGE_URL: stringValue('APK_BANNER_IMAGE_URL'),
    GITHUB_RELEASES_API_URL: optionalHttpUrl('GITHUB_RELEASES_API_URL')
  };

  const newPassword = typeof body.SMTP_PASS === 'string' ? body.SMTP_PASS : '';
  if (newPassword) {
    if (newPassword.length > 4096) throw createHttpError(400, 'SMTP_PASS is too long.');
    updates.SMTP_PASS = newPassword;
  }

  const effectivePassword = updates.SMTP_PASS || process.env.SMTP_PASS;
  const missing = [
    ['SMTP_HOST', updates.SMTP_HOST],
    ['SMTP_USER', updates.SMTP_USER],
    ['SMTP_PASS', effectivePassword],
    ['EMAIL_FROM', updates.EMAIL_FROM]
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw createHttpError(400, `Required email settings are missing: ${missing.join(', ')}`);
  }

  return updates;
}

function serializeEnvValue(value) {
  return JSON.stringify(String(value));
}

function writeEnvUpdates(updates) {
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingEol = current.endsWith('\n');
  const lines = current ? current.split(/\r?\n/) : [];
  if (hadTrailingEol && lines[lines.length - 1] === '') lines.pop();

  const values = new Map(Object.entries(updates));
  const updatedKeys = new Set();
  const updatedLines = lines.map(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !values.has(match[1])) return line;
    const key = match[1];
    const value = values.get(key);
    updatedKeys.add(key);
    return `${key}=${serializeEnvValue(value)}`;
  });

  for (const [key, value] of values) {
    if (updatedKeys.has(key)) continue;
    updatedLines.push(`${key}=${serializeEnvValue(value)}`);
  }

  const output = updatedLines.join(eol) + (hadTrailingEol || updatedLines.length ? eol : '');
  const tempFile = `${ENV_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempFile, output, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempFile, ENV_FILE);
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = String(value);
  }
}

function cleanEmailPayload(body) {
  const includeApkLinks = body.includeApkLinks === true || body.includeApkLinks === 'true';
  const cleanSubject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const cleanText = typeof body.messageText === 'string' ? body.messageText.trim() : '';
  const cleanHtml = typeof body.messageHtml === 'string' ? body.messageHtml.trim() : '';
  const subject = cleanSubject || (includeApkLinks ? 'Download the latest KiduyuTV app' : '');

  if (!subject) {
    throw createHttpError(400, 'Email subject is required.');
  }
  if (subject.length > 180) {
    throw createHttpError(400, 'Email subject must be 180 characters or fewer.');
  }
  if (!includeApkLinks && !cleanText && !cleanHtml) {
    throw createHttpError(400, 'Email message is required.');
  }
  if (cleanText.length > 50000 || cleanHtml.length > 100000) {
    throw createHttpError(400, 'Email message is too large.');
  }

  return {
    subject,
    text: cleanText,
    html: cleanHtml,
    includeApkLinks
  };
}

async function fetchJson(url) {
  if (typeof fetch !== 'function') {
    throw createHttpError(500, 'This Node.js runtime does not support fetch.');
  }

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'KiduyuTV-Admin'
    }
  });

  if (!res.ok) {
    throw createHttpError(502, `GitHub release lookup failed (${res.status}).`);
  }

  return res.json();
}

function pickApkAsset(assets, platform) {
  const patterns = {
    phone: /^KiduyuTV-phone-release-.+\.apk$/i,
    tv: /^KiduyuTV-tv-release-.+\.apk$/i
  };
  const pattern = patterns[String(platform || '').toLowerCase()];
  if (!pattern) return undefined;

  return assets.find(asset => pattern.test(String(asset.name || '')));
}

async function getLatestApkLinks({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && latestApkLinksCache && latestApkLinksCache.expiresAt > now) {
    return latestApkLinksCache.value;
  }

  const release = await fetchJson(process.env.GITHUB_RELEASES_API_URL || GITHUB_RELEASES_API_URL);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const phone = pickApkAsset(assets, 'phone');
  const tv = pickApkAsset(assets, 'tv');

  if (!phone || !tv) {
    throw createHttpError(502, 'Latest GitHub release does not contain both phone and TV APK assets.');
  }

  const value = {
    tagName: release.tag_name || '',
    releaseName: release.name || release.tag_name || 'Latest release',
    releaseNotes: typeof release.body === 'string' ? release.body.trim() : '',
    releaseUrl: release.html_url || 'https://github.com/kiduyu-klaus/KiduyuTv_final/releases/latest',
    phone: {
      name: phone.name,
      url: phone.browser_download_url
    },
    tv: {
      name: tv.name,
      url: tv.browser_download_url
    }
  };

  latestApkLinksCache = {
    value,
    expiresAt: now + APK_LINK_CACHE_TTL_MS
  };

  return value;
}

function escapeHtmlValue(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getUnsubscribeUrl() {
  if (process.env.EMAIL_UNSUBSCRIBE_URL) return process.env.EMAIL_UNSUBSCRIBE_URL;
  const replyAddress = process.env.EMAIL_REPLY_TO || process.env.SMTP_USER || '';
  return replyAddress ? `mailto:${replyAddress}?subject=Unsubscribe` : '#';
}

function getPublicBaseUrl() {
  const configuredBase = (process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://sflatransport.com')
    .replace(/\/+$/, '');
  return configuredBase.endsWith(APP_BASE_PATH)
    ? configuredBase
    : `${configuredBase}${APP_BASE_PATH}`;
}

function getApkBannerImageUrl() {
  const configured = process.env.APK_BANNER_IMAGE_URL || APK_BANNER_IMAGE_URL;
  if (/^https?:\/\//i.test(configured)) return configured;

  const cleanPath = configured.replace(/^\.?\/*/, '');
  return `${getPublicBaseUrl()}/${cleanPath || 'ic_banner.png'}`;
}

function buildApkTextEmail(apkLinks, existingText = '') {
  const intro = existingText.trim() || [
    'Hi,',
    '',
    'The latest KiduyuTV app release is ready to download. Choose the APK that matches your device.'
  ].join('\n');

  return [
    intro,
    '',
    `Latest release: ${apkLinks.tagName || 'latest'}`,
    '',
    `Phone / Tablet APK: ${apkLinks.phone.url}`,
    `Android TV / Fire TV APK: ${apkLinks.tv.url}`,
    `Release page: ${apkLinks.releaseUrl}`,
    '',
    'If you were not expecting this message, you can ignore it.',
    '',
    'KiduyuTV'
  ].join('\n');
}

function buildApkHtmlEmail(apkLinks, existingHtml = '') {
  const safeTag = escapeHtmlValue(apkLinks.tagName || 'latest');
  const safePhoneUrl = escapeHtmlValue(apkLinks.phone.url);
  const safeTvUrl = escapeHtmlValue(apkLinks.tv.url);
  const safeReleaseUrl = escapeHtmlValue(apkLinks.releaseUrl);
  const safeBannerUrl = escapeHtmlValue(getApkBannerImageUrl());
  const safeUnsubscribeUrl = escapeHtmlValue(getUnsubscribeUrl());

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <meta name="supported-color-schemes" content="dark light">
    <title>Download the latest KiduyuTV app</title>
    <!--[if mso]>
    <noscript>
      <xml>
        <o:OfficeDocumentSettings>
          <o:PixelsPerInch>96</o:PixelsPerInch>
        </o:OfficeDocumentSettings>
      </xml>
    </noscript>
    <![endif]-->
    <style>
      @media only screen and (max-width: 600px) {
        .container { width: 100% !important; border-radius: 0 !important; }
        .stack-col { display: block !important; width: 100% !important; padding-right: 0 !important; padding-bottom: 12px !important; }
        .btn-cell { display: block !important; width: 100% !important; }
        .btn { display: block !important; width: 100% !important; box-sizing: border-box; }
        .hero-pad { padding: 26px 20px 22px !important; }
        .hero-title { font-size: 23px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#F4F6FA;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      KiduyuTV ${safeTag} is live - grab the phone or TV build directly, no attachments needed.
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#FFFFFF;margin:0;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" class="container" data-kiduyu-template="latest-apk-email" style="max-width:600px;background:#14161D;border:1px solid #23262F;border-radius:20px;overflow:hidden;">

            <tr>
              <td style="padding:0;background:#E50914;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="padding:22px 28px;">
                      <span style="font-size:15px;font-weight:800;letter-spacing:.06em;color:#FFFFFF;text-transform:uppercase;">KiduyuTV</span>
                    </td>
                    <td align="right" style="padding:22px 28px;">
                      <span style="font-size:12px;font-weight:700;color:#FFFFFF;background:#B00610;padding:6px 12px;border-radius:100px;">${safeTag}</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0;">
                <img src="${safeBannerUrl}" width="600" alt="KiduyuTV" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
              </td>
            </tr>

            <tr>
              <td class="hero-pad" style="padding:36px 28px 8px;">
                <h1 class="hero-title" style="margin:0 0 12px;color:#FFFFFF;font-size:26px;line-height:1.25;font-weight:800;">
                  A new release just dropped
                </h1>
                ${existingHtml.trim() || '<p style="margin:0 0 26px;color:#B7BECC;font-size:15.5px;line-height:1.65;">Faster playback, fewer bugs, better stability. Pick the build that matches your device below - takes about 30 seconds.</p>'}
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td class="stack-col" width="50%" style="padding:0 8px 12px 0;vertical-align:top;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#1B1E27;border:1px solid #2A2E3A;border-radius:14px;">
                        <tr>
                          <td style="padding:20px;">
                            <p style="margin:0 0 4px;color:#8A93A6;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;">For Phone &amp; Tablet</p>
                            <p style="margin:0 0 16px;color:#EDEFF4;font-size:14px;line-height:1.5;">Android phones and tablets</p>
                            <a href="${safePhoneUrl}" class="btn" style="display:inline-block;background:#E50914;color:#FFFFFF;text-decoration:none;border-radius:10px;padding:12px 18px;font-size:14px;font-weight:700;">Download &rarr;</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td class="stack-col" width="50%" style="padding:0 0 12px 8px;vertical-align:top;">
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#1B1E27;border:1px solid #2A2E3A;border-radius:14px;">
                        <tr>
                          <td style="padding:20px;">
                            <p style="margin:0 0 4px;color:#8A93A6;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;">For TV</p>
                            <p style="margin:0 0 16px;color:#EDEFF4;font-size:14px;line-height:1.5;">Android TV and Fire TV</p>
                            <a href="${safeTvUrl}" class="btn" style="display:inline-block;background:#2B3342;color:#FFFFFF;text-decoration:none;border-radius:10px;padding:12px 18px;font-size:14px;font-weight:700;">Download &rarr;</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 28px 34px;">
                <p style="margin:0;color:#8A93A6;font-size:13.5px;line-height:1.6;">
                  Want the full changelog first? <a href="${safeReleaseUrl}" style="color:#FF6B73;text-decoration:underline;font-weight:600;">View the release notes</a>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px;">
                <div style="border-top:1px solid #23262F;"></div>
              </td>
            </tr>

            <tr>
              <td style="padding:22px 28px 28px;">
                <p style="margin:0 0 10px;color:#6E7686;font-size:12px;line-height:1.7;">
                  APKs are linked directly rather than attached, to keep this email small and delivery reliable. Files are hosted on GitHub Releases.
                </p>
                <p style="margin:0;color:#6E7686;font-size:12px;line-height:1.7;">
                  You're receiving this because you have a KiduyuTV account.
                  <a href="${safeUnsubscribeUrl}" style="color:#8A93A6;text-decoration:underline;">Unsubscribe</a>
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function maybeAttachLatestApkLinks(email) {
  if (!email.includeApkLinks) return { email, apkLinks: null };

  const apkLinks = await getLatestApkLinks();
  const hasGeneratedHtml = email.html.includes('data-kiduyu-template="latest-apk-email"');
  const html = hasGeneratedHtml
    ? email.html
        .replace(/%unsubscribe_url%/g, escapeHtmlValue(getUnsubscribeUrl()))
        .replace(/%apk_banner_url%/g, escapeHtmlValue(getApkBannerImageUrl()))
    : buildApkHtmlEmail(apkLinks, email.html);

  return {
    apkLinks,
    email: {
      ...email,
      text: buildApkTextEmail(apkLinks, email.text),
      html
    }
  };
}

async function sendEmailMessage(transporter, recipients, email, { bcc = false } = {}) {
  const message = {
    from: process.env.EMAIL_FROM,
    replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM,
    to: bcc ? process.env.EMAIL_FROM : recipients,
    bcc: bcc ? recipients : undefined,
    subject: email.subject,
    text: email.text || undefined,
    html: email.html || undefined,
    headers: {
      'X-Auto-Response-Suppress': 'All'
    }
  };

  if (process.env.EMAIL_UNSUBSCRIBE_URL) {
    message.list = {
      unsubscribe: {
        url: process.env.EMAIL_UNSUBSCRIBE_URL,
        comment: 'Unsubscribe from KiduyuTV email updates'
      }
    };
  }

  const info = await transporter.sendMail(message);

  return {
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted.length : 0,
    rejected: Array.isArray(info.rejected) ? info.rejected.length : 0
  };
}

// Health check
router.get('/health', (req, res) => {
  log('info', 'Health check');
  res.json({ status: 'ok', app: 'connectTv', timestamp: Date.now() });
});

// Public latest-release metadata used by the landing-page download cards.
router.get('/downloads/latest', async (req, res) => {
  try {
    const apkLinks = await getLatestApkLinks();
    res.set('Cache-Control', 'public, max-age=300');
    return res.json({ success: true, ...apkLinks });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/downloads/latest', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Main endpoint
router.post('/connectTv', async (req, res) => {
  try {
    const { code, idToken } = req.body;
    if (!code || !idToken) {
      log('warn', 'connectTv missing code or idToken', { ip: req.ip });
      return res.status(400).json({ error: 'Missing code or idToken.' });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const phoneUid = decoded.uid;
    const db = admin.firestore();
    const docRef = db.collection('tvCodes').doc(code);
    const snap = await docRef.get();

    if (!snap.exists) {
      log('warn', 'connectTv invalid code', { code, ip: req.ip });
      return res.status(404).json({ error: 'Invalid code.' });
    }
    const data = snap.data();
    if (data.status !== 'pending') {
      log('warn', 'connectTv code already used', { code, ip: req.ip });
      return res.status(409).json({ error: 'Code already used.' });
    }

    const createdAt = data.createdAt.toDate();
    if (Date.now() - createdAt > 5 * 60 * 1000) {
      log('warn', 'connectTv code expired', { code, ip: req.ip });
      return res.status(410).json({ error: 'Code expired.' });
    }

    const customToken = await admin.auth().createCustomToken(phoneUid);
    await docRef.update({ status: 'linked', customToken, phoneUid });

    log('info', 'connectTv success', { code, phoneUid, adminUid: decoded.uid });
    return res.json({ success: true });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/connectTv', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// ── ADMIN AUTH ROUTES ────────────────────────────────────────────

// Verify admin ID token and get user info
router.post('/admin/verify', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      log('warn', 'admin/verify missing idToken', { ip: req.ip });
      return res.status(400).json({ error: 'Missing idToken.' });
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    const db = admin.firestore();
    const adminDoc = await db.collection('admins').doc(decoded.uid).get();

    if (!adminDoc.exists) {
      log('warn', 'admin/verify not an admin', { uid: decoded.uid, email: decoded.email, ip: req.ip });
      return res.status(403).json({ error: 'Not an admin.' });
    }

    log('info', 'admin/verify success', { uid: decoded.uid, email: decoded.email });
    return res.json({
      success: true,
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name || decoded.email
    });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/verify', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/admin/email/config', async (req, res) => {
  try {
    await verifyAdminToken(req.query.idToken);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, config: getEmailConfigForAdmin() });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/email/config', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.put('/admin/email/config', async (req, res) => {
  try {
    const adminUser = await verifyAdminToken(req.body.idToken);
    const updates = cleanEmailConfigPayload(req.body);
    writeEnvUpdates(updates);

    log('info', 'admin/email/config updated', {
      adminUid: adminUser.uid,
      fields: Object.keys(updates).filter(key => key !== 'SMTP_PASS'),
      smtpPasswordUpdated: Object.prototype.hasOwnProperty.call(updates, 'SMTP_PASS')
    });

    return res.json({ success: true, config: getEmailConfigForAdmin() });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/email/config', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/email/recipients', async (req, res) => {
  try {
    await verifyAdminToken(req.query.idToken);
    const emails = await listAllUsersWithEmails();

    log('info', 'admin/email/recipients counted', { count: emails.length });
    return res.json({ success: true, count: emails.length });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/email/recipients', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.get('/admin/email/latest-apks', async (req, res) => {
  try {
    await verifyAdminToken(req.query.idToken);
    const forceRefresh = req.query.refresh === 'true';
    const apkLinks = await getLatestApkLinks({ forceRefresh });

    log('info', 'admin/email/latest-apks fetched', { tagName: apkLinks.tagName });
    return res.json({ success: true, ...apkLinks });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/email/latest-apks', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/email/send', async (req, res) => {
  try {
    const { idToken } = req.body;
    const adminUser = await verifyAdminToken(idToken);
    const preparedEmail = cleanEmailPayload(req.body);

    const missingConfig = validateEmailConfig();
    if (missingConfig.length) {
      return res.status(500).json({ error: `Missing email config: ${missingConfig.join(', ')}` });
    }

    const recipients = await listAllUsersWithEmails();
    if (!recipients.length) {
      return res.status(400).json({ error: 'No registered users with email addresses found.' });
    }

    const parsedBatchSize = Number(process.env.EMAIL_BATCH_SIZE || 50);
    const batchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
      ? Math.min(Math.floor(parsedBatchSize), 100)
      : 50;
    const batches = chunkArray(recipients, batchSize);
    const transporter = getEmailTransporter();
    const { email, apkLinks } = await maybeAttachLatestApkLinks(preparedEmail);
    const results = [];

    for (const batch of batches) {
      results.push(await sendEmailMessage(transporter, batch, email, { bcc: true }));
    }

    log('info', 'admin/email/send completed', {
      adminUid: adminUser.uid,
      recipientCount: recipients.length,
      batchCount: batches.length,
      subject: email.subject,
      apkLinksIncluded: !!apkLinks
    });

    return res.json({
      success: true,
      recipientCount: recipients.length,
      batchCount: batches.length,
      apkLinks,
      results
    });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/email/send', stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/admin/users/:uid/email', async (req, res) => {
  try {
    const { idToken } = req.body;
    const adminUser = await verifyAdminToken(idToken);
    const preparedEmail = cleanEmailPayload(req.body);
    const missingConfig = validateEmailConfig();

    if (missingConfig.length) {
      return res.status(500).json({ error: `Missing email config: ${missingConfig.join(', ')}` });
    }

    const targetUser = await admin.auth().getUser(req.params.uid);
    const recipient = targetUser.email ? targetUser.email.trim().toLowerCase() : '';

    if (!recipient) {
      return res.status(400).json({ error: 'This user does not have an email address.' });
    }
    if (targetUser.disabled) {
      return res.status(400).json({ error: 'This user account is disabled.' });
    }

    const transporter = getEmailTransporter();
    const { email, apkLinks } = await maybeAttachLatestApkLinks(preparedEmail);
    const result = await sendEmailMessage(transporter, [recipient], email);

    log('info', 'admin/users/:uid/email sent', {
      adminUid: adminUser.uid,
      targetUid: req.params.uid,
      recipient,
      subject: email.subject,
      apkLinksIncluded: !!apkLinks
    });

    return res.json({
      success: true,
      uid: req.params.uid,
      email: recipient,
      apkLinks,
      result
    });
  } catch (err) {
    log('error', err.message, { endpoint: `/api/admin/users/${req.params.uid}/email`, stack: err.stack });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── ADMIN DATA ROUTES ─────────────────────────────────────────────

// Get all users (limited data for list view)
router.get('/admin/users', async (req, res) => {
  try {
    const { idToken, page = 1, limit = 20, search = '' } = req.query;
    if (!idToken) {
      log('warn', 'admin/users missing idToken', { ip: req.ip });
      return res.status(400).json({ error: 'Missing idToken.' });
    }

    // Verify admin
    await admin.auth().verifyIdToken(idToken);
    const db = admin.firestore();
    const rtdb = admin.database();

    // Get all users from Auth
    const listUsersResult = await admin.auth().listUsers(1000);
    let users = listUsersResult.users.map(u => ({
      uid: u.uid,
      email: u.email || 'N/A',
      displayName: u.displayName || 'Anonymous',
      photoURL: u.photoURL || null,
      createdAt: u.metadata.creationTime ? new Date(u.metadata.creationTime).getTime() : null,
      lastLoginAt: u.metadata.lastRefreshTime ? new Date(u.metadata.lastRefreshTime).getTime() : null
    }));

    // For each user, try to fetch their Realtime DB data
    const enrichedUsers = await Promise.all(users.map(async (user) => {
      try {
        const snapshot = await rtdb.ref(`users/${user.uid}`).once('value');
        const userData = snapshot.val() || {};
        return {
          ...user,
          myListCount: userData.myList ? Object.keys(userData.myList).length : 0,
          watchHistoryCount: userData.watchHistory ? Object.keys(userData.watchHistory).length : 0,
          savedChannelsCount: userData.savedChannels ? Object.keys(userData.savedChannels).length : 0,
          savedCastsCount: userData.savedCasts ? Object.keys(userData.savedCasts).length : 0,
          defaultProvider: userData.defaultProvider || 'Auto',
          hasData: !!userData.myList
        };
      } catch (e) {
        return { ...user, myListCount: 0, watchHistoryCount: 0, savedChannelsCount: 0, savedCastsCount: 0, hasData: false };
      }
    }));

    // Sort by last login (most recent first)
    enrichedUsers.sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0));

    // Apply search filter
    let filtered = enrichedUsers;
    if (search) {
      const s = search.toLowerCase();
      filtered = enrichedUsers.filter(u =>
        (u.email && u.email.toLowerCase().includes(s)) ||
        (u.displayName && u.displayName.toLowerCase().includes(s)) ||
        (u.uid && u.uid.toLowerCase().includes(s))
      );
    }

    // Paginate
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const start = (pageNum - 1) * limitNum;
    const paginated = filtered.slice(start, start + limitNum);

    log('info', 'admin/users listed', { count: filtered.length, page: pageNum, search });
    return res.json({
      users: paginated,
      total: filtered.length,
      page: pageNum,
      totalPages: Math.ceil(filtered.length / limitNum)
    });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/users', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// Get single user full details by UID
router.get('/admin/users/:uid', async (req, res) => {
  try {
    const { idToken } = req.query;
    const { uid } = req.params;

    if (!idToken) {
      log('warn', 'admin/users/:uid missing idToken', { uid, ip: req.ip });
      return res.status(400).json({ error: 'Missing idToken.' });
    }
    await admin.auth().verifyIdToken(idToken);

    const db = admin.firestore();
    const rtdb = admin.database();

    // Get Auth user info
    let userInfo;
    try {
      userInfo = await admin.auth().getUser(uid);
    } catch (e) {
      userInfo = null;
    }

    // Get Realtime DB data
    const snapshot = await rtdb.ref(`users/${uid}`).once('value');
    const userData = snapshot.val() || {};

    log('info', 'admin/users/:uid fetched', { uid, hasData: !!userData.myList });
    return res.json({
      auth: userInfo ? {
        uid: userInfo.uid,
        email: userInfo.email || 'N/A',
        displayName: userInfo.displayName || 'Anonymous',
        photoURL: userInfo.photoURL || null,
        createdAt: userInfo.metadata?.creationTime ? new Date(userInfo.metadata.creationTime).getTime() : null,
        lastLoginAt: userInfo.metadata?.lastRefreshTime ? new Date(userInfo.metadata.lastRefreshTime).getTime() : null,
        provider: userInfo.providerData?.[0]?.providerId || 'unknown'
      } : null,
      myList: userData.myList || {},
      watchHistory: userData.watchHistory || {},
      savedChannels: userData.savedChannels || {},
      savedCasts: userData.savedCasts || {},
      savedCompanies: userData.savedCompanies || {},
      savedNetworks: userData.savedNetworks || {},
      preferences: {
        defaultProvider: userData.defaultProvider || 'Auto'
      }
    });
  } catch (err) {
    log('error', err.message, { endpoint: `/api/admin/users/${req.params.uid}`, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// Get analytics stats
router.get('/admin/analytics', async (req, res) => {
  try {
    const { idToken } = req.query;
    if (!idToken) {
      log('warn', 'admin/analytics missing idToken', { ip: req.ip });
      return res.status(400).json({ error: 'Missing idToken.' });
    }

    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();

    // List all users
    const listUsersResult = await admin.auth().listUsers(1000);
    const totalUsers = listUsersResult.users.length;

    // Calculate stats from all users' data
    let stats = {
      totalUsers,
      usersWithMyList: 0,
      usersWithWatchHistory: 0,
      totalMyListItems: 0,
      totalWatchHistoryItems: 0,
      topMyListMovies: [],
      topMyListTvShows: [],
      topSavedCasts: [],
      providerDistribution: { Auto: 0 },
      topWatchedMovies: [],
      topWatchedTvShows: []
    };

    // Counts keyed by tmdbId, each entry tracks { title, count } so the UI
    // can show "The Dark Knight" instead of "TMDB #155".
    const movieCounts = {};
    const tvCounts = {};
    const castCounts = {};
    const providerCounts = {};

    const bump = (bucket, id, title) => {
      const key = String(id);
      if (!bucket[key]) bucket[key] = { title: title || null, count: 0 };
      else if (title && !bucket[key].title) bucket[key].title = title;
      bucket[key].count += 1;
    };

    await Promise.all(listUsersResult.users.map(async (user) => {
      try {
        const snapshot = await rtdb.ref(`users/${user.uid}`).once('value');
        const data = snapshot.val() || {};

        if (data.defaultProvider) {
          providerCounts[data.defaultProvider] = (providerCounts[data.defaultProvider] || 0) + 1;
        }

        if (data.myList) {
          stats.usersWithMyList++;
          const entries = Object.values(data.myList);
          stats.totalMyListItems += entries.length;
          entries.forEach(item => {
            if (!item.isTv) bump(movieCounts, item.tmdbId, item.title);
            else bump(tvCounts, item.tmdbId, item.title || item.name);
          });
        }

        if (data.watchHistory) {
          stats.usersWithWatchHistory++;
          const wh = data.watchHistory;
          const movies = wh.movies || wh;
          const tvs = wh.tvShows || {};
          Object.values(movies).forEach(item => {
            bump(movieCounts, item.tmdbId, item.title);
          });
          Object.values(tvs).forEach(item => {
            bump(tvCounts, item.tmdbId, item.title || item.name);
          });
        }

        if (data.savedCasts) {
          Object.values(data.savedCasts).forEach(cast => {
            castCounts[cast.name] = (castCounts[cast.name] || 0) + 1;
          });
        }
      } catch (e) { }
    }));

    // Convert counts to sorted arrays
    const toTopList = (bucket) =>
      Object.entries(bucket)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([id, { title, count }]) => ({ tmdbId: parseInt(id), title, count }));

    stats.topMyListMovies = toTopList(movieCounts);
    stats.topMyListTvShows = toTopList(tvCounts);
    stats.topSavedCasts = Object.entries(castCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
    stats.providerDistribution = providerCounts;
    stats.topWatchedMovies = stats.topMyListMovies;
    stats.topWatchedTvShows = stats.topMyListTvShows;

    log('info', 'admin/analytics computed', { totalUsers });
    return res.json(stats);
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/analytics', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// Delete user data from Realtime DB (not auth account)
router.delete('/admin/users/:uid/data', async (req, res) => {
  try {
    const { idToken } = req.body;
    const { uid } = req.params;

    if (!idToken) {
      log('warn', 'admin/users/:uid/data DELETE missing idToken', { uid, ip: req.ip });
      return res.status(400).json({ error: 'Missing idToken.' });
    }
    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();

    await rtdb.ref(`users/${uid}`).remove();
    log('info', 'admin/users/:uid/data deleted', { uid });
    return res.json({ success: true, message: 'User data deleted.' });
  } catch (err) {
    log('error', err.message, { endpoint: `/api/admin/users/${req.params.uid}/data`, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// Get TV schedule data
router.get('/admin/schedule', async (req, res) => {
  try {
    const { idToken } = req.query;
    if (!idToken) {
      log('warn', 'admin/schedule missing idToken', { ip: req.ip });
      return res.status(400).json({ error: 'Missing idToken.' });
    }

    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();
    const snapshot = await rtdb.ref('schedule').once('value');
    const scheduleData = snapshot.val() || {};

    log('info', 'admin/schedule fetched');
    return res.json(scheduleData);
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/schedule', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// ── APP CONFIG ROUTES ─────────────────────────────────────────────

// Default values — used to initialise a section when its RTDB node is empty.
// Existing values are NEVER overwritten by defaults; they are only applied
// when the section has never been written.
// ── STREAM PROVIDERS ────────────────────────────────────────────────
// Each provider is stored at:
//   app_config/stream_providers_Configuration/<provider_name>
//
// Fields: stream_provider_name, url, enabled,
//         movie_url_template, tv_url_template,
//         iframe_attributes (map), allow_attributes (string),
//         movie_parameters (map), tv_parameters (map),
//         createdAt

const PROVIDER_DEFAULTS = {
  Videasy: {
    stream_provider_name: 'Videasy', url: 'https://player.videasy.net', enabled: true,
    movie_url_template: 'https://player.videasy.net/movie/%d',
    tv_url_template: 'https://player.videasy.net/tv/%d/%d/%d',
    iframe_attributes: { frameborder: '0', allow: 'encrypted-media' },
    allow_attributes: '',
    movie_parameters: { overlay: 'true', color: '8B5CF6' },
    tv_parameters: { nextEpisode: 'true', autoplayNextEpisode: 'true', episodeSelector: 'true', overlay: 'true', color: '8B5CF6' },
    createdAt: null
  },
  Vidrock: {
    stream_provider_name: 'Vidrock', url: 'https://vidrock.net', enabled: true,
    movie_url_template: 'https://vidrock.net/movie/%d',
    tv_url_template: 'https://vidrock.net/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true' },
    tv_parameters: { autoplay: 'true', autonext: 'true' },
    createdAt: null
  },
  VidLink: {
    stream_provider_name: 'VidLink', url: 'https://vidlink.pro', enabled: true,
    movie_url_template: 'https://vidlink.pro/movie/%d',
    tv_url_template: 'https://vidlink.pro/tv/%d/%d/%d',
    iframe_attributes: { frameborder: '0' },
    allow_attributes: '',
    movie_parameters: { autoPlay: 'true' },
    tv_parameters: { autoPlay: 'true' },
    createdAt: null
  },
  VidFast: {
    stream_provider_name: 'VidFast', url: 'https://vidfast.pro', enabled: true,
    movie_url_template: 'https://vidfast.pro/movie/%d',
    tv_url_template: 'https://vidfast.pro/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoPlay: 'true', theme: '9B59B6' },
    tv_parameters: { autoPlay: 'true', nextButton: 'true', autoNext: 'true', theme: '9B59B6' },
    createdAt: null
  },
  VidKing: {
    stream_provider_name: 'VidKing', url: 'https://www.vidking.net', enabled: true,
    movie_url_template: 'https://www.vidking.net/embed/movie/%d',
    tv_url_template: 'https://www.vidking.net/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoPlay: 'true' },
    tv_parameters: { autoPlay: 'true', nextEpisode: 'true', episodeSelector: 'true' },
    createdAt: null
  },
  VidNest: {
    stream_provider_name: 'VidNest', url: 'https://vidnest.fun', enabled: true,
    movie_url_template: 'https://vidnest.fun/movie/%d',
    tv_url_template: 'https://vidnest.fun/tv/%d/%d/%d',
    iframe_attributes: { scrolling: 'no', frameBorder: '0' },
    allow_attributes: '',
    movie_parameters: { servericon: 'show', bottomcaption: 'true', timeslider: '1' },
    tv_parameters: {},
    createdAt: null
  },
  VidUp: {
    stream_provider_name: 'VidUp', url: 'https://vidup.to', enabled: true,
    movie_url_template: 'https://vidup.to/movie/%d',
    tv_url_template: 'https://vidup.to/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoPlay: 'true' },
    tv_parameters: { autoPlay: 'true' },
    createdAt: null
  },
  Flixer: {
    stream_provider_name: 'Flixer', url: 'https://flixer.su', enabled: true,
    movie_url_template: 'https://flixer.su/watch/movie/%d',
    tv_url_template: 'https://flixer.su/watch/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  VidCore: {
    stream_provider_name: 'VidCore', url: 'https://vidcore.net', enabled: true,
    movie_url_template: 'https://vidcore.net/movie/%d',
    tv_url_template: 'https://vidcore.net/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoPlay: 'true', sub: 'en' },
    tv_parameters: { autoPlay: 'true', nextButton: 'true', autoNext: 'true' },
    createdAt: null
  },
  Peachify: {
    stream_provider_name: 'Peachify', url: 'https://peachify.top', enabled: true,
    movie_url_template: 'https://peachify.top/embed/movie/%d',
    tv_url_template: 'https://peachify.top/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { sub: 'English' },
    tv_parameters: { sub: 'English', autoNext: '30' },
    createdAt: null
  },
  VidAPI: {
    stream_provider_name: 'VidAPI', url: 'https://vaplayer.ru', enabled: true,
    movie_url_template: 'https://vaplayer.ru/embed/movie/%d',
    tv_url_template: 'https://vaplayer.ru/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: '1', overlay: 'true' },
    tv_parameters: { autoplay: '1', overlay: 'true' },
    createdAt: null
  },
  VidPlus: {
    stream_provider_name: 'VidPlus', url: 'https://player.vidplus.to', enabled: true,
    movie_url_template: 'https://player.vidplus.to/embed/movie/%d',
    tv_url_template: 'https://player.vidplus.to/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true', autoNext: 'true', nextButton: 'true', poster: 'true', title: 'true', episodelist: 'true', servericon: 'true' },
    tv_parameters: { autoplay: 'true', autoNext: 'true', poster: 'true', title: 'true', servericon: 'true' },
    createdAt: null
  },
  CineSrc: {
    stream_provider_name: 'CineSrc', url: 'https://cinesrc.st', enabled: true,
    movie_url_template: 'https://cinesrc.st/embed/movie/%d',
    tv_url_template: 'https://cinesrc.st/embed/tv/%d?s=%d&e=%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true', quality: '1080' },
    tv_parameters: { color: 'FF1493', autoplay: 'true', autonext: 'true' },
    createdAt: null
  },
  Vidzen: {
    stream_provider_name: 'Vidzen', url: 'https://vidzen.fun', enabled: true,
    movie_url_template: 'https://vidzen.fun/movie/%d',
    tv_url_template: 'https://vidzen.fun/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true' },
    tv_parameters: { autoplay: 'true' },
    createdAt: null
  },
  Cinemaos: {
    stream_provider_name: 'Cinemaos', url: 'https://cinemaos.tech', enabled: true,
    movie_url_template: 'https://cinemaos.tech/player/%d',
    tv_url_template: 'https://cinemaos.tech/player/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true' },
    tv_parameters: { autoplay: 'true' },
    createdAt: null
  },
  Amri: {
    stream_provider_name: 'Amri', url: 'https://amri.gg', enabled: true,
    movie_url_template: 'https://amri.gg/movie/%d',
    tv_url_template: 'https://amri.gg/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true' },
    tv_parameters: { autoplay: 'true' },
    createdAt: null
  },
  Zxc: {
    stream_provider_name: 'Zxc', url: 'https://zxcstream.xyz', enabled: true,
    movie_url_template: 'https://zxcstream.xyz/embed/movie/%d',
    tv_url_template: 'https://zxcstream.xyz/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true' },
    tv_parameters: { autoplay: 'true' },
    createdAt: null
  },
  Vlux: {
    stream_provider_name: 'Vlux', url: 'https://vidlux.xyz', enabled: true,
    movie_url_template: 'https://vidlux.xyz/embed/movie/%d',
    tv_url_template: 'https://vidlux.xyz/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoplay: 'true' },
    tv_parameters: { autoplay: 'true' },
    createdAt: null
  },
  'VidSrc (WTF) v4': {
    stream_provider_name: 'VidSrc (WTF) v4', url: 'https://vidsrc.wtf', enabled: true,
    movie_url_template: 'https://vidsrc.wtf/api/4/movie/?id=%d',
    tv_url_template: 'https://vidsrc.wtf/api/4/tv/?id=%d&s=%d&e=%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  PrimeSrc: {
    stream_provider_name: 'PrimeSrc', url: 'https://primesrc.me', enabled: true,
    movie_url_template: 'https://primesrc.me/embed/movie?tmdb=%d',
    tv_url_template: 'https://primesrc.me/embed/tv?tmdb=%d&season=%d&episode=%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  'VidSrc (WTF) v3': {
    stream_provider_name: 'VidSrc (WTF) v3', url: 'https://vidsrc.wtf', enabled: true,
    movie_url_template: 'https://vidsrc.wtf/api/3/movie/?id=%d',
    tv_url_template: 'https://vidsrc.wtf/api/3/tv/?id=%d&s=%d&e=%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  VidZee: {
    stream_provider_name: 'VidZee', url: 'https://player.vidzee.wtf', enabled: true,
    movie_url_template: 'https://player.vidzee.wtf/v2/embed/movie/%d',
    tv_url_template: 'https://player.vidzee.wtf/v2/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  Lordflix: {
    stream_provider_name: 'Lordflix', url: 'https://lordflix.org', enabled: true,
    movie_url_template: 'https://lordflix.org/watch/movie/%d',
    tv_url_template: 'https://lordflix.org/watch/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  Mapple: {
    stream_provider_name: 'Mapple', url: 'https://mapple.uk', enabled: true,
    movie_url_template: 'https://mapple.uk/watch/movie/%d',
    tv_url_template: 'https://mapple.uk/watch/tv/%d-%d-%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  Smashystream: {
    stream_provider_name: 'Smashystream', url: 'https://embed.smashystream.com', enabled: true,
    movie_url_template: 'https://embed.smashystream.com/playere.php?tmdb=%d',
    tv_url_template: 'https://embed.smashystream.com/playere.php?tmdb=%d&season=%d&episode=%d',
    iframe_attributes: { frameborder: '0' },
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  '111Movies': {
    stream_provider_name: '111Movies', url: 'https://111movies.com', enabled: true,
    movie_url_template: 'https://111movies.com/movie/%d',
    tv_url_template: 'https://111movies.com/tv/%d/%d/%d',
    iframe_attributes: { frameborder: '0' },
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  Autoembed: {
    stream_provider_name: 'Autoembed', url: 'https://autoembed.co', enabled: true,
    movie_url_template: 'https://autoembed.co/movie/tmdb/%d',
    tv_url_template: 'https://autoembed.co/tv/tmdb/%d-%d-%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  },
  EmbedMaster: {
    stream_provider_name: 'EmbedMaster', url: 'https://embedmaster.link', enabled: true,
    movie_url_template: 'https://embedmaster.link/movie/%d',
    tv_url_template: 'https://embedmaster.link/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoPlay: 'true' },
    tv_parameters: { autoPlay: 'true', nextButton: 'true', autoNext: 'true' },
    createdAt: null
  },
  Vidsync: {
    stream_provider_name: 'Vidsync', url: 'https://vidsync.xyz', enabled: true,
    movie_url_template: 'https://vidsync.xyz/embed/movie/%d',
    tv_url_template: 'https://vidsync.xyz/embed/tv/%d/%d/%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: { autoPlay: 'true' },
    tv_parameters: { autoPlay: 'true', autoNext: 'true' },
    createdAt: null
  },
  'VidSrc (WTF) v1': {
    stream_provider_name: 'VidSrc (WTF) v1', url: 'https://vidsrc.wtf', enabled: true,
    movie_url_template: 'https://vidsrc.wtf/api/1/movie/?id=%d',
    tv_url_template: 'https://vidsrc.wtf/api/1/tv/?id=%d&s=%d&e=%d',
    iframe_attributes: {},
    allow_attributes: '',
    movie_parameters: {},
    tv_parameters: {},
    createdAt: null
  }
};

const PROVIDERS_RTDB_PATH = 'app_config/stream_providers_Configuration';

async function initProviders(rtdb) {
  const ref = rtdb.ref(PROVIDERS_RTDB_PATH);
  const snap = await ref.once('value');
  const existing = snap.val() || {};

  let updated = false;
  const now = new Date().toISOString();

  for (const [name, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    if (!existing[name]) {
      existing[name] = { ...defaults, createdAt: now };
      updated = true;
    } else {
      // Merge in any new fields that didn't exist on this provider
      const existingProvider = existing[name];
      for (const [key, val] of Object.entries(defaults)) {
        if (existingProvider[key] === undefined || existingProvider[key] === null) {
          existingProvider[key] = val;
          updated = true;
        }
      }
    }
  }

  if (updated) {
    await ref.set(existing);
    log('info', 'providers updated with missing/default fields');
  }
  return existing;
}

function sanitizeProviderPayload(body) {
  function safeMap(val) {
    if (typeof val === 'object' && val !== null && !Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch (_) { return {}; }
    }
    return {};
  }
  return {
    stream_provider_name:  typeof body.stream_provider_name === 'string' ? body.stream_provider_name.trim()  : '',
    url:                  typeof body.url                  === 'string' ? body.url.trim()                  : '',
    enabled:              body.enabled === true || body.enabled === 'true' || body.enabled === 1 || body.enabled === '1',
    movie_url_template:   typeof body.movie_url_template   === 'string' ? body.movie_url_template.trim()   : '',
    tv_url_template:     typeof body.tv_url_template      === 'string' ? body.tv_url_template.trim()      : '',
    iframe_attributes:    safeMap(body.iframe_attributes),
    allow_attributes:    typeof body.allow_attributes === 'string' ? body.allow_attributes.trim() : '',
    movie_parameters:    safeMap(body.movie_parameters),
    tv_parameters:       safeMap(body.tv_parameters)
  };
}

// GET /api/admin/providers — fetch all providers (init with defaults if empty)
router.get('/admin/providers', async (req, res) => {
  try {
    const { idToken } = req.query;
    if (!idToken) {
      log('warn', 'admin/providers GET missing idToken', { ip: req.ip });
      return res.status(400).json({ error: 'Missing idToken.' });
    }
    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();
    const providers = await initProviders(rtdb);
    log('info', 'admin/providers fetched');
    return res.json(providers);
  } catch (err) {
    log('error', err.message, { endpoint: '/api/admin/providers', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/providers/<name> — create or update a single provider
router.put('/admin/providers/:name', async (req, res) => {
  try {
    const { idToken } = req.body;
    const providerName = req.params.name.trim();
    if (!idToken) {
      log('warn', 'admin/providers PUT missing idToken', { ip: req.ip, name: providerName });
      return res.status(400).json({ error: 'Missing idToken.' });
    }
    if (!providerName) {
      return res.status(400).json({ error: 'Provider name is required.' });
    }
    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();

    // Get existing to preserve createdAt
    const existingSnap = await rtdb.ref(`${PROVIDERS_RTDB_PATH}/${providerName}`).once('value');
    const existing = existingSnap.val() || {};
    const existingCreatedAt = existing.createdAt || new Date().toISOString();

    const payload = sanitizeProviderPayload(req.body);
    payload.stream_provider_name = payload.stream_provider_name || providerName;
    payload.createdAt = existingCreatedAt;

    await rtdb.ref(`${PROVIDERS_RTDB_PATH}/${providerName}`).set(payload);
    log('info', 'admin/providers updated', { name: providerName });
    return res.json({ success: true, ...payload });
  } catch (err) {
    log('error', err.message, { endpoint: `/api/admin/providers/${req.params.name}`, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/providers/<name> — remove a single provider
router.delete('/admin/providers/:name', async (req, res) => {
  try {
    const { idToken } = req.body;
    const providerName = req.params.name.trim();
    if (!idToken) {
      log('warn', 'admin/providers DELETE missing idToken', { ip: req.ip, name: providerName });
      return res.status(400).json({ error: 'Missing idToken.' });
    }
    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();
    await rtdb.ref(`${PROVIDERS_RTDB_PATH}/${providerName}`).remove();
    log('info', 'admin/providers deleted', { name: providerName });
    return res.json({ success: true });
  } catch (err) {
    log('error', err.message, { endpoint: `/api/admin/providers/${req.params.name}`, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// ── APP CONFIG ROUTES ──────────────────────────────────────────────

const ADS_CONFIG_RTDB_PATH = 'app_config/google_ads_Configuration';

const ADS_CONFIG_DEFAULTS = {
  enable_test_ads: false,
  use_test_ads: false,                 // alias for enable_test_ads (app-side)
  PHONE_ADAPTIVE_BANNER: 'ca-app-pub-3803477439180910/7183108212',
  PHONE_INTERSTITIAL_UNIT: 'ca-app-pub-3803477439180910/5295324788',
  PHONE_REWARDED_UNIT: 'ca-app-pub-3803477439180910/3982243116',
  PHONE_REWARDED_INTERSTITIAL_UNIT: 'ca-app-pub-3803477439180910/1751398697',
  PHONE_APP_OPEN_UNIT: 'ca-app-pub-3803477439180910/9694976435',
  PHONE_NATIVE_UNIT: 'ca-app-pub-3803477439180910/5035465131',
  TEST_PHONE_ADAPTIVE_BANNER: 'ca-app-pub-3940256099942544/9214589741',
  TEST_PHONE_INTERSTITIAL_UNIT: 'ca-app-pub-3940256099942544/1033173712',
  TEST_PHONE_REWARDED_UNIT: 'ca-app-pub-3940256099942544/5224354917',
  TEST_PHONE_REWARDED_INTERSTITIAL_UNIT: 'ca-app-pub-3940256099942544/5354046379',
  TEST_PHONE_APP_OPEN_UNIT: 'ca-app-pub-3940256099942544/9257395921',
  TEST_PHONE_NATIVE_UNIT: 'ca-app-pub-3940256099942544/2247696110',
  TV_ADAPTIVE_BANNER: 'ca-app-pub-3803477439180910/XXXXXXXXXX',
  TV_INTERSTITIAL_UNIT: 'ca-app-pub-3803477439180910/YYYYYYYYYY',
  TV_REWARDED_UNIT: 'ca-app-pub-3803477439180910/ZZZZZZZZZZ',
  TV_REWARDED_INTERSTITIAL_UNIT: 'ca-app-pub-3803477439180910/AAAAAAAAAA',
  TV_APP_OPEN_UNIT: 'ca-app-pub-3803477439180910/BBBBBBBBBB',
  TV_NATIVE_UNIT: 'ca-app-pub-3803477439180910/CCCCCCCCCC',
  TEST_TV_ADAPTIVE_BANNER: 'ca-app-pub-3940256099942544/9214589741',
  TEST_TV_INTERSTITIAL_UNIT: 'ca-app-pub-3940256099942544/1033173712',
  TEST_TV_REWARDED_UNIT: 'ca-app-pub-3940256099942544/5224354917',
  TEST_TV_REWARDED_INTERSTITIAL_UNIT: 'ca-app-pub-3940256099942544/5354046379',
  TEST_TV_APP_OPEN_UNIT: 'ca-app-pub-3940256099942544/9257395921',
  TEST_TV_NATIVE_UNIT: 'ca-app-pub-3940256099942544/2247696110'
};

const ADS_CONFIG_FIELDS = Object.keys(ADS_CONFIG_DEFAULTS).map(name => ({
  name,
  type: name === 'enable_test_ads' || name === 'use_test_ads' ? 'boolean' : undefined
}));

const ADS_CONFIG_LEGACY_FIELDS = [
  'phone_banner_ad_unit_id',
  'phone_interstitial_ad_unit_id',
  'phone_rewarded_ad_unit_id',
  'phone_rewarded_interstitial_ad_unit_id',
  'phone_app_open_ad_unit_id',
  'phone_native_ad_unit_id',
  'test_phone_banner_ad_unit_id',
  'test_phone_interstitial_ad_unit_id',
  'test_phone_rewarded_ad_unit_id',
  'test_phone_rewarded_interstitial_ad_unit_id',
  'test_phone_app_open_ad_unit_id',
  'test_phone_native_ad_unit_id',
  'tv_banner_ad_unit_id',
  'tv_interstitial_ad_unit_id',
  'tv_rewarded_ad_unit_id',
  'tv_rewarded_interstitial_ad_unit_id',
  'tv_app_open_ad_unit_id',
  'tv_native_ad_unit_id',
  'test_tv_banner_ad_unit_id',
  'test_tv_interstitial_ad_unit_id',
  'test_tv_rewarded_ad_unit_id',
  'test_tv_rewarded_interstitial_ad_unit_id',
  'test_tv_app_open_ad_unit_id',
  'test_tv_native_ad_unit_id'
];

async function initAdsConfig(rtdb) {
  const ref = rtdb.ref(ADS_CONFIG_RTDB_PATH);
  const snap = await ref.once('value');
  const existing = snap.val() || {};
  let updated = false;
  const removedLegacyKeys = [];

  for (const [key, val] of Object.entries(ADS_CONFIG_DEFAULTS)) {
    if (existing[key] === undefined || existing[key] === null || existing[key] === '') {
      existing[key] = val;
      updated = true;
    }
  }

  for (const key of ADS_CONFIG_LEGACY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      delete existing[key];
      removedLegacyKeys.push(key);
      updated = true;
    }
  }

  if (updated) {
    await ref.set(existing);
    log('info', 'ads config updated with missing/default fields', { removedLegacyKeys });
  }

  return existing;
}

// Default values — used to initialise a section when its RTDB node is empty.
// Existing values are NEVER overwritten by defaults; missing fields are filled
// when the section is loaded.
const CONFIG_DEFAULTS = {
  streaming: {
    playlist_url: 'https://raw.githubusercontent.com/abusaeeidx/IPTV-Scraper-Zilla/main/combined-playlist.m3u',
    playlist_epg: 'https://raw.githubusercontent.com/JulioCesarXY/EPG-LG-Channels/refs/heads/main/lg_epg_us.xml',
    schedule_api: 'https://dlhd.pk',
    playlist_cache_duration: 6,         // hours
    createdAt: null
  },
  api: {
    tmdb_bearer_token: '',
    trakt_client_id: '',
    trakt_client_secret: ''
  },
  ads: ADS_CONFIG_DEFAULTS,
  filters: {
    enable_custom_filters: false,
    easylist_url: 'https://easylist.to/easylist/easylist.txt',
    easyprivacy_url: 'https://easylist.to/easylist/easyprivacy.txt',
    custom_filters_url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/native.oppo-realme.txt',
    update_interval_hours: 24,
    filter_timeout_ms: 30000,
    filter_fallback_easylist: 'https://easylist-downloads.adblockplus.org/easylist.txt',
    filter_fallback_easyprivacy: 'https://easylist-downloads.adblockplus.org/easyprivacy.txt'
  },
  network: {
    api_cache_size_mb: 10,               // MB
    cache_max_age_minutes: 5,
    cache_max_stale_days: 7,
    api_timeout_seconds: 30,
    max_retries: 3,
    retry_delay_ms: 3000
  },
  features: {
    disable_ads_globally: false,
    cursor_speed: 50,
    cursor_hide_delay_ms: 5000
  },
  app_update: {
    enabled: false,
    version: '',
    update_title: '',
    message: '',
    download_link_phone: '',
    download_link_tv: ''
  },
  app_packagenames: {
    app_type_phone: 'com.kiduyuk.klausk.kiduyutv.phone',
    app_type_tv: 'com.kiduyuk.klausk.kiduyutv.tv'
  },
  home_dialog: {
    dialog_message: 'Welcome to Kiduyu TV! Enjoy your streaming experience.'
  }
};

// Whitelisted config sections — maps an admin-URL slug to an RTDB path
// and the set of fields the section owns. Unknown fields in the request body
// are silently dropped. Fields can be tagged with a `type` to control coercion:
// 'boolean' / 'number' / 'providerList' / default (string).
const CONFIG_SECTIONS = {
  streaming: {
    rtdbPath: 'app_config/playlist_url',
    fields: [
      { name: 'playlist_url' },
      { name: 'playlist_epg' },
      { name: 'schedule_api' },
      { name: 'playlist_cache_duration', type: 'number' }
    ],
    preserveCreatedAt: true
  },
  api: {
    rtdbPath: 'app_config/api_Configuration',
    fields: [
      { name: 'tmdb_bearer_token' },
      { name: 'trakt_client_id' },
      { name: 'trakt_client_secret' }
    ]
  },
  ads: {
    rtdbPath: ADS_CONFIG_RTDB_PATH,
    fields: ADS_CONFIG_FIELDS
  },
  filters: {
    rtdbPath: 'app_config/filter_lists_Configuration',
    fields: [
      { name: 'enable_custom_filters',     type: 'boolean' },
      { name: 'easylist_url' },
      { name: 'easyprivacy_url' },
      { name: 'custom_filters_url' },
      { name: 'update_interval_hours',     type: 'number' },
      { name: 'filter_timeout_ms',         type: 'number' },
      { name: 'filter_fallback_easylist' },
      { name: 'filter_fallback_easyprivacy' }
    ]
  },
  network: {
    rtdbPath: 'app_config/network_settings_Configuration',
    fields: [
      { name: 'api_cache_size_mb',       type: 'number' },
      { name: 'cache_max_age_minutes',   type: 'number' },
      { name: 'cache_max_stale_days',    type: 'number' },
      { name: 'api_timeout_seconds',     type: 'number' },
      { name: 'max_retries',             type: 'number' },
      { name: 'retry_delay_ms',          type: 'number' }
    ]
  },
  features: {
    rtdbPath: 'app_config/feature_flags_Configuration',
    fields: [
      { name: 'disable_ads_globally',  type: 'boolean' },
      { name: 'cursor_speed',           type: 'number' },
      { name: 'cursor_hide_delay_ms',   type: 'number' }
    ]
  },
  app_update: {
    rtdbPath: 'app_config/app_update',
    fields: [
      { name: 'enabled', type: 'boolean' },
      { name: 'version' },
      { name: 'update_title' },
      { name: 'message' },
      { name: 'download_link_phone' },
      { name: 'download_link_tv' }
    ]
  },
  app_packagenames: {
    rtdbPath: 'app_config/app_packagenames',
    fields: [
      { name: 'app_type_phone' },
      { name: 'app_type_tv' }
    ]
  },
  home_dialog: {
    rtdbPath: 'app_config/home_dialog',
    fields: [
      { name: 'dialog_message' }
    ]
  }
};

function getConfigSection(slug) {
  return CONFIG_SECTIONS[slug];
}

function sanitizeConfigField(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  switch (field.type) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }
    case 'providerList': {
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(p => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim())
        .map(p => ({
          name:       p.name.trim(),
          url:        typeof p.url === 'string' ? p.url.trim() : '',
          enabled:    p.enabled === true || p.enabled === 'true' || p.enabled === 1 || p.enabled === '1',
          movie_url_template: typeof p.movie_url_template === 'string' ? p.movie_url_template.trim() : '',
          tv_url_template:    typeof p.tv_url_template    === 'string' ? p.tv_url_template.trim()    : ''
        }));
    }
    default:
      if (typeof raw === 'string') return raw.trim();
      return String(raw);
  }
}

// Merges defaults into existing data without overwriting any existing keys.
// Used to initialise a config section when it doesn't exist in RTDB.
function mergeDefaults(existing, defaults) {
  if (!existing || typeof existing !== 'object') return { ...defaults };
  const merged = {};
  for (const key of Object.keys(defaults)) {
    if (existing[key] !== undefined && existing[key] !== null && existing[key] !== '') {
      merged[key] = existing[key];
    } else {
      merged[key] = defaults[key];
    }
  }
  return merged;
}

// Initialise a config section in RTDB with defaults if the node is empty.
// Returns the merged data (existing values preserved, missing filled in).
async function initConfigSection(rtdb, sectionDef, slug) {
  const ref = rtdb.ref(sectionDef.rtdbPath);
  const snap = await ref.once('value');
  const existing = snap.val();
  const defaults = CONFIG_DEFAULTS[slug] || {};
  const merged = mergeDefaults(existing, defaults);
  const missingKeys = Object.keys(merged).filter(key => existing == null || existing[key] === undefined || existing[key] === null || existing[key] === '');
  if (!snap.exists() || existing === null || missingKeys.length > 0) {
    await ref.set(merged);
    log('info', 'config section initialised with defaults', { path: sectionDef.rtdbPath, missingKeys });
  }
  return merged;
}

// Get one config section. Returns the raw node (merged with defaults if empty).
router.get('/admin/config/:section', async (req, res) => {
  try {
    const sectionDef = getConfigSection(req.params.section);
    if (!sectionDef) {
      return res.status(404).json({ error: 'Unknown config section.' });
    }
    const { idToken } = req.query;
    if (!idToken) {
      log('warn', 'admin/config GET missing idToken', { ip: req.ip, section: req.params.section });
      return res.status(400).json({ error: 'Missing idToken.' });
    }

    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();
    // Init with defaults if empty — does NOT overwrite existing values
    const cfg = req.params.section === 'ads'
      ? await initAdsConfig(rtdb)
      : await initConfigSection(rtdb, sectionDef, req.params.section);

    log('info', 'admin/config fetched', { section: req.params.section });
    return res.json(cfg);
  } catch (err) {
    log('error', err.message, { endpoint: `/api/admin/config/${req.params.section}`, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// Update one config section. Only the whitelisted fields are written;
// `createdAt` is preserved on sections flagged with preserveCreatedAt.
router.put('/admin/config/:section', async (req, res) => {
  try {
    const sectionDef = getConfigSection(req.params.section);
    if (!sectionDef) {
      return res.status(404).json({ error: 'Unknown config section.' });
    }
    const { idToken } = req.body;
    if (!idToken) {
      log('warn', 'admin/config PUT missing idToken', { ip: req.ip, section: req.params.section });
      return res.status(400).json({ error: 'Missing idToken.' });
    }

    await admin.auth().verifyIdToken(idToken);
    const rtdb = admin.database();

    const payload = {};
    for (const field of sectionDef.fields) {
      const clean = sanitizeConfigField(field, req.body[field.name]);
      if (clean !== undefined) payload[field.name] = clean;
    }

    const ref = rtdb.ref(sectionDef.rtdbPath);
    if (sectionDef.preserveCreatedAt) {
      const snap = await ref.once('value');
      const existing = snap.val() || {};
      payload.createdAt = existing.createdAt || new Date().toISOString();
    }

    // Merge with existing values so partial updates don't wipe unset fields
    const existing = req.params.section === 'ads'
      ? await initAdsConfig(rtdb)
      : (await ref.once('value')).val() || {};
    const merged = { ...existing, ...payload };
    await ref.set(merged);

    log('info', 'admin/config updated', { section: req.params.section, fields: Object.keys(payload) });
    return res.json({ success: true, ...merged });
  } catch (err) {
    log('error', err.message, { endpoint: `/api/admin/config/${req.params.section}`, stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// ── PUBLIC APP CONFIG ENDPOINTS ─────────────────────────────────

router.get('/getAppPackageNames', async (req, res) => {
  try {
    const rtdb = admin.database();
    const sectionDef = getConfigSection('app_packagenames');
    const config = await initConfigSection(rtdb, sectionDef, 'app_packagenames');
    return res.json({
      app_type_phone: config.app_type_phone || CONFIG_DEFAULTS.app_packagenames.app_type_phone,
      app_type_tv: config.app_type_tv || CONFIG_DEFAULTS.app_packagenames.app_type_tv
    });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/getAppPackageNames', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

router.get('/getHomeDialogMessage', async (req, res) => {
  try {
    const rtdb = admin.database();
    const sectionDef = getConfigSection('home_dialog');
    const config = await initConfigSection(rtdb, sectionDef, 'home_dialog');
    return res.json({ dialog_message: config.dialog_message || CONFIG_DEFAULTS.home_dialog.dialog_message });
  } catch (err) {
    log('error', err.message, { endpoint: '/api/getHomeDialogMessage', stack: err.stack });
    return res.status(500).json({ error: err.message });
  }
});

// ── MOUNT ADMIN PANEL AND ROUTER UNDER /api ───────────────────────

app.use('/admin-panel', (req, res) => {
  res.redirect(308, `${APP_BASE_PATH}/admin-panel${req.url}`);
});
app.use(`${APP_BASE_PATH}/admin-panel`, express.static(path.join(__dirname, 'admin')));
app.use(APP_BASE_PATH, router);
// ── START SERVER ──────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `Server started on port ${PORT}`);
  console.log(`connectTv listening on port ${PORT}`);
});
