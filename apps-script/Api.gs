/**
 * API приложения «База» — приложения на iPhone (PWA), которое пишет во «Входящие» и показывает базу по темам.
 *
 * Файл добавляется в тот же проект Apps Script, что и Code.gs («База знаний — ревизия»), и пользуется его
 * функциями: CONFIG, root_, sub_, importMarkdown_, exportMarkdown_, callGemini_, callGeminiRaw_,
 * youtubeInfo_, readRules_, cleanTitle_, fmtTime_, decodeEntities_, YT_RE, DOC_MIME, continueRevision.
 * Ключ Gemini тот же — свойство скрипта GEMINI_API_KEY.
 *
 * Настройка (один раз):
 *   1. Выполнить setupApp() — создаст ключ приложения и покажет его в журнале выполнения.
 *   2. «Начать развертывание» → «Новое развертывание» → тип «Веб-приложение»,
 *      «Запуск от имени: я», «У кого есть доступ: все» → скопировать URL (заканчивается на /exec).
 *   3. В приложении: Настройки → вставить URL и ключ → «Проверить».
 * После изменения кода: «Начать развертывание» → «Управление развертываниями» → карандаш →
 * «Версия: новая версия» → «Развернуть». URL при этом не меняется.
 */

const APP = {
  NAME: 'База',
  MAX_AUDIO_BYTES: 18 * 1024 * 1024, // у Gemini лимит ~20 МБ на запрос со встроенным файлом
  CHAT_MAX_PAGES: 6,
  CHAT_MAX_CHARS: 60000,
  VIDEO_LOOKUPS_PER_CALL: 25,        // сколько старых клиппингов за один запрос читать, чтобы найти ссылку
  RECENT_NOTES: 150,
  CLIPPINGS: 'Клиппинги',
  NOTES: 'Заметки',
  FILES: 'Файлы',
};

const API_ = {
  ping: apiPing_,
  tree: apiTree_,
  page: apiPage_,
  add: apiAdd_,
  voice: apiVoice_,
  chat: apiChat_,
  revise: apiRevise_,
};

// ───────────────────────────── Запуск вручную ─────────────────────────────

function setupApp() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('APP_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
    props.setProperty('APP_TOKEN', token);
  }
  Logger.log('Ключ приложения: ' + token);
  Logger.log('Дальше: «Начать развертывание» → «Новое развертывание» → «Веб-приложение», ' +
    'запуск от имени «я», доступ «все». URL веб-приложения и этот ключ вставьте в приложении в Настройках.');
}

/** Если ключ утёк: создаёт новый, старый перестаёт работать. */
function resetAppToken() {
  PropertiesService.getScriptProperties().deleteProperty('APP_TOKEN');
  setupApp();
}

/** Проверка без телефона: печатает в журнал, что увидит приложение. */
function testApi() {
  const t = apiTree_().tree;
  Logger.log('Тем: ' + t.topics.length + ', мыслей: ' + t.thoughts.length + ', видео: ' + t.videos.length +
    ', во «Входящих»: ' + t.inbox.length);
  t.topics.forEach(x => Logger.log('  ' + x.name + ' — страниц: ' + x.pages.length));
}

// ───────────────────────────── Веб-приложение ─────────────────────────────

function doGet() {
  return json_({ ok: true, app: APP.NAME, hint: 'API работает. Приложение обращается сюда POST-запросами.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Неверный формат запроса' });
  }
  return json_(handleApi_(req));
}

