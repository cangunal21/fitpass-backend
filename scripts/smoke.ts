/**
 * Smoke test: gerçekçi ver-i seed edip TÜM önemli endpoint'leri çalıştırır.
 * Amaç: getSessions gibi "gerçek veriyle çöken" bugları deploy ÖNCESİ yakalamak.
 *
 * Çalıştırma:  npm run smoke
 * (Kendi sunucusunu test portunda başlatır, kontrolleri yapar, veriyi temizler.)
 */
import { spawn, ChildProcess } from 'child_process'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
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
  // Yorumlar bookingId + venueId FK'sına bağlı → booking/venue silmeden ÖNCE temizlenmeli
  await prisma.review.deleteMany({ where: { OR: [{ reviewerUserId: 990021 }, { reviewerUserId: U }, { venueId: V }, { venueId: 990011 }] } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990021 } }).catch(() => {})
  // Salon yaşam-döngüsü testi kalıntıları (test ortada kalırsa) — bağlılıklar önce
  await prisma.booking.deleteMany({ where: { OR: [{ userId: 990011 }, { sessionId: 990011 }] } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990011 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990011 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990011 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990011 } }).catch(() => {})
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
  // İlçe filtresi: salonun ilçesiyle (neighborhoodId=V) arayınca o salonun dersi çıkmalı
  await check('GET /api/public/sessions?neighborhoodId (ilçe filtresi salonu buluyor)', async () => {
    const r = await expectOk(`/api/public/sessions?neighborhoodId=${V}`)
    if (!Array.isArray(r.json?.sessions) || !r.json.sessions.find((s: any) => s.id === S)) {
      throw new Error('salon kendi ilçe filtresinde çıkmadı')
    }
  })
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

  // Refresh token akışı: kayıt → refresh ile yeni access token → yeni token getMe'de çalışır → logout → refresh artık 401
  await check('Refresh token: yenileme + logout iptali', async () => {
    const uniq = Date.now()
    const em = `reftest${uniq}@x.com`
    const reg = await http('/api/auth/register', { method: 'POST', body: { username: `reftest${uniq}`, email: em, password: 'RefTest1234', fullName: 'Ref Test' } })
    const rtok = reg.json?.refreshToken
    if (!rtok || !reg.json?.token) throw new Error('register refreshToken/token döndürmedi')
    const r1 = await http('/api/auth/refresh', { method: 'POST', body: { refreshToken: rtok } })
    if (r1.status !== 200 || !r1.json?.token) throw new Error(`refresh başarısız: ${r1.status}`)
    const me = await http('/api/auth/me', { token: r1.json.token })
    if (me.status !== 200) throw new Error(`yenilenen token getMe'de çalışmadı: ${me.status}`)
    await http('/api/auth/logout', { method: 'POST', body: { refreshToken: rtok } })
    const r2 = await http('/api/auth/refresh', { method: 'POST', body: { refreshToken: rtok } })
    if (r2.status !== 401) throw new Error(`logout sonrası refresh hâlâ çalışıyor: ${r2.status}`)
    const tu = await prisma.user.findUnique({ where: { email: em }, select: { id: true } })
    if (tu) {
      await prisma.refreshToken.deleteMany({ where: { userId: tu.id } }).catch(() => {})
      await prisma.emailVerificationToken.deleteMany({ where: { userId: tu.id } }).catch(() => {})
      await prisma.user.delete({ where: { id: tu.id } }).catch(() => {})
    }
  })

  // Banlanan kullanıcı: aktif oturum + refresh engellenmeli
  await check('Ban: banlı kullanıcı getMe 403 + refresh 401', async () => {
    const uniq = Date.now() + 1
    const em = `bantest${uniq}@x.com`
    const reg = await http('/api/auth/register', { method: 'POST', body: { username: `bantest${uniq}`, email: em, password: 'BanTest1234', fullName: 'Ban Test' } })
    const utok = reg.json?.token, rtok = reg.json?.refreshToken
    if (!utok || !rtok) throw new Error('register token/refreshToken yok')
    const tu = await prisma.user.findUnique({ where: { email: em }, select: { id: true } })
    await prisma.user.update({ where: { id: tu!.id }, data: { banned: true } })
    const me = await http('/api/auth/me', { token: utok })
    if (me.status !== 403) throw new Error(`banlı getMe ${me.status} (403 bekleniyor)`)
    const rf = await http('/api/auth/refresh', { method: 'POST', body: { refreshToken: rtok } })
    if (rf.status !== 401) throw new Error(`banlı refresh ${rf.status} (401 bekleniyor)`)
    // Banlı kullanıcının public profili gizlenmeli (404)
    const pp = await http(`/api/public/users/bantest${uniq}`)
    if (pp.status !== 404) throw new Error(`banlı public profil ${pp.status} (404 bekleniyor)`)
    await prisma.refreshToken.deleteMany({ where: { userId: tu!.id } }).catch(() => {})
    await prisma.emailVerificationToken.deleteMany({ where: { userId: tu!.id } }).catch(() => {})
    await prisma.user.delete({ where: { id: tu!.id } }).catch(() => {})
  })

  // Banlı kullanıcının yorumları silinir + salon puan ortalaması yeniden hesaplanır
  await check('Ban: yorumlar silinir + salon puanı yeniden hesaplanır', async () => {
    const X = 990021, uniq = Date.now() + 5
    await prisma.user.upsert({ where: { id: X }, update: { banned: false }, create: { id: X, username: `revban_${X}`, email: `revban_${X}@x.com`, passwordHash: 'x', fullName: 'RevBan', tierSportCounts: {} } })
    const bk = await prisma.booking.create({ data: { userId: X, sessionId: S, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `RVB-${uniq}` } })
    await prisma.review.create({ data: { bookingId: bk.id, reviewerUserId: X, targetType: 'venue', venueId: V, rating: 2, comment: 'banlı yorum' } })
    await prisma.venue.update({ where: { id: V }, data: { totalReviews: 1, avgRating: 2 } })
    const r = await http(`/api/admin/users/${X}/ban`, { method: 'PUT', admin: true, body: { ban: true } })
    if (r.status !== 200) throw new Error(`ban isteği başarısız: ${r.status} ${r.text.slice(0, 120)}`)
    if ((await prisma.review.count({ where: { reviewerUserId: X } })) !== 0) throw new Error('banlı kullanıcının yorumu silinmedi')
    const v = await prisma.venue.findUnique({ where: { id: V }, select: { totalReviews: true } })
    if (v?.totalReviews !== 0) throw new Error(`salon puanı yeniden hesaplanmadı (totalReviews=${v?.totalReviews})`)
    await prisma.booking.deleteMany({ where: { id: bk.id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: X } }).catch(() => {})
  })

  // ---- Salon yaşam döngüsü: donmuş salon her yerde gizlenir + dolu salon FK hatası vermeden silinir ----
  const V2 = 990011, C2 = 990011, S2 = 990011, U2 = 990011
  await check('Salon dondurma: donmuş salonun seansı liste/detay/rezervasyonda kapalı', async () => {
    await prisma.venue.upsert({ where: { id: V2 }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: V2, name: 'LC Venue', email: `lc${V2}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: C2 }, update: {}, create: { id: C2, venueId: V2, title: 'LC Class', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: S2 }, update: { status: 'open', availableSpots: 20 }, create: { id: S2, classId: C2, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: U2 }, update: {}, create: { id: U2, username: `lc_${U2}`, email: `lc_${U2}@x.com`, passwordHash: 'x', fullName: 'LC User', tierSportCounts: {} } })
    const u2tok = jwt.sign({ userId: U2, email: `lc_${U2}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    // Pasife alınan dersin seansı listede çıkmamalı (class.isActive filtresi)
    await prisma.class.update({ where: { id: C2 }, data: { isActive: false } })
    const lsInactive = await expectOk('/api/public/sessions')
    if (lsInactive.json.sessions.find((s: any) => s.id === S2)) throw new Error('pasif dersin seansı listede görünüyor')
    await prisma.class.update({ where: { id: C2 }, data: { isActive: true } })
    // Salon AKTİFKEN rezervasyon (silme testi için dolu salon hazırlar)
    const b0 = await http('/api/bookings', { method: 'POST', token: u2tok, body: { sessionId: S2 } })
    if (b0.status !== 201) throw new Error(`aktif salona rezervasyon başarısız: ${b0.status} ${b0.text.slice(0, 120)}`)
    // Salonu dondur
    await prisma.venue.update({ where: { id: V2 }, data: { isActive: false, isSuspended: true } })
    // 1) Ders listesinde çıkmamalı
    const ls = await expectOk('/api/public/sessions')
    if (ls.json.sessions.find((s: any) => s.id === S2)) throw new Error('donmuş salonun seansı listede görünüyor')
    // 2) Seans detayı 404
    const det = await http(`/api/public/sessions/${S2}`)
    if (det.status !== 404) throw new Error(`donmuş salon seans detayı ${det.status} (404 bekleniyor)`)
    // 3) Eski linkle yeni rezervasyon engellenmeli
    const b1 = await http('/api/bookings', { method: 'POST', token, body: { sessionId: S2 } })
    if (b1.status === 201) throw new Error('donmuş salona rezervasyon yapılabildi')
  })
  await check('Salon silme: ders+seans+rezervasyonu olan salon 500 vermeden silinir', async () => {
    const r = await http(`/api/admin/venues/${V2}`, { method: 'DELETE', admin: true })
    if (r.status !== 200) throw new Error(`salon silme başarısız: ${r.status} ${r.text.slice(0, 160)}`)
    if (await prisma.venue.findUnique({ where: { id: V2 } })) throw new Error('salon hâlâ DB\'de')
    if ((await prisma.booking.count({ where: { sessionId: S2 } })) > 0) throw new Error('salonun rezervasyonu temizlenmedi (FK sızıntısı)')
    if ((await prisma.class.count({ where: { venueId: V2 } })) > 0) throw new Error('salonun dersi temizlenmedi')
    await prisma.user.deleteMany({ where: { id: U2 } }).catch(() => {})
  })

  // Hesap silme — EN SON (kullanıcıyı kaldırır). Yanlış parola reddedilmeli, doğru parola tüm veriyi temizlemeli.
  await check('Hesap silme: yanlış parola → 401', async () => {
    const r = await http('/api/auth/account', { method: 'DELETE', token, body: { password: 'yanlis-parola' } })
    if (r.status !== 401) throw new Error(`yanlış parolayla silindi: ${r.status}`)
  })
  await check('Hesap silme: doğru parola → silinir + veriler (booking dahil) temizlenir', async () => {
    const hash = await bcrypt.hash('SilTest1234', 12)
    await prisma.user.update({ where: { id: U }, data: { passwordHash: hash } })
    const r = await http('/api/auth/account', { method: 'DELETE', token, body: { password: 'SilTest1234' } })
    if (r.status !== 200) throw new Error(`silme başarısız: ${r.status} ${r.text.slice(0, 160)}`)
    if (await prisma.user.findUnique({ where: { id: U } })) throw new Error('kullanıcı hâlâ DB\'de')
    if ((await prisma.booking.count({ where: { userId: U } })) > 0) throw new Error('booking temizlenmedi (FK sızıntısı)')
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
