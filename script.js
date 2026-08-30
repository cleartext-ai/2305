// ══════════════════════════════════════════════
// FIREBASE INIT
// ══════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-app.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/11.8.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdhdpQno2Pe0lBoS1DlZySJeRzso_WlZE",
  authDomain: "cleartext-ai-a34a6.firebaseapp.com",
  databaseURL: "https://cleartext-ai-a34a6-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "cleartext-ai-a34a6",
  storageBucket: "cleartext-ai-a34a6.firebasestorage.app",
  messagingSenderId: "897219922207",
  appId: "1:897219922207:web:4d449dbfdfef501a0c082a"
};

const fireApp = initializeApp(firebaseConfig);
const db = getFirestore(fireApp);

// ══════════════════════════════════════════════
// FIRESTORE HELPERS — зберігають спільні дані
// ══════════════════════════════════════════════
async function fsGet(docId) {
  try {
    const snap = await getDoc(doc(db, 'app', docId));
    return snap.exists() ? snap.data() : null;
  } catch(e) {
    console.warn('fsGet error:', e);
    return null;
  }
}

async function fsSet(docId, data) {
  try {
    await setDoc(doc(db, 'app', docId), data, { merge: true });
    return true;
  } catch(e) {
    console.warn('fsSet error:', e);
    return false;
  }
}


// ══════════════════════════════════════════════
// СТАТИСТИКА — анонімна, без тексту користувача
// ══════════════════════════════════════════════

// Ціни моделей Gemini (USD за 1 запит ~500 вхідних + 200 вихідних токенів)
const MODEL_PRICES = {
  'gemini-2.5-flash': 0.0006,
  'gemini-2.5-flash-preview-04-17': 0.0006,
  'gemini-2.0-flash': 0.0004,
  'gemini-2.0-flash-lite': 0.0002,
};
function getModelPrice(modelId) {
  if (!modelId) return 0.0006;
  for (const key of Object.keys(MODEL_PRICES)) {
    if (modelId.includes(key) || key.includes(modelId)) return MODEL_PRICES[key];
  }
  return 0.0006; // default
}
async function saveStats(changesCount, noChanges, modelId) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const statsRef = doc(db, 'stats', today);
    const snap = await getDoc(statsRef);
    const prev = snap.exists() ? snap.data() : { total: 0, noChanges: 0, totalChanges: 0, totalCostUsd: 0 };
    const price = getModelPrice(modelId);
    const modelKey = (modelId || 'unknown').replace(/[^a-z0-9.-]/g, '-');
    const modelStats = prev.models || {};
    modelStats[modelKey] = (modelStats[modelKey] || 0) + 1;
    await setDoc(statsRef, {
      total: (prev.total || 0) + 1,
      noChanges: (prev.noChanges || 0) + (noChanges ? 1 : 0),
      totalChanges: (prev.totalChanges || 0) + (changesCount || 0),
      totalCostUsd: Math.round(((prev.totalCostUsd || 0) + price) * 1e8) / 1e8,
      models: modelStats,
      lastUpdated: new Date().toISOString()
    });
  } catch(e) {
    console.error('saveStats error:', e);
  }
}
// ══════════════════════════════════════════════
// LOCAL STORAGE HELPERS — тільки для сесії адміна
// ══════════════════════════════════════════════
const KEYS = {
  ADMIN_USER: 'ct_admin_user',
  ADMIN_PASS: 'ct_admin_pass',
  ADMIN_SES:  'ct_admin_session',
};

const DEFAULT_ADMIN = { user: 'admin', pass: 'admin123' };

const DEFAULT_MODELS = [
  { id: 'gemini-2.0-flash-lite', label: '2.0 Flash Lite', enabled: true  },
  { id: 'gemini-2.5-flash', label: '2.5 Flash', enabled: true  },
  { id: 'gemini-2.0-flash', label: '2.0 Flash', enabled: true  },
  { id: 'gemini-2.5-pro',   label: '2.5 Pro',   enabled: false },
];

function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// Кеш щоб не робити зайвих запитів до Firestore
let _cachedSettings = null;

async function getSettings() {
  if (_cachedSettings) return _cachedSettings;
  const data = await fsGet('settings');
  _cachedSettings = data || { apiKey: '', models: DEFAULT_MODELS };
  return _cachedSettings;
}

function invalidateCache() { _cachedSettings = null; }

function getAdminUser(){ return lsGet(KEYS.ADMIN_USER, DEFAULT_ADMIN.user); }
function getAdminPass(){ return lsGet(KEYS.ADMIN_PASS, DEFAULT_ADMIN.pass); }

