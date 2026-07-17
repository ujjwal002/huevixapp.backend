# first have to change in razor pay :- ngrok

# clousde fared 

brew install cloudflared        # one time
cloudflared tunnel --url http://localhost:4000


npx prisma migrate reset

npm run seed
node prisma/seed-vocab.js
node prisma/seed-grammar.js
node prisma/seed-sponsored.js


npx prisma db push
pm2 restart huevix-backend

k6 run load-test.js


curl -X POST http://localhost:4000/api/v1/cards/admin-article \
  -H "Authorization: Bearer <ADMIN_ACCESS_TOKEN>" \
  -F "image=@hero.jpg" \
  -F "title=A Calm Morning in Kyoto" \
  -F "targetLanguage=en" \
  -F "nativeLanguage=hi" \
  -F "level=INTERMEDIATE" \
  -F "topic=travel" \
  -F "publish=true" \
  -F 'vocab=[{"term":"serene","partOfSpeech":"adjective","meaning":"शांत","example":"The temple garden was serene."}]'


  (crontab -l 2>/dev/null; echo "30 3 * * * cd /home/ubuntu/huevixapp.backend && node scripts/quiz-daily.js >> /home/ubuntu/quiz-cron.log 2>&1") | crontab -~/backups/backup.sh


  30 2,6,10,14 * * * cd /home/ubuntu/huevixapp.backend && node scripts/news-fetch.js >> ~/news-cron.log 2>&1

  node --input-type=module -e "
import 'dotenv/config';
const key = process.env.NEWSDATA_API_KEY;
const params = new URLSearchParams({ apikey: key, language: process.env.NEWS_LANGUAGE || 'en' });
if (process.env.NEWS_CATEGORIES) params.set('category', process.env.NEWS_CATEGORIES);
if (process.env.NEWS_COUNTRY) params.set('country', process.env.NEWS_COUNTRY);
console.log('Requesting with params:', params.toString().replace(key, 'KEY_HIDDEN'));
const res = await fetch('https://newsdata.io/api/1/latest?' + params.toString());
const json = await res.json();
console.log('HTTP', res.status);
console.log(JSON.stringify(json, null, 2).slice(0, 800));
"


npm run format && npm run lint && npm test



mkdir -p ~/backups && nano ~/backup-db.sh


#!/bin/bash
# Nightly Postgres -> S3 backup. Keeps 14 days locally + everything in S3.
set -e
STAMP=$(date +%F)
FILE=~/backups/huevix_$STAMP.sql.gz
pg_dump -h localhost -U huevix huevix | gzip > "$FILE"
aws s3 cp "$FILE" s3://huevix-app-prod/db-backups/huevix_$STAMP.sql.gz
find ~/backups -name "huevix_*.sql.gz" -mtime +14 -delete
echo "[backup] done $STAMP ($(du -h "$FILE" | cut -f1))"


chmod +x ~/backup-db.sh
./backup-db.sh          # run once NOW — verify a file lands in S3
crontab -e              # add:
30 21 * * * /home/ubuntu/backup-db.sh >> /home/ubuntu/backups/backup.log 2>&1