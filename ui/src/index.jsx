import { useEffect, useState } from 'react';
import { Gamepad2, Trash2, Smartphone, RefreshCw, Copy, ArrowRight, Box, RotateCw, CloudOff, Type, Network, BookOpen } from 'lucide-react';
import { get, post, put, del, useApi, useStore, waitJob } from '@hostwerk/api';
import { ArrowRightLeft } from 'lucide-react';
import { Btn, Empty, Loading, InfoTip, Seg, Switch, SettingRow, Callout, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Bedrock bridge: phone and console players on Java servers (Geyser + Floodgate).
 * A row in every Minecraft server's "Connect" box (slot "mc.connect") and a page with all servers at a glance:
 * addresses for friends at home and outside, Bedrock server list entry, GeyserOptionalPack, Velocity backends, a guide
 * per platform. Dates follow Hostwerk's language (document language), not the system.
 */
const locale = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'en';
const when = (ts) => new Date(ts).toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const copy = (text) => { navigator.clipboard.writeText(text).then(() => toast.success('Address copied'), () => toast.error('Could not copy')); };

/** Restart offer after switching off or changing Geyser's settings while the server runs. */
function RestartNote({ id, done }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="bedrock-note">
      <span className="grow small">The server still has the old state loaded – it applies after a restart.</span>
      <Btn className="xs" icon={RotateCw} busy={busy} onClick={async () => { setBusy(true); try { await post(`/mc/servers/${encodeURIComponent(id)}/restart`); toast.success('Server restarted'); if (done) done(); } catch (e) { toast.error(e); } setBusy(false); }}>Restart now</Btn>
    </div>
  );
}

/** Where friends connect: at home (LAN address) and from outside (domain or public IP) – as sentences, with copy. */
function Addresses({ id, port }) {
  const [a, setA] = useState(null);
  useEffect(() => { let alive = true; get(`/mc/servers/${encodeURIComponent(id)}/bedrock/address`).then((x) => { if (alive) setA(x); }).catch(() => { if (alive) setA({}); }); return () => { alive = false; }; }, [id, port]);
  if (!a) return <div className="tiny muted">Looking up the addresses …</div>;
  return (
    <div className="stack bedrock-addresses">
      {a.lan && (
        <div className="row-tight">
          <span className="grow small">{t('At home (same Wi-Fi): Add server → address {host}, port {port}', { host: a.lan, port: a.port })}</span>
          <button type="button" className="btn ghost xs icon" aria-label="Copy home address" title="Copy home address" onClick={() => copy(`${a.lan}:${a.port}`)}><Copy /></button>
        </div>
      )}
      {a.outside ? (
        <div className="row-tight">
          <span className="grow small">{t('Friends outside: address {host}, port {port}', { host: a.outside, port: a.port })}
            {' '}<InfoTip title="Reachable from outside">{a.routerAuto ? t('The router forwards UDP port {port} by itself (Router & port forwarding).', { port: a.port }) : t('UDP port {port} has to be forwarded to this PC in the router – the extension “Router & port forwarding” can do that by itself.', { port: a.port })}</InfoTip></span>
          <button type="button" className="btn ghost xs icon" aria-label="Copy outside address" title="Copy outside address" onClick={() => copy(`${a.outside}:${a.port}`)}><Copy /></button>
        </div>
      ) : <div className="tiny muted">The address for friends outside is not known yet (no internet connection or DynDNS).</div>}
    </div>
  );
}

