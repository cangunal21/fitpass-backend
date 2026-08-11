/**
 * Smoke test: gerçekçi ver-i seed edip TÜM önemli endpoint'leri çalıştırır.
 * Amaç: getSessions gibi "gerçek veriyle çöken" bugları deploy ÖNCESİ yakalamak.
 *
 * Çalıştırma:  npm run smoke
 * (Kendi sunucusunu test portunda başlatır, kontrolleri yapar, veriyi temizler.)
 */
import 'dotenv/config' // sunucunun (src/index.ts) yaptığı gibi: sırlar .env'den gelir, gömülü varsayılan YOK
import { guardTestDb } from './_guardTestDb'
guardTestDb('smoke') // CANLI DB koruması — dotenv export edilmiş DATABASE_URL'i EZMEZ (bkz. _guardTestDb.ts)
import { spawn, ChildProcess } from 'child_process'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { generateToken } from '../src/utils/jwt'
import { seasonInfo } from '../src/utils/season'
import { ensureBadges } from '../src/utils/ensureBadges'
import { awardSeasonChampions } from '../src/jobs/championJob'
import { sendRatingPrompts } from '../src/jobs/ratingPromptJob'
import { sendRemindersJob } from '../src/jobs/reminderJob'
import { sweepWaitlist } from '../src/jobs/waitlistJob'
import { reconcileAttendancePoints } from '../src/jobs/attendanceJob'
import prisma from '../src/utils/prisma'

const PORT = 3199
const BASE = `http://localhost:${PORT}`
// Test harness'i sunucuyla AYNI anahtarı kullanmalı. Gömülü varsayılan kaldırıldı (public repo).
const JWT_SECRET = process.env.JWT_SECRET || ''
if (!JWT_SECRET) { console.error('JWT_SECRET set edilmeli (.env veya ortam).'); process.exit(1) }
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'fitpass-admin-2024'
const CRON_SECRET = process.env.CRON_SECRET || 'cron-secret-2024'

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
  await prisma.class_Session.upsert({ where: { id: S }, update: {}, create: { id: S, classId: C, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 20, status: 'open' } })
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
  // Güvenlik regresyon testi kalıntıları (990281/990283)
  await prisma.booking.deleteMany({ where: { userId: { in: [990281, 990283] } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990283 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990281, 990283] } } }).catch(() => {})
  // Gizlilik/IDOR regresyon kalıntıları (9903xx) — FK sırası: booking→session→class→instructor→venue
  await prisma.booking.deleteMany({ where: { OR: [{ userId: 990301 }, { session: { class: { venueId: { in: [990301, 990302] } } } }] } }).catch(() => {})
  await prisma.rewardPoint.deleteMany({ where: { userId: 990301 } }).catch(() => {})
  await prisma.refreshToken.deleteMany({ where: { userId: 990301 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { class: { venueId: { in: [990301, 990302] } } } }).catch(() => {})
  await prisma.class.updateMany({ where: { venueId: { in: [990301, 990302] } }, data: { instructorId: null } }).catch(() => {})
  await prisma.class.deleteMany({ where: { venueId: { in: [990301, 990302] } } }).catch(() => {})
  await prisma.instructor.deleteMany({ where: { venueId: { in: [990301, 990302] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990301 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: { in: [990301, 990302] } } }).catch(() => {})
  // Oyunlaştırma follow-up regresyon kalıntıları (#3 şampiyon berabere 99031x, #2 referral reversal 99033x)
  await prisma.userBadge.deleteMany({ where: { userId: { in: [990312, 990313] } } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: { in: [990312, 990313] } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990311 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990310 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990312, 990313] } } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: 990310 } }).catch(() => {})
  await prisma.rewardPoint.deleteMany({ where: { userId: { in: [990330, 990331] } } }).catch(() => {})
  await prisma.referral.deleteMany({ where: { OR: [{ referrerId: 990330 }, { referredId: { in: [990330, 990331] } }] } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990330, 990331] } } }).catch(() => {})
  // Ekonomik regresyon kalıntıları (9934x + test kupon kodları)
  const econVenues = [990340, 990341, 990342, 990343]
  const econUsers = [990340, 990342, 990343]
  await prisma.coupon.deleteMany({ where: { code: { in: ['HALF50TEST', 'ORCL10'] } } }).catch(() => {})
  await prisma.rewardPoint.deleteMany({ where: { userId: { in: econUsers } } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { OR: [{ userId: { in: econUsers } }, { session: { class: { venueId: { in: econVenues } } } }] } }).catch(() => {})
  await prisma.coupon.deleteMany({ where: { venueId: { in: econVenues } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { class: { venueId: { in: econVenues } } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { venueId: { in: econVenues } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: econUsers } } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: { in: econVenues } } }).catch(() => {})
  // Gizlilik-modeli liderlik regresyon kalıntısı (9935x)
  await prisma.booking.deleteMany({ where: { userId: 990350 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990350 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990350 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990350 } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: 990350 } }).catch(() => {})
  // Ertelenen teknik borç batch kalıntıları (99036x: refresh/silinen-token/pointRate/bayesian/takvim/drop-in)
  await prisma.refreshToken.deleteMany({ where: { userId: 990361 } }).catch(() => {})
  await prisma.rewardPoint.deleteMany({ where: { userId: { in: [990361, 990362, 990366, 990367] } } }).catch(() => {})
  await prisma.dropInParticipant.deleteMany({ where: { OR: [{ userId: 990367 }, { slotId: 990367 }] } }).catch(() => {})
  await prisma.dropInSlot.deleteMany({ where: { id: 990367 } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: { in: [990361, 990362, 990366, 990367] } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990362 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990362 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990361, 990362, 990366, 990367, 990369] } } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: { in: [990363, 990364, 990365] } } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: { in: [990363, 990368] } } }).catch(() => {})
  // Bildirim çoklu-dil (#67) kalıntıları (99037x)
  await prisma.follow.deleteMany({ where: { OR: [{ followerId: { in: [990371, 990372] } }, { followingId: { in: [990371, 990372] } }] } }).catch(() => {})
  await prisma.notification.deleteMany({ where: { userId: { in: [990371, 990372, 990373] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990371, 990372, 990373] } } }).catch(() => {})
  await prisma.refreshToken.deleteMany({ where: { userId: 990381 } }).catch(() => {})
  // Drift denetimi düzeltmeleri (99039x): onay kapısı + drop-in moderasyon filtresi
  await prisma.booking.deleteMany({ where: { session: { classId: 990391 } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990391 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990391 } }).catch(() => {})
  await prisma.dropInParticipant.deleteMany({ where: { slotId: 990392 } }).catch(() => {})
  await prisma.dropInSlot.deleteMany({ where: { id: 990392 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: { in: [990391, 990392] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990381 } }).catch(() => {})
  // Kategori silme guard testi kalıntısı (990401 + SmokeKatSil)
  await prisma.userBadge.deleteMany({ where: { userId: 990401 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990401 } }).catch(() => {})
  await prisma.sportCategory.deleteMany({ where: { name: 'SmokeKatSil' } }).catch(() => {})
  // Coğrafya (cityId) testi kalıntısı (990421)
  await prisma.user.deleteMany({ where: { id: 990421 } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: 990421 } }).catch(() => {})
  // Özel yanıt testi kalıntısı (990431)
  await prisma.review.deleteMany({ where: { venueId: 990431 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990431 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990431 } }).catch(() => {})
  // Gelir raporu TZ testi kalıntısı (99041x)
  await prisma.booking.deleteMany({ where: { session: { classId: 990411 } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990411 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990411 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990411 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990411 } }).catch(() => {})
  // Auth regresyon test venue kalıntıları (990013 other-venue, 990014 suspend)
  await prisma.venue.deleteMany({ where: { id: { in: [990013, 990014] } } }).catch(() => {})
  await prisma.coupon.deleteMany({ where: { code: { startsWith: 'NEG' } } }).catch(() => {})
  // Kayıt/giriş case testi kalıntısı (usrcase01)
  {
    const u = await prisma.user.findFirst({ where: { email: { equals: 'usrcase01@x.com', mode: 'insensitive' } }, select: { id: true } }).catch(() => null)
    if (u) { await prisma.refreshToken.deleteMany({ where: { userId: u.id } }).catch(() => {}); await prisma.emailVerificationToken.deleteMany({ where: { userId: u.id } }).catch(() => {}); await prisma.user.delete({ where: { id: u.id } }).catch(() => {}) }
  }
  // Gizli hesap testi kalıntıları (990271/990272)
  await prisma.follow.deleteMany({ where: { OR: [{ followerId: { in: [990271, 990272] } }, { followingId: { in: [990271, 990272] } }] } }).catch(() => {})
  await prisma.notification.deleteMany({ where: { userId: { in: [990271, 990272] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990271, 990272] } } }).catch(() => {})
  // Düzenli (geçmiş sezon) testi kalıntıları (990261-990270)
  await prisma.userBadge.deleteMany({ where: { userId: 990261 } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: 990261 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: Array.from({ length: 10 }, (_, i) => 990261 + i) } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990261 } }).catch(() => {})
  // Takip akışı testi kalıntıları (990251/990252)
  await prisma.follow.deleteMany({ where: { OR: [{ followerId: { in: [990251, 990252] } }, { followingId: { in: [990251, 990252] } }] } }).catch(() => {})
  await prisma.notification.deleteMany({ where: { userId: { in: [990251, 990252] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990251, 990252] } } }).catch(() => {})
  // Kurucu/Elçi testi kalıntıları (990241-990244)
  await prisma.referral.deleteMany({ where: { referrerId: 990241 } }).catch(() => {})
  await prisma.userBadge.deleteMany({ where: { userId: 990241 } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: 990241 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990241 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990241, 990242, 990243, 990244] } } }).catch(() => {})
  // Rekor seri + sezon şampiyonu testi kalıntıları (990221-990233)
  await prisma.userBadge.deleteMany({ where: { OR: [{ userId: { in: [990221, 990222, 990231] } }, { scopeId: 990221 }] } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: { in: [990221, 990222, 990231] } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990221, 990222, 990231, 990232, 990233] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990221 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990221, 990222, 990231] } } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: 990221 } }).catch(() => {})
  // Sezonluk liderlik testi kalıntısı (990211/990212)
  await prisma.booking.deleteMany({ where: { userId: 990211 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990211, 990212] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990211 } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: 990211 } }).catch(() => {})
  // Cron hatırlatma idempot-lik testi kalıntısı (990191)
  await prisma.booking.deleteMany({ where: { sessionId: 990191 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990191 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990191 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990191 } }).catch(() => {})
  // Salon istatistik groupSize testi kalıntısı (990181)
  await prisma.booking.deleteMany({ where: { sessionId: 990181 } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: 990181 } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: 990181 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990181 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990181 } }).catch(() => {})
  // Nearby global-sort testi kalıntısı (990161-990163)
  await prisma.class_Session.deleteMany({ where: { id: { in: [990161, 990162] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: { in: [990161, 990162] } } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: { in: [990161, 990162] } } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: { in: [990161, 990162, 990163] } } }).catch(() => {})
  // Favori testi kalıntıları
  await prisma.favoriteVenue.deleteMany({ where: { userId: 990101 } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: 990101 } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: 990101 } }).catch(() => {})
  // Yorum yaşam-döngüsü + çift puanlama + pending/job + eğitmen-auth + eğitmen-portal testi kalıntıları
  await prisma.notification.deleteMany({ where: { userId: { in: [990093, 990095] } } }).catch(() => {})
  await prisma.instructorPasswordResetToken.deleteMany({ where: { instructorId: { in: [990093, 990095, 990097, 990098, 990100] } } }).catch(() => {})
  await prisma.review.deleteMany({ where: { OR: [{ venueId: { in: [990091, 990093, 990094, 990095, 990097, 990099, 990100] } }, { instructorId: { in: [990093, 990095, 990097, 990098, 990100] } }] } }).catch(() => {})
  await prisma.booking.deleteMany({ where: { userId: { in: [990091, 990093, 990094, 990095, 990097, 990100] } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { class: { venueId: 990100 } } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [990091, 990092, 990093, 990094, 990095, 990096] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: { in: [990091, 990093, 990094, 990095] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { venueId: 990100 } }).catch(() => {})
  await prisma.instructor.deleteMany({ where: { id: { in: [990093, 990095, 990097, 990098, 990100] } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [990091, 990093, 990094, 990095, 990097, 990100] } } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: { in: [990091, 990093, 990094, 990095, 990097, 990099, 990100] } } }).catch(() => {})
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
  await prisma.booking.deleteMany({ where: { OR: [{ userId: U }, { sessionId: S }, { sessionId: 990002 }] } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: { in: [S, 990002] } } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: C } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: V } }).catch(() => {})
  await prisma.userBadge.deleteMany({ where: { userId: U } }).catch(() => {})
  await prisma.notification.deleteMany({ where: { userId: U } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: U } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: V } }).catch(() => {})
}

