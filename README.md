# Inventario MP Nacional

App local preparada para deployment en Vercel. La primera version usa Excel con la pestaña `ANEXADO`; la capa de datos queda aislada para migrar luego a SingleStore/ODBC desde endpoints server-side.

## Campos esperados de ANEXADO

- `FECHA`
- `TIPO`
- `NOMBRE`
- `PRODUCTO`
- `TANQUE`
- `CAPACIDAD`
- `INVENTARIO`
- `DISPONIBLE`
- `ACIDEZ`
- `OC`
- `ORDEN RECIBIDA EN BODEGA`
- `FECHA ORDEN`
- `DIAS RETRAZO`
- `PEDIDO`
- `RETIRADO`
- `PENDIENTE RETIRO`
- `OBSERVACIÓN`
- `TRANSITO`
- `IMPORTACIONES`

Todas las cantidades se tratan como toneladas. `DISPONIBLE` se interpreta como inventario neto despues de merma.

## Ejecucion local

```bash
npm install
npm run dev
```

Abrir `http://localhost:3000`.

## Variables de entorno

Copiar `.env.example` a `.env.local`:

```bash
HF_TOKEN=
HF_MODEL=mistralai/Mistral-7B-Instruct-v0.3
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

En Vercel estas variables deben configurarse como Environment Variables del proyecto.

## Arquitectura

- `src/lib/excel.ts`: parser del archivo plano.
- `src/lib/types.ts`: modelo de inventario, flota, rutas y recomendaciones.
- `src/lib/optimizer.ts`: motor heuristico inicial para priorizar movimientos.
- `src/app/api/ai/route.ts`: inferencias de Hugging Face desde servidor.
- `src/app/api/telegram/route.ts`: notificaciones por bot de Telegram desde servidor.

## Siguiente paso de datos

Cuando exista el archivo de flota y la tabla de rutas, se deben reemplazar los datos de muestra de `sample-data.ts` por adaptadores server-side:

- inventario desde Excel o SingleStore
- flota disponible por fecha
- matriz de rutas con kilometros y costo por kilometro
- reglas de acidez y penalizacion operativa
