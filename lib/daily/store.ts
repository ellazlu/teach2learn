// Shared persistence for L2T Daily (server only). The smallest store that
// works across users:
// - Redis over REST when configured (Upstash, or Vercel KV which exposes the
//   same API): UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN.
// - Otherwise a JSON file on the server's disk (DAILY_DATA_FILE, default
//   .data/l2t-daily.json). Fine for `next dev`/a single Node server; on
//   serverless hosting configure Redis, since instances don't share a disk.
// Never the browser's localStorage.

export interface DailyStore {
  kind: 'redis' | 'file' | 'memory';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  setNX(key: string, value: string, ttlSec?: number): Promise<boolean>; // true if it was set
  incr(key: string, ttlSec?: number): Promise<number>;
  rpush(key: string, value: string, ttlSec?: number): Promise<number>;
  lrange(key: string): Promise<string[]>;
  hset(key: string, field: string, value: string, ttlSec?: number): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
}

// ---- Redis REST -------------------------------------------------------------------

export function redisStore(url: string, token: string, fetchImpl: typeof fetch = fetch): DailyStore {
  const cmd = async (...args: (string | number)[]) => {
    const res = await fetchImpl(url.replace(/\/$/, ''), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`leaderboard storage error: ${data.error || res.status}`);
    return data.result;
  };
  const expire = (key: string, ttl?: number) => (ttl ? cmd('EXPIRE', key, ttl) : Promise.resolve());
  return {
    kind: 'redis',
    get: (k) => cmd('GET', k),
    set: async (k, v, ttl) => void (await (ttl ? cmd('SET', k, v, 'EX', ttl) : cmd('SET', k, v))),
    setNX: async (k, v, ttl) => (await (ttl ? cmd('SET', k, v, 'NX', 'EX', ttl) : cmd('SET', k, v, 'NX'))) === 'OK',
    incr: async (k, ttl) => {
      const n = Number(await cmd('INCR', k));
      if (n === 1) await expire(k, ttl);
      return n;
    },
    rpush: async (k, v, ttl) => {
      const n = Number(await cmd('RPUSH', k, v));
      if (n === 1) await expire(k, ttl);
      return n;
    },
    lrange: async (k) => (await cmd('LRANGE', k, 0, -1)) || [],
    hset: async (k, f, v, ttl) => {
      await cmd('HSET', k, f, v);
      await expire(k, ttl);
    },
    hgetall: async (k) => {
      const flat: string[] = (await cmd('HGETALL', k)) || [];
      const out: Record<string, string> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
      return out;
    },
  };
}

// ---- In-memory (tests) and file-backed (single server) ------------------------------------

interface Data { kv: Record<string, { v: any; exp: number | null }> }

function mapStore(load: () => Promise<Data>, save: (d: Data) => Promise<void>, kind: 'file' | 'memory', now = () => Date.now()): DailyStore {
  let chain: Promise<unknown> = Promise.resolve();
  // Serialize every operation so concurrent requests can't interleave writes.
  const op = <T>(fn: (d: Data) => T, write: boolean): Promise<T> => {
    const run = chain.then(async () => {
      const d = await load();
      for (const [k, e] of Object.entries(d.kv)) if (e.exp !== null && e.exp <= now()) delete d.kv[k];
      const out = fn(d);
      if (write) await save(d);
      return out;
    });
    chain = run.catch(() => {});
    return run;
  };
  const exp = (ttl?: number) => (ttl ? now() + ttl * 1000 : null);
  return {
    kind,
    get: (k) => op((d) => (d.kv[k] ? String(d.kv[k].v) : null), false),
    set: (k, v, ttl) => op((d) => void (d.kv[k] = { v, exp: exp(ttl) }), true),
    setNX: (k, v, ttl) => op((d) => (d.kv[k] ? false : ((d.kv[k] = { v, exp: exp(ttl) }), true)), true),
    incr: (k, ttl) => op((d) => {
      const cur = d.kv[k];
      const n = (cur ? Number(cur.v) : 0) + 1;
      d.kv[k] = { v: n, exp: cur ? cur.exp : exp(ttl) };
      return n;
    }, true),
    rpush: (k, v, ttl) => op((d) => {
      const cur = d.kv[k] || { v: [], exp: exp(ttl) };
      cur.v = [...cur.v, v];
      d.kv[k] = cur;
      return cur.v.length;
    }, true),
    lrange: (k) => op((d) => (d.kv[k] ? [...d.kv[k].v] : []), false),
    hset: (k, f, v, ttl) => op((d) => {
      const cur = d.kv[k] || { v: {}, exp: null };
      cur.v = { ...cur.v, [f]: v };
      cur.exp = exp(ttl) ?? cur.exp;
      d.kv[k] = cur;
    }, true),
    hgetall: (k) => op((d) => ({ ...(d.kv[k]?.v || {}) }), false),
  };
}

export function memoryStore(now?: () => number): DailyStore {
  const data: Data = { kv: {} };
  return mapStore(async () => data, async () => {}, 'memory', now);
}

export function fileStore(file: string): DailyStore {
  const load = async (): Promise<Data> => {
    const fs = await import('node:fs/promises');
    try {
      const d = JSON.parse(await fs.readFile(file, 'utf8'));
      return d && d.kv ? d : { kv: {} };
    } catch {
      return { kv: {} };
    }
  };
  const save = async (d: Data) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(d));
    await fs.rename(tmp, file); // atomic replace
  };
  return mapStore(load, save, 'file');
}

let cached: DailyStore | null = null;
export function getStore(): DailyStore {
  if (cached) return cached;
  const env = (globalThis as any).process?.env || {};
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  cached = url && token ? redisStore(url, token) : fileStore(env.DAILY_DATA_FILE || '.data/l2t-daily.json');
  return cached;
}
export const setStoreForTests = (s: DailyStore | null) => void (cached = s);
