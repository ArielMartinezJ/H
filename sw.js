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
var SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png', 'favicon-32.png'];

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
