/* Enki Remote — mobile-first LAN client. All model/chat content is text, never HTML. */
'use strict';

const $ = id => document.getElementById(id);
const state = {
  devices: [], deviceId: null, sessionId: null, overview: null, detail: null,
  signatures: {}, openTools: new Set(), busy: false, connected: false,
  sessionFilter: 'all', recorder: null, chunks: [], recordingTimer: null, toastTimer: null,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, action, primary = false) {
  const node = el('button', primary ? 'primary' : 'secondary', label);
  node.type = 'button'; node.addEventListener('click', action); return node;
}
function toast(message, error = false) {
  const node = $('toast'); node.textContent = message;
  node.className = error ? 'show error' : 'show';
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.className = '', 4500);
}
async function api(path, body) {
  const response = await fetch('/api/remote/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function currentDevice() { return state.devices.find(device => device.id === state.deviceId); }
function currentSession() { return state.overview?.sessions?.find(session => session.id === state.sessionId); }
function statusFor(id) { return state.overview?.statuses?.[id]?.type || 'idle'; }
function statusLabel(status) {
  return ({ idle: 'Свободна', busy: 'Работает', retry: 'Повтор', waiting: 'Ждёт ответа' })[status] || status;
}
function attention(sessionID) {
  return (state.overview?.questions || []).some(q => q.sessionID === sessionID)
    || (state.overview?.permissions || []).some(p => p.sessionID === sessionID);
}
function formatTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Only models whose provider is configured and whose actual access is available.
 * Unknown/unavailable/quota-disabled entries are not offered at all. */
function availableModels(overview = state.overview) {
  const connected = new Set(overview?.providers?.connected || []);
  const result = [];
  for (const provider of overview?.providers?.all || []) {
    if (provider.auth?.configured === false || (connected.size && !connected.has(provider.id))) continue;
    for (const [id, model] of Object.entries(provider.models || {})) {
      const available = model.access?.state ? model.access.state === 'available' : true;
      if (!available) continue;
      result.push({ providerID: provider.id, modelID: id, providerName: provider.name || provider.id,
        name: model.name || id, context: model.limit?.context || 0 });
    }
  }
  return result;
}
function fillModels(select, overview, selected) {
  const old = selected || select.value;
  const models = availableModels(overview);
  const signature = JSON.stringify([models.map(m => [m.providerID, m.modelID, m.name, m.context]), old]);
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature; select.replaceChildren();
  for (const model of models) {
    const option = el('option', '', `${model.name} · ${Math.round(model.context / 1024)}K`);
    option.value = model.providerID + '\n' + model.modelID; select.append(option);
  }
  if (old && [...select.options].some(option => option.value === old)) select.value = old;
  if (!models.length) { const option = el('option', '', 'Нет доступных моделей'); option.value = ''; select.append(option); }
}
function selectModel(select = $('model')) {
  if (!select.value) return null;
  const [providerID, ...rest] = select.value.split('\n');
  return { providerID, modelID: rest.join('\n') };
}

async function loadOverview() {
  try {
    const data = await api('overview');
    state.devices = data.devices; state.connected = true;
    $('connection').className = 'connection online'; $('connection').title = 'Hub на связи';
    if (!currentDevice()) state.deviceId = data.devices.find(device => device.online)?.id || data.devices[0]?.id || null;
    const device = currentDevice(); state.overview = device?.overview || null;
    if (state.deviceId) localStorage.setItem('enki.remote.device', state.deviceId);
    if (state.overview && !currentSession()) state.sessionId = state.overview.sessions?.[0]?.id || null;
    renderDevices(); renderHeader();
  } catch (error) {
    state.connected = false; $('connection').className = 'connection'; $('connection').title = 'Нет связи с Hub';
  }
}
function renderDevices() {
  const select = $('device-select');
  const signature = JSON.stringify(state.devices.map(device => [device.id, device.name, device.online, device.appVersion]));
  if (state.signatures.devices === signature || select.matches(':focus')) return;
  state.signatures.devices = signature; select.replaceChildren();
  for (const device of state.devices) {
    const option = el('option', '', `${device.name || 'Enki'} · ${device.online ? 'в сети' : 'офлайн'}`);
    option.value = device.id; select.append(option);
  }
  if (state.deviceId) select.value = state.deviceId;
  if (!state.devices.length) { const option = el('option', '', 'Нет устройств'); option.value = ''; select.append(option); }
}
async function chooseDevice(id) {
  state.deviceId = id; state.overview = currentDevice()?.overview || null;
  state.sessionId = state.overview?.sessions?.[0]?.id || null; state.detail = null;
  delete state.signatures.detail; delete state.signatures.models;
  renderHeader(); await selectSession(state.sessionId);
}
function renderHeader() {
  const session = currentSession();
  $('composer').hidden = !session; $('empty').hidden = !!session;
  $('session-title').textContent = session?.title || 'Выбрать сессию';
  $('session-path').textContent = session ? session.directory : currentDevice()?.name || '';
  const status = session ? statusFor(session.id) : null;
  $('session-status').textContent = session ? (attention(session.id) ? 'Нужен ответ' : statusLabel(status)) : '';
  $('session-status').className = 'status' + (status === 'busy' || status === 'retry' || attention(session?.id) ? ' busy' : '');
  if (session) {
    const selected = session.model ? session.model.providerID + '\n' + session.model.id : '';
    fillModels($('model'), state.overview, selected);
  }
}
async function selectSession(id) {
  state.sessionId = id; state.detail = null; delete state.signatures.detail;
  if (id) localStorage.setItem('enki.remote.session', id);
  renderHeader();
  const area = $('prompt'); area.value = id ? sessionStorage.getItem('enki.remote.draft.' + id) || '' : ''; resizeComposer();
  if (state.deviceId && id) { await api('watch', { device: state.deviceId, session: id }); await loadDetail(); }
}
async function loadDetail() {
  if (!state.deviceId || !state.sessionId) return;
  try {
    const data = await api(`session?device=${encodeURIComponent(state.deviceId)}&session=${encodeURIComponent(state.sessionId)}`);
    if (data.detail?.session === state.sessionId) { state.detail = data.detail; renderDetail(); }
  } catch (error) { /* retain the last confirmed view and retry next poll */ }
}
function renderDetail() {
  const detail = state.detail; if (!detail) return;
  const signature = JSON.stringify([detail.messages, detail.questions, detail.permissions, detail.queue, detail.status, detail.info]);
  if (state.signatures.detail === signature) return;
  state.signatures.detail = signature;
  renderMessages(detail.messages || []); renderInteractions(); renderQueue(detail.queue);
  if (detail.info?.model && !$('model').matches(':focus'))
    fillModels($('model'), state.overview, detail.info.model.providerID + '\n' + detail.info.model.id);
}
function renderMessages(messages) {
  const root = $('messages');
  const nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 220;
  if (!messages.length) {
    root.replaceChildren(); const empty = el('div', 'empty');
    empty.append(el('div', 'empty-mark', '⌁'), el('h1', '', currentSession()?.title || 'Сессия'), el('p', '', 'Напишите или надиктуйте первое задание.'));
    root.append(empty); return;
  }
  root.replaceChildren();
  for (const message of messages) {
    const item = el('article', `message ${message.info.role}${message.info.error ? ' error' : ''}`);
    item.append(el('div', 'message-role', message.info.role === 'user' ? 'Вы' : message.info.modelID || 'Enki'));
    const texts = (message.parts || []).filter(part => part.type === 'text' && part.text);
    if (texts.length) item.append(el('div', 'bubble', texts.map(part => part.text).join('\n\n')));
    for (const part of message.parts || []) {
      if (part.type === 'reasoning' && part.text) item.append(workDetails('Рассуждение', part.text, part.id));
      if (part.type === 'tool') {
        const status = part.state?.status || 'pending';
        const title = part.state?.title || part.tool || 'Инструмент';
        const output = [part.state?.error, part.state?.output].filter(Boolean).join('\n');
        item.append(workDetails(`${title} · ${status}`, output || 'Нет текстового вывода', part.callID || part.id, status === 'error'));
      }
    }
    if (message.info.error) item.append(el('div', 'bubble', typeof message.info.error === 'string' ? message.info.error : JSON.stringify(message.info.error)));
    root.append(item);
  }
  if (nearBottom) root.scrollTop = root.scrollHeight;
}
function workDetails(title, text, id, failed = false) {
  const detail = el('details', 'work'); detail.open = state.openTools.has(id);
  detail.addEventListener('toggle', () => detail.open ? state.openTools.add(id) : state.openTools.delete(id));
  detail.append(el('summary', failed ? 'tool-error' : '', title), el('pre', '', text)); return detail;
}
function renderInteractions() {
  const root = $('alerts'); root.replaceChildren();
  for (const request of state.detail?.questions || []) {
    const card = el('section', 'alert-card'); card.append(el('h3', '', 'Нужен ваш ответ'));
    const form = el('form', 'question-form');
    request.questions.forEach((question, index) => {
      if (question.context) form.append(el('p', 'context', question.context));
      form.append(el('p', '', question.question));
      for (const option of question.options || []) {
        const label = el('label'), input = el('input'); input.type = question.multiple ? 'checkbox' : 'radio';
        input.name = `q-${request.id}-${index}`; input.value = option.label;
        const wrapper = el('span'); wrapper.append(document.createTextNode(option.label));
        if (option.description) wrapper.append(el('small', 'muted', ' ' + option.description));
        label.append(input, wrapper); form.append(label);
      }
      if (question.custom !== false) {
        const custom = el('textarea'); custom.name = `custom-${index}`; custom.rows = 2;
        custom.placeholder = question.options?.length ? 'Свой вариант (необязательно)' : 'Ваш ответ'; form.append(custom);
      }
    });
    const submit = el('button', 'primary wide', 'Ответить'); submit.type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      const answers = request.questions.map((question, index) => {
        const selected = [...form.querySelectorAll(`input[name="q-${request.id}-${index}"]:checked`)].map(input => input.value);
        const custom = form.elements[`custom-${index}`]?.value?.trim(); if (custom) selected.push(custom); return selected;
      });
      void command('question.reply', { id: request.id, answers });
    });
    card.append(form, button('Отклонить', () => void command('question.reject', { id: request.id }))); root.append(card);
  }
  for (const request of state.detail?.permissions || []) {
    const card = el('section', 'alert-card');
    card.append(el('h3', '', 'Нужно разрешение'), el('p', '', `${request.permission}: ${(request.patterns || []).join(', ')}`));
    const row = el('div', 'answers');
    row.append(button('Разрешить', () => void command('permission.reply', { id: request.id, reply: 'once' }), true),
      button('Всегда', () => void command('permission.reply', { id: request.id, reply: 'always' })),
      button('Отказать', () => void command('permission.reply', { id: request.id, reply: 'reject' })));
    card.append(row); root.append(card);
  }
}
function renderQueue(queue) {
  const root = $('queue'); root.replaceChildren();
  for (const item of queue?.items || []) root.append(el('div', 'queue-item', `В очереди: ${item.text}`));
  for (const item of queue?.corrections || []) root.append(el('div', 'queue-item', `Уточнение: ${item.text} · ${item.state}`));
  if (queue?.pausedReason) root.append(button('Возобновить очередь', () => void command('queue.resume', { model: selectModel() })));
}

