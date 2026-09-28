import { StrictMode, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, Megaphone, ClipboardList, Wallet as WalletIcon } from 'lucide-react';
import { api, type Ad, type Asset, type Fiat, type Order, type Wallet } from './lib/api';
import { Async, AuthScreen, Badge, Button, Card, Empty, Field, OrdersPanel, Shell, Stat, WalletsPanel, date, money, num, useAction, useData, useHashPage, useSession } from './lib/ui';
import './style.css';

const NAV = [
  { id:'dashboard', label:'Dashboard', icon:<LayoutDashboard size={17}/> },
  { id:'ads', label:'My Ads', icon:<Megaphone size={17}/> },
  { id:'orders', label:'Orders', icon:<ClipboardList size={17}/> },
  { id:'wallets', label:'Wallets', icon:<WalletIcon size={17}/> },
];

function App() {
  const session = useSession();
  const [page, go] = useHashPage('dashboard');
  if (!session) return <AuthScreen title="Vendor panel" subtitle="Post P2P ads, lock escrow and release trades." allowRegister allowedRoles={['USER','VENDOR']}/>;
  return <Shell brand="SecureTrade Vendor" subtitle="Manage your P2P ads and trades" nav={NAV} active={page} onNav={go} session={session}>
    {page === 'dashboard' && <Dashboard go={go}/>}
    {page === 'ads' && <MyAds/>}
    {page === 'orders' && <Orders/>}
    {page === 'wallets' && <Wallets/>}
  </Shell>;
}

function Dashboard({ go }:{ go:(p:string)=>void }) {
  const wallets = useData(()=>api<Wallet[]>('/api/v1/wallets'));
  const ads = useData(()=>api<Ad[]>('/api/v1/vendor/ads'));
  const orders = useData(()=>api<Order[]>('/api/v1/p2p/orders'));
  const o = orders.data ?? [];
  const finished = o.filter(x=>['COMPLETED','CANCELLED','RESOLVED'].includes(x.status));
  const pending = o.filter(x=>['CREATED','ESCROW_LOCKED','PAYMENT_SENT','DISPUTED'].includes(x.status));
  const balances = (field:'available'|'locked') => wallets.data ? wallets.data.filter(w=>Number(w[field])>0).map(w=>`${num(w[field])} ${w.asset.symbol}`).join(', ') || '0' : '…';
  return <>
    <section className="grid">
      <Stat label="Available balance" value={balances('available')} sub="Can be locked for new trades"/>
      <Stat label="Locked in escrow" value={balances('locked')} sub="Released when trades complete"/>
      <Stat label="Active ads" value={ads.data ? ads.data.filter(a=>a.active).length : '…'} sub={ads.data ? `${ads.data.length} total` : ''}/>
      <Stat label="Open orders" value={orders.data ? pending.length : '…'} sub="Need action or awaiting counterparty"/>
      <Stat label="Completion rate" value={orders.data ? (finished.length ? `${Math.round(o.filter(x=>x.status==='COMPLETED').length/finished.length*100)}%` : '—') : '…'} sub="Completed / finished orders"/>
      <Stat label="Disputes" value={orders.data ? o.filter(x=>x.status==='DISPUTED').length : '…'} sub="Under review"/>
    </section>
    <Card title="Orders needing attention" actions={<Button variant="ghost" onClick={()=>go('orders')}>All orders</Button>}>
      <Async state={orders}>{()=>pending.length ? <OrdersPanel orders={pending} reload={orders.reload}/> : <Empty>No open orders. <a href="#ads" onClick={()=>go('ads')}>Post an ad →</a></Empty>}</Async>
    </Card>
  </>;
}

const emptyAd = { side:'SELL', assetSymbol:'USDT', fiatCode:'INR', price:'', available:'', minOrder:'', maxOrder:'', paymentMethod:'', terms:'' };