function handleApi_(req) {
  const token = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!token) return { ok: false, error: 'Ключ приложения не создан — выполните setupApp() в Apps Script' };
  if (req.token !== token) return { ok: false, auth: false, error: 'Неверный ключ приложения' };
  const fn = API_[req.action];
  if (!fn) return { ok: false, error: 'Неизвестное действие: ' + req.action };
  try {
    return Object.assign({ ok: true }, fn(req));
  } catch (e) {
    console.error(req.action + ': ' + (e.stack || e.message));
    return { ok: false, error: e.message };
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────────── Действия ─────────────────────────────

function apiPing_() {
  const props = PropertiesService.getScriptProperties();
  return {
    app: APP.NAME,
    model: props.getProperty('GEMINI_MODEL') || CONFIG.MODEL,
    gemini: !!props.getProperty('GEMINI_API_KEY'),
    base: root_().getName(),
    time: new Date().toISOString(),
  };
}

/** Вся структура базы для экранов «База» и «Видео» — без текстов страниц. */
function apiTree_() {
  const root = root_();
  const knowledge = sub_(root, CONFIG.KNOWLEDGE);

  const general = [];
  eachDoc_(knowledge, f => general.push(docInfo_(f)));
  const topics = [];
  const tf = knowledge.getFolders();
  while (tf.hasNext()) {
    const folder = tf.next();
    const name = folder.getName();
    const topic = { name, indexId: null, pages: [] };
    walkDocs_(folder, (f, path) => {
      if (!path && f.getName() === name) topic.indexId = f.getId();
      else topic.pages.push(docInfo_(f, path));
    });
    topic.pages.sort(byModified_);
    topics.push(topic);
  }
  topics.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const thoughts = [];
  let thoughtsIndex = null;
  walkDocs_(sub_(root, CONFIG.THOUGHTS), (f, path) => {
    if (!path && f.getName() === CONFIG.THOUGHTS) thoughtsIndex = f.getId();
    else thoughts.push(docInfo_(f, path));
  });
  thoughts.sort(byModified_);

  const sources = sub_(root, CONFIG.SOURCES);
  const notes = [];
  walkDocs_(sub_(sources, APP.NOTES), (f, path) => notes.push(docInfo_(f, path)));
  notes.sort(byModified_);

  const inbox = [];
  const it = sub_(root, CONFIG.INBOX).getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const mime = f.getMimeType();
    if (f.getName() === CONFIG.INBOX_GUIDE || mime === 'application/vnd.google-apps.script') continue;
    inbox.push(Object.assign(docInfo_(f), { mime, url: f.getDescription() || '' }));
  }
  inbox.sort(byCreated_);

  return {
    tree: {
      topics,
      general: general.sort(byModified_),
      thoughts,
      thoughtsIndex,
      videos: clippings_(sub_(sources, APP.CLIPPINGS)),
      notes: notes.slice(0, APP.RECENT_NOTES),
      notesTotal: notes.length,
      inbox,
      mainId: firstDocId_(root, CONFIG.MAIN_DOC),
      rulesId: firstDocId_(root, CONFIG.RULES_DOC),
      lastReport: lastReport_(root),
      updated: new Date().toISOString(),
    },
  };
}

function apiPage_(req) {
  const f = DriveApp.getFileById(String(req.id || ''));
  if (f.getMimeType() !== DOC_MIME) throw new Error('Это не Google Документ: ' + f.getName());
  return {
    page: {
      id: f.getId(),
      title: f.getName(),
      markdown: exportMarkdown_(f.getId()),
      modified: f.getLastUpdated().toISOString(),
      url: f.getDescription() || '',
    },
  };
}