async function command(kind, payload, session = state.sessionId) {
  if (state.busy || !state.deviceId) return null;
  state.busy = true;
  try {
    const result = await api('command', { id: crypto.randomUUID(), device: state.deviceId, session, kind, payload });
    toast('Команда сохранена; ждём устройство…');
    setTimeout(loadDetail, 900); setTimeout(loadOverview, 1400); return result;
  } catch (error) { toast(error.message, true); return null; }
  finally { state.busy = false; }
}

function openSessions() {
  renderSessionResults(); $('sessions-dialog').showModal();
  setTimeout(() => $('session-search').focus(), 50);
}
function renderSessionResults() {
  const root = $('session-results'); root.replaceChildren();
  const search = $('session-search').value.trim().toLowerCase();
  let previousDirectory = null, count = 0;
  for (const session of state.overview?.sessions || []) {
    const status = statusFor(session.id), needs = attention(session.id);
    if (state.sessionFilter === 'busy' && status !== 'busy' && status !== 'retry') continue;
    if (state.sessionFilter === 'attention' && !needs && status !== 'waiting') continue;
    if (state.sessionFilter === 'workshop' && !session.workshop) continue;
    if (search && !(session.title + ' ' + session.directory).toLowerCase().includes(search)) continue;
    if (session.directory !== previousDirectory) {
      root.append(el('div', 'project-heading', session.directory)); previousDirectory = session.directory;
    }
    const item = el('button', 'session-option' + (session.id === state.sessionId ? ' current' : ''));
    const text = el('span', 'option-text'); text.append(el('strong', '', session.title || 'Новый чат'));
    text.append(el('small', '', `${session.workshop ? 'Мастерская · ' : ''}${formatTime(session.time?.updated)}`)); item.append(text);
    item.append(el('span', 'session-state' + (needs ? ' attention' : ''), needs ? 'Нужен ответ' : statusLabel(status)));
    item.addEventListener('click', async () => { $('sessions-dialog').close(); await selectSession(session.id); });
    root.append(item); count++;
  }
  if (!count) root.append(el('p', 'muted', 'Ничего не найдено. Измените поиск или фильтр.'));
}

