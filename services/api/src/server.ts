import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Prisma, PrismaClient, UserRole, UserStatus, OrderSide, P2PStatus, LedgerDirection } from '@prisma/client';

const prisma = new PrismaClient();
const app = express();
app.set('trust proxy', 1); // behind Render/Vercel proxy: use real client IP for audit logs and rate limits
app.use(helmet());
const corsOrigins = process.env.CORS_ORIGIN?.split(',').map(o=>o.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins?.length ? corsOrigins : true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production');
const JWT_SECRET = process.env.JWT_SECRET ?? 'development-only-change-me';
const ACCESS_TTL = (process.env.JWT_EXPIRES_IN ?? '15m') as jwt.SignOptions['expiresIn'];
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_DAYS ?? 30);

// ---------- helpers ----------

class HttpError extends Error { constructor(public status:number, public code:string){ super(code); } }
const fail = (status:number, code:string): never => { throw new HttpError(status, code); };

type Tx = Prisma.TransactionClient;
type AuthReq = express.Request & { auth?: {id:string; role:UserRole} };
const D = (v:Prisma.Decimal.Value) => new Prisma.Decimal(v);
const hashToken = (t:string) => crypto.createHash('sha256').update(t).digest('hex');
const param = (req:express.Request, name:string) => String(req.params[name]);
const publicUser = (u:{id:string; email:string; role:UserRole; status:UserStatus; kycStatus:string}) => ({ id:u.id, email:u.email, role:u.role, status:u.status, kycStatus:u.kycStatus });
const maskEmail = (e:string) => { const [n,d]=e.split('@'); return `${n.slice(0,2)}***@${d}`; };

const audit = (actorId:string|undefined, action:string, entityType:string, entityId:string|undefined, reason:string|undefined, req:express.Request) =>
  prisma.auditLog.create({ data:{ actorId, action, entityType, entityId, reason, ip:req.ip, requestId:req.header('x-request-id') ?? undefined } });

async function issueTokens(user:{id:string; role:UserRole}) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await prisma.session.create({ data:{ userId:user.id, tokenHash:hashToken(refreshToken), expiresAt:new Date(Date.now()+REFRESH_TTL_DAYS*86_400_000) } });
  const accessToken = jwt.sign({ sub:user.id, role:user.role }, JWT_SECRET, { expiresIn:ACCESS_TTL });
  return { token:accessToken, accessToken, refreshToken };
}

const auth = (req:AuthReq, res:express.Response, next:express.NextFunction) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ','');
    if (!token) return res.status(401).json({ success:false, code:'UNAUTHORIZED' });
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload & {role:UserRole};
    if (!payload.sub) return res.status(401).json({ success:false, code:'INVALID_TOKEN' });
    req.auth = { id:payload.sub, role:payload.role };
    next();
  } catch { return res.status(401).json({ success:false, code:'INVALID_TOKEN' }); }
};
const roles = (...allowed:UserRole[]) => (req:AuthReq, res:express.Response, next:express.NextFunction) => {
  if (!req.auth || !allowed.includes(req.auth.role)) return res.status(403).json({ success:false, code:'FORBIDDEN' });
  next();
};
const authLimiter = rateLimit({
  windowMs: 15*60_000,
  limit: Number(process.env.AUTH_RATE_LIMIT ?? 20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success:false, code:'TOO_MANY_REQUESTS' },
});

// ---------- wallet / escrow primitives (must run inside a transaction) ----------

async function walletFor(tx:Tx, userId:string, symbol:string) {
  const asset = await tx.asset.findUnique({ where:{ symbol } });
  if (!asset || !asset.enabled) fail(400, 'UNKNOWN_ASSET');
  return tx.wallet.upsert({ where:{ userId_assetId:{ userId, assetId:asset!.id } }, create:{ userId, assetId:asset!.id }, update:{} });
}
const ledger = (tx:Tx, walletId:string, direction:LedgerDirection, amount:Prisma.Decimal, referenceType:string, referenceId:string) =>
  tx.ledgerEntry.create({ data:{ walletId, direction, amount, referenceType, referenceId } });

