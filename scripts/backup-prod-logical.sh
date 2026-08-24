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

SRV="$("$PSQL" "$PROD_URL_GUVENLI" -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]')" || true
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
  # KATALOGDAN uret, information_schema'dan DEGIL. information_schema `data_type` sutunu dizileri
  # 'ARRAY' diye verir (gecersiz SQL uretir), `numeric(10,2)`yi hassasiyetsiz 'numeric' yapar ve
  # PK/DEFAULT'u HIC tasimaz. Yerel PG16'da sinandi: uretilen DDL ucunde de bozuktu; arsivdeki
  # `_prisma_migrations` DDL'i PK'siz cikmisti. format_type + pg_get_expr ikisi de dogru getirir.
  DDL="$("$PSQL" "$PROD_URL_GUVENLI" -tAc "
    SELECT 'CREATE TABLE IF NOT EXISTS \"'||c.relname||'\" ('||
           string_agg('\"'||a.attname||'\" '||format_type(a.atttypid, a.atttypmod)||
             CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END||
             COALESCE(' DEFAULT '||pg_get_expr(d.adbin, d.adrelid), ''),
             ', ' ORDER BY a.attnum)||
           COALESCE((SELECT ', CONSTRAINT \"'||pc.conname||'\" '||pg_get_constraintdef(pc.oid)
                     FROM pg_constraint pc WHERE pc.conrelid=c.oid AND pc.contype='p'), '')||
           ');'
    FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE c.relname='${t}' AND c.relkind='r'
    GROUP BY c.relname, c.oid" 2>/dev/null)"
  if [[ -n "$DDL" ]]; then
    printf '\n-- sema disi (prod'"'"'da var, schema.prisma'"'"'da yok):\n%s\n' "$DDL" >> "$DIR/schema-1-tables.sql"
    SEMADISI=$((SEMADISI+1))
    echo "    + sema disi tablo eklendi: $t"
  fi
