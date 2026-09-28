// End-to-end smoke test against a running API.
//   API_URL=http://localhost:4000 ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/smoke.mjs
// Without admin credentials the wallet-funded escrow steps are skipped.
const API = (process.env.API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const run = Date.now();
let failures = 0;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
}
const register = async (tag) => (await call('POST', '/api/v1/auth/register', { body: { email: `smoke-${tag}-${run}@test.local`, password: 'Smoke-Test-Pass-1' } })).json.data;

const health = await call('GET', '/health');
check('health', health.status === 200, health);
const assets = await call('GET', '/api/v1/assets');
check('assets seeded', assets.json.data?.some((a) => a.symbol === 'USDT'), assets.json);
const markets = await call('GET', '/api/v1/markets');
check('markets seeded', markets.json.data?.length >= 2, markets.json);

const vendor = await register('vendor');
const buyer = await register('buyer');
check('register returns access + refresh tokens', vendor?.accessToken && vendor?.refreshToken, vendor);

const me = await call('GET', '/api/v1/me', { token: buyer.accessToken });
check('/me hides passwordHash', me.status === 200 && !('passwordHash' in me.json.data), me.json);

const refreshed = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: buyer.refreshToken } });
check('refresh issues new tokens', refreshed.status === 200 && refreshed.json.data.refreshToken !== buyer.refreshToken, refreshed.json);
const reused = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: buyer.refreshToken } });
check('refresh token is single-use', reused.status === 401, reused);
buyer.accessToken = refreshed.json.data.accessToken;

const badAd = await call('POST', '/api/v1/vendor/ads', { token: vendor.accessToken, body: { assetSymbol: 'NOPE', fiatCode: 'INR', side: 'SELL', price: 1, available: 1, minOrder: 1, maxOrder: 1, paymentMethod: 'UPI' } });
check('ad with unknown asset rejected', badAd.status === 400, badAd.json);

const ad = (await call('POST', '/api/v1/vendor/ads', { token: vendor.accessToken, body: { assetSymbol: 'USDT', fiatCode: 'INR', side: 'SELL', price: 88.5, available: 100, minOrder: 10, maxOrder: 80, paymentMethod: 'UPI' } })).json.data;
check('ad created', !!ad?.id, ad);

const order = (await call('POST', '/api/v1/p2p/orders', { token: buyer.accessToken, body: { advertisementId: ad.id, cryptoAmount: 20 } })).json.data;
check('order created with fiat total', order?.fiatAmount === '1770', order);
const adAfter = (await call('GET', '/api/v1/p2p/ads?asset=USDT')).json.data.find((a) => a.id === ad.id);
check('ad liquidity reserved (100 -> 80)', adAfter?.available === '80', adAfter);
check('public ad hides vendor email', !adAfter?.vendor?.email, adAfter?.vendor);

const oversell = await call('POST', '/api/v1/p2p/orders', { token: buyer.accessToken, body: { advertisementId: ad.id, cryptoAmount: 80 } });
const oversell2 = await call('POST', '/api/v1/p2p/orders', { token: buyer.accessToken, body: { advertisementId: ad.id, cryptoAmount: 10 } });
check('ad cannot be oversold', oversell.status === 201 && oversell2.status === 409, [oversell.json, oversell2.json]);
await call('POST', `/api/v1/p2p/orders/${oversell.json.data?.id}/cancel`, { token: buyer.accessToken });
const adRestored = (await call('GET', '/api/v1/p2p/ads?asset=USDT')).json.data.find((a) => a.id === ad.id);
check('cancel restores ad liquidity', adRestored?.available === '80', adRestored);

const noFunds = await call('POST', `/api/v1/p2p/orders/${order.id}/escrow`, { token: vendor.accessToken });
check('escrow requires seller balance', noFunds.status === 409 && noFunds.json.code === 'INSUFFICIENT_BALANCE', noFunds.json);
const earlyDispute = await call('POST', `/api/v1/p2p/orders/${order.id}/dispute`, { token: buyer.accessToken, body: { reason: 'dispute before escrow is locked' } });
check('dispute blocked before escrow', earlyDispute.status === 409, earlyDispute.json);

