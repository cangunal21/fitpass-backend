#!/usr/bin/env bash
# TASINABILIR (surumden bagimsiz) prod yedegi — pg_dump GEREKTIRMEZ.
#
# NEDEN VAR: pg_dump, KENDISINDEN YENI bir sunucuyu yedeklemeyi reddeder. Olculdu: Railway prod =
# PostgreSQL 18.4, bu makinede istemci 16.14 -> "server version mismatch". Ama psql 16, sunucu 18'e
# SORUNSUZ baglanir (server_version'i okuyabiliyoruz). Bu betik o gercege dayanir:
#   sema  = prisma schema.prisma'dan uretilen SAF SQL DDL  (surumden bagimsiz)
#   veri  = her tablo icin CSV (COPY ... TO, istemci tarafinda)  (surumden bagimsiz)
# Sonuc: HERHANGI bir PostgreSQL surumune geri yuklenebilen bir yedek. -Fc dump'tan daha tasinabilir.
#
# Kullanim:
#   npm run backup:prod:logical -- "postgresql://kullanici:sifre@host:port/veritabani"
#   (URL: Railway > Postgres servisi > Variables > DATABASE_PUBLIC_URL)
#
# GUVENLIK: prod'a SADECE OKUMA yapar. Geri yukleme DOGRULAMASI her zaman YEREL gecici bir
# veritabanina yapilir; uzak hedefe asla yazmaz.
set -euo pipefail

PROD_URL="${1:-${PROD_DATABASE_URL:-}}"
if [[ -z "$PROD_URL" ]]; then
  echo "HATA: prod veritabani URL'si gerekli."
  echo "Kullanim: $0 \"postgresql://...\""
  exit 1
fi
[[ "$PROD_URL" == postgres* ]] || { echo "HATA: URL 'postgresql://' ile baslamali."; exit 1; }

cd "$(dirname "$0")/.."
PSQL="$(command -v psql || true)"
[[ -n "$PSQL" ]] || { echo "HATA: psql bulunamadi."; exit 1; }

STAMP="$(date +%Y-%m-%d-%H%M)"
DIR="${BACKUP_DIR:-$HOME/Desktop}/sipsakspor-prod-${STAMP}"
DATA="$DIR/data"
mkdir -p "$DATA"

SRV="$("$PSQL" "$PROD_URL" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]')" || true
[[ -n "$SRV" ]] || { echo "HATA: prod'a baglanilamadi. URL'yi ve ag erisimini kontrol et."; exit 1; }
echo "prod sunucu: PostgreSQL $SRV   |   istemci: $("$PSQL" --version | awk '{print $3}')"
echo "hedef klasor: $DIR"
echo ""

# --- 1/6 SEMA -------------------------------------------------------------------------------------
# Tablolar+indeksler ile YABANCI ANAHTARLAR ayri dosyalara yaziliyor. Sebep: veri yuklenirken FK'lar
# henuz yoksa tablo sirasi hic onemli olmaz (aksi halde 40 tabloyu bagimlilik sirasina dizmek ya da
# superuser gerektiren `session_replication_role=replica` kullanmak gerekirdi).
echo "=== 1/6 Sema uretiliyor (prisma -> saf SQL) ==="
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script 2>/dev/null \
  | grep -v '^Loaded Prisma config' > "$DIR/_schema-all.sql"
grep -q 'CREATE TABLE' "$DIR/_schema-all.sql" || { echo "HATA: sema uretilemedi."; exit 1; }
grep -E '^ALTER TABLE .* FOREIGN KEY' "$DIR/_schema-all.sql" > "$DIR/schema-2-fks.sql" || true
grep -vE '^ALTER TABLE .* FOREIGN KEY' "$DIR/_schema-all.sql" > "$DIR/schema-1-tables.sql"
rm -f "$DIR/_schema-all.sql"
echo "    schema-1-tables.sql ($(grep -c 'CREATE TABLE' "$DIR/schema-1-tables.sql") tablo), schema-2-fks.sql ($(wc -l < "$DIR/schema-2-fks.sql" | tr -d ' ') FK)"