function openNew() {
  const devices = $('new-device'); devices.replaceChildren();
  for (const device of state.devices.filter(device => device.online)) {
    const option = el('option', '', device.name || 'Enki'); option.value = device.id; devices.append(option);
  }
  if (state.deviceId && state.devices.find(device => device.id === state.deviceId)?.online) devices.value = state.deviceId;
  updateNewProject(); $('new-dialog').showModal();
}
function newOverview() { return state.devices.find(device => device.id === $('new-device').value)?.overview || null; }
function updateNewProject() {
  const overview = newOverview(), projects = $('new-project'); projects.replaceChildren();
  for (const directory of overview?.projects || []) { const option = el('option', '', directory); option.value = directory; projects.append(option); }
  fillModels($('new-model'), overview, '');
}
$('new-device').addEventListener('change', updateNewProject);
$('new-form').addEventListener('submit', async event => {
  event.preventDefault();
  const model = selectModel($('new-model')), prompt = $('new-prompt').value.trim();
  const device = $('new-device').value, directory = $('new-project').value;
  if (!model || !prompt || !device || !directory) return toast('Выберите компьютер, проект, модель и введите задание', true);
  try {
    const created = await api('command', { id: crypto.randomUUID(), device, session: null,
      kind: 'session.create', payload: { directory, model, prompt } });
    $('new-dialog').close(); toast('Создаю сессию на устройстве…');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const status = await api('command?id=' + encodeURIComponent(created.id));
      if (status.state === 'done' && status.result?.session?.id) {
        state.deviceId = device; await loadOverview(); await selectSession(status.result.session.id); return;
      }
      if (status.state === 'error') throw new Error(status.result?.error || 'Не удалось создать сессию');
    }
    toast('Сессия ещё создаётся. Откройте список через несколько секунд.');
  } catch (error) { toast(error.message, true); }
});