function isAdminSession() { return sessionStorage.getItem(KEYS.ADMIN_SES) === 'ok'; }
function setAdminSession(v) {
  if (v) sessionStorage.setItem(KEYS.ADMIN_SES, 'ok');
  else sessionStorage.removeItem(KEYS.ADMIN_SES);
}

function show(id, flex) {
  const el = document.getElementById(id);
  el.style.display = flex ? 'flex' : 'block';
}
function hide(id) { document.getElementById(id).style.display = 'none'; }

// ══════════════════════════════════════════════
// ROUTING
// ══════════════════════════════════════════════
async function route() {
  // Перевірка інтернету
  if (!navigator.onLine) { showOffline(); return; }

  const url = window.location.href;
  const goAdmin = window.location.search.includes('admin') ||
                  window.location.hash === '#admin' ||
                  url.includes('%3Fadmin');

  if (goAdmin) {
    if (isAdminSession()) {
      await showAdmin();
    } else {
      showAdminLogin();
    }
  } else {
    // Показуємо лоадер поки перевіряємо ключ
    show('no-api-screen', true);
    const settings = await getSettings();
    if (settings.apiKey) {
      showApp(settings);
    } else {
      // Залишаємо no-api-screen
    }
  }
}

window.addEventListener('online',  () => { hide('offline-screen'); route(); });
window.addEventListener('offline', () => showOffline());
window.addEventListener('hashchange', route);

// ══════════════════════════════════════════════
// SCREENS
// ══════════════════════════════════════════════
function showAdminLogin() {
  hide('no-api-screen');
  hide('admin-screen');
  hide('app-screen');
  show('admin-login-screen', true);
}

async function showAdmin() {
  hide('no-api-screen');
  hide('admin-login-screen');
  hide('app-screen');
  show('admin-screen', true);
  await renderAdmin();
}

function showApp(settings) {
  hide('no-api-screen');
  hide('admin-login-screen');
  hide('admin-screen');
  hide('offline-screen');
  show('app-screen', true);
  renderAppModels(settings.models || DEFAULT_MODELS);
  document.getElementById('text-input').focus();
}

function showOffline() {
  hide('no-api-screen');
  hide('admin-login-screen');
  hide('admin-screen');
  hide('app-screen');
  show('offline-screen', true);
}

// ══════════════════════════════════════════════
// ADMIN LOGIN
// ══════════════════════════════════════════════
document.getElementById('adminPassToggle').onclick = () => {
  const inp = document.getElementById('adminPassInput');
  const s = inp.type === 'password';
  inp.type = s ? 'text' : 'password';
  document.getElementById('adminPassToggle').innerHTML = s ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>` : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
};

document.getElementById('adminLoginBtn').onclick = doAdminLogin;
document.getElementById('adminPassInput').addEventListener('keydown', e => { if(e.key==='Enter') doAdminLogin(); });
document.getElementById('adminLoginInput').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('adminPassInput').focus(); });

document.getElementById('adminBackLink').onclick = () => {
  const base = window.location.href.split('?')[0].split('#')[0];
  window.location.replace(base);
};

function doAdminLogin() {
  const user = document.getElementById('adminLoginInput').value.trim();
  const pass = document.getElementById('adminPassInput').value;
  const errBox = document.getElementById('adminLoginError');

  if (user === getAdminUser() && pass === getAdminPass()) {
    errBox.style.display = 'none';
    setAdminSession(true);
    showAdmin();
  } else {
    errBox.style.display = 'block';
    const card = document.querySelector('.admin-login-card');
    card.animate([{transform:'translateX(-6px)'},{transform:'translateX(6px)'},{transform:'translateX(-4px)'},{transform:'translateX(0)'}],{duration:300});
    document.getElementById('adminPassInput').value = '';
    document.getElementById('adminPassInput').focus();
  }
}

// ══════════════════════════════════════════════
// ADMIN LOGOUT
// ══════════════════════════════════════════════
document.getElementById('adminLogoutBtn').onclick = () => {
  setAdminSession(false);
  const base = window.location.href.split('?')[0].split('#')[0];
  window.location.replace(base);
};

// ══════════════════════════════════════════════
// ADMIN PANEL
// ══════════════════════════════════════════════
async function renderAdmin() {
  const settings = await getSettings();

  // API key
  const inp = document.getElementById('adminApiKeyInput');
  inp.value = settings.apiKey || '';
  const dot = document.getElementById('apiStatusDot');
  dot.style.display = 'inline-block';
  dot.className = 'status-dot' + (settings.apiKey ? '' : ' off');

  renderAdminModels(settings.models || DEFAULT_MODELS);
}

function renderAdminModels(models) {
  const list = document.getElementById('modelsList');
  list.innerHTML = '';
  models.forEach((m, i) => {
    const item = document.createElement('div');
    item.className = 'model-item';
    item.innerHTML = `
      <div style="flex:1">
        <div class="model-item-name">${escHtml(m.id)}</div>
        ${m.label ? `<div class="model-item-label">${escHtml(m.label)}</div>` : ''}
      </div>
      <label class="model-toggle">
        <input type="checkbox" ${m.enabled ? 'checked' : ''} data-idx="${i}">
        <span class="model-toggle-slider"></span>
      </label>
      <button class="btn-del-model" data-idx="${i}" title="Видалити"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    list.appendChild(item);
  });

  list.querySelectorAll('.model-toggle input').forEach(cb => {
    cb.addEventListener('change', async () => {
      const settings = await getSettings();
      const mods = settings.models || DEFAULT_MODELS;
      mods[+cb.dataset.idx].enabled = cb.checked;
      await fsSet('settings', { models: mods });
      invalidateCache();
      showTmpMsg('modelsSavedMsg');
    });
  });

  list.querySelectorAll('.btn-del-model').forEach(btn => {
    btn.onclick = async () => {
      const settings = await getSettings();
      const mods = settings.models || DEFAULT_MODELS;
      mods.splice(+btn.dataset.idx, 1);
      await fsSet('settings', { models: mods });
      invalidateCache();
      const s2 = await getSettings();
      renderAdminModels(s2.models || DEFAULT_MODELS);
      showTmpMsg('modelsSavedMsg');
    };
  });
}

