import { SettingHelp } from "./SettingHelp";
import { useEffect, useState } from "react";
import { browserNative } from "../browser/integration";
import { browserEnvironment, browserEnvironmentDefaults, type BrowserEnvironment } from "../browser/environment";
import { store, useAppState } from "../state/store";

type Props = { disabled: boolean; running: boolean; onDirtyChange?: (dirty: boolean) => void };

interface Profile {
  id: string;
  title: string;
  summary: string;
  badges: string[];
  env: BrowserEnvironment;
}

/** Ready-made profiles. Each one is a complete environment, so the cards stay
 * in sync with the individual controls below instead of being a second source
 * of truth. */
const PROFILES: Profile[] = [
  {
    id: "standard",
    title: "Стандартный",
    summary: "Повседневные задачи: встроенный браузер в панели, сайты видят обычный Chrome.",
    badges: ["Встроенный", "Панель", "Маркеры скрыты", "Рекомендуется"],
    env: { ...browserEnvironmentDefaults },
  },
  {
    id: "fast",
    title: "Быстрый",
    summary: "То же, но без скрытия маркеров: самый быстрый запуск и меньше памяти.",
    badges: ["Встроенный", "Панель", "Максимальная скорость", "Следы видны"],
    env: { ...browserEnvironmentDefaults, reduceAutomationSignals: false },
  },
  {
    id: "compatibility",
    title: "Совместимость",
    summary: "Установленный Google Chrome в обычном окне. Самый убедительный вариант для входов и капч.",
    badges: ["Google Chrome", "Окно", "Маркеры скрыты", "Пауза 150 мс"],
    env: { ...browserEnvironmentDefaults, engine: "chrome", display: "window", actionDelayMs: 150 },
  },
  {
    id: "private",
    title: "Приватный",
    summary: "Временные данные сайтов: входы не сохраняются после закрытия браузера.",
    badges: ["Встроенный", "Панель", "Без истории"],
    env: { ...browserEnvironmentDefaults, storage: "temporary", doNotTrack: true, protectWebRTC: true, serviceWorkers: "block" },
  },
];

const sameEnvironment = (a: BrowserEnvironment, b: BrowserEnvironment) => JSON.stringify(a) === JSON.stringify(b);

function speedLabel(env: BrowserEnvironment) {
  const base = env.display === "window"
    ? "Обычный запуск в окне"
    : env.reduceAutomationSignals
      ? "Обычный запуск, больше памяти"
      : "Самый быстрый запуск";
  return env.actionDelayMs > 0 ? `${base} · пауза ${env.actionDelayMs} мс` : base;
}

function summaryOf(env: BrowserEnvironment) {
  return {
    browser: env.engine === "chrome" ? "Google Chrome (установленный)" : "Chromium Enki (встроенный)",
    where: env.display === "window" ? "В обычном окне браузера" : "Во встроенной панели Enki",
    fingerprint: env.reduceAutomationSignals ? "Обычный Chrome, маркеры скрыты" : "Видны следы автоматизации",
    speed: speedLabel(env),
    storage: env.storage === "temporary" ? "Временные, до закрытия" : "Сохраняются между запусками",
  };
}

