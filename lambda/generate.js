const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const OpenAI = require('openai');
const crypto = require('crypto');
const https = require('https');

const BEDROCK_REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'ap-northeast-1';
const CLAUDE_MODEL_ID =
  process.env.BEDROCK_CLAUDE_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });
const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION || 'ap-northeast-1',
}));
const INVITE_TABLE_NAME = process.env.INVITE_TABLE_NAME;
const ACCEPTANCE_LOCK_SECONDS = Math.max(1, Number(process.env.ACCEPTANCE_LOCK_SECONDS || 60) || 60);
const ANONYMOUS_INVITE_DAILY_LIMIT = Math.max(1, Number(process.env.ANONYMOUS_INVITE_DAILY_LIMIT || 3) || 3);
const ANONYMOUS_RATE_LIMIT_SALT = process.env.ANONYMOUS_RATE_LIMIT_SALT || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
const TURNSTILE_ACTION = 'generate_invite';
const TURNSTILE_EXPECTED_HOSTNAMES = new Set(
  String(process.env.TURNSTILE_EXPECTED_HOSTNAMES || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean),
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const MASCOT_SYSTEM =
  'You are a mischievous, playful, cute, and witty little mascot for a date invitation app. ' +
  'Your personality is like a cheeky kid — bubbly, teasing, a tiny bit dramatic, and charming. ' +
  'Keep every response very short (max 10 words). No heart or love emojis. Output only the text, no quotes.';

exports.handler = async (event) => {
  const method = event.httpMethod || event.requestContext?.http?.method || '';
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const type = body.type || 'invite';

    if (type === 'reaction') {
      const reaction = await generateReaction();
      return respond(200, { reaction });
    }

    if (type === 'acceptInvite') {
      try {
        const result = await acceptInvite(body.inviteId);
        return respond(result.statusCode || 200, result.body);
      } catch (err) {
        console.error('acceptInvite failed:', err);
        return respond(500, {
          ok: false,
          error: err.message || 'Failed to send calendar invite',
        });
      }
    }

    if (type === 'getInvite') {
      const result = await getPublicInvite(body.inviteId);
      return respond(result.statusCode, result.body);
    }

    // type === 'invite': run all generations in parallel
    const { senderEmail, timezone, name, activity, date, note } = body;
    if (!senderEmail || !name || !activity || !date) {
      return respond(400, { error: 'senderEmail, name, activity, and date are required' });
    }
    const notificationEmail = normalizeEmail(senderEmail);
    if (!isValidEmail(notificationEmail)) {
      return respond(400, { error: 'senderEmail must be a valid email address' });
    }
    const verification = await verifyTurnstile(body.turnstileToken, event);
    if (!verification.success) {
      return respond(verification.statusCode, { error: verification.message });
    }
    requireInviteTable();
    const allowance = await reserveAnonymousInviteAllowance(event, notificationEmail);
    if (!allowance.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((new Date(allowance.retryAfter).getTime() - Date.now()) / 1000),
      );
      return respond(429, {
        error: `Daily invite limit reached. You can generate up to ${ANONYMOUS_INVITE_DAILY_LIMIT} invites per day.`,
        retryAfter: allowance.retryAfter,
      }, { 'Retry-After': String(retryAfterSeconds) });
    }

    const [[message, usedProvider], mascotIntro, buttonAnimCSS, confettiCSS] = await Promise.all([
      generateInviteMessage(name, activity, date, note),
      generateMascotIntro(name, activity),
      generateButtonAnimCSS(activity),
      generateConfettiCSS(activity),
    ]);

    const inviteId = crypto.randomUUID();
    await dynamodb.send(new PutCommand({
      TableName: INVITE_TABLE_NAME,
      Item: {
        inviteId,
        senderEmail: notificationEmail,
        recipientName: name,
        activity,
        date,
        timezone: timezone || 'UTC',
        message,
        mascotIntro,
        buttonAnimCSS,
        confettiCSS,
        status: 'CREATED',
        createdAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(inviteId)',
    }));

    return respond(200, {
      inviteId,
      message,
      mascotIntro,
      buttonAnimCSS,
      confettiCSS,
      provider: usedProvider,
    });
  } catch (err) {
    console.error(err);
    return respond(500, { error: 'Something went wrong. Please try again.' });
  }
};

// ── Stored invitations ─────────────────────────────────────────────────────────

function requireInviteTable() {
  if (!INVITE_TABLE_NAME) {
    throw new Error('INVITE_TABLE_NAME env var is not configured');
  }
}

