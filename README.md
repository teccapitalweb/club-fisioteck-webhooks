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

## Correos del Club (Resend) y recordatorios de pago

Variables en Railway (nunca en el código):

- `RESEND_API_KEY` — llave de Resend (resend.com).
- `MAIL_FROM` — remitente ya verificado en Resend, p. ej. `FisioTeck <no-reply@fisioteck.com>`.
- `CLUB_URL` — (opcional) dirección del Club; por defecto `https://club.fisioteck.com`.
- `API_URL` — (opcional) dirección pública de este servidor; se usa en el enlace de baja de los recordatorios.
- `CERT_SIGNING_KEY` — también firma los enlaces de baja (derivada con etiqueta propia).
- `RECORDATORIOS_TAREA=off` — apaga la revisión automática de recordatorios.

Sin `RESEND_API_KEY`/`MAIL_FROM` el servidor arranca igual: los correos de bienvenida y pago siguen por EmailJS y la verificación usa el correo estándar de Firebase.

Con Resend configurado salen con la plantilla de FisioTeck: confirmar correo (`POST /api/auth/send-verification`), restablecer contraseña (`POST /api/auth/reset-password`), certificado con el PDF adjunto (al emitirse) y la bienvenida, el aviso de pago y la cancelación.

**Recordatorios de pago** (misma serie que Alintec y Zoorigen: 7 correos por vuelta, hasta 3 vueltas, descanso de 4 días, cupones únicos de Stripe de $50 y $100 solo para el primer mes del plan mensual, de 8:00 a 22:00 hora de México). **Arrancan APAGADOS**: se encienden en el panel → Recordatorios de pago, después de un ensayo y un correo de prueba. Montos, tiempos y vueltas están en `services/recordatorios-pago.js` (`SERIE` y `CONFIG`).
