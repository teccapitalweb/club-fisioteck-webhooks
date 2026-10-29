'use strict';

// Firestore en memoria para pruebas locales (sin emulador, sin Java, sin credenciales).
// Conserva instancias de FakeTimestamp porque server.js llama toMillis()/toDate().

class FakeTimestamp {
  constructor(ms) { this._ms = ms; }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
  static fromDate(date) { return new FakeTimestamp(date.getTime()); }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
}

function clone(value) {
  if (value instanceof FakeTimestamp) return new FakeTimestamp(value._ms);
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  }
  return value;
}

// Marca que devuelve FieldPath.documentId() en las consultas por id de documento.
const NOMBRE_DOC = '__name__';

class FakeDocumentSnapshot {
  constructor(ref, value) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = value !== undefined;
    this._value = value;
  }
  data() { return this._value === undefined ? undefined : clone(this._value); }
}

class FakeDocumentReference {
  constructor(db, path) {
    this._db = db;
    this.path = path;
    this.id = path.split('/').at(-1);
  }
  // Con `db.lenta = true` la lectura toma su foto y TARDA un turno del reloj en entregarla: así dos
  // solicitudes simultáneas leen el mismo estado viejo, como pasa en producción, y solo una transacción
  // real evita el doble guardado.
  async get() {
    const foto = new FakeDocumentSnapshot(this, this._db._data.get(this.path));
    if (this._db.lenta) await new Promise(resolver => setImmediate(resolver));
    return foto;
  }
  async set(value, options) {
    const current = this._db._data.get(this.path);
    const next = options && options.merge ? { ...(current || {}), ...clone(value) } : clone(value);
    this._db._data.set(this.path, next);
    this._db._versiones.set(this.path, this._db._version(this.path) + 1);
  }
  // Subcolección (p. ej. avisos/{uid}/items): en la fake es solo otra ruta con prefijo.
  collection(name) { return new FakeCollectionReference(this._db, `${this.path}/${name}`); }
  async update(value) {
    if (!this._db._data.has(this.path)) throw new Error(`missing document ${this.path}`);
    await this.set(value, { merge: true });
  }
  async delete() {
    this._db._data.delete(this.path);
    this._db._versiones.set(this.path, this._db._version(this.path) + 1);
  }
}