/** Row for one server: switch on with one click, show port and addresses, switch off. */
export function BedrockShare({ s }) {
  const b = useApi(`/mc/servers/${s.id}/bedrock`, [s.type], { live: false, poll: true });
  const [busy, setBusy] = useState(false);
  const jobs = useStore((x) => x.jobs);
  const [job, setJob] = useState(null);
  // Replaced by mc-network (1.2): the route is gone – the successor shows its own row in this box
  if (!b.data) return null;
  const d = b.data;
  if (!d.supported) return <div className="tiny muted">{t('Bedrock players (phone, console): {why}', { why: d.why })}</div>;
  if (d.enabled) {
    return (
      <div className="stack bedrock-share">
        <div className="bedrock-row">
          <Smartphone size={15} />
          <div className="grow bedrock-min">
            <div className="small"><b>Bedrock players</b> · {t('Port {port} (UDP)', { port: d.port })}{d.floodgate ? ` · ${t('without a Java account')}` : ''}</div>
          </div>
          <Btn className="ghost xs" icon={Trash2} busy={busy} onClick={async () => {
            if (!(await confirmDialog({ title: 'Switch off Bedrock players?', text: 'Geyser and Floodgate are removed together with their settings and waiting updates.', confirm: 'Switch off' }))) return;
            setBusy(true); try { b.setData(await del(`/mc/servers/${s.id}/bedrock`)); } catch (e) { toast.error(e); } setBusy(false);
          }}>Switch off</Btn>
        </div>
        <Addresses id={s.id} port={d.port} />
        {d.restartNeeded && <RestartNote id={s.id} done={() => b.reload()} />}
      </div>
    );
  }
  const j = job && jobs && jobs[job];
  return (
    <div className="stack bedrock-share">
      {d.restartNeeded && <RestartNote id={s.id} done={() => b.reload()} />}
      <Btn className="sm" icon={Gamepad2} busy={busy} onClick={async () => {
        setBusy(true);
        try { const r = await post(`/mc/servers/${s.id}/bedrock`, { floodgate: true }); setJob(r.job); const res = await waitJob(r.job); toast.success(t('Bedrock players can now join on port {port}', { port: res.result ? res.result.port : 19132 })); b.reload(); } catch (e) { toast.error(e); }
        setBusy(false); setJob(null);
      }}>Allow phone & console players (Bedrock)</Btn>
      {j && <div className="tiny muted">{j.text}</div>}
    </div>
  );
}

/** Bedrock server list entry: two MOTD lines and the server name – or the Java MOTD (passthrough). */
function MotdEditor({ s, onSaved }) {
  const m = useApi(`/mc/servers/${s.id}/bedrock/motd`, [s.id], { live: false, poll: false });
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (m.data) setF(m.data); }, [m.data]);
  if (m.error) return <div className="tiny muted row-tight">{m.error}<button type="button" className="btn ghost xs" onClick={() => m.reload()}>Try again</button></div>;
  if (!f) return <div className="tiny muted row-tight"><span className="hw-spinner hw-sm" aria-hidden="true" /> Loading …</div>;
  if (!f.available) return <div className="tiny muted">Start the server once – then Geyser has its settings and you can change the entry here.</div>;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="stack bedrock-motd">
      <SettingRow title="Use the Java MOTD" text="Bedrock players see the same text as Java players."><Switch checked={!!f.passthrough} onChange={(v) => setF({ ...f, passthrough: v })} /></SettingRow>
      {!f.passthrough && <>
        <input className="input sm" maxLength={80} aria-label="First line" placeholder="First line" value={f.motd1} onChange={set('motd1')} />
        <input className="input sm" maxLength={80} aria-label="Second line" placeholder="Second line" value={f.motd2} onChange={set('motd2')} />
      </>}
      <input className="input sm" maxLength={40} aria-label="Server name (Bedrock)" placeholder="Server name (Bedrock)" value={f.serverName} onChange={set('serverName')} />
      <div className="row-tight"><Btn className="xs" busy={busy} onClick={async () => {
        setBusy(true);
        try { const r = await put(`/mc/servers/${s.id}/bedrock/motd`, f); setF(r); toast.success(r.restartNeeded ? 'Saved – applies after a restart' : 'Saved'); if (onSaved) onSaved(); } catch (e) { toast.error(e); }
        setBusy(false);
      }}>Save</Btn></div>
    </div>
  );
}

