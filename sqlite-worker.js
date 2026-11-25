// Il database di Ludus nel browser. Riceve dal driver androidx.sqlite (WebWorkerSQLiteDriver) le
// richieste open / prepare / step / close e le esegue con SQLite compilato per il web.
// I dati stanno nello spazio privato del sito (OPFS, VFS "opfs-sahpool": non servono header
// speciali, quindi funziona anche su GitHub Pages). Se il browser non lo permette (finestra
// privata, Firefox senza OPFS) si ripiega sulla memoria: i dati durano solo finche' la pagina e' aperta.
import sqlite3InitModule from './sqlite3.mjs';

const SQLITE_NULL = 5;

// Avvisi per la pagina (avvio.js): id -1, il driver li ignora.
function avvisa(stato, dettaglio) {
    self.postMessage({ id: -1, data: null, error: null, stato, dettaglio: dettaglio ? String(dettaglio) : null });
}

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

// Una scheda alla volta: l'archivio OPFS non si puo' aprire due volte. Ricaricando la pagina il blocco
// della vecchia si libera da solo; se e' un'altra scheda la pagina lo dice e aspetta.
async function prendiBlocco() {
    if (!navigator.locks) return;
    const preso = await new Promise((risolvi) => {
        navigator.locks.request('ludus-db', { ifAvailable: true }, (b) => {
            if (!b) { risolvi(false); return undefined; }
            risolvi(true);
            return new Promise(() => {});
        }).catch(() => risolvi(true));
    });
    if (preso) return;
    const avviso = setTimeout(() => avvisa('altra-scheda'), 1500);
    await new Promise((risolvi) => {
        navigator.locks.request('ludus-db', () => { risolvi(); return new Promise(() => {}); });
    });
    clearTimeout(avviso);
    avvisa('libera');
}

// Riserva per i browser senza OPFS: il database sta in memoria e dopo ogni scrittura se ne salva una
// copia intera in IndexedDB (pochi MB).
function apriRiserva() {
    return new Promise((risolvi, rifiuta) => {
        const r = indexedDB.open('ludus-database', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('file');
        r.onsuccess = () => risolvi(r.result);
        r.onerror = () => rifiuta(r.error);
    });
}

function riservaRichiesta(riserva, modo, fai) {
    return new Promise((risolvi, rifiuta) => {
        const t = riserva.transaction('file', modo);
        const r = fai(t.objectStore('file'));
        t.oncomplete = () => risolvi(r.result);
        t.onerror = t.onabort = () => rifiuta(t.error);
    });
}

// I file dei database in memoria (copie dei backup da ripristinare).
const inMemoria = new Map();

const percorso = (nome) => '/' + nome.replace(/^\/+/, '');

function riempi(sqlite3, db, schema, dati) {
    const p = sqlite3.wasm.allocFromTypedArray(dati);
    const rc = sqlite3.capi.sqlite3_deserialize(
        db.pointer, schema, p, dati.length, dati.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );
    db.checkRc(rc);
}

let salvataggio = null;

function salvaRiserva({ sqlite3, riserva }, voce) {
    if (!riserva || voce.temporaneo) return;
    const modifiche = sqlite3.capi.sqlite3_total_changes(voce.db.pointer);
    const fuoriTransazione = sqlite3.capi.sqlite3_get_autocommit(voce.db.pointer);
    if (!fuoriTransazione || modifiche === voce.salvate) return;
    clearTimeout(salvataggio);
    salvataggio = setTimeout(() => {
        try {
            if (!sqlite3.capi.sqlite3_get_autocommit(voce.db.pointer)) return;
            voce.salvate = sqlite3.capi.sqlite3_total_changes(voce.db.pointer);
            const dati = sqlite3.capi.sqlite3_js_db_export(voce.db.pointer);
            riservaRichiesta(riserva, 'readwrite', (s) => s.put(dati, voce.nome)).catch((e) => avvisa('memoria', e));
        } catch (e) {
            avvisa('memoria', e);
        }
    }, 150);
}

const pronto = (async () => {
    const sqlite3 = await sqlite3InitModule();
    await prendiBlocco();
    let pool = null;
    let errore = null;
    // Appena dopo un ricaricamento i file della pagina vecchia possono essere ancora aperti.
    for (let tentativo = 0; tentativo < 20 && !pool; tentativo++) {
        try {
            pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'ludus-opfs', clearOnInit: false });
        } catch (e) {
            errore = e;
            const nonDisponibile = !navigator.storage || !navigator.storage.getDirectory;
            if (nonDisponibile || tentativo >= 3 && !/lock|access|handle|modif/i.test(String(e))) break;
            await attesa(250);
        }
    }
    let riserva = null;
    if (!pool) {
        console.warn('Ludus: OPFS non disponibile, uso IndexedDB.', errore);
        try {
            riserva = await apriRiserva();
        } catch (e) {
            console.warn('Ludus: archivio persistente non disponibile, uso la memoria.', e);
            avvisa('memoria', e);
        }
    } else if (pool.getCapacity() < 8) {
        await pool.addCapacity(8 - pool.getCapacity());
    }
    return { sqlite3, pool, riserva };
})();

const database = new Map();
const istruzioni = new Map();
let prossimoId = 1;

function normalizza(v) {
    return typeof v === 'bigint' ? Number(v) : v;
}