/** available -> locked on the seller's wallet */
async function lockFunds(tx:Tx, userId:string, symbol:string, amount:Prisma.Decimal, orderId:string) {
  const w = await walletFor(tx, userId, symbol);
  const r = await tx.wallet.updateMany({ where:{ id:w.id, available:{ gte:amount } }, data:{ available:{ decrement:amount }, locked:{ increment:amount } } });
  if (!r.count) fail(409, 'INSUFFICIENT_BALANCE');
  await ledger(tx, w.id, LedgerDirection.DEBIT, amount, 'ESCROW_LOCK', orderId);
}
/** locked -> available on the seller's wallet (cancel / refund) */
async function refundLocked(tx:Tx, userId:string, symbol:string, amount:Prisma.Decimal, orderId:string) {
  const w = await walletFor(tx, userId, symbol);
  const r = await tx.wallet.updateMany({ where:{ id:w.id, locked:{ gte:amount } }, data:{ locked:{ decrement:amount }, available:{ increment:amount } } });
  if (!r.count) fail(409, 'LOCKED_BALANCE_MISMATCH');
  await ledger(tx, w.id, LedgerDirection.CREDIT, amount, 'ESCROW_REFUND', orderId);
}
/** seller locked -> buyer available (release) */
async function releaseLocked(tx:Tx, sellerId:string, buyerId:string, symbol:string, amount:Prisma.Decimal, orderId:string) {
  const s = await walletFor(tx, sellerId, symbol);
  const r = await tx.wallet.updateMany({ where:{ id:s.id, locked:{ gte:amount } }, data:{ locked:{ decrement:amount } } });
  if (!r.count) fail(409, 'LOCKED_BALANCE_MISMATCH');
  const b = await walletFor(tx, buyerId, symbol);
  await tx.wallet.update({ where:{ id:b.id }, data:{ available:{ increment:amount } } });
  await ledger(tx, b.id, LedgerDirection.CREDIT, amount, 'ESCROW_RELEASE', orderId);
}
/** give reserved quantity back to the advertisement */
const restoreAd = (tx:Tx, advertisementId:string, amount:Prisma.Decimal) =>
  tx.p2PAdvertisement.update({ where:{ id:advertisementId }, data:{ available:{ increment:amount } } });
/** move an order between states only if it is still in one of the expected states (guards races) */
async function transition(tx:Tx, orderId:string, from:P2PStatus[], to:P2PStatus) {
  const r = await tx.p2POrder.updateMany({ where:{ id:orderId, status:{ in:from } }, data:{ status:to } });
  if (!r.count) fail(409, 'INVALID_STATUS');
  return tx.p2POrder.findUniqueOrThrow({ where:{ id:orderId } });
}
async function loadOrder(id:string) {
  return (await prisma.p2POrder.findUnique({ where:{ id }, include:{ escrow:true, dispute:true } })) ?? fail(404, 'ORDER_NOT_FOUND');
}

// ---------- public ----------

app.get('/', (_req,res)=>res.json({ success:true, service:'securetrade-api', health:'/health', api:'/api/v1' }));
app.get('/health', (_req,res)=>res.json({ success:true, service:'securetrade-api', time:new Date().toISOString() }));

app.get('/api/v1/assets', async (_req,res)=>{
  res.json({ success:true, data:await prisma.asset.findMany({ where:{ enabled:true }, include:{ networks:{ include:{ network:true } } }, orderBy:{ symbol:'asc' } }) });
});
app.get('/api/v1/fiat', async (_req,res)=>{
  res.json({ success:true, data:await prisma.fiatCurrency.findMany({ where:{ enabled:true }, orderBy:{ code:'asc' } }) });
});
app.get('/api/v1/markets', async (_req,res)=>{
  res.json({ success:true, data:await prisma.tradingPair.findMany({ where:{ enabled:true }, include:{ baseAsset:true, quoteAsset:true }, orderBy:{ symbol:'asc' } }) });
});
app.get('/api/v1/p2p/ads', async (req,res)=>{
  const q = z.object({ asset:z.string().optional(), fiat:z.string().optional(), side:z.enum(['BUY','SELL']).optional() }).parse(req.query);
  const ads = await prisma.p2PAdvertisement.findMany({
    where:{ active:true, available:{ gt:0 }, assetSymbol:q.asset, fiatCode:q.fiat, side:q.side as OrderSide|undefined },
    include:{ vendor:{ select:{ id:true, email:true, kycStatus:true } } },
    orderBy:{ createdAt:'desc' },
  });
  res.json({ success:true, data:ads.map(a=>({ ...a, vendor:{ id:a.vendor.id, name:maskEmail(a.vendor.email), kycStatus:a.vendor.kycStatus } })) });
});

