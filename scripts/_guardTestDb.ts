/**
 * TEST VERİTABANI GÜVENLİK KİLİDİ — her test harness'inin (smoke/stress/fuzz/chaos) EN BAŞINDA,
 * `dotenv/config` importundan HEMEN SONRA çağrılır.
 *
 * NEDEN VAR: harness'ler `import 'dotenv/config'` ile .env'i yükler, AMA dotenv dışarıdan zaten
 * EXPORT EDİLMİŞ bir değişkeni EZMEZ. Yani tek bir `export DATABASE_URL=<prod>` (kabuk geçmişinden
 * yanlış satır, açık kalmış bir terminal, kopyalanan bir komut) sonrasında `npm run smoke` sessizce
 * CANLI veritabanına bağlanır. Harness'ler seed eder ve cleanup()'ta deleteMany çalıştırır → gerçek
 * kullanıcı/salon/rezervasyon verisi silinebilir. Bu, geri dönüşü olmayan bir hata sınıfı olduğu için
 * uyarı değil, HARD STOP olarak ele alınır.
 *
 * KURAL: yalnız YEREL host'a izin verilir (localhost / 127.0.0.1 / ::1). CI de localhost'taki
 * postgres service container'ını kullandığı için (.github/workflows/ci.yml) engellenmez.
 * Bilinçli bir uzak test DB'si gerekiyorsa: ALLOW_REMOTE_TEST_DB=true ile açıkça izin ver.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', ''])

export function guardTestDb(harnessName: string): void {
  const url = process.env.DATABASE_URL || ''
  if (!url) {
    console.error(`\n❌ ${harnessName}: DATABASE_URL yok. .env dosyanı kontrol et.\n`)
    process.exit(1)
  }

  if (process.env.ALLOW_REMOTE_TEST_DB === 'true') {
    console.warn(`⚠️  ${harnessName}: ALLOW_REMOTE_TEST_DB=true — uzak DB kilidi BİLEREK devre dışı.`)
    return
  }

  let host = ''
  try {
    // postgresql://user:pass@host:port/db → URL parse yeterli; bozuk URL'de aşağıdaki catch devreye girer.
    host = new URL(url).hostname
  } catch {
    console.error(`\n❌ ${harnessName}: DATABASE_URL ayrıştırılamadı — güvenli tarafta kalıp duruyorum.\n`)
    process.exit(1)
  }

  if (!LOCAL_HOSTS.has(host)) {
    console.error(
      `\n❌ ${harnessName} DURDURULDU — DATABASE_URL yerel değil (host: ${host}).\n` +
      `   Bu harness veri SEED EDER ve cleanup()'ta SİLER. Uzak/canlı bir veritabanında çalıştırmak\n` +
      `   gerçek veriyi yok edebilir.\n\n` +
      `   Muhtemel sebep: kabukta 'export DATABASE_URL=...' kalmış (dotenv onu EZMEZ).\n` +
      `   Çözüm:  unset DATABASE_URL   → sonra tekrar dene (.env'deki yerel değer kullanılır).\n` +
      `   Gerçekten uzak bir TEST veritabanı istiyorsan: ALLOW_REMOTE_TEST_DB=true ile çalıştır.\n`
    )
    process.exit(1)
  }
}
