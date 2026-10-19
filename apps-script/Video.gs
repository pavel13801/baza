/**
 * Карточки видео: по одной карточке (Google Документ) на каждое видео в разделе «Видео».
 *
 * Карточка делается сразу после добавления ссылки — в фоне, через очередь processVideoQueue:
 *   1. Транскрипт: субтитры YouTube, а если их нет — Gemini сам слушает видео (transcribeYouTube_ из Code.gs).
 *   2. Конспект по транскрипту: коротко, стоит ли смотреть, главы, ключевые идеи с таймкодами, что применить,
 *      цитаты, вопросы для самопроверки.
 * Утренняя ревизия потом берёт готовую карточку и разносит полезное по «Знаниям» со ссылками на неё.
 * Развлекательные видео остаются только карточкой.
 *
 * Служебные данные карточки (статус, тип, темы, канал, этап обработки) лежат в свойствах файла на Диске —
 * приложение читает их одним запросом, не открывая документы.
 *
 * Запуск вручную: migrateVideos() — один раз сделать карточки для видео, сохранённых раньше.
 */

const VIDEO = {
  FOLDER: 'Видео',
  ARCHIVE: 'Архив',                  // Служебное/Архив — пустые и повторные транскрипты
  MAX_TRIES: 3,
  TRANSCRIPT_MAX_CHARS: 600000,
  SUMMARY_RESERVE_MS: 100 * 1000,    // столько времени нужно оставить на конспект в одном запуске
};

const VIDEO_TYPES = { learn: 'Обучение', inspire: 'Вдохновение', fun: 'Развлечение' };
const VIDEO_STATUSES = ['new', 'watched', 'applied'];
const CARD_FIELDS = 'id,name,createdTime,modifiedTime,properties';

// ───────────────────────────── Запуск вручную ─────────────────────────────

/** Один раз: карточки для видео, которые уже лежат в «Источники/Клиппинги». Повторный запуск ничего не дублирует. */
function migrateVideos() {
  const root = root_();
  const clips = sub_(sub_(root, CONFIG.SOURCES), APP.CLIPPINGS);
  const archive = sub_(sub_(root, CONFIG.SERVICE), VIDEO.ARCHIVE);
  const groups = {};
  walkDocs_(clips, f => {
    const text = DocumentApp.openById(f.getId()).getBody().getText();
    const desc = f.getDescription();
    const url = (desc && desc !== '-' ? desc : '') || (text.match(YT_RE) || [''])[0];
    const vid = ytId_(url);
    if (!vid) return;
    (groups[vid] = groups[vid] || []).push({
      file: f, text, real: isRealTranscript_(text), transcript: /^Транскрипт\s+—/.test(f.getName()),
    });
  });

  const log = [];
  Object.keys(groups).forEach(vid => {
    const docs = groups[vid];
    const real = docs.filter(d => d.real).sort((a, b) => b.text.length - a.text.length);
    const best = real[0] || null;
    // пустые транскрипты («субтитров нет») и лишние копии — в архив, не удаляются
    docs.filter(d => d.transcript && d !== best).forEach(d => {
      d.file.moveTo(archive);
      log.push('В «' + CONFIG.SERVICE + '/' + VIDEO.ARCHIVE + '»: ' + d.file.getName());
    });
    if (findCard_(vid)) { log.push('Карточка уже есть: ' + vid); return; }
    // прогресс старой расшифровки мог ссылаться на пустой транскрипт — начинаем заново
    if (!best) PropertiesService.getScriptProperties().deleteProperty('TR_' + vid);
    const withComment = docs.find(d => /Мой комментарий/.test(d.text));
    const comment = withComment ? commentFromText_(withComment.text) : '';
    const card = ensureVideo_(watchUrl_(vid), { comment, transcriptId: best ? best.file.getId() : null });
    log.push('Карточка: ' + card.title + (best ? ' — транскрипт уже есть' : ' — транскрипт сделает Gemini'));
  });
  scheduleVideoQueue_(5000);
  Logger.log(log.length ? log.join('\n') : 'Видео в «Клиппингах» не найдено');
  Logger.log('Карточки дособираются в фоне за несколько минут (функция processVideoQueue).');
  return log;
}

