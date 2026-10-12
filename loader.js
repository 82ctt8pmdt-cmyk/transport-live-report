const cacheName = "transport-report-2026-09";
const maxReportBytes = 40 * 1024 * 1024;

export class ReportError extends Error {
  constructor(code, stage, message, status) {
    super(message);
    this.name = "ReportError";
    Object.assign(this, { code, stage, status });
  }
}

export async function readJson(url, { fetcher = fetch, timeoutMs = 10000, stage = "registry" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
    if (!response.ok) throw new ReportError("HTTP", stage, `HTTP ${response.status}`, response.status);
    const text = await response.text();
    if (text.length > 1000000 || /^\s*</.test(text)) {
      throw new ReportError("METADATA_CONTENT", stage, "Вместо метаданных получена другая страница");
    }
    try { return JSON.parse(text); }
    catch { throw new ReportError("METADATA_JSON", stage, "Некорректный JSON"); }
  } catch (error) {
    if (error instanceof ReportError) throw error;
    if (controller.signal.aborted) throw new ReportError("TIMEOUT", stage, "Истекло время ожидания");
    throw new ReportError("NETWORK", stage, "Сетевая ошибка; DNS, TLS и CORS требуют проверки в браузере");
  } finally { clearTimeout(timer); }
}

export async function readStaticManifest(manifestUrl, { fetcher = fetch } = {}) {
  const address = new URL(manifestUrl);
  if (!["http:", "https:"].includes(address.protocol)) throw new Error("Invalid report registry");
  address.searchParams.set("t", Date.now());
  const value = await readJson(address.href, { fetcher, stage: "manifest" });
  if (value?.schemaVersion !== 1 || value.mode !== "static"
    || !/^[a-f0-9]{64}$/.test(value.version) || !/^[a-f0-9]{64}$/.test(value.standaloneSha256)
    || !/^[a-f0-9]{64}$/.test(value.snapshotSha256)
    || !Number.isSafeInteger(value.standaloneBytes) || value.standaloneBytes < 1 || value.standaloneBytes > maxReportBytes
    || value.reportPath !== `reports/${value.standaloneSha256}.html`) throw new ReportError("MANIFEST_INVALID", "manifest", "Invalid report registry");
  return { ...value, reportUrl: new URL(value.reportPath, address).href };
}

export function validPointer(value) {
  return value?.schemaVersion === 1 && /^https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)$/.test(value.url)
    && /^[a-f0-9]{64}$/.test(value.version) && /^[a-f0-9]{64}$/.test(value.standaloneSha256)
    && /^[a-f0-9]{64}$/.test(value.snapshotSha256) && Number.isFinite(Date.parse(value.updatedAt))
    && Number.isSafeInteger(value.standaloneBytes) && value.standaloneBytes > 0 && value.standaloneBytes <= maxReportBytes;
}

export function createPointerReader(pointerUrl, { fetcher = fetch, now = Date.now } = {}) {
  const raw = new URL(pointerUrl);
  const gistId = /^\/[^/]+\/([a-f0-9]{32})\/raw\/report.json$/.exec(raw.pathname)?.[1];
  if (raw.hostname !== "gist.githubusercontent.com" || !gistId) throw new Error("Invalid address registry");
  let newest;
  function adopt(value) {
    if (!validPointer(value)) throw new Error("Invalid report address");
    if (!newest || Date.parse(value.updatedAt) >= Date.parse(newest.updatedAt)) newest = value;
  }
  return { async read() {
    raw.searchParams.set("t", now());
    adopt(await readJson(raw.href, { fetcher, timeoutMs: 4000, stage: "channel-registry" }));
    return newest;
  } };
}

