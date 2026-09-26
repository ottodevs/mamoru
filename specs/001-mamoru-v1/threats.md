# Amenazas 001 · Mamoru v1

- Spec: `specs/001-mamoru-v1/spec.md`
- Plan: `specs/001-mamoru-v1/plan.md`
- Escenarios: `specs/001-mamoru-v1/scenarios.md`
- Fecha: 2026-09-26

Este documento recoge dos cosas. Primero, las pruebas de la constitución que tumban el plan. Después, las amenazas contra el capital, la vista y el método, con sus controles y el riesgo que queda.

## 1. Alcance y supuestos

**Qué se protege.** Los fondos de la smart account, la integridad del ciclo de una operación, la privacidad de la vista de cada usuario y la verdad de lo que enseña la pantalla.

**Estado de v1.** Producción no firma: el dry-run y la puerta de fondos están cerrados. En v1, las amenazas que dependen de una sesión activa solo existen en el laboratorio y en el diseño que abrirá T-000025. Aun así se prueban ahora, porque son las que tumban el plan.

**Supuestos de confianza.**

- Los contratos del registro se comportan como están desplegados en Base: EntryPoint v0.7, Safe 1.4.1, Safe7579, SmartSession, OwnableValidator, las piezas WebAuthn de Safe y Uniswap V3.
- El usuario protege su owner: la passkey y el respaldo.
- Cloudflare aísla los Workers, los Durable Objects y los secretos de otras cuentas.
- Ot y la cuenta de Cloudflare de Nexa Havenworks son de confianza dentro de los límites de la política de sesión, y nunca fuera de ellos.

**Fronteras.**

| Frontera | De un lado | Del otro |
|---|---|---|
| Navegador y API | SPA, passkey del usuario | `mamoru-app` |
| API y motor | `mamoru-app` | `mamoru-engine` por Service Binding |
| Motor y cadena | Durable Object y Workflows | RPC y bundler |
| Motor y MultiBaas | `ReadModelSync` en `mamoru-engine` | Estado de indexación, event queries y eventos de transacción del deployment |
| Webhook | MultiBaas | `/hooks/multibaas` |
| Laboratorio y producción | anvil, Alto y D1 local | Base, proveedores y D1 remota |

## 2. Activos

| Activo | Dónde vive | Quién puede moverlo |
|---|---|---|
| Tokens y posiciones de la cuenta | Chain | El owner sin límites. La sesión dentro de la política, siempre con destinatario la cuenta |
| Owners y módulos | Chain | Solo el owner |
| Session key | Durable Object, cifrada | Solo `sign` dentro del Durable Object |
| `SESSION_KEK` | Secreto del Worker del motor | Cloudflare y Ot |
| Diario de operaciones | SQLite del Durable Object | Solo el Durable Object |
| Proyección y grants | D1 | App y motor |
| Claves de RPC, bundler y MultiBaas | Secretos de Workers | Cloudflare y Ot |
| Secreto del webhook | Secreto de la app | Cloudflare y Ot |
| Sesión de producto | Cookie `HttpOnly` | El navegador del usuario |

## 3. Pruebas que tumban el plan

Estas son las cinco pruebas de la constitución. Si una falla, no se parchea para que pase. Se para y se sigue la consecuencia de la tabla.