async function loadInvite(inviteId) {
  if (!inviteId) return null;
  requireInviteTable();
  const result = await dynamodb.send(new GetCommand({
    TableName: INVITE_TABLE_NAME,
    Key: { inviteId },
  }));
  return result.Item || null;
}

async function verifyTurnstile(token, event) {
  if (!TURNSTILE_SECRET_KEY) {
    console.error('TURNSTILE_SECRET_KEY is not configured; public invite generation is disabled');
    return { success: false, statusCode: 503, message: 'Human verification is not configured.' };
  }
  if (!token || typeof token !== 'string' || token.length > 2048) {
    return { success: false, statusCode: 400, message: 'Please complete the human verification challenge.' };
  }

  const params = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: token,
    remoteip: sourceIpForEvent(event),
    idempotency_key: crypto.randomUUID(),
  });
  const response = await httpsRequest({
    hostname: 'challenges.cloudflare.com',
    path: '/turnstile/v0/siteverify',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params.toString()),
    },
  }, params.toString());

  let validation;
  try {
    validation = JSON.parse(response.body);
  } catch {
    validation = { success: false, 'error-codes': ['invalid-siteverify-response'] };
  }
  if (response.statusCode < 200 || response.statusCode >= 300 || !validation.success) {
    console.warn('Turnstile validation rejected:', validation['error-codes'] || response.statusCode);
    return { success: false, statusCode: 400, message: 'Human verification failed. Please try again.' };
  }
  if (validation.action !== TURNSTILE_ACTION) {
    console.warn('Turnstile action mismatch:', validation.action);
    return { success: false, statusCode: 400, message: 'Human verification failed. Please try again.' };
  }
  if (TURNSTILE_EXPECTED_HOSTNAMES.size > 0 &&
      !TURNSTILE_EXPECTED_HOSTNAMES.has(String(validation.hostname || '').toLowerCase())) {
    console.warn('Turnstile hostname mismatch:', validation.hostname);
    return { success: false, statusCode: 400, message: 'Human verification failed. Please try again.' };
  }
  return { success: true };
}

async function reserveAnonymousInviteAllowance(event, notificationEmail) {
  const sourceIp = sourceIpForEvent(event);
  const now = new Date();
  const windowDate = now.toISOString().slice(0, 10);
  const nextWindow = new Date(`${windowDate}T00:00:00.000Z`);
  nextWindow.setUTCDate(nextWindow.getUTCDate() + 1);
  const expiresAt = Math.floor(nextWindow.getTime() / 1000) + 86400;
  const sourceFingerprint = anonymousClientFingerprint(`source-ip:${sourceIp}`);
  const emailFingerprint = anonymousClientFingerprint(`notification-email:${notificationEmail}`);

  try {
    await dynamodb.send(new TransactWriteCommand({
      TransactItems: [
        inviteAllowanceCounterUpdate(`RATE#SOURCE_IP#${windowDate}#${sourceFingerprint}`, windowDate, expiresAt, now),
        inviteAllowanceCounterUpdate(`RATE#NOTIFICATION_EMAIL#${windowDate}#${emailFingerprint}`, windowDate, expiresAt, now),
      ],
    }));
    return { allowed: true };
  } catch (err) {
    if (err.name !== 'TransactionCanceledException') throw err;
    return { allowed: false, retryAfter: nextWindow.toISOString() };
  }
}

function sourceIpForEvent(event) {
  return event.requestContext?.http?.sourceIp ||
    event.requestContext?.identity?.sourceIp ||
    'unidentified-client';
}

function inviteAllowanceCounterUpdate(inviteId, windowDate, expiresAt, now) {
  return {
    Update: {
      TableName: INVITE_TABLE_NAME,
      Key: { inviteId },
      UpdateExpression:
        'SET recordType = :recordType, windowDate = :windowDate, expiresAt = :expiresAt, updatedAt = :updatedAt ADD requestCount :one',
      ConditionExpression: 'attribute_not_exists(requestCount) OR requestCount < :limit',
      ExpressionAttributeValues: {
        ':recordType': 'ANONYMOUS_INVITE_DAILY_LIMIT',
        ':windowDate': windowDate,
        ':expiresAt': expiresAt,
        ':updatedAt': now.toISOString(),
        ':one': 1,
        ':limit': ANONYMOUS_INVITE_DAILY_LIMIT,
      },
    },
  };
}

