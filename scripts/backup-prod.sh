#!/usr/bin/env bash
# KANITLANMIS prod yedegi: yedegi alir + GERI YUKLEMEYI test eder + satir sayilarini karsilastirir.
#
# Neden boyle: "yedek aldim" demek yetmez — hic denenmemis yedek, yedek sayilmaz. Bozuk/eksik bir dump
# dosyasi ancak gercekten geri yuklemeye calisinca anlasilir, ve o an genellikle veri kaybedilmis andir.
# Bu betik her kosuda: (1) prod'u dosyaya alir, (2) YEREL gecici bir veritabanina geri yukler,
# (3) her tablonun satir sayisini kaynakla karsilastirir, (4) gecici veritabanini siler.
#
# Kullanim:
#   ./scripts/backup-prod.sh "postgresql://kullanici:sifre@host:port/veritabani"
#   (URL'yi Railway > Postgres servisi > Variables > DATABASE_PUBLIC_URL'den kopyala)
#
# GUVENLIK: prod'a SADECE OKUMA yapar (pg_dump). Geri yukleme HER ZAMAN yerel gecici db'ye yapilir;
# uzak bir hedefe asla yazmaz.
set -euo pipefail

PROD_URL="${1:-${PROD_DATABASE_URL:-}}"

# ── PAROLAYI KOMUT SATIRINDAN CIKAR ─────────────────────────────────────────────────────────────
# `psql "postgresql://kullanici:PAROLA@host/db"` cagrisinda baglanti adresi bir KOMUT SATIRI
# ARGUMANIDIR; makinedeki her yerel surec `ps`/`pgrep -f` ile onu okuyabilir. 18 Agu 2026'da bu
# somut olarak gerceklesti: bir surec listesi alindi ve prod parolasi cikti. Parola artik PGPASSWORD
# ortam degiskeniyle gecirilir (surec ortami, komut satirinin aksine, baska kullanicilara kapalidir);
# komut satirinda yalnizca kullanici@host/db kalir.
_urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }
PROD_URL_GUVENLI="$PROD_URL"
if [[ "$PROD_URL" =~ ^([a-zA-Z+]+)://([^:@/]+):([^@]+)@(.+)$ ]]; then
  PGPASSWORD="$(_urldecode "${BASH_REMATCH[3]}")"; export PGPASSWORD
  PROD_URL_GUVENLI="${BASH_REMATCH[1]}://${BASH_REMATCH[2]}@${BASH_REMATCH[4]}"
fi

if [[ -z "$PROD_URL_GUVENLI" ]]; then
  echo "HATA: prod veritabani URL'si gerekli."
  echo "Kullanim: $0 \"postgresql://...\"   (ya da PROD_DATABASE_URL ortam degiskeni)"
  exit 1
fi
if [[ "$PROD_URL_GUVENLI" != postgres* ]]; then
  echo "HATA: URL 'postgresql://' ile baslamali."
  exit 1
fi

STAMP="$(date +%Y-%m-%d-%H%M)"
OUT="${BACKUP_DIR:-$HOME/Desktop}/sipsakspor-prod-${STAMP}.dump"
TMPDB="fitpass_restore_test_${STAMP//-/_}"

# --- SURUM ESLESTIRME (kritik) ---------------------------------------------------------------
# pg_dump, KENDISINDEN YENI bir sunucuyu yedeklemeyi REDDEDER (dogru davranis: eksik/bozuk yedek
# uretmesin). Olculdu: Railway prod = PostgreSQL 18.4, yerel varsayilan istemci = 16.14 ->
# "aborting because of server version mismatch". Bu yuzden sunucunun majör surumunu OKUYUP ona
# uyan istemciyi seciyoruz; yoksa net bir kurulum talimati verip duruyoruz (sessizce yarim
# yedek almaktan iyidir).
PSQL_ANY="$(command -v psql || true)"
[[ -z "$PSQL_ANY" ]] && { echo "HATA: psql bulunamadi (PostgreSQL istemcisi kurulu degil)."; exit 1; }
SRV_FULL="$("$PSQL_ANY" "$PROD_URL_GUVENLI" -tAc "SHOW server_version" 2>/dev/null | tr -d '[:space:]')" || true
if [[ -z "$SRV_FULL" ]]; then
  echo "HATA: prod veritabanina baglanilamadi. URL'yi ve ag erisimini kontrol et."
  exit 1
fi
SRV_MAJOR="${SRV_FULL%%.*}"
echo "prod sunucu surumu: $SRV_FULL (major $SRV_MAJOR)"

# Uyan istemciyi bul: PG_BIN env > brew keg (Intel/ARM) > PATH
find_pg_bin() {
  if [[ -n "${PG_BIN:-}" ]]; then echo "$PG_BIN"; return; fi
  for c in "/usr/local/opt/postgresql@${SRV_MAJOR}/bin" "/opt/homebrew/opt/postgresql@${SRV_MAJOR}/bin"; do
    [[ -x "$c/pg_dump" ]] && { echo "$c"; return; }
  done
  local pathv; pathv="$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
  [[ "$pathv" == "$SRV_MAJOR" ]] && { dirname "$(command -v pg_dump)"; return; }
  echo ""
}
PG_BIN_DIR="$(find_pg_bin)"
if [[ -z "$PG_BIN_DIR" ]]; then
  # Eslesen pg_dump yok. ELLERI HAVAYA KALDIRMIYORUZ: surumden bagimsiz (sema SQL + tablo basina CSV)
  # yedege dusuyoruz. psql, kendinden yeni sunucuya baglanabildigi icin bu yol calisir ve ciktisi
  # HERHANGI bir PostgreSQL surumune geri yuklenebilir. Kullanici tek komutla yedegini alir.
  echo ""
  echo "NOT: prod PostgreSQL $SRV_MAJOR, bu makinedeki pg_dump ise daha eski -> pg_dump kullanilamaz."
  echo "     Surumden BAGIMSIZ yedege geciliyor (sema SQL + tablo basina CSV). Ayni guvence:"
  echo "     yedek gercekten geri yuklenip satir sayisi ve icerik ozeti karsilastirilacak."
  echo "     (Istersen yerel istemciyi de kurabilirsin: brew install postgresql@${SRV_MAJOR})"
  echo ""
  # URL ARGUMAN OLARAK GECIRILMEZ: cocuk surecin komut satiri da `ps` ile okunabilir. Ortamdan
  # gecirilir (betikler zaten PROD_DATABASE_URL'e dusuyor). Parola ayrica PGPASSWORD'de.
  PROD_DATABASE_URL="$PROD_URL" exec bash "$(dirname "$0")/backup-prod-logical.sh"
fi
PGDUMP="$PG_BIN_DIR/pg_dump"; PGRESTORE="$PG_BIN_DIR/pg_restore"
PSQL="$PG_BIN_DIR/psql"; CREATEDB="$PG_BIN_DIR/createdb"; DROPDB="$PG_BIN_DIR/dropdb"
echo "kullanilan istemci: $("$PGDUMP" --version)"
# ---------------------------------------------------------------------------------------------

echo "=== 1/4 Prod yedegi aliniyor (salt okuma) ==="
"$PGDUMP" "$PROD_URL_GUVENLI" -Fc --no-owner --no-privileges -f "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
echo "    dosya: $OUT  ($SIZE)"

# --- DOGRULAMA HEDEFI --------------------------------------------------------------------------
# Geri yukleme, dump'i ureten sunucuyla AYNI MAJOR surumde bir sunucuya yapilmali: v18 dump'i v16
# sunucuya yuklenemez. Sirayla dene: VERIFY_URL env > yerelde ayni major surumu konusan sunucu.
# Bulunamazsa yedek ALINIR ama dogrulama ATLANIR ve bu ACIKCA soylenir (sessizce "kanitlandi" DEMEZ).
VERIFY_BASE=""
if [[ -n "${VERIFY_URL:-}" ]]; then
  vmaj="$("$PSQL" "$VERIFY_URL" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]')"; vmaj="${vmaj%%.*}"
  [[ "$vmaj" == "$SRV_MAJOR" ]] && VERIFY_BASE="$VERIFY_URL" || echo "UYARI: VERIFY_URL surumu ($vmaj) prod ($SRV_MAJOR) ile uyusmuyor, yok sayiliyor."
fi
if [[ -z "$VERIFY_BASE" ]]; then
  for port in 5432 5433 5434; do
    lmaj="$("$PSQL" -h localhost -p "$port" -d postgres -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]')"; lmaj="${lmaj%%.*}"
    if [[ "$lmaj" == "$SRV_MAJOR" ]]; then VERIFY_BASE="postgresql://localhost:$port/postgres"; break; fi
  done
fi

if [[ -z "$VERIFY_BASE" ]]; then
  echo ""
  echo "⚠️  YEDEK ALINDI AMA DOGRULANMADI."
  echo "   Dosya: $OUT ($SIZE)"
  echo "   Sebep: yerelde PostgreSQL $SRV_MAJOR SUNUCUSU calismiyor; v$SRV_MAJOR dump'i eski surume geri yuklenemez."
  echo "   Dogrulamayi acmak icin (tek seferlik):"
  echo "     brew services start postgresql@${SRV_MAJOR}     # ya da farkli portta ikinci instans"
  echo "   Sonra ayni komutu tekrar kos; ya da hazir bir sunucu varsa:"
  echo "     VERIFY_URL=\"postgresql://kullanici@host:port/postgres\" npm run backup:prod -- \"<prod-url>\""
  echo ""
  echo "   NOT: Dogrulanmamis yedege GUVENME — bozuk/eksik dump ancak geri yuklemeye calisinca anlasilir."
  exit 3
fi

VHOST="${VERIFY_BASE%/*}"
echo "=== 2/4 Gecici veritabanina geri yukleniyor ($VHOST/$TMPDB) ==="
"$CREATEDB" -d "$VERIFY_BASE" "$TMPDB" 2>/dev/null || { echo "HATA: gecici veritabani olusturulamadi."; exit 1; }
TMPURL="$VHOST/$TMPDB"
# --exit-on-error KULLANMIYORUZ: sahip/yetki farklari zararsiz uyari uretir; asil kanit satir sayisi.
"$PGRESTORE" -d "$TMPURL" --no-owner --no-privileges "$OUT" 2>/tmp/pgrestore_warn.log || true
WARN=$(grep -ci "error" /tmp/pgrestore_warn.log || true)
echo "    pg_restore uyari/hata satiri: $WARN (0 ideal; sahip/yetki uyarilari zararsiz)"

echo "=== 3/4 Satir sayilari karsilastiriliyor (kaynak vs geri yuklenen) ==="
COUNT_SQL="SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
FAIL=0; TOTAL_SRC=0; TOTAL_DST=0
while read -r t; do
  [[ -z "$t" ]] && continue
  src=$("$PSQL" "$PROD_URL_GUVENLI" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "X")
  dst=$("$PSQL" "$TMPURL"  -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "X")
  if [[ "$src" == "X" || "$dst" == "X" ]]; then
    printf "  ?? %-28s kaynak=%s geri=%s\n" "$t" "$src" "$dst"; FAIL=$((FAIL+1)); continue
  fi
  TOTAL_SRC=$((TOTAL_SRC+src)); TOTAL_DST=$((TOTAL_DST+dst))
  if [[ "$src" != "$dst" ]]; then
    printf "  ✗  %-28s kaynak=%s geri=%s\n" "$t" "$src" "$dst"; FAIL=$((FAIL+1))
  fi
done < <("$PSQL" "$PROD_URL_GUVENLI" -tAc "$COUNT_SQL")
echo "    toplam satir: kaynak=$TOTAL_SRC geri_yuklenen=$TOTAL_DST"

echo "=== 4/4 Gecici veritabani siliniyor ==="
"$DROPDB" -d "$VERIFY_BASE" "$TMPDB" 2>/dev/null || true

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "✅ YEDEK KANITLANDI — geri yukleme calisti, tum tablolarda satir sayilari birebir ayni."
  echo "   Dosya: $OUT ($SIZE)"
  echo "   SIMDI BU DOSYAYI SIFRELI HARICI DISKE KOPYALA. Ayni diskteki yedek, yedek degildir."
  echo "   NOT: dosya TUM kullanici verisini icerir (e-posta, passwordHash) -> buluta/git'e KOYMA."
else
  echo "❌ DOGRULAMA BASARISIZ — $FAIL tabloda fark/erisim sorunu var. Yedege GUVENME, once bunu cozelim."
  exit 2
fi
