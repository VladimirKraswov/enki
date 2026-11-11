async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}
const el = (id) => document.getElementById(id);
const text = (value) => document.createTextNode(String(value ?? "—"));
const row = (label, value) => {
  const div = document.createElement("div"); div.className = "kv";
  const a = document.createElement("span"); a.textContent = label;
  const b = document.createElement("b"); b.append(text(value));
  div.append(a, b); return div;
};

async function loadOverview() {
  const data = await api("/api/console/overview");
  const channels = el("channels"); channels.replaceChildren();
  for (const [name, info] of Object.entries(data.channels || {})) {
    const card = document.createElement("div"); card.className = "card";
    const h = document.createElement("h3"); h.append(text(name === "stable" ? "Стабильный канал" : "Предварительный"));
    card.append(h, row("Версия", info.version || "нет"), row("Доступно", info.available ? "да" : "нет"));
    channels.append(card);
  }
  const devices = el("devices"); devices.replaceChildren();
  for (const device of data.devices || []) {
    const card = document.createElement("div"); card.className = "card";
    card.append(row("Устройство", device.name || device.id),
      row("Платформа", device.platform || "—"),
      row("Enki", device.appVersion || "—"),
      row("Статус", device.revoked ? "отозван" : device.admin ? "администратор" : "устройство"),
      row("Активность", device.seen ? new Date(device.seen).toLocaleString("ru-RU") : "—"));
    devices.append(card);
  }
  const services = el("services"); services.replaceChildren();
  for (const service of data.services || []) {
    services.append(row(`${service.id} · ${service.label}`, service.kind === "fixed" ? `фиксированная модель ${service.model}` : "шлюз с выбором модели"));
  }
  if (data.serviceError) services.append(row("Сервисы моделей", data.serviceError));
  el("catalog").replaceChildren(row("Моделей в каталоге Hub", (data.catalogModels || []).length));
  const cred = el("credentials"); cred.replaceChildren();
  cred.append(row("Провайдеры с кредами на Hub", (data.credentialProviders || []).join(", ") || "нет"));
  el("overview").hidden = false;
  el("login").hidden = true;
  el("who").textContent = "локальная сеть";
  el("refresh").hidden = false;
}

el("refresh").addEventListener("click", () => { void loadOverview().catch(error => alert(error.message)); });
void loadOverview().catch(error => { el("who").textContent = error.message; });