// Valor comparable: las marcas de tiempo se comparan por milisegundos.
function comparable(v) {
  if (v instanceof FakeTimestamp) return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return v;
}
function leerCampo(valor, campo) {
  return String(campo).split('.').reduce((acc, parte) => (acc == null ? undefined : acc[parte]), valor);
}
function compara(a, b) {
  const x = comparable(a); const y = comparable(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}
const valorDe = (d, campo) => (campo === NOMBRE_DOC ? d.id : leerCampo(d.value, campo));

class FakeQuery {
  constructor(collection, filters = [], max = Infinity, orden = []) {
    this.collection = collection;
    this.filters = filters;
    this.max = max;
    this.orden = orden;
  }
  where(field, operator, value) {
    if (!['==', '>', '>=', '<', '<=', 'in', 'array-contains'].includes(operator)) throw new Error(`unsupported operator ${operator}`);
    return new FakeQuery(this.collection, [...this.filters, [field, operator, value]], this.max, this.orden);
  }
  orderBy(field, direccion = 'asc') {
    return new FakeQuery(this.collection, this.filters, this.max, [...this.orden, [field, direccion]]);
  }
  limit(max) { return new FakeQuery(this.collection, this.filters, max, this.orden); }
  // select() sin campos (solo ids) o con ellos: en la fake devuelve los documentos completos
  select() { return new FakeQuery(this.collection, this.filters, this.max, this.orden); }
  _coincide(d, [field, operator, expected]) {
    const actual = valorDe(d, field);
    if (operator === '==') return comparable(actual) === comparable(expected);
    if (operator === 'in') return Array.isArray(expected) && expected.includes(actual);
    if (operator === 'array-contains') return Array.isArray(actual) && actual.includes(expected);
    if (actual === undefined || actual === null) return false;
    const c = compara(actual, expected);
    return operator === '>' ? c > 0 : operator === '>=' ? c >= 0 : operator === '<' ? c < 0 : c <= 0;
  }
  _docs() {
    const db = this.collection._db;
    const prefix = `${this.collection.path}/`;
    let docs = [];
    for (const [path, value] of db._data.entries()) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      const d = { path, id: path.slice(prefix.length), value };
      if (!this.filters.every(f => this._coincide(d, f))) continue;
      docs.push(d);
    }
    // Como en Firestore: al ordenar por un campo, los documentos que no lo tienen quedan fuera.
    for (const [campo] of this.orden) docs = docs.filter(d => valorDe(d, campo) != null);
    if (this.orden.length) {
      docs.sort((a, b) => {
        for (const [campo, dir] of this.orden) {
          const c = compara(valorDe(a, campo), valorDe(b, campo));
          if (c !== 0) return dir === 'desc' ? -c : c;
        }
        return 0;
      });
    }
    return docs.slice(0, this.max);
  }
  async get() {
    const db = this.collection._db;
    const docs = this._docs().map(d => new FakeDocumentSnapshot(new FakeDocumentReference(db, d.path), d.value));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
  count() {
    return { get: async () => ({ data: () => ({ count: this._docs().length }) }) };
  }
}

class FakeCollectionReference extends FakeQuery {
  constructor(db, path) {
    super({ _db: db, path });
    this._db = db;
    this.path = path;
    this.collection = this;
  }
  doc(id) { return new FakeDocumentReference(this._db, `${this.path}/${id}`); }
}

class FakeFirestore {
  constructor(seed = {}) {
    this._data = new Map(Object.entries(seed).map(([path, value]) => [path, clone(value)]));
    this._versiones = new Map(); // cuántas veces cambió cada documento (para las transacciones)
  }
  _version(path) { return this._versiones.get(path) || 0; }
  // Transacción optimista como la de Firestore: si un documento leído cambió antes de confirmar,
  // se reintenta toda la función. Las escrituras se aplican juntas y sin await entre la
  // comprobación y la aplicación, así dos transacciones simultáneas nunca pisan la misma lectura.
  async runTransaction(fn, { intentos = 5 } = {}) {
    for (let intento = 0; intento < intentos; intento++) {
      const leidos = new Map();
      const pendientes = [];
      const tx = {
        get: async ref => { leidos.set(ref.path, this._version(ref.path)); return ref.get(); },
        set: (ref, value, options) => { pendientes.push(() => ref.set(value, options)); return tx; },
        update: (ref, value) => { pendientes.push(() => ref.update(value)); return tx; },
        delete: ref => { pendientes.push(() => ref.delete()); return tx; }
      };
      const resultado = await fn(tx);
      if ([...leidos].some(([path, version]) => this._version(path) !== version)) continue;
      for (const aplicar of pendientes) aplicar(); // cada set/delete cambia el Map de inmediato (sin esperar)
      return resultado;
    }
    throw new Error('Transacción abortada por contención');
  }
  collection(name) { return new FakeCollectionReference(this, name); }
  async getAll(...refs) { return Promise.all(refs.map(ref => ref.get())); }
  batch() {
    const operaciones = [];
    const lote = {
      set: (ref, value, options) => { operaciones.push(() => ref.set(value, options)); return lote; },
      update: (ref, value) => { operaciones.push(() => ref.update(value)); return lote; },
      delete: ref => { operaciones.push(() => ref.delete()); return lote; },
      commit: async () => { for (const operacion of operaciones) await operacion(); }
    };
    return lote;
  }
  value(path) { return clone(this._data.get(path)); }
}

module.exports = { FakeFirestore, FakeTimestamp, NOMBRE_DOC };
