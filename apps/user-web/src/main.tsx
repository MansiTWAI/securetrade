import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, ArrowLeftRight, ClipboardList, Wallet as WalletIcon, CandlestickChart } from 'lucide-react';
import { api, type Ad, type Asset, type Fiat, type Order, type Pair, type Wallet } from './lib/api';
import { Async, AuthScreen, Badge, Button, Card, Empty, Field, Modal, OrdersPanel, Shell, Stat, WalletsPanel, money, num, useAction, useData, useHashPage, useSession } from './lib/ui';
import './style.css';

const NAV = [
  { id:'dashboard', label:'Dashboard', icon:<LayoutDashboard size={17}/> },
  { id:'p2p', label:'P2P Market', icon:<ArrowLeftRight size={17}/> },
  { id:'orders', label:'My Orders', icon:<ClipboardList size={17}/> },
  { id:'wallets', label:'Wallets', icon:<WalletIcon size={17}/> },
  { id:'markets', label:'Markets', icon:<CandlestickChart size={17}/> },
];

function App() {
  const session = useSession();
  const [page, go] = useHashPage('dashboard');
  if (!session) return <AuthScreen title="Welcome to SecureTrade" subtitle="Buy and sell crypto peer-to-peer with escrow protection." allowRegister/>;
  return <Shell brand="SecureTrade" subtitle="Secure multi-asset P2P trading" nav={NAV} active={page} onNav={go} session={session}>
    {page === 'dashboard' && <Dashboard go={go}/>}
    {page === 'p2p' && <P2PMarket go={go}/>}
    {page === 'orders' && <MyOrders/>}
    {page === 'wallets' && <Wallets/>}
    {page === 'markets' && <Markets/>}
  </Shell>;
}

function Dashboard({ go }:{ go:(p:string)=>void }) {
  const wallets = useData(()=>api<Wallet[]>('/api/v1/wallets'));
  const orders = useData(()=>api<Order[]>('/api/v1/p2p/orders'));
  const ads = useData(()=>api<Ad[]>('/api/v1/p2p/ads', { auth:false }));
  const active = orders.data?.filter(o=>['CREATED','ESCROW_LOCKED','PAYMENT_SENT','DISPUTED'].includes(o.status)) ?? [];
  return <>
    <section className="grid">
      <Stat label="Assets held" value={wallets.data ? wallets.data.filter(w=>Number(w.available)+Number(w.locked)>0).length : '…'} sub="Wallets with a balance"/>
      <Stat label="Active orders" value={orders.data ? active.length : '…'} sub="Awaiting a next step"/>
      <Stat label="Completed trades" value={orders.data ? orders.data.filter(o=>o.status==='COMPLETED').length : '…'} sub="All time"/>
      <Stat label="Open P2P offers" value={ads.data ? ads.data.length : '…'} sub="Across all assets"/>
      <Stat label="In escrow" value={wallets.data ? wallets.data.filter(w=>Number(w.locked)>0).map(w=>`${num(w.locked)} ${w.asset.symbol}`).join(', ') || '0' : '…'} sub="Locked for your sell orders"/>
      <Stat label="Disputes" value={orders.data ? orders.data.filter(o=>o.status==='DISPUTED').length : '…'} sub="Under review"/>
    </section>
    <Card title="Orders needing attention" actions={<Button variant="ghost" onClick={()=>go('orders')}>All orders</Button>}>
      <Async state={orders}>{()=>active.length ? <OrdersPanel orders={active} reload={orders.reload}/> : <Empty>Nothing pending. <a href="#p2p" onClick={()=>go('p2p')}>Browse P2P offers →</a></Empty>}</Async>
    </Card>
  </>;
}

