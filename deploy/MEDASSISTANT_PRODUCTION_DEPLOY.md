# RadiantMedAI Production Deployment

This stack is separate from the existing `radiant-bi` Docker apps.

Production names used by this app:

- App container: `medassistant-chat`
- Postgres container: `medassistant-postgres`
- Qdrant container: `medassistant-qdrant`
- Ollama container: `medassistant-ollama`
- Docker network: `medassistant-network`
- App localhost port: `3007`
- Postgres localhost port: `5545`
- Qdrant localhost port: `6334`
- Ollama localhost port: `11435`

## 1. DNS

Point this DNS record to the VPS:

```text
medassistant.hakida.co.ke  A  102.68.87.177
```

## 2. Copy Project To VPS

Recommended path:

```bash
mkdir -p /opt/medassistant
cd /opt/medassistant
git clone <your_medicalAi_repo_url> app
cd /opt/medassistant/app
```

If you copy files manually instead of using git, copy the whole project folder, including:

- `next-chat-ui`
- `db`
- `shared`
- `docker-compose.prod.yml`
- `.env.production.example`
- `deploy`

## 3. Create Production Env

```bash
cp .env.production.example .env.production
nano .env.production
```

Set long random values for:

- `CLINICAL_POSTGRES_PASSWORD`
- `AUTH_SESSION_SECRET`
- `ADMIN_PASSWORD`

Generate secrets:

```bash
openssl rand -hex 32
```

## 4. Start Docker Stack

```bash
cd /opt/medassistant/app
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

The first start pulls:

- `phi4-mini:3.8b`
- `nomic-embed-text`

Check Ollama model pull logs:

```bash
docker logs -f medassistant-ollama-pull
```

## 5. Nginx

Copy the nginx config:

```bash
cp /opt/medassistant/app/deploy/nginx-medassistant.conf /etc/nginx/sites-available/medassistant
ln -s /etc/nginx/sites-available/medassistant /etc/nginx/sites-enabled/medassistant
nginx -t
systemctl reload nginx
```

Enable HTTPS:

```bash
certbot --nginx -d medassistant.hakida.co.ke
```

The app will be available at:

```text
https://medassistant.hakida.co.ke
```

## 6. Initial Login

Use the admin credentials from `.env.production`:

```text
Phone: ADMIN_PHONE
Password: ADMIN_PASSWORD
```

Admin panel:

```text
https://medassistant.hakida.co.ke/admin
```

## 7. Ingest Internal Clinical Guideline

After the app is running, upload/ingest the internal clinical guideline from the UI/API you already use locally.

The production stack initializes the pathway tables from:

```text
db/clinical_pathways_schema_seed.sql
```

Qdrant still needs the guideline chunks embedded into:

```text
QDRANT_COLLECTION=clinical_guidelines
```

## 8. Operations

Restart only this app:

```bash
cd /opt/medassistant/app
docker compose --env-file .env.production -f docker-compose.prod.yml restart
```

View logs:

```bash
docker logs -f medassistant-chat
docker logs -f medassistant-postgres
docker logs -f medassistant-qdrant
docker logs -f medassistant-ollama
```

Back up clinical database:

```bash
docker exec medassistant-postgres pg_dump -U clinical_user clinical_pathways > medassistant-clinical-backup.sql
```

## 9. Notes For 4 GiB VPS

The VPS has 4 GiB RAM. Local Ollama with `phi4-mini:3.8b` may run, but it can be slow or memory constrained. If performance is poor:

1. Keep Ollama for embeddings only.
2. Select OpenAI or DeepSeek in the admin panel for chat responses.
3. Put the API key in `.env.production`.

Do not expose Postgres, Qdrant, or Ollama publicly. This compose binds them to `127.0.0.1`.
