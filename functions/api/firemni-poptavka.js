// Cloudflare Pages Function
// Endpoint: POST /api/firemni-poptavka
// Posílá email z firemního formuláře (pro-firmy.html)
//
// Env variables (nastav v CF Pages → Settings → Environment variables):
//   RESEND_API_KEY  - tvůj Resend API klíč (Encrypt = ON, stejný jako pro /api/rezervace)
//   MAIL_FROM       - adresa odesílatele, např. "Web firemní <firmy@expressdetailing.cz>"
//                     (doména musí být verifikovaná v Resendu)
//   MAIL_TO         - kam mají poptávky chodit, např. "expressdetail.litomysl@gmail.com"

const BRAND = {
  name: 'Express Detailing - Pro firmy',
  accent: '#e3122d',          // červená z firemní stránky
  accentSoft: 'rgba(227, 18, 45, 0.12)',
  bg: '#0a0a0c',
  bgCard: '#131315',
  text: '#ffffff',
  textMuted: '#d4d4d8',
  border: 'rgba(255,255,255,0.08)',
};

const recentSubmits = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 3;

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  try {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM || !env.MAIL_TO) {
      console.error('Missing env vars');
      return new Response(JSON.stringify({ ok: false, error: 'config' }), { status: 500, headers });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    const list = (recentSubmits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= RATE_MAX) {
      return new Response(JSON.stringify({ ok: false, error: 'rate_limit' }), { status: 429, headers });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return new Response(JSON.stringify({ ok: false, error: 'invalid_body' }), { status: 400, headers });
    }

    // Honeypot z firemního formuláře
    if (body.website) {
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    // Validace polí (musí sednout s formulářem ve firemni-cisteni.html)
    const company = sanitize(body.company);
    const ico = sanitize(body.ico);
    const name = sanitize(body.name);
    const phone = sanitize(body.phone);
    const email = sanitize(body.email);
    const fleetsize = sanitize(body.fleetsize);
    const service = sanitize(body.service);
    const location = sanitize(body.location);
    const message = sanitize(body.message);
    const consent = body.consent === true;

    if (
      company.length < 2 ||
      name.length < 2 ||
      phone.replace(/\D/g, '').length < 9 ||
      (email && !isEmail(email)) ||
      !consent
    ) {
      return new Response(JSON.stringify({ ok: false, error: 'validation' }), { status: 400, headers });
    }

    const subject = `Firemní poptávka - ${company}${fleetsize ? ` (${fleetsize})` : ''}`;
    const html = renderHtmlEmail({ company, ico, name, phone, email, fleetsize, service, location, message });
    const text = renderTextEmail({ company, ico, name, phone, email, fleetsize, service, location, message });

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        ...(email ? { reply_to: email } : {}),
        subject,
        html,
        text,
        tags: [{ name: 'source', value: 'web-firemni' }],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('Resend error:', resp.status, err);
      return new Response(JSON.stringify({ ok: false, error: 'send_failed' }), { status: 502, headers });
    }

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

function renderHtmlEmail({ company, ico, name, phone, email, fleetsize, service, location, message }) {
  const e = escapeHtml;

  const contactRows = [
    ['Kontaktní osoba', e(name)],
    ['Telefon', `<a href="tel:${e(phone)}" style="color:${BRAND.accent};text-decoration:none">${e(phone)}</a>`],
    email ? ['Email', `<a href="mailto:${e(email)}" style="color:${BRAND.accent};text-decoration:none">${e(email)}</a>`] : null,
  ].filter(Boolean);

  const companyRows = [
    ['Firma', e(company)],
    ico ? ['IČO', e(ico)] : null,
  ].filter(Boolean);

  const detailRows = [
    fleetsize ? ['Velikost flotily', e(fleetsize)] : null,
    service ? ['Zájem o službu', e(service)] : null,
    location ? ['Lokalita', e(location)] : null,
    message ? ['Zpráva', e(message).replace(/\n/g, '<br>')] : null,
  ].filter(Boolean);

  const renderTable = (rows) => `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      ${rows
        .map(
          ([k, v]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.textMuted};font-size:13px;text-transform:uppercase;letter-spacing:0.06em;width:160px;vertical-align:top;">${k}</td>
        <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};color:${BRAND.text};font-size:15px;vertical-align:top;">${v}</td>
      </tr>`,
        )
        .join('')}
    </table>`;

  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Firemní poptávka</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${BRAND.text};">
  <div style="max-width:620px;margin:0 auto;padding:32px 20px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="display:inline-block;padding:6px 14px;background:${BRAND.accentSoft};border:1px solid ${BRAND.accent};border-radius:999px;color:${BRAND.accent};font-size:12px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">
        Firemní poptávka
      </div>
    </div>

    <h1 style="margin:0 0 8px;font-size:24px;font-weight:600;text-align:center;color:${BRAND.text};">
      Nová poptávka od firmy ${e(company)}
    </h1>
    <p style="margin:0 0 28px;text-align:center;color:${BRAND.textMuted};font-size:15px;">
      Přišla z firemní stránky <strong style="color:${BRAND.text};">${BRAND.name}</strong>.
    </p>

    <div style="background:${BRAND.bgCard};border:1px solid ${BRAND.border};border-radius:14px;padding:24px 28px;margin-bottom:16px;">
      <div style="color:${BRAND.accent};font-size:12px;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin-bottom:10px;">Firma</div>
      ${renderTable(companyRows)}
    </div>

    <div style="background:${BRAND.bgCard};border:1px solid ${BRAND.border};border-radius:14px;padding:24px 28px;margin-bottom:16px;">
      <div style="color:${BRAND.accent};font-size:12px;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin-bottom:10px;">Kontakt</div>
      ${renderTable(contactRows)}
    </div>

    ${
      detailRows.length
        ? `
    <div style="background:${BRAND.bgCard};border:1px solid ${BRAND.border};border-radius:14px;padding:24px 28px;">
      <div style="color:${BRAND.accent};font-size:12px;text-transform:uppercase;letter-spacing:0.1em;font-weight:600;margin-bottom:10px;">Detaily poptávky</div>
      ${renderTable(detailRows)}
    </div>`
        : ''
    }

    <div style="margin-top:24px;text-align:center;">
      <a href="tel:${e(phone)}" style="display:inline-block;padding:12px 22px;background:${BRAND.accent};color:#ffffff;text-decoration:none;border-radius:999px;font-weight:600;font-size:15px;">
        Zavolat do firmy
      </a>
    </div>

    <p style="margin:36px 0 0;text-align:center;color:${BRAND.textMuted};font-size:12px;opacity:0.7;">
      Odpovědí na tento email napíšeš přímo kontaktní osobě.<br>
      Email odeslán automaticky z firemního formuláře na expressdetailing.cz
    </p>
  </div>
</body>
</html>`;
}

function renderTextEmail({ company, ico, name, phone, email, fleetsize, service, location, message }) {
  return [
    `FIREMNÍ POPTÁVKA - ${BRAND.name}`,
    '',
    '== FIRMA ==',
    `Firma: ${company}`,
    ico ? `IČO: ${ico}` : null,
    '',
    '== KONTAKT ==',
    `Kontaktní osoba: ${name}`,
    `Telefon: ${phone}`,
    email ? `Email: ${email}` : null,
    '',
    '== DETAILY ==',
    fleetsize ? `Velikost flotily: ${fleetsize}` : null,
    service ? `Zájem o službu: ${service}` : null,
    location ? `Lokalita: ${location}` : null,
    message ? `\nZpráva:\n${message}` : null,
    '',
    '---',
    'Odpovědí na tento email napíšeš přímo kontaktní osobě.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const onRequest = async (context) => {
  if (context.request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  }
  return onRequestPost(context);
};
