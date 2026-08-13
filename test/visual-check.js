// Script ponctuel (non inclus dans npm test) : génère un PNG de contrôle
// visuel avec un peu de tout (composants, équation, annotations, thème)
// pour vérification manuelle avant livraison. Utilise un fichier de
// données isolé, comme test-mcp-client.js.
const path = require('path');
const fs = require('fs');
process.env.TABLEAU_DATA_FILE = path.join(__dirname, '..', 'data', 'tableau-visualcheck.json');
try { fs.unlinkSync(process.env.TABLEAU_DATA_FILE); } catch (e) {}

const { CanvasStore } = require('../server/store.js');
const { renderSnapshotPNG } = require('../server/snapshot.js');

async function main() {
  const store = new CanvasStore();
  store.setTheme('nuit');
  store.add({ type: 'component', kind: 'battery', x: 200, y: 200, label: 'Pile 9V', source: 'eleve' });
  store.add({ type: 'component', kind: 'resistor', x: 400, y: 200, label: 'R1 = 220 Ω', source: 'eleve' });
  store.add({ type: 'wire', points: [[240, 200], [360, 200]], source: 'eleve' });
  store.add({ type: 'equation', latex: 'U = R \\cdot I', x: 200, y: 340, source: 'eleve' });
  store.add({ type: 'annotation', subtype: 'erreur', x: 260, y: 340, texte: 'Vérifie ce signe', source: 'codex' });
  store.add({ type: 'annotation', subtype: 'indice', x: 260, y: 420, texte: "Pense à la loi d'Ohm", source: 'codex' });
  store.add({ type: 'annotation', subtype: 'zone', zone: { x: 150, y: 150, w: 320, h: 130 }, texte: 'Sous-circuit', source: 'codex' });
  store.add({ type: 'annotation', subtype: 'formule_aide', latex: 'U_R = U \\cdot \\frac{R}{R_1+R_2}', x: 650, y: 220, source: 'codex' });
  store.add({ type: 'annotation', subtype: 'application', latex: 'U_R = 12 \\cdot \\frac{220}{220+330}', x: 650, y: 300, source: 'codex' });
  store.add({ type: 'text', text: 'Diviseur de tension', x: 650, y: 400, source: 'eleve' });

  const elements = store.getAll();
  const png = await renderSnapshotPNG(elements, { width: 1600, height: 1000, theme: store.getTheme() });
  const out = path.join(__dirname, '..', 'data', 'visual-check-nuit.png');
  fs.writeFileSync(out, png);
  console.log('PNG écrit ->', out);

  store.setTheme('papier');
  const png2 = await renderSnapshotPNG(elements, { width: 1600, height: 1000, theme: store.getTheme() });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'visual-check-papier.png'), png2);
  console.log('PNG écrit -> data/visual-check-papier.png');

  store.setTheme('clair');
  const png3 = await renderSnapshotPNG(elements, { width: 1600, height: 1000, theme: store.getTheme() });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'visual-check-clair.png'), png3);
  console.log('PNG écrit -> data/visual-check-clair.png');

  try { fs.unlinkSync(process.env.TABLEAU_DATA_FILE); } catch (e) {}
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
