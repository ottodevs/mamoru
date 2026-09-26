# Escenarios 001 · Mamoru v1

- Spec: `specs/001-mamoru-v1/spec.md`
- Plan: `specs/001-mamoru-v1/plan.md`
- Fecha: 2026-09-26

Los escenarios son la capa de verificación que Spec Kit no trae. Cada tarea de `tasks.md` se acepta con escenarios de este catálogo. Cada escenario cita requisitos de la spec.

## 1. Reglas del catálogo

1. **Un archivo por escenario.** Cada escenario de este documento será un archivo `scenarios/catalog/<id>.yaml` con estos campos:
   - `id` y `requirements`;
   - `fork`, con `source`, `block`, `blockHash` y `chainId`;
   - `policy`, `fixtures`, `steps`, `expect` e `invariants`.
2. **El bloque de fork es obligatorio.** El runner rechaza un escenario sin `fork.block` (`LAB_BLOCK_REQUIRED`), con un hash que no coincide (`LAB_BLOCK_HASH_MISMATCH`) o con chain id 8453 u 84532 (`LAB_CHAIN_ID_FORBIDDEN`).
3. **Fork por defecto: `catalog-v1`.**
   - Base, bloque 51811000.
   - Hash `0xb7820875b174f7a8afb72d33464864e6cdfbe0c2173446cc8c4a5649923423ff`.
   - Chain id del fork 31337.

   El segundo fork, para SESS-19 y M06, usa el mismo bloque con chain id 31338.
4. **Esperados.** Un resultado esperado es un estado de operación, un código de razón, un invariante o un cambio cualitativo: sube, baja, igual, cero, mayor que cero, mismo hash. No aparece ningún umbral del Packaging ni el valor de un parámetro de ingeniería. Los parámetros de ingeniería salen de la versión de política del escenario y no se afirman.
5. **Pruebas fuera del fork.** La sección 16 recoge las comprobaciones que no corren en fork. Declaran `fork: none` y el motivo, y ninguna firma.
6. **Mismo código que producción.** El runner usa el mismo `decide` y los mismos adaptadores que producción. Solo cambia la configuración (`MAMORU_MODE=lab`).

## 2. Invariantes comunes

El runner los comprueba después de cada paso de cada escenario de fork, salvo que el escenario diga lo contrario.

| Invariante | Qué comprueba |
|---|---|
| `INV-RECIPIENT` | En una operación de Mamoru, los `Transfer` que salen de la cuenta van solo a pools del registro. Los que salen de un pool o del NonfungiblePositionManager van solo a la cuenta. Todo campo `recipient` firmado por la sesión es la cuenta |
| `INV-TARGETS` | Toda llamada firmada por la sesión apunta a un target del grant: tokens de la política, NonfungiblePositionManager o SwapRouter02. Ninguna va a un venue prohibido |
| `INV-SLOT` | Nunca hay dos operaciones no terminales en la misma cuenta |
| `INV-NONCE` | Cada operación usa un solo nonce en todos sus intentos. El carril de Mamoru avanza exactamente una vez por operación incluida |
| `INV-PERSIST-FIRST` | Toda userOp que el motor envía al bundler tiene antes una fila `signed` con el mismo hash en el diario. No se aplica a las userOps que la familia SESS construye a mano. SESS-24 comprueba el caso contrario: una userOp válida que no está en el diario |
| `INV-ETH-GAS` | El ETH de la cuenta solo baja por el `actualGasCost` de sus userOps. Ninguna llamada lleva valor nativo |
| `INV-NO-ANVIL-IN-ENGINE` | El puerto del proxy que usa el motor rechaza `anvil_*`, `evm_*` y `hardhat_*`, y el informe cuenta cero llamadas de ese tipo desde el motor |
| `INV-CODES` | Todo código emitido está en el catálogo `ReasonCode` |
| `INV-NO-BASESCAN-LAB` | Ninguna respuesta de la API ni ninguna página del laboratorio contiene enlaces a Basescan |
| `INV-FORK-CHAIN` | Toda RPC y todo bundler de la ejecución responden el chain id del fork |

## 3. Fixtures y perturbaciones

### 3.1 Fixtures

| Fixture | Qué deja preparado |
|---|---|
| `fx-owners` | Passkey owner del autenticador de software. Owner de respaldo: cuenta de desarrollo 1 de anvil. Pagador de gas para el walkaway: cuenta de desarrollo 2 |
| `fx-safe` | Safe con los owners, Safe7579 y Smart Sessions sin sesiones, desplegado por el owner con los parámetros del onboarding. Variante `counterfactual`: sin desplegar |
| `fx-gas` | ETH en la cuenta como reserva de gas. Variante `extra`: por encima de la reserva |
| `fx-usdc` | USDC transferido a la cuenta desde una ballena impersonada, con un evento `Transfer` real |
| `fx-weth` | WETH transferido a la cuenta desde una ballena |
| `fx-sessions` | El owner activa los grants de la política del escenario con salts nuevos. Registra los `permissionId` y `allowedTokenIds`. La session key es la que generó el motor. En la familia SESS es la cuenta de desarrollo 5 de anvil, tratada como filtrada |
| `fx-lp` | Aplica `fx-usdc` y ejecuta con el motor las dos entradas de M02. El escenario empieza con una posición gestionada y en rango |
| `fx-lp-direct` | Aplica `fx-usdc` y crea la posición con `mintAndNote` de la sesión, sin motor. Sirve a los escenarios que corren antes de que exista el motor (familia SESS, WALK-01, WALK-02). El `tokenId` queda en `allowedTokenIds` |
| `fx-owner-position` | Posición acuñada por el owner, fuera de `allowedTokenIds` |
| `fx-second-account` | Segundo usuario con su propio Safe, sesiones y posición |
| `fx-whale` | Ballenas impersonadas con USDC y cbBTC para mover pools con swaps reales |
| `fx-incident` | Fila en `operator_incidents` de la D1 local, o una bandera en cadena puesta con escritura de storage en la fase de preparación |

### 3.2 Perturbaciones

| Perturbación | Efecto |
|---|---|
| `swaps-in-range` | La ballena hace swaps reales en las dos direcciones sin sacar el precio del rango. Genera comisiones |
| `push-out-of-range` | La ballena mueve el tick fuera del rango de la posición |
| `manipulate-spot` | Un swap grande de la ballena separa el tick actual del TWAP |
| `liquidity-change` | La ballena añade y retira liquidez en el pool curado con su propia posición. Genera `Mint`, `Burn` y eventos del NonfungiblePositionManager reales |
| `time-warp` | Avanza el tiempo y mina |
| `reorg` | `anvil_reorg` con la profundidad del escenario |
| `bundler-hold` | Alto acepta y no incluye hasta que se suelta |
| `bundler-drop` | Alto olvida su mempool |
| `bundler-down` | Alto se para |
| `rpc-flaky` | El puerto del motor en el proxy responde 429 o 5xx, o bloques distintos en una misma lectura |
| `index-lag` | El lector del fork que hace de `EventIndexPort` omite un evento hasta que el escenario lo suelta |
| `index-wrong` | El lector altera un argumento de una fila, un agregado de MBQ-07 o el `tick` del último `Swap` de un tramo |
| `index-behind` | El lector declara su bloque indexado por detrás de `H` más de `MB_MAX_LAG_BLOCKS`, o que está procesando logs pasados |
| `index-absent` | El lector declara un chain id que no es el del fork, o un contrato sin enlazar |
| `index-start(B)` | El lector declara el bloque de inicio B y no devuelve filas anteriores |
| `index-fail` | El lector responde error a las queries |
| `crash-at` y `hold-at` | Acción `crash` o `hold` en un punto de fallo con nombre (plan §20) |
| `do-evict` | Reinicia el proceso local del motor. El SQLite del Durable Object persiste |

## 4. Cobertura del ciclo

El catálogo cubre catorce escenarios de fork, del s01 al s14, más la variante s08a, con estas reglas:

- bloque fijo y chain id del fork;
- Uniswap V3 como única ejecución;
- resultados como códigos y estados.

Los escenarios que usaban vaults ERC-4626 o ERC-7540 (s02, s04, s09 y s10) conservan su propósito estructural. Las llamadas a vaults pasan a ser rechazos: SESS-10 esconde un `deposit` de ERC-4626 en un lote y `INV-TARGETS` corre en todos los escenarios.

| Escenario | Qué cubre | Qué resuelve Mamoru |
|---|---|---|
| M01 | Observación sin capital | Observación a bloque fijo y código por bucket |
| M02 | Depósito y asignación a vaults | Asignación en V3: `enter_swap` y `enter_mint`. Buckets sin pool con `PLAN_BUCKET_NO_EXECUTABLE_POOL` |
| M03 | Swap desde la cuenta | Swap por la sesión, con mínimo desde QuoterV2 y approve exacto |
| M04 | Harvest de un vault | Harvest de comisiones V3 a USDC con crédito solo de comisiones |
| M05 | Fixtures y snapshots del harness | Autoprueba del runner: snapshot por ejecución, reproducción y sin anvil en el motor |
| M06 | Observación en red principal | Guarda de chain y activos fuera de la política |
| M07 | LP V3 | LP en WETH/USDC 0.3% con la política de escenario y ticks múltiplos de 60 |
| M08 | Cierre de posición | Cierre en un lote, fila `close` sin crédito |
| M09 | Estado pendiente entre revisiones y reinicio | Salida retenida por el bundler, timeout, reinicio y reenvío con el mismo nonce |
| M10 | Harvest con inclusión inmediata o retrasada | Slot ocupado y crédito solo en `confirmed` |
| M11 | Rechazos previos, gas y estado estable | Manipulación de precio sin envío, ETH solo para gas, ciclo estable |
| M12 | Tres buckets | Tres buckets con uno ejecutable y shadow sin efecto |
| M13 | Plan en dry-run | Dry-run en dos fases con cadena intacta |
| M14 | Reajuste de rango | Cierre por rango, reentrada con `tokenId` nuevo y variante con premisa vieja |

## 5. Escenarios de ciclo: M01 a M14

Todos usan el fork `catalog-v1` (Base 51811000, chain id 31337), salvo que se indique. Todos comprueban los invariantes de la sección 2.

### M01 · Observación sin capital

- Requisitos: FR-RPC-001, FR-DEC-001, FR-DEC-007, FR-DEC-013, FR-LAB-006
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`
- Pasos:
  1. Revisión.
  2. Se repite `decide` sobre la misma observación.
- Esperado:
  - Observación `OBS_OK` en un bloque con el hash del fork.
  - Decisión `DECIDE_HOLD` con `DECIDE_NO_CAPITAL`.
  - Buckets: `btc-usdc` con `DECIDE_NO_CAPITAL`; `stables` y `risk` con `PLAN_BUCKET_NO_EXECUTABLE_POOL`.
  - Ninguna operación. El diario tiene una decisión y cero operaciones.
  - El paso 2 produce la misma decisión y el mismo rastro, byte a byte.

### M02 · Depósito y primera asignación

- Requisitos: FR-DEC-007, FR-ENG-015, FR-UNI-001, FR-UNI-002, FR-UNI-003, FR-UNI-006, FR-ACC-003
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-usdc`
- Pasos:
  1. Se mina hasta que el depósito queda por debajo de `safe`.
  2. Revisión.
  3. Revisión inmediata tras el estado terminal.
  4. Revisión.
- Esperado:
  - **Paso 2.**
    - Códigos `OBS_DEPOSIT_DETECTED` y `DECIDE_ENTER`.
    - Operación `enter_swap`: `proposed`, `prepared`, `simulated`, `signed`, `submitted`, `included` y `confirmed`, con `EXEC_OK`.
    - Llamadas: `USDC.approve(SwapRouter02, exacto)` y `SwapRouter02.exactInputSingle`, de USDC a cbBTC, fee 500, destinatario la cuenta, mínimo mayor que cero y `sqrtPriceLimitX96` cero.
    - Grant `enter-swap`.
  - **Paso 3.**
    - Operación `enter_mint` en `confirmed`, con grant `enter-mint`.
    - Llamadas: dos `approve` al NonfungiblePositionManager, `mint` con destinatario la cuenta, ticks múltiplos de 10 y mínimos mayores que cero, y dos `approve(NonfungiblePositionManager, 0)`.
    - El `tokenId` nuevo está en `allowedTokenIds` y la posición queda `managed`.
  - **Paso 4.** `DECIDE_HOLD` con `DECIDE_IN_RANGE`.
  - **Buckets.** `btc-usdc` con `STRATEGY_PREFERENCE`. `stables` y `risk` con `PLAN_BUCKET_NO_EXECUTABLE_POOL`. Su parte sigue en USDC.
  - **Anotaciones.** Hay anotación `ENY_SHADOW`.
  - **Allowances.** Todas en cero al final de cada operación.