done < <("$PSQL" "$PROD_URL_GUVENLI" -tAc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
[[ "$SEMADISI" -gt 0 ]] && echo "    ($SEMADISI tablo prisma semasinda yoktu, prod yapisindan uretildi)"

# CANLI indeksler: ensureIndexes.ts bazi unique indeksleri KODLA aciyor (prisma semasinda yok).
# Bunlari da kaydediyoruz ki yedek, canlinin gercek halini yansitsin.
"$PSQL" "$PROD_URL_GUVENLI" -tAc "SELECT indexdef||';' FROM pg_indexes WHERE schemaname='public' ORDER BY indexname" \
  > "$DIR/live-indexes.sql" 2>/dev/null || true
echo "    live-indexes.sql ($(wc -l < "$DIR/live-indexes.sql" | tr -d ' ') indeks — kodla acilanlar dahil)"

# CANLI DEFAULT'lar: sema `prisma migrate diff` ile uretiliyor, ama Prisma'nin ISTEMCI TARAFINDA
# urettigi degerler (ornegin `@default(uuid())`) DB tarafina DEFAULT olarak YAZILMAZ. Prod'da ise
# migration'la konmus gercek bir DB default'u olabilir. Olculdu (17 Agu 2026): RefreshToken.family
# prod'da `DEFAULT gen_random_uuid()::text` tasiyor, uretilen semada bu DUSMUS; geri yuklenen DB'de
# DEFAULT'lu sutun sayisi 154 yerine 150 cikiyordu. Yani "kanitlanmis" damgali ama semasi eksik bir DB.
# Tek ornegi degil SINIFI kapatiyoruz: prod'daki TUM sutun default'lari ALTER olarak tasiniyor.
"$PSQL" "$PROD_URL_GUVENLI" -tAc "
  SELECT 'ALTER TABLE \"'||c.relname||'\" ALTER COLUMN \"'||a.attname||'\" SET DEFAULT '||pg_get_expr(d.adbin, d.adrelid)||';'
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE c.relkind='r'
  ORDER BY c.relname, a.attnum" > "$DIR/schema-1b-defaults.sql" 2>/dev/null || true
echo "    schema-1b-defaults.sql ($(wc -l < "$DIR/schema-1b-defaults.sql" | tr -d ' ') default — prod'un GERCEK hali)"

# CANLI CHECK KISITLARI: `prisma migrate diff` CHECK URETMEZ — Prisma bunlari modellemiyor.
# BEDELI ODENDI (21-23 Agu 2026, 24 Agu'da teshis edildi): online ders isiyle prod'a iki CHECK
# kondu (class_venueless_must_be_online, class_delivery_mode_valid). Uretilen 1089 satirlik
# semada ikisi de YOK -> geri yuklenen kopyada eksik -> katalog karsilastirmasi tam 2 satir fark
# gordu -> UC GUN BOYUNCA her yedek "DOGRULANAMADI" damgasi yiyip saklama suresiyle SILINDI.
# Yani yedek aliniyordu ama kullanilabilir tek bir yedek KALMIYORDU.
#
# Ayni kor nokta CI'da da cikmisti ve orada src/utils/ensureIndexes.ts ile kapatilmisti; yedek
# tarafi kapatilmamisti. KURAL: Prisma'nin modellemedigi HER prod DDL'i burada yakalanmali —
# indeks ve default icin zaten yapiliyordu, CHECK eksikti.
#
# DROP IF EXISTS + ADD: bugun hedef DB Prisma semasindan kuruldugu icin cakisma olamaz, ama
# Prisma ileride CHECK uretmeye baslarsa bu dosya yine idempotent kalir.
"$PSQL" "$PROD_URL_GUVENLI" -tAc "
  SELECT 'ALTER TABLE '||conrelid::regclass::text||' DROP CONSTRAINT IF EXISTS \"'||conname||'\";'
       ||E'\n'||'ALTER TABLE '||conrelid::regclass::text||' ADD CONSTRAINT \"'||conname||'\" '||pg_get_constraintdef(oid)||';'
  FROM pg_constraint
  WHERE connamespace='public'::regnamespace AND contype='c'
  ORDER BY conname" > "$DIR/schema-1c-checks.sql" 2>/dev/null || true
echo "    schema-1c-checks.sql ($(grep -c 'ADD CONSTRAINT' "$DIR/schema-1c-checks.sql" 2>/dev/null || echo 0) CHECK — prisma bunlari uretmez)"

# PROD KATALOG PARMAK IZI: dogrulama adiminda geri yuklenen DB ile SATIR SATIR karsilastirilir.
# Ayrica insanin sonradan `diff` alabilecegi tek dosya budur.
katalog_sql() {
  cat <<'SQL'
SELECT 'COL|'||table_name||'|'||column_name||'|'||data_type||'|'||coalesce(character_maximum_length::text,'-')||'|'||is_nullable||'|'||coalesce(column_default,'-')
  FROM information_schema.columns WHERE table_schema='public'
UNION ALL
-- contype filtresi BILINCLI. Disarida birakilanlar ve NEDENI (17 Agu 2026'da olculdu, 291 fark):
--   'n' NOT NULL  : PostgreSQL 17+ bunlari pg_constraint'te AYRI satir olarak listeler, 16 listelemez.
--                   Prod 18.4, dogrulama hedefi yerel 16 -> 289 sahte fark. Bilgi kaybi YOK: NOT NULL
--                   zaten asagidaki COL| satirlarinda is_nullable olarak karsilastiriliyor.
--   'u' UNIQUE    : prod'da tabloya gomulu UNIQUE olarak (RefreshToken_token_key gibi) duruyor;
--                   `prisma migrate diff` ayni tekilligi CREATE UNIQUE INDEX olarak uretiyor. Ikisi de
--                   ayni kisitlamayi uygular ve IDX| satirlarinda ZATEN karsilastiriliyor (o tarafta
--                   sifir fark cikti). Beyan bicimi farki, geri yukleme icin anlamli degil.
-- Iceride kalanlar semantik tasiyor ve baska hicbir yerde olculmuyor: p=PK, f=FK, c=CHECK, x=EXCLUDE.
SELECT 'CON|'||conrelid::regclass::text||'|'||conname||'|'||contype::text||'|'||pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype IN ('p','f','c','x')
UNION ALL
SELECT 'IDX|'||tablename||'|'||indexname||'|'||indexdef
  FROM pg_indexes WHERE schemaname='public'
ORDER BY 1
SQL
}
# HATAYI YUTMA. Ilk yazimda burada `2>/dev/null || true` vardi ve sorgu `text || "char"` belirsiz
# operator hatasiyla dusuyordu; dosya BOS kaliyor, asagidaki `[[ -s ... ]]` karsilastirmayi
# atliyor, SEMA_FARK 0 kaliyor ve yedek "sema de eslesti" damgasi aliyordu. Yani yeni kapi hicbir
# sey olcmeden yesil veriyordu — duzeltmeye calistigi kusurun aynisi. Hata artik gorunur ve
# katalog uretilemezse dogrulama BASARISIZ sayilir (asagida SEMA_FARK=-1).
if ! katalog_sql | "$PSQL" "$PROD_URL_GUVENLI" -tA -f - > "$DIR/schema-0-prod-katalog.txt" 2>"$DIR/_katalog-hata.txt"; then
  echo "    ✗ prod katalogu OKUNAMADI: $(head -2 "$DIR/_katalog-hata.txt" | tr '\n' ' ')"
else
  rm -f "$DIR/_katalog-hata.txt"
fi
KATALOG_SATIR="$(wc -l < "$DIR/schema-0-prod-katalog.txt" | tr -d ' ')"
echo "    schema-0-prod-katalog.txt ($KATALOG_SATIR satir: sutun+kisit+indeks)"
[[ "$KATALOG_SATIR" -eq 0 ]] && echo "    ⚠️  katalog BOS — sema karsilastirmasi yapilamayacak, dogrulama BASARISIZ sayilacak"

# --- 2/6 TABLO LISTESI + VERI --------------------------------------------------------------------
echo "=== 2/6 Veri cekiliyor (tablo basina CSV) ==="
# NOT: macOS'ta bash 3.2 var -> `mapfile` YOK. Ayrica bos bir dizinin "${a[@]}" acilimi
# `set -u` altinda bash 3.2'de hata verir; bu yuzden sayaci ayri tutup once kontrol ediyoruz.
TABLES=(); NTAB=0
while IFS= read -r t; do
  [[ -n "$t" ]] && { TABLES+=("$t"); NTAB=$((NTAB+1)); }
done < <("$PSQL" "$PROD_URL_GUVENLI" -tAc \
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")
[[ "$NTAB" -gt 0 ]] || { echo "HATA: public semasinda tablo yok."; exit 1; }

: > "$DIR/rowcounts.tsv"
TOTAL=0
for t in "${TABLES[@]}"; do
  [[ -z "$t" ]] && continue
  "$PSQL" "$PROD_URL_GUVENLI" -q -c "\\copy (SELECT * FROM \"$t\") TO '$DATA/$t.csv' WITH (FORMAT csv, HEADER true)" >/dev/null
  n="$("$PSQL" "$PROD_URL_GUVENLI" -tAc "SELECT count(*) FROM \"$t\"")"
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
  d="$(PGOPTIONS='-c timezone=UTC' "$PSQL" "$PROD_URL_GUVENLI" -tAc "SELECT md5(coalesce(string_agg(md5(to_jsonb(x)::text), '' ORDER BY md5(to_jsonb(x)::text)), '')) FROM \"$t\" x" 2>/dev/null || echo DIGEST_ALINAMADI)"
  printf '%s\t%s\t%s\n' "$t" "$n" "$d" >> "$DIR/rowcounts.tsv"
  TOTAL=$((TOTAL + n))
  printf '    %-30s %8s satir  %s\n' "$t" "$n" "${d:0:8}"
done
echo "    TOPLAM: $NTAB tablo / $TOTAL satir"

# --- 3/6 SEQUENCE'LER ----------------------------------------------------------------------------
# Bunlar olmadan geri yuklenen veritabaninda ID sayaclari 1'den baslar -> ilk yazmada cakisma.
echo "=== 3/6 ID sayaclari (sequence) kaydediliyor ==="
"$PSQL" "$PROD_URL_GUVENLI" -tAc \
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

# 5) prod'un GERCEK sutun default'lari
#    Prisma'nin ISTEMCI TARAFINDA urettigi degerler (@default(uuid()) gibi) DB'ye DEFAULT olarak
#    yazilmaz; prod'da migration'la konmus gercek default'lar olabilir. Bu adim atlanirsa sema
#    sessizce eksik kalir (olculdu: 154 yerine 150 default'lu sutun).
psql "$TARGET" -v ON_ERROR_STOP=1 -f schema-1b-defaults.sql

# 6) CHECK kisitlari — PRISMA BUNLARI URETMEZ, bu dosya olmadan geri gelmezler
#    Bedeli odendi: online ders isiyle konan iki CHECK uretilen semada olmadigi icin geri yuklenen
#    kopyada eksik kaliyor ve dogrulama "SEMA FARKI: 2 satir" deyip dusuyordu.
psql "$TARGET" -v ON_ERROR_STOP=1 -f schema-1c-checks.sql

# 7) kodla acilan ek indeksler — sunucu ilk acilista bunlari kendi olusturur
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
  # Prod'un GERCEK default'lari (prisma semasinin uretemedikleri dahil)
  [[ -s "$DIR/schema-1b-defaults.sql" ]] && "$PSQL" "$T" -q -v ON_ERROR_STOP=1 -f "$DIR/schema-1b-defaults.sql" >/dev/null
  # CHECK kisitlari FK'lardan SONRA: veri zaten yuklu, bir CHECK ihlali TAM BURADA patlar —
  # FK'larla ayni mantik, yedegin saglamligi icin ek kanit. ON_ERROR_STOP ACIK: sessizce
  # atlanirsa katalog karsilastirmasi yine fark gorur ve sebebi anlasilmaz.
  [[ -s "$DIR/schema-1c-checks.sql" ]] && "$PSQL" "$T" -q -v ON_ERROR_STOP=1 -f "$DIR/schema-1c-checks.sql" >/dev/null
  # Kodla acilan indeksler (ensureIndexes.ts). Var olanlar "already exists" der; BEKLENEN durum bu,
  # o yuzden burada ON_ERROR_STOP kapali. RESTORE.md adim 5 de ayni seyi soyluyor.
  [[ -s "$DIR/live-indexes.sql" ]] && "$PSQL" "$T" -q -f "$DIR/live-indexes.sql" >/dev/null 2>&1

  # --- SEMA KARSILASTIRMASI ----------------------------------------------------------------------
  # Dogrulama eskiden YALNIZ VERIYE bakiyordu: count(*) + icerik ozeti. Semanin dogru geri geldigini
  # HICBIR sey kontrol etmiyordu. Olculdu (17 Agu 2026): prod ile geri yuklenen DB arasinda indeks
  # 113 vs 107, PK 42 vs 41, DEFAULT'lu sutun 154 vs 150 farki vardi — ve yedek yine "KANITLANDI"
  # damgasi aliyordu. schema.prisma'da ifade edilemeyen HER prod DDL'i (DB default, CHECK, trigger,
  # kismi indeks) bu bosluktan sessizce dusuyordu; felaket gunune kadar da fark edilmiyordu.
  SEMA_FARK=0
  if [[ ! -s "$DIR/schema-0-prod-katalog.txt" ]]; then
    # "Karsilastiramadim" ile "fark yok" AYNI SEY DEGIL. Katalog yoksa sema hakkinda hicbir sey
    # bilmiyoruz demektir; bu durumda yedegi "sema de dogrulandi" diye damgalamak yalan olur.
    echo "    ✗ prod katalogu YOK/BOS — sema karsilastirilamadi (dogrulanmamis sayiliyor)"
    SEMA_FARK=-1
  else
    katalog_sql | "$PSQL" "$T" -tA -f - > "$DIR/_katalog-geri.txt" 2>/dev/null || true
    if ! diff -u "$DIR/schema-0-prod-katalog.txt" "$DIR/_katalog-geri.txt" > "$DIR/_sema-diff.txt" 2>&1; then
      SEMA_FARK="$(grep -c '^[+-][^+-]' "$DIR/_sema-diff.txt" || echo 0)"
      { echo "# PROD ile GERI YUKLENEN DB arasindaki SEMA farklari"
        echo "# '-' prod'da VAR geri yuklenende YOK · '+' tersi"
        echo ""
        grep '^[+-][^+-]' "$DIR/_sema-diff.txt"
      } > "$DIR/SEMA-FARKLARI.txt"
      echo "    ✗ SEMA FARKI: $SEMA_FARK satir (ayrinti: SEMA-FARKLARI.txt)"
    else
      echo "    sema birebir ayni (sutun + kisit + indeks)"
    fi
    rm -f "$DIR/_katalog-geri.txt" "$DIR/_sema-diff.txt"
  fi

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
  # VERIFIED artik VERI **ve** SEMA'yi birlikte olcuyor. Sema farki da basarisizliktir: semasi
  # eksik bir geri yukleme "calisiyor gibi" gorunup ilk yazmada patlar.
  if [[ "$FAIL" -eq 0 && "$SEMA_FARK" -eq 0 ]]; then
    echo "    tum tablolar birebir ayni: $NTAB tablo, $TOTAL satir, icerik ozetleri VE sema eslesti"; VERIFIED=yes
  elif [[ "$FAIL" -ne 0 ]]; then
    echo "    $FAIL tabloda VERI farki var"; VERIFIED=no
  elif [[ "$SEMA_FARK" -eq -1 ]]; then
    echo "    veri ayni ama SEMA KARSILASTIRILAMADI — kanit eksik"; VERIFIED=no
  else
    echo "    veri ayni ama SEMA farkli ($SEMA_FARK satir) — bkz. SEMA-FARKLARI.txt"; VERIFIED=no
  fi
fi

# --- 6/6 PAKETLE ---------------------------------------------------------------------------------
echo "=== 6/6 Tek dosyaya paketleniyor ==="
TGZ="$DIR.tgz"
# umask 077: arsiv OLUSURKEN 600 olsun. Sonradan chmod da yapiliyor ama arada bir an bile
# dunyaya-okunur birakmamak dogru (dosya TUM kullanici verisini iceriyor: e-posta + passwordHash).
( umask 077; tar -czf "$TGZ" -C "$(dirname "$DIR")" "$(basename "$DIR")" )

# ARSIVIN KENDISI SINANIR. Dogrulama KLASOR uzerinde yapiliyordu; sonra tar aliniyor ve klasor
# SILINIYORDU — yani "KANITLANDI" cumlesi artik var olmayan bir sey hakkindaydi. Bozuk/yarim bir
# .tgz (disk dolmasi, kesinti) bu asamaya kadar hic fark edilmezdi.
if ! tar -tzf "$TGZ" >/dev/null 2>&1; then
  echo "HATA: uretilen arsiv OKUNAMIYOR (tar -tzf basarisiz) — yedek gecersiz."
  rm -f "$TGZ"
  exit 2
fi
BEKLENEN_DOSYA="$(find "$DIR" -type f | wc -l | tr -d ' ')"
ARSIV_DOSYA="$(tar -tzf "$TGZ" | grep -vc '/$' || echo 0)"
if [[ "$ARSIV_DOSYA" -lt "$BEKLENEN_DOSYA" ]]; then
  echo "HATA: arsivde $ARSIV_DOSYA dosya var, klasorde $BEKLENEN_DOSYA idi — eksik paketleme."
  rm -f "$TGZ"
  exit 2
fi

rm -rf "$DIR"
chmod 600 "$TGZ" 2>/dev/null || true

# SAGLAMA: felaket gunune kadar bekleyip "acaba bozuldu mu" diye dusunmemek icin. Dogrulama:
#   shasum -a 256 -c sipsakspor-prod-....tgz.sha256
( cd "$(dirname "$TGZ")" && shasum -a 256 "$(basename "$TGZ")" > "$(basename "$TGZ").sha256" ) 2>/dev/null || true
chmod 600 "$TGZ.sha256" 2>/dev/null || true
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
