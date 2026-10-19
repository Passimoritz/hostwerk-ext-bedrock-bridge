'use strict';
/*
 * Bedrock players (phone, console, Windows edition) on Java servers: Geyser translates the Bedrock protocol, Floodgate allows
 * Bedrock accounts without a Java account. One click: download the matching packages (Paper/Spigot/Purpur/Folia, Velocity,
 * Fabric, NeoForge), set the configuration (own UDP port, auth-type floodgate), open the port in the firewall and router
 * (through the public ports). Switching it off puts everything back.
 *
 * Keeps itself up to date: Geyser has to match the current Bedrock version (Bedrock updates every few weeks). The extension
 * checks the download API at start and every 6 hours, downloads new builds into a staging folder (checksum) and puts them
 * in place at the next server start. If the server is running, it restarts it as soon as nobody is online.
 * Data stays where it always was: the "geyser" entry of each Minecraft server in Hostwerk's settings.
 */
const fs = require('fs');
const path = require('path');

const API = 'https://download.geysermc.org/v2/projects';
/** Server type → Geyser package, Floodgate package (null = none) */
const PLATFORM = {
  paper: ['spigot', 'spigot'], purpur: ['spigot', 'spigot'], spigot: ['spigot', 'spigot'], folia: ['spigot', 'spigot'],
  velocity: ['velocity', 'velocity'], fabric: ['fabric', null], neoforge: ['neoforge', null],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JAR = /^(geyser|floodgate)[-_].*\.jar$/i;
const STAGE = '.hostwerk-neu';

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

class Geyser {
  /** host: extension host · mc: Hostwerk's Minecraft manager · net: { downloadFile, fetchJson, jobProgress, runJob } */
  constructor(host, mc, net) {
    this.host = host; this.ctx = host.ctx; this.t = host.t; this.mc = mc; this.net = net;
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
  /** Free Bedrock port: 19132, with several servers 19133 … */
  freePort(id) {
    const used = new Set(this.mc.list().filter((x) => x.id !== id && x.geyser).map((x) => x.geyser.port));
    let p = 19132;
    while (used.has(p)) p++;
    return p;
  }
  status(id) {
    const s = this.mc.get(id);
    const sup = this.supported(s);
    const dir = this.mc.addonDir(id);
    let jars = [];
    try { jars = fs.readdirSync(dir).filter((f) => JAR.test(f)); } catch { /* no folder yet */ }
    const g = s.geyser || {};
    return { id, name: s.name, type: s.type, supported: sup.ok, why: sup.why || null, enabled: !!s.geyser, port: s.geyser ? g.port : null, floodgate: !!g.floodgate, jars, address: s.geyser ? `${this.publicHost()}:${g.port}` : null,
      build: g.builds ? g.builds.geyser : null, pending: g.pending ? g.pending.geyser : null, checkedAt: g.checkedAt || null, running: this.mc.proc(id).isRunning() };
  }
  overview() { return this.mc.list().map((s) => this.status(s.id)); }
  publicHost() { const r = this.ctx.router && this.ctx.router.cache && this.ctx.router.cache.igd; return (r && r.localIp) || this.t('address-of-this-PC'); }

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

  /** Newest build of a package: { build: "2.6.0-812", sha256 } */
  async latest(project, platform) {
    const j = await this.net.fetchJson(`${API}/${project}/versions/latest/builds/latest`);
    const d = j && j.downloads && j.downloads[platform];
    if (!d) throw new Error(this.t('{project} no longer offers a package for {platform}.', { project, platform }));
    return { build: `${j.version}-${j.build}`, sha256: d.sha256 || null };
  }
  fileName(project, platform) { return `${project === 'geyser' ? 'Geyser' : 'floodgate'}-${platform}.jar`; }

  async download(job, project, platform, dir, from, to) {
    const url = `${API}/${project}/versions/latest/builds/latest/downloads/${platform}`;
    const name = this.fileName(project, platform);
    let info = null;
    try { info = await this.latest(project, platform); } catch { /* load without checksum */ }
    await this.net.downloadFile(url, path.join(dir, name), { sha256: info && info.sha256 ? info.sha256 : undefined, onProgress: job ? this.net.jobProgress(job, this.t('Downloading {name}', { name: project === 'geyser' ? 'Geyser' : 'Floodgate' }), from, to) : undefined });
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

  enable(id, { floodgate = true } = {}) {
    const { t } = this;
    const s = this.mc.get(id);
    const sup = this.supported(s);
    if (!sup.ok) throw this.host.error(400, sup.why);
    return this.net.runJob(t('Allow Bedrock players on “{name}”', { name: s.name }), async (job) => {
      const dir = this.mc.addonDir(id);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir).filter((x) => JAR.test(x))) fs.rmSync(path.join(dir, f), { force: true });
      const gb = await this.download(job, 'geyser', sup.geyser, dir, 5, 45);
      const fg = floodgate && sup.floodgate;
      const fb = fg ? await this.download(job, 'floodgate', sup.floodgate, dir, 45, 65) : null;
      const port = (s.geyser && s.geyser.port) || this.freePort(id);
      s.geyser = { port, floodgate: !!fg, at: Date.now(), builds: { geyser: gb.build, ...(fb ? { floodgate: fb.build } : {}) } };
      this.ctx.settings.save();
      // Start once so Geyser creates its configuration – then adjust it and restart
      const wasRunning = this.mc.proc(id).isRunning();
      job.progress(70, t('Starting the server so Geyser creates its settings …'));
      if (wasRunning) await this.mc.restart(id); else await this.mc.start(id);
      let file = null;
      for (let i = 0; i < 240 && !(file = this.configFile(id)); i++) await sleep(500);
      if (!file) throw new Error(t('Geyser did not create its settings – check the console.'));
      this.patchConfig(file, { port, floodgate: fg });
      job.progress(88, t('Restarting …'));
      await this.mc.restart(id);
      if (!wasRunning) { for (let i = 0; i < 240 && !this.mc.proc(id).extra.ready && this.mc.proc(id).isRunning(); i++) await sleep(500); await this.mc.stop(id); }
      // Forward the port in the router if automatic forwarding is on (extension "Router & port forwarding")
      if (this.ctx.router && this.ctx.router.cfg.auto) await this.ctx.router.sync().catch(() => {});
      return { port, floodgate: !!fg, address: `${this.publicHost()}:${port}` };
    }, { key: `geyser-${id}` });
  }

  async disable(id) {
    const s = this.mc.get(id);
    const dir = this.mc.addonDir(id);
    try { for (const f of fs.readdirSync(dir).filter((x) => JAR.test(x))) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
    delete s.geyser;
    this.ctx.settings.save();
    if (this.ctx.router && this.ctx.router.cfg.auto) await this.ctx.router.sync().catch(() => {});
    return this.status(id);
  }
}

module.exports = { Geyser, PLATFORM, patchConfigText, JAR, STAGE };