function anonymousClientFingerprint(value) {
  if (ANONYMOUS_RATE_LIMIT_SALT) {
    return crypto.createHmac('sha256', ANONYMOUS_RATE_LIMIT_SALT).update(value).digest('hex');
  }
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function getPublicInvite(inviteId) {
  if (!inviteId) {
    return { statusCode: 400, body: { error: 'inviteId is required' } };
  }

  const invite = await loadInvite(inviteId);
  if (!invite) {
    return { statusCode: 404, body: { error: 'Invite not found or no longer available.' } };
  }

  return {
    statusCode: 200,
    body: {
      recipientName: invite.recipientName,
      activity: invite.activity,
      date: invite.date,
      message: invite.message,
      mascotIntro: invite.mascotIntro,
      buttonAnimCSS: invite.buttonAnimCSS,
      confettiCSS: invite.confettiCSS,
    },
  };
}

async function acceptInvite(inviteId) {
  if (!inviteId) {
    return { statusCode: 400, body: { ok: false, error: 'inviteId is required' } };
  }

  const invite = await loadInvite(inviteId);
  if (!invite) {
    return { statusCode: 404, body: { ok: false, error: 'Invite not found or no longer available.' } };
  }
  if (invite.status === 'SENT') {
    return { body: { ok: true, alreadySent: true } };
  }

  const now = Math.floor(Date.now() / 1000);
  const lockToken = crypto.randomUUID();
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: INVITE_TABLE_NAME,
      Key: { inviteId },
      UpdateExpression: 'SET #status = :sending, lockUntil = :lockUntil, acceptanceToken = :token',
      ConditionExpression:
        '#status = :created OR #status = :failed OR (#status = :sending AND lockUntil < :now)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':created': 'CREATED',
        ':failed': 'FAILED',
        ':sending': 'SENDING',
        ':now': now,
        ':lockUntil': now + ACCEPTANCE_LOCK_SECONDS,
        ':token': lockToken,
      },
    }));
  } catch (err) {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    const current = await loadInvite(inviteId);
    if (current?.status === 'SENT') {
      return { body: { ok: true, alreadySent: true } };
    }
    return { body: { ok: true, sending: true } };
  }

  let result;
  try {
    result = await sendCalendarInvite(inviteId, invite);
  } catch (err) {
    await markInviteFailed(inviteId, lockToken, err);
    throw err;
  }

  await markInviteSent(inviteId, lockToken);
  return { body: result };
}

async function markInviteSent(inviteId, lockToken) {
  await dynamodb.send(new UpdateCommand({
    TableName: INVITE_TABLE_NAME,
    Key: { inviteId },
    UpdateExpression: 'SET #status = :sent, sentAt = :sentAt REMOVE lockUntil, acceptanceToken',
    ConditionExpression: '#status = :sending AND acceptanceToken = :token',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':sending': 'SENDING',
      ':sent': 'SENT',
      ':sentAt': new Date().toISOString(),
      ':token': lockToken,
    },
  }));
}

async function markInviteFailed(inviteId, lockToken, error) {
  try {
    await dynamodb.send(new UpdateCommand({
      TableName: INVITE_TABLE_NAME,
      Key: { inviteId },
      UpdateExpression: 'SET #status = :failed, failedAt = :failedAt, failureReason = :reason REMOVE lockUntil, acceptanceToken',
      ConditionExpression: '#status = :sending AND acceptanceToken = :token',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':sending': 'SENDING',
        ':failed': 'FAILED',
        ':failedAt': new Date().toISOString(),
        ':reason': String(error.message || error).slice(0, 500),
        ':token': lockToken,
      },
    }));
  } catch (updateError) {
    console.error('Unable to mark failed invite:', updateError);
  }
}

// ── Invite message ────────────────────────────────────────────────────────────

async function generateInviteMessage(name, activity, date, note) {
  const prompt = `Create a sweet, playful date invitation message (2-3 sentences) for:
- Recipient: ${name}
- Activity: ${activity}
- Date/time: ${date}
${note ? `- Personal note: ${note}` : ''}
Write only the invitation body — no greeting, no sign-off, no quotes. Warm, charming, ends with excitement. No heart or love emojis.`;

  try {
    const text = await generateWithOpenAI(prompt);
    return [text, 'openai'];
  } catch (err) {
    console.warn('OpenAI failed, falling back to Claude Haiku:', err.message);
    const text = await generateWithClaude(prompt);
    return [text, 'claude'];
  }
}

