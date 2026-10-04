const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'src/online-template.html'), 'utf8');
for (const [marker, file] of Object.entries({ STYLES: 'src/online.css', CORE: 'src/draft-core.js', AUCTION: 'src/auction-core.js', LEAGUE: 'src/league-core.js', SOUND: 'src/sounds.js', APP: 'src/online-app.js' })) {
  html = html.replace(`/*__${marker}__*/`, () => fs.readFileSync(path.join(root, file), 'utf8').replace(/<\/script/gi, '<\\/script'));
}
fs.mkdirSync(path.join(root, 'public'), { recursive: true });
fs.writeFileSync(path.join(root, 'online.html'), html);
fs.writeFileSync(path.join(root, 'public/index.html'), html);
fs.copyFileSync(path.join(root, 'index.html'), path.join(root, 'public/offline.html'));
console.log('Built online.html and Render public directory. Start with npm start.');
