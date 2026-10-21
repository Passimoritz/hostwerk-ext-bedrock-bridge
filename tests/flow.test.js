'use strict';
/*
 * Bedrock bridge end to end with a simulated download API and a simulated Minecraft server: switching on (download,
 * first start, config patch), giving up cleanly, switching off with clean-up, update check, Bedrock server list entry,
 * Velocity with Floodgate on the backends, GeyserOptionalPack.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.HW_TEST = '1';
const { Geyser, patchMotdText, readMotd, patchSendDataText } = require('../server/geyser');

const GEYSER_YML = 'bedrock:\n  address: 0.0.0.0\n  port: 19132\n  motd1: "Geyser"\n  motd2: "Another Geyser server."\n  server-name: "Geyser"\nremote:\n  address: auto\n  port: 25565\n  auth-type: online\npassthrough-motd: true\n';

function setup({ createConfig = true, build = 900 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-geyser-flow-'));
  const servers = [
    { id: 'a', name: 'Survival', type: 'paper' },
    { id: 'p', name: 'Proxy', type: 'velocity' },
    { id: 'l', name: 'Lobby', type: 'paper', network: { proxy: 'p' } },
    { id: 'f', name: 'Modded', type: 'fabric', network: { proxy: 'p' } },
  ];
  const running = new Set();
  const plugins = (id) => path.join(dir, id, 'plugins');
  const calls = [];
  const mc = {
    list: () => servers, get: (id) => servers.find((s) => s.id === id), dir: (id) => path.join(dir, id), addonDir: plugins,
    proc: (id) => ({ isRunning: () => running.has(id), extra: { ready: true, players: id === 'a' ? ['Steve', '.BedrockAlex'] : [] } }),
    start: async (id) => {
      calls.push(['start', id]); running.add(id);
      const s = servers.find((x) => x.id === id);
      // Geyser and Floodgate create their settings at the first start
      if (createConfig && fs.readdirSync(plugins(id)).some((f) => /^geyser/i.test(f))) {
        const cfg = path.join(plugins(id), s.type === 'velocity' ? 'Geyser-Velocity' : 'Geyser-Spigot');
        fs.mkdirSync(cfg, { recursive: true });
        if (!fs.existsSync(path.join(cfg, 'config.yml'))) fs.writeFileSync(path.join(cfg, 'config.yml'), GEYSER_YML);
      }
      if (fs.existsSync(plugins(id)) && fs.readdirSync(plugins(id)).some((f) => /^floodgate/i.test(f))) {
        fs.mkdirSync(path.join(plugins(id), 'floodgate'), { recursive: true });
        if (!fs.existsSync(path.join(plugins(id), 'floodgate', 'key.pem'))) fs.writeFileSync(path.join(plugins(id), 'floodgate', 'key.pem'), `KEY-${id}`);
        if (!fs.existsSync(path.join(plugins(id), 'floodgate', 'config.yml'))) fs.writeFileSync(path.join(plugins(id), 'floodgate', 'config.yml'), 'username-prefix: "."\nsend-floodgate-data: false\n');
      }
    },
    stop: async (id) => { calls.push(['stop', id]); running.delete(id); },
    restart: async (id) => { await mc.stop(id); await mc.start(id); },
  };
  const net = {
    fetchJson: async (url) => {
      const project = url.match(/projects\/([^/]+)/)[1];
      return { version: '2.7.0', build, downloads: { spigot: { sha256: null }, velocity: { sha256: null }, fabric: { sha256: null }, geyseroptionalpack: { sha256: null } }, project };
    },
    downloadFile: async (url, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, url); },
    jobProgress: () => () => {},
    runJob: (title, fn) => { const job = { progress() {}, log: (m) => job.lines.push(m), lines: [] }; return { id: 'job1', job, done: fn(job) }; },
  };
  const host = { ctx: { settings: { save: () => {} }, keeper: null, router: null }, t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s), error: (st, m) => Object.assign(new Error(m), { status: st }), broadcast: () => {} };
  const g = new Geyser(host, mc, net, { udpFree: async () => true });
  for (const s of servers) fs.mkdirSync(plugins(s.id), { recursive: true });
  return { dir, servers, running, g, mc, plugins, calls, host };
}

test('switching on: packages, first start, config patched, server stopped again', async () => {
  const { g, servers, plugins, running } = setup();
  const r = g.enable('a');
  const out = await r.done;
  assert.strictEqual(out.port, 19132);
  assert.deepStrictEqual(fs.readdirSync(plugins('a')).filter((f) => f.endsWith('.jar')).sort(), ['Geyser-spigot.jar', 'floodgate-spigot.jar']);
  const yml = fs.readFileSync(path.join(plugins('a'), 'Geyser-Spigot', 'config.yml'), 'utf8');
  assert.match(yml, /auth-type: floodgate/);
  assert.deepStrictEqual(servers[0].geyser.builds, { geyser: '2.7.0-900', floodgate: '2.7.0-900' });
  assert.ok(!running.has('a'), 'was off before → off again');
  const st = g.status('a');
  assert.strictEqual(st.prefix, '.');
  assert.deepStrictEqual(st.bedrockPlayers, ['.BedrockAlex'], 'Bedrock players marked by the Floodgate prefix');
});

test('giving up cleanly when Geyser never creates its settings', async () => {
  const { g, servers, plugins, running, mc } = setup({ createConfig: false });
  // The server crashes during the first start: no fixed two-minute wait, the bridge notices it right away
  mc.start = async (id) => { running.delete(id); };
  await assert.rejects(g.enable('a').done, /did not create its settings/);
  assert.ok(!servers[0].geyser, 'not left half on');
  assert.deepStrictEqual(fs.readdirSync(plugins('a')), []);
});

test('switching off removes packages, settings folders and waiting updates; running server needs a restart', async () => {
  const { g, servers, plugins, running } = setup();
  await g.enable('a').done;
  fs.mkdirSync(path.join(plugins('a'), '.hostwerk-neu'), { recursive: true });
  running.add('a');
  const off = await g.disable('a');
  assert.ok(!off.enabled && off.restartNeeded);
  assert.deepStrictEqual(fs.readdirSync(plugins('a')), [], 'jars, Geyser-Spigot/, floodgate/ and the staging folder are gone');
  assert.ok(g.status('a').restartNeeded, 'page keeps offering the restart');
  g.applyStaged('a'); // Hostwerk calls this before the next start
  assert.ok(!g.status('a').restartNeeded && !servers[0].geyserOff);
});

test('update check downloads into the staging folder and applies while stopped', async () => {
  const s = setup();
  await s.g.enable('a').done;
  s.g.net.fetchJson = async () => ({ version: '2.7.1', build: 950, downloads: { spigot: { sha256: null } } });
  s.running.add('a');
  const r = await s.g.checkUpdate('a');
  assert.deepStrictEqual(r.pending, { geyser: '2.7.1-950', floodgate: '2.7.1-950' });
  assert.ok(fs.existsSync(path.join(s.plugins('a'), '.hostwerk-neu', 'Geyser-spigot.jar')), 'staged, not replaced while running');
  s.running.delete('a');
  assert.ok(s.g.applyStaged('a'));
  assert.strictEqual(s.servers[0].geyser.builds.geyser, '2.7.1-950');
});

test('Bedrock server list entry: MOTD lines, server name, passthrough', async () => {
  const t = patchMotdText(GEYSER_YML, { motd1: 'Hallo "Welt"', motd2: 'Zeile 2', serverName: 'Mein Server', passthrough: false });
  assert.deepStrictEqual(readMotd(t), { motd1: 'Hallo "Welt"', motd2: 'Zeile 2', serverName: 'Mein Server', passthrough: false });
  assert.match(t, /remote:\n {2}address: auto/, 'other sections untouched');
  const noKeys = patchMotdText('bedrock:\n  port: 19132\nremote:\n  port: 25565\n', { motd1: 'A', passthrough: true });
  assert.strictEqual(readMotd(noKeys).motd1, 'A');
  assert.strictEqual(readMotd(noKeys).passthrough, true);
  assert.match(noKeys, /remote:\n {2}port: 25565/);

  const { g, running } = setup();
  await g.enable('a').done;
  running.add('a');
  const r = g.setMotd('a', { motd1: 'Willkommen\nzweite', serverName: 'x'.repeat(60) });
  assert.strictEqual(r.motd1, 'Willkommen zweite', 'no line breaks in YAML');
  assert.strictEqual(r.serverName.length, 40);
  assert.ok(r.restartNeeded && g.status('a').restartNeeded);
});

test('Velocity with Floodgate: key on every backend, send-floodgate-data on, removed again', async () => {
  const { g, servers, plugins } = setup();
  const out = await g.enable('p').done;
  assert.ok(out.port);
  assert.strictEqual(fs.readFileSync(path.join(plugins('l'), 'floodgate', 'key.pem'), 'utf8'), 'KEY-p', 'same key as the proxy');
  assert.ok(fs.readdirSync(plugins('l')).includes('floodgate-spigot.jar'));
  assert.ok(!fs.readdirSync(plugins('f')).some((f) => /floodgate/i.test(f)), 'Fabric backend: no Floodgate package exists');
  assert.match(fs.readFileSync(path.join(plugins('p'), 'floodgate', 'config.yml'), 'utf8'), /send-floodgate-data: true/);
  const st = g.status('p');
  assert.deepStrictEqual(st.backends.map((b) => [b.id, b.key, b.supported]), [['l', true, true], ['f', false, false]]);
  assert.deepStrictEqual(servers[1].geyser.backends, ['l']);
  await g.disable('p');
  assert.ok(!fs.existsSync(path.join(plugins('l'), 'floodgate')), 'Floodgate the bridge installed on the backend is removed');
  assert.ok(!fs.readdirSync(plugins('l')).some((f) => /floodgate/i.test(f)));
  assert.match(patchSendDataText('a: 1\n'), /send-floodgate-data: true/);
});

test('GeyserOptionalPack into Geyser\'s packs folder', async () => {
  const { g, plugins, servers } = setup();
  await assert.rejects(g.setOptionalPack('a', true), /Switch on Bedrock players first/);
  await g.enable('a').done;
  await g.setOptionalPack('a', true);
  const pack = path.join(plugins('a'), 'Geyser-Spigot', 'packs', 'GeyserOptionalPack.mcpack');
  assert.ok(fs.existsSync(pack));
  assert.ok(g.status('a').optionalPack);
  assert.strictEqual(servers[0].geyser.builds.optionalPack, '2.7.0-900');
  await g.setOptionalPack('a', false);
  assert.ok(!fs.existsSync(pack));
});
