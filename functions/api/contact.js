// Cloudflare Pages Function
// Endpoint: POST /api/contact
// Posílá email z kontaktního formuláře osobního čištění (index.html)
//
// Env variables (nastav v CF Pages → Settings → Environment variables):
//   RESEND_API_KEY  - tvůj Resend API klíč (Encrypt = ON)
//   MAIL_FROM       - adresa odesílatele, např. "Web <web@expressdetailing.cz>"
//                     (doména musí být verifikovaná v Resendu)
//   MAIL_TO         - kam mají poptávky chodit, např. "expressdetail.litomysl@gmail.com"

const BRAND = {
  name: 'Express Detailing Litomyšl',
  accent: '#4d8cff',       // modrá z indexu
  accentSoft: 'rgba(77, 140, 255, 0.12)',
  bg: '#0a1628',
  bgCard: '#0f2240',
  text: '#ffffff',
  textMuted: '#c9d3e3',
  border: 'rgba(255,255,255,0.08)',
};

// Jednoduchý in-memory rate limit per IP (po deploy je per-instance, takže není железna,
// ale ořeže nejhrubší bursty). Pro tvrdší limit použij Cloudflare Turnstile nebo Rate Limiting.
const recentSubmits = new Map();
const RATE_WINDOW_MS = 60_000; // 1 minuta
const RATE_MAX = 3;            // max 3 odeslání za minutu z jedné IP

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS / metody
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  try {
    // 1) Validace prostředí
    if (!env.RESEND_API_KEY || !env.MAIL_FROM || !env.MAIL_TO) {
      console.error('Missing env vars');
      return new Response(JSON.stringify({ ok: false, error: 'config' }), { status: 500, headers });
    }

    // 2) Rate limit per IP
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const list = (recentSubmits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_MAX) {
      return new Response(JSON.stringify({ ok: false, error: 'rate_limit' }), { status: 429, headers });
    }

    // 3) Parsing
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_body' }), { status: 400, headers });
    }

    // 4) Validace polí (musí sednout s formulářem v index.html)
    const name = sanitize(body.name);
    const phone = sanitize(body.phone);
    const email = sanitize(body.email);
    const cartype = sanitize(body.cartype);
    const message = sanitize(body.message);
    const consent = body.consent === true;

    if (name.length < 2 || phone.replace(/\s/g, '').length < 9 || !isEmail(email) || !consent) {
      return new Response(JSON.stringify({ ok: false, error: 'validation' }), { status: 400, headers });
    }

    // 5) Honeypot (pokud bys ho přidal do formuláře jako "website")
    if (body.website) {
      // Tichý úspěch - bot si myslí, že prošel
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    // 6) Sestavení emailu
    const subject = `Nová poptávka z webu - ${name}`;
    const html = renderHtmlEmail({ name, phone, email, cartype, message });
    const text = renderTextEmail({ name, phone, email, cartype, message });

    // 7) Odeslání přes Resend HTTP API
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        reply_to: email,
        subject,
        html,
        text,
        tags: [{ name: 'source', value: 'web-osobni' }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Resend error:', resp.status, err);
      return new Response(JSON.stringify({ ok: false, error: 'send_failed' }), { status: 502, headers });
    }

    // Zaznamenat úspěšné odeslání do rate limitu
    list.push(now);
    recentSubmits.set(ip, list);

    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch (e) {
    console.error('Unhandled:', e);
    return new Response(JSON.stringify({ ok: false, error: 'server' }), { status: 500, headers });
  }
}

// ---- Helpers ----

function sanitize(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 2000);
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtmlEmail({ name, phone, email, cartype, message }) {
  const e = escapeHtml;
  const rows = [
    ['Jméno', e(name)],
    ['Telefon', `<a href="tel:${e(phone)}" style="color:${BRAND.accent};text-decoration:none">${e(phone)}</a>`],
    ['Email', `<a href="mailto:${e(email)}" style="color:${BRAND.accent};text-decoration:none">${e(email)}</a>`],
    cartype ? ['Typ vozu', e(cartype)] : null,
    message ? ['Zpráva', e(message).replace(/\n/g, '<br>')] : null,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nová poptávka</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${BRAND.text};">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="display:inline-block;padding:6px 14px;background:${BRAND.accentSoft};border:1px solid ${BRAND.accent};border-radius:999px;color:${BRAND.accent};font-size:12px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">
        Nová poptávka
      </div>
    </div>

    <h1 style="margin:0 0 8px;font-size:24px;font-weight:600;text-align:center;color:${BRAND.text};">
      Někdo poptává čištění interiéru
    </h1>
    <p style="margin:0 0 28px;text-align:center;color:${BRAND.textMuted};font-size:15px;">
      Poptávka přišla z hlavní stránky <strong style="color:${BRAND.text};">${BRAND.name}</strong>.
    </p>

    <div style="background:${BRAND.bgCard};border:1px solid ${BRAND.border};border-radius:14px;padding:24px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        ${rows
          .map(
            ([k, v]) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.textMuted};font-size:13px;text-transform:uppercase;letter-spacing:0.06em;width:140px;vertical-align:top;">${k}</td>
          <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.text};font-size:15px;vertical-align:top;">${v}</td>
        </tr>`,
          )
          .join('')}
      </table>
    </div>

    <div style="margin-top:24px;text-align:center;">
      <a href="tel:${escapeHtml(phone)}" style="display:inline-block;padding:12px 22px;background:${BRAND.accent};color:#0a1628;text-decoration:none;border-radius:999px;font-weight:600;font-size:15px;">
        Zavolat zákazníkovi
      </a>
    </div>

    <p style="margin:36px 0 0;text-align:center;color:${BRAND.textMuted};font-size:12px;opacity:0.7;">
      Odpovědí na tento email napíšeš přímo zákazníkovi.<br>
      Email odeslán automaticky z formuláře na expressdetailing.cz
    </p>
  </div>
</body>
</html>`;
}

function renderTextEmail({ name, phone, email, cartype, message }) {
  return [
    `NOVÁ POPTÁVKA Z WEBU - ${BRAND.name}`,
    '',
    `Jméno: ${name}`,
    `Telefon: ${phone}`,
    `Email: ${email}`,
    cartype ? `Typ vozu: ${cartype}` : null,
    message ? `\nZpráva:\n${message}` : null,
    '',
    '---',
    'Odpovědí na tento email napíšeš přímo zákazníkovi.',
  ]
    .filter(Boolean)
    .join('\n');
}

// Volitelně: handler pro non-POST metody, ať vrátí 405
export const onRequest = async (context) => {
  if (context.request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  return onRequestPost(context);
};
