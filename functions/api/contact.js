// Cloudflare Pages Function: POST /api/contact
// Přijme poptávku z formuláře a odešle e-mail přes Resend.
//
// NASTAVENÍ v Cloudflare Pages (Settings > Environment variables):
//   RESEND_API_KEY  = re_xxxxxxxx        (API klíč z resend.com)
//   CONTACT_TO      = expressdetail.litomysl@gmail.com   (kam chodí poptávky)
//   CONTACT_FROM    = poptavka@expressdetailing.cz       (musí být ověřená doména v Resend)
//
// Dokud nemáte ověřenou vlastní doménu, lze pro CONTACT_FROM dočasně
// použít onboarding@resend.dev (Resend testovací odesílatel).

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CAR_TYPES = {
  osobni: 'Osobní automobil',
  suv: 'SUV / větší vůz',
  dodavka: 'Dodávka / užitkový vůz',
  jine: 'Jiné',
};

export async function onRequestPost(context) {
  const { request, env } = context;

  // Kontrola konfigurace
  if (!env.RESEND_API_KEY || !env.CONTACT_TO || !env.CONTACT_FROM) {
    return json(500, { error: 'Server není správně nakonfigurovaný.' });
  }

  // Načtení dat
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'Neplatný formát požadavku.' });
  }

  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const email = String(body.email || '').trim();
  const cartype = CAR_TYPES[body.cartype] || 'Neuvedeno';
  const message = String(body.message || '').trim();
  const consent = body.consent === true;
  const honeypot = String(body.website || '').trim();

  // Honeypot: pokud je vyplněný, tváříme se úspěšně, ale nic neodešleme
  if (honeypot) {
    return json(200, { ok: true });
  }

  // Validace
  if (name.length < 2) {
    return json(400, { error: 'Vyplňte prosím jméno.' });
  }
  if (phone.replace(/\s/g, '').length < 9) {
    return json(400, { error: 'Vyplňte prosím platný telefon.' });
  }
  if (!consent) {
    return json(400, { error: 'Je potřeba souhlas se zpracováním osobních údajů.' });
  }

  // Sestavení e-mailu
  const subject = `Nová poptávka termínu: ${name}`;
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.6;">
      <h2 style="margin:0 0 16px;">Nová poptávka z webu</h2>
      <table style="border-collapse:collapse;">
        <tr><td style="padding:4px 16px 4px 0;color:#666;">Jméno</td><td><strong>${escapeHtml(name)}</strong></td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666;">Telefon</td><td><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666;">E-mail</td><td>${email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : 'Neuveden'}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#666;">Typ vozu</td><td>${escapeHtml(cartype)}</td></tr>
      </table>
      <p style="margin:16px 0 4px;color:#666;">Zpráva:</p>
      <p style="margin:0;white-space:pre-wrap;background:#f5f5f5;padding:12px;border-radius:8px;">${escapeHtml(message) || 'Bez zprávy'}</p>
      <p style="margin:20px 0 0;font-size:12px;color:#999;">Odesláno z formuláře na expressdetailing.cz</p>
    </div>
  `;

  const text =
    `Nová poptávka z webu\n\n` +
    `Jméno: ${name}\n` +
    `Telefon: ${phone}\n` +
    `E-mail: ${email || 'Neuveden'}\n` +
    `Typ vozu: ${cartype}\n\n` +
    `Zpráva:\n${message || 'Bez zprávy'}\n`;

  // Odeslání přes Resend
  try {
    const payload = {
      from: `Express Detailing <${env.CONTACT_FROM}>`,
      to: [env.CONTACT_TO],
      subject,
      html,
      text,
    };
    // Pokud zákazník uvedl e-mail, nastavíme reply-to, ať se dá rovnou odpovědět
    if (email) {
      payload.reply_to = email;
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error('Resend chyba:', res.status, detail);
      return json(502, { error: 'Nepodařilo se odeslat e-mail.' });
    }

    return json(200, { ok: true });
  } catch (e) {
    console.error('Výjimka při odesílání:', e);
    return json(500, { error: 'Došlo k chybě při odesílání.' });
  }
}

// Ostatní metody (GET apod.) odmítneme
export async function onRequest(context) {
  if (context.request.method === 'POST') {
    return onRequestPost(context);
  }
  return json(405, { error: 'Metoda není povolena.' });
}