// ───────────────────────────── Карточки ─────────────────────────────

function videoFolder_() { return sub_(root_(), VIDEO.FOLDER); }

function watchUrl_(id) { return 'https://www.youtube.com/watch?v=' + id; }

/**
 * Находит карточку видео или создаёт заготовку и ставит её в очередь.
 * opts: comment — мой комментарий; transcriptId — готовый транскрипт; info — уже полученные название и канал.
 */
function ensureVideo_(url, opts) {
  opts = opts || {};
  const id = ytId_(url);
  if (!id) throw new Error('Это не ссылка на YouTube: ' + url);
  const found = findCard_(id);
  if (found) {
    if (opts.comment) appendCardComment_(found.id, opts.comment);
    return found;
  }
  const info = opts.info || youtubeInfo_(watchUrl_(id));
  const md = '# ' + info.title +
    '\n\n- **Ссылка:** ' + watchUrl_(id) + (info.author ? '\n- **Канал:** ' + info.author : '') +
    '\n\n_Карточка готовится: транскрипт и конспект появятся через пару минут._' +
    '\n\n## Мой комментарий\n\n' + (opts.comment || 'Пока нет.');
  const docId = importMarkdown_(cleanTitle_(info.title), md, videoFolder_());
  setCardProps_(docId, {
    videoId: id,
    url: watchUrl_(id),
    status: 'new',
    state: opts.transcriptId ? 'summarizing' : 'queued',
    stage: opts.transcriptId ? 'конспект' : 'в очереди',
    transcriptId: opts.transcriptId || null,
    channel: info.author || '',
    seconds: info.seconds ? String(info.seconds) : '',
    added: new Date().toISOString(),
  });
  return findCardById_(docId);
}

function findCard_(videoId) {
  const r = Drive.Files.list({
    q: "'" + videoFolder_().getId() + "' in parents and trashed = false and " +
      "properties has { key='videoId' and value='" + String(videoId).replace(/[^\w-]/g, '') + "' }",
    fields: 'files(' + CARD_FIELDS + ')',
    pageSize: 5,
  });
  const f = (r.files || [])[0];
  return f ? cardInfo_(f) : null;
}

function findCardById_(id) {
  return cardInfo_(Drive.Files.get(id, { fields: CARD_FIELDS }));
}