/** Velocity proxy: Floodgate and the key on every backend server. */
function Backends({ s, reload }) {
  const [busy, setBusy] = useState(false);
  const list = s.backends || [];
  return (
    <div className="stack bedrock-backends">
      {list.length === 0 ? <div className="tiny muted">No backend servers in this network yet.</div> : list.map((b) => (
        <div key={b.id} className="row-tight small">
          <span className={`badge ${b.key ? 'ok' : b.supported ? 'warn' : 'err'}`}>{b.key ? 'key ok' : b.supported ? 'key missing' : 'not possible'}</span>
          <span className="grow ellipsis">{b.name}</span>
        </div>
      ))}
      <div className="row-tight"><Btn className="xs ghost" icon={Network} busy={busy} onClick={async () => {
        setBusy(true);
        try { const r = await post(`/mc/servers/${s.id}/bedrock/backends`); const bad = r.backends.filter((x) => !x.ok); if (bad.length) toast.error(bad.map((x) => `${x.name}: ${x.why}`).join(' · ')); else toast.success('Floodgate is ready on all backends – restart them'); reload(); } catch (e) { toast.error(e); }
        setBusy(false);
      }}>Sync backends</Btn></div>
    </div>
  );
}

/** Guide per platform: phones and Windows add servers directly, consoles need a detour. */
const PLATFORMS = [
  { id: 'phone', label: 'Phone & tablet' },
  { id: 'windows', label: 'Windows' },
  { id: 'xbox', label: 'Xbox' },
  { id: 'playstation', label: 'PlayStation' },
  { id: 'switch', label: 'Switch' },
];
function Guide() {
  const [p, setP] = useState('phone');
  return (
    <div className="card">
      <div className="card-head"><BookOpen size={16} /><h3>How friends join</h3></div>
      <div className="card-body stack">
        <Seg value={p} onChange={setP} options={PLATFORMS} />
        {(p === 'phone' || p === 'windows') && (
          <ol className="bedrock-steps small">
            <li>Open Minecraft and tap “Play”.</li>
            <li>Switch to the “Servers” tab and scroll down to “Add server”.</li>
            <li>Enter any name, the address and the port from the server card – then “Save” and join.</li>
          </ol>
        )}
        {(p === 'xbox' || p === 'playstation' || p === 'switch') && (
          <>
            <p className="small">Consoles only show the featured servers – own servers need a small detour:</p>
            <ol className="bedrock-steps small">
              <li>Easiest: BedrockConnect. In the network settings of the console, set the primary DNS server to a public BedrockConnect server (see its website for the current address), the secondary to 1.1.1.1.</li>
              <li>Start Minecraft, open “Servers” and join one of the featured servers – a server list appears instead.</li>
              <li>Choose “Connect to a server” and enter the address and the port from the server card.</li>
            </ol>
            <p className="tiny muted">{p === 'switch' ? 'Switch: the DNS setting is under System settings → Internet → Internet settings → your network → Change settings.' : p === 'xbox' ? 'Xbox: the DNS setting is under Settings → General → Network settings → Advanced settings → DNS settings.' : 'PlayStation: the DNS setting is under Settings → Network → Settings → Set up internet connection → your network → Advanced settings.'}</p>
          </>
        )}
      </div>
    </div>
  );
}