/** Заметка или ссылка → новый Google Документ во «Входящих». Ссылку с коротким комментарием оформляет как клиппинг. */
function apiAdd_(req) {
  const text = String(req.text || '').trim();
  if (!text) throw new Error('Пустая заметка');
  const root = root_();
  const now = new Date();
  const stamp = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
  const url = (text.match(/https?:\/\/[^\s<>"«»]+/) || [''])[0].replace(/[.,;:!?)]+$/, '');
  const rest = url ? text.replace(url, '').trim() : text;

  let title, md;
  if (url && rest.length < 600) {
    const yt = YT_RE.test(url);
    const info = yt ? youtubeInfo_(url) : pageInfo_(url);
    title = cleanTitle_((yt ? 'Видео — ' : 'Ссылка — ') + info.title);
    md = '# ' + info.title + '\n\n- **Ссылка:** ' + url +
      (info.author ? '\n- **Автор:** ' + info.author : '') +
      '\n- **Добавлено:** ' + stamp + ', из приложения' +
      '\n\n## Мой комментарий\n\n' + (rest || '_Без комментария._');
  } else {
    title = cleanTitle_(req.title || 'Заметка — ' + firstWords_(text));
    md = text + '\n\n_Добавлено: ' + stamp + ', из приложения_';
  }
  const id = importMarkdown_(title, md, sub_(root, CONFIG.INBOX));
  if (url) DriveApp.getFileById(id).setDescription(url);
  const scheduled = req.revise ? scheduleRevision_() : false;
  return { item: { id, title, url, kind: url ? 'link' : 'note' }, scheduled };
}

const VOICE_SYSTEM = [
  'Ты расшифровываешь голосовые заметки владельца личной базы знаний.',
  'Запиши ДОСЛОВНО всё, что сказано, на языке оригинала. Расставь знаки препинания, разбей на абзацы по смыслу.',
  'Не пересказывай, не сокращай и не добавляй ничего от себя. Слова-паразиты («ну», «э-э», «как бы») и явные оговорки убери.',
  'Придумай короткое название заметки (3–7 слов) по её смыслу.',
  'Ответь ТОЛЬКО JSON: { "title": "название", "text": "расшифровка" }. Если речи нет — { "title": "", "text": "" }.',
].join('\n');

/** Голосовая заметка: аудио → «Источники/Файлы», расшифровка Gemini → документ во «Входящих». */
function apiVoice_(req) {
  if (!req.audio) throw new Error('Нет аудио');
  const mime = String(req.mime || 'audio/mp4').split(';')[0].trim();
  const bytes = Utilities.base64Decode(req.audio);
  if (bytes.length > APP.MAX_AUDIO_BYTES) {
    throw new Error('Запись слишком большая (' + Math.round(bytes.length / 1048576) + ' МБ) — разбейте на части до 15 минут');
  }
  const root = root_();
  const inbox = sub_(root, CONFIG.INBOX);
  const now = new Date();
  const stamp = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
  const ext = /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : /mpeg|mp3/.test(mime) ? 'mp3' : 'm4a';
  const audioName = 'Голосовая заметка ' + stamp.replace(':', '-') + '.' + ext;
  const audio = sub_(sub_(root, CONFIG.SOURCES), APP.FILES).createFile(Utilities.newBlob(bytes, mime, audioName));
  const duration = req.seconds ? fmtTime_(Math.round(req.seconds)) : '';

  let tr;
  try {
    tr = callGemini_(VOICE_SYSTEM, [
      { inlineData: { mimeType: mime, data: req.audio } },
      { text: 'Голосовая заметка, записана ' + stamp + (duration ? ', длительность ' + duration : '') + '.' },
    ], { temperature: 0 });
  } catch (e) {
    // не расшифровалось сразу — запись уходит во «Входящие» как есть, утренняя ревизия разберёт аудио сама
    audio.moveTo(inbox);
    return {
      item: { id: audio.getId(), title: audioName, kind: 'audio' },
      warning: 'Сразу расшифровать не удалось (' + e.message.slice(0, 120) + '). Запись лежит во «Входящих» — её разберёт ревизия.',
    };
  }
  const text = String(tr.text || '').trim();
  if (!text) {
    return {
      item: { id: audio.getId(), title: audioName, kind: 'audio' },
      warning: 'Речь в записи не распознана. Аудио сохранено в «Источники/Файлы».',
    };
  }
  const title = cleanTitle_('Голосовая — ' + (tr.title || stamp));
  const md = text + '\n\n---\n\n- **Голосовая заметка:** ' + stamp + (duration ? ', ' + duration : '') +
    '\n- **Запись:** [аудио](' + audio.getUrl() + ')';
  const id = importMarkdown_(title, md, inbox);
  const scheduled = req.revise ? scheduleRevision_() : false;
  return { item: { id, title, kind: 'voice', text }, scheduled };
}

const PICK_SYSTEM = [
  'Ты помогаешь искать в личной базе знаний. Тебе дают каталог страниц (название, раздел, дата изменения) и вопрос.',
  'Выбери до 6 страниц, которые нужно прочитать, чтобы ответить. Названия — точно как в каталоге.',
  'Если вопрос про недавнее («за неделю», «вчера», «последнее») — выбирай по датам.',
  'Если для ответа база не нужна (приветствие, общий вопрос не про базу) — верни пустой список.',
  'Ответь ТОЛЬКО JSON: { "pages": ["название", ...] }',
].join('\n');

function chatSystem_(rules) {
  return [
    'Ты — AI-ассистент внутри личной базы знаний владельца. Сегодня ' +
      Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd') + '.',
    'Отвечай по-русски, по делу и без воды, в Markdown (заголовки, списки, жирный — по необходимости).',
    'Опирайся прежде всего на страницы базы, которые тебе дали. Используя страницу, называй её в «ёлочках».',
    'Если в базе ответа нет — прямо скажи об этом; можешь добавить ответ из общих знаний, пометив его «(не из базы)».',
    'Не выдумывай, что есть в базе. Если просят идеи, план или выжимку — делай на основе материалов базы.',
    '',
    'Правила базы, чтобы понимать её устройство:',
    '<правила>', rules, '</правила>',
  ].join('\n');
}

/** Чат по базе: Gemini выбирает страницы по каталогу, затем отвечает по их тексту. */
function apiChat_(req) {
  const msgs = (req.messages || []).filter(m => m && m.text).slice(-12);
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'user') throw new Error('Пустой вопрос');
  const root = root_();
  const index = chatIndex_(root);
  const byTitle = {};
  index.forEach(p => { byTitle[p.title] = p; });
  const history = msgs.slice(0, -1)
    .map(m => (m.role === 'user' ? 'Я: ' : 'Ассистент: ') + String(m.text).slice(0, 4000))
    .join('\n\n');

  let titles = [];
  if (req.pageId) {
    const hit = index.find(p => p.id === req.pageId);
    if (hit) titles.push(hit.title);
  }
  const catalog = index.map(p => '- ' + p.title + ' (' + p.path + ', ' + p.modified.slice(0, 10) + ')').join('\n');
  const pick = callGemini_(PICK_SYSTEM, [
    { text: 'Каталог базы:\n' + catalog },
    { text: (history ? 'Начало разговора:\n' + history.slice(-6000) + '\n\n' : '') + 'Вопрос: ' + last.text },
  ], { temperature: 0 });
  (pick.pages || []).forEach(t => {
    if (byTitle[t] && titles.indexOf(t) < 0) titles.push(t);
  });
  titles = titles.slice(0, APP.CHAT_MAX_PAGES);

  let budget = APP.CHAT_MAX_CHARS;
  const pages = [];
  titles.forEach(t => {
    if (budget <= 1000) return;
    const md = stripImages_(exportMarkdown_(byTitle[t].id)).slice(0, budget);
    budget -= md.length;
    pages.push({ title: t, id: byTitle[t].id, md });
  });

  const answer = callGeminiRaw_(chatSystem_(readRules_(root)), [
    { text: 'Каталог базы (для справки):\n' + catalog },
    {
      text: pages.length
        ? 'Страницы базы по теме вопроса:\n\n' +
          pages.map(p => '<страница название="' + p.title + '">\n' + p.md + '\n</страница>').join('\n\n')
        : 'Подходящих страниц в базе не нашлось.',
    },
    { text: (history ? 'Начало разговора:\n' + history + '\n\n' : '') + 'Мой вопрос: ' + last.text },
  ], { temperature: 0.4 });

  return { answer: answer.trim(), sources: pages.map(p => ({ title: p.title, id: p.id })) };
}

function apiRevise_() {
  const scheduled = scheduleRevision_();
  return { scheduled, inbox: inboxCount_() };
}

// ───────────────────────────── Вспомогательное ─────────────────────────────

/** Ревизия «Входящих» вне расписания: через ~минуту, через ту же функцию, что продолжает длинные ревизии. */
function scheduleRevision_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'continueRevision')) return true;
  ScriptApp.newTrigger('continueRevision').timeBased().after(10 * 1000).create();
  return true;
}

