const cacheName = "transport-report-2026-09";
const maxReportBytes = 40 * 1024 * 1024;

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
