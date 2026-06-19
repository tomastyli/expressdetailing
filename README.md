# Express Detailing - nasazení na Cloudflare Pages

Web byl upraven: optimalizovaný výkon, SEO, přístupnost, alt popisky obrázků,
cookie/GDPR lišta a funkční odesílání formuláře přes Resend.

## Obsah balíku

```
index.html                          hlavní stránka
pro-firmy.html                      stránka pro firmy (B2B)
rezervace.html                      online rezervace termínu (5krokový formulář)
ochrana-osobnich-udaju.html         zásady ochrany osobních údajů (GDPR)
assets/                             obrázky ve formátu WebP + favicony + og-image
_headers                            cache a bezpečnostní hlavičky pro Cloudflare
_redirects                          přesměrování (/firemni-cisteni -> /pro-firmy)
site.webmanifest                    manifest pro mobilní zástupce
robots.txt                          instrukce pro vyhledávače
sitemap.xml                         mapa webu
functions/api/rezervace.js          serverová funkce: rezervace -> e-mail + Supabase
functions/api/firemni-poptavka.js   serverová funkce: firemní poptávka -> e-mail
```

## Jak nasadit

1. Nahrajte celý obsah této složky do kořene projektu na Cloudflare Pages.
   Struktura složek (assets/, functions/) musí zůstat zachovaná.

2. V Cloudflare Pages otevřete Settings > Environment variables a přidejte
   tyto proměnné (Production i Preview):

   - RESEND_API_KEY              = váš API klíč z resend.com (začíná re_)
   - MAIL_FROM                   = "Web <web@expressdetailing.cz>" (doména ověřená v Resend)
   - MAIL_TO                     = expressdetail.litomysl@gmail.com
   - SUPABASE_URL                = Project URL z Supabase (jen pro ukládání rezervací)
   - SUPABASE_SERVICE_ROLE_KEY   = service_role klíč z Supabase (Encrypt = ON)

   MAIL_FROM musí být na doméně ověřené v Resend. Dokud doménu nemáte
   ověřenou, použijte dočasně onboarding@resend.dev. SUPABASE_* jsou volitelné
   (bez nich rezervace stále dorazí e-mailem, jen se neuloží do databáze).

3. Hotovo. Rezervace posílá data na /api/rezervace, firemní poptávka na
   /api/firemni-poptavka. Obě funkce odešlou e-mail přes Resend.

## Co bylo upraveno

### Rychlost
- 14 obrázků bylo vytaženo z HTML (byly vložené jako base64, 95 % velikosti
  souboru) do samostatných WebP souborů. HTML kleslo z 1,6 MB na ~93 KB.
- Obrázky se načítají postupně (lazy loading), hlavní fotka má prioritu.
- Soubor _headers nastavuje roční cache pro obrázky.
- Fonty se načítají bez blokování vykreslení stránky.

### SEO
- Doplněny meta tagy, canonical, Open Graph, Twitter Card.
- Přidána strukturovaná data JSON-LD (lokální firma + časté dotazy),
  což pomáhá zobrazení ve vyhledávání Google.
- Vytvořen náhledový obrázek pro sdílení na sociálních sítích.
- robots.txt a sitemap.xml.

### Přístupnost
- Ke všem obrázkům přidány popisky (alt), galerie má figure/figcaption.
- Přidán odkaz pro přeskočení na obsah, hlavní oblast main.
- FAQ funguje jako přístupný accordion, ikony skryté pro čtečky.
- Viditelné zvýraznění při ovládání klávesnicí.

### Cookie a GDPR
- Lišta s volbou Přijmout / Odmítnout / Upravit nastavení.
- Volba se ukládá, analytika se spustí jen se souhlasem.
- Formulář má povinný souhlas se zpracováním osobních údajů.

## Důležité, prosím zkontrolujte

- Web vznikl úpravou kódu, vizuálně jej po nasazení projděte v prohlížeči
  a znovu si jej změřte na pagespeed.web.dev.
- Zásady ochrany osobních údajů jsou součástí balíku (ochrana-osobnich-udaju.html,
  dostupné na /ochrana-osobnich-udaju). Odkazuje na ně formulář i cookie lišta.
  Obsah zkontrolujte a případně doplňte přesné údaje správce.
- Stará URL /firemni-cisteni je přes _redirects přesměrovaná na /pro-firmy (301).
- Souřadnice firmy v meta tazích a JSON-LD jsou orientačně pro Litomyšl.
  Pokud máte přesnou adresu, doporučuji ji doplnit.
