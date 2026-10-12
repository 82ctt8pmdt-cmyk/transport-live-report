import { createPointerReader, downloadReport, readCachedReport, saveCachedReport } from "./loader.js?v=3";

const status = document.querySelector("#status");
let settings;
let active;
let activeVersion;
let activeHash;
let checking = false;
let failures = 0;
let pointerReader;
let recoveryRequested = false;

function message(title, detail) {
  status.classList.toggle("loaded", Boolean(active));
  status.querySelector("strong").textContent = title;
  status.querySelector("p").textContent = detail;
  status.hidden = false;
  status.querySelector("progress").hidden = true;
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
    const timeout = setTimeout(() => reject(new Error("Frame unavailable")), 30000);
    frame.onload = () => { clearTimeout(timeout); resolve(); };
    frame.onerror = () => { clearTimeout(timeout); reject(new Error("Frame unavailable")); };
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
      if (Date.now() > deadline) throw new Error("Report did not render");
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
    settings ??= await (await fetch("./config.json", { cache: "no-store", credentials: "omit" })).json();
    pointerReader ??= createPointerReader(settings.pointerUrl);
    const pointer = await pointerReader.read({ recover: recoveryRequested });
    recoveryRequested = false;
    if (Date.now() - Date.parse(pointer.updatedAt) > 180000) {
      message("Компьютер владельца недоступен", active ? "Показана последняя загруженная версия. Обновление возобновится автоматически." : "Отчёт откроется автоматически, когда компьютер будет в сети.");
      return;
    }
    if (pointer.version !== activeVersion) {
      if (active && activeHash === pointer.standaloneSha256) {
        activeVersion = pointer.version;
        document.documentElement.dataset.reportVersion = pointer.version;
      } else {
        message("Проверка актуальной версии…", "");
        let bytes = await readCachedReport(pointer);
        const fromCache = Boolean(bytes);
        if (!bytes) bytes = await downloadReport(pointer, { onProgress: progress });
        message("Открываем отчёт…", "Данные проверены.");
        await showReport(new TextDecoder().decode(bytes), pointer);
        document.documentElement.dataset.reportLoadSource = fromCache ? "browser-cache" : "mac";
        if (!fromCache) void saveCachedReport(pointer, bytes);
      }
    }
    failures = 0;
    status.hidden = true;
  } catch (error) {
    recoveryRequested = true;
    console.warn("Transport report load failed:", error.message);
    failures++;
    if (failures >= 2 || !active) message("Соединение с компьютером…", active
      ? "Показана последняя загруженная версия. Повторяем подключение автоматически."
      : "Повторяем подключение автоматически. Компьютер владельца должен быть включён и подключён к интернету.");
  } finally {
    checking = false;
    if (failures && !active) setTimeout(refresh, 5000);
  }
}

setInterval(refresh, 15000);
window.addEventListener("online", refresh);
document.addEventListener("visibilitychange", refresh);
refresh();