if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const admin = (await call('POST', '/api/v1/auth/login', { body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })).json.data;
  check('admin login', admin?.role === 'SUPER_ADMIN', admin);
  const credit = await call('POST', '/api/v1/admin/wallets/credit', { token: admin.accessToken, body: { email: `smoke-vendor-${run}@test.local`, assetSymbol: 'USDT', amount: 50, reason: 'smoke test funding' } });
  check('admin credits vendor wallet', credit.json.data?.available === '50', credit.json);

  const esc = await call('POST', `/api/v1/p2p/orders/${order.id}/escrow`, { token: vendor.accessToken });
  check('escrow locks seller funds', esc.json.data?.status === 'ESCROW_LOCKED', esc.json);
  const vw = (await call('GET', '/api/v1/wallets', { token: vendor.accessToken })).json.data.find((w) => w.asset.symbol === 'USDT');
  check('seller wallet 30 available / 20 locked', vw?.available === '30' && vw?.locked === '20', vw);
  await call('POST', `/api/v1/p2p/orders/${order.id}/payment-sent`, { token: buyer.accessToken });
  const rel = await call('POST', `/api/v1/p2p/orders/${order.id}/release`, { token: vendor.accessToken });
  check('release completes order', rel.json.data?.status === 'COMPLETED', rel.json);
  const bw = (await call('GET', '/api/v1/wallets', { token: buyer.accessToken })).json.data.find((w) => w.asset.symbol === 'USDT');
  const vw2 = (await call('GET', '/api/v1/wallets', { token: vendor.accessToken })).json.data.find((w) => w.asset.symbol === 'USDT');
  check('buyer received 20 USDT, seller locked back to 0', bw?.available === '20' && vw2?.locked === '0', { bw, vw2 });
  const lateDispute = await call('POST', `/api/v1/p2p/orders/${order.id}/dispute`, { token: buyer.accessToken, body: { reason: 'dispute after completion' } });
  check('dispute blocked on completed order', lateDispute.status === 409, lateDispute.json);

  // dispute + admin resolution (refund seller)
  const o2 = (await call('POST', '/api/v1/p2p/orders', { token: buyer.accessToken, body: { advertisementId: ad.id, cryptoAmount: 10 } })).json.data;
  await call('POST', `/api/v1/p2p/orders/${o2.id}/escrow`, { token: vendor.accessToken });
  const d = await call('POST', `/api/v1/p2p/orders/${o2.id}/dispute`, { token: buyer.accessToken, body: { reason: 'seller unresponsive after lock' } });
  check('dispute opened on locked order', d.status === 201, d.json);
  const dup = await call('POST', `/api/v1/p2p/orders/${o2.id}/dispute`, { token: vendor.accessToken, body: { reason: 'second dispute attempt' } });
  check('duplicate dispute rejected', dup.status === 409, dup.json);
  const resolved = await call('POST', `/api/v1/admin/disputes/${d.json.data.id}/resolve`, { token: admin.accessToken, body: { outcome: 'REFUND_SELLER', resolution: 'buyer never paid' } });
  check('admin resolves dispute', resolved.status === 200, resolved.json);
  const vw3 = (await call('GET', '/api/v1/wallets', { token: vendor.accessToken })).json.data.find((w) => w.asset.symbol === 'USDT');
  check('refund returned seller funds (30 available / 0 locked)', vw3?.available === '30' && vw3?.locked === '0', vw3);
  const stats = await call('GET', '/api/v1/admin/stats', { token: admin.accessToken });
  check('admin stats', stats.status === 200 && typeof stats.json.data.users === 'number', stats.json);
} else {
  console.log('SKIP  admin/escrow steps (set ADMIN_EMAIL and ADMIN_PASSWORD)');
}

const forbidden = await call('GET', '/api/v1/admin/audit', { token: buyer.accessToken });
check('non-admin blocked from audit', forbidden.status === 403, forbidden.json);
const notFound = await call('GET', '/api/v1/nope');
check('unknown route returns JSON 404', notFound.status === 404 && notFound.json.code === 'NOT_FOUND', notFound);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
