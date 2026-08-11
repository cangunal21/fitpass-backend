#!/usr/bin/env node
/*
 * ŞEMA DEPLOY — `prisma db push` YERİNE.
 *
 * NEDEN DEĞİŞTİ (10 Ağu 2026, ölçülerek bulundu):
 * `npm start` her açılışta `prisma db push` çalıştırıyordu. Yerelde denendi: şemadan bir kolon
 * silindiğinde `db push`, 7 satırlık tablodan o kolonu **SESSİZCE DÜŞÜRDÜ** — uyarı yok,
 * onay yok, çıkış kodu 0. Yani şemaya yanlışlıkla dokunan (ya da kötü biten bir merge yapan)
 * biri, bir sonraki deploy'da ÜRETİM VERİSİNİ kalıcı olarak kaybedebiliyordu. `db push` bir
 * prototipleme aracıdır; sürüm geçmişi, gözden geçirme ve geri alma imkânı yoktur.
 *
 * BU BETİK NE YAPAR
 *  1) YIKICI SQL KAPISI — uygulanmamış migration dosyalarında DROP/RENAME/NOT NULL gibi
 *     veri kaybettirebilecek ifade varsa deploy'u DURDURUR. Bilerek yapılıyorsa migration
 *     dosyasının başına `-- ALLOW-DESTRUCTIVE: <gerekçe>` yazılması gerekir (bilinçli karar
 *     git'te iz bırakır).
 *  2) İLK GEÇİŞ (baseline) — veritabanında tablolar var ama migration geçmişi yoksa (bugünkü
 *     `db push` ile yönetilen durum), 0_init migration'ı ÇALIŞTIRILMADAN "uygulanmış" işaretlenir.
 *     Aksi halde `migrate deploy` mevcut tabloları yeniden yaratmaya çalışıp patlardı.
 *  3) `prisma migrate deploy` — yalnızca bekleyen migration'ları uygular.
 *
 * NEREDE ÇALIŞIR: railway.json → deploy.preDeployCommand. Hata verirse Railway deploy'u
 * durdurur ve ESKİ sürüm trafiğe hizmet vermeye devam eder (güvenli başarısızlık).
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations')
const BASELINE = '0_init'

// Veri kaybettirebilecek ifadeler. Eşleşme YORUM SATIRLARI ATILDIKTAN sonra yapılır.
const YIKICI = [
  { re: /\bDROP\s+TABLE\b/i, ad: 'DROP TABLE' },
  { re: /\bDROP\s+COLUMN\b/i, ad: 'DROP COLUMN' },
  { re: /\bDROP\s+SCHEMA\b/i, ad: 'DROP SCHEMA' },
  { re: /\bRENAME\s+(COLUMN|TO)\b/i, ad: 'RENAME (kolon/tablo yeniden adlandırma)' },
  { re: /\bSET\s+NOT\s+NULL\b/i, ad: 'SET NOT NULL (mevcut NULL satırlarda patlar)' },
  { re: /\bDROP\s+CONSTRAINT\b/i, ad: 'DROP CONSTRAINT' },
  { re: /\bTRUNCATE\b/i, ad: 'TRUNCATE' },
]

const log = (m) => console.log(`[db-deploy] ${m}`)
const hata = (m) => console.error(`[db-deploy] ❌ ${m}`)

function prisma(args) {
  execFileSync('npx', ['prisma', ...args], { stdio: 'inherit', cwd: path.join(__dirname, '..') })
}

function migrationKlasorleri() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, 'migration.sql')))
    .sort()
}

/** SQL'i yorumlardan arındır — "-- DROP COLUMN yapma" gibi bir NOT yanlış alarm vermesin. */
function yorumsuz(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* blok */
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))  // -- satır sonu
    .join('\n')
}

/** Bir migration SQL'inde yıkıcı ifade var mı? (saf fonksiyon — testten çağrılır) */
function yikiciBul(ham) {
  if (/--\s*ALLOW-DESTRUCTIVE:/i.test(ham)) return []          // bilinçli karar, git'te izli
  const sql = yorumsuz(ham)
  return YIKICI.filter((y) => y.re.test(sql)).map((y) => y.ad)
}

