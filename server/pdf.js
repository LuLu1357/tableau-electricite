// Insertion locale d'une page de PDF sur le tableau : rasterise la page en
// PNG via poppler (pdftoppm, CLI) et mémorise le résultat par hash de
// contenu (pdf + numéro de page + largeur) pour ne jamais re-rasteriser
// deux fois la même page. 100% local, aucun service cloud.
//
// Prérequis machine : poppler (`brew install poppler` sur macOS). Si absent,
// on renvoie une erreur claire plutôt que de planter — voir PDF_TOOL_MISSING.

const { execFile } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'pdf-cache');
const PDF_TOOL_MISSING = 'PDF_TOOL_MISSING';

let pdftoppmChecked = false;
let pdftoppmAvailable = false;

function checkPdftoppm() {
  return new Promise((resolve) => {
    if (pdftoppmChecked) return resolve(pdftoppmAvailable);
    execFile('pdftoppm', ['-v'], (err) => {
      pdftoppmChecked = true;
      pdftoppmAvailable = !err || err.code === 0 || /poppler/i.test(String(err));
      resolve(pdftoppmAvailable);
    });
  });
}

function hashOf(str) {
  return createHash('sha1').update(str).digest('hex').slice(0, 20);
}

async function insertPdfPage({ pdfPath, page, width }) {
  const available = await checkPdftoppm();
  if (!available) return { error: PDF_TOOL_MISSING };

  if (!fs.existsSync(pdfPath)) {
    return { error: `Fichier PDF introuvable : ${pdfPath}` };
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const stat = fs.statSync(pdfPath);
  const key = hashOf(`${pdfPath}::${stat.size}::${stat.mtimeMs}::${page}`);
  const pngPath = path.join(CACHE_DIR, `${key}.png`);

  if (!fs.existsSync(pngPath)) {
    const prefix = path.join(CACHE_DIR, `tmp-${key}`);
    await new Promise((resolve, reject) => {
      execFile('pdftoppm', ['-png', '-f', String(page), '-l', String(page), '-r', '150', pdfPath, prefix], (err) => {
        if (err) return reject(err);
        resolve();
      });
    }).catch((e) => { throw new Error(`pdftoppm a échoué : ${e.message}`); });

    // pdftoppm nomme le fichier "<prefix>-<page padded>.png" (padding variable).
    const dir = fs.readdirSync(CACHE_DIR);
    const produced = dir.find((f) => f.startsWith(`tmp-${key}-`) && f.endsWith('.png'));
    if (!produced) return { error: `pdftoppm n'a produit aucune image pour la page ${page} (page hors limites ?)` };
    fs.renameSync(path.join(CACHE_DIR, produced), pngPath);
  }

  const meta = await sharp(pngPath).metadata();
  const targetWidth = width || 420;
  const targetHeight = Math.round((meta.height / meta.width) * targetWidth);

  return {
    src: `/pdf-cache/${key}.png`,
    absPath: pngPath,
    width: targetWidth,
    height: targetHeight,
  };
}

module.exports = { insertPdfPage, PDF_TOOL_MISSING };