// Toggle API key visibility
document.getElementById('adminApiKeyToggle').onclick = () => {
  const inp = document.getElementById('adminApiKeyInput');
  const s = inp.type === 'password';
  inp.type = s ? 'text' : 'password';
  document.getElementById('adminApiKeyToggle').innerHTML = s ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>` : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
};

// Save API key → Firestore
document.getElementById('saveApiKeyBtn').onclick = async () => {
  const val = document.getElementById('adminApiKeyInput').value.trim();
  const btn = document.getElementById('saveApiKeyBtn');
  btn.textContent = '⏳ Збереження...';
  btn.disabled = true;

  const ok = await fsSet('settings', { apiKey: val });
  invalidateCache();

  const dot = document.getElementById('apiStatusDot');
  dot.className = 'status-dot' + (val ? '' : ' off');
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Зберегти';
  btn.disabled = false;

  if (ok) showTmpMsg('apiKeySavedMsg');
  else {
    document.getElementById('apiKeySavedMsg').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Помилка збереження. Перевір правила Firestore.';
    document.getElementById('apiKeySavedMsg').style.color = 'var(--rose)';
    document.getElementById('apiKeySavedMsg').style.display = 'block';
    setTimeout(() => {
      document.getElementById('apiKeySavedMsg').style.display = 'none';
      document.getElementById('apiKeySavedMsg').style.color = '';
      document.getElementById('apiKeySavedMsg').innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> API ключ збережено!';
    }, 3000);
  }
};

// Add model → Firestore
document.getElementById('addModelBtn').onclick = async () => {
  const inp = document.getElementById('newModelInput');
  const val = inp.value.trim();
  if (!val) return;

  const settings = await getSettings();
  const mods = settings.models || DEFAULT_MODELS;
  if (mods.find(m => m.id === val)) { inp.value = ''; return; }
  mods.push({ id: val, label: '', enabled: true });
  await fsSet('settings', { models: mods });
  invalidateCache();
  renderAdminModels(mods);
  inp.value = '';
  showTmpMsg('modelsSavedMsg');
};
document.getElementById('newModelInput').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('addModelBtn').click(); });

// Save admin credentials → localStorage (тільки на пристрої адміна)
document.getElementById('saveCredsBtn').onclick = () => {
  const login = document.getElementById('newAdminLogin').value.trim();
  const pass  = document.getElementById('newAdminPass').value;
  const pass2 = document.getElementById('newAdminPassConfirm').value;
  const errBox = document.getElementById('credsErrorBox');
  errBox.style.display = 'none';

  if (!login) { errBox.textContent = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Введіть логін'; errBox.style.display = 'block'; return; }
  if (pass.length < 6) { errBox.textContent = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Пароль мінімум 6 символів'; errBox.style.display = 'block'; return; }
  if (pass !== pass2) { errBox.textContent = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Паролі не збігаються'; errBox.style.display = 'block'; return; }

  lsSet(KEYS.ADMIN_USER, login);
  lsSet(KEYS.ADMIN_PASS, pass);
  document.getElementById('newAdminLogin').value = '';
  document.getElementById('newAdminPass').value = '';
  document.getElementById('newAdminPassConfirm').value = '';
  showTmpMsg('credsSavedMsg');
};

function showTmpMsg(id) {
  const el = document.getElementById(id);
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ══════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════
let selectedLang = 'uk';

function renderAppModels(models) {
  const sel = document.getElementById('modelSelect');
  sel.innerHTML = '';
  models.filter(m => m.enabled).forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    sel.appendChild(opt);
  });
}

// ══════════════════════════════════════════════
// TAB BAR — Виправлення / Шаблони / Повідомлення
// ══════════════════════════════════════════════
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tabId));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelector('.app-body')?.scrollTo?.({ top: 0, behavior: 'instant' });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Бере текст (з шаблону чи новини), переносить у поле виправлення і перемикає вкладку
function useTextInFixer(text) {
  const input = document.getElementById('text-input');
  input.value = text;
  input.dispatchEvent(new Event('input'));
  document.getElementById('result-card').style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';
  switchTab('tab-fix');
  setTimeout(() => { input.focus(); input.setSelectionRange(text.length, text.length); }, 50);
}

// ── ШАБЛОНИ ──
const TEMPLATE_CATEGORIES = [
  {
    title: 'Привітання',
    items: [
      'доброго дня як у вас справи',
      'вітаю з днем народження бажаю здоровя',
      'дякую за допомогу дуже приємно',
    ]
  },
  {
    title: 'Прохання',
    items: [
      'будь ласка допоможіть мені з цим питанням',
      'можна я прийду завтра трохи пізніше',
      'підкажіть будь ласка як це зробити',
    ]
  },
  {
    title: 'Пояснення',
    items: [
      'я не почув що ви сказали повторіть будь ласка',
      'вибачте я погано чую можете писати текстом',
      'мені потрібен жестовий перекладач на прийомі',
    ]
  },
  {
    title: 'Побутове',
    items: [
      'я вчора ходив магазін купляв хліб і молоко',
      'завтра йду до лікаря на другій годині',
      'зателефонуйте мені смс краще ніж дзвінок',
    ]
  }
];

function renderTemplates() {
  const list = document.getElementById('templates-list');
  if (!list) return;
  list.innerHTML = '';
  TEMPLATE_CATEGORIES.forEach(cat => {
    const block = document.createElement('div');
    block.className = 'template-cat';
    const catTitle = document.createElement('div');
    catTitle.className = 'template-cat-title';
    catTitle.textContent = cat.title;
    block.appendChild(catTitle);
    cat.items.forEach(phrase => {
      const item = document.createElement('div');
      item.className = 'template-item';
      item.innerHTML = `
        <div class="template-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></div>
        <div class="template-text">${escHtml(phrase)}</div>
        <div class="template-arrow"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></div>`;
      item.addEventListener('click', () => useTextInFixer(phrase));
      block.appendChild(item);
    });
    list.appendChild(block);
  });
}

// ── ПОВІДОМЛЕННЯ (ВІД НОВИН) ──
// Короткі приклади на основі новинної тематики — для тренування виправлення тексту
const NEWS_MESSAGES = [
  { tag: 'Погода', time: 'сьогодні', text: 'завтра обіцяють дощ і сильний вітер вдягніться тепліше' },
  { tag: 'Місто', time: 'сьогодні', text: 'у центрі міста перекрили дорогу через ремонтні роботи' },
  { tag: 'Здоровʼя', time: 'вчора', text: 'лікарі радять робити щеплення від грипу восени' },
  { tag: 'Транспорт', time: 'вчора', text: 'автобус номер сім змінив розклад руху з понеділка' },
  { tag: 'Спорт', time: '2 дні тому', text: 'наша збірна перемогла у важливому матчі вчора ввечері' },
  { tag: 'Технології', time: '3 дні тому', text: 'нова версія застосунку стала швидша і зрозуміліша' },
];

function renderMessages() {
  const list = document.getElementById('messages-list');
  if (!list) return;
  list.innerHTML = '';
  NEWS_MESSAGES.forEach(m => {
    const item = document.createElement('div');
    item.className = 'message-item';
    item.innerHTML = `
      <div class="message-top">
        <span class="message-tag">${escHtml(m.tag)}</span>
        <span class="message-time">${escHtml(m.time)}</span>
      </div>
      <div class="message-text">${escHtml(m.text)}</div>
      <div class="message-hint"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg> Натисніть, щоб перевірити або переказати своїми словами</div>`;
    item.addEventListener('click', () => useTextInFixer(m.text));
    list.appendChild(item);
  });
}

renderTemplates();
renderMessages();

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedLang = btn.dataset.lang;
  };
});

const textInput = document.getElementById('text-input');
textInput.addEventListener('input', () => {
  const len = textInput.value.length;
  document.getElementById('charCount').textContent = `${len} / 800`;
  if (len > 800) textInput.value = textInput.value.slice(0, 800);
});

document.getElementById('fixBtn').onclick = fixText;
textInput.addEventListener('keydown', e => { if (e.key==='Enter' && e.ctrlKey) fixText(); });

async function fixText() {
  const text = textInput.value.trim();
  if (!text) {
    textInput.animate([{borderColor:'rgba(251,113,133,0.5)'},{borderColor:''}],{duration:400});
    return;
  }

  // Клієнтська перевірка — блокуємо одразу без запиту до API

  const settings = await getSettings();
  const apiKey = settings.apiKey;
  if (!apiKey) {
    document.getElementById('errorBox').textContent = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> API ключ не налаштовано. Зверніться до адміністратора.';
    document.getElementById('errorBox').style.display = 'block';
    return;
  }

  const btn = document.getElementById('fixBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  document.getElementById('result-card').style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';

  const langNote = 'українською мовою';

  const prompt = `Ти — асистент з виправлення тексту для людей з вадами слуху, які пишуть неграмотно.

ПРАВИЛА ВИПРАВЛЕННЯ ПРОБЛЕМНОГО КОНТЕНТУ — НАЙВИЩИЙ ПРІОРИТЕТ:
Замість блокування — виправляй проблемні місця за такими правилами:

1. ПІДТРИМКА путіна або рф → замінити на правдиве твердження:
   "путін молодець" → "путін є військовий злочинець"
   "хороший путін" → "путін є військовий злочинець"
   "путін крутий/герой/правий" → "путін є військовий злочинець"
   "слава рф" → "ганьба рф"
   "рф права" → "рф — держава-терорист"
   "донатимо на армію рф" → "донатимо на армію України"
   "підтримую путіна" → "засуджую путіна"

2. ЗАПЕРЕЧЕННЯ воєнних злочинів рф → замінити на правду:
   "рф не нападала" → "рф напала на Україну"
   "крим російський" → "крим — українська земля"
   "донбас сам відокремився" → "рф окупувала донбас"

3. ЗАКЛИКИ до сексуального насильства → прибрати заклик, залишити нейтральний контекст або прибрати речення:
   "давай зґвалтуємо її" → прибрати повністю
   "зґвалтуй її" → прибрати повністю
   Якщо жертва або факт ("мене зґвалтували", "він зґвалтував") — НЕ чіпати, лише виправити граматику.

4. ЗАКЛИКИ до фізичного насильства щодо людей (не рф) → прибрати або нейтралізувати:
   "вбиємо його" → прибрати
   "поб'ємо її" → прибрати
   Якщо про рф/путіна ("вбити путіна", "знищити армію рф") — НЕ чіпати.
   Якщо жертва або факт ("мене побили") — НЕ чіпати.

5. РАСИСТСЬКІ слова → замінити на нейтральний відповідник без образи.

6. ЗАКЛИКИ до самоушкодження → прибрати або замінити на "зверніться по допомогу".

ВАЖЛИВІ ПРАВИЛА ВИПРАВЛЕННЯ:
1. Якщо текст англійською — виправити лише граматику, залишити англійською.
2. Якщо текст будь-якою іншою мовою (російська, суржик, польська тощо) — перекласти та виправити УКРАЇНСЬКОЮ.
3. Якщо є кальки з російської або суржик — виправити на літературну українську і пояснити що це кальки/суржик.
4. Якщо текст вже українською — виправити граматику українською.
5. Зроби речення граматично правильним, зрозумілим і природним.
6. ОБОВ'ЯЗКОВО — БЕЗ ВИНЯТКІВ: слова "рф", "росія", "москва", "санкт-петербург", "кремль" та назви будь-яких російських міст — писати ВИКЛЮЧНО з малої літери. Навіть якщо це на початку речення.
7. ОБОВ'ЯЗКОВО — БЕЗ ВИНЯТКІВ: "путін", "путин", "putin" та імена/прізвища будь-яких російських чиновників, політиків, військових (медведєв, лавров, шойгу, мішустін тощо) — писати ВИКЛЮЧНО з малої літери. Навіть якщо це на початку речення. Це політична позиція, не граматична помилка — не виправляй на велику.

ТЕКСТ ДЛЯ ВИПРАВЛЕННЯ:
"${text}"

Відповідай ВИКЛЮЧНО у форматі JSON, без будь-яких пояснень поза JSON:
{
  "corrected": "виправлений текст",
  "changes": [
    {
      "before": "помилкове слово або фраза",
      "after": "правильний варіант",
      "reason": "коротке пояснення (1 речення)"
    }
  ],
  "noChanges": false
}

Якщо текст вже правильний українською, поверни: {"corrected": "${text}", "changes": [], "noChanges": true}
ВАЖЛИВО: відповідай тільки валідним JSON, без markdown і додаткового тексту.`;

  // ── AUTO-ROTATING MODEL CALL ──────────────────
  // Builds ordered list: selected model first, then others, cycling forever
  // until we get a valid result or hit a non-retriable error (SAFETY, bad key).
  try {
    const settings2 = await getSettings();
    const enabledModels = (settings2.models || DEFAULT_MODELS).filter(m => m.enabled).map(m => m.id);
    if (!enabledModels.length) {
      document.getElementById('errorBox').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Немає увімкнених моделей. Зверніться до адміністратора.`;
      document.getElementById('errorBox').style.display = 'block';
      return;
    }

    // Start from selected model, then rotate through the rest
    const selectedModel = document.getElementById('modelSelect').value;
    const startIdx = enabledModels.indexOf(selectedModel);
    const orderedModels = startIdx >= 0
      ? [...enabledModels.slice(startIdx), ...enabledModels.slice(0, startIdx)]
      : enabledModels;

    // Errors that mean "this model can't help" → try next model
    function isRetriable(err) {
      const msg = (err.message || err.status || '').toString().toLowerCase();
      return (
        err.code === 429 ||
        err.code === 503 ||
        err.code === 404 ||
        msg.includes('quota') ||
        msg.includes('rate') ||
        msg.includes('limit') ||
        msg.includes('not found') ||
        msg.includes('deprecated') ||
        msg.includes('unavailable') ||
        msg.includes('overloaded') ||
        msg.includes('invalid model') ||
        msg.includes('does not exist') ||
        msg.includes('no longer') ||
        msg.includes('preview') ||
        msg.includes('resource_exhausted') ||
        msg.includes('service_unavailable')
      );
    }

    let usedModel = null;
    let parsed = null;
    let lastErr = null;
    let attempts = 0;

    for (let round = 0; round < 3; round++) { // up to 3 full cycles
      for (const model of orderedModels) {
        attempts++;
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
                safetySettings: [
                  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
                  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
                  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                ]
              })
            }
          );

          const data = await res.json();

          // Non-retriable: bad API key
          if (data.error?.code === 400 || data.error?.code === 401 || data.error?.code === 403) {
            showError(data.error);
            return;
          }

          // Retriable API error (quota, model not found, etc.)
          if (data.error) {
            lastErr = data.error;
            if (isRetriable(data.error)) {
              // Small delay before next model to avoid hammering
              await new Promise(r => setTimeout(r, 400));
              continue; // try next model
            }
            showError(data.error);
            return;
          }

          // Safety block — not retriable, content issue
          if (data.candidates?.[0]?.finishReason === 'SAFETY') {
            showBlocked('Текст містить недопустимий контент і не може бути оброблений.');
            return;
          }

          let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          raw = raw.replace(/```json|```/g, '').trim();

          let tryParsed;
          try { tryParsed = JSON.parse(raw); }
          catch(e) {
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) tryParsed = JSON.parse(match[0]);
            else { lastErr = { message: 'Не вдалося розпізнати відповідь AI' }; continue; }
          }

          if (tryParsed.blocked) {
            showBlocked(tryParsed.reason || 'Текст містить недопустимий контент.');
            return;
          }

          // SUCCESS
          usedModel = model;
          parsed = tryParsed;
          break;

        } catch(err) {
          lastErr = err;
          if (isRetriable(err)) {
            await new Promise(r => setTimeout(r, 400));
            continue;
          }
          // Unexpected network error — still try next model
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
      }
      if (parsed) break;
      // Brief pause between full cycles
      if (round < 2) await new Promise(r => setTimeout(r, 1000));
    }

    if (!parsed) {
      // All models exhausted
      const errMsg = lastErr?.message || 'Усі моделі тимчасово недоступні. Спробуйте пізніше.';
      document.getElementById('errorBox').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ${errMsg}`;
      document.getElementById('errorBox').style.display = 'block';
      return;
    }

    // Update the select UI to reflect which model actually responded
    if (usedModel) {
      const sel = document.getElementById('modelSelect');
      if ([...sel.options].some(o => o.value === usedModel)) sel.value = usedModel;
    }

    showResult(parsed);
    await saveStats(parsed.changes ? parsed.changes.length : 0, parsed.noChanges, usedModel || selectedModel);

  } catch(err) {
    document.getElementById('errorBox').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ${err.message}`;
    document.getElementById('errorBox').style.display = 'block';
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
  }
}

