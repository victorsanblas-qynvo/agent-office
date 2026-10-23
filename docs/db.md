# Base de datos

**schema v5** (`SCHEMA_VERSION` en `hub/src/db.ts`). Un fichero SQLite, `office.db`, en `~/.config/agent-office/` (o en `AGENT_OFFICE_HOME`), con permisos 600. `hub/test/docs.test.ts` falla si una tabla de la base no tiene aquí su sección `## <tabla>` o si este número no es el de `SCHEMA_VERSION`.

Todas las fechas (`ts`, `*_at`) son milisegundos desde la época. Los campos `TEXT` marcados como JSON guardan texto JSON.

## PRAGMAs

| PRAGMA | Valor | Dónde |
| --- | --- | --- |
| `journal_mode` | `WAL` | `openDb`, solo si el fichero no es `:memory:` |
| `synchronous` | `NORMAL` | ídem: un corte de luz puede perder las últimas transacciones, pero WAL mantiene la base consistente |
| `busy_timeout` | `2000` | `openDb`, siempre |
| `user_version` | versión del esquema | `migrate`, dentro de la transacción de cada migración |

El fichero se deja en modo 600 en cada apertura.

## Migraciones aditivas

`openDb` ejecuta `migrate`, que hace tres cosas:

1. Con `user_version < ADDITIVE_SINCE` (2, es decir, una base de la v1), borra las tablas de la v1 (`V1_TABLES`) y crea `SCHEMA` entera. Es la única vez que el hub descarta datos.
2. Con `user_version >= ADDITIVE_SINCE`, ejecuta `SCHEMA` (todo es `CREATE TABLE/INDEX IF NOT EXISTS`) y no toca nada existente.
3. Aplica en orden las `MIGRATIONS` con versión mayor que la de la base, cada una en su transacción y fijando `user_version` al terminar.

**Regla: desde la versión `ADDITIVE_SINCE` las migraciones solo añaden tablas, columnas o índices.** `checkAdditive` rechaza (lanza un error antes de ejecutar nada) cualquier migración posterior cuyas sentencias casen `DROP`, `DELETE`, `TRUNCATE`, `REPLACE`, `UPDATE` o `ALTER TABLE … DROP|RENAME`. Por eso los datos de una versión anterior sobreviven a cualquier actualización, y por eso los cambios de formato se resuelven al leer (por ejemplo, los informes antiguos recalculan su resumen en el panel) y no reescribiendo filas.

**Cómo añadir una versión:**

1. Añade al final de `MIGRATIONS` un `{ version: N + 1, statements: [...] }` con `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` y `ALTER TABLE … ADD COLUMN` (una columna nueva en `NOT NULL` necesita `DEFAULT`).
2. Sube `SCHEMA_VERSION` a `N + 1`. Una base nueva ejecuta `SCHEMA` y después todas las migraciones, así que no repitas las tablas nuevas en `SCHEMA`.
3. Si la tabla guarda datos por planta, añádela a `FLOOR_TABLES` (o `ORDER_TABLES` si cuelga de un encargo) en `hub/src/floor-data.ts`, para que borrar una planta se la lleve; y, si su historial debe caducar, a `RULES` en `hub/src/prune.ts`.
4. Actualiza este documento (cambia `schema v5` y añade la sección) y, si procede, `hub/test/db.test.ts`.

La búsqueda de texto (`search_fts`) queda fuera de las migraciones a propósito: se crea al arrancar, y un Bun sin FTS5 sigue abriendo la base.

## Retención

El hub llama a `pruneInChunks` al arrancar y cada 24 horas, con `retentionDays` de `config.json` (14 por defecto). Borra por tandas de 5 000 filas cediendo el turno al bucle de eventos, para no frenar a los hooks que esperan. Solo las tablas de la lista siguiente caducan; el resto se conserva. Borrar una planta (`purgeFloorData`) elimina además todas las filas de esa planta en una transacción. «Poda» abajo es esa retención.

## events