// ---------- auth ----------

app.post('/api/v1/auth/register', authLimiter, async (req,res)=>{
  const input = z.object({ email:z.string().email(), password:z.string().min(10), phone:z.string().optional(), fullName:z.string().min(2).optional() }).parse(req.body);
  const email = input.email.toLowerCase();
  if (await prisma.user.findUnique({ where:{ email } })) return res.status(409).json({ success:false, code:'EMAIL_EXISTS' });
  const user = await prisma.user.create({ data:{ email, phone:input.phone, passwordHash:await bcrypt.hash(input.password,12), profile:{ create:{ fullName:input.fullName } } } });
  await audit(user.id, 'USER_REGISTERED', 'User', user.id, undefined, req);
  res.status(201).json({ success:true, data:{ ...publicUser(user), ...await issueTokens(user) } });
});
app.post('/api/v1/auth/login', authLimiter, async (req,res)=>{
  const input = z.object({ email:z.string().email(), password:z.string() }).parse(req.body);
  const user = await prisma.user.findUnique({ where:{ email:input.email.toLowerCase() } });
  if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ success:false, code:'INVALID_CREDENTIALS' });
  if (user.status !== UserStatus.ACTIVE) return res.status(403).json({ success:false, code:'ACCOUNT_RESTRICTED' });
  await audit(user.id, 'USER_LOGIN', 'User', user.id, undefined, req);
  res.json({ success:true, data:{ ...publicUser(user), ...await issueTokens(user) } });
});
app.post('/api/v1/auth/refresh', authLimiter, async (req,res)=>{
  const { refreshToken } = z.object({ refreshToken:z.string().min(20) }).parse(req.body);
  const session = await prisma.session.findFirst({ where:{ tokenHash:hashToken(refreshToken) }, include:{ user:true } });
  if (!session || session.expiresAt < new Date()) return res.status(401).json({ success:false, code:'INVALID_REFRESH_TOKEN' });
  await prisma.session.delete({ where:{ id:session.id } }); // rotate: each refresh token is single-use
  if (session.user.status !== UserStatus.ACTIVE) return res.status(403).json({ success:false, code:'ACCOUNT_RESTRICTED' });
  res.json({ success:true, data:{ ...publicUser(session.user), ...await issueTokens(session.user) } });
});
app.post('/api/v1/auth/logout', async (req,res)=>{
  const { refreshToken } = z.object({ refreshToken:z.string().min(20) }).parse(req.body);
  await prisma.session.deleteMany({ where:{ tokenHash:hashToken(refreshToken) } });
  res.json({ success:true });
});

// ---------- account ----------

app.get('/api/v1/me', auth, async (req:AuthReq,res)=>{
  const user = await prisma.user.findUnique({ where:{ id:req.auth!.id }, omit:{ passwordHash:true }, include:{ profile:true, wallets:{ include:{ asset:true } } } });
  if (!user) return res.status(404).json({ success:false, code:'USER_NOT_FOUND' });
  res.json({ success:true, data:user });
});
app.get('/api/v1/wallets', auth, async (req:AuthReq,res)=>{
  res.json({ success:true, data:await prisma.wallet.findMany({ where:{ userId:req.auth!.id }, include:{ asset:true }, orderBy:{ asset:{ symbol:'asc' } } }) });
});

// ---------- vendor ads ----------