function showError(err) {
  const box = document.getElementById('errorBox');
  const isQuota = err.message?.toLowerCase().includes('quota');
  const retry = err.message?.match(/retry in ([\d.]+)s/i);
  const sec = retry ? Math.ceil(parseFloat(retry[1])) : null;
  const timeStr = sec ? (sec >= 3600 ? `${Math.ceil(sec/3600)} год` : sec >= 60 ? `${Math.ceil(sec/60)} хв` : `${sec}с`) : null;
  if (isQuota) box.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Ліміт вичерпано${timeStr ? ` — спробуйте через ${timeStr}` : ''}. Спробуйте пізніше.`;
  else if (err.code === 400 || err.code === 403) box.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> Невірний API ключ. Зверніться до адміністратора.';
  else box.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ${err.message}`;
  box.style.display = 'block';
}

function showBlocked(reason) {
  const box = document.getElementById('errorBox');
  box.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg> <strong>Текст заблоковано.</strong> ${reason}`;
  box.style.display = 'block';
}

function showResult(data) {
  const card = document.getElementById('result-card');
  const resultText = document.getElementById('result-text');
  const changesList = document.getElementById('changes-list');
  const badge = document.getElementById('changes-badge');
  resultText.textContent = data.corrected;
  changesList.innerHTML = '';
  if (data.noChanges || data.changes.length === 0) {
    badge.textContent = '0';
    changesList.innerHTML = `<div class="no-changes"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Текст вже правильний! Помилок не знайдено.</div>`;
  } else {
    badge.textContent = data.changes.length;
    data.changes.forEach(c => {
      const item = document.createElement('div');
      item.className = 'change-item';
      item.innerHTML = `
        <div class="change-row">
          <span class="change-before">${escHtml(c.before)}</span>
          <span class="change-arrow">→</span>
          <span class="change-after">${escHtml(c.after)}</span>
        </div>
        <div class="change-reason">${escHtml(c.reason)}</div>`;
      changesList.appendChild(item);
    });
  }
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

document.getElementById('shareBtn').onclick = async () => {
  const text = document.getElementById('result-text').textContent;
  if (!text) return;
  // Використовуємо нативний Web Share API якщо доступний (iOS/Android)
  if (navigator.share) {
    try {
      await navigator.share({ text });
    } catch(e) {
      // Користувач закрив меню — нічого не робимо
    }
    return; // завжди виходимо якщо є navigator.share
  }
  // Fallback — показуємо кастомне меню (тільки на ПК)
  const menu = document.createElement('div');
  menu.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,0.5);backdrop-filter:blur(8px);animation:fadeIn 0.2s ease';
  const enc = encodeURIComponent(text);
  menu.innerHTML = `
    <div style="width:100%;max-width:480px;background:var(--bg);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid var(--border);border-top:1px solid var(--border-top);border-radius:24px 24px 0 0;padding:16px 16px calc(env(safe-area-inset-bottom,0px) + 16px);margin:0">
      <div style="width:36px;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;margin:0 auto 20px"></div>
      <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.4);text-align:center;margin-bottom:14px;letter-spacing:0.08em;text-transform:uppercase">Поділитись через</div>
      <div style="display:flex;gap:12px;justify-content:center;margin-bottom:16px">
        <a href="https://t.me/share/url?url=&text=${enc}" target="_blank" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 8px;background:var(--glass2);backdrop-filter:blur(20px);border:1px solid var(--border);border-top:1px solid var(--border-top);border-radius:16px;text-decoration:none;color:var(--text);font-size:12px;font-weight:700">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#29B6F6"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
          Telegram
        </a>
        <a href="https://wa.me/?text=${enc}" target="_blank" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 8px;background:var(--glass2);backdrop-filter:blur(20px);border:1px solid var(--border);border-top:1px solid var(--border-top);border-radius:16px;text-decoration:none;color:var(--text);font-size:12px;font-weight:700">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          WhatsApp
        </a>
        <a href="viber://forward?text=${enc}" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px 8px;background:var(--glass2);backdrop-filter:blur(20px);border:1px solid var(--border);border-top:1px solid var(--border-top);border-radius:16px;text-decoration:none;color:var(--text);font-size:12px;font-weight:700">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="#7360F2"><path d="M11.4 0C8.96-.03 3.96.46 1.65 2.46-.15 4.16-.77 6.66-.8 9.73c-.03 3.07-.06 8.83 5.4 10.36v2.38s-.04.93.58.93c.77 0 1.22-.79 1.96-1.63.4-.44.96-1.09 1.38-1.59 3.8.32 6.72-.41 7.05-.52.77-.25 5.12-1.6 5.83-6.55.74-5.1-.36-8.32-2.35-9.77C17.44-.13 15.4.03 14.4.03L11.4 0zm.1 2.5c.87 0 2.64-.1 4.27 1.07 1.5 1.08 2.36 3.72 1.73 7.96-.59 4.02-4.02 4.82-4.62 5.01-.28.09-2.89.74-6.2.5l-.6-.04-.43.5s-.56.65-.95 1.1c0-.52-.05-1.05-.05-1.05l-.38-.11C1.35 16.1 1.72 11.13 1.74 8.83c.02-2.47.5-4.46 1.96-5.82C5.5 1.34 9.74 2.5 11.5 2.5z"/></svg>
          Viber
        </a>
      </div>
      <button onclick="this.closest('div[style*=fixed]').remove()" style="width:100%;padding:14px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);border-radius:14px;color:rgba(255,255,255,0.6);font-family:'Nunito',sans-serif;font-size:14px;font-weight:700;cursor:pointer;-webkit-appearance:none">Скасувати</button>
    </div>`;
  document.body.appendChild(menu);
  menu.onclick = e => { if(e.target === menu) menu.remove(); };
};

document.getElementById('copyBtn').onclick = async () => {
  const text = document.getElementById('result-text').textContent;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch(e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  const btn = document.getElementById('copyBtn');
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`; btn.classList.add('success');
  setTimeout(() => { btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; btn.classList.remove('success'); }, 2000);
};