### M03 · Swap por la sesión

- Requisitos: FR-UNI-001, FR-UNI-002, FR-UNI-006, FR-ACC-010, FR-AA-001, FR-AA-002, FR-AA-004
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-usdc`
- Pasos:
  1. Revisión hasta que `enter_swap` llega a un estado terminal.
- Esperado:
  - `enter_swap` en `confirmed` con `EXEC_OK`.
  - `amountOutMinimum` es igual al que calcula el adaptador con la cotización de QuoterV2 en el bloque de preparación y la tolerancia de la política. La prueba lo recalcula con la misma función, sin fijar el valor.
  - El delta de cbBTC es mayor o igual que el mínimo, tanto en la simulación como en el evento `Swap`.
  - Allowance de USDC al router: cero.
  - El `userOpHash` del diario es igual a `EntryPoint.getUserOpHash`.
  - El recibo del bundler coincide con el `UserOperationEvent` leído por RPC.
  - El pre-chequeo acepta el lote (`SESSION_ACTIVE`).

### M04 · Harvest a USDC

- Requisitos: FR-DEC-009, FR-UNI-005, FR-UNI-006, FR-PRJ-003, FR-PRJ-004, FR-ENG-008
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-lp`, `fx-whale`
- Pasos:
  1. Revisión.
  2. Rondas de `swaps-in-range`, cada una seguida de una revisión, hasta que la decisión cambia. El número de rondas no se afirma.
  3. Revisión inmediata tras el estado terminal.
- Esperado:
  - **Paso 1.** `DECIDE_HOLD` con `DECIDE_HARVEST_BELOW_COST`. Ninguna operación.
  - **Paso 2.**
    - Termina en `DECIDE_HARVEST`.
    - Operación `harvest` en `confirmed` con `EXEC_OK`, confirmada en un bloque `safe`.
    - Llamadas: `collect`, con el `tokenId`, destinatario la cuenta e importes máximos; `approve(SwapRouter02, exacto)` de cbBTC; y `exactInputSingle` de cbBTC a USDC.
    - Estado de la cuenta:
      - la liquidez de la posición no cambia;
      - el `tokenId` sigue y está `managed`;
      - el USDC sube;
      - el cbBTC vuelve al valor de antes del harvest.
  - **Paso 3.** `DECIDE_HOLD` con `DECIDE_HARVEST_BELOW_COST`.
  - **Savings Log.**
    - Fila `harvest` con principal cero, comisiones iguales al evento `Collect` y conversión igual al evento `Swap`.
    - Estado `confirmed` y `PROJ_CONFIRMED`.
    - Procedencia `journal` y `fork_rpc`.
    - El total del libro sube lo acreditado.

### M05 · Autoprueba del runner

- Requisitos: FR-LAB-002, FR-LAB-004, FR-LAB-005, FR-LAB-006, FR-LAB-012
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-usdc`
- Pasos:
  1. Se aplican las fixtures y se toma el snapshot S1 en la ejecución R1.
  2. Se cambia el estado y se vuelve a S1.
  3. En la ejecución R2 se intenta usar S1.
  4. Se envía `anvil_setBalance` por el puerto del motor.
  5. Se vuelca el estado, se carga en otro anvil de la misma versión y se repite la observación.
- Esperado:
  - **Pasos 1 y 2.** Tras volver a S1, saldos y nonce iguales a los de S1. Los saldos de las fixtures son los que declara la fixture.
  - **Paso 3.** `LAB_SNAPSHOT_FOREIGN`. El runner no revierte.
  - **Paso 4.** El proxy rechaza la llamada. El informe cuenta cero métodos de anvil desde el motor (`INV-NO-ANVIL-IN-ENGINE`).
  - **Paso 5.** Mismo hash de observación y `LAB_REPRO_OK`. El artefacto lleva el sha256 del estado, la versión de anvil, el bloque y las fixtures.

### M06 · Guarda de chain y activos fuera de la política

- Requisitos: FR-RPC-004, FR-ENG-017, FR-DEC-014, FR-LAB-003
- Fork: `catalog-v1` · 51811000 · 31337, más un segundo anvil en el mismo bloque con chain id 31338
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-weth`
- Pasos:
  1. El motor, configurado con chain id 31337, apunta al anvil 31338. Revisión.
  2. El motor vuelve al anvil 31337. `fx-weth` deposita WETH. Revisión.
  3. El runner intenta arrancar un anvil con chain id 8453.
- Esperado:
  - **Paso 1.** `OBS_CHAIN_MISMATCH`. Ni decisión ni operación.
  - **Paso 2.** WETH listado con `OBS_UNMANAGED_ASSET`. `DECIDE_HOLD` con `DECIDE_NO_CAPITAL`. Ninguna llamada tiene WETH como target.
  - **Paso 3.** `LAB_CHAIN_ID_FORBIDDEN` antes de arrancar el proceso.

### M07 · LP en WETH/USDC 0.3% con la política de escenario

- Requisitos: FR-UNI-003, FR-UNI-004, FR-DEC-002, FR-ENG-013
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `lab-weth-usdc-v1`, solo de escenario. Sus grants son los de §12.2 del plan con WETH en lugar de cbBTC y fee 3000.
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-usdc`
- Pasos:
  1. Revisiones hasta el estado estable.
  2. Intención `exit`.
  3. Revisiones hasta `EXIT_COMPLETED`.
- Esperado:
  - **Paso 1.**
    - `enter_swap` de USDC a WETH con fee 3000, en `confirmed`.
    - `enter_mint` en `confirmed`, con token0 WETH, token1 USDC y ticks múltiplos de 60.
  - **Paso 3.**
    - `DECIDE_EXIT` con `EXIT_USER_EMERGENCY`.
    - `close_position` en `confirmed`: el NFT queda quemado y `ownerOf` revierte.
    - `DECIDE_CONVERT` y `convert` en `confirmed`.
    - `EXIT_COMPLETED` y la cuenta en pausa.
  - La política `conservador-v1` no lista este pool: sobre el mismo estado, `decide` con `conservador-lab-v1` marca la posición con `OBS_UNMANAGED_ASSET`.

### M08 · Cierre de posición

- Requisitos: FR-UNI-004, FR-PRJ-003, FR-PRJ-004, FR-ENG-013
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-lp`, `fx-whale`
- Pasos:
  1. `swaps-in-range`.
  2. Intención `exit`.
  3. Revisiones hasta `EXIT_COMPLETED`.
- Esperado:
  - **Cierre.**
    - `DECIDE_EXIT` con `EXIT_USER_EMERGENCY`.
    - `close_position` en `confirmed`, en un solo lote con tres llamadas: `decreaseLiquidity` de toda la liquidez, `collect` al máximo con destinatario la cuenta y `burn`.
  - **Conversión y fin.**
    - `DECIDE_CONVERT` y `convert` en `confirmed`.
    - `EXIT_COMPLETED` y la cuenta en pausa.
  - **Savings Log.**
    - Fila `close` con principal igual a la suma de `DecreaseLiquidity` y comisiones igual a `Collect` menos principal.
    - Crédito cero y `PROJ_PRINCIPAL_EXCLUDED`.
    - El total del libro no cambia.
  - **Targets.** Ninguna llamada a vaults (`INV-TARGETS`).

### M09 · Salida retenida, reinicio y mismo nonce

- Requisitos: FR-ENG-006, FR-ENG-010, FR-ENG-013, FR-AA-003
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-lp`
- Pasos:
  1. `bundler-hold` e intención `exit`.
  2. Revisión.
  3. `time-warp` más allá del plazo de recibo.
  4. `do-evict`.
  5. El motor vuelve y salta la alarma vigilante.
  6. Se suelta el bundler.
  7. Revisiones hasta `EXIT_COMPLETED`.
- Esperado:
  - **Paso 2.** `close_position` en `signed` y luego `submitted`, con `BUNDLER_ACCEPTED`.
  - **Paso 3.** Pasa a `pending_reconciliation` con `RECON_TIMEOUT`. Arranca `rc-{opId}-1`.
  - **Paso 5.** La reconciliación sigue tras el reinicio. Pasa a `submitted` con `RECON_RESENT_SAME_BYTES`.
  - **Paso 6.** Pasa a `included` con `OP_INCLUDED` y a `confirmed` con `EXEC_OK`.
  - **Del paso 2 al 6.**
    - Las revisiones dan `DECIDE_SLOT_BUSY`.
    - La salida sigue en curso.
    - `paused` sigue en falso.
  - **Paso 7.** `convert` en `confirmed`. `EXIT_COMPLETED`. `paused` pasa a verdadero solo ahora.
  - **Unicidad.**
    - Un solo `userOpHash` en todos los intentos del cierre.
    - El carril de nonce avanza uno por el cierre y uno por la conversión (`INV-NONCE`).

### M10 · Slot ocupado y crédito solo en `confirmed`

- Requisitos: FR-ENG-003, FR-ENG-015, FR-PRJ-004, FR-PRJ-005
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-lp`, `fx-whale`
- Pasos, variante a (inclusión inmediata):
  1. `swaps-in-range` hasta `DECIDE_HARVEST`.
  2. Revisión.
- Pasos, variante b (inclusión retrasada):
  1. `swaps-in-range` hasta `DECIDE_HARVEST`.
  2. `bundler-hold` y revisión.
  3. Otra revisión.
  4. Se suelta el bundler.
  5. Revisión inmediata.
- Esperado, variante a:
  - `harvest` en `confirmed`.
  - La fila del Savings Log pasa de `pending` a `confirmed`. El crédito aparece solo en `confirmed`.
- Esperado, variante b:
  - **Paso 2.** `harvest` en `submitted`. Current Action muestra la operación. El Savings Log aún no tiene fila. El total del libro no cambia.
  - **Paso 3.** `DECIDE_SLOT_BUSY`. Ninguna operación nueva.
  - **Paso 4.** `confirmed`. El Savings Log crea la fila ya en `confirmed` y el total sube.
  - **Paso 5.** `DECIDE_HOLD` con `DECIDE_HARVEST_BELOW_COST`.
  - La liquidez de la posición no cambia en ninguna variante.

### M11 · Precio manipulado sin envío y ETH solo para gas

- Requisitos: FR-UNI-009, FR-ACC-002, FR-DEC-014, FR-ENG-015
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas` (variante `extra`), `fx-sessions`, `fx-usdc`, `fx-whale`
- Pasos:
  1. `manipulate-spot` en el pool curado.
  2. Revisión.
  3. `time-warp` y un swap inverso de la ballena hasta que el TWAP y el tick vuelven a estar cerca.
  4. Revisiones hasta el estado estable.
- Esperado:
  - **Paso 2.**
    - `OBS_ETH_NOT_INVESTED`.
    - Decisión sin operación, con el rastro de la Execution Health Gate en `NO_GO` por `EHG_PRICE_DIVERGENCE`.
    - Alto no recibe ninguna userOp.
  - **Paso 4.**
    - `enter_swap` y `enter_mint` en `confirmed`.
    - Termina en `DECIDE_HOLD` con `DECIDE_IN_RANGE`, y las revisiones siguientes no crean operaciones.
  - **ETH.**
    - En cada revisión, `OBS_ETH_NOT_INVESTED`.
    - El ETH baja exactamente la suma de `actualGasCost` (`INV-ETH-GAS`).
    - Ninguna llamada lleva valor nativo.

### M12 · Tres buckets

- Requisitos: FR-DEC-006, FR-DEC-007, FR-DSH-002
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-usdc`
- Pasos:
  1. Revisiones hasta el estado estable.
  2. Se repite la última decisión cambiando solo las entradas shadow.
- Esperado:
  - **Buckets.** `btc-usdc` con `STRATEGY_PREFERENCE` y sus entradas en `confirmed`. `stables` y `risk` con `PLAN_BUCKET_NO_EXECUTABLE_POOL`.
  - **Asignación.** Aparece `STRATEGY_PREFERENCE_DEVIATION`. La asignación real se aparta de la preferencia y no se hace nada por ello.
  - **Anotaciones.** Hay `ENY_SHADOW` y `RISK_SHADOW`.
  - **Paso 2.** Misma decisión y mismo código. Shadow no controla.
  - **Portfolio.** Enseña la preferencia y la asignación real. El USDC sin pool va rotulado como "Idle, no executable pool in v1".

