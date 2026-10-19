/**
 * База знаний на Google Drive: перевод в Google Документы и ежедневная ревизия «Входящих» через Gemini.
 *
 * Функции для запуска вручную (выпадающий список вверху редактора → «Выполнить»):
 *   testGemini()           — проверить ключ и модель Gemini
 *   migrateToGoogleDocs()  — один раз: перевести все .md в Google Документы (можно запускать повторно)
 *   installTrigger()       — включить ежедневный запуск в 9:00 по Иркутску
 *   dailyRevision()        — сама ревизия (её же вызывает расписание)
 *   migrateVideos()        — один раз: карточки для видео, сохранённых раньше (Video.gs)
 *
 * Видео разбираются через карточки (Video.gs): транскрипт и конспект делаются сразу после добавления ссылки,
 * а ревизия разносит полезное из готовой карточки по «Знаниям».
 */

const CONFIG = {
  ROOT_FOLDER_ID: '1AibuQB958CCc7S4lGryABE06Y_-VQ2GC', // папка «База знаний»
  MODEL: 'gemini-3.8-flash',      // можно переопределить свойством скрипта GEMINI_MODEL
  TIMEZONE: 'Asia/Irkutsk',
  HOUR: 9,
  TIME_BUDGET_MS: 4.5 * 60 * 1000, // лимит Apps Script — 6 минут на запуск
  MAX_INLINE_BYTES: 15 * 1024 * 1024,
  TRANSCRIPT_CHUNK_SEC: 600,       // видео расшифровывается кусками по 10 минут
  TRANSCRIPT_MAX_SEC: 4 * 3600,    // если длительность неизвестна — не дальше 4 часов
  INBOX: 'Входящие',
  THOUGHTS: 'Мысли и идеи',
  KNOWLEDGE: 'Знания',
  SOURCES: 'Источники',
  SERVICE: 'Служебное',
  REPORTS: 'Отчёты ревизий',
  ARCHIVE_MD: 'Архив .md (до перехода)',
  RULES_DOC: 'Правила базы',
  MAIN_DOC: 'Главная',
  JOURNAL_DOC: 'Журнал',
  INBOX_GUIDE: 'Входящие — как пользоваться',
  SOURCE_SUBFOLDERS: ['Заметки', 'Клиппинги', 'Статьи', 'Файлы'],
  LINK_PREFIX: 'https://kb.local/', // временные ссылки «по имени страницы», заменяются на адреса документов
};

const DOC_MIME = 'application/vnd.google-apps.document';

// ───────────────────────────── Запуск вручную ─────────────────────────────

function testGemini() {
  const res = callGemini_('Ответь JSON {"ok": true, "model": "<твоя модель>"}', [{ text: 'Проверка связи.' }]);
  Logger.log('Gemini отвечает: ' + JSON.stringify(res));
}

function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyRevision')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyRevision').timeBased()
    .atHour(CONFIG.HOUR).nearMinute(0).everyDays(1).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log('Ежедневная ревизия включена: ' + CONFIG.HOUR + ':00 ' + CONFIG.TIMEZONE);
}

// ───────────────────────────── Перевод .md → Google Документы ─────────────────────────────

function migrateToGoogleDocs() {
  const started = Date.now();
  const root = root_();
  const archive = sub_(sub_(root, CONFIG.SERVICE), CONFIG.ARCHIVE_MD);
  const mdFiles = [];
  walkFiles_(root, [archive.getId()], (file, folder) => {
    if (file.getName().toLowerCase().endsWith('.md')) mdFiles.push({ file, folder });
  });

  // 1. Создать документы (уже созданные пропускаются — функцию можно запускать повторно)
  let created = 0;
  for (const { file, folder } of mdFiles) {
    if (Date.now() - started > CONFIG.TIME_BUDGET_MS) {
      Logger.log('Не успел за один запуск (создано ' + created + '). Запустите migrateToGoogleDocs() ещё раз.');
      return;
    }
    const name = file.getName().replace(/\.md$/i, '');
    if (name === 'CLAUDE') continue; // заменён документом «Правила базы»
    if (folder.getFilesByName(name).hasNext()) continue;
    const md = prepareMarkdown_(file.getBlob().getDataAsString('UTF-8'));
    importMarkdown_(name, md, folder);
    created++;
  }
  Logger.log('Создано документов: ' + created);

  // 2. Перевести временные ссылки на адреса документов (прогресс запоминается между запусками)
  const props = PropertiesService.getScriptProperties();
  const fixed = JSON.parse(props.getProperty('LINKS_FIXED') || '[]');
  const map = titleMap_(root);
  let links = 0;
  for (const title in map) {
    const id = map[title].id;
    if (fixed.indexOf(id) >= 0) continue;
    if (Date.now() - started > CONFIG.TIME_BUDGET_MS) {
      props.setProperty('LINKS_FIXED', JSON.stringify(fixed));
      Logger.log('Ссылки исправлены в ' + fixed.length + ' из ' + Object.keys(map).length +
        ' документов. Запустите migrateToGoogleDocs() ещё раз — продолжу с этого места.');
      return;
    }
    links += fixDocLinks_(id, map);
    fixed.push(id);
  }
  props.setProperty('LINKS_FIXED', JSON.stringify(fixed));
  Logger.log('Исправлено ссылок: ' + links);

  // 3. Убрать .md в архив (не удаляются)
  mdFiles.forEach(({ file }) => file.moveTo(archive));
  Logger.log('Готово. Исходные .md перенесены в «' + CONFIG.SERVICE + '/' + CONFIG.ARCHIVE_MD + '».');
}

