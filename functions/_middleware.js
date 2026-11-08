const HLAVNI_HOST = 'www.expressdetailing.cz';
const PRESMEROVAT = new Set(['expressdetailing.cz']);

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (/(^|\/)\.(?!well-known(\/|$))|\.(md|toml|example)$|^\/package(-lock)?\.json$/i.test(url.pathname)) {
    return new Response('Nenalezeno', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' } });
  }
  const metoda = context.request.method;
  if (PRESMEROVAT.has(url.hostname) && (metoda === 'GET' || metoda === 'HEAD')) {
    url.protocol = 'https:';
    url.hostname = HLAVNI_HOST;
    url.port = '';
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
  }
  return context.next();
}