| Prueba | Cómo se corre | Qué significa fallar | Consecuencia |
|---|---|---|---|
| KT-1. Prueba adversarial de la sesión | SESS-01 a SESS-25 en fork, con la session key tratada como filtrada | Un ataque de la lista mueve fondos fuera de la cuenta, amplía permisos, toca una posición fuera de alcance o actúa tras revocar o caducar. O el uso ajeno no se detecta | La cuenta y la codificación de sesiones no sirven como están. Se para la implementación del motor. Si la falla es de codificación, se parte el grant (FR-ACC-005). Si es del diseño de Smart Sessions, cambiar la cuenta exige enmendar la spec cerrada |
| KT-2. Walkaway con el owner | WALK-01 y WALK-02 en fork, con el motor, la app y el índice parados | El owner no puede revocar, cerrar o retirar sin Mamoru | T-000025 sigue cerrado. La cuenta se revisa con una enmienda de la spec cerrada |
| KT-3. SSR de verdad | Revisión de UI-01 a UI-08 y de las vistas del dashboard | Una función del panel no se puede servir como SPA con Static Assets | Se reabre el framework del panel con una enmienda de la spec cerrada |
| KT-4. Límites de Workers | Medición de CPU, subpeticiones y pasos en los escenarios de T004, T009, T014 y T017, con los pasos partidos | Un paso del motor no cabe en los límites de Workers ni partiéndolo | Se mide Containers para ese paso. Salir de Cloudflare exige que Containers tampoco alcance |
| KT-5. MultiBaas indexa Base | MB-01 contra el deployment de Base | `MB_BASE_INDEXING_ABSENT` o `MB_QUERY_MISMATCH` | MultiBaas sale del motor: sin webhooks y sin historia de MultiBaas. Las vistas salen de logs RPC rotulados (BASE-02). El intento de lectura queda documentado. El README del premio cuenta solo lo probado |

### 3.1 Clases de ataque de KT-1

| Clase | Qué intenta el atacante | Escenarios | Control que lo para |
|---|---|---|---|
| Desvío de destinatario | Swap, cobro o mint hacia otra dirección | SESS-01 a SESS-03 | Regla `recipient` igual a la cuenta |
| Salida directa | `transfer`, `transferFrom` y movimientos del NFT | SESS-04 | Default deny: el par (target, selector) no está en el grant |
| Importe | Pasar el tope por llamada o el acumulado | SESS-05, SESS-06 | Reglas LESS_THAN_OR_EQUAL con límite acumulado |
| Approvals | Approval infinito, a otro spender, `increaseAllowance`, Permit2 | SESS-07, SESS-08 | Spender EQUAL y tope. Selectores no concedidos |
| Alcance de posición | Tocar posiciones que la sesión no acuñó | SESS-09 | `allowedTokenIds`, escrito solo por `mintAndNote` |
| Contrabando en lote | Esconder una llamada prohibida entre llamadas válidas | SESS-10 | Validación por llamada: una falla y cae todo el lote |
| Revocación y repetición | Reusar un `permissionId` revocado. Repetir la activación | SESS-11 | Revocación en cadena, nonce del Safe y `revoked_permission_ids` |
| Firma por la cuenta | ERC-1271 y ERC-7739 con la session key | SESS-12 | Sin permisos ERC-7739 en los grants |
| Escalada | Owners, módulos, guard, fallback y autoampliación | SESS-13 a SESS-16 | Default deny y sin acción fallback |
| Tiempo y uso | Actuar tras caducar o tras agotar el límite | SESS-17, SESS-18 | Marco temporal y límite de uso |
| Otra chain | Repetir en otra chain | SESS-19 | Chain id dentro del hash de la userOp y del EIP-712 del Safe |
| Paymaster, valor, rutas y `delegatecall` | Paymaster, valor nativo, `multicall`, `exactInput`, `unwrapWETH9`, `sweepToken` y `delegatecall` | SESS-20 a SESS-23 | `permitERC4337Paymaster=false`, valor 0, selectores no concedidos y modo de ejecución |
| Uso ajeno válido | Operar dentro de la política sin que Mamoru lo sepa | SESS-24 | Detección `SESSION_FOREIGN_USE` y pausa |
| Paridad | Que el pre-chequeo acepte algo que la cadena rechaza, o al revés | SESS-25 | Mismas reglas en `packages/account/precheck` |

## 4. Amenazas

### THR-01 · Webhook falso

- **Vector.** Alguien que no es MultiBaas envía `event.emitted` a `/hooks/multibaas`. O repite entregas reales, o las altera.
- **Controles:**
  - HMAC sobre el cuerpo crudo con `MULTIBAAS_WEBHOOK_SECRET`;
  - ventana de antigüedad;
  - dedupe por (`blockHash`, `txHash`, `logIndex`);
  - mapeo solo a cuentas registradas.

  Además, un wake hint nunca es un GO: la revisión relee la chain (FR-MB-003, FR-ENG-011). El cuerpo del webhook no entra en `decide` ni en el Savings Log (FR-PRJ-007).
