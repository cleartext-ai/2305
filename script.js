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
// Адмін може перевизначити ціну моделі в Firestore (settings.models[i].price).
// Якщо перевизначення немає — падаємо назад на стандартну таблицю цін вище.
function getModelPriceFromList(modelId, modelsList) {
  const m = (modelsList || []).find(x => x.id === modelId);
  if (m && typeof m.price === 'number' && !isNaN(m.price) && m.price > 0) return m.price;
  return getModelPrice(modelId);
}
async function saveStats(changesCount, noChanges, modelId, modelsList, latencyMs) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const statsRef = doc(db, 'stats', today);
    const snap = await getDoc(statsRef);
    const prev = snap.exists() ? snap.data() : { total: 0, noChanges: 0, totalChanges: 0, totalCostUsd: 0 };
    const price = getModelPriceFromList(modelId, modelsList);
    const modelKey = (modelId || 'unknown').replace(/[^a-z0-9.-]/g, '-');
    const modelStats = prev.models || {};
    modelStats[modelKey] = (modelStats[modelKey] || 0) + 1;
    const hourKey = String(new Date().getHours()).padStart(2, '0');
    const hourStats = prev.hours || {};
    hourStats[hourKey] = (hourStats[hourKey] || 0) + 1;
    const payload = {
      total: (prev.total || 0) + 1,
      noChanges: (prev.noChanges || 0) + (noChanges ? 1 : 0),
      totalChanges: (prev.totalChanges || 0) + (changesCount || 0),
      totalCostUsd: Math.round(((prev.totalCostUsd || 0) + price) * 1e8) / 1e8,
      models: modelStats,
      hours: hourStats,
      lastUpdated: new Date().toISOString()
    };
    if (typeof latencyMs === 'number' && latencyMs > 0) {
      payload.latencyTotalMs = (prev.latencyTotalMs || 0) + latencyMs;
      payload.latencyCount = (prev.latencyCount || 0) + 1;
    }
    await setDoc(statsRef, payload, { merge: true });
  } catch(e) {
    console.error('saveStats error:', e);
  }
}

// Лічильник фактичних помилок API (усі спроби/моделі не спрацювали) — для ALERT-чіпа в адмінці.
async function saveErrorStat() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const statsRef = doc(db, 'stats', today);
    const snap = await getDoc(statsRef);
    const prev = snap.exists() ? snap.data() : {};
    await setDoc(statsRef, { errors: (prev.errors || 0) + 1, lastUpdated: new Date().toISOString() }, { merge: true });
  } catch(e) { /* телеметрія не критична */ }
}

// Лічильник анонімних блокувань SAFETY-фільтром — без збереження самого тексту.
async function saveBlockedStat() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const statsRef = doc(db, 'stats', today);
    const snap = await getDoc(statsRef);
    const prev = snap.exists() ? snap.data() : {};
    await setDoc(statsRef, { blockedCount: (prev.blockedCount || 0) + 1, lastUpdated: new Date().toISOString() }, { merge: true });
  } catch(e) { /* телеметрія не критична */ }
}
// ══════════════════════════════════════════════
// LOCAL STORAGE HELPERS — тільки для сесії адміна
// ══════════════════════════════════════════════
const KEYS = {
  ADMIN_USER: 'ct_admin_user',
  ADMIN_PASS: 'ct_admin_pass',
  ADMIN_SES:  'ct_admin_session',
  ADMIN_LOCKOUT: 'ct_admin_lockout',
};

const DEFAULT_ADMIN = { user: 'admin', pass: 'admin123' };
const LOGIN_LOCKOUT_THRESHOLD = 5;   // невдалих спроб поспіль
const LOGIN_LOCKOUT_MS = 60 * 1000;  // 1 хвилина блокування

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
  _cachedSettings = data || { apiKey: '', models: DEFAULT_MODELS, maintenanceMode: false, dailyLimitEnabled: false, dailyLimit: 0 };
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
    if (settings.maintenanceMode) {
      showNoApi('maintenance');
    } else if (settings.apiKey) {
      showApp(settings);
    } else {
      showNoApi('nokey');
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
  applyLockoutUI();
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
  renderTemplates(settings.templates);
  renderBanner(settings);
  document.getElementById('text-input').focus();
  requestAnimationFrame(() => {
    const activeBtn = document.querySelector('.tab-btn.active');
    const indicator = document.getElementById('tabIndicator');
    if (activeBtn && indicator) {
      indicator.style.transition = 'none';
      moveTabIndicator(activeBtn);
      requestAnimationFrame(() => { indicator.style.transition = ''; });
    }
  });
}

function showOffline() {
  hide('no-api-screen');
  hide('admin-login-screen');
  hide('admin-screen');
  hide('app-screen');
  show('offline-screen', true);
}