async function waitForServer() {
  // '/' DEĞİL '/health': kök uç sunucu dinlemeye başlar başlamaz 200 dönüyordu, ama açılış
  // işleri (ensureIndexes — rozet çift-veriş korumasının DAYANDIĞI tekillik index'leri) hâlâ
  // sürüyordu. Testler o pencerede başlayınca yarış oluşuyordu. /health artık bootTamam
  // bayrağına bakıyor → gerçek hazır-olma sinyali.
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) return } catch {}
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error('Sunucu başlamadı (veya açılış işleri tamamlanmadı)')
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

  // Check-in sistemi: salon kodu doğrulayıp check-in yapıyor mu (uçtan uca) + ZAMAN PENCERESİ (#5)
  await check('Check-in: salon kodu ile check-in + gelecek seans reddi (#5)', async () => {
    const venueToken = jwt.sign({ venueId: V, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    // Ders SAATİNDE (pencere içi: başlangıç−20dk .. bitiş+40dk) seans → check-in BAŞARILI
    await prisma.class_Session.upsert({ where: { id: 990002 }, update: { classId: C, startsAt: new Date(Date.now() - 20 * 60000), endsAt: new Date(Date.now() + 40 * 60000), status: 'open', capacity: 20 }, create: { id: 990002, classId: C, startsAt: new Date(Date.now() - 20 * 60000), endsAt: new Date(Date.now() + 40 * 60000), capacity: 20, status: 'open' } })
    const code = `CIN${Date.now() % 100000}`
    await prisma.booking.create({ data: { userId: U, sessionId: 990002, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `CIN-${Date.now()}`, checkInCode: code, checkedIn: false } })
    const r = await http('/api/bookings/checkin', { method: 'POST', token: venueToken, body: { code } })
    if (r.status !== 200 || !r.json?.success) throw new Error(`check-in başarısız: ${r.status} ${r.text.slice(0, 140)}`)
    // #5: GELECEKTEKİ seans (S, +2 gün) check-in REDDEDİLİR (streak/rozet şişirme engeli)
    const bf = await prisma.booking.findFirst({ where: { userId: U, sessionId: S }, select: { checkInCode: true } })
    if (bf?.checkInCode) {
      const rf = await http('/api/bookings/checkin', { method: 'POST', token: venueToken, body: { code: bf.checkInCode } })
      if (rf.status !== 400) throw new Error(`gelecekteki seans check-in reddedilmedi (#5): ${rf.status}`)
    }
  })

  // Check-in yanlış salon token'ı ile reddedilmeli (IDOR koruması)
  await check('Check-in: başka salon reddediliyor (404 — existence-oracle kapalı)', async () => {
    const b = await prisma.booking.findFirst({ where: { userId: U, sessionId: S }, select: { checkInCode: true } })
    // GERÇEK ama farklı bir salon. Sahip-olunmayan kod, BULUNAMAYAN kodla AYNI 404 döner (403 DEĞİL):
    // 403 dönmek "bu kod platformda var" bilgisini ele veriyordu (existence-oracle). Denetim turu 13'te
    // instructor tarafıyla simetrik hale getirildi; bu test o davranışı kilitliyor.
    const OV = 990013
    await prisma.venue.upsert({ where: { id: OV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: OV, name: 'OtherV', email: `ov${OV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    const otherVenueToken = jwt.sign({ venueId: OV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/bookings/checkin', { method: 'POST', token: otherVenueToken, body: { code: b?.checkInCode } })
    if (r.status !== 404) throw new Error(`başka salon check-in: ${r.status} (404 bekleniyor — oracle kapalı)`)
    await prisma.venue.deleteMany({ where: { id: OV } }).catch(() => {})
  })

  // AUTH: askıya alınan salon token'ı OKUMA uçlarında da reddedilir (venueAuthMiddleware per-request recheck + cache invalidate)
  await check('Auth: askıya alınan salon token okuma uçlarında 403 (recheck)', async () => {
    const SV = 990014
    await prisma.venue.upsert({ where: { id: SV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: SV, name: 'SuspV', email: `sv${SV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    const svTok = jwt.sign({ venueId: SV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    if ((await http('/api/venue/stats', { token: svTok })).status !== 200) throw new Error('aktif salon /stats okuyamadı (kurulum)')
    const susp = await http(`/api/admin/venues/${SV}/suspend`, { method: 'PUT', admin: true, body: { suspend: true } })
    if (susp.status !== 200) throw new Error(`suspend başarısız: ${susp.status}`)
    if ((await http('/api/venue/stats', { token: svTok })).status !== 403) throw new Error('askıya alınan salon token ile OKUMA yapabildi — venueAuth recheck çalışmıyor')
    await prisma.venue.deleteMany({ where: { id: SV } }).catch(() => {})
  })

  // AUTH: cron reminders secret'siz/yanlış-secret 401 (gömülü default kaldırıldı; smoke sunucusuna CRON_SECRET verildi)
  await check('Auth: cron reminders secret gerektirir (401)', async () => {
    const noHdr = await fetch(BASE + '/api/cron/reminders').then(r => r.status).catch(() => 0)
    if (noHdr !== 401) throw new Error(`cron secret'siz ${noHdr} (401 bekleniyor)`)
    const wrong = await fetch(BASE + '/api/cron/reminders', { headers: { 'x-cron-secret': 'yanlis-secret' } }).then(r => r.status).catch(() => 0)
    if (wrong !== 401) throw new Error(`cron yanlış secret ${wrong} (401 bekleniyor)`)
  })

  // AUTH: venue şifre sıfırlama MIN_PASSWORD (8) uygular — 7 karakter reddedilir (önceden 6'ya izin veriyordu)
  await check('Auth: venue reset-password kısa şifreyi reddeder (min 8)', async () => {
    const r = await http('/api/venue/reset-password', { method: 'POST', body: { token: 'dummy-token', password: '1234567' } })
    if (r.status !== 400) throw new Error(`7-karakter venue şifresi ${r.status} (400 bekleniyor)`)
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
    // check-in kapısını GEÇ (checkedIn=true) ki YALNIZ "ders gerçekleşmedi" (endsAt gelecekte) kapısı sınansın.
    // (S seansı +2 gün gelecekte olduğundan endpoint'le check-in #5 penceresine takılırdı — DB'den kuruyoruz.)
    await prisma.booking.update({ where: { id: b!.id }, data: { checkedIn: true, checkedInAt: new Date() } })
    const r = await http('/api/reviews', { method: 'POST', token, body: { bookingId: b?.id, rating: 5, comment: 'erken yorum' } })
    if (r.status !== 400) throw new Error(`gerçekleşmemiş derse yorum yapılabildi: ${r.status}`)
    await prisma.booking.update({ where: { id: b!.id }, data: { checkedIn: false, checkedInAt: null } }).catch(() => {})
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
      const u = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true } }) // kod email'i küçük harfe normalize eder
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
    // B ücretli ders alır → check-in'de completeReferral: iki tarafa da 100 (puan/referral artık check-in'de)
    if ((await http('/api/bookings', { method: 'POST', token: B.token, body: { sessionId: S } })).status !== 201) throw new Error('B rezervasyon başarısız')
    const bBooking = await prisma.booking.findFirst({ where: { userId: B.id, sessionId: S }, select: { id: true } })
    if (!bBooking) throw new Error('B booking bulunamadı')
    // Derse GİTTİ (check-in) → gerçek awardAttendanceOnCheckin yolu (referral + cashback burada tetiklenir)
    await prisma.booking.update({ where: { id: bBooking.id }, data: { checkedIn: true, checkedInAt: new Date() } })
    await require('../src/controllers/bookingController').awardAttendanceOnCheckin(bBooking.id)
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

  // ---- KRİTİK gizlilik/IDOR regresyonu (privacy-authz denetimi, 18 bulgu) ----
  // Eğitmen passwordHash/email/phone public sızmaz · salon finansal getMyBookings'te sızmaz ·
  // yabancı hoca dersе bağlanamaz · updateInstructor passwordHash döndürmez · private profil agregat gizler.
  await check('Gizlilik/IDOR: eğitmen PII + salon finansal + yabancı-hoca + private-agregat', async () => {
    const GV = 990301, GV2 = 990302, GI = 990301, GI2 = 990302, GC = 990301, GS = 990301, GU = 990301
    const nb = await prisma.neighborhood.findFirst({ select: { id: true, cityId: true } })
    const anyCat = await prisma.sportCategory.findFirst({ select: { id: true, name: true } })
    if (!nb || !anyCat) throw new Error('seed (neighborhood/sportCategory) yok')
    const email = `greg_${GU}@x.com`
    const INSTR_SECRET = { passwordHash: 'HASH-SIZMAMALI', email: 'hoca-gizli@x.com', phone: '5551234567' }
    // Kurulum
    await prisma.venue.upsert({ where: { id: GV }, update: { isApproved: true, isActive: true, iban: 'TR999', identityNumber: '22222222222', taxNumber: '9998887766', iyzicoSubMerchantKey: 'sk-secret', kycDocs: { kimlik: 'u' } }, create: { id: GV, name: 'GVenue', email: `gv${GV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: nb.id, cityId: nb.cityId, iban: 'TR999', identityNumber: '22222222222', taxNumber: '9998887766', iyzicoSubMerchantKey: 'sk-secret', kycDocs: { kimlik: 'u' } } })
    await prisma.venue.upsert({ where: { id: GV2 }, update: { isApproved: true, isActive: true }, create: { id: GV2, name: 'GVenue2', email: `gv${GV2}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: nb.id, cityId: nb.cityId } })
    await prisma.instructor.upsert({ where: { id: GI }, update: { venueId: GV, isActive: true, inviteStatus: 'active', ...INSTR_SECRET }, create: { id: GI, venueId: GV, fullName: 'Gizli Hoca', specialty: 'Yoga', isActive: true, inviteStatus: 'active', ...INSTR_SECRET } })
    await prisma.instructor.upsert({ where: { id: GI2 }, update: { venueId: GV2, isActive: true }, create: { id: GI2, venueId: GV2, fullName: 'Yabanci Hoca', isActive: true } })
    await prisma.class.upsert({ where: { id: GC }, update: { venueId: GV, instructorId: GI, isActive: true }, create: { id: GC, venueId: GV, title: 'GClass', category: anyCat.name, sportCategoryId: anyCat.id, basePrice: 100, durationMinutes: 60, capacity: 20, instructorId: GI, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: GS }, update: { status: 'open', capacity: 20, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000) }, create: { id: GS, classId: GC, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: GU }, update: { activityPrivacy: 'public', banned: false }, create: { id: GU, username: `greg_${GU}`, email, passwordHash: 'x', fullName: 'Greg User', tierSportCounts: {}, totalLessonsCompleted: 7, recordStreak: 4 } })
    const gvTok = jwt.sign({ venueId: GV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const guTok = jwt.sign({ userId: GU, email }, JWT_SECRET, { expiresIn: '1h' })
    const INSTR_LEAK = ['passwordHash', 'email', 'phone', 'inviteStatus', 'userId']
    const VENUE_FIN = ['iban', 'identityNumber', 'taxNumber', 'iyzicoSubMerchantKey', 'kycDocs']

    // 1) public eğitmen detayı — passwordHash/email/phone SIZMAZ (kimlik-doğrulamasız uç)
    const insDet = await expectOk(`/api/public/instructors/${GI}`)
    const insObj = insDet.json?.instructor || {}
    for (const k of INSTR_LEAK) if (k in insObj) throw new Error(`public instructor '${k}' sızdırıyor (hesap ele geçirme!)`)

    // 2) public venue detayı — iç içe instructors[] + classes[].instructor de temiz
    const vDet = await expectOk(`/api/public/venues/${GV}`)
    const nestedIns = (vDet.json?.venue?.instructors || []).find((i: any) => i.id === GI)
    if (!nestedIns) throw new Error('venue.instructors[] içinde hoca yok (kurulum)')
    for (const k of INSTR_LEAK) if (k in nestedIns) throw new Error(`venue.instructors[] '${k}' sızdırıyor`)
    const nestedCls = (vDet.json?.venue?.classes || []).find((c: any) => c.id === GC)
    if (nestedCls?.instructor) for (const k of INSTR_LEAK) if (k in nestedCls.instructor) throw new Error(`venue.classes[].instructor '${k}' sızdırıyor`)

    // 3) getMyBookings — salonun IBAN/TCKN/İyzico/KYC'si müşteriye SIZMAZ
    const bkRes = await http('/api/bookings', { method: 'POST', token: guTok, body: { sessionId: GS } })
    if (bkRes.status !== 201) throw new Error(`booking oluşmadı: ${bkRes.status}`)
    const my = await expectOk('/api/bookings/my', { token: guTok })
    const myBk = (my.json?.bookings || []).find((b: any) => b.sessionId === GS)
    const myVenue = myBk?.session?.class?.venue || {}
    for (const k of VENUE_FIN) if (k in myVenue) throw new Error(`getMyBookings venue '${k}' sızdırıyor (KVKK/finansal!)`)

    // 4) createClass — YABANCI hoca (başka salonun) reddedilir (403), kendi hocan kabul (201)
    const foreign = await http('/api/venue/classes', { method: 'POST', token: gvTok, body: { title: 'X', category: anyCat.name, basePrice: 100, duration: 60, capacity: 10, instructorId: GI2 } })
    if (foreign.status !== 403) throw new Error(`yabancı instructorId 403 beklenirken ${foreign.status} (cross-tenant yazma!)`)
    const own = await http('/api/venue/classes', { method: 'POST', token: gvTok, body: { title: 'X', category: anyCat.name, basePrice: 100, duration: 60, capacity: 10, instructorId: GI } })
    if (own.status !== 201) throw new Error(`kendi hoca ile ders 201 beklenirken ${own.status}`)
    const ownClassId = own.json?.class?.id

    // 5) updateInstructor — salon sahibine passwordHash DÖNMEZ
    const upd = await http(`/api/venue/instructors/${GI}`, { method: 'PUT', token: gvTok, body: { phone: '5550001122' } })
    if (upd.status !== 200) throw new Error(`updateInstructor: ${upd.status}`)
    if ('passwordHash' in (upd.json?.instructor || {})) throw new Error('updateInstructor passwordHash döndürüyor (salon→hoca realm sızıntısı)')

    // 6) AKTİVİTE GİZLİ (profil AÇIK): gidilen dersler (activities) GİZLİ; ama rozet + istatistik HERKESE açık
    // (kullanıcı kararı: "rozet ve tier'ı herkes görür"). Yabancı (anonim) bakışı.
    await prisma.user.update({ where: { id: GU }, data: { activityPrivacy: 'private' } })
    const prof = await expectOk(`/api/public/users/greg_${GU}`)
    if (prof.json?.activities !== null) throw new Error('aktivite-gizli: gidilen dersler (activities) null olmalı')
    const pu = prof.json?.user || {}
    if (!('badges' in pu) || !Array.isArray(pu.badges)) throw new Error('aktivite-gizli: rozetler GÖRÜNMELİ (yeni model)')
    // totalLessonsCompleted getUserActivities'te syncUserTier ile yeniden hesaplanır → sabit değere güvenme; VARLIĞI yeter
    if (!('totalLessonsCompleted' in pu)) throw new Error('aktivite-gizli: istatistik alanı görünmeli (gizlenmemeli)')

    // Temizlik
    await prisma.booking.deleteMany({ where: { userId: GU } }).catch(() => {})
    await prisma.rewardPoint.deleteMany({ where: { userId: GU } }).catch(() => {})
    await prisma.refreshToken.deleteMany({ where: { userId: GU } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: ownClassId ? { in: [ownClassId] } : { in: [] } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: GS } }).catch(() => {})
    await prisma.class.updateMany({ where: { id: GC }, data: { instructorId: null } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: GC } }).catch(() => {})
    await prisma.instructor.deleteMany({ where: { id: { in: [GI, GI2] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: GU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: { in: [GV, GV2] } } }).catch(() => {})
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

  // ---- Yorum yaşam döngüsü: seans SİLİNSE BİLE yorum kalıcı (booking'den ayrıştırılır) ----
  // GÜVENLİK: salon, kötü yorumu seansı/dersi silerek TEMİZLEYEMEZ. Seans silinince yorumun
  // bookingId'si null'a çekilir; venueId + puan korunur → avgRating/totalReviews DEĞİŞMEZ.
  await check('Yorum: seans silinince yorum KALICI (ayrıştırılır), salon puanı düşmez', async () => {
    const RV = 990091, RC = 990091, RS1 = 990091, RS2 = 990092, RU = 990091
    await prisma.venue.upsert({ where: { id: RV }, update: { isApproved: true, isActive: true }, create: { id: RV, name: 'RevVenue', email: `rv${RV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: RC }, update: {}, create: { id: RC, venueId: RV, title: 'RevDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.user.upsert({ where: { id: RU }, update: {}, create: { id: RU, username: `rev_${RU}`, email: `rev_${RU}@x.com`, passwordHash: 'x', fullName: 'Rev', tierSportCounts: {} } })
    const past = (k: number) => new Date(Date.now() - k * 86400000)
    await prisma.class_Session.upsert({ where: { id: RS1 }, update: {}, create: { id: RS1, classId: RC, startsAt: past(2), endsAt: past(2), capacity: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: RS2 }, update: {}, create: { id: RS2, classId: RC, startsAt: past(1), endsAt: past(1), capacity: 20, status: 'open' } })
    const bk1 = await prisma.booking.create({ data: { userId: RU, sessionId: RS1, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `RV1-${Date.now()}` } })
    const bk2 = await prisma.booking.create({ data: { userId: RU, sessionId: RS2, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `RV2-${Date.now()}` } })
    const rvw1 = await prisma.review.create({ data: { bookingId: bk1.id, reviewerUserId: RU, targetType: 'venue', venueId: RV, rating: 2 } })
    await prisma.review.create({ data: { bookingId: bk2.id, reviewerUserId: RU, targetType: 'venue', venueId: RV, rating: 4 } })
    await prisma.venue.update({ where: { id: RV }, data: { avgRating: 3, totalReviews: 2 } })
    // RS1 seansını sil → rating-2 yorum SİLİNMEZ, bookingId=null olur; puan 3/2 kalır (avg değişmez)
    const vTok = jwt.sign({ venueId: RV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const del = await http(`/api/venue/classes/${RC}/sessions/${RS1}`, { method: 'DELETE', token: vTok })
    if (del.status !== 200) throw new Error(`seans silme: ${del.status} ${del.text.slice(0, 120)}`)
    const survived = await prisma.review.findUnique({ where: { id: rvw1.id }, select: { id: true, bookingId: true, venueId: true, rating: true } })
    if (!survived) throw new Error('EXPLOIT: seans silinince yorum da silindi (salon kötü yorumu temizleyebiliyor)')
    if (survived.bookingId !== null) throw new Error(`yorum booking'den ayrıştırılmadı (bookingId=${survived.bookingId})`)
    if (survived.venueId !== RV || survived.rating !== 2) throw new Error('ayrıştırılan yorumun venueId/puanı bozuldu')
    const v = await prisma.venue.findUnique({ where: { id: RV }, select: { avgRating: true, totalReviews: true } })
    if (v?.totalReviews !== 2 || v?.avgRating !== 3) throw new Error(`salon puanı değişmemeli: avg=${v?.avgRating} total=${v?.totalReviews} (3/2 bekleniyor)`)
    await prisma.review.deleteMany({ where: { venueId: RV } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: RU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { classId: RC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: RC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: RU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: RV } }).catch(() => {})
  })

  // ---- YENİ puanlama akışı: çift puan (salon+hoca), check-in kapısı, bitişten 2 saat penceresi ----
  await check('Puanlama: check-in\'li + bitişten 2sa sonra salon & hoca çift puanı + display', async () => {
    const IV = 990093, IC = 990093, ISS = 990093, IU = 990093, II = 990093
    const past3h = new Date(Date.now() - 3 * 3600000)
    // ISS2 FARKLI bir saatte: (classId, startsAt) artık DB'de tekil. Aynı dersin aynı anda iki
    // seansı zaten olamaz; fixture kolaylık olsun diye aynı saati kullanıyordu.
    const past4h = new Date(Date.now() - 4 * 3600000)
    await prisma.venue.upsert({ where: { id: IV }, update: { isApproved: true, isActive: true, avgRating: 0, totalReviews: 0 }, create: { id: IV, name: 'RateVenue', email: `rt${IV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.instructor.upsert({ where: { id: II }, update: { avgRating: 0, totalReviews: 0, isActive: true }, create: { id: II, venueId: IV, fullName: 'Rate Hoca', isActive: true } })
    await prisma.class.upsert({ where: { id: IC }, update: { instructorId: II }, create: { id: IC, venueId: IV, instructorId: II, title: 'RateDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: ISS }, update: { startsAt: past3h, endsAt: past3h }, create: { id: ISS, classId: IC, startsAt: past3h, endsAt: past3h, capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: IU }, update: {}, create: { id: IU, username: `rate_${IU}`, email: `rate_${IU}@x.com`, passwordHash: 'x', fullName: 'Rate User', tierSportCounts: {} } })
    // check-in'li booking (derse GİTMİŞ)
    const bkC = await prisma.booking.create({ data: { userId: IU, sessionId: ISS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `RT-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    const tokC = jwt.sign({ userId: IU }, JWT_SECRET, { expiresIn: '1h' })
    // Salon 5 + hoca 4, iki AYRI yorum
    const r = await http('/api/reviews', { method: 'POST', token: tokC, body: { bookingId: bkC.id, venueRating: 5, venueComment: 'salon süper', instructorRating: 4, instructorComment: 'hoca iyi', isAnonymous: false } })
    if (r.status !== 201) throw new Error(`çift puan 201 dönmedi: ${r.status} ${r.text.slice(0, 140)}`)
    const rows = await prisma.review.findMany({ where: { bookingId: bkC.id }, select: { targetType: true, rating: true, venueId: true, instructorId: true, comment: true } })
    if (rows.length !== 2) throw new Error(`2 satır (salon+hoca) bekleniyordu, ${rows.length} var`)
    const vrow = rows.find(x => x.targetType === 'venue'); const irow = rows.find(x => x.targetType === 'instructor')
    if (vrow?.rating !== 5 || vrow?.venueId !== IV) throw new Error('salon satırı hatalı')
    if (irow?.rating !== 4 || irow?.instructorId !== II) throw new Error('hoca satırı hatalı')
    // Ortalamalar iki tarafta da güncellendi mi
    const vAgg = await prisma.venue.findUnique({ where: { id: IV }, select: { avgRating: true, totalReviews: true } })
    const iAgg = await prisma.instructor.findUnique({ where: { id: II }, select: { avgRating: true, totalReviews: true } })
    if (vAgg?.avgRating !== 5 || vAgg?.totalReviews !== 1) throw new Error(`salon ort. güncellenmedi: ${vAgg?.avgRating}/${vAgg?.totalReviews}`)
    if (iAgg?.avgRating !== 4 || iAgg?.totalReviews !== 1) throw new Error(`hoca ort. güncellenmedi: ${iAgg?.avgRating}/${iAgg?.totalReviews}`)
    // Display uçları: hem salon hem hoca profilinde sayım + ortalama
    const vpub = await expectOk(`/api/reviews/venue/${IV}`)
    if (vpub.json?.totalReviews !== 1 || vpub.json?.avgRating !== 5) throw new Error(`salon display sayım/ort. yanlış: ${vpub.json?.avgRating}/${vpub.json?.totalReviews}`)
    const ipub = await expectOk(`/api/reviews/instructor/${II}`)
    if (ipub.json?.totalReviews !== 1 || ipub.json?.avgRating !== 4) throw new Error(`hoca display sayım/ort. yanlış: ${ipub.json?.avgRating}/${ipub.json?.totalReviews}`)
    // İkinci gönderim → 400 (bu ders zaten puanlandı)
    const r2 = await http('/api/reviews', { method: 'POST', token: tokC, body: { bookingId: bkC.id, venueRating: 3 } })
    if (r2.status !== 400) throw new Error(`ikinci puan reddedilmedi: ${r2.status}`)
    await prisma.review.deleteMany({ where: { OR: [{ venueId: IV }, { instructorId: II }] } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: IU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { classId: IC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: IC } }).catch(() => {})
    await prisma.instructor.deleteMany({ where: { id: II } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: IU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: IV } }).catch(() => {})
  })

  // ---- Puanlama check-in KAPISI: derse katılmayan (checkedIn=false) puan VEREMEZ (403) ----
  await check('Puanlama: check-in olmayan booking 403 (derse gitmeyen puanlayamaz)', async () => {
    const IV = 990094, IC = 990094, ISS = 990094, IU = 990094
    const past3h = new Date(Date.now() - 3 * 3600000)
    // ISS2 FARKLI bir saatte: (classId, startsAt) artık DB'de tekil. Aynı dersin aynı anda iki
    // seansı zaten olamaz; fixture kolaylık olsun diye aynı saati kullanıyordu.
    const past4h = new Date(Date.now() - 4 * 3600000)
    await prisma.venue.upsert({ where: { id: IV }, update: { isApproved: true, isActive: true }, create: { id: IV, name: 'NoCheckVenue', email: `nc${IV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: IC }, update: {}, create: { id: IC, venueId: IV, title: 'NoCheckDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: ISS }, update: { startsAt: past3h, endsAt: past3h }, create: { id: ISS, classId: IC, startsAt: past3h, endsAt: past3h, capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: IU }, update: {}, create: { id: IU, username: `nc_${IU}`, email: `nc_${IU}@x.com`, passwordHash: 'x', fullName: 'NoCheck', tierSportCounts: {} } })
    const bkN = await prisma.booking.create({ data: { userId: IU, sessionId: ISS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `NC-${Date.now()}`, checkedIn: false } })
    const tokN = jwt.sign({ userId: IU }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/reviews', { method: 'POST', token: tokN, body: { bookingId: bkN.id, venueRating: 5 } })
    if (r.status !== 403) throw new Error(`check-in'siz puan 403 dönmeli, döndü: ${r.status} ${r.text.slice(0, 120)}`)
    await prisma.booking.deleteMany({ where: { userId: IU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { classId: IC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: IC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: IU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: IV } }).catch(() => {})
  })

  // ---- Faz B: bekleyen-puan listesi (GET /pending) + hatırlatma job'ı (ratingPromptJob) ----
  await check('Puanlama: /pending bekleyen dersi verir + job hatırlatma gönderir + puanlayınca listeden düşer', async () => {
    const IV = 990095, IC = 990095, II = 990095, IU = 990095
    const ISS = 990095   // katılınan + 3sa önce bitmiş (job'a uygun: >2sa)
    const ISS2 = 990096  // katılınmayan (checkedIn=false) — pending'de OLMAMALI
    const past3h = new Date(Date.now() - 3 * 3600000)
    // ISS2 FARKLI bir saatte: (classId, startsAt) artık DB'de tekil. Aynı dersin aynı anda iki
    // seansı zaten olamaz; fixture kolaylık olsun diye aynı saati kullanıyordu.
    const past4h = new Date(Date.now() - 4 * 3600000)
    await prisma.venue.upsert({ where: { id: IV }, update: { isApproved: true, isActive: true }, create: { id: IV, name: 'PendVenue', email: `pv${IV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.instructor.upsert({ where: { id: II }, update: { isActive: true }, create: { id: II, venueId: IV, fullName: 'Pend Hoca', isActive: true } })
    await prisma.class.upsert({ where: { id: IC }, update: { instructorId: II }, create: { id: IC, venueId: IV, instructorId: II, title: 'PendDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: ISS }, update: { startsAt: past3h, endsAt: past3h }, create: { id: ISS, classId: IC, startsAt: past3h, endsAt: past3h, capacity: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: ISS2 }, update: { startsAt: past4h, endsAt: past4h }, create: { id: ISS2, classId: IC, startsAt: past4h, endsAt: past4h, capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: IU }, update: {}, create: { id: IU, username: `pend_${IU}`, email: `pend_${IU}@x.com`, passwordHash: 'x', fullName: 'Pend User', tierSportCounts: {} } })
    const bkGo = await prisma.booking.create({ data: { userId: IU, sessionId: ISS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `PG-${Date.now()}`, checkedIn: true, checkedInAt: new Date(), ratingPromptSent: false } })
    // katılınmayan booking (aynı kullanıcı, farklı seans) — pending listesine GİRMEMELİ
    await prisma.booking.create({ data: { userId: IU, sessionId: ISS2, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `PN-${Date.now()}`, checkedIn: false } })
    const tok = jwt.sign({ userId: IU }, JWT_SECRET, { expiresIn: '1h' })

    // 1) /pending yalnız katılınan+bitmiş+puansız dersi verir (hoca bilgisi dahil)
    const p1 = await expectOk('/api/reviews/pending', { token: tok })
    const list1 = p1.json?.pending || []
    if (list1.length !== 1) throw new Error(`pending 1 ders bekleniyordu, ${list1.length} geldi`)
    const item = list1[0]
    if (item.bookingId !== bkGo.id) throw new Error('pending yanlış booking')
    if (item.instructorId !== II || item.instructorName !== 'Pend Hoca') throw new Error('pending hoca bilgisi eksik')
    if (item.venueId !== IV || item.venueName !== 'PendVenue') throw new Error('pending salon bilgisi eksik')

    // 2) job: hatırlatma gönderir → ratingPromptSent=true + in-app bildirim oluşur
    await sendRatingPrompts()
    const afterJob = await prisma.booking.findUnique({ where: { id: bkGo.id }, select: { ratingPromptSent: true } })
    if (!afterJob?.ratingPromptSent) throw new Error('job ratingPromptSent işaretlemedi')
    const notif = await prisma.notification.findFirst({ where: { userId: IU, type: 'rating_prompt' } })
    if (!notif) throw new Error('job in-app puanlama bildirimi oluşturmadı')
    // idempotent: ikinci koşuda tekrar bildirim OLUŞTURMAZ (ratingPromptSent zaten true)
    await sendRatingPrompts()
    const notifCount = await prisma.notification.count({ where: { userId: IU, type: 'rating_prompt' } })
    if (notifCount !== 1) throw new Error(`job çift-gönderim yaptı: ${notifCount} bildirim`)

    // 3) puanla → /pending artık boş (salon satırı oluştu)
    const rv = await http('/api/reviews', { method: 'POST', token: tok, body: { bookingId: bkGo.id, venueRating: 4, instructorRating: 5 } })
    if (rv.status !== 201) throw new Error(`pending sonrası puan 201 dönmedi: ${rv.status} ${rv.text.slice(0, 120)}`)
    const p2 = await expectOk('/api/reviews/pending', { token: tok })
    if ((p2.json?.pending || []).length !== 0) throw new Error('puanladıktan sonra pending boşalmadı')

    await prisma.notification.deleteMany({ where: { userId: IU } }).catch(() => {})
    await prisma.review.deleteMany({ where: { OR: [{ venueId: IV }, { instructorId: II }] } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: IU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { classId: IC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: IC } }).catch(() => {})
    await prisma.instructor.deleteMany({ where: { id: II } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: IU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: IV } }).catch(() => {})
  })

  // ---- Faz C: EĞİTMEN AUTH — davet→şifre→giriş→me(finans yok)→yanıt + realm izolasyonu ----
  await check('Eğitmen auth: davet→şifre→giriş→me(finans yok)→yanıt; salon/eğitmen token izolasyonu', async () => {
    const IV = 990097, II = 990097, II2 = 990098, IU = 990097, IV2 = 990099
    await prisma.venue.upsert({ where: { id: IV }, update: { isApproved: true, isActive: true }, create: { id: IV, name: 'AuthVenue', email: `av${IV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.venue.upsert({ where: { id: IV2 }, update: { isApproved: true, isActive: true }, create: { id: IV2, name: 'OtherVenue', email: `ov${IV2}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.instructor.upsert({ where: { id: II }, update: { email: null, passwordHash: null, inviteStatus: 'none', isActive: true, venueId: IV }, create: { id: II, venueId: IV, fullName: 'Auth Hoca', isActive: true } })
    await prisma.instructor.upsert({ where: { id: II2 }, update: { venueId: IV }, create: { id: II2, venueId: IV, fullName: 'Diğer Hoca', isActive: true } })
    await prisma.user.upsert({ where: { id: IU }, update: {}, create: { id: IU, username: `arev_${IU}`, email: `arev_${IU}@x.com`, passwordHash: 'x', fullName: 'A Rev', tierSportCounts: {} } })
    const rvwMine = await prisma.review.create({ data: { reviewerUserId: IU, targetType: 'instructor', instructorId: II, rating: 5, comment: 'harika hoca', isAnonymous: true } })
    const rvwOther = await prisma.review.create({ data: { reviewerUserId: IU, targetType: 'instructor', instructorId: II2, rating: 3, isAnonymous: true } })
    const vTok = jwt.sign({ venueId: IV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const vTok2 = jwt.sign({ venueId: IV2, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })

    // 0) Yanlış salon davet edemez → 403
    const wrongInv = await http(`/api/venue/instructors/${II}/invite`, { method: 'POST', token: vTok2, body: { email: 'x@x.com' } })
    if (wrongInv.status !== 403) throw new Error(`başka salon eğitmeni davet edebildi: ${wrongInv.status}`)

    // 1) Salon eğitmeni davet eder. GÜVENLİK: token yanıtta DÖNMEZ (sadece e-posta) → DB'den okunur.
    const inv = await http(`/api/venue/instructors/${II}/invite`, { method: 'POST', token: vTok, body: { email: 'authhoca@x.com' } })
    if (inv.status !== 200) throw new Error(`davet başarısız: ${inv.status} ${inv.text.slice(0, 120)}`)
    if (inv.json?.inviteUrl || inv.json?.token) throw new Error('davet token yanıtta SIZDI (yalnız e-postayla gitmeli)')
    const rtRow = await prisma.instructorPasswordResetToken.findFirst({ where: { instructorId: II, used: false }, orderBy: { id: 'desc' } })
    const token = rtRow?.token
    if (!token) throw new Error('davet token üretilmedi')

    // 2) Şifre belirle: kısa şifre → 400; geçerli → 200; token tek-kullanım (ikinci → 400)
    if ((await http('/api/instructor/set-password', { method: 'POST', body: { token, password: '123' } })).status !== 400) throw new Error('kısa şifre reddedilmedi')
    if ((await http('/api/instructor/set-password', { method: 'POST', body: { token, password: 'HocaPass123' } })).status !== 200) throw new Error('şifre belirlenemedi')
    if ((await http('/api/instructor/set-password', { method: 'POST', body: { token, password: 'HocaPass123' } })).status !== 400) throw new Error('davet token tekrar kullanılabildi (tek-kullanım değil)')

    // 3) Giriş: yanlış şifre → 401; doğru (email case-insensitive) → token
    if ((await http('/api/instructor/login', { method: 'POST', body: { email: 'authhoca@x.com', password: 'yanlis' } })).status !== 401) throw new Error('yanlış şifre 401 dönmedi')
    const l = await http('/api/instructor/login', { method: 'POST', body: { email: 'AuthHoca@x.com', password: 'HocaPass123' } })
    if (l.status !== 200 || !l.json?.token) throw new Error(`giriş başarısız: ${l.status}`)
    const iTok = l.json.token

    // 4) /me — FİNANS ve hassas alan SIZMAZ
    const me = await http('/api/instructor/me', { token: iTok })
    if (me.status !== 200) throw new Error(`/me başarısız: ${me.status}`)
    for (const leak of ['iban', 'taxNumber', 'identityNumber', 'passwordHash', 'totalRevenue', 'finalAmount', 'venuePayout', 'checkInCode']) {
      if (JSON.stringify(me.json).toLowerCase().includes(leak.toLowerCase())) throw new Error(`/me finans/hassas alan sızdırdı: ${leak}`)
    }

    // 5) REALM İZOLASYONU: eğitmen token'ı salon ucunda 401; salon token'ı eğitmen ucunda 401
    const vLeak = await http('/api/venue/me', { token: iTok })
    if (vLeak.status !== 401) throw new Error(`eğitmen token'ı SALON ucuna girdi: ${vLeak.status}`)
    const iLeak = await http('/api/instructor/me', { token: vTok })
    if (iLeak.status !== 401) throw new Error(`salon token'ı EĞİTMEN ucuna girdi: ${iLeak.status}`)
    // 5b) KRİTİK: eğitmen/salon token'ı (userId'siz) KULLANICI ucuna girmesin — aksi halde
    // where:{userId:undefined} tüm kullanıcıların rezervasyonunu döndürürdü (cross-user sızıntı)
    const uLeak1 = await http('/api/bookings/my', { token: iTok })
    if (uLeak1.status !== 401) throw new Error(`eğitmen token'ı KULLANICI ucuna girdi (cross-user sızıntı!): ${uLeak1.status}`)
    const uLeak2 = await http('/api/bookings/my', { token: vTok })
    if (uLeak2.status !== 401) throw new Error(`salon token'ı KULLANICI ucuna girdi (cross-user sızıntı!): ${uLeak2.status}`)

    // 6) Kendi yorumları — anonim yorumda kimlik gizli
    const rv = await http('/api/instructor/reviews', { token: iTok })
    const list = rv.json?.reviews || []
    const mine = list.find((r: any) => r.id === rvwMine.id)
    if (!mine) throw new Error('kendi yorumu listede yok')
    if (mine.reviewer !== null || 'reviewerUserId' in mine) throw new Error('anonim yorumda kimlik sızıyor (eğitmen kimin verdiğini görmemeli)')

    // 7) Kendi yorumuna public yanıt
    const rep = await http(`/api/instructor/reviews/${rvwMine.id}/reply`, { method: 'PUT', token: iTok, body: { reply: 'teşekkürler!', visibility: 'public' } })
    if (rep.status !== 200) throw new Error(`yanıt başarısız: ${rep.status}`)
    // GÜVENLİK: yanıt yanıtındaki review anonim → reviewerUserId/bookingId SIZMAMALI (deanonimizasyon)
    const repReview = rep.json?.review || {}
    if ('reviewerUserId' in repReview || repReview.reviewer != null) throw new Error('yanıt yanıtında anonim kimlik sızdı')
    const afterRep = await prisma.review.findUnique({ where: { id: rvwMine.id }, select: { venueReply: true, replyVisibility: true } })
    if (afterRep?.venueReply !== 'teşekkürler!' || afterRep.replyVisibility !== 'public') throw new Error('yanıt kaydedilmedi')

    // 8) SAHİPLİK: başka hocanın yorumuna yanıt → 403
    const repOther = await http(`/api/instructor/reviews/${rvwOther.id}/reply`, { method: 'PUT', token: iTok, body: { reply: 'olmaz' } })
    if (repOther.status !== 403) throw new Error(`başka hocanın yorumuna yanıt yazılabildi: ${repOther.status}`)

    // 9) Yanıtı sil
    if ((await http(`/api/instructor/reviews/${rvwMine.id}/reply`, { method: 'DELETE', token: iTok })).status !== 200) throw new Error('yanıt silinemedi')

    await prisma.instructorPasswordResetToken.deleteMany({ where: { instructorId: { in: [II, II2] } } }).catch(() => {})
    await prisma.review.deleteMany({ where: { instructorId: { in: [II, II2] } } }).catch(() => {})
    await prisma.instructor.deleteMany({ where: { id: { in: [II, II2] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: IU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: { in: [IV, IV2] } } }).catch(() => {})
  })

  // ---- Eğitmen portalı: profil düzenle + kendi dersi + seans + check-in + sahiplik + onay kapısı ----
  await check('Eğitmen portalı: profil-düzenle + ders/seans ekle + check-in (sahiplik + finans yok + onay)', async () => {
    const IV = 990100, II = 990100, IU = 990100
    await prisma.venue.upsert({ where: { id: IV }, update: { isApproved: true, isActive: true }, create: { id: IV, name: 'PortalVenue', email: `pv${IV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.instructor.upsert({ where: { id: II }, update: { isActive: true, venueId: IV }, create: { id: II, venueId: IV, fullName: 'Portal Hoca', isActive: true } })
    await prisma.user.upsert({ where: { id: IU }, update: {}, create: { id: IU, username: `portal_${IU}`, email: `portal_${IU}@x.com`, passwordHash: 'x', fullName: 'Portal User', tierSportCounts: {} } })
    const iTok = jwt.sign({ instructorId: II, email: 'portal@x.com', role: 'instructor' }, JWT_SECRET, { expiresIn: '1h' })

    // 1) PUT /me — profil düzenle (fullName/bio/specialty/avatar) + finans SIZMAZ
    const upd = await http('/api/instructor/me', { method: 'PUT', token: iTok, body: { fullName: 'Yeni Hoca Adı', bio: 'Yeni bio', specialty: 'Yoga · Pilates', avatarUrl: 'https://img/x.jpg' } })
    if (upd.status !== 200) throw new Error(`profil düzenleme başarısız: ${upd.status} ${upd.text.slice(0, 120)}`)
    if (upd.json?.instructor?.fullName !== 'Yeni Hoca Adı' || upd.json?.instructor?.bio !== 'Yeni bio' || upd.json?.instructor?.avatarUrl !== 'https://img/x.jpg') throw new Error('profil alanları güncellenmedi')
    if (/venuePayout|finalAmount|passwordHash|iban/i.test(JSON.stringify(upd.json))) throw new Error('profil yanıtı finans/hassas alan sızdırdı')

    // 2) POST /classes — kendi salonuna, kendi üzerine ders (venueId DB'den, instructorId zorla)
    const cr = await http('/api/instructor/classes', { method: 'POST', token: iTok, body: { title: 'Sabah Yogası', category: catName, basePrice: 150, duration: 60, capacity: 12 } })
    if (cr.status !== 201) throw new Error(`ders ekleme başarısız: ${cr.status} ${cr.text.slice(0, 120)}`)
    const classId = cr.json?.class?.id
    // DOĞRULUK: negatif/NaN fiyat-süre-kapasite reddedilmeli (negatif süre endsAt'i bozup puanlama penceresini kaydırırdı)
    if ((await http('/api/instructor/classes', { method: 'POST', token: iTok, body: { title: 'Neg', category: catName, basePrice: -100, duration: -30, capacity: -5 } })).status !== 400) throw new Error('negatif fiyat/süre ders reddedilmedi')
    if ((await http('/api/instructor/classes', { method: 'POST', token: iTok, body: { title: 'NaN', category: catName, basePrice: 'abc', duration: 60, capacity: 10 } })).status !== 400) throw new Error('sayısal olmayan fiyat reddedilmedi')
    if (cr.json?.class?.instructorId !== II || cr.json?.class?.venueId !== IV) throw new Error('ders sahiplik/venue hatalı (instructorId/venueId)')

    // 3) POST /classes/:id/sessions — kendi dersine seans
    const d = new Date(Date.now() + 2 * 86400000)
    const date = d.toISOString().slice(0, 10)
    const se = await http(`/api/instructor/classes/${classId}/sessions`, { method: 'POST', token: iTok, body: { date, time: '10:00', capacity: 12 } })
    if (se.status !== 201) throw new Error(`seans ekleme başarısız: ${se.status} ${se.text.slice(0, 120)}`)
    const sessionId = se.json?.session?.id

    // 4) GET /classes — yalnız kendi dersi listede
    const gc = await http('/api/instructor/classes', { token: iTok })
    if (!(gc.json?.classes || []).some((c: any) => c.id === classId)) throw new Error('kendi dersi /classes listesinde yok')

    // 5) CHECK-IN — kendi dersinin öğrencisini QR koduyla onayla (ders SAATİNDE — #5 penceresi) + finans yok + idempotent
    const nowSess = await prisma.class_Session.create({ data: { classId, startsAt: new Date(Date.now() - 20 * 60000), endsAt: new Date(Date.now() + 40 * 60000), capacity: 12, status: 'open' } })
    const code = `PRT${Date.now() % 100000}`
    await prisma.booking.create({ data: { userId: IU, sessionId: nowSess.id, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `PRTB-${Date.now()}`, checkInCode: code, checkedIn: false } })
    const ci = await http('/api/instructor/checkin', { method: 'POST', token: iTok, body: { code } })
    if (ci.status !== 200 || !ci.json?.success) throw new Error(`check-in başarısız: ${ci.status} ${ci.text.slice(0, 120)}`)
    if (/venuePayout|finalAmount|baseAmount|commission/i.test(JSON.stringify(ci.json))) throw new Error('check-in yanıtı finans sızdırdı')
    const ci2 = await http('/api/instructor/checkin', { method: 'POST', token: iTok, body: { code } })
    if (!ci2.json?.alreadyCheckedIn) throw new Error('ikinci check-in alreadyCheckedIn dönmedi')
    // #5: GELECEKTEKİ seans (sessionId = +2 gün) check-in REDDEDİLİR (streak şişirme engeli)
    const futCode = `FUT${Date.now() % 100000}`
    await prisma.booking.create({ data: { userId: IU, sessionId, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `FUTB-${Date.now()}`, checkInCode: futCode, checkedIn: false } })
    const ciFut = await http('/api/instructor/checkin', { method: 'POST', token: iTok, body: { code: futCode } })
    if (ciFut.status !== 400) throw new Error(`gelecekteki seans check-in reddedilmedi (#5): ${ciFut.status}`)

    // 6) SAHİPLİK — başka hocanın (instructorId=null) dersindeki öğrenciyi check-in → 403
    const otherClass = await prisma.class.create({ data: { venueId: IV, title: 'Başka Ders', category: catName, basePrice: 100, durationMinutes: 60, capacity: 10, isActive: true, instructorId: null } })
    const past = new Date(Date.now() - 86400000)
    const otherSess = await prisma.class_Session.create({ data: { classId: otherClass.id, startsAt: past, endsAt: past, capacity: 10, status: 'open' } })
    const code2 = `OTH${Date.now() % 100000}`
    await prisma.booking.create({ data: { userId: IU, sessionId: otherSess.id, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `OTHB-${Date.now()}`, checkInCode: code2, checkedIn: false } })
    const ciOther = await http('/api/instructor/checkin', { method: 'POST', token: iTok, body: { code: code2 } })
    // Sahip-olunmayan kod, BULUNAMAYAN kodla AYNI 404 döner (existence-oracle kapatıldı — denetim turu 7 #8)
    if (ciOther.status !== 404) throw new Error(`başka hocanın öğrencisini check-in yapabildi: ${ciOther.status}`)

    // 7) ONAY KAPISI — salon onaysızsa eğitmen ders ekleyemez (403)
    await prisma.venue.update({ where: { id: IV }, data: { isApproved: false } })
    const crBlocked = await http('/api/instructor/classes', { method: 'POST', token: iTok, body: { title: 'Olmaz', category: catName, basePrice: 100, duration: 60, capacity: 10 } })
    if (crBlocked.status !== 403) throw new Error(`onaysız salonda ders eklenebildi: ${crBlocked.status}`)

    await prisma.booking.deleteMany({ where: { userId: IU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { class: { venueId: IV } } }).catch(() => {})
    await prisma.class.deleteMany({ where: { venueId: IV } }).catch(() => {})
    await prisma.instructor.deleteMany({ where: { id: II } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: IU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: IV } }).catch(() => {})
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
    // GÜVENLİK (undefined-filter): token'SIZ reset → 400 olmalı; aksi halde where:{token:undefined}
    // filtreyi yok sayıp kurbanın token'ını bulur ve şifresini ezerdi (hesap ele geçirme).
    if ((await http('/api/auth/reset-password', { method: 'POST', body: { password: 'Hacked12345' } })).status !== 400) throw new Error("token'sız reset-password 400 dönmedi (undefined-filter hesap ele geçirme açığı!)")
    if ((await http('/api/auth/login', { method: 'POST', body: { email, password: 'Hacked12345' } })).status === 200) throw new Error("token'sız reset kurbanın şifresini değiştirdi (hesap ele geçirme!)")
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
    // GÜVENLİK (undefined-filter): token'sız verify-email → 400 (başkasının e-postasını doğrulayamaz)
    if ((await http('/api/auth/verify-email', { method: 'POST', body: {} })).status !== 400) throw new Error("token'sız verify-email 400 dönmedi (undefined-filter)")
    // GÜVENLİK (venueAuth): venueId TAŞIMAYAN venue token'ı reddedilmeli (aksi halde where:{venueId:undefined}
    // ile tüm salonların rezervasyon/gelir/kupon/hoca verisi dökülürdü)
    const noVenueIdTok = jwt.sign({ role: 'venue', email: 'x@x.com' }, JWT_SECRET, { expiresIn: '1h' })
    if ((await http('/api/venue/me', { token: noVenueIdTok })).status !== 401) throw new Error("venueId'siz venue token'ı 401 dönmedi (undefined-filter salon sızıntısı!)")
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
      await prisma.class_Session.upsert({ where: { id }, update: { status: 'open', startsAt: st }, create: { id, classId: PC, startsAt: st, endsAt: new Date(st.getTime() + 3600000), capacity: 20, status: 'open' } })
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
    const mkSess = async (id: number, k: number) => prisma.class_Session.upsert({ where: { id }, update: { startsAt: noon(k), endsAt: new Date(noon(k).getTime() + 3600000), status: 'open', capacity: 20 }, create: { id, classId: C, startsAt: noon(k), endsAt: new Date(noon(k).getTime() + 3600000), status: 'open', capacity: 20 } })
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

  // ---- Sezonluk liderlik: geçen sezonun dersi bu sezon tablosunda sayılmaz ----
  await check('Sezonluk liderlik: geçen sezon dersi sayılmaz + yanıtta sezon bilgisi var', async () => {
    const season = seasonInfo()
    const N = 990211, X = 990211
    await prisma.neighborhood.upsert({ where: { id: N }, update: {}, create: { id: N, name: 'SezonMah', latitude: 41, longitude: 29, cityId: 1 } })
    await prisma.user.upsert({ where: { id: X }, update: { neighborhoodId: N, activityPrivacy: 'public', banned: false }, create: { id: X, username: `szn_${X}`, email: `szn_${X}@x.com`, passwordHash: 'x', fullName: 'Sezon User', tierSportCounts: {}, neighborhoodId: N, activityPrivacy: 'public' } })
    const inSeason = new Date(season.start.getTime() + 5 * 86400000)   // sezon içi
    const preSeason = new Date(season.start.getTime() - 10 * 86400000) // geçen sezon
    await prisma.class_Session.upsert({ where: { id: 990211 }, update: { startsAt: inSeason }, create: { id: 990211, classId: C, startsAt: inSeason, endsAt: new Date(inSeason.getTime() + 3600000), status: 'open', capacity: 20 } })
    await prisma.class_Session.upsert({ where: { id: 990212 }, update: { startsAt: preSeason }, create: { id: 990212, classId: C, startsAt: preSeason, endsAt: new Date(preSeason.getTime() + 3600000), status: 'open', capacity: 20 } })
    await prisma.booking.deleteMany({ where: { userId: X } })
    const mk = (id: number, sid: number) => prisma.booking.create({ data: { id, userId: X, sessionId: sid, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `SZN-${id}-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    await mk(990211, 990211) // sezon içi → sayılmalı
    await mk(990212, 990212) // geçen sezon → sayılmamalı
    const r = await http(`/api/social/leaderboard/users?neighborhoodId=${N}`)
    const me = (r.json?.leaderboard || []).find((u: any) => u.id === X)
    if (!me) throw new Error('X sezon liderliğinde yok (sezon içi 1 ders olmalıydı)')
    if (me.lessonCount !== 1) throw new Error(`lessonCount ${me.lessonCount} (1 bekleniyor — geçen sezon dersi sayılmamalı)`)
    if (!r.json?.season?.label) throw new Error('yanıtta season.label yok')
    await prisma.booking.deleteMany({ where: { userId: X } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: { in: [990211, 990212] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: X } }).catch(() => {})
    await prisma.neighborhood.deleteMany({ where: { id: N } }).catch(() => {})
  })

  // YENİ GİZLİLİK MODELİ: aktivite-gizli kullanıcı da LİDERLİKTE görünür (Instagram sıralama mantığı — yalnız banlı hariç)
  await check('Liderlik: aktivite-gizli kullanıcı da sıralamada görünür (yeni model)', async () => {
    const N = 990350, PU = 990350, SS = 990350
    const scat = await prisma.sportCategory.findFirst({ select: { id: true } })
    await prisma.neighborhood.upsert({ where: { id: N }, update: {}, create: { id: N, name: 'LbGizliMah', latitude: 41, longitude: 29, cityId: 1 } })
    await prisma.class.upsert({ where: { id: N }, update: { sportCategoryId: scat?.id ?? null }, create: { id: N, venueId: V, title: 'LbGizliDers', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const past = new Date(Date.now() - 86400000) // güncel sezon içi + geçmiş → liderlik sayar
    await prisma.class_Session.upsert({ where: { id: SS }, update: { startsAt: past, classId: N }, create: { id: SS, classId: N, startsAt: past, endsAt: new Date(past.getTime() + 3600000), status: 'open', capacity: 20 } })
    await prisma.user.upsert({ where: { id: PU }, update: { neighborhoodId: N, activityPrivacy: 'private', banned: false }, create: { id: PU, username: `lbgiz_${PU}`, email: `lbgiz_${PU}@x.com`, passwordHash: 'x', fullName: 'LbGizli', tierId: 1, tierSportCounts: {}, neighborhoodId: N, activityPrivacy: 'private' } })
    await prisma.booking.deleteMany({ where: { userId: PU } })
    await prisma.booking.create({ data: { userId: PU, sessionId: SS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `LBG-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    const r = await http(`/api/social/leaderboard/users?neighborhoodId=${N}`)
    const me = (r.json?.leaderboard || []).find((u: any) => u.id === PU)
    if (!me) throw new Error('aktivite-gizli kullanıcı liderlikte GÖRÜNMÜYOR (yeni model: sıralama herkese açık)')
    if (me.username !== `lbgiz_${PU}`) throw new Error('liderlikte username dönmedi')
    // DAYANIKLILIK: geçersiz ?branch=<rastgele> YOK SAYILIR (gerçek kategori değil) → aynı sonuç.
    // Aksi halde her rastgele branch cache-bust edip tüm-tablo taraması tetikliyordu (DoS).
    const rGarbage = await http(`/api/social/leaderboard/users?neighborhoodId=${N}&branch=YOKBOYLE_BRANCH_XYZ`)
    if (!(rGarbage.json?.leaderboard || []).some((u: any) => u.id === PU)) throw new Error('geçersiz branch sıralamayı bozdu — normalize edilmeli (cache-bust DoS)')
    await prisma.booking.deleteMany({ where: { userId: PU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: SS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: N } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: PU } }).catch(() => {})
    await prisma.neighborhood.deleteMany({ where: { id: N } }).catch(() => {})
  })

  // ---- Bekleme listesi (waitlist) UÇTAN UCA ----
  await check('Waitlist: dolu seans → sıra → iptalde bildirim → rezervasyonda listeden çık', async () => {
    const WS = 990041, UA = 990041, UB = 990042, UC = 990043
    await prisma.class_Session.upsert({ where: { id: WS }, update: { capacity: 1, status: 'open' }, create: { id: WS, classId: C, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 1, status: 'open' } })
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
    await prisma.class_Session.upsert({ where: { id: S2 }, update: { status: 'open', capacity: 20 }, create: { id: S2, classId: C2, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), capacity: 20, status: 'open' } })
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
    await prisma.class_Session.upsert({ where: { id: 990161 }, update: { startsAt: new Date(Date.now() + 5 * 86400000), status: 'open' }, create: { id: 990161, classId: 990161, startsAt: new Date(Date.now() + 5 * 86400000), endsAt: new Date(Date.now() + 5 * 86400000 + 3600000), capacity: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: 990162 }, update: { startsAt: new Date(Date.now() + 1 * 86400000), status: 'open' }, create: { id: 990162, classId: 990162, startsAt: new Date(Date.now() + 1 * 86400000), endsAt: new Date(Date.now() + 1 * 86400000 + 3600000), capacity: 20, status: 'open' } })
    const r = await http(`/api/public/sessions?search=NEARBYTEST&sort=nearby&userNeighborhoodId=990161&limit=1`)
    if (r.status !== 200) throw new Error(`beklenen 200, gelen ${r.status}`)
    const first = r.json?.sessions?.[0]
    if (!first) throw new Error('sonuç boş')
    if (first.id !== 990161) throw new Error(`1. sonuç seans ${first.id} (990161=yakın bekleniyor; eski kod uzak/erken döndürürdü)`)
  })

  await check('For You: aynı ders çoklu seansla domine etmez (distinct classId)', async () => {
    // U catName'i tercih ediyor; C dersi (title "Smoke Class") catName kategorisinde + seed seansı var.
    // İkinci bir gelecek seans ekle → distinct olmasa 2 kez dönerdi.
    await prisma.class_Session.upsert({ where: { id: 990171 }, update: { startsAt: new Date(Date.now() + 3 * 86400000), status: 'open' }, create: { id: 990171, classId: C, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), capacity: 20, status: 'open' } })
    const r = await http('/api/public/for-you', { token })
    if (r.status !== 200) throw new Error(`beklenen 200, gelen ${r.status}`)
    const ss = r.json?.sessions || []
    const cnt = ss.filter((x: any) => x.title === 'Smoke Class' && x.venueId === V).length
    if (cnt > 1) throw new Error(`aynı ders ${cnt} kez döndü (distinct ile 1 bekleniyor)`)
    await prisma.class_Session.deleteMany({ where: { id: 990171 } })
  })

  // NOT (Tur20): Bu test eskiden "bakiye de farkla eşitlenir" diye bitiyordu. O beklenti, puanın
  // REZERVASYONDA kredilendiği eski modelden kalmaydı. Bugün puan yalnız CHECK-IN'de kredileniyor
  // (createBooking'in kendi yorumu bunu söylüyor; cancelBooking da yalnız checkedIn ise geri alıyor)
  // ve transfer zaten yalnız checkedIn=false rezervasyonda mümkün → transfer edilebilir bir
  // rezervasyonun puanı bakiyede HİÇ olamaz. Testin kurduğu "bakiye 2 + pointsEarned 2 + checkedIn
  // false" durumu artık ULAŞILAMAZ bir durumdu; beklenti bakiyenin DEĞİŞMEMESİ olarak düzeltildi.
  await check('Transfer: ucuz derse geçişte pointsEarned tazelenir, BAKİYE değişmez', async () => {
    const TV = 990141, TU = 990141
    const scat = await prisma.sportCategory.findFirst({})
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true }, create: { id: TV, name: 'Transfer Salon', email: `trf${TV}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TV }, update: {}, create: { id: TV, venueId: TV, title: 'Pahalı', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 200, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class.upsert({ where: { id: TV + 1 }, update: {}, create: { id: TV + 1, venueId: TV, title: 'Ucuz', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const se = await prisma.class_Session.upsert({ where: { id: TV }, update: { startsAt: new Date(Date.now() + 2 * 86400000) }, create: { id: TV, classId: TV, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 20, status: 'open' } })
    const sc = await prisma.class_Session.upsert({ where: { id: TV + 1 }, update: { startsAt: new Date(Date.now() + 2 * 86400000) }, create: { id: TV + 1, classId: TV + 1, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 20, status: 'open' } })
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
    if (up?.rewardPoints !== 2) throw new Error(`rewardPoints ${up?.rewardPoints} (2 bekleniyor — transfer kredilenmemiş puana DOKUNMAMALI)`)
  })

  await check('Kupon: kişi başı limit ikinci kullanımı engeller (400)', async () => {
    const cScat = await prisma.sportCategory.findFirst({})
    await prisma.class.upsert({ where: { id: 990151 }, update: {}, create: { id: 990151, venueId: V, title: 'KuponDers', category: catName, sportCategoryId: cScat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: 990151 }, update: { startsAt: new Date(Date.now() + 2 * 86400000), status: 'open' }, create: { id: 990151, classId: 990151, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: 990152 }, update: { startsAt: new Date(Date.now() + 2 * 86400000), status: 'open' }, create: { id: 990152, classId: 990151, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 20, status: 'open' } })
    await prisma.booking.deleteMany({ where: { session: { classId: 990151 } } })
    await prisma.coupon.deleteMany({ where: { code: 'PERUSER1' } })
    await prisma.coupon.create({ data: { venueId: V, code: 'PERUSER1', discountType: 'fixed', discountValue: 100, perUserLimit: 1, isActive: true } })
    const b1 = await http('/api/bookings', { method: 'POST', token, body: { sessionId: 990151, couponCode: 'PERUSER1' } })
    if (b1.status !== 201) throw new Error(`1. kullanım başarısız: ${b1.status} ${b1.text.slice(0, 120)}`)
    const b2 = await http('/api/bookings', { method: 'POST', token, body: { sessionId: 990152, couponCode: 'PERUSER1' } })
    if (b2.status !== 400) throw new Error(`2. kullanım engellenmeli (400), gelen: ${b2.status} ${b2.text.slice(0, 120)}`)
  })

  await check('Salon istatistik: doluluk groupSize (koltuk) sayar, kayıt değil', async () => {
    const SV = 990181, SU = 990181
    const sScat = await prisma.sportCategory.findFirst({})
    await prisma.venue.upsert({ where: { id: SV }, update: { isApproved: true, isActive: true }, create: { id: SV, name: 'Stat Salon', email: `stat${SV}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: SV }, update: {}, create: { id: SV, venueId: SV, title: 'StatDers', category: catName, sportCategoryId: sScat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 10, isActive: true } })
    // 2 gün sonra → 'upcoming' (7 gün) penceresine düşer; capacity: 10
    await prisma.class_Session.upsert({ where: { id: SV }, update: { startsAt: new Date(Date.now() + 2 * 86400000) }, create: { id: SV, classId: SV, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 2 * 86400000 + 3600000), capacity: 10, status: 'open' } })
    await prisma.user.upsert({ where: { id: SU }, update: {}, create: { id: SU, username: `stat_${SU}`, email: `stat_${SU}@x.com`, passwordHash: 'x', fullName: 'Stat User', tierId: 1, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { sessionId: SV } })
    // TEK rezervasyon kaydı ama groupSize: 3 → 3 koltuk dolu olmalı
    await prisma.booking.create({ data: { userId: SU, sessionId: SV, status: 'confirmed', bookingType: 'class', groupSize: 3, baseAmount: 300, commissionAmount: 0, venueCommission: 0, finalAmount: 300, venuePayout: 300, pointsEarned: 0, checkedIn: false, bookingNumber: `STAT-${Date.now()}` } })
    const vtok = jwt.sign({ venueId: SV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/venue/stats', { token: vtok })
    if (r.status !== 200) throw new Error(`stats başarısız: ${r.status} ${r.text.slice(0, 120)}`)
    const up = (r.json?.upcoming || []).find((x: any) => x.title === 'StatDers')
    if (!up) throw new Error('StatDers upcoming listesinde yok')
    if (up.booked !== 3) throw new Error(`booked ${up.booked} (3 bekleniyor — groupSize, kayıt sayısı değil)`)
    if (up.fillRate !== 30) throw new Error(`fillRate ${up.fillRate} (30 bekleniyor: 3/10 koltuk)`)
  })

  await check('Güvenlik: public profil bookings checkInCode/finansal alan SIZDIRMAZ', async () => {
    const PU = 990281
    await prisma.user.upsert({ where: { id: PU }, update: { activityPrivacy: 'public', profilePrivacy: 'public' }, create: { id: PU, username: `pub_${PU}`, email: `pub_${PU}@x.com`, passwordHash: 'x', fullName: 'Pub User', tierId: 1, tierSportCounts: {}, activityPrivacy: 'public' } })
    await prisma.booking.deleteMany({ where: { userId: PU } })
    await prisma.booking.create({ data: { id: 990281, userId: PU, sessionId: S, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `PUB-${Date.now()}`, checkInCode: `SEC${Date.now() % 100000}`, checkedIn: false } })
    const r = await http(`/api/public/users/pub_${PU}`)
    const b = (r.json?.bookings || [])[0]
    if (!b) throw new Error('booking dönmedi')
    for (const leak of ['checkInCode', 'finalAmount', 'venuePayout', 'commissionAmount', 'bookingNumber']) {
      if (leak in b) throw new Error(`hassas alan sızdı: ${leak}`)
    }
    await prisma.booking.deleteMany({ where: { userId: PU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: PU } }).catch(() => {})
  })

  await check('Güvenlik: createBooking geçmiş seansa izin vermez (400)', async () => {
    const BU = 990283
    await prisma.user.upsert({ where: { id: BU }, update: {}, create: { id: BU, username: `bkp_${BU}`, email: `bkp_${BU}@x.com`, passwordHash: 'x', fullName: 'Bk', tierId: 1, tierSportCounts: {} } })
    const past = new Date(Date.now() - 3 * 86400000)
    await prisma.class_Session.upsert({ where: { id: 990283 }, update: { startsAt: past, status: 'open' }, create: { id: 990283, classId: C, startsAt: past, endsAt: new Date(past.getTime() + 3600000), status: 'open', capacity: 20 } })
    const tok = jwt.sign({ userId: BU, email: `bkp_${BU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/bookings', { method: 'POST', token: tok, body: { sessionId: 990283 } })
    if (r.status !== 400) throw new Error(`geçmiş seans rezervasyonu ${r.status} (400 bekleniyor): ${r.text.slice(0, 100)}`)
    await prisma.booking.deleteMany({ where: { userId: BU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: 990283 } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: BU } }).catch(() => {})
  })

  await check('Güvenlik: createCoupon negatif fixed indirim reddeder (400)', async () => {
    const vtok = jwt.sign({ venueId: V, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/venue/coupons', { method: 'POST', token: vtok, body: { code: `NEG${Date.now()}`, discountType: 'fixed', discountValue: -100 } })
    if (r.status !== 400) throw new Error(`negatif fixed kupon ${r.status} (400 bekleniyor)`)
  })

  // #ECON-A: transfer YÜZDE kuponu mutlak indirime DONMAZ — yeni baza göre yeniden hesaplanır (salon eksik ödenmez)
  await check('Ekonomik: transfer yüzde-kuponu yeni baza göre hesaplar (#A)', async () => {
    const EV = 990340, CA = 990340, CB = 990341, SA = 990340, SB = 990341, EU = 990340
    await prisma.venue.upsert({ where: { id: EV }, update: { isApproved: true, isActive: true }, create: { id: EV, name: 'EconV', email: `ev${EV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: CA }, update: { basePrice: 200, isActive: true, venueId: EV }, create: { id: CA, venueId: EV, title: 'Pahalı', category: catName, basePrice: 200, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class.upsert({ where: { id: CB }, update: { basePrice: 100, isActive: true, venueId: EV }, create: { id: CB, venueId: EV, title: 'Ucuz', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const fut = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: SA }, update: { classId: CA, startsAt: fut, status: 'open', capacity: 20 }, create: { id: SA, classId: CA, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: SB }, update: { classId: CB, startsAt: fut, status: 'open', capacity: 20 }, create: { id: SB, classId: CB, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: EU }, update: {}, create: { id: EU, username: `econ_${EU}`, email: `econ_${EU}@x.com`, passwordHash: 'x', fullName: 'Econ', tierId: 1, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: EU } })
    await prisma.coupon.deleteMany({ where: { code: 'HALF50TEST' } })
    await prisma.coupon.create({ data: { venueId: EV, code: 'HALF50TEST', discountType: 'percent', discountValue: 50, isActive: true } })
    const euTok = jwt.sign({ userId: EU, email: `econ_${EU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const bk = await http('/api/bookings', { method: 'POST', token: euTok, body: { sessionId: SA, couponCode: 'HALF50TEST' } })
    if (bk.status !== 201) throw new Error(`booking: ${bk.status} ${bk.text.slice(0, 120)}`)
    const bid = bk.json?.booking?.id
    const b0 = await prisma.booking.findUnique({ where: { id: bid }, select: { finalAmount: true, venuePayout: true } })
    if (b0?.finalAmount !== 100 || b0?.venuePayout !== 100) throw new Error(`kurulum final/payout 100 bekleniyor (${b0?.finalAmount}/${b0?.venuePayout})`)
    const tr = await http(`/api/bookings/${bid}/transfer`, { method: 'PUT', token: euTok, body: { targetSessionId: SB } })
    if (tr.status !== 200) throw new Error(`transfer: ${tr.status} ${tr.text.slice(0, 120)}`)
    const b1 = await prisma.booking.findUnique({ where: { id: bid }, select: { finalAmount: true, venuePayout: true } })
    if (b1?.venuePayout !== 50 || b1?.finalAmount !== 50) throw new Error(`transfer sonrası final/payout 50 olmalı (%50 yeni baz 100), geldi ${b1?.finalAmount}/${b1?.venuePayout} — eski bug 0/0`)
    await prisma.booking.deleteMany({ where: { userId: EU } }).catch(() => {})
    await prisma.rewardPoint.deleteMany({ where: { userId: EU } }).catch(() => {})
    await prisma.coupon.deleteMany({ where: { code: 'HALF50TEST' } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: { in: [SA, SB] } } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: { in: [CA, CB] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: EU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: EV } }).catch(() => {})
  })

  // #ECON-C: ders/salon silmede puan geri-alma bakiyeyi NEGATİFE düşürmez (clamp)
  await check('Ekonomik: ders silmede puan geri-alma clamp\'li (#C)', async () => {
    const EV = 990342, CC = 990342, SC = 990342, EU = 990342
    await prisma.venue.upsert({ where: { id: EV }, update: { isApproved: true, isActive: true }, create: { id: EV, name: 'EconV2', email: `ev${EV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: CC }, update: { venueId: EV, isActive: true }, create: { id: CC, venueId: EV, title: 'D', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const fut = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: SC }, update: { classId: CC, startsAt: fut }, create: { id: SC, classId: CC, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: EU }, update: { rewardPoints: 30 }, create: { id: EU, username: `econc_${EU}`, email: `econc_${EU}@x.com`, passwordHash: 'x', fullName: 'EconC', tierSportCounts: {}, rewardPoints: 30 } })
    await prisma.booking.deleteMany({ where: { userId: EU } }); await prisma.rewardPoint.deleteMany({ where: { userId: EU } })
    // Bakiye 30 ama booking pointsEarned 50 (yıllık reset sonrası senaryosu) → clamp min(50,30)=30 → 0, NEGATİF değil
    await prisma.booking.create({ data: { userId: EU, sessionId: SC, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, pointsEarned: 50, checkedIn: true, checkedInAt: new Date(), bookingNumber: `ECC-${Date.now()}`, checkInCode: `ECC${Date.now() % 100000}` } }) // checkedIn: puan check-in'de kredilenir, silmede geri-alma yalniz kredilenmis booking'e uygulanir
    const vtok = jwt.sign({ venueId: EV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const del = await http(`/api/venue/classes/${CC}`, { method: 'DELETE', token: vtok })
    if (del.status >= 400) throw new Error(`ders silme: ${del.status} ${del.text.slice(0, 120)}`)
    const u = await prisma.user.findUnique({ where: { id: EU }, select: { rewardPoints: true } })
    if ((u?.rewardPoints ?? -1) !== 0) throw new Error(`puan clamp: 0 bekleniyor, geldi ${u?.rewardPoints} — eski bug −20`)
    await prisma.rewardPoint.deleteMany({ where: { userId: EU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: EU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: SC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: CC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: EU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: EV } }).catch(() => {})
  })

  // #ECON-E: salon KAPATTIĞI (isActive=false) dersin ayakta seansı sessionId ile booklanamaz
  await check('Ekonomik: kapalı dersin seansı booklanamaz (#E)', async () => {
    const EV = 990343, CD = 990343, SD = 990343, EU = 990343
    await prisma.venue.upsert({ where: { id: EV }, update: { isApproved: true, isActive: true }, create: { id: EV, name: 'EconV3', email: `ev${EV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: CD }, update: { venueId: EV, isActive: false }, create: { id: CD, venueId: EV, title: 'Kapalı', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: false } })
    const fut = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: SD }, update: { classId: CD, startsAt: fut, status: 'open' }, create: { id: SD, classId: CD, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: EU }, update: {}, create: { id: EU, username: `econe_${EU}`, email: `econe_${EU}@x.com`, passwordHash: 'x', fullName: 'EconE', tierSportCounts: {} } })
    const euTok = jwt.sign({ userId: EU, email: `econe_${EU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const bk = await http('/api/bookings', { method: 'POST', token: euTok, body: { sessionId: SD } })
    if (bk.status !== 400) throw new Error(`kapalı ders booklandı: ${bk.status} (400 bekleniyor)`)
    await prisma.booking.deleteMany({ where: { userId: EU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: SD } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: CD } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: EU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: EV } }).catch(() => {})
  })

  // #ECON-H: non-numeric percent discountValue reddedilir (NaN money kolonuna yazılmasın)
  await check('Ekonomik: createCoupon non-numeric değeri reddeder (#H)', async () => {
    const vtok = jwt.sign({ venueId: V, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/venue/coupons', { method: 'POST', token: vtok, body: { code: `NAN${Date.now()}`, discountType: 'percent', discountValue: 'abc' } })
    if (r.status !== 400) throw new Error(`non-numeric kupon ${r.status} (400 bekleniyor)`)
  })

  // #ECON-B: validateCoupon enumeration oracle vermez (yok/yanlış-salon aynı yanıt); geçerli indirimi döner
  await check('Ekonomik: validateCoupon oracle vermez (#B)', async () => {
    await prisma.coupon.deleteMany({ where: { code: 'ORCL10' } })
    await prisma.coupon.create({ data: { venueId: V, code: 'ORCL10', discountType: 'percent', discountValue: 10, isActive: true } })
    const notFound = await http('/api/public/validate-coupon', { method: 'POST', body: { code: 'YOKBOYLE_X', venueId: V } })
    const wrongVenue = await http('/api/public/validate-coupon', { method: 'POST', body: { code: 'ORCL10', venueId: V + 99999 } })
    if (notFound.status !== wrongVenue.status) throw new Error(`oracle: yok(${notFound.status}) ≠ yanlış-salon(${wrongVenue.status})`)
    if (notFound.json?.valid !== false || wrongVenue.json?.valid !== false) throw new Error('geçersiz kupon valid:false dönmeli')
    const ok = await http('/api/public/validate-coupon', { method: 'POST', body: { code: 'ORCL10', venueId: V } })
    if (!ok.json?.valid || ok.json?.coupon?.discountValue !== 10) throw new Error(`geçerli kupon indirimi dönmedi: ${ok.text.slice(0, 120)}`)
    await prisma.coupon.deleteMany({ where: { code: 'ORCL10' } }).catch(() => {})
  })

  await check('Rekor seri: 3 gün üst üste check-in → getMe recordStreak 3', async () => {
    const RU = 990231
    await prisma.user.upsert({ where: { id: RU }, update: { recordStreak: 0 }, create: { id: RU, username: `rec_${RU}`, email: `rec_${RU}@x.com`, passwordHash: 'x', fullName: 'Rekor User', tierId: 1, tierSportCounts: {} } })
    const noon = (k: number) => { const d = new Date(); d.setUTCHours(9, 0, 0, 0); return new Date(d.getTime() - k * 86400000) }
    const mkS = (id: number, k: number) => prisma.class_Session.upsert({ where: { id }, update: { startsAt: noon(k) }, create: { id, classId: C, startsAt: noon(k), endsAt: new Date(noon(k).getTime() + 3600000), status: 'open', capacity: 20 } })
    await mkS(990231, 1); await mkS(990232, 2); await mkS(990233, 3)
    await prisma.booking.deleteMany({ where: { userId: RU } })
    const mkB = (id: number, sid: number) => prisma.booking.create({ data: { id, userId: RU, sessionId: sid, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `REC-${id}-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    await mkB(990231, 990231); await mkB(990232, 990232); await mkB(990233, 990233)
    const tok = jwt.sign({ userId: RU, email: `rec_${RU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/auth/me', { token: tok })
    if (r.status !== 200) throw new Error(`me başarısız: ${r.status}`)
    if (r.json?.user?.recordStreak !== 3) throw new Error(`recordStreak ${r.json?.user?.recordStreak} (3 bekleniyor)`)
    await prisma.booking.deleteMany({ where: { userId: RU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: { in: [990231, 990232, 990233] } } }).catch(() => {})
    await prisma.userBadge.deleteMany({ where: { userId: RU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: RU } }).catch(() => {})
  })

  await check('Sezon şampiyonu: biten sezonda ilçe+spor ilk 3 rozet + getMe kapsam/sezon', async () => {
    const testNow = new Date(2026, 11, 15) // 15 Ara 2026 → biten sezon Güz 2026 (lansman zemini geçer)
    const cur = seasonInfo(testNow)
    const prev = seasonInfo(new Date(cur.start.getTime() - 86400000))
    const scat = await prisma.sportCategory.findFirst({})
    await ensureBadges()
    const champB = await prisma.badge.findUnique({ where: { key: 'season_champion' }, select: { id: true } })
    if (!champB) throw new Error('season_champion rozeti yok (ensureBadges)')
    const N = 990221
    await prisma.neighborhood.upsert({ where: { id: N }, update: {}, create: { id: N, name: 'ŞampMah', latitude: 41, longitude: 29, cityId: 1 } })
    await prisma.class.upsert({ where: { id: N }, update: { sportCategoryId: scat?.id ?? null }, create: { id: N, venueId: V, title: 'ŞampDers', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const inPrev = (off: number) => new Date(prev.start.getTime() + off * 86400000)
    await prisma.class_Session.upsert({ where: { id: 990221 }, update: { startsAt: inPrev(5) }, create: { id: 990221, classId: N, startsAt: inPrev(5), endsAt: new Date(inPrev(5).getTime() + 3600000), status: 'open', capacity: 20 } })
    await prisma.class_Session.upsert({ where: { id: 990222 }, update: { startsAt: inPrev(6) }, create: { id: 990222, classId: N, startsAt: inPrev(6), endsAt: new Date(inPrev(6).getTime() + 3600000), status: 'open', capacity: 20 } })
    const mkU = (id: number) => prisma.user.upsert({ where: { id }, update: { neighborhoodId: N, activityPrivacy: 'public', banned: false }, create: { id, username: `smp_${id}`, email: `smp_${id}@x.com`, passwordHash: 'x', fullName: 'Şamp', tierId: 1, tierSportCounts: {}, neighborhoodId: N, activityPrivacy: 'public' } })
    await mkU(990221); await mkU(990222)
    await prisma.booking.deleteMany({ where: { userId: { in: [990221, 990222] } } })
    const bk = (id: number, uid: number, sid: number) => prisma.booking.create({ data: { id, userId: uid, sessionId: sid, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `SMP-${id}-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    await bk(990223, 990221, 990221); await bk(990224, 990221, 990222); await bk(990225, 990222, 990221) // 990221→2 ders, 990222→1 ders
    await prisma.userBadge.deleteMany({ where: { badgeId: champB.id, seasonKey: prev.key } }) // dedupe temizle
    await awardSeasonChampions(testNow)
    const a = await prisma.userBadge.findMany({ where: { userId: 990221, badgeId: champB.id, seasonKey: prev.key, scopeType: 'district', scopeId: N } })
    if (!a.some(x => x.rank === 1)) throw new Error('990221 ilçe 1.liği alamadı')
    const b = await prisma.userBadge.findMany({ where: { userId: 990222, badgeId: champB.id, seasonKey: prev.key, scopeType: 'district', scopeId: N } })
    if (!b.some(x => x.rank === 2)) throw new Error('990222 ilçe 2.liği alamadı')
    const tok = jwt.sign({ userId: 990221, email: 'smp_990221@x.com' }, JWT_SECRET, { expiresIn: '1h' })
    const me = await http('/api/auth/me', { token: tok })
    const cb = (me.json?.user?.badges || []).find((x: any) => x.badge?.key === 'season_champion')
    if (!cb?.scopeName) throw new Error('getMe şampiyon rozetinde scopeName yok')
    if (!cb?.seasonLabel) throw new Error('getMe şampiyon rozetinde seasonLabel yok')
    await prisma.userBadge.deleteMany({ where: { badgeId: champB.id, seasonKey: prev.key } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: { in: [990221, 990222] } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: { in: [990221, 990222] } } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: N } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [990221, 990222] } } }).catch(() => {})
    await prisma.neighborhood.deleteMany({ where: { id: N } }).catch(() => {})
  })

  // #3: Şampiyon BERABERE — eş-skorlu kazanan ELENMEZ, ikisi de aynı derece (deterministik yarışma sıralaması)
  await check('Sezon şampiyonu: berabere → iki kazanan da rank 1 (#3)', async () => {
    const testNow = new Date(2026, 11, 15)
    const cur = seasonInfo(testNow)
    const prev = seasonInfo(new Date(cur.start.getTime() - 86400000))
    const scat = await prisma.sportCategory.findFirst({})
    await ensureBadges()
    const champB = await prisma.badge.findUnique({ where: { key: 'season_champion' }, select: { id: true } })
    if (!champB) throw new Error('season_champion yok')
    const NT = 990310, CT = 990310, U1 = 990312, U2 = 990313
    await prisma.neighborhood.upsert({ where: { id: NT }, update: {}, create: { id: NT, name: 'BrbMah', latitude: 41, longitude: 29, cityId: 1 } })
    await prisma.class.upsert({ where: { id: CT }, update: { sportCategoryId: scat?.id ?? null }, create: { id: CT, venueId: V, title: 'BrbDers', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const inPrev = (off: number) => new Date(prev.start.getTime() + off * 86400000)
    await prisma.class_Session.upsert({ where: { id: 990311 }, update: { startsAt: inPrev(5) }, create: { id: 990311, classId: CT, startsAt: inPrev(5), endsAt: new Date(inPrev(5).getTime() + 3600000), status: 'open', capacity: 20 } })
    const mkU = (id: number) => prisma.user.upsert({ where: { id }, update: { neighborhoodId: NT, activityPrivacy: 'public', banned: false }, create: { id, username: `brb_${id}`, email: `brb_${id}@x.com`, passwordHash: 'x', fullName: 'Brb', tierId: 1, tierSportCounts: {}, neighborhoodId: NT, activityPrivacy: 'public' } })
    await mkU(U1); await mkU(U2)
    await prisma.booking.deleteMany({ where: { userId: { in: [U1, U2] } } })
    const bk = (id: number, uid: number) => prisma.booking.create({ data: { id, userId: uid, sessionId: 990311, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `BRB-${id}-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    await bk(990314, U1); await bk(990315, U2) // ikisi de 1 ders → BERABERE
    await prisma.userBadge.deleteMany({ where: { badgeId: champB.id, seasonKey: prev.key } }) // already-guard sıfırla
    await awardSeasonChampions(testNow)
    const r1 = await prisma.userBadge.findFirst({ where: { userId: U1, badgeId: champB.id, seasonKey: prev.key, scopeType: 'district', scopeId: NT } })
    const r2 = await prisma.userBadge.findFirst({ where: { userId: U2, badgeId: champB.id, seasonKey: prev.key, scopeType: 'district', scopeId: NT } })
    if (!r1 || !r2) throw new Error(`berabere iki kazanan da rozet almalı (u1=${!!r1} u2=${!!r2})`)
    if (r1.rank !== 1 || r2.rank !== 1) throw new Error(`berabere ikisi de rank 1 olmalı (u1=${r1.rank} u2=${r2.rank}) — eski slice(0,3) birini elerdi`)
    await prisma.userBadge.deleteMany({ where: { userId: { in: [U1, U2] } } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: { in: [U1, U2] } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: 990311 } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: CT } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [U1, U2] } } }).catch(() => {})
    await prisma.neighborhood.deleteMany({ where: { id: NT } }).catch(() => {})
  })

  // #2: Hesap silme → davetlinin TAMAMLANMIŞ referral'ında davet edenin +100'ü GERİ ALINIR (farming engeli)
  await check('Hesap silme: tamamlanmış referral +100 geri alınır (#2 farming)', async () => {
    const RR = 990330, DD = 990331
    await prisma.rewardPoint.deleteMany({ where: { userId: { in: [RR, DD] } } }).catch(() => {})
    await prisma.referral.deleteMany({ where: { OR: [{ referrerId: RR }, { referredId: DD }] } }).catch(() => {})
    await prisma.user.upsert({ where: { id: RR }, update: { rewardPoints: 250 }, create: { id: RR, username: `rr_${RR}`, email: `rr_${RR}@x.com`, passwordHash: 'x', fullName: 'Referrer', tierSportCounts: {}, rewardPoints: 250 } })
    await prisma.user.upsert({ where: { id: DD }, update: { passwordHash: bcrypt.hashSync('DelPass123', 10) }, create: { id: DD, username: `dd_${DD}`, email: `dd_${DD}@x.com`, passwordHash: bcrypt.hashSync('DelPass123', 10), fullName: 'Referred', tierSportCounts: {} } })
    await prisma.referral.create({ data: { referrerId: RR, referredId: DD, status: 'completed', completedAt: new Date(), referredBonusGranted: true } })
    const dTok = jwt.sign({ userId: DD, email: `dd_${DD}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const del = await http('/api/auth/account', { method: 'DELETE', token: dTok, body: { password: 'DelPass123' } })
    if (del.status !== 200) throw new Error(`hesap silme başarısız: ${del.status} ${del.text.slice(0, 120)}`)
    const rr = await prisma.user.findUnique({ where: { id: RR }, select: { rewardPoints: true } })
    if (rr?.rewardPoints !== 150) throw new Error(`davet edenin puanı geri alınmadı: ${rr?.rewardPoints} (150 bekleniyor: 250−100)`)
    const rev = await prisma.rewardPoint.findFirst({ where: { userId: RR, source: 'referral_reversed' } })
    if (!rev || rev.points !== -100) throw new Error(`referral_reversed ledger kaydı yok/yanlış: ${rev?.points}`)
    await prisma.rewardPoint.deleteMany({ where: { userId: RR } }).catch(() => {})
    await prisma.referral.deleteMany({ where: { referrerId: RR } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: RR } }).catch(() => {})
  })

  await check('Rozet kataloğu: streak rozetleri silinir, değerler düzeltilir, founder/referral var', async () => {
    await ensureBadges()
    const streak = await prisma.badge.count({ where: { criteriaType: 'streak' } })
    if (streak !== 0) throw new Error(`streak rozeti kaldı: ${streak}`)
    const v = await prisma.badge.findUnique({ where: { key: 'variety_5' }, select: { criteriaValue: true } })
    if (v?.criteriaValue !== 3) throw new Error(`variety ${v?.criteriaValue} (3 bekleniyor)`)
    const l = await prisma.badge.findUnique({ where: { key: 'loyalty_10' }, select: { criteriaValue: true } })
    if (l?.criteriaValue !== 5) throw new Error(`loyalty ${l?.criteriaValue} (5 bekleniyor)`)
    const tm = await prisma.badge.findUnique({ where: { key: 'team_5' }, select: { criteriaValue: true } })
    if (tm?.criteriaValue !== 3) throw new Error(`team ${tm?.criteriaValue} (3 bekleniyor)`)
    if (!(await prisma.badge.findUnique({ where: { key: 'founder' } }))) throw new Error('founder rozeti yok')
    if (!(await prisma.badge.findUnique({ where: { key: 'referral' } }))) throw new Error('referral rozeti yok')
  })

  await check('Rozet: Kurucu (ilk 500 + ilk ders) + Elçi (3 tamamlanan davet)', async () => {
    await ensureBadges()
    const KU = 990241, RIDS = [990242, 990243, 990244]
    await prisma.referral.deleteMany({ where: { referrerId: KU } })
    await prisma.userBadge.deleteMany({ where: { userId: KU } })
    await prisma.booking.deleteMany({ where: { userId: KU } })
    // createdAt'ı erkene sabitle → kayıt sırası ≤500 garanti (DB boyutundan bağımsız)
    await prisma.user.upsert({ where: { id: KU }, update: { createdAt: new Date('2020-01-01T00:00:00Z') }, create: { id: KU, username: `ku_${KU}`, email: `ku_${KU}@x.com`, passwordHash: 'x', fullName: 'Kurucu User', tierId: 1, tierSportCounts: {}, createdAt: new Date('2020-01-01T00:00:00Z') } })
    const past = new Date(Date.now() - 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: 990241 }, update: { startsAt: past }, create: { id: 990241, classId: C, startsAt: past, endsAt: new Date(past.getTime() + 3600000), status: 'open', capacity: 20 } })
    await prisma.booking.create({ data: { id: 990241, userId: KU, sessionId: 990241, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `KU-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    for (const rid of RIDS) {
      await prisma.user.upsert({ where: { id: rid }, update: {}, create: { id: rid, username: `kr_${rid}`, email: `kr_${rid}@x.com`, passwordHash: 'x', fullName: 'Ref', tierId: 1, tierSportCounts: {} } })
      await prisma.referral.create({ data: { referrerId: KU, referredId: rid, status: 'completed', completedAt: new Date() } })
    }
    const tok = jwt.sign({ userId: KU, email: `ku_${KU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/auth/me', { token: tok })
    const keys = (r.json?.user?.badges || []).map((b: any) => b.badge?.key)
    if (!keys.includes('founder')) throw new Error('Kurucu verilmedi')
    if (!keys.includes('referral')) throw new Error('Elçi verilmedi')
    await prisma.referral.deleteMany({ where: { referrerId: KU } }).catch(() => {})
    await prisma.userBadge.deleteMany({ where: { userId: KU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: KU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: 990241 } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [KU, ...RIDS] } } }).catch(() => {})
  })

  await check('Takip: açık→accepted+bildirim, gizli→istek+bildirim, kabul→accepted, sayaç accepted-only', async () => {
    const A = 990251, B = 990252
    await prisma.follow.deleteMany({ where: { OR: [{ followerId: A }, { followingId: B }] } })
    await prisma.notification.deleteMany({ where: { userId: { in: [A, B] } } })
    await prisma.user.upsert({ where: { id: A }, update: {}, create: { id: A, username: `fa_${A}`, email: `fa_${A}@x.com`, passwordHash: 'x', fullName: 'Follower A', tierId: 1, tierSportCounts: {} } })
    await prisma.user.upsert({ where: { id: B }, update: { profilePrivacy: 'public' }, create: { id: B, username: `fb_${B}`, email: `fb_${B}@x.com`, passwordHash: 'x', fullName: 'Target B', tierId: 1, tierSportCounts: {}, profilePrivacy: 'public' } })
    const tokA = jwt.sign({ userId: A, email: `fa_${A}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const tokB = jwt.sign({ userId: B, email: `fb_${B}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    // Açık profil → doğrudan accepted + follow bildirimi
    const r1 = await http(`/api/social/follow/fb_${B}`, { method: 'POST', token: tokA })
    if (r1.json?.status !== 'accepted') throw new Error(`açık status ${r1.json?.status} (accepted)`)
    if ((await prisma.notification.count({ where: { userId: B, type: 'follow' } })) < 1) throw new Error('takip bildirimi yok')
    const st1 = await http(`/api/social/status/fb_${B}`, { token: tokA })
    if (st1.json?.followers !== 1) throw new Error(`followers ${st1.json?.followers} (1)`)
    // Gizli profil → istek (pending) + follow_request bildirimi
    await http(`/api/social/unfollow/fb_${B}`, { method: 'DELETE', token: tokA })
    await prisma.user.update({ where: { id: B }, data: { profilePrivacy: 'private' } })
    const r2 = await http(`/api/social/follow/fb_${B}`, { method: 'POST', token: tokA })
    if (r2.json?.status !== 'pending') throw new Error(`gizli status ${r2.json?.status} (pending)`)
    if ((await prisma.notification.count({ where: { userId: B, type: 'follow_request' } })) < 1) throw new Error('istek bildirimi yok')
    const st2 = await http(`/api/social/status/fb_${B}`, { token: tokA })
    // Yeni model: gizli profile PENDING olan (henüz kabul değil) yabancı sayılır → sayaç GİZLİ (null) + isProfilePrivate.
    // Takip durumu (buton için) yine 'pending' döner. ("sadece kimlik + takip isteği")
    if (st2.json?.followStatus !== 'pending') throw new Error(`gizli-pending status ${st2.json?.followStatus} (pending bekleniyor)`)
    if (st2.json?.followers !== null || !st2.json?.isProfilePrivate) throw new Error(`gizli profilde pending'e sayaç gizlenmeli (followers=${st2.json?.followers}, isProfilePrivate=${st2.json?.isProfilePrivate})`)
    // Kabul → accepted + follow_accept bildirimi
    const acc = await http(`/api/social/follow-requests/fa_${A}/accept`, { method: 'POST', token: tokB })
    if (acc.status !== 200) throw new Error(`kabul ${acc.status}`)
    const st3 = await http(`/api/social/status/fb_${B}`, { token: tokA })
    if (st3.json?.followers !== 1 || st3.json?.followStatus !== 'accepted') throw new Error(`kabul sonrası ${st3.json?.followers}/${st3.json?.followStatus}`)
    if ((await prisma.notification.count({ where: { userId: A, type: 'follow_accept' } })) < 1) throw new Error('kabul bildirimi yok')
    await prisma.follow.deleteMany({ where: { OR: [{ followerId: A }, { followingId: B }] } }).catch(() => {})
    await prisma.notification.deleteMany({ where: { userId: { in: [A, B] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [A, B] } } }).catch(() => {})
  })

  await check('Gizli hesap: içerik sahibi+onaylı takipçiye açık, yabancıya/bekleyene gizli', async () => {
    const OWN = 990271, VIEW = 990272
    await prisma.follow.deleteMany({ where: { OR: [{ followerId: VIEW }, { followingId: OWN }] } })
    await prisma.notification.deleteMany({ where: { userId: { in: [OWN, VIEW] } } })
    await prisma.user.upsert({ where: { id: OWN }, update: { profilePrivacy: 'private', activityPrivacy: 'public', preferredSports: ['Yoga'] }, create: { id: OWN, username: `gz_${OWN}`, email: `gz_${OWN}@x.com`, passwordHash: 'x', fullName: 'Gizli User', tierId: 1, tierSportCounts: {}, profilePrivacy: 'private', activityPrivacy: 'public', preferredSports: ['Yoga'] } })
    await prisma.user.upsert({ where: { id: VIEW }, update: {}, create: { id: VIEW, username: `vw_${VIEW}`, email: `vw_${VIEW}@x.com`, passwordHash: 'x', fullName: 'Viewer', tierId: 1, tierSportCounts: {} } })
    const vtok = jwt.sign({ userId: VIEW, email: `vw_${VIEW}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const otok = jwt.sign({ userId: OWN, email: `gz_${OWN}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    // 1) Yabancı → gizli, içerik yok
    const r1 = await http(`/api/public/users/gz_${OWN}`, { token: vtok })
    if (!r1.json?.isProfilePrivate) throw new Error('yabancıya gizli işareti gelmedi')
    if (r1.json?.user?.preferredSports || r1.json?.user?.badges) throw new Error('gizli hesapta içerik sızdı')
    // 2) Sahibi → tam içerik
    const r2 = await http(`/api/public/users/gz_${OWN}`, { token: otok })
    if (r2.json?.isProfilePrivate) throw new Error('sahibine gizli döndü')
    if (!('preferredSports' in (r2.json?.user || {}))) throw new Error('sahibine içerik gelmedi')
    // 3) Bekleyen (pending) takipçi → hâlâ gizli
    await http(`/api/social/follow/gz_${OWN}`, { method: 'POST', token: vtok })
    const r3 = await http(`/api/public/users/gz_${OWN}`, { token: vtok })
    if (!r3.json?.isProfilePrivate) throw new Error('pending takipçiye içerik açıldı (olmamalı)')
    // 4) Kabul sonrası → onaylı takipçi görür
    await http(`/api/social/follow-requests/vw_${VIEW}/accept`, { method: 'POST', token: otok })
    const r4 = await http(`/api/public/users/gz_${OWN}`, { token: vtok })
    if (r4.json?.isProfilePrivate) throw new Error('onaylı takipçiye hâlâ gizli')
    await prisma.follow.deleteMany({ where: { OR: [{ followerId: VIEW }, { followingId: OWN }] } }).catch(() => {})
    await prisma.notification.deleteMany({ where: { userId: { in: [OWN, VIEW] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [OWN, VIEW] } } }).catch(() => {})
  })

  await check('Düzenli: GEÇMİŞ sezonda 10 ders → rozet (güncel sezon 0 olsa da)', async () => {
    await ensureBadges()
    const DU = 990261
    const ids = Array.from({ length: 10 }, (_, i) => 990261 + i)
    await prisma.userBadge.deleteMany({ where: { userId: DU } })
    await prisma.booking.deleteMany({ where: { userId: DU } })
    await prisma.user.upsert({ where: { id: DU }, update: {}, create: { id: DU, username: `duz_${DU}`, email: `duz_${DU}@x.com`, passwordHash: 'x', fullName: 'Duzenli User', tierId: 1, tierSportCounts: {} } })
    // 10 seans Nisan 2026 (bahar sezonu — güncel sezondan farklı, geçmiş)
    for (let i = 0; i < 10; i++) {
      const sid = 990261 + i
      const d = new Date('2026-04-10T09:00:00Z'); d.setUTCDate(d.getUTCDate() + i)
      await prisma.class_Session.upsert({ where: { id: sid }, update: { startsAt: d }, create: { id: sid, classId: C, startsAt: d, endsAt: new Date(d.getTime() + 3600000), status: 'open', capacity: 20 } })
      await prisma.booking.create({ data: { id: sid, userId: DU, sessionId: sid, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `DUZ-${sid}-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })
    }
    const tok = jwt.sign({ userId: DU, email: `duz_${DU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/auth/me', { token: tok })
    const keys = (r.json?.user?.badges || []).map((b: any) => b.badge?.key)
    if (!keys.includes('lessons_10')) throw new Error('Düzenli (lessons_10) verilmedi — geçmiş sezon 10 ders sayılmadı')
    await prisma.userBadge.deleteMany({ where: { userId: DU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: DU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: DU } }).catch(() => {})
  })

  await check('Kayıt/giriş: geçersiz username reddedilir + email case-insensitive', async () => {
    const email = 'usrcase01@x.com'
    const clean = async () => { const u = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } }); if (u) { await prisma.refreshToken.deleteMany({ where: { userId: u.id } }); await prisma.emailVerificationToken.deleteMany({ where: { userId: u.id } }); await prisma.user.delete({ where: { id: u.id } }).catch(() => {}) } }
    await clean()
    // 1) geçersiz username (boşluk + /) → 400
    const bad = await http('/api/auth/register', { method: 'POST', body: { username: 'ali veli/x', email: 'valid_reg_x@x.com', password: 'Test1234', fullName: 'T' } })
    if (bad.status !== 400) throw new Error(`geçersiz username ${bad.status} (400 bekleniyor)`)
    // 2) karışık-case email ile kayıt (UsrCase01@X.CoM → usrcase01@x.com)
    const reg = await http('/api/auth/register', { method: 'POST', body: { username: 'usrcase01', email: 'UsrCase01@X.CoM', password: 'Test1234', fullName: 'T' } })
    if (reg.status !== 201) throw new Error(`kayıt ${reg.status}: ${reg.text.slice(0, 120)}`)
    // 3) aynı email farklı case → çift hesap engeli 400
    const dup = await http('/api/auth/register', { method: 'POST', body: { username: 'usrcase02', email: 'usrcase01@x.com', password: 'Test1234', fullName: 'T' } })
    if (dup.status !== 400) throw new Error(`çift email (case) ${dup.status} (400 bekleniyor)`)
    // 4) FARKLI case ile giriş → başarılı
    const login = await http('/api/auth/login', { method: 'POST', body: { email: 'USRCASE01@x.com', password: 'Test1234' } })
    if (login.status !== 200) throw new Error(`case-insensitive giriş ${login.status} (200 bekleniyor)`)
    await clean()
  })

  await check('Admin: secret yok/yanlış → 401, doğru → 200 (timing-safe)', async () => {
    const noSecret = await http('/api/admin/stats')
    if (noSecret.status !== 401) throw new Error(`secretsiz ${noSecret.status} (401 bekleniyor)`)
    const wrong = await fetch(BASE + '/api/admin/stats', { headers: { 'x-admin-secret': 'yanlis-secret-xyz' } })
    if (wrong.status !== 401) throw new Error(`yanlış secret ${wrong.status} (401 bekleniyor)`)
    const ok = await http('/api/admin/stats', { admin: true })
    if (ok.status !== 200) throw new Error(`doğru secret ${ok.status} (200 bekleniyor)`)
  })

  await check('Cron hatırlatma: eşzamanlı 2 tetikte tek mail (atomik reminderSent claim)', async () => {
    const RS = 990191
    await prisma.class.upsert({ where: { id: RS }, update: {}, create: { id: RS, venueId: V, title: 'ReminderDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const startsAt = new Date(Date.now() + 120 * 60 * 1000) // +2 saat → hatırlatma penceresi (105-135 dk)
    await prisma.class_Session.upsert({ where: { id: RS }, update: { startsAt, status: 'open' }, create: { id: RS, classId: RS, startsAt, endsAt: new Date(startsAt.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: RS }, update: { email: `rem_${RS}@x.com` }, create: { id: RS, username: `rem_${RS}`, email: `rem_${RS}@x.com`, passwordHash: 'x', fullName: 'Reminder User', tierId: 1, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { sessionId: RS } })
    await prisma.booking.create({ data: { userId: RS, sessionId: RS, status: 'confirmed', bookingType: 'class', groupSize: 1, baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, pointsEarned: 0, reminderSent: false, checkedIn: false, bookingNumber: `REM-${Date.now()}` } })
    const secret = process.env.CRON_SECRET || 'cron-secret-2024'
    const hit = (): Promise<any> => fetch(BASE + '/api/cron/reminders', { headers: { 'x-cron-secret': secret } }).then(r => r.json()).catch(() => ({ sent: 0 }))
    const [a, b] = await Promise.all([hit(), hit()])
    const total = (a?.sent || 0) + (b?.sent || 0)
    if (total !== 1) throw new Error(`toplam gönderim ${total} (1 bekleniyor — eşzamanlı tetikte çift mail olmamalı)`)
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

  // ================== SAAT DİLİMİ REGRESYONLARI ==================
  // Bunlar denetim turu 11'de bulunan kaymaların geri gelmesini engeller. Sunucu UTC çalışırken
  // (Railway) TR duvar-saatinin korunduğunu KANITLARLAR — testin kendisi sunucunun TZ'inden
  // bağımsız olsun diye her yerde Europe/Istanbul ile karşılaştırma yapılır.
  const trHM = (d: Date | string) => new Date(d).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' })
  const trWd = (d: Date | string) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(new Date(d).toLocaleDateString('en-US', { timeZone: 'Europe/Istanbul', weekday: 'short' }))

  await check('Saat dilimi: tekrarlayan seans TR duvar-saatini korur (19:00 → 19:00)', async () => {
    const TV = 990501, TC = 990501
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true, isVerified: true }, create: { id: TV, name: 'TzVenue', email: `tz${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, isVerified: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TC }, update: {}, create: { id: TC, venueId: TV, title: 'TzDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.deleteMany({ where: { classId: TC } })
    const tok = jwt.sign({ venueId: TV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    // Pazartesi(1) + Perşembe(4), saat 19:00, 2 hafta
    const r = await http(`/api/venue/classes/${TC}/sessions/recurring`, { method: 'POST', token: tok, body: { time: '19:00', capacity: 10, weekDays: [1, 4], weeks: 2 } })
    if (r.status !== 201) throw new Error(`tekrarlayan seans: ${r.status} ${r.text.slice(0, 160)}`)
    const created = await prisma.class_Session.findMany({ where: { classId: TC }, select: { startsAt: true } })
    if (created.length === 0) throw new Error('hiç seans oluşmadı')
    for (const s of created) {
      // REGRESYON: setHours ile sunucu-yerel hesap yapılırsa UTC sunucuda burası '22:00' döner.
      if (trHM(s.startsAt) !== '19:00') throw new Error(`seans saati İstanbul'da ${trHM(s.startsAt)} (19:00 bekleniyor) — sunucu TZ'ine kaymış`)
      if (![1, 4].includes(trWd(s.startsAt))) throw new Error(`seans günü ${trWd(s.startsAt)} (Pzt=1/Per=4 bekleniyor) — gün kaymış`)
    }
    await prisma.class_Session.deleteMany({ where: { classId: TC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: TC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
  })

  await check('Saat dilimi: tekrarlayan seans tek-seans yoluyla AYNI anı üretir', async () => {
    const TV = 990502, TC = 990502
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true, isVerified: true }, create: { id: TV, name: 'TzVenue2', email: `tz${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, isVerified: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TC }, update: {}, create: { id: TC, venueId: TV, title: 'TzDers2', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.deleteMany({ where: { classId: TC } })
    const tok = jwt.sign({ venueId: TV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const rr = await http(`/api/venue/classes/${TC}/sessions/recurring`, { method: 'POST', token: tok, body: { time: '20:30', capacity: 10, weekDays: [3], weeks: 1 } })
    if (rr.status !== 201) throw new Error(`tekrarlayan: ${rr.status}`)
    const rec = await prisma.class_Session.findFirst({ where: { classId: TC }, orderBy: { startsAt: 'asc' }, select: { startsAt: true } })
    if (!rec) throw new Error('tekrarlayan seans oluşmadı (bu haftaki Çarşamba geçmiş olabilir)')
    // Aynı günü tek-seans ucundan da ekle → iki yol AYNI anı vermeli (eskiden 3 saat fark vardı).
    // (classId, startsAt) artık DB'de TEKİL olduğu için önce tekrarlayan seansı silip aynı anı
    // ikinci yoldan üretiyoruz; karşılaştırma aynı, çakışma yok.
    const ymd = new Date(rec.startsAt).toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' })
    await prisma.class_Session.deleteMany({ where: { classId: TC } })
    const one = await http(`/api/venue/classes/${TC}/sessions`, { method: 'POST', token: tok, body: { date: ymd, time: '20:30', capacity: 10 } })
    if (one.status !== 201) throw new Error(`tek seans: ${one.status} ${one.text.slice(0, 160)}`)
    const single = await prisma.class_Session.findUnique({ where: { id: one.json.session.id }, select: { startsAt: true } })
    if (new Date(single!.startsAt).getTime() !== new Date(rec.startsAt).getTime()) {
      throw new Error(`iki yol farklı an üretti: tekrarlayan=${new Date(rec.startsAt).toISOString()} tek=${new Date(single!.startsAt).toISOString()}`)
    }
    await prisma.class_Session.deleteMany({ where: { classId: TC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: TC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
  })

  await check('Drop-in check-in: etkinlikten çok önce okutulamaz (zaman penceresi)', async () => {
    const TV = 990503, TU = 990503
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true }, create: { id: TV, name: 'TzVenue3', email: `tz${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.user.upsert({ where: { id: TU }, update: {}, create: { id: TU, username: `tz_${TU}`, email: `tz_${TU}@x.com`, passwordHash: 'x', fullName: 'Tz', tierSportCounts: {} } })
    const cat = await prisma.sportCategory.findFirst({ where: { name: { equals: catName, mode: 'insensitive' } }, select: { id: true } })
    const far = new Date(Date.now() + 10 * 86400000) // 10 gün sonra
    const slot = await prisma.dropInSlot.create({ data: { venueId: TV, sportCategoryId: cat!.id, title: 'TzDropIn', startsAt: far, endsAt: new Date(far.getTime() + 3600000), pricePerPerson: 100, totalPrice: 400, totalPlayers: 4, format: '2x2', status: 'open', visibility: 'open' } })
    const code = `TZCODE${Date.now()}`.slice(0, 12).toUpperCase()
    await prisma.dropInParticipant.create({ data: { slotId: slot.id, userId: TU, status: 'confirmed', checkInCode: code } })
    const tok = jwt.sign({ venueId: TV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/bookings/dropin-checkin', { method: 'POST', token: tok, body: { code } })
    // REGRESYON: pencere yokken 200 dönüyordu → salon gelecekteki katılımı check-in'leyip seri/rozet şişirebiliyordu
    if (r.status !== 400) throw new Error(`10 gün sonraki drop-in check-in'i ${r.status} döndü (400 bekleniyor)`)
    await prisma.dropInParticipant.deleteMany({ where: { slotId: slot.id } }).catch(() => {})
    await prisma.dropInSlot.deleteMany({ where: { id: slot.id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: TU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
  })

  // ================== TEST BORCU KAPATMA (turlar 12/13/18 testsiz düzeltmeler) ==================
  await check('Test borcu: getMyBookings komisyon kırılımını GİZLER (T13)', async () => {
    const MU = 991301
    await prisma.user.upsert({ where: { id: MU }, update: {}, create: { id: MU, username: `mb_${MU}`, email: `mb_${MU}@x.com`, passwordHash: 'x', fullName: 'Mb', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: MU } })
    await prisma.booking.create({ data: { userId: MU, sessionId: S, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 15, venueCommission: 15, userCommission: 0, venuePayout: 85, finalAmount: 100, bookingNumber: `MB-${Date.now()}` } })
    const tok = jwt.sign({ userId: MU, email: `mb_${MU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/bookings/my', { token: tok })
    if (r.status !== 200) throw new Error(`my: ${r.status}`)
    const blob = JSON.stringify(r.json)
    // REGRESYON: komisyon/payout müşteriye dönmemeli (iş modeli verisi)
    for (const f of ['commissionAmount', 'venueCommission', 'venuePayout', 'userCommission']) {
      if (blob.includes(f)) throw new Error(`getMyBookings ${f} sızdırıyor`)
    }
    await prisma.booking.deleteMany({ where: { userId: MU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: MU } }).catch(() => {})
  })

  await check('Test borcu: askıya alınmış salonun eğitmeni GİRİŞ yapamaz (T13)', async () => {
    const SV = 991302, SI = 991302
    const bcryptLib = require('bcryptjs')
    await prisma.venue.upsert({ where: { id: SV }, update: { isApproved: true, isActive: false, isSuspended: true }, create: { id: SV, name: 'SuspLoginV', email: `slv${SV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: false, isSuspended: true, neighborhoodId: V, cityId: 1 } })
    await prisma.instructor.upsert({ where: { id: SI }, update: { venueId: SV, isActive: true, passwordHash: await bcryptLib.hash('EgitmenSifre1', 12), email: `slins${SI}@x.com` }, create: { id: SI, venueId: SV, fullName: 'Susp Login Hoca', isActive: true, passwordHash: await bcryptLib.hash('EgitmenSifre1', 12), email: `slins${SI}@x.com` } })
    const r = await http('/api/instructor/login', { method: 'POST', body: { email: `slins${SI}@x.com`, password: 'EgitmenSifre1' } })
    // REGRESYON: donmuş salonun eğitmeni yeni token üretememeli (kök neden)
    if (r.status === 200 && r.json?.token) throw new Error('askıya alınmış salonun eğitmeni giriş yapabildi')
    await prisma.instructor.deleteMany({ where: { id: SI } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: SV } }).catch(() => {})
  })

  await check('Test borcu: referral kodu çağrılar arası SABİT kalır (T12 koşullu yazma)', async () => {
    const RU = 991303
    await prisma.user.upsert({ where: { id: RU }, update: { referralCode: null }, create: { id: RU, username: `rc_${RU}`, email: `rc_${RU}@x.com`, passwordHash: 'x', fullName: 'Rc', tierSportCounts: {} } })
    const tok = jwt.sign({ userId: RU, email: `rc_${RU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const c1 = (await http('/api/referral', { token: tok })).json?.referralCode
    const c2 = (await http('/api/referral', { token: tok })).json?.referralCode
    if (!c1 || c1 !== c2) throw new Error(`referral kodu değişti: ${c1} → ${c2} (koşullu yazma yok)`)
    await prisma.user.deleteMany({ where: { id: RU } }).catch(() => {})
  })

  await check('Test borcu: transferBooking eski seansın waitlist\'ini bilgilendirir (T18)', async () => {
    const TV = 991305, TC = 991305, S1 = 991305, S2 = 991306, UA = 991305, UB = 991306
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true }, create: { id: TV, name: 'TrWlV', email: `trwl${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TC }, update: {}, create: { id: TC, venueId: TV, title: 'TrWlD', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const soon = new Date(Date.now() + 3 * 86400000)
    // Kaynak seans kapasite 1 (A ile dolu → B beklemede); hedef seans boş
    await prisma.class_Session.upsert({ where: { id: S1 }, update: { startsAt: soon, capacity: 1 }, create: { id: S1, classId: TC, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 1, status: 'open' } })
    const soon2 = new Date(soon.getTime() + 2 * 3600000) // farklı saat: (classId,startsAt) tekillik indeksi (T12)
    await prisma.class_Session.upsert({ where: { id: S2 }, update: { startsAt: soon2, capacity: 20 }, create: { id: S2, classId: TC, startsAt: soon2, endsAt: new Date(soon2.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: UA }, update: {}, create: { id: UA, username: `ta_${UA}`, email: `ta_${UA}@x.com`, passwordHash: 'x', fullName: 'Ta', tierSportCounts: {} } })
    await prisma.user.upsert({ where: { id: UB }, update: {}, create: { id: UB, username: `tb_${UB}`, email: `tb_${UB}@x.com`, passwordHash: 'x', fullName: 'Tb', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: { in: [UA, UB] } } })
    await prisma.waitlist.deleteMany({ where: { sessionId: { in: [S1, S2] } } })
    const bkA = await prisma.booking.create({ data: { userId: UA, sessionId: S1, status: 'confirmed', bookingType: 'class', groupSize: 1, baseAmount: 100, commissionAmount: 0, venueCommission: 0, venuePayout: 100, finalAmount: 100, bookingNumber: `TA-${Date.now()}` } })
    // B kaynak seansın beklemesinde
    await prisma.waitlist.create({ data: { sessionId: S1, userId: UB, status: 'waiting' } })
    const aTok = jwt.sign({ userId: UA, email: `ta_${UA}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/bookings/${bkA.id}/transfer`, { method: 'PUT', token: aTok, body: { targetSessionId: S2 } })
    if (r.status !== 200) throw new Error(`transfer: ${r.status} ${r.text.slice(0,120)}`)
    await new Promise(res => setTimeout(res, 300)) // notifyFirstWaitlistUser fire-and-forget
    // REGRESYON: eski seans (S1) boşaldı → B 'notified' olmalı (eskiden hiç bildirilmiyordu)
    const wl = await prisma.waitlist.findFirst({ where: { sessionId: S1, userId: UB }, select: { status: true } })
    if (wl?.status !== 'notified') throw new Error(`transfer sonrası eski seans waitlist'i bildirilmedi (status=${wl?.status})`)
    await prisma.notification.deleteMany({ where: { userId: { in: [UA, UB] } } }).catch(() => {}) // waitlist_open bildirimi temizle (yetim FK)
    await prisma.waitlist.deleteMany({ where: { sessionId: { in: [S1, S2] } } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: { in: [UA, UB] } } }).catch(() => {})
    for (const id of [S1, S2]) await prisma.class_Session.deleteMany({ where: { id } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: TC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [UA, UB] } } }).catch(() => {})
  })

  await check('Test borcu: drop-in visibility beyaz-liste (geçersiz → open) (T16)', async () => {
    const DV = 991307
    await prisma.venue.upsert({ where: { id: DV }, update: { isApproved: true, isActive: true, isVerified: true }, create: { id: DV, name: 'VisV', email: `visv${DV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, isVerified: true, neighborhoodId: V, cityId: 1 } })
    await prisma.sportCategory.upsert({ where: { id: 991307 }, update: {}, create: { id: 991307, name: 'Basketbol', iconUrl: 'basketball', colorHex: '#F59E0B' } }).catch(() => {})
    const vtok = jwt.sign({ venueId: DV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    // Geçersiz visibility → beyaz-liste 'open'a çekmeli
    const r = await http('/api/venue/dropin', { method: 'POST', token: vtok, body: { sport: 'Basketbol', format: '5v5 Tam Saha', date: '2027-01-01', time: '19:00', pricePerPerson: 100, visibility: 'hacker-value' } })
    if (r.status !== 201) throw new Error(`dropin: ${r.status} ${r.text.slice(0,120)}`)
    const slot = await prisma.dropInSlot.findFirst({ where: { venueId: DV }, orderBy: { id: 'desc' }, select: { visibility: true } })
    if (slot?.visibility !== 'open') throw new Error(`geçersiz visibility beyaz-listeye çekilmedi: ${slot?.visibility}`)
    await prisma.dropInSlot.deleteMany({ where: { venueId: DV } }).catch(() => {})
    await prisma.sportCategory.deleteMany({ where: { id: 991307 } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: DV } }).catch(() => {})
  })

  await check('Test borcu: deleteDropInSlot slot + katılımcıları BİRLİKTE siler (T12 transaction)', async () => {
    const DV = 991304, DU = 991304
    await prisma.venue.upsert({ where: { id: DV }, update: { isApproved: true, isActive: true }, create: { id: DV, name: 'DelDropV', email: `ddv${DV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.user.upsert({ where: { id: DU }, update: {}, create: { id: DU, username: `dd_${DU}`, email: `dd_${DU}@x.com`, passwordHash: 'x', fullName: 'Dd', tierSportCounts: {} } })
    const cat = await prisma.sportCategory.findFirst({ where: { name: { equals: catName, mode: 'insensitive' } }, select: { id: true } })
    const soon = new Date(Date.now() + 5 * 86400000)
    const slot = await prisma.dropInSlot.create({ data: { venueId: DV, sportCategoryId: cat!.id, title: 'DelSlot', startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), pricePerPerson: 100, totalPrice: 400, totalPlayers: 4, format: '2x2', status: 'open', visibility: 'open' } })
    await prisma.dropInParticipant.create({ data: { slotId: slot.id, userId: DU, status: 'confirmed', checkInCode: `DD${Date.now() % 100000}` } })
    const vtok = jwt.sign({ venueId: DV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/venue/dropin/${slot.id}`, { method: 'DELETE', token: vtok })
    if (r.status !== 200) throw new Error(`dropin sil: ${r.status} ${r.text.slice(0,120)}`)
    // İkisi de gitmiş olmalı (yarım-durum yok)
    const slotLeft = await prisma.dropInSlot.count({ where: { id: slot.id } })
    const partLeft = await prisma.dropInParticipant.count({ where: { slotId: slot.id } })
    if (slotLeft !== 0 || partLeft !== 0) throw new Error(`yarım silme: slot=${slotLeft} participant=${partLeft} (0/0 bekleniyor)`)
    await prisma.venue.deleteMany({ where: { id: DV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: DU } }).catch(() => {})
  })

  // ================== GAMIFICATION REGRESYONLARI (denetim turu 19) ==================
  await check('Gamification: puan REZERVASYONDA verilmez, check-in\'de verilir (no-show farming kapalı)', async () => {
    const PV = 991211, PC = 991211, PS = 991211, PU = 991211
    await prisma.venue.upsert({ where: { id: PV }, update: { isApproved: true, isActive: true }, create: { id: PV, name: 'PtV', email: `ptv${PV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: PC }, update: {}, create: { id: PC, venueId: PV, title: 'PtDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const soon = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: PS }, update: { startsAt: soon }, create: { id: PS, classId: PC, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 20, status: 'open' } })
    // Sporcu tier (pointRate %2) — booking pointsEarned=round(100*0.02)=2
    await prisma.user.upsert({ where: { id: PU }, update: { rewardPoints: 0, tierId: 2 }, create: { id: PU, username: `pt_${PU}`, email: `pt_${PU}@x.com`, passwordHash: 'x', fullName: 'Pt', rewardPoints: 0, tierId: 2, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: PU } }); await prisma.rewardPoint.deleteMany({ where: { userId: PU } })
    const utok = jwt.sign({ userId: PU, email: `pt_${PU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const bk = await http('/api/bookings', { method: 'POST', token: utok, body: { sessionId: PS } })
    if (bk.status !== 201) throw new Error(`rezervasyon: ${bk.status} ${bk.text.slice(0,120)}`)
    // REZERVASYON ANINDA puan 0 olmalı (no-show ile puan biriktirilemez)
    let u = await prisma.user.findUnique({ where: { id: PU }, select: { rewardPoints: true } })
    if (u?.rewardPoints !== 0) throw new Error(`rezervasyonda puan verildi: ${u?.rewardPoints} (0 bekleniyor — no-show farming)`)
    const bid = bk.json?.booking?.id || (await prisma.booking.findFirst({ where: { userId: PU }, select: { id: true } }))?.id
    // CHECK-IN → puan şimdi kredilenmeli (pointsEarned=2)
    await prisma.booking.update({ where: { id: bid }, data: { checkedIn: true, checkedInAt: new Date() } })
    await require('../src/controllers/bookingController').awardAttendanceOnCheckin(bid)
    u = await prisma.user.findUnique({ where: { id: PU }, select: { rewardPoints: true } })
    if (u?.rewardPoints !== 2) throw new Error(`check-in'de puan kredilenmedi: ${u?.rewardPoints} (2 bekleniyor)`)
    // İdempotent: ikinci çağrı çift kredilemez
    await require('../src/controllers/bookingController').awardAttendanceOnCheckin(bid)
    u = await prisma.user.findUnique({ where: { id: PU }, select: { rewardPoints: true } })
    if (u?.rewardPoints !== 2) throw new Error(`idempotent değil: ${u?.rewardPoints} (2 bekleniyor, çift kredi)`)
    await prisma.rewardPoint.deleteMany({ where: { userId: PU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: PU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: PS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: PC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: PV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: PU } }).catch(() => {})
  })


  await check('Gamification: liderlik branş filtresi kanonik kategoriyi kullanır (case drift yok)', async () => {
    // Kategori adı 'Yoga' ama ders category alanı 'yoga' (küçük) girilirse: eski filtre class.category='Yoga'
    // (case-sensitive) → kullanıcı liderlikte GÖRÜNMEZDİ. Kanonik sportCategory.name filtresi bunu düzeltir.
    const LV = 991201, LC = 991201, LS = 991201, LU = 991201
    const cat = await prisma.sportCategory.findFirst({ where: { name: { equals: catName, mode: 'insensitive' } }, select: { id: true, name: true } })
    await prisma.venue.upsert({ where: { id: LV }, update: { isApproved: true, isActive: true }, create: { id: LV, name: 'LbV', email: `lbv${LV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    // class.category KASITLI küçük harf (drift), ama sportCategoryId kanonik
    await prisma.class.upsert({ where: { id: LC }, update: { category: catName.toLowerCase(), sportCategoryId: cat!.id }, create: { id: LC, venueId: LV, title: 'LbDers', category: catName.toLowerCase(), sportCategoryId: cat!.id, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const past = new Date(Date.now() - 2 * 86400000) // sezon içi geçmiş
    await prisma.class_Session.upsert({ where: { id: LS }, update: { startsAt: past }, create: { id: LS, classId: LC, startsAt: past, endsAt: past, capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: LU }, update: {}, create: { id: LU, username: `lb_${LU}`, email: `lb_${LU}@x.com`, passwordHash: 'x', fullName: 'Lb', neighborhoodId: V, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: LU } })
    await prisma.booking.create({ data: { userId: LU, sessionId: LS, status: 'confirmed', checkedIn: true, checkedInAt: past, bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, venuePayout: 100, finalAmount: 100, bookingNumber: `LB-${Date.now()}` } })
    // branş = kanonik kategori adı (büyük harf) → kullanıcı GÖRÜNMELİ (ders category küçük harf olsa da)
    const r = await http(`/api/social/leaderboard/users?branch=${encodeURIComponent(cat!.name)}`)
    if (r.status !== 200) throw new Error(`liderlik: ${r.status} ${r.text.slice(0,120)}`)
    const found = Array.isArray(r.json?.leaderboard) && r.json.leaderboard.some((u: any) => u.username === `lb_${LU}`)
    if (!found) throw new Error('case-drift kullanıcı branş liderliğinde görünmedi (kanonik filtre yok)')
    await prisma.booking.deleteMany({ where: { userId: LU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: LS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: LC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: LV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: LU } }).catch(() => {})
  })

  await check('Gamification: kayıtta tierId atanır (ilk booking pointRate 0 değil)', async () => {
    const email = `tiertest_${Date.now()}@x.com`
    const r = await http('/api/auth/register', { method: 'POST', body: { fullName: 'Tier Test', username: `tiertest${Date.now()}`.slice(0, 20), email, password: 'GecerliSifre123' } })
    if (r.status !== 201 && r.status !== 200) throw new Error(`kayıt: ${r.status} ${r.text.slice(0,120)}`)
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true, tierId: true } })
    if (u?.tierId !== 1) throw new Error(`kayıtta tierId ${u?.tierId} (1=Aday bekleniyor) → ilk booking pointRate 0 olurdu`)
    await prisma.user.deleteMany({ where: { email } }).catch(() => {})
  })

  // ================== BİLDİRİM REGRESYONLARI (denetim turu 18) ==================
  await check('Bildirim: salon seansı silince pushToken\'siz kullanıcıya in-app Notification yazılır', async () => {
    const NV = 991101, NC = 991101, NS = 991101, NU = 991101
    await prisma.venue.upsert({ where: { id: NV }, update: { isApproved: true, isActive: true }, create: { id: NV, name: 'NotifV', email: `ntv${NV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: NC }, update: {}, create: { id: NC, venueId: NV, title: 'NotifDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const soon = new Date(Date.now() + 3 * 86400000)
    await prisma.class_Session.upsert({ where: { id: NS }, update: { startsAt: soon }, create: { id: NS, classId: NC, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 20, status: 'open' } })
    // pushToken YOK (web kullanıcısı) → eskiden hiçbir bildirim almıyordu
    await prisma.user.upsert({ where: { id: NU }, update: { pushToken: null }, create: { id: NU, username: `ntf_${NU}`, email: `ntf_${NU}@x.com`, passwordHash: 'x', fullName: 'Ntf', pushToken: null, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: NU } })
    await prisma.notification.deleteMany({ where: { userId: NU } })
    await prisma.booking.create({ data: { userId: NU, sessionId: NS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, venuePayout: 100, finalAmount: 100, bookingNumber: `NT-${Date.now()}` } })
    const vtok = jwt.sign({ venueId: NV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/venue/classes/${NC}/sessions/${NS}`, { method: 'DELETE', token: vtok })
    if (r.status !== 200) throw new Error(`seans silme: ${r.status} ${r.text.slice(0,120)}`)
    // REGRESYON: eskiden pushToken filtresi kullanıcıyı eliyordu → hiç bildirim yoktu
    const notif = await prisma.notification.count({ where: { userId: NU, type: 'booking_cancelled' } })
    if (notif === 0) throw new Error('pushToken\'siz kullanıcıya iptal in-app Notification yazılmadı')
    await prisma.notification.deleteMany({ where: { userId: NU } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: NC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: NV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: NU } }).catch(() => {})
  })

  await check('Bildirim: seans saati değişince rezervasyon sahibine bildirim + reminderSent sıfırlanır', async () => {
    const NV = 991102, NC = 991102, NS = 991102, NU = 991102
    await prisma.venue.upsert({ where: { id: NV }, update: { isApproved: true, isActive: true, isVerified: true }, create: { id: NV, name: 'ReschedV', email: `rsv${NV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, isVerified: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: NC }, update: {}, create: { id: NC, venueId: NV, title: 'ReschedDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const soon = new Date(Date.now() + 3 * 86400000)
    await prisma.class_Session.upsert({ where: { id: NS }, update: { startsAt: soon }, create: { id: NS, classId: NC, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: NU }, update: {}, create: { id: NU, username: `rsc_${NU}`, email: `rsc_${NU}@x.com`, passwordHash: 'x', fullName: 'Rsc', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: NU } })
    await prisma.notification.deleteMany({ where: { userId: NU } })
    // reminderSent=true → yeniden-planlama bunu false yapmalı (düzeltilmiş hatırlatma tekrar gitsin)
    await prisma.booking.create({ data: { userId: NU, sessionId: NS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, venuePayout: 100, finalAmount: 100, bookingNumber: `RS-${Date.now()}`, reminderSent: true } })
    const vtok = jwt.sign({ venueId: NV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    // Yeni saat: 5 gün sonra farklı bir saat
    const newDay = new Date(Date.now() + 5 * 86400000)
    const ymd = newDay.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' })
    const r = await http(`/api/venue/classes/${NC}/sessions/${NS}`, { method: 'PUT', token: vtok, body: { date: ymd, time: '18:00', capacity: 20 } })
    if (r.status !== 200) throw new Error(`seans güncelle: ${r.status} ${r.text.slice(0,120)}`)
    const notif = await prisma.notification.count({ where: { userId: NU, type: 'session_rescheduled' } })
    if (notif === 0) throw new Error('yeniden-planlamada rezervasyon sahibine bildirim yazılmadı')
    const bk = await prisma.booking.findFirst({ where: { userId: NU }, select: { reminderSent: true } })
    if (bk?.reminderSent !== false) throw new Error('reminderSent sıfırlanmadı (düzeltilmiş hatırlatma bastırılır)')
    await prisma.notification.deleteMany({ where: { userId: NU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: NU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: NS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: NC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: NV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: NU } }).catch(() => {})
  })

  // ================== GİRDİ/INJECTION REGRESYONLARI (denetim turu 16) ==================
  await check('Girdi: cashback e-postası classTitle esc()\'li (stored XSS guard, kaynak)', async () => {
    const fs = require('fs')
    const src = fs.readFileSync(__dirname + '/../src/utils/email.ts', 'utf8')
    // sendCashbackEmail gövdesinde classTitle YALNIZ esc() ile geçmeli. Ham ${classTitle} (esc'siz) regresyon.
    const fnStart = src.indexOf('export const sendCashbackEmail')
    const fnBody = src.slice(fnStart, fnStart + 2500)
    // esc'siz ${classTitle} arıyoruz: "${classTitle" ama öncesinde "esc(" yok
    if (/\$\{classTitle\}/.test(fnBody) && !/\$\{esc\(classTitle\)\}/.test(fnBody)) {
      throw new Error('sendCashbackEmail classTitle\'i esc()\'siz kullanıyor (stored XSS)')
    }
  })

  await check('Girdi: updateClass başlığı 120 karaktere kırpar (createClass ile simetrik)', async () => {
    const UV = 991001, UC = 991001
    await prisma.venue.upsert({ where: { id: UV }, update: { isApproved: true, isActive: true }, create: { id: UV, name: 'UpV', email: `upv${UV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: UC }, update: {}, create: { id: UC, venueId: UV, title: 'Eski', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const vtok = jwt.sign({ venueId: UV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const longTitle = 'A'.repeat(300)
    const r = await http(`/api/venue/classes/${UC}`, { method: 'PUT', token: vtok, body: { title: longTitle, description: 'D'.repeat(5000), basePrice: 'abc' } })
    if (r.status !== 200) throw new Error(`updateClass: ${r.status} ${r.text.slice(0,120)}`)
    const cls = await prisma.class.findUnique({ where: { id: UC }, select: { title: true, description: true } })
    if ((cls!.title?.length || 0) > 120) throw new Error(`title kırpılmadı: ${cls!.title?.length} karakter`)
    if ((cls!.description?.length || 0) > 2000) throw new Error(`description kırpılmadı: ${cls!.description?.length}`)
    await prisma.class.deleteMany({ where: { id: UC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: UV } }).catch(() => {})
  })

  await check('Girdi: geçersiz mahalle → 400 (parseIntSafe, 500 değil)', async () => {
    const PU = 991002
    await prisma.user.upsert({ where: { id: PU }, update: {}, create: { id: PU, username: `pf_${PU}`, email: `pf_${PU}@x.com`, passwordHash: 'x', fullName: 'Pf', tierSportCounts: {} } })
    const tok = jwt.sign({ userId: PU, email: `pf_${PU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/auth/profile', { method: 'PUT', token: tok, body: { neighborhoodId: 'abc' } })
    if (r.status === 500) throw new Error('geçersiz mahalle 500 verdi (parseIntSafe yok)')
    if (r.status !== 400) throw new Error(`geçersiz mahalle ${r.status} (400 bekleniyor)`)
    await prisma.user.deleteMany({ where: { id: PU } }).catch(() => {})
  })

  await check('Girdi: gizli aktivite like → 404 (existence-oracle kapalı)', async () => {
    // Var olmayan feedKey de 404 dönmeli; gizli-var-olan da 404 — ikisi ayırt edilememeli.
    const XU = 991003
    await prisma.user.upsert({ where: { id: XU }, update: {}, create: { id: XU, username: `lk_${XU}`, email: `lk_${XU}@x.com`, passwordHash: 'x', fullName: 'Lk', tierSportCounts: {} } })
    const tok = jwt.sign({ userId: XU, email: `lk_${XU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/social/feed/booking_999999999/like', { method: 'POST', token: tok })
    // Olmayan aktivite 404 olmalı (403 değil) — gizli olanla aynı yanıt
    if (r.status === 403) throw new Error('feed like 403 döndürdü (existence-oracle — 404 olmalı)')
    await prisma.user.deleteMany({ where: { id: XU } }).catch(() => {})
  })

  // ================== HATA YOLLARI REGRESYONLARI (denetim turu 15) ==================
  await check('Hata yolu: şifre değişince TÜM refresh oturumları iptal edilir (atomik)', async () => {
    const CU = 990901
    const bcryptLib = require('bcryptjs')
    await prisma.user.upsert({ where: { id: CU }, update: { passwordHash: await bcryptLib.hash('EskiSifre123', 12) }, create: { id: CU, username: `cp_${CU}`, email: `cp_${CU}@x.com`, passwordHash: await bcryptLib.hash('EskiSifre123', 12), fullName: 'Cp', tierSportCounts: {} } })
    await prisma.refreshToken.deleteMany({ where: { userId: CU } })
    await prisma.refreshToken.create({ data: { token: `rt-cp-${CU}-${Date.now()}`, userId: CU, expiresAt: new Date(Date.now() + 86400000) } })
    const tok = jwt.sign({ userId: CU, email: `cp_${CU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/auth/change-password', { method: 'PUT', token: tok, body: { currentPassword: 'EskiSifre123', newPassword: 'YeniSifre456' } })
    if (r.status !== 200) throw new Error(`şifre değiştir: ${r.status} ${r.text.slice(0,120)}`)
    // REGRESYON: revoke .catch(()=>{}) ile yutuluyordu → oturum açık kalabiliyordu
    const alive = await prisma.refreshToken.count({ where: { userId: CU, revoked: false } })
    if (alive !== 0) throw new Error(`şifre değişti ama ${alive} oturum hâlâ açık (0 bekleniyor)`)
    await prisma.refreshToken.deleteMany({ where: { userId: CU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: CU } }).catch(() => {})
  })

  await check('Hata yolu: ban içerik temizliği + token iptali ATOMİK (yorum kalmaz)', async () => {
    const BU = 990902, BV = 990902
    await prisma.venue.upsert({ where: { id: BV }, update: { isApproved: true, isActive: true }, create: { id: BV, name: 'BanV', email: `bnv${BV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.user.upsert({ where: { id: BU }, update: { banned: false }, create: { id: BU, username: `ban_${BU}`, email: `ban_${BU}@x.com`, passwordHash: 'x', fullName: 'Ban', tierSportCounts: {} } })
    await prisma.review.deleteMany({ where: { reviewerUserId: BU } })
    await prisma.review.create({ data: { reviewerUserId: BU, targetType: 'venue', venueId: BV, rating: 5 } })
    await prisma.refreshToken.deleteMany({ where: { userId: BU } })
    await prisma.refreshToken.create({ data: { token: `rt-ban-${BU}-${Date.now()}`, userId: BU, expiresAt: new Date(Date.now() + 86400000) } })
    const r = await http(`/api/admin/users/${BU}/ban`, { method: 'PUT', admin: true, body: { ban: true } })
    if (r.status !== 200) throw new Error(`ban: ${r.status} ${r.text.slice(0,120)}`)
    // Ban + purge + revoke atomik → yorum silinmeli, token iptal olmalı, kullanıcı banlı olmalı
    const reviews = await prisma.review.count({ where: { reviewerUserId: BU } })
    if (reviews !== 0) throw new Error(`banlı kullanıcının yorumu silinmedi: ${reviews}`)
    const aliveTok = await prisma.refreshToken.count({ where: { userId: BU, revoked: false } })
    if (aliveTok !== 0) throw new Error(`banlı kullanıcının token'ı iptal edilmedi: ${aliveTok}`)
    const u = await prisma.user.findUnique({ where: { id: BU }, select: { banned: true } })
    if (!u?.banned) throw new Error('kullanıcı banlanmadı')
    await prisma.refreshToken.deleteMany({ where: { userId: BU } }).catch(() => {})
    await prisma.review.deleteMany({ where: { reviewerUserId: BU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: BU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: BV } }).catch(() => {})
  })

  await check('Hata yolu: Sentry scrub opak token + bcrypt hash + IBAN maskeler', async () => {
    const { scrub } = require('../src/utils/sentry')
    const resetTok = 'a'.repeat(64) // reset token: 64 hex
    if (scrub(`link token=${resetTok}`)?.includes(resetTok)) throw new Error('64-hex reset token maskelenmedi')
    const bcryptH = '$2b$12$' + 'A'.repeat(53)
    if (scrub(`hash ${bcryptH}`)?.includes(bcryptH)) throw new Error('bcrypt hash maskelenmedi')
    if (scrub('iban TR33 0006 1005 1978 6457 8413 26')?.includes('6457')) throw new Error('IBAN maskelenmedi')
    // checkInCode (8 hex) yanlış-pozitif riskiyle KASITLI maskelenmiyor → kısa hex korunmalı
    if (scrub('kod ABCD1234')?.includes('ABCD1234') !== true) throw new Error('kısa kod yanlışlıkla maskelendi (checkInCode koruması bozuk)')
  })

  await check('Hata yolu: salon şifre-sıfırlama linki tek kullanımlık (atomik CAS)', async () => {
    const RV = 990903
    const bcryptLib = require('bcryptjs')
    await prisma.venue.upsert({ where: { id: RV }, update: {}, create: { id: RV, name: 'RstV', email: `rstv${RV}@x.com`, passwordHash: await bcryptLib.hash('eski', 12), address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.venuePasswordResetToken.deleteMany({ where: { venueId: RV } })
    const rtok = `vrst-${RV}-${Date.now()}`
    await prisma.venuePasswordResetToken.create({ data: { token: rtok, venueId: RV, expiresAt: new Date(Date.now() + 3600000) } })
    const r1 = await http('/api/venue/reset-password', { method: 'POST', body: { token: rtok, password: 'YeniSifre123' } })
    if (r1.status !== 200) throw new Error(`ilk sıfırlama: ${r1.status} ${r1.text.slice(0,120)}`)
    // İkinci kez AYNI token → CAS ile reddedilmeli (eskiden used CAS'siz, iki kez yazabiliyordu)
    const r2 = await http('/api/venue/reset-password', { method: 'POST', body: { token: rtok, password: 'BaskaSifre456' } })
    if (r2.status === 200) throw new Error('aynı salon sıfırlama linki İKİNCİ kez kullanılabildi')
    await prisma.venuePasswordResetToken.deleteMany({ where: { venueId: RV } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: RV } }).catch(() => {})
  })

  // ================== PARA MATEMATİĞİ REGRESYONLARI (denetim turu 14) ==================
  await check('Para: fixed kupon discountAmount money()\'li — defter özdeşliği tutar', async () => {
    const CV = 990801, CC = 990801, CS = 990801, CU = 990801
    await prisma.venue.upsert({ where: { id: CV }, update: { isApproved: true, isActive: true }, create: { id: CV, name: 'CpV', email: `cpv${CV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: CC }, update: {}, create: { id: CC, venueId: CV, title: 'CpD', category: catName, basePrice: 50, durationMinutes: 60, capacity: 20, isActive: true } })
    const soon = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: CS }, update: { startsAt: soon }, create: { id: CS, classId: CC, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: CU }, update: {}, create: { id: CU, username: `cp_${CU}`, email: `cp_${CU}@x.com`, passwordHash: 'x', fullName: 'Cp', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: CU } })
    // Kuruş-altı fixed kupon oluşturmayı DENE → 2 ondalığa yuvarlanmalı (9.999 → 10.00)
    await prisma.coupon.deleteMany({ where: { code: 'FIX999' } })
    const vtok = jwt.sign({ venueId: CV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const cr = await http('/api/venue/coupons', { method: 'POST', token: vtok, body: { code: 'FIX999', discountType: 'fixed', discountValue: 9.999 } })
    if (cr.status !== 201) throw new Error(`kupon oluşturma: ${cr.status} ${cr.text.slice(0,120)}`)
    const cpn = await prisma.coupon.findUnique({ where: { code: 'FIX999' }, select: { discountValue: true } })
    if (Math.round((cpn!.discountValue) * 1000) % 10 !== 0) throw new Error(`fixed kupon 2 ondalığa yuvarlanmadı: ${cpn!.discountValue}`)
    // Rezervasyonda defter özdeşliği: baseAmount = finalAmount + discountAmount (float tozu olmamalı)
    const utok = jwt.sign({ userId: CU, email: `cp_${CU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const bk = await http('/api/bookings', { method: 'POST', token: utok, body: { sessionId: CS, couponCode: 'FIX999' } })
    if (bk.status !== 201) throw new Error(`rezervasyon: ${bk.status} ${bk.text.slice(0,120)}`)
    const row = await prisma.booking.findFirst({ where: { userId: CU }, select: { baseAmount: true, finalAmount: true, discountAmount: true } })
    const drift = Math.abs(row!.baseAmount - (row!.finalAmount + row!.discountAmount))
    if (drift > 1e-9) throw new Error(`defter özdeşliği bozuk: baseAmount ${row!.baseAmount} != finalAmount ${row!.finalAmount} + discountAmount ${row!.discountAmount} (fark ${drift})`)
    await prisma.booking.deleteMany({ where: { userId: CU } }).catch(() => {})
    await prisma.coupon.deleteMany({ where: { code: 'FIX999' } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: CS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: CC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: CV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: CU } }).catch(() => {})
  })

  await check('Para: drop-in totalPrice money()\'li + sıfır/negatif fiyat reddedilir', async () => {
    const DV = 990802
    await prisma.venue.upsert({ where: { id: DV }, update: { isApproved: true, isActive: true, isVerified: true }, create: { id: DV, name: 'DpV', email: `dpv${DV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, isVerified: true, neighborhoodId: V, cityId: 1 } })
    // Drop-in'in izinli sporları (Basketbol/Padel/Halı Saha) katalogda YOK → endpoint 503 verip fiyat
    // kontrolüne HİÇ ulaşmıyor. Testin fiyat kontrolünü gerçekten sınaması için geçici kategori aç.
    // (İlk sürüm sport/format/kategori nedeniyle non-201 alıp fiyat kontrolünü atlıyordu — sabotaj yakaladı.)
    await prisma.sportCategory.upsert({ where: { id: 990802 }, update: {}, create: { id: 990802, name: 'Basketbol', iconUrl: 'basketball', colorHex: '#F59E0B' } }).catch(() => {})
    const vtok = jwt.sign({ venueId: DV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const base = { sport: 'Basketbol', format: '5v5 Tam Saha', date: '2027-01-01', time: '19:00' }
    // Negatif ve sıfır fiyat reddedilmeli (artık kategori var → fiyat kontrolüne ulaşılıyor)
    const neg = await http('/api/venue/dropin', { method: 'POST', token: vtok, body: { ...base, pricePerPerson: -5 } })
    if (neg.status === 201) throw new Error('negatif fiyatlı drop-in oluşturulabildi')
    const zero = await http('/api/venue/dropin', { method: 'POST', token: vtok, body: { ...base, pricePerPerson: 0 } })
    if (zero.status === 201) throw new Error('sıfır fiyatlı drop-in oluşturulabildi')
    // Geçerli ama float-tozu üreten fiyat: 10 oyuncu × 33.33 = 333.29999... → totalPrice money()'li olmalı
    const ok = await http('/api/venue/dropin', { method: 'POST', token: vtok, body: { ...base, pricePerPerson: 33.33 } })
    if (ok.status !== 201) throw new Error(`geçerli drop-in: ${ok.status} ${ok.text.slice(0,120)}`)
    const slot = await prisma.dropInSlot.findFirst({ where: { venueId: DV }, orderBy: { id: 'desc' }, select: { totalPrice: true } })
    if (Math.abs(slot!.totalPrice - Math.round(slot!.totalPrice * 100) / 100) > 1e-9) throw new Error(`totalPrice money()'li değil: ${slot!.totalPrice}`)
    await prisma.dropInSlot.deleteMany({ where: { venueId: DV } }).catch(() => {})
    await prisma.sportCategory.deleteMany({ where: { id: 990802 } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: DV } }).catch(() => {})
  })

  await check('Para: önceki yılda kazanılan puan, reset sonrası iptalde CARİ yılı düşürmez', async () => {
    const YU = 990803, YC = 990803, YS = 990803, YV = 990803
    await prisma.venue.upsert({ where: { id: YV }, update: { isApproved: true, isActive: true }, create: { id: YV, name: 'YrV', email: `yrv${YV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: YC }, update: {}, create: { id: YC, venueId: YV, title: 'YrD', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const future = new Date(Date.now() + 20 * 86400000)
    await prisma.class_Session.upsert({ where: { id: YS }, update: { startsAt: future }, create: { id: YS, classId: YC, startsAt: future, endsAt: new Date(future.getTime() + 3600000), capacity: 20, status: 'open' } })
    const thisYear = new Date().getUTCFullYear()
    // Kullanıcı: cari yılda 5 puanı VAR (meşru), rewardPointsYear = bu yıl
    await prisma.user.upsert({ where: { id: YU }, update: { rewardPoints: 5, rewardPointsYear: thisYear }, create: { id: YU, username: `yr_${YU}`, email: `yr_${YU}@x.com`, passwordHash: 'x', fullName: 'Yr', rewardPoints: 5, rewardPointsYear: thisYear, tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: YU } })
    // ÖNCEKİ yılda oluşturulmuş, 5 puan kazandırmış bir booking (createdAt geçen yıl)
    const lastYear = new Date(Date.UTC(thisYear - 1, 11, 20))
    await prisma.booking.create({ data: { userId: YU, sessionId: YS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, venuePayout: 100, finalAmount: 100, pointsEarned: 5, bookingNumber: `YR-${Date.now()}`, createdAt: lastYear, groupSize: 1 } })
    const utok = jwt.sign({ userId: YU, email: `yr_${YU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const bkId = (await prisma.booking.findFirst({ where: { userId: YU }, select: { id: true } }))!.id
    const r = await http(`/api/bookings/${bkId}/cancel`, { method: 'PUT', token: utok })
    if (r.status !== 200) throw new Error(`iptal: ${r.status} ${r.text.slice(0,120)}`)
    const after = await prisma.user.findUnique({ where: { id: YU }, select: { rewardPoints: true } })
    // REGRESYON: eskiden dec=min(5, 5)=5 → cari yılın meşru 5 puanı haksız silinirdi. Artık 5 kalmalı.
    if (after!.rewardPoints !== 5) throw new Error(`önceki yıl booking iptali cari puanı düşürdü: ${after!.rewardPoints} (5 bekleniyor)`)
    await prisma.booking.deleteMany({ where: { userId: YU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: YS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: YC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: YV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: YU } }).catch(() => {})
  })

  // ================== YETKI — İKİNCİ PARTİ REGRESYONLAR (turlar 12-13 test borcu) ==================
  await check('Yetki: askıya alınmış salona transfer YAPILAMAZ', async () => {
    const TV = 990711, TC = 990711, S1 = 990711, S2 = 990712, TU = 990711
    // Kaynak seans: normal aktif salon; hedef seans: askıya alınmış salon
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: TV, name: 'TrSrc', email: `trs${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    const TV2 = 990713
    await prisma.venue.upsert({ where: { id: TV2 }, update: { isApproved: true, isActive: false, isSuspended: true }, create: { id: TV2, name: 'TrDst', email: `trd${TV2}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: false, isSuspended: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TC }, update: {}, create: { id: TC, venueId: TV, title: 'TrSrcC', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const TC2 = 990712
    await prisma.class.upsert({ where: { id: TC2 }, update: {}, create: { id: TC2, venueId: TV2, title: 'TrDstC', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const soon = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: S1 }, update: { startsAt: soon }, create: { id: S1, classId: TC, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: S2 }, update: { startsAt: soon }, create: { id: S2, classId: TC2, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: TU }, update: {}, create: { id: TU, username: `tr_${TU}`, email: `tr_${TU}@x.com`, passwordHash: 'x', fullName: 'Tr', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: TU } })
    const bk = await prisma.booking.create({ data: { userId: TU, sessionId: S1, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, venuePayout: 100, finalAmount: 100, bookingNumber: `TR-${Date.now()}`, groupSize: 1 } })
    const utok = jwt.sign({ userId: TU, email: `tr_${TU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/bookings/${bk.id}/transfer`, { method: 'PUT', token: utok, body: { targetSessionId: S2 } })
    if (r.status === 200) throw new Error('askıya alınmış salona transfer başarılı oldu (engellenmedi)')
    await prisma.booking.deleteMany({ where: { userId: TU } }).catch(() => {})
    for (const id of [S1, S2]) await prisma.class_Session.deleteMany({ where: { id } }).catch(() => {})
    for (const id of [TC, TC2]) await prisma.class.deleteMany({ where: { id } }).catch(() => {})
    for (const id of [TV, TV2]) await prisma.venue.deleteMany({ where: { id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: TU } }).catch(() => {})
  })

  await check('Yetki: gizli profilin (profilePrivacy) favori listesi yabancıya kapalı', async () => {
    const FU = 990714
    await prisma.user.upsert({ where: { id: FU }, update: { profilePrivacy: 'private', activityPrivacy: 'public', banned: false }, create: { id: FU, username: `fav_${FU}`, email: `fav_${FU}@x.com`, passwordHash: 'x', fullName: 'Fav', profilePrivacy: 'private', tierSportCounts: {} } })
    // Kimlik doğrulaması OLMADAN (public uç) → gizli profilin favorileri dönmemeli
    const r = await http(`/api/favorites/user/fav_${FU}`)
    if (r.status !== 200) throw new Error(`favori uç: ${r.status}`)
    if (r.json?.private !== true) throw new Error('gizli profilin favori listesi yabancıya açıldı (profilePrivacy yok sayıldı)')
    await prisma.user.deleteMany({ where: { id: FU } }).catch(() => {})
  })

  await check('Yetki: banlı kullanıcının token\'ı optionalAuth\'ta viewer sayılmaz', async () => {
    const BU = 990715, OU = 990716
    // Gizli PROFİLLİ hedef (profilePrivacy=private) + onu ONAYLI takip eden ama BANLI bir kullanıcı.
    // Ban çalışıyorsa optionalAuth viewer kimliğini düşürür → istek anonim işlenir → gizli profil
    // yabancıya kapanır (isProfilePrivate:true). Ban kontrolü kalkarsa banlı, onaylı-takipçi
    // ayrıcalığıyla gizli profili AÇAR (isProfilePrivate düşer). Önce iki durumu ayırt edebildiğimizi
    // kanıtlarız: ONAYLI takipçi (banlı DEĞİL) gizli profili görebilmeli — kontrol grubu.
    await prisma.user.upsert({ where: { id: OU }, update: { profilePrivacy: 'private', banned: false }, create: { id: OU, username: `own_${OU}`, email: `own_${OU}@x.com`, passwordHash: 'x', fullName: 'Own', profilePrivacy: 'private', tierSportCounts: {} } })
    await prisma.user.upsert({ where: { id: BU }, update: { banned: true }, create: { id: BU, username: `bn_${BU}`, email: `bn_${BU}@x.com`, passwordHash: 'x', fullName: 'Bn', banned: true, tierSportCounts: {} } })
    await prisma.follow.deleteMany({ where: { followingId: OU } })
    await prisma.follow.create({ data: { followerId: BU, followingId: OU, status: 'accepted' } }).catch(() => {})
    const bnTok = jwt.sign({ userId: BU, email: `bn_${BU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/public/users/own_${OU}`, { token: bnTok })
    if (r.status !== 200) throw new Error(`public profil: ${r.status}`)
    // Banlı viewer düşürülmeli → gizli profil AÇILMAMALI
    if (r.json?.isProfilePrivate !== true) throw new Error('banlı kullanıcı onaylı-takipçi ayrıcalığıyla gizli profili gördü (optionalAuth ban kontrolü yok)')
    await prisma.follow.deleteMany({ where: { followingId: OU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [BU, OU] } } }).catch(() => {})
  })

  await check('Yetki: aynı çift için İKİNCİ açık şikayet oluşturulamaz', async () => {
    const RU = 990717, RT = 990718
    await prisma.user.upsert({ where: { id: RU }, update: {}, create: { id: RU, username: `rp_${RU}`, email: `rp_${RU}@x.com`, passwordHash: 'x', fullName: 'Rp', tierSportCounts: {} } })
    await prisma.user.upsert({ where: { id: RT }, update: {}, create: { id: RT, username: `rt_${RT}`, email: `rt_${RT}@x.com`, passwordHash: 'x', fullName: 'Rt', tierSportCounts: {} } })
    await prisma.report.deleteMany({ where: { reporterUserId: RU, reportedUserId: RT } })
    const tok = jwt.sign({ userId: RU, email: `rp_${RU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    await http('/api/social/report', { method: 'POST', token: tok, body: { username: `rt_${RT}`, reason: 'test' } })
    await http('/api/social/report', { method: 'POST', token: tok, body: { username: `rt_${RT}`, reason: 'test2' } })
    const open = await prisma.report.count({ where: { reporterUserId: RU, reportedUserId: RT, status: 'open' } })
    if (open > 1) throw new Error(`aynı çift için ${open} açık şikayet var (1 bekleniyor)`)
    await prisma.report.deleteMany({ where: { reporterUserId: RU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [RU, RT] } } }).catch(() => {})
  })

  // ================== YETKI / IDOR REGRESYONLARI (denetim turu 13) ==================
  await check('Yetki: getVenueBookings checkInCode ve komisyon SIZDIRMAZ', async () => {
    const AV = 990701, AC = 990701, AS = 990701, AU = 990701
    await prisma.venue.upsert({ where: { id: AV }, update: { isApproved: true, isActive: true }, create: { id: AV, name: 'AuthVenue', email: `av${AV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: AC }, update: {}, create: { id: AC, venueId: AV, title: 'AuthDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const when = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: AS }, update: { startsAt: when }, create: { id: AS, classId: AC, startsAt: when, endsAt: new Date(when.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: AU }, update: {}, create: { id: AU, username: `auth_${AU}`, email: `auth_${AU}@x.com`, passwordHash: 'x', fullName: 'Auth', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { sessionId: AS } })
    await prisma.booking.create({ data: { userId: AU, sessionId: AS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 15, venueCommission: 15, venuePayout: 85, finalAmount: 100, bookingNumber: `AV-${Date.now()}`, checkInCode: 'SECRET99' } })
    const vtok = jwt.sign({ venueId: AV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/venue/bookings', { token: vtok })
    if (r.status !== 200) throw new Error(`venue bookings: ${r.status}`)
    const blob = JSON.stringify(r.json)
    if (blob.includes('SECRET99')) throw new Error('checkInCode salona SIZDI (müşteri adına check-in yapabilir)')
    if (blob.includes('venuePayout') || blob.includes('commissionAmount')) throw new Error('komisyon kırılımı yanıtta')
    // Tur20: finalAmount (müşterinin ödediği tutar) DÖNMELİ — include→select geçişinde düşmüştü,
    // web+mobil salon paneli "₺undefined" basıyordu. Komisyon gizli, ödenen tutar görünür.
    if (r.json?.bookings?.[0]?.finalAmount !== 100) throw new Error(`finalAmount dönmüyor (${r.json?.bookings?.[0]?.finalAmount}) — salon paneli ₺undefined gösterir`)
    await prisma.booking.deleteMany({ where: { sessionId: AS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: AS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: AC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: AV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: AU } }).catch(() => {})
  })

  await check('Yetki: banUser boolean olmayan ban alanını reddeder (sessiz unban yok)', async () => {
    const BU = 990702
    await prisma.user.upsert({ where: { id: BU }, update: { banned: true }, create: { id: BU, username: `ban_${BU}`, email: `ban_${BU}@x.com`, passwordHash: 'x', fullName: 'Ban', banned: true, tierSportCounts: {} } })
    // ban alanı YOK → eskiden !!undefined=false ile SESSİZCE unban oluyordu
    const r = await http(`/api/admin/users/${BU}/ban`, { method: 'PUT', admin: true, body: {} })
    if (r.status !== 400) throw new Error(`eksik ban alanı ${r.status} döndü (400 bekleniyor)`)
    const still = await prisma.user.findUnique({ where: { id: BU }, select: { banned: true } })
    if (!still?.banned) throw new Error('boş gövde kullanıcının banını SESSİZCE kaldırdı')
    await prisma.user.deleteMany({ where: { id: BU } }).catch(() => {})
  })

  await check('Yetki: askıya alınmış salonun eğitmeni check-in YAPAMAZ', async () => {
    const SV = 990703, SC = 990703, SS = 990703, SI = 990703, SU = 990703
    await prisma.venue.upsert({ where: { id: SV }, update: { isApproved: true, isActive: false, isSuspended: true }, create: { id: SV, name: 'SuspVenue', email: `sv${SV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: false, isSuspended: true, neighborhoodId: V, cityId: 1 } })
    await prisma.instructor.upsert({ where: { id: SI }, update: { isActive: true, venueId: SV }, create: { id: SI, venueId: SV, fullName: 'Susp Hoca', isActive: true } })
    await prisma.class.upsert({ where: { id: SC }, update: { instructorId: SI }, create: { id: SC, venueId: SV, instructorId: SI, title: 'SuspDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const soon = new Date(Date.now() + 10 * 60000)
    await prisma.class_Session.upsert({ where: { id: SS }, update: { startsAt: soon }, create: { id: SS, classId: SC, startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: SU }, update: {}, create: { id: SU, username: `susp_${SU}`, email: `susp_${SU}@x.com`, passwordHash: 'x', fullName: 'Susp', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { sessionId: SS } })
    await prisma.booking.create({ data: { userId: SU, sessionId: SS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, venuePayout: 100, finalAmount: 100, bookingNumber: `SV-${Date.now()}`, checkInCode: 'SUSP1234' } })
    const itok = jwt.sign({ instructorId: SI, role: 'instructor' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/instructor/checkin', { method: 'POST', token: itok, body: { code: 'SUSP1234' } })
    if (r.status !== 403) throw new Error(`askıya alınmış salonun eğitmeni check-in yaptı: ${r.status} (403 bekleniyor)`)
    const bk = await prisma.booking.findFirst({ where: { sessionId: SS }, select: { checkedIn: true } })
    if (bk?.checkedIn) throw new Error('donmuş salonda check-in yazıldı')
    await prisma.booking.deleteMany({ where: { sessionId: SS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: SS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: SC } }).catch(() => {})
    await prisma.instructor.deleteMany({ where: { id: SI } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: SV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: SU } }).catch(() => {})
  })

  await check('Yetki: geçmiş/kapalı seansın bekleme listesine girilemez', async () => {
    const WV = 990704, WC = 990704, WS = 990704, WU = 990704
    await prisma.venue.upsert({ where: { id: WV }, update: { isApproved: true, isActive: true }, create: { id: WV, name: 'WlV', email: `wlv${WV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: WC }, update: {}, create: { id: WC, venueId: WV, title: 'WlD', category: catName, basePrice: 100, durationMinutes: 60, capacity: 1, isActive: true } })
    const past = new Date(Date.now() - 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: WS }, update: { startsAt: past }, create: { id: WS, classId: WC, startsAt: past, endsAt: new Date(past.getTime() + 3600000), capacity: 1, status: 'open' } })
    await prisma.user.upsert({ where: { id: WU }, update: {}, create: { id: WU, username: `wlu_${WU}`, email: `wlu_${WU}@x.com`, passwordHash: 'x', fullName: 'Wlu', tierSportCounts: {} } })
    const utok = jwt.sign({ userId: WU, email: `wlu_${WU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/waitlist/sessions/${WS}`, { method: 'POST', token: utok })
    if (r.status !== 400) throw new Error(`geçmiş seansa bekleme listesi: ${r.status} (400 bekleniyor)`)
    await prisma.waitlist.deleteMany({ where: { sessionId: WS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: WS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: WC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: WV } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: WU } }).catch(() => {})
  })

  // ================== EŞZAMANLILIK REGRESYONLARI (denetim turu 12) ==================
  await check('Eşzamanlılık: parola sıfırlama TÜM oturumları kapatır ve token tek kullanımlık', async () => {
    const PU = 990601
    const bcryptLib = require('bcryptjs')
    await prisma.user.upsert({ where: { id: PU }, update: {}, create: { id: PU, username: `pw_${PU}`, email: `pw_${PU}@x.com`, passwordHash: await bcryptLib.hash('EskiSifre123', 12), fullName: 'Pw', tierSportCounts: {} } })
    await prisma.refreshToken.deleteMany({ where: { userId: PU } })
    await prisma.refreshToken.create({ data: { token: `rt-old-${PU}-${Date.now()}`, userId: PU, expiresAt: new Date(Date.now() + 86400000) } })
    await prisma.passwordResetToken.deleteMany({ where: { userId: PU } })
    const rt = `reset-${PU}-${Date.now()}`
    await prisma.passwordResetToken.create({ data: { token: rt, userId: PU, expiresAt: new Date(Date.now() + 3600000) } })
    const r1 = await http('/api/auth/reset-password', { method: 'POST', body: { token: rt, password: 'YeniSifre123' } })
    if (r1.status !== 200) throw new Error(`sıfırlama: ${r1.status} ${r1.text.slice(0, 160)}`)
    // REGRESYON: revoke `.catch(()=>{})` ile yutuluyordu → eski oturum ayakta kalabiliyordu
    const alive = await prisma.refreshToken.count({ where: { userId: PU, revoked: false } })
    if (alive !== 0) throw new Error(`parola değişti ama ${alive} oturum hâlâ açık (0 bekleniyor)`)
    // Aynı token ikinci kez kullanılamaz (CAS)
    const r2 = await http('/api/auth/reset-password', { method: 'POST', body: { token: rt, password: 'BaskaSifre123' } })
    if (r2.status === 200) throw new Error('aynı sıfırlama token\'ı İKİNCİ kez kullanılabildi')
    await prisma.refreshToken.deleteMany({ where: { userId: PU } }).catch(() => {})
    await prisma.passwordResetToken.deleteMany({ where: { userId: PU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: PU } }).catch(() => {})
  })

  await check('Eşzamanlılık: aynı ders+saat için İKİ seans oluşturulamaz (DB tekilliği)', async () => {
    const TV = 990602, TC = 990602
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true, isVerified: true }, create: { id: TV, name: 'CcVenue', email: `cc${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, isVerified: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TC }, update: {}, create: { id: TC, venueId: TV, title: 'CcDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class_Session.deleteMany({ where: { classId: TC } })
    const when = new Date(Date.now() + 5 * 86400000)
    await prisma.class_Session.create({ data: { classId: TC, startsAt: when, endsAt: new Date(when.getTime() + 3600000), capacity: 20, status: 'open' } })
    // REGRESYON: (classId, startsAt) tekilliği yoktu → çift gönderim iki seans üretiyor, kontenjan ikiye bölünüyordu
    let ikinciOlustu = false
    try {
      await prisma.class_Session.create({ data: { classId: TC, startsAt: when, endsAt: new Date(when.getTime() + 3600000), capacity: 20, status: 'open' } })
      ikinciOlustu = true
    } catch (e: any) { if (e?.code !== 'P2002') throw e }
    if (ikinciOlustu) throw new Error('aynı ders+saat için ikinci seans oluşabildi (DB tekilliği yok)')
    await prisma.class_Session.deleteMany({ where: { classId: TC } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: TC } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
  })

  await check('Eşzamanlılık: drop-in check-in İKİ kez başarılı dönemez (atomik CAS)', async () => {
    const TV = 990603, TU = 990603
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true }, create: { id: TV, name: 'CcVenue2', email: `cc${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.user.upsert({ where: { id: TU }, update: {}, create: { id: TU, username: `cc_${TU}`, email: `cc_${TU}@x.com`, passwordHash: 'x', fullName: 'Cc', tierSportCounts: {} } })
    const cat = await prisma.sportCategory.findFirst({ where: { name: { equals: catName, mode: 'insensitive' } }, select: { id: true } })
    const now = new Date(Date.now() + 10 * 60000) // 10 dk sonra → check-in penceresi AÇIK
    const slot = await prisma.dropInSlot.create({ data: { venueId: TV, sportCategoryId: cat!.id, title: 'CcDropIn', startsAt: now, endsAt: new Date(now.getTime() + 3600000), pricePerPerson: 100, totalPrice: 400, totalPlayers: 4, format: '2x2', status: 'open', visibility: 'open' } })
    const code = `CC${Date.now()}`.slice(0, 12).toUpperCase()
    await prisma.dropInParticipant.create({ data: { slotId: slot.id, userId: TU, status: 'confirmed', checkInCode: code } })
    const tok = jwt.sign({ venueId: TV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    // İKİ İSTEĞİ AYNI ANDA gönder — oku-sonra-yaz olsaydı ikisi de success dönerdi
    const [a, b] = await Promise.all([
      http('/api/bookings/dropin-checkin', { method: 'POST', token: tok, body: { code } }),
      http('/api/bookings/dropin-checkin', { method: 'POST', token: tok, body: { code } }),
    ])
    const basarili = [a, b].filter(r => r.json?.success === true).length
    if (basarili !== 1) throw new Error(`eşzamanlı iki check-in'den ${basarili} tanesi 'success' döndü (tam 1 bekleniyor)`)
    await prisma.dropInParticipant.deleteMany({ where: { slotId: slot.id } }).catch(() => {})
    await prisma.dropInSlot.deleteMany({ where: { id: slot.id } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: TU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
  })

  await check('Eşzamanlılık: bekleme listesinde \'notified\' kalıcı dışlama DEĞİL (süre aşımı)', async () => {
    const TV = 990604, TC = 990604, TS = 990604, TU = 990604
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true }, create: { id: TV, name: 'WlVenue', email: `wl${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TC }, update: {}, create: { id: TC, venueId: TV, title: 'WlDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 1, isActive: true } })
    const when = new Date(Date.now() + 3 * 86400000)
    await prisma.class_Session.upsert({ where: { id: TS }, update: { startsAt: when }, create: { id: TS, classId: TC, startsAt: when, endsAt: new Date(when.getTime() + 3600000), capacity: 1, status: 'open' } })
    await prisma.user.upsert({ where: { id: TU }, update: {}, create: { id: TU, username: `wl_${TU}`, email: `wl_${TU}@x.com`, passwordHash: 'x', fullName: 'Wl', tierSportCounts: {} } })
    await prisma.waitlist.deleteMany({ where: { sessionId: TS } })
    // 31 dakika önce bildirilmiş ama yeri kapamamış bekleyen → yeniden seçilebilmeli
    await prisma.waitlist.create({ data: { sessionId: TS, userId: TU, status: 'notified', notifiedAt: new Date(Date.now() - 31 * 60000) } })
    const { notifyFirstWaitlistUser } = require('../src/controllers/waitlistController')
    await notifyFirstWaitlistUser(TS)
    const row = await prisma.waitlist.findFirst({ where: { sessionId: TS, userId: TU }, select: { notifiedAt: true } })
    // REGRESYON: 'notified' kalıcıydı → notifiedAt hiç tazelenmez, kullanıcı bir daha ASLA bildirim almazdı
    if (!row?.notifiedAt || row.notifiedAt.getTime() < Date.now() - 5 * 60000) {
      throw new Error('süresi geçmiş \'notified\' bekleyen yeniden bildirilmedi (kalıcı dışlama)')
    }
    await prisma.waitlist.deleteMany({ where: { sessionId: TS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: TS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: TC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: TU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
  })

  await check('Saat dilimi: trFormat yardımcıları gece yarısı sınırında doğru', async () => {
    const { trYmd, trWeekday, trInstant, trAddDays, trMonthStart } = require('../src/utils/trFormat')
    // İstanbul 5 Ağu 2026 01:00 = UTC 4 Ağu 22:00 → TR günü 5 Ağustos olmalı (UTC'de 4'ü)
    const gece = new Date('2026-08-04T22:00:00.000Z')
    if (trYmd(gece) !== '2026-08-05') throw new Error(`trYmd=${trYmd(gece)} (2026-08-05 bekleniyor)`)
    if (trWeekday(gece) !== 3) throw new Error(`trWeekday=${trWeekday(gece)} (Çarşamba=3 bekleniyor)`)
    if (trInstant('2026-08-03', '19:00').toISOString() !== '2026-08-03T16:00:00.000Z') throw new Error('trInstant TR duvar-saatini UTC\'ye çevirmiyor')
    if (trAddDays('2026-08-31', 1) !== '2026-09-01') throw new Error('trAddDays ay sınırında hatalı')
    if (trMonthStart(gece).toISOString() !== '2026-07-31T21:00:00.000Z') throw new Error(`trMonthStart=${trMonthStart(gece).toISOString()} (1 Ağu 00:00 TR bekleniyor)`)
    if (trMonthStart(gece, -1).toISOString() !== '2026-06-30T21:00:00.000Z') throw new Error('trMonthStart(-1) hatalı')
  })

  // ===== ERTELENEN TEKNİK BORÇ BATCH REGRESYONLARI =====

  // #48 Refresh token AT-REST HASH: DB'de ham token değil sha256 parmak izi saklanır (düz metin sızıntı riski kapalı)
  await check('Auth: refresh token DB\'de hash olarak saklanır (düz metin değil)', async () => {
    const nodeCrypto = require('crypto')
    const { issueRefreshToken, rotateAccessToken } = require('../src/utils/refreshToken')
    const uid = 990361
    await prisma.user.upsert({ where: { id: uid }, update: { tierSportCounts: {} }, create: { id: uid, username: `rt_${uid}`, email: `rt_${uid}@x.com`, passwordHash: 'x', fullName: 'RT', tierSportCounts: {} } })
    const raw = await issueRefreshToken(uid)
    const stored = await prisma.refreshToken.findFirst({ where: { userId: uid }, orderBy: { id: 'desc' }, select: { token: true } })
    if (!stored) throw new Error('refresh token DB\'ye yazılmadı')
    if (stored.token === raw) throw new Error('refresh token DÜZ METİN saklanıyor (hash bekleniyordu)')
    if (stored.token !== nodeCrypto.createHash('sha256').update(raw).digest('hex')) throw new Error('saklanan değer sha256(raw) değil')
    if (!(await rotateAccessToken(raw))) throw new Error('ham refresh token ile access token alınamadı')
    if (await rotateAccessToken('deadbeef-gecersiz')) throw new Error('geçersiz refresh token access token verdi')
  })

  // #48 Silinen/olmayan kullanıcı token'ı: DB'de yoksa authMiddleware 401 (eskiden req.userId=silinmiş-id ile geçiyordu)
  await check('Auth: olmayan kullanıcı token\'ı 401 (authstate missing)', async () => {
    const ghost = 990369
    await prisma.user.deleteMany({ where: { id: ghost } }).catch(() => {})
    const ghostTok = jwt.sign({ userId: ghost, email: 'ghost@x.com' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/auth/me', { token: ghostTok })
    if (r.status !== 401) throw new Error(`olmayan kullanıcı /me ${r.status} (401 bekleniyor)`)
  })

  // Tur19 pointRate stale: puan check-in ANINDAKİ güncel tier oranıyla hesaplanır + booking.pointsEarned güncellenir
  await check('Puan: check-in\'de GÜNCEL tier oranıyla yeniden hesaplanır (stale değil)', async () => {
    const { awardAttendanceOnCheckin } = require('../src/controllers/bookingController')
    const uid = 990362, sid = 990362, cid = 990362
    const loT = await prisma.tier.findFirst({ where: { pointRate: { gt: 0 } }, orderBy: { pointRate: 'asc' } })
    const hiT = await prisma.tier.findFirst({ orderBy: { pointRate: 'desc' } })
    if (!loT || !hiT || loT.pointRate >= hiT.pointRate) throw new Error('kurulum: farklı oranlı iki tier yok')
    await prisma.user.upsert({ where: { id: uid }, update: { tierId: loT.id, rewardPoints: 0 }, create: { id: uid, username: `pr_${uid}`, email: `pr_${uid}@x.com`, passwordHash: 'x', fullName: 'PR', tierSportCounts: {}, tierId: loT.id, rewardPoints: 0 } })
    await prisma.class.upsert({ where: { id: cid }, update: {}, create: { id: cid, venueId: V, title: 'PR Class', category: 'Yoga', basePrice: 1000, durationMinutes: 60, capacity: 10, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: sid }, update: { classId: cid, startsAt: new Date(Date.now() - 7200000), endsAt: new Date(Date.now() - 3600000) }, create: { id: sid, classId: cid, startsAt: new Date(Date.now() - 7200000), endsAt: new Date(Date.now() - 3600000), capacity: 10, status: 'open' } })
    const finalAmount = 1000
    const stalePts = Math.round(finalAmount * loT.pointRate / 100)   // rezervasyon-anı (düşük) oranı
    const freshPts = Math.round(finalAmount * hiT.pointRate / 100)   // check-in-anı (yüksek) oranı
    await prisma.rewardPoint.deleteMany({ where: { userId: uid } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: uid } }).catch(() => {})
    const b = await prisma.booking.create({ data: { userId: uid, sessionId: sid, status: 'confirmed', bookingType: 'class', baseAmount: finalAmount, commissionAmount: 0, venueCommission: 0, finalAmount, venuePayout: finalAmount, bookingNumber: `PR-${Date.now()}`, checkedIn: true, pointsEarned: stalePts } })
    await prisma.user.update({ where: { id: uid }, data: { tierId: hiT.id } }) // check-in'e kadar tier atladı
    await awardAttendanceOnCheckin(b.id)
    const ledger = await prisma.rewardPoint.findFirst({ where: { bookingId: b.id, source: 'attendance' }, select: { points: true } })
    if (ledger?.points !== freshPts) throw new Error(`ledger ${ledger?.points}, güncel-oran ${freshPts} bekleniyor (stale ${stalePts})`)
    const bAfter = await prisma.booking.findUnique({ where: { id: b.id }, select: { pointsEarned: true } })
    if (bAfter?.pointsEarned !== freshPts) throw new Error(`booking.pointsEarned ${bAfter?.pointsEarned}, ${freshPts} bekleniyor (iptal-geri-alma tutarlılığı)`)
  })

  // Tur19 getVenueLeaderboard min-güven (Wilson alt sınırı): çok-yorumlu 4.5, tek-yorumlu 5.0'ı geçer; yorumsuz görünmez
  await check('Liderlik: salon Wilson alt-sınır sıralama (çok-yorumlu 4.5 > tek-yorumlu 5.0, yorumsuz yok)', async () => {
    const nb = 990363, vLo = 990363, vHi = 990364, vZero = 990365
    await prisma.neighborhood.upsert({ where: { id: nb }, update: {}, create: { id: nb, name: 'BayesMah', latitude: 41, longitude: 29, cityId: 1 } })
    const mk = (id: number, avg: number, tot: number) => prisma.venue.upsert({ where: { id }, update: { isApproved: true, isActive: true, avgRating: avg, totalReviews: tot, neighborhoodId: nb }, create: { id, name: `Bayes${id}`, email: `bayes${id}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, avgRating: avg, totalReviews: tot, neighborhoodId: nb, cityId: 1 } })
    await mk(vLo, 5.0, 1); await mk(vHi, 4.5, 200); await mk(vZero, 0, 0)
    const r = await expectOk(`/api/social/leaderboard/venues?neighborhoodId=${nb}`)
    const lb = (r.json?.leaderboard || []).filter((v: any) => [vLo, vHi, vZero].includes(v.id))
    const idx = (id: number) => lb.findIndex((v: any) => v.id === id)
    if (idx(vHi) === -1 || idx(vLo) === -1) throw new Error('yorumlu iki salon da listede değil')
    if (idx(vHi) > idx(vLo)) throw new Error('çok-yorumlu 4.5, tek-yorumlu 5.0 altında kaldı (Bayesian yok)')
    if (idx(vZero) !== -1) throw new Error('yorumsuz salon liderlikte görünüyor (min-yorum eşiği yok)')
  })

  // Tur19 getMyCalendar startsAt<now: gelecekteki bir seansta checkedIn olsa bile takvime/seriye girmez
  await check('Takvim: gelecekteki check-in\'li seans takvime/seriye girmez (startsAt<now)', async () => {
    const uid = 990366
    await prisma.user.upsert({ where: { id: uid }, update: { tierSportCounts: {} }, create: { id: uid, username: `cal_${uid}`, email: `cal_${uid}@x.com`, passwordHash: 'x', fullName: 'Cal', tierSportCounts: {} } })
    await prisma.booking.deleteMany({ where: { userId: uid } }).catch(() => {})
    await prisma.booking.create({ data: { userId: uid, sessionId: S, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `CAL-${Date.now()}`, checkedIn: true } }) // S = +2 gün (gelecek)
    const tok = jwt.sign({ userId: uid, email: `cal_${uid}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await expectOk('/api/social/my-calendar', { token: tok })
    if ((r.json?.activities || []).length !== 0) throw new Error(`gelecekteki check-in takvime girdi (${r.json?.activities?.length})`)
    if (r.json?.dailyStreak !== 0) throw new Error(`gelecekteki check-in dailyStreak'i şişirdi (${r.json?.dailyStreak})`)
  })

  // Çıkışta cihazın push token'ı temizlenmeli. REGRESYON: refresh token at-rest HASH'e geçirilince
  // logout'taki DOĞRUDAN `findUnique({token: raw})` sorgusu sessizce hep null dönmeye başlamış,
  // push token hiç temizlenmiyordu (çıkış yapan cihaza bildirim gitmeye devam ederdi).
  await check('Auth: çıkışta cihazın push token\'ı temizlenir (hash\'li arama)', async () => {
    const { issueRefreshToken } = require('../src/utils/refreshToken')
    const uid = 990381
    await prisma.refreshToken.deleteMany({ where: { userId: uid } }).catch(() => {})
    await prisma.user.upsert({ where: { id: uid }, update: { tierSportCounts: {}, pushToken: 'ExponentPushToken[smoke-logout]' }, create: { id: uid, username: `lo_${uid}`, email: `lo_${uid}@x.com`, passwordHash: 'x', fullName: 'LO', tierSportCounts: {}, pushToken: 'ExponentPushToken[smoke-logout]' } })
    const raw = await issueRefreshToken(uid)
    const r = await http('/api/auth/logout', { method: 'POST', body: { refreshToken: raw } })
    if (r.status !== 200) throw new Error(`logout ${r.status}`)
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { pushToken: true } })
    if (u?.pushToken) throw new Error(`çıkışta pushToken temizlenmedi ("${u.pushToken}") — ham/hash uyumsuzluğu`)
    const rt = await prisma.refreshToken.findFirst({ where: { userId: uid }, select: { revoked: true } })
    if (rt && !rt.revoked) throw new Error('refresh token iptal edilmedi')
  })

  // Onayı KALDIRILMIŞ salon seans GÜNCELLEYEMEZ (kardeş create uçlarıyla simetri) — aksi halde
  // rezervasyonlu müşterilere 3 kanaldan bildirim göndermeye devam edebiliyordu. SİLME serbest kalır
  // (temizlik/iptal hakkı), bu test onu da doğrular.
  await check('Yetki: onayı kaldırılmış salon seans GÜNCELLEYEMEZ (silebilir)', async () => {
    const UV = 990391, UC = 990391, US = 990391
    await prisma.booking.deleteMany({ where: { session: { classId: UC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: US } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: UC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: UV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: UV, name: 'UnapprV', email: `uv${UV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: UC }, update: {}, create: { id: UC, venueId: UV, title: 'Unappr Class', category: 'Yoga', basePrice: 100, durationMinutes: 60, capacity: 10, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: US }, update: { classId: UC, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000) }, create: { id: US, classId: UC, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), capacity: 10, status: 'open' } })
    const tok = jwt.sign({ venueId: UV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const { trYmd } = require('../src/utils/trFormat')
    const body = { date: trYmd(new Date(Date.now() + 4 * 86400000)), time: '10:00', capacity: 10 }
    // ONAYLIYKEN güncelleyebilmeli (kurulum doğrulaması — test yanlış sebeple yeşil olmasın)
    const okRes = await http(`/api/venue/classes/${UC}/sessions/${US}`, { method: 'PUT', token: tok, body })
    if (okRes.status === 403) throw new Error('onaylı salon güncelleyemedi (kurulum hatalı)')
    // ONAY KALDIRILINCA 403
    await prisma.venue.update({ where: { id: UV }, data: { isApproved: false } })
    const r = await http(`/api/venue/classes/${UC}/sessions/${US}`, { method: 'PUT', token: tok, body })
    if (r.status !== 403) throw new Error(`onaysız salon seans güncelleyebildi: ${r.status}`)
    // SİLME hâlâ serbest olmalı (müşteriyi ortada bırakmama)
    const d = await http(`/api/venue/classes/${UC}/sessions/${US}`, { method: 'DELETE', token: tok })
    if (d.status === 403) throw new Error('onaysız salon kendi seansını silemedi (temizlik hakkı kapanmış)')
  })

  // Askıya alınmış salonun drop-in ilanı public listede GÖRÜNMEMELİ (kardeş public uçlarla simetri)
  await check('Gizlilik: askıya alınmış salonun drop-in ilanı public listede yok', async () => {
    const DV = 990392, DS = 990392
    const cat = await prisma.sportCategory.findFirst({})
    if (!cat) throw new Error('kurulum: sportCategory yok')
    await prisma.dropInParticipant.deleteMany({ where: { slotId: DS } }).catch(() => {})
    await prisma.dropInSlot.deleteMany({ where: { id: DS } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: DV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: DV, name: 'DropSuspV', email: `dsv${DV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    const soon = new Date(Date.now() + 2 * 86400000)
    await prisma.dropInSlot.create({ data: { id: DS, venueId: DV, sportCategoryId: cat.id, title: 'Susp Slot', startsAt: soon, endsAt: new Date(soon.getTime() + 3600000), format: '5v5', totalPlayers: 10, totalPrice: 100, pricePerPerson: 10, status: 'open', visibility: 'open' } })
    const before = await expectOk('/api/public/dropin')
    if (!(before.json?.slots || []).some((s: any) => s.id === DS)) throw new Error('onaylı salonun slotu listede yok (kurulum hatalı)')
    await prisma.venue.update({ where: { id: DV }, data: { isActive: false } })
    const after = await expectOk('/api/public/dropin')
    if ((after.json?.slots || []).some((s: any) => s.id === DS)) throw new Error('askıya alınmış salonun drop-in ilanı public listede KALDI')
  })

  // KOPYA-KURAL SÜRÜKLENMESİ GUARD'I. Gerçek kural (bookingController: <12s iptal YOK, >=24s tam,
  // 12-24s YARIM) ile satın alma noktasındaki metin ayrışmıştı: "12 saat öncesine kadar ücretsiz
  // iptal" yarım-iade penceresini gizliyordu (para konusunda yanıltıcı). Bu test hem backend kuralının
  // hem de istemci metinlerinin birlikte değişmesini zorlar. Kardeş repo yoksa (CI) metin kısmı atlanır.
  await check('Kopya: iptal/iade metni backend kuralıyla tutarlı (yarım-iade penceresi gizlenmiyor)', async () => {
    const fs = require('fs'), path = require('path')
    // 1) Backend kuralı hâlâ 12/24 mü? (kural değişirse metinler de gözden geçirilmeli)
    const bc = fs.readFileSync(path.join(__dirname, '../src/controllers/bookingController.ts'), 'utf8')
    if (!/freshHours\s*<\s*12/.test(bc)) throw new Error('12 saat iptal kapısı bulunamadı — kural değişmişse metinler de güncellenmeli')
    // Tur20: kurala MUAFİYET eklendi (salon ertelerse tam iade) → regex yeni ifadeye göre.
    if (!/salonErteledi\s*\|\|\s*freshHours\s*>=\s*24\s*\)\s*\?\s*'full'\s*:\s*'half'/.test(bc)) throw new Error('24s tam / 12-24s yarım kuralı bulunamadı — metinler gözden geçirilmeli')
    // Erteleme muafiyeti kullanıcıya DUYURULMALI: hakkı bilmeyen kullanamaz.
    const nt = fs.readFileSync(path.join(__dirname, '../src/utils/notifyText.ts'), 'utf8')
    if (!/session_rescheduled[\s\S]{0,600}?ÜCRETSİZ iptal/.test(nt)) throw new Error('erteleme bildiriminde ücretsiz iptal hakkı yazmıyor — kullanıcı hakkından habersiz kalır')
    // 2) İstemci metinleri "12 saate kadar ücretsiz" gibi yanıltıcı ifade İÇERMEMELİ
    const misleading = [/12 saat öncesine kadar ücretsiz/i, /free cancellation up to 12 hours/i, /cancel for free up to 12 hours/i]
    const files = [
      path.join(__dirname, '../src/utils/email.ts'),
      path.join(process.env.HOME || '', 'fitpass-web/src/lib/i18n.tsx'),
      path.join(process.env.HOME || '', 'fitpass-mobile/src/lib/i18n.tsx'),
    ]
    for (const f of files) {
      if (!fs.existsSync(f)) continue // kardeş repo yok → atla
      const txt = fs.readFileSync(f, 'utf8')
      for (const re of misleading) {
        if (re.test(txt)) throw new Error(`yanıltıcı iptal metni geri gelmiş (${path.basename(f)}): ${re}`)
      }
    }
  })

  // Kategori silme koruması ROZET referansını da saymalı. Guard önceden hiç yazılmayan tabloları
  // (ActivityLog/UserTierHistory → her zaman 0) sayıp GERÇEKTEN yazılan UserBadge.sportCategoryId'yi
  // kaçırıyordu → rozet dağıtılmış kategori guard'dan geçip FK ihlaliyle 500'e düşüyordu.
  await check('Admin: rozet bağlı kategori silinemez (guard tüm FK\'leri sayar)', async () => {
    const uid = 990401
    // SportCategory.name @unique DEĞİL → upsert kullanılamaz; bul-veya-oluştur.
    const mkCat = async () => (await prisma.sportCategory.findFirst({ where: { name: 'SmokeKatSil' } }))
      ?? (await prisma.sportCategory.create({ data: { name: 'SmokeKatSil', colorHex: '#123456' } }))
    const cat = await mkCat()
    await prisma.user.upsert({ where: { id: uid }, update: { tierSportCounts: {} }, create: { id: uid, username: `kd_${uid}`, email: `kd_${uid}@x.com`, passwordHash: 'x', fullName: 'KD', tierSportCounts: {} } })
    // Referans YOKKEN silinebilmeli (kurulum doğrulaması — test yanlış sebeple yeşil olmasın)
    const free = await http(`/api/admin/categories/${cat.id}`, { method: 'DELETE', admin: true })
    if (free.status !== 200) throw new Error(`referanssız kategori silinemedi: ${free.status} ${free.text.slice(0, 90)}`)
    // Şimdi ROZET bağlı bir kategori: silme 400 ile ENGELLENMELİ (FK 500'ü DEĞİL)
    const cat2 = await mkCat()
    const badge = await prisma.badge.findFirst({ select: { id: true } })
    if (!badge) throw new Error('kurulum: badge yok (ensureBadges çalışmamış)')
    await prisma.userBadge.create({ data: { userId: uid, badgeId: badge.id, sportCategoryId: cat2.id } })
    const r = await http(`/api/admin/categories/${cat2.id}`, { method: 'DELETE', admin: true })
    if (r.status === 200) throw new Error('rozet bağlı kategori SİLİNDİ — guard UserBadge\'i saymıyor')
    if (r.status >= 500) throw new Error(`guard atlandı, FK hatası 500 döndü: ${r.text.slice(0, 90)}`)
    if (r.status !== 400) throw new Error(`beklenen 400, gelen ${r.status}`)
    if (!/rozet/i.test(r.json?.error || '')) throw new Error(`hata mesajı rozet sayısını söylemiyor: ${r.json?.error}`)
  })

  // Gelir raporunda "Bu Ay" ile aylık grafik AYNI ay sınırını kullanmalı (İstanbul 00:00).
  // Önceden başlık trMonthStart (TR), grafik new Date(y,m,1) (UTC) kullanıyordu → ayın ilk 3 saatinde
  // aynı ekranda ÇELİŞEN iki ciro rakamı. Test: TR ayının ilk saatlerine denk gelen bir rezervasyon
  // hem "bu ay" toplamında hem grafiğin SON ayında görünmeli (ikisi tutarlı olmalı).
  await check('Gelir raporu: "Bu Ay" ile aylık grafik aynı ay sınırını kullanır (TR)', async () => {
    const { trMonthStart, trYmd } = require('../src/utils/trFormat')
    const RV = 990411, RC = 990411, RS = 990411, RU = 990411
    const monthStart = trMonthStart(new Date())
    // TR ay başından 1 saat SONRA: UTC'de hâlâ ÖNCEKİ ay olabilir (kritik pencere)
    const inWindow = new Date(monthStart.getTime() + 3600000)
    if (inWindow > new Date()) return // ay henüz 1 saatlik değil → pencere test edilemez, atla
    await prisma.booking.deleteMany({ where: { session: { classId: RC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: RS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: RC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: RV }, update: { isApproved: true, isActive: true }, create: { id: RV, name: 'RevV', email: `rev${RV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.user.upsert({ where: { id: RU }, update: { tierSportCounts: {} }, create: { id: RU, username: `rev_${RU}`, email: `rev_${RU}@x.com`, passwordHash: 'x', fullName: 'Rev', tierSportCounts: {} } })
    await prisma.class.upsert({ where: { id: RC }, update: {}, create: { id: RC, venueId: RV, title: 'Rev Class', category: 'Yoga', basePrice: 100, durationMinutes: 60, capacity: 10, isActive: true } })
    await prisma.class_Session.upsert({ where: { id: RS }, update: { classId: RC }, create: { id: RS, classId: RC, startsAt: new Date(Date.now() + 86400000), endsAt: new Date(Date.now() + 90000000), capacity: 10, status: 'open' } })
    await prisma.booking.create({ data: { userId: RU, sessionId: RS, status: 'confirmed', bookingType: 'class', baseAmount: 777, commissionAmount: 0, venueCommission: 0, finalAmount: 777, venuePayout: 777, bookingNumber: `REV-${Date.now()}`, createdAt: inWindow } })
    const tok = jwt.sign({ venueId: RV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const r = await expectOk('/api/venue/revenue', { token: tok })
    const thisMonth = r.json?.thisMonthRevenue ?? r.json?.thisMonth ?? null
    const chart = r.json?.monthlyRevenue || []
    const last = chart[chart.length - 1]
    if (!last) throw new Error('aylık grafik boş')
    // Grafiğin son ayı TR'deki içinde bulunduğumuz ay olmalı ve 777'yi içermeli
    if (!last.revenue || last.revenue < 777) throw new Error(`grafiğin son ayı ${last.revenue} — 777 TL'lik kayıt UTC yüzünden önceki aya düşmüş olabilir`)
    if (thisMonth != null && thisMonth < 777) throw new Error(`"Bu Ay" ${thisMonth} — grafikle çelişiyor`)
    const trMonth = parseInt(trYmd(monthStart).slice(5, 7), 10)
    const MONTHS_TR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara']
    if (last.month !== MONTHS_TR[trMonth - 1]) throw new Error(`grafik son ay etiketi "${last.month}", TR ayı "${MONTHS_TR[trMonth - 1]}" olmalı`)
  })

  // cityId İSTEMCİDEN değil MAHALLEDEN türetilmeli. Önceden 4 noktada SABİT 1 (İstanbul) yazılıyordu;
  // DB'de zaten 5 şehir var (İstanbul/Ankara/Bursa/İzmir/Muğla) → İstanbul dışı bir ilçe seçilince
  // "Ankara mahallesi + İstanbul şehri" tutarsız satırı doğuyor ve ?cityId= filtresi sessizce yanlış
  // şehirde listeliyordu. Ayrıca web kayıt formu cityId'yi KENDİ gönderiyordu (istemci türetilmiş
  // veriyi dikte etmemeli) → sunucu artık istemcinin gönderdiğini yok sayıyor.
  await check('Coğrafya: cityId istemciden değil MAHALLEDEN türetilir (İstanbul\'a sabitlenmez)', async () => {
    const NB = 990421, UID = 990421
    // İstanbul OLMAYAN bir şehre bağlı mahalle (Ankara = 2 varsayımı yerine gerçek kaydı bul)
    const other = await prisma.city.findFirst({ where: { id: { not: 1 } }, select: { id: true, name: true } })
    if (!other) throw new Error('kurulum: İstanbul dışı şehir yok (seed eksik)')
    await prisma.neighborhood.upsert({ where: { id: NB }, update: { cityId: other.id }, create: { id: NB, name: 'GeoTestMah', latitude: 39, longitude: 32, cityId: other.id } })
    await prisma.user.deleteMany({ where: { id: UID } }).catch(() => {})
    await prisma.user.create({ data: { id: UID, username: `geo_${UID}`, email: `geo_${UID}@x.com`, passwordHash: 'x', fullName: 'Geo', tierSportCounts: {} } })
    const tok = jwt.sign({ userId: UID, email: `geo_${UID}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http('/api/auth/profile', { method: 'PUT', token: tok, body: { neighborhoodId: NB } })
    if (r.status !== 200) throw new Error(`profil güncelleme ${r.status}: ${r.text.slice(0, 90)}`)
    const u = await prisma.user.findUnique({ where: { id: UID }, select: { cityId: true, neighborhoodId: true } })
    if (u?.neighborhoodId !== NB) throw new Error('mahalle atanmadı')
    if (u?.cityId !== other.id) throw new Error(`cityId=${u?.cityId}, beklenen ${other.id} (${other.name}) — İstanbul'a sabitlenmiş olabilir`)
  })

  // Salon ÖZEL yanıtı: sahip ucu (/api/venue/reviews) GÖRÜR, public uç (/api/reviews/venue/:id) GİZLER.
  // Önceden salon paneli public uçtan okuduğu için salon KENDİ özel yanıtını göremiyordu (yazınca
  // kayboluyordu) → özellik backend'de hazır olmasına rağmen kullanılamıyordu.
  await check('Yorum: özel yanıt sahip ucunda GÖRÜNÜR, public uçta GİZLİ', async () => {
    const RV = 990431, RU = 990431, RC = 990431, RS = 990431
    await prisma.review.deleteMany({ where: { venueId: RV } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: RU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: RS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: RC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: RV }, update: { isApproved: true, isActive: true }, create: { id: RV, name: 'RevVis', email: `rv${RV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.user.upsert({ where: { id: RU }, update: { tierSportCounts: {} }, create: { id: RU, username: `rv_${RU}`, email: `rv_${RU}@x.com`, passwordHash: 'x', fullName: 'RV', tierSportCounts: {} } })
    const review = await prisma.review.create({ data: { venueId: RV, reviewerUserId: RU, targetType: 'venue', rating: 4, comment: 'test yorum' } })
    const vTok = jwt.sign({ venueId: RV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    // ÖZEL yanıt yaz
    const rep = await http(`/api/reviews/${review.id}/reply`, { method: 'PUT', token: vTok, body: { reply: 'gizli yanit', visibility: 'private' } })
    if (rep.status !== 200) throw new Error(`yanıt yazılamadı: ${rep.status} ${rep.text.slice(0, 90)}`)
    const saved = await prisma.review.findUnique({ where: { id: review.id }, select: { replyVisibility: true, venueReply: true } })
    if (saved?.replyVisibility !== 'private') throw new Error(`replyVisibility='${saved?.replyVisibility}' — 'private' bekleniyor (istemci visibility göndermiyor olabilir)`)
    // SAHİP ucu görmeli
    const own = await expectOk('/api/venue/reviews', { token: vTok })
    const mine = (own.json?.reviews || []).find((x: any) => x.id === review.id)
    if (!mine) throw new Error('sahip ucunda yorum yok')
    if (mine.venueReply !== 'gizli yanit') throw new Error('SALON KENDİ ÖZEL YANITINI GÖREMİYOR (sahip ucu public gibi gizliyor)')
    // PUBLIC uç gizlemeli (giriş yapmamış ziyaretçi)
    const pub = await expectOk(`/api/reviews/venue/${RV}`)
    const theirs = (pub.json?.reviews || []).find((x: any) => x.id === review.id)
    if (!theirs) throw new Error('public uçta yorum yok')
    if (theirs.venueReply) throw new Error(`ÖZEL yanıt public uçta SIZDI: "${theirs.venueReply}"`)
  })

  // ===== BİLDİRİM ÇOKLU-DİL (#67) REGRESYONLARI =====

  // Katalog: aynı anahtar iki dilde de metin üretir + parametreler doldurulur (push başlığı dahil)
  await check('Bildirim i18n: katalog TR/EN metin + parametre doldurma', async () => {
    const { notifyBody, notifyPush, notifyFields } = require('../src/utils/notifyText')
    const p = { username: 'ayse' }
    const tr = notifyBody('tr', 'follow', p), en = notifyBody('en', 'follow', p)
    if (!tr.includes('@ayse') || !en.includes('@ayse')) throw new Error('parametre doldurulmadı')
    if (tr === en) throw new Error('TR ve EN metin AYNI (çeviri yok)')
    if (/[{}]/.test(tr) || /[{}]/.test(en)) throw new Error('doldurulmamış yer tutucu kaldı')
    const pushEn = notifyPush('en', 'follow', p)
    if (!pushEn?.title || pushEn.title === notifyPush('tr', 'follow', p)?.title) throw new Error('push başlığı çevrilmiyor')
    // notifyFields hem anahtar+parametre HEM geriye dönük düz metin üretmeli
    const f = notifyFields('en', 'follow', p)
    if (f.messageKey !== 'follow' || (f.messageParams as any).username !== 'ayse' || !f.message) throw new Error('notifyFields eksik alan')
  })

  // Uygulama-içi bildirim DB'ye ANAHTAR+PARAMETRE yazar (yalnız metin değil) → dil değişince geçmiş de çevrilir
  await check('Bildirim i18n: DB\'ye messageKey+messageParams yazılıyor (EN kullanıcı EN metin)', async () => {
    const a = 990371, b = 990372
    await prisma.follow.deleteMany({ where: { OR: [{ followerId: a }, { followingId: a }, { followerId: b }, { followingId: b }] } }).catch(() => {})
    await prisma.notification.deleteMany({ where: { userId: { in: [a, b] } } }).catch(() => {})
    await prisma.user.upsert({ where: { id: a }, update: { tierSportCounts: {} }, create: { id: a, username: `nfa_${a}`, email: `nfa_${a}@x.com`, passwordHash: 'x', fullName: 'A', tierSportCounts: {} } })
    // hedef kullanıcının dili EN → bildirim İngilizce üretilmeli
    await prisma.user.upsert({ where: { id: b }, update: { tierSportCounts: {}, locale: 'en' }, create: { id: b, username: `nfb_${b}`, email: `nfb_${b}@x.com`, passwordHash: 'x', fullName: 'B', tierSportCounts: {}, locale: 'en' } })
    const tokA = jwt.sign({ userId: a, email: `nfa_${a}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await http(`/api/social/follow/nfb_${b}`, { method: 'POST', token: tokA })
    if (r.status !== 200) throw new Error(`takip başarısız: ${r.status} ${r.text.slice(0, 100)}`)
    const n = await prisma.notification.findFirst({ where: { userId: b, type: 'follow' }, orderBy: { id: 'desc' } })
    if (!n) throw new Error('bildirim oluşmadı')
    if (n.messageKey !== 'follow') throw new Error(`messageKey='${n.messageKey}' (follow bekleniyor) — metin-only saklama geri gelmiş`)
    if ((n.messageParams as any)?.username !== `nfa_${a}`) throw new Error('messageParams.username yok/yanlış')
    if (!/started following you/i.test(n.message)) throw new Error(`EN kullanıcıya TR fallback metni yazıldı: "${n.message}"`)
  })

  // X-Locale başlığı kullanıcının kayıtlı dilini günceller (dirty-check: yalnız DEĞİŞİNCE yazar)
  await check('Bildirim i18n: X-Locale başlığı User.locale\'i senkronlar', async () => {
    const uid = 990373
    await prisma.user.upsert({ where: { id: uid }, update: { tierSportCounts: {}, locale: 'tr' }, create: { id: uid, username: `loc_${uid}`, email: `loc_${uid}@x.com`, passwordHash: 'x', fullName: 'Loc', tierSportCounts: {}, locale: 'tr' } })
    const tok = jwt.sign({ userId: uid, email: `loc_${uid}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const res = await fetch(BASE + '/api/auth/me', { headers: { Authorization: `Bearer ${tok}`, 'X-Locale': 'en' } })
    if (res.status !== 200) throw new Error(`/me ${res.status}`)
    // syncLocale ateşle-unut (isteği yavaşlatmaz) → kısa bekleme
    for (let i = 0; i < 20; i++) {
      const u = await prisma.user.findUnique({ where: { id: uid }, select: { locale: true } })
      if (u?.locale === 'en') return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error("X-Locale: en gönderildi ama User.locale 'tr' kaldı")
  })

  // KATALOG-İSTEMCİ PARİTESİ: backend'e eklenen her uygulama-içi anahtar web+mobil sözlüklerinde olmalı.
  // (Yoksa istemci saklanan düz metne düşer — çökme değil ama o bildirim çevrilmez.)
  // Kardeş repo'lar yoksa (CI backend-only checkout) test ATLANIR.
  await check('Bildirim i18n: katalog anahtarları web+mobil sözlükleriyle eşleşiyor', async () => {
    const fs = require('fs'), path = require('path')
    const webI18n = path.join(process.env.HOME || '', 'fitpass-web/src/lib/i18n.tsx')
    const mobI18n = path.join(process.env.HOME || '', 'fitpass-mobile/src/lib/i18n.tsx')
    if (!fs.existsSync(webI18n) || !fs.existsSync(mobI18n)) return // kardeş repo yok → atla
    const { NOTIFY } = require('../src/utils/notifyText')
    // Uygulama-içi olarak GERÇEKTEN yazılan anahtarlar (notifyFields çağrılan yerler)
    const inApp = ['follow', 'follow_request', 'follow_accept', 'like', 'comment', 'comment_reply', 'group_invite',
      'booking_cancelled_class_removed', 'booking_cancelled_venue_closed', 'session_rescheduled', 'waitlist_open',
      'rating_prompt', 'badge_one', 'badge_many', 'season_champion']
    const web = fs.readFileSync(webI18n, 'utf8'), mob = fs.readFileSync(mobI18n, 'utf8')
    const missing: string[] = []
    for (const k of inApp) {
      if (!NOTIFY[k]?.body) missing.push(`katalog:${k}`)
      // her sözlükte TR + EN olmak üzere 2 kez geçmeli
      if ((web.match(new RegExp(`'notif\\.${k}':`, 'g')) || []).length < 2) missing.push(`web:${k}`)
      if ((mob.match(new RegExp(`'notif\\.${k}':`, 'g')) || []).length < 2) missing.push(`mobil:${k}`)
    }
    if (missing.length) throw new Error(`eksik bildirim anahtarları: ${missing.join(', ')}`)
  })

  // Tur19 drop-in liderlik sayımı: yalnızca drop-in'i olan kullanıcı da ders liderliğinde görünür (streak zaten sayıyordu)
  await check('Liderlik: drop-in katılımı kullanıcı liderliğine sayılır', async () => {
    const uid = 990367, slotId = 990367, nb = 990368
    const season = seasonInfo()
    const cat = await prisma.sportCategory.findFirst({})
    if (!cat) throw new Error('kurulum: sportCategory yok')
    await prisma.neighborhood.upsert({ where: { id: nb }, update: {}, create: { id: nb, name: 'DIMah', latitude: 41, longitude: 29, cityId: 1 } })
    await prisma.user.upsert({ where: { id: uid }, update: { tierSportCounts: {}, neighborhoodId: nb }, create: { id: uid, username: `di_${uid}`, email: `di_${uid}@x.com`, passwordHash: 'x', fullName: 'DI', tierSportCounts: {}, neighborhoodId: nb } })
    // bu sezon içinde, GEÇMİŞ, checkedIn drop-in
    const past = new Date(Math.max(season.start.getTime() + 3600000, Date.now() - 3600000))
    await prisma.dropInSlot.upsert({ where: { id: slotId }, update: { startsAt: past, endsAt: new Date(past.getTime() + 3600000), sportCategoryId: cat.id }, create: { id: slotId, venueId: V, sportCategoryId: cat.id, title: 'DI Slot', startsAt: past, endsAt: new Date(past.getTime() + 3600000), format: '1v1', totalPlayers: 10, totalPrice: 100, pricePerPerson: 10 } })
    await prisma.dropInParticipant.deleteMany({ where: { userId: uid } }).catch(() => {})
    await prisma.dropInParticipant.create({ data: { slotId, userId: uid, status: 'confirmed', checkedIn: true } })
    const r = await expectOk(`/api/social/leaderboard/users?neighborhoodId=${nb}`) // benzersiz ilçe → taze cache
    const me = (r.json?.leaderboard || []).find((x: any) => x.id === uid)
    if (!me) throw new Error('sadece drop-in\'i olan kullanıcı liderlikte yok (drop-in sayılmıyor)')
    if (me.lessonCount < 1) throw new Error(`drop-in lessonCount ${me.lessonCount} (>=1 bekleniyor)`)
  })

  // Tur20 — DENETİM BULGUSU: boşalan yer SESSİZCE boş kalıyordu. notifyFirstWaitlistUser
  // yalnız iptal OLAYINDA çağrılıyordu; (a) 30 dk'lık öncelik penceresi dolduğunda ve
  // (b) salon KAPASİTEYİ ARTIRDIĞINDA kimse tekrar bakmıyordu. Süpürge job'ı durum-tabanlı
  // çalışır: "yeri olan + bekleyeni olan" seansı bulur, yerin nasıl açıldığına bakmaz.
  // Ayrıca sıra sıralaması düzeltildi: penceresi dolan kişi hâlâ en eski satır olduğu için
  // her turda YİNE o seçiliyordu (arkasındakiler süresiz bloklanıyordu).
  await check('Bekleme listesi: pencere dolunca VE kapasite artınca sıradakine haber gider', async () => {
    const WV = 990531, WC = 990531, WS = 990531, W1 = 990531, W2 = 990532, WB = 990533
    await prisma.waitlist.deleteMany({ where: { sessionId: WS } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { session: { classId: WC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: WS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: WC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: WV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: WV, name: 'BeklemeSalon', email: `bs${WV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: WC }, update: { venueId: WV, isActive: true }, create: { id: WC, venueId: WV, title: 'BeklemeDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const fut = new Date(Date.now() + 3 * 86400000)
    await prisma.class_Session.upsert({ where: { id: WS }, update: { classId: WC, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 1, status: 'open' }, create: { id: WS, classId: WC, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 1, status: 'open' } })
    const mkU = (id: number) => prisma.user.upsert({ where: { id }, update: { banned: false }, create: { id, username: `bek_${id}`, email: `bek_${id}@x.com`, passwordHash: 'x', fullName: 'Bekleyen', tierSportCounts: {} } })
    await mkU(W1); await mkU(W2); await mkU(WB)
    await prisma.booking.create({ data: { userId: WB, sessionId: WS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `BEK-${Date.now()}` } })

    // İki kişi bekliyor; W1 ÖNCE sıraya girmiş (createdAt daha eski)
    await prisma.waitlist.create({ data: { userId: W1, sessionId: WS, status: 'waiting', createdAt: new Date(Date.now() - 60 * 60000) } })
    await prisma.waitlist.create({ data: { userId: W2, sessionId: WS, status: 'waiting', createdAt: new Date(Date.now() - 30 * 60000) } })

    // Seans DOLU (1/1) → süpürge kimseye haber vermemeli
    await sweepWaitlist()
    let w1 = await prisma.waitlist.findUnique({ where: { userId_sessionId: { userId: W1, sessionId: WS } } })
    if (w1?.status !== 'waiting') throw new Error('dolu seansta bildirim gitti (yer yokken haber verilmemeli)')

    // (a) SALON KAPASİTEYİ ARTIRIYOR → 1 yer açılır, sıradaki W1'e haber gitmeli
    await prisma.class_Session.update({ where: { id: WS }, data: { capacity: 2 } })
    await sweepWaitlist()
    w1 = await prisma.waitlist.findUnique({ where: { userId_sessionId: { userId: W1, sessionId: WS } } })
    if (w1?.status !== 'notified') throw new Error('kapasite artınca bekleme listesine haber GİTMEDİ')
    let w2 = await prisma.waitlist.findUnique({ where: { userId_sessionId: { userId: W2, sessionId: WS } } })
    if (w2?.status !== 'waiting') throw new Error('tek yer açıldı ama İKİ kişiye birden haber gitti')

    // (b) W1 yeri kapamıyor, 30 dk'lık ÖNCELİK PENCERESİ doluyor → sıra W2'ye GEÇMELİ.
    // Eski sıralamada (yalnız createdAt) yine W1 seçiliyordu → W2 süresiz bloklanıyordu.
    await prisma.waitlist.update({ where: { id: w1!.id }, data: { notifiedAt: new Date(Date.now() - 31 * 60000) } })
    await sweepWaitlist()
    w2 = await prisma.waitlist.findUnique({ where: { userId_sessionId: { userId: W2, sessionId: WS } } })
    if (w2?.status !== 'notified') throw new Error('öncelik penceresi dolunca sıra DEVREDİLMEDİ — cevap vermeyen ilk kişi arkasındakileri süresiz bloklar')

    await prisma.waitlist.deleteMany({ where: { sessionId: WS } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { sessionId: WS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: WS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: WC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [W1, W2, WB] } } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: WV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: check-in'de puan kredisi "ateşle-unut" çağrılıyor (bilinçli:
  // müşteri kapıda beklerken check-in yavaşlamasın). Ama çağrı başarısız olursa booking
  // checkedIn=true kalır, defterde 'attendance' satırı OLMAZ → kullanıcı hak ettiği puanı
  // HİÇ almaz ve kimse fark etmez. Mutabakat job'ı bunu tamamlar (idempotent).
  await check('Puan: kredilenmemiş check-in mutabakatla tamamlanır, çift kredi olmaz', async () => {
    const AV = 990541, AC = 990541, AS2 = 990541, AU = 990541
    await prisma.rewardPoint.deleteMany({ where: { userId: AU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { session: { classId: AC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: AS2 } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: AC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: AV }, update: { isApproved: true, isActive: true }, create: { id: AV, name: 'MutabakatSalon', email: `ms${AV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: AC }, update: { venueId: AV, isActive: true, basePrice: 200 }, create: { id: AC, venueId: AV, title: 'MutabakatDers', category: catName, basePrice: 200, durationMinutes: 60, capacity: 20, isActive: true } })
    const past = new Date(Date.now() - 2 * 3600000)
    await prisma.class_Session.upsert({ where: { id: AS2 }, update: { classId: AC, startsAt: past, endsAt: new Date(past.getTime() + 3600000) }, create: { id: AS2, classId: AC, startsAt: past, endsAt: new Date(past.getTime() + 3600000), capacity: 20, status: 'open' } })
    // tierId 1 = Aday (%1) → 200 TL için 2 puan
    await prisma.user.upsert({ where: { id: AU }, update: { rewardPoints: 0, tierId: 1 }, create: { id: AU, username: `mut_${AU}`, email: `mut_${AU}@x.com`, passwordHash: 'x', fullName: 'Mutabakat', tierId: 1, tierSportCounts: {}, rewardPoints: 0 } })

    // "Ateşle-unut çağrısı BAŞARISIZ oldu" durumunu taklit et: check-in yapılmış ama defter satırı YOK
    const bk = await prisma.booking.create({ data: { userId: AU, sessionId: AS2, status: 'confirmed', bookingType: 'class', baseAmount: 200, commissionAmount: 0, venueCommission: 0, finalAmount: 200, venuePayout: 200, bookingNumber: `MUT-${Date.now()}`, checkedIn: true, checkedInAt: new Date(), pointsEarned: 2 } })
    const once = await prisma.user.findUnique({ where: { id: AU }, select: { rewardPoints: true } })
    if (once?.rewardPoints !== 0) throw new Error(`kurulum: bakiye 0 olmalı, ${once?.rewardPoints}`)

    // 1) Mutabakat eksiği tamamlamalı
    await reconcileAttendancePoints()
    const defter = await prisma.rewardPoint.findMany({ where: { bookingId: bk.id, source: 'attendance' } })
    if (defter.length !== 1) throw new Error(`mutabakat sonrası 'attendance' satırı ${defter.length} (1 bekleniyor) — kredilenmemiş check-in tamamlanmadı`)
    const sonra = await prisma.user.findUnique({ where: { id: AU }, select: { rewardPoints: true } })
    if ((sonra?.rewardPoints || 0) <= 0) throw new Error(`bakiyeye puan yazılmadı: ${sonra?.rewardPoints}`)

    // 2) TEKRAR koşmak ÇİFT kredi vermemeli (idempotent)
    await reconcileAttendancePoints()
    const defter2 = await prisma.rewardPoint.findMany({ where: { bookingId: bk.id, source: 'attendance' } })
    if (defter2.length !== 1) throw new Error(`ikinci mutabakat çift kredi yazdı: ${defter2.length} satır`)
    const sonra2 = await prisma.user.findUnique({ where: { id: AU }, select: { rewardPoints: true } })
    if (sonra2?.rewardPoints !== sonra?.rewardPoints) throw new Error(`ikinci mutabakat bakiyeyi değiştirdi: ${sonra?.rewardPoints} → ${sonra2?.rewardPoints}`)

    await prisma.rewardPoint.deleteMany({ where: { userId: AU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { sessionId: AS2 } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: AS2 } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: AC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: AU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: AV } }).catch(() => {})
  })

  // Tur20 — ŞEMA GÜVENLİK KAPISI. Ölçüldü: `prisma db push` şemadan kolon silindiğinde
  // 7 satırlık tablodan o kolonu SESSİZCE düşürdü (uyarı yok, çıkış kodu 0). `npm start` her
  // açılışta db push çalıştırdığı için şemaya yanlışlıkla dokunan biri üretim verisini
  // kaybedebiliyordu. Artık deploy versiyonlanmış migration'larla yapılıyor ve bekleyen
  // migration'larda yıkıcı SQL varsa deploy DURUYOR. Bu test kapının desenlerini sabitler.
  await check('Şema: yıkıcı migration SQL\'i deploy kapısına takılır', async () => {
    const { yikiciBul } = require('../scripts/db-deploy.cjs')

    const yakalanmali: [string, string][] = [
      ['ALTER TABLE "Booking" DROP COLUMN "notes";', 'DROP COLUMN'],
      ['DROP TABLE "Booking";', 'DROP TABLE'],
      ['ALTER TABLE "Booking" RENAME COLUMN "a" TO "b";', 'RENAME'],
      ['ALTER TABLE "Booking" ALTER COLUMN "x" SET NOT NULL;', 'SET NOT NULL'],
      ['TRUNCATE "Booking";', 'TRUNCATE'],
      ['ALTER TABLE "Booking" DROP CONSTRAINT "fk";', 'DROP CONSTRAINT'],
    ]
    for (const [sql, beklenen] of yakalanmali) {
      const b = yikiciBul(sql)
      if (b.length === 0) throw new Error(`yıkıcı SQL yakalanmadı (${beklenen}): ${sql}`)
    }

    // GÜVENLİ olanlar takılmamalı (yanlış alarm deploy'u boşuna bloklar)
    const gecmeli = [
      'ALTER TABLE "Booking" ADD COLUMN "yeni" TEXT;',
      'CREATE TABLE "Yeni" ("id" SERIAL PRIMARY KEY);',
      'CREATE INDEX "i" ON "Booking"("userId");',
      'CREATE UNIQUE INDEX IF NOT EXISTS "u" ON "Booking"("bookingNumber");',
      // yorum içinde geçen yıkıcı kelime yanlış alarm VERMEMELİ
      '-- Bu migration DROP COLUMN yapmaz, sadece açıklama\nALTER TABLE "Booking" ADD COLUMN "y2" TEXT;',
      '/* DROP TABLE demiyoruz */ ALTER TABLE "Booking" ADD COLUMN "y3" TEXT;',
    ]
    for (const sql of gecmeli) {
      const b = yikiciBul(sql)
      if (b.length > 0) throw new Error(`güvenli SQL yanlışlıkla yıkıcı sayıldı (${b.join(',')}): ${sql.slice(0, 60)}`)
    }

    // Bilinçli silme: ALLOW-DESTRUCTIVE işareti kapıyı açar (karar git'te izli kalır)
    const izinli = yikiciBul('-- ALLOW-DESTRUCTIVE: veri yeni alana taşındı\nALTER TABLE "Booking" DROP COLUMN "notes";')
    if (izinli.length !== 0) throw new Error('ALLOW-DESTRUCTIVE işareti kapıyı açmıyor — bilinçli silme imkânsız hale gelir')

    // Deploy hattı gerçekten migration kullanmalı: start'ta db push KALMAMALI
    const fs2 = require('fs'), path2 = require('path')
    const pkg = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../package.json'), 'utf8'))
    if (/db\s+push/.test(pkg.scripts?.start || '')) throw new Error('npm start hâlâ `prisma db push` çalıştırıyor — sessiz kolon silme riski geri geldi')
    const rj = JSON.parse(fs2.readFileSync(path2.join(__dirname, '../railway.json'), 'utf8'))
    if (!/db-deploy/.test(rj.deploy?.preDeployCommand || '')) throw new Error('railway.json preDeployCommand şema kapısını çağırmıyor')
  })

  // Tur20 — SIFIR-KESİNTİ DEPLOY. Ölçülmüştü: her Railway deploy'unda ~30sn 502 penceresi vardı
  // (healthcheckPath tanımsız → trafik hazır olmayan konteynere dönüyor; SIGTERM işleyicisi yok →
  // uçan istekler ölüyor). Bu test iki mekanizmayı da doğrular: /health açılış bitmeden 503 der,
  // SIGTERM sonrası 503'e döner (yönlendirici trafiği kessin) ve süreç TEMİZ (kod 0) kapanır.
  await check('Deploy: /health hazır-olma sinyali verir ve SIGTERM\'de temiz kapanır', async () => {
    const path = require('path')
    const altPort = PORT + 7
    const alt = spawn('npx', ['ts-node', 'src/index.ts'], {
      env: { ...process.env, PORT: String(altPort), DISABLE_RATE_LIMIT: 'true', ADMIN_SECRET, CRON_SECRET },
      cwd: path.join(__dirname, '..'), detached: true, stdio: 'ignore',
    })
    const altBase = `http://localhost:${altPort}`
    const hGet = async () => { try { const r = await fetch(altBase + '/health'); return { s: r.status, j: await r.json().catch(() => null) } } catch { return { s: 0, j: null } } }
    try {
      // 1) SAĞLIKLI olana kadar bekle (açılış işleri bitince)
      let hazir = false
      for (let i = 0; i < 90; i++) {
        const h = await hGet()
        if (h.s === 200 && (h.j as any)?.ok === true) { hazir = true; break }
        await new Promise(r => setTimeout(r, 1000))
      }
      if (!hazir) throw new Error('alt sunucu 90sn içinde sağlıklı olmadı')

      // 2) SIGTERM → drenaj penceresinde /health 503 + shutting_down demeli
      process.kill(-alt.pid!, 'SIGTERM')
      let gordu503 = false
      for (let i = 0; i < 25; i++) {
        const h = await hGet()
        if (h.s === 503 && (h.j as any)?.state === 'shutting_down') { gordu503 = true; break }
        if (h.s === 0) break // zaten kapanmış (drenajı kaçırdık)
        await new Promise(r => setTimeout(r, 100))
      }
      if (!gordu503) throw new Error('SIGTERM sonrası /health 503/shutting_down dönmedi — yönlendirici trafiği kesmez, istekler ölür')

      // 3) TEMİZ çıkış (kod 0) — zorla öldürülmüyor
      const kod = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(-1), 20000)
        alt.on('exit', (c) => { clearTimeout(t); resolve(c) })
      })
      if (kod === -1) throw new Error('süreç 20sn içinde kapanmadı (graceful shutdown takıldı)')
      if (kod !== 0) throw new Error(`süreç temiz kapanmadı, çıkış kodu ${kod}`)
    } finally {
      try { if (alt.pid) process.kill(-alt.pid, 'SIGKILL') } catch { /* zaten ölmüş */ }
    }
  })

  // Tur20 — ÜRÜN KARARI (kullanıcı onayı): SALON dersi ertelediğinde kullanıcı, iptal
  // penceresi kuralından muaf olarak TAM İADE ile iptal edebilmeli. Yeni saat onun tercihi
  // değil; "12-24 saat kala yarım iade" cezasını salonun kararı yüzünden ödememeli.
  await check('İptal: salon erteleyince kullanıcı pencere kuralından muaf TAM iade alır', async () => {
    const EV = 990521, EC = 990521, ES = 990521, EU = 990521
    await prisma.booking.deleteMany({ where: { session: { classId: EC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: ES } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: EC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: EV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: EV, name: 'ErtelemeSalon', email: `es${EV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: EC }, update: { venueId: EV, isActive: true, basePrice: 200 }, create: { id: EC, venueId: EV, title: 'ErtelemeDers', category: catName, basePrice: 200, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.user.upsert({ where: { id: EU }, update: {}, create: { id: EU, username: `ert_${EU}`, email: `ert_${EU}@x.com`, passwordHash: 'x', fullName: 'Erteleme', tierSportCounts: {} } })
    const utok = jwt.sign({ userId: EU, email: `ert_${EU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const vtok = jwt.sign({ venueId: EV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const { trYmd: _y, trTime: _t } = require('../src/utils/trFormat')
    const url = `/api/venue/classes/${EC}/sessions/${ES}`
    const hedefE = (d: Date) => ({ date: _y(d), time: _t(d) }) // sabit saat yazmak flaky yapıyor

    // KONTROL 1: erteleme YOKKEN, 12-24 saat aralığı YARIM iade olmalı (mevcut politika bozulmasın)
    const yirmiSaat = new Date(Date.now() + 20 * 3600000)
    await prisma.class_Session.upsert({ where: { id: ES }, update: { classId: EC, startsAt: yirmiSaat, endsAt: new Date(yirmiSaat.getTime() + 3600000), status: 'open', capacity: 20 }, create: { id: ES, classId: EC, startsAt: yirmiSaat, endsAt: new Date(yirmiSaat.getTime() + 3600000), capacity: 20, status: 'open' } })
    const bk1 = await http('/api/bookings', { method: 'POST', token: utok, body: { sessionId: ES } })
    if (bk1.status !== 201) throw new Error(`kurulum booking: ${bk1.status} ${bk1.text.slice(0, 120)}`)
    const c1 = await http(`/api/bookings/${bk1.json.booking.id}/cancel`, { method: 'PUT', token: utok })
    if (c1.status !== 200) throw new Error(`kontrol iptali: ${c1.status} ${c1.text.slice(0, 120)}`)
    if (!/Yarım iade/.test(c1.json?.message || '')) throw new Error(`ertelenmemiş 20 saatlik rezervasyon YARIM iade almalıydı: ${c1.json?.message}`)

    // ASIL SENARYO: uzak bir seansa rezervasyon → salon 20 saate ÇEKİYOR → tam iade hakkı
    const uzak = new Date(Date.now() + 10 * 86400000)
    await prisma.class_Session.update({ where: { id: ES }, data: { startsAt: uzak, endsAt: new Date(uzak.getTime() + 3600000) } })
    const bk2 = await http('/api/bookings', { method: 'POST', token: utok, body: { sessionId: ES } })
    if (bk2.status !== 201) throw new Error(`2. booking: ${bk2.status} ${bk2.text.slice(0, 120)}`)
    const bid = bk2.json.booking.id

    const tasi = await http(url, { method: 'PUT', token: vtok, body: { ...hedefE(yirmiSaat), capacity: 20 } })
    if (tasi.status !== 200) throw new Error(`salon ertelemesi başarısız: ${tasi.status} ${tasi.text.slice(0, 140)}`)
    const damga = await prisma.booking.findUnique({ where: { id: bid }, select: { rescheduledAt: true } })
    if (!damga?.rescheduledAt) throw new Error('erteleme damgası (rescheduledAt) atılmadı — kullanıcı iade hakkını kaybeder')

    const c2 = await http(`/api/bookings/${bid}/cancel`, { method: 'PUT', token: utok })
    if (c2.status !== 200) throw new Error(`ertelenen rezervasyon iptal edilemedi: ${c2.status} ${c2.text.slice(0, 140)}`)
    if (!/Tam iade/.test(c2.json?.message || '')) throw new Error(`salon ertelediği hâlde TAM iade verilmedi: ${c2.json?.message}`)

    await prisma.booking.deleteMany({ where: { sessionId: ES } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: ES } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: EC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: EU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: EV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: salon rezervasyonlu seansı 12 saatten yakına taşıyabiliyordu.
  // cancelBooking "derse 12 saatten az kaldıysa iptal yok" diyor → kullanıcı ne derse gidebiliyor
  // ne parasını geri alabiliyordu. Salon o saate almak istiyorsa seansı SİLEBİLİR (herkes iade alır).
  await check('Yetki: rezervasyonlu seans 12 saatten YAKINA taşınamaz (iptal hakkı korunur)', async () => {
    const YV = 990511, YC = 990511, YS = 990511, YU = 990511
    await prisma.booking.deleteMany({ where: { session: { classId: YC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: YS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: YC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: YV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: YV, name: 'TasimaSalon', email: `ts${YV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: YC }, update: { venueId: YV, isActive: true }, create: { id: YC, venueId: YV, title: 'TasimaDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const uzak = new Date(Date.now() + 10 * 86400000)
    await prisma.class_Session.upsert({ where: { id: YS }, update: { classId: YC, startsAt: uzak, endsAt: new Date(uzak.getTime() + 3600000), status: 'open', capacity: 20 }, create: { id: YS, classId: YC, startsAt: uzak, endsAt: new Date(uzak.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: YU }, update: {}, create: { id: YU, username: `tas_${YU}`, email: `tas_${YU}@x.com`, passwordHash: 'x', fullName: 'Tasima', tierSportCounts: {} } })
    const vtok = jwt.sign({ venueId: YV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const { trYmd: _ymd, trTime: _hm } = require('../src/utils/trFormat')
    const url = `/api/venue/classes/${YC}/sessions/${YS}`
    // Hedefin KENDİ İstanbul gün+saatini kullan. Sabit bir saat ('23:30') yazmak, testin koştuğu
    // saate göre hedefi gün sınırının ötesine atıp 12 saatten UZAĞA düşürebiliyordu (flaky).
    const hedef = (ms: number) => { const d = new Date(Date.now() + ms); return { date: _ymd(d), time: _hm(d) } }

    // REZERVASYON YOKKEN yakına taşımak SERBEST olmalı (kimsenin hakkı yok)
    const bosTasi = await http(url, { method: 'PUT', token: vtok, body: { ...hedef(8 * 3600000), capacity: 20 } })
    if (bosTasi.status !== 200) throw new Error(`rezervasyonsuz seans yakına taşınamadı: ${bosTasi.status} ${bosTasi.text.slice(0, 120)}`)

    // Seansı tekrar uzağa al ve REZERVASYON ekle
    await http(url, { method: 'PUT', token: vtok, body: { ...hedef(10 * 86400000), capacity: 20 } })
    await prisma.booking.create({ data: { userId: YU, sessionId: YS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `TAS-${Date.now()}` } })

    // Artık 12 saatten yakına taşınamamalı
    const yakin = await http(url, { method: 'PUT', token: vtok, body: { ...hedef(6 * 3600000), capacity: 20 } })
    if (yakin.status !== 400) throw new Error(`rezervasyonlu seans 12 saatten yakına taşınabildi: ${yakin.status} — kullanıcının iptal hakkı yok oldu`)
    const kalan = await prisma.class_Session.findUnique({ where: { id: YS }, select: { startsAt: true } })
    if (!kalan || (kalan.startsAt.getTime() - Date.now()) / 3600000 < 12) throw new Error('red edilmesine rağmen seans yakına taşındı')

    // 12 saatten UZAĞA taşımak hâlâ serbest
    const uzagaTasi = await http(url, { method: 'PUT', token: vtok, body: { ...hedef(3 * 86400000), capacity: 20 } })
    if (uzagaTasi.status !== 200) throw new Error(`rezervasyonlu seans uzağa taşınamadı: ${uzagaTasi.status} ${uzagaTasi.text.slice(0, 120)}`)

    await prisma.booking.deleteMany({ where: { sessionId: YS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: YS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: YC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: YU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: YV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: hatırlatma gönderimi BAŞARISIZ olsa bile reminderSent=true
  // kalıyordu (bayrak gönderimden ÖNCE, çift-gönderim koruması olarak işaretleniyor). Resend
  // kesintisi/kota aşımı sırasında o pencereye düşen herkes hatırlatmasız kalıyor, loglar
  // temiz görünüyordu — hata sessizdi. Artık hiçbir kanal teslim edemezse bayrak geri alınır.
  await check('Hatırlatma: gönderim başarısızsa reminderSent geri alınır (tekrar denenir)', async () => {
    const RV = 990501, RC = 990501, RS = 990501, RU1 = 990501, RU2 = 990502
    await prisma.booking.deleteMany({ where: { session: { classId: RC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: RS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: RC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: RV }, update: { isApproved: true, isActive: true }, create: { id: RV, name: 'HatirlatmaSalon', email: `hs${RV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: RC }, update: { venueId: RV, isActive: true }, create: { id: RC, venueId: RV, title: 'HatirlatmaDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    // Hatırlatma penceresi: +90..+150 dk → tam ortası
    const when = new Date(Date.now() + 120 * 60 * 1000)
    await prisma.class_Session.upsert({ where: { id: RS }, update: { classId: RC, startsAt: when, endsAt: new Date(when.getTime() + 3600000), status: 'open' }, create: { id: RS, classId: RC, startsAt: when, endsAt: new Date(when.getTime() + 3600000), capacity: 20, status: 'open' } })

    // U1: TEK kanalı push ve o da BAŞARISIZ olacak (token 'ExponentPushToken' ile başlamıyor →
    // sendPushNotification ağa hiç çıkmadan false döner). E-posta kanalı kapalı.
    await prisma.user.upsert({ where: { id: RU1 }, update: { pushToken: 'gecersiz-token', emailReminders: false }, create: { id: RU1, username: `hat_${RU1}`, email: `hat_${RU1}@x.com`, passwordHash: 'x', fullName: 'Hat1', tierSportCounts: {}, pushToken: 'gecersiz-token', emailReminders: false } })
    // U2: HİÇBİR kanal yok (push token yok, e-posta kapalı) → denenecek bir şey yok, bayrak KALMALI
    await prisma.user.upsert({ where: { id: RU2 }, update: { pushToken: null, emailReminders: false }, create: { id: RU2, username: `hat_${RU2}`, email: `hat_${RU2}@x.com`, passwordHash: 'x', fullName: 'Hat2', tierSportCounts: {}, pushToken: null, emailReminders: false } })

    const mk = (uid: number, n: string) => prisma.booking.create({ data: { userId: uid, sessionId: RS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: n, reminderSent: false } })
    const b1 = await mk(RU1, `HAT1-${Date.now()}`)
    const b2 = await mk(RU2, `HAT2-${Date.now()}`)

    await sendRemindersJob()

    const a1 = await prisma.booking.findUnique({ where: { id: b1.id }, select: { reminderSent: true } })
    if (a1?.reminderSent !== false) throw new Error('gönderim başarısız olmasına rağmen reminderSent=true kaldı — hatırlatma bir daha DENENMEZ')
    const a2 = await prisma.booking.findUnique({ where: { id: b2.id }, select: { reminderSent: true } })
    if (a2?.reminderSent !== true) throw new Error('kanalı olmayan kullanıcıda bayrak geri alındı — sonsuz yeniden deneme olur')

    await prisma.booking.deleteMany({ where: { sessionId: RS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: RS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: RC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: { in: [RU1, RU2] } } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: RV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: onayı GERİ ALINMIŞ salon check-in yapmaya devam edebiliyordu.
  // venueAuthMiddleware yalnız isActive/isSuspended bakıyor; isApproved'a bakan
  // venueApprovedMiddleware bu iki uçta yoktu → platformdan kaldırılmış salon kullanıcıya
  // puan/streak/rozet kazandırmaya ve yorum kapısını açmaya devam ediyordu.
  await check('Yetki: onayı KALDIRILMIŞ salon check-in YAPAMAZ', async () => {
    const DV = 990481, DC = 990481, DS = 990481, DU = 990481
    await prisma.booking.deleteMany({ where: { session: { classId: DC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: DS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: DC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: DV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: DV, name: 'OnaySalon', email: `os${DV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: DC }, update: { venueId: DV, isActive: true }, create: { id: DC, venueId: DV, title: 'OnayDers', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const past = new Date(Date.now() - 20 * 60000)
    await prisma.class_Session.upsert({ where: { id: DS }, update: { classId: DC, startsAt: past, endsAt: new Date(Date.now() + 40 * 60000) }, create: { id: DS, classId: DC, startsAt: past, endsAt: new Date(Date.now() + 40 * 60000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: DU }, update: {}, create: { id: DU, username: `ons_${DU}`, email: `ons_${DU}@x.com`, passwordHash: 'x', fullName: 'Onay', tierSportCounts: {} } })
    const kod = 'ONAYKOD1'
    await prisma.booking.create({ data: { userId: DU, sessionId: DS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `ONS-${Date.now()}`, checkInCode: kod, checkedIn: false } })
    const vtok = jwt.sign({ venueId: DV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })

    // ONAYLIYKEN çalışmalı (kurulum doğrulaması — test yanlış sebeple yeşil olmasın)
    const ok = await http('/api/bookings/checkin', { method: 'POST', token: vtok, body: { code: kod } })
    if (ok.status !== 200) throw new Error(`kurulum: onaylı salon check-in yapamadı (${ok.status} ${ok.text.slice(0, 120)})`)

    // ONAY KALDIRILINCA 403
    await prisma.booking.updateMany({ where: { sessionId: DS }, data: { checkedIn: false, checkedInAt: null } })
    await prisma.venue.update({ where: { id: DV }, data: { isApproved: false } })
    const red = await http('/api/bookings/checkin', { method: 'POST', token: vtok, body: { code: kod } })
    if (red.status !== 403) throw new Error(`onayı kaldırılmış salon check-in yapabildi: ${red.status}`)
    const b = await prisma.booking.findFirst({ where: { sessionId: DS }, select: { checkedIn: true } })
    if (b?.checkedIn) throw new Error('403 dönmesine rağmen booking checkedIn oldu')

    await prisma.booking.deleteMany({ where: { sessionId: DS } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: DS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: DC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: DU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: DV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: seans/ders silinince kupon usedCount iade EDİLMİYORDU (iptal
  // yolunda ediliyor). maxUses'lı kampanya, hiç gerçekleşmemiş rezervasyonlar yüzünden tükeniyordu.
  await check('Kupon: seans silinince kullanım hakkı İADE edilir (iptalle simetrik)', async () => {
    const KV = 990491, KC = 990491, KS = 990491, KU = 990491
    await prisma.booking.deleteMany({ where: { session: { classId: KC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: KS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: KC } }).catch(() => {})
    await prisma.coupon.deleteMany({ where: { code: 'SILINEN10' } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: KV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: KV, name: 'KuponSalon', email: `ks${KV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: KC }, update: { venueId: KV, isActive: true }, create: { id: KC, venueId: KV, title: 'KuponDers2', category: catName, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const fut = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: KS }, update: { classId: KC, startsAt: fut, status: 'open', capacity: 20 }, create: { id: KS, classId: KC, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: KU }, update: {}, create: { id: KU, username: `kup_${KU}`, email: `kup_${KU}@x.com`, passwordHash: 'x', fullName: 'Kupon', tierSportCounts: {} } })
    const cp = await prisma.coupon.create({ data: { venueId: KV, code: 'SILINEN10', discountType: 'fixed', discountValue: 10, maxUses: 10, isActive: true } })
    const utok = jwt.sign({ userId: KU, email: `kup_${KU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })

    const bk = await http('/api/bookings', { method: 'POST', token: utok, body: { sessionId: KS, couponCode: 'SILINEN10' } })
    if (bk.status !== 201) throw new Error(`kurulum booking: ${bk.status} ${bk.text.slice(0, 120)}`)
    const c1 = await prisma.coupon.findUnique({ where: { id: cp.id }, select: { usedCount: true } })
    if (c1?.usedCount !== 1) throw new Error(`kurulum: usedCount 1 olmalı, ${c1?.usedCount}`)

    // Salon SEANSI SİLER → kupon hakkı geri gelmeli
    const vtok = jwt.sign({ venueId: KV, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const del = await http(`/api/venue/classes/${KC}/sessions/${KS}`, { method: 'DELETE', token: vtok })
    if (del.status !== 200) throw new Error(`seans silinemedi: ${del.status} ${del.text.slice(0, 120)}`)
    const c2 = await prisma.coupon.findUnique({ where: { id: cp.id }, select: { usedCount: true } })
    if (c2?.usedCount !== 0) throw new Error(`seans silinince kupon hakkı iade edilmedi: usedCount ${c2?.usedCount} (0 bekleniyor)`)

    await prisma.coupon.deleteMany({ where: { code: 'SILINEN10' } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: KC } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: KU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: KV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: özel drop-in slotu HİÇ açılamıyordu. Sunucu görüntülemede ?code=,
  // katılımda privateCode bekliyor; hiçbir istemci göndermiyordu → salon özel slot üretebiliyor
  // ama davetli 404/403 alıyordu (özellik tamamen ölü). Bu test sözleşmenin iki ucunu da sabitler.
  await check('Drop-in: özel slot kodla görüntülenir ve kodla katılınır, kodsuz kapalı', async () => {
    const PV = 990471, PS = 990471, PU = 990471
    const cat = await prisma.sportCategory.findFirst({})
    if (!cat) throw new Error('kurulum: sportCategory yok')
    await prisma.dropInParticipant.deleteMany({ where: { slotId: PS } }).catch(() => {})
    await prisma.dropInSlot.deleteMany({ where: { id: PS } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: PV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: PV, name: 'OzelDropV', email: `odv${PV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    const st = new Date(Date.now() + 2 * 86400000)
    await prisma.dropInSlot.create({ data: { id: PS, venueId: PV, sportCategoryId: cat.id, title: 'Ozel Mac', startsAt: st, endsAt: new Date(st.getTime() + 3600000), format: '5v5', totalPlayers: 10, totalPrice: 500, pricePerPerson: 50, visibility: 'private', privateCode: 'GIZLI42', status: 'open' } })
    await prisma.user.upsert({ where: { id: PU }, update: {}, create: { id: PU, username: `odu_${PU}`, email: `odu_${PU}@x.com`, passwordHash: 'x', fullName: 'OzelDavetli', tierSportCounts: {} } })
    const tok = jwt.sign({ userId: PU, email: `odu_${PU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })

    // KODSUZ görüntüleme → 404 (id enumerasyonuyla roster sızmasın)
    const kodsuz = await http(`/api/public/dropin/${PS}`)
    if (kodsuz.status !== 404) throw new Error(`kodsuz görüntüleme ${kodsuz.status} (404 bekleniyor)`)
    // YANLIŞ kod → 404
    const yanlis = await http(`/api/public/dropin/${PS}?code=YANLIS`)
    if (yanlis.status !== 404) throw new Error(`yanlış kod ${yanlis.status} (404 bekleniyor)`)
    // DOĞRU kod → 200 ve privateCode yanıttan STRIP edilmiş olmalı
    const dogru = await http(`/api/public/dropin/${PS}?code=GIZLI42`)
    if (dogru.status !== 200 || !dogru.json?.slot) throw new Error(`doğru kodla görüntülenemedi: ${dogru.status} ${dogru.text.slice(0, 120)}`)
    if (dogru.text.includes('GIZLI42')) throw new Error('privateCode yanıtta SIZDI')

    // KODSUZ katılım → 403
    const joinKodsuz = await http(`/api/bookings/dropin/${PS}/join`, { method: 'POST', token: tok, body: {} })
    if (joinKodsuz.status !== 403) throw new Error(`kodsuz katılım ${joinKodsuz.status} (403 bekleniyor)`)
    // DOĞRU kodla katılım → başarılı
    const joinDogru = await http(`/api/bookings/dropin/${PS}/join`, { method: 'POST', token: tok, body: { privateCode: 'GIZLI42' } })
    if (joinDogru.status !== 200 && joinDogru.status !== 201) throw new Error(`kodla katılım başarısız: ${joinDogru.status} ${joinDogru.text.slice(0, 140)}`)

    await prisma.dropInParticipant.deleteMany({ where: { slotId: PS } }).catch(() => {})
    await prisma.dropInSlot.deleteMany({ where: { id: PS } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: PU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: PV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: transfer, HİÇ KREDİLENMEMİŞ puanı gerçek bakiyeye yansıtıyordu.
  // Puan kredilendirmesi rezervasyondan check-in'e taşınınca transferBooking'deki bakiye
  // senkronu artık yanlış: (a) ucuza transferde kullanıcının BAŞKA derslerden kazandığı puan
  // düşülüyor, (b) arada tier yükseldiyse derse gitmeden puan ekleniyor ve check-in'de ikinci
  // kez veriliyordu. Transfer zaten yalnız checkedIn=false rezervasyonda mümkün.
  await check('Puan: transfer bakiyeye DOKUNMAZ (kredilenmemiş puan düşülmez/eklenmez)', async () => {
    const TV = 990461, TCA = 990461, TCB = 990462, TSA = 990461, TSB = 990462, TU = 990461
    await prisma.venue.upsert({ where: { id: TV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: TV, name: 'TransferV', email: `tv${TV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: TCA }, update: { basePrice: 600, isActive: true, venueId: TV }, create: { id: TCA, venueId: TV, title: 'PahalıT', category: catName, basePrice: 600, durationMinutes: 60, capacity: 20, isActive: true } })
    await prisma.class.upsert({ where: { id: TCB }, update: { basePrice: 200, isActive: true, venueId: TV }, create: { id: TCB, venueId: TV, title: 'UcuzT', category: catName, basePrice: 200, durationMinutes: 60, capacity: 20, isActive: true } })
    const fut = new Date(Date.now() + 2 * 86400000)
    await prisma.class_Session.upsert({ where: { id: TSA }, update: { classId: TCA, startsAt: fut, status: 'open', capacity: 20 }, create: { id: TSA, classId: TCA, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.class_Session.upsert({ where: { id: TSB }, update: { classId: TCB, startsAt: fut, status: 'open', capacity: 20 }, create: { id: TSB, classId: TCB, startsAt: fut, endsAt: new Date(fut.getTime() + 3600000), capacity: 20, status: 'open' } })
    // Bakiyesi OLAN kullanıcı: başka derslerden kazanılmış 100 puan
    await prisma.booking.deleteMany({ where: { userId: TU } }).catch(() => {})
    await prisma.rewardPoint.deleteMany({ where: { userId: TU } }).catch(() => {})
    await prisma.user.upsert({ where: { id: TU }, update: { rewardPoints: 100, tierId: 1 }, create: { id: TU, username: `trf_${TU}`, email: `trf_${TU}@x.com`, passwordHash: 'x', fullName: 'Trf', tierId: 1, tierSportCounts: {}, rewardPoints: 100 } })
    const tok = jwt.sign({ userId: TU, email: `trf_${TU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })

    const bk = await http('/api/bookings', { method: 'POST', token: tok, body: { sessionId: TSA } })
    if (bk.status !== 201) throw new Error(`kurulum booking: ${bk.status} ${bk.text.slice(0, 120)}`)
    const bid = bk.json?.booking?.id
    // Rezervasyon bakiyeyi DEĞİŞTİRMEMELİ (puan check-in'de verilir)
    const uAfterBook = await prisma.user.findUnique({ where: { id: TU }, select: { rewardPoints: true } })
    if (uAfterBook?.rewardPoints !== 100) throw new Error(`rezervasyon bakiyeyi değiştirdi: ${uAfterBook?.rewardPoints} (100 bekleniyor)`)

    const tr = await http(`/api/bookings/${bid}/transfer`, { method: 'PUT', token: tok, body: { targetSessionId: TSB } })
    if (tr.status !== 200) throw new Error(`transfer: ${tr.status} ${tr.text.slice(0, 140)}`)

    // ASIL İDDİA: ucuza transfer bakiyeyi DÜŞÜRMEMELİ
    const uAfter = await prisma.user.findUnique({ where: { id: TU }, select: { rewardPoints: true } })
    if (uAfter?.rewardPoints !== 100) throw new Error(`transfer bakiyeyi değiştirdi: ${uAfter?.rewardPoints} (100 bekleniyor) — kredilenmemiş puan bakiyeden düşülüyor`)
    // Defterde transfer kaynaklı satır OLMAMALI
    const defter = await prisma.rewardPoint.findMany({ where: { userId: TU } })
    if (defter.length !== 0) throw new Error(`transfer defter satırı yazdı: ${JSON.stringify(defter.map(d => ({ p: d.points, s: d.source })))}`)
    // pointsEarned tahmini yine de tazelenmeli (ucuz seansa göre)
    const b1 = await prisma.booking.findUnique({ where: { id: bid }, select: { pointsEarned: true, finalAmount: true, sessionId: true } })
    if (b1?.sessionId !== TSB) throw new Error('transfer seansı taşımadı')
    if (b1?.finalAmount !== 200) throw new Error(`yeni tutar 200 olmalı, ${b1?.finalAmount}`)

    await prisma.booking.deleteMany({ where: { userId: TU } }).catch(() => {})
    await prisma.rewardPoint.deleteMany({ where: { userId: TU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: { in: [TSA, TSB] } } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: { in: [TCA, TCB] } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: TU } }).catch(() => {})
    await prisma.venue.deleteMany({ where: { id: TV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: salon/eğitmen realm'inde parola değişimi ESKİ JWT'leri iptal
  // etmiyordu. Token 7 gün geçerli, refresh tablosu yok → ele geçirilmiş oturum, parola
  // sıfırlansa bile 7 gün IBAN/TCKN okumaya ve ders silmeye devam ediyordu. Kullanıcı realm'i
  // bunu zaten doğru yapıyordu (asimetri yalnız salon/eğitmendeydi).
  await check('Yetki: salon parola değişimi ESKİ token\'ları iptal eder (cache dahil)', async () => {
    const PV = 990451 // 9904xx bloğunda KULLANILMAYAN id (990431 eski bir testin salonuyla çakışıyordu)
    const pw = 'EskiParola123!'
    const hash = await bcrypt.hash(pw, 12)
    // email UPDATE dalında da yazılıyor: aynı id'den kalma bayat bir satır varsa e-postası
    // farklı kalıp login adımını sahte-kırmızı yapıyordu.
    await prisma.venue.upsert({
      where: { id: PV },
      update: { email: `pv${PV}@x.com`, passwordHash: hash, passwordChangedAt: null, isApproved: true, isActive: true, isSuspended: false },
      create: { id: PV, name: 'ParolaSalon', email: `pv${PV}@x.com`, passwordHash: hash, address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 },
    })
    // iat'i GEÇMİŞE al: parola damgasıyla aynı saniyeye düşüp testi sahte-yeşil yapmasın
    const eski = jwt.sign({ venueId: PV, role: 'venue', iat: Math.floor(Date.now() / 1000) - 120 }, JWT_SECRET, { expiresIn: '7d' })

    // 1) Önce çalıştığını doğrula — ve bu istek venueState cache'ini DOLDURSUN
    const once = await http('/api/venue/me', { token: eski })
    if (once.status !== 200) throw new Error(`kurulum: eski token baştan çalışmıyor (${once.status})`)

    // 2) Parolayı panelden değiştir
    const chg = await http('/api/venue/change-password', { method: 'PUT', token: eski, body: { currentPassword: pw, newPassword: 'YeniParola123!' } })
    if (chg.status !== 200) throw new Error(`parola değiştirilemedi: ${chg.status} ${chg.text.slice(0, 120)}`)

    // 3) ESKİ token artık reddedilmeli — 60sn cache invalidate edilmezse burası hâlâ 200 döner
    const sonra = await http('/api/venue/me', { token: eski })
    if (sonra.status === 200) throw new Error('parola değiştikten SONRA eski token hâlâ geçerli (iptal yok ya da cache düşmedi)')
    if (sonra.status !== 401) throw new Error(`eski token için 401 bekleniyordu, ${sonra.status} geldi`)

    // 4) YENİ giriş çalışmalı (iptal mekanizması yeni oturumu da kilitlemesin)
    const login = await http('/api/venue/login', { method: 'POST', body: { email: `pv${PV}@x.com`, password: 'YeniParola123!' } })
    if (login.status !== 200 || !login.json?.token) throw new Error(`yeni parolayla giriş başarısız: ${login.status} ${login.text.slice(0, 140)}`)
    const yeniTok = login.json.token
    const yeni = await http('/api/venue/me', { token: yeniTok })
    if (yeni.status !== 200) throw new Error(`yeni token reddedildi: ${yeni.status} — iptal kapısı taze oturumu da kesiyor`)

    await prisma.venue.deleteMany({ where: { id: PV } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: favori listesi sözleşmesi. Uç DÜZ salon nesnesi döndürüyor
  // (favs.map(f => f.venue)); mobil ekran `{ venue: {...} }` sarmalayıcısı bekliyordu → boş
  // kartlar + karta dokununca çökme. Web aynı ucu düz biçimde doğru tüketiyordu, yani sunucu
  // doğru, istemci yanlıştı. Bu test biçimi SABİTLER: uç sarmalayıcıya dönerse burada kırılır.
  await check('Favoriler: uç DÜZ salon nesnesi döndürür (venue sarmalayıcısı YOK) + semt taşır', async () => {
    const FU = 990421
    await prisma.user.upsert({ where: { id: FU }, update: {}, create: { id: FU, username: `fav_${FU}`, email: `fav_${FU}@x.com`, passwordHash: 'x', fullName: 'Fav' } })
    await prisma.favoriteVenue.deleteMany({ where: { userId: FU } }).catch(() => {})
    await prisma.favoriteVenue.create({ data: { userId: FU, venueId: V } })
    const tok = jwt.sign({ userId: FU, email: `fav_${FU}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
    const r = await expectOk('/api/favorites/my', { token: tok })
    const list = r.json?.favorites
    if (!Array.isArray(list) || list.length !== 1) throw new Error(`favori listesi beklenmedik: ${JSON.stringify(list)?.slice(0, 120)}`)
    const f = list[0]
    if (f.venue !== undefined) throw new Error('uç venue sarmalayıcısı döndürdü — istemciler DÜZ biçim bekliyor')
    if (typeof f.id !== 'number' || typeof f.name !== 'string') throw new Error(`düz salon alanları yok: ${Object.keys(f).join(',')}`)
    if (!('neighborhood' in f)) throw new Error('neighborhood seçilmemiş — salon kartında semt satırı boş kalır')
    // Public profil ucu da AYNI biçimi vermeli (iki uç ayrışırsa istemci birinde kırılır)
    const pubUser = await prisma.user.findUnique({ where: { id: FU }, select: { username: true } })
    const p = await expectOk(`/api/favorites/user/${pubUser!.username}`)
    const pf = (p.json?.favorites || [])[0]
    if (pf && pf.venue !== undefined) throw new Error('public favori ucu farklı biçim döndürüyor (sarmalayıcı)')
    await prisma.favoriteVenue.deleteMany({ where: { userId: FU } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: FU } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: şampiyon BİLDİRİMİ hiç gitmiyordu. Rozetleri yazan sorgu başarılı,
  // ardından "bu koşuda yazılanlar"ı bulan sorgu UserBadge'de OLMAYAN createdAt alanına bakıyordu
  // (şemadaki ad earnedAt) → her koşuda Prisma hatası, dıştaki catch yutuyor, sonraki koşu
  // "zaten verildi" korumasından erken dönüyor → kayıp KALICI. Mevcut şampiyon testleri yalnız
  // ROZETİ doğruladığı için hata 19 denetim turundan geçmişti; bu test BİLDİRİMİ doğruluyor.
  await check('Sezon şampiyonu: rozetle birlikte BİLDİRİM de gider ve tekrar koşuda çiftlenmez', async () => {
    const testNow = new Date(2026, 11, 15) // biten sezon Güz 2026 (lansman zeminini geçer)
    const cur = seasonInfo(testNow)
    const prev = seasonInfo(new Date(cur.start.getTime() - 86400000))
    const scat = await prisma.sportCategory.findFirst({})
    await ensureBadges()
    const champB = await prisma.badge.findUnique({ where: { key: 'season_champion' }, select: { id: true } })
    if (!champB) throw new Error('season_champion rozeti yok (ensureBadges)')
    const NB = 990411, CL = 990411, SS = 990411, UU = 990411
    await prisma.neighborhood.upsert({ where: { id: NB }, update: {}, create: { id: NB, name: 'BildirimMah', latitude: 41, longitude: 29, cityId: 1 } })
    await prisma.class.upsert({ where: { id: CL }, update: { sportCategoryId: scat?.id ?? null }, create: { id: CL, venueId: V, title: 'BildirimDers', category: catName, sportCategoryId: scat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const inPrev = new Date(prev.start.getTime() + 5 * 86400000)
    await prisma.class_Session.upsert({ where: { id: SS }, update: { startsAt: inPrev, endsAt: new Date(inPrev.getTime() + 3600000) }, create: { id: SS, classId: CL, startsAt: inPrev, endsAt: new Date(inPrev.getTime() + 3600000), status: 'open', capacity: 20 } })
    await prisma.user.upsert({ where: { id: UU }, update: { neighborhoodId: NB, activityPrivacy: 'public', banned: false }, create: { id: UU, username: `bld_${UU}`, email: `bld_${UU}@x.com`, passwordHash: 'x', fullName: 'Bildirim', tierId: 1, tierSportCounts: {}, neighborhoodId: NB, activityPrivacy: 'public' } })
    await prisma.booking.deleteMany({ where: { userId: UU } })
    await prisma.notification.deleteMany({ where: { userId: UU } })
    await prisma.userBadge.deleteMany({ where: { badgeId: champB.id, seasonKey: prev.key } })
    await prisma.booking.create({ data: { userId: UU, sessionId: SS, status: 'confirmed', bookingType: 'class', baseAmount: 100, commissionAmount: 0, venueCommission: 0, finalAmount: 100, venuePayout: 100, bookingNumber: `BLD-${Date.now()}`, checkedIn: true, checkedInAt: new Date() } })

    await awardSeasonChampions(testNow)

    const rozet = await prisma.userBadge.findFirst({ where: { userId: UU, badgeId: champB.id, seasonKey: prev.key } })
    if (!rozet) throw new Error('şampiyon rozeti verilmedi (kurulum hatalı)')
    const bildirimler = await prisma.notification.findMany({ where: { userId: UU, messageKey: 'season_champion' } })
    if (bildirimler.length === 0) throw new Error('rozet verildi ama BİLDİRİM gitmedi (createdAt/earnedAt hatası geri geldi)')
    if (bildirimler.length !== 1) throw new Error(`tek bildirim bekleniyordu, ${bildirimler.length} tane var`)
    const p: any = bildirimler[0].messageParams
    if (!p?.season) throw new Error('bildirim parametrelerinde sezon adı yok')

    // İKİNCİ koşu: rozetler zaten var → yeni bildirim YAZILMAMALI (çift push koruması)
    await awardSeasonChampions(testNow)
    const sonra = await prisma.notification.count({ where: { userId: UU, messageKey: 'season_champion' } })
    if (sonra !== 1) throw new Error(`ikinci koşu bildirimi çiftledi: ${sonra}`)

    await prisma.userBadge.deleteMany({ where: { badgeId: champB.id, seasonKey: prev.key } }).catch(() => {})
    await prisma.notification.deleteMany({ where: { userId: UU } }).catch(() => {})
    await prisma.booking.deleteMany({ where: { userId: UU } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: SS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: CL } }).catch(() => {})
    await prisma.user.deleteMany({ where: { id: UU } }).catch(() => {})
    await prisma.neighborhood.deleteMany({ where: { id: NB } }).catch(() => {})
  })

  // Tur20 — DENETİM BULGUSU: Class_Session.capacity TOPLAM kapasitedir ve rezervasyonla
  // azalmaz. Public uçlar eskiden bu ham sayıyı "availableSpots" adıyla döndürüyordu, üç
  // istemci de KALAN YER sanıp dolu dersi "10 yer kaldı" diye gösteriyordu.
  await check('Kapasite: public uçlar KALAN yeri döndürür (kapasiteyi değil)', async () => {
    const CV = 990401, CC = 990401, CS = 990401, CU = 990401
    await prisma.booking.deleteMany({ where: { session: { classId: CC } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: CS } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: CC } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: CV }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: CV, name: 'CapV', email: `cv${CV}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: CC }, update: { isActive: true }, create: { id: CC, venueId: CV, title: 'Cap Class', category: 'Yoga', basePrice: 100, durationMinutes: 60, capacity: 10, isActive: true } })
    const st = new Date(Date.now() + 3 * 86400000)
    await prisma.class_Session.upsert({ where: { id: CS }, update: { classId: CC, startsAt: st, endsAt: new Date(st.getTime() + 3600000), capacity: 10, status: 'open' }, create: { id: CS, classId: CC, startsAt: st, endsAt: new Date(st.getTime() + 3600000), capacity: 10, status: 'open' } })
    await prisma.user.upsert({ where: { id: CU }, update: {}, create: { id: CU, username: `cap_${CU}`, email: `cap_${CU}@x.com`, passwordHash: 'x', fullName: 'Cap' } })

    // Boşken: kalan = kapasite = 10
    const bos = await expectOk(`/api/public/sessions/${CS}`)
    if (bos.json?.session?.spotsLeft !== 10) throw new Error(`boş seans spotsLeft ${bos.json?.session?.spotsLeft} (10 bekleniyor)`)
    if (bos.json?.session?.capacity !== 10) throw new Error(`capacity ${bos.json?.session?.capacity} (10 bekleniyor)`)

    // 4 kişilik rezervasyon → kalan 6, kapasite HÂLÂ 10
    await prisma.booking.create({ data: { userId: CU, sessionId: CS, status: 'confirmed', groupSize: 4, bookingType: 'class', baseAmount: 400, commissionAmount: 0, venueCommission: 0, finalAmount: 400, venuePayout: 400, bookingNumber: `CAPA-${Date.now()}` } })
    const dolu = await expectOk(`/api/public/sessions/${CS}`)
    if (dolu.json?.session?.spotsLeft !== 6) throw new Error(`4 kişi sonrası spotsLeft ${dolu.json?.session?.spotsLeft} (6 bekleniyor — kapasite dönüyor olabilir)`)
    if (dolu.json?.session?.capacity !== 10) throw new Error(`capacity rezervasyonla değişti: ${dolu.json?.session?.capacity}`)
    // Geçiş takma adı da KALAN yer anlamında olmalı (eski istemciler yanlış göstermesin)
    if (dolu.json?.session?.availableSpots !== 6) throw new Error(`availableSpots takma adı ${dolu.json?.session?.availableSpots} (6 bekleniyor)`)

    // Liste ucu da aynı sözleşmeyi vermeli
    const liste = await expectOk(`/api/public/sessions?venueId=${CV}`)
    const s = (liste.json?.sessions || []).find((x: any) => x.id === CS)
    if (!s) throw new Error('seans listede yok (kurulum hatalı)')
    if (s.spotsLeft !== 6) throw new Error(`liste spotsLeft ${s.spotsLeft} (6 bekleniyor)`)

    // Tamamen dolduğunda 0 — negatife düşmemeli
    await prisma.booking.create({ data: { userId: CU, sessionId: CS, status: 'confirmed', groupSize: 6, bookingType: 'class', baseAmount: 600, commissionAmount: 0, venueCommission: 0, finalAmount: 600, venuePayout: 600, bookingNumber: `CAPB-${Date.now()}` } })
    const full = await expectOk(`/api/public/sessions/${CS}`)
    if (full.json?.session?.spotsLeft !== 0) throw new Error(`dolu seans spotsLeft ${full.json?.session?.spotsLeft} (0 bekleniyor)`)
  })

  // Tur20 — DENETİM BULGUSU: updateSession'da kapasite doğrulaması YOKTU. Dolu seansın
  // kapasitesi doluluğun altına çekilebiliyor (aşırı satış), boş/geçersiz değer 500 veriyordu.
  await check('Kapasite: seans güncelleme doluluğun altına düşüremez ve geçersiz değeri reddeder', async () => {
    const UV2 = 990402, UC2 = 990402, US2 = 990402, UU2 = 990402
    await prisma.booking.deleteMany({ where: { session: { classId: UC2 } } }).catch(() => {})
    await prisma.class_Session.deleteMany({ where: { id: US2 } }).catch(() => {})
    await prisma.class.deleteMany({ where: { id: UC2 } }).catch(() => {})
    await prisma.venue.upsert({ where: { id: UV2 }, update: { isApproved: true, isActive: true, isSuspended: false }, create: { id: UV2, name: 'CapV2', email: `cv${UV2}@x.com`, passwordHash: 'x', address: 'A', isApproved: true, isActive: true, neighborhoodId: V, cityId: 1 } })
    await prisma.class.upsert({ where: { id: UC2 }, update: { isActive: true }, create: { id: UC2, venueId: UV2, title: 'Cap Class 2', category: 'Yoga', basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
    const st2 = new Date(Date.now() + 3 * 86400000)
    await prisma.class_Session.upsert({ where: { id: US2 }, update: { classId: UC2, startsAt: st2, endsAt: new Date(st2.getTime() + 3600000), capacity: 20, status: 'open' }, create: { id: US2, classId: UC2, startsAt: st2, endsAt: new Date(st2.getTime() + 3600000), capacity: 20, status: 'open' } })
    await prisma.user.upsert({ where: { id: UU2 }, update: {}, create: { id: UU2, username: `cap2_${UU2}`, email: `cap2_${UU2}@x.com`, passwordHash: 'x', fullName: 'Cap2' } })
    await prisma.booking.create({ data: { userId: UU2, sessionId: US2, status: 'confirmed', groupSize: 15, bookingType: 'class', baseAmount: 1500, commissionAmount: 0, venueCommission: 0, finalAmount: 1500, venuePayout: 1500, bookingNumber: `CAPC-${Date.now()}` } })

    const tok = jwt.sign({ venueId: UV2, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
    const { trYmd } = require('../src/utils/trFormat')
    const date = trYmd(new Date(Date.now() + 4 * 86400000))
    const url = `/api/venue/classes/${UC2}/sessions/${US2}`

    // 15 dolu → 5'e düşürme REDDEDİLMELİ
    const kucult = await http(url, { method: 'PUT', token: tok, body: { date, time: '10:00', capacity: 5 } })
    if (kucult.status !== 400) throw new Error(`dolu seans kapasitesi 5'e düşürülebildi: ${kucult.status} (aşırı satış)`)
    const after = await prisma.class_Session.findUnique({ where: { id: US2 } })
    if (after?.capacity !== 20) throw new Error(`red edilmesine rağmen kapasite değişti: ${after?.capacity}`)

    // Geçersiz kapasiteler 400 olmalı (500 DEĞİL)
    for (const bad of [undefined, '', 'abc', 0, -5]) {
      const r = await http(url, { method: 'PUT', token: tok, body: { date, time: '10:00', capacity: bad } })
      if (r.status !== 400) throw new Error(`geçersiz kapasite (${JSON.stringify(bad)}) → ${r.status} (400 bekleniyor)`)
    }

    // Doluluğa EŞİT ve ÜSTÜ kabul edilmeli
    const esit = await http(url, { method: 'PUT', token: tok, body: { date, time: '10:00', capacity: 15 } })
    if (esit.status !== 200) throw new Error(`doluluğa eşit kapasite reddedildi: ${esit.status}`)
    const buyut = await http(url, { method: 'PUT', token: tok, body: { date, time: '11:00', capacity: 25 } })
    if (buyut.status !== 200) throw new Error(`kapasite artırma reddedildi: ${buyut.status}`)
  })
}

async function main() {
  let server: ChildProcess | null = null
  try {
    let serverLog = ''
    server = spawn('npx', ['ts-node', 'src/index.ts'], {
      env: { ...process.env, PORT: String(PORT), DISABLE_RATE_LIMIT: 'true', ADMIN_SECRET, CRON_SECRET },
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
