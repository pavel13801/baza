'use strict';
(function () {
  const VERSION = '1.1.3';
  const esc = MD.esc;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  // ───────────────────────────── Хранилище ─────────────────────────────
  // Настройки и мелочи — localStorage, база, страницы и очередь отправки — IndexedDB.

  const LS = {
    get(k, d) {
      try { const v = localStorage.getItem('baza:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) {
      try { localStorage.setItem('baza:' + k, JSON.stringify(v)); } catch (e) {}
    },
  };

  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('baza', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => res(req && req.result);
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error);
      });
    };
    return {
      get: k => run('readonly', s => s.get(k)).catch(() => undefined),
      set: (k, v) => run('readwrite', s => s.put(v, k)).catch(() => {}),
      clear: () => run('readwrite', s => s.clear()).catch(() => {}),
    };
  })();

  // ───────────────────────────── Состояние ─────────────────────────────

  const S = {
    settings: Object.assign({ url: '', token: '', demo: false, interval: 15, revise: false }, LS.get('settings', {})),
    tree: null,
    treeAt: 0,
    treeError: '',
    tab: LS.get('tab', 'capture'),
    stacks: { capture: [], base: [], videos: [], chat: [] },
    rootScroll: {},
    outbox: [],
    chat: LS.get('chat', []),
    chatPage: null,
    chatBusy: false,
    search: '',
    draft: LS.get('draft', ''),
  };
  if (!S.stacks[S.tab]) S.tab = 'capture';

  const configured = () => !!(S.settings.demo || (S.settings.url && S.settings.token));
  const saveSettings = () => LS.set('settings', S.settings);

  // ───────────────────────────── API ─────────────────────────────

  class ApiError extends Error {
    constructor(msg, opts) { super(msg); Object.assign(this, opts || {}); }
  }

  async function api(action, data, timeoutMs) {
    data = data || {};
    if (S.settings.demo) {
      const r = await window.demoApi(action, data);
      if (!r.ok) throw new ApiError(r.error);
      return r;
    }
    if (!S.settings.url || !S.settings.token) throw new ApiError('Приложение не подключено к базе — откройте Настройки', { setup: true });
    if (!navigator.onLine) throw new ApiError('Нет интернета', { network: true });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 90000);
    let res;
    try {
      res = await fetch(S.settings.url, {
        method: 'POST',
        // text/plain — «простой» запрос без preflight: Apps Script не умеет отвечать на OPTIONS
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({}, data, { action, token: S.settings.token })),
        signal: ctrl.signal,
        redirect: 'follow',
        credentials: 'omit',
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new ApiError('Сервер не ответил вовремя', { timeout: true });
      throw new ApiError('Нет связи с сервером — проверьте интернет и URL веб-приложения', { network: true });
    } finally {
      clearTimeout(timer);
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new ApiError('Сервер ответил не JSON (код ' + res.status + '). Проверьте, что веб-приложение развернуто с доступом «Все».');
    }
    if (!json.ok) throw new ApiError(json.error || 'Ошибка сервера', { auth: json.auth === false });
    return json;
  }

  // ───────────────────────────── Мелочи интерфейса ─────────────────────────────

  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2800);
  }

  function setSync(state, title) {
    const el = $('#sync');
    el.className = 'sync ' + (state || '');
    el.title = title || '';
    el.setAttribute('aria-label', title || 'Обновить из Google Диска');
  }

  const DTF_TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const DTF_DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
  const DTF_YEAR = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (days === 0) return 'сегодня, ' + DTF_TIME.format(d);
    if (days === 1) return 'вчера, ' + DTF_TIME.format(d);
    if (days < 7) return days + ' ' + plural(days, 'день', 'дня', 'дней') + ' назад';
    return (d.getFullYear() === now.getFullYear() ? DTF_DAY : DTF_YEAR).format(d).replace('.', '');
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  const mmss = sec => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');

  const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/;
  const ytId = url => ((String(url || '').match(YT_RE) || [])[1] || '');
  const thumb = id => 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg';
  const docUrl = id => 'https://docs.google.com/document/d/' + id + '/edit';

  const I = {
    chev: '<svg class="chev" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" fill="currentColor"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.55)"/><path d="M9.5 7.5v9l7.5-4.5z" fill="#fff"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  };

  const TOPIC_EMOJI = [
    [/инструмент|сервис|приложен/, '🛠️'], [/процесс|workflow|систем/, '🔁'], [/кейс|пример|проект/, '📦'],
    [/промпт|prompt/, '💬'], [/ошибк|анти/, '⚠️'], [/идея|мысл/, '💡'], [/деньг|монетиз|бизнес|финанс/, '💰'],
    [/здоров|спорт|трен/, '🏃'], [/учеб|курс|обуч/, '🎓'], [/книг|чтен/, '📚'], [/ии|ai|нейро|агент|llm/, '🤖'],
    [/маркет|продаж|реклам/, '📣'], [/дизайн/, '🎨'], [/код|разработ|программ/, '⌨️'],
  ];
  const topicEmoji = name => (TOPIC_EMOJI.find(([re]) => re.test(norm(name))) || [0, '📁'])[1];

  function row(o) {
    // o: { act, data: {k: v}, icon, title, sub, badge, hot, chev }
    const attrs = Object.entries(o.data || {}).map(([k, v]) => ' data-' + k + '="' + esc(v) + '"').join('');
    const tag = o.act ? 'button' : 'div';
    return '<li><' + tag + ' class="row' + (o.icon ? ' has-icon' : '') + '"' + (o.act ? ' data-act="' + o.act + '"' : '') + attrs + '>' +
      (o.icon ? '<span class="ico">' + o.icon + '</span>' : '') +
      '<span class="body"><span class="t">' + esc(o.title) + '</span>' + (o.sub ? '<span class="s">' + esc(o.sub) + '</span>' : '') + '</span>' +
      (o.badge != null ? '<span class="badge' + (o.hot ? ' hot' : '') + '">' + esc(o.badge) + '</span>' : '') +
      (o.right || '') +
      (o.chev !== false && o.act ? I.chev : '') +
      '</' + tag + '></li>';
  }
  const pageRow = (p, sub, icon) => row({ act: 'page', data: { id: p.id, title: p.title }, icon: icon || '📄', title: p.title, sub: sub != null ? sub : when(p.modified) });

  // ───────────────────────────── Навигация ─────────────────────────────

  const top = () => { const s = S.stacks[S.tab]; return s[s.length - 1] || null; };

  function push(view) {
    const cur = top();
    if (cur) cur.scroll = window.scrollY; else S.rootScroll[S.tab] = window.scrollY;
    S.stacks[S.tab].push(view);
    render();
    window.scrollTo(0, 0);
  }

  function back() {
    S.stacks[S.tab].pop();
    render();
    const cur = top();
    window.scrollTo(0, (cur ? cur.scroll : S.rootScroll[S.tab]) || 0);
  }

  function switchTab(tab) {
    if (tab === S.tab) {
      if (S.stacks[tab].length) { S.stacks[tab] = []; render(); }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const cur = top();
    if (cur) cur.scroll = window.scrollY; else S.rootScroll[S.tab] = window.scrollY;
    S.tab = tab;
    LS.set('tab', tab);
    render();
    const now = top();
    window.scrollTo(0, (now ? now.scroll : S.rootScroll[tab]) || 0);
  }

  function openPage(id, title, extra) {
    push(Object.assign({ type: 'page', id, title: title || '' }, extra || {}));
  }

  function render() {
    const v = top();
    $('#back').hidden = !v;
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === S.tab));
    const out = v ? VIEWS[v.type](v) : ROOTS[S.tab]();
    $('#title').textContent = out.title;
    document.title = out.title === 'База' ? 'База' : out.title + ' — База';
    $('#view').innerHTML = out.html;
    if (out.after) out.after();
  }

  // ───────────────────────────── Синхронизация с Google Диском ─────────────────────────────

  let treeLoading = null;
  function refreshTree(force) {
    if (!configured()) { setSync('', 'Не подключено'); return Promise.resolve(); }
    if (treeLoading) return treeLoading;
    if (!force && Date.now() - S.treeAt < 60000) return Promise.resolve();
    setSync('busy', 'Обновляю…');
    treeLoading = api('tree', {}, 120000).then(r => {
      S.tree = r.tree;
      S.treeAt = Date.now();
      S.treeError = '';
      idb.set('tree', { tree: r.tree, at: S.treeAt, demo: !!S.settings.demo });
      setSync('ok', 'Обновлено ' + DTF_TIME.format(new Date()));
      onTreeUpdated();
    }).catch(e => {
      S.treeError = e.message;
      setSync(e.network ? 'offline' : 'error', e.message);
      if (!S.tree) onTreeUpdated();
      if (e.auth) toast('Неверный ключ приложения — проверьте Настройки');
    }).finally(() => { treeLoading = null; });
    return treeLoading;
  }

  function onTreeUpdated() {
    const v = top();
    if (!v && S.tab === 'base') {
      if ($('#baseBody') && S.tree) $('#baseBody').innerHTML = baseBody();
      else render();
    } else if (!v && S.tab === 'videos') render();
    else if (!v && S.tab === 'chat' && !S.chat.length) render();
    else if (v && (v.type === 'topic' || v.type === 'list')) render();
    else if (v && v.type === 'video') {
      const c = findVideo(v.id);
      if (c && c.state !== v.lastState) render(); // карточка дозрела — показать конспект
    }
    watchProcessing();
  }

  // ───────────────────────────── Очередь отправки ─────────────────────────────
  // Всё, что записано, сначала ложится в очередь на телефоне и уходит на Диск, когда есть связь.

  async function loadOutbox() {
    S.outbox = (await idb.get('outbox')) || [];
    S.outbox.forEach(i => { if (i.status === 'sending') i.status = 'queued'; });
  }

  function saveOutbox() {
    const done = S.outbox.filter(i => i.status === 'done');
    if (done.length > 30) {
      const drop = new Set(done.slice(30).map(i => i.id));
      S.outbox = S.outbox.filter(i => !drop.has(i.id));
    }
    return idb.set('outbox', S.outbox);
  }

  function enqueue(item) {
    Object.assign(item, {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      created: Date.now(),
      status: 'queued',
    });
    S.outbox.unshift(item);
    saveOutbox();
    renderRecent();
    flushOutbox();
  }

  const bufToBase64 = (buf, type) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(new Blob([buf], { type }));
  });

  let flushing = false;
  async function flushOutbox() {
    if (flushing || !configured()) return;
    flushing = true;
    let sent = 0;
    try {
      for (const item of S.outbox.filter(i => i.status === 'queued')) {
        item.status = 'sending';
        item.error = '';
        renderRecent();
        try {
          let r;
          if (item.type === 'voice') {
            const audio = await bufToBase64(item.audio, item.mime);
            r = await api('voice', { audio, mime: item.mime, seconds: item.seconds, revise: item.revise }, 240000);
          } else {
            r = await api('add', { text: item.text, revise: item.revise }, 90000);
          }
          Object.assign(item, { status: 'done', result: r.item, warning: r.warning || '', sent: Date.now() });
          if (item.type === 'voice') delete item.audio; // аудио уже на Диске, место на телефоне не занимаем
          sent++;
          if (r.warning) toast(r.warning, 5000);
        } catch (e) {
          item.status = e.network || e.setup ? 'queued' : 'error';
          item.error = e.message;
          if (e.network || e.setup) break;
        }
        await saveOutbox();
        renderRecent();
      }
    } finally {
      flushing = false;
      saveOutbox();
      renderRecent();
    }
    if (sent) {
      const video = S.outbox.find(i => i.status === 'done' && i.sent > Date.now() - 60000 && i.result && i.result.cardId);
      if (video) toast('Видео сохранено — карточка с конспектом будет готова через 1–3 минуты', 4500);
      else toast(sent === 1 ? 'Сохранено во «Входящие»' : 'Сохранено во «Входящие»: ' + sent);
      setTimeout(() => refreshTree(true), 1200);
    }
  }

  function outboxItemHtml(i) {
    const res = i.result || {};
    const icon = i.type === 'voice' ? '🎙️' : /https?:\/\//.test(i.text || '') ? (ytId(i.text) ? '▶️' : '🔗') : '✏️';
    const title = res.title || (i.type === 'voice' ? 'Голосовая заметка, ' + mmss(i.seconds || 0) : String(i.text || '').slice(0, 90));
    const label = { queued: navigator.onLine && configured() ? 'в очереди' : 'ждёт сети', sending: 'отправляю…', done: 'во «Входящих»', error: 'ошибка' }[i.status];
    let sub = when(new Date(i.created).toISOString());
    if (i.status === 'error') sub = i.error;
    else if (i.warning) sub = i.warning;
    else if (res.text) sub = res.text;
    else if (i.status === 'queued' && !configured()) sub = 'Отправлю после подключения базы';
    const tools = i.status === 'error'
      ? '<span class="chips" style="margin-top:6px"><button class="chip" data-act="retry" data-id="' + i.id + '">Повторить</button><button class="chip" data-act="drop" data-id="' + i.id + '">Удалить</button></span>'
      : '';
    const openable = i.status === 'done' && res.id && res.kind !== 'audio';
    return '<li><' + (openable ? 'button data-act="page" data-id="' + esc(res.id) + '" data-title="' + esc(res.title || '') + '"' : 'div') + ' class="row has-icon">' +
      '<span class="ico">' + icon + '</span>' +
      '<span class="body"><span class="t">' + esc(title) + '</span><span class="s">' + esc(sub) + '</span>' + tools + '</span>' +
      '<span class="status ' + i.status + '">' + label + '</span>' +
      '</' + (openable ? 'button' : 'div') + '></li>';
  }

  function recentHtml() {
    if (!S.outbox.length) return '<div class="card empty">Здесь появится то, что вы записали. Всё уходит в папку «Входящие» на Google Диске, а ревизия Gemini раскладывает по темам.</div>';
    return '<ul class="list">' + S.outbox.slice(0, 20).map(outboxItemHtml).join('') + '</ul>';
  }

  function renderRecent() {
    const el = $('#recent');
    if (el) el.innerHTML = recentHtml();
  }

  // ───────────────────────────── Голосовые заметки ─────────────────────────────

  const MAX_REC_SEC = 15 * 60;
  const Rec = { rec: null, stream: null, chunks: [], started: 0, timer: 0, ctx: null, raf: 0, cancel: false };

  async function startRec() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('Запись звука не поддерживается в этом браузере');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      toast('Нет доступа к микрофону. Разрешите его в настройках Safari для этого сайта.', 4500);
      return;
    }
    const types = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mime = types.find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    } catch (e) {
      rec = new MediaRecorder(stream);
    }
    Object.assign(Rec, { rec, stream, chunks: [], started: Date.now(), cancel: false });
    rec.ondataavailable = e => { if (e.data && e.data.size) Rec.chunks.push(e.data); };
    rec.onstop = onRecStop;
    rec.start(1000);
    Rec.timer = setInterval(tickRec, 250);
    startMeter(stream);
    renderVoice();
  }

  function stopRec(cancel) {
    if (!Rec.rec) return;
    Rec.cancel = !!cancel;
    try { Rec.rec.stop(); } catch (e) { onRecStop(); }
    Rec.stream.getTracks().forEach(t => t.stop());
    clearInterval(Rec.timer);
    cancelAnimationFrame(Rec.raf);
    if (Rec.ctx) { Rec.ctx.close().catch(() => {}); Rec.ctx = null; }
  }

  async function onRecStop() {
    const rec = Rec.rec;
    if (!rec) return;
    Rec.rec = null;
    const seconds = (Date.now() - Rec.started) / 1000;
    const type = (rec.mimeType || (Rec.chunks[0] && Rec.chunks[0].type) || 'audio/mp4');
    const blob = new Blob(Rec.chunks, { type });
    Rec.chunks = [];
    renderVoice();
    if (Rec.cancel) return;
    if (seconds < 1.2 || blob.size < 1000) { toast('Слишком короткая запись'); return; }
    const audio = await blob.arrayBuffer();
    enqueue({ type: 'voice', audio, mime: type.split(';')[0], seconds, revise: S.settings.revise });
    toast(navigator.onLine ? 'Расшифровываю запись…' : 'Нет сети — отправлю запись, когда появится', 3500);
  }

  function tickRec() {
    const sec = (Date.now() - Rec.started) / 1000;
    const t = $('#recTimer');
    if (t) t.textContent = mmss(sec);
    if (sec >= MAX_REC_SEC) { stopRec(false); toast('Запись остановлена: максимум 15 минут'); }
  }

  function startMeter(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      Rec.ctx = new AC();
      const an = Rec.ctx.createAnalyser();
      an.fftSize = 512;
      Rec.ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d; }
        const btn = $('#mic');
        if (btn) btn.style.setProperty('--level', Math.min(1, Math.sqrt(sum / buf.length) * 5).toFixed(3));
        Rec.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {}
  }

  function voiceHtml() {
    if (Rec.rec) {
      return '<button id="mic" class="mic rec" data-act="mic" aria-label="Остановить и сохранить">' + I.stop + '</button>' +
        '<div class="timer" id="recTimer">' + mmss((Date.now() - Rec.started) / 1000) + '</div>' +
        '<div class="chips"><button class="chip" data-act="mic-cancel">Отменить</button></div>';
    }
    return '<button id="mic" class="mic" data-act="mic" aria-label="Начать запись">' + I.mic + '</button>' +
      '<div class="hint">Нажмите и говорите. Gemini расшифрует запись и положит текст во «Входящие».</div>';
  }

  function renderVoice() {
    const el = $('#voice');
    if (el) el.innerHTML = voiceHtml();
  }

  // ───────────────────────────── Экран «Записать» ─────────────────────────────

  function linkPreviewHtml(text) {
    const url = (String(text).match(/https?:\/\/[^\s<>"«»]+/) || [''])[0];
    if (!url) return '';
    const id = ytId(url);
    if (id) {
      return '<div class="link-card"><img src="' + thumb(id) + '" alt="" loading="lazy">' +
        '<div class="lt">Видео YouTube — сохраню с транскриптом, ваш текст пойдёт как комментарий</div></div>';
    }
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) {}
    return '<div class="link-card"><div class="lt">🔗 Ссылка: ' + esc(host) + ' — ваш текст пойдёт как комментарий</div></div>';
  }

  let draftTimer = 0;
  ROOTS_capture.after = () => {
    const ta = $('#note');
    ta.addEventListener('input', () => {
      S.draft = ta.value;
      $('#linkPreview').innerHTML = linkPreviewHtml(ta.value);
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => LS.set('draft', S.draft), 400);
    });
    $('#reviseNow').addEventListener('change', e => { S.settings.revise = e.target.checked; saveSettings(); });
  };
  function ROOTS_capture() {
    return {
      title: 'Записать',
      html:
        (configured() ? '' : '<div class="card pad stack" style="margin-bottom:14px"><div><b>База ещё не подключена.</b> Записывать уже можно — всё сохранится на телефоне и уйдёт на Диск после подключения.</div><button class="btn small" data-act="settings">Подключить</button></div>') +
        '<div class="card compose">' +
          '<textarea id="note" placeholder="Мысль, заметка или ссылка на видео…" enterkeyhint="enter">' + esc(S.draft) + '</textarea>' +
          '<div id="linkPreview">' + linkPreviewHtml(S.draft) + '</div>' +
          '<div class="actions">' +
            '<button class="chip" data-act="paste">Вставить</button>' +
            '<label class="toggle"><input type="checkbox" id="reviseNow"' + (S.settings.revise ? ' checked' : '') + '> Разобрать сразу</label>' +
            '<span class="grow"></span>' +
            '<button class="btn primary small" data-act="save">Сохранить</button>' +
          '</div>' +
        '</div>' +
        '<h2 class="section">Голосовая заметка</h2>' +
        '<div class="card voice" id="voice">' + voiceHtml() + '</div>' +
        '<h2 class="section">Недавнее</h2>' +
        '<div id="recent">' + recentHtml() + '</div>',
      after: ROOTS_capture.after,
    };
  }

  function saveNote() {
    const ta = $('#note');
    const text = ta.value.trim();
    if (!text) { toast('Сначала напишите что-нибудь'); ta.focus(); return; }
    enqueue({ type: 'text', text, revise: S.settings.revise });
    ta.value = '';
    S.draft = '';
    LS.set('draft', '');
    $('#linkPreview').innerHTML = '';
    ta.blur();
    if (!navigator.onLine) toast('Нет сети — отправлю, когда появится');
    else if (!configured()) toast('Сохранено на телефоне. Подключите базу в Настройках');
  }

  async function paste() {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { toast('Буфер обмена пуст'); return; }
      const ta = $('#note');
      ta.value = ta.value.trim() ? ta.value.replace(/\s*$/, '\n') + t : t;
      ta.dispatchEvent(new Event('input'));
      ta.focus();
    } catch (e) {
      toast('Не удалось прочитать буфер — вставьте долгим нажатием на поле');
    }
  }

  // ───────────────────────────── Экран «База» ─────────────────────────────

  function onboardingHtml() {
    return '<div class="card pad stack">' +
      '<div style="font-size:40px">📚</div>' +
      '<div><b>Подключите свою базу знаний</b></div>' +
      '<div class="muted">Приложение работает с папкой «База знаний» на Google Диске через ваш скрипт Apps Script. Нужны URL веб-приложения и ключ — они появятся после установки (инструкция в README).</div>' +
      '<div class="chips"><button class="btn primary small" data-act="settings">Подключить</button><button class="btn small" data-act="demo-on">Посмотреть демо</button></div>' +
      '</div>';
  }

  function loadingHtml() {
    if (S.treeError) {
      return '<div class="card pad stack"><div><b>Не удалось загрузить базу</b></div><div class="muted">' + esc(S.treeError) + '</div>' +
        '<div class="chips"><button class="btn small" data-act="refresh">Повторить</button><button class="btn small" data-act="settings">Настройки</button></div></div>';
    }
    return '<div class="card pad"><div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>';
  }

  function allItems() {
    const t = S.tree;
    const items = [];
    t.topics.forEach(tp => {
      items.push({ kind: 'topic', title: tp.name, topic: tp });
      tp.pages.forEach(p => items.push({ kind: 'page', title: p.title, p, sub: tp.name + (p.path ? ' / ' + p.path : '') }));
    });
    t.general.forEach(p => items.push({ kind: 'page', title: p.title, p, sub: 'Знания' }));
    t.thoughts.forEach(p => items.push({ kind: 'page', title: p.title, p, sub: 'Мысли и идеи', icon: '💡' }));
    videos().forEach(v => items.push({ kind: 'video', title: v.title + ' ' + (v.channel || ''), v }));
    (t.clips || []).forEach(p => items.push({ kind: 'page', title: p.title, p, sub: 'Клиппинг', icon: '📰' }));
    t.notes.forEach(p => items.push({ kind: 'page', title: p.title, p, sub: 'Мои заметки', icon: '✏️' }));
    t.inbox.forEach(p => items.push({ kind: 'inbox', title: p.title, p, sub: 'Входящие — ждёт разбора', icon: '📥' }));
    return items;
  }

  function searchHtml(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    const hits = allItems().filter(x => { const t = norm(x.title + ' ' + (x.sub || '')); return words.every(w => t.includes(w)); }).slice(0, 80);
    if (!hits.length) {
      return '<div class="card empty">Ничего не нашлось в названиях.<br><br><button class="btn small" data-act="ask" data-q="' + esc(q) + '">Спросить AI по базе</button></div>';
    }
    return '<ul class="list">' + hits.map(x => {
      if (x.kind === 'topic') return row({ act: 'topic', data: { name: x.title }, icon: topicEmoji(x.title), title: x.title, sub: 'Тема · ' + x.topic.pages.length + ' стр.' });
      if (x.kind === 'video') return videoRow(x.v);
      if (x.kind === 'inbox') return x.p.mime === 'application/vnd.google-apps.document' ? pageRow(x.p, x.sub, x.icon) : row({ icon: x.icon, title: x.title, sub: x.sub });
      return pageRow(x.p, x.sub + ' · ' + when(x.p.modified), x.icon);
    }).join('') + '</ul>' +
      '<div class="center" style="margin-top:14px"><button class="btn small" data-act="ask" data-q="' + esc(q) + '">Спросить AI: «' + esc(q.slice(0, 40)) + '»</button></div>';
  }

  function baseBody() {
    const t = S.tree;
    if (S.search.trim()) return searchHtml(S.search.trim());
    let h = '';
    if (t.inbox.length) {
      h += '<div class="card banner"><span class="ico">📥</span><div class="body"><div><b>Во «Входящих»: ' + t.inbox.length + '</b></div>' +
        '<div class="small muted">Ревизия разберёт их в 9:00</div></div>' +
        '<button class="btn small" data-act="revise">Разобрать</button></div>' +
        '<div style="margin-top:6px"></div><ul class="list">' + row({ act: 'list', data: { kind: 'inbox' }, title: 'Посмотреть, что ждёт разбора', chev: true }) + '</ul>';
    }
    h += '<h2 class="section">Мои мысли</h2><ul class="list">' +
      row({ act: 'list', data: { kind: 'thoughts' }, icon: '💡', title: 'Мысли и идеи', sub: t.thoughts[0] ? 'последняя: ' + t.thoughts[0].title : 'пока пусто', badge: t.thoughts.length }) +
      row({ act: 'list', data: { kind: 'notes' }, icon: '✏️', title: 'Мои заметки (оригиналы)', sub: 'надиктованное и написанное, как есть', badge: t.notesTotal || t.notes.length }) +
      '</ul>';
    h += '<h2 class="section">Знания по темам</h2>';
    h += t.topics.length
      ? '<div class="topics">' + t.topics.map(tp =>
        '<button class="topic" data-act="topic" data-name="' + esc(tp.name) + '"><span class="ico">' + topicEmoji(tp.name) + '</span>' +
        '<span class="n">' + esc(tp.name) + '</span><span class="c">' + tp.pages.length + ' ' + plural(tp.pages.length, 'страница', 'страницы', 'страниц') +
        (tp.pages[0] ? ' · ' + when(tp.pages[0].modified) : '') + '</span></button>').join('') + '</div>'
      : '<div class="card empty">Тем пока нет — они появятся после первой ревизии.</div>';
    if (t.general.length) h += '<div style="margin-top:10px"></div><ul class="list">' + t.general.map(p => pageRow(p, 'Знания · ' + when(p.modified), '📖')).join('') + '</ul>';
    h += '<h2 class="section">Источники</h2><ul class="list">' +
      row({ act: 'tab', data: { tab: 'videos' }, icon: '▶️', title: 'Видео и статьи', sub: 'конспекты с таймкодами, что применить', badge: videos().length + (t.clips || []).length }) + '</ul>';
    h += '<h2 class="section">Служебное</h2><ul class="list">' +
      (t.mainId ? pageRow({ id: t.mainId, title: 'Главная' }, 'оглавление базы', '🏠') : '') +
      (t.rulesId ? pageRow({ id: t.rulesId, title: 'Правила базы' }, 'по ним Gemini разбирает «Входящие»', '📐') : '') +
      (t.lastReport ? pageRow(t.lastReport, 'последняя ревизия · ' + when(t.lastReport.created), '🧾') : '') +
      '</ul>';
    h += '<p class="small muted center" style="margin-top:18px">Обновлено ' + (S.treeAt ? when(new Date(S.treeAt).toISOString()) : '—') + (S.settings.demo ? ' · демо-режим' : '') + '</p>';
    return h;
  }

  function ROOTS_base() {
    if (!configured()) return { title: 'База', html: onboardingHtml() };
    if (!S.tree) return { title: 'База', html: loadingHtml() };
    return {
      title: 'База',
      html: '<label class="search">' + I.search + '<input id="search" type="search" placeholder="Поиск по базе" autocomplete="off" value="' + esc(S.search) + '"></label>' +
        '<div id="baseBody">' + baseBody() + '</div>',
      after() {
        $('#search').addEventListener('input', e => { S.search = e.target.value; $('#baseBody').innerHTML = baseBody(); });
      },
    };
  }

  // ───────────────────────────── Экран «Видео» ─────────────────────────────

  // У каждого видео — карточка в разделе «Видео» на Диске: конспект с таймкодами, что применить, вопросы.
  // Статус, тип, темы и канал приходят из свойств файла, поэтому фильтры работают без открытия документов.

  const V_STATUS = { new: 'Не смотрел', watched: 'Посмотрел', applied: 'Применил' };
  const V_TYPE = { learn: ['📚', 'Обучение'], inspire: ['✨', 'Вдохновение'], fun: ['🎬', 'Развлечение'] };
  S.vf = Object.assign({ status: 'all', type: 'all', topic: '', channel: '' }, LS.get('vf', {}), { q: '' });
  const saveVf = () => LS.set('vf', { status: S.vf.status, type: S.vf.type, topic: S.vf.topic, channel: S.vf.channel });

  const videos = () => ((S.tree && S.tree.videos) || []).filter(v => v.videoId);
  const findVideo = id => videos().find(v => v.id === id) || null;
  const ready = v => !v.state || v.state === 'done';
  const persistTree = () => idb.set('tree', { tree: S.tree, at: S.treeAt, demo: !!S.settings.demo });
  function fmtDur(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  const tsToSec = t => String(t).split(':').reduce((a, x) => a * 60 + +x, 0);

  function clipRow(c) {
    return row({ act: 'page', data: { id: c.id, title: c.title }, icon: '📰', title: c.title, sub: 'Клиппинг · ' + when(c.created) });
  }

  function videoRow(v) {
    return row({ act: 'video', data: { id: v.id }, icon: '▶️', title: v.title, sub: [v.channel, V_STATUS[v.status] || ''].filter(Boolean).join(' · ') });
  }

  function videoTile(v) {
    const badge = !ready(v)
      ? '<span class="tag">' + (v.state === 'error' ? '⚠️ ошибка' : '⏳ готовится') + '</span>'
      : v.status === 'applied' ? '<span class="tag ok">★ применил</span>'
        : v.status === 'watched' ? '<span class="tag ok">✓ посмотрел</span>' : '';
    const sub = [v.type && V_TYPE[v.type] ? V_TYPE[v.type][0] : '', v.channel, when(v.created)].filter(Boolean).join(' · ');
    return '<button class="video" data-act="video" data-id="' + esc(v.id) + '">' +
      '<span class="thumb">' + I.video + '<img src="' + thumb(v.videoId) + '" alt="" loading="lazy" onerror="this.remove()">' + badge +
      (v.seconds ? '<span class="dur">' + fmtDur(v.seconds) + '</span>' : '') + '</span>' +
      '<span class="vb"><span class="vt">' + esc(v.title) + '</span><span class="vs">' + esc(sub) + '</span></span></button>';
  }

  function pendingTile(i) {
    return '<button class="video" data-act="page" data-id="' + esc(i.id) + '" data-title="' + esc(i.title) + '">' +
      '<span class="thumb">' + I.video + '<img src="' + thumb(ytId(i.url)) + '" alt="" loading="lazy" onerror="this.remove()">' +
      '<span class="tag">ждёт разбора</span></span>' +
      '<span class="vb"><span class="vt">' + esc(i.title.replace(/^Видео\s+—\s+/, '')) + '</span><span class="vs">' + esc(when(i.created)) + '</span></span></button>';
  }

  function filterVideos() {
    const f = S.vf;
    const words = norm(f.q).split(/\s+/).filter(Boolean);
    return videos().filter(v =>
      (f.status === 'all' || v.status === f.status) &&
      (f.type === 'all' || v.type === f.type) &&
      (!f.topic || (v.topics || []).indexOf(f.topic) >= 0) &&
      (!f.channel || v.channel === f.channel) &&
      words.every(w => norm(v.title + ' ' + (v.channel || '') + ' ' + (v.topics || []).join(' ')).includes(w)));
  }

  function videosBody() {
    if (!videos().length) {
      return '<div class="card empty">Пока нет видео. Вставьте ссылку на YouTube на экране «Записать» — через пару минут здесь появится карточка: конспект с таймкодами, что применить и вопросы для самопроверки.</div>';
    }
    const list = filterVideos();
    if (!list.length) return '<div class="card empty">Под фильтр ничего не подходит.<br><br><button class="btn small" data-act="vf-reset">Сбросить фильтры</button></div>';
    return '<div class="videos">' + list.map(videoTile).join('') + '</div>';
  }

  function ROOTS_videos() {
    if (!configured()) return { title: 'Видео', html: onboardingHtml() };
    if (!S.tree) return { title: 'Видео', html: loadingHtml() };
    const t = S.tree;
    const all = videos();
    const f = S.vf;
    const have = new Set(all.map(v => v.videoId));
    const pending = t.inbox.filter(i => ytId(i.url) && !have.has(ytId(i.url)) && i.mime === 'application/vnd.google-apps.document');
    const clips = t.clips || [];
    const uniq = arr => Array.from(new Set(arr)).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
    const topics = uniq([].concat(...all.map(v => v.topics || [])));
    const channels = uniq(all.map(v => v.channel));
    const count = s => all.filter(v => s === 'all' || v.status === s).length;

    let h = '';
    if (all.length) {
      h += '<label class="search">' + I.search + '<input id="vq" type="search" placeholder="Поиск по видео, каналам, темам" autocomplete="off" value="' + esc(f.q) + '"></label>';
      h += '<div class="seg">' + ['all', 'new', 'watched', 'applied'].map(s =>
        '<button data-act="vf" data-k="status" data-v="' + s + '"' + (f.status === s ? ' class="on"' : '') + '>' +
        (s === 'all' ? 'Все' : V_STATUS[s]) + ' <span>' + count(s) + '</span></button>').join('') + '</div>';
      h += '<div class="chips filters">' + ['all', 'learn', 'inspire', 'fun'].map(k =>
        '<button class="chip' + (f.type === k ? ' on' : '') + '" data-act="vf" data-k="type" data-v="' + k + '">' +
        (k === 'all' ? 'Любой тип' : V_TYPE[k].join(' ')) + '</button>').join('') +
        (topics.length ? '<select class="chip' + (f.topic ? ' on' : '') + '" id="vTopic" aria-label="Тема"><option value="">Все темы</option>' +
          topics.map(x => '<option value="' + esc(x) + '"' + (f.topic === x ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>' : '') +
        (channels.length > 1 ? '<select class="chip' + (f.channel ? ' on' : '') + '" id="vChannel" aria-label="Канал"><option value="">Все каналы</option>' +
          channels.map(x => '<option value="' + esc(x) + '"' + (f.channel === x ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select>' : '') +
        '</div>';
    }
    if (pending.length) h += '<h2 class="section">Ждут карточки</h2><div class="videos">' + pending.map(pendingTile).join('') + '</div><div style="height:14px"></div>';
    h += '<div id="vBody">' + videosBody() + '</div>';
    if (clips.length) h += '<h2 class="section">Статьи и другое</h2><ul class="list">' + clips.map(clipRow).join('') + '</ul>';
    return {
      title: 'Видео',
      html: h,
      after() {
        const q = $('#vq');
        if (q) q.addEventListener('input', e => { S.vf.q = e.target.value; $('#vBody').innerHTML = videosBody(); });
        const sel = (id, key) => { const el = $(id); if (el) el.addEventListener('change', e => { S.vf[key] = e.target.value; saveVf(); rerenderKeepScroll(); }); };
        sel('#vTopic', 'topic');
        sel('#vChannel', 'channel');
      },
    };
  }

  function rerenderKeepScroll() {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  function openVideo(id) {
    const v = findVideo(id);
    push({ type: 'video', id, title: v ? v.title : '' });
  }

  function playerHtml(vid) {
    if (!vid) return '';
    return '<div class="player" id="player"><img src="https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg" alt="">' +
      '<button class="play" data-act="yt-play" data-vid="' + vid + '" aria-label="Смотреть">' + I.play + '</button></div>';
  }

  /** Плеер внутри приложения; sec — перейти к моменту (таймкоды в конспекте и транскрипте). */
  function playAt(vid, sec) {
    const p = $('#player');
    if (!p) return;
    p.innerHTML = '<iframe src="https://www.youtube-nocookie.com/embed/' + encodeURIComponent(vid) +
      '?autoplay=1&playsinline=1&rel=0' + (sec ? '&start=' + Math.floor(sec) : '') +
      '" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Видео"></iframe>';
    if (sec != null) {
      const y = p.getBoundingClientRect().top + window.scrollY - $('.top').offsetHeight - 8;
      if (y < window.scrollY) window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }

  /**
   * Пункты раздела превращаются в чек-лист. Google Документ при экспорте в Markdown теряет «[ ]»,
   * поэтому список «Что применить» приходит обычным — здесь ему возвращаются галочки.
   */
  function checklistSection(md, heading) {
    let inside = false;
    return String(md).split('\n').map(line => {
      const h = line.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (h) { inside = h[2].replace(/[\\*_]/g, '').trim() === heading; return line; }
      if (inside && !/^\s*([-*+]|\d+[.)])\s+\\?\[[ xX]\\?\]/.test(line)) return line.replace(/^(\s*)(?:[-*+]|\d+[.)])\s+/, '$1- [ ] ');
      return line;
    }).join('\n');
  }

  /** «[12:34]» и «**0:02**» в тексте → ссылки на нужный момент видео. */
  function linkTimestamps(md, vid) {
    const link = t => '[' + t + '](https://www.youtube.com/watch?v=' + vid + '&t=' + tsToSec(t) + 's)';
    return String(md)
      .replace(/\\?\[(\d{1,2}:\d{2}(?::\d{2})?)\\?\](?!\()/g, (m, t) => link(t))
      .replace(/\*\*(\d{1,2}:\d{2}(?::\d{2})?)\*\*/g, (m, t) => link(t));
  }

  function VIEWS_video(v) {
    const c = findVideo(v.id) || { id: v.id, title: v.title || 'Видео', videoId: v.videoId || '', status: 'new', state: 'done', done: [] };
    Object.assign(v, { videoId: c.videoId, url: c.url || (c.videoId ? 'https://www.youtube.com/watch?v=' + c.videoId : ''), lastState: c.state, title: c.title });
    let h = playerHtml(c.videoId);
    const meta = [c.channel, c.seconds ? fmtDur(c.seconds) : '', c.type && V_TYPE[c.type] ? V_TYPE[c.type].join(' ') : '', (c.topics || []).join(', ')].filter(Boolean);
    if (meta.length) h += '<p class="small muted vmeta">' + esc(meta.join(' · ')) + '</p>';
    h += '<div class="seg" id="vStatus">' + Object.keys(V_STATUS).map(s =>
      '<button data-act="vstatus" data-v="' + s + '"' + (c.status === s ? ' class="on"' : '') + '>' + V_STATUS[s] + '</button>').join('') + '</div>';
    if (!ready(c)) {
      h += '<div class="card pad notice">' + (c.state === 'error'
        ? '<b>⚠️ Карточку сделать не удалось</b><div class="small muted">' + esc(c.error || '') + '</div><div style="margin-top:8px"><button class="btn small" data-act="vretry">Попробовать ещё раз</button></div>'
        : '<b>⏳ Карточка готовится</b><div class="small muted">Сейчас: ' + esc(c.stage || 'в очереди') + '. Обычно 1–3 минуты, длинные видео — дольше. Обновится само.</div>') + '</div>';
    }
    h += '<div class="page-meta">' +
      (c.transcriptId ? '<button class="chip" data-act="page" data-id="' + esc(c.transcriptId) + '" data-title="Транскрипт" data-video="' + esc(c.videoId) + '">Транскрипт</button>' : '') +
      '<button class="chip" data-act="ask-page" data-id="' + esc(c.id) + '">Спросить AI</button>' +
      (v.url ? '<a class="chip" href="' + esc(v.url) + '" target="_blank" rel="noopener">YouTube</a>' : '') +
      (String(c.id).startsWith('demo') ? '' : '<a class="chip" href="' + docUrl(c.id) + '" target="_blank" rel="noopener">Google Docs</a>') +
      (ready(c) ? '<button class="chip" data-act="vretry">Пересобрать</button>' : '') +
      '</div>' +
      '<article class="card doc" id="doc"><div class="skeleton" style="width:70%"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="width:50%"></div></article>' +
      '<p class="small muted center" id="docMeta"></p>';
    return { title: c.title, html: h, after: () => loadPage(v) };
  }

  function applyChecks(v) {
    const c = findVideo(v.id);
    const done = new Set((c && c.done) || []);
    $$('#doc [data-check]').forEach(el => setCheck(el, done.has(+el.dataset.check)));
  }

  function setCheck(el, on) {
    el.textContent = on ? '☑' : '☐';
    el.classList.add('tap');
    el.setAttribute('role', 'checkbox');
    el.setAttribute('aria-checked', String(on));
    const li = el.closest('li');
    if (li) li.classList.toggle('done', on);
  }

  async function toggleCheck(el) {
    const v = top();
    const c = v && findVideo(v.id);
    if (!c) return;
    const i = +el.dataset.check;
    const set = new Set(c.done || []);
    if (set.has(i)) set.delete(i); else set.add(i);
    c.done = Array.from(set).sort((a, b) => a - b);
    setCheck(el, set.has(i));
    const total = $$('#doc [data-check]').length;
    const allDone = total && set.size === total && c.status !== 'applied';
    try {
      const r = await api('videoSet', Object.assign({ id: c.id, done: c.done.join(',') }, allDone ? { status: 'applied' } : {}));
      Object.assign(c, r.video);
      persistTree();
      if (allDone) {
        $$('#vStatus button').forEach(b => b.classList.toggle('on', b.dataset.v === 'applied'));
        toast('Все пункты сделаны — отметил видео как «Применил»');
      }
    } catch (e) {
      toast(e.message);
    }
  }

  async function setVideoStatus(s) {
    const v = top();
    const c = v && findVideo(v.id);
    if (!c || c.status === s) return;
    const prev = c.status;
    const mark = x => $$('#vStatus button').forEach(b => b.classList.toggle('on', b.dataset.v === x));
    c.status = s;
    mark(s);
    try {
      const r = await api('videoSet', { id: c.id, status: s });
      Object.assign(c, r.video);
      persistTree();
      toast('Отмечено: ' + V_STATUS[s]);
    } catch (e) {
      c.status = prev;
      mark(prev);
      toast(e.message);
    }
  }

  async function retryVideo() {
    const v = top();
    const c = v && findVideo(v.id);
    if (!c) return;
    if (ready(c) && !confirm('Пересобрать карточку заново? Gemini ещё раз сделает конспект, отметки «Что применить» сбросятся.')) return;
    try {
      const r = await api('videoRetry', { id: c.id });
      Object.assign(c, r.video);
      persistTree();
      render();
      watchProcessing();
      toast('Карточка пересобирается — обычно 1–3 минуты');
    } catch (e) {
      toast(e.message);
    }
  }

  // Пока какие-то карточки готовятся, база обновляется каждые 40 секунд
  let procTimer = 0;
  function watchProcessing() {
    clearTimeout(procTimer);
    if (!videos().some(v => !ready(v) && v.state !== 'error')) return;
    procTimer = setTimeout(() => {
      if (document.visibilityState === 'visible') refreshTree(true);
      else watchProcessing();
    }, 40000);
  }

  async function migrateVideos() {
    toast('Собираю карточки для старых видео…', 5000);
    try {
      const r = await api('migrateVideos', {}, 300000);
      const made = (r.log || []).filter(x => /^Карточка:/.test(x)).length;
      toast(made ? 'Заведено карточек: ' + made + '. Конспекты появятся в течение нескольких минут.' : 'Новых видео для карточек не нашлось', 5000);
      refreshTree(true);
    } catch (e) {
      toast(e.message, 5000);
    }
  }

  // ───────────────────────────── Страница ─────────────────────────────

  function findKnown(id) {
    if (!S.tree) return null;
    const t = S.tree;
    const pools = [].concat(...t.topics.map(x => x.pages), t.general, t.thoughts, t.notes, t.inbox, t.videos, t.clips || [], t.lastReport ? [t.lastReport] : []);
    return pools.find(p => p.id === id) || null;
  }

  VIEWS_page.after = v => loadPage(v);
  function VIEWS_page(v) {
    const vid = v.videoId || ytId(v.url);
    let h = '';
    if (vid) { v.videoId = vid; h += playerHtml(vid); }
    h += '<div class="page-meta">' +
      (v.url ? '<a class="chip" href="' + esc(v.url) + '" target="_blank" rel="noopener">' + (vid ? 'Открыть в YouTube' : 'Источник') + '</a>' : '') +
      (v.noteId && v.noteId !== v.id ? '<button class="chip" data-act="page" data-id="' + esc(v.noteId) + '" data-title="Мой комментарий">Мой комментарий</button>' : '') +
      '<button class="chip" data-act="ask-page" data-id="' + esc(v.id) + '">Спросить AI</button>' +
      (String(v.id).startsWith('demo') ? '' : '<a class="chip" href="' + docUrl(v.id) + '" target="_blank" rel="noopener">Google Docs</a>') +
      '</div>' +
      '<article class="card doc" id="doc"><div class="skeleton" style="width:70%"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton" style="width:50%"></div></article>' +
      '<p class="small muted center" id="docMeta"></p>';
    return { title: v.title || 'Страница', html: h, after: () => VIEWS_page.after(v) };
  }

  async function loadPage(v) {
    const key = 'page:' + v.id;
    const cached = await idb.get(key);
    if (cached) showPage(v, cached, true);
    try {
      const r = await api('page', { id: v.id }, 60000);
      const p = Object.assign(r.page, { at: Date.now() });
      idb.set(key, p);
      if (!cached || cached.markdown !== p.markdown || cached.title !== p.title) showPage(v, p, false);
      else showMeta(v, p, false);
    } catch (e) {
      if (top() !== v) return;
      if (!cached) $('#doc').innerHTML = '<p><b>Не удалось открыть страницу.</b></p><p class="muted">' + esc(e.message) + '</p>';
      else showMeta(v, cached, true);
    }
  }

  function showPage(v, p, fromCache) {
    if (top() !== v) return;
    if (!v.title && p.title) { v.title = p.title; $('#title').textContent = p.title; }
    if (!v.url && p.url && p.url !== '-' && /^https?:/.test(p.url)) { v.url = p.url; if (ytId(p.url) && !v.videoId) { v.videoId = ytId(p.url); render(); return; } }
    let md = MD.stripTitle(p.markdown, p.title);
    // канал, длительность, тип и темы карточки уже показаны над плеером — в тексте их не дублируем
    if (v.type === 'video' && /^#{1,3}\s/m.test(md)) md = md.replace(/^[\s\S]*?(?=^#{1,3}\s)/m, '');
    if (v.type === 'video') md = checklistSection(md, 'Что применить');
    if (v.videoId) md = linkTimestamps(md, v.videoId);
    $('#doc').innerHTML = MD.render(md) || '<p class="muted">Пустая страница</p>';
    if (v.type === 'video') applyChecks(v);
    showMeta(v, p, fromCache);
  }

  function showMeta(v, p, fromCache) {
    const el = $('#docMeta');
    if (el && top() === v) el.textContent = 'Изменено ' + when(p.modified) + (fromCache && !navigator.onLine ? ' · сохранённая копия' : '');
  }

  // ───────────────────────────── Темы и списки ─────────────────────────────

  function VIEWS_topic(v) {
    const tp = S.tree && S.tree.topics.find(x => x.name === v.name);
    if (!tp) return { title: v.name, html: '<div class="card empty">Тема не найдена — возможно, её переименовали.</div>' };
    let h = '';
    if (tp.indexId) h += '<ul class="list">' + pageRow({ id: tp.indexId, title: tp.name }, 'оглавление темы', '🗂️') + '</ul><div style="margin-top:10px"></div>';
    h += tp.pages.length
      ? '<ul class="list">' + tp.pages.map(p => pageRow(p, (p.path ? p.path + ' · ' : '') + when(p.modified))).join('') + '</ul>'
      : '<div class="card empty">В теме пока нет страниц.</div>';
    h += '<div class="center" style="margin-top:16px"><button class="btn small" data-act="ask" data-q="Сделай краткую выжимку по теме «' + esc(tp.name) + '»: главное и что применить.">Выжимка по теме от AI</button></div>';
    return { title: tp.name, html: h };
  }

  function VIEWS_list(v) {
    const t = S.tree;
    if (!t) return { title: '', html: loadingHtml() };
    if (v.kind === 'thoughts') {
      return {
        title: 'Мысли и идеи',
        html: (t.thoughtsIndex ? '<ul class="list">' + pageRow({ id: t.thoughtsIndex, title: 'Мысли и идеи' }, 'оглавление', '🗂️') + '</ul><div style="margin-top:10px"></div>' : '') +
          (t.thoughts.length ? '<ul class="list">' + t.thoughts.map(p => pageRow(p, null, '💡')).join('') + '</ul>' : '<div class="card empty">Пока пусто.</div>'),
      };
    }
    if (v.kind === 'notes') {
      return {
        title: 'Мои заметки',
        html: (t.notes.length ? '<ul class="list">' + t.notes.map(p => pageRow(p, null, '✏️')).join('') + '</ul>' : '<div class="card empty">Пока пусто.</div>') +
          (t.notesTotal > t.notes.length ? '<p class="small muted center">Показаны последние ' + t.notes.length + ' из ' + t.notesTotal + '</p>' : ''),
      };
    }
    return {
      title: 'Входящие',
      html: '<p class="small muted" style="margin:0 4px 10px">Это ещё не разобрано. Ревизия Gemini разложит всё по темам в 9:00 или по кнопке «Разобрать».</p>' +
        (t.inbox.length ? '<ul class="list">' + t.inbox.map(p => p.mime === 'application/vnd.google-apps.document'
          ? pageRow(p, when(p.created), ytId(p.url) ? '▶️' : p.url ? '🔗' : '📥')
          : row({ icon: /audio/.test(p.mime) ? '🎙️' : '📎', title: p.title, sub: when(p.created) })).join('') + '</ul>' : '<div class="card empty">Всё разобрано 🎉</div>') +
        (t.inbox.length ? '<div class="center" style="margin-top:16px"><button class="btn primary small" data-act="revise">Разобрать сейчас</button></div>' : ''),
    };
  }

  async function revise() {
    try {
      const r = await api('revise');
      toast('Ревизия запустится в течение минуты' + (r.inbox ? ' — во «Входящих» ' + r.inbox : '') + '. Обновлю базу через пару минут.', 4500);
      setTimeout(() => refreshTree(true), 150000);
    } catch (e) {
      toast(e.message, 4000);
    }
  }

  // ───────────────────────────── AI-чат ─────────────────────────────

  function saveChat() { LS.set('chat', S.chat.slice(-40)); }

  function chatSuggestions() {
    const tp = S.tree && S.tree.topics.length ? S.tree.topics[0].name : null;
    const list = [
      'Что нового появилось в базе за последнюю неделю?',
      'Какие идеи я записывал в последнее время?',
      tp ? 'Сделай выжимку по теме «' + tp + '»' : 'Какие темы есть в моей базе?',
      'Что из базы мне стоит применить в первую очередь?',
    ];
    return '<div class="card pad stack"><div style="font-size:34px">✨</div><div><b>AI-ассистент по вашей базе</b></div>' +
      '<div class="muted small">Работает на Gemini через ваш ключ в Apps Script. Ищет нужные страницы в базе и отвечает по ним.</div></div>' +
      '<div class="chips" style="margin-top:12px">' + list.map(q => '<button class="chip" data-act="ask" data-q="' + esc(q) + '">' + esc(q) + '</button>').join('') + '</div>';
  }

  function chatHtml() {
    if (!S.chat.length && !S.chatBusy) return chatSuggestions();
    return S.chat.map((m, i) => {
      if (m.role === 'user') return '<div class="msg user">' + esc(m.text) + '</div>';
      if (m.role === 'error') return '<div class="msg error">⚠️ ' + esc(m.text) + ' <button class="chip" data-act="chat-retry">Повторить</button></div>';
      return '<div class="msg model"><div class="doc">' + MD.render(m.text) + '</div>' +
        (m.sources && m.sources.length ? '<div class="src">' + m.sources.map(s => '<button class="chip" data-act="page" data-id="' + esc(s.id) + '" data-title="' + esc(s.title) + '">' + esc(s.title) + '</button>').join('') + '</div>' : '') +
        '<div class="tools"><button class="chip" data-act="chat-save" data-i="' + i + '">В базу</button><button class="chip" data-act="chat-copy" data-i="' + i + '">Копировать</button></div></div>';
    }).join('') + (S.chatBusy ? '<div class="typing" aria-label="Думаю"><i></i><i></i><i></i></div>' : '');
  }

  function renderChat(scroll) {
    const el = $('#chat');
    if (!el) return;
    el.innerHTML = chatHtml();
    const clr = $('#chatClear');
    if (clr) clr.hidden = !S.chat.length;
    const comp = $('.composer');
    if (comp) el.style.paddingBottom = (comp.offsetHeight + 16) + 'px';
    if (scroll !== false) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  }

  function ROOTS_chat() {
    return {
      title: 'AI-ассистент',
      html: '<div class="chat" id="chat">' + chatHtml() + '</div>' +
        '<div class="composer">' +
          (S.chatPage ? '<div class="ctx chips"><button class="chip" data-act="chat-ctx-clear">📄 ' + esc(S.chatPage.title) + ' ✕</button></div>' : '') +
          '<form id="chatForm"><textarea id="chatInput" rows="1" placeholder="Спросите о своей базе…" enterkeyhint="send"></textarea>' +
          '<button class="send" type="submit" aria-label="Отправить">' + I.send + '</button></form>' +
          '<div class="center" id="chatClear" style="margin-top:4px"' + (S.chat.length ? '' : ' hidden') + '><button class="chip" data-act="chat-clear" style="min-height:26px;font-size:12.5px;background:none">Новый разговор</button></div>' +
        '</div>',
      after() {
        const ta = $('#chatInput');
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
        ta.addEventListener('input', grow);
        ta.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); $('#chatForm').requestSubmit(); }
        });
        $('#chatForm').addEventListener('submit', e => {
          e.preventDefault();
          const text = ta.value;
          ta.value = '';
          grow();
          sendChat(text);
        });
        $('.chat').style.paddingBottom = ($('.composer').offsetHeight + 16) + 'px';
        if (S.chat.length) window.scrollTo(0, document.body.scrollHeight);
      },
    };
  }

  async function sendChat(text) {
    text = String(text || '').trim();
    if (!text || S.chatBusy) return;
    if (!configured()) { toast('Сначала подключите базу в Настройках'); return; }
    S.chat = S.chat.filter(m => m.role !== 'error');
    S.chat.push({ role: 'user', text });
    S.chatBusy = true;
    saveChat();
    renderChat();
    try {
      const r = await api('chat', {
        messages: S.chat.map(m => ({ role: m.role, text: m.text })),
        pageId: S.chatPage ? S.chatPage.id : undefined,
      }, 180000);
      S.chat.push({ role: 'model', text: r.answer || '(пустой ответ)', sources: r.sources || [] });
    } catch (e) {
      S.chat.push({ role: 'error', text: e.message });
    }
    S.chatBusy = false;
    saveChat();
    renderChat();
  }

  function ask(q, page) {
    if (page) S.chatPage = page;
    S.stacks.chat = [];
    switchTab('chat');
    if (q) sendChat(q);
    else setTimeout(() => { const ta = $('#chatInput'); if (ta) ta.focus(); }, 50);
  }

  // ───────────────────────────── Настройки ─────────────────────────────

  function VIEWS_settings() {
    const st = S.settings;
    const body = JSON.stringify({ action: 'add', token: st.token || 'ВАШ_КЛЮЧ', text: '«Ввод быстрой команды»' });
    const help = s => MD.render(s);
    return {
      title: 'Настройки',
      html:
        '<h2 class="section">Подключение к базе</h2>' +
        '<div class="card">' +
          '<label class="field"><span>URL веб-приложения Apps Script</span><input id="setUrl" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(st.url) + '"></label>' +
          '<label class="field"><span>Ключ приложения (из setupApp)</span><input id="setToken" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="вставьте ключ" value="' + esc(st.token) + '"></label>' +
        '</div>' +
        '<div class="chips" style="margin-top:10px"><button class="btn primary small" data-act="settings-save">Сохранить и проверить</button></div>' +
        '<p class="small" id="pingResult" style="margin:10px 4px"></p>' +

        '<h2 class="section">Работа</h2>' +
        '<div class="card">' +
          '<label class="field"><span>Обновлять базу с Диска, пока приложение открыто</span><select id="setInterval">' +
            [5, 15, 30, 60].map(n => '<option value="' + n + '"' + (st.interval === n ? ' selected' : '') + '>каждые ' + n + ' мин</option>').join('') +
          '</select></label>' +
          '<label class="field toggle"><input type="checkbox" id="setDemo"' + (st.demo ? ' checked' : '') + '> Демо-режим (выдуманные данные, без Google Диска)</label>' +
        '</div>' +

        '<h2 class="section">Действия</h2>' +
        '<ul class="list">' +
          '<li><button class="row has-icon" data-act="app-update"><span class="ico">⬆️</span><span class="body">' +
            '<span class="t">Обновить приложение</span><span class="s" id="updInfo">установлена версия ' + VERSION + '</span></span>' + I.chev + '</button></li>' +
          row({ act: 'revise', icon: '🧹', title: 'Разобрать «Входящие» сейчас', sub: 'не дожидаясь ревизии в 9:00' }) +
          row({ act: 'refresh', icon: '🔄', title: 'Обновить базу с Диска' }) +
          row({ act: 'migrate', icon: '🎞️', title: 'Сделать карточки для старых видео', sub: 'для роликов, сохранённых до карточек; повторно не дублирует' }) +
          row({ act: 'clear-cache', icon: '🗑️', title: 'Очистить сохранённые страницы', sub: 'очередь отправки не трогается', chev: false }) +
        '</ul>' +

        '<h2 class="section">Помощь</h2>' +
        '<div class="card">' +
          '<details class="help"><summary>Установить на iPhone</summary><div class="doc">' + help(
            '1. Откройте этот сайт в **Safari**.\n2. Кнопка «Поделиться» → **«На экран „Домой“»**.\n3. Запускайте с иконки «База» — так это полноценное приложение: без адресной строки, с офлайн-кэшем и без срока годности (в отличие от IPA, подписанной бесплатным аккаунтом).') +
          '</div></details>' +
          '<details class="help" style="border-top:0.5px solid var(--line)"><summary>Ссылки из YouTube в один тап</summary><div class="doc">' + help(
            'Сделайте «Быструю команду», и в меню «Поделиться» любого приложения появится пункт «В базу».\n\n' +
            '1. Приложение **Команды** → «+» → «Добавить действие» → **«Получить содержимое URL»**.\n' +
            '2. URL — адрес веб-приложения (тот же, что выше).\n' +
            '3. Метод **POST**, «Текст запроса» — **JSON**, поля: `action` = `add`, `token` = ваш ключ, `text` = переменная «Ввод быстрой команды».\n' +
            '4. Нажмите ⓘ внизу → включите **«Показывать в меню „Поделиться“»**, типы входа — URL и текст.\n' +
            '5. Назовите команду «В базу». Её же можно вызвать голосом: «Привет, Siri, в базу».') +
            '<div class="code">' + esc(body) + '</div><p class="small muted">Так выглядит тело запроса.</p></div></details>' +
          '<details class="help" style="border-top:0.5px solid var(--line)"><summary>Gemini и токены</summary><div class="doc">' + help(
            'Всё, что делает AI — расшифровка голосовых, разбор «Входящих», чат, — идёт через **Gemini API** с ключом, который лежит в свойствах вашего скрипта Apps Script (`GEMINI_API_KEY`). Токены Claude не тратятся.\n\n' +
            'Подписка Google AI Pro и Gemini API — разные вещи: подписка даёт приложение Gemini, а API работает по ключу из **Google AI Studio**. У ключа есть бесплатный лимит, которого для личной базы обычно хватает. На бесплатном тарифе Google может использовать отправленные данные для улучшения своих моделей.') +
          '</div></details>' +
        '</div>' +
        '<p class="small muted center" style="margin-top:18px">База ' + VERSION + '</p>',
      after() {
        $('#setInterval').addEventListener('change', e => { st.interval = +e.target.value; saveSettings(); });
        $('#setDemo').addEventListener('change', e => setDemo(e.target.checked));
        serverVersion().then(v => {
          const el = $('#updInfo');
          if (!el || !v) return;
          el.textContent = v === VERSION
            ? 'установлена версия ' + VERSION + ' — последняя'
            : 'установлена ' + VERSION + ', доступна ' + v + ' — нажмите, чтобы обновить';
          if (v !== VERSION) el.style.color = 'var(--accent)';
        });
      },
    };
  }

  async function saveConnection() {
    const url = $('#setUrl').value.trim();
    const token = $('#setToken').value.trim();
    const out = $('#pingResult');
    if (url && !/^https:\/\/script\.google(usercontent)?\.com\/.+\/exec/.test(url)) {
      out.innerHTML = '<span style="color:var(--danger)">URL должен быть вида https://script.google.com/macros/s/…/exec</span>';
      return;
    }
    Object.assign(S.settings, { url, token, demo: false });
    saveSettings();
    $('#setDemo').checked = false;
    if (!url || !token) { out.textContent = 'Сохранено. Для подключения нужны и URL, и ключ.'; return; }
    out.textContent = 'Проверяю…';
    try {
      const r = await api('ping', {}, 30000);
      out.innerHTML = '<span style="color:var(--ok)">✓ Подключено к «' + esc(r.base) + '»</span> · модель ' + esc(r.model) + (r.gemini ? '' : ' · <span style="color:var(--danger)">не задан GEMINI_API_KEY</span>');
      await resetData();
      refreshTree(true);
      flushOutbox();
    } catch (e) {
      out.innerHTML = '<span style="color:var(--danger)">✕ ' + esc(e.message) + '</span>';
    }
  }

  async function resetData() {
    S.tree = null;
    S.treeAt = 0;
    S.treeError = '';
    S.stacks.base = [];
    S.stacks.videos = [];
    await idb.set('tree', null);
  }

  async function setDemo(on) {
    S.settings.demo = on;
    saveSettings();
    await resetData();
    if (!on) { S.chat = []; saveChat(); }
    toast(on ? 'Демо-режим включён' : 'Демо-режим выключен');
    refreshTree(true);
  }

  // ───────────────────────────── События ─────────────────────────────

  const ROOTS = { capture: ROOTS_capture, base: ROOTS_base, videos: ROOTS_videos, chat: ROOTS_chat };
  const VIEWS = { page: VIEWS_page, video: VIEWS_video, topic: VIEWS_topic, list: VIEWS_list, settings: VIEWS_settings };

  document.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (tab) { switchTab(tab.dataset.tab); return; }
    const docLink = e.target.closest('a[data-doc]');
    if (docLink) { e.preventDefault(); openPage(docLink.dataset.doc, (findKnown(docLink.dataset.doc) || {}).title || docLink.textContent.trim()); return; }
    // таймкод этого же видео — перемотать плеер, а не уходить на YouTube
    const a = e.target.closest('a[href]');
    const cur = top();
    if (a && cur && cur.videoId && ytId(a.href) === cur.videoId) {
      let t = null;
      try { t = new URL(a.href).searchParams.get('t'); } catch (err) {}
      if (t != null) { e.preventDefault(); playAt(cur.videoId, parseInt(t, 10) || 0); return; }
    }
    const chk = e.target.closest('#doc [data-check]');
    if (chk && cur && cur.type === 'video') { toggleCheck(chk); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const d = el.dataset;
    switch (d.act) {
      case 'save': saveNote(); break;
      case 'paste': paste(); break;
      case 'mic': if (Rec.rec) stopRec(false); else startRec(); break;
      case 'mic-cancel': stopRec(true); toast('Запись отменена'); break;
      case 'retry': {
        const it = S.outbox.find(x => x.id === d.id);
        if (it) { it.status = 'queued'; saveOutbox(); renderRecent(); flushOutbox(); }
        break;
      }
      case 'drop':
        S.outbox = S.outbox.filter(x => x.id !== d.id);
        saveOutbox();
        renderRecent();
        break;
      case 'page': openPage(d.id, d.title || (findKnown(d.id) || {}).title, d.video ? { videoId: d.video } : null); break;
      case 'video': openVideo(d.id); break;
      case 'topic': push({ type: 'topic', name: d.name }); break;
      case 'list': push({ type: 'list', kind: d.kind }); break;
      case 'tab': switchTab(d.tab); break;
      case 'settings': push({ type: 'settings' }); break;
      case 'settings-save': saveConnection(); break;
      case 'demo-on': setDemo(true).then(render); break;
      case 'refresh': refreshTree(true); toast('Обновляю базу…'); break;
      case 'revise': revise(); break;
      case 'clear-cache':
        idb.clear().then(() => { saveOutbox(); idb.set('tree', { tree: S.tree, at: S.treeAt }); toast('Сохранённые страницы удалены'); });
        break;
      case 'yt-play': playAt(d.vid, null); break;
      case 'vf':
        S.vf[d.k] = d.v;
        saveVf();
        rerenderKeepScroll();
        break;
      case 'vf-reset':
        Object.assign(S.vf, { status: 'all', type: 'all', topic: '', channel: '', q: '' });
        saveVf();
        render();
        break;
      case 'vstatus': setVideoStatus(d.v); break;
      case 'vretry': retryVideo(); break;
      case 'migrate': migrateVideos(); break;
      case 'app-update':
        if (Rec.rec) { toast('Сначала закончите запись'); break; }
        forceUpdate();
        break;
      case 'ask': ask(d.q); break;
      case 'ask-page': {
        const v = top();
        ask('', { id: d.id, title: (v && v.title) || 'страница' });
        break;
      }
      case 'chat-clear': S.chat = []; S.chatPage = null; saveChat(); render(); break;
      case 'chat-ctx-clear': S.chatPage = null; render(); break;
      case 'chat-retry': {
        const lastUser = [...S.chat].reverse().find(m => m.role === 'user');
        if (lastUser) { S.chat = S.chat.filter(m => m !== lastUser && m.role !== 'error'); sendChat(lastUser.text); }
        break;
      }
      case 'chat-save': {
        const i = +d.i;
        const m = S.chat[i];
        const q = S.chat.slice(0, i).reverse().find(x => x.role === 'user');
        if (m) {
          enqueue({ type: 'text', text: 'Ответ AI-ассистента (не моя мысль) на вопрос «' + (q ? q.text : '') + '»:\n\n' + m.text, revise: false });
          toast('Ответ отправлен во «Входящие»');
        }
        break;
      }
      case 'chat-copy': {
        const m = S.chat[+d.i];
        if (m && navigator.clipboard) navigator.clipboard.writeText(m.text).then(() => toast('Скопировано'), () => toast('Не удалось скопировать'));
        break;
      }
    }
  });

  $('#back').addEventListener('click', back);
  $('#settingsBtn').addEventListener('click', () => { const v = top(); if (!v || v.type !== 'settings') push({ type: 'settings' }); });
  $('#sync').addEventListener('click', () => { if (configured()) { refreshTree(true); flushOutbox(); } else push({ type: 'settings' }); });

  window.addEventListener('online', () => { flushOutbox(); refreshTree(true); renderRecent(); });
  window.addEventListener('offline', () => { setSync('offline', 'Нет сети'); renderRecent(); });
  // ───────────────────────────── Обновление приложения ─────────────────────────────
  // На iPhone приложение с экрана «Домой» держится за старые файлы — поэтому версия сверяется с сервером
  // (version.json), а «Обновить приложение» сбрасывает офлайн-кэш и грузит всё заново.
  // Заметки, очередь отправки и настройки лежат отдельно (localStorage, IndexedDB) и не трогаются.

  async function serverVersion() {
    if (location.protocol !== 'https:' || !navigator.onLine) return null;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      return r.ok ? ((await r.json()).version || null) : null;
    } catch (e) {
      return null;
    }
  }

  async function forceUpdate() {
    toast('Обновляю приложение…', 8000);
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) {}
    // новый адрес страницы — чтобы и сама страница не взялась из кэша браузера
    location.replace(location.pathname + '?v=' + Date.now());
  }

  // Вышла новая версия — обновиться самому, один раз на каждую версию (чтобы не зациклиться)
  let lastVersionCheck = 0;
  async function autoUpdate() {
    if (Date.now() - lastVersionCheck < 10 * 60000) return;
    lastVersionCheck = Date.now();
    const v = await serverVersion();
    if (!v || v === VERSION || Rec.rec) return;
    if (LS.get('autoUpdatedTo', '') === v) return;
    LS.set('autoUpdatedTo', v);
    forceUpdate();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    autoUpdate();
    flushOutbox();
    if (Date.now() - S.treeAt > 5 * 60000) refreshTree(true);
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - S.treeAt > S.settings.interval * 60000) refreshTree(true);
  }, 60000);

  // ───────────────────────────── Запуск ─────────────────────────────

  (async function boot() {
    const cached = await idb.get('tree');
    if (cached && cached.tree && !!cached.demo === !!S.settings.demo) { S.tree = cached.tree; S.treeAt = cached.at || 0; }
    await loadOutbox();
    render();
    autoUpdate();
    // адрес с ?v=… после обновления больше не нужен
    if (/[?&]v=\d+/.test(location.search)) history.replaceState(null, '', location.pathname);
    if (configured()) {
      if (!navigator.onLine) setSync('offline', 'Нет сети — показана сохранённая копия');
      refreshTree(true);
      flushOutbox();
    } else {
      setSync('', 'Не подключено');
    }
    // на localhost офлайн-кэш не нужен: при разработке он показывал бы старую версию файлов
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      // пришла новая версия приложения — перезагрузиться, чтобы сразу её показать (кроме записи голоса)
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return;
        if (Rec.rec) { toast('Вышла новая версия — перезапустите приложение после записи', 5000); return; }
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  })();
})();
