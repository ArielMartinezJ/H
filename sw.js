/* sw.js — Diario de Hábitos · service worker (offline 100% del casco)
 *
 * REGLAS (§1.8 del system-prompt + nevera 1 del handoff):
 *  - La versión llega por la URL: sw.js?v=vNN. El worker la lee de ahí y NO
 *    la lleva escrita, así cambiar APPVER es lo único necesario. Sin parámetro
 *    cae en 'v0' A PROPÓSITO, para que el desajuste se vea (⚠ en Diagnóstico).
 *  - El nombre de la caché lleva la versión: cambiar de versión = caché nueva;
 *    al activar se borran TODAS las cachés viejas de esta app.
 *  - fetch: solo GET.
 *      · documento (navegación): RED PRIMERO (y se cachea), o al recargar
 *        verías la versión vieja; sin conexión, el documento cacheado.
 *      · fuentes de Google (googleapis/gstatic): CACHÉ PRIMERO (Leandro las
 *        quiere offline → se guardan la 1ª vez; respuestas opacas incluidas).
 *      · Supabase y cualquier otra red cross-origin que NO sean las fuentes:
 *        PASAN DE LARGO (no se cachean; son datos, no casco).
 *      · resto mismo-origen: CACHÉ PRIMERO con reserva de red.
 *  - RE-SUBIR el sw.js en cada entrega (D7d): es un entregable. Si el
 *    documento se sirviera de una caché vieja, el navegador no pediría el HTML
 *    nuevo; por eso el documento va red-primero y la caché se versiona.
 */
'use strict';

var VER = 'v0';
try { VER = new URL(self.location.href).searchParams.get('v') || 'v0'; } catch (e) { VER = 'v0'; }
var CACHE = 'diario-habitos-' + VER;

var FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
function isFont(url) { return FONT_HOSTS.indexOf(url.hostname) !== -1; }

// El casco: documento (raíz estable './') + manifest + iconos. Rutas RELATIVAS a
// la ubicación del sw.js (mismo directorio), así funciona bajo un subdirectorio
// de GitHub Pages. Se precachea en install para que la app y su icono estén
// disponibles offline desde el primer momento (incl. añadir a pantalla de inicio).
var SHELL = ['./', 'manifest.webmanifest', 'icon192.png', 'icon512.png', 'icon180.png', 'favicon32.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // add() individual y tolerante: si algún recurso falta en un deploy, no
      // tumba la instalación entera (a diferencia de addAll).
      return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // borra SOLO las cachés de esta app que no sean la de la versión actual
        if (k.indexOf('diario-habitos-') === 0 && k !== CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;              // solo GET

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // solo http(s): blob: (manifest/icono en runtime), data:, extensiones… pasan de largo
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  var sameOrigin = (url.origin === self.location.origin);

  // Datos de Supabase (aunque la app se sirva del MISMO proyecto): rest/auth/realtime/functions
  // son datos, no casco → pasan de largo, nunca se cachean.
  if (sameOrigin && /^\/(rest|auth|realtime|functions)\//.test(url.pathname)) return;

  // Cross-origin: solo tocamos las fuentes de Google; el resto (Supabase, CDN…) pasa de largo
  if (!sameOrigin) {
    if (isFont(url)) {
      e.respondWith(
        caches.open(CACHE).then(function (c) {
          return c.match(req).then(function (hit) {
            if (hit) return hit;
            return fetch(req).then(function (res) {
              // se cachea aunque sea opaca (fuentes de otro origen)
              try { c.put(req, res.clone()); } catch (er) {}
              return res;
            });
          });
        })
      );
    }
    return; // otra red cross-origin → pasa de largo
  }

  // Mismo origen: ¿es el documento? (navegación)
  var isDoc = req.mode === 'navigate' || req.destination === 'document';
  if (isDoc) {
    // RED PRIMERO: trae la versión nueva y la cachea; sin red, el documento cacheado
    e.respondWith(
      fetch(req).then(function (res) {
        // clonar YA (síncrono): si se difiere, al ejecutarse el body de res ya está
        // consumido por el navegador y clone() falla -> el documento no se cachearía.
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
        return res;
      }).catch(function () {
        return caches.open(CACHE).then(function (c) {
          return c.match(req).then(function (hit) { return hit || c.match('./'); });
        });
      })
    );
    return;
  }

  // Resto mismo origen: CACHÉ PRIMERO con reserva de red
  e.respondWith(
    caches.open(CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          try { c.put(req, res.clone()); } catch (er) {}
          return res;
        });
      });
    })
  );
});

