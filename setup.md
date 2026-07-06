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