export function BrowserEnvironmentSettings({ disabled, running, onDirtyChange }: Props) {
  const app = useAppState();
  const saved = app.prefs.browser?.environment;
  const [draft, setDraft] = useState(() => browserEnvironment(saved));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { setDraft(browserEnvironment(saved)); }, [saved]);
  const locked = disabled || busy;
  const dirty = !sameEnvironment(draft, browserEnvironment(saved));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const activeProfile = PROFILES.find(profile => sameEnvironment(profile.env, draft))?.id ?? "custom";
  const summary = summaryOf(draft);
  const change = <K extends keyof BrowserEnvironment>(key: K, value: BrowserEnvironment[K]) => {
    setDraft(previous => ({ ...previous, [key]: value })); setNotice(""); setError("");
  };
  const select = <K extends keyof BrowserEnvironment>(key: K, label: string, hint: string, options: [BrowserEnvironment[K], string][]) =>
    <div className="setting-row"><div className="setting-label"><label htmlFor={`browser-env-${key}`}>{label}</label><SettingHelp topic={`browser.${key}`} title={label}/><small>{hint}</small></div><div className="setting-control"><select id={`browser-env-${key}`} value={String(draft[key])} disabled={locked} onChange={event => change(key, (key === "actionDelayMs" ? Number(event.target.value) : event.target.value) as BrowserEnvironment[K])}>{options.map(([value, text]) => <option key={String(value)} value={String(value)}>{text}</option>)}</select></div></div>;
  const toggle = (key: "doNotTrack" | "protectWebRTC" | "reduceAutomationSignals", label: string, hint: string) =>
    <div className="setting-row"><div className="setting-label"><label htmlFor={`browser-env-${key}`}>{label}</label><SettingHelp topic={`browser.${key}`} title={label}/><small>{hint}</small></div><div className="setting-control"><label className="switch-label"><input id={`browser-env-${key}`} type="checkbox" checked={draft[key]} disabled={locked} onChange={event => change(key, event.target.checked)}/><span>{draft[key] ? "Включено" : "Выключено"}</span></label></div></div>;
  const text = (key: "locale" | "timezone", label: string, hint: string, placeholder: string) =>
    <div className="setting-row engine-field-row"><div className="setting-label"><label htmlFor={`browser-env-${key}`}>{label}</label><SettingHelp topic={`browser.${key}`} title={label}/><small>{hint}</small></div><div className="setting-control"><input id={`browser-env-${key}`} value={draft[key]} maxLength={100} placeholder={placeholder} disabled={locked} onChange={event => change(key, event.target.value)}/></div></div>;
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      // Validate before persisting, even when the service is currently stopped.
      const environment = { ...draft, locale: draft.locale.trim(), timezone: draft.timezone.trim() };
      if (environment.locale) environment.locale = Intl.getCanonicalLocales(environment.locale)[0];
      if (environment.timezone) new Intl.DateTimeFormat("en", { timeZone: environment.timezone });
      const result = running ? await browserNative<{pending?:number}>("browser_input", {action:"preferences", args:{environment}}) : undefined;
      store.setBrowserSettings({environment});
      setDraft(environment);
      setNotice(result?.pending ? `Сохранено. Открытых браузеров со старым профилем: ${result.pending}.` : "Сохранено. Профиль применится к новым браузерам.");
    } catch (error) { setError(error instanceof RangeError ? "Проверьте язык и часовой пояс." : error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="setting-group" aria-label="Профиль браузера">
    <h2>Профиль браузера <SettingHelp topic="browser.presets" title="Профили браузера"/></h2>
    <p className="settings-intro">Профиль решает, какая программа откроет сайт, где будет окно, что увидит сайт и насколько быстро работают действия агента. Выберите готовый профиль или настройте пункты ниже — изменения применятся к новым браузерам после «Сохранить профиль».</p>
    <div className="browser-profiles" role="radiogroup" aria-label="Готовые профили браузера">
      {PROFILES.map(profile => <button key={profile.id} type="button" role="radio" aria-checked={activeProfile === profile.id} className={`browser-profile${activeProfile === profile.id ? " is-active" : ""}`} disabled={locked} onClick={() => { setDraft(profile.env); setError(""); setNotice(`Профиль «${profile.title}» выбран. Проверьте сводку и нажмите «Сохранить профиль».`); }}>
        <strong>{profile.title}</strong>
        <span className="browser-profile-summary">{profile.summary}</span>
        <span className="browser-profile-badges">{profile.badges.map(badge => <span key={badge} className="browser-profile-badge">{badge}</span>)}</span>
      </button>)}
    </div>
    <div className="browser-summary" role="status" aria-label="Что получится">
      {([["Браузер", summary.browser], ["Где открывается", summary.where], ["Что видят сайты", summary.fingerprint], ["Скорость", summary.speed], ["Данные сайтов", summary.storage]] as const).map(([label, value]) => <div className="browser-summary-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
    {activeProfile === "custom" && <p className="browser-hint" role="status">Настройки изменены вручную: это свой набор, а не один из готовых профилей.</p>}
    <details className="settings-disclosure browser-advanced"><summary>Настроить профиль вручную</summary>
    <div className="setting-card browser-env-card">
      <h3 className="browser-group-title">Браузер и окно</h3>
      {select("engine", "Браузер", "Chromium Enki — встроенный, ничего устанавливать не нужно. Google Chrome — внешний браузер, установленный на компьютере.", [["chromium", "Chromium Enki (встроенный)"], ["chrome", "Google Chrome (установленный)"]])}
      {select("display", "Где открывается", "Панель — внутри Enki без отдельного окна. Окно — отдельное окно браузера, удобно для ручного входа.", [["embedded", "Во встроенной панели"], ["window", "В обычном окне"]])}
      <h3 className="browser-group-title">Скорость</h3>
      {select("actionDelayMs", "Пауза перед действием агента", "Замедляет только действия агента, не ручную работу. Больше пауза — меньше похоже на робота, но медленнее.", [[0, "Без дополнительной паузы"], [150, "150 мс"], [350, "350 мс"], [700, "700 мс"]])}
      <h3 className="browser-group-title">Что видят сайты</h3>
      {toggle("reduceAutomationSignals", "Скрывать маркеры автоматизации", "Скрывает webdriver и «Headless», подменяет UA, добавляет плагины. Запуск чуть медленнее, больше памяти. Не обходит CAPTCHA и не меняет IP.")}
      {toggle("doNotTrack", "Отправлять Do Not Track", "Просит сайты не отслеживать. Многие запросы игнорируют.")}
      {toggle("protectWebRTC", "Ограничить WebRTC", "Ограничивает прямые UDP-соединения. Может сломать видеозвонки.")}
      {select("serviceWorkers", "Service Workers", "Фоновая работа сайтов: кэш, офлайн-режим, уведомления.", [["allow", "Разрешить"], ["block", "Блокировать"]])}
      <h3 className="browser-group-title">Данные и оформление</h3>
      {select("storage", "Данные сайтов", "Постоянные сохраняют входы между запусками. Временные действуют до закрытия.", [["persistent", "Сохранять отдельно для каждой сессии"], ["temporary", "Временный профиль до закрытия браузера"]])}
      {text("locale", "Язык сайтов", "Пусто — системный. Например, ru-RU или en-US.", "Системный · ru-RU, en-US")}
      {text("timezone", "Часовой пояс", "Пусто — системный. Например, Europe/Moscow.", "Системный · Europe/Moscow")}
      {select("colorScheme", "Тема сайтов", "Тема, которую запрашивают сайты.", [["system", "Системная"], ["light", "Светлая"], ["dark", "Тёмная"]])}
      {select("reducedMotion", "Анимации сайтов", "Просьба уменьшить движение для поддерживающих сайтов.", [["no-preference", "Как на сайте"], ["reduce", "Уменьшить движение"]])}
    </div>
    </details>
    <div className="settings-actions">
      <button className="btn primary" disabled={locked || !dirty} onClick={() => void save()}>{busy ? "Сохраняю…" : "Сохранить профиль"}</button>
      <button className="btn" disabled={locked} onClick={() => { setDraft({...browserEnvironmentDefaults}); setNotice(""); setError(""); }}>Сбросить профиль</button>
    </div>
    <p className="settings-muted" role="status">{notice}</p>
    {error && <p className="settings-inline-error" role="alert">{error}</p>}
  </section>;
}
