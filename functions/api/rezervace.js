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
//   MAPY_API_KEY                - (nepovinné) klíč z developer.mapy.com, převod adresy na polohu
//   BULKGATE_APP_ID             - (nepovinné) BulkGate → Modules & APIs → Simple API → Application ID
//   BULKGATE_APP_TOKEN          - (nepovinné) totéž, Application token (Encrypt = ON)
//   SMS_ENABLED                 - "1" = posílat potvrzovací SMS zákazníkovi. Bez toho se SMS neposílá.
//   SMS_UNICODE                 - "1" = SMS s diakritikou (stojí 2 SMS místo 1)

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
  interier: 'Detailing interiéru (od 2 500 Kč)',
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
    const body = await readBody(request);
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
    const street = sanitize(body.street);   // nepovinné (nový formulář ho vyžaduje)
    const zip = sanitize(body.zip);         // nepovinné
    // Starý formulář posílá preferred_date a concerns hotové, nový je skládá z částí.
    const when = sanitize(body.when);
    const days = sanitize(body.days);
    const exact = sanitize(body.exact_date);
    const dayparts = sanitize(body.dayparts);
    const email = sanitize(body.email).slice(0, 200);
    const car_model = sanitize(body.car_model).slice(0, 120);
    const problems = sanitize(body.problems);
    const note = sanitize(body.concerns);
    const prefDates = exact.split(/,\s*/).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 5);
    const preferred_date =
      sanitize(body.preferred_date) ||
      [when, days || (when ? 'kterýkoli den' : ''), dayparts, prefDates.length ? `konkrétně ${prefDates.map(czDate).join(', ')}` : '']
        .filter(Boolean)
        .join(', ') ||
      'Kdykoli, bez omezení';
    const concerns = [problems, note].filter(Boolean).join('. '); // nepovinné

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

    const record = {
      name, phone, email, city, street, zip, car, car_model, service, preferred_date, concerns, problems, note,
      car_size: carSize(car),
      pref_urgency: when || null,
      pref_days: splitList(days),
      pref_dayparts: splitList(dayparts),
      pref_dates: prefDates,
    };

    // 6) Poloha z adresy (Mapy.com). Když selže, rezervace projde i tak, poloha jen chybí.
    const geo = await geocode(env, record);
    if (geo) Object.assign(record, geo);

    // 7) Paralelně: zápis do Supabase + odeslání emailu.
    //    Supabase si chyby ošetří uvnitř (nesmí shodit email).
    const [saved, emailResp] = await Promise.all([
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

    // 8) Potvrzovací SMS zákazníkovi (jen když je zapnutá). Chyba SMS nesmí shodit rezervaci.
    const smsOk = await sendSms(env, record);
    if (smsOk && saved && saved.id != null) await supabasePatch(env, saved.id, { sms_sent_at: new Date().toISOString() });

    return new Response(JSON.stringify({ ok: true }), { headers });
  } catch (e) {
    console.error('Unhandled:', e);
    return new Response(JSON.stringify({ ok: false, error: 'server' }), { status: 500, headers });
  }
}

// ---- Supabase ----

