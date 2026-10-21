'use strict';
/*
 * Native part of the Bedrock bridge (SDK 2.7). Hooks into Hostwerk's Minecraft manager as "minecraft.geyser" – Hostwerk calls
 * applyStaged() before every server start, so waiting Geyser updates land while the server is off.
 *   GET    /api/mc/servers/:id/bedrock               state of one server (with prefix and Bedrock players online)
 *   POST   /api/mc/servers/:id/bedrock               switch on (job)       DELETE … switch off (cleans up completely)
 *   POST   /api/mc/servers/:id/bedrock/update        look for a new build now
 *   GET    /api/mc/servers/:id/bedrock/address       addresses for friends at home and outside
 *   GET    /api/mc/servers/:id/bedrock/motd          Bedrock server list entry   PUT … change it
 *   PUT    /api/mc/servers/:id/bedrock/optional-pack { on } GeyserOptionalPack on/off
 *   POST   /api/mc/servers/:id/bedrock/backends      Velocity: Floodgate + key on all backends again
 *   GET    /api/bedrock                              { replacedBy, servers } – all servers at a glance (extension page)
 * Service "bedrock" for Hostwerk and other extensions: isBedrock(serverId, playerName), status(serverId).
 *
 * 1.2: replaced by the extension "Minecraft server network" (mc-network) – same data, Geyser once on the proxy, Bedrock
 * Dedicated Server, version bridges, networks. As soon as mc-network is installed this extension steps aside completely
 * (no timers, no routes except GET /bedrock with the hint, minecraft.geyser belongs to mc-network). Until then it keeps
 * working as before, so nothing breaks before the move.
 */
const { Geyser } = require('./geyser');

let geyser = null;

/** Is the successor there? (installed, or already active as minecraft.geyser) */
function replaced(host) {
  try { if (host.ctx.extMarket && host.ctx.extMarket.list().some((e) => e.id === 'mc-network' && !e.error)) return true; } catch { /* older Hostwerk */ }
  const g = host.ctx.minecraft && host.ctx.minecraft.geyser;
  return !!(g && g.constructor && g.constructor.name === 'Bedrock');
}

function activate(host) {
  const mc = host.ctx.minecraft;
  if (replaced(host)) {
    // Step aside: the page only says where everything is now
    host.router.get('/bedrock', (req, res) => res.json({ replacedBy: 'mc-network', servers: [] }));
    return;
  }
  const dl = host.core('download');
  geyser = new Geyser(host, mc, { downloadFile: dl.downloadFile, fetchJson: dl.fetchJson, jobProgress: dl.jobProgress, runJob: host.core('jobs').runJob });
  mc.geyser = geyser;
  host.provide('bedrock', {
    status: (id) => geyser.status(id),
    /** Is this player a Bedrock player (Floodgate name prefix)? – for marking them in player lists */
    isBedrock: (id, name) => { try { const s = mc.get(id); if (!s || !s.geyser || !s.geyser.floodgate) return false; return String(name || '').startsWith(geyser.prefix(id)); } catch { return false; } },
  });
  const r = host.router;
  const changed = () => host.broadcast({ type: 'mc' }); // other open views (server page, connect box) reload
  r.get('/bedrock', (req, res) => res.json({ replacedBy: null, servers: geyser.overview() }));
  r.get('/mc/servers/:id/bedrock', (req, res) => res.json(geyser.status(req.params.id)));
  r.post('/mc/servers/:id/bedrock', (req, res) => res.json({ job: geyser.enable(req.params.id, req.body || {}).id }));
  r.delete('/mc/servers/:id/bedrock', async (req, res) => { const out = await geyser.disable(req.params.id); changed(); res.json(out); });
  r.post('/mc/servers/:id/bedrock/update', async (req, res) => { await geyser.checkUpdate(req.params.id); res.json(geyser.status(req.params.id)); });
  r.get('/mc/servers/:id/bedrock/address', async (req, res) => res.json(await geyser.addresses(req.params.id)));
  r.get('/mc/servers/:id/bedrock/motd', (req, res) => res.json(geyser.motd(req.params.id)));
  r.put('/mc/servers/:id/bedrock/motd', (req, res) => res.json(geyser.setMotd(req.params.id, req.body || {})));
  r.put('/mc/servers/:id/bedrock/optional-pack', async (req, res) => res.json(await geyser.setOptionalPack(req.params.id, !!(req.body || {}).on)));
  r.post('/mc/servers/:id/bedrock/backends', async (req, res) => res.json({ backends: await geyser.syncBackends(req.params.id, null), status: geyser.status(req.params.id) }));
}

function deactivate(host) {
  if (geyser) geyser.stop();
  const mc = host && host.ctx ? host.ctx.minecraft : null;
  if (mc && mc.geyser === geyser) delete mc.geyser;
  geyser = null;
}

module.exports = { activate, deactivate };