function prepareMarkdown_(md) {
  md = md.replace(/\r\n/g, '\n');
  // YAML-шапка клиппингов → список свойств
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    const props = fm[1].split('\n')
      .filter(l => /^[\wА-яЁё-]+:\s*\S/.test(l))
      .map(l => {
        const i = l.indexOf(':');
        return '- **' + l.slice(0, i) + ':** ' + l.slice(i + 1).trim().replace(/^"|"$/g, '');
      });
    md = (props.length ? props.join('\n') + '\n\n' : '') + md.slice(fm[0].length);
  }
  // «картинки» с YouTube → обычная ссылка
  md = md.replace(/!\[[^\]]*\]\((https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)[^)]*)\)/g, '[Видео]($1)');
  // ссылки на .md-страницы → временные ссылки по имени страницы
  md = md.replace(/\]\(<([^>]+)>\)/g, (m, href) => kbHref_(href));
  md = md.replace(/\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)/g, (m, href) => (/^[a-z]+:/i.test(href) ? m : kbHref_(href)));
  return md;
}

function kbHref_(href) {
  const p = decodeURIComponent(href.replace(/#.*$/, ''));
  if (!/\.md$/i.test(p)) return '](' + href + ')';
  let base = p.split('/').pop().replace(/\.md$/i, '');
  if (base === 'CLAUDE') base = CONFIG.RULES_DOC;
  return '](' + CONFIG.LINK_PREFIX + encodeURIComponent(base) + ')';
}

// ───────────────────────────── Ежедневная ревизия ─────────────────────────────

function dailyRevision() {
  withLock_(() => runRevision_(false));
}

/** Продолжение ревизии через 5 минут — когда не успела расшифровка длинного видео. */
function continueRevision() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'continueRevision')
    .forEach(t => ScriptApp.deleteTrigger(t));
  withLock_(() => runRevision_(true));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try { fn(); } finally { lock.releaseLock(); }
}

function scheduleContinuation_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'continueRevision')) return;
  ScriptApp.newTrigger('continueRevision').timeBased().after(5 * 60 * 1000).create();
}

function runRevision_(continuation) {
  const started = Date.now();
  const root = root_();
  const inbox = sub_(root, CONFIG.INBOX);
  const report = { found: 0, done: [], thoughts: [], created: [], updated: [], transcripts: [], left: [], errors: [], attention: [], started, needsContinue: false };

  const items = [];
  const it = inbox.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName() !== CONFIG.INBOX_GUIDE && f.getMimeType() !== 'application/vnd.google-apps.script') items.push(f);
  }
  report.found = items.length;

  if (items.length) {
    const ctx = { root, map: titleMap_(root), rules: readRules_(root) };
    for (const file of items) {
      if (Date.now() - started > CONFIG.TIME_BUDGET_MS) {
        report.left.push(file.getName() + ' — не успел, продолжу');
        report.needsContinue = true;
        continue;
      }
      try {
        processItem_(file, ctx, report);
      } catch (e) {
        report.errors.push(file.getName() + ': ' + e.message);
      }
    }
  }
  if (report.needsContinue) scheduleContinuation_();
  const nothingNew = report.done.length + report.errors.length + report.transcripts.length === 0;
  if (continuation && nothingNew) return; // промежуточные запуски без результата не засоряют отчёты
  writeReport_(root, report);
}