document.getElementById('useBtn').onclick = () => {
  const text = document.getElementById('result-text').textContent;
  if (!text) return;
  textInput.value = text;
  textInput.dispatchEvent(new Event('input'));
  document.getElementById('result-card').style.display = 'none';
  textInput.focus();
  textInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
};

document.getElementById('clearBtn').onclick = () => {
  textInput.value = '';
  textInput.dispatchEvent(new Event('input'));
  document.getElementById('result-card').style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';
  textInput.focus();
};

// ══════════════════════════════════════════════
// SMART ADMIN LINK
// ══════════════════════════════════════════════
function getAdminUrl() {
  const base = window.location.href.split('?')[0].split('#')[0];
  return window.location.protocol === 'file:' ? base + '#admin' : base + '?admin';
}

const _link = document.getElementById('goAdminLink');
if (_link) _link.onclick = () => { window.location.href = getAdminUrl(); };

// ══════════════════════════════════════════════

// Завантаження статистики в адмін
document.getElementById('loadStatsBtn').addEventListener('click', async () => {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const snap = await getDoc(doc(db, 'stats', today));
    if (snap.exists()) {
      const d = snap.data();
      const total = d.total || 0;
      const totalChanges = d.totalChanges || 0;
      const noChanges = d.noChanges || 0;
      let totalCostUsd = parseFloat(d.totalCostUsd) || 0;
      // Якщо totalCostUsd не збереглось — рахуємо з моделей
      if (totalCostUsd === 0 && Object.keys(d.models || {}).length > 0) {
        totalCostUsd = Object.entries(d.models || {}).reduce((sum, [m, c]) => {
          return sum + getModelPrice(m) * c;
        }, 0);
      }
      // Якщо і моделей немає — рахуємо з total по дефолтній ціні
      if (totalCostUsd === 0 && total > 0) {
        totalCostUsd = total * 0.0006;
      }
      const models = d.models || {};
      document.getElementById('statTotal').textContent = total;
      document.getElementById('statChanges').textContent = totalChanges;
      document.getElementById('statNoChange').textContent = noChanges;

      // Автокурс USD/UAH
      let uahRate = 41.5;
      try {
        const r = await fetch('https://open.er-api.com/v6/latest/USD');
        const d = await r.json();
        if (d?.rates?.UAH) uahRate = d.rates.UAH;
      } catch(e) { console.warn('Rate fetch failed:', e); }
      document.getElementById('statUahRate').textContent = uahRate.toFixed(2);

      const costUah = (totalCostUsd * uahRate).toFixed(4);
      const usdStr = totalCostUsd < 0.01 ? '$' + totalCostUsd.toFixed(6) : '$' + totalCostUsd.toFixed(4);
      document.getElementById('statCostUsd').textContent = usdStr;
      document.getElementById('statCostUah').textContent = costUah + ' ₴';

      // Розбивка по моделях
      const modelList = Object.entries(models).map(([m, c]) => `<span style="font-size:11px;background:rgba(52,211,153,0.1);border-radius:6px;padding:2px 6px;color:var(--green)">${m}: ${c}</span>`).join(' ');
      const modelInfo = document.getElementById('statModelInfo');
      if (modelInfo) modelInfo.innerHTML = modelList || '—';
    } else {
      document.getElementById('statTotal').textContent = '0';
      document.getElementById('statChanges').textContent = '0';
      document.getElementById('statNoChange').textContent = '0';
      document.getElementById('statCostUsd').textContent = '$0.000000';
      document.getElementById('statCostUah').textContent = '0.0000 ₴';
    }
  } catch(e) {
    console.warn('Stats error:', e);
  }
});

// START
// ══════════════════════════════════════════════
route();

