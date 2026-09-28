// Idempotent reference-data seed. Safe to run on every deploy.
// Creates assets, networks, fiat currencies and trading pairs, and — if ADMIN_EMAIL and
// ADMIN_PASSWORD are set — a SUPER_ADMIN account (existing passwords are never overwritten).
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

const networks = [
  { code:'BTC', name:'Bitcoin' },
  { code:'ERC20', name:'Ethereum (ERC-20)' },
  { code:'TRC20', name:'Tron (TRC-20)' },
];
const assets = [
  { symbol:'USDT', name:'Tether USD', type:'STABLECOIN', decimals:6, networks:['ERC20','TRC20'] },
  { symbol:'BTC', name:'Bitcoin', type:'CRYPTO', decimals:8, networks:['BTC'] },
  { symbol:'ETH', name:'Ethereum', type:'CRYPTO', decimals:18, networks:['ERC20'] },
];
const fiat = [
  { code:'INR', name:'Indian Rupee', symbol:'₹' },
  { code:'USD', name:'US Dollar', symbol:'$' },
  { code:'EUR', name:'Euro', symbol:'€' },
];
const pairs = [
  { symbol:'BTC-USDT', base:'BTC', quote:'USDT', minQuantity:'0.00001' },
  { symbol:'ETH-USDT', base:'ETH', quote:'USDT', minQuantity:'0.0001' },
];

async function main() {
  for (const n of networks) await prisma.network.upsert({ where:{ code:n.code }, create:n, update:{ name:n.name } });

  for (const { networks:nets, ...a } of assets) {
    const asset = await prisma.asset.upsert({ where:{ symbol:a.symbol }, create:a, update:{ name:a.name, type:a.type, decimals:a.decimals } });
    for (const code of nets) {
      const network = await prisma.network.findUniqueOrThrow({ where:{ code } });
      await prisma.assetNetwork.upsert({ where:{ assetId_networkId:{ assetId:asset.id, networkId:network.id } }, create:{ assetId:asset.id, networkId:network.id }, update:{} });
    }
  }

  for (const f of fiat) await prisma.fiatCurrency.upsert({ where:{ code:f.code }, create:f, update:{ name:f.name, symbol:f.symbol } });

  for (const p of pairs) {
    const base = await prisma.asset.findUniqueOrThrow({ where:{ symbol:p.base } });
    const quote = await prisma.asset.findUniqueOrThrow({ where:{ symbol:p.quote } });
    await prisma.tradingPair.upsert({
      where:{ symbol:p.symbol },
      create:{ symbol:p.symbol, baseAssetId:base.id, quoteAssetId:quote.id, makerFee:'0.001', takerFee:'0.001', minQuantity:p.minQuantity },
      update:{},
    });
  }

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    const existing = await prisma.user.findUnique({ where:{ email } });
    if (!existing) {
      await prisma.user.create({ data:{ email, role:UserRole.SUPER_ADMIN, passwordHash:await bcrypt.hash(password,12), profile:{ create:{ fullName:'Platform Admin' } } } });
      console.log(`Seed: created SUPER_ADMIN ${email}`);
    } else if (existing.role !== UserRole.SUPER_ADMIN) {
      await prisma.user.update({ where:{ id:existing.id }, data:{ role:UserRole.SUPER_ADMIN } });
      console.log(`Seed: promoted ${email} to SUPER_ADMIN`);
    }
  } else {
    console.log('Seed: ADMIN_EMAIL/ADMIN_PASSWORD not set, skipping admin account');
  }
  console.log('Seed: reference data up to date');
}

main().finally(()=>prisma.$disconnect()).catch(e=>{ console.error(e); process.exit(1); });
