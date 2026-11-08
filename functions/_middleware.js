const HLAVNI_HOST = 'www.expressdetailing.cz';
const PRESMEROVAT = new Set(['expressdetailing.cz']);

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const metoda = context.request.method;
  if (PRESMEROVAT.has(url.hostname) && (metoda === 'GET' || metoda === 'HEAD')) {
    url.protocol = 'https:';
    url.hostname = HLAVNI_HOST;
    url.port = '';
    return new Response(null, { status: 301, headers: { Location: url.toString() } });
  }
  return context.next();
}
