# API del hub

Escrito a mano a partir de `hub/src/server.ts`; `hub/test/docs.test.ts` comprueba que cada ruta de ese fichero aparece aquí como `` `MÉTODO /ruta` `` y que aquí no sobra ninguna. Al añadir o quitar una ruta, cambia este fichero.

## Reglas comunes

- El hub escucha en `127.0.0.1:<puerto>` (4747 por defecto). Toda ruta comprueba la cabecera `Host` (`127.0.0.1:<puerto>` o `localhost:<puerto>`); si no coincide responde `403 forbidden`. No hay CORS.
- **Auth** de las tablas:
  - `ninguna`: sin credencial.
  - `key`: cabecera `X-Office-Key` con la key de `~/.config/agent-office/key`; si falta o no coincide, `401 unauthorized` (texto).
  - `key o panel`: la misma cabecera `X-Office-Key` o un token de panel en `X-Office-Panel` (se obtiene en `POST /api/panel/claim`, vale 30 días); si no, `401 unauthorized`.
- Cabeceras de sesión que añade `office-hook.sh` (y los scripts): `X-Office-Socket`, `X-Office-Token`, `X-Office-Role`, `X-Office-Name`. El hub identifica con ellas a la sesión que llama.
- Topes de cuerpo: 8 MB en las rutas de los hooks y del chat (`/events`, `/hook`, `/ask`, `/permission`, `/gate*`, `/guard`, `/usage`, `/chat`, `/encargo` y `/api/chat/*`), 1 MB en el resto de `/api/*`, 64 KB en `PUT /api/layouts`. Pasado el tope: `413 {"error":{"key":"hub.api.bodyTooLarge"}}`.
- Un error no capturado en una ruta responde `500 {"error":{"key":"hub.api.internalError"}}` y queda en `hub.log`.
- Los errores de `/api/*` llevan una **clave de texto del hub** (`{"error":{"key":"hub.api.…","params":{…}}}`); el panel la traduce. Los textos de las claves están en `shared/`.
- Las rutas con `:id` o `:orderId` numéricos aceptan solo enteros de hasta 15 cifras; si no, `400 hub.api.badId` (o `hub.api.boardFields` donde se indica).

## Hooks y scripts

Las llaman `plugin/hooks/office-hook.sh`, los scripts de `plugin/scripts/` y los lanzadores. Todas exigen `key`, salvo `/health` (sin credencial) y `/api/redaccion/sync` (también acepta panel).

| Método y ruta | Auth | Cuerpo | Respuestas y claves de error |
| --- | --- | --- | --- |
| `GET /health` | ninguna | | `200 ok` (texto). Los lanzadores de los departamentos lo comprueban antes de abrir la sesión. |
| `POST /hook` | key | JSON del evento de hook de Claude Code | Texto: `pass`, `pass` + salto de línea + contexto que debe imprimir el hook (memoria, aviso del chat, reglas nuevas, denegación de lectura de un revisor), o `block:<motivo>` (el hook sale con código 2). Un cuerpo que no es un evento de hook da `pass`. Es la ruta de `office-hook.sh` por defecto: registra el evento, aplica la guardia a las herramientas de escritura y la puerta a `TaskCompleted`. |
| `POST /events` | key | JSON del evento | `200` vacío o con JSON de salida del hook. Solo registra; es la ruta de `emit.sh` (compatibilidad). |
| `POST /guard` | key | JSON del evento | Texto `pass` o `block:<motivo>`. Ruta de `guard.sh` (compatibilidad). |
| `POST /gate` | key | JSON del evento (`TaskCompleted`) | Texto `pass` o `block:<motivo>`. Ruta de `gate.sh` (compatibilidad). |
| `POST /gate-message` | key | JSON del evento (`PreToolUse` de `SendMessage`) | Texto `pass` o `block:<motivo>`: puerta del `HECHO:` y tope de encargos del director. |
| `POST /ask` | key | JSON del evento (`PreToolUse` de `AskUserQuestion`) | La petición queda abierta hasta que se responde en el panel, se devuelve al terminal o pasan unos 60 minutos. `200` con el JSON de decisión del hook, o `200` vacío para que salga en la terminal (sin panel abierto, o si se cancela). |
| `POST /permission` | key | JSON del evento (`PermissionRequest`) | Igual que `/ask`: JSON de decisión (permitir o denegar) o `200` vacío. |
| `POST /usage` | key | JSON de entrada de la línea de estado de Claude Code (`rate_limits`, `context_window`…) | Texto con la línea de estado que muestra la sesión (vacío si el cuerpo no trae ventanas de límite vigentes). |
| `POST /chat` | key | Formulario (o JSON): `channel`, `kind` (`texto`, `toca`, `listo`, `pregunta`), `text`, `files` (uno por ruta, solo en `toca` y `listo`), `from`, `cwd`. `?format=text` pide texto | `200 {"message","warnings"}` (o texto). Errores `{"error":…}` o `ERROR: …`: `400 hub.api.chatKind`, `hub.api.chatFields`, `hub.api.chatTooLong` (texto de más de 2 000 caracteres o más de 40 ficheros); `403 hub.api.chatChannelForbidden`, `hub.api.chatSessionUnknown`; `404 hub.api.chatChannelUnknown`, `hub.api.chatFloorUnknown`, `hub.api.chatAuthorUnknown`. |
| `GET /chat/:channel` | key | Query: `desde` (id del último mensaje visto), `esperar` (segundos, hasta 90; deja la petición abierta), `format=text` | `200` con la lista de mensajes (JSON) o texto. `404 hub.api.chatChannelUnknown`. |
| `POST /encargo` | key | Formulario (o JSON): `order` (`carpeta`, `comprobar`, `estado`, `descartar`), `slug`, `reason`, `cwd` | Siempre texto para la terminal del agente, con estado `200`, `400`, `403`, `404` o `409`. |
| `POST /api/redaccion/sync` | key o panel | JSON: `slug`, `floors` (plantas), `ref` opcional. `?format=text` pide texto | `200 {"ok":true,"slug","floors","text"}` (o texto) tras `fetch` y worktrees desacoplados. `400 {"error":…}` (o `ERROR: …`) si la petición no es válida o falla una planta. Lo llama `office-sync.sh`; la petición puede tardar. |

