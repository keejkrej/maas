import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Minimal document store. Production uses Firestore; local dev/tests use a JSON file.
 * Paths are Firestore-style: "collection/doc/collection/doc".
 */
export interface Query {
  where?: [field: string, value: unknown];
  /** Only docs whose numeric `field` is greater than `value`. */
  gt?: [field: string, value: number];
  orderBy?: [field: string, dir: "asc" | "desc"];
  limit?: number;
}

export type BatchOp = { op: "set"; path: string; data: object } | { op: "delete"; path: string };

export interface DocStore {
  get<T>(path: string): Promise<T | null>;
  set(path: string, data: object, merge?: boolean): Promise<void>;
  delete(path: string): Promise<void>;
  list<T>(collection: string, q?: Query): Promise<{ id: string; data: T }[]>;
  batch(ops: BatchOp[]): Promise<void>;
  /** Atomic read-modify-write. Return the new value, null to delete, or undefined to leave unchanged. */
  update<T>(path: string, fn: (cur: T | null) => T | null | undefined): Promise<T | null>;
}

/** Firestore doc ids can't contain "/", so file paths are encoded. */
export const docId = (s: string) => encodeURIComponent(s).replace(/\./g, "%2E");
export const fromDocId = (s: string) => decodeURIComponent(s);

// ---------------- Firestore ----------------

class FirestoreStore implements DocStore {
  private dbp: Promise<FirebaseFirestore.Firestore>;
  constructor() {
    this.dbp = (async () => {
      const { initializeApp, getApps } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      if (!getApps().length) initializeApp();
      const db = getFirestore();
      db.settings({ ignoreUndefinedProperties: true });
      return db;
    })();
  }
  async get<T>(p: string) {
    const s = await (await this.dbp).doc(p).get();
    return s.exists ? (s.data() as T) : null;
  }
  async set(p: string, data: object, merge = false) {
    await (await this.dbp).doc(p).set(data, { merge });
  }
  async delete(p: string) {
    await (await this.dbp).doc(p).delete();
  }
  async list<T>(collection: string, q: Query = {}) {
    let ref: FirebaseFirestore.Query = (await this.dbp).collection(collection);
    if (q.where) ref = ref.where(q.where[0], "==", q.where[1]);
    if (q.gt) ref = ref.where(q.gt[0], ">", q.gt[1]);
    if (q.orderBy) ref = ref.orderBy(q.orderBy[0], q.orderBy[1]);
    if (q.limit) ref = ref.limit(q.limit);
    const snap = await ref.get();
    return snap.docs.map((d) => ({ id: d.id, data: d.data() as T }));
  }
  async batch(ops: BatchOp[]) {
    const db = await this.dbp;
    for (let i = 0; i < ops.length; i += 450) {
      const b = db.batch();
      for (const o of ops.slice(i, i + 450)) {
        if (o.op === "set") b.set(db.doc(o.path), o.data);
        else b.delete(db.doc(o.path));
      }
      await b.commit();
    }
  }
  async update<T>(p: string, fn: (cur: T | null) => T | null | undefined) {
    const db = await this.dbp;
    return db.runTransaction(async (tx) => {
      const ref = db.doc(p);
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data() as T) : null;
      const next = fn(cur);
      if (next === undefined) return cur;
      if (next === null) tx.delete(ref);
      else tx.set(ref, next as object);
      return next;
    });
  }
}

// ---------------- Local JSON file (dev/tests) ----------------

class LocalStore implements DocStore {
  private docs = new Map<string, any>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string) {
    try {
      this.docs = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8"))));
    } catch {}
  }
  private flush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.docs)));
    }, 50);
  }
  private clone<T>(v: T): T {
    return v === undefined ? v : structuredClone(v);
  }
  async get<T>(p: string) {
    return this.docs.has(p) ? (this.clone(this.docs.get(p)) as T) : null;
  }
  async set(p: string, data: object, merge = false) {
    const clean = JSON.parse(JSON.stringify(data));
    this.docs.set(p, merge ? { ...(this.docs.get(p) ?? {}), ...clean } : clean);
    this.flush();
  }
  async delete(p: string) {
    this.docs.delete(p);
    this.flush();
  }
  async list<T>(collection: string, q: Query = {}) {
    const prefix = collection + "/";
    let rows = [...this.docs.entries()]
      .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map(([k, v]) => ({ id: k.slice(prefix.length), data: this.clone(v) as T }));
    if (q.where) rows = rows.filter((r: any) => r.data[q.where![0]] === q.where![1]);
    if (q.gt) rows = rows.filter((r: any) => r.data[q.gt![0]] > q.gt![1]);
    if (q.orderBy) {
      const [f, dir] = q.orderBy;
      rows.sort((a: any, b: any) => (a.data[f] < b.data[f] ? -1 : a.data[f] > b.data[f] ? 1 : 0) * (dir === "desc" ? -1 : 1));
    }
    return q.limit ? rows.slice(0, q.limit) : rows;
  }
  async batch(ops: BatchOp[]) {
    for (const o of ops) o.op === "set" ? await this.set(o.path, o.data) : await this.delete(o.path);
  }
  async update<T>(p: string, fn: (cur: T | null) => T | null | undefined) {
    // Single process, no awaits between read and write: atomic.
    const cur = this.docs.has(p) ? (this.clone(this.docs.get(p)) as T) : null;
    const next = fn(cur);
    if (next === undefined) return cur;
    if (next === null) this.docs.delete(p);
    else this.docs.set(p, JSON.parse(JSON.stringify(next)));
    this.flush();
    return next;
  }
}

export const db: DocStore = config.useFirestore ? new FirestoreStore() : new LocalStore(path.join(config.dataDir, "db.json"));
