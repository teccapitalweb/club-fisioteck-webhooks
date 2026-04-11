# Club FisioTeck — Webhook Server

Servidor que conecta Shopify con Firebase para el Club FisioTeck.

## Variables de entorno (configurar en Railway)

- `FIREBASE_SERVICE_ACCOUNT` — JSON completo de la clave de servicio de Firebase
- `SHOPIFY_WEBHOOK_SECRET` — Secret de los webhooks de Shopify
- `PORT` — Puerto (Railway lo asigna automáticamente)

## Endpoints

- `POST /webhooks/orders/paid` — Shopify envía cuando se paga un pedido
- `POST /webhooks/subscriptions/cancelled` — Cuando se cancela una suscripción
- `POST /webhooks/subscriptions/failed` — Cuando falla un pago
- `GET /api/member/:email` — Consultar datos de un socio
- `POST /api/link-member` — Vincular un socio pendiente con su cuenta
