/**
 * STRES & EŞZAMANLILIK TESTİ — gerçek dünya yükünü taklit eder.
 * Amaç: aynı anda çok kullanıcı + salon işlem yaparken overbooking / race condition /
 * çökme / veri tutarsızlığı OLMADIĞINI kanıtlamak.
 *
 * Çalıştırma:  npm run stress   (kendi sunucusunu test portunda açar, seed eder, temizler)
 */
import { spawn, ChildProcess } from 'child_process'
import jwt from 'jsonwebtoken'
import prisma from '../src/utils/prisma'

const PORT = 3198
const BASE = `http://localhost:${PORT}`
const JWT_SECRET = process.env.JWT_SECRET || 'fitpass-secret-key-change-in-production'

// Yüksek ID aralığı (çakışmasın)
const B = 980000
const V = B, C = B, NB = B
const SESS_CAP3 = B + 1, SESS_GROUP = B + 2, SESS_CANCEL = B + 3, SESS_DOUBLE = B + 4
const SLOT = B + 1
const NUSERS = 30

let pass = 0, fail = 0
const lines: string[] = []
const users: { id: number; token: string }[] = []
let tierId: number | null = null
let pointRate = 0

function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; lines.push(`  ✅ ${name}`) }
  else { fail++; lines.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

async function http(path: string, opts: { token?: string; method?: string; body?: any } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.body) headers['Content-Type'] = 'application/json'
  const t0 = Date.now()
  try {
    const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
    return { status: res.status, ms: Date.now() - t0 }
  } catch (e: any) {
    return { status: 0, ms: Date.now() - t0, err: e?.message }
  }
}

async function makeSession(id: number, spots: number) {
  await prisma.booking.deleteMany({ where: { sessionId: id } }).catch(() => {})
  await prisma.class_Session.upsert({
    where: { id }, update: { availableSpots: spots, status: 'open' },
    create: { id, classId: C, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), availableSpots: spots, status: 'open' },
  })
}

