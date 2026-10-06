// Reference screenshots of the Electron renderer (mock bridge) at 1x.
import puppeteer from '/home/work/Code/Agente/apps/desktop/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { mkdirSync } from 'node:fs';

const OUT = '/tmp/electron/';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 900));

const shoot = async (name) => {
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('shot', name);
};

const clickTab = async (needle) =>
  page.evaluate((value) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) =>
      (el.getAttribute('aria-label') || '').toLowerCase().includes(value.toLowerCase())
    );
    tab?.click();
    return Boolean(tab);
  }, needle);

await shoot('home-dark');
console.log('code tab', await clickTab('digo'));
await shoot('code-dark');
console.log('bots tab', await clickTab('bots'));
await shoot('bots-dark');
console.log('role tab', await clickTab('rol'));
await shoot('roleplay-dark');

await page.evaluate(() => document.querySelector('[data-activity-settings]')?.click());
await shoot('settings-general-dark');

for (const label of ['Búsqueda web', 'Artefactos', 'En este equipo', 'Voz', 'Accesibilidad']) {
  const clicked = await page.evaluate((name) => {
    const row = [...document.querySelectorAll('[data-nav-row]')].find((el) =>
      (el.textContent || '').trim().startsWith(name)
    );
    row?.click();
    return Boolean(row);
  }, label);
  if (!clicked) {
    console.log('missing section', label);
    continue;
  }
  await shoot(`settings-${label.toLowerCase().replaceAll(/[^a-z]+/g, '-')}-dark`);
}

await page.evaluate(() => localStorage.setItem('chatealm_theme', 'light'));
await page.goto('http://localhost:5173/?mock=1', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 900));
await shoot('home-light');
await browser.close();
