# Perfilar en Render

Perfilar es un software de back office de selección de personal. Lee currículums con IA, filtra requisitos y asigna candidatos a las vacantes de la empresa.

Esta carpeta tiene todo lo necesario para publicarlo en Render:

| Archivo | Para qué sirve |
|---|---|
| `server.js` | Servidor: muestra la web, guarda los datos y se conecta con la IA |
| `public/index.html` | La web de Perfilar |
| `public/shim.js` | Conecta la web con el servidor |
| `public/diagnostico.html` | Revisa la configuración: abrí `/diagnostico` |
| `seed.json` | Datos iniciales: la empresa y las 7 vacantes |
| `render.yaml` | Configuración automática para Render |
| `package.json` | Dependencias de Node |

## Qué se necesita

1. Una cuenta de **GitHub**.
2. Una cuenta de **Render** (render.com).
3. Una **clave de la API de Anthropic**. Se crea en https://platform.claude.com, en la sección API Keys. La cuenta necesita crédito cargado: Perfilar usa Claude Sonnet 5.5 y cada CV cuesta unos pocos centavos de dólar.

## Paso a paso

### 1. Subir el código a GitHub

1. En GitHub, creá un repositorio nuevo, por ejemplo `perfilar`.
2. Subí todos los archivos de esta carpeta, manteniendo la carpeta `public` tal cual. Desde la web de GitHub se puede hacer con **Add file → Upload files**.

### 2. Crear todo en Render con el Blueprint (recomendado)

1. En Render, tocá **New → Blueprint**.
2. Conectá tu cuenta de GitHub y elegí el repositorio `perfilar`.
3. Render lee `render.yaml` y propone crear dos cosas: el servicio web `perfilar` y la base de datos `perfilar-db`, ambos en plan gratuito.
4. Te va a pedir un valor:
   - `ANTHROPIC_API_KEY`: pegá la clave de Anthropic.
5. Tocá **Apply** y esperá unos minutos a que termine.
6. Abrí la dirección que termina en `.onrender.com`.
7. (Opcional) Para que nadie más pueda entrar, agregá en **Environment** la variable `APP_PASSWORD` con una contraseña. El navegador la va a pedir al entrar.

### Alternativa: crear todo a mano

1. **New → Postgres**, plan Free. Cuando esté lista, copiá la **Internal Database URL**.
2. **New → Web Service**, elegí el repositorio y completá:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free
3. En **Environment**, agregá estas variables:
   - `DATABASE_URL`: la URL de Postgres que copiaste.
   - `ANTHROPIC_API_KEY`: la clave de Anthropic.
   - `APP_PASSWORD` (opcional): una contraseña para entrar.
   - `ANTHROPIC_MODEL` (opcional): `claude-sonnet-5-5`. Para gastar menos, se puede usar `claude-haiku-5-5`.

## Cosas para tener en cuenta

- **El servicio gratis se duerme.** Después de 15 minutos sin uso, Render lo apaga y el siguiente acceso tarda cerca de un minuto en arrancar. Antes de la demo, abran la página un par de minutos antes.
- **La base gratis de Render vence a los 30 días**, con 14 días extra de gracia antes de que se borre. Alcanza para el proyecto. Si la quieren por más tiempo, pueden usar una base gratuita de Neon o Supabase y poner su URL en `DATABASE_URL`.
- **Sin `DATABASE_URL`**, Perfilar guarda los datos en un archivo que Render borra en cada reinicio. Sirve solo para probar.
- **Sin `ANTHROPIC_API_KEY`**, la app funciona igual (vacantes, ranking, cálculo), pero no puede leer CVs con IA. En ese caso, la ficha del candidato se completa a mano.
- La primera vez que arranca con la base vacía, carga sola la empresa y las 7 vacantes de `seed.json`.

## Si al subir un CV no lee el archivo

Abrí tu dirección de Render agregando `/diagnostico` al final, por ejemplo `https://perfilar.onrender.com/diagnostico`. La página revisa todo y dice qué arreglar. Las causas más comunes son:

| Qué pasa | Causa | Cómo se arregla |
|---|---|---|
| Al subir el CV aparece la ficha vacía para completar a mano | Falta `ANTHROPIC_API_KEY` | Render → tu servicio → **Environment** → agregá la clave → **Save Changes** |
| Aparece "La cuenta de Anthropic no tiene crédito" | La cuenta de la API no tiene saldo | platform.claude.com → **Billing** → cargá crédito (con 5 dólares alcanza) |
| Aparece "La clave no es válida" | La clave está mal copiada o se borró | Creá una nueva en platform.claude.com → **API Keys** y pegala sin espacios |
| Los botones están grises o dice "No se pudo conectar con el servidor" | Se creó como **Static Site**, o falta `shim.js` | Tiene que ser un **Web Service** con Start Command `npm start`, y `shim.js` tiene que estar dentro de `public` |
| Dice "Cannot GET /" | `index.html` no está dentro de la carpeta `public` | Mové `index.html`, `shim.js` y `diagnostico.html` a `public/` |
| Los datos desaparecen solos | Falta `DATABASE_URL` | Conectá una base Postgres (ver arriba) |

Una suscripción a Claude Pro o Max **no sirve** como clave: la API se paga aparte, en platform.claude.com.

## Probarlo en tu computadora (opcional)

Con Node 18 o superior instalado:

```bash
npm install
ANTHROPIC_API_KEY=tu_clave npm start
```

Después abrí http://localhost:3000. Sin `DATABASE_URL`, los datos se guardan en `data.json`.