- **Detección.** `HOOK_BAD_SIGNATURE`, `HOOK_STALE`, `HOOK_DUPLICATE`, `HOOK_UNMAPPED` y `HOOK_REORGED` en `webhook_deliveries` y en la auditoría.
- **Escenarios.** HOOK-01 a HOOK-09 y TEN-04.
- **Riesgo residual.** Con el secreto robado, un atacante solo adelanta revisiones. Una avalancha se coalesce (`HOOK_COALESCED`) y cuesta cómputo, no fondos.

### THR-02 · Reorg

- **Vector.** Una inclusión, una observación o un evento desaparecen de la cadena canónica.
- **Controles:**
  - `confirmed` solo en un bloque `safe` con hash canónico (FR-ENG-008);
  - observación fijada por número y hash, con `sign` negado si el bloque ya no es canónico;
  - filas del Savings Log con estado `pending` hasta `safe`, y `reorged` si salen;
  - el proyector relee el hash de los eventos del webhook.
- **Detección.** `RECON_REORGED`, `EHG_OBSERVATION_REORGED`, `PROJ_REORGED` y `HOOK_REORGED`.
- **Escenarios.** REORG-01 a REORG-03, HOOK-05 y DASH-05.
- **Riesgo residual.** Una operación reorganizada puede tardar más en confirmarse. Como el nonce vuelve a estar libre, se reenvían los mismos bytes.

### THR-03 · Lecturas cruzadas entre usuarios

- **Vector.** Un usuario autenticado lee o actúa sobre la cuenta de otro. Para ello manipula el `accountKey`, presenta un grant ajeno o aprovecha un webhook que despierta a otra cuenta.
- **Controles:**
  - `ViewGrant` con prueba 1271 o 6492 de la propia cuenta (FR-VIEW-001);
  - middleware que cruza el `accountKey` con los grants del `userId`, y consultas que usan el `accountKey` del grant (FR-VIEW-003);
  - nombre del Durable Object solo desde cuentas registradas (FR-VIEW-005);
  - `chain_id` en todas las filas;
  - cookies `HttpOnly`, `Secure` y `SameSite`, más comprobación de `Origin` (FR-VIEW-006);
  - la ruta `history` filtra por el `account_key` del grant, y una referencia ajena devuelve una lista vacía (FR-DSH-020).
- **Detección.** `GRANT_REQUIRED`, `GRANT_INVALID_PROOF`, `GRANT_EXPIRED` y `AUTH_ORIGIN_REJECTED` en la auditoría.
- **Escenarios.** TEN-01 a TEN-08 y ONB-04.
- **Riesgo residual.** El estado en cadena de cualquier cuenta es público. La frontera de privacidad cubre solo lo que Mamoru añade: decisiones, intenciones, datos del login y la relación entre usuario y cuenta.

### THR-04 · Session key filtrada

- **Vector.** Un atacante obtiene la session key de una cuenta: por el Durable Object, por la clave de cifrado o por un fallo del motor.
- **Qué no puede hacer, porque la cadena lo impide (SESS-01 a SESS-23):**
  - sacar tokens o NFTs de la cuenta;
  - cambiar owners, módulos, guard o fallback;
  - ampliar sus permisos;
  - firmar por la cuenta;
  - usar paymaster o mover valor nativo;
  - tocar posiciones de otras cuentas, porque revierte;
  - tocar posiciones anteriores a la activación;
  - actuar tras caducar, tras agotar el límite o tras la revocación;
  - repetir en otra chain.
- **Qué sí puede hacer:**
  - **Sandwich.** Hacer swaps entre USDC y cbBTC dentro de los topes con `amountOutMinimum` de 1 wei, para exprimirlos con un sandwich. El techo de la pérdida son los topes por llamada y acumulados.
  - **Precio manipulado.** Acuñar, reducir o cerrar posiciones gestionadas con el precio manipulado. El valor vuelve a la cuenta, pero en la proporción que eligió el atacante. El techo lo marcan la economía de la profundidad del pool y los topes.
  - **Gas.** Gastar la reserva de ETH con operaciones que revierten en ejecución (SESS-09 a).
