// Ludus senza rete: i file dell'app si tengono tutti alla prima visita, immagini e risorse man mano che
// servono. VERSIONE e FILE li scrive il task sitoWeb.
const VERSIONE = '29743f3bcc5afcd9';
const FILE = ['./', '658820f72b4617efb380.wasm', 'avvio.js', 'c5799ba81395aae48d3b.wasm', 'composeResources/com.it.ludus.resources/drawable/gruppo_addominali.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_avambracci.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_bicipiti.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_cardio.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_collo.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_dorso.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_femorali.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_glutei.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_petto.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_polpacci.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_quadricipiti.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_spalle.png', 'composeResources/com.it.ludus.resources/drawable/gruppo_tricipiti.png', 'composeResources/com.it.ludus.resources/drawable/misura_avambraccio.png', 'composeResources/com.it.ludus.resources/drawable/misura_bicipite.png', 'composeResources/com.it.ludus.resources/drawable/misura_collo.png', 'composeResources/com.it.ludus.resources/drawable/misura_coscia.png', 'composeResources/com.it.ludus.resources/drawable/misura_fianchi.png', 'composeResources/com.it.ludus.resources/drawable/misura_petto.png', 'composeResources/com.it.ludus.resources/drawable/misura_polpaccio.png', 'composeResources/com.it.ludus.resources/drawable/misura_spalle.png', 'composeResources/com.it.ludus.resources/drawable/misura_vita.png', 'composeResources/com.it.ludus.resources/files/esercizi/catalogo.json', 'composeResources/com.it.ludus.resources/files/schede_incluse/elenco.txt', 'composeResources/com.it.ludus.resources/font/cinzel_variable.ttf', 'icona.png', 'index.html', 'ludus.js', 'manifest.webmanifest', 'pdf/pdf.min.mjs', 'pdf/pdf.worker.min.mjs', 'sqlite-worker.js', 'sqlite3.mjs', 'sqlite3.wasm'];
const CACHE_APP = 'ludus-app-' + VERSIONE;
const CACHE_RISORSE = 'ludus-risorse';

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_APP)
        // Dalla rete, non dalla cache del browser: i file devono essere tutti della stessa versione.
        .then((c) => c.addAll(FILE.map((f) => new Request(f, { cache: 'reload' }))))
        .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        for (const n of await caches.keys()) if (n.startsWith('ludus-app-') && n !== CACHE_APP) await caches.delete(n);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin) return;
    e.respondWith((async () => {
        const app = await caches.open(CACHE_APP);
        const pagina = e.request.mode === 'navigate';
        // Anche la pagina e' quella tenuta: cosi' pagina e app sono sempre della stessa versione. Quella nuova
        // si scarica intanto e la pagina avvisa quando e' pronta.
        if (pagina) return (await app.match('index.html')) || fetch(e.request);
        const tenuto = await app.match(e.request, { ignoreSearch: true });
        if (tenuto) return tenuto;
        // Le immagini degli esercizi non cambiano: prima quelle tenute.
        const risorse = await caches.open(CACHE_RISORSE);
        const gia = await risorse.match(e.request);
        const immagine = /\.(webp|png|jpg|ttf)$/.test(url.pathname);
        if (gia && immagine) return gia;
        try {
            const r = await fetch(e.request);
            if (r.ok && url.pathname.includes('/composeResources/')) risorse.put(e.request, r.clone()).catch(() => {});
            return r;
        } catch (x) {
            return gia || Response.error();
        }
    })());
});

// Tocco sulla notifica di fine recupero: torna alla pagina.
self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    e.waitUntil(self.clients.matchAll({ type: 'window' }).then((c) => (c.length ? c[0].focus() : self.clients.openWindow('./'))));
});