app.post('/api/v1/vendor/ads', auth, roles(UserRole.USER, UserRole.VENDOR), async (req:AuthReq,res)=>{
  const input = z.object({
    assetSymbol:z.string().min(2).transform(s=>s.toUpperCase()), fiatCode:z.string().length(3).transform(s=>s.toUpperCase()), side:z.enum(['BUY','SELL']),
    price:z.coerce.number().positive(), available:z.coerce.number().positive(), minOrder:z.coerce.number().positive(), maxOrder:z.coerce.number().positive(),
    paymentMethod:z.string().min(2).max(100), terms:z.string().max(2000).optional(),
  }).refine(v=>v.minOrder<=v.maxOrder, { message:'minOrder must be <= maxOrder', path:['minOrder'] }).parse(req.body);
  const asset = await prisma.asset.findUnique({ where:{ symbol:input.assetSymbol } });
  if (!asset?.enabled) return res.status(400).json({ success:false, code:'UNKNOWN_ASSET' });
  const fiat = await prisma.fiatCurrency.findUnique({ where:{ code:input.fiatCode } });
  if (!fiat?.enabled) return res.status(400).json({ success:false, code:'UNKNOWN_FIAT' });
  const ad = await prisma.p2PAdvertisement.create({ data:{ vendorId:req.auth!.id, ...input, side:input.side as OrderSide } });
  await audit(req.auth!.id, 'P2P_AD_CREATED', 'P2PAdvertisement', ad.id, undefined, req);
  res.status(201).json({ success:true, data:ad });
});
app.get('/api/v1/vendor/ads', auth, async (req:AuthReq,res)=>{
  res.json({ success:true, data:await prisma.p2PAdvertisement.findMany({ where:{ vendorId:req.auth!.id }, orderBy:{ createdAt:'desc' } }) });
});
app.patch('/api/v1/vendor/ads/:id', auth, async (req:AuthReq,res)=>{
  const { active } = z.object({ active:z.boolean() }).parse(req.body);
  const r = await prisma.p2PAdvertisement.updateMany({ where:{ id:param(req,'id'), vendorId:req.auth!.id }, data:{ active } });
  if (!r.count) return res.status(404).json({ success:false, code:'AD_NOT_FOUND' });
  await audit(req.auth!.id, active ? 'P2P_AD_ENABLED' : 'P2P_AD_DISABLED', 'P2PAdvertisement', param(req,'id'), undefined, req);
  res.json({ success:true, data:await prisma.p2PAdvertisement.findUnique({ where:{ id:param(req,'id') } }) });
});

// ---------- P2P orders ----------

app.get('/api/v1/p2p/orders', auth, async (req:AuthReq,res)=>{
  const me = req.auth!.id;
  const orders = await prisma.p2POrder.findMany({
    where:{ OR:[{ buyerId:me }, { sellerId:me }] },
    include:{ advertisement:{ select:{ price:true, paymentMethod:true, terms:true, side:true } }, buyer:{ select:{ email:true } }, seller:{ select:{ email:true } }, dispute:true },
    orderBy:{ createdAt:'desc' }, take:100,
  });
  res.json({ success:true, data:orders.map(o=>({ ...o, role:o.buyerId===me?'BUYER':'SELLER', buyer:{ name:maskEmail(o.buyer.email) }, seller:{ name:maskEmail(o.seller.email) } })) });
});

app.post('/api/v1/p2p/orders', auth, async (req:AuthReq,res)=>{
  const input = z.object({ advertisementId:z.string(), cryptoAmount:z.coerce.number().positive() }).parse(req.body);
  const me = req.auth!.id;
  const amount = D(input.cryptoAmount);
  const order = await prisma.$transaction(async tx=>{
    const ad = await tx.p2PAdvertisement.findUnique({ where:{ id:input.advertisementId } });
    if (!ad || !ad.active) fail(404, 'AD_NOT_FOUND');
    if (ad!.vendorId === me) fail(400, 'SELF_ORDER');
    if (amount.lt(ad!.minOrder) || amount.gt(ad!.maxOrder)) fail(400, 'AMOUNT_OUT_OF_RANGE');
    // reserve the quantity on the ad atomically so it can't be oversold
    const r = await tx.p2PAdvertisement.updateMany({ where:{ id:ad!.id, active:true, available:{ gte:amount } }, data:{ available:{ decrement:amount } } });
    if (!r.count) fail(409, 'INSUFFICIENT_AD_LIQUIDITY');
    // SELL ad: vendor sells crypto to the taker. BUY ad: vendor buys crypto from the taker.
    const [buyerId, sellerId] = ad!.side === OrderSide.SELL ? [me, ad!.vendorId] : [ad!.vendorId, me];
    return tx.p2POrder.create({ data:{ advertisementId:ad!.id, buyerId, sellerId, assetSymbol:ad!.assetSymbol, fiatCode:ad!.fiatCode, cryptoAmount:amount, fiatAmount:amount.mul(ad!.price), status:P2PStatus.CREATED } });
  });
  await audit(me, 'P2P_ORDER_CREATED', 'P2POrder', order.id, undefined, req);
  res.status(201).json({ success:true, data:order });
});

