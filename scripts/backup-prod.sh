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
if [[ -z "$PROD_URL" ]]; then
  echo "HATA: prod veritabani URL'si gerekli."
  echo "Kullanim: $0 \"postgresql://...\"   (ya da PROD_DATABASE_URL ortam degiskeni)"
  exit 1
fi
if [[ "$PROD_URL" != postgres* ]]; then
  echo "HATA: URL 'postgresql://' ile baslamali."
  exit 1
fi

STAMP="$(date +%Y-%m-%d-%H%M)"
OUT="${BACKUP_DIR:-$HOME/Desktop}/sipsakspor-prod-${STAMP}.dump"
TMPDB="fitpass_restore_test_${STAMP//-/_}"

echo "=== 1/4 Prod yedegi aliniyor (salt okuma) ==="
pg_dump "$PROD_URL" -Fc --no-owner --no-privileges -f "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
echo "    dosya: $OUT  ($SIZE)"

echo "=== 2/4 Gecici YEREL veritabanina geri yukleniyor: $TMPDB ==="
createdb "$TMPDB"
# --exit-on-error KULLANMIYORUZ: sahip/yetki farklari zararsiz uyari uretir; asil kanit satir sayisi.
pg_restore -d "$TMPDB" --no-owner --no-privileges "$OUT" 2>/tmp/pgrestore_warn.log || true
WARN=$(grep -ci "error" /tmp/pgrestore_warn.log || true)
echo "    pg_restore uyari/hata satiri: $WARN (0 ideal; sahip/yetki uyarilari zararsiz)"

echo "=== 3/4 Satir sayilari karsilastiriliyor (kaynak vs geri yuklenen) ==="
COUNT_SQL="SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
FAIL=0; TOTAL_SRC=0; TOTAL_DST=0
while read -r t; do
  [[ -z "$t" ]] && continue
  s=$(psql "$PROD_URL" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "X")
  d=$(psql -d "$TMPDB" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "X")
  if [[ "$s" == "X" || "$d" == "X" ]]; then
    printf "  ?? %-28s kaynak=%s geri=%s\n" "$t" "$s" "$d"; FAIL=$((FAIL+1)); continue
  fi
  TOTAL_SRC=$((TOTAL_SRC+s)); TOTAL_DST=$((TOTAL_DST+d))
  if [[ "$s" != "$d" ]]; then
    printf "  ✗  %-28s kaynak=%s geri=%s\n" "$t" "$s" "$d"; FAIL=$((FAIL+1))
  fi
done < <(psql "$PROD_URL" -tAc "$COUNT_SQL")
echo "    toplam satir: kaynak=$TOTAL_SRC geri_yuklenen=$TOTAL_DST"

echo "=== 4/4 Gecici veritabani siliniyor ==="
dropdb "$TMPDB"

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "✅ YEDEK KANITLANDI — geri yukleme calisti, tum tablolarda satir sayilari birebir ayni."
  echo "   Dosya: $OUT"
  echo "   ŞİMDİ BU DOSYAYI MAC'TEN DISARI CIKAR (iCloud/Drive/harici disk). Ayni diskteki yedek, yedek degildir."
else
  echo "❌ DOGRULAMA BASARISIZ — $FAIL tabloda fark/erisim sorunu var. Yedege GUVENME, once bunu cozelim."
  exit 2
fi