function renderSettings() {
  if (!$('settings-dialog').open) return;
  const settings = state.overview?.settings;
  const signature = JSON.stringify([settings, state.overview?.updates, availableModels()]);
  if (state.signatures.settings === signature) return;
  state.signatures.settings = signature;
  const root = $('settings-content'); root.replaceChildren();
  if (!settings) { root.append(el('p', '', 'Устройство офлайн. Настройки недоступны.')); return; }
  const grid = el('div', 'settings-grid');
  const policy = el('div', 'setting'); policy.append(el('p', 'muted', 'Доступ по умолчанию'));
  const select = el('select');
  for (const [value, label] of [['ask', 'Спрашивать'], ['read', 'Только чтение'], ['full', 'Полный доступ']]) {
    const option = el('option', '', label); option.value = value; select.append(option);
  }
  select.value = settings.defaultPolicy; policy.append(select); grid.append(policy);
  const flags = [];
  for (const [key, label] of [['compaction', 'Автосжатие истории'], ['browserEnabled', 'Браузерные инструменты'], ['lspEnabled', 'LSP']]) {
    const box = el('div', 'setting'), labelNode = el('label'), input = el('input'); input.type = 'checkbox';
    input.checked = key === 'compaction' ? settings.compaction?.enabled !== false : !!settings[key];
    labelNode.append(input, document.createTextNode(label)); box.append(labelNode); grid.append(box); flags.push([key, input]);
  }
  root.append(grid);
  const actions = el('div', 'answers');
  actions.append(button('Сохранить настройки', () => void command('settings.update', { patch: {
    defaultPolicy: select.value, browserEnabled: flags[1][1].checked, lspEnabled: flags[2][1].checked,
    compaction: { ...settings.compaction, enabled: flags[0][1].checked },
  } }, null), true));
  if (state.sessionId) actions.append(button('Сжать историю сессии', () => void command('compact', {})));
  actions.append(button('Обновить доступность моделей', () => void command('providers.refresh', {}, null)));
  root.append(actions);
  const models = el('section', 'settings-section'); models.append(el('h3', '', 'Доступные модели'));
  const grouped = new Map();
  for (const model of availableModels()) {
    if (!grouped.has(model.providerName)) grouped.set(model.providerName, []);
    grouped.get(model.providerName).push(`${model.name} (${Math.round(model.context / 1024)}K)`);
  }
  for (const [provider, list] of grouped) {
    const row = el('div', 'provider-row'); row.append(el('strong', '', provider), el('small', '', list.join(' · '))); models.append(row);
  }
  if (!grouped.size) models.append(el('p', 'muted', 'Нет доступных моделей.'));
  root.append(models);
  const updates = el('section', 'settings-section'); updates.append(el('h3', '', 'Обновление Enki'));
  const update = state.overview?.updates;
  updates.append(el('p', 'muted', update
    ? `Установлено: ${update.nativeVersion || '—'}\nДоступно: ${update.release?.version || 'нет данных'}\nЭтап: ${update.build?.stage || 'idle'}`
    : 'Запрашиваю состояние устройства…'));
  if (update?.build?.error) updates.append(el('p', 'tool-error', update.build.error));
  const updateButtons = el('div', 'answers');
  updateButtons.append(button('Проверить', () => void command('update.check', {}, null)),
    button('Скачать / собрать', () => void command('update.prepare', {}, null)),
    button('Установить и перезапустить', () => {
      if (confirm('Установить подготовленное обновление? Enki перезапустится после завершения работы агентов.'))
        void command('update.apply', {}, null);
    }, true));
  updates.append(updateButtons); root.append(updates);
}

