# Gestion de Mesas

Sistema web dinamico para gestionar mesas e invitados en eventos.

## Stack

- **Backend**: Node.js + Express (puro JS, sin modulos nativos)
- **Persistencia**: archivo JSON en `data/mesas.json` (guardado automatico con escritura atomica)
- **Frontend**: HTML + CSS + JS vanilla (ES modules)
- **Excel**: [SheetJS](https://sheetjs.com/) via CDN (parseo en navegador)

## Arrancar

```bash
npm install
npm start
```

El servidor abre en `http://localhost:3000`.

Para acceder desde otro dispositivo en la misma red, usa la IP local de tu PC:
`http://<tu-ip-local>:3000` (asegurate que el firewall de Windows permita el puerto 3000).

## Funciones

- **Importar Excel**: detecta columnas automaticamente (nombre/telefono/email) y permite mapear manualmente antes de confirmar.
- **Crear mesas**: se colocan automaticamente en una cuadricula; arrastralas en el canvas para reordenar.
- **Tamano dinamico**: cada mesa crece conforme agregas invitados; el numero grande del centro muestra el total.
- **Arrastrar y soltar**: arrastra un invitado desde la lista lateral hasta cualquier mesa.
- **Click a una mesa**: muestra la lista de asistentes, permite agregar rapido (buscador de invitados sin mesa o crear uno nuevo solo con nombre).
- **Click a un invitado**: muestra nombre y telefono, edicion inline, y gestion de acompanantes (plus ones).
- **Plus ones**: cada acompanante es una persona independiente. Puede compartir mesa con el titular (cuenta como 1 adicional) o ir a otra mesa (cada uno cuenta 1 en su mesa). El titular no vale x2.
- **Un invitado = una mesa**: cada persona solo puede estar en una mesa a la vez.
- **Persistencia multi-dispositivo**: todo se guarda en `data/mesas.json` en el servidor. Abrirlo desde otro dispositivo en la misma red muestra el mismo estado.

## Estructura

```
GestionDeMesas/
  server.js        # Express + API REST
  db.js            # Persistencia JSON (sin SQLite para evitar compilacion nativa en Windows)
  package.json
  data/
    mesas.json     # Se crea al primer cambio
  public/
    index.html
    styles.css
    app.js         # Logica del frontend
```

## Endpoints API

- `GET  /api/state`           → `{ tables, guests }`
- `POST /api/tables`          → crear mesa
- `PUT  /api/tables/:id`      → editar mesa (nombre, capacidad)
- `PATCH /api/tables/:id/position` → mover mesa en el canvas
- `DELETE /api/tables/:id`    → eliminar mesa (los invitados quedan sin mesa)
- `POST /api/guests`          → crear invitado (acepta `parent_id` y `is_plus_one`)
- `POST /api/guests/bulk`     → importacion masiva
- `PUT  /api/guests/:id`      → editar invitado
- `PATCH /api/guests/:id/assign` → cambiar mesa asignada (o `null` para quitar)
- `DELETE /api/guests/:id`    → eliminar (cascada a sus plus ones)
- `POST /api/reset`           → borrar todo

## Notas

- La DB es un archivo JSON. Respaldar = copiar `data/mesas.json`.
- Si quieres otra base de datos (SQLite, Postgres, etc.) solo hay que reemplazar la implementacion de `db.js` manteniendo el mismo shape de `queries`.
