// Cloudflare Pages Function
// Endpoint: POST /api/rezervace
// Zpracovává rezervaci z rezervace.html — uloží do Supabase a pošle email přes Resend
//
// Env variables (nastav v CF Pages → Settings → Environment variables):
//   RESEND_API_KEY              - Resend API klíč (stejný jako pro /api/firemni-poptavka)
//   MAIL_FROM                   - adresa odesílatele, např. "Web <web@expressdetailing.cz>"
//   MAIL_TO                     - kam mají rezervace chodit
//   SUPABASE_URL                - Supabase → Settings → API → Project URL
//   SUPABASE_SERVICE_ROLE_KEY   - Supabase → Settings → API → service_role key (Encrypt = ON)

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

const SERVICE_LABELS = {
  interier: 'Detailing interiéru (od 3 000 Kč)',
};

const VALID_SERVICES = ['interier'];

// Jednoduchý in-memory rate limit per IP (po deploy je per-instance, takže není železná,
// ale ořeže nejhrubší bursty). Pro tvrdší limit použij Cloudflare Turnstile nebo Rate Limiting.
const recentSubmits = new Map();
const RATE_WINDOW_MS = 60_000; // 1 minuta
const RATE_MAX = 3;            // max 3 odeslání za minutu z jedné IP

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  try {
    // 1) Validace prostředí (pro email; Supabase je volitelná, výpadek nesmí shodit email)
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

    // 4) Honeypot — tichý úspěch, bot si myslí, že prošel
    if (body.website) {
      return new Response(JSON.stringify({ ok: true }), { headers });
    }

    // 5) Validace polí (musí sednout s formulářem v rezervace.html)
    const name = sanitize(body.name);
    const phone = sanitize(body.phone);
    const city = sanitize(body.city);
    const car = sanitize(body.car);
    const service = sanitize(body.service);
    const preferred_date = sanitize(body.preferred_date);
    const concerns = sanitize(body.concerns); // nepovinné

    if (
      name.length < 2 ||
      phone.replace(/\D/g, '').length < 9 ||
      !city ||
      !car ||
      !preferred_date ||
      !VALID_SERVICES.includes(service)
    ) {
      return new Response(JSON.stringify({ ok: false, error: 'validation' }), { status: 400, headers });
    }

    const record = { name, phone, city, car, service, preferred_date, concerns };

    // 6) Paralelně: zápis do Supabase + odeslání emailu.
    //    Supabase si chyby ošetří uvnitř (nesmí shodit email).
    const [, emailResp] = await Promise.all([
      supabaseInsert(env, record),
      sendEmail(env, record),
    ]);

    // 7) Když email selže, vracíme 502 (Supabase už proběhl/selhal samostatně)
    if (!emailResp || !emailResp.ok) {
      const err = emailResp ? await emailResp.text() : 'no response';
      console.error('Resend error:', emailResp && emailResp.status, err);
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

// ---- Supabase ----

// Vrací vždy splněný Promise — případnou chybu jen zaloguje, aby email odešel i tak.
async function supabaseInsert(env, record) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Supabase env vars missing — přeskakuji INSERT');
    return null;
  }
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/bookings`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        name: record.name,
        phone: record.phone,
        city: record.city,
        car: record.car,
        service: record.service,
        preferred_date: record.preferred_date,
        note: record.concerns || null,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('Supabase insert failed:', resp.status, err);
    }
    return resp;
  } catch (e) {
    console.error('Supabase insert error:', e);
    return null;
  }
}

// ---- Email (Resend) ----

function sendEmail(env, record) {
  const subject = `Nová rezervace — ${record.name}, ${record.car}`;
  const html = renderHtmlEmail(record);
  const text = renderTextEmail(record);

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [env.MAIL_TO],
      subject,
      html,
      text,
      tags: [{ name: 'source', value: 'web-rezervace' }],
    }),
  });
}

// ---- Helpers ----

function sanitize(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 2000);
}

function serviceLabel(service) {
  return SERVICE_LABELS[service] || service;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtmlEmail({ name, phone, city, car, service, preferred_date, concerns }) {
  const e = escapeHtml;
  const rows = [
    ['Jméno', e(name)],
    ['Telefon', `<a href="tel:${e(phone)}" style="color:${BRAND.accent};text-decoration:none">${e(phone)}</a>`],
    ['Město', e(city)],
    ['Auto', e(car)],
    ['Služba', e(serviceLabel(service))],
    ['Termín', e(preferred_date)],
    concerns ? ['Co trápí', e(concerns)] : null,
  ].filter(Boolean);

  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nová rezervace</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${BRAND.text};">
  <div style="max-width:600px;margin:0 auto;padding:32px 20px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="display:inline-block;padding:6px 14px;background:${BRAND.accentSoft};border:1px solid ${BRAND.accent};border-radius:999px;color:${BRAND.accent};font-size:12px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;">
        Nová rezervace
      </div>
    </div>

    <h1 style="margin:0 0 8px;font-size:24px;font-weight:600;text-align:center;color:${BRAND.text};">
      Nová online rezervace termínu
    </h1>
    <p style="margin:0 0 28px;text-align:center;color:${BRAND.textMuted};font-size:15px;">
      Rezervace přišla z webu <strong style="color:${BRAND.text};">${BRAND.name}</strong>.
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
      Potvrď termín telefonicky se zákazníkem.<br>
      Email odeslán automaticky z rezervačního formuláře na expressdetailing.cz
    </p>
  </div>
</body>
</html>`;
}

function renderTextEmail({ name, phone, city, car, service, preferred_date, concerns }) {
  return [
    `NOVÁ REZERVACE Z WEBU - ${BRAND.name}`,
    '',
    `Jméno: ${name}`,
    `Telefon: ${phone}`,
    `Město: ${city}`,
    `Auto: ${car}`,
    `Služba: ${serviceLabel(service)}`,
    `Termín: ${preferred_date}`,
    concerns ? `Co trápí: ${concerns}` : null,
    '',
    '---',
    'Potvrď termín telefonicky se zákazníkem.',
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