- **Controles:**
  - topes por llamada y acumulados fijados al activar;
  - caducidad y límite de uso;
  - un solo carril de nonce para Mamoru;
  - detección de uso ajeno;
  - revocación por el owner sin Mamoru (WALK-01, WALK-02).
- **Detección.** `SESSION_FOREIGN_USE`: una userOp con el validador de sesión de Mamoru que no está en el diario pausa la cuenta, y la vista enseña "Revoke Mamoru now". Si el atacante consume el nonce de una operación en vuelo, aparece `RECON_NONCE_CONSUMED_BY_OTHER`.
- **Escenarios.** SESS-01 a SESS-25, JRNL-06, WALK-01 y WALK-02.
- **Respuesta.** Sección 6, caso A.
- **Riesgo residual.** R-1, R-2 y R-3 de la sección 5.

### THR-05 · Saltarse el dry-run en producción

- **Vector.** Una configuración errónea, un despliegue con banderas cambiadas o un camino de código que firma en producción.
- **Controles:**
  - `CORE_DRY_RUN` solo admite `true` en producción (`CONFIG_DRY_RUN_REQUIRED`);
  - la lista de chains de firma está vacía (`CONFIG_MODE_INVALID` si no);
  - doble guarda en `AccountEngine.sign` y en `BundlerPort.send`;
  - puerta de fondos cerrada: ninguna cuenta de producción tiene sesiones activas, porque la activación está deshabilitada, así que ni una firma de sesión validaría en cadena;
  - ninguna tarea desactiva el dry-run (constitución, principio XVIII).
- **Detección.** Los códigos de configuración al arrancar. Cero llamadas al bundler en DRY-03.
- **Escenarios.** DRY-01 a DRY-03, M13, UI-01 y LAB-11.
- **Riesgo residual.** Ninguno de capital en v1: no hay sesión en Base y la cuenta es contrafactual.

### THR-06 · Firma del laboratorio válida en Base

- **Vector.** Una userOp o una transacción del owner firmada en el fork se reenvía a Base.
- **Controles:**
  - el fork usa 31337 o 31338, y el runner se niega a 8453 y 84532;
  - el chain id entra en el hash de la userOp y en el dominio EIP-712 del Safe;
  - `SIGN_CHAIN_NOT_ALLOWED` en el motor;
  - el bundler de laboratorio escucha en loopback y apunta a anvil.
- **Detección.** `LAB_CHAIN_ID_FORBIDDEN`, `SIGN_CHAIN_NOT_ALLOWED` y `LAB_BUNDLER_NOT_LOCAL`.
- **Escenarios.** SESS-19, LAB-01, LAB-07 y DRY-02.
- **Riesgo residual.** Las cuentas del laboratorio usan owners con claves públicas de desarrollo. La misma dirección contrafactual existe en Base, y cualquiera con esas claves la controlaría allí. Por eso:
  - la vista de laboratorio nunca enseña una dirección para depositar;
  - la banda dice "Not capital";
  - el kit de recuperación del laboratorio va rotulado como laboratorio;
  - una cuenta del laboratorio nunca se registra en producción (FR-LAB-013).

### THR-07 · Doble envío o reutilización de nonce

- **Vector.** Un timeout, una caída o dos instancias producen dos operaciones para una sola decisión, o dos nonces para una operación.
- **Controles:**
  - una operación no terminal por cuenta;
  - persistir antes de enviar;
  - mismos bytes en el reenvío;
  - reemplazo con el mismo nonce y las mismas llamadas;
  - instancia dueña;
  - `failed` solo con prueba (FR-ENG-003 a FR-ENG-010).
- **Detección.** `OP_OWNER_MISMATCH`, `OP_SLOT_BUSY` y los invariantes `INV-NONCE` e `INV-PERSIST-FIRST`.
- **Escenarios.** JRNL-01 a JRNL-09, RETRY-01 a RETRY-06 y M09.
- **Riesgo residual.** Ninguno conocido dentro del modelo. Una operación puede quedar mucho tiempo en `pending_reconciliation`, visible y sin abrir otro nonce.