function showNoApi(reason) {
  hide('admin-login-screen');
  hide('admin-screen');
  hide('app-screen');
  hide('offline-screen');
  const noKeyEl = document.getElementById('noApiTextNoKey');
  const maintEl = document.getElementById('noApiTextMaintenance');
  if (noKeyEl && maintEl) {
    const isMaintenance = reason === 'maintenance';
    noKeyEl.style.display = isMaintenance ? 'none' : 'inline';
    maintEl.style.display = isMaintenance ? 'inline' : 'none';
  }
  show('no-api-screen', true);
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

// ══════════════════════════════════════════════
// АВТОБЛОКУВАННЯ ПІСЛЯ НЕВДАЛИХ СПРОБ ВХОДУ (на цьому пристрої)
// ══════════════════════════════════════════════
function getLockoutState() {
  return lsGet(KEYS.ADMIN_LOCKOUT, { fails: 0, lockedUntil: 0 });
}
function setLockoutState(state) { lsSet(KEYS.ADMIN_LOCKOUT, state); }

function registerFailedLogin() {
  const state = getLockoutState();
  state.fails = (state.fails || 0) + 1;
  if (state.fails >= LOGIN_LOCKOUT_THRESHOLD) {
    state.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    state.fails = 0;
  }
  setLockoutState(state);
  return state;
}
function clearLockoutState() { setLockoutState({ fails: 0, lockedUntil: 0 }); }

function isLockedOut() {
  const state = getLockoutState();
  return state.lockedUntil && Date.now() < state.lockedUntil;
}

let _lockoutInterval = null;
function applyLockoutUI() {
  const btn = document.getElementById('adminLoginBtn');
  const errBox = document.getElementById('adminLoginError');
  if (_lockoutInterval) { clearInterval(_lockoutInterval); _lockoutInterval = null; }
  if (!isLockedOut()) {
    if (btn) btn.disabled = false;
    return;
  }
  if (btn) btn.disabled = true;
  const tick = () => {
    const state = getLockoutState();
    const remaining = Math.max(0, Math.ceil((state.lockedUntil - Date.now()) / 1000));
    if (remaining <= 0) {
      clearInterval(_lockoutInterval);
      _lockoutInterval = null;
      if (btn) btn.disabled = false;
      errBox.style.display = 'none';
      return;
    }
    errBox.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Забагато невдалих спроб. Спробуйте через ${remaining}с.`;
    errBox.style.display = 'block';
  };
  tick();
  _lockoutInterval = setInterval(tick, 1000);
}

function doAdminLogin() {
  if (isLockedOut()) { applyLockoutUI(); return; }
  const user = document.getElementById('adminLoginInput').value.trim();
  const pass = document.getElementById('adminPassInput').value;
  const errBox = document.getElementById('adminLoginError');

  if (user === getAdminUser() && pass === getAdminPass()) {
    errBox.style.display = 'none';
    clearLockoutState();
    setAdminSession(true);
    _adminSessionStart = Date.now();
    logEvent('Успішний вхід в адмінку (логін: ' + user + ')', 'ok');
    pushAudit('Успішний вхід в адмінку (логін: ' + user + ')');
    showAdmin();
  } else {
    logEvent('Невдала спроба входу (логін: ' + (user || '—') + ')', 'fail');
    const state = registerFailedLogin();
    if (state.lockedUntil && Date.now() < state.lockedUntil) {
      pushAudit('Автоблокування входу після кількох невдалих спроб (логін: ' + (user || '—') + ')');
      applyLockoutUI();
    } else {
      errBox.style.display = 'block';
    }
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

  // Maintenance mode
  const maintToggle = document.getElementById('maintenanceToggle');
  if (maintToggle) {
    maintToggle.checked = !!settings.maintenanceMode;
    updateMaintenanceUI(!!settings.maintenanceMode);
  }

  // API key
  const inp = document.getElementById('adminApiKeyInput');
  inp.value = settings.apiKey || '';
  const dot = document.getElementById('apiStatusDot');
  dot.style.display = 'inline-block';
  dot.className = 'status-dot' + (settings.apiKey ? '' : ' off');

  renderAdminModels(settings.models || DEFAULT_MODELS);
  renderAdminTestModelSelect(settings.models || DEFAULT_MODELS);

  // Templates editor draft
  _templatesDraft = JSON.parse(JSON.stringify((settings.templates && settings.templates.length) ? settings.templates : DEFAULT_TEMPLATES));
  renderTemplatesEditor();

  // Announcement banner
  const bannerToggle = document.getElementById('bannerToggle');
  if (bannerToggle) {
    bannerToggle.checked = !!settings.bannerEnabled;
    updateBannerUI(!!settings.bannerEnabled);
  }
  const bannerTextInput = document.getElementById('bannerTextInput');
  if (bannerTextInput) bannerTextInput.value = settings.bannerText || '';
  const bannerTypeSelect = document.getElementById('bannerTypeSelect');
  if (bannerTypeSelect) bannerTypeSelect.value = settings.bannerType || 'info';

  // Daily request limit
  const limitToggle = document.getElementById('limitToggle');
  const limitInput = document.getElementById('limitValueInput');
  if (limitToggle) {
    limitToggle.checked = !!settings.dailyLimitEnabled;
    updateLimitUI(!!settings.dailyLimitEnabled);
  }
  if (limitInput) limitInput.value = settings.dailyLimit ? settings.dailyLimit : '';

  // Tech panel (diagnostics / log / json) — admin-only, no effect on user app
  if (!_adminSessionStart) _adminSessionStart = Date.now();
  restoreLog();
  renderAuditLog(settings.auditLog);
  runDiagnostics();
  refreshRawJson();
  loadPeriodStats(_currentPeriodDays || 1);
  checkErrorAlert();
  loadHourlyBreakdown();
}

// ALERT-чіп у шапці адмінки, якщо сьогодні були помилки API
async function checkErrorAlert() {
  const chip = document.getElementById('adminAlertChip');
  if (!chip) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await getDoc(doc(db, 'stats', today));
    const errors = snap.exists() ? (snap.data().errors || 0) : 0;
    if (errors > 0) {
      chip.textContent = `⚠ Помилки сьогодні: ${errors}`;
      chip.style.display = 'inline-flex';
    } else {
      chip.style.display = 'none';
    }
  } catch(e) {
    chip.style.display = 'none';
  }
}

// Погодинний розподіл запитів за сьогодні
async function loadHourlyBreakdown() {
  const chartEl = document.getElementById('hourlyBarChart');
  if (!chartEl) return;
  chartEl.innerHTML = '<div class="bar-chart-empty">Завантаження…</div>';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const snap = await getDoc(doc(db, 'stats', today));
    const hours = snap.exists() ? (snap.data().hours || {}) : {};
    const data = [];
    for (let h = 0; h < 24; h++) {
      const key = String(h).padStart(2, '0');
      data.push({ hour: key, total: hours[key] || 0 });
    }
    const max = Math.max(1, ...data.map(d => d.total));
    chartEl.innerHTML = '';
    data.forEach(d => {
      const col = document.createElement('div');
      col.className = 'bar-chart-col';
      col.title = `${d.hour}:00 — ${d.total} запитів`;
      col.innerHTML = `<div class="bar-chart-bar" style="height:${Math.max(2, Math.round((d.total / max) * 100))}%"></div>`;
      chartEl.appendChild(col);
    });
  } catch(e) {
    chartEl.innerHTML = '<div class="bar-chart-empty">Помилка завантаження</div>';
  }
}

document.getElementById('hourlyRefreshBtn')?.addEventListener('click', loadHourlyBreakdown);

function renderAdminTestModelSelect(models) {
  const sel = document.getElementById('adminTestModelSelect');
  if (!sel) return;
  const prevVal = sel.value;
  sel.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = (m.label || m.id) + (m.enabled ? '' : ' (вимкнена)');
    if (!m.enabled) opt.className = 'opt-disabled-model';
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => o.value === prevVal)) sel.value = prevVal;
}

// ══════════════════════════════════════════════
// ADMIN — РЕДАКТОР ШАБЛОНІВ (settings.templates у Firestore)
// Впливає на вкладку "Шаблони" у користувачів лише після натискання
// "Зберегти шаблони"; за замовчуванням користувач бачить DEFAULT_TEMPLATES.
// ══════════════════════════════════════════════
let _templatesDraft = [];

function renderTemplatesEditor() {
  const list = document.getElementById('templatesEditorList');
  if (!list) return;
  list.innerHTML = '';
  _templatesDraft.forEach((cat, ci) => {
    const block = document.createElement('div');
    block.className = 'tpl-cat-block';
    const header = document.createElement('div');
    header.className = 'admin-row';
    header.style.gap = '8px';
    header.innerHTML = `
      <input type="text" class="model-add-input tpl-cat-title-input" data-cat="${ci}" value="${escHtml(cat.title || '')}" placeholder="Назва категорії" style="flex:1">
      <button class="btn-del-model" data-cat="${ci}" data-action="delcat" title="Видалити категорію"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
    block.appendChild(header);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'tpl-items';
    (cat.items || []).forEach((phrase, ii) => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.style.gap = '8px';
      row.innerHTML = `
        <input type="text" class="model-add-input" data-cat="${ci}" data-item="${ii}" value="${escHtml(phrase)}" style="flex:1">
        <button class="btn-del-model" data-cat="${ci}" data-item="${ii}" data-action="delitem" title="Видалити фразу"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
      itemsWrap.appendChild(row);
    });
    block.appendChild(itemsWrap);

    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-model';
    addBtn.type = 'button';
    addBtn.dataset.cat = ci;
    addBtn.dataset.action = 'additem';
    addBtn.textContent = '+ Фраза';
    addBtn.style.alignSelf = 'flex-start';
    block.appendChild(addBtn);

    list.appendChild(block);
  });

  // Category title edits
  list.querySelectorAll('.tpl-cat-title-input').forEach(inp => {
    inp.addEventListener('input', () => { _templatesDraft[+inp.dataset.cat].title = inp.value; });
  });
  // Phrase edits
  list.querySelectorAll('.tpl-items input').forEach(inp => {
    inp.addEventListener('input', () => { _templatesDraft[+inp.dataset.cat].items[+inp.dataset.item] = inp.value; });
  });
  // Delete category
  list.querySelectorAll('[data-action="delcat"]').forEach(btn => {
    btn.addEventListener('click', () => { _templatesDraft.splice(+btn.dataset.cat, 1); renderTemplatesEditor(); });
  });
  // Delete phrase
  list.querySelectorAll('[data-action="delitem"]').forEach(btn => {
    btn.addEventListener('click', () => { _templatesDraft[+btn.dataset.cat].items.splice(+btn.dataset.item, 1); renderTemplatesEditor(); });
  });
  // Add phrase
  list.querySelectorAll('[data-action="additem"]').forEach(btn => {
    btn.addEventListener('click', () => { _templatesDraft[+btn.dataset.cat].items.push(''); renderTemplatesEditor(); });
  });
}

document.getElementById('addTemplateCatBtn')?.addEventListener('click', () => {
  _templatesDraft.push({ title: '', items: [''] });
  renderTemplatesEditor();
});

document.getElementById('saveTemplatesBtn')?.addEventListener('click', async () => {
  // Прибираємо порожні категорії/фрази перед збереженням
  const cleaned = _templatesDraft
    .map(c => ({ title: (c.title || '').trim(), items: (c.items || []).map(i => i.trim()).filter(Boolean) }))
    .filter(c => c.title && c.items.length);
  const ok = await fsSet('settings', { templates: cleaned });
  invalidateCache();
  if (ok) {
    _templatesDraft = JSON.parse(JSON.stringify(cleaned));
    renderTemplatesEditor();
    showTmpMsg('templatesSavedMsg');
    logEvent(`Шаблони збережено (${cleaned.length} категорій)`, 'ok');
    pushAudit(`Оновлено шаблони (${cleaned.length} категорій)`);
  } else {
    logEvent('Помилка збереження шаблонів', 'fail');
  }
});

function updateMaintenanceUI(isOn) {
  const label = document.getElementById('maintenanceStatusLabel');
  const dot = document.getElementById('maintenanceStatusDot');
  if (label) {
    label.textContent = isOn ? 'Увімкнено — застосунок недоступний для користувачів' : 'Вимкнено — застосунок працює';
    label.style.color = isOn ? 'var(--rose)' : 'var(--text)';
  }
  if (dot) {
    dot.style.display = 'inline-block';
    dot.className = 'status-dot' + (isOn ? ' off' : '');
  }
}

document.getElementById('maintenanceToggle').addEventListener('change', async (e) => {
  const checked = e.target.checked;
  const toggle = e.target;
  toggle.disabled = true;
  const ok = await fsSet('settings', { maintenanceMode: checked });
  invalidateCache();
  toggle.disabled = false;
  if (ok) {
    updateMaintenanceUI(checked);
    showTmpMsg('maintenanceSavedMsg');
    logEvent('Режим технічних робіт: ' + (checked ? 'УВІМКНЕНО' : 'вимкнено'), checked ? 'fail' : 'ok');
    pushAudit('Режим технічних робіт: ' + (checked ? 'увімкнено' : 'вимкнено'));
  } else {
    // Відкат чекбокса якщо збереження не вдалось
    toggle.checked = !checked;
  }
});

// ══════════════════════════════════════════════
// ADMIN — ДЕННИЙ ЛІМІТ ЗАПИТІВ (опційно, вимкнено за замовчуванням)
// ══════════════════════════════════════════════
function updateLimitUI(isOn) {
  const label = document.getElementById('limitStatusLabel');
  const dot = document.getElementById('limitStatusDot');
  if (label) {
    label.textContent = isOn ? 'Увімкнено — застосунок обмежує кількість запитів' : 'Вимкнено — без обмежень';
    label.style.color = isOn ? 'var(--rose)' : 'var(--text)';
  }
  if (dot) {
    dot.style.display = 'inline-block';
    dot.className = 'status-dot' + (isOn ? '' : ' off');
  }
}

document.getElementById('limitToggle')?.addEventListener('change', async (e) => {
  const checked = e.target.checked;
  const toggle = e.target;
  toggle.disabled = true;
  const ok = await fsSet('settings', { dailyLimitEnabled: checked });
  invalidateCache();
  toggle.disabled = false;
  if (ok) {
    updateLimitUI(checked);
    showTmpMsg('limitSavedMsg');
    logEvent('Денний ліміт запитів: ' + (checked ? 'УВІМКНЕНО' : 'вимкнено'), checked ? 'info' : 'ok');
  } else {
    toggle.checked = !checked;
  }
});

document.getElementById('saveLimitBtn')?.addEventListener('click', async () => {
  const inp = document.getElementById('limitValueInput');
  const val = parseInt(inp.value, 10);
  if (isNaN(val) || val < 1) { inp.animate([{borderColor:'rgba(251,113,133,0.6)'},{borderColor:''}],{duration:400}); return; }
  const ok = await fsSet('settings', { dailyLimit: val });
  invalidateCache();
  if (ok) { showTmpMsg('limitSavedMsg'); logEvent(`Денний ліміт запитів встановлено: ${val}`, 'ok'); pushAudit(`Денний ліміт запитів встановлено: ${val}`); }
});

// ══════════════════════════════════════════════
// ADMIN — ОГОЛОШЕННЯ (БАНЕР ДЛЯ КОРИСТУВАЧІВ)
// Вимкнено за замовчуванням. Коли увімкнено — показується у #app-screen.
// ══════════════════════════════════════════════
function updateBannerUI(isOn) {
  const label = document.getElementById('bannerStatusLabel');
  const dot = document.getElementById('bannerStatusDot');
  if (label) {
    label.textContent = isOn ? 'Увімкнено — банер видно користувачам' : 'Вимкнено — банер не показується';
    label.style.color = isOn ? 'var(--rose)' : 'var(--text)';
  }
  if (dot) {
    dot.style.display = 'inline-block';
    dot.className = 'status-dot' + (isOn ? '' : ' off');
  }
}

document.getElementById('bannerToggle')?.addEventListener('change', async (e) => {
  const checked = e.target.checked;
  const toggle = e.target;
  toggle.disabled = true;
  const ok = await fsSet('settings', { bannerEnabled: checked });
  invalidateCache();
  toggle.disabled = false;
  if (ok) {
    updateBannerUI(checked);
    showTmpMsg('bannerSavedMsg');
    logEvent('Банер оголошення: ' + (checked ? 'УВІМКНЕНО' : 'вимкнено'), checked ? 'info' : 'ok');
    pushAudit('Банер оголошення: ' + (checked ? 'увімкнено' : 'вимкнено'));
  } else {
    toggle.checked = !checked;
  }
});

document.getElementById('saveBannerBtn')?.addEventListener('click', async () => {
  const text = document.getElementById('bannerTextInput').value.trim().slice(0, 140);
  const type = document.getElementById('bannerTypeSelect').value || 'info';
  const ok = await fsSet('settings', { bannerText: text, bannerType: type });
  invalidateCache();
  if (ok) {
    showTmpMsg('bannerSavedMsg');
    logEvent('Текст банера оновлено', 'ok');
    pushAudit('Текст банера оновлено: "' + text.slice(0, 60) + '"');
  }
});

// Показ банера в застосунку користувача (викликається з showApp())
function renderBanner(settings) {
  const el = document.getElementById('appBanner');
  const textEl = document.getElementById('appBannerText');
  if (!el || !textEl) return;
  if (settings.bannerEnabled && settings.bannerText) {
    textEl.textContent = settings.bannerText;
    el.className = 'app-banner' + (settings.bannerType && settings.bannerType !== 'info' ? ' app-banner--' + settings.bannerType : '');
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
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
      <input type="number" class="model-price-input" data-idx="${i}" value="${typeof m.price === 'number' && m.price > 0 ? m.price : ''}" placeholder="${getModelPrice(m.id).toFixed(4)}" step="0.0001" min="0" title="Ціна за запит (USD), порожньо = за замовчуванням">
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
      pushAudit(`Модель ${mods[+cb.dataset.idx].id}: ${cb.checked ? 'увімкнено' : 'вимкнено'}`);
    });
  });

  list.querySelectorAll('.model-price-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const settings = await getSettings();
      const mods = settings.models || DEFAULT_MODELS;
      const raw = inp.value.trim();
      const val = raw === '' ? null : parseFloat(raw);
      if (val === null || isNaN(val) || val <= 0) delete mods[+inp.dataset.idx].price;
      else mods[+inp.dataset.idx].price = val;
      await fsSet('settings', { models: mods });
      invalidateCache();
      showTmpMsg('modelsSavedMsg');
      logEvent(`Ціну моделі ${mods[+inp.dataset.idx].id} оновлено`, 'ok');
      pushAudit(`Ціну моделі ${mods[+inp.dataset.idx].id} оновлено`);
    });
  });

  list.querySelectorAll('.btn-del-model').forEach(btn => {
    btn.onclick = async () => {
      const settings = await getSettings();
      const mods = settings.models || DEFAULT_MODELS;
      const removedId = mods[+btn.dataset.idx]?.id;
      mods.splice(+btn.dataset.idx, 1);
      await fsSet('settings', { models: mods });
      invalidateCache();
      const s2 = await getSettings();
      renderAdminModels(s2.models || DEFAULT_MODELS);
      showTmpMsg('modelsSavedMsg');
      pushAudit(`Модель видалено: ${removedId}`);
    };
  });
}

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

  if (ok) { showTmpMsg('apiKeySavedMsg'); logEvent('API ключ збережено', 'ok'); pushAudit('API ключ оновлено'); refreshRawJson(); }
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
  pushAudit(`Додано модель: ${val}`);
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
  logEvent('Дані входу адміна оновлено (логін: ' + login + ')', 'ok');
  pushAudit('Дані входу адміна оновлено (логін: ' + login + ')');
};

function showTmpMsg(id) {
  const el = document.getElementById(id);
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 2500);
}

// ══════════════════════════════════════════════
// ADMIN — TECH PANEL (diagnostics / api tester / raw json / log / danger zone)
// Everything below is admin-only: it does not touch fixText(), the Gemini
// prompt, renderAppModels(), or anything rendered inside #app-screen.
// ══════════════════════════════════════════════
let _adminSessionStart = null;

// Персистентний аудит-журнал (зберігається у Firestore settings.auditLog,
// на відміну від logEvent()/sessionStorage — переживає перезавантаження і видно на всіх пристроях).
async function pushAudit(action) {
  try {
    const settings = await getSettings();
    const log = Array.isArray(settings.auditLog) ? settings.auditLog.slice(-99) : [];
    log.push({ time: new Date().toISOString(), user: getAdminUser(), action });
    await fsSet('settings', { auditLog: log });
    invalidateCache();
    renderAuditLog(log);
  } catch(e) { /* аудит не критичний — тихо ігноруємо помилку */ }
}

function renderAuditLog(log) {
  const box = document.getElementById('auditLog');
  if (!box) return;
  if (!log || !log.length) { box.innerHTML = '<div class="term-log-line term-log-line--dim">// історія порожня</div>'; return; }
  box.innerHTML = '';
  log.slice().reverse().forEach(e => {
    const line = document.createElement('div');
    line.className = 'term-log-line';
    const dt = new Date(e.time);
    const dtStr = isNaN(dt) ? e.time : dt.toLocaleString('uk-UA', { hour12: false });
    line.textContent = `[${dtStr}] (${e.user || '?'}) ${e.action}`;
    box.appendChild(line);
  });
}

function logEvent(msg, type) {
  const time = new Date().toLocaleTimeString('uk-UA', { hour12: false });
  const log = JSON.parse(sessionStorage.getItem('ct_admin_log') || '[]');
  log.push({ time, msg, type });
  sessionStorage.setItem('ct_admin_log', JSON.stringify(log.slice(-200)));
  restoreLog();
}

// Пошук + фільтр за типом застосовуються тут же, при кожному рендері журналу
function restoreLog() {
  const box = document.getElementById('activityLog');
  if (!box) return;
  const search = (document.getElementById('logSearchInput')?.value || '').trim().toLowerCase();
  const typeFilter = document.getElementById('logFilterSelect')?.value || '';
  box.innerHTML = '';
  let log = JSON.parse(sessionStorage.getItem('ct_admin_log') || '[]');
  if (typeFilter) log = log.filter(e => e.type === typeFilter);
  if (search) log = log.filter(e => e.msg.toLowerCase().includes(search));
  if (!log.length) { box.innerHTML = '<div class="term-log-line term-log-line--dim">// журнал порожній або нічого не знайдено</div>'; return; }
  log.forEach(e => {
    const line = document.createElement('div');
    line.className = 'term-log-line' + (e.type ? ' term-log-line--' + e.type : '');
    line.textContent = `[${e.time}] ${e.msg}`;
    box.appendChild(line);
  });
  box.scrollTop = box.scrollHeight;
}

document.getElementById('clearLogBtn')?.addEventListener('click', () => {
  sessionStorage.removeItem('ct_admin_log');
  restoreLog();
});

document.getElementById('exportLogBtn')?.addEventListener('click', () => {
  const log = JSON.parse(sessionStorage.getItem('ct_admin_log') || '[]');
  const text = log.length ? log.map(e => `[${e.time}] ${e.type ? '[' + e.type + '] ' : ''}${e.msg}`).join('\n') : '// журнал порожній';
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cleartext-log-${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('logSearchInput')?.addEventListener('input', () => restoreLog());
document.getElementById('logFilterSelect')?.addEventListener('change', () => restoreLog());

// Live clock + session uptime (admin header + diagnostics card)
function tickAdminClock() {
  const now = new Date().toLocaleTimeString('uk-UA', { hour12: false });
  const clockEl = document.getElementById('diagClock');
  if (clockEl) clockEl.textContent = now;
  const termClock = document.getElementById('admTermClock');
  if (termClock) termClock.textContent = now;
  const sinceEl = document.getElementById('diagSessionSince');
  if (sinceEl && _adminSessionStart) {
    const diff = Math.floor((Date.now() - _adminSessionStart) / 1000);
    const m = String(Math.floor(diff / 60)).padStart(2, '0');
    const s = String(diff % 60).padStart(2, '0');
    sinceEl.textContent = `${m}:${s}`;
  }
}
setInterval(tickAdminClock, 1000);

async function runDiagnostics() {
  const statusEl = document.getElementById('diagOverallStatus');
  const fbEl = document.getElementById('diagFirebaseStatus');
  const latEl = document.getElementById('diagLatency');
  const onlineEl = document.getElementById('diagOnline');
  const swEl = document.getElementById('diagSW');
  const dispEl = document.getElementById('diagDisplayMode');
  const platEl = document.getElementById('diagPlatform');
  const uaEl = document.getElementById('diagUA');
  if (!statusEl) return;
  statusEl.textContent = 'CHECKING…';
  statusEl.className = 'term-chip';

  if (onlineEl) { onlineEl.textContent = navigator.onLine ? 'ONLINE' : 'OFFLINE'; onlineEl.className = 'diag-value ' + (navigator.onLine ? 'ok' : 'fail'); }

  if (swEl) {
    try {
      const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
      swEl.textContent = regs.length ? `АКТИВНИЙ ×${regs.length}` : 'НЕ ЗАРЕЄСТРОВАНО';
      swEl.className = 'diag-value ' + (regs.length ? 'ok' : 'warn');
    } catch { swEl.textContent = 'N/A'; }
  }

  if (dispEl) {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    dispEl.textContent = standalone ? 'STANDALONE' : 'BROWSER';
  }
  if (platEl) platEl.textContent = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '—';
  if (uaEl) uaEl.textContent = navigator.userAgent;

  const swVerEl = document.getElementById('diagSWVersion');
  if (swVerEl) {
    try {
      const res = await fetch('sw.js', { cache: 'no-store' });
      const txt = await res.text();
      const m = txt.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
      swVerEl.textContent = m ? m[1] : 'невідомо';
    } catch { swVerEl.textContent = 'N/A'; }
  }

  const t0 = performance.now();
  try {
    await fsGet('settings');
    const ms = Math.round(performance.now() - t0);
    if (fbEl) { fbEl.textContent = 'OK'; fbEl.className = 'diag-value ok'; }
    if (latEl) latEl.textContent = ms + ' ms';
    statusEl.textContent = 'OK';
    statusEl.className = 'term-chip term-chip--ok';
  } catch (e) {
    if (fbEl) { fbEl.textContent = 'ПОМИЛКА'; fbEl.className = 'diag-value fail'; }
    if (latEl) latEl.textContent = '—';
    statusEl.textContent = 'FAIL';
    statusEl.className = 'term-chip term-chip--fail';
  }
}
document.getElementById('diagRefreshBtn')?.addEventListener('click', () => {
  logEvent('Запущено оновлення діагностики', 'info');
  runDiagnostics();
});

document.getElementById('diagUpdateSwBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('diagUpdateSwBtn');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = '⏳ Оновлення…';
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) { await reg.update(); logEvent('Service Worker: примусове оновлення виконано', 'ok'); }
      else logEvent('Service Worker: реєстрацію не знайдено', 'fail');
    } else {
      logEvent('Service Worker недоступний у цьому браузері', 'fail');
    }
  } catch (e) {
    logEvent('Помилка оновлення Service Worker: ' + e.message, 'fail');
  }
  btn.disabled = false;
  btn.innerHTML = orig;
  runDiagnostics();
});

document.getElementById('diagCopyBtn')?.addEventListener('click', async () => {
  const lines = [
    `Firestore: ${document.getElementById('diagFirebaseStatus')?.textContent}`,
    `Затримка БД: ${document.getElementById('diagLatency')?.textContent}`,
    `Мережа: ${document.getElementById('diagOnline')?.textContent}`,
    `Service Worker: ${document.getElementById('diagSW')?.textContent}`,
    `Версія SW кешу: ${document.getElementById('diagSWVersion')?.textContent}`,
    `Режим показу: ${document.getElementById('diagDisplayMode')?.textContent}`,
    `Платформа: ${document.getElementById('diagPlatform')?.textContent}`,
    `Локальний час: ${document.getElementById('diagClock')?.textContent}`,
    `User-Agent: ${document.getElementById('diagUA')?.textContent}`,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(lines);
    logEvent('Діагностику скопійовано в буфер обміну', 'info');
  } catch (e) {
    logEvent('Не вдалося скопіювати діагностику: ' + e.message, 'fail');
  }
});

// API key tester — isolated GET request, separate from the user-facing generateContent call
document.getElementById('testApiKeyBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('testApiKeyBtn');
  const resBox = document.getElementById('apiTestResult');
  const key = document.getElementById('adminApiKeyInput').value.trim();
  resBox.style.display = 'block';
  if (!key) {
    resBox.innerHTML = '<div class="term-log-line term-log-line--fail">// помилка: ключ порожній</div>';
    return;
  }
  btn.disabled = true;
  const origHtml = btn.innerHTML;
  btn.innerHTML = '⏳ Перевірка…';
  resBox.innerHTML = '<div class="term-log-line term-log-line--dim">// надсилання запиту...</div>';
  const t0 = performance.now();
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    const ms = Math.round(performance.now() - t0);
    const data = await res.json();
    if (res.ok) {
      const count = (data.models || []).length;
      resBox.innerHTML =
        `<div class="term-log-line term-log-line--ok">// HTTP ${res.status} OK</div>` +
        `<div class="term-log-line">// затримка: ${ms} ms</div>` +
        `<div class="term-log-line">// доступно моделей: ${count}</div>`;
      logEvent(`Тест API ключа: успішно (${ms} ms, ${count} моделей)`, 'ok');
    } else {
      resBox.innerHTML =
        `<div class="term-log-line term-log-line--fail">// HTTP ${res.status}</div>` +
        `<div class="term-log-line term-log-line--fail">// ${escHtml((data.error && data.error.message) || 'невідома помилка')}</div>`;
      logEvent(`Тест API ключа: помилка HTTP ${res.status}`, 'fail');
    }
  } catch (e) {
    resBox.innerHTML = `<div class="term-log-line term-log-line--fail">// мережева помилка: ${escHtml(e.message)}</div>`;
    logEvent('Тест API ключа: мережева помилка', 'fail');
  }
  btn.disabled = false;
  btn.innerHTML = origHtml;
});

