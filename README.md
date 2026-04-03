# Turismo CDG

Software gestionale Next.js + Prisma per controllo di gestione, vendite, inventari, costi merci e integrazione Monetica.

## Stack

- Next.js 16
- Prisma ORM
- PostgreSQL

## Sviluppo locale

1. Crea il file `.env` partendo da `.env.example`.
2. Imposta `DATABASE_URL` verso il tuo PostgreSQL locale.
3. Avvia il progetto:

```bash
npm install
npm run build
npm run dev
```

App locale: `http://localhost:3000`

## Deploy su Railway

Il repository contiene già la configurazione `railway.json` per:

- build con `npm run build`
- migrazioni Prisma automatiche con `npm run railway:migrate`
- start su porta dinamica Railway con `npm run start`
- healthcheck su `/api/health`

### Variabili ambiente richieste

Imposta su Railway almeno queste variabili:

- `DATABASE_URL`
- `APP_LOGIN_USERNAME`
- `APP_LOGIN_PASSWORD` oppure `APP_LOGIN_PASSWORD_SHA256`
- `APP_LOGIN_SESSION_SECRET`
- `MONETICA_API_BEARER_TOKEN`
- `MONETICA_ARTICLES_URL`
- `MONETICA_TRANSACTIONS_URL`
- `MONETICA_WEBHOOK_SECRET`

Puoi usare `.env.example` come base.

### Procedura consigliata

1. Crea il servizio `PostgreSQL` su Railway.
2. Crea il servizio applicativo collegato a questo repository GitHub.
3. Copia la `DATABASE_URL` del servizio Postgres nelle variabili del servizio app.
4. Configura le altre env dall’esempio `.env.example`.
5. Lancia il primo deploy.

Durante il deploy Railway eseguirà:

1. `npm run build`
2. `npm run railway:migrate`
3. `npm run start`

## Prisma

Il database reale è PostgreSQL. Prisma usa:

- schema: `prisma/schema.prisma`
- migrazioni: cartella `prisma/migrations`

Per applicare manualmente le migrazioni in produzione:

```bash
npm run railway:migrate
```