$('dictate').addEventListener('click', async () => {
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    return toast('Для микрофона откройте страницу по HTTPS в современном браузере.', true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    state.recorder = recorder; state.chunks = [];
    recorder.addEventListener('dataavailable', event => { if (event.data.size) state.chunks.push(event.data); });
    recorder.addEventListener('error', () => toast('Ошибка записи микрофона.', true));
    recorder.addEventListener('stop', async () => {
      clearTimeout(state.recordingTimer); stream.getTracks().forEach(track => track.stop());
      $('dictate').textContent = '🎙'; $('dictation-status').textContent = 'Распознаю речь…';
      try {
        const form = new FormData();
        form.append('file', new Blob(state.chunks, { type: recorder.mimeType }), 'dictation.' + (recorder.mimeType.includes('mp4') ? 'm4a' : 'webm'));
        form.append('model', 'gigaam-v3-e2e-rnnt'); form.append('language', 'ru');
        const response = await fetch('/api/remote/asr', { method: 'POST', body: form });
        const value = await response.json(); if (!response.ok) throw new Error(value.error || `ASR HTTP ${response.status}`);
        const area = $('prompt'); area.value = (area.value.trim() ? area.value.trim() + ' ' : '') + value.text.trim();
        area.dispatchEvent(new Event('input')); $('dictation-status').textContent = 'Готово — проверьте текст перед отправкой';
      } catch (error) { $('dictation-status').textContent = ''; toast(error.message, true); }
      state.recorder = null;
    });
    recorder.start(); $('dictate').textContent = '■'; $('dictation-status').textContent = 'Идёт запись · нажмите ■ для завершения';
    state.recordingTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 5 * 60_000);
  } catch (error) { toast('Нет доступа к микрофону: ' + error.message, true); }
});