// AI corrector tester — runs buildFixPrompt() through the selected model once,
// isolated from fixText(): does not save stats, does not touch the user app screen.
document.getElementById('adminTestRunBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('adminTestRunBtn');
  const resBox = document.getElementById('adminTestResult');
  const text = document.getElementById('adminTestInput').value.trim();
  const model = document.getElementById('adminTestModelSelect').value;
  const key = (document.getElementById('adminApiKeyInput').value.trim()) || (await getSettings()).apiKey;
  resBox.style.display = 'block';

  if (!text) { resBox.innerHTML = '<div class="term-log-line term-log-line--fail">// помилка: введіть текст для тесту</div>'; return; }
  if (!key) { resBox.innerHTML = '<div class="term-log-line term-log-line--fail">// помилка: немає API ключа (заповніть поле вище)</div>'; return; }
  if (!model) { resBox.innerHTML = '<div class="term-log-line term-log-line--fail">// помилка: немає доступних моделей</div>'; return; }

  btn.disabled = true;
  const origHtml = btn.innerHTML;
  btn.innerHTML = '⏳ Тестування…';
  resBox.innerHTML = `<div class="term-log-line term-log-line--dim">// надсилання запиту до ${escHtml(model)}...</div>`;
  const t0 = performance.now();
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: buildFixPrompt(text) }] }],
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
    const ms = Math.round(performance.now() - t0);
    const data = await res.json();
    if (!res.ok || data.error) {
      resBox.innerHTML = `<div class="term-log-line term-log-line--fail">// HTTP ${res.status}</div><div class="term-log-line term-log-line--fail">// ${escHtml((data.error && data.error.message) || 'невідома помилка')}</div>`;
      logEvent(`Тест виправлення: помилка HTTP ${res.status} (${model})`, 'fail');
      return;
    }
    if (data.candidates?.[0]?.finishReason === 'SAFETY') {
      resBox.innerHTML = `<div class="term-log-line term-log-line--fail">// заблоковано фільтром безпеки (SAFETY)</div>`;
      logEvent(`Тест виправлення: заблоковано SAFETY (${model})`, 'fail');
      return;
    }
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    raw = raw.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); }

    if (parsed) {
      resBox.innerHTML =
        `<div class="term-log-line term-log-line--ok">// HTTP ${res.status} OK · ${ms} ms · модель: ${escHtml(model)}</div>` +
        `<div class="term-log-line">// виправлено: ${escHtml(parsed.corrected || '—')}</div>` +
        `<div class="term-log-line">// змін: ${(parsed.changes || []).length}${parsed.noChanges ? ' (текст без помилок)' : ''}</div>` +
        (parsed.changes && parsed.changes.length ? parsed.changes.map(c => `<div class="term-log-line term-log-line--dim">//  "${escHtml(c.before)}" → "${escHtml(c.after)}" — ${escHtml(c.reason || '')}</div>`).join('') : '');
      logEvent(`Тест виправлення успішний (${ms} ms, модель: ${model})`, 'ok');
    } else {
      resBox.innerHTML = `<div class="term-log-line term-log-line--fail">// не вдалося розпізнати відповідь моделі</div><div class="term-log-line term-log-line--dim">// сира відповідь: ${escHtml(raw.slice(0, 300))}</div>`;
      logEvent('Тест виправлення: не вдалося розпізнати JSON-відповідь', 'fail');
    }
  } catch (e) {
    resBox.innerHTML = `<div class="term-log-line term-log-line--fail">// мережева помилка: ${escHtml(e.message)}</div>`;
    logEvent('Тест виправлення: мережева помилка', 'fail');
  }
  btn.disabled = false;
  btn.innerHTML = origHtml;
});

