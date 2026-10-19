import { useState } from 'react';
import { Gamepad2, Trash2, Smartphone, RefreshCw, Copy, ArrowRight, Box } from 'lucide-react';
import { post, del, useApi, useStore, waitJob, fmtDate } from '@hostwerk/api';
import { Btn, Empty, Loading, InfoTip, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';

/*
 * Bedrock bridge: phone and console players on Java servers (Geyser + Floodgate).
 * A row in every Minecraft server's "Connect" box (slot "mc.connect") and a page with all servers at a glance.
 */

/** Row for one server: switch on with one click, show port and address, switch off. */
export function BedrockShare({ s }) {
  const b = useApi(`/mc/servers/${s.id}/bedrock`, [s.type], { live: false, poll: true });
  const [busy, setBusy] = useState(false);
  const jobs = useStore((x) => x.jobs);
  const [job, setJob] = useState(null);
  if (!b.data) return null;
  const d = b.data;
  if (!d.supported) return <div className="tiny muted">{t('Bedrock players (phone, console): {why}', { why: d.why })}</div>;
  if (d.enabled) {
    return (
      <div className="bedrock-row">
        <Smartphone size={15} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="small"><b>Bedrock players</b> · {t('Port {port} (UDP)', { port: d.port })}{d.floodgate ? ` · ${t('without a Java account')}` : ''}</div>
          <div className="tiny muted">{t('In Minecraft Bedrock: Add server → address of this PC, port {port}', { port: d.port })}</div>
        </div>
        <Btn className="ghost xs" icon={Trash2} busy={busy} onClick={async () => {
          if (!(await confirmDialog({ title: 'Switch off Bedrock players?', text: 'Geyser and Floodgate are removed.', confirm: 'Switch off' }))) return;
          setBusy(true); try { b.setData(await del(`/mc/servers/${s.id}/bedrock`)); } catch (e) { toast.error(e); } setBusy(false);
        }}>Switch off</Btn>
      </div>
    );
  }
  const j = job && jobs && jobs[job];
  return (
    <div className="stack" style={{ gap: 6 }}>
      <Btn className="sm" icon={Gamepad2} busy={busy} onClick={async () => {
        setBusy(true);
        try { const r = await post(`/mc/servers/${s.id}/bedrock`, { floodgate: true }); setJob(r.job); const res = await waitJob(r.job); toast.success(t('Bedrock players can now join on port {port}', { port: res.result ? res.result.port : 19132 })); b.reload(); } catch (e) { toast.error(e); }
        setBusy(false); setJob(null);
      }}>Allow phone & console players (Bedrock)</Btn>
      {j && <div className="tiny muted">{j.text}</div>}
    </div>
  );
}

function BedrockPage() {
  const d = useApi('/bedrock', [], { live: false, poll: true });
  const [busy, setBusy] = useState(null);
  const update = async (id) => { setBusy(id); try { await post(`/mc/servers/${id}/bedrock/update`); d.reload(); toast.success('Checked for updates'); } catch (e) { toast.error(e); } setBusy(null); };
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Smartphone /> Bedrock bridge</h1>
          <p>Friends on phones, consoles and the Windows edition play on your Java servers – Geyser and Floodgate with one click.</p>
        </div>
        <div className="actions">
          <InfoTip title="How it works">Geyser translates between Bedrock and Java, Floodgate lets Bedrock players in without a Java account. Hostwerk picks a free UDP port (19132, 19133 …), sets everything up and keeps both up to date: new builds are downloaded in the background and put in place at the next restart – or right away when nobody is online.</InfoTip>
        </div>
      </div>
      {!d.data ? <Loading /> : d.data.length === 0 ? <Empty icon={Box} title="No Minecraft servers yet" text="Create a Minecraft server first – then allow Bedrock players here." action={<a className="btn primary" href="#/mc">Minecraft</a>} /> : (
        <div className="grid grid-2">
          {d.data.map((s) => (
            <div key={s.id} className="card">
              <div className="card-head"><Box size={16} /><h3 className="ellipsis">{s.name}</h3><span className="badge">{s.type}</span>
                <div className="right">{s.enabled ? <span className="badge ok">Bedrock on</span> : s.supported ? <span className="badge">off</span> : <span className="badge warn">not possible</span>}</div>
              </div>
              <div className="card-body stack" style={{ gap: 8 }}>
                {s.enabled && (
                  <div className="row-tight"><code className="grow ellipsis">{s.address}</code><button type="button" className="btn ghost xs icon" aria-label="Copy address" title="Copy address" onClick={() => { navigator.clipboard.writeText(s.address); toast.success('Address copied'); }}><Copy /></button></div>
                )}
                {s.enabled && <div className="tiny muted">{[s.build && t('Build {b}', { b: s.build }), s.pending && t('build {b} waits for the next restart', { b: s.pending }), s.checkedAt && t('checked {when}', { when: fmtDate(s.checkedAt) })].filter(Boolean).join(' · ')}</div>}
                <BedrockShare s={s} />
                <div className="row-tight">
                  {s.enabled && <Btn className="xs ghost" icon={RefreshCw} busy={busy === s.id} onClick={() => update(s.id)}>Check for updates</Btn>}
                  <a className="btn xs ghost" href={`#/mc/${encodeURIComponent(s.id)}`}><ArrowRight size={12} />Open server</a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default {
  pages: { main: BedrockPage },
  slots: { 'mc.connect': [{ id: 'bedrock', title: 'Bedrock players', Component: BedrockShare, order: 60 }] },
};