# --- SEMA DISI TABLOLAR (prisma semasinda YOK ama prod'da VAR) -----------------------------------
# BEDELI ODENMIS: sema `schema.prisma`dan, veri ise prod'daki TUM tablolardan cekiliyor. Aradaki
# fark, geri yuklemeyi KIRIYOR. Olculdu (17 Agu 2026): Prisma'nin kendi kayit tablosu
# `_prisma_migrations` prod'da var, semada yok -> CSV'si aliniyor ama CREATE TABLE'i uretilmiyor
# -> dogrulama `relation "_prisma_migrations" does not exist` ile cokuyordu. Yani bu yoldan alinan
# yedek HIC dogrulanamamisti.
#
# Tek ornegi degil SINIFI kapatiyoruz: semada karsiligi olmayan HER tablonun DDL'i, prod'daki
# GERCEK yapisindan (information_schema) uretiliyor. Ileride kodla acilan baska bir tablo olursa
# da calisir. `_prisma_migrations` ozellikle onemli: geri yuklemede olmazsa Prisma tum
# migration'lari yeniden uygulamaya calisir.
SEMADISI=0
while IFS= read -r t; do
  [[ -n "$t" ]] || continue
  # Semada zaten var mi? (tirnakli ya da tirnaksiz CREATE TABLE)
  grep -qE "CREATE TABLE (IF NOT EXISTS )?(\"?public\"?\.)?\"?${t}\"?" "$DIR/schema-1-tables.sql" && continue
  DDL="$("$PSQL" "$PROD_URL" -tAc "
    SELECT 'CREATE TABLE IF NOT EXISTS \"'||table_name||'\" ('||
           string_agg('\"'||column_name||'\" '||
             CASE WHEN data_type='USER-DEFINED' THEN 'text' ELSE data_type END||
             COALESCE('('||character_maximum_length||')','')||
             CASE WHEN is_nullable='NO' THEN ' NOT NULL' ELSE '' END,
             ', ' ORDER BY ordinal_position)||');'
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='${t}'
    GROUP BY table_name" 2>/dev/null)"
  if [[ -n "$DDL" ]]; then
    printf '\n-- sema disi (prod'"'"'da var, schema.prisma'"'"'da yok):\n%s\n' "$DDL" >> "$DIR/schema-1-tables.sql"
    SEMADISI=$((SEMADISI+1))
    echo "    + sema disi tablo eklendi: $t"
  fi