// Raw JSON settings — view / export / import
async function refreshRawJson() {
  const ta = document.getElementById('rawSettingsJson');
  if (!ta) return;
  const settings = await getSettings();
  ta.value = JSON.stringify(settings, null, 2);
}
document.getElementById('refreshJsonBtn')?.addEventListener('click', () => {
  invalidateCache();
  refreshRawJson();
  logEvent('Оновлено перегляд JSON налаштувань', 'info');
});

document.getElementById('exportJsonBtn')?.addEventListener('click', async () => {
  const settings = await getSettings();
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cleartext-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  logEvent('Експортовано settings.json', 'info');
});

document.getElementById('importJsonInput')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('Очікується JSON-об\u2019єкт');
    if (!confirm('Перезаписати поточні налаштування вмістом файлу? Цю дію не можна скасувати.')) { e.target.value = ''; return; }
    const ok = await fsSet('settings', obj);
    invalidateCache();
    if (ok) {
      await renderAdmin();
      showTmpMsg('jsonSavedMsg');
      logEvent('Імпортовано налаштування з файлу ' + file.name, 'ok');
      pushAudit('Імпортовано налаштування з файлу ' + file.name);
    } else {
      logEvent('Помилка запису імпортованих налаштувань', 'fail');
    }
  } catch (err) {
    alert('Помилка імпорту: ' + err.message);
    logEvent('Помилка імпорту JSON: ' + err.message, 'fail');
  }
  e.target.value = '';
});