// Vrací vždy splněný Promise — případnou chybu jen zaloguje, aby email odešel i tak.
// Vrací uložený řádek (kvůli id), nebo null.
async function supabaseInsert(env, record) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Supabase env vars missing — přeskakuji INSERT');
    return null;
  }
  const legacyNote = [record.concerns, addressLine(record) ? `Adresa: ${addressLine(record)}` : ''].filter(Boolean).join(' | ') || null;
  const full = {
    name: record.name,
    phone: record.phone,
    city: record.city,
    car: record.car,
    service: record.service,
    preferred_date: record.preferred_date,
    note: legacyNote,
    street: record.street || null,
    zip: record.zip || null,
    email: record.email || null,
    car_model: record.car_model || null,
    car_size: record.car_size,
    problems: record.problems || null,
    lat: record.lat ?? null,
    lng: record.lng ?? null,
    geocode_label: record.geocode_label || null,
    pref_urgency: record.pref_urgency,
    pref_days: record.pref_days,
    pref_dayparts: record.pref_dayparts,
    pref_dates: record.pref_dates,
    status: 'nova',
    planned_minutes: plannedMinutes(record.car_size),
  };
  // Stará tabulka (před spuštěním SQL migrace) nové sloupce nezná -> druhý pokus jen se starými.
  const legacy = {
    name: full.name, phone: full.phone, city: full.city, car: full.car, service: full.service,
    preferred_date: full.preferred_date, note: legacyNote,
  };
  try {
    for (const row of [full, legacy]) {
      const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/bookings`, {
        method: 'POST',
        headers: supabaseHeaders(env, 'return=representation'),
        body: JSON.stringify(row),
      });
      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        return Array.isArray(data) ? data[0] : data;
      }
      console.error('Supabase insert failed:', resp.status, await resp.text());
      if (resp.status !== 400) return null; // jen chyba sloupců (400) má smysl zkoušet znovu
    }
    return null;
  } catch (e) {
    console.error('Supabase insert error:', e);
    return null;
  }
}

async function supabasePatch(env, id, patch) {
  try {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/bookings?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: supabaseHeaders(env, 'return=minimal'),
      body: JSON.stringify(patch),
    });
    if (!resp.ok) console.error('Supabase patch failed:', resp.status, await resp.text());
  } catch (e) {
    console.error('Supabase patch error:', e);
  }
}

function supabaseHeaders(env, prefer) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: prefer,
  };
}

// ---- Poloha z adresy (Mapy.com Geocoding API) ----
// 1 dotaz = 4 kredity, zdarma je 250 000 kreditů měsíčně (~60 000 adres).

async function geocode(env, { street, zip, city }) {
  if (!env.MAPY_API_KEY || !city) return null;
  const query = [street, [zip, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const url = `https://api.mapy.com/v1/geocode?lang=cs&limit=1&type=regional&query=${encodeURIComponent(query)}&apikey=${encodeURIComponent(env.MAPY_API_KEY)}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) {
      console.error('Mapy geocode failed:', resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    const hit = data && data.items && data.items[0];
    if (!hit || !hit.position) return null;
    return {
      lat: hit.position.lat,
      lng: hit.position.lon,
      geocode_label: [hit.name, hit.location].filter(Boolean).join(', ').slice(0, 300),
    };
  } catch (e) {
    console.error('Mapy geocode error:', e);
    return null;
  }
}

// ---- SMS (BulkGate Simple Transactional API) ----

async function sendSms(env, { phone }) {
  if (env.SMS_ENABLED !== '1' || !env.BULKGATE_APP_ID || !env.BULKGATE_APP_TOKEN) return false;
  const unicode = env.SMS_UNICODE === '1';
  const text = unicode
    ? 'Dobrý den, děkuji za rezervaci čištění interiéru. Ozvu se vám s návrhem přesného termínu. Jan, Express Detailing, 792 302 615'
    : 'Dobry den, dekuji za rezervaci cisteni interieru. Ozvu se vam s navrhem presneho terminu. Jan, Express Detailing, 792 302 615';
  try {
    const resp = await fetch('https://portal.bulkgate.com/api/1.0/simple/transactional', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_id: env.BULKGATE_APP_ID,
        application_token: env.BULKGATE_APP_TOKEN,
        number: phone.replace(/[^\d+]/g, ''),
        country: 'cz',
        text,
        unicode,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      console.error('BulkGate SMS failed:', resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('BulkGate SMS error:', e);
    return false;
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

// Přijme JSON i data z klasického formuláře (multipart / urlencoded).
async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return request.json().catch(() => null);
  try {
    const form = await request.formData();
    const out = {};
    for (const [k, v] of form.entries()) out[k] = k in out ? `${out[k]}, ${v}` : v;
    return out;
  } catch (e) {
    return null;
  }
}

// Velikost auta z textu volby ve formuláři (musí sedět s hodnotami v rezervace.html).
function carSize(car) {
  if (/^Malé/.test(car)) return 'S';
  if (/^Sedan/.test(car)) return 'M';
  if (/^Velké/.test(car)) return 'L';
  if (/^Dodávka/.test(car)) return 'XL';
  return '?';
}

// Odhad délky práce v minutách (bez dojezdu a rezervy). Stejná čísla používá planovac.html.
function plannedMinutes(size) {
  return { S: 180, M: 240, L: 285, XL: 300, '?': 240 }[size] || 240;
}

function splitList(v) {
  return v ? v.split(/,\s*/).filter(Boolean).slice(0, 7) : [];
}

function czDate(iso) {
  const [, m, d] = iso.split('-');
  return `${+d}. ${+m}.`;
}

function sanitize(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 2000);
}

function addressLine({ street, zip, city }) {
  if (!street && !zip) return '';
  return [street, [zip, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
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

function renderHtmlEmail({ name, phone, email, city, street, zip, car, car_model, service, preferred_date, concerns, lat, lng }) {
  const e = escapeHtml;
  const map = lat != null ? ` · <a href="https://mapy.com/s?q=${lat},${lng}" style="color:${BRAND.accent}">mapa</a>` : '';
  const rows = [
    ['Jméno', e(name)],
    ['Telefon', `<a href="tel:${e(phone)}" style="color:${BRAND.accent};text-decoration:none">${e(phone)}</a>`],
    email ? ['E-mail', e(email)] : null,
    ['Město', e(city)],
    street || zip ? ['Adresa', e(addressLine({ street, zip, city })) + map] : null,
    ['Auto', e(car) + (car_model ? ` (${e(car_model)})` : '')],
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

function renderTextEmail({ name, phone, email, city, street, zip, car, car_model, service, preferred_date, concerns }) {
  return [
    `NOVÁ REZERVACE Z WEBU - ${BRAND.name}`,
    '',
    `Jméno: ${name}`,
    `Telefon: ${phone}`,
    email ? `E-mail: ${email}` : null,
    `Město: ${city}`,
    street || zip ? `Adresa: ${addressLine({ street, zip, city })}` : null,
    `Auto: ${car}${car_model ? ` (${car_model})` : ''}`,
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