done < <("$PSQL" "$PROD_URL" -tAc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
[[ "$SEMADISI" -gt 0 ]] && echo "    ($SEMADISI tablo prisma semasinda yoktu, prod yapisindan uretildi)"

# CANLI indeksler: ensureIndexes.ts bazi unique indeksleri KODLA aciyor (prisma semasinda yok).
# Bunlari da kaydediyoruz ki yedek, canlinin gercek halini yansitsin.
"$PSQL" "$PROD_URL" -tAc "SELECT indexdef||';' FROM pg_indexes WHERE schemaname='public' ORDER BY indexname" \
  > "$DIR/live-indexes.sql" 2>/dev/null || true
echo "    live-indexes.sql ($(wc -l < "$DIR/live-indexes.sql" | tr -d ' ') indeks — kodla acilanlar dahil)"

# --- 2/6 TABLO LISTESI + VERI --------------------------------------------------------------------
echo "=== 2/6 Veri cekiliyor (tablo basina CSV) ==="
# NOT: macOS'ta bash 3.2 var -> `mapfile` YOK. Ayrica bos bir dizinin "${a[@]}" acilimi
# `set -u` altinda bash 3.2'de hata verir; bu yuzden sayaci ayri tutup once kontrol ediyoruz.
TABLES=(); NTAB=0
while IFS= read -r t; do
  [[ -n "$t" ]] && { TABLES+=("$t"); NTAB=$((NTAB+1)); }
done < <("$PSQL" "$PROD_URL" -tAc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
[[ "$NTAB" -gt 0 ]] || { echo "HATA: public semasinda tablo yok."; exit 1; }

: > "$DIR/rowcounts.tsv"
TOTAL=0
for t in "${TABLES[@]}"; do
  [[ -z "$t" ]] && continue
  "$PSQL" "$PROD_URL" -q -c "\\copy (SELECT * FROM \"$t\") TO '$DATA/$t.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
  n="$("$PSQL" "$PROD_URL" -tAc "SELECT count(*) FROM \"$t\"")"
  # SAAT DILIMI BAGLANTI ANINDA SABITLENIR (PGOPTIONS='-c timezone=UTC'): `to_jsonb` bir
  # `timestamptz` alanini OTURUMUN
  # saat dilimine gore metne cevirir. Prod Etc/UTC, bu makine America/Toronto -> AYNI an iki
  # farkli metin uretiyor ("...T16:10:43+00:00" vs "...T19:10:43+03:00") -> md5'ler tutmuyor ve
  # dogrulama "ICERIK farkli" diye YANLIS ALARM veriyordu. Olculdu 17 Agu 2026: veri birebir
  # aynıyken `_prisma_migrations` surekli farkli gorunuyordu. UTC'ye sabitlemek karsilastirmayi
  # ZAYIFLATMAZ, tam tersine dogru sey olan ANI karsilastirir (yerel gosterimini degil).
  #
  # NEDEN `SET TimeZone=...; SELECT ...` DEGIL: psql her ifadenin sonucunu basar; `SET` de "SET"
  # komut etiketini yazar ve `-tAc` ile yakalanan degisken "SET\n<ozet>" olur -> karsilastirma
  # tamamen bozulur (denendi: 42 tablo "84 fark" gorundu). PGOPTIONS baglantiyi kurarken ayarlar,
  # hicbir cikti uretmez.
  # ICERIK OZETI: "satir sayisi ayni" != "veri ayni". Her satirin TAM metin gosteriminin md5'ini
  # alip siraya BAGLI OLMAYAN sekilde birlestiriyoruz -> tek bir parmak izi. Boylece geri yuklemeden
  # sonra sadece sayilari degil her alanin degerini de karsilastirabiliyoruz.
  # to_jsonb kullaniyoruz (x::text DEGIL): canli DB `db push` ile buyudugu icin fiziksel sutun
  # sirasi sema sirasindan farkli; row::text buna duyarli olup ayni veride bile yanlis alarm veriyordu.
  # Surumler arasi guvenli: PG12+ float8'i "en kisa tam donusum" ile yazar, jsonb anahtarlari normalize.
  d="$(PGOPTIONS='-c timezone=UTC' "$PSQL" "$PROD_URL" -tAc "SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text)), '')) FROM \"$t\" x" 2>/dev/null || echo DIGEST_ALINAMADI)"
  printf '%s\t%s\t%s\n' "$t" "$n" "$d" >> "$DIR/rowcounts.tsv"
  TOTAL=$((TOTAL + n))
  printf '    %-30s %8s satir  %s\n' "$t" "$n" "${d:0:8}"
done
echo "    TOPLAM: $NTAB tablo / $TOTAL satir"

# --- 3/6 SEQUENCE'LER ----------------------------------------------------------------------------
# Bunlar olmadan geri yuklenen veritabaninda ID sayaclari 1'den baslar -> ilk yazmada cakisma.
echo "=== 3/6 ID sayaclari (sequence) kaydediliyor ==="
"$PSQL" "$PROD_URL" -tAc \
  "SELECT format('SELECT setval(%L, %s, true);', schemaname||'.'||quote_ident(sequencename), GREATEST(COALESCE(last_value,1),1)) FROM pg_sequences WHERE schemaname='public'" \
  > "$DIR/schema-3-sequences.sql"
echo "    $(wc -l < "$DIR/schema-3-sequences.sql" | tr -d ' ') sequence"

# --- 4/6 META ------------------------------------------------------------------------------------
{
  echo "sipsakspor prod yedegi"
  echo "tarih (yerel)      : $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "prod sunucu surumu : PostgreSQL $SRV"
  echo "yedekleyen istemci : $("$PSQL" --version)"
  echo "git commit         : $(git rev-parse HEAD 2>/dev/null || echo bilinmiyor)"
  echo "git dal            : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo bilinmiyor)"
  echo "tablo / satir      : $NTAB / $TOTAL"
} > "$DIR/meta.txt"

cat > "$DIR/RESTORE.md" <<'MD'
# Bu yedek nasil geri yuklenir