// ── Mascot intro line ─────────────────────────────────────────────────────────

async function generateMascotIntro(name, activity) {
  const prompt = `${name} just opened a date invitation for "${activity}". Give them a cheeky, flirty, playful greeting as their mascot. Max 10 words + 1 emoji.`;
  return generateMascotLine(prompt);
}

// ── No button reaction ────────────────────────────────────────────────────────

async function generateReaction() {
  const moods = [
    'surprised and giggling',
    'dramatically heartbroken',
    'smug and knowing',
    'playfully suspicious',
    'encouragingly persistent',
  ];
  const mood = moods[Math.floor(Math.random() * moods.length)];
  const prompt = `Someone tried to click "No" on a date invitation but the button escaped. React in a ${mood} way. Max 8 words + 1 emoji.`;
  return generateMascotLine(prompt);
}

// ── SES calendar invite on Yes ────────────────────────────────────────────────

async function sendCalendarInvite(inviteId, { senderEmail, recipientName, activity, date, timezone, message }) {
  if (!senderEmail || !activity || !date) {
    throw new Error('Stored invite is missing senderEmail, activity, or date');
  }
  if (!isValidEmail(senderEmail)) {
    throw new Error('Stored invite has an invalid sender email address');
  }

  const fromEmail = process.env.SES_FROM_EMAIL;
  const sesRegion = process.env.SES_REGION || process.env.AWS_REGION || 'ap-northeast-1';
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL env var is not configured');
  }

  const tz = timezone || process.env.SES_CALENDAR_TIMEZONE || 'UTC';
  const startDateTime = normalizeLocalDateTime(date);
  const endDateTime = addHoursToLocalDateTime(startDateTime, 1);
  const safeRecipient = recipientName || 'Your guest';
  const uid = `${inviteId}@jaycloud.net`;
  const summary = `${safeRecipient} said yes: ${activity}`;
  const description = [
    `${safeRecipient} accepted your invite.`,
    '',
    `Activity: ${activity}`,
    message ? `Invite message: ${message}` : '',
    '',
    'Sent by Unhinged Calendly.',
  ].filter(Boolean).join('\n');
  const ics = buildCalendarInvite({
    uid,
    summary,
    description,
    startDateTime,
    endDateTime,
    timezone: tz,
    organizerEmail: fromEmail,
    attendeeEmail: senderEmail,
  });

  const rawMessage = buildRawCalendarEmail({
    fromEmail,
    toEmail: senderEmail,
    subject: summary,
    text: `${safeRecipient} said yes to ${activity}.\n\nA calendar invite is attached.`,
    html: `<p><strong>${escapeHtml(safeRecipient)}</strong> said yes to <strong>${escapeHtml(activity)}</strong>.</p><p>A calendar invite is attached.</p>`,
    ics,
  });

  const result = await sendSesRawEmail({
    region: sesRegion,
    fromEmail,
    toEmail: senderEmail,
    rawMessage,
  });

  return { ok: true, messageId: result.SendRawEmailResponse?.SendRawEmailResult?.MessageId || result.messageId };
}

async function sendSesRawEmail({ region, fromEmail, toEmail, rawMessage }) {
  const params = new URLSearchParams({
    Action: 'SendRawEmail',
    Version: '2010-12-01',
    Source: fromEmail,
    'Destinations.member.1': toEmail,
    'RawMessage.Data': Buffer.from(rawMessage, 'utf8').toString('base64'),
  });
  const body = params.toString();
  const host = `email.${region}.amazonaws.com`;
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS credentials are not available to sign SES request');
  }
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/ses/aws4_request`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    Host: host,
    'X-Amz-Date': amzDate,
  };
  if (process.env.AWS_SESSION_TOKEN) {
    headers['X-Amz-Security-Token'] = process.env.AWS_SESSION_TOKEN;
  }

  const signedHeaderNames = Object.keys(headers).map(key => key.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames
    .map(key => `${key}:${headers[Object.keys(headers).find(original => original.toLowerCase() === key)].trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(body, 'hex'),
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest, 'hex'),
  ].join('\n');
  const signingKey = getSignatureKey(process.env.AWS_SECRET_ACCESS_KEY, dateStamp, region, 'ses');
  const signature = hmac(signingKey, stringToSign, 'hex');
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${process.env.AWS_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await httpsRequest({
    hostname: host,
    path: '/',
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`SES HTTP ${response.statusCode}: ${response.body}`);
  }

  return { messageId: extractXmlValue(response.body, 'MessageId') };
}

