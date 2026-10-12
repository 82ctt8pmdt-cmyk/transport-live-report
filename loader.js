const cacheName = "transport-report-2026-09";
const maxReportBytes = 40 * 1024 * 1024;

export function validPointer(value) {
  return value?.schemaVersion === 1 && /^https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)$/.test(value.url)
    && /^[a-f0-9]{64}$/.test(value.version) && /^[a-f0-9]{64}$/.test(value.standaloneSha256)
    && /^[a-f0-9]{64}$/.test(value.snapshotSha256) && Number.isFinite(Date.parse(value.updatedAt));
}

export function createPointerReader(pointerUrl, { fetcher = fetch, now = Date.now } = {}) {
  const raw = new URL(pointerUrl);
  const gistId = /^\/[^/]+\/([a-f0-9]{32})\/raw\/report.json$/.exec(raw.pathname)?.[1];
  if (raw.hostname !== "gist.githubusercontent.com" || !gistId) throw new Error("Invalid address registry");
  let newest;
  let lastRecovery = -Infinity;
  function adopt(value) {
    if (!validPointer(value)) throw new Error("Invalid report address");
    if (!newest || Date.parse(value.updatedAt) >= Date.parse(newest.updatedAt)) newest = value;
  }
  async function json(url) {
    const response = await fetcher(url, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Address unavailable");
    return response.json();
  }
  return { async read({ recover = false } = {}) {
    let failure;
    raw.searchParams.set("t", now());
    try { adopt(await json(raw.href)); }
    catch (error) { failure = error; }
    // Raw-file caches may lag after a reconnect. Use the public API only on
    // failure/staleness, at most once per minute; never put a token in the page.
    if ((recover || failure || !newest || now() - Date.parse(newest.updatedAt) > 180000)
      && now() - lastRecovery >= 60000) {
      lastRecovery = now();
      try {
        const gist = await json(`https://api.github.com/gists/${gistId}?t=${now()}`);
        adopt(JSON.parse(gist.files["report.json"].content));
      } catch (error) { failure = error; }
    }
    if (!newest) throw failure || new Error("Address unavailable");
    return newest;
  } };
}

export async function verifyBytes(bytes, expectedHash) {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expectedHash) throw new Error("Report integrity mismatch");
  return bytes;
}

export async function downloadReport(pointer, { onProgress = () => {}, fetcher = fetch,
  timeoutMs = 180000, stallMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  let complete = false;
  try {
    const response = await fetcher(`${pointer.url}/__report/standalone?version=${pointer.version}`, {
      cache: "no-store", credentials: "omit", signal: controller.signal
    });
    if (!response.ok) throw new Error(`Report connection returned ${response.status}`);
    const total = Number.isSafeInteger(pointer.standaloneBytes) ? pointer.standaloneBytes : null;
    if (total && (total < 1 || total > maxReportBytes)) throw new Error("Unexpected report size");
    onProgress(0, total);
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      let stalled;
      const next = await Promise.race([reader.read(), new Promise((_, reject) => {
        stalled = setTimeout(() => { controller.abort(); reject(new Error("Report download stalled")); }, stallMs);
      })]).finally(() => clearTimeout(stalled));
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxReportBytes || (total && size > total)) throw new Error("Unexpected report size");
      chunks.push(next.value);
      onProgress(size, total);
    }
    if (total && size !== total) throw new Error("Incomplete report download");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    await verifyBytes(bytes.buffer, pointer.standaloneSha256);
    complete = true;
    return bytes.buffer;
  } finally {
    clearTimeout(timeout);
    if (!complete) { controller.abort(); await reader?.cancel().catch(() => {}); }
    reader?.releaseLock();
  }
}

function cachedValue(mode, value) {
  return new Promise(resolve => {
    let db;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      db?.close();
      resolve(result ?? null);
    };
    const timeout = setTimeout(() => finish(null), 2000);
    try {
      const opened = indexedDB.open(cacheName, 1);
      opened.onupgradeneeded = () => opened.result.createObjectStore("report");
      opened.onerror = () => finish(null);
      opened.onblocked = () => finish(null);
      opened.onsuccess = () => {
        db = opened.result;
        if (settled) { db.close(); return; }
        const transaction = db.transaction("report", mode);
        const store = transaction.objectStore("report");
        const request = mode === "readonly" ? store.get("current") : store.put(value, "current");
        let result;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => finish(result);
        transaction.onerror = () => finish(null);
        transaction.onabort = () => finish(null);
      };
    } catch { finish(null); }
  });
}

export async function readCachedReport(pointer) {
  const cached = await cachedValue("readonly");
  if (cached?.sha256 !== pointer.standaloneSha256 || !(cached.bytes instanceof ArrayBuffer)) return null;
  try { return await verifyBytes(cached.bytes, pointer.standaloneSha256); }
  catch { return null; }
}

export async function saveCachedReport(pointer, bytes) {
  await cachedValue("readwrite", { sha256: pointer.standaloneSha256, bytes });
}
