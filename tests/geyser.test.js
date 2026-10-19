'use strict';
/*
 * Bedrock bridge without a real Minecraft server: supported server types, free ports, config patch,
 * staged updates (put in place only while stopped), switching off, status.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.HW_TEST = '1';
const { Geyser, patchConfigText } = require('../server/geyser');
const de = require('../locales/de.json');

const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-geyser-'));
  const servers = [{ id: 'a', name: 'Survival', type: 'paper' }, { id: 'b', name: 'Creative', type: 'paper', geyser: { port: 19132 } }, { id: 'v', name: 'Plain', type: 'vanilla' }];
  const running = new Set();
  const mc = {
    list: () => servers, get: (id) => servers.find((s) => s.id === id), dir: (id) => path.join(dir, id), addonDir: (id) => path.join(dir, id, 'plugins'),
    proc: (id) => ({ isRunning: () => running.has(id), extra: { ready: true, players: [] } }), restart: async () => {}, start: async () => {}, stop: async () => {},
  };
  let saved = 0;
  const host = { ctx: { settings: { save: () => { saved++; } }, keeper: null, router: null }, t: (s, v) => fill(de[s] || s, v), error: (st, m) => Object.assign(new Error(m), { status: st }), broadcast: () => {} };
  const g = new Geyser(host, mc, {});
  return { dir, servers, running, g, saved: () => saved };
}

test('supported types and reasons in German', () => {
  const { g } = setup();
  assert.deepStrictEqual(g.supported({ type: 'paper' }), { ok: true, geyser: 'spigot', floodgate: 'spigot' });
  assert.deepStrictEqual(g.supported({ type: 'fabric' }), { ok: true, geyser: 'fabric', floodgate: null });
  assert.match(g.supported({ type: 'vanilla' }).why, /Vanilla kann keine Plugins/);
  assert.match(g.supported({ type: 'forge' }).why, /NeoForge/);
});

test('free port skips ports of other servers', () => {
  const { g } = setup();
  assert.strictEqual(g.freePort('a'), 19133);
  assert.strictEqual(g.freePort('b'), 19132, 'own port stays free for itself');
});

test('config patch: bedrock port and floodgate auth only', () => {
  const yml = 'bedrock:\n  address: 0.0.0.0\n  port: 19132\nremote:\n  port: 25565\n  auth-type: online\n';
  const out = patchConfigText(yml, { port: 19140, floodgate: true });
  assert.match(out, /bedrock:\n {2}address: 0\.0\.0\.0\n {2}port: 19140/);
  assert.match(out, /remote:\n {2}port: 25565/, 'Java port untouched');
  assert.match(out, /auth-type: floodgate/);
  assert.match(patchConfigText(yml, { port: 1, floodgate: false }), /auth-type: online/);
});

test('staged update lands only while stopped and replaces the old jar', () => {
  const { g, dir, servers } = setup();
  const s = servers[1];
  const plugins = path.join(dir, 'b', 'plugins');
  fs.mkdirSync(path.join(plugins, '.hostwerk-neu'), { recursive: true });
  fs.writeFileSync(path.join(plugins, 'Geyser-Spigot-old.jar'), 'old');
  fs.writeFileSync(path.join(plugins, 'Other.jar'), 'keep');
  fs.writeFileSync(path.join(plugins, '.hostwerk-neu', 'Geyser-Spigot.jar'), 'new');
  s.geyser.pending = { geyser: '2.7.0-900' };
  const logs = [];
  assert.strictEqual(g.applyStaged('b', (m) => logs.push(m)), true);
  assert.deepStrictEqual(fs.readdirSync(plugins).sort(), ['Geyser-Spigot.jar', 'Other.jar']);
  assert.strictEqual(s.geyser.builds.geyser, '2.7.0-900');
  assert.ok(!s.geyser.pending);
  assert.match(logs[0], /Geyser aktualisiert \(Build 2\.7\.0-900\)/);
  assert.strictEqual(g.applyStaged('b'), false, 'nothing waiting → nothing done');
});

test('status and switching off', async () => {
  const { g, dir, servers } = setup();
  const plugins = path.join(dir, 'b', 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, 'floodgate-spigot.jar'), 'x');
  const st = g.status('b');
  assert.ok(st.enabled && st.port === 19132 && st.jars.includes('floodgate-spigot.jar'));
  assert.match(st.address, /IP-dieses-PCs:19132/);
  const off = await g.disable('b');
  assert.ok(!off.enabled && !servers[1].geyser);
  assert.deepStrictEqual(fs.readdirSync(plugins), []);
  assert.strictEqual(g.overview().length, 3);
});

test('every German text has a value', () => {
  for (const [k, v] of Object.entries(de)) if (k !== '$patterns') assert.ok(typeof v === 'string' && v.trim(), k);
});
