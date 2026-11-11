/* Enki LAN remote UI. Dynamic content is always inserted as text, never HTML. */
'use strict';
const $ = id => document.getElementById(id);
const state = { devices: [], device: localStorage.getItem('enki.remote.device'), session: localStorage.getItem('enki.remote.session'), detail: null, overview: null, online: false, recorder: null, chunks: [], busy: false, openTools: new Set(), toastTimer: null, signatures: {} };
let pollTimer;

function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(label, action, primary = false) { const node = el('button', primary ? 'primary' : 'secondary', label); node.type = 'button'; node.addEventListener('click', action); return node; }
function toast(message, error = false) { const node = $('toast'); node.textContent = message; node.className = error ? 'show error' : 'show'; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => node.className = '', 5000); }
async function api(path, body) {
  const response = await fetch('/api/remote/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function currentDevice() { return state.devices.find(d => d.id === state.device); }
function currentSession() { return state.overview?.sessions?.find(s => s.id === state.session); }
function statusFor(id) { return state.overview?.statuses?.[id]?.type || 'idle'; }
function statusLabel(status) { return ({ idle: 'Свободна', busy: 'Работает', retry: 'Повтор', waiting: 'Ждёт ответа' })[status] || status; }
function modelRef(session = currentSession()) {
  const select = $('model');
  if (select?.value) { const [providerID, ...rest] = select.value.split('\n'); return { providerID, modelID: rest.join('\n') }; }
  if (session?.model) return { providerID: session.model.providerID, modelID: session.model.id };
  const provider = state.overview?.providers?.all?.find(p => p.auth?.configured && Object.keys(p.models || {}).length);
  const modelID = provider ? Object.keys(provider.models)[0] : null;
  return provider && modelID ? { providerID: provider.id, modelID } : null;
}
function fillModels(select, selected) {
  const old = selected || select.value;
  select.replaceChildren();
  for (const provider of state.overview?.providers?.all || []) {
    const group = el('optgroup'); group.label = provider.name || provider.id;
    for (const [id, model] of Object.entries(provider.models || {})) {
      const option = el('option', '', `${model.name || id} · ${Math.round((model.limit?.context || 0) / 1024)}K`);
      option.value = provider.id + '\n' + id;
      if (model.access?.state && model.access.state !== 'available') option.disabled = true;
      group.append(option);
    }
    select.append(group);
  }
  if (old && [...select.options].some(o => o.value === old && !o.disabled)) select.value = old;
}
function selectedModelValue(session = currentSession()) { return session?.model ? session.model.providerID + '\n' + session.model.id : ''; }

async function loadOverview() {
  try {
    const data = await api('overview'); state.devices = data.devices; state.online = true;
    $('connection').textContent = 'Hub на связи'; $('connection').className = 'pill online';
    if (!currentDevice()) state.device = data.devices.find(d => d.online)?.id || data.devices[0]?.id || null;
    const device = currentDevice(); state.overview = device?.overview || null;
    if (state.device) localStorage.setItem('enki.remote.device', state.device);
    if (state.overview && !currentSession()) state.session = state.overview.sessions?.[0]?.id || null;
    if (state.session) localStorage.setItem('enki.remote.session', state.session);
    renderDevices(); renderSessions(); renderHeader(); renderSettings();
  } catch (error) {
    state.online = false; $('connection').textContent = 'Нет связи с Hub'; $('connection').className = 'pill';
  }
}
function renderDevices() {
  const signature = JSON.stringify(state.devices.map(d => [d.id,d.name,d.platform,d.online,d.appVersion,d.overview?.questions?.length,d.overview?.permissions?.length]));
  if (state.signatures.devices === signature) return; state.signatures.devices = signature;
  const root = $('devices'); root.replaceChildren();
  for (const device of state.devices) {
    const item = el('button', 'device' + (device.id === state.device ? ' selected' : ''));
    const head = el('div', 'device-name'); head.append(el('strong', '', device.name || 'Enki'), el('span', 'dot' + (device.online ? ' online' : '')));
    const attention = (device.overview?.questions?.length || 0) + (device.overview?.permissions?.length || 0);
    item.append(head, el('small', '', device.online ? `${device.platform} · ${device.appVersion || device.overview?.version || ''}` : 'Нет свежей связи'));
    if (attention) item.append(el('span', 'badge', `Требует ответа: ${attention}`));
    item.addEventListener('click', async () => { state.device = device.id; state.session = device.overview?.sessions?.[0]?.id || null; state.detail = null; $('sidebar').classList.remove('open'); await selectSession(state.session); await loadOverview(); });
    root.append(item);
  }
  if (!state.devices.length) root.append(el('p', 'muted', 'Пока нет подключённых устройств.'));
}
function renderSessions() {
  const signature = JSON.stringify([state.device,state.session,(state.overview?.sessions || []).map(x => [x.id,x.title,x.directory,statusFor(x.id)])]);
  if (state.signatures.sessions === signature) return; state.signatures.sessions = signature;
  const root = $('sessions'); root.replaceChildren();
  for (const session of state.overview?.sessions || []) {
    const item = el('button', 'session-item' + (session.id === state.session ? ' selected' : ''));
    const status = statusFor(session.id);
    const head = el('div', 'session-title-line'); head.append(el('span', '', session.title || 'Новый чат'));
    if (status !== 'idle') head.append(el('span', 'badge', statusLabel(status)));
    item.append(head, el('small', '', session.directory));
    item.addEventListener('click', () => selectSession(session.id)); root.append(item);
  }
}
function renderHeader() {
  const session = currentSession();
  $('empty').hidden = !!session; $('work').hidden = !session;
  if (!session) return;
  $('session-title').textContent = session.title || 'Новый чат'; $('session-path').textContent = session.directory;
  const status = statusFor(session.id); $('session-status').textContent = statusLabel(status); $('session-status').className = 'pill' + (status === 'busy' || status === 'retry' ? ' busy' : ' online');
  const modelsSignature = JSON.stringify([session.model,state.overview?.providers]);
  if (state.signatures.models !== modelsSignature) { state.signatures.models = modelsSignature; fillModels($('model'), selectedModelValue(session)); }
}
async function selectSession(id) {
  state.session = id; state.detail = null;
  if (id) localStorage.setItem('enki.remote.session', id);
  renderSessions(); renderHeader();
  if (state.device && id) { await api('watch', { device: state.device, session: id }); await loadDetail(); }
}
async function loadDetail() {
  if (!state.device || !state.session) return;
  try {
    const data = await api(`session?device=${encodeURIComponent(state.device)}&session=${encodeURIComponent(state.session)}`);
    if (data.detail?.session === state.session) { state.detail = data.detail; renderDetail(); }
  } catch (error) { /* the next poll retries; the last confirmed view remains */ }
}
function renderDetail() {
  const detail = state.detail; if (!detail) return;
  const signature = JSON.stringify([detail.messages,detail.questions,detail.permissions,detail.queue,detail.status,detail.info]);
  if (state.signatures.detail === signature) return; state.signatures.detail = signature;
  renderMessages(detail.messages || []); renderInteractions(); renderQueue(detail.queue);
  if (detail.info?.model && !$('model').matches(':focus')) fillModels($('model'), selectedModelValue(detail.info));
}
function renderMessages(messages) {
  const root = $('messages'), nearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 180;
  root.replaceChildren();
  for (const message of messages) {
    const item = el('article', `message ${message.info.role}${message.info.error ? ' error' : ''}`);
    item.append(el('div', 'message-role', message.info.role === 'user' ? 'Вы' : `${message.info.modelID || 'Enki'}`));
    const texts = (message.parts || []).filter(p => p.type === 'text' && p.text);
    if (texts.length) { const bubble = el('div', 'bubble'); bubble.textContent = texts.map(p => p.text).join('\n\n'); item.append(bubble); }
    for (const part of message.parts || []) {
      if (part.type === 'reasoning' && part.text) item.append(workDetails('Рассуждение', part.text, part.id));
      if (part.type === 'tool') {
        const status = part.state?.status || 'pending', title = part.state?.title || part.tool || 'Инструмент';
        const output = [part.state?.error, part.state?.output].filter(Boolean).join('\n');
        item.append(workDetails(`${title} · ${status}`, output || 'Нет текстового вывода.', part.callID || part.id, status === 'error'));
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
  const summary = el('summary', failed ? 'tool-error' : 'tool-title', title); detail.append(summary, el('pre', '', text)); return detail;
}
function renderInteractions() {
  const root = $('alerts'); root.replaceChildren();
  for (const request of state.detail?.questions || []) {
    const card = el('section', 'alert-card'); card.append(el('h3', '', 'Enki ждёт ответа'));
    const form = el('form', 'question-form');
    request.questions.forEach((question, index) => {
      if (question.context) form.append(el('p', 'context', question.context));
      form.append(el('p', '', question.question));
      if (question.options?.length) {
        question.options.forEach((option, optionIndex) => {
          const label = el('label'); const input = el('input'); input.type = question.multiple ? 'checkbox' : 'radio'; input.name = `q-${request.id}-${index}`; input.value = option.label; input.checked = !question.multiple && optionIndex === 0;
          label.append(input, document.createTextNode(' ' + option.label + (option.description ? ' — ' + option.description : ''))); form.append(label);
        });
      }
      if (question.custom !== false) { const custom = el('textarea'); custom.name = `custom-${index}`; custom.placeholder = question.options?.length ? 'Свой вариант (необязательно)' : 'Ваш ответ'; custom.rows = 2; form.append(custom); }
    });
    form.append(button('Ответить', () => {}, true));
    form.querySelector('button').type = 'submit';
    form.addEventListener('submit', event => {
      event.preventDefault();
      const answers = request.questions.map((q, index) => {
        const selected = [...form.querySelectorAll(`input[name="q-${request.id}-${index}"]:checked`)].map(input => input.value);
        const custom = form.elements[`custom-${index}`]?.value?.trim(); if (custom) selected.push(custom); return selected;
      });
      void command('question.reply', { id: request.id, answers });
    });
    card.append(form, button('Отклонить', () => void command('question.reject', { id: request.id }))); root.append(card);
  }
  for (const request of state.detail?.permissions || []) {
    const card = el('section', 'alert-card'); card.append(el('h3', '', 'Нужно разрешение'), el('p', '', `${request.permission}: ${(request.patterns || []).join(', ')}`));
    const row = el('div', 'answers'); row.append(button('Разрешить один раз', () => void command('permission.reply', { id: request.id, reply: 'once' }), true), button('Всегда', () => void command('permission.reply', { id: request.id, reply: 'always' })), button('Отказать', () => void command('permission.reply', { id: request.id, reply: 'reject' })));
    card.append(row); root.append(card);
  }
}
function renderQueue(queue) {
  const root = $('queue'); root.replaceChildren();
  for (const item of queue?.items || []) root.append(el('div', 'queue-item', `В очереди: ${item.text}`));
  if (queue?.corrections?.length) for (const item of queue.corrections) root.append(el('div', 'queue-item', `Уточнение: ${item.text} · ${item.state}`));
  if (queue?.pausedReason) root.append(button('Возобновить очередь', () => void command('queue.resume', { model: modelRef() })));
}
async function command(kind, payload, session = state.session) {
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await api('command', { id: crypto.randomUUID(), device: state.device, session, kind, payload });
    toast(result.state === 'queued' ? 'Команда сохранена; ждём устройство…' : 'Команда принята');
    setTimeout(loadDetail, 1200); setTimeout(loadOverview, 1800); return result;
  } catch (error) { toast(error.message, true); throw error; }
  finally { state.busy = false; }
}

$('composer').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('prompt').value.trim(), model = modelRef();
  if (!text || !model) return toast(!model ? 'Выберите модель' : 'Введите задание', true);
  await command('prompt', { text, model }); $('prompt').value = ''; sessionStorage.removeItem('enki.remote.draft.' + state.session);
});
$('model').addEventListener('change', () => { const model = modelRef(); if (model && state.session) void command('model.set', { model }); });
$('prompt').addEventListener('input', () => sessionStorage.setItem('enki.remote.draft.' + state.session, $('prompt').value));

function openNew() {
  const deviceSelect = $('new-device'); deviceSelect.replaceChildren();
  for (const device of state.devices.filter(d => d.online)) { const option = el('option', '', device.name); option.value = device.id; deviceSelect.append(option); }
  if (state.device) deviceSelect.value = state.device;
  const device = state.devices.find(d => d.id === deviceSelect.value); const overview = device?.overview;
  const projects = $('new-project'); projects.replaceChildren();
  for (const directory of overview?.projects || []) { const option = el('option', '', directory); option.value = directory; projects.append(option); }
  const previous = state.overview; state.overview = overview; fillModels($('new-model'), selectedModelValue()); state.overview = previous;
  $('new-dialog').showModal();
}
$('new-device').addEventListener('change', () => { const selected = state.device, previous = state.overview; state.device = $('new-device').value; state.overview = currentDevice()?.overview; const projects = $('new-project'); projects.replaceChildren(); for (const directory of state.overview?.projects || []) { const option = el('option', '', directory); option.value = directory; projects.append(option); } fillModels($('new-model')); state.device = selected; state.overview = previous; });
$('new-form').addEventListener('submit', async event => {
  event.preventDefault();
  const [providerID, ...rest] = $('new-model').value.split('\n'), prompt = $('new-prompt').value.trim(), device = $('new-device').value, directory = $('new-project').value;
  if (!providerID || !rest.length || !prompt) return toast('Выберите компьютер, проект, модель и введите задание', true);
  try {
    const created = await api('command', { id: crypto.randomUUID(), device, session: null, kind: 'session.create', payload: { directory, model: { providerID, modelID: rest.join('\n') }, prompt } });
    $('new-dialog').close(); toast('Создаю сессию на устройстве…');
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000)); const status = await api('command?id=' + encodeURIComponent(created.id));
      if (status.state === 'done' && status.result?.session?.id) { state.device = device; await loadOverview(); await selectSession(status.result.session.id); return; }
      if (status.state === 'error') throw new Error(status.result?.error || 'Не удалось создать сессию');
    }
    toast('Команда ещё выполняется. Обновите список через несколько секунд.');
  } catch (error) { toast(error.message, true); }
});