function P2PMarket({ go }:{ go:(p:string)=>void }) {
  const [filter, setFilter] = useState({ side:'SELL', asset:'', fiat:'' });
  const assets = useData(()=>api<Asset[]>('/api/v1/assets', { auth:false }));
  const fiat = useData(()=>api<Fiat[]>('/api/v1/fiat', { auth:false }));
  const ads = useData(()=>{
    const q = new URLSearchParams({ side:filter.side, ...(filter.asset && { asset:filter.asset }), ...(filter.fiat && { fiat:filter.fiat }) });
    return api<Ad[]>(`/api/v1/p2p/ads?${q}`, { auth:false });
  }, [filter.side, filter.asset, filter.fiat]);
  const [take, setTake] = useState<Ad|null>(null);
  return <>
    <Card>
      <div className="toolbar">
        <div className="tabs inline">
          <button className={filter.side==='SELL' ? 'on' : ''} onClick={()=>setFilter({ ...filter, side:'SELL' })}>Buy crypto</button>
          <button className={filter.side==='BUY' ? 'on' : ''} onClick={()=>setFilter({ ...filter, side:'BUY' })}>Sell crypto</button>
        </div>
        <select value={filter.asset} onChange={e=>setFilter({ ...filter, asset:e.target.value })} aria-label="Asset"><option value="">All assets</option>{assets.data?.map(a=><option key={a.id}>{a.symbol}</option>)}</select>
        <select value={filter.fiat} onChange={e=>setFilter({ ...filter, fiat:e.target.value })} aria-label="Fiat"><option value="">All currencies</option>{fiat.data?.map(f=><option key={f.code}>{f.code}</option>)}</select>
      </div>
      <Async state={ads}>{list=>list.length ? <div className="table-wrap"><table>
        <thead><tr><th>Advertiser</th><th className="r">Price</th><th className="r">Available</th><th className="r">Limits</th><th>Payment</th><th/></tr></thead>
        <tbody>{list.map(a=><tr key={a.id}>
          <td>{a.vendor?.name}<div className="muted small">KYC: {a.vendor?.kycStatus.replace(/_/g,' ').toLowerCase()}</div></td>
          <td className="r"><b>{money(a.price, a.fiatCode)}</b><div className="muted small">per {a.assetSymbol}</div></td>
          <td className="r">{num(a.available)} {a.assetSymbol}</td>
          <td className="r">{num(a.minOrder)} – {num(a.maxOrder)} {a.assetSymbol}</td>
          <td>{a.paymentMethod}</td>
          <td className="r"><Button variant={a.side==='SELL' ? 'ok' : 'danger'} onClick={()=>setTake(a)}>{a.side==='SELL' ? 'Buy' : 'Sell'} {a.assetSymbol}</Button></td>
        </tr>)}</tbody>
      </table></div> : <Empty>No offers match these filters yet.</Empty>}</Async>
    </Card>
    {take && <TakeAd ad={take} onClose={()=>setTake(null)} onDone={()=>{ setTake(null); go('orders'); }}/>}
  </>;
}

function TakeAd({ ad, onClose, onDone }:{ ad:Ad; onClose:()=>void; onDone:()=>void }) {
  const [amount, setAmount] = useState('');
  const { busy, run } = useAction();
  const n = Number(amount);
  const max = Math.min(Number(ad.maxOrder), Number(ad.available));
  const valid = n >= Number(ad.minOrder) && n <= max;
  const buying = ad.side === 'SELL';
  return <Modal title={`${buying ? 'Buy' : 'Sell'} ${ad.assetSymbol}`} onClose={onClose}>
    <p className="muted">Price {money(ad.price, ad.fiatCode)} per {ad.assetSymbol} · pay via {ad.paymentMethod}</p>
    {ad.terms && <p className="terms">{ad.terms}</p>}
    <Field label={`Amount (${ad.assetSymbol})`} hint={`Between ${num(ad.minOrder)} and ${num(max)}`}>
      <input type="number" min={ad.minOrder} max={max} step="any" value={amount} onChange={e=>setAmount(e.target.value)} autoFocus/>
    </Field>
    <div className="total">You {buying ? 'pay' : 'receive'} <b>{money(valid ? n*Number(ad.price) : 0, ad.fiatCode)}</b></div>
    <p className="muted small">{buying ? 'The seller locks the crypto in escrow first; you then send the fiat payment and mark it as paid.' : 'You will lock the crypto in escrow; it is released to the buyer after you confirm their payment.'}</p>
    <div className="row end"><Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button busy={busy==='take'} disabled={!valid} onClick={()=>run('take', ()=>api('/api/v1/p2p/orders', { method:'POST', body:{ advertisementId:ad.id, cryptoAmount:n } }), 'Order created').then(ok=>ok && onDone())}>Place order</Button></div>
  </Modal>;
}

function MyOrders() {
  const orders = useData(()=>api<Order[]>('/api/v1/p2p/orders'));
  return <Card title="P2P orders" actions={<Button variant="ghost" onClick={orders.reload}>Refresh</Button>}>
    <Async state={orders}>{list=><OrdersPanel orders={list} reload={orders.reload}/>}</Async>
  </Card>;
}

function Wallets() {
  const wallets = useData(()=>api<Wallet[]>('/api/v1/wallets'));
  return <Card title="Balances" actions={<Button variant="ghost" onClick={wallets.reload}>Refresh</Button>}>
    <Async state={wallets}>{w=><WalletsPanel wallets={w}/>}</Async>
    <p className="muted small">On-chain deposits and withdrawals require a custody provider and are not enabled yet.</p>
  </Card>;
}

function Markets() {
  const pairs = useData(()=>api<Pair[]>('/api/v1/markets', { auth:false }));
  return <Card title="Spot markets">
    <Async state={pairs}>{list=>list.length ? <div className="table-wrap"><table>
      <thead><tr><th>Pair</th><th>Base</th><th>Quote</th><th className="r">Maker / taker fee</th><th className="r">Min quantity</th><th>Status</th></tr></thead>
      <tbody>{list.map(p=><tr key={p.id}><td><b>{p.symbol}</b></td><td>{p.baseAsset.name}</td><td>{p.quoteAsset.name}</td><td className="r">{num(Number(p.makerFee)*100,3)}% / {num(Number(p.takerFee)*100,3)}%</td><td className="r">{num(p.minQuantity)} {p.baseAsset.symbol}</td><td><Badge value="LISTED"/></td></tr>)}</tbody>
    </table></div> : <Empty>No markets listed.</Empty>}</Async>
    <p className="muted small">Live prices and spot order matching need a market-data provider and matching engine, which are not connected yet.</p>
  </Card>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
