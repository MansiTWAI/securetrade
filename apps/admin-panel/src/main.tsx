import { StrictMode, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, Users, Gavel, Coins, ScrollText } from 'lucide-react';
import { api, type Asset, type Role } from './lib/api';
import { Async, AuthScreen, Badge, Button, Card, Empty, Field, Modal, Shell, Stat, date, label, money, num, useAction, useData, useHashPage, useSession } from './lib/ui';
import './style.css';

const ADMIN_ROLES:Role[] = ['SUPER_ADMIN','COMPLIANCE','SUPPORT','P2P_ADMIN','FINANCE','AUDITOR','TRADING_ADMIN'];
const ALL_ROLES:Role[] = ['USER','VENDOR', ...ADMIN_ROLES];
const NAV = [
  { id:'overview', label:'Overview', icon:<LayoutDashboard size={17}/> },
  { id:'users', label:'Users', icon:<Users size={17}/> },
  { id:'disputes', label:'Disputes', icon:<Gavel size={17}/> },
  { id:'credit', label:'Credit Wallet', icon:<Coins size={17}/> },
  { id:'audit', label:'Audit Log', icon:<ScrollText size={17}/> },
];

type User = { id:string; email:string; role:Role; status:string; kycStatus:string; createdAt:string };
type Dispute = { id:string; reason:string; resolution?:string|null; createdAt:string; resolvedAt?:string|null; order:{ id:string; assetSymbol:string; fiatCode:string; cryptoAmount:string; fiatAmount:string; status:string; buyer:{ email:string }; seller:{ email:string } } };
type AuditEntry = { id:string; action:string; entityType:string; entityId?:string; reason?:string; ip?:string; createdAt:string; actor?:{ email:string; role:string }|null };
type Stats = { users:number; openDisputes:number; activeAds:number; orders:number; completed:number };

function App() {
  const session = useSession();
  const [page, go] = useHashPage('overview');
  if (!session || !ADMIN_ROLES.includes(session.role)) return <AuthScreen title="Admin console" subtitle="Restricted to platform staff." allowRegister={false} allowedRoles={ADMIN_ROLES}/>;
  return <Shell brand="SecureTrade Admin" subtitle="Platform administration" nav={NAV} active={page} onNav={go} session={session}>
    {page === 'overview' && <Overview go={go}/>}
    {page === 'users' && <UsersPage selfId={session.id}/>}
    {page === 'disputes' && <Disputes/>}
    {page === 'credit' && <Credit/>}
    {page === 'audit' && <Audit/>}
  </Shell>;
}

function Overview({ go }:{ go:(p:string)=>void }) {
  const stats = useData(()=>api<Stats>('/api/v1/admin/stats'));
  const s = stats.data;
  return <>
    <Async state={stats}>{()=><section className="grid">
      <Stat label="Users" value={s!.users} sub="Registered accounts"/>
      <Stat label="Open disputes" value={s!.openDisputes} sub="Awaiting resolution"/>
      <Stat label="Active P2P ads" value={s!.activeAds} sub="Visible in the market"/>
      <Stat label="P2P orders" value={s!.orders} sub="All time"/>
      <Stat label="Completed trades" value={s!.completed} sub={s!.orders ? `${Math.round(s!.completed/s!.orders*100)}% of orders` : ''}/>
      <Stat label="Service" value="Online" sub="API reachable"/>
    </section>}</Async>
    <Card title="Quick actions"><div className="row">
      <Button onClick={()=>go('disputes')}>Review disputes</Button>
      <Button variant="ghost" onClick={()=>go('credit')}>Credit a wallet</Button>
      <Button variant="ghost" onClick={()=>go('users')}>Manage users</Button>
    </div></Card>
  </>;
}