export async function resolveDelivery(settings, { baseUrl = location.href, fetcher = fetch, pointerReader, now = Date.now } = {}) {
  let fallback;
  let manifestError;
  try { fallback = await readStaticManifest(new URL(settings.manifestPath, baseUrl), { fetcher }); }
  catch (error) { manifestError = error; }
  if (settings.mode === "mac-first") {
    try {
      const primary = await pointerReader.read();
      const age = now() - Date.parse(primary.updatedAt);
      if (age > 180000 || age < -60000) throw new ReportError("CHANNEL_STALE", "channel-registry", "Адрес канала не подтверждён свежей записью");
      return { primary, fallback, source: "mac", registryError: manifestError };
    } catch (error) {
      if (!fallback) {
        throw new ReportError("REGISTRIES_UNAVAILABLE", "manifest",
          `Публикация: ${manifestError?.code || "UNKNOWN"}${manifestError?.status ? ` HTTP ${manifestError.status}` : ""}; канал Mac: ${error.code || "UNKNOWN"}`);
      }
      return { primary: fallback, source: "github-pages", fallbackReason: error };
    }
  }
  if (!fallback) throw manifestError;
  return { primary: fallback, source: "github-pages" };
}

export async function loadDelivery(delivery, { load = downloadReport, readCache = readCachedReport, onProgress = () => {} } = {}) {
  async function obtain(pointer, source) {
    const cached = await readCache(pointer);
    const bytes = cached || await load(pointer, { onProgress, timeoutMs: source === "mac" ? 12000 : 60000,
      stallMs: source === "mac" ? 6000 : 15000 });
    return { bytes, pointer, source, fromCache: Boolean(cached) };
  }
  try { return { ...await obtain(delivery.primary, delivery.source), fallbackReason: delivery.fallbackReason }; }
  catch (error) {
    if (!delivery.fallback || delivery.source !== "mac") throw error;
    return { ...await obtain(delivery.fallback, "github-pages"), fallbackReason: error,
      publishedBehindMac: delivery.fallback.standaloneSha256 !== delivery.primary.standaloneSha256 };
  }
}

export async function verifyBytes(bytes, expectedHash) {
  if (!crypto?.subtle) throw new ReportError("BROWSER_UNSUPPORTED", "integrity", "Недоступна безопасная проверка SHA-256 в браузере");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expectedHash) throw new ReportError("HASH_MISMATCH", "integrity", "Report integrity mismatch");
  return bytes;
}

export async function downloadReport(pointer, { onProgress = () => {}, fetcher = fetch,
  timeoutMs = 180000, stallMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  let complete = false;
  try {
    const response = await fetcher(pointer.reportUrl || `${pointer.url}/__report/standalone?version=${pointer.version}`, {
      cache: "no-store", credentials: "omit", signal: controller.signal
    });
    if (!response.ok) throw new ReportError("HTTP", "download", `Report connection returned ${response.status}`, response.status);
    const total = Number.isSafeInteger(pointer.standaloneBytes) ? pointer.standaloneBytes : null;
    if (total && (total < 1 || total > maxReportBytes)) throw new Error("Unexpected report size");
    onProgress(0, total);
    if (!response.body?.getReader) throw new ReportError("BROWSER_UNSUPPORTED", "download", "Браузер не поддерживает потоковую загрузку отчёта");
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      let stalled;
      const next = await Promise.race([reader.read(), new Promise((_, reject) => {
        stalled = setTimeout(() => { controller.abort(); reject(new ReportError("STALL", "download", "Report download stalled")); }, stallMs);
      })]).finally(() => clearTimeout(stalled));
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxReportBytes || (total && size > total)) throw new Error("Unexpected report size");
      chunks.push(next.value);
      onProgress(size, total);
    }
    if (total && size !== total) throw new ReportError("INCOMPLETE", "download", "Incomplete report download");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    await verifyBytes(bytes.buffer, pointer.standaloneSha256);
    complete = true;
    return bytes.buffer;
  } catch (error) {
    if (error instanceof ReportError) throw error;
    if (controller.signal.aborted) throw new ReportError("TIMEOUT", "download", "Истекло время загрузки отчёта");
    if (error instanceof TypeError) throw new ReportError("NETWORK", "download", "Сетевая ошибка; DNS, TLS и CORS требуют проверки в браузере");
    throw error;
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
