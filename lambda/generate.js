const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const MASCOT_SYSTEM =
  'You are a mischievous, playful, cute, and slightly flirty little mascot for a date invitation app. ' +
  'Your personality is like a witty, cheeky kid — bubbly, teasing, a tiny bit dramatic, and irresistibly charming. ' +
  'Keep every response very short (max 10 words + 1 emoji). Output only the text, no quotes.';

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
    const { name, activity, date, note, provider } = body;
    if (!name || !activity || !date) {
      return respond(400, { error: 'name, activity, and date are required' });
    }

    const [message, mascotIntro, svgMascot, buttonAnimCSS, confettiCSS] = await Promise.all([
      generateInviteMessage(name, activity, date, note, provider),
      generateMascotIntro(name, activity),
      generateSvgMascot(activity),
      generateButtonAnimCSS(activity),
      generateConfettiCSS(activity),
    ]);

    return respond(200, {
      message,
      mascotIntro,
      svgMascot,
      buttonAnimCSS,
      confettiCSS,
      provider: provider === 'openai' ? 'openai' : 'claude',
    });
  } catch (err) {
    console.error(err);
    return respond(500, { error: 'Something went wrong. Please try again.' });
  }
};

// ── Invite message ────────────────────────────────────────────────────────────

async function generateInviteMessage(name, activity, date, note, provider) {
  const prompt = `Create a sweet, playful date invitation message (2-3 sentences) for:
- Recipient: ${name}
- Activity: ${activity}
- Date/time: ${date}
${note ? `- Personal note: ${note}` : ''}
Write only the invitation body — no greeting, no sign-off, no quotes. Warm, charming, ends with excitement.`;

  return provider === 'openai'
    ? generateWithOpenAI(prompt)
    : generateWithClaude(prompt);
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

// ── SVG mascot (replaces GIF) ─────────────────────────────────────────────────

async function generateSvgMascot(activity) {
  const prompt = `Create a compact animated SVG mascot face themed for a "${activity}" date.
Requirements:
- viewBox="0 0 100 100" attribute, no width/height
- Basic shapes only: circle, ellipse, rect, simple path
- One <style> block with a single @keyframes named "mascotAnim" (wiggle or blink)
- Apply the animation to the face group using class="face"
- Cute, expressive, round face
- STRICT 550 character total limit
- Output ONLY the SVG element starting with <svg. No XML declaration, no comments.`;

  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return sanitizeSvg(res.content[0].text.trim());
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
