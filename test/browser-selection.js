// Test navigateur isolé de la sélection simple/multiple et du déplacement.
// Il utilise son propre port et son propre fichier de données afin de ne jamais
// lire ni modifier le tableau réel de Lucas.
const path = require('path');
const fs = require('fs');

const TEST_PORT = 0; // port libre choisi par le système
const TEST_DATA_FILE = path.join(__dirname, '..', 'data', 'tableau-selection-test.json');
process.env.TABLEAU_DATA_FILE = TEST_DATA_FILE;

const { chromium } = require('playwright');
const { CanvasStore } = require('../server/store.js');
const { startHttpServer } = require('../server/http.js');

function assert(condition, label) {
  if (!condition) throw new Error(label);
  console.log(`[ok] ${label}`);
}

function cleanup() {
  try { fs.unlinkSync(TEST_DATA_FILE); } catch (e) { /* fichier absent */ }
}

async function boardPoint(page, x, y) {
  return page.locator('#board').evaluate((board, point) => {
    const svgPoint = board.createSVGPoint();
    svgPoint.x = point.x;
    svgPoint.y = point.y;
    const screenPoint = svgPoint.matrixTransform(board.getScreenCTM());
    return { x: screenPoint.x, y: screenPoint.y };
  }, { x, y });
}

async function dragBoard(page, from, to, steps = 8, beforeUp) {
  const start = await boardPoint(page, from.x, from.y);
  const end = await boardPoint(page, to.x, to.y);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps });
  if (beforeUp) await beforeUp();
  await page.mouse.up();
}

async function waitForPositions(page, expected) {
  await page.waitForFunction((positions) => fetch('/api/state')
    .then((r) => r.json())
    .then((state) => positions.every((position) => {
      const element = state.elements.find((candidate) => candidate.id === position.id);
      return element && element.x === position.x && element.y === position.y;
    })), expected);
}

async function main() {
  cleanup();
  const store = new CanvasStore();
  const first = store.add({ id: 'first', type: 'component', kind: 'resistor', x: 300, y: 300, source: 'eleve' });
  const second = store.add({ id: 'second', type: 'component', kind: 'battery', x: 500, y: 300, source: 'codex' });
  const third = store.add({ id: 'third', type: 'component', kind: 'lamp', x: 800, y: 300, source: 'eleve' });
  const http = await startHttpServer(store, TEST_PORT);
  const port = http.server.address().port;
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    const syncedPage = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    await Promise.all([
      page.goto(`http://127.0.0.1:${port}`),
      syncedPage.goto(`http://127.0.0.1:${port}`),
    ]);
    await Promise.all([
      page.locator('#statusText').waitFor({ state: 'visible' }),
      syncedPage.locator('[data-id="third"][data-hit="1"]').waitFor(),
    ]);

    // Le bord droit du cadre coupe la boîte englobante du second composant :
    // il doit être sélectionné même s'il n'est pas entièrement contenu.
    await dragBoard(page, { x: 200, y: 240 }, { x: 470, y: 350 }, 8, async () => {
      const overlayCount = await page.locator('#overlay-layer rect').count();
      assert(overlayCount === 3, 'le rectangle visible sélectionne les deux éléments touchés pendant le glissé');
    });
    assert(await page.locator('#overlay-layer rect').count() === 2, 'deux éléments restent sélectionnés après le relâchement');

    await dragBoard(page, { x: 300, y: 300 }, { x: 400, y: 370 });
    await waitForPositions(page, [
      { id: first.id, x: 400, y: 370 },
      { id: second.id, x: 600, y: 370 },
      { id: third.id, x: 800, y: 300 },
    ]);
    assert(true, 'les deux éléments sélectionnés se déplacent ensemble et le troisième reste immobile');

    await syncedPage.waitForFunction(() => {
      const firstHit = document.querySelector('[data-id="first"][data-hit="1"]');
      const secondHit = document.querySelector('[data-id="second"][data-hit="1"]');
      if (!firstHit || !secondHit) return false;
      const firstX = Number(firstHit.getAttribute('x'));
      const secondX = Number(secondHit.getAttribute('x'));
      return firstX > 350 && secondX > 550 && secondX - firstX === 200;
    });
    assert(true, 'le déplacement multiple est diffusé à un second client par WebSocket');

    await dragBoard(page, { x: 800, y: 300 }, { x: 850, y: 340 });
    await waitForPositions(page, [
      { id: first.id, x: 400, y: 370 },
      { id: second.id, x: 600, y: 370 },
      { id: third.id, x: 850, y: 340 },
    ]);
    assert(await page.locator('#overlay-layer rect').count() === 1, 'la sélection et le déplacement d’un seul élément continuent de fonctionner');
  } finally {
    await browser.close();
    for (const client of http.wss.clients) client.terminate();
    await new Promise((resolve) => http.wss.close(resolve));
    await new Promise((resolve) => http.server.close(resolve));
    store.flush();
    cleanup();
  }
}

main().catch((error) => {
  cleanup();
  console.error('[ÉCHEC] test navigateur de sélection :', error);
  process.exit(1);
});