function renderSettings() {
  if (!$('settings-dialog').open) return;
  const settings = state.overview?.settings;
  const signature = JSON.stringify([settings,state.overview?.providers]);
  if (state.signatures.settings === signature) return; state.signatures.settings = signature;
  const root = $('settings-content'); root.replaceChildren();
  if (!settings) return root.append(el('p', '', 'Устройство офлайн.'));
  const grid = el('div', 'settings-grid');
  const policy = el('div', 'setting'); policy.append(el('label', '', 'Режим доступа по умолчанию'));
  const select = el('select'); for (const [value, label] of [['ask', 'Спрашивать'], ['read', 'Только чтение'], ['full', 'Полный доступ']]) { const option = el('option', '', label); option.value = value; select.append(option); } select.value = settings.defaultPolicy; policy.append(select); grid.append(policy);
  const flags = [];
  for (const [key, label] of [['compaction', 'Автосжатие истории'], ['browserEnabled', 'Браузерные инструменты'], ['lspEnabled', 'LSP']]) {
    const box = el('div', 'setting'), labelNode = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = key === 'compaction' ? settings.compaction?.enabled !== false : !!settings[key]; labelNode.append(input, document.createTextNode(label)); box.append(labelNode); grid.append(box); flags.push([key, input]);
  }
  root.append(grid, button('Сохранить настройки', async () => {
    const patch = { defaultPolicy: select.value, browserEnabled: flags[1][1].checked, lspEnabled: flags[2][1].checked, compaction: { ...settings.compaction, enabled: flags[0][1].checked } };
    await command('settings.update', { patch }, null); toast('Настройки отправлены');
  }, true), button('Обновить каталог моделей', () => void command('providers.refresh', {}, null)),
    ...(state.session ? [button('Сжать историю текущей сессии', () => void command('compact', {}))] : []));
  for (const provider of state.overview?.providers?.all || []) {
    const box = el('div', 'provider'); box.append(el('strong', '', `${provider.name || provider.id}${provider.auth?.configured ? '' : ' · не настроен'}`));
    box.append(el('div', 'provider-models', Object.values(provider.models || {}).map(m => `${m.name || m.id} (${Math.round((m.limit?.context || 0) / 1024)}K)`).join(' · '))); root.append(box);
  }
}