### THR-08 · Manipulación de precio y sandwich

- **Vector.** Un tercero mueve el pool antes de la operación de Mamoru, o la envuelve con un sandwich.
- **Controles:**
  - Execution Health Gate con guarda de TWAP frente a spot (FR-UNI-009);
  - cotización fresca de QuoterV2 en el bloque de la operación;
  - `amountOutMinimum` mayor que cero, derivado de la cotización con tolerancia;
  - simulación con deltas;
  - premisa comprobada en la simulación.

  Una salida puede saltarse el NO GO de precio (FR-DEC-005): la pérdida por salir se acepta frente al riesgo de quedarse. La conversión posterior espera a que la puerta dé GO.
- **Detección.** `EHG_PRICE_DIVERGENCE`, `EHG_SIM_DELTA_MISMATCH`, `OP_DECISION_STALE` y `EXEC_INNER_REVERT`.
- **Escenarios.** M11, M14 (variante b), GATE-02 y JRNL-09.
- **Riesgo residual.** Un sandwich dentro de la tolerancia de la política, o una manipulación sostenida durante toda la ventana del TWAP.

### THR-09 · Filtración de la clave de MultiBaas

- **Vector.** La clave API de MultiBaas sale del motor.
- **Controles:**
  - la clave vive solo como secreto del motor, con el rol mínimo, y solo la usa `ReadModelSync` (FR-MB-006);
  - `mamoru-app` no tiene la clave, y el navegador no conoce ni el host del deployment (FR-DSH-019);
  - nunca va al navegador, a D1, a argv ni a artefactos;
  - la evidencia de MB-01 a MB-04 se guarda sin claves;
  - MultiBaas nunca es un GO ni la prueba de liquidación.
- **Detección.** Revisión de artefactos y logs (LAB-06, OPS-01). Captura de red y revisión del bundle (UI-08). Discrepancias entre MultiBaas y la RPC (`PROJ_INDEXER_MISMATCH`, `MB_QUERY_MISMATCH`).
- **Escenarios.** MB-01, MB-02, OPS-01, LAB-06, UI-08, HOOK-08 y DASH-04.
- **Respuesta.** Rotar la clave en MultiBaas y el secreto del Worker.
- **Riesgo residual.** Con la clave, un atacante puede leer datos del deployment. Si el rol lo permite, también cambiar su configuración y engañar a la vista hasta que la RPC lo contradiga. Por eso el rol es el mínimo.

### THR-10 · Filtración de las claves de RPC o del bundler, o proveedor comprometido

- **Vector.** Alguien usa las URL con clave, o el proveedor miente.
- **Controles:**
  - las URL con clave son secretos, nunca aparecen en argv (proxy de loopback) ni en artefactos;
  - las lecturas se fijan a un bloque con hash;
  - si una respuesta no cuadra, se falla cerrado (`OBS_BLOCK_INCONSISTENT`);
  - el recibo del bundler se contrasta con la RPC (FR-AA-004);
  - la política de sesión es el límite final;
  - el proveedor se cambia por configuración.
- **Detección.** Códigos de observación y discrepancias entre el recibo y los logs.
- **Escenarios.** LAB-06, RETRY-01, M03 y la prueba de contrato del puerto.
- **Riesgo residual.** Una clave robada consume la cuota. Una RPC que miente de forma coherente puede engañar a la decisión y a la simulación. En v1 producción no firma, así que solo engaña a la vista. Antes de firmar en Base, T-000025 tendrá que revisar este riesgo, fuera de este pack.

### THR-11 · Manipulación o desfase de D1

- **Vector.** Alguien cambia filas de D1, o D1 se queda atrás.
- **Controles:**
  - D1 es proyección, y `decide` no la lee (FR-PRJ-007);
  - el motor lee de D1 solo el registro de cuentas, que solo inicializa el Durable Object, y las incidencias del operador, que entran en la observación con procedencia `d1`;
  - el Durable Object guarda su propia política y el estado de sesiones;
  - una proyección vieja se rotula "Stale";
  - la auditoría es solo de añadir.