app.post('/api/v1/p2p/orders/:id/escrow', auth, async (req:AuthReq,res)=>{
  const order = await loadOrder(param(req,'id'));
  if (order.sellerId !== req.auth!.id) return res.status(403).json({ success:false, code:'FORBIDDEN' });
  const updated = await prisma.$transaction(async tx=>{
    const o = await transition(tx, order.id, [P2PStatus.CREATED], P2PStatus.ESCROW_LOCKED);
    await lockFunds(tx, order.sellerId, order.assetSymbol, order.cryptoAmount, order.id);
    const escrow = await tx.escrow.create({ data:{ p2pOrderId:order.id, assetSymbol:order.assetSymbol, amount:order.cryptoAmount } });
    return { ...o, escrow };
  });
  await audit(req.auth!.id, 'P2P_ESCROW_LOCKED', 'P2POrder', order.id, 'Seller locked crypto for escrow', req);
  res.json({ success:true, data:updated });
});

app.post('/api/v1/p2p/orders/:id/payment-sent', auth, async (req:AuthReq,res)=>{
  const order = await loadOrder(param(req,'id'));
  if (order.buyerId !== req.auth!.id) return res.status(404).json({ success:false, code:'ORDER_NOT_FOUND' });
  const o = await prisma.$transaction(tx=>transition(tx, order.id, [P2PStatus.ESCROW_LOCKED], P2PStatus.PAYMENT_SENT));
  await audit(req.auth!.id, 'P2P_PAYMENT_MARKED_SENT', 'P2POrder', o.id, undefined, req);
  res.json({ success:true, data:o });
});

app.post('/api/v1/p2p/orders/:id/release', auth, async (req:AuthReq,res)=>{
  const order = await loadOrder(param(req,'id'));
  if (order.sellerId !== req.auth!.id) return res.status(404).json({ success:false, code:'ORDER_NOT_FOUND' });
  if (!order.escrow || order.escrow.releasedAt) return res.status(409).json({ success:false, code:'ESCROW_NOT_RELEASEABLE' });
  const result = await prisma.$transaction(async tx=>{
    const o = await transition(tx, order.id, [P2PStatus.PAYMENT_SENT], P2PStatus.COMPLETED);
    await releaseLocked(tx, order.sellerId, order.buyerId, order.assetSymbol, order.cryptoAmount, order.id);
    await tx.escrow.update({ where:{ id:order.escrow!.id }, data:{ releasedAt:new Date() } });
    return o;
  });
  await audit(req.auth!.id, 'P2P_ESCROW_RELEASED', 'P2POrder', result.id, 'Seller confirmed fiat receipt', req);
  res.json({ success:true, data:result });
});

app.post('/api/v1/p2p/orders/:id/cancel', auth, async (req:AuthReq,res)=>{
  const order = await loadOrder(param(req,'id'));
  const me = req.auth!.id;
  if (![order.buyerId, order.sellerId].includes(me)) return res.status(404).json({ success:false, code:'ORDER_NOT_FOUND' });
  // Either side may cancel before escrow; once crypto is locked only the buyer may back out (before paying).
  const allowed:P2PStatus[] = me === order.buyerId ? [P2PStatus.CREATED, P2PStatus.ESCROW_LOCKED] : [P2PStatus.CREATED];
  const result = await prisma.$transaction(async tx=>{
    const o = await transition(tx, order.id, allowed, P2PStatus.CANCELLED);
    if (order.escrow && !order.escrow.releasedAt) {
      await refundLocked(tx, order.sellerId, order.assetSymbol, order.cryptoAmount, order.id);
      await tx.escrow.update({ where:{ id:order.escrow.id }, data:{ releasedAt:new Date() } });
    }
    await restoreAd(tx, order.advertisementId, order.cryptoAmount);
    return o;
  });
  await audit(me, 'P2P_ORDER_CANCELLED', 'P2POrder', order.id, undefined, req);
  res.json({ success:true, data:result });
});