function processItem_(file, ctx, report) {
  const content = readItem_(file);
  if (!content) {
    report.left.push(file.getName() + ' — формат не поддерживается (' + file.getMimeType() + '), оставлен во «Входящих»');
    return;
  }

  const parts = [
    { text: 'Каталог базы:\n' + catalog_(ctx.map) },
    { text: 'Материал из «Входящих»: «' + file.getName() + '», добавлен ' +
      Utilities.formatDate(file.getDateCreated(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm') },
    content.text != null ? { text: content.text } : { inlineData: content.inline },
  ];

  // Ссылка на YouTube — сначала карточка видео (транскрипт + конспект, Video.gs), потом разбор по ней
  const yt = content.text && (content.text.match(YT_RE) || [])[0];
  let card = null;
  if (yt) {
    card = ensureVideo_(yt, { comment: commentFromText_(content.text) });
    if (card.state !== 'done' && card.state !== 'error' && !processVideo_(card, report.started)) {
      const c = findCardById_(card.id);
      report.left.push(file.getName() + ' — карточка видео: ' +
        (c.state === 'error' ? 'ошибка (' + c.error + ')' : c.stage || 'в работе') + ', продолжу');
      if (c.state !== 'error') report.needsContinue = true;
      return;
    }
    card = findCardById_(card.id);
    ctx.map[card.title] = { id: card.id, path: VIDEO.FOLDER };
    if (card.state === 'error') {
      report.attention.push('«' + card.title + '»: карточку видео сделать не удалось (' + card.error +
        '), разобрано по комментарию. Повторить — кнопкой в приложении.');
    } else {
      report.transcripts.push(card.title + (card.method ? ' — ' + card.method : ''));
      if (card.type === 'fun') {
        file.moveTo(sub_(sub_(ctx.root, CONFIG.SOURCES), 'Клиппинги'));
        report.done.push(file.getName() + ' → только карточка в «' + VIDEO.FOLDER + '» (развлекательное, в знания не разносится)');
        return;
      }
      if (Date.now() - report.started > CONFIG.TIME_BUDGET_MS - 120 * 1000) {
        report.left.push(file.getName() + ' — карточка видео готова, разбор продолжу');
        report.needsContinue = true;
        return;
      }
      parts.push({ text: 'По этому видео уже есть карточка «' + card.title + '» в разделе «' + VIDEO.FOLDER + '». ' +
        'Ссылайся на неё так: [' + card.title + '](' + CONFIG.LINK_PREFIX + encodeURIComponent(card.title) + '). ' +
        'Факты из видео помечай таймкодом [мм:сс].\n\n' + exportMarkdown_(card.id) });
      if (card.transcriptId) {
        parts.push({ text: 'Транскрипт видео (уже сохранён, повторно сохранять не нужно):\n\n' +
          DocumentApp.openById(card.transcriptId).getBody().getText().slice(0, VIDEO.TRANSCRIPT_MAX_CHARS) });
      }
    }
  }
  const plan = callGemini_(planSystem_(ctx), parts);
  if (card) plan.sourceFolder = 'Клиппинги';

  // Новые темы
  (plan.newTopics || []).forEach(t => ensureTopic_(ctx, t.name, t.description || ''));

  // Моя мысль
  if (plan.thought && plan.thought.title && plan.thought.markdown) {
    const title = uniqueTitle_(plan.thought.title, ctx.map);
    const folder = sub_(ctx.root, CONFIG.THOUGHTS);
    const id = importMarkdown_(title, resolveLinks_(plan.thought.markdown, ctx.map), folder);
    ctx.map[title] = { id, path: CONFIG.THOUGHTS };
    appendIndexLink_(ctx.map[CONFIG.THOUGHTS].id, title, id);
    report.thoughts.push(title);
  }

  // Новые страницы знаний
  (plan.newPages || []).forEach(p => {
    if (!p.title || !p.markdown) return;
    const topic = ensureTopic_(ctx, p.topic || 'Разное', '');
    const title = uniqueTitle_(p.title, ctx.map);
    const id = importMarkdown_(title, resolveLinks_(p.markdown, ctx.map), topic.folder);
    ctx.map[title] = { id, path: CONFIG.KNOWLEDGE + '/' + topic.name };
    appendIndexLink_(topic.indexId, title, id);
    report.created.push(title);
  });

  // Обновление существующих страниц
  (plan.updates || []).forEach(u => {
    const hit = ctx.map[u.title];
    if (!hit) { report.attention.push('Gemini предложил обновить несуществующую страницу «' + u.title + '»'); return; }
    const current = exportMarkdown_(hit.id);
    const res = callGemini_(updateSystem_(ctx), [
      { text: 'Каталог базы:\n' + catalog_(ctx.map) },
      { text: 'Текущая страница «' + u.title + '»:\n\n' + current },
      { text: 'Что сделать: ' + (u.instruction || '') + '\n\nНовый материал:\n' + (u.material || '') },
    ]);
    if (res.markdown) {
      replaceDocMarkdown_(hit.id, resolveLinks_(res.markdown, ctx.map));
      report.updated.push(u.title);
    }
  });

  // Оригинал → «Источники»
  const sub = CONFIG.SOURCE_SUBFOLDERS.indexOf(plan.sourceFolder) >= 0 ? plan.sourceFolder : 'Файлы';
  file.moveTo(sub_(sub_(ctx.root, CONFIG.SOURCES), sub));
  report.done.push(file.getName() + ' → ' + CONFIG.SOURCES + '/' + sub + (plan.summary ? ' — ' + plan.summary : ''));
  if (plan.attention) report.attention.push(file.getName() + ': ' + plan.attention);
}

// ───────────────────────────── Транскрибация YouTube ─────────────────────────────

const YT_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)|youtu\.be\/)[\w-]+[^\s)\]]*/;

