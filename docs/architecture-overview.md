# WIFITEST Architecture Overview

Este documento resume la arquitectura general de WIFITEST para que otra conversación de Codex pueda entender rápidamente cómo está organizado el proyecto, cómo fluye la información y dónde vive cada responsabilidad principal.

No entra en detalle tool por tool. El objetivo es explicar el sistema a alto nivel.

## 1. Qué es WIFITEST

WIFITEST es una aplicación de escritorio local-first para auditar redes Wi-Fi y la superficie básica de administración del router asociado.

La aplicación está dividida en dos grandes partes:

- `backend local` que expone capacidades de auditoría como tools MCP
- `frontend de escritorio` que guía al usuario, lanza pruebas, guarda contexto y presenta resultados

La filosofía general es:

- las comprobaciones reales se ejecutan en la misma máquina que tiene la interfaz Wi-Fi
- el frontend no ejecuta herramientas de sistema directamente
- el backend publica tools asíncronas y devuelve resultados estructurados
- el frontend traduce esos resultados a una experiencia guiada y a un sistema de scoring

## 2. Componentes principales

### 2.1 Frontend

Vive en `frontend/` y está encapsulado como aplicación de escritorio mediante Tauri.

Tecnologías principales:

- `Tauri` como shell de escritorio
- `HTML/CSS/JavaScript` para la interfaz

Responsabilidades principales:

- mostrar la interfaz y el flujo de uso
- descubrir las tools disponibles en el MCP
- lanzar tools
- hacer polling de jobs asíncronos
- mantener el estado global de la aplicación
- persistir el contexto principal de la red objetivo
- calcular la puntuación global de seguridad

### 2.2 Servidor MCP

Vive principalmente en `backend/MCP/server.py`.

Tecnologías principales:

- `Python`
- `MCP Python SDK`
- `FastMCP`
- `streamable-http`

Responsabilidades principales:

- declarar las tools MCP
- recibir llamadas JSON-RPC desde el frontend
- serializar y validar argumentos
- crear un `job_id`
- registrar el job en Redis
- encolar la ejecución
- exponer el recurso `job://{job_id}` para consultar el estado y el resultado

Importante: el servidor MCP no hace la ejecución pesada de la tool en línea. Solo prepara y despacha el trabajo de forma asíncrona.

### 2.3 Redis

Vive como infraestructura externa, pero el acceso está centralizado en `backend/MCP/redis_queue.py`.

Se usa para dos cosas:

- cola de jobs mediante `Redis Streams`
- almacenamiento de metadatos y resultados de cada job

Claves y estructuras importantes:

- stream de jobs: `mcp:jobs:stream`
- grupo de consumidores: `mcp-workers`
- hash por job: `mcp:job:{job_id}`

### 2.4 Workers

Viven en `backend/MCP/worker.py`.

Responsabilidades principales:

- leer jobs pendientes desde Redis
- resolver dinámicamente qué ejecutor corresponde a cada tool
- ejecutar la lógica real de la tool
- envolver el resultado en un contrato común
- actualizar el estado del job en Redis

## 3. Flujo asíncrono de una tool

El patrón de ejecución es uno de los aspectos más importantes del proyecto.

### 3.1 Secuencia completa

1. El frontend decide lanzar una tool.
2. Usa el cliente MCP para hacer una llamada `tools/call`.
3. El servidor MCP recibe la petición.
4. `server.py` delega en `serializer.py` la normalización y validación de argumentos.
5. El servidor genera un `job_id`.
6. Se crea la metadata inicial del job en Redis con estado `queued`.
7. El job se encola en el stream `mcp:jobs:stream`.
8. El servidor devuelve inmediatamente una respuesta pequeña con:
   - `job_id`
   - `tool_name`
   - `status: queued`
   - `resource: job://{job_id}`
9. Un worker consume el job desde Redis.
10. El worker marca el job como `running`.
11. El worker resuelve qué función ejecutar según el nombre de la tool.
12. La tool devuelve un objeto con:
   - `raw_text`
   - `normalized`
13. El worker completa el sobre común de salida:
   - `raw_text`
   - `normalized`
   - `nombreTool`
   - `job_id`
14. El worker marca el job como `completed` o `failed`.
15. El frontend hace polling del recurso `job://{job_id}` hasta que el estado final llega.
16. El frontend guarda el resultado en su store y actualiza la UI.

### 3.2 Por qué se hace así

Este diseño evita bloquear el servidor mientras una tool:

- tarda varios segundos
- ejecuta comandos del sistema
- usa la interfaz Wi-Fi
- necesita esperar a capturas o sondeos

También permite:

- varias tools concurrentes
- varios workers
- polling estable desde el frontend
- trazabilidad clara por `job_id`

## 4. Contratos y serialización

Uno de los pilares de desacoplamiento del proyecto es el fichero compartido:

- `contracts/tools.json`

