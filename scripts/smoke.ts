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
import { generateToken } from '../src/utils/jwt'
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
  const testUserIds = [990021, 990022, 990023, 990024]
  // Yorumlar bookingId + venueId FK'sına bağlı → booking/venue silmeden ÖNCE temizlenmeli
  await prisma.review.deleteMany({ where: { OR: [{ reviewerUserId: { in: testUserIds } }, { reviewerUserId: U }, { venueId: V }, { venueId: 990011 }] } }).catch(() => {})
  // Test kullanıcı booking'leri kupon/kategori silmeden ÖNCE (couponId/sportCategoryId FK)
  await prisma.booking.deleteMany({ where: { userId: { in: testUserIds } } }).catch(() => {})
  await prisma.coupon.deleteMany({ where: { venueId: V } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: testUserIds } } }).catch(() => {})
  // Durum-yayılımı kategori testi kalıntıları (class önce, sonra kategori)
  await prisma.class.deleteMany({ where: { title: 'KatTest' } }).catch(() => {})
  await prisma.sportCategory.deleteMany({ where: { name: { startsWith: 'SmokeKat' } } }).catch(() => {})
  // Hoca testi kalıntıları — ders instructorId'sini boşalt, sonra hocaları sil (FK)
  await prisma.class.updateMany({ where: { venueId: { in: [V, 990011] } }, data: { instructorId: null } }).catch(() => {})
  await prisma.instructor.deleteMany({ where: { venueId: { in: [V, 990011] } } }).catch(() => {})
  // Bildirimler userId FK'sına bağlı → test kullanıcıları silinmeden önce temizle
  await prisma.notification.deleteMany({ where: { userId: { in: [...testUserIds, 990011] } } }).catch(() => {})
  // Şikayet testi kalıntısı
  await prisma.complaint.deleteMany({ where: { subject: { startsWith: 'SmokeSikayet' } } }).catch(() => {})
  // Chat testi kalıntısı
  await prisma.chatMessage.deleteMany({ where: { userId: 990111 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990111 } }).catch(() => {})
  // Transfer testi kalıntısı (990141)
  await prisma.rewardPoint.deleteMany({ where: { userId: 990141 } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: 990141 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990141, 990142] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: { in: [990141, 990142] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990141 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990141 } }).catch(() => {})
  // Kupon kişi-başı limit testi kalıntısı (990151)
  await prisma.booking.deleteMany({ where: { session: { classId: 990151 } } }).catch(() => {})
  await prisma.coupon.deleteMany({ where: { code: 'PERUSER1' } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990151, 990152] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990151 } }).catch(() => {})
  // For You distinct testi kalıntısı
  await prisma.class_Session.deleteMany({ where: { id: 990171 } }).catch(() => {})
  // Nearby global-sort testi kalıntısı (990161-990163)
  await prisma.class_Session.deleteMany({ where: { id: { in: [990161, 990162] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: { in: [990161, 990162] } } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: { in: [990161, 990162] } } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: { in: [990161, 990162, 990163] } } }).catch(() => {})
  // Favori testi kalıntıları
  await prisma.favoriteVenue.deleteMany({ where: { userId: 990101 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990101 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990101 } }).catch(() => {})
  // Yorum yaşam-döngüsü testi kalıntıları (review → booking → session → class → user → venue)
  await prisma.review.deleteMany({ where: { venueId: 990091 } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: 990091 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990091, 990092] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990091 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990091 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990091 } }).catch(() => {})
  // Salon gate + pagination testi kalıntıları
  await prisma.class.deleteMany({ where: { venueId: 990071 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990071 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990081, 990082, 990083, 990084, 990085] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990081 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990081 } }).catch(() => {})
  // Grup etiketleme testi kalıntıları
  await prisma.booking.deleteMany({ where: { userId: { in: [990061, 990062] } } }).catch(() => {})
  await prisma.notification.deleteMany({ where: { userId: { in: [990061, 990062] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990061, 990062] } } }).catch(() => {})
  // Streak liderlik testi kalıntıları
  await prisma.booking.deleteMany({ where: { userId: 990051 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990051, 990052, 990053] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990051 } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: 990051 } }).catch(() => {})
    // Referral + şifre-sıfırlama testi kalıntıları (ref_* / pwd_* kullanıcılar) — FK sırasıyla
  const refUsers = await prisma.user.findMany({ where: { OR: [{ email: { startsWith: 'ref_' } }, { email: { startsWith: 'pwd_' } }, { email: { startsWith: 'cap_' } }] }, select: { id: true } }).catch(() => [] as { id: number }[])
  const refIds = refUsers.map(u => u.id)
  if (refIds.length) {
    await prisma.booking.deleteMany({ where: { userId: { in: refIds } } }).catch(() => {})
    await prisma.rewardPoint.deleteMany({ where: { userId: { in: refIds } } }).catch(() => {})
    await prisma.referral.deleteMany({ where: { OR: [{ referrerId: { in: refIds } }, { referredId: { in: refIds } }] } }).catch(() => {})
    await prisma.refreshToken.deleteMany({ where: { userId: { in: refIds } } }).catch(() => {})
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: refIds } } }).catch(() => {})
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: refIds } } }).catch(() => {})
    await prisma.notification.deleteMany({ where: { userId: { in: refIds } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: refIds } } }).catch(() => {})
  }
  // Waitlist testi kalıntıları (waitlist → booking → session → puan → user sırası)
  await prisma.waitlist.deleteMany({ where: { sessionId: 990041 } }).catch(() => {})
  await prisma.rewardPoint.deleteMany({ where: { userId: { in: [990041, 990042, 990043] } } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { sessionId: 990041 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990041 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990041, 990042, 990043] } } }).catch(() => {})
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
  // Feed like/comment guard: olmayan/erişilemez feedKey'e orphan satır + istenmeyen bildirim yazılamamalı
  await check('POST feed/like olmayan aktivite → 404 (orphan yok)', async () => {
    const r = await http('/api/social/feed/b-999999999/like', { method: 'POST', token })
    if (r.status !== 404) throw new Error(`beklenen 404, gelen ${r.status}: ${r.text.slice(0, 100)}`)
    const cnt = await prisma.activityLike.count({ where: { feedKey: 'b-999999999' } })
    if (cnt !== 0) throw new Error('olmayan aktiviteye like satırı oluştu')
  })
  await check('POST feed/like bozuk feedKey → 404', async () => {
    const r = await http('/api/social/feed/xyz/like', { method: 'POST', token })
    if (r.status !== 404) throw new Error(`beklenen 404, gelen ${r.status}`)
  })
  await check('POST feed/comment olmayan aktivite → 404 (orphan yok)', async () => {
    const r = await http('/api/social/feed/b-999999999/comments', { method: 'POST', token, body: { content: 'x' } })
    if (r.status !== 404) throw new Error(`beklenen 404, gelen ${r.status}: ${r.text.slice(0, 100)}`)
    const cnt = await prisma.activityComment.count({ where: { feedKey: 'b-999999999' } })
    if (cnt !== 0) throw new Error('olmayan aktiviteye yorum satırı oluştu')
  })
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

  // Anonim yorum GERÇEKTEN anonim mi — reviewer objesi VE scalar reviewerUserId gizlenmeli
  await check('Gizlilik: anonim yorumda reviewer + reviewerUserId sızmıyor', async () => {
    const Y = 990022, uniq = Date.now() + 9
    await prisma.user.upsert({ where: { id: Y }, update: {}, create: { id: Y, username: `anon_${Y}`, email: `anon_${Y}@x.com`, passwordHash: 'x', fullName: 'Anon User', tierSportCounts: {} } })
    const bk = await prisma.booking.create({ data: { userId: Y, sessionId: S, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `ANN-${uniq}` } })
    const rv = await prisma.review.create({ data: { bookingId: bk.id, reviewerUserId: Y, targetType: 'venue', venueId: V, rating: 4, comment: 'anon', isAnonymous: true } })
    const res = await expectOk(`/api/reviews/venue/${V}`)
    const found = (res.json?.reviews || []).find((r: any) => r.id === rv.id)
    if (!found) throw new Error('anonim yorum listede yok')
    if (found.reviewer !== null) throw new Error('anonim yorumda reviewer objesi sızıyor')
    if ('reviewerUserId' in found) throw new Error('anonim yorumda reviewerUserId sızıyor (deşifre edilebilir)')
    await prisma.review.deleteMany({ where: { id: rv.id } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { id: bk.id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: Y } }).catch(() => {})
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

  // Para: iptal edilen rezervasyon kuponun usedCount hakkını YAKMAMALI (geri verilmeli)
  await check('Para: iptalde kupon usedCount geri verilir', async () => {
    const Z = 990023, uniq = Date.now() + 3
    const code = `SMKCPN${uniq}`
    const cpn = await prisma.coupon.create({ data: { venueId: V, code, discountType: 'percent', discountValue: 10, isActive: true } })
    await prisma.user.upsert({ where: { id: Z }, update: {}, create: { id: Z, username: `cpn_${Z}`, email: `cpn_${Z}@x.com`, passwordHash: 'x', fullName: 'Coupon User', tierSportCounts: {} } })
    const ztok = jwt.sign({ userId: Z, email: `cpn_${Z}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const bk = await http('/api/bookings', { method: 'POST', token: ztok, body: { sessionId: S, couponCode: code } })
    if (bk.status !== 201) throw new Error(`kuponlu rezervasyon başarısız: ${bk.status} ${bk.text.slice(0, 120)}`)
    const c1 = await prisma.coupon.findUnique({ where: { code }, select: { usedCount: true } })
    if (c1?.usedCount !== 1) throw new Error(`rezervasyon sonrası usedCount ${c1?.usedCount} (1 bekleniyor)`)
    const cancel = await http(`/api/bookings/${bk.json?.booking?.id}/cancel`, { method: 'PUT', token: ztok })
    if (cancel.status !== 200) throw new Error(`iptal başarısız: ${cancel.status} ${cancel.text.slice(0, 120)}`)
    const c2 = await prisma.coupon.findUnique({ where: { code }, select: { usedCount: true } })
    if (c2?.usedCount !== 0) throw new Error(`iptal sonrası usedCount ${c2?.usedCount} (0 bekleniyor — kupon hakkı yandı)`)
    await prisma.booking.deleteMany({ where: { userId: Z } }).catch(() => {})
    await prisma.coupon.deleteMany({ where: { id: cpn.id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: Z } }).catch(() => {})
  })

  // Durum-yayılımı: kullanımdaki kategori silinemez (400, gerçek veri cascade-silinmez), boş silinir (200)
  await check('Durum: kullanımdaki kategori silinemez, boş silinir', async () => {
    const catName = `SmokeKat${Date.now()}`
    const cat = await prisma.sportCategory.create({ data: { name: catName } })
    const cls = await prisma.class.create({ data: { venueId: V, title: 'KatTest', category: catName, sportCategoryId: cat.id, basePrice: 50, durationMinutes: 60, capacity: 10, isActive: true } })
    const blocked = await http(`/api/admin/categories/${cat.id}`, { method: 'DELETE', admin: true })
    if (blocked.status !== 400) throw new Error(`kullanımdaki kategori ${blocked.status} (400 bekleniyor, 500 değil)`)
    if (!(await prisma.sportCategory.findUnique({ where: { id: cat.id } }))) throw new Error('kategori yanlışlıkla silindi')
    await prisma.class.delete({ where: { id: cls.id } })
    const ok = await http(`/api/admin/categories/${cat.id}`, { method: 'DELETE', admin: true })
    if (ok.status !== 200) throw new Error(`boş kategori silinemedi: ${ok.status}`)
    await prisma.sportCategory.deleteMany({ where: { id: cat.id } }).catch(() => {})
  })

  // Durum-yayılımı: admin kupon silme, kuponu kullanan booking varken 500 vermez + couponId koparır
  await check('Durum: admin kupon silme booking baglantisini koparir (500 yok)', async () => {
    const W = 990024, uniq = Date.now() + 7
    const code = `ADMCPN${uniq}`
    const cpn = await prisma.coupon.create({ data: { venueId: V, code, discountType: 'percent', discountValue: 10, isActive: true } })
    await prisma.user.upsert({ where: { id: W }, update: {}, create: { id: W, username: `adm_${W}`, email: `adm_${W}@x.com`, passwordHash: 'x', fullName: 'Adm', tierSportCounts: {} } })
    const wtok = jwt.sign({ userId: W, email: `adm_${W}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const bk = await http('/api/bookings', { method: 'POST', token: wtok, body: { sessionId: S, couponCode: code } })
    if (bk.status !== 201) throw new Error(`kuponlu booking başarısız: ${bk.status}`)
    const del = await http(`/api/admin/coupons/${cpn.id}`, { method: 'DELETE', admin: true })
    if (del.status !== 200) throw new Error(`admin kupon silme: ${del.status} ${del.text.slice(0, 120)}`)
    if (await prisma.coupon.findUnique({ where: { id: cpn.id } })) throw new Error('kupon silinmedi')
    const b = await prisma.booking.findUnique({ where: { id: bk.json?.booking?.id }, select: { couponId: true } })
    if (b?.couponId !== null) throw new Error('booking couponId koparılmadı (FK sızıntısı)')
    await prisma.booking.deleteMany({ where: { userId: W } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: W } }).catch(() => {})
  })

  // Salon hoca silme: sahiplik + FK-güvenli (dersin instructorId'si boşalır, hoca gider)
  await check('Salon: hoca silme dersin bağlantısını koparır (FK-güvenli)', async () => {
    const venueToken = jwt.sign({ venueId: V, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const ins = await prisma.instructor.create({ data: { venueId: V, fullName: 'SilHoca', specialty: 'Yoga' } })
    await prisma.class.update({ where: { id: C }, data: { instructorId: ins.id } })
    // Başka salon silemez (sahiplik)
    const otherTok = jwt.sign({ venueId: V + 5555, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const forbidden = await http(`/api/venue/instructors/${ins.id}`, { method: 'DELETE', token: otherTok })
    if (forbidden.status === 200) throw new Error('başka salon hocayı silebildi (IDOR)')
    // Kendi salonu siler
    const del = await http(`/api/venue/instructors/${ins.id}`, { method: 'DELETE', token: venueToken })
    if (del.status !== 200) throw new Error(`hoca silme: ${del.status} ${del.text.slice(0, 120)}`)
    if (await prisma.instructor.findUnique({ where: { id: ins.id } })) throw new Error('hoca silinmedi')
    const cls = await prisma.class.findUnique({ where: { id: C }, select: { instructorId: true } })
    if (cls?.instructorId !== null) throw new Error('ders instructorId koparılmadı (FK sızıntısı)')
  })

  // Şikayet/iletişim: DB'ye kalıcı kaydedilir (e-posta ayrı) + admin görür + çözülür
  await check('Şikayet: DB kaydı + admin listesi + çözme', async () => {
    const uniq = Date.now()
    const subj = `SmokeSikayet${uniq}`
    const r = await http('/api/public/complaint', { method: 'POST', body: { name: 'Örnek', email: `sk${uniq}@x.com`, subject: subj, message: 'Test şikayet mesajı' } })
    if (r.status !== 200) throw new Error(`şikayet gönderilemedi: ${r.status}`)
    const c = await prisma.complaint.findFirst({ where: { subject: subj } })
    if (!c) throw new Error('şikayet DB\'ye kaydedilmedi (e-posta gitmese bile durmalıydı)')
    const list = await http('/api/admin/complaints', { admin: true })
    if (!(list.json?.complaints || []).some((x: any) => x.id === c.id)) throw new Error('admin listesinde şikayet yok')
    const res2 = await http(`/api/admin/complaints/${c.id}/resolve`, { method: 'PUT', admin: true })
    if (res2.status !== 200) throw new Error(`çözme başarısız: ${res2.status}`)
    const c2 = await prisma.complaint.findUnique({ where: { id: c.id } })
    if (c2?.status !== 'resolved') throw new Error('şikayet çözüldü olarak işaretlenmedi')
    await prisma.complaint.deleteMany({ where: { subject: subj } }).catch(() => {})
  })

  // Admin hoca doğrulama (verified tik): doğrula → public detay + admin liste yansır → kaldır
  await check('Admin: hoca doğrulama (verified) uçtan uca', async () => {
    const ins = await prisma.instructor.create({ data: { venueId: V, fullName: 'VerifyHoca', specialty: 'Yoga' } })
    const v = await http(`/api/admin/instructors/${ins.id}/verify`, { method: 'PUT', admin: true, body: { verified: true } })
    if (v.status !== 200) throw new Error(`verify isteği: ${v.status}`)
    const det = await http(`/api/public/instructors/${ins.id}`)
    if (det.json?.instructor?.verified !== true) throw new Error('public detayda verified=true dönmedi')
    const list = await http('/api/admin/instructors', { admin: true })
    if (!(list.json?.instructors || []).some((i: any) => i.id === ins.id && i.verified === true)) throw new Error('admin listede verified görünmedi')
    const un = await http(`/api/admin/instructors/${ins.id}/verify`, { method: 'PUT', admin: true, body: { verified: false } })
    if (un.status !== 200) throw new Error(`doğrulama kaldırma: ${un.status}`)
    const det2 = await http(`/api/public/instructors/${ins.id}`)
    if (det2.json?.instructor?.verified !== false) throw new Error('doğrulama kaldırılamadı')
    await prisma.instructor.deleteMany({ where: { id: ins.id } }).catch(() => {})
  })

  // ---- Referral (davet) UÇTAN UCA ----
  await check('Referral: davet→ücretli ders→100+100, pending→completed, 3-limit, silme-decrement', async () => {
    const uniq = Date.now()
    const reg = async (tag: string, refCode?: string) => {
      const email = `ref_${tag}_${uniq}@x.com`
      const r = await http('/api/auth/register', { method: 'POST', body: { username: `ref_${tag}_${uniq}`, email, password: 'RefTest1234', fullName: `Ref ${tag}`, ...(refCode ? { referralCode: refCode } : {}) } })
      const u = await prisma.user.findUnique({ where: { email }, select: { id: true } })
      return { token: r.json?.token as string, id: u?.id as number }
    }
    const R = await reg('R')
    if (!R.token || !R.id) throw new Error('R kaydı başarısız')
    const code = (await http('/api/referral', { token: R.token })).json?.referralCode
    if (!code) throw new Error('R referral kodu üretilmedi')
    const B = await reg('B', code)
    await new Promise(r => setTimeout(r, 400)) // applyReferralCode fire-and-forget
    // Kayıt anında: referral PENDING, R.count=1, PUAN YOK (ilk ücretli derse kadar)
    const refRow = await prisma.referral.findFirst({ where: { referrerId: R.id, referredId: B.id } })
    if (refRow?.status !== 'pending') throw new Error(`referral ${refRow?.status} (pending bekleniyor)`)
    let rs = await prisma.user.findUnique({ where: { id: R.id }, select: { rewardPoints: true, referralCount: true } })
    if (rs?.referralCount !== 1) throw new Error(`R.referralCount ${rs?.referralCount} (1)`)
    if (rs?.rewardPoints !== 0) throw new Error(`R puan ${rs?.rewardPoints} (0 — henüz ücretli ders yok)`)
    // B ücretli ders alır → completeReferral: iki tarafa da 100
    if ((await http('/api/bookings', { method: 'POST', token: B.token, body: { sessionId: S } })).status !== 201) throw new Error('B rezervasyon başarısız')
    await new Promise(r => setTimeout(r, 400))
    if ((await prisma.referral.findFirst({ where: { id: refRow.id } }))?.status !== 'completed') throw new Error('referral completed olmadı')
    rs = await prisma.user.findUnique({ where: { id: R.id }, select: { rewardPoints: true, referralCount: true } })
    if (rs?.rewardPoints !== 100) throw new Error(`R puan ${rs?.rewardPoints} (100 bekleniyor)`)
    const bPts = (await prisma.user.findUnique({ where: { id: B.id }, select: { rewardPoints: true } }))?.rewardPoints || 0
    if (bPts < 100) throw new Error(`B puan ${bPts} (>=100: davet 100 + ders cashback)`)
    // Idempotent: artık pending referral yok → yeni booking tekrar tetiklemez
    if (await prisma.referral.findFirst({ where: { referredId: B.id, status: 'pending' } })) throw new Error('idempotent değil (hâlâ pending)')
    // 3-limit: C,D koduyla (count 2,3) → E reddedilir
    const C = await reg('C', code); await reg('D', code)
    await new Promise(r => setTimeout(r, 400))
    rs = await prisma.user.findUnique({ where: { id: R.id }, select: { rewardPoints: true, referralCount: true } })
    if (rs?.referralCount !== 3) throw new Error(`R.referralCount ${rs?.referralCount} (3: B,C,D)`)
    const E = await reg('E', code)
    await new Promise(r => setTimeout(r, 400))
    if (await prisma.referral.findFirst({ where: { referrerId: R.id, referredId: E.id } })) throw new Error('4. davet (limit) engellenmedi')
    // Silme-decrement: C (davet edilen) hesabını siler → R.count 3→2 (davet hakkı iade)
    const delC = await http('/api/auth/account', { method: 'DELETE', token: C.token, body: { password: 'RefTest1234' } })
    if (delC.status !== 200) throw new Error(`C silinemedi: ${delC.status} ${delC.text.slice(0, 160)}`)
    rs = await prisma.user.findUnique({ where: { id: R.id }, select: { rewardPoints: true, referralCount: true } })
    if (rs?.referralCount !== 2) throw new Error(`silme sonrası R.count ${rs?.referralCount} (2 bekleniyor)`)
    // temizlik (C zaten silindi)
    const ids = [R.id, B.id, E.id].filter(Boolean)
    await prisma.booking.deleteMany({ where: { userId: { in: ids } } }).catch(() => {})
    await prisma.rewardPoint.deleteMany({ where: { userId: { in: ids } } }).catch(() => {})
    await prisma.referral.deleteMany({ where: { OR: [{ referrerId: { in: ids } }, { referredId: { in: ids } }] } }).catch(() => {})
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }).catch(() => {})
    await prisma.emailVerificationToken.deleteMany({ where: { userId: { in: ids } } }).catch(() => {})
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  })

  // ---- KRİTİK gizlilik: public venue uçları IBAN/TCKN/KYC finansal veriyi SIZDIRMAZ ----
  await check('Gizlilik: public venue uçları IBAN/TCKN/KYC sızdırmaz', async () => {
    await prisma.venue.update({ where: { id: V }, data: { iban: 'TR000000000000000000000000', identityNumber: '11111111111', taxNumber: '1234567890', payoutGsm: '5551112233', contactName: 'Ad', contactSurname: 'Soyad', legalCompanyTitle: 'X AŞ', iyzicoSubMerchantKey: 'sk-test', subMerchantStatus: 'approved', kycDocs: { kimlik: 'url' } } })
    const leakKeys = ['iban', 'identityNumber', 'taxNumber', 'payoutGsm', 'contactName', 'contactSurname', 'legalCompanyTitle', 'iyzicoSubMerchantKey', 'subMerchantStatus', 'kycDocs']
    const det = await expectOk(`/api/public/venues/${V}`)
    const vd = det.json?.venue || {}
    for (const k of leakKeys) if (k in vd) throw new Error(`venue DETAY '${k}' sızdırıyor (KVKK/finansal veri!)`)
    const list = await expectOk('/api/public/venues')
    const inList = (list.json?.venues || []).find((x: any) => x.id === V)
    if (inList) for (const k of leakKeys) if (k in inList) throw new Error(`venue LİSTE '${k}' sızdırıyor`)
    await prisma.venue.update({ where: { id: V }, data: { iban: null, identityNumber: null, taxNumber: null, payoutGsm: null, contactName: null, contactSurname: null, legalCompanyTitle: null, iyzicoSubMerchantKey: null, subMerchantStatus: 'none', kycDocs: {} } }).catch(() => {})
  })

  // ---- Girdi cap: aşırı uzun kullanıcı metni kırpılır (DB şişmesi/AI maliyeti önlenir) ----
  await check('Girdi cap: uzun fullName (register) + notes (booking) kırpılır', async () => {
    const uq = Date.now(); const email = `cap_${uq}@x.com`
    const reg = await http('/api/auth/register', { method: 'POST', body: { username: `cap_${uq}`, email, password: 'CapTest1234', fullName: 'A'.repeat(5000) } })
    if (!reg.json?.token) throw new Error(`register başarısız: ${reg.status}`)
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true, fullName: true } })
    if (!u || (u.fullName?.length || 0) > 80) throw new Error(`fullName kırpılmadı: ${u?.fullName?.length} (<=80 bekleniyor)`)
    const uTok = jwt.sign({ userId: u.id, email }, JWT_SECRET, { expiresIn: '1h' })
    const bk = await http('/api/bookings', { method: 'POST', token: uTok, body: { sessionId: S, notes: 'B'.repeat(5000) } })
    if (bk.status !== 201) throw new Error(`booking: ${bk.status}`)
    const b = await prisma.booking.findFirst({ where: { userId: u.id, sessionId: S }, select: { notes: true } })
    if ((b?.notes?.length || 0) > 500) throw new Error(`notes kırpılmadı: ${b?.notes?.length} (<=500 bekleniyor)`)
    await prisma.booking.deleteMany({ where: { userId: u.id } }).catch(() => {})
    await prisma.rewardPoint.deleteMany({ where: { userId: u.id } }).catch(() => {})
    await prisma.refreshToken.deleteMany({ where: { userId: u.id } }).catch(() => {})
    await prisma.emailVerificationToken.deleteMany({ where: { userId: u.id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: u.id } }).catch(() => {})
  })

  // ---- Chat: sohbet DB'de saklanmaz — history legacy kayıt olsa bile boş döner ----
  await check('Chat: geçmiş DB\'den okunmaz (KVKK — saklama kaldırıldı)', async () => {
    const CU = 990111
    await prisma.user.upsert({ where: { id: CU }, update: {}, create: { id: CU, username: `chat_${CU}`, email: `chat_${CU}@x.com`, passwordHash: 'x', fullName: 'Chat', tierSportCounts: {} } })
    const cTok = jwt.sign({ userId: CU, email: `chat_${CU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    // Eski (legacy) bir sohbet kaydı olsa bile history OKUMAMALI → boş dönmeli
    await prisma.chatMessage.create({ data: { userId: CU, role: 'user', content: 'eski mesaj' } }).catch(() => {})
    const h = await expectOk('/api/chat/history', { token: cTok })
    if (!Array.isArray(h.json?.messages) || h.json.messages.length !== 0) throw new Error(`chat history boş değil (${h.json?.messages?.length}) — saklama kaldırıldı, DB'den okunmamalı`)
    await prisma.chatMessage.deleteMany({ where: { userId: CU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: CU } }).catch(() => {})
  })

  // ---- Favoriler: donmuş salon listede görünmez ama favori kaydı korunur ----
  await check('Favoriler: donmuş salon listede yok, geri aktifleşince döner', async () => {
    const FU = 990101, FV = 990101
    await prisma.venue.upsert({ where: { id: FV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: FV, name: 'FavVenue', email: `fav${FV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.user.upsert({ where: { id: FU }, update: {}, create: { id: FU, username: `fav_${FU}`, email: `fav_${FU}@x.com`, passwordHash: 'x', fullName: 'Fav', tierSportCounts: {} } })
    const fTok = jwt.sign({ userId: FU, email: `fav_${FU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    if ((await http(`/api/favorites/${FV}`, { method: 'POST', token: fTok })).status >= 400) throw new Error('favori eklenemedi')
    const l1 = await expectOk('/api/favorites/my', { token: fTok })
    if (!(l1.json?.favorites || []).some((v: any) => v.id === FV)) throw new Error('favori listede yok')
    // Dondur → listede yok
    await prisma.venue.update({ where: { id: FV }, data: { isActive: false, isSuspended: true } })
    const l2 = await expectOk('/api/favorites/my', { token: fTok })
    if ((l2.json?.favorites || []).some((v: any) => v.id === FV)) throw new Error('donmuş salon favori listesinde görünüyor')
    // Geri aktifleştir → favori kaydı korunduğu için tekrar görünür
    await prisma.venue.update({ where: { id: FV }, data: { isActive: true, isSuspended: false } })
    const l3 = await expectOk('/api/favorites/my', { token: fTok })
    if (!(l3.json?.favorites || []).some((v: any) => v.id === FV)) throw new Error('salon geri aktif olunca favori dönmedi (kayıt silinmiş)')
    await prisma.favoriteVenue.deleteMany({ where: { userId: FU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: FU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: FV } }).catch(() => {})
  })

  // ---- Yorum yaşam döngüsü: seans silinince silinen yorumlar salon puanından düşer ----
  await check('Yorum: seans silinince salon avgRating/totalReviews yeniden hesaplanır', async () => {
    const RV = 990091, RC = 990091, RS1 = 990091, RS2 = 990092, RU = 990091
    await prisma.venue.upsert({ where: { id: RV }, update: { isApproved: true, isActive: true }, create: { id: RV, name: 'RevVenue', email: `rv${RV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: RC }, update: {}, create: { id: RC, venueId: RV, title: 'RevDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.user.upsert({ where: { id: RU }, update: {}, create: { id: RU, username: `rev_${RU}`, email: `rev_${RU}@x.com`, passwordHash: 'x', fullName: 'Rev', tierSportCounts: {} } })
    const past = (k: number) => new Date(Date.now() - k * 86400000)
    await prisma.class_Session.upsert({ where: { id: RS1 }, update: {}, create: { id: RS1, classId: RC, startsAt: past(2), endsAt: past(2), availableSpots: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: RS2 }, update: {}, create: { id: RS2, classId: RC, startsAt: past(1), endsAt: past(1), availableSpots: 20, status: 'open' } })
    const bk1 = await prisma.booking.create({ data: { userId: RU, sessionId: RS1, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `RV1-${Date.now()}` } })
    const bk2 = await prisma.booking.create({ data: { userId: RU, sessionId: RS2, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `RV2-${Date.now()}` } })
    await prisma.review.create({ data: { bookingId: bk1.id, reviewerUserId: RU, targetType: 'venue', venueId: RV, rating: 2 } })
    await prisma.review.create({ data: { bookingId: bk2.id, reviewerUserId: RU, targetType: 'venue', venueId: RV, rating: 4 } })
    await prisma.venue.update({ where: { id: RV }, data: { avgRating: 3, totalReviews: 2 } })
    // RS1 seansını sil → rating-2 yorum da silinir → recompute: sadece rating-4 kalır
    const vTok = jwt.sign({ venueId: RV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const del = await http(`/api/venue/classes/${RC}/sessions/${RS1}`, { method: 'DELETE', token: vTok })
    if (del.status !== 200) throw new Error(`seans silme: ${del.status} ${del.text.slice(0, 120)}`)
    const v = await prisma.venue.findUnique({ where: { id: RV }, select: { avgRating: true, totalReviews: true } })
    if (v?.totalReviews !== 1 || v?.avgRating !== 4) throw new Error(`salon puanı güncellenmedi: avg=${v?.avgRating} total=${v?.totalReviews} (4/1 bekleniyor)`)
    await prisma.review.deleteMany({ where: { venueId: RV } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: RU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { classId: RC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: RC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: RU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: RV } }).catch(() => {})
  })

  // ---- Şifre sıfırlama uçtan uca: token tek-kullanım + oturum iptal + hesap sızıntısı yok ----
  await check('Şifre sıfırlama: token tek-kullanım + refresh iptal + enumeration yok', async () => {
    const uq = Date.now(); const email = `pwd_${uq}@x.com`
    const reg = await http('/api/auth/register', { method: 'POST', body: { username: `pwd_${uq}`, email, password: 'OldPass1234', fullName: 'Pwd User' } })
    if (!reg.json?.refreshToken) throw new Error('register refreshToken vermedi')
    const uid = (await prisma.user.findUnique({ where: { email }, select: { id: true } }))?.id
    await http('/api/auth/forgot-password', { method: 'POST', body: { email } })
    const prt = await prisma.passwordResetToken.findFirst({ where: { userId: uid, used: false }, orderBy: { id: 'desc' } })
    if (!prt) throw new Error('reset token oluşmadı')
    if ((await http('/api/auth/reset-password', { method: 'POST', body: { token: prt.token, password: 'NewPass1234' } })).status !== 200) throw new Error('reset başarısız')
    // Eski şifre login FAIL, yeni şifre OK
    if ((await http('/api/auth/login', { method: 'POST', body: { email, password: 'OldPass1234' } })).status === 200) throw new Error('eski şifreyle giriş yapılabildi')
    if ((await http('/api/auth/login', { method: 'POST', body: { email, password: 'NewPass1234' } })).status !== 200) throw new Error('yeni şifreyle giriş yapılamadı')
    // Token tekrar kullanılamaz (tek-kullanımlık)
    if ((await http('/api/auth/reset-password', { method: 'POST', body: { token: prt.token, password: 'Other12345' } })).status !== 400) throw new Error('kullanılmış token tekrar çalıştı')
    // Sıfırlama eski refresh token'ı iptal etti
    const rt = await prisma.refreshToken.findFirst({ where: { token: reg.json.refreshToken }, select: { revoked: true } })
    if (rt && rt.revoked !== true) throw new Error('şifre sıfırlamada eski refresh token iptal edilmedi (oturum yaşıyor)')
    // Enumeration yok: olmayan e-posta da 200
    if ((await http('/api/auth/forgot-password', { method: 'POST', body: { email: `yok_${uq}@x.com` } })).status !== 200) throw new Error('olmayan e-posta farklı yanıt (hesap sızıntısı)')
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {})
    await prisma.passwordResetToken.deleteMany({ where: { userId: uid } }).catch(() => {})
    await prisma.emailVerificationToken.deleteMany({ where: { userId: uid } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: uid } }).catch(() => {})
  })

  // ---- Arama/pagination: sayfalar tutarlı (total sabit, hasMore doğru, örtüşme yok) ----
  await check('Pagination: 5 seans / 2\'şer sayfa — total/hasMore/örtüşme doğru', async () => {
    const PV = 990081, PC = 990081
    await prisma.venue.upsert({ where: { id: PV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: PV, name: 'PageVenue', email: `pv${PV}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: PC }, update: { isActive: true }, create: { id: PC, venueId: PV, title: 'Page Ders', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const sessIds: number[] = []
    for (let i = 0; i < 5; i++) {
      const id = 990081 + i; sessIds.push(id)
      const st = new Date(Date.now() + (i + 1) * 86400000)
      await prisma.class_Session.upsert({ where: { id }, update: { status: 'open', startsAt: st }, create: { id, classId: PC, startsAt: st, endsAt: new Date(st.getTime() + 3600000), availableSpots: 20, status: 'open' } })
    }
    const p1 = await expectOk(`/api/public/sessions?venueId=${PV}&limit=2&page=1`)
    if (p1.json.total !== 5) throw new Error(`total ${p1.json.total} (5 bekleniyor)`)
    if (p1.json.sessions.length !== 2 || p1.json.hasMore !== true) throw new Error(`sayfa1 len=${p1.json.sessions.length} hasMore=${p1.json.hasMore}`)
    const p2 = await expectOk(`/api/public/sessions?venueId=${PV}&limit=2&page=2`)
    const p3 = await expectOk(`/api/public/sessions?venueId=${PV}&limit=2&page=3`)
    if (p3.json.sessions.length !== 1 || p3.json.hasMore !== false) throw new Error(`sayfa3 len=${p3.json.sessions.length} hasMore=${p3.json.hasMore}`)
    const allIds = [...p1.json.sessions, ...p2.json.sessions, ...p3.json.sessions].map((s: any) => s.id)
    if (new Set(allIds).size !== 5) throw new Error(`sayfalar örtüşüyor/eksik: ${allIds.length} kayıt ${new Set(allIds).size} tekil`)
    await prisma.class_Session.deleteMany({ where: { id: { in: sessIds } } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: PC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: PV } }).catch(() => {})
  })

  // ---- Salon gate: onaysız + donmuş salon (mevcut token dahil) ders ekleyemez ----
  await check('Salon: onaysız→403, onaylı→201, donmuş salon mevcut token ile→403', async () => {
    const VV = 990071
    await prisma.venue.upsert({ where: { id: VV }, update: { isApproved: false, isActive: true, isSuspended: false }, create: { id: VV, name: 'GateTest', email: `gate${VV}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: false, isActive: true, neighborhoodId: V, cityId: 1 } })
    const vTok = jwt.sign({ venueId: VV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const classBody = { title: 'Gate Ders', category: catName, basePrice: 100, duration: 60, capacity: 10 }
    // Onaysız → 403
    if ((await http('/api/venue/classes', { method: 'POST', token: vTok, body: classBody })).status !== 403) throw new Error('onaysız salon ders ekleyebildi (403 bekleniyor)')
    // Onayla → 201
    await prisma.venue.update({ where: { id: VV }, data: { isApproved: true } })
    const ok = await http('/api/venue/classes', { method: 'POST', token: vTok, body: classBody })
    if (ok.status !== 201) throw new Error(`onaylı+aktif salon ders ekleyemedi: ${ok.status} ${ok.text.slice(0, 120)}`)
    // Dondur (mevcut token hâlâ geçerli) → 403 (venueLogin değil, middleware engellemeli)
    await prisma.venue.update({ where: { id: VV }, data: { isActive: false, isSuspended: true } })
    if ((await http('/api/venue/classes', { method: 'POST', token: vTok, body: classBody })).status !== 403) throw new Error('donmuş salon mevcut token ile ders ekleyebildi (403 bekleniyor)')
    await prisma.class.deleteMany({ where: { venueId: VV } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: VV } }).catch(() => {})
  })

  // ---- Grup etiketleme: self-tag + duplikat temizlenir, arkadaşa TAM 1 bildirim ----
  await check('Grup etiketleme: self-tag + duplikat temizlenir, arkadaş 1 davet bildirimi', async () => {
    const uq = Date.now(); const T = 990061, F = 990062
    const tName = `tag_t_${uq}`, fName = `tag_f_${uq}`
    await prisma.user.upsert({ where: { id: T }, update: { username: tName, email: `${tName}@x.com`, banned: false }, create: { id: T, username: tName, email: `${tName}@x.com`, passwordHash: 'x', fullName: 'Tagger', tierSportCounts: {} } })
    await prisma.user.upsert({ where: { id: F }, update: { username: fName, email: `${fName}@x.com`, banned: false }, create: { id: F, username: fName, email: `${fName}@x.com`, passwordHash: 'x', fullName: 'Friend', tierSportCounts: {} } })
    const tTok = jwt.sign({ userId: T, email: `${tName}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    // Kendini + arkadaşı 2 kez etiketle → dedup + self-exclusion sonrası sadece [fName] kalmalı
    const bk = await http('/api/bookings', { method: 'POST', token: tTok, body: { sessionId: S, groupSize: 4, taggedUsernames: [tName, fName, fName] } })
    if (bk.status !== 201) throw new Error(`grup rezervasyon: ${bk.status} ${bk.text.slice(0, 120)}`)
    const b = await prisma.booking.findFirst({ where: { userId: T, sessionId: S }, select: { taggedFriends: true } })
    const tags = (b?.taggedFriends as string[]) || []
    if (tags.length !== 1 || tags[0] !== fName) throw new Error(`taggedFriends ${JSON.stringify(tags)} (sadece [${fName}] beklenir — self+duplikat temizlenmeli)`)
    if ((await prisma.notification.count({ where: { userId: F, type: 'group_invite' } })) !== 1) throw new Error('arkadaş 1 davet bildirimi almalıydı (duplikat temizlenmeli)')
    if ((await prisma.notification.count({ where: { userId: T, type: 'group_invite' } })) !== 0) throw new Error('tagger kendine davet bildirimi ALMAMALI (self-tag engeli)')
    await prisma.booking.deleteMany({ where: { userId: T } }).catch(() => {})
    await prisma.notification.deleteMany({ where: { userId: { in: [T, F] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [T, F] } } }).catch(() => {})
  })

  // ---- Streak (seri) liderliği: no-show günü seri SAYMAZ (kullanıcının check-in'li takvimiyle tutarlı) ----
  await check('Streak liderliği: no-show günü seri saymaz (check-in tutarlı)', async () => {
    const N = 990051, X = 990051
    await prisma.neighborhood.upsert({ where: { id: N }, update: {}, create: { id: N, name: 'StreakMah', latitude: 41, longitude: 29, cityId: 1 } })
    await prisma.user.upsert({ where: { id: X }, update: { neighborhoodId: N, activityPrivacy: 'public', banned: false }, create: { id: X, username: `strk_${X}`, email: `strk_${X}@x.com`, passwordHash: 'x', fullName: 'Streak User', tierSportCounts: {}, neighborhoodId: N, activityPrivacy: 'public' } })
    const noon = (k: number) => { const d = new Date(); d.setUTCHours(9, 0, 0, 0); return new Date(d.getTime() - k * 86400000) } // 09:00 UTC = 12:00 İstanbul
    const mkSess = async (id: number, k: number) => prisma.class_Session.upsert({ where: { id }, update: { startsAt: noon(k), endsAt: new Date(noon(k).getTime() + 3600000), status: 'open', availableSpots: 20 }, create: { id, classId: C, startsAt: noon(k), endsAt: new Date(noon(k).getTime() + 3600000), status: 'open', availableSpots: 20 } })
    await mkSess(990051, 3); await mkSess(990052, 2); await mkSess(990053, 1)
    const mkBk = async (id: number, sid: number, checked: boolean) => prisma.booking.upsert({ where: { id }, update: { checkedIn: checked }, create: { id, userId: X, sessionId: sid, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `STK-${id}`, checkedIn: checked, checkedInAt: checked ? new Date() : null } })
    await mkBk(990051, 990051, false) // D-3: confirmed AMA check-in yok (no-show)
    await mkBk(990052, 990052, true)  // D-2: check-in
    await mkBk(990053, 990053, true)  // D-1: check-in
    const r = await http(`/api/social/leaderboard/streaks?neighborhoodId=${N}`)
    const me = (r.json?.leaderboard || []).find((u: any) => u.id === X)
    if (!me) throw new Error('X streak liderliğinde yok (check-in serisi 2 olmalıydı)')
    if (me.streak !== 2) throw new Error(`streak ${me.streak} (2 bekleniyor — D-3 no-show sayılmamalı; confirmed olsaydı 3 çıkardı)`)
    await prisma.booking.deleteMany({ where: { userId: X } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: { in: [990051, 990052, 990053] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: X } }).catch(() => {})
    await prisma.neighborhood.deleteMany({ where: { id: N } }).catch(() => {})
  })

  // ---- Bekleme listesi (waitlist) UÇTAN UCA ----
  await check('Waitlist: dolu seans → sıra → iptalde bildirim → rezervasyonda listeden çık', async () => {
    const WS = 990041, UA = 990041, UB = 990042, UC = 990043
    await prisma.class_Session.upsert({ where: { id: WS }, update: { availableSpots: 1, status: 'open' }, create: { id: WS, classId: C, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), availableSpots: 1, status: 'open' } })
    for (const uid of [UA, UB, UC]) {
      await prisma.user.upsert({ where: { id: uid }, update: {}, create: { id: uid, username: `wl_${uid}`, email: `wl_${uid}@x.com`, passwordHash: 'x', fullName: `WL ${uid}`, tierSportCounts: {} } })
    }
    const tok = (uid: number) => jwt.sign({ userId: uid, email: `wl_${uid}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    // A dersi doldurur (kapasite 1)
    const bookA = await http('/api/bookings', { method: 'POST', token: tok(UA), body: { sessionId: WS } })
    if (bookA.status !== 201) throw new Error(`A rezervasyon: ${bookA.status}`)
    // B ve C bekleme listesine
    if ((await http(`/api/waitlist/sessions/${WS}`, { method: 'POST', token: tok(UB) })).status !== 201) throw new Error('B waitlist katılamadı')
    if ((await http(`/api/waitlist/sessions/${WS}`, { method: 'POST', token: tok(UC) })).status !== 201) throw new Error('C waitlist katılamadı')
    // Sıra: B=1, C=2 (position bug düzeltmesi)
    const stB = await http(`/api/waitlist/sessions/${WS}/status`, { token: tok(UB) })
    if (stB.json?.position !== 1 || stB.json?.totalWaiting !== 2) throw new Error(`B sıra yanlış: pos=${stB.json?.position} total=${stB.json?.totalWaiting}`)
    const stC = await http(`/api/waitlist/sessions/${WS}/status`, { token: tok(UC) })
    if (stC.json?.position !== 2) throw new Error(`C sıra yanlış: pos=${stC.json?.position}`)
    // A iptal → ilk bekleyene (B) bildirim (status 'notified')
    const bkA = await prisma.booking.findFirst({ where: { userId: UA, sessionId: WS } })
    if ((await http(`/api/bookings/${bkA?.id}/cancel`, { method: 'PUT', token: tok(UA) })).status !== 200) throw new Error('A iptal edemedi')
    const wB = await prisma.waitlist.findFirst({ where: { userId: UB, sessionId: WS }, select: { status: true } })
    if (wB?.status !== 'notified') throw new Error(`B bildirim durumu: ${wB?.status} (notified bekleniyor)`)
    // B açılan yeri rezerve eder → waitlist'ten ÇIKAR (stale kalmasın)
    const bookB = await http('/api/bookings', { method: 'POST', token: tok(UB), body: { sessionId: WS } })
    if (bookB.status !== 201) throw new Error(`B rezervasyon: ${bookB.status} ${bookB.text.slice(0, 100)}`)
    const stB2 = await http(`/api/waitlist/sessions/${WS}/status`, { token: tok(UB) })
    if (stB2.json?.onWaitlist !== false) throw new Error('B rezervasyon sonrası hâlâ bekleme listesinde (stale kayıt)')
    // C artık 1. sırada (B çıktı) — sıra kayması doğru
    const stC2 = await http(`/api/waitlist/sessions/${WS}/status`, { token: tok(UC) })
    if (stC2.json?.position !== 1 || stC2.json?.totalWaiting !== 1) throw new Error(`C güncel sıra yanlış: pos=${stC2.json?.position} total=${stC2.json?.totalWaiting}`)
    await prisma.rewardPoint.deleteMany({ where: { userId: { in: [UA, UB, UC] } } }).catch(() => {})
    await prisma.waitlist.deleteMany({ where: { sessionId: WS } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { sessionId: WS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: WS } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [UA, UB, UC] } } }).catch(() => {})
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
    // Aktif rezervasyonu olan kullanıcı (U2) "salon kaldırıldı" bildirimi almalı
    const notif = await prisma.notification.findFirst({ where: { userId: U2, type: 'booking_cancelled' } })
    if (!notif) throw new Error('salon silinince etkilenen kullanıcıya bildirim gitmedi')
    await prisma.notification.deleteMany({ where: { userId: U2 } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: U2 } }).catch(() => {})
  })

  await check('Token ömrü: kullanıcı 1s (kısa+refresh), venue 7g (uzun)', async () => {
    const dec = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString())
    const uTok = generateToken({ userId: 1, email: 'x@x.com' })
    const vTok = generateToken({ venueId: 1, email: 'x@x.com', role: 'venue' })
    const uLife = dec(uTok).exp - dec(uTok).iat
    const vLife = dec(vTok).exp - dec(vTok).iat
    if (uLife !== 3600) throw new Error(`kullanıcı token ömrü ${uLife}s (3600=1s bekleniyor)`)
    if (vLife !== 604800) throw new Error(`venue token ömrü ${vLife}s (604800=7g bekleniyor)`)
  })

  await check('Görsel: sadece geçerli http(s) URL kabul, kötü/bozuk girdi temizlenir', async () => {
    const vt = jwt.sign({ venueId: V, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/venue/images', { method: 'PUT', token: vt, body: { images: ['javascript:alert(1)', 'https://res.cloudinary.com/x/a.jpg', 'not-a-url', 123, 'https://res.cloudinary.com/x/b.jpg'], coverImageUrl: 'javascript:evil' } })
    if (r.status !== 200) throw new Error(`beklenen 200, gelen ${r.status}: ${r.text.slice(0, 100)}`)
    const v = await prisma.venue.findUnique({ where: { id: V }, select: { pendingImages: true, pendingCoverImageUrl: true } })
    const imgs = v?.pendingImages as any[]
    if (!Array.isArray(imgs) || imgs.length !== 2) throw new Error(`pendingImages ${JSON.stringify(imgs)} (2 geçerli URL bekleniyor)`)
    if (imgs.some((u: string) => !/^https/.test(u))) throw new Error('geçersiz URL sızdı')
    if (v?.pendingCoverImageUrl !== null) throw new Error(`cover ${v?.pendingCoverImageUrl} (null bekleniyor — javascript: reddedilmeli)`)
    // İz bırakma: bekleyeni temizle
    await prisma.venue.update({ where: { id: V }, data: { pendingImages: [], pendingCoverImageUrl: null, imagesPendingReview: false } })
  })

  await check('Arama nearby: en yakın salon geç seansda olsa 1. sayfada (global sort)', async () => {
    // Kullanıcı + YAKIN salon aynı konumda (mesafe ~0); UZAK salon uzakta ama seansı daha ERKEN.
    await prisma.neighborhood.upsert({ where: { id: 990161 }, update: {}, create: { id: 990161, name: 'NbUser', latitude: 41.5, longitude: 29.5, cityId: 1 } })
    await prisma.neighborhood.upsert({ where: { id: 990162 }, update: {}, create: { id: 990162, name: 'NbNear', latitude: 41.5, longitude: 29.5, cityId: 1 } })
    await prisma.neighborhood.upsert({ where: { id: 990163 }, update: {}, create: { id: 990163, name: 'NbFar', latitude: 40.0, longitude: 28.0, cityId: 1 } })
    await prisma.venue.upsert({ where: { id: 990161 }, update: { isApproved: true, isActive: true }, create: { id: 990161, name: 'YakinSalon', email: 'nvn@x.com', passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: 990162, cityId: 1 } })
    await prisma.venue.upsert({ where: { id: 990162 }, update: { isApproved: true, isActive: true }, create: { id: 990162, name: 'UzakSalon', email: 'nvf@x.com', passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: 990163, cityId: 1 } })
    const scat2 = await prisma.sportCategory.findFirst({})
    await prisma.class.upsert({ where: { id: 990161 }, update: {}, create: { id: 990161, venueId: 990161, title: 'NEARBYTEST Yakin', category: catName, sportCategoryId: scat2?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class.upsert({ where: { id: 990162 }, update: {}, create: { id: 990162, venueId: 990162, title: 'NEARBYTEST Uzak', category: catName, sportCategoryId: scat2?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: 990161 }, update: { startsAt: new Date(Date.now() + 5 * 86400000), status: 'open' }, create: { id: 990161, classId: 990161, startsAt: new Date(Date.now() + 5 * 86400000), endsAt: new Date(Date.now() + 5 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: 990162 }, update: { startsAt: new Date(Date.now() + 1 * 86400000), status: 'open' }, create: { id: 990162, classId: 990162, startsAt: new Date(Date.now() + 1 * 86400000), endsAt: new Date(Date.now() + 1 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    const r = await http(`/api/public/sessions?search=NEARBYTEST&sort=nearby&userNeighborhoodId=990161&limit=1`)
    if (r.status !== 200) throw new Error(`beklenen 200, gelen ${r.status}`)
    const first = r.json?.sessions?.[0]
    if (!first) throw new Error('sonuç boş')
    if (first.id !== 990161) throw new Error(`1. sonuç seans ${first.id} (990161=yakın bekleniyor; eski kod uzak/erken döndürürdü)`)
  })

  await check('For You: aynı ders çoklu seansla domine etmez (distinct classId)', async () => {
    // U catName'i tercih ediyor; C dersi (title "Smoke Class") catName kategorisinde + seed seansı var.
    // İkinci bir gelecek seans ekle → distinct olmasa 2 kez dönerdi.
    await prisma.class_Session.upsert({ where: { id: 990171 }, update: { startsAt: new Date(Date.now() + 3 * 86400000), status: 'open' }, create: { id: 990171, classId: C, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    const r = await http('/api/public/for-you', { token })
    if (r.status !== 200) throw new Error(`beklenen 200, gelen ${r.status}`)
    const ss = r.json?.sessions || []
    const cnt = ss.filter((x: any) => x.title === 'Smoke Class' && x.venueId === V).length
    if (cnt > 1) throw new Error(`aynı ders ${cnt} kez döndü (distinct ile 1 bekleniyor)`)
    await prisma.class_Session.deleteMany({ where: { id: 990171 } })
  })

  await check('Transfer: ucuz derse geçişte puan yeniden hesaplanır + bakiye eşitlenir', async () => {
    const TV = 990141, TU = 990141
    const scat = await prisma.sportCategory.findFirst({})
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true }, create: { id: TV, name: 'Transfer Salon', email: `trf${TV}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TV }, update: {}, create: { id: TV, venueId: TV, title: 'Pahalı', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 200, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class.upsert({ where: { id: TV + 1 }, update: {}, create: { id: TV + 1, venueId: TV, title: 'Ucuz', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const se = await prisma.class_Session.upsert({ where: { id: TV }, update: { startsAt: new Date(Date.now() + 2 * 86400000) }, create: { id: TV, classId: TV, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    const sc = await prisma.class_Session.upsert({ where: { id: TV + 1 }, update: { startsAt: new Date(Date.now() + 2 * 86400000) }, create: { id: TV + 1, classId: TV + 1, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: TU }, update: { rewardPoints: 2, tierId: 1 }, create: { id: TU, username: `trf_${TU}`, email: `trf_${TU}@x.com`, passwordHash: 'x', fullName: 'Transfer User', tierId: 1, rewardPoints: 2, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: TU } })
    const bk = await prisma.booking.create({ data: { userId: TU, sessionId: se.id, status: 'confirmed', bookingType: 'class', groupSize: 1, baseAmount: 200, commissionAmount: 0, venueCommission: 0, finalAmount: 200, venuePayout: 200, pointsEarned: 2, checkedIn: false, bookingNumber: `TRF-${Date.now()}` } })
    const tok = jwt.sign({ userId: TU, email: `trf_${TU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/bookings/${bk.id}/transfer`, { method: 'PUT', token: tok, body: { targetSessionId: sc.id } })
    if (r.status !== 200) throw new Error(`transfer başarısız: ${r.status} ${r.text.slice(0, 120)}`)
    const after = await prisma.booking.findUnique({ where: { id: bk.id }, select: { pointsEarned: true, finalAmount: true } })
    if (after?.pointsEarned !== 1) throw new Error(`pointsEarned ${after?.pointsEarned} (1 bekleniyor — ucuz derse göre)`)
    if (after?.finalAmount !== 100) throw new Error(`finalAmount ${after?.finalAmount} (100 bekleniyor)`)
    const up = await prisma.user.findUnique({ where: { id: TU }, select: { rewardPoints: true } })
    if (up?.rewardPoints !== 1) throw new Error(`rewardPoints ${up?.rewardPoints} (1 bekleniyor — fazla puan geri alındı)`)
  })

  await check('Kupon: kişi başı limit ikinci kullanımı engeller (400)', async () => {
    const cScat = await prisma.sportCategory.findFirst({})
    await prisma.class.upsert({ where: { id: 990151 }, update: {}, create: { id: 990151, venueId: V, title: 'KuponDers', category: catName, sportCategoryId: cScat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: 990151 }, update: { startsAt: new Date(Date.now() + 2 * 86400000), status: 'open' }, create: { id: 990151, classId: 990151, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: 990152 }, update: { startsAt: new Date(Date.now() + 2 * 86400000), status: 'open' }, create: { id: 990152, classId: 990151, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
    await prisma.booking.deleteMany({ where: { session: { classId: 990151 } } })
    await prisma.coupon.deleteMany({ where: { code: 'PERUSER1' } })
    await prisma.coupon.create({ data: { venueId: V, code: 'PERUSER1', discountType: 'fixed', discountValue: 100, perUserLimit: 1, isActive: true } })
    const b1 = await http('/api/bookings', { method: 'POST', token, body: { sessionId: 990151, couponCode: 'PERUSER1' } })
    if (b1.status !== 201) throw new Error(`1. kullanım başarısız: ${b1.status} ${b1.text.slice(0, 120)}`)
    const b2 = await http('/api/bookings', { method: 'POST', token, body: { sessionId: 990152, couponCode: 'PERUSER1' } })
    if (b2.status !== 400) throw new Error(`2. kullanım engellenmeli (400), gelen: ${b2.status} ${b2.text.slice(0, 120)}`)
  })

  // Hesap silme — EN SON (kullanıcıyı kaldırır). Yanlış parola reddedilmeli, doğru parola tüm veriyi temizlemeli.
  await check('Hesap silme: yanlış parola → 401', async () => {
    const r = await http('/api/auth/account', { method: 'DELETE', token, body: { password: 'yanlis-parola' } })
    if (r.status !== 401) throw new Error(`yanlış parolayla silindi: ${r.status}`)
  })
  await check('Hesap silme: doğru parola → silinir + veriler (booking dahil) temizlenir', async () => {
    const hash = await bcrypt.hash('SilTest1234', 12)
    await prisma.user.update({ where: { id: U }, data: { passwordHash: hash } })
    // Gerçek kullanıcı gibi bir refresh token ver → silme FK-güvenliği (refreshToken temizliği) test edilsin
    await prisma.refreshToken.create({ data: { token: `smoke-rt-${U}-${Date.now()}`, userId: U, expiresAt: new Date(Date.now() + 86400000) } }).catch(() => {})
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
