// A small document store for Telegram alerts and relay counts (docs/05 §6.5). Server only.
// Firestore when FIRESTORE=1 (Cloud Run, credentials from the service account); in memory
// otherwise (local dev, tests). It holds no money record: the contract is the only one.
import type { Firestore } from "@google-cloud/firestore";

export type Doc<T> = { id: string; data: T };

export interface Store {
  get<T>(col: string, id: string): Promise<T | null>;
  set<T extends object>(col: string, id: string, data: T): Promise<void>;
  delete(col: string, id: string): Promise<void>;
  /** Documents whose `field` equals `value`. */
  where<T>(col: string, field: string, value: string | number): Promise<Doc<T>[]>;
  all<T>(col: string): Promise<Doc<T>[]>;
  /** Takes `name` for `ms` unless someone else holds it. */
  lease(name: string, holder: string, ms: number): Promise<boolean>;
  /** Reads, deletes and returns `id` in one step (a one-time code), or null. */
  take<T>(col: string, id: string): Promise<T | null>;
}

class MemoryStore implements Store {
  private cols = new Map<string, Map<string, unknown>>();
  private col(c: string) {
    let m = this.cols.get(c);
    if (!m) {
      m = new Map();
      this.cols.set(c, m);
    }
    return m;
  }
  async get<T>(c: string, id: string) {
    return (structuredClone(this.col(c).get(id)) as T) ?? null;
  }
  async set<T extends object>(c: string, id: string, data: T) {
    this.col(c).set(id, structuredClone(data));
  }
  async delete(c: string, id: string) {
    this.col(c).delete(id);
  }
  async where<T>(c: string, field: string, value: string | number) {
    return [...this.col(c)]
      .filter(([, d]) => (d as Record<string, unknown>)[field] === value)
      .map(([id, d]) => ({ id, data: structuredClone(d) as T }));
  }
  async all<T>(c: string) {
    return [...this.col(c)].map(([id, d]) => ({ id, data: structuredClone(d) as T }));
  }
  async lease(name: string, holder: string, ms: number) {
    const l = this.col("locks").get(name) as { holder: string; until: number } | undefined;
    if (l && l.holder !== holder && l.until > Date.now()) return false;
    this.col("locks").set(name, { holder, until: Date.now() + ms });
    return true;
  }
  async take<T>(c: string, id: string) {
    const d = this.col(c).get(id);
    this.col(c).delete(id);
    return (d as T) ?? null;
  }
}

class FirestoreStore implements Store {
  private db: Promise<Firestore>;
  constructor() {
    this.db = import("@google-cloud/firestore").then(
      ({ Firestore }) => new Firestore({ ignoreUndefinedProperties: true }),
    );
  }
  async get<T>(c: string, id: string) {
    const s = await (await this.db).collection(c).doc(id).get();
    return s.exists ? (s.data() as T) : null;
  }
  async set<T extends object>(c: string, id: string, data: T) {
    await (await this.db).collection(c).doc(id).set(data);
  }
  async delete(c: string, id: string) {
    await (await this.db).collection(c).doc(id).delete();
  }
  async where<T>(c: string, field: string, value: string | number) {
    const q = await (await this.db).collection(c).where(field, "==", value).get();
    return q.docs.map((d) => ({ id: d.id, data: d.data() as T }));
  }
  async all<T>(c: string) {
    const q = await (await this.db).collection(c).get();
    return q.docs.map((d) => ({ id: d.id, data: d.data() as T }));
  }
  async lease(name: string, holder: string, ms: number) {
    const db = await this.db;
    const ref = db.collection("locks").doc(name);
    return db.runTransaction(async (t) => {
      const l = (await t.get(ref)).data() as { holder: string; until: number } | undefined;
      if (l && l.holder !== holder && l.until > Date.now()) return false;
      t.set(ref, { holder, until: Date.now() + ms });
      return true;
    });
  }
  async take<T>(c: string, id: string) {
    const db = await this.db;
    const ref = db.collection(c).doc(id);
    return db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists) return null;
      t.delete(ref);
      return s.data() as T;
    });
  }
}

export const persistent = () => process.env.FIRESTORE === "1";

// On globalThis so every route bundle in the process shares one client (and one memory store).
const g = globalThis as { __earmarkStore?: Store };
g.__earmarkStore ??= persistent() ? new FirestoreStore() : new MemoryStore();
export const store: Store = g.__earmarkStore;
