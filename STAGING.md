# Lanzar en Staging (Render)

## Opción 1: Nuevo servicio Staging en Render

1. **Dashboard de Render** → [dashboard.render.com](https://dashboard.render.com)
2. **New** → **Web Service**
3. Conectar el mismo repositorio (GitHub/GitLab) que producción
4. Configuración:
   - **Name**: `progressbar-staging` (o el que prefieras)
   - **Branch**: `staging` (crear la rama y pushear, o usar `develop` / la que uses para pruebas)
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free (o el mismo que producción)

5. **Environment** (variables de entorno):
   - `NODE_ENV` = `staging`
   - `APP_BASE_URL` = **la URL que Render te asigne** al crear el servicio (ej. `https://progressbar-staging.onrender.com`)
   - Las mismas que en producción: `TIENDANUBE_CLIENT_ID`, `TIENDANUBE_CLIENT_SECRET`, `PORT=3000`, y todas las `DB_*` (puedes usar la misma base o una DB de staging).

6. **Create Web Service**. Tras el primer deploy, copia la URL del servicio y, si hace falta, actualiza `APP_BASE_URL` en Environment con esa URL y redeploya.

7. En el **Portal de socios de Tiendanube**, para probar la app en staging puedes usar la URL de prueba (Modo desarrollador) apuntando a `https://progressbar-staging.onrender.com/admin` (o la URL que te dé Render).

---

## Opción 2: Rama local y push a `staging`

Si aún no tienes rama `staging`:

```bash
git checkout -b staging
git push -u origin staging
```

Luego crea el servicio en Render apuntando a la rama `staging` como en la opción 1.

---

## Opción 3: Probar en local como staging

Copia `.env` a `.env.staging`, pon `APP_BASE_URL` a la URL pública de tu staging (o usa [ngrok](https://ngrok.com) para exponer localhost). Luego:

```bash
# Windows (PowerShell)
$env:NODE_ENV="staging"; npm start

# Mac/Linux
NODE_ENV=staging npm start
```

O define `NODE_ENV=staging` dentro de `.env.staging` y carga ese archivo (por ejemplo con `dotenv-cli` o renombrando a `.env` para la sesión).
