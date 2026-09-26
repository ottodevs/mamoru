# Pack 001 · Mamoru v1

Pack de especificación de Mamoru v1, escrito con el ciclo de GitHub Spec Kit (constitución, spec, plan y tareas) y parado antes de implementar. Los escenarios son la capa de verificación que Spec Kit no trae.

- Ley: `inputs/mamoru-spec-v1.md`, cerrada el 2026-09-26. Este pack no la reabre.
- Constitución: `.specify/memory/constitution.md` v1.0.0.
- Fecha del pack: 2026-09-26.

## Estado

El pack vive en la copia de trabajo y no está en ningún commit. La spec cerrada dice que no se genera un armazón de Spec Kit en el repo público. Publicar este pack, o no, es decisión de Ot al revisarlo.

En este pase no se creó código de aplicación ni se tocaron dependencias.

## Qué se especifica

El producto de v1 es el dashboard de producción en Base: una vista de la smart account del usuario que dice cuánto vale lo que tiene, qué pide una decisión suya, qué va a hacer Mamoru y por qué, y qué pasa en sus posiciones y en los pools de su plan. Es también la entrega al track Best Digital Asset Dashboard de Curvegrid. En v1, producción corre en dry-run como modo de seguridad hasta T-000025. El fork de Base es el plano de verificación: prueba el ciclo completo con el mismo código, pero no es el producto.

## Orden de lectura

| Orden | Archivo | Qué contiene |
|---|---|---|
| 1 | `.specify/memory/constitution.md` | Principios comprobables, pruebas que tumban el plan, las tres líneas abiertas y el gobierno |
| 2 | `specs/001-mamoru-v1/spec.md` | Historias priorizadas con Dado, Cuando y Entonces, requisitos FR, entidades, catálogo de códigos de razón, casos límite y criterios de éxito. US8 es el dashboard de producción y FR-PRZ el mapa del premio |
| 3 | `specs/001-mamoru-v1/plan.md` | Módulos, puertos, registro de Base verificado, máquina de estados, diario del Durable Object, política de sesión, secuencias, persistencia, fallos, Cloudflare, plano de verificación, mapa de archivos y, en §23, el plan de consultas del dashboard |
| 4 | `specs/001-mamoru-v1/dashboard.md` | El dashboard de producción: vistas, procedencia con chain, modelo de lectura sobre MultiBaas y la RPC, Actions, payload, mapa del premio y README del premio |
| 5 | `specs/001-mamoru-v1/scenarios.md` | Catálogo de escenarios con bloque de fork obligatorio: ciclo M01 a M14, abuso de sesión, walkaway, diario, reintentos, puertas, aislamiento, webhook, dashboard, plano de verificación y pruebas en Base de solo lectura, más la matriz de trazabilidad |
| 6 | `specs/001-mamoru-v1/threats.md` | Pruebas que tumban el plan, amenazas THR-01 a THR-20, riesgos residuales y respuesta a incidentes |
| 7 | `specs/001-mamoru-v1/tasks.md` | Tareas T001 a T019 para una sesión posterior, con su orden de trabajo, y cada una con requisitos, archivos, escenarios que la aceptan y lo que no debe hacer |

## Dónde está cada cosa del dashboard

| Pregunta | Dónde |
|---|---|
| Qué punto del brief responde cada vista | `dashboard.md` §1 |
| Orden de las vistas en `/dashboard` | `dashboard.md` §3 y FR-DSH-002 |
| Chips de procedencia con chain | `dashboard.md` §5 y FR-DSH-011 |
| Contratos que Ot enlaza en MultiBaas | `dashboard.md` §6.2 |
| Catálogo de event queries MBQ-01 a MBQ-08 | `dashboard.md` §6.4 y FR-MB-002 |
| Contraste con la RPC | `dashboard.md` §6.5 y FR-PRJ-010 a FR-PRJ-014 |
| Elección de fuente y salud del índice | `dashboard.md` §6.6 y FR-MB-007 |
| Cada vista: pregunta, campos, queries, comprobación RPC, vacío, error y acción | `dashboard.md` §7 |
| Actions frente a Current Action | `dashboard.md` §7.2 y §7.3, FR-DSH-012 y FR-DSH-013 |
| Treasury y camino de conversión | `dashboard.md` §7.5 y FR-DSH-015 |
| Analítica de pools y posiciones | `dashboard.md` §7.6, FR-DSH-016 y FR-DSH-017 |
| Payload de la API | `dashboard.md` §9 |
| Producción frente al plano de verificación | `dashboard.md` §10 |
| Mapa del premio de Curvegrid | `dashboard.md` §11 y FR-PRZ-001 a FR-PRZ-005 |
| README del premio: cinco apartados, afirmaciones y fallo de MultiBaas | `dashboard.md` §12 y FR-PRZ-004 |
| Quién llama a MultiBaas, payloads, cadencia, D1 y fallo sin Base | `plan.md` §23 |
| Tablas del modelo de lectura | `plan.md` §15 |
| Secuencia de `ReadModelSync` | `plan.md` §13.5 |
| Escenarios del dashboard | `scenarios.md` §14: DASH-09 a DASH-19 y UI-06 a UI-08 |
| Pruebas en Base de solo lectura | `scenarios.md` §16: MB-01 a MB-04, BASE-01 y BASE-02 |
| Fugas nuevas del modelo de lectura | `threats.md` THR-20 y R-10 |
| Tareas del dashboard | `tasks.md` T017, T018, T012, T019 y T016 |

## Convenciones

- La prosa va en español. Los ids de requisito, los tipos, los códigos de razón y las rutas van en inglés.
- La copia de la interfaz va en inglés, como el README público.
- Familias de ids:

| Familia | Qué es | Dónde se define |
|---|---|---|
| `FR-ONB`, `FR-VIEW`, `FR-ACC`, `FR-ENG`, `FR-DEC`, `FR-UNI`, `FR-RPC`, `FR-AA`, `FR-MB`, `FR-PRJ`, `FR-DSH`, `FR-PRZ`, `FR-LAB`, `FR-OPS` | Requisitos funcionales | `spec.md` |
| `SC-001` a `SC-022` | Criterios de éxito | `spec.md` |
| `ReasonCode` | Códigos de razón | `spec.md` |
| `MBQ-01` a `MBQ-08` | Event queries del dashboard | `dashboard.md` §6.4 |
| `M01` a `M14` | Escenarios de ciclo | `scenarios.md` |
| `SESS`, `WALK`, `JRNL`, `RETRY`, `GATE`, `EXIT`, `PAUSE`, `DEP`, `ONB`, `TEN`, `HOOK`, `REORG`, `DASH`, `UI`, `LAB`, `DRY`, `CYCLE`, `MB`, `BASE`, `OPS`, `DOC` | Escenarios | `scenarios.md` |
| `INV-*` | Invariantes comunes de los escenarios | `scenarios.md` |
| `KT-1` a `KT-5` | Pruebas que tumban el plan | `threats.md` |
| `THR-01` a `THR-20`, `R-1` a `R-10` | Amenazas y riesgos residuales | `threats.md` |
| `T001` a `T019` | Tareas | `tasks.md` |

## Líneas abiertas

Solo quedan abiertas las tres que deja la constitución:

1. Better Auth es candidato del login de producto. T010 lo acepta o lo descarta detrás de `ProductAuthPort`.
2. Los pines de versión se congelan en el primer commit de implementación (T001).
3. Que MultiBaas indexe Base es una comprobación de aceptación: MB-01 a MB-04, en T006. Si no lo hace, el dashboard sale de logs RPC rotulados (BASE-02) y el README lo cuenta.

## Decisiones que toma este pack

Todas caben dentro de la ley. La lista completa está en `spec.md`, sección "Decisiones tomadas en este pack". Las que más pesan:

- **Interfaz.** En inglés.
- **Producto y entrega.** El dashboard de producción en Base es el producto de v1 y la entrega al premio de Curvegrid. El dry-run es un modo de seguridad. El fork es el plano de verificación.
- **Modelo de lectura.** Solo el Workflow `ReadModelSync` del motor llama a MultiBaas. Cada fila se contrasta con la RPC antes de guardarse en D1, y la API sirve el dashboard solo desde D1. Sin MultiBaas, las vistas salen de logs RPC con su causa.
- **Actions.** Se deriva en la API con una función pura y no se guarda. No hay intenciones nuevas: convertir sigue dentro del harvest y de la salida, en Uniswap V3.
- **Valor.** En USDC y como estimación, con `slot0` de los pools de precio del registro. WETH/USDC 0.3% es fuente de precio y nunca se ejecuta en producción.
- **Chains.** v1 enseña Base y nada más. Cada cifra lleva su chain id.
- **Bloque del catálogo.** El 51811000 de Base, con hash `0xb7820875b174f7a8afb72d33464864e6cdfbe0c2173446cc8c4a5649923423ff`. Se verificó que todos los contratos del registro tienen código en ese bloque. El fork usa chain id 31337.
- **Buckets.** En v1, `stables` y `risk` no tienen pool V3 ejecutable verificado en Base y se registran con `PLAN_BUCKET_NO_EXECUTABLE_POOL`. Solo `btc-usdc` opera, con USDC/cbBTC 0.05%.
- **Sesión.** Tres grants: `enter-swap`, `enter-mint` y `manage`. Una posición se gestiona solo si está en `allowedTokenIds`, y esa lista solo crece en el `mintAndNote` de la misma transacción.
- **Cuenta.** Sin SDK de cuenta: la codificación se hace con viem y ABIs del registro. Sin SDK de MultiBaas: un cliente `fetch` propio.
- **Ahorro y gas.** USDC es el activo de ahorro. El ETH es solo reserva de gas. No hay paymaster.
- **Fuera de alcance.** Votos de DAO, calendarios de vesting y analítica de propiedad de RWA.

## Cómo comprobar el pack

- [ ] Existen `specs/001-mamoru-v1/` y `.specify/memory/constitution.md`.
- [ ] `tasks.md` no ordena implementar en esta sesión.
- [ ] `git status` no enseña `src/`, `package.json` ni `wrangler.toml` creados por este pase. Solo aparecen `.specify/` y `specs/` como nuevos, junto a lo que ya estaba sin seguimiento.
- [ ] Ningún archivo del pack contiene URL de RPC, claves ni secretos.
- [ ] Ningún archivo del pack deja nada pendiente fuera de las tres líneas abiertas.
- [ ] Cada requisito aparece en la matriz de trazabilidad de `scenarios.md`.
- [ ] Cada tarea cita requisitos, archivos, escenarios que la aceptan y lo que no debe hacer.
- [ ] El orden de trabajo de `tasks.md` respeta todas las dependencias, y las tareas del dashboard van después del diario y de las pruebas de la cuenta.
- [ ] Cada vista de `dashboard.md` §7 dice su pregunta, sus campos, sus event queries, su comprobación RPC, sus estados vacío y de error, y la acción del usuario.
- [ ] Ningún escenario afirma un umbral del Packaging.
- [ ] Ninguna tarea despliega, sube versiones, abre la puerta de fondos ni desactiva el dry-run.
- [ ] El `README.md` público no se toca en este pase. Lo reescribe T016.