function inboxCount_() {
  let n = 0;
  const it = sub_(root_(), CONFIG.INBOX).getFiles();
  while (it.hasNext()) if (it.next().getName() !== CONFIG.INBOX_GUIDE) n++;
  return n;
}

/**
 * Клиппинги для экрана «Видео». Транскрипт и исходная заметка со ссылкой на одно видео склеиваются в одну карточку.
 * Ссылка на видео запоминается в описании файла, чтобы не открывать документ при каждом запросе.
 */
function clippings_(folder) {
  const items = [];
  let lookups = 0;
  walkDocs_(folder, f => {
    let url = f.getDescription() || '';
    if (!url && lookups < APP.VIDEO_LOOKUPS_PER_CALL) {
      lookups++;
      const head = DocumentApp.openById(f.getId()).getBody().getText().slice(0, 3000);
      url = (head.match(YT_RE) || head.match(/https?:\/\/[^\s<>"«»)]+/) || [''])[0];
      f.setDescription(url || '-');
    }
    if (url === '-') url = '';
    items.push(Object.assign(docInfo_(f), { url, videoId: ytId_(url) }));
  });

  const byVideo = {};
  const out = [];
  items.sort(byCreated_).forEach(x => {
    const transcript = /^Транскрипт\s+—/.test(x.title);
    const key = x.videoId || x.id;
    const prev = byVideo[key];
    if (!prev) {
      const card = Object.assign({}, x, { noteId: transcript ? null : x.id });
      byVideo[key] = card;
      out.push(card);
      return;
    }
    if (transcript) {
      // карточка ведёт на транскрипт, заметка со ссылкой остаётся «моим комментарием»
      prev.noteId = prev.noteId || prev.id;
      Object.assign(prev, { id: x.id, title: x.title, modified: x.modified });
    } else {
      prev.noteId = x.id;
    }
  });
  out.forEach(c => { c.title = c.title.replace(/^(Транскрипт|Видео|Ссылка)\s+—\s+/, ''); });
  return out;
}

/** Страницы, по которым ищет чат: знания, мысли, транскрипты и оригиналы заметок. */
function chatIndex_(root) {
  const out = [];
  const add = (folder, base) => walkDocs_(folder, (f, path) => {
    const p = docInfo_(f, path);
    p.path = base + (path ? '/' + path : '');
    out.push(p);
  });
  add(sub_(root, CONFIG.KNOWLEDGE), CONFIG.KNOWLEDGE);
  add(sub_(root, CONFIG.THOUGHTS), CONFIG.THOUGHTS);
  const sources = sub_(root, CONFIG.SOURCES);
  add(sub_(sources, APP.CLIPPINGS), CONFIG.SOURCES + '/' + APP.CLIPPINGS);
  add(sub_(sources, APP.NOTES), CONFIG.SOURCES + '/' + APP.NOTES);
  return out.sort(byModified_);
}

function walkDocs_(folder, fn, path) {
  path = path || '';
  eachDoc_(folder, f => fn(f, path));
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const s = subs.next();
    walkDocs_(s, fn, path ? path + '/' + s.getName() : s.getName());
  }
}

function eachDoc_(folder, fn) {
  const files = folder.getFilesByType(DOC_MIME);
  while (files.hasNext()) fn(files.next());
}

function docInfo_(f, path) {
  return {
    id: f.getId(),
    title: f.getName(),
    modified: f.getLastUpdated().toISOString(),
    created: f.getDateCreated().toISOString(),
    path: path || '',
  };
}

function byModified_(a, b) { return a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0; }
function byCreated_(a, b) { return a.created < b.created ? 1 : a.created > b.created ? -1 : 0; }

function firstDocId_(folder, name) {
  const it = folder.getFilesByName(name);
  return it.hasNext() ? it.next().getId() : null;
}

function lastReport_(root) {
  const it = sub_(sub_(root, CONFIG.SERVICE), CONFIG.REPORTS).getFilesByType(DOC_MIME);
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    if (!best || f.getDateCreated() > best.getDateCreated()) best = f;
  }
  return best ? docInfo_(best) : null;
}

function ytId_(url) {
  const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{6,})/);
  return m ? m[1] : '';
}

function pageInfo_(url) {
  const info = { title: url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 80), author: '' };
  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true, headers: { 'Accept-Language': 'ru,en;q=0.8' },
    });
    const html = resp.getContentText().slice(0, 300000);
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
      html.match(/<title[^>]*>([^<]+)/i);
    if (m) info.title = decodeEntities_(m[1]).replace(/\s+/g, ' ').trim();
  } catch (e) {}
  return info;
}

function firstWords_(text) {
  const line = String(text).split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60) + '…';
}

/** Картинки из экспорта Google Документов (base64) чату не нужны и съедают лимит. */
function stripImages_(md) {
  return md.replace(/^\[[^\]]+\]:\s*<?data:[^\n]*$/gm, '').replace(/!\[[^\]]*\]\[[^\]]*\]/g, '');
}
