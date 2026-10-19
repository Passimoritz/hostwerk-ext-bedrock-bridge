'use strict';
/*
 * Native part of the Bedrock bridge (SDK 2.7). Hooks into Hostwerk's Minecraft manager as "minecraft.geyser" – Hostwerk calls
 * applyStaged() before every server start, so waiting Geyser updates land while the server is off.
 *   GET    /api/mc/servers/:id/bedrock          state of one server
 *   POST   /api/mc/servers/:id/bedrock          switch on (job)       DELETE … switch off
 *   POST   /api/mc/servers/:id/bedrock/update   look for a new build now
 *   GET    /api/bedrock                         all servers at a glance (extension page)
 */
const { Geyser } = require('./geyser');

let geyser = null;

function activate(host) {
  const mc = host.ctx.minecraft;
  const dl = host.core('download');
  geyser = new Geyser(host, mc, { downloadFile: dl.downloadFile, fetchJson: dl.fetchJson, jobProgress: dl.jobProgress, runJob: host.core('jobs').runJob });
  mc.geyser = geyser;
  const r = host.router;
  r.get('/bedrock', (req, res) => res.json(geyser.overview()));
  r.get('/mc/servers/:id/bedrock', (req, res) => res.json(geyser.status(req.params.id)));
  r.post('/mc/servers/:id/bedrock', (req, res) => res.json({ job: geyser.enable(req.params.id, req.body || {}).id }));
  r.delete('/mc/servers/:id/bedrock', async (req, res) => res.json(await geyser.disable(req.params.id)));
  r.post('/mc/servers/:id/bedrock/update', async (req, res) => { await geyser.checkUpdate(req.params.id); res.json(geyser.status(req.params.id)); });
}

function deactivate(host) {
  if (geyser) geyser.stop();
  const mc = host && host.ctx ? host.ctx.minecraft : null;
  if (mc && mc.geyser === geyser) delete mc.geyser;
  geyser = null;
}

module.exports = { activate, deactivate };