Cada evento de hook que llega a `/hook` o `/events`: una fila por llamada a herramienta, turno, inicio de sesión…

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | autoincremental |
| `ts` | INTEGER | |
| `session_id` | TEXT | sesión de Claude Code |
| `agent_key` | TEXT | agente (la sesión principal usa su `session_id`) |
| `floor` | TEXT | slug de la planta |
| `event` | TEXT | nombre del hook (`PreToolUse`…) |
| `tool`, `state`, `path` | TEXT | herramienta, estado resultante y ruta, si hay |
| `payload` | TEXT | contenido del evento; no se guarda en plantas observadas ni en sesiones ajenas a la oficina |

Escribe: `Office.ingest` (`office-sql.ts`). Poda: `ts` anterior al corte. Índices: `events_ts`, `events_agent`, `events_floor`.

## sessions

| Columna | Tipo | Notas |
| --- | --- | --- |
| `session_id` | TEXT PK | |
| `cwd`, `floor`, `role`, `name` | TEXT | carpeta, planta, rol `office-*` y nombre del agente |
| `socket`, `token`, `team` | TEXT | socket y token de mensajería (para el inbox) y equipo |
| `started_at`, `updated_at`, `ended_at` | INTEGER | |
| `rules_hash`, `launch_hash` | TEXT | huellas de las reglas y del lanzador al arrancar (v4): detectan reglas nuevas y «Relanzar» |
| `task_open_since` | INTEGER | desde cuándo tiene un encargo abierto (v4), para el aviso de parado |
| `plan_slug` | TEXT | v4: reservada; hoy ningún código la escribe |

Escribe: `office-sql.ts` (alta al primer evento, `updateHashes`, `updateTaskOpen`, `endSession`). Poda: `COALESCE(ended_at, updated_at)` anterior al corte.

## agents

| Columna | Tipo | Notas |
| --- | --- | --- |
| `agent_key` | TEXT PK | |
| `session_id` | TEXT | |
| `parent_key` | TEXT | agente que lo lanzó |
| `name`, `role`, `floor`, `team` | TEXT | |
| `started_at`, `updated_at`, `ended_at` | INTEGER | |

Escribe: `office-sql.ts`. Poda: `COALESCE(ended_at, updated_at)` anterior al corte.

## floors

| Columna | Tipo | Notas |
| --- | --- | --- |
| `slug` | TEXT PK | |
| `path` | TEXT UNIQUE | carpeta raíz del repositorio |
| `stack` | TEXT | stack detectado (`flutter`, `node`, `laravel`, genérico) |

Escribe: el registro de plantas observadas (`dbRegistry`, `INSERT OR IGNORE` con el primer evento de un repositorio nuevo). Las gestionadas viven en `config.json`. No caduca; se borra con la planta.

## tasks

| Columna | Tipo | Notas |
| --- | --- | --- |
| `scope` | TEXT PK | equipo o `session-<8 caracteres>` |
| `task_id` | TEXT PK | |
| `subject`, `owner`, `status` | TEXT | |
| `updated_at` | INTEGER | |

Escribe: `office-sql.ts` con `TaskCreated`/`TaskCompleted`. Poda: `updated_at` anterior al corte. Sin columna de planta: al borrar una planta se localiza por el `scope` de sus sesiones y agentes.

## edits

Una fila por fichero que edita un agente: la base de la puerta de tests.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `ts`, `agent_key`, `floor`, `path` | | |

Escribe: `office-sql.ts`. Poda: `ts` anterior al corte. Índices: `edits_agent`, `edits_floor`.

## verdicts

Resultados de tests (`kind = 'tests'`) y veredictos de revisión de documentos.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `ts`, `agent_key`, `role`, `floor` | | |
| `kind` | TEXT | `tests`, `approved`, `improve` o `no-agreement` |
| `ok` | INTEGER | 1 si pasó o se aprobó |
| `command` | TEXT | comando de test (solo `tests`) |
| `path`, `round`, `score` | | documento revisado, ronda y nota (solo veredictos) |