/** Все карточки раздела «Видео» одним запросом к Диску (без открытия документов). */
function listCards_() {
  const out = [];
  let pageToken;
  do {
    const r = Drive.Files.list({
      q: "'" + videoFolder_().getId() + "' in parents and trashed = false and mimeType = '" + DOC_MIME + "'",
      fields: 'nextPageToken, files(' + CARD_FIELDS + ')',
      pageSize: 200,
      pageToken,
    });
    (r.files || []).forEach(f => out.push(cardInfo_(f)));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out.sort((a, b) => (a.created < b.created ? 1 : -1));
}

function cardInfo_(f) {
  const p = f.properties || {};
  return {
    id: f.id,
    title: f.name,
    created: p.added || f.createdTime,
    modified: f.modifiedTime,
    videoId: p.videoId || '',
    url: p.url || '',
    channel: p.channel || '',
    seconds: +p.seconds || 0,
    status: VIDEO_STATUSES.indexOf(p.status) >= 0 ? p.status : 'new',
    type: VIDEO_TYPES[p.type] ? p.type : '',
    topics: p.topics ? p.topics.split('; ') : [],
    state: p.state || 'done',
    stage: p.stage || '',
    error: p.err || '',
    tries: +p.tries || 0,
    transcriptId: p.transcriptId || '',
    method: p.method || '',
    done: p.done ? p.done.split(',').map(Number) : [],
  };
}

/** Свойства файла на Диске: значение null удаляет свойство. Лимит Диска — 124 байта на ключ со значением. */
function setCardProps_(id, props) {
  const out = {};
  Object.keys(props).forEach(k => { out[k] = props[k] == null ? null : fitProp_(k, String(props[k])); });
  Drive.Files.update({ properties: out }, id);
}

function fitProp_(key, val) {
  const size = s => Utilities.newBlob(key + s).getBytes().length;
  if (size(val) <= 124) return val;
  while (val && size(val + '…') > 124) val = val.slice(0, -1);
  return val + '…';
}

/** Новый комментарий к уже сохранённому видео дописывается в конец карточки (если его там ещё нет). */
function appendCardComment_(id, comment) {
  const doc = DocumentApp.openById(id);
  const body = doc.getBody();
  const text = body.getText();
  if (text.indexOf(comment.slice(0, 60)) >= 0) return;
  body.appendParagraph(comment);
  for (let i = body.getNumChildren() - 2; i >= 0; i--) {
    const el = body.getChild(i);
    if (el.getType() === DocumentApp.ElementType.PARAGRAPH && el.asParagraph().getText().trim() === 'Пока нет.') body.removeChild(el);
  }
  doc.saveAndClose();
}

// ───────────────────────────── Очередь ─────────────────────────────

function scheduleVideoQueue_(delayMs) {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processVideoQueue')) return;
  ScriptApp.newTrigger('processVideoQueue').timeBased().after(delayMs || 5000).create();
}

/** Фоновая обработка карточек. Сама переназначает себя, пока есть незаконченные. */
function processVideoQueue() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processVideoQueue')
    .forEach(t => ScriptApp.deleteTrigger(t));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { scheduleVideoQueue_(2 * 60 * 1000); return; } // идёт ревизия — позже
  const started = Date.now();
  let left = false;
  try {
    const pending = listCards_()
      .filter(c => c.state !== 'done' && c.state !== 'error')
      .sort((a, b) => (a.created < b.created ? -1 : 1));
    for (const card of pending) {
      if (Date.now() - started > CONFIG.TIME_BUDGET_MS - 60 * 1000) { left = true; break; }
      if (!processVideo_(card, started)) left = true;
    }
  } finally {
    lock.releaseLock();
  }
  if (left) scheduleVideoQueue_(60 * 1000);
}

/** Один шаг обработки карточки. true — карточка готова, false — продолжим в следующий запуск. */
function processVideo_(card, started) {
  try {
    if (card.state === 'queued' || card.state === 'transcribing' || !card.transcriptId) {
      setCardProps_(card.id, { state: 'transcribing', stage: 'транскрипт' });
      const tr = transcribeYouTube_(watchUrl_(card.videoId), started);
      setCardProps_(card.id, {
        transcriptId: tr.docId,
        method: tr.method,
        seconds: String(tr.seconds || card.seconds || ''),
        stage: tr.done ? 'конспект' : 'транскрипт: ' + fmtTime_(tr.next) + (tr.seconds ? ' из ' + fmtTime_(tr.seconds) : ''),
      });
      if (!tr.done) return false;
      PropertiesService.getScriptProperties().deleteProperty(tr.key);
      Object.assign(card, { transcriptId: tr.docId, method: tr.method, seconds: tr.seconds || card.seconds });
      setCardProps_(card.id, { state: 'summarizing' });
    }
    if (Date.now() - started > CONFIG.TIME_BUDGET_MS - VIDEO.SUMMARY_RESERVE_MS) return false;
    buildCard_(card);
    setCardProps_(card.id, { state: 'done', stage: null, err: null, tries: null });
    return true;
  } catch (e) {
    const tries = card.tries + 1;
    card.tries = tries;
    setCardProps_(card.id, {
      tries: String(tries),
      err: e.message.slice(0, 50),
      state: tries >= VIDEO.MAX_TRIES ? 'error' : card.state === 'queued' ? 'transcribing' : card.state,
    });
    console.error('Карточка ' + card.title + ': ' + (e.stack || e.message));
    return false;
  }
}