$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('prompt').value.trim(), model = selectModel();
  if (!text || !model) return toast(!model ? 'Нет доступной модели' : 'Введите задание', true);
  const result = await command('prompt', { text, model });
  if (result) { $('prompt').value = ''; sessionStorage.removeItem('enki.remote.draft.' + state.sessionId); }
});
$('model').addEventListener('change', () => { const model = selectModel(); if (model && state.sessionId) void command('model.set', { model }); });
function resizeComposer() { const area = $('prompt'); area.style.height = 'auto'; area.style.height = Math.min(180, area.scrollHeight) + 'px'; }
$('prompt').addEventListener('input', () => { sessionStorage.setItem('enki.remote.draft.' + state.sessionId, $('prompt').value); resizeComposer(); });
$('device-select').addEventListener('change', () => void chooseDevice($('device-select').value));
$('session-search').addEventListener('input', renderSessionResults);

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action],[data-filter]');
  if (target?.dataset.filter) {
    state.sessionFilter = target.dataset.filter;
    document.querySelectorAll('.filter').forEach(node => node.classList.toggle('selected', node === target));
    renderSessionResults(); return;
  }
  const action = target?.dataset.action;
  if (action === 'sessions') openSessions();
  if (action === 'close-sessions') $('sessions-dialog').close();
  if (action === 'new') openNew();
  if (action === 'close-new') $('new-dialog').close();
  if (action === 'install') void installApp();
  if (action === 'settings') { $('settings-dialog').showModal(); renderSettings(); }
  if (action === 'close-settings') $('settings-dialog').close();
  if (action === 'stop') void command('stop', {});
});

for (const id of ['sessions-dialog', 'new-dialog', 'settings-dialog'])
  $(id).addEventListener('click', event => { if (event.target === $(id)) $(id).close(); });

let installPrompt = null;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Enki установлен на это устройство'); });
async function installApp() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone === true)
    return toast('Enki уже работает как установленное приложение');
  if (installPrompt) {
    const prompt = installPrompt; installPrompt = null; await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome !== 'accepted') toast('Установка отменена'); return;
  }
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent))
    toast('В Safari: Поделиться → «На экран “Домой”».');
  else toast('В меню браузера выберите «Установить приложение» / «Установить Enki».');
}
if ('serviceWorker' in navigator && window.isSecureContext)
  window.addEventListener('load', () => navigator.serviceWorker.register('/remote-sw.js', { scope: '/' }).catch(() => {}));
window.addEventListener('offline', () => { $('connection').className = 'connection'; $('connection').title = 'Нет сети'; });
window.addEventListener('online', () => { void loadOverview(); });

async function poll() { await loadOverview(); await loadDetail(); }
void (async () => {
  state.deviceId = localStorage.getItem('enki.remote.device');
  state.sessionId = localStorage.getItem('enki.remote.session');
  await loadOverview(); if (state.sessionId) await selectSession(state.sessionId);
  setInterval(poll, 2500);
})();