async function main() {
  // Şemadaki datasource bloğunda `url` YOK (prisma.config.ts'ten geliyor) → üretilen client
  // bağlantıyı kendi bulamıyor; uygulamanın kendi kurulumuyla (adapter) AYNI şekilde kurulur.
  const { PrismaClient } = require('@prisma/client')
  const { PrismaPg } = require('@prisma/adapter-pg')
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) { hata('DATABASE_URL tanımlı değil'); process.exit(1) }
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 2 }) })

  let tablolarVar = false
  let gecmisVar = false
  let uygulanmis = new Set()

  try {
    const r = await db.$queryRawUnsafe(
      `SELECT to_regclass('public."User"') IS NOT NULL AS tablolar,
              to_regclass('public._prisma_migrations') IS NOT NULL AS gecmis`
    )
    tablolarVar = !!r[0].tablolar
    gecmisVar = !!r[0].gecmis
    if (gecmisVar) {
      const m = await db.$queryRawUnsafe(
        `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`
      )
      uygulanmis = new Set(m.map((x) => x.migration_name))
    }
  } finally {
    await db.$disconnect().catch(() => {})
  }

  log(`durum: tablolar=${tablolarVar ? 'var' : 'yok'}, migration geçmişi=${gecmisVar ? 'var' : 'yok'}, uygulanmış=${uygulanmis.size}`)

  // ── 1) YIKICI SQL KAPISI (yalnız BEKLEYEN migration'lar) ──────────────────
  const bekleyen = migrationKlasorleri().filter((d) => !uygulanmis.has(d))
  // İlk geçişte 0_init zaten "uygulanmış" sayılacak → onu tarama (mevcut şemanın fotoğrafı).
  const taranacak = bekleyen.filter((d) => !(tablolarVar && !gecmisVar && d === BASELINE))

  const bulgular = []
  for (const d of taranacak) {
    const ham = fs.readFileSync(path.join(MIGRATIONS_DIR, d, 'migration.sql'), 'utf8')
    if (/--\s*ALLOW-DESTRUCTIVE:/i.test(ham)) {
      log(`⚠️  ${d}: ALLOW-DESTRUCTIVE işaretli — yıkıcı kontrol atlandı (bilinçli karar)`)
      continue
    }
    for (const ad of yikiciBul(ham)) bulgular.push(`${d} → ${ad}`)
  }

  if (bulgular.length) {
    hata('Bekleyen migration\'larda VERİ KAYBETTİREBİLECEK ifade var, deploy DURDURULDU:')
    for (const b of bulgular) console.error(`        • ${b}`)
    console.error('')
    console.error('  Neden: bu deploy sırasında eski ve yeni konteyner ~20 sn BİRLİKTE çalışır')
    console.error('  (railway.json → overlapSeconds). Kolon/tablo o anda kaybolursa eski konteyner')
    console.error('  hata verir; veri kaybı ise geri alınamaz.')
    console.error('')
    console.error('  DOĞRU YOL — iki aşamalı:')
    console.error('    1) Bu deploy: yeni alanı EKLE, kodu iki alanı da okuyacak/yazacak hâle getir.')
    console.error('    2) Sonraki deploy: eski alanı kaldıran migration\'ı yaz.')
    console.error('  Kolon ADI değiştiriyorsan DB\'ye hiç dokunma: Prisma\'da @map kullan.')
    console.error('    örnek: capacity Int @map("availableSpots")')
    console.error('')
    console.error('  Gerçekten bilinçli bir silme ise migration.sql\'in başına şunu ekle:')
    console.error('    -- ALLOW-DESTRUCTIVE: <neden güvenli olduğunu tek cümleyle yaz>')
    process.exit(1)
  }

  // ── 2) İLK GEÇİŞ (baseline) ───────────────────────────────────────────────
  if (tablolarVar && !gecmisVar) {
    log(`ilk geçiş: veritabanı zaten dolu, "${BASELINE}" ÇALIŞTIRILMADAN uygulanmış işaretleniyor`)
    prisma(['migrate', 'resolve', '--applied', BASELINE])
  }

  // ── 3) BEKLEYENLERİ UYGULA ────────────────────────────────────────────────
  log('prisma migrate deploy')
  prisma(['migrate', 'deploy'])
  log('✅ şema güncel')
}

module.exports = { yikiciBul, yorumsuz }

// Doğrudan çalıştırıldığında deploy'u yap; require edildiğinde yalnız fonksiyonları ver.
if (require.main === module) {
  main().catch((e) => {
    hata(e?.message || e)
    process.exit(1)
  })
}