$('dictate').addEventListener('click', async () => {
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('Браузер не поддерживает запись. Откройте страницу по HTTPS.', true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {}); state.recorder = recorder; state.chunks = [];
    recorder.addEventListener('dataavailable', event => { if (event.data.size) state.chunks.push(event.data); });
    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach(track => track.stop()); $('dictate').textContent = '🎙 Надиктовать'; $('dictation-status').textContent = 'Распознаю…';
      try {
        const form = new FormData(); form.append('file', new Blob(state.chunks, { type: recorder.mimeType }), 'dictation.' + (recorder.mimeType.includes('mp4') ? 'm4a' : 'webm')); form.append('model', 'gigaam-v3-e2e-rnnt'); form.append('language', 'ru');
        const response = await fetch('/api/remote/asr', { method: 'POST', body: form }), value = await response.json();
        if (!response.ok) throw new Error(value.error || `ASR HTTP ${response.status}`);
        const area = $('prompt'); area.value = (area.value.trim() ? area.value.trim() + ' ' : '') + value.text.trim(); area.dispatchEvent(new Event('input')); $('dictation-status').textContent = 'Текст добавлен';
      } catch (error) { $('dictation-status').textContent = ''; toast(error.message, true); }
      state.recorder = null;
    });
    recorder.start(); $('dictate').textContent = '■ Остановить запись'; $('dictation-status').textContent = 'Запись…';
  } catch (error) { toast('Нет доступа к микрофону: ' + error.message, true); }
});

document.addEventListener('click', event => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'reload') void loadOverview();
  if (action === 'new') openNew();
  if (action === 'close-new') $('new-dialog').close();
  if (action === 'settings') { renderSettings(); $('settings-dialog').showModal(); }
  if (action === 'close-settings') $('settings-dialog').close();
  if (action === 'stop') void command('stop', {});
});
$('menu').addEventListener('click', () => $('sidebar').classList.toggle('open'));
setInterval(() => { if (state.session && !state.recorder) { const saved = sessionStorage.getItem('enki.remote.draft.' + state.session); if (saved && !$('prompt').value) $('prompt').value = saved; } }, 500);

async function poll() { await loadOverview(); await loadDetail(); }
void (async () => { await loadOverview(); if (state.session) await selectSession(state.session); pollTimer = setInterval(poll, 2500); })();
