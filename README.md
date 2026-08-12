# Club FisioTeck — Webhook Server

Servidor que conecta Stripe, Firebase y Bunny Stream para el Club FisioTeck.

## Variables de entorno (configurar en Railway)

- `FIREBASE_SERVICE_ACCOUNT` — JSON completo de la clave de servicio de Firebase
- `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` — cobros y webhooks de Stripe
- `BUNNY_STREAM_LIBRARY_ID` — ID de la biblioteca de Bunny Stream
- `BUNNY_STREAM_TOKEN_KEY` — llave de firma para reproducción protegida
- `PORT` — Puerto (Railway lo asigna automáticamente)

## Endpoints

- `POST /webhooks/stripe` — recibe eventos de Stripe
- `POST /api/create-checkout` — crea la suscripción
- `POST /api/video-playback` — entrega una URL firmada de Bunny después de validar Firebase y el acceso
- `GET /api/member/:email` — Consultar datos de un socio
- `POST /api/link-member` — Vincular un socio pendiente con su cuenta

Consulta [BUNNY-MIGRATION.md](BUNNY-MIGRATION.md) para el flujo de carga y asociación de videos.