- **Detección.** Estado `stale` en la procedencia. Diferencias entre el diario y la proyección cuando el cursor se reprocesa.
- **Escenarios.** RETRY-05, UI-03 y DASH-08.
- **Riesgo residual.** Una incidencia falsa en D1 fuerza una salida (THR-17). Una incidencia borrada deja de proteger hasta que se detecta.

### THR-12 · Datos del laboratorio en producción

- **Vector.** Filas, enlaces o cuentas del fork aparecen en la vista de producción.
- **Controles:**
  - `chain_id` en todas las filas;
  - la API de producción filtra por 8453 (`PROJ_FOREIGN_CHAIN_ROW`);
  - la D1 del laboratorio es local;
  - no hay Basescan en el laboratorio;
  - las entregas sintéticas van rotuladas;
  - los puntos de fallo solo existen en modo `lab`.
- **Detección.** `PROJ_FOREIGN_CHAIN_ROW` y el invariante `INV-NO-BASESCAN-LAB`.
- **Escenarios.** TEN-06, UI-02 y LAB-11.
- **Riesgo residual.** Ninguno conocido.

### THR-13 · Toma del login de producto

- **Vector.** Un atacante toma la cuenta de Google, el email o la passkey de login del usuario.
- **Controles:**
  - el login no autoriza fondos (FR-ONB-001);
  - la vista exige un `ViewGrant` re-verificado;
  - `renew_session` exige una firma del owner;
  - las intenciones quedan auditadas y la vista las enseña.
- **Detección.** Auditoría de intenciones y cambios en el estado de la cuenta.
- **Escenarios.** ONB-06, TEN-01 a TEN-05.
- **Riesgo residual.** El atacante puede ver la cuenta y mandar `pause` o `exit`. Las dos intenciones son seguras para los fondos. Una salida inoportuna cuesta gas y comisiones no ganadas, y la conversión espera a que la Execution Health Gate dé GO.

### THR-14 · Frontend malicioso o cadena de suministro

- **Vector.** Una dependencia comprometida o una build alterada pide al usuario que firme con su passkey algo distinto de lo que enseña. Por ejemplo, añadir un owner.
- **Controles:**
  - versiones exactas y lockfile (FR-OPS-005, OPS-02);
  - dependencias mínimas;
  - los flujos del owner enseñan la acción decodificada desde el mismo objeto que se codifica (ONB-05);
  - no hay SDK de cuenta;
  - ninguna ruta de la API firma (ONB-06);
  - el walkaway se puede hacer con herramientas independientes de Mamoru (`docs/walkaway.md`).
- **Detección.** Auditoría de dependencias (OPS-02, OPS-03).
- **Escenarios.** ONB-05, ONB-06, OPS-02 y OPS-03.
- **Riesgo residual.** Al firmar, el usuario confía en el frontend servido. Una passkey firma un hash que el usuario no puede leer.

### THR-15 · Custodia de la clave de cifrado y del Durable Object

- **Vector.** Alguien entra en la cuenta de Cloudflare, o un empleado malicioso, lee `SESSION_KEK` y el SQLite del Durable Object.
- **Controles:**
  - las session keys van cifradas y solo se descifran en `sign`;
  - la clave de cifrado se deriva de un secreto de Worker;
  - la política de sesión limita lo que cualquiera puede hacer con la clave, incluido el operador;
  - el walkaway no depende de Mamoru;
  - en v1 no hay session keys de producción.
- **Detección.** `SESSION_FOREIGN_USE` si la clave se usa fuera del motor.
- **Escenarios.** SESS-01 a SESS-25 y WALK-01.
- **Respuesta.** Sección 6, caso E.
- **Riesgo residual.** Quien controla el motor puede actuar como THR-04 en todas las cuentas a la vez. Es la frontera de la promesa no custodia: nadie puede sacar fondos de la cuenta, pero se puede perder valor dentro de los topes.

### THR-16 · Fondos en la cuenta contrafactual con la puerta cerrada

