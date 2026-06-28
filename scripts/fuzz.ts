/// <reference types="node" />
/**
 * KAPSAMLI FUZZ TESTİ — TÜM endpoint'leri bozuk/kötü girdiyle dövüp 5xx (sunucu hatası)
 * veren her noktayı bulur. Public + kullanıcı + salon + admin auth'larıyla.
 * Beklenti: hiçbir bozuk istek 5xx/çökme yapmamalı (400/401/403/404 OK).
 *
 * Çalıştırma:  npm run fuzz
 */
import { spawn, ChildProcess } from 'child_process'
import jwt from 'jsonwebtoken'
import prisma from '../src/utils/prisma'

const PORT = 3194
const BASE = `http://localhost:${PORT}`
const JWT_SECRET = process.env.JWT_SECRET || 'fitpass-secret-key-change-in-production'
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'fitpass-admin-2024'
const B = 970000
const U = B, V = B, C = B, S = B, NB = B

let userToken = '', venueToken = ''
const fails: string[] = []
let total = 0

type Auth = 'none' | 'user' | 'venue' | 'admin'
async function hit(label: string, method: string, path: string, auth: Auth, body?: any) {
  total++
  const headers: Record<string, string> = {}
  if (auth === 'user') headers.Authorization = `Bearer ${userToken}`
  if (auth === 'venue') headers.Authorization = `Bearer ${venueToken}`
  if (auth === 'admin') headers['x-admin-secret'] = ADMIN_SECRET
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
    if (res.status >= 500) fails.push(`[${res.status}] ${method} ${path} (${auth}) — ${label}`)
    else if (res.status === 0) fails.push(`[conn] ${method} ${path} — ${label}`)
  } catch (e: any) {
    fails.push(`[throw] ${method} ${path} — ${label}: ${e?.message}`)
  }
}

async function seed() {
  await prisma.city.upsert({ where: { id: 1 }, update: {}, create: { id: 1, name: 'İstanbul' } })
  await prisma.neighborhood.upsert({ where: { id: NB }, update: {}, create: { id: NB, name: 'FuzzMah', latitude: 41, longitude: 29, cityId: 1 } })
  const cat = await prisma.sportCategory.findFirst({})
  await prisma.venue.upsert({ where: { id: V }, update: {}, create: { id: V, name: 'Fuzz Venue', email: `fuzz${V}@x.com`, passwordHash: 'x', address: 'Adres', isApproved: true, isActive: true, neighborhoodId: NB, cityId: 1 } })
  await prisma.class.upsert({ where: { id: C }, update: {}, create: { id: C, venueId: V, title: 'Fuzz Class', category: cat?.name || 'Yoga', sportCategoryId: cat?.id ?? null, basePrice: 100, durationMinutes: 60, capacity: 20, isActive: true } })
  await prisma.class_Session.upsert({ where: { id: S }, update: {}, create: { id: S, classId: C, startsAt: new Date(Date.now() + 3 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000 + 3600000), availableSpots: 20, status: 'open' } })
  await prisma.user.upsert({ where: { id: U }, update: {}, create: { id: U, username: `fuzz_${U}`, email: `fuzz_${U}@x.com`, passwordHash: 'x', fullName: 'Fuzz User', tierSportCounts: {} } })
  userToken = jwt.sign({ userId: U, email: `fuzz_${U}@x.com` }, JWT_SECRET, { expiresIn: '1h' })
  venueToken = jwt.sign({ venueId: V, role: 'venue' }, JWT_SECRET, { expiresIn: '1h' })
}
async function cleanup() {
  await prisma.booking.deleteMany({ where: { OR: [{ userId: U }, { sessionId: S }] } }).catch(() => {})
  await prisma.class_Session.deleteMany({ where: { id: S } }).catch(() => {})
  await prisma.class.deleteMany({ where: { id: C } }).catch(() => {})
  await prisma.venue.deleteMany({ where: { id: V } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: U } }).catch(() => {})
  await prisma.neighborhood.deleteMany({ where: { id: NB } }).catch(() => {})
}

const HUGE = 'x'.repeat(5000)