Escribe: `Office` al ver un resultado de tests y `protocol-desk.ts` al llegar un veredicto. Poda: solo `kind = 'tests'` con `ts` anterior al corte; los veredictos de documentos se conservan. Índices: `verdicts_floor`, `verdicts_path`, `verdicts_agent`.

## messages

Mensajes entre agentes (`SendMessage`).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `ts`, `floor` | | |
| `from_key`, `to_name`, `to_key` | TEXT | remitente, nombre del destinatario y su clave si se resuelve |
| `text` | TEXT | el mensaje; no se guarda en plantas observadas ni en sesiones ajenas a la oficina |

Escribe: `office-sql.ts`. Poda: `ts` anterior al corte. Índices: `messages_from`, `messages_to`.

## questions

Preguntas (`AskUserQuestion`) y permisos que esperan en el panel.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | TEXT PK | |
| `session_id`, `agent_key`, `floor` | | |
| `payload` | TEXT | JSON de la pregunta o del permiso |
| `status` | TEXT | `pending`, `answered`, `released` o `expired` |
| `created_at`, `resolved_at` | INTEGER | |

Escribe: `office-sql.ts` (`INSERT OR REPLACE` al abrirla, `UPDATE` al cerrarla; al arrancar, las que quedaron `pending` pasan a `released`). Poda: `created_at` anterior al corte y `status != 'pending'`.

## gate_decisions

Cada decisión de las puertas (`HECHO:`, `TaskCompleted`, tope de encargos del director).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `ts` | INTEGER | |
| `scope`, `task_id` | TEXT | equipo, o `encargo:<sesión>` en las decisiones del tope de encargos del director (que cuenta aquí los que lleva enviados) |
| `decision`, `reason` | TEXT | `pass` o `block` y el motivo |

Escribe: `gate-desk.ts` / `office-sql.ts`. Poda: `ts` anterior al corte. Sin planta: se localiza por `scope`.

## lessons

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `floor`, `role` | TEXT | el puesto (planta y rol) que hereda la lección |
| `text`, `norm` | TEXT | texto y forma normalizada |
| `origin` | TEXT | `agent` o `user` |
| `agent_key` | TEXT | autor, si es de un agente |
| `created_at` | INTEGER | |

`UNIQUE (floor, role, norm)` evita duplicados. Escribe: `memory.ts` (`LECCIÓN:` de un agente o la añadida desde el panel). Poda: no caduca con el tiempo; al guardar una, `pruneLessons` borra las más antiguas de origen `agent` de ese puesto por encima de `memory.maxLessons`, y las de origen `user` nunca. Se borra con `DELETE /api/memory/:id` o con la planta. Índice: `lessons_agent`.

## reports

Informe de cada agente.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `agent_key` | TEXT PK | |
| `floor`, `role_id`, `name` | TEXT | `role_id` nulo en sesiones ajenas a la oficina |
| `started_at`, `ended_at`, `updated_at` | INTEGER | |
| `summary` | TEXT | resumen en español (el panel recalcula la forma traducible) |
| `data` | TEXT | JSON del informe completo |

Escribe: `reports.ts` (upsert cuando un agente de la oficina termina: `SubagentStop`, `Stop` o `SessionEnd`; no se guardan en plantas observadas ni sesiones ajenas). Poda: al guardar uno con rol, se conservan los 50 más recientes de ese puesto (`MAX_REPORTS_PER_ROLE`); por retención, solo los de `role_id` nulo con `updated_at` anterior al corte. Índice: `reports_role`.

## documents

Planes y skills que ve el panel.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `path` | TEXT PK | relativa a `office-docs` (`redaccion/planes/x.md`, `taller/skills/x`) |
| `kind` | TEXT | `plan` o `skill` |
| `slug` | TEXT | |
| `round` | INTEGER | última ronda de revisión (por defecto 0) |
| `requested_at`, `closed_at`, `discarded_at`, `updated_at` | INTEGER | |
| `delivered_at` | INTEGER | v3: cuándo se entregó al usuario |
| `decision`, `decided_at` | TEXT, INTEGER | v3: `ejecutar`, `aparcar` o `cerrar` y cuándo |
| `delivered_base` | TEXT | v3: rama base y commit con que se entregó |