### M13 · Dry-run en dos fases

- Requisitos: FR-ENG-014, FR-DSH-004
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-usdc`
- Pasos:
  1. Fase A: revisión con parada antes de firmar.
  2. Fase B: sobre el mismo estado, revisión sin parada.
- Esperado:
  - **Fase A.**
    - `enter_swap` pasa por `proposed`, `prepared` y `simulated` y termina `discarded` con `DRY_RUN_STOP`.
    - Nonce, saldos, allowances y posiciones de la cuenta iguales antes y después. Alto recibe cero userOps.
    - Current Action dice "Simulated, not sent" con `DRY_RUN_STOP`.
    - Una segunda revisión sin cambio de premisa no abre otra operación: `REVIEW_DEDUPED`.
  - **Fase B.**
    - Mismo tipo de decisión y mismas llamadas, salvo los importes que dependen del bloque de la cotización.
    - `confirmed` con `EXEC_OK`.

### M14 · Reajuste de rango

- Requisitos: FR-DEC-010, FR-UNI-003, FR-UNI-004, FR-ENG-015
- Fork: `catalog-v1` · 51811000 · 31337
- Política: `conservador-lab-v1`, con `range.adjust = on_out_of_range`
- Fixtures: `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-lp`, `fx-whale`
- Pasos, variante a:
  1. `push-out-of-range` y revisión.
  2. Revisiones inmediatas tras cada estado terminal.
  3. `push-out-of-range` otra vez, dentro del cooldown. Revisión.
  4. `time-warp` más allá del cooldown y revisión.
- Pasos, variante b (premisa vieja):
  1. `hold-at(after_prepare_persist)`, `push-out-of-range` y revisión.
  2. Con la operación retenida, la ballena devuelve el precio al rango y se suelta.
  3. Revisión.
- Esperado, variante a:
  - **Paso 1.** `DECIDE_RANGE_ADJUST` y `close_position` en `confirmed`.
  - **Paso 2.**
    - `DECIDE_ENTER` y las entradas necesarias, en `confirmed`.
    - El `tokenId` nuevo es mayor que el anterior y queda `managed` y en rango.
    - El NFT anterior está quemado.
  - **Paso 3.** `DECIDE_RANGE_COOLDOWN`. Ninguna operación.
  - **Paso 4.** `DECIDE_RANGE_ADJUST`.
- Esperado, variante b:
  - La operación termina `discarded` con `OP_DECISION_STALE` en la simulación. Alto no recibe ninguna userOp.
  - Paso 3: `DECIDE_HOLD` con `DECIDE_IN_RANGE`.

## 6. Abuso de la sesión: SESS-01 a SESS-25

- **Fork.** `catalog-v1` · 51811000 · 31337. SESS-19 añade el fork 31338.
- **Política.** `conservador-lab-v1`.
- **Fixtures.** `fx-owners`, `fx-safe`, `fx-gas`, `fx-usdc`, `fx-lp-direct`, `fx-sessions` (con la session key filtrada), `fx-owner-position`, `fx-second-account` y `fx-whale`. SESS-24 y SESS-25 usan `fx-lp`, porque necesitan el motor.
- **El atacante.** Tiene la session key y nada más. Construye userOps a mano con viem y las envía a Alto. Para leer el motivo exacto de un rechazo, también llama a `EntryPoint.handleOps` desde una cuenta de desarrollo de anvil. El motor está parado, salvo en SESS-24 y SESS-25.
- **Esperado por defecto.**
  - `CHAIN_REJECTED_VALIDATION`: error AA del bundler o `FailedOp` de `handleOps`.
  - Sin cambio de estado: saldos, allowances, NFTs, owners, módulos, sesiones y nonces iguales.
  - El pre-chequeo del motor rechaza el mismo lote con el código indicado (lo comprueba SESS-25).

| Id | Requisitos | Ataque | Esperado |
|---|---|---|---|
| SESS-01 | FR-ACC-003, FR-UNI-002 | `exactInputSingle` de USDC a cbBTC con `recipient` del atacante | Por defecto. `POLICY_DENIED_RECIPIENT` |
| SESS-02 | FR-ACC-003, FR-UNI-003 | `collect` de la posición gestionada con `recipient` del atacante | Por defecto. `POLICY_DENIED_RECIPIENT` |
| SESS-03 | FR-ACC-003, FR-UNI-003 | `mint` con `recipient` del atacante | Por defecto. `POLICY_DENIED_RECIPIENT` |
| SESS-04 | FR-ACC-004 | `transfer` y `transferFrom` de USDC y cbBTC al atacante; `safeTransferFrom`, `transferFrom`, `approve` y `setApprovalForAll` del NFT | Por defecto en cada una. `POLICY_DENIED_TARGET` |
| SESS-05 | FR-ACC-003 | Swap con `amountIn` por encima del tope por llamada | Por defecto. `POLICY_DENIED_AMOUNT` |
| SESS-06 | FR-ACC-003 | Swaps sucesivos, cada uno dentro del tope por llamada, hasta pasar el tope acumulado | Los que caben en el acumulado se incluyen con destinatario la cuenta: es el residuo de THR-04. El que lo pasa: por defecto, con `POLICY_DENIED_CUMULATIVE` |
| SESS-07 | FR-UNI-006 | `USDC.approve(SwapRouter02, máximo uint256)` | Por defecto. `POLICY_DENIED_APPROVAL` |
| SESS-08 | FR-UNI-006, FR-ACC-004 | `approve` al atacante; `increaseAllowance` de USDC; `approve` a Permit2 | Por defecto en cada una. `POLICY_DENIED_APPROVAL` o `POLICY_DENIED_TARGET` |
| SESS-09 | FR-ACC-008 | a) `decreaseLiquidity` sobre el `tokenId` de `fx-second-account`. b) `decreaseLiquidity` sobre la posición de `fx-owner-position`, acuñada antes de activar. c) El owner acuña otra posición después de activar y la session key intenta `decreaseLiquidity` sobre ese `tokenId` | a) `POLICY_DENIED_POSITION` o revert del NonfungiblePositionManager si la posición no es de la cuenta. b) y c) `POLICY_DENIED_POSITION`. El id nuevo del owner no está en `allowedTokenIds`. Ningún caso mueve esa liquidez |
| SESS-10 | FR-ACC-004, FR-UNI-008 | Lote con un `collect` válido más `USDC.transfer` al atacante. Lote con un `collect` válido más `deposit` en un vault ERC-4626 de Base | Todo el lote rechazado. Por defecto, con `POLICY_DENIED_TARGET` |
| SESS-11 | FR-ACC-006 | El owner revoca los grants. El atacante reutiliza el `permissionId` revocado. Se reenvía la transacción de activación del owner. Se pide al motor reactivar el `permissionId` revocado. Se renueva | Reutilizar: por defecto. Reenviar la activación: revierte porque el nonce del Safe ya se usó. Reactivar: `SESSION_PERMISSION_ID_REUSED`, sin llamada. Renovar: salt nuevo y `permissionId` distinto |
| SESS-12 | FR-ACC-004 | Firma de la session key presentada a `isValidSignature` de la cuenta, en crudo y con envoltorio ERC-7739. `permit` de USDC firmado así | `isValidSignature` no devuelve `0x1626ba7e`. El `permit` revierte |
| SESS-13 | FR-ACC-004 | Selector no concedido en un target concedido (`increaseLiquidity`). Llamada a un contrato que no está en el grant | Por defecto. `POLICY_DENIED_TARGET`. No hay acción fallback |
| SESS-14 | FR-ACC-004 | `addOwnerWithThreshold`, `swapOwner`, `removeOwner` y `changeThreshold` por la sesión | Por defecto. `POLICY_DENIED_TARGET` |
| SESS-15 | FR-ACC-004 | `installModule`, `uninstallModule`, `setGuard`, `setFallbackHandler` y `enableModule` por la sesión | Por defecto. `POLICY_DENIED_TARGET` |
| SESS-16 | FR-ACC-004, FR-ACC-006 | La sesión llama a SmartSession para activar otra sesión o añadir políticas a la suya. userOp con firma en modo de activación | Por defecto. `POLICY_DENIED_TARGET` |
| SESS-17 | FR-ACC-003 | userOp válida tras `time-warp` más allá de `validUntil` | Por defecto. El motor registra `SESSION_EXPIRED` |
| SESS-18 | FR-ACC-003 | userOps válidas hasta agotar el límite de uso, y una más | La última: por defecto |
| SESS-19 | FR-RPC-004, FR-LAB-003 | userOp firmada para 31337 enviada al fork 31338 con el mismo estado. Transacción del owner firmada para 31337 enviada al 31338 | userOp: por defecto, porque el hash incluye el chain id. Transacción del owner: revierte por firma inválida |
| SESS-20 | FR-ACC-002 | userOp de sesión con `paymasterAndData` de un paymaster cualquiera | Por defecto |
| SESS-21 | FR-ACC-004 | Llamada con valor nativo mayor que cero | Por defecto. `POLICY_DENIED_VALUE` |
| SESS-22 | FR-UNI-002, FR-UNI-008 | `multicall`, `exactInput`, `unwrapWETH9`, `sweepToken` y `refundETH` de SwapRouter02. `multicall` del NonfungiblePositionManager | Por defecto. `POLICY_DENIED_TARGET` |
| SESS-23 | FR-ACC-004 | Modo de ejecución `delegatecall`. Ejecución como executor. Variantes de modo `try` | Por defecto. `POLICY_DENIED_CALLTYPE` |
| SESS-24 | FR-ACC-011 | Con el motor en marcha, el atacante envía una userOp válida dentro de la política, un swap pequeño con mínimo de 1 wei | Se incluye. El motor ve un `UserOperationEvent` con la sesión de Mamoru que no está en el diario: `SESSION_FOREIGN_USE`. La cuenta pasa a pausa y la vista enseña "Revoke Mamoru now" |
| SESS-25 | FR-ACC-010 | El pre-chequeo corre sobre los lotes de SESS-01 a SESS-23 y sobre todos los lotes que produce el motor en M02 a M14 | Rechaza todo lo que la cadena rechaza, con el código de la tabla. Acepta todo lo que produce el motor. Ninguna discrepancia |

## 7. Walkaway: WALK-01 a WALK-05

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Política.** `conservador-lab-v1`.
- **Fixtures.** `fx-owners`, `fx-safe`, `fx-gas` y `fx-sessions`. WALK-01 y WALK-02 usan `fx-lp-direct`. WALK-03 y WALK-05 usan `fx-lp`.
- **Qué está apagado.** El motor, la app y el lector de índice están parados, salvo en WALK-03 y WALK-05. La prueba usa solo viem, la RPC del fork, el owner y el kit de recuperación.

| Id | Requisitos | Pasos | Esperado |
|---|---|---|---|
| WALK-01 | FR-ACC-009, FR-ONB-006 | El owner de respaldo firma una transacción del Safe. Lleva un lote con MultiSendCallOnly con estas llamadas: `removeSession` de cada grant; `decreaseLiquidity`, `collect` con destinatario la cuenta y `burn`; y `transfer` de USDC y cbBTC a una dirección del owner. La envía el pagador. Después, el atacante prueba una userOp con la session key | La transacción se ejecuta. Sesiones revocadas, NFT quemado y tokens en la dirección del owner. La userOp de sesión: `CHAIN_REJECTED_VALIDATION` |
| WALK-02 | FR-ACC-009, FR-ONB-003 | Lo mismo, firmado con la passkey del autenticador de software mediante SafeWebAuthnSharedSigner. Lo envía cualquier cuenta de desarrollo | Mismo resultado. La verificación P-256 funciona en el fork (requisito previo: LAB-08) |
| WALK-03 | FR-ENG-011, FR-DEC-014 | Tras WALK-01, arranca el motor y hay una revisión | `SESSION_REVOKED`, `OBS_EXTERNAL_CHANGE` y `OBS_OWNER_ACTION`. `DECIDE_HOLD` con `DECIDE_NO_CAPITAL`. Ninguna operación. Current Action lo explica |
| WALK-04 | FR-ONB-005, FR-ONB-006, FR-ACC-009 | Cuenta contrafactual (`fx-safe` variante `counterfactual`) con USDC. El owner despliega el Safe con los parámetros del kit y retira el USDC | La dirección desplegada es la del kit (`ONB_ADDRESS_MATCH`). La retirada se ejecuta sin ningún servicio de Mamoru |
| WALK-05 | FR-ENG-007, FR-ACC-009 | Con el motor en marcha: `bundler-hold`, un harvest en `submitted`, y el owner revoca los grants. Luego `time-warp` y mineo hasta `safe` | La operación no se incluye. Pasa a `pending_reconciliation` con `RECON_TIMEOUT` y termina `failed` con `RECON_UNINCLUDABLE`. No hay segundo nonce. El slot queda libre. La siguiente revisión da `SESSION_REVOKED` y ninguna operación |

## 8. Diario: JRNL-01 a JRNL-09

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Política.** `conservador-lab-v1`.
- **Fixtures.** `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-lp` y `fx-whale`, con `swaps-in-range` hasta `DECIDE_HARVEST`.
- **Operación bajo prueba.** Un `harvest`.
- **Esperado común.** Una sola inclusión y el carril de nonce avanzado en uno (`INV-NONCE`, `INV-PERSIST-FIRST`). No se aplica a JRNL-05 b: esa variante caduca sin inclusión y sin nonce nuevo.

| Id | Requisitos | Fallo | Esperado |
|---|---|---|---|
| JRNL-01 | FR-ENG-005, FR-ENG-010 | `crash-at(after_sign_persist)` y reinicio | La alarma vigilante abre la reconciliación. Estados: `signed`, `pending_reconciliation` (`RECON_SEND_UNKNOWN`), `submitted` (`RECON_RESENT_SAME_BYTES`), `included` y `confirmed` |
| JRNL-02 | FR-ENG-005, FR-AA-003 | `crash-at(after_bundler_accept)` y reinicio | La reconciliación encuentra la userOp por hash en el bundler o incluida. Termina `confirmed`. Si reenvía, el bundler responde el mismo hash |
| JRNL-03 | FR-ENG-005 | `crash-at(after_submit_persist)` y reinicio | La espera sigue desde `submitted`. Termina `confirmed` |
| JRNL-04 | FR-ENG-005 | `crash-at(inside_sign_before_commit)` y reinicio | La transacción SQLite se deshace: la operación sigue en `simulated`, sin nonce reservado y sin envío. Al volver, termina `discarded` con `EHG_OBSERVATION_STALE`. La revisión siguiente crea otra operación, que llega a `confirmed` |
| JRNL-05 | FR-ENG-006, FR-ENG-007 | a) `bundler-drop` tras aceptar. b) `bundler-down`, más `time-warp` más allá de `validUntil`, más mineo hasta `safe` | a) `RECON_TIMEOUT`, `RECON_RESENT_SAME_BYTES` y `confirmed`. b) `failed` con `RECON_UNINCLUDABLE` y `SESSION_EXPIRED`. Ningún nonce nuevo |
| JRNL-06 | FR-ENG-007, FR-ACC-011 | Con el harvest retenido, el atacante incluye otra userOp con el mismo nonce del carril | `failed` con `RECON_NONCE_CONSUMED_BY_OTHER`. `SESSION_FOREIGN_USE` y la cuenta en pausa |
| JRNL-07 | FR-ENG-009 | Dos instancias `OperationReconcile` sobre la misma operación | La que no es dueña recibe `OP_OWNER_MISMATCH` en su primera transición y termina. Una sola inclusión |
| JRNL-08 | FR-ENG-002 | `do-evict` en cada estado no terminal: `proposed`, `prepared`, `simulated`, `signed`, `submitted`, `pending_reconciliation` e `included` | El Durable Object rehidrata desde SQLite y la operación sigue desde su estado. Ninguna transición se duplica |
| JRNL-09 | FR-ENG-007 | Con el harvest retenido en el bundler, la ballena mueve el pool hasta que el mínimo del swap no se cumple. Luego se suelta | `included` con `success=false` y `failed` con `EXEC_INNER_REVERT`. El motivo sale de `UserOperationRevertReason`. La cuenta solo pierde gas. La revisión siguiente decide desde cero |

## 9. Reintentos: RETRY-01 a RETRY-06

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Política.** `conservador-lab-v1`.
- **Fixtures.** Las del diario, salvo que se indique.

| Id | Requisitos | Fallo | Esperado |
|---|---|---|---|
| RETRY-01 | FR-RPC-001 | a) `rpc-flaky` con 429 y 5xx en las primeras lecturas de la observación. b) El proxy responde bloques distintos dentro de una lectura. c) Fallo persistente | a) `OBS_OK` tras reintentar dentro del paso. b) `OBS_BLOCK_INCONSISTENT` y ninguna decisión. c) `OBS_RPC_UNAVAILABLE` y ninguna decisión. La revisión siguiente, ya sin fallo, observa con normalidad |
| RETRY-02 | FR-AA-003, FR-ENG-006 | El proxy corta la respuesta de `eth_sendUserOperation` después de que Alto aceptó | `pending_reconciliation` con `RECON_SEND_UNKNOWN`. La reconciliación encuentra el hash. Termina `confirmed`. Una sola inclusión |
| RETRY-03 | FR-ENG-006 | a) La base fee del fork sube por encima del fee firmado, dentro del tope. b) La base fee sube por encima del tope | a) `signReplacement` con el mismo nonce y el mismo `calls_hash`, `RECON_REPLACED_FEE` y `confirmed`. `op_attempts` tiene dos filas con el mismo nonce. b) Sin reemplazo: queda en `pending_reconciliation` con la causa, y Current Action la enseña |
| RETRY-04 | FR-AA-003 | `bundler-down` en el primario. Un segundo Alto en loopback hace de bundler de respaldo | `BUNDLER_UNAVAILABLE` en el primario y `BUNDLER_ACCEPTED` en el de respaldo con los mismos bytes y el mismo `userOpHash`. Termina `confirmed` |
| RETRY-05 | FR-PRJ-001 | `crash-at(project_step)` al escribir en D1 | El cursor de proyección no avanza. La alarma reintenta. Cada fila queda escrita una vez |
| RETRY-06 | FR-UNI-001 | El proxy hace fallar las llamadas a QuoterV2 en la preparación | `discarded` con `EHG_QUOTE_UNAVAILABLE`. Nada firmado. La revisión siguiente, ya sin fallo, prepara con normalidad |

## 10. Precedencia de puertas: GATE-01 a GATE-09

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Política.** `conservador-lab-v1`.
- **Fixtures.** `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions`, `fx-lp` y `fx-whale`. `fx-incident` donde se indica.

| Id | Requisitos | Preparación y acción | Esperado |
|---|---|---|---|
| GATE-01 | FR-DEC-003, FR-DEC-004, FR-DEC-006, FR-DEC-012 | `fx-incident` sobre cbBTC con la posición dentro. Revisión. Se repite `decide` cambiando solo las entradas shadow | `RISK_INCIDENT_EXIT`, `DECIDE_EXIT` y `EXIT_RISK_INCIDENT`. `ENY_SHADOW` y `STRATEGY_PREFERENCE` aparecen en el rastro y no cambian la decisión. La repetición da la misma decisión |
| GATE-02 | FR-DEC-005, FR-ENG-013 | Intención `exit` más `manipulate-spot`. Revisiones hasta el final | `close_position` en `confirmed`, con `EHG_PRICE_DIVERGENCE` en `NO_GO` y `EHG_NO_GO_OVERRIDDEN_BY_EXIT` en el rastro. La conversión da `DECIDE_CONVERT_HELD` con `EHG_PRICE_DIVERGENCE`. Cuando el precio se normaliza, `DECIDE_CONVERT`, `convert` en `confirmed` y `EXIT_COMPLETED` |
| GATE-03 | FR-DEC-005, FR-DSH-008 | Intención `exit` y `time-warp` más allá de `validUntil` | Nada firmado. `EXIT_PENDING` con causa `SESSION_EXPIRED`. La vista ofrece renovar y "Leave without Mamoru" |
| GATE-04 | FR-DEC-005 | a) Intención `exit` con la reserva de gas por debajo del mínimo. b) Intención `exit` con la cuenta en la lista negra de USDC, puesta con escritura de storage en la preparación | a) `EXIT_PENDING` con `ACCT_GAS_RESERVE_LOW`. b) La simulación del cierre revierte: `EXIT_PENDING` con `EHG_SIM_REVERT` y `RISK_ACCOUNT_BLOCKLISTED`. En los dos casos, nada firmado |
| GATE-05 | FR-DEC-003 | a) Incidencia en el pool curado sin capital dentro, con USDC libre. b) La misma incidencia con la posición dentro. c) La política de escenario declara el pool con un fee que no es el de la cadena | a) Entrada bloqueada con `PURGA_INCIDENT`. b) Purga da `PURGA_NOT_APPLICABLE` y manda Risk Monitor con `RISK_INCIDENT_EXIT`. c) `PURGA_IDENTITY_MISMATCH` y ninguna entrada |
| GATE-06 | FR-DEC-008, FR-DEC-012 | a) El proxy hace fallar las lecturas de `paused()` y de la lista negra, y la tabla de incidencias no se puede leer. b) USDC en pausa por escritura de storage. c) La cuenta en la lista negra de USDC | a) `PURGA_EVIDENCE_UNKNOWN` y `RISK_EVIDENCE_UNKNOWN`. Entradas bloqueadas, sin `DECIDE_EXIT`. b) `RISK_TOKEN_PAUSED` y entradas bloqueadas. c) `RISK_ACCOUNT_BLOCKLISTED`, entradas bloqueadas y aviso en la vista |
| GATE-07 | FR-ENG-012, FR-DEC-004 | La cuenta en pausa y `fx-incident` sobre cbBTC | La salida sigue: `EXIT_RISK_INCIDENT` y `close_position` en `confirmed` |
| GATE-08 | FR-ENG-013 | Harvest retenido con `hold-at(after_simulate_persist)`. Llega la intención `exit` | El harvest termina `discarded` con `OP_PREEMPTED_BY_EXIT`. La instancia retenida, al soltarse, recibe `SIGN_STATE_INVALID` y termina. La operación siguiente es `close_position` |
| GATE-09 | FR-ENG-013 | Harvest en `submitted` con `bundler-hold`. Llega la intención `exit` | Mientras el harvest está en vuelo: `DECIDE_SLOT_BUSY` y `EXIT_PENDING` con `OP_SLOT_BUSY`. Al soltar, el harvest llega a `confirmed` y la revisión inmediata cierra |

## 11. Salida, pausa y depósito

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Política.** `conservador-lab-v1`.

| Id | Requisitos | Preparación y acción | Esperado |
|---|---|---|---|
| EXIT-01 | FR-ENG-013 | `fx-lp` dos veces: dos posiciones gestionadas. Intención `exit` | Dos `close_position` en revisiones sucesivas, una por revisión. Luego `convert` y `EXIT_COMPLETED`. Sin posiciones y con la cuenta en pausa |
| EXIT-02 | FR-ENG-014, FR-DEC-005, FR-ENG-015 | `fx-lp`, parada antes de firmar en todas las revisiones e intención `exit` | La primera revisión deja el cierre `discarded` con `DRY_RUN_STOP`. `EXIT_PENDING` con causa `DRY_RUN_STOP`. Las posiciones siguen. La revisión siguiente, sin cambio de premisa, es `REVIEW_DEDUPED` y no abre otra operación |
| EXIT-03 | FR-ENG-013, FR-ENG-002 | `fx-lp`, intención `exit` y `do-evict` antes de la primera revisión | Tras el reinicio, `exit_request` sigue en el diario. El cierre llega a `confirmed` |
| PAUSE-01 | FR-ENG-012 | `fx-lp` con comisiones por encima del coste y la cuenta en pausa | `DECIDE_HOLD` con `DECIDE_PAUSED`. Ninguna operación |
| PAUSE-02 | FR-ENG-012 | Harvest en `submitted` con `bundler-hold`. Intención de pausa. Se suelta | El harvest llega a `confirmed`. Ninguna operación nueva. Las revisiones siguientes dan `DECIDE_PAUSED` |
| PAUSE-03 | FR-ENG-012, FR-ENG-016 | Tras PAUSE-01, intención de reanudar | `INTENT_ACCEPTED`. La revisión siguiente da `DECIDE_HARVEST` |
| DEP-01 | FR-RPC-001, FR-DEC-013 | `fx-usdc` sin minar hasta `safe`. Revisión. Mineo hasta `safe`. Revisión | Primera revisión: `OBS_DEPOSIT_UNSAFE`, ninguna operación. Segunda: `OBS_DEPOSIT_DETECTED` y `DECIDE_ENTER` |
| DEP-02 | FR-ONB-009, FR-DSH-004 | App y motor en modo `lab` con `FUNDS_GATE=closed`. Onboarding completo en el navegador | La vista termina en "Account ready. Deposits are closed." Ni botón ni instrucciones de depósito. La activación de sesiones y `renew_session` responden `FUNDS_GATE_CLOSED`. La cuenta sigue contrafactual |
| DEP-03 | FR-ONB-009, FR-ACC-009 | Como DEP-02, más USDC enviado a la dirección contrafactual. Revisión | `ACCT_COUNTERFACTUAL` y `ACCT_FUNDS_WHILE_CLOSED`. Ninguna operación. La vista enlaza el procedimiento de WALK-04 |
| DEP-04 | FR-DEC-014 | `fx-lp` más `fx-weth` | `OBS_UNMANAGED_ASSET` para WETH. Ninguna llamada con WETH como target |

## 12. Onboarding y aislamiento

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Entorno.**
  - App y motor en modo `lab` sobre workerd local, con D1 local.
  - Pruebas de navegador con autenticador WebAuthn virtual.
  - El login usa el candidato detrás de `ProductAuthPort`.

| Id | Requisitos | Preparación y acción | Esperado |
|---|---|---|---|
| ONB-01 | FR-ONB-001, FR-ONB-002 | Usuario con un solo método de login intenta terminar. Después vincula un segundo método, o verifica un email de recuperación | Primero: `ONB_RECOVERY_REQUIRED` y la cuenta no pasa a `ready`. Después: continúa |
| ONB-02 | FR-ONB-004 | Respaldo sin prueba. Prueba firmada por otra dirección. Prueba correcta | `ONB_BACKUP_UNPROVEN`, `ONB_BACKUP_UNPROVEN` y aceptado |
| ONB-03 | FR-ONB-005 | La API calcula la dirección. El owner despliega en el fork con esos parámetros | `ONB_ADDRESS_MATCH` |
| ONB-04 | FR-VIEW-001, FR-VIEW-004 | `MamoruViewGrant` firmado con la passkey antes del despliegue. Después del despliegue. El owner quita la passkey como owner. Caduca el grant | Grant creado con `erc6492`. Después, re-verificado con `erc1271`. Sin la passkey: `GRANT_INVALID_PROOF`. Caducado: `GRANT_EXPIRED` |
| ONB-05 | FR-ONB-008, FR-ONB-007 | Se comparan el resumen de `GET /api/accounts/:accountKey/session-policy` y los datos de activación que codifica el adaptador. La prueba altera un campo del resumen. También se pide un preset que no sea Conservador | Hashes iguales: `ONB_POLICY_HASH_MATCH`. Con el campo alterado, la prueba detecta la diferencia. El preset ajeno responde `INTENT_REJECTED_STATE` y Conservador sigue siendo el único |
| ONB-06 | FR-ONB-001, FR-VIEW-002 | Con una sesión de producto válida y sin firma del owner, se llama a todas las rutas de la API, enumeradas desde el router | Ninguna produce una firma, una userOp, una activación de sesión ni un movimiento de tokens. Alto recibe cero userOps y el estado de la cuenta no cambia. `relayOwnerOp` rechaza una userOp que no firmó el owner |
| TEN-01 | FR-VIEW-003, FR-VIEW-005 | U2 pide el dashboard de la cuenta A1 | `GRANT_REQUIRED` con estado 403. Ninguna fila de A1 en la respuesta |
| TEN-02 | FR-VIEW-003, FR-ENG-016 | U2 envía `pause` y `exit` a A1 | `GRANT_REQUIRED`. El Durable Object de A1 no recibe nada: su tabla de intenciones no cambia |
| TEN-03 | FR-VIEW-001 | U2 presenta un grant de A1 firmado con su propia passkey, que no es owner de A1 | `GRANT_INVALID_PROOF` |
| TEN-04 | FR-VIEW-005, FR-MB-003 | Entrega sintética de un evento del `tokenId` de A1. Entrega de un evento de una dirección no registrada. Wake hint con un `accountKey` no registrado | Solo despierta A1. A2 no recibe nada. La segunda: `HOOK_UNMAPPED`. La tercera: el motor la rechaza por cuenta no registrada |
| TEN-05 | FR-VIEW-003, FR-VIEW-005 | Manipulación de parámetros: `accountKey` distinto en ruta y cuerpo, mayúsculas y minúsculas de la dirección, prefijo de otro chain id | `GRANT_REQUIRED` en todos los casos. Ninguna fila cruzada. Toda consulta filtra por el `accountKey` del grant |
| TEN-06 | FR-PRJ-008, FR-LAB-013 | Se inserta una fila con `chain_id` 31337 en la D1 de una app en modo `production`, y se lee | La API no la devuelve. El log registra `PROJ_FOREIGN_CHAIN_ROW` |
| TEN-07 | FR-VIEW-006 | Intención con un `Origin` ajeno. Revisión de las cookies de sesión | `AUTH_ORIGIN_REJECTED`. Las cookies llevan `HttpOnly`, `Secure` y `SameSite` |
| TEN-08 | FR-DSH-020, FR-VIEW-003, FR-VIEW-005, FR-PRJ-015 | `fx-second-account` y una sincronización de cuenta de cada una. a) U2 pide `history` de A1. b) U1 pide `history` de A1 con `ref` igual al `tokenId` de A2, con un pool fuera de su política y con una `section` desconocida. c) U1 pide la página siguiente con un `cursor` alterado | a) `GRANT_REQUIRED` con estado 403. b) Las dos primeras: lista vacía, sin filas de A2. La tercera: 400 sin filas. c) Rechazado o vacío, nunca filas de A2. Las filas de pool son las mismas para las dos cuentas. La instancia de cuenta de `ReadModelSync` de A1 solo escribe filas con el `account_key` de A1 |

## 13. Webhook y reorg

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Entregas.** Son sintéticas, rotuladas como tales en la D1 local y firmadas con el secreto de prueba. En el laboratorio no hay entregas reales de MultiBaas.
- **Fixtures.** `fx-owners`, `fx-safe`, `fx-gas`, `fx-sessions` y `fx-lp`.

| Id | Requisitos | Preparación y acción | Esperado |
|---|---|---|---|
| HOOK-01 | FR-MB-003, FR-ENG-011 | Entrega válida de un `Collect` del `tokenId` gestionado | `HOOK_ACCEPTED`. Wake y revisión con observación en un bloque mayor o igual que el del evento. La decisión sale de la RPC |
| HOOK-02 | FR-MB-003 | Firma inválida | 401 con `HOOK_BAD_SIGNATURE`. Ningún wake |
| HOOK-03 | FR-MB-003 | Timestamp fuera de ventana | `HOOK_STALE`. Ningún wake |
| HOOK-04 | FR-MB-003 | La misma entrega dos veces | La segunda: `HOOK_DUPLICATE`. Un solo wake |
| HOOK-05 | FR-MB-003, FR-PRJ-005 | Entrega de un evento cuyo bloque desaparece con `reorg` | El proyector marca la entrega `HOOK_REORGED`. Ningún crédito sale de ella |
| HOOK-06 | FR-ENG-011 | Muchas entregas del mismo pool en una ventana corta | Una revisión. El resto: `HOOK_COALESCED` |
| HOOK-07 | FR-MB-004, FR-ENG-001 | M04 completo sin ninguna entrega | M04 pasa igual, solo con el cron |
| HOOK-08 | FR-ENG-011, FR-PRJ-007 | Entrega bien firmada con un `Collect` cuyo importe y `tokenId` no existen en cadena | La revisión decide con la RPC: `DECIDE_HOLD` según el estado real. Ninguna operación sale del payload. Ninguna fila del Savings Log sale de él |
| HOOK-09 | FR-MB-003 | Evento de una dirección no registrada | `HOOK_UNMAPPED` |
| REORG-01 | FR-ENG-008 | Harvest incluido en el bloque N. `reorg` antes de que N sea `safe`, quitando la inclusión | `RECON_REORGED` y `pending_reconciliation`. Reenvío de los mismos bytes, inclusión en la cadena nueva y `confirmed`. Una sola inclusión canónica |
| REORG-02 | FR-PRJ-005 | Fila del Savings Log en `pending`, incluida pero no `safe`. `reorg` | La fila pasa a `reorged` con `PROJ_REORGED`, sin crédito. Tras la nueva inclusión, fila `confirmed`. El total no cuenta la fila reorganizada |
| REORG-03 | FR-ENG-005 | Observación en el bloque N. `reorg` que reemplaza N antes de firmar | `sign` se niega con `EHG_OBSERVATION_REORGED`. `discarded`. La revisión siguiente observa de nuevo |

## 14. Dashboard e interfaz

- **Fork.** `catalog-v1` · 51811000 · 31337.
- **Entorno.** Proyector del motor en modo `lab`. El lector `fork_rpc` hace de `EventIndexPort`. La API y la SPA sirven desde workerd local.
- **Modelo de lectura.** `ReadModelSync` corre con el lector del fork. Cada escenario fija su ventana `W` y su retención `R`. El runner recalcula las cifras esperadas con `eth_getLogs` y lecturas de anvil sobre la misma ventana, así que "igual al recálculo" es una comparación exacta, no un umbral.

| Id | Requisitos | Preparación y acción | Esperado |
|---|---|---|---|
| DASH-01 | FR-PRJ-002, FR-PRJ-003, FR-PRJ-005 | M04 | Fila `harvest` con principal cero, comisiones del `Collect`, conversión del `Swap` y crédito. Estado `confirmed` y, cuando el lector coincide, `reconciled` (`PROJ_RECONCILED`). Procedencia `journal` y `fork_rpc`. En el laboratorio, el índice también es `fork_rpc` |
| DASH-02 | FR-PRJ-003, FR-PRJ-004 | M08 | Fila `close` con principal igual a la suma de `DecreaseLiquidity`, comisiones igual a `Collect` menos principal y crédito cero. `PROJ_PRINCIPAL_EXCLUDED` |
| DASH-03 | FR-PRJ-006, FR-MB-004 | a) M04 con `index-lag`. b) M04 con el lector de índice desactivado | a) Fila `confirmed` con `PROJ_INDEXER_PENDING` y el crédito aplicado, porque diario y RPC bastan. Pasa a `reconciled` cuando el lector alcanza. b) Los paneles de historia salen de logs RPC con `PROJ_SOURCE_FALLBACK_RPC` y el chip lo dice |
| DASH-04 | FR-PRJ-005 | M04 con `index-wrong` | `indexer_mismatch` con `PROJ_INDEXER_MISMATCH`. Importes y crédito salen de la RPC |
| DASH-05 | FR-PRJ-005, FR-DSH-003 | REORG-02, leído en el payload de la API | La fila está en `reorged` y el resumen la excluye. El texto visible del panel lo acepta T012 |
| DASH-06 | FR-PRJ-009 | Tras M04, el owner retira USDC con una transacción del Safe hasta dejar el saldo por debajo del libro | Disponible igual al saldo. `PROJ_SAVINGS_EXCEEDS_BALANCE`. Se enseñan los dos valores |
| DASH-07 | FR-PRJ-003, FR-UNI-005 | a) El owner hace `decreaseLiquidity` de parte de la posición gestionada sin `collect`. Luego, harvest. b) El owner cobra solo una parte de ese principal y, después, hay otro harvest | a) El crédito son solo las comisiones (`PROJ_PRINCIPAL_EXCLUDED`). b) El primer cobro parcial deja principal pendiente. El harvest siguiente no acredita ese resto como comisión |
| DASH-08 | FR-PRJ-002, FR-DSH-003, FR-DSH-005 | Recorrido del payload del dashboard en los estados de M01, M04 y M09 | Toda cifra lleva `Provenance` completa (`PROJ_PROVENANCE_COMPLETE`). Una cifra sin observar lleva `not_observed` y valor nulo, nunca cero |
| DASH-09 | FR-DSH-012, FR-DEC-015, FR-DEC-013 | `fx-lp`, `fx-owner-position` en el pool curado y `fx-weth`. Versión de política del escenario con `range.adjust = off`. a) Revisión con las dos posiciones en rango. b) `push-out-of-range` saca del rango las dos posiciones. Revisión. c) La ballena devuelve el tick al rango. Revisión. d) Como b), con `range.adjust = on_out_of_range` | a) Actions tiene `OBS_UNMANAGED_ASSET:position:<tokenId del owner>` y `OBS_UNMANAGED_ASSET:token:WETH`, las dos `understand`, y ninguna entrada de rango. b) Aparecen `OBS_POSITION_OUT_OF_RANGE:position:<gestionada>` como `understand`, con el texto de `range.adjust = off`, y `OBS_POSITION_OUT_OF_RANGE:position:<del owner>` como `decide`. La decisión registra los dos códigos en `positions`. Ninguna propuesta toca la posición del owner. c) Las dos entradas de rango desaparecen sin que nadie las descarte. Las de activos no gestionados siguen. d) La entrada de la gestionada lleva el texto de cierre y reentrada y enlaza a Current Action, que enseña `DECIDE_RANGE_ADJUST` |
| DASH-10 | FR-DEC-015, FR-DSH-012, FR-DSH-016 | `fx-lp` y `fx-owner-position`. a) `swaps-in-range` sin llegar al coste. Revisión. b) `swaps-in-range` hasta que las comisiones de las dos posiciones superan el coste estimado por el factor de la política. Revisión. c) El harvest de la gestionada termina. d) El owner cobra su posición con su propia transacción. Revisión | a) Ninguna entrada de comisiones. La gestionada lleva `DECIDE_HARVEST_BELOW_COST` en sus códigos. b) `DECIDE_HARVEST:position:<gestionada>` como `understand` con enlace a Current Action, y `OBS_FEES_ABOVE_COST:position:<del owner>` como `decide` con enlace a la posición. Ninguna entrada ofrece cobrar. Ninguna propuesta para la del owner. c) La entrada de la gestionada desaparece. La del owner sigue. d) La del owner desaparece. Su `Collect` aparece en Your positions como "Not from Mamoru" y no entra en el Savings Log |
| DASH-11 | FR-DSH-012, FR-DSH-006, FR-DSH-013 | `fx-lp`. a) `time-warp` hasta la ventana de renovación de la sesión. b) `time-warp` hasta después de la caducidad. c) Desde a), el owner revoca la sesión. d) Intención `pause`. e) Desde b), intención `exit`. f) SESS-24: una userOp de la sesión fuera de Mamoru | a) `SESSION_RENEWAL_DUE` como `decide` con "Renew session". b) `SESSION_EXPIRED` como `decide` con "Renew session". `SESSION_RENEWAL_DUE` ya no está. c) `SESSION_REVOKED` como `understand`, sin acción. d) `DECIDE_PAUSED` como `decide` con "Resume". Current Action ya no tiene "Pause". e) `EXIT_PENDING` con causa `SESSION_EXPIRED`, con "Renew session" y el enlace "Leave without Mamoru". Current Action enseña "Exit pending" con la causa y ningún botón de renovación. f) `SESSION_FOREIGN_USE` como `critical` con el enlace "Leave without Mamoru", seguida de `DECIDE_PAUSED`. En todos los casos, el orden es `critical`, `decide` y `understand`, y ningún botón de intención aparece dos veces en la página |
| DASH-12 | FR-DSH-012, FR-PRJ-005, FR-PRJ-009 | a) DASH-04. b) DASH-06. Después, el owner devuelve USDC a la cuenta hasta superar el libro. Revisión | a) `PROJ_INDEXER_MISMATCH:savings:<opId>` como `understand`, con enlace a la fila, que dice "Indexer mismatch · chain value shown". b) `PROJ_SAVINGS_EXCEEDS_BALANCE` como `understand`, con enlace a Savings, que enseña el libro y el saldo. Tras la devolución, la entrada desaparece y el disponible vuelve a ser el libro |
| DASH-13 | FR-DSH-013, FR-DSH-012 | Se lee el payload en cada estado de operación de M03, M09, M10, M13 y REORG-01 | Ningún `ActionItem` lleva un código `BUNDLER_*`, `RECON_*`, `OP_*`, `EXEC_*` ni `DRY_RUN_STOP`. Current Action enseña cada estado con su texto de `dashboard.md` §7.3, y `notes` solo contiene `BUNDLER_UNAVAILABLE` o `RECON_TIMEOUT`. `actions` es igual a la función de `@mamoru/projector` aplicada al resto del mismo payload, y la misma entrada da la misma lista |
| DASH-14 | FR-MB-002, FR-PRJ-010, FR-PRJ-011, FR-PRJ-014, FR-PRJ-015, FR-DSH-017, FR-LAB-014 | `swaps-in-range` y `liquidity-change` en el pool curado. Sincronizaciones de pools. a) Lector sano. b) `index-wrong` en el `amount0` de un `Swap`. c) `index-wrong` en el agregado de MBQ-07. d) `index-wrong` en el `tick` del último `Swap` de un tramo. e) `time-warp` más allá de la retención y otra sincronización | a) Swaps recientes, cambios de liquidez y estadísticas iguales al recálculo: número de swaps, volumen por token, comisiones estimadas, ticks mínimo y máximo, y liquidez añadida y retirada. Filas con `check = reconciled`. `proj_pool_activity` no tiene `account_key`. b) La fila se guarda con el valor de la RPC, `check = mismatch` y `PROJ_INDEXER_MISMATCH`. Las estadísticas siguen iguales al recálculo. c) Las estadísticas siguen iguales al recálculo y llevan `MB_QUERY_MISMATCH` en `detail`. d) `MB_QUERY_MISMATCH` en `mb_checks` y el tramo guardado desde la RPC. e) No quedan filas de pool anteriores a `H − R`. Una posición que salió de rango antes de ese bloque tiene `outOfRangeSince = before_retention` |
| DASH-15 | FR-DSH-016, FR-PRJ-003, FR-PRJ-012, FR-PRJ-013 | `fx-lp`. `swaps-in-range` con revisiones. M04. El owner hace `decreaseLiquidity` de una parte, como en DASH-07. `push-out-of-range` y revisión. Variante: antes de una sincronización se borra de la D1 local la fila `increase` de la posición | Liquidez según eventos igual a `positions(tokenId).liquidity` en `H`. Comisiones cobradas iguales a `Collect` menos principal. Movimiento de comisiones igual a la diferencia entre las instantáneas más lo cobrado en la ventana. Tiempo en rango igual al recálculo. "Out of range since" es el bloque del `Swap` que sacó el tick. Solo son "Mamoru" los eventos cuya transacción está en el diario: el `decreaseLiquidity` del owner es "Not from Mamoru". Una posición acuñada dentro de la ventana enseña su movimiento de comisiones desde su bloque. Variante: el invariante falla, `historyComplete = false`, "History incomplete" con `PROJ_INDEXER_MISMATCH`, la liquidez sale de la RPC y Actions tiene `PROJ_INDEXER_MISMATCH:position:<tokenId>` |
| DASH-16 | FR-DSH-014, FR-DSH-015, FR-RPC-005, FR-UNI-001 | a) M01. b) M02 con `fx-weth` y `fx-gas` en su variante `extra`. c) M04. d) GATE-02, leído mientras la conversión espera. e) Como b), con el proxy fallando `slot0` del pool USDC/cbBTC | a) Saldos a cero leídos, cada uno con su chip, y un total. b) USDC y cbBTC "In your plan", WETH "Not managed by Mamoru" y ETH "Gas only, not invested" con `OBS_ETH_NOT_INVESTED`. Cada valor es el saldo por el precio de `slot0` del pool de precio en el mismo bloque, en USDC y rotulado "Estimate". El total es la suma de saldos y posiciones. Treasury reparte idle, LP y cajón, y enseña gas y fuera del plan aparte. El camino de conversión tiene el texto fijo de `dashboard.md` §7.5. c) El swap de comisiones sale en Treasury como "Harvest conversion", contrastado y marcado "Mamoru". d) Estado `held` con `DECIDE_CONVERT_HELD` y causa `EHG_PRICE_DIVERGENCE`, la entrada `DECIDE_CONVERT_HELD` en Actions y la cotización de QuoterV2 como estimación. e) El total dice "Not observed" y nombra "cbBTC price". En ningún caso una vista ofrece convertir |
| DASH-17 | FR-MB-007, FR-DSH-018, FR-PRJ-006, FR-LAB-014 | DASH-14 a) y M04, con: a) `index-absent`; b) `index-behind`, y después el lector alcanza; c) `index-fail`; d) sin `MULTIBAAS_URL` | En los cuatro casos, las vistas tienen los mismos campos y las mismas cifras que con el lector sano, desde logs RPC con el chip "Base fork RPC logs · block N". a) Cabecera `not_indexing_base`, filas con `cause = MB_BASE_INDEXING_ABSENT` y `mb_aggregate = skipped`. b) Cabecera `behind`. Filas hasta el bloque indexado con `check = reconciled` y el resto con `MB_INDEX_LAGGING`. Cuando el lector alcanza, los tramos nuevos vuelven al lector y las filas guardadas conservan su rótulo. c) Cabecera `failing` y filas con `MB_QUERY_FAILED`. d) Cabecera `not_configured` y `PROJ_SOURCE_FALLBACK_RPC`. Ningún estado del índice vacía una vista ni crea una entrada en Actions |
| DASH-18 | FR-DSH-010, FR-DSH-011, FR-PRJ-008 | a) Recorrido del payload y del DOM en los estados de M01, M04 y DASH-14, en modo `lab`. b) App en modo `production` con filas de 8453 en la D1 local y la fila de 31337 de TEN-06 | a) Toda `Provenance` lleva `chainId` 31337 y todo chip dice "Base fork". `chains` tiene una sola entrada. b) Toda `Provenance` lleva 8453 y todo chip dice "Base". `chains` tiene una sola entrada, Base (8453), y la cabecera dice "Other chains: not observed in v1." Ninguna cifra, ni un cero, lleva otra chain. La fila de 31337 no aparece |
| DASH-19 | FR-MB-007, FR-PRJ-010, FR-PRJ-012 | `fx-owner-position` acuñada antes de B. `index-start(B)`, con B posterior a `H − R`. Sincronizaciones de pools y de cuenta | Los tramos anteriores a B salen de logs RPC con `cause = MB_BEFORE_START_BLOCK` y el chip de esa causa. Los posteriores salen del lector con `check = reconciled`. La cabecera sigue en `indexing`. La historia de la posición del owner está completa y su invariante de liquidez se cumple |
| UI-01 | FR-DSH-004, FR-ONB-009 | App en modo `production` con filas de chain 8453 en la D1 local. Navegador por las tres rutas | El banner "Simulation mode. Mamoru plans and simulates. It does not sign or send transactions. Deposits are closed." aparece en todas. Ningún botón de depósito. Current Action dice "Simulated, not sent" con `DRY_RUN_STOP` |
| UI-02 | FR-DSH-004, FR-DSH-007 | App en modo `lab`. Navegador por las tres rutas | La banda "Simulation · Base fork · Block N · Not capital" aparece en todas, con N igual al bloque de la última observación. Ningún enlace a Basescan en el DOM ni en la API (`INV-NO-BASESCAN-LAB`) |
| UI-03 | FR-DSH-005 | a) RPC caída sin proyección previa. b) Proyección vieja | a) Los paneles dicen "Not observed", nunca cero. b) "Stale" con la hora |
| UI-04 | FR-DSH-006 | Clic en Pause. Doble clic en Pause. Clic en Exit | Pendiente solo en Pause. Una sola intención, por clave de idempotencia. Exit pide confirmación antes de enviar |
| UI-05 | FR-DSH-003, FR-DSH-009, FR-RPC-005 | Recorrido de las vistas. Revisión de `src/web/copy` | Chip de procedencia con chain en cada cifra. Las cifras de valor van en USDC y dicen "Estimate". El código de razón aparece junto al texto. Los textos están en inglés, sin raya larga y sin emoji |
| UI-06 | FR-DSH-012, FR-DSH-006, FR-DSH-009 | Navegador en los estados de DASH-09 b), DASH-11 d) y f), y M01. Después, M01 con `rpc-flaky` al leer la sesión | La lista del DOM tiene las entradas del payload, en su orden, cada una con título, texto y código de razón. "Resume" y "Renew session" tienen su propio estado pendiente y mandan una sola intención por clave de idempotencia. Ninguna entrada tiene un botón de convertir, vender, cobrar o depositar. En M01: "Nothing needs your decision." Con la sesión sin observar: "Mamoru could not check everything. Not observed: " y la sesión |
| UI-07 | FR-DSH-002, FR-DSH-005, FR-PRZ-003, FR-ONB-009 | App en modo `production` con una cuenta contrafactual vacía de 8453 y filas de pool de 8453 en la D1 local. Navegador por `/dashboard` | Las vistas aparecen en el orden de FR-DSH-002. Los estados vacíos dicen exactamente "No positions. Deposits are closed.", "Nothing in your treasury yet. Deposits are closed.", "No savings yet. Deposits are closed.", "No harvests yet. In simulation mode Mamoru collects nothing." y "No operations on Base yet. In simulation mode Mamoru sends nothing." "Pools in your plan" enseña el pool curado. "Pause" y "Exit" están deshabilitados con "Nothing to manage. Deposits are closed." Ninguna vista, texto ni ruta trata votos de DAO, vesting o RWA |
| UI-08 | FR-DSH-019, FR-MB-006, FR-OPS-004 | Navegador por las tres rutas en modo `production` y en modo `lab`, con captura de red. Revisión del bundle de la SPA y de la configuración de `mamoru-app` | Todas las peticiones del navegador van al mismo origen: assets y `/api/*`. Ninguna va a MultiBaas, a la RPC ni al bundler. El bundle no contiene hosts de MultiBaas, de RPC ni de bundler, ni valores con forma de clave. La configuración de `mamoru-app` no tiene `MULTIBAAS_API_KEY` |

## 15. Guardas del laboratorio, dry-run y ciclo de verificación

| Id | Requisitos | Fork | Preparación y acción | Esperado |
|---|---|---|---|---|
| LAB-01 | FR-LAB-003 | escenario con 8453 y otro con 84532; anvil que responde otro chain id | El runner lee el escenario o arranca anvil | `LAB_CHAIN_ID_FORBIDDEN` antes del primer paso |
| LAB-02 | FR-LAB-002 | escenario sin `fork.block` | El runner lee el escenario | `LAB_BLOCK_REQUIRED` |
| LAB-03 | FR-LAB-002 | `catalog-v1` con un hash alterado en el manifiesto | Arranque | `LAB_BLOCK_HASH_MISMATCH` |
| LAB-04 | FR-LAB-004, FR-OPS-005 | `catalog-v1` | anvil de otra versión | `LAB_ANVIL_VERSION_MISMATCH` |
| LAB-05 | FR-LAB-009 | `catalog-v1` | En la preparación, código distinto en una dirección del registro | `LAB_REGISTRY_CODE_MISMATCH` y ningún paso |
| LAB-06 | FR-LAB-007, FR-OPS-004, FR-OPS-006, FR-ACC-007 | `catalog-v1` | Se intenta pasar una URL con clave como argumento de anvil. Se revisan procesos, artefactos y logs. El blob de la session key en el diario no es la clave en claro, y los logs no llevan email, nombre ni la clave | `LAB_KEY_IN_ARGV`. La lista de procesos solo enseña la URL de loopback. Ningún secreto ni dato personal en artefactos ni logs. El blob persistido no coincide con la clave en claro |
| LAB-07 | FR-AA-005, FR-ENG-017 | `catalog-v1` | Bundler fuera de loopback, o apuntando a una RPC que no es anvil | El motor no arranca: `LAB_BUNDLER_NOT_LOCAL` |
| LAB-08 | FR-LAB-010, FR-RPC-002 | `catalog-v1` | a) Sin precompile y con el verificador de respaldo sin código. b) El proxy quita `eth_simulateV1` | a) `LAB_P256_UNAVAILABLE`. Los escenarios con passkey se marcan no ejecutados con ese código, nunca como pasados. b) `LAB_SIMULATE_UNAVAILABLE` al arrancar. Si se fuerza la ejecución, el motor da `EHG_SIM_UNAVAILABLE` y ninguna operación |
| LAB-09 | FR-LAB-005 | `catalog-v1` | Id de snapshot de otra ejecución | `LAB_SNAPSHOT_FOREIGN` |
| LAB-10 | FR-LAB-004 | `catalog-v1` | Se carga el artefacto de M04 en la versión fijada de anvil y se repite la observación y la decisión | `LAB_REPRO_OK`. Mismo hash de observación y misma decisión |
| LAB-11 | FR-LAB-011 | `catalog-v1` | a) `crash-at` en modo `lab`. b) Motor en modo `production` con `FAULT_POINTS` puesto. c) Revisión estática de la build de producción | a) `LAB_FAULT_INJECTED` en el log. b) `CONFIG_MODE_INVALID` y el motor no arranca. c) No hay camino que active un punto de fallo fuera del modo `lab` |
| DRY-01 | FR-ENG-014, FR-ENG-017 | ninguno: prueba de configuración en el pool de Workers | a) `CORE_DRY_RUN=false`. b) `SIGNING_CHAIN_IDS` con un valor. c) Configuración de producción válida y llamadas directas a `AccountEngine.sign` y a `BundlerPort.send` | a) `CONFIG_DRY_RUN_REQUIRED`. b) `CONFIG_MODE_INVALID`. c) `DRY_RUN_STOP` en las dos llamadas y ninguna llamada de red |
| DRY-02 | FR-ENG-014, FR-RPC-004 | ninguno: un stub de RPC responde chain id 8453; nunca un anvil con 8453 | Motor en modo `lab` contra el stub | `OBS_CHAIN_MISMATCH` al observar y `SIGN_CHAIN_NOT_ALLOWED` al pedir firma |
| DRY-03 | FR-ENG-001, FR-ONB-009 | ninguno: Base en solo lectura | Motor en modo `production` sobre workerd local, con la RPC de Base por entorno y un bundler stub que falla la prueba ante cualquier llamada. Cuenta contrafactual vacía | `DECIDE_HOLD` con `DECIDE_NO_CAPITAL`, `ACCT_COUNTERFACTUAL` y `FUNDS_GATE_CLOSED`. Ninguna operación y cero llamadas al bundler |
| CYCLE-01 | FR-DSH-004, FR-DSH-002, FR-LAB-004 | `catalog-v1` · 51811000 · 31337 | Catálogo `cycle-conservador`: M02, `swaps-in-range`, `liquidity-change` y M04, con la app en el navegador | Secuencia: `OBS_DEPOSIT_DETECTED`; `DECIDE_ENTER` con `enter_swap` en `EXEC_OK`; `DECIDE_ENTER` con `enter_mint` en `EXEC_OK`; `DECIDE_IN_RANGE`; `DECIDE_HARVEST` con `EXEC_OK`; `PROJ_CONFIRMED` o `PROJ_RECONCILED`. Las vistas enseñan cada paso: la posición en Your positions, los swaps y cambios de liquidez en Pools in your plan, la operación en Current Action y el harvest en Savings Log y en Treasury. Banda visible y ningún enlace a Basescan. `docs/fork-verification.md` describe esta misma secuencia como verificación, no como producto |

## 16. Comprobaciones fuera del fork

Estas pruebas no firman. Las que tocan Base son de solo lectura y toman las claves del entorno local, nunca de argv ni de archivos del repo.

| Id | Requisitos | Motivo para no usar fork | Qué hace | Esperado |
|---|---|---|---|---|
| MB-01 | FR-MB-001, FR-MB-002, FR-MB-005, FR-MB-007 | MultiBaas no indexa el fork | 1. Lee del deployment de MultiBaas que la chain es Base (8453) y que tiene enlazados el pool curado, el NonfungiblePositionManager y el EntryPoint con el alias y la etiqueta de `dashboard.md` §6.2. 2. Hace una event query de `Swap` del pool USDC/cbBTC 0.05% en una ventana reciente. 3. Toma el último `Swap` de un bloque B y compara su `sqrtPriceX96` y su `tick` con `slot0()` en el bloque B vía `eth_call`. 4. Guarda la evidencia sin claves en `evidence/multibaas/` | `MB_BASE_INDEXING_OK`. Si no: `MB_BASE_INDEXING_ABSENT` o `MB_QUERY_MISMATCH`, `MULTIBAAS_ENGINE_ENABLED=false` y el README limitado a lo probado |
| MB-02 | FR-MB-002, FR-MB-005, FR-MB-007, FR-MB-008, FR-PRJ-010, FR-PRJ-011, FR-PRJ-014 | MultiBaas no indexa el fork | Con la clave del motor, en Base: 1. Lee el estado del deployment y el de cada contrato enlazado. 2. Ejecuta MBQ-01, MBQ-02 y MBQ-07 del pool curado sobre un rango reciente dentro del índice, con todas sus páginas y sin guardarlas. 3. Contrasta las filas con `eth_getLogs` del mismo rango, ancla el último `Swap` con `slot0()` en su bloque y compara MBQ-07 con las cifras calculadas con las filas. 4. Registra el formato aceptado de `eventName`, de `value` en los filtros y de varios eventos por query, y el `limit` máximo. 5. Lista las queries guardadas, los alias y los webhooks del deployment. Si la clave no puede listarlos, Ot los lista con su sesión y la evidencia lo dice. 6. Guarda la evidencia sin claves | Por query: `PROJ_RECONCILED`, `MB_QUERY_MISMATCH` o `MB_QUERY_FAILED`, con los recuentos de filas de cada fuente. La clave puede leer el estado, ejecutar queries sin guardarlas y listar eventos. Ninguna query guardada, alias ni webhook contiene la dirección de una cuenta de Mamoru. La prueba no escribe en el deployment |
| MB-03 | FR-MB-002, FR-MB-005, FR-PRJ-010, FR-PRJ-012 | MultiBaas no indexa el fork | En Base: 1. Toma un `Mint` reciente del pool curado cuyo `owner` es el NonfungiblePositionManager, posterior al bloque de inicio de su índice, y el `IncreaseLiquidity` de la misma transacción, que da un `tokenId` real. 2. Ejecuta MBQ-03 con ese `tokenId` y MBQ-04 con el `to` del `Transfer` de acuñación, desde el bloque de acuñación. 3. Contrasta con `eth_getLogs` y comprueba el invariante de liquidez con `positions(tokenId)` en `H`. 4. Ejecuta MBQ-06 con la transacción de acuñación y lo compara con los logs del recibo. 5. Guarda la evidencia sin claves | Por query: `PROJ_RECONCILED`, `MB_QUERY_MISMATCH` o `MB_QUERY_FAILED`. El invariante se cumple, o la evidencia registra `PROJ_INDEXER_MISMATCH` |
| MB-04 | FR-MB-002, FR-MB-005, FR-MB-007, FR-PRJ-010 | MultiBaas no indexa el fork | En Base: 1. Toma un `UserOperationEvent` reciente del EntryPoint y su `sender`, una cuenta pública que no es de Mamoru. 2. Ejecuta MBQ-05 con ese `sender` sobre un rango reciente. 3. Toma un `Swap` reciente del pool curado y ejecuta MBQ-08 con su `recipient`. 4. Contrasta con `eth_getLogs`. 5. Mide el retraso del índice del EntryPoint frente al bloque `safe`. 6. Guarda la evidencia sin claves | Por query: `PROJ_RECONCILED`, `MB_QUERY_MISMATCH` o `MB_QUERY_FAILED`. La evidencia registra el retraso medido y, si pasa `MB_MAX_LAG_BLOCKS`, `MB_INDEX_LAGGING` |
| BASE-01 | FR-DSH-010, FR-DSH-011, FR-DSH-014, FR-DSH-017, FR-DSH-019, FR-PRZ-001, FR-ONB-009 | Es producción en solo lectura: la chain es Base | App y motor en modo `production` sobre workerd local, con la RPC de Base y el deployment de MultiBaas por entorno, y un bundler stub que falla la prueba ante cualquier llamada. Cuenta contrafactual vacía, como en DRY-03. Dos ticks de cron. Navegador por `/dashboard` con captura de red | La cabecera dice "Base · 8453", "Not deployed" y el estado del índice. Toda cifra lleva `chainId` 8453. Portfolio enseña ceros leídos con su chip. "Pools in your plan" enseña precio, tick, TWAP, liquidez, saldos y las estadísticas de 24 horas del pool curado, con filas contrastadas o rotuladas. Current Action enseña `DECIDE_HOLD` con `DECIDE_NO_CAPITAL` y `FUNDS_GATE_CLOSED`. Actions no tiene botones de intención. Cero llamadas al bundler. El navegador solo habla con el mismo origen. El payload queda en `evidence/dashboard/` sin claves |
| BASE-02 | FR-DSH-018, FR-MB-007, FR-PRJ-006, FR-MB-005 | Es producción en solo lectura: la chain es Base | BASE-01 con `MULTIBAAS_URL` apuntando a un stub local que responde a) un `chainID` que no es 8453, b) error en todas las queries. c) BASE-01 sin `MULTIBAAS_URL` | Las vistas tienen los mismos campos que en BASE-01, desde logs RPC de Base, y ninguna queda en blanco. a) La cabecera dice "MultiBaas is not indexing Base. History comes from Base RPC logs." y las filas llevan "MultiBaas not indexing Base". b) La cabecera dice "MultiBaas queries are failing. History comes from Base RPC logs." y las filas llevan "MultiBaas query failed". c) "History comes from Base RPC logs." La evidencia queda en `evidence/dashboard/` y el README la cita como prueba del respaldo |
| OPS-01 | FR-OPS-001, FR-OPS-002, FR-OPS-003, FR-OPS-004 | Es configuración | Revisión estática de los dos `wrangler.jsonc` y del repo | El motor no tiene `routes` y lleva `workers_dev: false`. La app tiene `assets` en modo single-page-application con `run_worker_first` para `/api/*` y `/hooks/*`. Hay migración SQLite del Durable Object, Workflows, cron, Service Binding, observabilidad y `limits.cpu_ms`. No hay ningún `wrangler.toml` ni secretos en archivos. `.dev.vars` está en `.gitignore`. No hay configuración de zona |
| OPS-02 | FR-OPS-005 | Es configuración | Revisión de manifiestos y lockfile | Toda dependencia con versión exacta, sin `^`, `~`, `*` ni `latest`. Hay lockfile. Versiones de anvil y Alto en el manifiesto de escenarios. `compatibility_date` fijada |
| OPS-03 | FR-UNI-008 | Es auditoría estática, más los informes de fork | Busca en el código y el lockfile SDKs y hosts de Trading API, LP API, UniswapX, hooks v4, CoW, Tenderly, Aqua y 1inch. Junta `INV-TARGETS` de todos los informes | Ninguna aparición en el camino del capital. `INV-TARGETS` verde en todos los informes |
| DOC-01 | FR-MB-005, FR-DSH-003, FR-PRZ-003, FR-PRZ-004, FR-PRZ-005 | Es documentación | Revisa el README del premio, que es el `README.md` público, y su anexo `docs/multibaas.md`. Comprueba los cinco apartados de `dashboard.md` §12.1. Cruza cada afirmación con su evidencia: informe de escenario, archivos de MB-01 a MB-04, de BASE-01 y de BASE-02, o registro de entregas | Los apartados "One sentence", "How MultiBaas was used", "Team handles", "Setup and tests" y "Experience with MultiBaas" están, exactos y en ese orden. "Team handles" tiene los handles que dio Ot y ningún marcador. "How MultiBaas was used" solo nombra queries con `PROJ_RECONCILED` y lleva la línea "Not covered: DAO votes, vesting schedules and RWA ownership analytics." "Experience with MultiBaas" cuenta todos los resultados de MB-01 a MB-04, fallos incluidos. Ninguna afirmación prohibida de `dashboard.md` §12.3. Toda afirmación tiene evidencia. Una afirmación sin evidencia hace fallar la prueba |

## 17. Matriz de trazabilidad

Cada requisito de la spec aparece en al menos un escenario.

| Requisitos | Escenarios |
|---|---|
| FR-ONB-001, FR-ONB-002 | ONB-01, ONB-06 |
| FR-ONB-003 | WALK-02 |
| FR-ONB-004 | ONB-02 |
| FR-ONB-005 | ONB-03, WALK-04 |
| FR-ONB-006 | WALK-01, WALK-04 |
| FR-ONB-007 | ONB-05, M12 |
| FR-ONB-008 | ONB-05 |
| FR-ONB-009 | DEP-02, DEP-03, UI-01, DRY-03 |
| FR-VIEW-001 | ONB-04, TEN-03 |
| FR-VIEW-002 | ONB-06 |
| FR-VIEW-003 | TEN-01, TEN-02, TEN-05, TEN-08 |
| FR-VIEW-004 | ONB-04 |
| FR-VIEW-005 | TEN-01, TEN-04, TEN-05, TEN-08 |
| FR-VIEW-006 | TEN-07 |
| FR-ACC-001 | WALK-01, M02 |
| FR-ACC-002 | M11, SESS-20 |
| FR-ACC-003 | SESS-01 a SESS-03, SESS-05, SESS-06, SESS-17, SESS-18 |
| FR-ACC-004 | SESS-04, SESS-08, SESS-10, SESS-12 a SESS-16, SESS-21, SESS-23 |
| FR-ACC-005 | SESS-07, SESS-08, revisión de §12.3 del plan |
| FR-ACC-006 | SESS-11, SESS-16 |
| FR-ACC-007 | JRNL-04, LAB-06 |
| FR-ACC-008 | SESS-09 |
| FR-ACC-009 | WALK-01, WALK-02, WALK-04, WALK-05, DEP-03 |
| FR-ACC-010 | SESS-25, M03 |
| FR-ACC-011 | SESS-24, JRNL-06 |
| FR-ENG-001 | HOOK-07, DRY-03 |
| FR-ENG-002 | JRNL-08, EXIT-03 |
| FR-ENG-003 | M10 |
| FR-ENG-004 | todos los escenarios de fork con operación (`INV-CODES`) |
| FR-ENG-005 | JRNL-01 a JRNL-04, REORG-03 |
| FR-ENG-006 | M09, JRNL-05, RETRY-02, RETRY-03 |
| FR-ENG-007 | JRNL-05, JRNL-06, JRNL-09, WALK-05 |
| FR-ENG-008 | M04, REORG-01 |
| FR-ENG-009 | JRNL-07 |
| FR-ENG-010 | M09, JRNL-01 |
| FR-ENG-011 | HOOK-01, HOOK-06, HOOK-08, WALK-03 |
| FR-ENG-012 | PAUSE-01 a PAUSE-03, GATE-07 |
| FR-ENG-013 | M07 a M09, GATE-02, GATE-08, GATE-09, EXIT-01, EXIT-03 |
| FR-ENG-014 | M13, EXIT-02, DRY-01, DRY-02 |
| FR-ENG-015 | M02, M11, M14 |
| FR-ENG-016 | PAUSE-03, TEN-02 |
| FR-ENG-017 | M06, LAB-07, DRY-01 |
| FR-DEC-001 | M01 |
| FR-DEC-002 | M07 |
| FR-DEC-003 | GATE-01, GATE-05 |
| FR-DEC-004 | GATE-01, GATE-07 |
| FR-DEC-005 | GATE-02 a GATE-04, EXIT-02 |
| FR-DEC-006 | M12, GATE-01 |
| FR-DEC-007 | M01, M02, M12 |
| FR-DEC-008 | GATE-06 |
| FR-DEC-009 | M04 |
| FR-DEC-010 | M14 |
| FR-DEC-011 | GATE-08, GATE-09, EXIT-01 |
| FR-DEC-012 | GATE-01, GATE-06 |
| FR-DEC-013 | M01, DEP-01, DASH-09 |
| FR-DEC-014 | M06, M11, DEP-04, WALK-03 |
| FR-DEC-015 | DASH-09, DASH-10 |
| FR-UNI-001 | M03, RETRY-06 |
| FR-UNI-002 | M02, M03, SESS-01, SESS-22 |
| FR-UNI-003 | M02, M07, M14, SESS-02, SESS-03 |
| FR-UNI-004 | M07, M08, M14 |
| FR-UNI-005 | M04, DASH-07 |
| FR-UNI-006 | M02, M03, SESS-07, SESS-08 |
| FR-UNI-007 | `INV-TARGETS` en todos los escenarios de fork, LAB-05 |
| FR-UNI-008 | SESS-10, SESS-22, OPS-03 |
| FR-UNI-009 | M11, GATE-02 |
| FR-RPC-001 | M01, DEP-01, RETRY-01 |
| FR-RPC-002 | M03, LAB-08 |
| FR-RPC-003 | DRY-03, prueba de contrato del puerto |
| FR-RPC-004 | M06, SESS-19, DRY-02 |
| FR-RPC-005 | UI-05, DASH-16 |
| FR-AA-001, FR-AA-002 | M03 |
| FR-AA-003 | M09, JRNL-02, RETRY-02, RETRY-04 |
| FR-AA-004 | M03 |
| FR-AA-005 | LAB-07 |
| FR-MB-001 | MB-01 |
| FR-MB-002 | MB-01 a MB-04, DASH-14 |
| FR-MB-003 | HOOK-01 a HOOK-05, HOOK-09, TEN-04 |
| FR-MB-004 | HOOK-07, DASH-03 |
| FR-MB-005 | MB-01 a MB-04, BASE-02, DOC-01 |
| FR-MB-006 | UI-08, TEN-08 |
| FR-MB-007 | MB-01, MB-02, MB-04, DASH-17, DASH-19, BASE-02 |
| FR-MB-008 | MB-02 |
| FR-PRJ-001 | RETRY-05 |
| FR-PRJ-002 | DASH-01, DASH-08 |
| FR-PRJ-003 | M04, M08, DASH-02, DASH-07 |
| FR-PRJ-004 | M08, M10, DASH-02 |
| FR-PRJ-005 | M10, DASH-01, DASH-04, DASH-05, REORG-02 |
| FR-PRJ-006 | DASH-03, DASH-17, BASE-02 |
| FR-PRJ-007 | HOOK-08 |
| FR-PRJ-008 | TEN-06, DASH-18 |
| FR-PRJ-009 | DASH-06, DASH-12 |
| FR-PRJ-010 | DASH-14, DASH-19, MB-02 a MB-04 |
| FR-PRJ-011 | DASH-14, MB-02 |
| FR-PRJ-012 | DASH-15, DASH-19, MB-03 |
| FR-PRJ-013 | DASH-15 |
| FR-PRJ-014 | DASH-14, MB-02 |
| FR-PRJ-015 | DASH-14, TEN-08 |
| FR-DSH-001 | UI-01, UI-02, OPS-01 |
| FR-DSH-002 | M12, UI-05, UI-07, CYCLE-01 |
| FR-DSH-003 | DASH-05, DASH-08, UI-05, DOC-01 |
| FR-DSH-004 | M13, UI-01, UI-02, DEP-02, CYCLE-01 |
| FR-DSH-005 | DASH-08, UI-03, UI-07 |
| FR-DSH-006 | UI-04, DASH-11, UI-06 |
| FR-DSH-007 | UI-02 |
| FR-DSH-008 | GATE-03 |
| FR-DSH-009 | UI-05, UI-06 |
| FR-DSH-010 | DASH-18, BASE-01 |
| FR-DSH-011 | DASH-08, DASH-18, BASE-01 |
| FR-DSH-012 | DASH-09 a DASH-13, UI-06 |
| FR-DSH-013 | DASH-11, DASH-13, UI-01 |
| FR-DSH-014 | DASH-16, BASE-01 |
| FR-DSH-015 | DASH-16 |
| FR-DSH-016 | DASH-10, DASH-15 |
| FR-DSH-017 | DASH-14, BASE-01 |
| FR-DSH-018 | DASH-17, BASE-02, UI-03 |
| FR-DSH-019 | UI-08, BASE-01 |
| FR-DSH-020 | TEN-08 |
| FR-PRZ-001 | BASE-01, DOC-01 |
| FR-PRZ-002 | DOC-01, revisión de `dashboard.md` §1 y §11, aceptada en T018 |
| FR-PRZ-003 | UI-07, DOC-01 |
| FR-PRZ-004 | DOC-01 |
| FR-PRZ-005 | DOC-01 |
| FR-LAB-001 | OPS-01, revisión del runner |
| FR-LAB-002 | M05, LAB-02, LAB-03 |
| FR-LAB-003 | M06, SESS-19, LAB-01 |
| FR-LAB-004 | M05, LAB-04, LAB-10, CYCLE-01 |
| FR-LAB-005 | M05, LAB-09 |
| FR-LAB-006 | M01, M05 |
| FR-LAB-007 | LAB-06 |
| FR-LAB-008 | revisión de este documento, aceptada en T003 |
| FR-LAB-009 | LAB-05 |
| FR-LAB-010 | LAB-08, WALK-02 |
| FR-LAB-011 | LAB-11 |
| FR-LAB-012 | M05 |
| FR-LAB-013 | TEN-06 |
| FR-LAB-014 | DASH-14, DASH-17, DASH-19 |
| FR-OPS-001 a FR-OPS-004 | OPS-01, LAB-06 |
| FR-OPS-005 | OPS-02, LAB-04 |
| FR-OPS-006 | LAB-06 |