async function run() {
  // ───────── PUBLIC ─────────
  await hit('venueId=abc', 'GET', '/api/public/sessions?venueId=abc', 'none')
  await hit('neighborhoodId=abc', 'GET', '/api/public/sessions?neighborhoodId=abc', 'none')
  await hit('nearby userNb=abc', 'GET', '/api/public/sessions?sort=nearby&userNeighborhoodId=abc', 'none')
  await hit('bad dates', 'GET', '/api/public/sessions?dateFrom=xxx&dateTo=yyy', 'none')
  await hit('huge category', 'GET', `/api/public/sessions?category=${HUGE}`, 'none')
  await hit('session abc', 'GET', '/api/public/sessions/abc', 'none')
  await hit('session huge', 'GET', '/api/public/sessions/999999999999999999999', 'none')
  await hit('venue abc', 'GET', '/api/public/venues/abc', 'none')
  await hit('dropin abc', 'GET', '/api/public/dropin/abc', 'none')
  await hit('instructor abc', 'GET', '/api/public/instructors/abc', 'none')
  await hit('user weird', 'GET', '/api/public/users/..%2F..', 'none')
  await hit('search empty', 'GET', '/api/public/users-search?q=', 'none')
  await hit('search huge', 'GET', `/api/public/users-search?q=${HUGE}`, 'none')
  await hit('coupon missing', 'POST', '/api/public/validate-coupon', 'none', {})
  await hit('coupon bad venue', 'POST', '/api/public/validate-coupon', 'none', { code: 'X', venueId: 'abc' })
  await hit('complaint missing', 'POST', '/api/public/complaint', 'none', {})
  await hit('complaint bad email', 'POST', '/api/public/complaint', 'none', { name: 'a', email: 'notanemail', subject: 's', message: HUGE })

  // ───────── AUTH ─────────
  await hit('register empty', 'POST', '/api/auth/register', 'none', {})
  await hit('register bad email', 'POST', '/api/auth/register', 'none', { username: 'u', email: 'bad', password: 'short', fullName: 'x' })
  await hit('login empty', 'POST', '/api/auth/login', 'none', {})
  await hit('login wrong', 'POST', '/api/auth/login', 'none', { email: 'nope@x.com', password: 'whatever' })
  await hit('change-pw missing', 'PUT', '/api/auth/change-password', 'user', {})
  await hit('profile bad nb', 'PUT', '/api/auth/profile', 'user', { neighborhoodId: 'abc' })
  await hit('profile huge', 'PUT', '/api/auth/profile', 'user', { fullName: HUGE, bio: HUGE })
  await hit('privacy weird', 'PUT', '/api/auth/privacy', 'user', { activityPrivacy: HUGE })
  await hit('notif bad', 'PUT', '/api/auth/notifications', 'user', { emailReminders: 'notbool' })
  await hit('verify missing', 'POST', '/api/auth/verify-email', 'none', {})
  await hit('verify bad', 'POST', '/api/auth/verify-email', 'none', { token: 'xxx' })
  await hit('reset missing', 'POST', '/api/auth/reset-password', 'none', {})
  await hit('forgot bad', 'POST', '/api/auth/forgot-password', 'none', { email: 'x' })
  await hit('push missing', 'POST', '/api/auth/push-token', 'user', {})
  await hit('push num', 'POST', '/api/auth/push-token', 'user', { pushToken: 123 })

  // ───────── BOOKINGS ─────────
  await hit('book abc', 'POST', '/api/bookings', 'user', { sessionId: 'abc' })
  await hit('book empty', 'POST', '/api/bookings', 'user', {})
  await hit('book bad group', 'POST', '/api/bookings', 'user', { sessionId: S, groupSize: 'x', taggedUsernames: 'notarray' })
  await hit('cancel abc', 'PUT', '/api/bookings/abc/cancel', 'user')
  await hit('cancel 99999', 'PUT', '/api/bookings/99999/cancel', 'user')
  await hit('transfer-opt abc', 'GET', '/api/bookings/abc/transfer-options', 'user')
  await hit('transfer missing', 'PUT', '/api/bookings/1/transfer', 'user', {})
  await hit('transfer bad', 'PUT', '/api/bookings/abc/transfer', 'user', { targetSessionId: 'x' })
  await hit('join abc', 'POST', '/api/bookings/dropin/abc/join', 'user')
  await hit('checkin missing', 'POST', '/api/bookings/checkin', 'venue', {})
  await hit('checkin bad', 'POST', '/api/bookings/checkin', 'venue', { code: 'NOTACODE' })
  await hit('dropin-checkin bad', 'POST', '/api/bookings/dropin-checkin', 'venue', { code: 'x' })

  // ───────── REVIEWS ─────────
  await hit('review abc', 'POST', '/api/reviews', 'user', { bookingId: 'abc', rating: 5 })
  await hit('review empty', 'POST', '/api/reviews', 'user', {})
  await hit('review bad rating', 'POST', '/api/reviews', 'user', { bookingId: 1, rating: 99 })
  await hit('review huge', 'POST', '/api/reviews', 'user', { bookingId: 1, rating: 5, comment: HUGE })
  await hit('venue reviews abc', 'GET', '/api/reviews/venue/abc', 'none')
  await hit('reply abc', 'PUT', '/api/reviews/abc/reply', 'venue', { reply: 'x' })
  await hit('reply empty', 'PUT', '/api/reviews/1/reply', 'venue', {})
  await hit('reply huge', 'PUT', '/api/reviews/1/reply', 'venue', { reply: HUGE })

  // ───────── SOCIAL ─────────
  await hit('follow weird', 'POST', '/api/social/follow/..%2F..', 'user')
  await hit('follow self', 'POST', `/api/social/follow/fuzz_${U}`, 'user')
  await hit('unfollow nope', 'DELETE', '/api/social/unfollow/yokboyle', 'user')
  await hit('status weird', 'GET', '/api/social/status/yokboyle', 'user')
  await hit('followers weird', 'GET', '/api/social/followers/yokboyle', 'none')
  await hit('like weird', 'POST', '/api/social/feed/zzz-999/like', 'user')
  await hit('unlike weird', 'DELETE', '/api/social/feed/zzz-999/like', 'user')
  await hit('comment empty', 'POST', '/api/social/feed/b-1/comments', 'user', { content: '' })
  await hit('comment bad parent', 'POST', '/api/social/feed/b-1/comments', 'user', { content: 'hi', parentId: 'abc' })
  await hit('comment huge', 'POST', '/api/social/feed/b-1/comments', 'user', { content: HUGE })
  await hit('lb nb=abc', 'GET', '/api/social/leaderboard/users?neighborhoodId=abc', 'none')
  await hit('lb huge branch', 'GET', `/api/social/leaderboard/streaks?branch=${HUGE}`, 'none')

  // ───────── FAVORITES / WAITLIST ─────────
  await hit('fav status abc', 'GET', '/api/favorites/status/abc', 'user')
  await hit('fav add abc', 'POST', '/api/favorites/abc', 'user')
  await hit('fav del abc', 'DELETE', '/api/favorites/abc', 'user')
  await hit('fav user weird', 'GET', '/api/favorites/user/yokboyle', 'none')

  // ───────── VENUE PANEL ─────────
  await hit('class empty', 'POST', '/api/venue/classes', 'venue', {})
  await hit('class bad', 'POST', '/api/venue/classes', 'venue', { title: HUGE, basePrice: 'x', capacity: -5, duration: 'y' })
  await hit('session abc', 'POST', '/api/venue/classes/abc/sessions', 'venue', {})
  await hit('session bad', 'POST', `/api/venue/classes/${C}/sessions`, 'venue', { date: 'bad', time: 'bad', capacity: 'x' })
  await hit('del session abc', 'DELETE', '/api/venue/classes/abc/sessions/abc', 'venue')

  // ───────── ADMIN ─────────
  await hit('approve abc', 'PUT', '/api/admin/venues/abc/approve', 'admin')
  await hit('del venue abc', 'DELETE', '/api/admin/venues/abc', 'admin')
  await hit('ban abc', 'PUT', '/api/admin/users/abc/ban', 'admin')
  await hit('cat empty', 'POST', '/api/admin/categories', 'admin', {})
  await hit('cat update abc', 'PUT', '/api/admin/categories/abc', 'admin', {})
  await hit('cat del abc', 'DELETE', '/api/admin/categories/abc', 'admin')
  await hit('report resolve abc', 'PUT', '/api/admin/reports/abc/resolve', 'admin')

  // Malformed JSON gövde
  total++
  try {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bozuk' })
    if (r.status >= 500) fails.push(`[${r.status}] bozuk JSON gövde`)
  } catch (e: any) { fails.push(`[throw] bozuk JSON: ${e?.message}`) }
}