function UsersPage({ selfId }:{ selfId:string }) {
  const users = useData(()=>api<User[]>('/api/v1/admin/users'));
  const [edit, setEdit] = useState<User|null>(null);
  const [form, setForm] = useState({ role:'USER' as Role, status:'ACTIVE', reason:'' });
  const { busy, run } = useAction();
  const [q, setQ] = useState('');
  const save = () => run('save', ()=>api(`/api/v1/admin/users/${edit!.id}`, { method:'PATCH', body:form }), 'User updated').then(ok=>{ if (ok) { setEdit(null); users.reload(); } });
  return <Card title="Users" actions={<><input placeholder="Search email…" value={q} onChange={e=>setQ(e.target.value)} style={{ width:220 }}/><Button variant="ghost" onClick={users.reload}>Refresh</Button></>}>
    <Async state={users}>{list=>{
      const shown = list.filter(u=>u.email.includes(q.toLowerCase()));
      return shown.length ? <div className="table-wrap"><table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>KYC</th><th>Joined</th><th/></tr></thead>
        <tbody>{shown.map(u=><tr key={u.id}>
          <td>{u.email}{u.id===selfId && <span className="muted"> (you)</span>}</td><td>{label(u.role)}</td><td><Badge value={u.status}/></td><td>{label(u.kycStatus)}</td><td className="muted">{date(u.createdAt)}</td>
          <td className="r">{u.id!==selfId && <Button variant="ghost" onClick={()=>{ setForm({ role:u.role, status:u.status, reason:'' }); setEdit(u); }}>Edit</Button>}</td>
        </tr>)}</tbody>
      </table></div> : <Empty>No users found.</Empty>;
    }}</Async>
    {edit && <Modal title={`Edit ${edit.email}`} onClose={()=>setEdit(null)}>
      <Field label="Role"><select value={form.role} onChange={e=>setForm({ ...form, role:e.target.value as Role })}>{ALL_ROLES.map(r=><option key={r} value={r}>{label(r)}</option>)}</select></Field>
      <Field label="Status" hint="Suspending or freezing signs the user out everywhere."><select value={form.status} onChange={e=>setForm({ ...form, status:e.target.value })}>{['ACTIVE','SUSPENDED','FROZEN'].map(s=><option key={s} value={s}>{label(s)}</option>)}</select></Field>
      <Field label="Reason (recorded in the audit log)"><input value={form.reason} onChange={e=>setForm({ ...form, reason:e.target.value })}/></Field>
      <div className="row end"><Button variant="ghost" onClick={()=>setEdit(null)}>Cancel</Button><Button busy={busy==='save'} disabled={form.reason.trim().length<3} onClick={save}>Save</Button></div>
    </Modal>}
  </Card>;
}

function Disputes() {
  const disputes = useData(()=>api<Dispute[]>('/api/v1/admin/disputes'));
  const [resolve, setResolve] = useState<Dispute|null>(null);
  const [form, setForm] = useState({ outcome:'RELEASE_TO_BUYER', resolution:'' });
  const { busy, run } = useAction();
  const submit = () => run('resolve', ()=>api(`/api/v1/admin/disputes/${resolve!.id}/resolve`, { method:'POST', body:form }), 'Dispute resolved').then(ok=>{ if (ok) { setResolve(null); disputes.reload(); } });
  return <Card title="P2P disputes" actions={<Button variant="ghost" onClick={disputes.reload}>Refresh</Button>}>
    <Async state={disputes}>{list=>list.length ? <div className="table-wrap"><table>
      <thead><tr><th>Opened</th><th>Order</th><th>Buyer / seller</th><th>Reason</th><th>Status</th><th/></tr></thead>
      <tbody>{list.map(d=><tr key={d.id}>
        <td className="muted">{date(d.createdAt)}</td>
        <td>{num(d.order.cryptoAmount)} {d.order.assetSymbol}<div className="muted small">{money(d.order.fiatAmount, d.order.fiatCode)} · <code>{d.order.id.slice(-8)}</code></div></td>
        <td>{d.order.buyer.email}<div className="muted small">{d.order.seller.email}</div></td>
        <td style={{ maxWidth:320 }}>{d.reason}{d.resolution && <div className="muted small">→ {d.resolution}</div>}</td>
        <td><Badge value={d.resolvedAt ? 'RESOLVED' : 'OPEN'}/></td>
        <td className="r">{!d.resolvedAt && <Button onClick={()=>{ setForm({ outcome:'RELEASE_TO_BUYER', resolution:'' }); setResolve(d); }}>Resolve</Button>}</td>
      </tr>)}</tbody>
    </table></div> : <Empty>No disputes. 🎉</Empty>}</Async>
    {resolve && <Modal title="Resolve dispute" onClose={()=>setResolve(null)}>
      <p className="muted">{num(resolve.order.cryptoAmount)} {resolve.order.assetSymbol} is locked in escrow. Buyer: {resolve.order.buyer.email} · Seller: {resolve.order.seller.email}</p>
      <p className="terms">{resolve.reason}</p>
      <Field label="Outcome"><select value={form.outcome} onChange={e=>setForm({ ...form, outcome:e.target.value })}>
        <option value="RELEASE_TO_BUYER">Release escrow to buyer (buyer paid)</option>
        <option value="REFUND_SELLER">Refund seller (buyer did not pay)</option>
      </select></Field>
      <Field label="Resolution notes"><textarea rows={3} value={form.resolution} onChange={e=>setForm({ ...form, resolution:e.target.value })}/></Field>
      <div className="row end"><Button variant="ghost" onClick={()=>setResolve(null)}>Cancel</Button><Button busy={busy==='resolve'} disabled={form.resolution.trim().length<5} onClick={submit}>Resolve</Button></div>
    </Modal>}
  </Card>;
}