app.post('/api/v1/p2p/orders/:id/dispute', auth, async (req:AuthReq,res)=>{
  const input = z.object({ reason:z.string().min(10).max(2000) }).parse(req.body);
  const order = await loadOrder(param(req,'id'));
  if (![order.buyerId, order.sellerId].includes(req.auth!.id)) return res.status(404).json({ success:false, code:'ORDER_NOT_FOUND' });
  if (order.dispute) return res.status(409).json({ success:false, code:'DISPUTE_EXISTS' });
  const d = await prisma.$transaction(async tx=>{
    await transition(tx, order.id, [P2PStatus.ESCROW_LOCKED, P2PStatus.PAYMENT_SENT], P2PStatus.DISPUTED);
    return tx.dispute.create({ data:{ orderId:order.id, openedBy:req.auth!.id, reason:input.reason } });
  });
  await audit(req.auth!.id, 'P2P_DISPUTE_OPENED', 'Dispute', d.id, input.reason, req);
  res.status(201).json({ success:true, data:d });
});

// ---------- admin ----------

const ADMINS = [UserRole.SUPER_ADMIN, UserRole.COMPLIANCE, UserRole.SUPPORT, UserRole.P2P_ADMIN, UserRole.FINANCE, UserRole.AUDITOR] as const;