async function waitForServer() {
  for (let i = 0; i < 90; i++) { try { const r = await fetch(BASE + '/'); if (r.ok) return } catch {} await new Promise(r => setTimeout(r, 1000)) }
  throw new Error('Sunucu başlamadı')
}

async function main() {
  let server: ChildProcess | null = null
  let log = ''
  try {
    server = spawn('npx', ['ts-node', 'src/index.ts'], { env: { ...process.env, PORT: String(PORT), DISABLE_RATE_LIMIT: 'true' }, detached: true })
    server.stdout?.on('data', d => { log += d }); server.stderr?.on('data', d => { log += d })
    try { await waitForServer() } catch (e) { console.error('Sunucu log:\n', log.slice(0, 1200)); throw e }
    await seed()
    await run()
  } catch (e: any) {
    fails.push(`KURULUM — ${e.message}`)
  } finally {
    await cleanup().catch(() => {})
    if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
  }

  console.log('\n=== KAPSAMLI FUZZ TESTİ ===')
  console.log(`${total} bozuk istek atıldı.`)
  if (fails.length === 0) {
    console.log('✅ Hiçbir endpoint 5xx/çökme yapmadı — tüm bozuk girdiler düzgün ele alındı.')
  } else {
    console.log(`❌ ${fails.length} sorunlu uç:`)
    fails.forEach(f => console.log('   ' + f))
  }
  await prisma.$disconnect()
  process.exit(fails.length > 0 ? 1 : 0)
}

main()