// ══════════════════════════════════════════════
// ADMIN — СТАТИСТИКА ЗА ПЕРІОД (сьогодні / 7 днів / 30 днів)
// Читає ті самі документи 'stats/{date}', що й основна статистика,
// нічого не пише і не впливає на застосунок для користувачів.
// ══════════════════════════════════════════════
let _currentPeriodDays = 1;
let _lastPeriodData = [];

function isoDateMinus(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function loadPeriodStats(days) {
  _currentPeriodDays = days;
  document.querySelectorAll('.period-tab').forEach(t => t.classList.toggle('active', +t.dataset.days === days));

  const totalEl = document.getElementById('periodTotal');
  const avgEl = document.getElementById('periodAvg');
  const costEl = document.getElementById('periodCost');
  const chartEl = document.getElementById('periodBarChart');
  if (!totalEl || !chartEl) return;

  totalEl.textContent = '…';
  avgEl.textContent = '…';
  costEl.textContent = '…';
  chartEl.innerHTML = '<div class="bar-chart-empty">Завантаження…</div>';

  const settingsForPrice = await getSettings();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(isoDateMinus(i));

  const results = await Promise.all(dates.map(async d => {
    try {
      const snap = await getDoc(doc(db, 'stats', d));
      if (!snap.exists()) return { date: d, total: 0, cost: 0 };
      const data = snap.data();
      let cost = parseFloat(data.totalCostUsd) || 0;
      if (!cost && data.models) {
        cost = Object.entries(data.models).reduce((sum, [m, c]) => sum + getModelPriceFromList(m, settingsForPrice.models) * c, 0);
      }
      return { date: d, total: data.total || 0, cost };
    } catch(e) {
      return { date: d, total: 0, cost: 0 };
    }
  }));

  _lastPeriodData = results;
  const totalSum = results.reduce((s, r) => s + r.total, 0);
  const costSum = results.reduce((s, r) => s + r.cost, 0);
  totalEl.textContent = totalSum;
  avgEl.textContent = (totalSum / days).toFixed(1);
  costEl.textContent = costSum < 0.01 ? '$' + costSum.toFixed(6) : '$' + costSum.toFixed(4);

  const max = Math.max(1, ...results.map(r => r.total));
  chartEl.innerHTML = '';
  results.forEach(r => {
    const col = document.createElement('div');
    col.className = 'bar-chart-col';
    const dayLabel = r.date.slice(5).replace('-', '/');
    col.title = `${r.date}: ${r.total} запитів`;
    col.innerHTML = `<div class="bar-chart-bar" style="height:${Math.max(2, Math.round((r.total / max) * 100))}%"></div>` +
      (days <= 7 ? `<div style="font-size:9px;color:var(--adm-dim);writing-mode:vertical-rl">${dayLabel}</div>` : '');
    chartEl.appendChild(col);
  });
}

document.querySelectorAll('.period-tab').forEach(btn => {
  btn.addEventListener('click', () => loadPeriodStats(+btn.dataset.days));
});

document.getElementById('periodExportBtn')?.addEventListener('click', () => {
  if (!_lastPeriodData.length) return;
  const rows = ['date,total_requests,cost_usd', ...(_lastPeriodData.map(r => `${r.date},${r.total},${r.cost.toFixed(6)}`))];
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cleartext-stats-${_currentPeriodDays}d-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  logEvent(`Експортовано CSV статистики (${_currentPeriodDays} дн.)`, 'info');
});

// Danger zone
document.getElementById('resetStatsBtn')?.addEventListener('click', async () => {
  if (!confirm('Скинути статистику за сьогодні? Дію неможливо скасувати.')) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await setDoc(doc(db, 'stats', today), { total: 0, noChanges: 0, totalChanges: 0, totalCostUsd: 0, models: {}, lastUpdated: new Date().toISOString() });
    logEvent('Статистику за ' + today + ' скинуто', 'ok');
    pushAudit('Статистику за ' + today + ' скинуто');
  } catch (e) {
    logEvent('Помилка скидання статистики: ' + e.message, 'fail');
    alert('Помилка: ' + e.message);
  }
});