async function seed() {
  await prisma.city.upsert({ where: { id: 1 }, update: {}, create: { id: 1, name: 'İstanbul' } })
  await prisma.neighborhood.upsert({ where: { id: NB }, update: {}, create: { id: NB, name: 'StressMah', latitude: 41, longitude: 29, cityId: 1 } })
  const cat = await prisma.sportCategory.findFirst({})
  const tier = await prisma.tier.findFirst({ where: { pointRate: { gt: 0 } }, orderBy: { pointRate: 'desc' } })
  tierId = tier?.id ?? null; pointRate = tier?.pointRate ?? 0
  await prisma.venue.upsert({ where: { id: V }, update: {}, create: { id: V, name: 'Stress Venue', email: `stress${V}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: NB, cityId: 1 } })
  await prisma.class.upsert({ where: { id: C }, update: {}, create: { id: C, venueId: V, title: 'Stress Class', category: cat?.name || 'Yoga', sportCategoryId: cat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 100, isActive: true } })
  await makeSession(SESS_CAP3, 3)
  await makeSession(SESS_GROUP, 6)
  await makeSession(SESS_CANCEL, 5)
  await makeSession(SESS_DOUBLE, 10)
  // Drop-in slot (4 kişilik)
  await prisma.dropInParticipant.deleteMany({ where: { slotId: SLOT } }).catch(() => {})
  await prisma.dropInSlot.upsert({
    where: { id: SLOT }, update: { currentPlayers: 0, totalPlayers: 4, status: 'open' },
    create: { id: SLOT, venueId: V, sportCategoryId: cat!.id, title: 'Stress DropIn', startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), format: '2v2', totalPlayers: 4, currentPlayers: 0, totalPrice: 400, pricePerPerson: 100, status: 'open' },
  })
  // Kullanıcılar (hepsi puan kazanan bir tier'da)
  for (let i = 0; i < NUSERS; i++) {
    const id = B + 100 + i
    await prisma.user.upsert({
      where: { id }, update: { tierId, rewardPoints: 0 },
      create: { id, username: `stress_${id}`, email: `stress_${id}@x.com`, passwordHash: 'x', fullName: `Stress ${i}`, tierSportCounts: {}, tierId, rewardPoints: 0 },
    })
    await prisma.rewardPoint.deleteMany({ where: { userId: id } }).catch(() => {})
    users.push({ id, token: jwt.sign({ userId: id, email: `stress_${id}@x.com` }, JWT_SECRET, { expiresIn: '1h' }) })
  }
}

async function cleanup() {
  const ids = users.map(u => u.id)
  await prisma.rewardPoint.deleteMany({ where: { userId: { in: ids } } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { OR: [{ userId: { in: ids } }, { sessionId: { in: [SESS_CAP3, SESS_GROUP, SESS_CANCEL, SESS_DOUBLE] } }] } }).catch(() => {})
  await prisma.dropInParticipant.deleteMany({ where: { slotId: SLOT } }).catch(() => {})
  await prisma.dropInSlot.deleteMany({ where: { id: SLOT } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [SESS_CAP3, SESS_GROUP, SESS_CANCEL, SESS_DOUBLE] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: C } }).catch(() => {})
  await prisma.dropInSlot.deleteMany({ where: { venueId: V } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: V } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: NB } }).catch(() => {})
}

async function occupancy(sessionId: number) {
  const r = await prisma.booking.aggregate({ where: { sessionId, status: { in: ['confirmed', 'pending'] } }, _sum: { groupSize: true } })
  return r._sum.groupSize || 0
}

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('Sunucu başlamadı')
}

async function run() {
  // ── TEST 1: Overbooking yarışı (kapasite 3, 30 paralel rezervasyon) ──
  {
    const res = await Promise.all(users.map(u => http('/api/bookings', { method: 'POST', token: u.token, body: { sessionId: SESS_CAP3 } })))
    const created = res.filter(r => r.status === 201).length
    const server5xx = res.filter(r => r.status >= 500).length
    const conns = res.filter(r => r.status === 0).length
    const occ = await occupancy(SESS_CAP3)
    ok('T1 overbooking: tam 3 rezervasyon başarılı', created === 3, `başarılı=${created}`)
    ok('T1 overbooking: kapasite aşılmadı (occupancy=3)', occ === 3, `occupancy=${occ}`)
    ok('T1 overbooking: 5xx/çökme yok', server5xx === 0 && conns === 0, `5xx=${server5xx}, bağlantı hatası=${conns}`)
  }

  // ── TEST 2: Grup rezervasyon overbooking (kapasite 6, 10 kişi × groupSize 2) ──
  {
    const ten = users.slice(0, 10)
    const res = await Promise.all(ten.map(u => http('/api/bookings', { method: 'POST', token: u.token, body: { sessionId: SESS_GROUP, groupSize: 2 } })))
    const created = res.filter(r => r.status === 201).length
    const server5xx = res.filter(r => r.status >= 500).length
    const occ = await occupancy(SESS_GROUP)
    ok('T2 grup overbooking: occupancy ≤ 6', occ <= 6, `occupancy=${occ}`)
    ok('T2 grup overbooking: tam 6 dolu (3 grup)', occ === 6 && created === 3, `occupancy=${occ}, başarılı=${created}`)
    ok('T2 grup overbooking: 5xx yok', server5xx === 0, `5xx=${server5xx}`)
  }

  // ── TEST 3: Drop-in katılım yarışı (4 kişilik, 20 paralel katılım) ──
  {
    const twenty = users.slice(0, 20)
    const res = await Promise.all(twenty.map(u => http(`/api/bookings/dropin/${SLOT}/join`, { method: 'POST', token: u.token })))
    const joined = res.filter(r => r.status === 200 || r.status === 201).length
    const server5xx = res.filter(r => r.status >= 500).length
    const slot = await prisma.dropInSlot.findUnique({ where: { id: SLOT }, select: { currentPlayers: true } })
    const partCount = await prisma.dropInParticipant.count({ where: { slotId: SLOT, status: 'confirmed' } })
    ok('T3 drop-in: tam 4 katılım başarılı', joined === 4, `başarılı=${joined}`)
    ok('T3 drop-in: currentPlayers=4 (sayaç doğru)', slot?.currentPlayers === 4, `currentPlayers=${slot?.currentPlayers}`)
    ok('T3 drop-in: participant=4 (sayaç=kayıt)', partCount === 4, `participants=${partCount}`)
    ok('T3 drop-in: 5xx yok', server5xx === 0, `5xx=${server5xx}`)
  }

  // ── TEST 4: Aynı kullanıcı çift-tıklama (1 kullanıcı 6 paralel aynı seans) ──
  {
    const u = users[0]
    const res = await Promise.all(Array.from({ length: 6 }).map(() => http('/api/bookings', { method: 'POST', token: u.token, body: { sessionId: SESS_DOUBLE } })))
    const created = res.filter(r => r.status === 201).length
    const server5xx = res.filter(r => r.status >= 500).length
    const cnt = await prisma.booking.count({ where: { userId: u.id, sessionId: SESS_DOUBLE, status: { in: ['confirmed', 'pending'] } } })
    ok('T4 çift-tıklama: yalnızca 1 rezervasyon', created === 1 && cnt === 1, `başarılı=${created}, db=${cnt}`)
    ok('T4 çift-tıklama: 5xx yok', server5xx === 0, `5xx=${server5xx}`)
  }

  // ── TEST 5: İptal kapasiteyi geri verir + puanı geri alır ──
  {
    const u = users[5]
    const before = await prisma.user.findUnique({ where: { id: u.id }, select: { rewardPoints: true } })
    const r = await http('/api/bookings', { method: 'POST', token: u.token, body: { sessionId: SESS_CANCEL } })
    const occ1 = await occupancy(SESS_CANCEL)
    const afterBook = await prisma.user.findUnique({ where: { id: u.id }, select: { rewardPoints: true } })
    const earned = (afterBook?.rewardPoints || 0) - (before?.rewardPoints || 0)
    const expectedPts = Math.round(100 * (pointRate / 100))
    ok('T5 rezervasyon: puan kazandırıldı', earned === expectedPts, `kazanılan=${earned}, beklenen=${expectedPts}`)
    // booking id bul, iptal et
    const booking = await prisma.booking.findFirst({ where: { userId: u.id, sessionId: SESS_CANCEL } })
    const cancelRes = await http(`/api/bookings/${booking?.id}/cancel`, { method: 'PUT', token: u.token })
    const occ2 = await occupancy(SESS_CANCEL)
    const afterCancel = await prisma.user.findUnique({ where: { id: u.id }, select: { rewardPoints: true } })
    ok('T5 iptal: kapasite geri verildi (occupancy 1→0)', occ1 === 1 && occ2 === 0, `occ1=${occ1}, occ2=${occ2}`)
    ok('T5 iptal: puan geri alındı (bakiye başa döndü)', (afterCancel?.rewardPoints || 0) === (before?.rewardPoints || 0), `başa=${before?.rewardPoints}, son=${afterCancel?.rewardPoints}`)
    ok('T5 iptal: 5xx yok', cancelRes.status < 500, `status=${cancelRes.status}`)
  }

  // ── TEST 6: Karışık eşzamanlı yük (250 paralel okuma+yazma) ──
  {
    const reads = [
      '/api/public/sessions', '/api/public/venues', '/api/public/dropin',
      '/api/social/leaderboard/users', '/api/social/leaderboard/streaks', '/api/social/leaderboard/venues',
      `/api/public/venues/${V}`, '/api/public/categories', '/api/public/neighborhoods',
    ]
    const ops: Promise<any>[] = []
    for (let i = 0; i < 250; i++) {
      if (i % 5 === 0) {
        const u = users[i % users.length]
        ops.push(http('/api/social/feed', { token: u.token }))
      } else if (i % 7 === 0) {
        const u = users[i % users.length]
        ops.push(http('/api/auth/me', { token: u.token }))
      } else {
        ops.push(http(reads[i % reads.length]))
      }
    }
    const res = await Promise.all(ops)
    const server5xx = res.filter(r => r.status >= 500).length
    const conns = res.filter(r => r.status === 0).length
    const max = Math.max(...res.map(r => r.ms)); const avg = Math.round(res.reduce((s, r) => s + r.ms, 0) / res.length)
    ok('T6 yük: 250 istekte 5xx/çökme yok', server5xx === 0 && conns === 0, `5xx=${server5xx}, conn=${conns}`)
    lines.push(`     ↳ gecikme: ort ${avg}ms, max ${max}ms`)
    const health = await http('/')
    ok('T6 yük: sunucu hâlâ ayakta', health.status === 200, `status=${health.status}`)
  }

  // ── TEST 7: Veri tutarlılığı taraması ──
  {
    for (const [id, cap] of [[SESS_CAP3, 3], [SESS_GROUP, 6]] as [number, number][]) {
      const occ = await occupancy(id)
      ok(`T7 tutarlılık: seans ${id} occupancy(${occ}) ≤ kapasite(${cap})`, occ <= cap)
    }
    // Örnek kullanıcılarda rewardPoints == log toplamı
    let mism = 0
    for (const u of users.slice(0, 10)) {
      const usr = await prisma.user.findUnique({ where: { id: u.id }, select: { rewardPoints: true } })
      const sum = await prisma.rewardPoint.aggregate({ where: { userId: u.id }, _sum: { points: true } })
      if ((usr?.rewardPoints || 0) !== (sum._sum.points || 0)) mism++
    }
    ok('T7 tutarlılık: rewardPoints == puan log toplamı', mism === 0, `uyuşmayan=${mism}`)
  }
}

async function main() {
  let server: ChildProcess | null = null
  try {
    let log = ''
    server = spawn('npx', ['ts-node', 'src/index.ts'], { env: { ...process.env, PORT: String(PORT) }, detached: true })
    server.stdout?.on('data', d => { log += d }); server.stderr?.on('data', d => { log += d })
    try { await waitForServer() } catch (e) { console.error('Sunucu log:\n', log.slice(0, 1200)); throw e }
    await seed()
    await run()
  } catch (e: any) {
    fail++; lines.push(`  ❌ KURULUM — ${e.message}`)
  } finally {
    await cleanup().catch(() => {})
    // Tüm süreç grubunu öldür (npx + alt ts-node) → zombie kalmasın
    if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
  }
  console.log('\n=== STRES & EŞZAMANLILIK TESTİ ===')
  console.log(lines.join('\n'))
  console.log(`\n${pass} geçti, ${fail} başarısız`)
  await prisma.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
}

main()