Bu yedek **surumden bagimsiz**: herhangi bir PostgreSQL 14+ sunucusuna yuklenebilir
(`-Fc` dump'lar sadece ayni ya da daha yeni surume yuklenebilir; bu oyle degil).

Sirayla, BOS bir veritabani hedefiyle:

```bash
TARGET="postgresql://kullanici:sifre@host:port/yeni_veritabani"

# 1) tablolar + indeksler (yabanci anahtarlar HENUZ yok — bu yuzden veri sirasi onemsiz)
psql "$TARGET" -v ON_ERROR_STOP=1 -f schema-1-tables.sql

# 2) veri
for f in data/*.csv; do
  t="$(basename "$f" .csv)"
  cols="$(head -1 "$f" | sed 's/[^,]*/"&"/g')"
  psql "$TARGET" -q -c "\copy \"$t\"($cols) FROM '$f' WITH (FORMAT csv, HEADER true)"
done

# 3) yabanci anahtarlar (veri tutarli degilse BURADA hata verir — istedigimiz budur)
psql "$TARGET" -v ON_ERROR_STOP=1 -f schema-2-fks.sql

# 4) ID sayaclari (bu adim atlanirsa ilk yeni kayit "duplicate key" verir)
psql "$TARGET" -v ON_ERROR_STOP=1 -f schema-3-sequences.sql

# 5) kodla acilan ek indeksler — sunucu ilk acilista bunlari kendi olusturur
#    (ensureIndexes.ts). Elle istersen: psql "$TARGET" -f live-indexes.sql  (var olanlar hata verir, normal)
```

Kontrol: `rowcounts.tsv` her tablo icin `ad / satir sayisi / icerik ozeti (md5)` tutar. Yukledikten
sonra ayni sorguyla karsilastirabilirsin:
`SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text)), '')) FROM "Tablo" x` `meta.txt` yedegin alindigi tarih, sunucu surumu ve git commit'ini icerir.

## GIZLILIK
`data/User.csv` TUM kullanici verisini icerir (e-posta, passwordHash, telefon). Bu klasor
**buluta / git'e / paylasimli klasore konmaz.** Dogru hedef: sifreli harici disk.
MD

# --- 5/6 GERI YUKLEME DOGRULAMASI (YEREL) --------------------------------------------------------
# Denenmemis yedek, yedek degildir. Burada gercekten geri yukluyoruz. Yerel sunucu surumu prod'dan
# ESKI olsa bile calisir — cunku sema saf SQL, veri CSV.
echo "=== 4/6 Yerel gecici veritabanina geri yukleniyor (kanit) ==="
TMPDB="fitpass_restore_test_${STAMP//-/_}"
# Yerel admin baglantisi: gelistiricinin .env'indeki DATABASE_URL'den turetilir (kullanici/sifre
# oradan gelir) — sadece veritabani adi "postgres" ile degistirilir. Yoksa varsayilan portlar denenir.
LOCAL_ADMIN=""
DEV_URL="$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')"
CANDIDATES=""
[[ -n "$DEV_URL" ]] && CANDIDATES="${DEV_URL%/*}/postgres"
CANDIDATES="$CANDIDATES postgresql://localhost:5432/postgres postgresql://localhost:5433/postgres"
for c in $CANDIDATES; do
  if "$PSQL" "$c" -tAc 'SELECT 1' >/dev/null 2>&1; then LOCAL_ADMIN="$c"; break; fi
done

if [[ -z "$LOCAL_ADMIN" ]]; then
  echo "    ATLANDI: yerelde PostgreSQL sunucusu yok (brew services start postgresql@16)."
  VERIFIED=skipped
else
  "$PSQL" "$LOCAL_ADMIN" -q -c "CREATE DATABASE \"$TMPDB\"" >/dev/null
  T="${LOCAL_ADMIN%/*}/$TMPDB"
  "$PSQL" "$T" -q -v ON_ERROR_STOP=1 -f "$DIR/schema-1-tables.sql" >/dev/null
  for t in "${TABLES[@]}"; do
    [[ -z "$t" ]] && continue
    f="$DATA/$t.csv"
    cols="$(head -1 "$f" | sed 's/[^,]*/"&"/g')"
    "$PSQL" "$T" -q -v ON_ERROR_STOP=1 -c "\\copy \"$t\"($cols) FROM '$f' WITH (FORMAT csv, HEADER true)" >/dev/null
  done
  # FK'lar EN SON: veri ic tutarsizsa tam burada patlar -> yedegin saglamligi icin en guclu kanit
  "$PSQL" "$T" -q -v ON_ERROR_STOP=1 -f "$DIR/schema-2-fks.sql" >/dev/null
  "$PSQL" "$T" -q -v ON_ERROR_STOP=1 -f "$DIR/schema-3-sequences.sql" >/dev/null

  echo "=== 5/6 Satir sayisi VE icerik ozeti karsilastiriliyor ==="
  FAIL=0
  while IFS=$'\t' read -r t src sdig; do
    dst="$("$PSQL" "$T" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo X)"
    ddig="$(PGOPTIONS='-c timezone=UTC' "$PSQL" "$T" -tAc "SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text)), '')) FROM \"$t\" x" 2>/dev/null || echo X)"
    if [[ "$src" != "$dst" ]]; then
      printf '  ✗ %-28s SATIR kaynak=%s geri=%s\n' "$t" "$src" "$dst"; FAIL=$((FAIL+1))
    elif [[ "$sdig" != "$ddig" ]]; then
      printf '  ✗ %-28s ICERIK farkli (sayi ayni!) kaynak=%s geri=%s\n' "$t" "${sdig:0:8}" "${ddig:0:8}"; FAIL=$((FAIL+1))
    fi
  done < "$DIR/rowcounts.tsv"
  "$PSQL" "$LOCAL_ADMIN" -q -c "DROP DATABASE \"$TMPDB\"" >/dev/null 2>&1 || true
  if [[ "$FAIL" -eq 0 ]]; then echo "    tum tablolar birebir ayni: $NTAB tablo, $TOTAL satir, icerik ozetleri de eslesti"; VERIFIED=yes
  else echo "    $FAIL tabloda fark var"; VERIFIED=no; fi
