// Cloudflare Pages Function
// Endpoint: POST /api/poukaz
// Objednávka dárkového poukazu z úvodní stránky: pošle e-mail majiteli přes Resend.
//
// Env variables (stejné jako u /api/rezervace):
//   RESEND_API_KEY, MAIL_FROM, MAIL_TO

const TYPES = {
  interier: 'Hloubkové čištění interiéru, 3 000 Kč',
  vstupni: 'Vstupní poukaz, 1 500 Kč',
  castka: 'Poukaz na libovolnou částku (od 1 000 Kč)',
};

const recentSubmits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 3;

export async function onRequestPost(context) {
  const { request, env } = context;
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

  try {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM || !env.MAIL_TO) {
      console.error('Missing env vars');
      return json({ ok: false, error: 'config' }, 500, headers);
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const list = (recentSubmits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_MAX) return json({ ok: false, error: 'rate_limit' }, 429, headers);

    const body = await readBody(request);
    if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid_body' }, 400, headers);

    // Honeypot: bot si myslí, že prošel
    if (body.website) return json({ ok: true }, 200, headers);

    const typ = sanitize(body.typ);
    const castka = Number(String(body.castka || '').replace(/\s/g, ''));
    const name = sanitize(body.name);
    const email = sanitize(body.email);
    const phone = sanitize(body.phone);
    const zdroj = sanitize(body.zdroj);
    const note = sanitize(body.note);

    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (
      !TYPES[typ] ||
      (typ === 'castka' && !(castka >= 1000 && castka <= 100000)) ||
      name.length < 2 ||
      !emailOk ||
      phone.replace(/\D/g, '').length < 9
    ) {
      return json({ ok: false, error: 'validation' }, 400, headers);
    }

    const record = { typ, castka: typ === 'castka' ? castka : null, name, email, phone, zdroj, note };
    const resp = await sendEmail(env, record);
    if (!resp || !resp.ok) {
      console.error('Resend error:', resp && resp.status, resp ? await resp.text() : 'no response');
      return json({ ok: false, error: 'send_failed' }, 502, headers);
    }

    list.push(now);
    recentSubmits.set(ip, list);
    return json({ ok: true }, 200, headers);
  } catch (e) {
    console.error('Unhandled:', e);
    return json({ ok: false, error: 'server' }, 500, headers);
  }
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers });
}

async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return request.json().catch(() => null);
  try {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch (e) {
    return null;
  }
}

function sanitize(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 2000);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function rows(r) {
  return [
    ['Poukaz', TYPES[r.typ] + (r.castka ? `: ${r.castka} Kč` : '')],
    ['Jméno', r.name],
    ['E-mail', r.email],
    ['Telefon', r.phone],
    r.zdroj ? ['Odkud se dozvěděl/a', r.zdroj] : null,
    r.note ? ['Poznámka', r.note] : null,
  ].filter(Boolean);
}

function sendEmail(env, r) {
  const data = rows(r);
  const text = ['Nová objednávka poukazu', '', ...data.map(([k, v]) => `${k}: ${v}`), '', 'Pošli platební údaje a po připsání platby PDF poukaz.'].join('\n');
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18191b">' +
    '<h1 style="font-size:20px;margin:0 0 16px">Nová objednávka poukazu</h1>' +
    '<table style="border-collapse:collapse;width:100%">' +
    data.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #ddd;color:#57595e;width:38%">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #ddd">${esc(v)}</td></tr>`).join('') +
    '</table><p style="margin-top:20px;color:#57595e;font-size:14px">Pošli platební údaje a po připsání platby PDF poukaz.</p></div>';

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [env.MAIL_TO],
      reply_to: r.email,
      subject: `Objednávka poukazu: ${r.name}`,
      html,
      text,
      tags: [{ name: 'source', value: 'web-poukaz' }],
    }),
  });
}
