# first have to change in razor pay :- ngrok

# clousde fared 

brew install cloudflared        # one time
cloudflared tunnel --url http://localhost:4000


npx prisma migrate reset

npm run seed
node prisma/seed-vocab.js
node prisma/seed-grammar.js
node prisma/seed-sponsored.js