Ese fichero define para cada tool:

- `input`
- `output`
- argumentos con `default`
- argumentos `free`
- argumentos `fixed`
- valores permitidos cuando aplica

### 4.1 Backend

En backend, `backend/MCP/tool_contracts.py` carga este fichero y lo cachea.

Después, `backend/MCP/serializer.py` usa esos contratos para:

- aplicar valores por defecto
- validar argumentos `fixed`
- normalizar entradas vacías
- ejecutar validaciones específicas por tool

Resultado: antes de que una tool se encole, su input ya está validado y normalizado.

### 4.2 Frontend

En frontend, `frontend/src/lib/contracts/contracts.js` carga el mismo fichero:

- primero intenta leerlo mediante un comando Tauri (`read_tool_contracts`)
- si eso falla, usa `fetch` como fallback

Esto permite que frontend y backend compartan una visión común de las tools sin duplicar definiciones a mano.

## 5. Estructura del backend MCP

### 5.1 `backend/MCP/server.py`

Es la puerta de entrada al backend.

Hace principalmente cuatro cosas:

- configura el servidor FastMCP
- declara las tools
- serializa y encola jobs
- expone el recurso `job://{job_id}`

Las tools declaradas aquí no suelen contener lógica de auditoría; simplemente empaquetan argumentos y llaman a un helper común (`procesarTool`).

### 5.2 `backend/MCP/serializer.py`

Contiene la validación de entrada por tool.

Funciones clave:

- aplicar defaults
- validar `fixed args`
- convertir strings numéricos
- comprobar formatos como MAC, IPv4 o tiempos

### 5.3 `backend/MCP/redis_queue.py`

Encapsula el acceso a Redis.

Responsabilidades:

- crear cliente Redis
- crear jobs
- encolar jobs
- actualizar estado
- recuperar un job completo por `job_id`

### 5.4 `backend/MCP/worker.py`

Es el consumidor asíncrono.

Lógica clave:

- `resolve_executor(tool_name)` importa dinámicamente `tools.{tool_name}`
- busca una función con nombre `{tool_name}_execute`
- ejecuta esa función
- envuelve la salida con el contrato común

### 5.5 `backend/MCP/tools/`

Aquí vive la lógica real de cada tool.

Patrón esperado:

- un fichero por tool
- una función principal `{tool_name}_execute(input)`
- devuelve al menos:
  - `raw_text`
  - `normalized`

### 5.6 `backend/MCP/tools/helpers.py`

Contiene lógica compartida, especialmente la relacionada con:

- gestión de modo de interfaz Wi-Fi (`monitor` / `managed`)
- restauración de estado de conexión
- interacción con `NetworkManager`

Este fichero es importante porque varias tools dependen de una única interfaz Wi-Fi y necesitan alternar entre escaneo y conexión sin que el usuario lo gestione manualmente.

## 6. Estructura del frontend

### 6.1 Tauri

El shell de escritorio está en `frontend/src-tauri/`.

Punto relevante:

- `frontend/src-tauri/src/lib.rs` define el comando `read_tool_contracts`, usado para leer `contracts/tools.json` desde el runtime nativo

### 6.2 MCP client

Vive en:

- `frontend/src/lib/mcp/client.js`

Responsabilidades:

- inicializar sesión MCP
- hablar JSON-RPC por HTTP local
- llamar a `tools/list`
- llamar a `tools/call`
- leer recursos `resources/read`

Detalles importantes:

- base URL por defecto: `http://127.0.0.1:8000/mcp`
- usa inicialización MCP antes de hacer requests normales

### 6.3 Descubrimiento de tools

Vive en:

- `frontend/src/lib/mcp/tools.js`

La función `discoverTools()`:

- llama a `tools/list` en MCP
- carga el contrato compartido
- fusiona ambas fuentes
- construye una definición enriquecida por tool:
  - metadatos MCP
  - contrato compartido
  - `defaultArgs`

### 6.4 Ejecución y polling de jobs

Vive en:

- `frontend/src/lib/mcp/jobs.js`

Responsabilidades:

- lanzar tools (`executeTool`)
- guardar el job inicial en el store
- programar polling con `setTimeout`
- consultar `job://{job_id}` periódicamente
- detener polling al completar, fallar o expirar

Estados finales reconocidos:

- `completed`
- `failed`
- `not_found`

### 6.5 Store global

Vive en:

- `frontend/src/lib/mcp/store.js`

Estado principal:

- `tools`
- `jobs`
- `activeJobIds`
- `completedJobIds`
- `failedJobIds`
- `targetNetwork`

`targetNetwork` es el contexto persistente principal del producto. Ahí se guardan, por ejemplo:

- red fijada
- escaneo inicial
- perfil enriquecido
- estado de conexión
- router profile
- UPnP
- management services
- evaluaciones asistidas
- resultados usados por el scoring

Persistencia:

- se guarda en `localStorage`
- clave: `wifitest.targetNetwork`

### 6.6 Main UI

La lógica de interfaz vive principalmente en:

- `frontend/src/main.js`

Responsabilidades:

- renderizar vistas
- conectar eventos de UI con tools
- sincronizar resultados de jobs al `targetNetwork`
- disparar el scoring

## 7. Modelo de datos del frontend

El proyecto gira mucho alrededor de `targetNetwork`.

Ese objeto funciona como contexto acumulado de la red que el usuario ha fijado para analizar.

Ejemplos de campos relevantes:

- `selectedNetwork`
- `scanResult`
- `profile`
- `connection`
- `wps`
- `routerProfile`
- `upnp`
- `managementServices`
- `passwordAssessment`
- `adminCredentialsAssessment`

La idea es que las tools no devuelven “pantallas”, sino resultados estructurados que luego el frontend injerta en este contexto común.

## 8. Motor de scoring

Vive en:

- `frontend/src/lib/security/scoring.js`

Características principales:

- no ejecuta herramientas
- trabaja solo con el estado acumulado del frontend
- aplica reglas de scoring independientes
- devuelve:
  - puntuación 0-10
  - cobertura
  - hallazgos negativos
  - señales positivas
  - comprobaciones pendientes
  - recomendaciones

La arquitectura del scoring está pensada para ser escalable:

- cada nuevo factor de seguridad se añade como una regla más
- no hace falta rediseñar el motor entero al incorporar una nueva tool

## 9. Diferencia funcional entre análisis “no conectado” y “conectado”

El producto separa dos contextos:

- comprobaciones sin estar conectado a la red objetivo
- comprobaciones una vez conectado a la red objetivo

Esto tiene impacto directo en la arquitectura porque:

- algunas tools necesitan la interfaz en modo `monitor`
- otras necesitan `managed`

El backend encapsula esta complejidad en helpers, para que el frontend solo tenga que pedir una capacidad y no gestionar manualmente la tarjeta Wi-Fi.

## 10. Mapa rápido de archivos importantes

### Backend

- `backend/MCP/server.py`: entrypoint MCP y declaración de tools
- `backend/MCP/serializer.py`: validación y normalización de inputs
- `backend/MCP/worker.py`: consumo de jobs y ejecución real
- `backend/MCP/redis_queue.py`: acceso a Redis
- `backend/MCP/tool_contracts.py`: carga del contrato compartido
- `backend/MCP/tools/helpers.py`: utilidades compartidas
- `backend/MCP/tools/*.py`: implementaciones reales de tools

### Frontend

- `frontend/src/main.js`: render y flujo principal de UI
- `frontend/src/styles.css`: estilos
- `frontend/src/lib/mcp/client.js`: cliente MCP por HTTP
- `frontend/src/lib/mcp/jobs.js`: ejecución y polling
- `frontend/src/lib/mcp/tools.js`: descubrimiento y normalización de tools
- `frontend/src/lib/mcp/store.js`: estado global
- `frontend/src/lib/contracts/contracts.js`: carga de contratos compartidos
- `frontend/src/lib/security/scoring.js`: motor de scoring
- `frontend/src/lib/security/password-strength.js`: evaluación local de robustez de clave Wi-Fi
- `frontend/src-tauri/src/lib.rs`: comandos Tauri disponibles para el frontend

### Contratos y apoyo

- `contracts/tools.json`: contrato compartido de tools
- `scripts/dev-stack.sh`: arranque de la pila de desarrollo

## 11. Cómo añadir una nueva tool sin romper la arquitectura

La arquitectura está pensada para crecer de forma incremental.

Para añadir una nueva tool MCP normalmente hay que tocar:

1. `contracts/tools.json`
   - definir input/output
2. `backend/MCP/serializer.py`
   - añadir serializer específico
3. `backend/MCP/server.py`
   - exponer la tool vía MCP
4. `backend/MCP/tools/<tool>.py`
   - implementar `{tool_name}_execute`
5. opcionalmente `frontend/src/main.js`
   - conectar la funcionalidad a la UI
6. opcionalmente `frontend/src/lib/security/scoring.js`
   - si la nueva tool debe afectar a la puntuación global

Gracias a este patrón:

- el backend sigue siendo homogéneo
- el frontend puede descubrir tools de forma consistente
- y el sistema de scoring puede ampliarse sin reestructurar toda la aplicación

## 12. Idea clave para otra conversación de Codex

Si otra conversación necesita entender el proyecto rápido, la idea más importante es esta:

- el backend MCP **no ejecuta en línea**, sino que **publica jobs asíncronos**
- Redis desacopla entrada y ejecución
- los workers ejecutan la lógica real
- el frontend hace polling de `job://{job_id}`
- el estado central del producto vive en `targetNetwork`
- el scoring se calcula en frontend a partir de resultados ya acumulados

Esa es la columna vertebral del proyecto.