- **Vector.** El usuario envía fondos a la dirección que vio en el onboarding antes de que se abran los depósitos.
- **Controles:**
  - no hay botón de depósito y el texto dice "Deposits are closed";
  - la dirección se comprueba contra el factory (`ONB_ADDRESS_MATCH`);
  - el motor detecta `ACCT_FUNDS_WHILE_CLOSED` y la vista enlaza el procedimiento de WALK-04;
  - el kit de recuperación permite desplegar y retirar sin Mamoru.
- **Detección.** `ACCT_FUNDS_WHILE_CLOSED`.
- **Escenarios.** DEP-02, DEP-03, ONB-03 y WALK-04.
- **Riesgo residual.** El usuario necesita gas en Base y una herramienta para desplegar su Safe. Si la dirección calculada fuera errónea, los fondos se perderían: ONB-03 y WALK-04 son obligatorios antes de enseñar cualquier dirección.

### THR-17 · Abuso o error en las incidencias del operador

- **Vector.** Una incidencia falsa o mal puesta fuerza salidas o bloquea entradas.
- **Controles:**
  - cada incidencia se identifica por la tupla del pool o del token, nunca por nombre;
  - las incidencias van a la auditoría, llevan autor y se pueden retirar;
  - la salida devuelve los fondos a la cuenta;
  - la conversión espera a que la Execution Health Gate dé GO.
- **Detección.** Auditoría y `EXIT_RISK_INCIDENT` en la vista, con la incidencia enlazada.
- **Escenarios.** GATE-01, GATE-05 y GATE-07.
- **Riesgo residual.** Coste de gas y comisiones no ganadas por un error del operador.

### THR-18 · Lista negra o pausa de USDC

- **Vector.** El emisor pausa USDC, o pone la cuenta en su lista negra.
- **Controles:**
  - Risk Monitor lee `paused()` e `isBlacklisted()`;
  - se bloquean las entradas;
  - una salida que revierte queda pendiente con la causa;
  - la vista avisa.
- **Detección.** `RISK_TOKEN_PAUSED`, `RISK_ACCOUNT_BLOCKLISTED` y `EHG_SIM_REVERT`.
- **Escenarios.** GATE-04 (variante b) y GATE-06 (variantes b y c).
- **Riesgo residual.** El riesgo del emisor es parte del preset: el cajón es USDC.

### THR-19 · Owner comprometido

- **Vector.** Un atacante controla la passkey o el owner de respaldo. Por ejemplo, entrando en la cuenta de la plataforma que sincroniza la passkey.
- **Controles:** Mamoru no puede proteger contra el owner. El respaldo permite al usuario rotar un owner si detecta el problema. La vista enseña los cambios de owners (`OBS_OWNER_ACTION`).
- **Detección.** `OBS_OWNER_ACTION` y `OBS_EXTERNAL_CHANGE`.
- **Escenarios.** WALK-03.
- **Riesgo residual.** Total sobre los fondos. Es inherente a una cuenta cuyo owner es el usuario.

### THR-20 · Filtración por el modelo de lectura del dashboard

- **Vector:**
  - la ruta `history` o el payload devuelven filas de otra cuenta: su historia de posiciones, sus operaciones en el EntryPoint o sus swaps;
  - una query de MultiBaas lleva parámetros de la petición y lee la historia de otra dirección;
  - el navegador recibe la clave o la URL del deployment, o llama a MultiBaas;
  - el deployment guarda direcciones de usuarios en queries, alias, etiquetas o webhooks, y quien tenga acceso a él ve qué cuentas usa Mamoru;
  - una fila pública de pool se marca como de Mamoru y enseña a todos los usuarios la actividad de otra cuenta.
- **Controles:**
  - solo `ReadModelSync` llama a MultiBaas, con parámetros que salen del registro, de la política, del `AccountRecord` y de la proyección (FR-MB-006);
  - las queries con direcciones de cuenta se ejecutan sin guardar, y no hay alias, etiquetas ni webhooks por cuenta (FR-MB-008);
  - la API lee solo D1 y filtra las filas por cuenta por el `account_key` del grant. Una referencia ajena devuelve una lista vacía (FR-DSH-020);
  - las filas de pool no llevan `account_key` ni marca de Mamoru. Solo las filas de la propia cuenta dicen "Mamoru" o "Not from Mamoru";
  - la SPA solo habla con `/api/*`, y el bundle no tiene hosts ni claves (FR-DSH-019).
