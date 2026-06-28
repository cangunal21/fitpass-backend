/**
 * Smoke test: gerçekçi ver-i seed edip TÜM önemli endpoint'leri çalıştırır.
 * Amaç: getSessions gibi "gerçek veriyle çöken" bugları deploy ÖNCESİ yakalamak.
 *
 * Çalıştırma:  npm run smoke
 * (Kendi sunucusunu test portunda başlatır, kontrolleri yapar, veriyi temizler.)
 */
import { spawn, ChildProcess } from 'child_process'
import jwt from 'jsonwebtoken'
import prisma from '../src/utils/prisma'

const PORT = 3199
const BASE = `http://localhost:${PORT}`
const JWT_SECRET = process.env.JWT_SECRET || 'fitpass-secret-key-change-in-production'
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'fitpass-admin-2024'

// Çakışmayı önlemek için yüksek ID aralığı
const V = 990001, C = 990001, S = 990001, U = 990001
let token = ''

let pass = 0, fail = 0
const lines: string[] = []

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; lines.push(`  ✅ ${name}`) }
  catch (e: any) { fail++; lines.push(`  ❌ ${name} — ${e.message}`) }
}

async function http(path: string, opts: { token?: string; method?: string; body?: any; admin?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  if (opts.admin) headers['x-admin-secret'] = ADMIN_SECRET
  if (opts.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const text = await res.text()
  return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}
// 500/çökme = başarısız. Happy-path için 200 bekleriz.
async function expectOk(path: string, opts: any = {}) {
  const r = await http(path, opts)
  if (r.status >= 500) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 140)}`)
  if (r.status !== 200 && !opts.allowNon200) throw new Error(`beklenen 200, gelen ${r.status}: ${r.text.slice(0, 100)}`)
  return r
}

async function seed() {
  await prisma.city.upsert({ where: { id: 1 }, update: {}, create: { id: 1, name: 'İstanbul' } })
  await prisma.neighborhood.upsert({ where: { id: V }, update: {}, create: { id: V, name: 'SmokeMahalle', latitude: 41, longitude: 29, cityId: 1 } })
  const cat = await prisma.sportCategory.findFirst({ where: {} })
  const catName = cat?.name || 'Yoga'
  await prisma.venue.upsert({ where: { id: V }, update: {}, create: { id: V, name: 'Smoke Venue', email: `smoke${V}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
  await prisma.class.upsert({ where: { id: C }, update: {}, create: { id: C, venueId: V, title: 'Smoke Class', category: catName, sportCategoryId: cat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
  await prisma.class_Session.upsert({ where: { id: S }, update: {}, create: { id: S, classId: C, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
  await prisma.user.upsert({ where: { id: U }, update: { preferredSports: [catName], preferredNeighborhoods: [V] }, create: { id: U, username: `smoke_${U}`, email: `smoke_${U}@x.com`, passwordHash: 'x', fullName: 'Smoke User', tierSportCounts: {}, preferredSports: [catName], preferredNeighborhoods: [V] } })
  token = jwt.sign({ userId: U, email: `smoke_${U}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
  return catName
}

async function cleanup() {
  await prisma.booking.deleteMany({ where: { OR: [{ userId: U }, { sessionId: S }] } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: S } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: C } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: V } }).catch(() => {})
  await prisma.userBadge.deleteMany({ where: { userId: U } }).catch(() => {})
  await prisma.notification.deleteMany({ where: { userId: U } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: U } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: V } }).catch(() => {})
}

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('Sunucu başlamadı')
}

async function run() {
  const catName = await seed()

  await check('GET /api/public/categories', async () => { await expectOk('/api/public/categories') })
  await check('GET /api/public/neighborhoods', async () => { await expectOk('/api/public/neighborhoods') })
  await check('GET /api/public/sessions (gerçek veriyle)', async () => {
    const r = await expectOk('/api/public/sessions')
    if (!Array.isArray(r.json?.sessions)) throw new Error('sessions dizisi yok')
    if (!r.json.sessions.find((s: any) => s.id === S)) throw new Error('seed seansı listede yok')
  })
  await check('GET /api/public/sessions?category', async () => { await expectOk(`/api/public/sessions?category=${encodeURIComponent(catName)}`) })
  await check('GET /api/public/sessions/:id', async () => { await expectOk(`/api/public/sessions/${S}`) })
  await check('GET /api/public/venues', async () => { await expectOk('/api/public/venues') })
  await check('GET /api/public/venues/:id', async () => { await expectOk(`/api/public/venues/${V}`) })
  await check('GET /api/public/venues-list', async () => { await expectOk('/api/public/venues-list') })
  await check('GET /api/public/dropin', async () => { await expectOk('/api/public/dropin') })
  await check('GET /api/public/for-you (token)', async () => {
    const r = await expectOk('/api/public/for-you', { token })
    if (!Array.isArray(r.json?.sessions)) throw new Error('sessions dizisi yok')
  })
  await check('GET /api/auth/me (token)', async () => {
    const r = await expectOk('/api/auth/me', { token })
    if (!r.json?.user) throw new Error('user yok')
    if (!Array.isArray(r.json.user.badges)) throw new Error('badges dizisi yok')
  })
  await check('GET /api/bookings/my (token)', async () => { await expectOk('/api/bookings/my', { token }) })
  await check('GET /api/social/leaderboard/users', async () => { await expectOk('/api/social/leaderboard/users') })
  await check('GET /api/social/leaderboard/streaks', async () => { await expectOk('/api/social/leaderboard/streaks') })
  await check('GET /api/social/leaderboard/venues', async () => { await expectOk('/api/social/leaderboard/venues') })
  await check('GET /api/social/feed (token)', async () => { await expectOk('/api/social/feed', { token }) })
  await check('GET /api/referral (token)', async () => { await expectOk('/api/referral', { token }) })
  await check('GET /api/public/users/:username', async () => { await expectOk(`/api/public/users/smoke_${U}`) })
  await check('GET /api/admin/stats (admin)', async () => { await expectOk('/api/admin/stats', { admin: true }) })

  // Booking flow: oluştur → my → iptal
  await check('POST /api/bookings → 201', async () => {
    const r = await http('/api/bookings', { method: 'POST', token, body: { sessionId: S } })
    if (r.status !== 201) throw new Error(`beklenen 201, gelen ${r.status}: ${r.text.slice(0, 120)}`)
  })

  // Takvim check-in'e bağlı: rezervasyon yapıldı ama check-in YAPILMADI → takvim BOŞ olmalı
  await check('Takvim: check-in ÖNCESİ aktivite yok', async () => {
    const r = await expectOk('/api/social/my-calendar', { token })
    if (!Array.isArray(r.json?.activities)) throw new Error('activities dizisi yok')
    if (r.json.activities.length !== 0) throw new Error(`check-in öncesi takvim boş olmalı (gelen: ${r.json.activities.length})`)
  })

  // Check-in sistemi: salon kodu doğrulayıp check-in yapıyor mu (uçtan uca)
  await check('Check-in: salon kodu ile check-in başarılı', async () => {
    const b = await prisma.booking.findFirst({ where: { userId: U, sessionId: S }, select: { checkInCode: true, status: true } })
    if (!b?.checkInCode) throw new Error('checkInCode üretilmemiş')
    const venueToken = jwt.sign({ venueId: V, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/bookings/checkin', { method: 'POST', token: venueToken, body: { code: b.checkInCode } })
    if (r.status !== 200 || !r.json?.success) throw new Error(`check-in başarısız (status=${b.status}): ${r.status} ${r.text.slice(0, 140)}`)
  })

  // Check-in yanlış salon token'ı ile reddedilmeli (IDOR koruması)
  await check('Check-in: başka salon reddediliyor (403)', async () => {
    const b = await prisma.booking.findFirst({ where: { userId: U, sessionId: S }, select: { checkInCode: true } })
    const otherVenueToken = jwt.sign({ venueId: V + 7777, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/bookings/checkin', { method: 'POST', token: otherVenueToken, body: { code: b?.checkInCode } })
    if (r.status !== 403) throw new Error(`başka salon check-in yapabildi: ${r.status}`)
  })

  // Takvim check-in SONRASI aktiviteyi göstermeli + streak alanları dönmeli
  await check('Takvim: check-in SONRASI aktivite + streak var', async () => {
    const r = await expectOk('/api/social/my-calendar', { token })
    const acts = r.json?.activities || []
    if (!acts.some((a: any) => typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date))) {
      throw new Error('check-in sonrası takvimde geçerli tarihli aktivite olmalı')
    }
    if (typeof r.json?.dailyStreak !== 'number' || typeof r.json?.weeklyStreak !== 'number') {
      throw new Error('dailyStreak/weeklyStreak alanları dönmüyor')
    }
  })

  // Review: ders henüz gerçekleşmediyse (gelecek seans) yorum 400 olmalı
  await check('Review: gerçekleşmemiş derse yorum reddediliyor (400)', async () => {
    const b = await prisma.booking.findFirst({ where: { userId: U, sessionId: S }, select: { id: true } })
    const r = await http('/api/reviews', { method: 'POST', token, body: { bookingId: b?.id, rating: 5, comment: 'erken yorum' } })
    if (r.status !== 400) throw new Error(`gerçekleşmemiş derse yorum yapılabildi: ${r.status}`)
  })
}

async function main() {
  let server: ChildProcess | null = null
  try {
    let serverLog = ''
    server = spawn('npx', ['ts-node', 'src/index.ts'], {
      env: { ...process.env, PORT: String(PORT), DISABLE_RATE_LIMIT: 'true' },
      detached: true,
    })
    server.stdout?.on('data', d => { serverLog += d })
    server.stderr?.on('data', d => { serverLog += d })
    try { await waitForServer() } catch (e) { console.error('Sunucu log:\n', serverLog.slice(0, 1000)); throw e }
    await run()
  } catch (e: any) {
    fail++; lines.push(`  ❌ KURULUM — ${e.message}`)
  } finally {
    await cleanup().catch(() => {})
    // Tüm süreç grubunu öldür (npx + alt ts-node) → zombie kalmasın
    if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
  }

  console.log('\n=== SMOKE TEST ===')
  console.log(lines.join('\n'))
  console.log(`\n${pass} geçti, ${fail} başarısız`)
  await prisma.$disconnect()
  process.exit(fail > 0 ? 1 : 0)
}

main()