// ───────────────────────────── Конспект ─────────────────────────────

function cardSystem_(rules, topics) {
  return [
    'Ты делаешь карточку видео для личной базы знаний владельца. Цель — чтобы из видео можно было взять',
    'максимум пользы, не пересматривая его, и быстро найти нужный момент.',
    '',
    'Правила базы, которые написал владелец:',
    '<правила>', rules, '</правила>',
    '',
    'Темы, которые уже есть в базе: ' + (topics.length ? topics.join(', ') : 'пока нет') + '.',
    '',
    'Тебе дают данные видео, комментарий владельца (он важнее всего) и транскрипт с отметками времени.',
    'Ответь ТОЛЬКО JSON:',
    '{',
    '  "type": "learn" | "inspire" | "fun",',
    '  "tldr": "2–3 предложения: о чём видео и главный вывод",',
    '  "worth": "1–2 предложения: хватит ли конспекта или стоит посмотреть, и какие моменты обязательно",',
    '  "chapters": [ { "t": "мм:сс", "title": "раздел видео" } ],',
    '  "ideas": [ { "t": "мм:сс", "text": "ключевая идея" } ],',
    '  "actions": [ "конкретное действие" ],',
    '  "quotes": [ { "t": "мм:сс", "text": "дословная короткая цитата" } ],',
    '  "questions": [ { "q": "вопрос для самопроверки", "a": "короткий ответ" } ],',
    '  "topics": [ "тема" ]',
    '}',
    'Правила:',
    '- type: learn — практические знания и навыки; inspire — идеи, истории и мотивация с выводами; fun — развлечение без практической пользы.',
    '- chapters — только для видео длиннее 10 минут, 3–10 разделов. Иначе пустой список.',
    '- ideas — 5–12 штук по порядку видео: конкретно, с цифрами, примерами, названиями инструментов из видео. Без воды.',
    '- actions — 0–7 действий, которые владелец может сделать сам; с учётом его комментария. Для fun — пусто.',
    '- quotes — 0–4 самых сильных фразы, дословно. questions — 3–5 для learn и inspire, пусто для fun.',
    '- topics — 1–3 темы; бери из списка тем базы, новую придумывай, только если ни одна не подходит.',
    '- Отметки времени t бери из транскрипта и не выдумывай. Если транскрипта нет — оставляй t пустыми.',
    '- Всё по-русски, кроме названий и терминов. Не добавляй того, чего нет в видео.',
  ].join('\n');
}

function buildCard_(card) {
  const root = root_();
  const tdoc = card.transcriptId ? DocumentApp.openById(card.transcriptId) : null;
  const transcript = tdoc ? tdoc.getBody().getText() : '';
  const hasText = isRealTranscript_(transcript);
  const comment = commentFromText_(DocumentApp.openById(card.id).getBody().getText());
  const meta = [
    'Видео: «' + card.title + '»',
    card.channel ? 'Канал: ' + card.channel : '',
    card.seconds ? 'Длительность: ' + fmtTime_(card.seconds) : '',
    'Ссылка: ' + card.url,
  ].filter(Boolean).join('\n');

  const j = callGemini_(cardSystem_(readRules_(root), topicNames_(root)), [
    { text: meta },
    { text: comment ? 'Комментарий владельца:\n' + comment : 'Комментария владельца нет.' },
    {
      text: hasText
        ? 'Транскрипт:\n\n' + transcript.slice(0, VIDEO.TRANSCRIPT_MAX_CHARS)
        : 'Транскрипта нет: субтитров у видео нет и распознать речь не удалось. Работай только по названию и комментарию, содержание не выдумывай.',
    },
  ], { temperature: 0.2, maxOutputTokens: 16384 });

  const type = VIDEO_TYPES[j.type] ? j.type : 'learn';
  replaceDocMarkdown_(card.id, cardMarkdown_(card, j, type, { comment, hasText, transcriptTitle: tdoc ? tdoc.getName() : '' }));
  setCardProps_(card.id, { type, topics: (j.topics || []).slice(0, 3).join('; '), done: null });
}

