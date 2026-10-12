const status = document.querySelector("#status");
let settings;
let active;
let activeVersion;
let checking = false;
let failures = 0;

function message(title, detail) {
  status.classList.toggle("loaded", Boolean(active));
  status.querySelector("strong").textContent = title;
  status.querySelector("p").textContent = detail;
  status.hidden = false;
}

export function validPointer(value) {
  return value?.schemaVersion === 1 && /^https:\/\/[a-z0-9-]+\.(?:lhr\.life|localhost\.run)$/.test(value.url)
    && /^[a-f0-9]{64}$/.test(value.version) && /^[a-f0-9]{64}$/.test(value.standaloneSha256)
    && /^[a-f0-9]{64}$/.test(value.snapshotSha256)
    && Number.isFinite(Date.parse(value.updatedAt));
}

async function readPointer() {
  const url = new URL(settings.pointerUrl);
  url.searchParams.set("t", Date.now());
  const response = await fetch(url, { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Address unavailable");
  const pointer = await response.json();
  if (!validPointer(pointer)) throw new Error("Invalid report address");
  return pointer;
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
    const pointer = await readPointer();
    if (Date.now() - Date.parse(pointer.updatedAt) > 180000) {
      message("Компьютер владельца недоступен", active ? "Показана последняя загруженная версия. Обновление возобновится автоматически." : "Отчёт откроется автоматически, когда компьютер будет в сети.");
      return;
    }
    if (pointer.version !== activeVersion) {
      if (active) message("Обновление отчёта…", "Текущая версия остаётся доступной.");
      const response = await fetch(`${pointer.url}/__report/standalone?version=${pointer.version}`, {
        cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(180000)
      });
      if (!response.ok) throw new Error("Computer unavailable");
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== pointer.standaloneSha256) throw new Error("Report integrity mismatch");
      await showReport(new TextDecoder().decode(bytes), pointer);
    }
    failures = 0;
    status.hidden = true;
  } catch {
    failures++;
    if (failures >= 2 || !active) message("Соединение с компьютером…", active
      ? "Показана последняя загруженная версия. Повторяем подключение автоматически."
      : "Повторяем подключение автоматически. Компьютер владельца должен быть включён и подключён к интернету.");
  } finally { checking = false; }
}

setInterval(refresh, 15000);
window.addEventListener("online", refresh);
document.addEventListener("visibilitychange", refresh);
refresh();
