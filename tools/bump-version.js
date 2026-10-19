// Новая версия приложения во всех местах сразу: node tools/bump-version.js 1.1.3
// version.json (по нему приложение понимает, что пора обновиться), VERSION в app.js и sw.js,
// и ?v=… у файлов в index.html — чтобы браузер не взял их из своего кэша.
const fs = require('fs');
const path = require('path');

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v || '')) {
  console.error('Укажите версию: node tools/bump-version.js 1.2.0');
  process.exit(1);
}
const app = path.join(__dirname, '..', 'app');
const edit = (file, fn) => {
  const p = path.join(app, file);
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error('Ничего не поменялось в ' + file);
  fs.writeFileSync(p, after);
};

fs.writeFileSync(path.join(app, 'version.json'), JSON.stringify({ version: v }) + '\n');
edit('app.js', s => s.replace(/const VERSION = '[\d.]+';/, "const VERSION = '" + v + "';"));
edit('sw.js', s => s.replace(/const VERSION = 'baza-[\d.]+';/, "const VERSION = 'baza-" + v + "';"));
edit('index.html', s => s.replace(/(href|src)="(styles\.css|md\.js|demo\.js|app\.js)(\?v=[\d.]+)?"/g, '$1="$2?v=' + v + '"'));
console.log('Версия ' + v + ': version.json, app.js, sw.js, index.html');