document.getElementById('resetModelsBtn')?.addEventListener('click', async () => {
  if (!confirm('Відновити список моделей за замовчуванням?')) return;
  await fsSet('settings', { models: DEFAULT_MODELS });
  invalidateCache();
  const s = await getSettings();
  renderAdminModels(s.models || DEFAULT_MODELS);
  refreshRawJson();
  logEvent('Моделі відновлено до значень за замовчуванням', 'ok');
  pushAudit('Моделі відновлено до значень за замовчуванням');
});

document.getElementById('resetTemplatesBtn')?.addEventListener('click', async () => {
  if (!confirm('Відновити шаблони за замовчуванням? Кастомні фрази буде втрачено.')) return;
  await fsSet('settings', { templates: DEFAULT_TEMPLATES });
  invalidateCache();
  _templatesDraft = JSON.parse(JSON.stringify(DEFAULT_TEMPLATES));
  renderTemplatesEditor();
  refreshRawJson();
  logEvent('Шаблони відновлено до значень за замовчуванням', 'ok');
  pushAudit('Шаблони відновлено до значень за замовчуванням');
});

document.getElementById('resetCredsBtn')?.addEventListener('click', () => {
  if (!confirm('Скинути логін і пароль адміна до значень за замовчуванням на цьому пристрої?')) return;
  lsSet(KEYS.ADMIN_USER, DEFAULT_ADMIN.user);
  lsSet(KEYS.ADMIN_PASS, DEFAULT_ADMIN.pass);
  logEvent('Дані входу адміна скинуто до значень за замовчуванням', 'ok');
  pushAudit('Дані входу адміна скинуто до значень за замовчуванням (цей пристрій)');
  alert('Дані входу скинуто до admin / admin123.');
});


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
// TAB BAR — Виправлення / Шаблони (плаваючий острівець)
// ══════════════════════════════════════════════
function moveTabIndicator(btn) {
  const nav = document.getElementById('tabBar');
  const indicator = document.getElementById('tabIndicator');
  if (!nav || !indicator || !btn) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = btn.getBoundingClientRect();
  indicator.style.width = btnRect.width + 'px';
  indicator.style.transform = `translateX(${btnRect.left - navRect.left}px)`;
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === tabId));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelector('.app-body')?.scrollTo?.({ top: 0, behavior: 'instant' });
  window.scrollTo({ top: 0, behavior: 'instant' });
  const activeBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  moveTabIndicator(activeBtn);
  if (tabId === 'tab-speak') renderSpeakTab();
  else { stopSpeaking(); stopListening(); }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Тримаємо індикатор під активною вкладкою і при зміні розміру вікна