## Panel

Las llama la interfaz (`ui/src/api.ts`) con `X-Office-Panel`; el servidor MCP (`hub/src/mcp.ts`) y `office-sync.sh` usan las mismas rutas con `X-Office-Key`. Salvo que se indique, el cuerpo y la respuesta son JSON y los errores llevan `{"error":{"key":…}}`.

| Método y ruta | Auth | Cuerpo | Respuestas y claves de error |
| --- | --- | --- | --- |
| `POST /api/panel/claim` | ninguna | `{"t":"<enlace>"}` (el de `/?t=`) | `200 {"token"}` y gasta el enlace (10 minutos, un solo uso). `401 hub.api.panelLinkInvalid`. |
| `GET /api/state` | key o panel | | `200` instantánea de la oficina (plantas, agentes, sesiones, preguntas, actividad, documentos, ajustes, uso…). |
| `POST /api/answers/:id` | key o panel | `{"answers":…}` para responder una pregunta o permiso, o `{"release":true}` para devolverla al terminal | `200 {"ok":true}`. `409 hub.api.questionClosed` si ya no está abierta; `400 hub.api.answerMissing` sin respuestas. |
| `POST /api/orders` | key o panel | `{"sessionId","text"}` (texto de hasta 4 000 caracteres) | `200 {"ok":true}`. `400 hub.api.orderFields`, `hub.api.orderTooLong`; `404 hub.api.sessionNotFound`; `403 hub.api.sessionNotOffice`; `502 hub.api.orderFailed`. |
| `POST /api/sessions/:id/status` | key o panel | | Pedir estado. `200 {"ok":true}`. `404 hub.api.sessionNotFound`; `403 hub.api.sessionNotOffice`; `502 hub.api.orderFailed`. |
| `POST /api/sessions/:id/relaunch` | key o panel | `{"resume":true\|false}` opcional (por defecto retoma la conversación, solo si existe su transcript; si no, la sesión empieza de cero) | `200 {"ok":true}`. `404 hub.api.sessionNotFound`, `hub.api.relaunchNoScript`; `403 hub.api.sessionNotOffice`; `409 hub.api.relaunchBusy`, `hub.api.relaunchNoWindow`; `501 hub.api.relaunchNoTmux`; `502 hub.api.relaunchFailed`. |
| `GET /api/settings` | key o panel | | `200` vista de los ajustes. `503 hub.api.settingsUnavailable`. |
| `POST /api/settings` | key o panel | Cambios de ajustes (JSON) | `200 {"ok":true,…}`; `400 {"ok":false,"error":[…]}` con una clave por campo inválido; `503`. |
| `GET /api/layouts` | key o panel | | `200` el contenido de `layouts.json`. |
| `PUT /api/layouts` | key o panel | Fichero de distribución (`version`, `floors`, `all`) | `200 {"ok":true,"data"}`. `400 {"ok":false,"error"}` (`hub.layouts.invalid`, `slug`, `tooManyFloors`, `tooManyDesks`, `spot`, `furniture`, `role`, `model`); `503 hub.layouts.unavailable`; `500 hub.layouts.saveFailed`; `413` por encima de 64 KB. |
| `POST /api/floors` | key o panel | `{"path","slug"?}` | `200 {"ok":true,…}`. Fallo: `{"ok":false,"error"}` con `400` (`hub.floors.pathRequired`, `notGitRepo`, `insideRepo`…), `409` o `500`; `503 hub.api.floorsUnavailable`. |
| `DELETE /api/floors/:slug` | key o panel | Query `force=1` para borrar con carpetas sucias | `200 {"ok":true,…}`. Fallo `{"ok":false,"error"}`: `404 hub.floors.notFound`; `409 hub.floors.removing`, planta con sesiones abiertas o carpetas sucias; `500`; `503`. |
| `GET /api/board` | key o panel | | `200 {"orders":[…]}` los encargos (tarjetas) abiertos. |
| `POST /api/board/orders` | key o panel | `{"floor","title","description"?,"base"?,"via":"lead"\|"director"}` | `200 {"order"}`. `400 hub.api.boardFields`; `404 hub.api.floorNotManaged`; `409 hub.api.deliveryOff`, `hub.api.leadClosed`, `hub.api.directorClosed`; `502 hub.api.directorUnreachable`. |
| `POST /api/board/orders/:id/move` | key o panel | `{"to":"pendiente"\|"en-curso"\|"revision"\|"hecho","force"?:true}` | `200 {"order"}`. `400 hub.api.boardFields`; `404 hub.api.orderNotFound`; `409 hub.api.orderBadState`, `hub.api.moveNeedsForce` (con `reason`). |
| `POST /api/board/orders/:id/discard` | key o panel | | `200 {"order"}`. `400 hub.api.badId`; `404 hub.api.orderNotFound`; `409 hub.api.orderBadState`. |
| `POST /api/board/orders/:id/folder` | key o panel | | Reintenta crear la carpeta. `200 {"order"}`. `404 hub.api.orderNotFound`; `409 hub.api.orderBadState`, `hub.api.noFolder`. |
| `POST /api/board/orders/:id/confirm-checks` | key o panel | | Confirma que el cambio de cómo se comprueba es intencionado, para el `HEAD` actual. `200 {"order"}`. `404 hub.api.orderNotFound`; `409 hub.api.noFolder`. |
| `GET /api/board/orders/:id/checks` | key o panel | | `200` ejecuciones de comprobaciones con su salida. `404 hub.api.orderNotFound`. |
| `POST /api/board/orders/:id/checks` | key o panel | | Lanza las comprobaciones. `200 {"run"}`. `404 hub.api.orderNotFound`; `409 hub.api.noChecks`, `hub.api.noFolder`. |
| `DELETE /api/board/orders/:id/checks` | key o panel | | Cancela las que corren. `200 {"ok":true,"cancelled"}`. |
| `GET /api/board/orders/:id/checkpoints` | key o panel | | `200` los puntos de control. `404 hub.api.orderNotFound`. |
| `GET /api/board/orders/:id/diff` | key o panel | | Lo que cambiaron los commits de la rama del encargo desde su base (`base...head`; la base es la punta de la rama base, o el commit del que salió si ya está fusionada). `200 {"base","head","files":[{"path","oldPath","adds","dels","binary"}],"totals":{"files","adds","dels"},"truncated"}`, como mucho 300 archivos. `400 hub.api.badId`; `404 hub.api.orderNotFound`; `409 hub.api.orderNoBranch`; `500 hub.api.diffFailed`. |
| `GET /api/board/orders/:id/pr-draft` | key o panel | Query `lang` (`es` por defecto, o `en`) | Borrador de la descripción del PR del encargo, sin publicar nada: Resumen (el texto del encargo, hasta ~1500 caracteres), Commits (hasta 50), Comprobaciones (la última ejecución) y Diff. `200 {"title","body"}` con el cuerpo en Markdown. `400 hub.api.badId`; `404 hub.api.orderNotFound`; `409 hub.api.orderNoBranch`; `500 hub.api.diffFailed`, `hub.api.logFailed`. |
| `GET /api/board/orders/:id/diff/file` | key o panel | Query `path`, una de las rutas del diff | El parche de un archivo. `200 {"path","patch","truncated","binary"}`, el parche cortado a 400 KB al final de una línea. `400 hub.api.pathRequired`, `hub.api.diffPath`; `404 hub.api.orderNotFound`; `409 hub.api.orderNoBranch`; `500 hub.api.diffFailed`. |
| `POST /api/alerts/:id/seen` | key o panel | | Cierra un aviso de fin. `200 {"ok":true}`. `404 hub.api.alertNotFound`. |
| `GET /api/worktrees` | key o panel | Query `floor` opcional | `200` las carpetas de encargos con su estado y tamaño. |
| `POST /api/worktrees/prune` | key o panel | | Retira ahora las carpetas que ya caducaron. `200` con el resultado. |
| `POST /api/worktrees/:orderId/keep` | key o panel | | Conservar un hecho sin fusionar. `200 {"ok":true}`. `404 hub.api.worktreeNotFound`. |
| `DELETE /api/worktrees/:orderId` | key o panel | Query `branch=1` borra también la rama, `force=1` ignora lo sin guardar | `200 {"ok":true}`. `400 hub.api.badId`; `404 hub.api.worktreeNotFound`; `409 hub.api.worktreeBusy`, `hub.api.worktreeDirty`, `hub.api.branchUnmerged`; `500 hub.api.worktreeFailed`. |
| `GET /api/memory/:floor/:role` | key o panel | | `200` las lecciones del puesto. `400 hub.api.badMemoryTarget`. |
| `POST /api/memory` | key o panel | `{"floor","role","text"}` | `200 {"lesson"}`. `400 hub.api.floorRequired`, `hub.api.roleInvalid`, `hub.api.lessonEmpty`; `400 hub.api.lessonSaveFailed`; `409 hub.api.lessonDuplicate`. |
| `DELETE /api/memory/:id` | key o panel | | `200 {"ok":true}`. `400 hub.api.badId`; `404 hub.api.lessonNotFound`. |
| `GET /api/usage/summary` | key o panel | Query `range=today\|week` (por defecto `today`) | `200` tokens por agente, día y plan, y ventanas del límite. `400 hub.api.usageRange`. |
| `GET /api/reports/:agentKey` | key o panel | | `200` el informe del agente. `404 hub.api.noReport`. |
| `GET /api/search` | key o panel | Query: `q`, `floor`, `agent`, `kind`, `from`, `to`, `before`, `limit` (hasta 100) | `200` resultados de actividad, mensajes, chat y agentes. `400 hub.api.searchBad`. |
| `GET /api/replay/:sessionId` | key o panel | Query `compress=1` acorta los silencios de más de 60 s | `200` la grabación reconstruida de la sesión. `404 hub.api.noRecording`; `413 hub.api.recordingTooLarge` (más de 20 000 eventos). |
| `GET /api/documents` | key o panel | | `200` los planes y skills con su estado. |
| `GET /api/documents/content` | key o panel | Query `path` | `200` el contenido. `404 hub.api.documentNotFound`. |
| `POST /api/documents/discard` | key o panel | `{"path"}` | `200 {"ok":true}`. `400 hub.api.pathRequired`; `404 hub.api.planNotFound`; `409 hub.api.planClosed`. |
| `POST /api/documents/restore` | key o panel | `{"path"}` | `200 {"ok":true}`. `400 hub.api.pathRequired`; `404 hub.api.planNotFound`; `409 hub.api.planNotDiscarded`. |
| `POST /api/documents/decide` | key o panel | `{"path","decision":"ejecutar"\|"aparcar"\|"cerrar"}` | `200 {"ok":true}`. `400 hub.api.decisionFields`; `404 hub.api.planNotFound`; `409 hub.api.planBadState`, `hub.api.planBusy`, `hub.api.directorClosed`; `502 hub.api.directorUnreachable`. |
| `GET /api/chat/:channel` | key o panel | Query `before` (id) para páginas anteriores | `200` mensajes del canal. `404 hub.api.chatChannelUnknown`. |
| `POST /api/chat/:channel` | key o panel | `{"text"}` | `200 {"message","delivered"}` (`delivered` = jefes a los que llegó). `400 hub.api.chatFields`, `hub.api.chatTooLong`; `404 hub.api.chatChannelUnknown`. |

## Estático y WebSocket

| Método y ruta | Auth | Cuerpo | Respuestas y claves de error |
| --- | --- | --- | --- |
| `GET /live` | key o panel, en el primer mensaje | WebSocket. Tras abrir, en menos de 1 s el cliente envía `{"type":"auth","token":"<key o token de panel>"}`; después `{"type":"heartbeat","visible":true\|false}` | Exige `Host` y `Origin` del propio hub (en desarrollo, también el de Vite). `403 forbidden` si no; `426 upgrade required` si la petición no es un WebSocket. Sin auth a tiempo o con credencial mala, cierra con código `4401`. Tras autenticar envía `{"type":"snapshot","data":…}` y después los mensajes de la oficina (`agent`, `question`, `activity`, `documents`, `usage`, `orders`, `checks`, `finished`, `layouts`…). Mensajes de más de 16 KB cierran la conexión. |
| `GET *` | ninguna | | `/` y `/index.html` sirven la interfaz (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`; sin compilar, una página que pide `bun run build`). `/assets/characters/custom/index.json` lista los `.glb` de `custom/`. Cualquier otra ruta sirve el fichero de `hub/public`; `404 not found` si no existe o sale de la carpeta; `400 bad request` con una codificación inválida. |