app.get('/api/v1/admin/stats', auth, roles(...ADMINS), async (_req,res)=>{
  const [users, openDisputes, activeAds, orders, completed] = await Promise.all([
    prisma.user.count(), prisma.dispute.count({ where:{ resolvedAt:null } }), prisma.p2PAdvertisement.count({ where:{ active:true } }),
    prisma.p2POrder.count(), prisma.p2POrder.count({ where:{ status:P2PStatus.COMPLETED } }),
  ]);
  res.json({ success:true, data:{ users, openDisputes, activeAds, orders, completed } });
});
app.get('/api/v1/admin/users', auth, roles(UserRole.SUPER_ADMIN, UserRole.COMPLIANCE, UserRole.SUPPORT), async (_req,res)=>{
  res.json({ success:true, data:await prisma.user.findMany({ omit:{ passwordHash:true }, orderBy:{ createdAt:'desc' }, take:200 }) });
});
app.patch('/api/v1/admin/users/:id', auth, roles(UserRole.SUPER_ADMIN), async (req:AuthReq,res)=>{
  const input = z.object({ role:z.nativeEnum(UserRole).optional(), status:z.nativeEnum(UserStatus).optional(), reason:z.string().min(3).max(500) }).parse(req.body);
  if (param(req,'id') === req.auth!.id) return res.status(400).json({ success:false, code:'CANNOT_MODIFY_SELF' });
  const user = await prisma.user.update({ where:{ id:param(req,'id') }, data:{ role:input.role, status:input.status }, omit:{ passwordHash:true } }).catch(()=>fail(404,'USER_NOT_FOUND'));
  if (input.status && input.status !== UserStatus.ACTIVE) await prisma.session.deleteMany({ where:{ userId:user.id } });
  await audit(req.auth!.id, 'USER_UPDATED', 'User', user.id, `${input.reason} ${JSON.stringify({ role:input.role, status:input.status })}`, req);
  res.json({ success:true, data:user });
});
app.get('/api/v1/admin/disputes', auth, roles(UserRole.SUPER_ADMIN, UserRole.P2P_ADMIN, UserRole.SUPPORT), async (_req,res)=>{
  res.json({ success:true, data:await prisma.dispute.findMany({ include:{ order:{ include:{ buyer:{ select:{ email:true } }, seller:{ select:{ email:true } } } } }, orderBy:{ createdAt:'desc' }, take:200 }) });
});
app.post('/api/v1/admin/disputes/:id/resolve', auth, roles(UserRole.SUPER_ADMIN, UserRole.P2P_ADMIN), async (req:AuthReq,res)=>{
  const input = z.object({ outcome:z.enum(['RELEASE_TO_BUYER','REFUND_SELLER']), resolution:z.string().min(5).max(2000) }).parse(req.body);
  const dispute = await prisma.dispute.findUnique({ where:{ id:param(req,'id') }, include:{ order:{ include:{ escrow:true } } } });
  if (!dispute) return res.status(404).json({ success:false, code:'DISPUTE_NOT_FOUND' });
  if (dispute.resolvedAt) return res.status(409).json({ success:false, code:'ALREADY_RESOLVED' });
  const { order } = dispute;
  const result = await prisma.$transaction(async tx=>{
    await transition(tx, order.id, [P2PStatus.DISPUTED], P2PStatus.RESOLVED);
    if (order.escrow && !order.escrow.releasedAt) {
      if (input.outcome === 'RELEASE_TO_BUYER') await releaseLocked(tx, order.sellerId, order.buyerId, order.assetSymbol, order.cryptoAmount, order.id);
      else { await refundLocked(tx, order.sellerId, order.assetSymbol, order.cryptoAmount, order.id); await restoreAd(tx, order.advertisementId, order.cryptoAmount); }
      await tx.escrow.update({ where:{ id:order.escrow.id }, data:{ releasedAt:new Date() } });
    }
    return tx.dispute.update({ where:{ id:dispute.id }, data:{ resolution:`${input.outcome}: ${input.resolution}`, resolvedBy:req.auth!.id, resolvedAt:new Date() } });
  });
  await audit(req.auth!.id, 'P2P_DISPUTE_RESOLVED', 'Dispute', dispute.id, `${input.outcome}: ${input.resolution}`, req);
  res.json({ success:true, data:result });
});
app.post('/api/v1/admin/wallets/credit', auth, roles(UserRole.SUPER_ADMIN, UserRole.FINANCE), async (req:AuthReq,res)=>{
  const input = z.object({ email:z.string().email(), assetSymbol:z.string().transform(s=>s.toUpperCase()), amount:z.coerce.number().positive(), reason:z.string().min(3).max(500) }).parse(req.body);
  const user = await prisma.user.findUnique({ where:{ email:input.email.toLowerCase() } });
  if (!user) return res.status(404).json({ success:false, code:'USER_NOT_FOUND' });
  const amount = D(input.amount);
  const wallet = await prisma.$transaction(async tx=>{
    const w = await walletFor(tx, user.id, input.assetSymbol);
    await ledger(tx, w.id, LedgerDirection.CREDIT, amount, 'ADMIN_CREDIT', req.auth!.id);
    return tx.wallet.update({ where:{ id:w.id }, data:{ available:{ increment:amount } }, include:{ asset:true } });
  });
  await audit(req.auth!.id, 'WALLET_CREDITED', 'Wallet', wallet.id, `${input.amount} ${input.assetSymbol} to ${user.email}: ${input.reason}`, req);
  res.json({ success:true, data:wallet });
});
app.get('/api/v1/admin/audit', auth, roles(UserRole.SUPER_ADMIN, UserRole.AUDITOR), async (_req,res)=>{
  res.json({ success:true, data:await prisma.auditLog.findMany({ orderBy:{ createdAt:'desc' }, take:200, include:{ actor:{ select:{ id:true, email:true, role:true } } } }) });
});

// ---------- errors ----------

app.use((_req,res)=>res.status(404).json({ success:false, code:'NOT_FOUND' }));
app.use((err:unknown, _req:express.Request, res:express.Response, _next:express.NextFunction)=>{
  if (err instanceof HttpError) return res.status(err.status).json({ success:false, code:err.code });
  if (err instanceof z.ZodError) return res.status(400).json({ success:false, code:'VALIDATION_ERROR', issues:err.issues.map(i=>({ path:i.path.join('.'), message:i.message })) });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ success:false, code:'INVALID_JSON' });
  console.error(err);
  res.status(500).json({ success:false, code:'INTERNAL_ERROR', message:'An unexpected error occurred' });
});

export default app;
if (!process.env.VERCEL) { const port = Number(process.env.PORT ?? 4000); app.listen(port, ()=>console.log(`SecureTrade API listening on :${port}`)); }