const TRANSCRIBE_SYSTEM = [
  'Ты — профессиональный транскрибатор. Запиши ДОСЛОВНО всю речь из указанного фрагмента видео:',
  'каждое слово так, как оно произнесено, на языке оригинала.',
  'Не пересказывай, не сокращай, не перефразируй, не исправляй и не добавляй ничего от себя.',
  'Разбивай текст на абзацы по смыслу (3–6 предложений). В начале каждого абзаца ставь отметку времени',
  'от начала всего видео в формате [чч:мм:сс].',
  'Если говорят несколько человек и это различимо — начинай реплики с «Спикер 1:», «Спикер 2:».',
  'Ответь только текстом транскрипта, без заголовков и пояснений. Если во фрагменте нет речи — ответь пустой строкой.',
].join('\n');

/**
 * Дословно расшифровывает видео кусками и дописывает в документ «Транскрипт — <название>» в «Источники/Клиппинги».
 * Прогресс хранится в свойствах скрипта, поэтому длинное видео расшифровывается за несколько запусков.
 */
function transcribeYouTube_(url, started) {
  const props = PropertiesService.getScriptProperties();
  const id = (url.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]+)/) || [])[1] || url;
  const key = 'TR_' + id;
  let st = JSON.parse(props.getProperty(key) || 'null');
  if (!st) {
    const info = youtubeInfo_(url);
    const caps = youtubeCaptions_(id);
    const useGemini = !caps && props.getProperty('TRANSCRIPT_FALLBACK') !== 'off'; // выключить: свойство TRANSCRIPT_FALLBACK = off
    const method = caps ? 'субтитры YouTube' + (caps.auto ? ' (автоматические)' : '') + ', язык: ' + caps.lang
      : useGemini ? 'распознавание речи Gemini' : 'нет — у видео нет субтитров';
    const title = cleanTitle_('Транскрипт — ' + info.title);
    const md = '# ' + info.title + '\n\n- **Ссылка:** ' + url +
      (info.author ? '\n- **Автор:** ' + info.author : '') +
      (info.seconds ? '\n- **Длительность:** ' + fmtTime_(info.seconds) : '') +
      '\n- **Источник текста:** ' + method +
      '\n\n## Транскрипт\n\n' + (caps ? caps.text : useGemini ? '' : '_Субтитров нет._');
    const docId = importMarkdown_(title, md, sub_(sub_(root_(), CONFIG.SOURCES), 'Клиппинги'));
    st = { key, docId, title, videoTitle: info.title, seconds: info.seconds, next: 0, done: !useGemini, method };
    props.setProperty(key, JSON.stringify(st));
  }
  const model = props.getProperty('TRANSCRIBE_MODEL') || props.getProperty('GEMINI_MODEL') || CONFIG.MODEL;
  const limit = st.seconds || CONFIG.TRANSCRIPT_MAX_SEC;
  // запас ~90 секунд на один запрос к Gemini, чтобы не упереться в 6-минутный лимит Apps Script
  while (!st.done && Date.now() - started < CONFIG.TIME_BUDGET_MS - 90 * 1000) {
    const end = Math.min(st.next + CONFIG.TRANSCRIPT_CHUNK_SEC, limit);
    let text;
    try {
      text = callGeminiRaw_(TRANSCRIBE_SYSTEM, [
        { fileData: { fileUri: 'https://www.youtube.com/watch?v=' + id }, videoMetadata: { startOffset: st.next + 's', endOffset: end + 's' } },
        { text: 'Фрагмент с ' + fmtTime_(st.next) + ' по ' + fmtTime_(end) + '.' },
      ], { mediaResolution: 'MEDIA_RESOLUTION_LOW', maxOutputTokens: 32768, temperature: 0 }, model).trim();
    } catch (e) {
      // длина видео неизвестна, и кусок начинается за его концом — Gemini отвечает ошибкой: видео кончилось
      if (st.next > 0 && !st.seconds && /Gemini 400/.test(e.message)) { st.done = true; break; }
      throw e;
    }
    if (text) appendParagraphs_(st.docId, text);
    st.next = end;
    // длина неизвестна (YouTube не отдал её скрипту): видео кончилось, если речь оборвалась задолго до конца куска
    const stamps = text.match(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g) || [];
    const lastSec = stamps.length ? parseT_(stamps[stamps.length - 1]) : 0;
    st.done = end >= limit || (!st.seconds && (text.length < 30 || lastSec < end - 120));
    props.setProperty(key, JSON.stringify(st));
  }
  if (st.done) props.setProperty(key, JSON.stringify(st));
  return st;
}

