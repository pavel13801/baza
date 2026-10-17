// Демо-режим: те же ответы, что даёт Apps Script, но на выдуманных данных. Ничего никуда не отправляется.
(function () {
  const day = n => new Date(Date.now() - n * 86400000).toISOString();
  let seq = 100;
  const page = (title, n, path) => ({ id: 'demo-' + (seq++), title, modified: day(n), created: day(n + 3), path: path || '' });

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
      { id: 'demo-v1', title: 'Как я веду базу знаний с ИИ', modified: day(1), created: day(1), path: '', url: 'https://www.youtube.com/watch?v=JtjfYS9hfWw', videoId: 'JtjfYS9hfWw', noteId: 'demo-v1n' },
      { id: 'demo-v2', title: 'Claude Code: 10 приёмов', modified: day(4), created: day(4), path: '', url: 'https://youtu.be/demo2', videoId: '', noteId: null },
      { id: 'demo-v3', title: 'Статья: как устроен RAG', modified: day(9), created: day(9), path: '', url: 'https://example.com/rag', videoId: '', noteId: null },
    ],
    notes: [page('Голосовая — идея про приложение', 0), page('Заметка — что купить для студии', 2)],
    notesTotal: 2,
    inbox: [
      { id: 'demo-i1', title: 'Видео — Как сделать PWA на iPhone', modified: day(0), created: day(0), path: '', mime: 'application/vnd.google-apps.document', url: 'https://www.youtube.com/watch?v=JtjfYS9hfWw' },
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
    ...tree.topics.map(t => t.pages), tree.general, tree.thoughts, tree.videos, tree.notes, tree.inbox,
    tree.lastReport ? [tree.lastReport] : []);

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function demoApi(action, data) {
    await wait(action === 'chat' || action === 'voice' ? 1400 : 350);
    switch (action) {
      case 'ping':
        return { ok: true, app: 'База (демо)', model: 'gemini (демо)', gemini: true, base: 'База знаний', time: new Date().toISOString() };
      case 'tree':
        return { ok: true, tree: JSON.parse(JSON.stringify(tree)) };
      case 'page': {
        const p = all().find(x => x.id === data.id) || { id: data.id, title: 'Страница', modified: day(0) };
        const video = tree.videos.find(v => v.id === data.id);
        let md = SAMPLE.replace('# Claude Code', '# ' + p.title);
        if (video) md = '# ' + p.title + '\n\n- **Ссылка:** ' + video.url + '\n- **Источник текста:** субтитры YouTube\n\n## Транскрипт\n\n[00:00:00] Это демо-транскрипт. В настоящей базе здесь будет дословный текст видео, который сделала ревизия.\n\n[00:01:10] Второй абзац транскрипта с отметкой времени.';
        if (data.id === 'demo-1') md = '# Инструменты\n\n## Страницы\n\n' + tree.topics[0].pages.map(x => '- [' + x.title + '](https://docs.google.com/document/d/' + x.id + '/edit)').join('\n');
        return { ok: true, page: { id: p.id, title: p.title, markdown: md, modified: p.modified, url: video ? video.url : '' } };
      }
      case 'add': {
        const url = (String(data.text).match(/https?:\/\/\S+/) || [''])[0];
        const title = (url ? 'Ссылка — ' : 'Заметка — ') + String(data.text).replace(url, '').trim().slice(0, 40);
        const item = { id: 'demo-' + (seq++), title, modified: new Date().toISOString(), created: new Date().toISOString(), path: '', mime: 'application/vnd.google-apps.document', url };
        tree.inbox.unshift(item);
        return { ok: true, item: { id: item.id, title, url, kind: url ? 'link' : 'note' }, scheduled: !!data.revise };
      }
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