function Credit() {
  const assets = useData(()=>api<Asset[]>('/api/v1/assets', { auth:false }));
  const [form, setForm] = useState({ email:'', assetSymbol:'USDT', amount:'', reason:'' });
  const { busy, run } = useAction();
  const submit = async (e:FormEvent) => {
    e.preventDefault();
    if (!confirm(`Credit ${form.amount} ${form.assetSymbol} to ${form.email}?`)) return;
    const ok = await run('credit', ()=>api('/api/v1/admin/wallets/credit', { method:'POST', body:form }), `Credited ${form.amount} ${form.assetSymbol} to ${form.email}`);
    if (ok) setForm({ ...form, email:'', amount:'', reason:'' });
  };
  const set = (k:keyof typeof form) => (e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>) => setForm({ ...form, [k]:e.target.value });
  return <Card title="Credit a user's wallet">
    <p className="muted">Manually add balance to a user (e.g. an off-platform deposit). Every credit is written to the ledger and audit log.</p>
    <form onSubmit={submit} style={{ maxWidth:520 }}>
      <Field label="User email"><input type="email" required value={form.email} onChange={set('email')}/></Field>
      <div className="form-grid" style={{ gridTemplateColumns:'1fr 1fr' }}>
        <Field label="Asset"><select value={form.assetSymbol} onChange={set('assetSymbol')}>{assets.data?.map(a=><option key={a.id}>{a.symbol}</option>)}</select></Field>
        <Field label="Amount"><input type="number" step="any" min="0" required value={form.amount} onChange={set('amount')}/></Field>
      </div>
      <Field label="Reason"><input required minLength={3} value={form.reason} onChange={set('reason')} placeholder="e.g. Bank deposit ref #1234"/></Field>
      <div className="row end"><Button busy={busy==='credit'} type="submit">Credit wallet</Button></div>
    </form>
  </Card>;
}

function Audit() {
  const log = useData(()=>api<AuditEntry[]>('/api/v1/admin/audit'));
  return <Card title="Audit log (latest 200)" actions={<Button variant="ghost" onClick={log.reload}>Refresh</Button>}>
    <Async state={log}>{list=>list.length ? <div className="table-wrap"><table>
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
      <tbody>{list.map(a=><tr key={a.id}>
        <td className="muted">{date(a.createdAt)}</td><td>{a.actor?.email ?? '—'}{a.actor && <div className="muted small">{label(a.actor.role)}</div>}</td>
        <td><b>{label(a.action)}</b></td><td>{a.entityType}{a.entityId && <div className="muted small"><code>{a.entityId.slice(-8)}</code></div>}</td>
        <td style={{ maxWidth:320 }}>{a.reason}</td><td className="muted small">{a.ip}</td>
      </tr>)}</tbody>
    </table></div> : <Empty>No audit events yet.</Empty>}</Async>
  </Card>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
