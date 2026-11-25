// Parte della pagina che serve prima (e intorno) all'app: worker del database, avvisi, audio.

function ludusAvviso(id, testo, azione) {
    let a = document.getElementById(id);
    if (a) return a;
    a = document.createElement('div');
    a.id = id;
    a.className = 'avviso';
    a.textContent = testo;
    const b = document.createElement('button');
    b.textContent = azione ? azione.testo : 'Ho capito';
    b.onclick = () => { if (azione) azione.fai(); a.remove(); };
    a.appendChild(b);
    document.body.appendChild(a);
    return a;
}

window.ludusCreaWorker = function () {
    const w = new Worker('sqlite-worker.js', { type: 'module' });
    ludusWorker = w;
    w.addEventListener('message', (e) => {
        const attesa = e.data && ludusAttesa.get(e.data.id);
        if (attesa) {
            ludusAttesa.delete(e.data.id);
            if (e.data.error) attesa.rifiuta(new Error(e.data.error)); else attesa.risolvi(e.data.data);
            return;
        }
        const stato = e.data && e.data.stato;
        if (stato === 'altra-scheda') {
            ludusAvviso('avviso-scheda', "Ludus è già aperta in un'altra scheda: chiudila per continuare qui.", { testo: 'Riprova', fai: () => location.reload() });
        } else if (stato === 'libera') {
            if (document.getElementById('avviso-scheda')) location.reload();
        } else if (stato === 'memoria') {
            ludusAvviso('avviso-memoria', 'Questo browser non salva i dati (per esempio in una finestra privata): chiudendo la pagina si perde tutto.');
        }
    });
    return w;
};

// Al primo tocco: suono sbloccato (Safari lo permette solo dentro un gesto) e dati marcati come da tenere.
window.addEventListener('pointerdown', () => {
    try {
        window.ludusAudio = window.ludusAudio || new (window.AudioContext || window.webkitAudioContext)();
        if (window.ludusAudio.state !== 'running') window.ludusAudio.resume();
    } catch (e) {}
    if (!window.ludusPersistente && navigator.storage && navigator.storage.persist) {
        window.ludusPersistente = true;
        navigator.storage.persist().catch(() => {});
    }
}, { passive: true, capture: true });

// Un errore imprevisto prima che l'app sia pronta: meglio dirlo che lasciare la pagina ferma.
window.addEventListener('error', (e) => {
    const m = document.getElementById('messaggio');
    if (m) m.textContent = "Qualcosa è andato storto nell'avvio: ricarica la pagina. (" + (e.message || 'errore') + ')';
});

// Il worker del database, e i suoi comandi fuori dal driver (backup e ripristino).
let ludusWorker = null;
let ludusProssimo = -10;
const ludusAttesa = new Map();

function ludusComando(cmd, dati) {
    const id = ludusProssimo--;
    return new Promise((risolvi, rifiuta) => {
        ludusAttesa.set(id, { risolvi, rifiuta });
        ludusWorker.postMessage({ id, data: { cmd, ...dati }, error: null });
    });
}

