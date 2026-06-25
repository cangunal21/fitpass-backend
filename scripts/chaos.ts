/// <reference types="node" />
/**
 * KAOS / DAYANIKLILIK TESTİ — "tek bir hata tüm sistemi düşürmez" güvencesini KANITLAR.
 * Kasıtlı hata enjekte eder (sync/async throw, next(err), yakalanmamış promise reddi,
 * uncaughtException) ve her seferinde:
 *   (a) hatalı istek temiz 500/200 alır (çökme/asılma yok),
 *   (b) sunucu AYAKTA kalır,
 *   (c) diğer (iyi) istekler etkilenmeden 200 döner.
 *
 * Çalıştırma:  npm run chaos   (sunucuyu CHAOS_TEST modunda test portunda açar)
 */
import { spawn, ChildProcess } from 'child_process'

const PORT = 3197
const BASE = `http://localhost:${PORT}`

let pass = 0, fail = 0
const lines: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; lines.push(`  ✅ ${name}`) }
  else { fail++; lines.push(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

async function http(path: string) {
  try {
    const res = await fetch(BASE + path)
    return { status: res.status }
  } catch (e: any) {
    return { status: 0, err: e?.message }
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const GOOD = '/api/public/categories'

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return } catch {}
    await sleep(1000)
  }
  throw new Error('Sunucu başlamadı')
}

async function run() {
  // Her senaryo: hatayı enjekte et → sunucunun ayakta + iyi isteğin 200 olduğunu doğrula.

  // C1: Senkron throw → 500 (Express yakalar), sunucu ayakta, izolasyon korunur
  {
    const bad = await http('/_chaos/throw-sync')
    const good = await http(GOOD)
    ok('C1 senkron throw: hatalı istek 500 (çökme/asılma yok)', bad.status === 500, `status=${bad.status}`)
    ok('C1 senkron throw: sunucu ayakta + iyi istek 200', good.status === 200, `good=${good.status}`)
  }

  // C2: Async throw (await sonrası) → Express 5 yakalar → 500, request asılı kalmaz
  {
    const bad = await http('/_chaos/throw-async')
    const good = await http(GOOD)
    ok('C2 async throw: hatalı istek 500 (asılı kalmadı)', bad.status === 500, `status=${bad.status}`)
    ok('C2 async throw: sunucu ayakta + iyi istek 200', good.status === 200, `good=${good.status}`)
  }

  // C3: next(err) → error middleware → 500
  {
    const bad = await http('/_chaos/next-error')
    const good = await http(GOOD)
    ok('C3 next(err): hatalı istek 500', bad.status === 500, `status=${bad.status}`)
    ok('C3 next(err): sunucu ayakta + iyi istek 200', good.status === 200, `good=${good.status}`)
  }

  // C4: Yakalanmamış promise reddi → unhandledRejection handler → sunucu ayakta
  {
    const r = await http('/_chaos/reject-unhandled')
    await sleep(100) // reddin işlenmesini bekle
    const good = await http(GOOD)
    ok('C4 yakalanmamış promise: istek 200 döndü', r.status === 200, `status=${r.status}`)
    ok('C4 yakalanmamış promise: sunucu ÇÖKMEDİ, iyi istek 200', good.status === 200, `good=${good.status}`)
  }

  // C5: setTimeout içinde throw → uncaughtException handler → sunucu ayakta (EN kritik)
  {
    const r = await http('/_chaos/uncaught')
    await sleep(150) // setTimeout'un (10ms) ateşlenmesini bekle
    const good1 = await http(GOOD)
    const good2 = await http('/')
    ok('C5 uncaughtException: istek 200 döndü', r.status === 200, `status=${r.status}`)
    ok('C5 uncaughtException: sunucu ÇÖKMEDİ, iyi istek 200', good1.status === 200, `good=${good1.status}`)
    ok('C5 uncaughtException: health endpoint 200', good2.status === 200, `health=${good2.status}`)
  }

  // C6: KARIŞIK yük altında izolasyon — 40 hata + 60 iyi istek iç içe.
  //     Beklenti: TÜM iyi istekler 200; sunucu ayakta.
  {
    const chaosPaths = ['/_chaos/throw-sync', '/_chaos/throw-async', '/_chaos/next-error', '/_chaos/reject-unhandled', '/_chaos/uncaught']
    const ops: Promise<{ status: number; good: boolean }>[] = []
    for (let i = 0; i < 100; i++) {
      if (i % 5 === 0) ops.push(http(chaosPaths[(i / 5) % chaosPaths.length]).then(r => ({ status: r.status, good: false })))
      else ops.push(http(GOOD).then(r => ({ status: r.status, good: true })))
    }
    const res = await Promise.all(ops)
    const goods = res.filter(r => r.good)
    const goodOk = goods.filter(r => r.status === 200).length
    const conns = res.filter(r => r.status === 0).length
    await sleep(150)
    const alive = await http('/')
    ok('C6 karışık yük: TÜM iyi istekler 200 (hatalılar etkilemedi)', goodOk === goods.length, `${goodOk}/${goods.length} iyi 200`)
    ok('C6 karışık yük: bağlantı hatası yok', conns === 0, `conn=${conns}`)
    ok('C6 karışık yük: yağmurdan sonra sunucu ayakta', alive.status === 200, `health=${alive.status}`)
  }

  // C7: Tek bir bozuk uç 50x dövülürken iyi uç hep 200 mü?
  {
    const hammer = await Promise.all(Array.from({ length: 50 }, () => http('/_chaos/throw-sync')))
    const conns = hammer.filter(r => r.status === 0).length
    const goods = await Promise.all(Array.from({ length: 20 }, () => http(GOOD)))
    const goodOk = goods.filter(r => r.status === 200).length
    ok('C7 50x bozuk uç: bağlantı kopması yok (hepsi 500)', conns === 0, `conn=${conns}`)
    ok('C7 dövme sırasında iyi uç hep 200', goodOk === 20, `${goodOk}/20`)
  }
}

async function main() {
  let server: ChildProcess | null = null
  let log = ''
  try {
    server = spawn('npx', ['ts-node', 'src/index.ts'], {
      env: { ...process.env, PORT: String(PORT), CHAOS_TEST: 'true', DISABLE_RATE_LIMIT: 'true' },
      detached: true,
    })
    server.stdout?.on('data', d => { log += d }); server.stderr?.on('data', d => { log += d })
    try { await waitForServer() } catch (e) { console.error('Sunucu log:\n', log.slice(0, 1200)); throw e }
    await run()
    // Sunucu hâlâ hata loglarını basıyor olmalı ama çalışıyor olmalı (kanıt)
    const crashed = /Cannot find module|SyntaxError|EADDRINUSE/.test(log)
    ok('Genel: sunucu süreci boyunca çökme/yeniden başlatma yok', !crashed)
  } catch (e: any) {
    fail++; lines.push(`  ❌ KURULUM — ${e.message}`)
  } finally {
    if (server?.pid) { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
  }

  console.log('\n=== KAOS / DAYANIKLILIK TESTİ ===')
  console.log(lines.join('\n'))
  console.log(`\n${pass} geçti, ${fail} başarısız`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
