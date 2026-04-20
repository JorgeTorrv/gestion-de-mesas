# Deploy gratuito con auto-deploy desde GitHub

Guia paso a paso para dejar la app en internet, con una URL fija, 100% gratis, y que cada `git push` actualice el sitio automaticamente.

**Stack recomendado:**
- **Host**: [Fly.io](https://fly.io) (tier gratuito, siempre online, incluye volumen persistente)
- **Repo**: GitHub (privado o publico, ambos funcionan)
- **Auto-deploy**: GitHub Actions dispara `flyctl deploy` en cada push a `main`

Por que Fly.io y no otro:
- Es el unico tier realmente gratis que deja **archivos persistentes** (nuestro `data/mesas.json` tiene que sobrevivir entre deploys).
- Otros tiers gratis (Render, Vercel, Netlify) tienen disco efimero o requieren migrar a una BD externa.
- La maquina se apaga automaticamente cuando no hay trafico y se despierta en ~2-4s al recibir un request, asi nunca agotas las horas gratuitas.

---

## 1. Crear el repo en GitHub (una sola vez)

### Opcion A — desde la web
1. Entra a https://github.com/new
2. Nombre: `gestion-de-mesas` (o el que quieras)
3. Elige privado o publico, **no** marques "Add README/gitignore/license" (ya los tienes)
4. Crear repo y copia la URL que te da (formato `https://github.com/TU_USUARIO/gestion-de-mesas.git`)

### Opcion B — desde la terminal con `gh` (si lo instalas)
```bash
winget install GitHub.cli
gh auth login
cd "G:/Documentos/GestionDeMesas"
gh repo create gestion-de-mesas --private --source=. --remote=origin
```

### Primer push
Desde la carpeta del proyecto:
```bash
cd "G:/Documentos/GestionDeMesas"
git init
git branch -M main
git add .
git commit -m "initial"
git remote add origin https://github.com/TU_USUARIO/gestion-de-mesas.git
git push -u origin main
```

A partir de aqui, cualquier `git push` a `main` va a disparar el auto-deploy (una vez configuremos el paso 3).

---

## 2. Crear la app en Fly.io (una sola vez)

### 2.1. Instalar flyctl
- **Windows (PowerShell)**:
  ```powershell
  iwr https://fly.io/install.ps1 -useb | iex
  ```
  Luego cierra y abre una terminal nueva.
- **Mac / Linux**: `curl -L https://fly.io/install.sh | sh`

### 2.2. Crear cuenta y hacer login
```bash
fly auth signup      # si no tienes cuenta
fly auth login       # si ya tienes
```
Fly.io pide tarjeta incluso en el plan gratis (para evitar abuso), pero **no te cobra** mientras te quedes en el tier free (una maquina 256MB + 1 volumen 3GB).

### 2.3. Lanzar la app
Dentro de la carpeta del proyecto:
```bash
cd "G:/Documentos/GestionDeMesas"
fly launch --no-deploy
```
Flujo de preguntas:
- **"App name"** → elige un nombre global unico, por ejemplo `mesas-juan` (tu URL sera `https://mesas-juan.fly.dev`). Si te dice que el del `fly.toml` ya existe, escribe uno nuevo.
- **"Choose a region"** → `mia` (Miami) o la mas cercana a ti.
- **"Would you like to set up a Postgres database?"** → **No**
- **"Would you like to set up an Upstash Redis database?"** → **No**
- **"Create .dockerignore from .gitignore?"** → **No** (ya existe)
- **"Would you like to deploy now?"** → **No**

Si te cambio el nombre de la app, tambien lo sobreescribio en `fly.toml`. Verifica que `[[mounts]]` sigue apuntando a `source = "mesas_data"` y `destination = "/data"`.

### 2.4. Crear el volumen persistente
```bash
fly volumes create mesas_data --region mia --size 1
```
(Confirmas con `y`. El volumen es gratis hasta 3GB; con 1GB basta y sobra para miles de invitados.)

### 2.5. Primer deploy manual (para verificar)
```bash
fly deploy
```
Cuando termine, abre la URL: `fly open` o `https://TU-APP.fly.dev`.

---

## 3. Auto-deploy desde GitHub (una sola vez)

El archivo `.github/workflows/deploy.yml` ya esta listo. Solo falta darle un token a GitHub para que pueda llamar a Fly.io.

### 3.1. Crear el token
```bash
fly tokens create deploy -x 8760h
```
Copia TODO el output (empieza con `FlyV1 fm2_...`). Ese es tu `FLY_API_TOKEN`.

### 3.2. Guardarlo en GitHub
1. En tu repo, ve a **Settings → Secrets and variables → Actions → New repository secret**
2. Nombre: `FLY_API_TOKEN`
3. Value: pega el token completo
4. **Add secret**

### 3.3. Probar
Haz cualquier cambio pequeno (por ejemplo edita README) y:
```bash
git add .
git commit -m "test auto-deploy"
git push
```
En GitHub, pestana **Actions**, veras el workflow corriendo. En 1-2 minutos el sitio tiene la version nueva.

---

## 4. Uso diario

Desde ahora, tu flujo es:
```bash
# editas codigo
git add .
git commit -m "lo que cambio"
git push
```
Listo. En ~90s el sitio esta actualizado. La base de datos (`/data/mesas.json`) no se toca porque vive en el volumen persistente.

---

## 5. Comandos utiles

```bash
fly status              # estado actual de la app
fly logs                # logs en vivo
fly open                # abrir la URL en el navegador
fly ssh console         # entrar al contenedor (para inspeccionar /data/mesas.json)
fly scale memory 512    # subir RAM si llegaras al limite
fly apps destroy TU-APP # borrar todo (cuidado)
```

Para bajar el respaldo desde el servidor sin entrar por SSH, usa el boton **Guardar** dentro de la app: descarga el JSON igual que en local.

---

## Alternativas (por si Fly.io no te convence)

| Host | Gratis? | Persistencia | Auto-deploy | Notas |
|------|---------|--------------|-------------|-------|
| **Fly.io** | Si | Volumen 3GB | Via Action | Recomendado aqui |
| **Railway** | $5 credito/mes (≈gratis a este volumen) | Volumen incluido | Nativo (conecta repo) | Mas simple pero no 100% gratis |
| **Render** | Si, pero | Disco efimero en free; disco persistente solo en planes pagos | Nativo | Tendrias que migrar a Postgres gratis (Neon) |
| **Glitch** | Si | Si, pero proyecto duerme | Import desde GitHub | Limite de horas al mes |

Si prefieres Railway: `https://railway.app` → **New Project → Deploy from GitHub repo** → elige el repo → agrega variable `DATA_DIR=/data` y monta un volumen en `/data`. El resto es automatico.