fi

# --- 6/6 PAKETLE ---------------------------------------------------------------------------------
echo "=== 6/6 Tek dosyaya paketleniyor ==="
TGZ="$DIR.tgz"
tar -czf "$TGZ" -C "$(dirname "$DIR")" "$(basename "$DIR")"
rm -rf "$DIR"
SIZE="$(du -h "$TGZ" | cut -f1)"

echo ""
case "$VERIFIED" in
  yes)
    echo "✅ YEDEK KANITLANDI — geri yukleme calisti, FK'lar gecti, HER SATIRIN ICERIGI birebir ayni."
    ;;
  no)
    echo "❌ DOGRULAMA BASARISIZ — dosya olustu ama GUVENME. Cikti yukarida."
    ;;
  *)
    echo "⚠️  YEDEK ALINDI, DOGRULANMADI (yerel PostgreSQL sunucusu yok)."
    ;;
esac
echo "   Dosya : $TGZ  ($SIZE)"
echo "   Icerik: $NTAB tablo / $TOTAL satir  |  prod PostgreSQL $SRV"
echo ""
echo "   SIMDI BU DOSYAYI SIFRELI HARICI DISKE KOPYALA. Ayni diskteki yedek, yedek degildir."
echo "   Dosya TUM kullanici verisini icerir (e-posta, passwordHash) -> buluta/git'e KOYMA."
# BELIRSIZ SONUC = BASARISIZLIK. Eskiden `no` disindaki HER durum exit 0 donuyordu — ozellikle
# `VERIFIED=skipped`, yani YEREL PostgreSQL bulunamadigi icin geri yukleme testinin HIC KOSMADIGI
# durum. Sarmalayici da exit 0'i "kanitlanmis (geri yukleme testi gecti)" diye SON-DURUM.txt'ye
# yaziyordu. Sonuc: yerel Postgres durursa (brew upgrade, reboot, disk baskisi) is her gun yedegi
# alir ve her gun "kanitlanmis" der — OYSA TEST HIC KOSMAMISTIR. Railway'de otomatik yedek
# olmadigi icin bu klasor TEK yedek hatti; yanlis "kanitlandi" raporu, yedeksizlikten kotudur:
# insan guvenir ve kontrol etmez.
case "$VERIFIED" in
  yes) exit 0 ;;   # geri yukleme testi KOSTU ve GECTI
  no)  exit 2 ;;   # KOSTU ve DUSTU
  *)   exit 3 ;;   # KOSMADI (skipped) ya da bilinmeyen -> BASARI SAYILMAZ
esac