Escribe: `documents.ts` (descubrimiento por `INSERT OR IGNORE` y `UPDATE` en cada paso del ciclo). No caduca, y no tiene planta, así que tampoco se borra con ella; sus filas siguen a los ficheros del repositorio de documentos.

## floor_sync

Último commit de la rama base que vio Redacción de cada planta.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `floor`, `ref` | TEXT PK | planta y rama |
| `last_sha` | TEXT | |
| `updated_at` | INTEGER | |

Escribe: `sync.ts` (upsert en cada sincronización). Se borra al limpiar las fuentes de la planta (`sync.ts`) y con la planta. No caduca.

## sync_worktrees

Las «fotos» de las plantas (worktrees desacoplados en `redaccion/.fuentes/`).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `slug`, `floor` | TEXT PK | plan y planta |
| `repo`, `path`, `ref`, `sha` | TEXT | repositorio, carpeta, rama y commit |
| `date` | TEXT | fecha del commit |
| `stale` | INTEGER | 1 si la rama base avanzó |
| `ahead_commits`, `ahead_files` | | cuánto avanzó (`ahead_files` es JSON) |
| `created_at` | INTEGER | |

Escribe: `sync.ts`. Se borra cuando se retira la foto (al entregar el plan, al caducar o al borrar la planta). No sigue la retención.

## alerts

Alertas de la guardia (`alerta`, `posible`) y avisos de fin de encargo o plan (`fin`).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `ts`, `floor`, `agent_key` | | |
| `level` | TEXT | `alerta`, `posible` o `fin` |
| `files` | TEXT | JSON con los ficheros (`[]` en `fin`) |
| `ref` | TEXT | v5: encargo o plan al que se refiere un `fin` |
| `cycle` | INTEGER | v5: ciclo del encargo |
| `seen_at` | INTEGER | v5: cuándo cerraste el popup |
| `detail` | TEXT | v5: JSON del aviso de fin (título, rama, resumen, comprobaciones) |

`UNIQUE (level, ref, cycle)` (índice `alerts_cycle`) garantiza un aviso de fin por encargo y ciclo. Escribe: `guard-desk.ts` (`alerta`/`posible`) y `board-desk.ts` (`fin`, con `INSERT OR IGNORE`). Poda: `ts` anterior al corte (un `fin` sin cerrar más viejo que la retención también cae). Índice: `alerts_ts`.

## chat_messages

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `ts`, `channel`, `floor` | | canal (`global` o el slug) |
| `author_key`, `author_name`, `role` | TEXT | |
| `origin` | TEXT | `agent` o `user` |
| `kind` | TEXT | `texto`, `toca`, `listo` o `pregunta` |
| `text` | TEXT | |
| `files` | TEXT | JSON con las rutas de `toca` y `listo` |

Escribe: `chat.ts` (`POST /chat`, `POST /api/chat/:channel`). Poda: `ts` anterior al corte. Índices: `chat_channel`, `chat_floor`.

## token_usage

Consumo de tokens por día (v4).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `day` | TEXT PK | día local |
| `agent_key` | TEXT PK | |
| `model` | TEXT PK | modelo (`''` si no se conoce) |
| `plan_slug` | TEXT PK | plan al que se imputa (`''` si ninguno) |
| `session_id`, `floor`, `role_id`, `name` | | |
| `turns`, `input`, `cache_read`, `cache_create`, `output` | INTEGER | turnos y tokens acumulados del día |
| `updated_at` | INTEGER | |

Escribe: `tokens.ts` al leer las transcripciones. Poda: `updated_at` anterior al corte. Índices: `token_usage_agent`, `token_usage_plan`.

## token_cursor

