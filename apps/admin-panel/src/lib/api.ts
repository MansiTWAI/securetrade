// Shared API client — identical copy in apps/user-web, apps/vendor-panel and apps/admin-panel (src/lib).
export const API_URL = (import.meta.env.VITE_API_URL ?? 'https://securetrade-api.onrender.com').replace(/\/$/, '');

export type Role = 'USER'|'VENDOR'|'SUPPORT'|'COMPLIANCE'|'FINANCE'|'TRADING_ADMIN'|'P2P_ADMIN'|'AUDITOR'|'SUPER_ADMIN';
export type Session = { id:string; email:string; role:Role; accessToken:string; refreshToken:string };
export type Asset = { id:string; symbol:string; name:string; type:string; decimals:number };
export type Fiat = { code:string; name:string; symbol:string };
export type Wallet = { id:string; available:string; locked:string; asset:Asset };
export type Pair = { id:string; symbol:string; makerFee:string; takerFee:string; minQuantity:string; baseAsset:Asset; quoteAsset:Asset };
export type Ad = { id:string; vendorId:string; assetSymbol:string; fiatCode:string; side:'BUY'|'SELL'; price:string; available:string; minOrder:string; maxOrder:string; paymentMethod:string; terms?:string|null; active:boolean; createdAt:string; vendor?:{ id:string; name:string; kycStatus:string } };
export type OrderStatus = 'CREATED'|'ESCROW_LOCKED'|'PAYMENT_SENT'|'COMPLETED'|'CANCELLED'|'DISPUTED'|'RESOLVED'|string;
export type Order = { id:string; advertisementId:string; buyerId:string; sellerId:string; assetSymbol:string; fiatCode:string; cryptoAmount:string; fiatAmount:string; status:OrderStatus; createdAt:string; role:'BUYER'|'SELLER'; advertisement:{ price:string; paymentMethod:string; terms?:string|null; side:string }; buyer:{ name:string }; seller:{ name:string }; dispute?:{ id:string; reason:string; resolution?:string|null }|null };

export class ApiError extends Error {
  constructor(public status:number, public code:string, public issues?:{ path:string; message:string }[]) { super(code); }
}

const MESSAGES:Record<string,string> = {
  INVALID_CREDENTIALS:'Wrong email or password.', EMAIL_EXISTS:'An account with this email already exists.', ACCOUNT_RESTRICTED:'This account is restricted. Contact support.',
  TOO_MANY_REQUESTS:'Too many attempts. Please wait a few minutes and try again.', UNAUTHORIZED:'Please sign in again.', INVALID_TOKEN:'Your session expired. Please sign in again.',
  FORBIDDEN:"You don't have permission to do that.", INSUFFICIENT_BALANCE:'Not enough available balance to lock this amount in escrow.',
  INSUFFICIENT_AD_LIQUIDITY:'This ad no longer has enough available quantity.', AMOUNT_OUT_OF_RANGE:"Amount is outside this ad's min/max limits.",
  SELF_ORDER:"You can't trade with your own ad.", AD_NOT_FOUND:'This ad is no longer available.', INVALID_STATUS:'This action is not allowed in the order\'s current state.',
  DISPUTE_EXISTS:'A dispute is already open for this order.', UNKNOWN_ASSET:'Unknown or disabled asset.', UNKNOWN_FIAT:'Unknown or disabled fiat currency.',
  USER_NOT_FOUND:'No user with that email.', CANNOT_MODIFY_SELF:"You can't change your own role or status.", ALREADY_RESOLVED:'This dispute is already resolved.',
  NETWORK:'Cannot reach the server. Check your connection and try again.',
};
export function errorMessage(e:unknown) {
  if (e instanceof ApiError) {
    if (e.code === 'VALIDATION_ERROR' && e.issues?.length) return e.issues.map(i=>`${i.path || 'input'}: ${i.message}`).join('; ');
    return MESSAGES[e.code] ?? `Request failed (${e.code}).`;
  }
  return e instanceof Error ? e.message : 'Something went wrong.';
}

// ---- session storage ----
const KEY = `securetrade.session.${location.host}`;
let session:Session|null = (()=>{ try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } })();
const listeners = new Set<(s:Session|null)=>void>();
export const getSession = () => session;
export function setSession(s:Session|null) {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  listeners.forEach(l=>l(s));
}
export function onSessionChange(fn:(s:Session|null)=>void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
const toSession = (d:any):Session => ({ id:d.id, email:d.email, role:d.role, accessToken:d.accessToken, refreshToken:d.refreshToken });

// ---- slow-server notice (Render free tier cold starts take ~50s) ----
let inflight = 0; let slowTimer:ReturnType<typeof setTimeout>|undefined;
const slowListeners = new Set<(slow:boolean)=>void>();
export function onSlowServer(fn:(slow:boolean)=>void) { slowListeners.add(fn); return () => { slowListeners.delete(fn); }; }
function track<T>(p:Promise<T>) {
  if (inflight++ === 0) slowTimer = setTimeout(()=>slowListeners.forEach(l=>l(true)), 4000);
  return p.finally(()=>{ if (--inflight === 0) { clearTimeout(slowTimer); slowListeners.forEach(l=>l(false)); } });
}

let refreshing:Promise<boolean>|null = null;
function refreshSession() {
  refreshing ??= (async()=>{
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ refreshToken:session?.refreshToken }) });
      const json = await res.json().catch(()=>({}));
      if (!res.ok) { setSession(null); return false; }
      setSession(toSession(json.data)); return true;
    } catch { return false; }
    finally { setTimeout(()=>{ refreshing = null; }); }
  })();
  return refreshing;
}

export async function api<T>(path:string, opts:{ method?:string; body?:unknown; auth?:boolean } = {}):Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  const send = () => fetch(API_URL + path, {
    method,
    headers:{ 'content-type':'application/json', ...(auth && session ? { authorization:`Bearer ${session.accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return track((async()=>{
    let res:Response;
    try { res = await send(); } catch { throw new ApiError(0, 'NETWORK'); }
    if (res.status === 401 && auth && session?.refreshToken && await refreshSession()) {
      try { res = await send(); } catch { throw new ApiError(0, 'NETWORK'); }
    }
    const json = await res.json().catch(()=>({}));
    if (!res.ok || json.success === false) {
      if (res.status === 401 && auth) setSession(null);
      throw new ApiError(res.status, json.code ?? `HTTP_${res.status}`, json.issues);
    }
    return json.data as T;
  })());
}

export async function login(email:string, password:string) {
  const d = await api<any>('/api/v1/auth/login', { method:'POST', body:{ email, password }, auth:false });
  setSession(toSession(d)); return getSession()!;
}
export async function register(email:string, password:string, fullName?:string) {
  const d = await api<any>('/api/v1/auth/register', { method:'POST', body:{ email, password, fullName:fullName || undefined }, auth:false });
  setSession(toSession(d)); return getSession()!;
}
export async function logout() {
  const rt = session?.refreshToken;
  setSession(null);
  if (rt) await api('/api/v1/auth/logout', { method:'POST', body:{ refreshToken:rt }, auth:false }).catch(()=>{});
}