function cardMarkdown_(card, j, type, o) {
  const ts = t => {
    const s = parseT_(t);
    return s == null ? '' : '[' + fmtTime_(s) + '](' + card.url + '&t=' + s + 's) ';
  };
  const list = arr => (Array.isArray(arr) ? arr.filter(Boolean) : []);
  const meta = [];
  if (card.channel) meta.push('**Канал:** ' + card.channel);
  if (card.seconds) meta.push('**Длительность:** ' + fmtTime_(card.seconds));
  meta.push('**Тип:** ' + VIDEO_TYPES[type]);
  const L = ['# ' + card.title, '', '- ' + meta.join(' · '), '- **Ссылка:** ' + card.url];
  if (list(j.topics).length) L.push('- **Темы:** ' + list(j.topics).join(', '));
  if (card.transcriptId) {
    L.push('- **Транскрипт:** [' + (o.transcriptTitle || 'Транскрипт') + '](' + docUrl_(card.transcriptId) + ')' +
      (o.hasText ? (card.method ? ' — ' + card.method : '') : ' — пустой: субтитров нет, речь не распознана'));
  }
  L.push('');
  if (j.tldr) L.push('## Коротко', '', j.tldr, '');
  if (j.worth) L.push('## Стоит ли смотреть', '', j.worth, '');
  if (list(j.chapters).length) L.push('## Главы', '', ...list(j.chapters).map(c => '- ' + ts(c.t) + c.title), '');
  if (list(j.ideas).length) L.push('## Ключевые идеи', '', ...list(j.ideas).map(x => '- ' + ts(x.t) + x.text), '');
  if (list(j.actions).length) L.push('## Что применить', '', ...list(j.actions).map(a => '- [ ] ' + a), '');
  if (list(j.quotes).length) {
    L.push('## Цитаты', '');
    list(j.quotes).forEach(q => L.push('> ' + ts(q.t) + '«' + q.text + '»', ''));
  }
  if (list(j.questions).length) {
    L.push('## Вопросы для самопроверки', '', ...list(j.questions).map((q, i) => (i + 1) + '. **' + q.q + '** ' + (q.a || '')), '');
  }
  L.push('## Мой комментарий', '', o.comment || 'Пока нет.');
  return L.join('\n');
}

// ───────────────────────────── Вспомогательное ─────────────────────────────

function topicNames_(root) {
  const out = [];
  const it = sub_(root, CONFIG.KNOWLEDGE).getFolders();
  while (it.hasNext()) out.push(it.next().getName());
  return out.sort();
}

/** «12:34», «1:02:03», «00:12:34» или число секунд → секунды. */
function parseT_(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'number') return Math.max(0, Math.round(t));
  const parts = String(t).trim().replace(/^\[|\]$/g, '').split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(isNaN)) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

/** Настоящий транскрипт, а не заготовка «субтитров нет»: есть текст и отметки времени. */
function isRealTranscript_(text) {
  const stamps = (String(text).match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || []).length;
  return stamps >= 3 && text.length > 600 && !/Субтитров нет\.?\s*$/.test(text.trim());
}

/** Мой комментарий из текста документа: всё после заголовка «Мой комментарий». */
function commentFromText_(text) {
  const m = String(text).match(/Мой комментарий\s*\n([\s\S]*)$/);
  if (!m) return '';
  const c = m[1].replace(/_?Без комментария\._?/g, '').replace(/^\s*Пока нет\.\s*$/gm, '').trim();
  return c.slice(0, 4000);
}