- **Detección.** `GRANT_REQUIRED` en la auditoría. `mb_checks` registra cada query por alcance. MB-02 lista las queries guardadas, los alias y los webhooks del deployment.
- **Escenarios.** TEN-01, TEN-05, TEN-08, UI-08 y MB-02.
- **Riesgo residual.** R-10.

## 5. Riesgos residuales aceptados

| Id | Riesgo | Techo | Dónde se ve |
|---|---|---|---|
| R-1 | Sandwich con una session key filtrada, usando mínimo de 1 wei | Topes por llamada y acumulados de `enter-swap` y `manage` | THR-04, SESS-06 |
| R-2 | Mint, reducción o cierre con precio manipulado usando la session key | Topes de `enter-mint` y profundidad del pool | THR-04 |
| R-3 | Gasto de gas con operaciones que revierten | Reserva de gas de la cuenta | SESS-09 a |
| R-4 | Posiciones que el owner acuña a mano | No es residual. `allowedTokenIds` solo crece en `mintAndNote` | SESS-09 c termina en `POLICY_DENIED_POSITION` |
| R-5 | Alto en el laboratorio puede correr sin las reglas de ERC-7562 | Diferencias entre el laboratorio y un bundler estricto | Plan §22 |
| R-6 | Fallos de los contratos de terceros: Safe, Safe7579, SmartSession, Uniswap V3 | Fuera del control de Mamoru | Supuestos de la spec |
| R-7 | Una RPC que miente de forma coherente | En v1, solo la vista | THR-10 |
| R-8 | Riesgo del emisor de USDC | Todo el cajón | THR-18 |
| R-9 | Compromiso de la cuenta de Cloudflare | Lo que permite la política de sesión | THR-15 |
| R-10 | MultiBaas y el proveedor RPC ven las direcciones y los `tokenId` que consulta el motor, y pueden relacionarlos con Mamoru | La relación entre cuentas y Mamoru. Ningún fondo, y ningún dato del login | THR-20 |

## 6. Respuesta a incidentes

Estos pasos los ejecuta Ot. En v1 producción no tiene sesiones activas, así que los casos A y E solo aplican al laboratorio y, más adelante, a T-000025.

| Caso | Disparador | Pasos |
|---|---|---|
| A. Uso ajeno o sospecha de clave filtrada | `SESSION_FOREIGN_USE` o `RECON_NONCE_CONSUMED_BY_OTHER` | 1. El Durable Object ya pausó la cuenta. 2. Marcar la session key como `compromised`. 3. La vista pide al usuario que revoque con su owner: Mamoru no puede revocar por él. 4. Revisar el origen. Si es la clave de cifrado, pasar al caso E. 5. Renovar solo con salt nuevo y tras la revocación |
| B. Incidencia en un pool o token | Aviso externo o bandera en cadena | 1. Añadir la fila en `operator_incidents` con la tupla. 2. Risk Monitor pide la salida en la siguiente revisión. 3. Retirar la fila cuando pase |
| C. Clave de MultiBaas filtrada | Uso inesperado o aviso | 1. Rotar la clave en MultiBaas. 2. Actualizar el secreto del motor. 3. Rotar el secreto del webhook si también se vio. 4. Contrastar la proyección con la RPC |
| D. Clave de RPC o de bundler filtrada | Consumo inesperado | 1. Rotar en el proveedor. 2. Actualizar el secreto |
| E. Clave de cifrado filtrada | Aviso de Cloudflare o sospecha | 1. Rotar `SESSION_KEK` con una versión nueva. 2. Marcar todas las session keys como `compromised`. 3. Pausar todas las cuentas. 4. Pedir a cada usuario que revoque y renueve con salt nuevo |
| F. Sospecha de firma en producción | Cualquier llamada al bundler en producción | 1. Revertir a la última versión revisada. 2. Revisar la configuración con DRY-01. 3. Ninguna tarea del pack abre esta puerta: tratarlo como incidente de seguridad |
