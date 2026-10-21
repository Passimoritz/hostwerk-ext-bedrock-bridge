'use strict';
/*
 * Bedrock players (phone, console, Windows edition) on Java servers: Geyser translates the Bedrock protocol, Floodgate allows
 * Bedrock accounts without a Java account. One click: download the matching packages (Paper/Spigot/Purpur/Folia, Velocity,
 * Fabric, NeoForge), set the configuration (own UDP port, auth-type floodgate), open the port in the firewall and router
 * (through the public ports). Switching it off puts everything back – packages, settings folders and waiting updates.
 *
 * Velocity with Floodgate: Floodgate has to run on the proxy AND on every backend server with the same key.pem –
 * otherwise the backends kick Bedrock players. The bridge installs Floodgate on the backends of the network, copies the key
 * and switches on "send-floodgate-data" on the proxy (again after every change of the network: "Sync backends").
 *
 * Keeps itself up to date: Geyser has to match the current Bedrock version (Bedrock updates every few weeks). The extension
 * checks the download API at start and every 6 hours, downloads new builds into a staging folder (checksum) and puts them
 * in place at the next server start. If the server is running, it restarts it as soon as nobody is online.
 * Data stays where it always was: the "geyser" entry of each Minecraft server in Hostwerk's settings.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');

const API = 'https://download.geysermc.org/v2/projects';
/** Server type → Geyser package, Floodgate package (null = none) */
const PLATFORM = {
  paper: ['spigot', 'spigot'], purpur: ['spigot', 'spigot'], spigot: ['spigot', 'spigot'], folia: ['spigot', 'spigot'],
  velocity: ['velocity', 'velocity'], fabric: ['fabric', null], neoforge: ['neoforge', null],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JAR = /^(geyser|floodgate)[-_].*\.jar$/i;
const STAGE = '.hostwerk-neu';
/** Settings folders Geyser and Floodgate create (plugins/… or config/…) – removed again when switching off. */
const CONFIG_DIRS = ['Geyser-Spigot', 'Geyser-Velocity', 'Geyser-Fabric', 'Geyser-NeoForge', 'geyser', 'floodgate'];
/** Resource pack that makes many Java features look right on Bedrock (armour stands, hit boxes …). */
const OPTIONAL_PACK = { project: 'geyseroptionalpack', platform: 'geyseroptionalpack', file: 'GeyserOptionalPack.mcpack' };
/** Waiting for the first start: as long as the server keeps starting – at most this long (big modpacks need minutes). */
const FIRST_START_MAX = 15 * 60000;

/** Bedrock port in the "bedrock:" section and – with Floodgate – the auth type. Pure text change, tested. */
function patchConfigText(text, { port, floodgate }) {
  let t = text;
  const b = t.search(/^bedrock:\s*$/m);
  if (b >= 0) {
    const after = t.slice(b);
    const m = after.match(/\n(\s+)port:\s*\d+/);
    if (m) t = t.slice(0, b) + after.replace(m[0], `\n${m[1]}port: ${port}`);
  }
  if (floodgate) t = t.replace(/(auth-type:\s*)\w+/, '$1floodgate');
  return t;
}

/** The "bedrock:" section as [start, end] (end = next top-level key or end of text). */
function bedrockSection(text) {
  const b = text.search(/^bedrock:\s*$/m);
  if (b < 0) return null;
  const nl = text.indexOf('\n', b);
  if (nl < 0) return [b, text.length];
  const n = text.slice(nl + 1).search(/^\S/m); // next top-level key
  return [b, n < 0 ? text.length : nl + 1 + n];
}
const yamlStr = (s) => `"${String(s).replace(/[\r\n]/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const yamlRead = (v) => { const s = String(v || '').trim(); const q = s.match(/^"((?:[^"\\]|\\.)*)"$/) || s.match(/^'((?:[^']|'')*)'$/); return q ? q[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/''/g, "'") : s; };

/** MOTD lines and server name that Bedrock players see in their server list. */
function readMotd(text) {
  const sec = bedrockSection(text);
  const part = sec ? text.slice(sec[0], sec[1]) : '';
  const get = (k) => { const m = part.match(new RegExp(`\\n\\s+${k}:\\s*(.*)`)); return m ? yamlRead(m[1]) : ''; };
  const pass = text.match(/^passthrough-motd:\s*(\w+)/m);
  return { motd1: get('motd1'), motd2: get('motd2'), serverName: get('server-name'), passthrough: pass ? pass[1] === 'true' : false };
}

/** Write MOTD lines and server name (keeps everything else). passthrough = show the Java MOTD instead. */
function patchMotdText(text, { motd1, motd2, serverName, passthrough }) {
  let t = text;
  const set = (key, val) => {
    if (val === undefined) return;
    const sec = bedrockSection(t);
    if (!sec) return;
    const part = t.slice(sec[0], sec[1]);
    const re = new RegExp(`(\\n(\\s+)${key}:)\\s*.*`);
    const indent = (part.match(/\n(\s+)\S/) || [null, '  '])[1];
    const next = re.test(part) ? part.replace(re, `$1 ${yamlStr(val)}`) : part.replace(/\s*$/, '') + `\n${indent}${key}: ${yamlStr(val)}\n`;
    t = t.slice(0, sec[0]) + next + t.slice(sec[1]);
  };
  set('motd1', motd1); set('motd2', motd2); set('server-name', serverName);
  if (typeof passthrough === 'boolean') {
    if (/^passthrough-motd:/m.test(t)) t = t.replace(/^(passthrough-motd:)\s*\w+/m, `$1 ${passthrough}`);
    else t = t.replace(/\s*$/, '') + `\npassthrough-motd: ${passthrough}\n`;
  }
  return t;
}

/** Floodgate on a proxy: "send-floodgate-data: true" so the backends learn who is a Bedrock player. */
function patchSendDataText(text, on = true) {
  return /^send-floodgate-data:/m.test(text) ? text.replace(/^(send-floodgate-data:)\s*\w+/m, `$1 ${on}`) : text.replace(/\s*$/, '') + `\nsend-floodgate-data: ${on}\n`;
}

/** First private IPv4 of this PC (for friends in the same network). */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)) return n.address;
  }
  return null;
}

/** Is a UDP port free on this PC? (other game servers, a second Geyser, Bedrock Dedicated Server …) */
function udpFree(port) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { try { s.close(); } catch { /* ignore */ } resolve(false); });
    s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
  });
}

class Geyser {
  /** host: extension host · mc: Hostwerk's Minecraft manager · net: { downloadFile, fetchJson, jobProgress, runJob } · opts: { udpFree } */
  constructor(host, mc, net, opts = {}) {
    this.host = host; this.ctx = host.ctx; this.t = host.t; this.mc = mc; this.net = net;
    this.udpFree = opts.udpFree || udpFree;
    this.timers = [];
    if (!process.env.HW_TEST) {
      // First check shortly after the start, then every 6 hours; waiting updates are applied every 10 minutes
      this.timers.push(setTimeout(() => this.checkAll().catch(() => {}), 4 * 60000));
      this.timers.push(setInterval(() => this.checkAll().catch(() => {}), 6 * 3600000));
      this.timers.push(setInterval(() => this.applyWhenEmpty().catch(() => {}), 10 * 60000));
      for (const x of this.timers) if (x.unref) x.unref();
    }
  }
  stop() { for (const x of this.timers) { clearTimeout(x); clearInterval(x); } }

  supported(s) {
    const p = PLATFORM[s.type];
    if (p) return { ok: true, geyser: p[0], floodgate: p[1] };
    const why = s.type === 'vanilla' ? this.t('Vanilla cannot load plugins – switch the server to Paper for Bedrock players (same world).') : s.type === 'forge' ? this.t('There is no Geyser for Forge – use NeoForge or Paper.') : this.t('There is no Geyser for this server type.');
    return { ok: false, why };
  }

  /** UDP ports others already want: other Bedrock bridges, game servers and other public UDP ports, own forwardings. */
  usedUdp(id) {
    const used = new Set(this.mc.list().filter((x) => x.id !== id && x.geyser).map((x) => x.geyser.port));
    const own = this.mc.get(id);
    try {
      for (const p of (this.ctx.security && this.ctx.security.publicPorts ? this.ctx.security.publicPorts() : [])) {
        if (p.proto === 'UDP' && !(own && own.geyser && p.port === own.geyser.port)) used.add(p.port);
      }
    } catch { /* no security service */ }
    try { for (const x of (this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.extra) || []) if (x.protocol === 'UDP') used.add(x.port); } catch { /* no router extension */ }
    return used;
  }

  /** Free Bedrock port: 19132, with several servers 19133 … – skips ports in use on this PC as well. */
  async freePort(id) {
    const s = this.mc.get(id);
    if (s && s.geyser && s.geyser.port) return s.geyser.port;
    const used = this.usedUdp(id);
    for (let p = 19132; p < 19132 + 200; p++) {
      if (used.has(p)) continue;
      if (await this.udpFree(p)) return p;
    }
    throw this.host.error(409, 'No free UDP port found between 19132 and 19331.');
  }

  /** Floodgate's prefix for Bedrock names (default "."), so other parts can mark Bedrock players. */
  prefix(id) {
    try {
      const f = path.join(this.mc.addonDir(id), 'floodgate', 'config.yml');
      const m = fs.readFileSync(f, 'utf8').match(/^username-prefix:\s*(.*)$/m);
      return m ? yamlRead(m[1]) : '.';
    } catch { return '.'; }
  }

  /** Backend servers of a Velocity proxy (members of its network). */
  backends(id) { return this.mc.list().filter((x) => x.id !== id && x.network && x.network.proxy === id); }

  status(id) {
    const s = this.mc.get(id);
    const sup = this.supported(s);
    const dir = this.mc.addonDir(id);
    let jars = [];
    try { jars = fs.readdirSync(dir).filter((f) => JAR.test(f)); } catch { /* no folder yet */ }
    const g = s.geyser || {};
    const p = this.mc.proc(id);
    const lan = this.lanHost();
    const prefix = g.floodgate ? this.prefix(id) : null;
    const players = (p.extra && p.extra.players) || [];
    const out = {
      id, name: s.name, type: s.type, supported: sup.ok, why: sup.why || null, enabled: !!s.geyser, port: s.geyser ? g.port : null, floodgate: !!g.floodgate, jars,
      address: s.geyser && lan ? `${lan}:${g.port}` : null,
      build: g.builds ? g.builds.geyser : null, pending: g.pending ? g.pending.geyser : null, checkedAt: g.checkedAt || null, running: p.isRunning(),
      restartNeeded: !!g.restartNeeded, optionalPack: !!g.optionalPack, proxy: s.type === 'velocity',
      // Bedrock players online right now (Floodgate names start with the prefix) – for marking them elsewhere
      prefix, bedrockPlayers: prefix ? players.map((x) => (typeof x === 'string' ? x : x && x.name)).filter((n) => n && n.startsWith(prefix)) : [],
    };
    if (out.proxy && g.floodgate) out.backends = this.backends(id).map((b) => ({ id: b.id, name: b.name, key: this.hasKey(b.id), supported: !!(PLATFORM[b.type] && PLATFORM[b.type][1]) }));
    if (!s.geyser && s.geyserOff) out.restartNeeded = !!s.geyserOff.restartNeeded;
    return out;
  }
  overview() { return this.mc.list().map((s) => this.status(s.id)); }
  lanHost() { const r = this.ctx.router && this.ctx.router.cache && this.ctx.router.cache.igd; return (r && r.localIp) || lanIp(); }

  /**
   * Addresses for friends: the same network (LAN address) and outside (DynDNS domain, remote access domain or the public IP).
   * Outside also needs the UDP port forwarded in the router – the "Router & port forwarding" extension does that by itself.
   */
  async addresses(id) {
    const s = this.mc.get(id);
    if (!s.geyser) return { lan: null, outside: null, port: null };
    const port = s.geyser.port;
    let outside = null;
    try { const d = this.ctx.router && this.ctx.router.dyn; if (d && d.domain) outside = d.domain; } catch { /* no router extension */ }
    try { if (!outside && this.ctx.remote) { const r = this.ctx.remote.status(); if (r && r.domain) outside = r.domain; } } catch { /* no remote access */ }
    try { if (!outside && this.ctx.liveGuide) outside = await this.ctx.liveGuide.publicIp(); } catch { /* offline */ }
    return { lan: this.lanHost(), outside: outside || null, port, routerAuto: !!(this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto) };
  }

  /** Geyser's configuration file (it is created at the first start). */
  configFile(id) {
    const base = this.mc.addonDir(id);
    const s = this.mc.get(id);
    const cands = s.type === 'fabric' || s.type === 'neoforge'
      ? [path.join(this.mc.dir(id), 'config', 'Geyser-Fabric', 'config.yml'), path.join(this.mc.dir(id), 'config', 'Geyser-NeoForge', 'config.yml'), path.join(this.mc.dir(id), 'config', 'geyser', 'config.yml')]
      : [path.join(base, 'Geyser-Spigot', 'config.yml'), path.join(base, 'Geyser-Velocity', 'config.yml'), path.join(base, 'geyser', 'config.yml')];
    return cands.find((f) => fs.existsSync(f)) || null;
  }
  patchConfig(file, opts) { fs.writeFileSync(file, patchConfigText(fs.readFileSync(file, 'utf8'), opts)); }

  /* ---------------- Server list entry for Bedrock (MOTD, name) ---------------- */

  motd(id) {
    const f = this.configFile(id);
    if (!f) return { available: false };
    return { available: true, ...readMotd(fs.readFileSync(f, 'utf8')) };
  }
  setMotd(id, b = {}) {
    const f = this.configFile(id);
    if (!f) throw this.host.error(409, 'Geyser has not created its settings yet – start the server once.');
    const clip = (v, n) => (typeof v === 'string' ? v.replace(/[\r\n]/g, ' ').slice(0, n) : undefined);
    fs.writeFileSync(f, patchMotdText(fs.readFileSync(f, 'utf8'), { motd1: clip(b.motd1, 80), motd2: clip(b.motd2, 80), serverName: clip(b.serverName, 40), passthrough: typeof b.passthrough === 'boolean' ? b.passthrough : undefined }));
    this.markRestart(id);
    return { ...this.motd(id), restartNeeded: this.mc.proc(id).isRunning() };
  }
  /** Changes in Geyser's settings apply after a restart – remember it for the page. */
  markRestart(id) {
    const s = this.mc.get(id);
    if (s.geyser && this.mc.proc(id).isRunning()) { s.geyser.restartNeeded = true; this.ctx.settings.save(); }
  }

  /** Newest build of a package: { build: "2.6.0-812", sha256 } */
  async latest(project, platform) {
    const j = await this.net.fetchJson(`${API}/${project}/versions/latest/builds/latest`);
    const d = j && j.downloads && j.downloads[platform];
    if (!d) throw new Error(this.t('{project} no longer offers a package for {platform}.', { project, platform }));
    return { build: `${j.version}-${j.build}`, sha256: d.sha256 || null };
  }
  fileName(project, platform) { return `${project === 'geyser' ? 'Geyser' : 'floodgate'}-${platform}.jar`; }

  async download(job, project, platform, dir, from, to, name = this.fileName(project, platform)) {
    const url = `${API}/${project}/versions/latest/builds/latest/downloads/${platform}`;
    let info = null;
    try { info = await this.latest(project, platform); } catch { /* load without checksum */ }
    const label = project === 'geyser' ? 'Geyser' : project === 'floodgate' ? 'Floodgate' : 'GeyserOptionalPack';
    await this.net.downloadFile(url, path.join(dir, name), { sha256: info && info.sha256 ? info.sha256 : undefined, onProgress: job && this.net.jobProgress ? this.net.jobProgress(job, this.t('Downloading {name}', { name: label }), from, to) : undefined });
    return { name, build: info ? info.build : null };
  }

  /* ---------------- Keeping itself up to date ---------------- */

  /** Look for new builds and download them into the staging folder; if the server is off, put them in place right away. */
  async checkUpdate(id) {
    const { t } = this;
    const s = this.mc.get(id);
    if (!s.geyser) return null;
    const sup = this.supported(s);
    if (!sup.ok) return null;
    const g = s.geyser;
    const want = { geyser: await this.latest('geyser', sup.geyser) };
    if (g.floodgate && sup.floodgate) want.floodgate = await this.latest('floodgate', sup.floodgate);
    g.checkedAt = Date.now();
    // The optional resource pack is not loaded while running – it is simply replaced and used from the next start
    if (g.optionalPack) await this.updateOptionalPack(id).catch(() => {});
    const have = g.builds || {};
    const changed = Object.keys(want).filter((k) => want[k].build !== have[k] && want[k].build !== (g.pending || {})[k]);
    if (!changed.length) {
      this.ctx.settings.save();
      if (this.ctx.keeper) this.ctx.keeper.note(`geyser-${id}`, { ok: true, label: `Geyser (${s.name})`, text: g.pending ? t('A new build waits for the next restart.') : t('Up to date (build {b}).', { b: have.geyser || '?' }) });
      return { upToDate: !g.pending, pending: g.pending || null };
    }
    const stage = path.join(this.mc.addonDir(id), STAGE);
    fs.mkdirSync(stage, { recursive: true });
    for (const k of changed) {
      const plat = k === 'geyser' ? sup.geyser : sup.floodgate;
      await this.net.downloadFile(`${API}/${k}/versions/latest/builds/latest/downloads/${plat}`, path.join(stage, this.fileName(k, plat)), { sha256: want[k].sha256 || undefined });
    }
    g.pending = { ...(g.pending || {}), ...Object.fromEntries(changed.map((k) => [k, want[k].build])) };
    this.ctx.settings.save();
    if (this.ctx.keeper) this.ctx.keeper.record(`geyser-${id}`, { ok: true, version: want.geyser.build, label: `Geyser (${s.name})`, text: t('New build downloaded: {list}.', { list: changed.map((k) => `${k} ${want[k].build}`).join(', ') }) });
    if (!this.mc.proc(id).isRunning()) this.applyStaged(id);
    return { pending: g.pending };
  }

  /** Put waiting builds in place – only while the server is stopped (Hostwerk calls this before every start). */
  applyStaged(id, log) {
    const s = this.mc.get(id);
    if (s.geyser && s.geyser.restartNeeded) { delete s.geyser.restartNeeded; this.ctx.settings.save(); }
    if (s.geyserOff) { delete s.geyserOff; this.ctx.settings.save(); }
    if (!s.geyser || !s.geyser.pending) return false;
    const dir = this.mc.addonDir(id);
    const stage = path.join(dir, STAGE);
    let files = [];
    try { files = fs.readdirSync(stage).filter((f) => JAR.test(f)); } catch { /* nothing there */ }
    for (const f of files) {
      const kind = /^geyser/i.test(f) ? /^geyser/i : /^floodgate/i;
      for (const old of fs.readdirSync(dir).filter((x) => JAR.test(x) && kind.test(x))) fs.rmSync(path.join(dir, old), { force: true });
      fs.renameSync(path.join(stage, f), path.join(dir, f));
    }
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* ignore */ }
    s.geyser.builds = { ...(s.geyser.builds || {}), ...s.geyser.pending };
    delete s.geyser.pending;
    this.ctx.settings.save();
    if (log) log(this.t('Geyser updated (build {b}) – Bedrock players with the newest app can join.', { b: s.geyser.builds.geyser }));
    return true;
  }

  /** A running server with a waiting update and nobody online: restart it. */
  async applyWhenEmpty() {
    for (const s of this.mc.list()) {
      if (!s.geyser || !s.geyser.pending) continue;
      const p = this.mc.proc(s.id);
      if (!p.isRunning() || !p.extra.ready || (p.extra.players || []).length) continue;
      await this.mc.restart(s.id).catch(() => {});
      this.host.broadcast({ type: 'toast', kind: 'info', text: this.t('{name}: Geyser updated (nobody was online).', { name: s.name }) });
    }
  }

  async checkAll() {
    for (const s of this.mc.list()) {
      if (!s.geyser) continue;
      try { await this.checkUpdate(s.id); } catch (e) { if (this.ctx.keeper) this.ctx.keeper.record(`geyser-${s.id}`, { ok: false, label: `Geyser (${s.name})`, text: this.t('Update check failed: {msg}', { msg: e.message }) }); }
    }
  }

  /**
   * Wait for Geyser's settings after a start: as long as the server keeps running and has not been ready for long –
   * not a fixed time (big servers need minutes). Gives up when the server stops (crash) or after FIRST_START_MAX.
   */
  async waitForConfig(id, { step = 500, max = FIRST_START_MAX, grace = 60000 } = {}) {
    const t0 = Date.now();
    let readyAt = null;
    for (;;) {
      const file = this.configFile(id);
      if (file) return file;
      const p = this.mc.proc(id);
      if (!p.isRunning()) return null;
      if (p.extra && p.extra.ready && !readyAt) readyAt = Date.now();
      if (readyAt && Date.now() - readyAt > grace) return null;
      if (Date.now() - t0 > max) return null;
      await sleep(step);
    }
  }

  enable(id, { floodgate = true } = {}) {
    const { t } = this;
    const s = this.mc.get(id);
    const sup = this.supported(s);
    if (!sup.ok) throw this.host.error(400, sup.why);
    return this.net.runJob(t('Allow Bedrock players on “{name}”', { name: s.name }), async (job) => {
      const dir = this.mc.addonDir(id);
      const wasRunning = this.mc.proc(id).isRunning();
      fs.mkdirSync(dir, { recursive: true });
      try {
        for (const f of fs.readdirSync(dir).filter((x) => JAR.test(x))) fs.rmSync(path.join(dir, f), { force: true });
        const gb = await this.download(job, 'geyser', sup.geyser, dir, 5, 40);
        const fg = floodgate && sup.floodgate;
        const fb = fg ? await this.download(job, 'floodgate', sup.floodgate, dir, 40, 60) : null;
        const port = await this.freePort(id);
        s.geyser = { port, floodgate: !!fg, at: Date.now(), builds: { geyser: gb.build, ...(fb ? { floodgate: fb.build } : {}) } };
        delete s.geyserOff;
        this.ctx.settings.save();
        // Start once so Geyser creates its configuration – then adjust it and restart
        job.progress(65, t('Starting the server so Geyser creates its settings …'));
        if (wasRunning) await this.mc.restart(id); else await this.mc.start(id);
        const file = await this.waitForConfig(id);
        if (!file) throw new Error(t('Geyser did not create its settings – check the console.'));
        this.patchConfig(file, { port, floodgate: fg });
        // Velocity: Floodgate also on every backend, with the proxy's key
        if (fg && s.type === 'velocity') { job.progress(80, t('Setting up Floodgate on the backend servers …'));
          for (const r of await this.syncBackends(id, job)) job.log(r.ok ? t('{name}: Floodgate and key ready{restart}', { name: r.name, restart: r.restart ? t(' – restart it') : '' }) : `${r.name}: ${r.why}`);
        }
        job.progress(88, t('Restarting …'));
        await this.mc.restart(id);
        if (!wasRunning) { await this.waitReady(id); await this.mc.stop(id); }
        // Forward the port in the router if automatic forwarding is on (extension "Router & port forwarding")
        if (this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto) await this.ctx.router.sync().catch(() => {});
        const lan = this.lanHost();
        return { port, floodgate: !!fg, address: lan ? `${lan}:${port}` : null };
      } catch (e) {
        // Do not stay half on: remove what was added and leave the server as it was
        await this.cleanup(id).catch(() => {});
        if (!wasRunning && this.mc.proc(id).isRunning()) await this.mc.stop(id).catch(() => {});
        throw e;
      }
    }, { key: `geyser-${id}` });
  }

  async waitReady(id, max = FIRST_START_MAX) {
    const t0 = Date.now();
    while (Date.now() - t0 < max) { const p = this.mc.proc(id); if (!p.isRunning() || (p.extra && p.extra.ready)) return; await sleep(500); }
  }

  /* ---------------- Velocity: Floodgate on the backends ---------------- */

  keyFile(id) { return path.join(this.mc.addonDir(id), 'floodgate', 'key.pem'); }
  hasKey(id) {
    try { const src = this.mc.get(id).network && this.mc.get(id).network.proxy; return !!src && fs.readFileSync(this.keyFile(id)).equals(fs.readFileSync(this.keyFile(src))); } catch { return false; }
  }

  /**
   * Floodgate on every backend of a Velocity proxy (Paper/Spigot/Purpur/Folia) plus the proxy's key.pem; proxy sends the
   * Floodgate data. The key appears at the proxy's first start with Floodgate. Returns [{ id, name, ok, why }].
   */
  async syncBackends(id, job) {
    const s = this.mc.get(id);
    if (!s.geyser || !s.geyser.floodgate || s.type !== 'velocity') return [];
    let key = null;
    for (let i = 0; i < 120 && !(key = fs.existsSync(this.keyFile(id)) ? this.keyFile(id) : null); i++) await sleep(500);
    if (!key) throw new Error(this.t('Floodgate on the proxy has not created its key yet – start the proxy once.'));
    const cfg = path.join(this.mc.addonDir(id), 'floodgate', 'config.yml');
    if (fs.existsSync(cfg)) fs.writeFileSync(cfg, patchSendDataText(fs.readFileSync(cfg, 'utf8'), true));
    const out = [];
    const installed = new Set(s.geyser.backends || []);
    for (const b of this.backends(id)) {
      const plat = PLATFORM[b.type] && PLATFORM[b.type][1];
      if (!plat || plat === 'velocity') { out.push({ id: b.id, name: b.name, ok: false, why: this.t('No Floodgate for this server type – Bedrock players cannot join it.') }); continue; }
      const dir = this.mc.addonDir(b.id);
      fs.mkdirSync(path.join(dir, 'floodgate'), { recursive: true });
      if (!fs.readdirSync(dir).some((f) => /^floodgate[-_].*\.jar$/i.test(f))) { await this.download(job, 'floodgate', plat, dir); installed.add(b.id); }
      fs.copyFileSync(key, path.join(dir, 'floodgate', 'key.pem'));
      out.push({ id: b.id, name: b.name, ok: true, restart: this.mc.proc(b.id).isRunning() });
    }
    s.geyser.backends = [...installed];
    this.ctx.settings.save();
    return out;
  }

  /* ---------------- GeyserOptionalPack ---------------- */

  packsDir(id) { const f = this.configFile(id); return f ? path.join(path.dirname(f), 'packs') : null; }
  async setOptionalPack(id, on) {
    const s = this.mc.get(id);
    if (!s.geyser) throw this.host.error(409, 'Switch on Bedrock players first.');
    if (on) { s.geyser.optionalPack = true; await this.updateOptionalPack(id); } else {
      delete s.geyser.optionalPack;
      const dir = this.packsDir(id);
      if (dir) fs.rmSync(path.join(dir, OPTIONAL_PACK.file), { force: true });
    }
    this.markRestart(id);
    this.ctx.settings.save();
    return this.status(id);
  }
  async updateOptionalPack(id) {
    const s = this.mc.get(id);
    const dir = this.packsDir(id);
    if (!dir) throw this.host.error(409, 'Geyser has not created its settings yet – start the server once.');
    const info = await this.latest(OPTIONAL_PACK.project, OPTIONAL_PACK.platform).catch(() => null);
    if (info && s.geyser.builds && s.geyser.builds.optionalPack === info.build && fs.existsSync(path.join(dir, OPTIONAL_PACK.file))) return false;
    fs.mkdirSync(dir, { recursive: true });
    await this.download(null, OPTIONAL_PACK.project, OPTIONAL_PACK.platform, dir, 0, 0, OPTIONAL_PACK.file);
    s.geyser.builds = { ...(s.geyser.builds || {}), optionalPack: info ? info.build : null };
    return true;
  }

  /* ---------------- Switching off ---------------- */

  /** Packages, settings folders and waiting updates away (the server's own files stay). */
  async cleanup(id) {
    const s = this.mc.get(id);
    const dir = this.mc.addonDir(id);
    try { for (const f of fs.readdirSync(dir).filter((x) => JAR.test(x))) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(dir, STAGE), { recursive: true, force: true }); } catch { /* ignore */ }
    const roots = [dir, path.join(this.mc.dir(id), 'config')];
    for (const r of roots) for (const c of CONFIG_DIRS) { try { fs.rmSync(path.join(r, c), { recursive: true, force: true }); } catch { /* ignore */ } }
    // Floodgate the bridge put onto backends of a proxy
    for (const bid of (s.geyser && s.geyser.backends) || []) {
      const b = this.mc.get(bid);
      if (!b || b.geyser) continue; // a backend with its own bridge keeps Floodgate
      const bd = this.mc.addonDir(bid);
      try { for (const f of fs.readdirSync(bd).filter((x) => /^floodgate[-_].*\.jar$/i.test(x))) fs.rmSync(path.join(bd, f), { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(bd, 'floodgate'), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    delete s.geyser;
    this.ctx.settings.save();
  }

  async disable(id) {
    const s = this.mc.get(id);
    const running = this.mc.proc(id).isRunning();
    await this.cleanup(id);
    // A running server keeps the loaded plugin until it restarts – the page says so and offers the restart
    if (running) s.geyserOff = { restartNeeded: true, at: Date.now() }; else delete s.geyserOff;
    this.ctx.settings.save();
    if (this.ctx.router && this.ctx.router.cfg && this.ctx.router.cfg.auto) await this.ctx.router.sync().catch(() => {});
    return { ...this.status(id), restartNeeded: running };
  }
}

module.exports = { Geyser, PLATFORM, patchConfigText, patchMotdText, readMotd, patchSendDataText, lanIp, udpFree, JAR, STAGE, CONFIG_DIRS, OPTIONAL_PACK };