function ServerCard({ s, reload }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null); // 'motd' | null
  const update = async () => { setBusy(true); try { await post(`/mc/servers/${s.id}/bedrock/update`); reload(); toast.success('Checked for updates'); } catch (e) { toast.error(e); } setBusy(false); };
  const pack = async (on) => { try { await put(`/mc/servers/${s.id}/bedrock/optional-pack`, { on }); reload(); toast.success(on ? 'GeyserOptionalPack is installed – applies after a restart' : 'GeyserOptionalPack removed'); } catch (e) { toast.error(e); } };
  return (
    <div className="card">
      <div className="card-head"><Box size={16} /><h3 className="ellipsis">{s.name}</h3><span className="badge">{s.type}</span>
        <div className="right">{s.enabled ? <span className="badge ok">Bedrock on</span> : s.supported ? <span className="badge">off</span> : <span className="badge warn">not possible</span>}</div>
      </div>
      <div className="card-body stack">
        {s.enabled && <div className="tiny muted">{[s.build && t('Build {b}', { b: s.build }), s.pending && t('build {b} waits for the next restart', { b: s.pending }), s.checkedAt && t('checked {when}', { when: when(s.checkedAt) })].filter(Boolean).join(' · ')}</div>}
        {s.enabled && s.bedrockPlayers && s.bedrockPlayers.length > 0 && <div className="small">{t('Bedrock players online: {names}', { names: s.bedrockPlayers.join(', ') })}</div>}
        <BedrockShare s={s} />
        {s.enabled && (
          <>
            <SettingRow title={<>GeyserOptionalPack <InfoTip title="GeyserOptionalPack">A resource pack for Bedrock players that makes Java things look right: armour stands, hit boxes, shields, banners and more. It is sent to Bedrock players when they join.</InfoTip></>} text="Java features look like on Java.">
              <Switch checked={!!s.optionalPack} onChange={pack} />
            </SettingRow>
            {s.proxy && s.floodgate && <><div className="small"><b>Backend servers</b> <InfoTip title="Floodgate behind Velocity">Floodgate runs on the proxy and on every backend with the same key. Otherwise the backends kick Bedrock players. After adding a server to the network, sync again.</InfoTip></div><Backends s={s} reload={reload} /></>}
            {open === 'motd' && <MotdEditor s={s} onSaved={reload} />}
          </>
        )}
        <div className="row-tight">
          {s.enabled && <Btn className="xs ghost" icon={Type} onClick={() => setOpen(open === 'motd' ? null : 'motd')}>{open === 'motd' ? 'Close server list entry' : 'Server list entry'}</Btn>}
          {s.enabled && <Btn className="xs ghost" icon={RefreshCw} busy={busy} onClick={update}>Check for updates</Btn>}
          <a className="btn xs ghost" href={`#/mc/${encodeURIComponent(s.id)}`}><ArrowRight size={12} />Open server</a>
        </div>
      </div>
    </div>
  );
}

/** 1.2: replaced by “Minecraft server network” – install it (Hostwerk 3.2 knows the move) or open the extensions page. */
function Replaced({ done }) {
  const [busy, setBusy] = useState(false);
  const install = async () => {
    setBusy(true);
    try { await post('/extmarket/moved/mc-network/install'); toast.success('Minecraft server network installed – your Bedrock settings are there'); location.hash = '#/ext/mc-network'; } catch { location.hash = '#/ext'; }
    setBusy(false);
  };
  return (
    <Callout kind="warn" dismissible={false} title="Replaced by “Minecraft server network”">
      <span>Geyser belongs on the proxy in a network – once for every server. The new extension does that, adds Bedrock Dedicated Servers, version bridges and networks, and takes over your settings, ports and Floodgate keys without any loss.</span>
      {done ? <a className="btn sm" href="#/ext/mc-network">Open Minecraft server network</a> : <Btn className="sm primary" icon={ArrowRightLeft} busy={busy} onClick={install}>Move now</Btn>}
    </Callout>
  );
}

function BedrockPage() {
  const r = useApi('/bedrock', [], { live: false, poll: true });
  const d = { ...r, data: r.data ? (Array.isArray(r.data) ? r.data : r.data.servers) : null };
  if (r.data && r.data.replacedBy) return <div className="page fade-in"><div className="page-head"><div><h1><Smartphone /> Bedrock bridge</h1><p>Friends on phones, consoles and the Windows edition play on your Java servers – Geyser and Floodgate with one click.</p></div></div><Replaced done /></div>;
  if (!d.data && d.error) return <div className="page"><Empty icon={CloudOff} title="Could not load the Bedrock bridge" text={d.error} action={<Btn icon={RotateCw} onClick={() => d.reload()}>Try again</Btn>} /></div>;
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
      <Replaced />
      {d.data && d.error && <Callout kind="warn" dismissible={false}>{t('Could not refresh: {error}', { error: d.error })}</Callout>}
      {!d.data ? <Loading /> : d.data.length === 0 ? <Empty icon={Box} title="No Minecraft servers yet" text="Create a Minecraft server first – then allow Bedrock players here." action={<a className="btn primary" href="#/mc">Minecraft</a>} /> : (
        <div className="grid grid-2 bedrock-grid">
          {d.data.map((s) => <ServerCard key={s.id} s={s} reload={() => d.reload({ silent: true })} />)}
          <Guide />
        </div>
      )}
    </div>
  );
}

export default {
  pages: { main: BedrockPage },
  slots: { 'mc.connect': [{ id: 'bedrock', title: 'Bedrock players', Component: BedrockShare, order: 60 }] },
};