async function apri({ sqlite3, pool, riserva }, { fileName }) {
    const nome = percorso(fileName);
    const databaseId = prossimoId++;
    const voce = { db: null, istruzioni: new Set(), nome, salvate: 0, temporaneo: inMemoria.has(nome) };
    if (pool) {
        voce.db = new pool.OpfsSAHPoolDb(nome);
    } else {
        voce.db = new sqlite3.oo1.DB(':memory:', 'c');
        const dati = inMemoria.get(nome) || (riserva ? await riservaRichiesta(riserva, 'readonly', (s) => s.get(nome)) : null);
        if (dati) riempi(sqlite3, voce.db, 'main', dati);
        voce.salvate = sqlite3.capi.sqlite3_total_changes(voce.db.pointer);
    }
    database.set(databaseId, voce);
    return { databaseId };
}

// ---- Backup e ripristino (comandi di avvio.js, non del driver) ----

function cerca(nome) {
    return [...database.values()].find((v) => v.nome === nome);
}

function esporta({ sqlite3, pool }, { fileName }) {
    const nome = percorso(fileName);
    const voce = cerca(nome);
    if (voce) return sqlite3.capi.sqlite3_js_db_export(voce.db.pointer);
    if (pool) return pool.exportFile(nome);
    throw new Error('Database non aperto');
}

async function importa({ pool }, { fileName, dati }) {
    const nome = percorso(fileName);
    if (pool) await pool.importDb(nome, dati);
    else inMemoria.set(nome, dati);
    return null;
}

// Chiude il database di un file (la copia del backup gia' portata alla versione attuale), che resta
// pronto per l'ATTACH.
function chiudiFile(contesto, { fileName }) {
    const { sqlite3, pool } = contesto;
    const nome = percorso(fileName);
    for (const [databaseId, voce] of [...database]) {
        if (voce.nome !== nome) continue;
        if (!pool) inMemoria.set(nome, sqlite3.capi.sqlite3_js_db_export(voce.db.pointer));
        chiudi(contesto, { databaseId });
    }
    return null;
}

function scarta({ pool }, { fileName }) {
    const nome = percorso(fileName);
    inMemoria.delete(nome);
    if (pool) pool.unlink(nome);
    return null;
}

// Senza OPFS un ATTACH aprirebbe un file che non c'e': si riempie dalla copia in memoria.
function attacca({ sqlite3, pool }, voce, sql) {
    const m = !pool && /^\s*ATTACH\s+DATABASE\s+'(.*)'\s+AS\s+(\w+)\s*$/i.exec(sql);
    if (!m) return false;
    const dati = inMemoria.get(percorso(m[1]));
    if (!dati) return false;
    voce.db.exec(`ATTACH DATABASE ':memory:' AS ${m[2]}`);
    riempi(sqlite3, voce.db, m[2], dati);
    return true;
}

function prepara(contesto, { databaseId, sql }) {
    const voce = database.get(databaseId);
    const stmt = voce.db.prepare(attacca(contesto, voce, sql) ? 'SELECT 1' : sql);
    const statementId = prossimoId++;
    istruzioni.set(statementId, { stmt, databaseId });
    voce.istruzioni.add(statementId);
    const columnNames = [];
    for (let i = 0; i < stmt.columnCount; i++) columnNames.push(stmt.getColumnName(i));
    return { statementId, parameterCount: stmt.parameterCount, columnNames };
}

function esegui(contesto, { statementId, bindings }) {
    const { sqlite3 } = contesto;
    const { stmt, databaseId } = istruzioni.get(statementId);
    stmt.reset(true);
    for (let i = 0; i < bindings.length; i++) {
        const v = bindings[i];
        if (v !== undefined) stmt.bind(i + 1, v);
    }
    const rows = [];
    let columnTypes = [];
    try {
        while (stmt.step()) {
            if (rows.length === 0) {
                for (let i = 0; i < stmt.columnCount; i++) {
                    columnTypes.push(sqlite3.capi.sqlite3_column_type(stmt.pointer, i));
                }
            }
            rows.push(stmt.get([]).map(normalizza));
        }
    } finally {
        stmt.reset();
    }
    salvaRiserva(contesto, database.get(databaseId));
    if (columnTypes.length === 0) {
        for (let i = 0; i < stmt.columnCount; i++) columnTypes.push(SQLITE_NULL);
    }
    return { rows, columnTypes };
}

function chiudi({ sqlite3, pool }, { statementId, databaseId }) {
    if (statementId != null) {
        const voce = istruzioni.get(statementId);
        if (voce) {
            voce.stmt.finalize();
            istruzioni.delete(statementId);
            database.get(voce.databaseId)?.istruzioni.delete(statementId);
        }
    }
    if (databaseId != null) {
        const voce = database.get(databaseId);
        if (voce) {
            voce.istruzioni.forEach((id) => {
                istruzioni.get(id)?.stmt.finalize();
                istruzioni.delete(id);
            });
            voce.db.close();
            database.delete(databaseId);
        }
    }
    return null;
}

self.onmessage = async (evento) => {
    const { id, data } = evento.data;
    try {
        const contesto = await pronto;
        let risultato;
        switch (data.cmd) {
            case 'open': risultato = await apri(contesto, data); break;
            case 'prepare': risultato = prepara(contesto, data); break;
            case 'step': risultato = esegui(contesto, data); break;
            case 'close': risultato = chiudi(contesto, data); break;
            case 'esporta': risultato = esporta(contesto, data); break;
            case 'importa': risultato = await importa(contesto, data); break;
            case 'chiudiFile': risultato = chiudiFile(contesto, data); break;
            case 'scarta': risultato = scarta(contesto, data); break;
            default: throw new Error('Comando sconosciuto: ' + data.cmd);
        }
        self.postMessage({ id, data: risultato, error: null });
    } catch (e) {
        self.postMessage({ id, data: null, error: String(e && e.message ? e.message : e) });
    }
};
