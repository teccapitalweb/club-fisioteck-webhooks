# Migración de video de FisioTeck a Bunny Stream

## Flujo preparado

1. El socio se registra gratis y puede explorar los 15 cursos.
2. La primera clase de cada curso queda marcada como `isPreview: true`.
3. Las demás clases requieren una membresía vigente.
4. El navegador solicita `/api/video-playback` con el token de Firebase.
5. El servidor valida usuario, membresía y clase; después genera una URL firmada de Bunny con vigencia corta.
6. Las llaves de Bunny nunca se envían al navegador.

## Archivos

- `data/bunny-catalog.json`: mapa exacto curso → clase → video de Bunny.
- `scripts/build-bunny-catalog.js`: regenera el mapa desde `club-fisioteck/data/content.json` sin borrar IDs de Bunny ya capturados.
- `.env.example`: variables requeridas en Railway.

## Después de subir los videos

1. Copia el GUID de cada video en `bunnyVideoId`, respetando su curso y clase.
2. Coloca `BUNNY_STREAM_LIBRARY_ID` y `BUNNY_STREAM_TOKEN_KEY` en el entorno del backend.
3. Activa Token Authentication en la biblioteca de Bunny.
4. En `club-fisioteck/data/content.json`, marca la clase migrada con `"videoProvider": "bunny"`. Mantén temporalmente `videoUrl` hasta comprobar la reproducción y luego retíralo.
5. Comprueba con una cuenta gratuita que sólo abra la clase 1 y con una cuenta pagada que abra todas.

El `BUNNY_STREAM_API_KEY` se usa únicamente para automatizar cargas o consultar la API desde un proceso administrativo. El reproductor sólo necesita la llave de firma en el backend.