Hasta dónde se ha leído la transcripción de cada agente (v4).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `agent_key` | TEXT PK | |
| `session_id`, `floor` | | |
| `transcript` | TEXT | ruta del fichero de transcripción |
| `byte_offset` | INTEGER | por dónde va la lectura |
| `last_msg_id`, `last_out` | | último mensaje contado y sus tokens de salida |
| `skipped_lines` | INTEGER | líneas que no se pudieron interpretar |
| `updated_at` | INTEGER | |
| `last_context` | INTEGER | v5: tokens de contexto del último turno |
| `compactions` | INTEGER | v5: compactaciones contadas |

Escribe: `tokens.ts`. Poda: `updated_at` anterior al corte.

## orders

Las tarjetas del Tablero (v5).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `slug` | TEXT UNIQUE | también el de la rama `encargo/<slug>` |
| `floor`, `title`, `description` | | |
| `status` | TEXT | `pendiente`, `en-curso`, `revision` o `hecho` |
| `source` | TEXT | `director`, `plan`, `panel-lead` o `panel-director` |
| `plan_slug`, `parent_id` | | plan y encargo padre (fases de un `PARTIR`, o el encargo del que se bifurcó) |
| `lead_session` | TEXT | sesión del jefe que lo lleva |
| `branch`, `base_ref`, `base_sha` | TEXT | rama del encargo, rama base y el commit del que sale la carpeta (la punta de la base o, en una bifurcación, el punto de control, que se escribe antes de crearla) |
| `base_stale` | INTEGER | 1 si no se pudo hacer `fetch` |
| `worktree_path`, `worktree_state`, `setup_error` | TEXT | carpeta, estado (`creando`, `preparando`, `listo`, `error`, `retirado`) y error de preparación |
| `review_state` | TEXT | `none` por defecto; reservado a la revisión automática, que no está hecha |
| `cycle` | INTEGER | ciclo de entrega (sube al reabrir desde Hecho) |
| `skipped_files` | TEXT | JSON con los ficheros que los puntos de control dejaron fuera |
| `checks_forced_sha` | TEXT | `HEAD` para el que confirmaste un cambio de cómo se comprueba |
| `pr_url`, `pr_state`, `merged_at` | | reservados a la PR y la fusión desde el panel, que no están hechas: hoy nadie los escribe |
| `kept_at` | INTEGER | cuándo conservaste una carpeta de un encargo hecho sin fusionar |
| `created_at`, `updated_at`, `last_activity` | INTEGER | |
| `removed_at` | INTEGER | borrado lógico: el encargo deja de listarse |

Escribe: `order-store.ts` (todas las altas y cambios pasan por `OrderStore`). No caduca; se borra con la planta. Índices: `orders_floor_status`, `orders_plan`.

## check_runs

Una ejecución de las comprobaciones de un encargo (v5).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `order_id` | INTEGER | |
| `floor`, `slug` | TEXT | |
| `sha` | TEXT | commit comprobado (`HEAD-dirty` si el commit falló) |
| `trigger` | TEXT | `listo`, `comprobar`, `panel` o `hecho` |
| `status` | TEXT | `running`, `passed`, `failed`, `timeout` o `cancelled` |
| `started_at`, `ended_at` | INTEGER | |

Escribe: `checks.ts`; al arrancar, las que quedaron `running` pasan a `cancelled`. Las filas no caducan (se borran con la planta); lo que sí caduca es la salida de sus `checks`. Índice: `check_runs_order`.

## checks

Cada comando de una ejecución (v5).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `run_id` | INTEGER | |
| `floor`, `slug` | TEXT | |
| `name`, `command` | TEXT | |
| `status` | TEXT | `pending`, `running`, `passed`, `failed`, `timeout` o `cancelled` |
| `exit_code`, `duration_ms` | INTEGER | |
| `output_tail` | TEXT | final de la salida (hasta `checksConfig.tailBytes`) |

Escribe: `checks.ts`. Poda: la fila se conserva; pasado el corte (`retentionDays`) `output_tail` se pone a `NULL` en las ejecuciones más viejas. Se borra con la planta. Índice: `checks_run`.

## checkpoints

Commits que hace el hub en la rama de un encargo (v5).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `order_id` | INTEGER | |
| `sha` | TEXT | |
| `reason`, `label` | TEXT | por qué se hizo (`listo`, `comprobar`…) y el mensaje `encargo(<slug>): …` |
| `created_at` | INTEGER | |