function youtubeInfo_(url) {
  const info = { title: 'Видео YouTube', author: '', seconds: 0 };
  try {
    const o = UrlFetchApp.fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(url), { muteHttpExceptions: true });
    if (o.getResponseCode() === 200) {
      const m = JSON.parse(o.getContentText());
      info.title = m.title || info.title;
      info.author = m.author_name || '';
    }
  } catch (e) {}
  try {
    const html = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText();
    const m = html.match(/"lengthSeconds":"(\d+)"/);
    if (m) info.seconds = +m[1];
  } catch (e) {}
  return info;
}

/**
 * Субтитры YouTube без ключей и без Gemini: ручные русские → любые ручные → автоматические.
 * Возвращает { lang, auto, text } или null, если субтитров нет или YouTube не отдал их.
 */
const YT_CLIENTS = [
  { clientName: 'ANDROID', clientVersion: '20.10.38' },
  { clientName: 'IOS', clientVersion: '20.10.4' },
];

/** Проверка субтитров вручную: пишет в журнал, что YouTube отвечает на каждом шаге. */
function testCaptions() {
  const id = 'JtjfYS9hfWw'; // видео, у которого точно есть русские автосубтитры
  const diag = [];
  const c = youtubeCaptions_(id, diag);
  Logger.log(diag.join('\n'));
  Logger.log(c ? 'ИТОГ: субтитры получены, ' + c.text.length + ' символов. Начало: ' + c.text.slice(0, 200)
    : 'ИТОГ: субтитры не получены');
}

function youtubeCaptions_(videoId, diag) {
  diag = diag || [];
  try {
    const page = UrlFetchApp.fetch('https://www.youtube.com/watch?v=' + videoId, {
      muteHttpExceptions: true, headers: { 'Accept-Language': 'ru,en;q=0.8' },
    });
    const html = page.getContentText();
    const apiKey = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1];
    diag.push('Страница видео: код ' + page.getResponseCode() + ', ' + html.length + ' байт, ключ innertube: ' + (apiKey ? 'есть' : 'нет'));
    if (!apiKey) return null;

    let xml = '', track = null;
    for (const client of YT_CLIENTS) {
      const resp = UrlFetchApp.fetch('https://www.youtube.com/youtubei/v1/player?key=' + apiKey, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ context: { client: Object.assign({ hl: 'ru' }, client) }, videoId }),
      });
      let player = {};
      try { player = JSON.parse(resp.getContentText()); } catch (e) {}
      const ps = player.playabilityStatus || {};
      const tracks = (((player.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
      diag.push(client.clientName + ': код ' + resp.getResponseCode() + ', статус ' + (ps.status || '—') +
        (ps.reason ? ' (' + ps.reason + ')' : '') + ', дорожек ' + tracks.length);
      if (!tracks.length) continue;
      track = tracks.find(t => t.languageCode === 'ru' && t.kind !== 'asr') ||
        tracks.find(t => t.kind !== 'asr') || tracks.find(t => t.kind === 'asr') || tracks[0];
      const subs = UrlFetchApp.fetch(track.baseUrl.replace('&fmt=srv3', ''), { muteHttpExceptions: true });
      xml = subs.getContentText();
      diag.push('  файл субтитров: код ' + subs.getResponseCode() + ', ' + xml.length + ' байт');
      if (xml.length > 100) break;
    }
    if (!xml || !track) return null;

    // формат <text start="сек">…</text> или <p t="мс">…</p>
    const phrases = [];
    const re = /<(text|p)\b([^>]*)>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(xml))) {
      const start = /\bstart="([\d.]+)"/.exec(m[2]);
      const t = /\bt="(\d+)"/.exec(m[2]);
      const sec = start ? +start[1] : t ? +t[1] / 1000 : 0;
      const txt = decodeEntities_(decodeEntities_(m[3].replace(/<[^>]+>/g, ''))).replace(/\s+/g, ' ').trim();
      if (txt) phrases.push({ sec, txt });
    }
    if (!phrases.length) return null;

    // абзацы примерно по минуте, с отметкой времени
    const paras = [];
    let cur = null;
    phrases.forEach(p => {
      const long = cur && p.sec - cur.sec >= 60;
      const ends = cur && /[.!?…]$/.test(cur.parts[cur.parts.length - 1]);
      if (!cur || (long && ends) || (cur && p.sec - cur.sec >= 90)) {
        cur = { sec: p.sec, parts: [] };
        paras.push(cur);
      }
      cur.parts.push(p.txt);
    });
    const stamp = s => {
      const h = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60);
      return '[' + [h, mm, ss].map(x => String(x).padStart(2, '0')).join(':') + ']';
    };
    return {
      lang: track.languageCode,
      auto: track.kind === 'asr',
      text: paras.map(p => stamp(p.sec) + ' ' + p.parts.join(' ')).join('\n\n'),
    };
  } catch (e) {
    diag.push('Ошибка: ' + e.message);
    return null;
  }
}