window.addEventListener('resize', () => {
  const activeBtn = document.querySelector('.tab-btn.active');
  if (activeBtn) moveTabIndicator(activeBtn);
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
// DEFAULT_TEMPLATES — використовується, якщо в Firestore (settings.templates)
// ще немає кастомних шаблонів, або як основа для "Відновити за замовчуванням".
const DEFAULT_TEMPLATES = [
  {
    title: 'Привітання',
    items: [
      'Доброго дня, як у вас справи?',
      'Вітаю з днем народження, бажаю здоров\u2019я!',
      'Дякую за допомогу, дуже приємно.',
    ]
  },
  {
    title: 'Прохання',
    items: [
      'Будь ласка, допоможіть мені з цим питанням.',
      'Можна я прийду завтра трохи пізніше?',
      'Підкажіть, будь ласка, як це зробити.',
    ]
  },
  {
    title: 'Пояснення',
    items: [
      'Я не почув, що ви сказали, повторіть, будь ласка.',
      'Вибачте, я погано чую, можете писати текстом?',
      'Мені потрібен жестовий перекладач на прийомі.',
    ]
  },
  {
    title: 'Побутове',
    items: [
      'Учора я ходив у магазин, купував хліб і молоко.',
      'Завтра йду до лікаря о другій годині.',
      'Зателефонуйте мені або напишіть смс, будь ласка.',
    ]
  }
];

function renderTemplates(categories) {
  const list = document.getElementById('templates-list');
  if (!list) return;
  const cats = (categories && categories.length) ? categories : DEFAULT_TEMPLATES;
  list.innerHTML = '';
  cats.forEach(cat => {
    const block = document.createElement('div');
    block.className = 'template-cat';
    const catTitle = document.createElement('div');
    catTitle.className = 'template-cat-title';
    catTitle.textContent = cat.title;
    block.appendChild(catTitle);
    (cat.items || []).forEach(phrase => {
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

// Промпт винесено в окрему функцію, щоб її міг використати і тестер AI в адмінці
// (без впливу на логіку чи вигляд застосунку для користувачів).
function buildFixPrompt(text) {
  return `Ти — асистент з виправлення тексту для людей з вадами слуху, які пишуть неграмотно.

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
}

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

  // Денний ліміт запитів — вмикається лише вручну адміном, за замовчуванням вимкнено
  if (settings.dailyLimitEnabled && settings.dailyLimit > 0) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const snap = await getDoc(doc(db, 'stats', today));
      const totalToday = snap.exists() ? (snap.data().total || 0) : 0;
      if (totalToday >= settings.dailyLimit) {
        document.getElementById('errorBox').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Денний ліміт запитів вичерпано (${settings.dailyLimit}). Спробуйте завтра.`;
        document.getElementById('errorBox').style.display = 'block';
        return;
      }
    } catch(e) { /* при помилці перевірки — не блокуємо користувача */ }
  }

  const btn = document.getElementById('fixBtn');
  btn.classList.add('loading');
  btn.disabled = true;
  document.getElementById('result-card').style.display = 'none';
  document.getElementById('errorBox').style.display = 'none';

  const prompt = buildFixPrompt(text);
  const _fixStart = performance.now();

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
            saveErrorStat();
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
            saveErrorStat();
            return;
          }

          // Safety block — not retriable, content issue
          if (data.candidates?.[0]?.finishReason === 'SAFETY') {
            showBlocked('Текст містить недопустимий контент і не може бути оброблений.');
            saveBlockedStat();
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
            saveBlockedStat();
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
      saveErrorStat();
      return;
    }

    // Update the select UI to reflect which model actually responded
    if (usedModel) {
      const sel = document.getElementById('modelSelect');
      if ([...sel.options].some(o => o.value === usedModel)) sel.value = usedModel;
    }

    showResult(parsed);
    const _latencyMs = Math.round(performance.now() - _fixStart);
    await saveStats(parsed.changes ? parsed.changes.length : 0, parsed.noChanges, usedModel || selectedModel, settings2.models, _latencyMs);

  } catch(err) {
    document.getElementById('errorBox').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ${err.message}`;
    document.getElementById('errorBox').style.display = 'block';
    saveErrorStat();
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
  _lastFixedText = data.corrected || '';
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

// ══════════════════════════════════════════════
// СПІЛЬНІ ФУНКЦІЇ: копіювати / поділитися / прочитати вголос
// Використовуються і в картці результату, і на вкладці «Спілкування».
// ══════════════════════════════════════════════
let _lastFixedText = '';

async function copyText(text, btn) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch(e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  if (!btn) return;
  const origHtml = btn.innerHTML;
  const checkSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  btn.innerHTML = btn.querySelector('span') ? `${checkSvg}<span>Скопійовано!</span>` : checkSvg;
  btn.classList.add('success');
  setTimeout(() => { btn.innerHTML = origHtml; btn.classList.remove('success'); }, 2000);
}

async function shareText(text) {
  if (!text) return;
  // Використовуємо нативний Web Share API якщо доступний (iOS/Android)
  if (navigator.share) {
    try { await navigator.share({ text }); } catch(e) { /* користувач закрив меню */ }
    return;
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
  menu.onclick = e => { if (e.target === menu) menu.remove(); };
}

// ── Text-to-Speech (Web Speech API) ──────────────────
let _speechUtterance = null;
function pickUkrainianVoice() {
  const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
  return voices.find(v => v.lang?.toLowerCase().startsWith('uk')) || null;
}
function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  document.querySelectorAll('.speak-action-btn--primary.speaking').forEach(btn => {
    btn.classList.remove('speaking');
    const label = btn.querySelector('span');
    if (label) label.textContent = 'Прочитати вголос';
  });
}
function speakText(text, btn) {
  if (!text) return;
  if (!('speechSynthesis' in window)) {
    alert('На жаль, цей браузер не підтримує озвучення тексту.');
    return;
  }
  // Повторне натискання під час озвучення — зупиняє
  if (window.speechSynthesis.speaking) {
    stopSpeaking();
    return;
  }
  _speechUtterance = new SpeechSynthesisUtterance(text);
  _speechUtterance.lang = 'uk-UA';
  _speechUtterance.rate = 0.95;
  const voice = pickUkrainianVoice();
  if (voice) _speechUtterance.voice = voice;
  const label = btn?.querySelector('span');
  if (btn) btn.classList.add('speaking');
  if (label) label.textContent = 'Зупинити';
  _speechUtterance.onend = () => stopSpeaking();
  _speechUtterance.onerror = () => stopSpeaking();
  window.speechSynthesis.speak(_speechUtterance);
}
// Голоси у Chrome вантажаться асинхронно — прогріваємо список заздалегідь
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => pickUkrainianVoice();
}

// ── Вкладка «Спілкування» ──────────────────
// Текст можна або написати самостійно прямо тут, або підтягнути
// останній виправлений варіант з вкладки «Виправлення».
let _speakTextSynced = ''; // останнє значення, яке ми самі підставили з _lastFixedText

function renderSpeakTab() {
  const textEl = document.getElementById('speakText');
  if (!textEl) return;
  // Підставляємо свіжий виправлений текст лише якщо користувач
  // ще не написав у полі щось своє (поле порожнє або містить
  // те саме значення, яке ми підставили минулого разу).
  if (_lastFixedText && (textEl.value === '' || textEl.value === _speakTextSynced)) {
    textEl.value = _lastFixedText;
    _speakTextSynced = _lastFixedText;
  }
}

document.getElementById('speakGotoFixBtn')?.addEventListener('click', () => switchTab('tab-fix'));
document.getElementById('speakReadBtn')?.addEventListener('click', (e) => {
  const el = document.getElementById('speakText');
  const text = el?.value.trim() || '';
  if (!text) {
    // Порожнє поле — не мовчимо, а показуємо користувачу, що саме треба зробити
    el?.focus();
    el?.classList.add('speak-textarea--empty-flash');
    setTimeout(() => el?.classList.remove('speak-textarea--empty-flash'), 900);
    return;
  }
  speakText(text, e.currentTarget);
});

// ══════════════════════════════════════════════
// РОЗПІЗНАВАННЯ МОВИ СПІВРОЗМОВНИКА (Web Speech API, browser-native STT)
// Працює локально в браузері — нічого не надсилається на наш сервер чи в Gemini,
// поки людина сама не натисне «Виправити цей текст».
// ══════════════════════════════════════════════
const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
let _recognition = null;
let _listenShouldContinue = false;
let _finalTranscript = '';

function initSpeechRecognition() {
  const micBtn = document.getElementById('listenMicBtn');
  const unsupportedBox = document.getElementById('listenUnsupported');
  if (!SpeechRecognitionApi) {
    if (micBtn) micBtn.style.display = 'none';
    if (unsupportedBox) unsupportedBox.style.display = 'flex';
    return;
  }
  _recognition = new SpeechRecognitionApi();
  _recognition.lang = 'uk-UA';
  _recognition.continuous = true;
  _recognition.interimResults = true;

  _recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) _finalTranscript += chunk + ' ';
      else interim += chunk;
    }
    renderListenTranscript(interim);
  };

  _recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return; // не критично, продовжуємо/перезапустимо
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setListenStatus(false);
      _listenShouldContinue = false;
      document.getElementById('listenStatusText').textContent = 'Немає доступу до мікрофона';
      return;
    }
    // Мережеві та інші помилки — зупиняємось, щоб не зациклюватись
    _listenShouldContinue = false;
    setListenStatus(false);
  };

  _recognition.onend = () => {
    // Деякі браузери самі зупиняють сесію після паузи в мовленні —
    // перезапускаємо, поки людина явно не натиснула "стоп".
    if (_listenShouldContinue) {
      try { _recognition.start(); } catch(e) { /* вже запущено */ }
    } else {
      setListenStatus(false);
    }
  };
}

function setListenStatus(isListening) {
  const micBtn = document.getElementById('listenMicBtn');
  const dot = document.getElementById('listenStatusDot');
  const statusText = document.getElementById('listenStatusText');
  if (micBtn) micBtn.classList.toggle('listening', isListening);
  if (dot) dot.classList.toggle('live', isListening);
  if (statusText) statusText.textContent = isListening ? 'Слухаю…' : 'Не слухає';
}

function renderListenTranscript(interim) {
  const box = document.getElementById('listenTranscript');
  if (!box) return;
  const finalText = _finalTranscript.trim();
  if (!finalText && !interim) {
    box.innerHTML = '<span class="listen-placeholder" id="listenPlaceholder">Тут з\'явиться розпізнаний текст…</span>';
  } else {
    box.innerHTML = `${escHtml(finalText)}${interim ? ' <span class="interim">' + escHtml(interim) + '</span>' : ''}`;
  }
  box.scrollTop = box.scrollHeight;
  document.getElementById('listenActions').style.display = finalText ? 'flex' : 'none';
}

function startListening() {
  if (!_recognition) return;
  stopSpeaking(); // не озвучувати й слухати одночасно
  _listenShouldContinue = true;
  try { _recognition.start(); setListenStatus(true); }
  catch(e) { /* вже запущено — ігноруємо */ }
}

function stopListening() {
  if (!_recognition) return;
  _listenShouldContinue = false;
  try { _recognition.stop(); } catch(e) { /* не запущено */ }
  setListenStatus(false);
}

document.getElementById('listenMicBtn')?.addEventListener('click', () => {
  if (_listenShouldContinue) stopListening();
  else startListening();
});

document.getElementById('listenUseBtn')?.addEventListener('click', () => {
  const text = _finalTranscript.trim();
  if (!text) return;
  stopListening();
  textInput.value = text;
  textInput.dispatchEvent(new Event('input'));
  switchTab('tab-fix');
  textInput.focus();
});

document.getElementById('listenCopyBtn')?.addEventListener('click', (e) => {
  copyText(_finalTranscript.trim(), e.currentTarget);
});

document.getElementById('listenClearBtn')?.addEventListener('click', () => {
  _finalTranscript = '';
  renderListenTranscript('');
});

initSpeechRecognition();

document.getElementById('shareBtn').onclick = () => shareText(document.getElementById('result-text').textContent);

document.getElementById('copyBtn').onclick = () => copyText(document.getElementById('result-text').textContent, document.getElementById('copyBtn'));

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
      // Якщо totalCostUsd не збереглось — рахуємо з моделей (з урахуванням цін адміна)
      if (totalCostUsd === 0 && Object.keys(d.models || {}).length > 0) {
        const settingsForPrice = await getSettings();
        totalCostUsd = Object.entries(d.models || {}).reduce((sum, [m, c]) => {
          return sum + getModelPriceFromList(m, settingsForPrice.models) * c;
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
      document.getElementById('statBlocked').textContent = d.blockedCount || 0;
      document.getElementById('statLatency').textContent = (d.latencyCount > 0)
        ? Math.round(d.latencyTotalMs / d.latencyCount) + ' мс'
        : '—';

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
      document.getElementById('statBlocked').textContent = '0';
      document.getElementById('statLatency').textContent = '—';
    }
  } catch(e) {
    console.warn('Stats error:', e);
  }
});

// ══════════════════════════════════════════════
// ADMIN — СВІТЛА/ТЕМНА ТЕМА АДМІНКИ (косметика, лише для адміна)
// ══════════════════════════════════════════════
const THEME_KEY = 'ct_admin_theme';
function applyAdminTheme(theme) {
  document.body.classList.toggle('admin-light-theme', theme === 'light');
  const icon = document.getElementById('adminThemeIcon');
  if (icon) {
    icon.innerHTML = theme === 'light'
      ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
      : '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }
}
applyAdminTheme(localStorage.getItem(THEME_KEY) || 'dark');

document.getElementById('adminThemeBtn')?.addEventListener('click', () => {
  const next = document.body.classList.contains('admin-light-theme') ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
  applyAdminTheme(next);
});

// ══════════════════════════════════════════════
// ADMIN — ГАРЯЧІ КЛАВІШІ (лише коли відкрита адмінка)
// Ctrl/Cmd+S — зберегти API ключ · Ctrl/Cmd+L — вийти · Ctrl/Cmd+F — фокус пошуку в журналі
// ══════════════════════════════════════════════
document.addEventListener('keydown', (e) => {
  const adminScreen = document.getElementById('admin-screen');
  if (!adminScreen || adminScreen.style.display === 'none' || adminScreen.style.display === '') return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    document.getElementById('saveApiKeyBtn')?.click();
  } else if (e.key === 'l' || e.key === 'L') {
    e.preventDefault();
    document.getElementById('adminLogoutBtn')?.click();
  } else if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    document.getElementById('logSearchInput')?.focus();
  }
});

// START
// ══════════════════════════════════════════════
route();