// Un archivio chiave-valore per le foto dei Check.
function ludusArchivio() {
    if (!ludusArchivio.db) {
        ludusArchivio.db = new Promise((risolvi, rifiuta) => {
            const r = indexedDB.open('ludus-file', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('foto');
            r.onsuccess = () => risolvi(r.result);
            r.onerror = () => rifiuta(r.error);
        });
    }
    return ludusArchivio.db;
}

async function ludusRichiesta(modo, fai) {
    const db = await ludusArchivio();
    return new Promise((risolvi, rifiuta) => {
        const t = db.transaction('foto', modo);
        const r = fai(t.objectStore('foto'));
        t.oncomplete = () => risolvi(r.result);
        t.onerror = t.onabort = () => rifiuta(t.error);
    });
}

let ludusBlocco = null;
let ludusAcceso = false;

async function ludusPrendiSchermo() {
    try {
        if (ludusAcceso && !ludusBlocco && navigator.wakeLock && document.visibilityState === 'visible') {
            ludusBlocco = await navigator.wakeLock.request('screen');
            ludusBlocco.addEventListener('release', () => { ludusBlocco = null; });
            if (!ludusAcceso) ludusBlocco.release();
        }
    } catch (e) {}
}
document.addEventListener('visibilitychange', ludusPrendiSchermo);

window.ludusBrowser = {
    // Raddrizza (EXIF) e riduce una foto, in JPEG.
    async riduciFoto(dati, lato) {
        const blob = new Blob([dati]);
        let img;
        try {
            img = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        } catch (e) {
            img = await new Promise((risolvi, rifiuta) => {
                const i = new Image();
                i.onload = () => risolvi(i);
                i.onerror = () => rifiuta(new Error('Foto non leggibile'));
                i.src = URL.createObjectURL(blob);
            });
        }
        const l = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
        const scala = Math.min(1, lato / Math.min(l, h));
        const c = document.createElement('canvas');
        c.width = Math.round(l * scala);
        c.height = Math.round(h * scala);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const esito = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
        return new Uint8Array(await esito.arrayBuffer());
    },
    salvaFile: (nome, dati) => ludusRichiesta('readwrite', (s) => s.put(dati, nome)),
    leggiFile: async (nome) => (await ludusRichiesta('readonly', (s) => s.get(nome))) || null,
    eliminaFile: (nome) => ludusRichiesta('readwrite', (s) => s.delete(nome)),
    elencoFile: () => ludusRichiesta('readonly', (s) => s.getAllKeys()),
    // Le parole del PDF con la posizione, in frazioni della pagina: [pagina, testo, x, y, larghezza, altezza].
    async leggiPdf(dati, pagineMassime) {
        const pdf = await import('./pdf/pdf.min.mjs');
        pdf.GlobalWorkerOptions.workerSrc = new URL('./pdf/pdf.worker.min.mjs', location.href).href;
        const doc = await pdf.getDocument({ data: dati, isEvalSupported: false }).promise;
        const righe = [];
        const penna = document.createElement('canvas').getContext('2d');
        penna.font = '20px Helvetica, Arial, sans-serif';
        for (let n = 1; n <= Math.min(doc.numPages, pagineMassime); n++) {
            const pagina = await doc.getPage(n);
            const vista = pagina.getViewport({ scale: 1 });
            const testo = await pagina.getTextContent();
            for (const v of testo.items) {
                if (!v.str || !v.str.trim()) continue;
                const m = pdf.Util.transform(vista.transform, v.transform);
                const alto = Math.hypot(m[2], m[3]) || v.height;
                // Parola per parola, con le larghezze vere delle lettere: con una media gli spazi sembrano piu'
                // larghi e le parole di un nome finirebbero in colonne diverse.
                const intera = penna.measureText(v.str).width || 1;
                for (const p of v.str.matchAll(/\S+/g)) {
                    const inizio = penna.measureText(v.str.slice(0, p.index)).width / intera * v.width;
                    const largo = penna.measureText(p[0]).width / intera * v.width;
                    righe.push([n - 1, p[0], (m[4] + inizio) / vista.width, (m[5] - alto) / vista.height, largo / vista.width, alto / vista.height]);
                }
            }
        }
        await doc.destroy();
        return JSON.stringify(righe);
    },
    esportaDatabase: (nome) => ludusComando('esporta', { fileName: nome }),
    importaDatabase: (nome, dati) => ludusComando('importa', { fileName: nome, dati }),
    chiudiDatabase: (nome) => ludusComando('chiudiFile', { fileName: nome }),
    scartaDatabase: (nome) => ludusComando('scarta', { fileName: nome }),
    schermoAcceso(acceso) {
        ludusAcceso = acceso;
        if (acceso) ludusPrendiSchermo();
        else if (ludusBlocco) ludusBlocco.release().catch(() => {});
    },
    // Solo con la pagina nascosta: davanti bastano vibrazione e suono.
    notifica(titolo, testo) {
        try {
            if (document.visibilityState === 'visible' || !('Notification' in window) || Notification.permission !== 'granted') return;
            const opzioni = { body: testo, icon: 'icona.png', tag: 'ludus-recupero', renotify: true, vibrate: [300, 100, 300] };
            navigator.serviceWorker.ready.then((r) => r.showNotification(titolo, opzioni)).catch(() => {});
        } catch (e) {}
    }
};

// La copia delle risorse nella cache del browser non e' indispensabile: se fallisce (poco spazio, finestra
// privata) l'app deve andare avanti lo stesso.
if (window.Cache) {
    const metti = Cache.prototype.put;
    Cache.prototype.put = function (...a) { return metti.apply(this, a).catch(() => {}); };
}

// Uso senza rete (vedi sw.js). Una versione nuova si applica da sola al prossimo avvio.
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const gia = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!gia) return;
        const avviso = ludusAvviso('avviso-versione', "C'è una versione nuova di Ludus.", { testo: 'Aggiorna', fai: () => location.reload() });
        // Copre la barra in basso: se non interessa se ne va, la versione nuova parte al prossimo avvio.
        setTimeout(() => avviso.remove(), 15000);
    });
}

// Il tasto (o il gesto) indietro del telefono torna indietro dentro l'app invece di chiuderla.
(function indietro() {
    history.pushState({ ludus: 1 }, '');
    window.addEventListener('popstate', () => {
        history.pushState({ ludus: 1 }, '');
        const ospite = [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
        const canvas = ospite && ospite.shadowRoot.querySelector('canvas');
        if (!canvas) return;
        canvas.focus();
        for (const tipo of ['keydown', 'keyup']) {
            canvas.dispatchEvent(new KeyboardEvent(tipo, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
        }
    });
})();

// I trascinamenti sono tutti dell'app. Compose lascia al browser lo scorrimento (touch-action: pan-x pan-y) e
// il browser, che non ha niente da scorrere, dopo pochi pixel annulla il gesto: le liste non scorrevano.
(function gestiAllApp() {
    const ospite = [...document.body.children].find((e) => e.shadowRoot) || [...document.querySelectorAll('*')].find((e) => e.shadowRoot);
    if (!ospite || !ospite.shadowRoot.querySelector('canvas')) { setTimeout(gestiAllApp, 100); return; }
    const stile = document.createElement('style');
    stile.textContent = 'canvas { touch-action: none !important; }';
    ospite.shadowRoot.appendChild(stile);
})();