/* v138 — Re-registro automático de la suscripción push -----------------------
 * Chrome/FCM caduca o rota la suscripción cada cierto tiempo; el endpoint viejo
 * muere (410) y deja de llegar cualquier aviso. El navegador avisa con el evento
 * 'pushsubscriptionchange': aquí re-subscribimos y re-subimos la fila a Supabase
 * NOSOTROS SOLOS, sin abrir la app. Para poder escribir con RLS necesitamos un
 * access_token: lo minteamos con el refresh_token que la app nos pasó por
 * postMessage y guardamos en un caché aparte ('push-creds', no se borra al
 * cambiar de versión). La VAPID pública va aquí embebida (no es secreta). */
var VAPID_PUBLIC = 'BK-tM0X_xU8y2LTf2az0bCmsKKkS6wSVvU16dFiaPiWN87pLZU4M1eAVi6kvsMQbA19BlsnIXEN5zMC85r6q9Uk';
function u8(b) {
  var pad = '='.repeat((4 - b.length % 4) % 4);
  var s = (b + pad).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(s); var a = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) a[i] = raw.charCodeAt(i);
  return a;
}
var CREDS_URL = 'https://push-creds.local/creds';   // clave interna del caché
function saveCreds(o) {
  return caches.open('push-creds').then(function (c) {
    return c.put(new Request(CREDS_URL), new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } }));
  }).catch(function () {});
}
function loadCreds() {
  return caches.open('push-creds').then(function (c) {
    return c.match(new Request(CREDS_URL)).then(function (r) { return r ? r.json() : null; });
  }).catch(function () { return null; });
}
self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'push-creds' && d.url && d.refreshToken) {
    saveCreds({ url: d.url, anonKey: d.anonKey, userId: d.userId, refreshToken: d.refreshToken });
  }
});
async function resubscribePush() {
  var creds = await loadCreds();
  if (!creds || !creds.url || !creds.refreshToken) return;   // sin credenciales no podemos re-subir
  var sub = null;
  try { sub = await self.registration.pushManager.getSubscription(); } catch (e) {}
  if (!sub) {
    try { sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(VAPID_PUBLIC) }); }
    catch (e) { return; }
  }
  var base = creds.url.replace(/\/+$/, '');
  var tok = '';
  try {
    var r = await fetch(base + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', headers: { 'apikey': creds.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: creds.refreshToken })
    });
    var d = await r.json();
    if (d && d.access_token) { tok = d.access_token; if (d.refresh_token) { creds.refreshToken = d.refresh_token; await saveCreds(creds); } }
  } catch (e) {}
  if (!tok) return;
  var j = sub.toJSON();
  try {
    await fetch(base + '/rest/v1/push_subscriptions?on_conflict=user_id,endpoint', {
      method: 'POST',
      headers: { 'apikey': creds.anonKey, 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: creds.userId, endpoint: j.endpoint, subscription: j }])
    });
  } catch (e) {}
}
self.addEventListener('pushsubscriptionchange', function (e) {
  e.waitUntil(resubscribePush());
});

/* v119 — Notificaciones push (aunque la app esté cerrada). No afecta a la caché
 * ni al offline: solo reacciona a eventos 'push' y a los clics en la notificación.
 * El payload que manda la Edge Function es JSON: { title, body, url }. */
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; }
  catch (err) { try { data = { body: e.data ? e.data.text() : '' }; } catch (e2) { data = {}; } }
  var title = data.title || 'Diario de Hábitos';
  var opts = {
    body:  data.body || '',
    icon:  'icon192.png',
    badge: 'favicon32.png',
    tag:   data.tag || 'habitos',
    data:  { url: data.url || './' },
    // v154: botón de acción propio en la notificación (además de tocar el cuerpo)
    actions: [{ action: 'open', title: 'Abrir' }]
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cls) {
      for (var i = 0; i < cls.length; i++) {
        var c = cls[i];
        if ('focus' in c) {
          // v154: ya hay una pestaña abierta -> enfócala Y dile a qué pestaña ir
          // (el #tab no cambia solo al enfocar; la app escucha este mensaje).
          try { c.postMessage({ type: 'navigate', url: target }); } catch (er) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target); // si no hay ninguna, abre en el destino (#tab incluido)
    })
  );
});