function buildRawCalendarEmail({ fromEmail, toEmail, subject, text, html, ics }) {
  const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const encodedSubject = encodeMimeHeader(subject);
  const encodedText = wrapBase64(Buffer.from(text, 'utf8').toString('base64'));
  const encodedHtml = wrapBase64(Buffer.from(html, 'utf8').toString('base64'));
  const encodedIcs = wrapBase64(Buffer.from(ics, 'utf8').toString('base64'));

  return [
    `From: "Unhinged Calendly" <${fromEmail}>`,
    `To: ${toEmail}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedHtml,
    '',
    `--${boundary}`,
    'Content-Type: text/calendar; charset=UTF-8; method=REQUEST; name="invite.ics"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="invite.ics"',
    'Content-Class: urn:content-classes:calendarmessage',
    '',
    encodedIcs,
    '',
    `--${boundary}--`,
  ].join('\r\n');
}

function buildCalendarInvite({ uid, summary, description, startDateTime, endDateTime, timezone, organizerEmail, attendeeEmail }) {
  const now = formatIcsUtc(new Date());
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Unhinged Calendly//Invite//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${escapeIcs(uid)}`,
    `DTSTAMP:${now}`,
    `DTSTART;TZID=${escapeIcs(timezone)}:${formatIcsLocal(startDateTime)}`,
    `DTEND;TZID=${escapeIcs(timezone)}:${formatIcsLocal(endDateTime)}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `ORGANIZER;CN=Unhinged Calendly:mailto:${organizerEmail}`,
    `ATTENDEE;CN=You;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeLocalDateTime(value) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return value.slice(0, 16);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid invite date');
  return date.toISOString().slice(0, 16);
}

function addHoursToLocalDateTime(value, hours) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) throw new Error('Invalid local date');
  const [, y, mo, d, h, mi] = match.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h + hours, mi));
  return date.toISOString().slice(0, 16);
}

function formatIcsLocal(value) {
  return value.replace(/[-:]/g, '');
}

function formatIcsUtc(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcs(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function encodeMimeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join('\r\n') || value;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sha256(value, encoding) {
  return crypto.createHash('sha256').update(value, 'utf8').digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function extractXmlValue(xml, tagName) {
  return xml.match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`))?.[1] || null;
}

// ── No button CSS escape animation ───────────────────────────────────────────

async function generateButtonAnimCSS(activity) {
  const prompt = `Write a CSS @keyframes block named "noEscape" for a button that playfully dodges clicks, themed for "${activity}".
- Use only transform properties (translate, rotate, scale)
- 4-5 keyframe stops
- Lively and fun, matches the activity energy
- STRICT 220 character limit
- Return ONLY the @keyframes block, nothing else`;

  return stripFences(await generateWithClaude(prompt, { maxTokens: 128 }));
}

// ── Confetti celebration CSS ──────────────────────────────────────────────────

async function generateConfettiCSS(activity) {
  const prompt = `Write a CSS @keyframes block named "confettiFall" for celebration confetti, themed for "${activity}".
- Animate: translateY from -20px to 110vh, rotation, slight horizontal sway
- End with opacity: 0
- STRICT 220 character limit
- Return ONLY the @keyframes block, nothing else`;

  return stripFences(await generateWithClaude(prompt, { maxTokens: 128 }));
}

// ── AI helpers ────────────────────────────────────────────────────────────────

async function generateMascotLine(prompt) {
  return generateWithClaude(prompt, { maxTokens: 64, system: MASCOT_SYSTEM });
}

async function generateWithClaude(prompt, { maxTokens = 256, system } = {}) {
  const input = {
    modelId: CLAUDE_MODEL_ID,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens },
  };
  if (system) {
    input.system = [{ text: system }];
  }

  const res = await bedrock.send(new ConverseCommand(input));
  const text = res.output?.message?.content?.find(content => content.text)?.text;
  if (!text) {
    throw new Error('Amazon Bedrock returned no text content');
  }
  return text.trim();
}

async function generateWithOpenAI(prompt) {
  const client = new OpenAI();
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0].message.content.trim();
}

function stripFences(text) {
  return text.replace(/^```[\w]*\n?/m, '').replace(/```\s*$/m, '').trim();
}

function sanitizeSvg(svg) {
  return stripFences(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '');
}

function respond(statusCode, body, extraHeaders = {}) {
  return { statusCode, headers: { ...CORS_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}