function MyAds() {
  const ads = useData(()=>api<Ad[]>('/api/v1/vendor/ads'));
  const assets = useData(()=>api<Asset[]>('/api/v1/assets', { auth:false }));
  const fiat = useData(()=>api<Fiat[]>('/api/v1/fiat', { auth:false }));
  const [form, setForm] = useState(emptyAd);
  const { busy, run } = useAction();
  const set = (k:keyof typeof form) => (e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>) => setForm({ ...form, [k]:e.target.value });
  const submit = async (e:FormEvent) => {
    e.preventDefault();
    const ok = await run('create', ()=>api('/api/v1/vendor/ads', { method:'POST', body:{ ...form, terms:form.terms || undefined } }), 'Ad published');
    if (ok) { setForm(emptyAd); ads.reload(); }
  };
  const toggle = (a:Ad) => run(a.id, ()=>api(`/api/v1/vendor/ads/${a.id}`, { method:'PATCH', body:{ active:!a.active } }), a.active ? 'Ad paused' : 'Ad activated').then(ok=>ok && ads.reload());
  return <>
    <Card title="Post a new ad">
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="I want to"><select value={form.side} onChange={set('side')}><option value="SELL">Sell crypto</option><option value="BUY">Buy crypto</option></select></Field>
          <Field label="Asset"><select value={form.assetSymbol} onChange={set('assetSymbol')}>{assets.data?.map(a=><option key={a.id}>{a.symbol}</option>)}</select></Field>
          <Field label="Fiat currency"><select value={form.fiatCode} onChange={set('fiatCode')}>{fiat.data?.map(f=><option key={f.code}>{f.code}</option>)}</select></Field>
          <Field label={`Price (${form.fiatCode} per ${form.assetSymbol})`}><input type="number" step="any" min="0" required value={form.price} onChange={set('price')}/></Field>
          <Field label={`Total quantity (${form.assetSymbol})`}><input type="number" step="any" min="0" required value={form.available} onChange={set('available')}/></Field>
          <Field label="Min per order"><input type="number" step="any" min="0" required value={form.minOrder} onChange={set('minOrder')}/></Field>
          <Field label="Max per order"><input type="number" step="any" min="0" required value={form.maxOrder} onChange={set('maxOrder')}/></Field>
          <Field label="Payment method"><input required placeholder="e.g. UPI, Bank transfer" value={form.paymentMethod} onChange={set('paymentMethod')}/></Field>
        </div>
        <Field label="Terms (optional)"><textarea rows={2} maxLength={2000} value={form.terms} onChange={set('terms')} placeholder="Payment window, account name requirements, etc."/></Field>
        {form.side === 'SELL' && <p className="muted small">When a buyer takes this ad you'll need enough available {form.assetSymbol} to lock in escrow.</p>}
        <div className="row end"><Button busy={busy==='create'} type="submit">Publish ad</Button></div>
      </form>
    </Card>
    <Card title="Your ads" actions={<Button variant="ghost" onClick={ads.reload}>Refresh</Button>}>
      <Async state={ads}>{list=>list.length ? <div className="table-wrap"><table>
        <thead><tr><th>Type</th><th className="r">Price</th><th className="r">Remaining</th><th className="r">Limits</th><th>Payment</th><th>Created</th><th>Status</th><th/></tr></thead>
        <tbody>{list.map(a=><tr key={a.id}>
          <td><b>{a.side==='SELL' ? 'Sell' : 'Buy'} {a.assetSymbol}</b></td>
          <td className="r">{money(a.price, a.fiatCode)}</td>
          <td className="r">{num(a.available)} {a.assetSymbol}</td>
          <td className="r">{num(a.minOrder)} – {num(a.maxOrder)}</td>
          <td>{a.paymentMethod}</td>
          <td className="muted">{date(a.createdAt)}</td>
          <td><Badge value={a.active ? 'ACTIVE' : 'INACTIVE'}/></td>
          <td className="r"><Button variant="ghost" busy={busy===a.id} onClick={()=>toggle(a)}>{a.active ? 'Pause' : 'Activate'}</Button></td>
        </tr>)}</tbody>
      </table></div> : <Empty>You haven't posted any ads yet.</Empty>}</Async>
    </Card>
  </>;
}

function Orders() {
  const orders = useData(()=>api<Order[]>('/api/v1/p2p/orders'));
  return <Card title="P2P orders" actions={<Button variant="ghost" onClick={orders.reload}>Refresh</Button>}>
    <Async state={orders}>{list=><OrdersPanel orders={list} reload={orders.reload}/>}</Async>
  </Card>;
}

function Wallets() {
  const wallets = useData(()=>api<Wallet[]>('/api/v1/wallets'));
  return <Card title="Balances" actions={<Button variant="ghost" onClick={wallets.reload}>Refresh</Button>}>
    <Async state={wallets}>{w=><WalletsPanel wallets={w}/>}</Async>
    <p className="muted small">To fund a wallet for selling, ask a platform admin to credit your account. On-chain deposits need a custody provider and are not enabled yet.</p>
  </Card>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
