// Демо-режим: те же ответы, что даёт Apps Script, но на выдуманных данных. Ничего никуда не отправляется.
(function () {
  const day = n => new Date(Date.now() - n * 86400000).toISOString();
  let seq = 100;
  const page = (title, n, path) => ({ id: 'demo-' + (seq++), title, modified: day(n), created: day(n + 3), path: path || '' });
  const video = (id, videoId, title, channel, seconds, type, topics, status, n) => ({
    id, title, created: day(n), modified: day(n), videoId, url: 'https://www.youtube.com/watch?v=' + videoId, channel, seconds,
    status, type, topics, state: 'done', stage: '', error: '', transcriptId: 'demo-t-' + id, method: 'субтитры YouTube', done: status === 'applied' ? [0, 1, 2] : [],
  });

  // Карточка видео — в том виде, в каком её отдаёт экспорт Google Документа
  const cardSample = v => {
    const t = (s, label) => '[' + label + '](' + v.url + '&t=' + s + 's)';
    return [
      '# ' + v.title,
      '',
      '- **Канал:** ' + v.channel + ' · **Длительность:** 18:44 · **Тип:** Обучение',
      '- **Ссылка:** ' + v.url,
      '- **Темы:** ' + (v.topics.join(', ') || '—'),
      '- **Транскрипт:** [Транскрипт — ' + v.title + '](https://docs.google.com/document/d/' + v.transcriptId + '/edit) — субтитры YouTube',
      '',
      '## Коротко',
      '',
      'Автор показывает, как собрать личную базу знаний, в которую всё попадает само: заметки, видео, голосовые. Главная мысль — не запоминать, а один раз настроить поток «вход → разбор → темы».',
      '',
      '## Стоит ли смотреть',
      '',
      'Конспекта хватит. Посмотреть стоит только демонстрацию разбора входящих — ' + t(412, '6:52') + ', там видно, как ИИ раскладывает материал.',
      '',
      '## Главы',
      '',
      '- ' + t(0, '0:00') + ' Зачем база знаний',
      '- ' + t(185, '3:05') + ' Структура папок',
      '- ' + t(412, '6:52') + ' Разбор входящих',
      '- ' + t(780, '13:00') + ' Повторение и ревью',
      '',
      '## Ключевые идеи',
      '',
      '- ' + t(95, '1:35') + ' Всё новое — в одну папку «Входящие», раскладывать руками не нужно.',
      '- ' + t(240, '4:00') + ' Сырьё и переработанное знание хранятся отдельно, иначе база превращается в свалку.',
      '- ' + t(530, '8:50') + ' Из каждого видео берётся максимум 5–7 идей и 1–3 действия — остальное шум.',
      '- ' + t(820, '13:40') + ' Раз в неделю 15 минут на повторение: вопросы по сохранённому.',
      '',
      '## Что применить',
      '',
      '  - Завести папку «Входящие» и класть туда всё без сортировки',
      '  - Настроить ежедневный разбор входящих',
      '  - Раз в неделю отвечать на вопросы из карточек',
      '',
      '## Цитаты',
      '',
      '> ' + t(301, '5:01') + '«База знаний полезна ровно настолько, насколько часто вы в неё возвращаетесь»',
      '',
      '## Вопросы для самопроверки',
      '',
      '1. **Почему сырьё хранят отдельно от знаний?** Чтобы переработанные страницы оставались чистыми и короткими.',
      '2. **Сколько идей брать из одного видео?** 5–7 идей и 1–3 действия.',
      '',
      '## Мой комментарий',
      '',
      'Попробовать такую же схему для рабочих материалов.',
    ].join('\n');
  };

  const tree = {
    topics: [
      { name: 'Инструменты', indexId: 'demo-1', pages: [
        page('Claude Code', 1), page('Obsidian', 4), page('Web Clipper', 6), page('Whisper Flow', 9), page('Notion', 15),
      ] },
      { name: 'Процессы', indexId: 'demo-2', pages: [
        page('Вайбкодинг: рабочий процесс', 2), page('База знаний на Google Диске', 5),
      ] },
      { name: 'Кейсы', indexId: 'demo-3', pages: [
        page('Лендинг за 48 минут', 3), page('Идеи из YouTube-комментариев', 8), page('Ежедневный брифинг в Notion', 12),
      ] },
      { name: 'Промпты', indexId: 'demo-4', pages: [page('Как писать промпты для кодинга', 7)] },
      { name: 'Ошибки и анти-паттерны', indexId: 'demo-5', pages: [page('Анти-паттерны вайбкодинга', 10)] },
    ],
    general: [page('Глоссарий', 5)],
    thoughts: [
      page('Приложение для заметок поверх Google Диска', 0),
      page('Монетизация AI-инструментов для малого бизнеса', 3),
      page('Что автоматизировать в первую очередь', 11),
    ],
    thoughtsIndex: 'demo-6',
    videos: [
      video('demo-v1', 'JtjfYS9hfWw', 'Хватит запоминать. Я построил ИИ-систему, которая помнит всё', 'Ник Тулинов', 1124, 'learn', ['Процессы', 'Инструменты'], 'new', 1),
      video('demo-v2', 'Y5hIPVniO7s', 'Большой гайд по Claude 2026: всё, что я понял за год', 'AI Блог', 3870, 'learn', ['Инструменты'], 'watched', 3),
      video('demo-v3', 'g2-8jEPN-QA', 'Claude Cowork + Notion: связка на 10 часов рутины в неделю', 'Автоматизация', 1462, 'inspire', ['Кейсы'], 'applied', 5),
      video('demo-v4', 'jJOj-pb4MqE', 'Ультиматум ярости — Лена Кука', 'Lena Kuka crew', 486, 'fun', [], 'watched', 7),
    ],
    clips: [{ id: 'demo-c1', title: 'Статья: как устроен RAG', modified: day(9), created: day(9), path: '', url: 'https://example.com/rag' }],
    notes: [page('Голосовая — идея про приложение', 0), page('Заметка — что купить для студии', 2)],
    notesTotal: 2,
    inbox: [
      { id: 'demo-i1', title: 'Заметка — идея для поста', modified: day(0), created: day(0), path: '', mime: 'application/vnd.google-apps.document', url: '' },
    ],
    mainId: 'demo-main',
    rulesId: 'demo-rules',
    lastReport: { id: 'demo-r1', title: '2026-10-17 ревизия', modified: day(0), created: day(0), path: '' },
    updated: new Date().toISOString(),
  };

  const SAMPLE = [
    '# Claude Code',
    '',
    '## Что это',
    '',
    'CLI-агент от Anthropic, который работает прямо в папке проекта: читает и правит файлы, запускает команды, ведёт git.',
    '',
    '## Ключевые идеи',
    '',
    '- Сначала **план**, потом код: попросить описать шаги и только после этого делать.',
    '- Держать правила проекта в `CLAUDE.md` — агент читает его при каждом запуске.',
    '  - коротко, по пунктам;',
    '  - без воды и общих слов.',
    '- Маленькие задачи вместо одной большой.',
    '',
    '## Как применять',
    '',
    '1. Открыть проект, описать задачу своими словами.',
    '2. Проверить план, поправить.',
    '3. Принять изменения и проверить руками.',
    '',
    '| Режим | Когда |',
    '| :-- | :-- |',
    '| План | большая задача |',
    '| Авто | рутина |',
    '',
    '> Мой вывод: экономия времени — в постановке задачи, а не в скорости печати кода.',
    '',
    '## Связанные страницы',
    '',
    '- [Вайбкодинг: рабочий процесс](https://docs.google.com/document/d/demo-105/edit)',
    '- [Анти-паттерны вайбкодинга](https://docs.google.com/document/d/demo-111/edit)',
    '',
    '## Источники',
    '',
    '- https://docs.anthropic.com/claude-code',
  ].join('\n');

  const all = () => [].concat(
    ...tree.topics.map(t => t.pages), tree.general, tree.thoughts, tree.videos, tree.clips, tree.notes, tree.inbox,
    tree.lastReport ? [tree.lastReport] : []);

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // Имитация фоновой обработки: через несколько секунд карточка «дозревает»
  function tickVideos() {
    tree.videos.forEach(v => {
      if (v.readyAt && Date.now() > v.readyAt) {
        Object.assign(v, { state: 'done', stage: '', type: v.type || 'learn', topics: v.topics.length ? v.topics : ['Инструменты'], title: v.title === 'Новое видео (демо)' ? 'Новое видео: как собрать PWA за вечер' : v.title });
        delete v.readyAt;
      }
    });
  }

  async function demoApi(action, data) {
    await wait(action === 'chat' || action === 'voice' ? 1400 : 350);
    switch (action) {
      case 'ping':
        return { ok: true, app: 'База (демо)', model: 'gemini (демо)', gemini: true, base: 'База знаний', time: new Date().toISOString() };
      case 'tree':
        tickVideos();
        return { ok: true, tree: JSON.parse(JSON.stringify(tree)) };
      case 'page': {
        const p = all().find(x => x.id === data.id) || { id: data.id, title: 'Страница', modified: day(0) };
        const card = tree.videos.find(v => v.id === data.id);
        const tr = tree.videos.find(v => v.transcriptId === data.id);
        let md = SAMPLE.replace('# Claude Code', '# ' + p.title);
        if (card) md = card.state === 'done' ? cardSample(card) : '# ' + card.title + '\n\n- **Ссылка:** ' + card.url + '\n\n_Карточка готовится: транскрипт и конспект появятся через пару минут._';
        if (tr) md = '# Транскрипт — ' + tr.title + '\n\n- **Ссылка:** ' + tr.url + '\n- **Источник текста:** субтитры YouTube\n\n## Транскрипт\n\n[00:00:00] Это демо-транскрипт. В настоящей базе здесь дословный текст видео.\n\n[00:01:35] Всё новое — в одну папку, раскладывать руками не нужно.\n\n[00:04:00] Сырьё и знания храним отдельно.';
        if (data.id === 'demo-1') md = '# Инструменты\n\n## Страницы\n\n' + tree.topics[0].pages.map(x => '- [' + x.title + '](https://docs.google.com/document/d/' + x.id + '/edit)').join('\n');
        return { ok: true, page: { id: p.id, title: tr ? 'Транскрипт — ' + tr.title : p.title, markdown: md, modified: p.modified || day(0), url: '' } };
      }
      case 'add': {
        const url = (String(data.text).match(/https?:\/\/\S+/) || [''])[0];
        const rest = String(data.text).replace(url, '').trim();
        const vid = (url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{6,})/) || [])[1];
        const title = (vid ? 'Видео — ' : url ? 'Ссылка — ' : 'Заметка — ') + (rest.slice(0, 40) || 'без комментария');
        const item = { id: 'demo-' + (seq++), title, modified: new Date().toISOString(), created: new Date().toISOString(), path: '', mime: 'application/vnd.google-apps.document', url };
        tree.inbox.unshift(item);
        let cardId = null;
        if (vid) {
          const existing = tree.videos.find(v => v.videoId === vid);
          if (existing) cardId = existing.id;
          else {
            const v = video('demo-' + (seq++), vid, 'Новое видео (демо)', 'Канал', 600, '', [], 'new', 0);
            Object.assign(v, { state: 'transcribing', stage: 'транскрипт', type: '', readyAt: Date.now() + 8000 });
            tree.videos.unshift(v);
            cardId = v.id;
          }
        }
        return { ok: true, item: { id: item.id, title, url, kind: url ? 'link' : 'note', cardId }, scheduled: !!data.revise };
      }
      case 'videoSet': {
        const v = tree.videos.find(x => x.id === data.id);
        if (!v) return { ok: false, error: 'Карточка не найдена' };
        if (data.status) v.status = data.status;
        if (data.done != null) v.done = String(data.done).split(',').filter(Boolean).map(Number);
        return { ok: true, video: JSON.parse(JSON.stringify(v)) };
      }
      case 'videoRetry': {
        const v = tree.videos.find(x => x.id === data.id);
        if (!v) return { ok: false, error: 'Карточка не найдена' };
        Object.assign(v, { state: 'summarizing', stage: 'конспект', done: [], readyAt: Date.now() + 6000 });
        return { ok: true, video: JSON.parse(JSON.stringify(v)) };
      }
      case 'migrateVideos':
        return { ok: true, log: ['Карточка уже есть: JtjfYS9hfWw'] };
      case 'voice':
        return { ok: true, item: { id: 'demo-' + (seq++), title: 'Голосовая — демо-запись', kind: 'voice', text: 'В демо-режиме запись не расшифровывается. В настоящей базе здесь будет текст, который распознал Gemini.' } };
      case 'chat': {
        const q = (data.messages || []).slice(-1)[0] || { text: '' };
        return {
          ok: true,
          answer: 'Это **демо-ответ** на вопрос «' + q.text.slice(0, 80) + '».\n\nВ настоящем режиме Gemini сначала выбирает подходящие страницы базы, читает их и отвечает по ним, например:\n\n- в «Claude Code» — про план перед кодом;\n- в «Вайбкодинг: рабочий процесс» — про маленькие задачи.',
          sources: [{ title: 'Claude Code', id: tree.topics[0].pages[0].id }, { title: 'Вайбкодинг: рабочий процесс', id: tree.topics[1].pages[0].id }],
        };
      }
      case 'revise':
        return { ok: true, scheduled: true, inbox: tree.inbox.length };
    }
    return { ok: false, error: 'Неизвестное действие: ' + action };
  }

  window.demoApi = demoApi;
})();
