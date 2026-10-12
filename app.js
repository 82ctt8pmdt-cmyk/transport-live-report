import { ReportError, createPointerReader, readJson, resolveDelivery, loadDelivery, saveCachedReport } from "./loader.js?v=7";

const status = document.querySelector("#status");
let settings;
let active;
let activeVersion;
let activeHash;
let checking = false;
let failures = 0;
let pointerReader;
let activeResult;
let lastMacPointer;
document.documentElement.dataset.loaderStarted = "true";

function message(title, detail) {
  status.classList.toggle("loaded", Boolean(active));
  status.querySelector("strong").textContent = title;
  status.querySelector("p").textContent = detail;
  status.hidden = false;
  status.querySelector("progress").hidden = true;
}

function errorDetail(error) {
  const stages = { config: "настройки", manifest: "версия публикации", "channel-registry": "адрес канала Mac",
    download: "полный отчёт", integrity: "проверка хеша", render: "отображение данных" };
  return `${stages[error.stage] || "загрузка"} · ${error.code || "UNKNOWN"}${error.status ? ` · HTTP ${error.status}` : ""}: ${error.message}`;
}

function showSource(result) {
  if (result?.fallbackReason) {
    message(result.publishedBehindMac ? "Резервная версия; обновление с Mac не получено" : "Отчёт открыт из резервной публикации",
      `Версия ${activeVersion.slice(0, 12)}. ${errorDetail(result.fallbackReason)}. Проверка продолжится автоматически.`);
  } else status.hidden = true;
}

function progress(received, total) {
  const percent = total ? Math.min(100, Math.floor(received / total * 100)) : null;
  message(active ? "Обновление отчёта…" : "Загрузка отчёта…",
    total ? `${percent}% · ${(received / 1e6).toFixed(1)} из ${(total / 1e6).toFixed(1)} МБ`
      : `${(received / 1e6).toFixed(1)} МБ получено`);
  const bar = status.querySelector("progress");
  bar.hidden = false;
  if (total) { bar.max = total; bar.value = received; }
  else bar.removeAttribute("value");
}

async function showReport(html, pointer) {
  const frame = document.createElement("iframe");
  frame.className = "pending";
  frame.title = "Контроль транспорта за сентябрь 2026";
  frame.referrerPolicy = "no-referrer";
  // A real same-origin frame URL preserves the unmodified app's History API.
  const frameUrl = new URL("./frame.html", location.href);
  const current = active ? new URL(active.contentWindow.location.href) : new URL(location.href);
  frameUrl.search = current.search;
  frameUrl.searchParams.set("view", "1");
  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new ReportError("FRAME_TIMEOUT", "render", "Не загрузилась оболочка отчёта")), 15000);
    frame.onload = () => { clearTimeout(timeout); resolve(); };
    frame.onerror = () => { clearTimeout(timeout); reject(new ReportError("FRAME_NETWORK", "render", "Ошибка загрузки оболочки отчёта")); };
  });
  frame.src = frameUrl.href;
  document.body.append(frame);
  try {
    await opened;
    frame.onload = null;
    const doc = frame.contentDocument;
    doc.open();
    frame.contentWindow.history.replaceState(null, "", frameUrl.href);
    doc.write(html);
    doc.close();
    const deadline = Date.now() + 30000;
    while (!doc.querySelector("main article")) {
      if (Date.now() > deadline) throw new ReportError("RENDER_TIMEOUT", "render", "Данные получены, но отчёт не отобразился");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    frame.className = "";
    active?.remove();
    active = frame;
    activeVersion = pointer.version;
    activeHash = pointer.standaloneSha256;
    document.documentElement.dataset.reportVersion = pointer.version;
    document.documentElement.dataset.snapshotSha256 = pointer.snapshotSha256;
    status.hidden = true;
  } catch (error) {
    frame.remove();
    throw error;
  }
}

async function refresh() {
  if (checking || document.hidden) return;
  checking = true;
  try {
    if (!settings) {
      const configUrl = new URL("./config.json", location.href);
      configUrl.searchParams.set("t", Date.now());
      settings = await readJson(configUrl.href, { stage: "config" });
      if (!["static", "mac-first"].includes(settings.mode) || settings.manifestPath !== "./report-version.json") {
        settings = undefined;
        throw new ReportError("CONFIG_INVALID", "config", "Неизвестная схема публикации");
      }
    }
    message("Проверка опубликованной версии…", "");
    if (settings.mode === "mac-first") pointerReader ??= createPointerReader(settings.pointerUrl);
    const delivery = await resolveDelivery(settings, { pointerReader });
    const pointer = delivery.primary;
    if (delivery.source === "mac") lastMacPointer = pointer;
    if (active && delivery.fallbackReason && lastMacPointer?.standaloneSha256 === activeHash
      && pointer.standaloneSha256 !== activeHash) {
      throw new ReportError("CURRENT_SOURCE_UNVERIFIED", "channel-registry",
        "Канал Mac не подтверждён. Ранее загруженная версия сохранена; резерв имеет другой хеш");
    }
    if (pointer.version !== activeVersion) {
      if (active && activeHash === pointer.standaloneSha256) {
        activeVersion = pointer.version;
        document.documentElement.dataset.reportVersion = pointer.version;
        activeResult = { ...activeResult, pointer, publishedBehindMac: false, fallbackReason: delivery.fallbackReason };
      } else {
        message(delivery.source === "mac" ? "Загрузка с Mac…" : "Загрузка опубликованного отчёта…", "");
        const result = await loadDelivery(delivery, { onProgress: progress });
        message("Открываем отчёт…", "Данные проверены.");
        await showReport(new TextDecoder().decode(result.bytes), result.pointer);
        activeResult = result;
        document.documentElement.dataset.reportLoadSource = result.fromCache ? "browser-cache" : result.source;
        if (!result.fromCache) void saveCachedReport(result.pointer, result.bytes);
      }
    }
    if (delivery.fallbackReason && activeResult) activeResult.fallbackReason = delivery.fallbackReason;
    failures = 0;
    delete document.documentElement.dataset.reportError;
    showSource(activeResult);
  } catch (error) {
    console.warn("Transport report load failed:", error.code, error.stage, error.status);
    document.documentElement.dataset.reportError = JSON.stringify({ code: error.code || "UNKNOWN", stage: error.stage, status: error.status });
    failures++;
    message(active ? "Актуальность отчёта не подтверждена" : "Отчёт пока не загрузился",
      `${active ? `Показана ранее загруженная версия ${activeVersion.slice(0, 12)}. ` : ""}${errorDetail(error)}. Повторим автоматически.`);
  } finally {
    checking = false;
    if (failures && !active) setTimeout(refresh, 15000);
  }
}

setInterval(refresh, 15000);
window.addEventListener("online", refresh);
document.addEventListener("visibilitychange", refresh);
refresh();