function decodeEntities_(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function appendParagraphs_(docId, text) {
  const doc = DocumentApp.openById(docId);
  const body = doc.getBody();
  text.split(/\n\s*\n/).forEach(p => { if (p.trim()) body.appendParagraph(p.trim()); });
  doc.saveAndClose();
}

function fmtTime_(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

function cleanTitle_(t) {
  return String(t).replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function readItem_(file) {
  const mime = file.getMimeType();
  if (mime === DOC_MIME) return { text: exportMarkdown_(file.getId()) };
  if (mime.indexOf('text/') === 0 || /\.(md|txt)$/i.test(file.getName())) {
    return { text: file.getBlob().getDataAsString('UTF-8') };
  }
  if ((mime === 'application/pdf' || mime.indexOf('image/') === 0 || mime.indexOf('audio/') === 0) &&
      file.getSize() <= CONFIG.MAX_INLINE_BYTES) {
    return { inline: { mimeType: mime, data: Utilities.base64Encode(file.getBlob().getBytes()) } };
  }
  return null;
}

function planSystem_(ctx) {
  return [
    'Ты ведёшь личную базу знаний владельца в Google Drive. Правила базы, которые написал владелец:',
    '<правила>', ctx.rules, '</правила>',
    '',
    'Тебе дают каталог базы и один материал из «Входящих». Реши, что с ним сделать, и ответь ТОЛЬКО JSON:',
    '{',
    '  "kind": "thought" | "source" | "noise",',
    '  "sourceFolder": "Заметки" | "Клиппинги" | "Статьи" | "Файлы",  // куда положить оригинал',
    '  "summary": "одна строка для отчёта: что это за материал",',
    '  "thought": null | { "title": "понятное название", "markdown": "мысль владельца, приведённая в порядок" },',
    '  "newPages": [ { "topic": "раздел в Знаниях", "title": "название", "markdown": "текст страницы" } ],',
    '  "updates": [ { "title": "ТОЧНОЕ имя существующей страницы из каталога", "instruction": "что изменить", "material": "что встроить" } ],',
    '  "newTopics": [ { "name": "новый раздел в Знаниях", "description": "о чём он" } ],',
    '  "attention": "что требует внимания владельца, или пустая строка"',
    '}',
    'Правила ответа:',
    '- thought заполняй, только если в материале есть собственная мысль, идея или комментарий владельца.',
    '- Предпочитай обновлять существующие страницы (updates), новые создавай только для самостоятельных тем.',
    '- Шум (kind "noise") — только перенос оригинала, без newPages и updates.',
    '- Ссылки на страницы базы пиши так: [Текст](' + CONFIG.LINK_PREFIX + 'Точное имя страницы). Имена — из каталога.',
    '- markdown — обычный Markdown без YAML-шапки. Всё на русском, кроме терминов и названий.',
    '- Если приложен транскрипт видео — извлекай знания из него; сам транскрипт в newPages не копируй. Комментарий владельца всё равно важнее.',
    '- Если есть карточка видео — не пересказывай видео целиком: в знания переноси только полезное, со ссылкой на карточку и таймкодами [мм:сс].',
    '- Не выдумывай содержание, которого нет в материале. Если по ссылке ничего не известно — напиши это в attention.',
  ].join('\n');
}

function updateSystem_(ctx) {
  return [
    'Ты редактор личной базы знаний. Правила базы:',
    '<правила>', ctx.rules, '</правила>',
    '',
    'Встрой новый материал в существующую страницу. Сохрани всё ценное содержание и все существующие ссылки,',
    'не дублируй мысли, сохрани структуру страницы. Новые ссылки на страницы базы: [Текст](' + CONFIG.LINK_PREFIX + 'Точное имя страницы).',
    'Ответь ТОЛЬКО JSON: { "markdown": "полный обновлённый текст страницы" }',
  ].join('\n');
}

function catalog_(map) {
  return Object.keys(map)
    .filter(t => map[t].path.indexOf(CONFIG.KNOWLEDGE) === 0 || map[t].path.indexOf(CONFIG.THOUGHTS) === 0)
    .sort()
    .map(t => '- ' + t + ' (' + map[t].path + ')')
    .join('\n');
}

function ensureTopic_(ctx, name, description) {
  const knowledge = sub_(ctx.root, CONFIG.KNOWLEDGE);
  const exists = knowledge.getFoldersByName(name).hasNext();
  const folder = sub_(knowledge, name);
  if (!exists || !ctx.map[name]) {
    const md = '# ' + name + '\n\n' + (description ? description + '\n\n' : '') + '## Страницы\n';
    const id = importMarkdown_(name, md, folder);
    ctx.map[name] = { id, path: CONFIG.KNOWLEDGE + '/' + name };
    addTopicToMain_(ctx, name, id);
  }
  return { name, folder, indexId: ctx.map[name].id };
}

function addTopicToMain_(ctx, name, id) {
  const main = ctx.map[CONFIG.MAIN_DOC];
  if (!main) return;
  const doc = DocumentApp.openById(main.id);
  const body = doc.getBody();
  let insertAt = -1;
  for (let i = 0, inSection = false; i < body.getNumChildren(); i++) {
    const el = body.getChild(i);
    const text = el.getType() === DocumentApp.ElementType.PARAGRAPH ? el.asParagraph().getText() : '';
    if (text.indexOf('Знания по темам') >= 0) { inSection = true; continue; }
    if (inSection && el.getType() === DocumentApp.ElementType.LIST_ITEM) insertAt = i;
    else if (inSection && insertAt >= 0) break;
  }
  const li = insertAt >= 0 ? body.insertListItem(insertAt + 1, name) : body.appendListItem(name);
  li.setLinkUrl(docUrl_(id));
  doc.saveAndClose();
}

function appendIndexLink_(indexId, title, id) {
  const doc = DocumentApp.openById(indexId);
  const body = doc.getBody();
  body.appendListItem(title).setLinkUrl(docUrl_(id));
  // «Пока пусто» убирается после добавления пункта: последний абзац документа удалить нельзя
  for (let i = body.getNumChildren() - 2; i >= 0; i--) {
    const el = body.getChild(i);
    if (el.getType() === DocumentApp.ElementType.PARAGRAPH && /Пока пусто/.test(el.asParagraph().getText())) {
      body.removeChild(el);
    }
  }
  doc.saveAndClose();
}

function writeReport_(root, r) {
  const date = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const list = arr => (arr.length ? arr.map(x => '- ' + x).join('\n') : '- нет');
  const md = r.found === 0
    ? '# Ревизия ' + date + '\n\nНовых материалов нет.'
    : [
      '# Ревизия ' + date, '',
      '**Во «Входящих» найдено:** ' + r.found, '',
      '## Разобрано', list(r.done), '',
      '## Видео: карточки (раздел «' + VIDEO.FOLDER + '»)', list(r.transcripts), '',
      '## Сохранены мысли', list(r.thoughts), '',
      '## Созданы страницы', list(r.created), '',
      '## Обновлены страницы', list(r.updated), '',
      '## Осталось во «Входящих»', list(r.left), '',
      '## Ошибки', list(r.errors), '',
      '## Требует внимания', list(r.attention),
    ].join('\n');
  const reports = sub_(sub_(root, CONFIG.SERVICE), CONFIG.REPORTS);
  const id = importMarkdown_(date + ' ревизия', md, reports);

  const journal = sub_(root, CONFIG.SERVICE).getFilesByName(CONFIG.JOURNAL_DOC);
  if (journal.hasNext()) {
    const doc = DocumentApp.openById(journal.next().getId());
    const line = date + ' — найдено ' + r.found + ', разобрано ' + r.done.length +
      ', мыслей ' + r.thoughts.length + ', новых страниц ' + r.created.length +
      ', обновлено ' + r.updated.length + (r.errors.length ? ', ошибок ' + r.errors.length : '');
    doc.getBody().appendListItem(line).setLinkUrl(docUrl_(id));
    doc.saveAndClose();
  }
}

function readRules_(root) {
  const f = root.getFilesByName(CONFIG.RULES_DOC);
  if (!f.hasNext()) throw new Error('Не найден документ «' + CONFIG.RULES_DOC + '» в корне базы');
  return exportMarkdown_(f.next().getId());
}

// ───────────────────────────── Gemini ─────────────────────────────

/** Запрос к Gemini с ответом в JSON. */
function callGemini_(system, parts, extraConfig) {
  const out = callGeminiRaw_(system, parts, Object.assign({ responseMimeType: 'application/json' }, extraConfig || {}));
  return JSON.parse(out.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, ''));
}

/** Запрос к Gemini, возвращает текст ответа. */
function callGeminiRaw_(system, parts, generationConfig, model) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Не задан GEMINI_API_KEY в свойствах скрипта');
  model = model || props.getProperty('GEMINI_MODEL') || CONFIG.MODEL;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts }],
    generationConfig: Object.assign({ temperature: 0.3 }, generationConfig || {}),
  };
  for (let attempt = 1; ; attempt++) {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    if (code === 200) {
      const data = JSON.parse(resp.getContentText());
      const text = ((data.candidates || [])[0] || {}).content;
      return ((text && text.parts) || []).filter(p => !p.thought).map(p => p.text || '').join('');
    }
    if ((code === 429 || code >= 500) && attempt < 4) { Utilities.sleep(15000 * attempt); continue; }
    throw new Error('Gemini ' + code + ': ' + resp.getContentText().slice(0, 300));
  }
}

