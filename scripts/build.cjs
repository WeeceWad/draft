const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'src/template.html'), 'utf8');
for (const [marker, file] of Object.entries({ STYLES: 'src/styles.css', DATA: 'data/38-0/players.js', CORE: 'src/draft-core.js', AUCTION: 'src/auction-core.js', LEAGUE: 'src/league-core.js', SOUND: 'src/sounds.js', APP: 'src/app.js' })) {
  const content = fs.readFileSync(path.join(root, file), 'utf8');
  html = html.replace(`/*__${marker}__*/`, () => marker === 'STYLES' ? content : content.replace(/<\/script/gi, '<\\/script'));
}
fs.writeFileSync(path.join(root, 'index.html'), html);
console.log('Built index.html — self-contained, offline, no dependencies.');
