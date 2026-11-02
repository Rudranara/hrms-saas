// Local visual review with an isolated development account; no payment requests.
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../../backend/.env', import.meta.url), quiet: true });
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const stage = process.argv[2] || 'before';
const name = `Billing visual review ${randomUUID()}`;
let socket;
try {
  const password = `Review passphrase ${randomUUID()}`;
  const response = await fetch('http://localhost:3000/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HRMS-Request': '1', Origin: 'http://localhost:3000' }, body: JSON.stringify({ organizationName: name, fullName: 'Review Administrator', email: `billing-${randomUUID()}@example.test`, password, confirmPassword: password }) });
  if (!response.ok) throw new Error(`Fixture registration failed: ${response.status} ${await response.text()}`);
  const token = response.headers.get('set-cookie')?.match(/hrms_session=([^;]+)/)?.[1];
  if (!token) throw new Error('Missing fixture session');
  const tabs = await fetch('http://localhost:9223/json/list').then(r => r.json());
  socket = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => (await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const wait = async expression => { for (let i=0;i<150;i++) { if (await evaluate(expression)) return; await new Promise(r=>setTimeout(r,100)); } throw new Error(`Timeout: ${expression}`); };
  await command('Page.enable');
  await command('Network.enable');
  await command('Network.setCookie', { name: 'hrms_session', value: token, url: 'http://localhost:3000', httpOnly: true });
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: 'http://localhost:3000/billing' });
  await wait("document.querySelectorAll('.billing-plan').length === 3");
  await new Promise(r=>setTimeout(r,500));
  const folder = new URL('../../artifacts/billing/', import.meta.url);
  await fs.mkdir(folder, { recursive: true });
  async function capture(label) { const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); await fs.writeFile(new URL(`${stage}-${label}.png`, folder), Buffer.from(shot.data,'base64')); }
  await capture('desktop');
  const checks = [];
  if (stage === 'logout') {
    for (const page of ['dashboard', 'billing']) {
      await command('Page.navigate', { url: `http://localhost:3000/${page}` });
      await wait("!!document.querySelector('.dashboard-logout > button')");
      await new Promise(r => setTimeout(r, 400));
      for (const width of [1440, 390, 320]) {
        await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
        await evaluate("document.querySelector('.dashboard-logout > button').focus(); document.querySelector('.dashboard-logout > button').click()");
        await wait("!!document.querySelector('dialog[open]')");
        const state = await evaluate(`(()=>{const d=document.querySelector('dialog[open]'), r=d.getBoundingClientRect();return { centered:Math.abs(r.x+r.width/2-document.documentElement.clientWidth/2)<2 && Math.abs(r.y+r.height/2-innerHeight/2)<2, fits:r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight, styled:getComputedStyle(d).padding==='32px' || getComputedStyle(d).padding==='26px 22px', safeFocus:document.activeElement.classList.contains('logout-confirmation-cancel') };})()`);
        assert.ok(state.centered && state.fits && state.styled && state.safeFocus, JSON.stringify({ page, width, state }));
        const shot = await command('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(new URL(`logout-${page}-${width}.png`, folder), Buffer.from(shot.data, 'base64'));
        await evaluate("document.querySelector('.logout-confirmation-cancel').click()");
        assert.equal(await evaluate("!!document.querySelector('dialog[open]')"), false);
        assert.equal(await evaluate("document.activeElement === document.querySelector('.dashboard-logout > button')"), true);
        checks.push({ page, width, ...state, cancelAndFocusRestore: true });
      }
      await evaluate("document.querySelector('.dashboard-logout > button').focus(); document.querySelector('.dashboard-logout > button').click()");
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await wait("!document.querySelector('dialog[open]')");
    }
    await evaluate("document.querySelector('.dashboard-logout > button').focus(); document.querySelector('.dashboard-logout > button').click()");
    await wait("!!document.querySelector('dialog[open]')");
    await evaluate("document.querySelector('.logout-confirmation-submit').click()");
    await wait("location.pathname === '/login'");
    assert.equal((await command('Network.getCookies', { urls: ['http://localhost:3000'] })).cookies.some(c => c.name === 'hrms_session'), false);
    console.log(JSON.stringify({ checks, escapeCloses: true, confirmedLogout: true }, null, 2));
  }
  if (stage !== 'logout') for (const width of [320,390,768,1440]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 768 });
    checks.push({ width, noOverflow: await evaluate('document.documentElement.scrollWidth <= innerWidth') });
    if (width === 390) await capture('mobile');
  }
  if (stage === 'after') {
    await evaluate("document.querySelectorAll('.billing-toggle button')[1].click()");
    await wait("document.querySelector('.billing-price').textContent.includes('9,990')");
    await capture('yearly');
    await evaluate("document.querySelector('details.billing-details summary').click()");
    await wait("document.querySelector('details.billing-details').open");
    checks.push({ subscriptionDetailsExpand: true, yearlyToggle: true });
    let historyFailure = true;
    socket.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.method !== 'Fetch.requestPaused') return;
      const body = historyFailure ? { message: 'Temporary billing history outage.' } : { payments: [{ id: 'visual-payment', amountMinor: 199900, currency: 'INR', status: 'CAPTURED', paidAt: '2026-10-28T09:00:00Z', createdAt: '2026-10-28T09:00:00Z', subscription: { plan: { name: 'Growth' }, interval: 'MONTHLY' } }] };
      void command('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: historyFailure ? 503 : 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') });
    });
    await command('Fetch.enable', { patterns: [{ urlPattern: '*/api/billing/history', requestStage: 'Request' }] });
    await command('Page.navigate', { url: 'http://localhost:3000/billing' });
    await wait("!!document.querySelector('.billing-history-error button')");
    await capture('history-error');
    historyFailure = false;
    await evaluate("document.querySelector('.billing-history-error button').click()");
    await wait("!!document.querySelector('.billing-payment-table tbody tr')");
    checks.push({ historyFailureAndRetry: true, paymentTable: await evaluate("document.querySelector('.billing-payment-table').textContent.includes('Growth') && document.querySelector('.billing-payment-table').textContent.includes('captured')") });
    await capture('history-populated');
    await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: true });
    checks.push({ populatedHistoryAt320: await evaluate('document.documentElement.scrollWidth <= innerWidth') });
    await command('Fetch.disable');
  }
  console.log(JSON.stringify({ stage, checks, screenshots: 'artifacts/billing' }, null, 2));
} finally {
  socket?.close();
  const fixtures = await db.organization.findMany({ where: { name }, select: { id: true } });
  for (const fixture of fixtures) await db.organization.delete({ where: { id: fixture.id } });
  await db.$disconnect();
}
