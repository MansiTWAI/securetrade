// Shared UI — identical copy in apps/user-web, apps/vendor-panel and apps/admin-panel (src/lib).
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ShieldCheck, LogOut, Loader2, X, RefreshCw } from 'lucide-react';
import { api, errorMessage, getSession, login, logout, onSessionChange, onSlowServer, register, type Order, type Role, type Session, type Wallet } from './api';

// ---------- formatting ----------
export const num = (v:string|number, max = 8) => Number(v).toLocaleString(undefined, { maximumFractionDigits:max });
export const money = (v:string|number, code:string) => { try { return Number(v).toLocaleString(undefined, { style:'currency', currency:code, maximumFractionDigits:2 }); } catch { return `${num(v,2)} ${code}`; } };
export const date = (v:string) => new Date(v).toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
export const label = (s:string) => s.replace(/_/g,' ').toLowerCase().replace(/^\w/, c=>c.toUpperCase());

// ---------- hooks ----------
export function useSession() {
  const [s, set] = useState<Session|null>(getSession());
  useEffect(()=>onSessionChange(set), []);
  return s;
}
/** Current page from the URL hash; follows back/forward and manual hash edits. */
export function useHashPage(fallback:string):[string, (p:string)=>void] {
  const read = () => location.hash.slice(1) || fallback;
  const [page, setPage] = useState(read);
  useEffect(()=>{ const f = () => setPage(read()); addEventListener('hashchange', f); return ()=>removeEventListener('hashchange', f); }, []);
  return [page, (p:string)=>{ location.hash = p; }];
}
export function useData<T>(load:()=>Promise<T>, deps:unknown[] = []) {
  const [state, setState] = useState<{ data?:T; error?:string; loading:boolean }>({ loading:true });
  const reload = useCallback(()=>{
    setState(s=>({ ...s, loading:true }));
    load().then(data=>setState({ data, loading:false }), e=>setState({ error:errorMessage(e), loading:false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(()=>{ reload(); }, [reload]);
  return { ...state, reload };
}

// ---------- toasts ----------
type Toast = { id:number; kind:'ok'|'err'; text:string };
const toastListeners = new Set<(t:Toast[])=>void>(); let toasts:Toast[] = []; let toastId = 0;
export function notify(text:string, kind:'ok'|'err' = 'ok') {
  const t = { id:++toastId, kind, text }; toasts = [...toasts, t]; toastListeners.forEach(l=>l(toasts));
  setTimeout(()=>{ toasts = toasts.filter(x=>x.id!==t.id); toastListeners.forEach(l=>l(toasts)); }, 5000);
}
function Toasts() {
  const [list, set] = useState<Toast[]>(toasts);
  useEffect(()=>{ toastListeners.add(set); return ()=>{ toastListeners.delete(set); }; }, []);
  return <div className="toasts" role="status">{list.map(t=><div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}</div>;
}
function SlowServerBanner() {
  const [slow, set] = useState(false);
  useEffect(()=>onSlowServer(set), []);
  return slow ? <div className="banner"><Loader2 size={16} className="spin"/> Waking up the server — the first request after a quiet period can take up to a minute…</div> : null;
}
/** Run an async action with busy state + success/error toast. */
export function useAction() {
  const [busy, setBusy] = useState<string|null>(null);
  const run = async (key:string, fn:()=>Promise<unknown>, success?:string) => {
    setBusy(key);
    try { await fn(); if (success) notify(success); return true; }
    catch (e) { notify(errorMessage(e), 'err'); return false; }
    finally { setBusy(null); }
  };
  return { busy, run };
}

// ---------- primitives ----------
export function Button({ children, busy, variant = 'primary', ...p }:React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?:boolean; variant?:'primary'|'ghost'|'danger'|'ok' }) {
  return <button {...p} className={`btn ${variant} ${p.className ?? ''}`} disabled={busy || p.disabled}>{busy && <Loader2 size={15} className="spin"/>}{children}</button>;
}
export function Field({ label:l, children, hint }:{ label:string; children:ReactNode; hint?:string }) {
  return <label className="field"><span>{l}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Badge({ value }:{ value:string }) { return <span className={`badge s-${value.toLowerCase()}`}>{label(value)}</span>; }
export function Card({ title, actions, children }:{ title?:string; actions?:ReactNode; children:ReactNode }) {
  return <section className="panel">{(title || actions) && <div className="panel-head">{title && <h2>{title}</h2>}<div className="row">{actions}</div></div>}{children}</section>;
}
export function Stat({ label:l, value, sub }:{ label:string; value:ReactNode; sub?:string }) {
  return <article><span>{l}</span><strong>{value}</strong>{sub && <small>{sub}</small>}</article>;
}
export function Loading() { return <div className="muted pad"><Loader2 size={16} className="spin"/> Loading…</div>; }
export function ErrorBox({ error, retry }:{ error:string; retry?:()=>void }) {
  return <div className="error-box">{error}{retry && <Button variant="ghost" onClick={retry}><RefreshCw size={14}/> Retry</Button>}</div>;
}
export function Empty({ children }:{ children:ReactNode }) { return <div className="empty">{children}</div>; }
export function Modal({ title, onClose, children }:{ title:string; onClose:()=>void; children:ReactNode }) {
  useEffect(()=>{ const k = (e:KeyboardEvent)=>e.key==='Escape' && onClose(); addEventListener('keydown', k); return ()=>removeEventListener('keydown', k); }, [onClose]);
  return <div className="overlay" onMouseDown={e=>e.target===e.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="panel-head"><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Close"><X size={18}/></button></div>
      {children}
    </div>
  </div>;
}
/** Renders children with data, or a loading / error state. */
export function Async<T>({ state, children }:{ state:{ data?:T; error?:string; loading:boolean; reload:()=>void }; children:(d:T)=>ReactNode }) {
  if (state.error) return <ErrorBox error={state.error} retry={state.reload}/>;
  if (state.data === undefined) return <Loading/>;
  return <>{children(state.data)}</>;
}

// ---------- layout ----------
export type NavItem = { id:string; label:string; icon:ReactNode };
export function Shell({ brand, subtitle, nav, active, onNav, session, children }:{ brand:string; subtitle:string; nav:NavItem[]; active:string; onNav:(id:string)=>void; session:Session; children:ReactNode }) {
  const current = nav.find(n=>n.id===active);
  return <div className="app">
    <aside>
      <div className="brand"><ShieldCheck/> <span>{brand}</span></div>
      {nav.map(n=><button key={n.id} className={n.id===active ? 'active' : ''} onClick={()=>onNav(n.id)} title={n.label}>{n.icon}<span>{n.label}</span></button>)}
      <div className="spacer"/>
      <button onClick={()=>logout()} title="Sign out"><LogOut size={17}/><span>Sign out</span></button>
    </aside>
    <main>
      <SlowServerBanner/>
      <header><div><h1>{current?.label}</h1><p>{subtitle}</p></div><div className="profile" title={session.email}><span className="avatar">{session.email[0].toUpperCase()}</span><span className="who">{session.email}<small>{label(session.role)}</small></span></div></header>
      {children}
    </main>
    <Toasts/>
  </div>;
}

export function AuthScreen({ title, subtitle, allowRegister, allowedRoles }:{ title:string; subtitle:string; allowRegister:boolean; allowedRoles?:Role[] }) {
  const [mode, setMode] = useState<'login'|'register'>('login');
  const [form, setForm] = useState({ email:'', password:'', fullName:'' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e:FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      const s = mode === 'login' ? await login(form.email, form.password) : await register(form.email, form.password, form.fullName);
      if (allowedRoles && !allowedRoles.includes(s.role)) { await logout(); setError('This account does not have access to this panel.'); }
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const set = (k:keyof typeof form) => (e:React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]:e.target.value });
  return <div className="auth">
    <SlowServerBanner/>
    <form className="auth-card" onSubmit={submit}>
      <div className="brand dark"><ShieldCheck/> SecureTrade</div>
      <h1>{title}</h1><p className="muted">{subtitle}</p>
      {allowRegister && <div className="tabs">
        <button type="button" className={mode==='login' ? 'on' : ''} onClick={()=>setMode('login')}>Sign in</button>
        <button type="button" className={mode==='register' ? 'on' : ''} onClick={()=>setMode('register')}>Create account</button>
      </div>}
      {mode === 'register' && <Field label="Full name"><input value={form.fullName} onChange={set('fullName')} autoComplete="name"/></Field>}
      <Field label="Email"><input type="email" required value={form.email} onChange={set('email')} autoComplete="email"/></Field>
      <Field label="Password" hint={mode==='register' ? 'At least 10 characters.' : undefined}>
        <input type="password" required minLength={mode==='register' ? 10 : 1} value={form.password} onChange={set('password')} autoComplete={mode==='register' ? 'new-password' : 'current-password'}/>
      </Field>
      {error && <div className="error-box">{error}</div>}
      <Button busy={busy} type="submit" className="wide">{mode==='login' ? 'Sign in' : 'Create account'}</Button>
    </form>
  </div>;
}

// ---------- shared panels ----------
export function WalletsPanel({ wallets }:{ wallets:Wallet[] }) {
  if (!wallets.length) return <Empty>No balances yet. Balances appear here once funds are credited or you receive crypto from a P2P trade.</Empty>;
  return <div className="table-wrap"><table>
    <thead><tr><th>Asset</th><th className="r">Available</th><th className="r">In escrow</th><th className="r">Total</th></tr></thead>
    <tbody>{wallets.map(w=><tr key={w.id}><td><b>{w.asset.symbol}</b> <span className="muted">{w.asset.name}</span></td><td className="r">{num(w.available)}</td><td className="r">{num(w.locked)}</td><td className="r">{num(Number(w.available)+Number(w.locked))}</td></tr>)}</tbody>
  </table></div>;
}

/** Orders for the signed-in user with the actions their role allows at each step. */
export function OrdersPanel({ orders, reload }:{ orders:Order[]; reload:()=>void }) {
  const { busy, run } = useAction();
  const [disputeFor, setDisputeFor] = useState<Order|null>(null);
  const [reason, setReason] = useState('');
  const act = (o:Order, action:string, msg:string) => run(`${o.id}:${action}`, ()=>api(`/api/v1/p2p/orders/${o.id}/${action}`, { method:'POST' }), msg).then(ok=>ok && reload());
  const next = (o:Order):string => {
    const seller = o.role === 'SELLER';
    switch (o.status) {
      case 'CREATED': return seller ? 'Lock the crypto in escrow to start the trade.' : 'Waiting for the seller to lock crypto in escrow.';
      case 'ESCROW_LOCKED': return seller ? 'Waiting for the buyer to send the fiat payment.' : `Send ${money(o.fiatAmount, o.fiatCode)} via ${o.advertisement.paymentMethod}, then mark as paid.`;
      case 'PAYMENT_SENT': return seller ? 'Buyer marked as paid. Confirm you received the fiat, then release.' : 'Waiting for the seller to confirm and release.';
      case 'DISPUTED': return 'Under review by the support team.';
      default: return '';
    }
  };
  if (!orders.length) return <Empty>No P2P orders yet.</Empty>;
  return <>
    <div className="table-wrap"><table>
      <thead><tr><th>Order</th><th>You</th><th className="r">Amount</th><th className="r">Total</th><th>Counterparty</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{orders.map(o=>{
        const k = (a:string)=>busy===`${o.id}:${a}`;
        const seller = o.role === 'SELLER';
        return <tr key={o.id}>
          <td><code>{o.id.slice(-8)}</code><div className="muted small">{date(o.createdAt)}</div></td>
          <td>{seller ? 'Selling' : 'Buying'}</td>
          <td className="r">{num(o.cryptoAmount)} {o.assetSymbol}</td>
          <td className="r">{money(o.fiatAmount, o.fiatCode)}<div className="muted small">@ {num(o.advertisement.price,2)} · {o.advertisement.paymentMethod}</div></td>
          <td>{seller ? o.buyer.name : o.seller.name}</td>
          <td><Badge value={o.status}/>{next(o) && <div className="muted small hint">{next(o)}</div>}{o.dispute?.resolution && <div className="muted small">{o.dispute.resolution}</div>}</td>
          <td><div className="row">
            {seller && o.status==='CREATED' && <Button busy={k('escrow')} onClick={()=>act(o,'escrow','Crypto locked in escrow')}>Lock escrow</Button>}
            {!seller && o.status==='ESCROW_LOCKED' && <Button busy={k('payment-sent')} onClick={()=>act(o,'payment-sent','Marked as paid')}>I've paid</Button>}
            {seller && o.status==='PAYMENT_SENT' && <Button variant="ok" busy={k('release')} onClick={()=>confirm(`Release ${num(o.cryptoAmount)} ${o.assetSymbol} to the buyer? Only do this after confirming you received ${money(o.fiatAmount,o.fiatCode)}.`) && act(o,'release','Crypto released — trade complete')}>Release</Button>}
            {(o.status==='CREATED' || (!seller && o.status==='ESCROW_LOCKED')) && <Button variant="ghost" busy={k('cancel')} onClick={()=>confirm('Cancel this order?') && act(o,'cancel','Order cancelled')}>Cancel</Button>}
            {['ESCROW_LOCKED','PAYMENT_SENT'].includes(o.status) && <Button variant="danger" onClick={()=>{ setReason(''); setDisputeFor(o); }}>Dispute</Button>}
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>
    {disputeFor && <Modal title="Open a dispute" onClose={()=>setDisputeFor(null)}>
      <p className="muted">Escrowed funds stay locked until the support team reviews the case.</p>
      <Field label="What went wrong?" hint="At least 10 characters."><textarea rows={4} value={reason} onChange={e=>setReason(e.target.value)}/></Field>
      <div className="row end"><Button variant="ghost" onClick={()=>setDisputeFor(null)}>Close</Button>
        <Button variant="danger" busy={busy==='dispute'} disabled={reason.trim().length<10} onClick={()=>run('dispute', ()=>api(`/api/v1/p2p/orders/${disputeFor.id}/dispute`, { method:'POST', body:{ reason } }), 'Dispute opened').then(ok=>{ if (ok) { setDisputeFor(null); reload(); } })}>Open dispute</Button></div>
    </Modal>}
  </>;
}
