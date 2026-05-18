// Cloudflare Pages Function: /api/firemni-poptavka
// Zpracuje poptávku z podstránky firemni-cisteni a odešle e-mail přes Resend.
//
// Umístění souboru v repozitáři:  functions/api/firemni-poptavka.js
// (Cloudflare Pages podle cesty automaticky vytvoří endpoint /api/firemni-poptavka)
//
// Proměnné prostředí nastavte v Cloudflare Pages → Settings → Environment variables:
//   RESEND_API_KEY   povinné, API klíč z resend.com
//   MAIL_TO          povinné, adresa, kam poptávky chodí (např. expressdetail.litomysl@gmail.com)
//   MAIL_FROM        povinné, ověřená odesílací adresa (např. poptavka@expressdetailing.cz)
//   MAIL_REPLY_TO    nepovinné, jinak se použije MAIL_TO

// Pomocná funkce: escapování textu od zákazníka, ať se nedostane HTML do e-mailu
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Čitelné popisky pro hodnoty ze selectů
const FLEET_LABELS = {
  '1-5': '1 až 5 vozidel',
  '6-15': '6 až 15 vozidel',
  '16-30': '16 až 30 vozidel',
  '30+': 'Více než 30 vozidel',
};
const SERVICE_LABELS = {
  'pravidelna': 'Pravidelná smluvní údržba',
  'jednorazove': 'Jednorázové vyčištění flotily',
  'prodej-leasing': 'Příprava před prodejem / leasingem',
  'nevim': 'Nevím, poradím se',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export async function onRequestPost({ request, env }) {
  // Kontrola konfigurace
  if (!env.RESEND_API_KEY || !env.MAIL_TO || !env.MAIL_FROM) {
    return json({ error: 'Formulář není správně nakonfigurován.' }, 500);
  }

  // Načtení a kontrola dat
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ error: 'Neplatný formát požadavku.' }, 400);
  }

  // Honeypot: pokud je vyplněný, tváříme se, že je vše v pořádku, ale nic neodešleme
  if (data.website) {
    return json({ ok: true });
  }

  const company = String(data.company || '').trim();
  const name = String(data.name || '').trim();
  const phone = String(data.phone || '').trim();
  const email = String(data.email || '').trim();
  const ico = String(data.ico || '').trim();
  const location = String(data.location || '').trim();
  const message = String(data.message || '').trim();
  const fleetsize = FLEET_LABELS[data.fleetsize] || 'Neuvedeno';
  const service = SERVICE_LABELS[data.service] || 'Neuvedeno';

  // Validace povinných polí
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (
    company.length < 2 ||
    name.length < 2 ||
    phone.replace(/\s/g, '').length < 9 ||
    !emailOk ||
    data.consent !== true
  ) {
    return json({ error: 'Vyplňte prosím všechna povinná pole.' }, 400);
  }

  // Sestavení e-mailu
  const subject = `Firemní poptávka: ${company}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1d1d20;line-height:1.6;">
      <h2 style="color:#e3122d;margin:0 0 16px;">Nová firemní poptávka</h2>
      <table style="border-collapse:collapse;width:100%;max-width:560px;">
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">Firma</td><td style="padding:6px 0;"><strong>${esc(company)}</strong></td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">IČO</td><td style="padding:6px 0;">${esc(ico) || '&ndash;'}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">Kontaktní osoba</td><td style="padding:6px 0;">${esc(name)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">Telefon</td><td style="padding:6px 0;"><a href="tel:${esc(phone)}">${esc(phone)}</a></td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">E-mail</td><td style="padding:6px 0;"><a href="mailto:${esc(email)}">${esc(email)}</a></td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">Počet vozidel</td><td style="padding:6px 0;">${esc(fleetsize)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">Typ služby</td><td style="padding:6px 0;">${esc(service)}</td></tr>
        <tr><td style="padding:6px 12px 6px 0;color:#6b6b73;">Lokalita</td><td style="padding:6px 0;">${esc(location) || '&ndash;'}</td></tr>
      </table>
      <p style="margin:18px 0 6px;color:#6b6b73;">Doplňující informace</p>
      <div style="padding:14px;background:#f5f5f7;border-radius:8px;white-space:pre-wrap;">${esc(message) || 'Bez poznámky.'}</div>
      <p style="margin-top:20px;font-size:12px;color:#9b9ba3;">Odesláno z podstránky firemního čištění expressdetailing.cz</p>
    </div>
  `;

  const text =
`Nová firemní poptávka

Firma: ${company}
IČO: ${ico || '-'}
Kontaktní osoba: ${name}
Telefon: ${phone}
E-mail: ${email}
Počet vozidel: ${fleetsize}
Typ služby: ${service}
Lokalita: ${location || '-'}

Doplňující informace:
${message || 'Bez poznámky.'}`;

  // Odeslání přes Resend
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [env.MAIL_TO],
        reply_to: env.MAIL_REPLY_TO || email,
        subject,
        html,
        text,
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('Resend error:', res.status, detail);
      return json({ error: 'E-mail se nepodařilo odeslat.' }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('Resend request failed:', err);
    return json({ error: 'E-mail se nepodařilo odeslat.' }, 502);
  }
}

// Ostatní metody odmítneme
export async function onRequest({ request }) {
  if (request.method === 'POST') return; // zpracuje onRequestPost
  return json({ error: 'Metoda není povolena.' }, 405);
}
