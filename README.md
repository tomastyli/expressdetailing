# Express Detailing - nasazení na Cloudflare Pages

Web byl upraven: optimalizovaný výkon, SEO, přístupnost, alt popisky obrázků,
cookie/GDPR lišta a funkční odesílání formuláře přes Resend.

## Obsah balíku

```
index.html              hlavní stránka (z 1,6 MB na ~93 KB)
assets/                 obrázky ve formátu WebP + favicony + og-image
_headers                cache a bezpečnostní hlavičky pro Cloudflare
site.webmanifest        manifest pro mobilní zástupce
robots.txt              instrukce pro vyhledávače
sitemap.xml             mapa webu
functions/api/contact.js  serverová funkce pro odeslání poptávky e-mailem
```

## Jak nasadit

1. Nahrajte celý obsah této složky do kořene projektu na Cloudflare Pages.
   Struktura složek (assets/, functions/) musí zůstat zachovaná.

2. V Cloudflare Pages otevřete Settings > Environment variables a přidejte
   tři proměnné (Production i Preview):

   - RESEND_API_KEY   = váš API klíč z resend.com (začíná re_)
   - CONTACT_TO       = expressdetail.litomysl@gmail.com
   - CONTACT_FROM     = poptavka@expressdetailing.cz

   CONTACT_FROM musí být na doméně ověřené v Resend. Dokud doménu nemáte
   ověřenou, použijte dočasně onboarding@resend.dev.

3. Hotovo. Formulář na webu posílá data na /api/contact, funkce je odešle e-mailem.

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
- Stránky /firemni-cisteni a /ochrana-osobnich-udaju jsou odkazované,
  ale jejich obsah není součástí tohoto balíku. Zásady ochrany osobních
  údajů je vhodné doplnit, protože na ně odkazuje formulář i cookie lišta.
- Souřadnice firmy v meta tazích a JSON-LD jsou orientačně pro Litomyšl.
  Pokud máte přesnou adresu, doporučuji ji doplnit.
