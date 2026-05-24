const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

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

    // type === 'invite': run all generations in parallel
    const { name, activity, date, note } = body;
    if (!name || !activity || !date) {
      return respond(400, { error: 'name, activity, and date are required' });
    }

    const [[message, usedProvider], mascotIntro, buttonAnimCSS, confettiCSS] = await Promise.all([
      generateInviteMessage(name, activity, date, note),
      generateMascotIntro(name, activity),
      generateButtonAnimCSS(activity),
      generateConfettiCSS(activity),
    ]);

    return respond(200, {
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

// ── No button CSS escape animation ───────────────────────────────────────────

async function generateButtonAnimCSS(activity) {
  const prompt = `Write a CSS @keyframes block named "noEscape" for a button that playfully dodges clicks, themed for "${activity}".
- Use only transform properties (translate, rotate, scale)
- 4-5 keyframe stops
- Lively and fun, matches the activity energy
- STRICT 220 character limit
- Return ONLY the @keyframes block, nothing else`;

  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  });
  return stripFences(res.content[0].text.trim());
}

// ── Confetti celebration CSS ──────────────────────────────────────────────────

async function generateConfettiCSS(activity) {
  const prompt = `Write a CSS @keyframes block named "confettiFall" for celebration confetti, themed for "${activity}".
- Animate: translateY from -20px to 110vh, rotation, slight horizontal sway
- End with opacity: 0
- STRICT 220 character limit
- Return ONLY the @keyframes block, nothing else`;

  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    messages: [{ role: 'user', content: prompt }],
  });
  return stripFences(res.content[0].text.trim());
}

// ── AI helpers ────────────────────────────────────────────────────────────────

async function generateMascotLine(prompt) {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    system: MASCOT_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
}

async function generateWithClaude(prompt) {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content[0].text.trim();
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

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}