Escribe: `checkpoints.ts`. No caduca; se borra con la planta. Índice: `checkpoints_order`. Restaurar un punto (`checkpoint-restore.ts`) solo añade el punto de lo que no estuviera guardado; el `HEAD` anterior queda en la referencia `refs/office/<slug>/before-reset-<ts>` del repositorio de la planta.

## order_comments

Comentarios de revisión del usuario sobre el diff de un encargo (v5).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id`, `order_id` | INTEGER | |
| `path`, `line`, `side` | | fichero, línea (`0`: el fichero entero) y lado del diff (`new` u `old`) |
| `text` | TEXT | JSON `{"body","cycle","sha"}`: el comentario, y el ciclo y el `head` del encargo cuando se escribió |
| `created_at`, `sent_at` | INTEGER | cuándo se escribió y cuándo se mandó al jefe (`NULL` si no lo recibió) |

Escribe: `review-desk.ts`. No caduca; se borra con la planta. Índice: `order_comments_order`.

## review_findings

Reservada (v5) para la revisión automática, que no está hecha: ningún código la escribe todavía.

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id`, `order_id` | INTEGER | |
| `sha`, `reviewer_key` | TEXT | commit revisado y revisor |
| `n` | INTEGER | número de hallazgo |
| `critical`, `important` | INTEGER | gravedad |
| `text` | TEXT | |
| `created_at`, `dismissed_at` | INTEGER | |
| `dismiss_reason` | TEXT | |

Se borra con la planta. Índice: `review_findings_order`.

## usage_samples

Muestras de las ventanas del límite de uso para la predicción (v5).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `ts` | INTEGER PK | |
| `win` | TEXT PK | `five` (5 horas) o `seven` (semana) |
| `used_pct` | REAL | porcentaje gastado |
| `resets_at` | INTEGER | cuándo se reinicia la ventana |

Escribe: `usage.ts` (`INSERT OR REPLACE`, una por ventana y minuto o antes si el valor se mueve). Poda: siempre 8 días (`SAMPLE_RETENTION_MS`), sea cual sea `retentionDays`.

## activity_log

Cada línea de actividad del panel, guardada para el Historial y el índice de búsqueda (v5).

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `ts` | INTEGER | |
| `session_id`, `agent_key`, `floor` | TEXT | |
| `event`, `tool`, `state` | TEXT | |
| `summary` | TEXT | texto de la línea, ya en español |

Escribe: `SearchDesk.recordActivity` (`search.ts`) con cada línea de actividad. Poda: `ts` anterior al corte. Índices: `activity_log_ts`, `activity_log_agent`, `activity_log_floor`.

## search_fts

Índice de texto completo (SQLite FTS5) de la actividad, los mensajes y el chat. **Opcional**: no está en `SCHEMA` ni en `MIGRATIONS`. `SearchDesk.ensureIndex` la crea al arrancar si el SQLite de Bun trae FTS5; si no, o si falla, el hub busca por coincidencia simple (`LIKE`) y la base abre igual. Por eso no aparece en una base `:memory:` recién abierta.

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  body, kind UNINDEXED, ref UNINDEXED, ts UNINDEXED, floor UNINDEXED, agent UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
)
```

| Columna | Notas |
| --- | --- |
| `body` | texto indexado (sin tildes ni mayúsculas) |
| `kind` | `activity`, `message` o `chat` (el tipo `agent` del Historial se busca en `agents`, no aquí) |
| `ref` | id de la fila de origen |
| `ts`, `floor`, `agent` | para filtrar y ordenar |

Escribe: `SearchDesk`, a medida que llegan las líneas; al crearla por primera vez, `backfill` indexa lo que ya había. Poda: `ts` anterior al corte (tolera que la tabla no exista) y, al borrar una planta, todas sus filas. Las tablas sombra de FTS5 (`search_fts_data`, `_idx`, `_content`, `_docsize`, `_config`) las gestiona SQLite.