// ───────────────────────────── Drive и Документы ─────────────────────────────

function root_() { return DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID); }

function sub_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function walkFiles_(folder, skipIds, fn) {
  if (skipIds.indexOf(folder.getId()) >= 0) return;
  const files = folder.getFiles();
  while (files.hasNext()) fn(files.next(), folder);
  const subs = folder.getFolders();
  while (subs.hasNext()) walkFiles_(subs.next(), skipIds, fn);
}

/** Все Google Документы базы: имя → { id, path }. */
function titleMap_(root) {
  const archive = sub_(sub_(root, CONFIG.SERVICE), CONFIG.ARCHIVE_MD);
  const reports = sub_(sub_(root, CONFIG.SERVICE), CONFIG.REPORTS);
  const map = {};
  const walk = (folder, path) => {
    if (folder.getId() === archive.getId() || folder.getId() === reports.getId()) return;
    const files = folder.getFilesByType(DOC_MIME);
    while (files.hasNext()) {
      const f = files.next();
      map[f.getName()] = { id: f.getId(), path };
    }
    const subs = folder.getFolders();
    while (subs.hasNext()) {
      const s = subs.next();
      walk(s, path ? path + '/' + s.getName() : s.getName());
    }
  };
  walk(root, '');
  return map;
}

function uniqueTitle_(title, map) {
  title = String(title).replace(/[\\/]/g, '-').trim();
  if (!map[title]) return title;
  for (let n = 2; ; n++) if (!map[title + ' (' + n + ')']) return title + ' (' + n + ')';
}

function resolveLinks_(md, map) {
  const re = new RegExp('\\[([^\\]]*)\\]\\(' + CONFIG.LINK_PREFIX.replace(/[.\/]/g, '\\$&') + '([^)]*)\\)', 'g');
  return md.replace(re, (m, label, enc) => {
    let title;
    try { title = decodeURIComponent(enc); } catch (e) { title = enc; }
    const hit = map[title.replace(/#.*$/, '').trim()];
    return hit ? '[' + label + '](' + docUrl_(hit.id) + ')' : label;
  });
}

function importMarkdown_(name, md, folder) {
  const blob = Utilities.newBlob(md, 'text/markdown', name + '.md');
  return Drive.Files.create({ name, mimeType: DOC_MIME, parents: [folder.getId()] }, blob).id;
}

function replaceDocMarkdown_(id, md) {
  Drive.Files.update({}, id, Utilities.newBlob(md, 'text/markdown', 'page.md'));
}

function exportMarkdown_(id) {
  const resp = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=' + encodeURIComponent('text/markdown'),
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Экспорт документа ' + id + ': ' + resp.getResponseCode());
  return resp.getContentText('UTF-8');
}

function docUrl_(id) { return 'https://docs.google.com/document/d/' + id + '/edit'; }

function asContainer_(el) {
  const T = DocumentApp.ElementType;
  switch (el.getType()) {
    case T.BODY_SECTION: return el.asBody();
    case T.PARAGRAPH: return el.asParagraph();
    case T.LIST_ITEM: return el.asListItem();
    case T.TABLE: return el.asTable();
    case T.TABLE_ROW: return el.asTableRow();
    case T.TABLE_CELL: return el.asTableCell();
    default: return null;
  }
}

/** Заменяет временные ссылки https://kb.local/<имя> в документе на адреса документов. */
function fixDocLinks_(docId, map) {
  const doc = DocumentApp.openById(docId);
  let changed = 0;
  const walk = el => {
    if (el.getType() === DocumentApp.ElementType.TEXT) {
      const text = el.asText();
      const len = text.getText().length;
      const idx = text.getTextAttributeIndices();
      for (let i = 0; i < idx.length; i++) {
        const url = text.getLinkUrl(idx[i]);
        if (!url || url.indexOf(CONFIG.LINK_PREFIX) !== 0) continue;
        let title;
        try { title = decodeURIComponent(url.slice(CONFIG.LINK_PREFIX.length)); } catch (e) { title = ''; }
        const hit = map[title.replace(/#.*$/, '')];
        const end = (i + 1 < idx.length ? idx[i + 1] : len) - 1;
        text.setLinkUrl(idx[i], end, hit ? docUrl_(hit.id) : null);
        changed++;
      }
      return;
    }
    const container = asContainer_(el);
    if (!container) return;
    for (let i = 0; i < container.getNumChildren(); i++) walk(container.getChild(i));
  };
  walk(doc.getBody());
  if (changed) doc.saveAndClose();
  return changed;
}
