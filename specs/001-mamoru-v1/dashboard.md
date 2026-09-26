# Dashboard 001 · Mamoru v1

- Spec: `specs/001-mamoru-v1/spec.md` (FR-DSH, FR-PRJ, FR-MB, FR-PRZ)
- Plan: `specs/001-mamoru-v1/plan.md` (§23, plan de consultas del dashboard)
- Escenarios: `specs/001-mamoru-v1/scenarios.md` (§14 y §16)
- Fecha: 2026-09-26

Este documento especifica el dashboard de producción de Mamoru v1 en Base. Es la superficie de producto y la entrega al premio Best Digital Asset Dashboard de Curvegrid. Para cada vista dice qué pregunta responde, qué campos enseña, de qué event query de MultiBaas y de qué lectura RPC sale cada cifra, qué enseña cuando falta un dato y qué puede hacer el usuario.

Tres reglas de la ley enmarcan todo el documento:

- **Modo de seguridad.** Producción corre en dry-run hasta T-000025: Mamoru observa, decide y simula, y no firma ni envía. El dashboard lo dice y enseña lo que Mamoru haría. Es una salvaguarda, no una función del producto.
- **MultiBaas es el modelo de lectura.** Alimenta la historia y la analítica de las vistas, siempre contrastado con la RPC de Base. No firma, no decide y nunca es la única prueba de que algo liquidó (FR-MB-004). Si discrepan, manda la RPC.
- **El fork es el plano de verificación.** Corre el mismo dashboard con una banda fija para comprobar el ciclo completo. No es el producto ni se presenta como tal.

La interfaz está en inglés. Los textos entre comillas son la copia exacta.

## 1. Qué responde el dashboard

| Punto del brief | Vista | Requisitos | Escenarios |
|---|---|---|---|
| El usuario entiende cuánto vale lo que hay en su smart account | Cabecera (§7.1), Portfolio (§7.4) y Treasury (§7.5) | FR-DSH-010, FR-DSH-014, FR-DSH-015 | DASH-16, DASH-18, BASE-01 |
| El usuario ve lo que pide una decisión suya | Actions (§7.2) | FR-DSH-012 | DASH-09 a DASH-12, UI-06 |
| El usuario ve la decisión operativa que Mamoru tomará o ya tomó, con su código | Current Action (§7.3) | FR-DSH-013 | DASH-13, UI-01, BASE-01 |
| Analítica DeFi real: swaps recientes, liquidez, movimiento de comisiones y estado de rango, de las posiciones de la cuenta y de los pools curados, desde event queries de MultiBaas contrastadas con la RPC | Pools and positions (§7.6) | FR-DSH-016, FR-DSH-017, FR-MB-002, FR-PRJ-010 a FR-PRJ-014 | DASH-14, DASH-15, DASH-19, MB-02, MB-03 |
| Tesorería: idle, LP, cajón de ahorro y camino de conversión, que sigue en Uniswap V3 | Treasury (§7.5) | FR-DSH-015 | DASH-16 |
| Cada cifra lleva su chain. v1 enseña Base y ningún saldo inventado en otras chains | Procedencia (§5) y cabecera (§7.1) | FR-DSH-010, FR-DSH-011 | DASH-18, BASE-01 |
| Votos de DAO, calendarios de vesting y analítica de propiedad de RWA quedan fuera | Ninguna vista (§13) | FR-PRZ-003 | UI-07, DOC-01 |

## 2. Reglas de la vista

1. **Procedencia con chain.** Cada cifra dice de dónde sale y de qué chain, con un chip (FR-DSH-003, FR-DSH-011).
2. **Nada inventado.** Un dato que falta se muestra como "Not observed", nunca como cero. Un cero leído en un bloque es una cifra real y lleva su chip. Un libro vacío se muestra con su texto de estado vacío (FR-DSH-005).
3. **Modo de seguridad rotulado.** Producción enseña el banner mientras dure el dry-run. El plano de verificación enseña su banda (FR-DSH-004).
4. **Sin Basescan en el plano de verificación.** Producción solo enlaza transacciones y direcciones de Base (FR-DSH-007).
5. **Código visible.** El código de razón aparece junto al texto que lo explica (FR-DSH-009).
6. **Estilo de la copia.** En inglés, sin raya larga y sin emoji. Un error dice qué pasó, por qué y qué hacer. Un estado vacío dice qué es la sección, por qué está vacía y cómo empieza. Un botón empieza con un verbo.
7. **La vista no firma.** Los botones mandan intenciones existentes (`preset`, `pause`, `exit` y `renew_session`). Cada botón tiene su propio estado pendiente y ningún botón de intención aparece dos veces en la página (FR-DSH-006).
8. **El navegador solo habla con la API.** La SPA nunca llama a MultiBaas, a la RPC ni al bundler. Las vistas del dashboard se sirven solo desde D1 (FR-DSH-019, FR-MB-006).
9. **Contraste antes de enseñar.** Una fila de MultiBaas se enseña como contrastada solo después de compararla con la RPC en el mismo rango (FR-PRJ-010).
10. **Una fuente caída no vacía una vista.** Sin MultiBaas, la historia sale de logs RPC y el chip lo dice. Sin RPC, las cifras de estado dicen "Not observed" y la historia guardada se enseña como vieja (FR-DSH-018).
11. **Importes legibles.** La API devuelve enteros en la unidad mínima del token. La SPA formatea con los decimales del registro (USDC 6, cbBTC 8, WETH y ETH 18) y enseña al lado el valor en USDC cuando existe. Las direcciones y los hashes se pueden copiar y, en producción, abrir en Basescan.

## 3. Rutas y estructura

| Ruta | Contenido |
|---|---|
| `/` | Qué es Mamoru, estado del modo de seguridad y acceso al login |
| `/onboarding` | Login recuperable, passkey owner, respaldo, dirección, grant de vista, kit de recuperación, Conservador y resumen de permisos |
| `/dashboard` | Las vistas de la lista siguiente |

Orden del dashboard, de arriba abajo:

1. Banner del modo de seguridad (producción) o banda del plano de verificación. Fija y no se puede cerrar.
2. Cabecera de cuenta (§7.1).
3. Actions (§7.2).
4. Current Action (§7.3).
5. Portfolio (§7.4).
6. Treasury (§7.5).
7. Pools and positions (§7.6), con las secciones "Your positions" y "Pools in your plan".
8. Savings (§7.7).
9. Savings Log (§7.8).
10. "Leave without Mamoru" y el kit de recuperación (§7.9).

Portfolio, Savings, Current Action y Savings Log son los cuatro paneles de la ley y conservan su nombre. No hay rutas nuevas. La SPA puede guardar en los parámetros de búsqueda de `/dashboard` la posición o el pool abiertos y el cursor del historial. Esos parámetros solo eligen qué pedir a la API, y la API los valida contra el grant (FR-DSH-020).

## 4. Banner y banda

| Modo | Copia exacta | Dónde |
|---|---|---|
| Producción | "Simulation mode. Mamoru plans and simulates. It does not sign or send transactions. Deposits are closed." | Todas las rutas, fijo arriba |
| Plano de verificación | "Simulation · Base fork · Block N · Not capital" | Todas las rutas, fijo arriba. N es el bloque de la última observación |

El banner describe la salvaguarda del dry-run. No se retira antes de T-000025 y la copia no lo presenta como una función. En producción, una operación parada por el dry-run se rotula "Simulated, not sent" con `DRY_RUN_STOP`. El banner no depende de datos: lo pinta la SPA según el modo que devuelve la API.

## 5. Procedencia

```ts
type Provenance = {
  source: 'chain_rpc' | 'fork_rpc' | 'multibaas' | 'journal' | 'd1' | 'estimate'
  chainId: number                    // chain de la cifra; en producción, siempre 8453
  blockNumber?: number
  blockHash?: `0x${string}`
  observedAt: string                 // ISO 8601 en UTC
  status: 'fresh' | 'stale' | 'not_observed'
  detail?: ReasonCode                // p. ej. PROJ_SOURCE_FALLBACK_RPC o PROJ_INDEXER_MISMATCH
  cause?: ReasonCode                 // causa del respaldo: MB_BASE_INDEXING_ABSENT, MB_INDEX_LAGGING, MB_QUERY_FAILED o MB_BEFORE_START_BLOCK
  check?: 'reconciled' | 'mismatch'  // solo en filas de historia: resultado del contraste del índice con la RPC
  checkedAt?: number                 // bloque que cerró el rango contrastado
}

type Figure<T> = { value: T | null; unit?: string; provenance: Provenance }
```

El chip se compone con el nombre de la chain que da `chains` (§7.1): "Base" para 8453 y "Base fork" para 31337 y 31338.

| Caso | Chip en producción | Chip en el plano de verificación |
|---|---|---|
| Lectura RPC en un bloque | "Base · block N" | "Base fork · block N" |
| Fila del índice contrastada (`check = reconciled`) | "MultiBaas · Base · checked at block N" | "Fork index · Base fork · checked at block N" |
| Fila de logs RPC por respaldo (`PROJ_SOURCE_FALLBACK_RPC`) | "Base RPC logs · block N" más la nota de la causa | "Base fork RPC logs · block N" más la nota de la causa |
| Fila con discrepancia (`check = mismatch`) | "Base · block N · MultiBaas disagreed" | "Base fork · block N · Fork index disagreed" |
| Diario | "Mamoru journal · Base" | "Mamoru journal · Base fork" |
| Dato de producto en D1 | "Mamoru database · Base" | "Mamoru database · Base fork" |
| Estimación | "Estimate · Base · block N" | "Estimate · Base fork · block N" |

Notas de la causa del respaldo:

| `cause` | Nota |
|---|---|
| `MB_INDEX_LAGGING` | "MultiBaas behind" |
| `MB_QUERY_FAILED` | "MultiBaas query failed" |
| `MB_BEFORE_START_BLOCK` | "before MultiBaas start" |
| `MB_BASE_INDEXING_ABSENT` | "MultiBaas not indexing Base" |
| sin causa: índice sin configurar | ninguna |

Reglas del estado:

- **`fresh`.** La cifra viene de la última observación o de la última sincronización.
- **`stale`.** La proyección tiene más de dos intervalos de cron. La vista enseña "Stale · updated HH:MM UTC".
- **`not_observed`.** No hay dato. El valor es nulo y la vista enseña "Not observed".

Una cifra sin `Provenance`, o con un `chainId` que no es el de la app, hace fallar DASH-08 y DASH-18.

## 6. Modelo de lectura: MultiBaas, RPC y D1

Solo el Workflow `ReadModelSync` del motor llama a MultiBaas. Escribe en D1 filas ya contrastadas con la RPC. La API solo lee D1. El plan de consultas, con cadencia, payloads y presupuesto, está en el plan §23.

### 6.1 Quién manda

| Fuente | Manda sobre | Se usa para | Nunca se usa para |
|---|---|---|---|
| RPC de Base (`chain_rpc`) | Saldos, posiciones, owners, sesiones, nonces, inclusión, estado de los pools y eventos canónicos | Observación, simulación, confirmación, contraste de cada fila del índice, importes del Savings Log y respaldo de la historia | |
| Diario (`journal`) | Ciclo de la operación, decisiones, pausa y salida | Current Action, tipo de fila del Savings Log y qué operaciones son de Mamoru | Saldos |
| MultiBaas (`multibaas`) | Nada | Historia y analítica de pools, posiciones, operaciones y swaps de la cuenta, eventos decodificados de una transacción y wake hints | Decidir, confirmar, acreditar por sí solo o firmar |
| D1 (`d1`) | Identidad, grants, preferencias e incidencias del operador | Servir la vista | Decidir. Solo las incidencias entran en la observación, con su procedencia |
| Estimación (`estimate`) | Nada | Valor en USDC y cotización del camino de conversión | Pasar por dato de cadena |
| Fork (`fork_rpc`) | Todo lo del plano de verificación | Verificación | Producción |

Reglas de conflicto:

1. La RPC gana a MultiBaas. Si discrepan, la fila se enseña con el valor de la RPC y `check = mismatch`.
2. El diario gana a D1 en el estado de una operación. D1 es proyección.
3. La cadena gana al diario en los fondos. El diario solo dice `confirmed` con el evento en un bloque `safe`.
4. Sin MultiBaas, la historia sale de logs RPC con `PROJ_SOURCE_FALLBACK_RPC` y la causa, y el chip lo dice.

### 6.2 Contratos enlazados en MultiBaas

Ot sube las ABIs y enlaza estos contratos en el deployment de Base con su sesión de administrador, antes de T006. La clave del motor no enlaza nada.

| Alias de dirección | Etiqueta del contrato | Dirección en Base | `startingBlock` al enlazar | Queries |
|---|---|---|---|---|
| `mamoru-pool-usdc-cbbtc-500` | `uniswap-v3-pool` | `0xfbb6eed8e7aa03b138556eedaf5d271a5e1e43ef` | `-302400`, siete días antes del enlace | MBQ-01, MBQ-02, MBQ-07, MBQ-08 |
| `mamoru-npm` | `uniswap-v3-npm` | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `latest` | MBQ-03, MBQ-04 |
| `mamoru-entrypoint-v07` | `erc4337-entrypoint-v07` | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | `latest` | MBQ-05 |

Un pool curado nuevo de otra versión de la política se enlaza igual, con su alias. No se enlazan:

- **USDC y cbBTC.** Sus `Transfer` en Base no alimentan ninguna vista y los saldos salen de la RPC.
- **Las cuentas de usuario.** En el deployment no se guardan direcciones de usuario: ni alias, ni etiquetas, ni queries guardadas, ni webhooks por cuenta (FR-MB-008).

### 6.3 Eventos

Los índices son la posición del argumento en el evento. Los filtros de MultiBaas usan `inputIndex`.

| Contrato | Evento | Argumentos (índice) | Indexados |
|---|---|---|---|
| Pool V3 | `Swap(address,address,int256,int256,uint160,uint128,int24)` | `sender` (0), `recipient` (1), `amount0` (2), `amount1` (3), `sqrtPriceX96` (4), `liquidity` (5), `tick` (6) | `sender`, `recipient` |
| Pool V3 | `Mint(address,address,int24,int24,uint128,uint256,uint256)` | `sender` (0), `owner` (1), `tickLower` (2), `tickUpper` (3), `amount` (4), `amount0` (5), `amount1` (6) | `owner`, `tickLower`, `tickUpper` |
| Pool V3 | `Burn(address,int24,int24,uint128,uint256,uint256)` | `owner` (0), `tickLower` (1), `tickUpper` (2), `amount` (3), `amount0` (4), `amount1` (5) | `owner`, `tickLower`, `tickUpper` |
| NonfungiblePositionManager | `IncreaseLiquidity(uint256,uint128,uint256,uint256)` | `tokenId` (0), `liquidity` (1), `amount0` (2), `amount1` (3) | `tokenId` |
| NonfungiblePositionManager | `DecreaseLiquidity(uint256,uint128,uint256,uint256)` | `tokenId` (0), `liquidity` (1), `amount0` (2), `amount1` (3) | `tokenId` |
| NonfungiblePositionManager | `Collect(uint256,address,uint256,uint256)` | `tokenId` (0), `recipient` (1), `amount0` (2), `amount1` (3) | `tokenId` |
| NonfungiblePositionManager | `Transfer(address,address,uint256)` | `from` (0), `to` (1), `tokenId` (2) | los tres |
| EntryPoint v0.7 | `UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)` | `userOpHash` (0), `sender` (1), `paymaster` (2), `nonce` (3), `success` (4), `actualGasCost` (5), `actualGasUsed` (6) | `userOpHash`, `sender`, `paymaster` |
| EntryPoint v0.7 | `UserOperationRevertReason(bytes32,address,uint256,bytes)` | `userOpHash` (0), `sender` (1), `nonce` (2), `revertReason` (3) | `userOpHash`, `sender` |

En USDC/cbBTC 0.05%, token0 es USDC y token1 es cbBTC. Una posición está en rango si `tickLower <= tick < tickUpper`.

### 6.4 Catálogo de queries

Todas las queries salvo MBQ-06 son event queries arbitrarias (`POST /api/v0/queries`) que no se guardan en el deployment. Todas filtran por dirección de contrato y por un rango cerrado de bloques [`from`, `to`], y ordenan por bloque ascendente. Seleccionan siempre `block_number`, `block_hash`, `tx_hash` y `triggered_at`, con los alias `block`, `blockHash`, `txHash` y `at`. Los cuerpos exactos están en el plan §23.4.

Notación de ventanas:

- `H` es el bloque `safe` de la sincronización. Cierra todos los rangos.
- `W` es la ventana de estadísticas (`READ_MODEL_WINDOW_BLOCKS`): 43.200 bloques, 24 horas a 2 segundos por bloque en Base.
- `R` es la retención de filas de pool (`READ_MODEL_RETENTION_BLOCKS`): 302.400 bloques, siete días.
- El cursor es el último bloque ya guardado de esa query y ese alcance.

| Id | Contrato | Evento | Campos, además de los comunes | Filtro | Ventana | Contraste RPC | Vistas |
|---|---|---|---|---|---|---|---|
| MBQ-01 | Pool curado | `Swap` | `sender`, `recipient`, `amount0`, `amount1`, `sqrtPriceX96`, `liquidity`, `tick` | `contract_address` = pool | Del cursor a `H`. La primera vez, desde `H − R` | `eth_getLogs` del pool con el tema de `Swap` en el mismo rango. Ancla: el último `Swap` del rango frente a `slot0()` en su bloque | Pools in your plan: swaps recientes, estadísticas y tiempo en rango. Your positions: "out of range since" |
| MBQ-02 | Pool curado | `Mint` y `Burn` | `event_signature` como `kind`; `owner`, `tickLower`, `tickUpper`, `amount`, `amount0`, `amount1` | `contract_address` = pool | Como MBQ-01 | `eth_getLogs` del pool con los temas de `Mint` y `Burn` | Pools in your plan: cambios de liquidez y liquidez añadida y retirada |
| MBQ-03 | NonfungiblePositionManager | `IncreaseLiquidity`, `DecreaseLiquidity` y `Collect` | `event_signature` como `kind`; por índice: `tokenId` (0), `arg1` (1), `amount0` (2), `amount1` (3) | `contract_address` = NonfungiblePositionManager y `tokenId` (0) igual a uno de los `tokenId` de la cuenta, unidos con `or` | Por `tokenId`: desde su bloque de acuñación, o desde el cursor | `eth_getLogs` del NonfungiblePositionManager con los tres temas y el `tokenId` en el segundo tema. Invariante de liquidez (FR-PRJ-012) | Your positions: eventos, comisiones cobradas y liquidez según eventos. Savings Log: contraste del `Collect` |
| MBQ-04 | NonfungiblePositionManager | `Transfer` | `from`, `to`, `tokenId` | `contract_address` = NonfungiblePositionManager y (`from` (0) = cuenta o `to` (1) = cuenta) | Desde el primer bloque que el motor observó para la cuenta, o desde el cursor | `eth_getLogs` con el tema de `Transfer` y la cuenta en el segundo o en el tercer tema | Your positions: entradas y salidas de posiciones |
| MBQ-05 | EntryPoint v0.7 | `UserOperationEvent` y `UserOperationRevertReason` | `userOpHash`, `sender`, `nonce`, `success`, `actualGasCost`, `revertReason` | `contract_address` = EntryPoint y `sender` (1) = cuenta | Como MBQ-04 | `eth_getLogs` del EntryPoint con la cuenta en el tercer tema | Current Action: "Operations on Base" |
| MBQ-06 | Contratos enlazados | Los eventos de una transacción | `event.name`, `event.signature`, `event.inputs`, `event.contract`, `event.indexInLog` y los datos de `transaction` | `GET /api/v0/events?tx_hash=` | Una transacción | Logs del recibo (`eth_getTransactionReceipt`) de esos contratos, decodificados con las mismas ABIs, por `indexInLog` | Savings Log: eventos decodificados de la fila |
| MBQ-07 | Pool curado | Agregados de `Swap` | `min` y `max` de `tick`; `add` de `amount0` con `amount0 > 0`; `add` de `amount1` con `amount1 > 0`. Agrupa por `contract_address` | `contract_address` = pool | [`H − W`, `H`] | Las mismas cifras calculadas por el motor con las filas ya contrastadas de la ventana | Pools in your plan: contraste de las estadísticas. Nunca es la fuente |
| MBQ-08 | Pool curado | `Swap` | Como MBQ-01 | `contract_address` = pool y `recipient` (1) = cuenta | Como MBQ-04 | `eth_getLogs` del pool con el tema de `Swap` y la cuenta en el tercer tema | Treasury: swaps de la cuenta |

Reglas del catálogo:

- **Solo el servidor pone los parámetros.** Las direcciones salen del registro. Los `tokenId`, de la proyección de la cuenta. La cuenta, del `AccountRecord`. Los rangos, del cursor. Nada sale de una petición del navegador (FR-MB-006).
- **Formato comprobado.** El formato aceptado de `eventName`, el de `value` en los filtros, si una query admite varios eventos y el `limit` máximo los registra MB-02. El constructor de queries usa lo que MB-02 registró. Si una query con varios eventos no se acepta, se parte en una query por evento con el mismo filtro.
- **Paginación.** `limit` es `MB_PAGE_LIMIT`. Se pide la página siguiente con `offset` hasta que una página trae menos filas que `limit`.
- **Sin recuento.** MultiBaas no tiene agregador de recuento. Los recuentos salen de las filas contrastadas.

### 6.5 Contraste

1. **Fila por fila.** Cada rango de MBQ-01 a MBQ-05 y MBQ-08 se lee también con `eth_getLogs` y el mismo filtro. Las filas se emparejan como multiconjunto por hash de bloque, hash de transacción, evento y argumentos decodificados. Una fila de MultiBaas con pareja se guarda con `source = multibaas`, `check = reconciled` y el `logIndex` de la RPC. Un log de la RPC sin pareja, o con argumentos distintos, se guarda con `source = chain_rpc`, `check = mismatch` y `PROJ_INDEXER_MISMATCH`. Una fila de MultiBaas sin log en la RPC no se guarda y queda en `mb_checks` con `MB_QUERY_MISMATCH` (FR-PRJ-010).
2. **Ancla del pool.** El último `Swap` guardado del rango tiene el `sqrtPriceX96` y el `tick` de `slot0()` en su bloque. Si no, la sincronización registra `MB_QUERY_MISMATCH` y ese rango se guarda desde la RPC (FR-PRJ-011).
3. **Invariante de liquidez.** Para cada `tokenId`, la suma de `IncreaseLiquidity` menos la de `DecreaseLiquidity` hasta `H` es igual a `positions(tokenId).liquidity` en `H`. Si no, la historia de la posición se marca incompleta con `PROJ_INDEXER_MISMATCH` y la liquidez se enseña desde la RPC (FR-PRJ-012).
4. **Agregados.** MBQ-07 contrasta las estadísticas calculadas con filas. Si difiere o falla, las estadísticas siguen saliendo de las filas y llevan `MB_QUERY_MISMATCH` o `MB_QUERY_FAILED` en `detail` (FR-PRJ-014).
5. **Eventos de una transacción.** MBQ-06 se compara con los logs del recibo. Si discrepa, la fila del Savings Log enseña los eventos del recibo con `check = mismatch`.
6. **Filas guardadas no se reescriben.** Una fila guardada por respaldo conserva su rótulo aunque MultiBaas vuelva. Solo un reorg la cambia, y entonces pasa a `reorged`.

### 6.6 Elección de fuente y salud del índice

Cada sincronización lee primero el estado del deployment (`GET /api/v0/chains/ethereum/status`) y el estado de indexación de cada contrato enlazado (`GET /api/v0/chains/ethereum/addresses/{alias}/contracts/{label}/status`). Con eso elige la fuente de cada rango (FR-MB-007):

| Condición, por contrato y rango | Fuente del rango | `cause` en la procedencia | Estado del índice en la cabecera |
|---|---|---|---|
| Índice sano: rango entre `startBlockNumber` y `latestBlockNumber` | MultiBaas contrastado | ninguna | `indexing` |
| El deployment no responde `chainID` 8453, o el contrato no está enlazado | Logs RPC | `MB_BASE_INDEXING_ABSENT` | `not_indexing_base` |
| Tramo anterior a `startBlockNumber` | Logs RPC para ese tramo | `MB_BEFORE_START_BLOCK` | sin cambio |
| `latestBlockNumber` más de `MB_MAX_LAG_BLOCKS` por detrás de `H`, o `isProcessingPastLogs` | MultiBaas hasta su bloque; logs RPC para el resto | `MB_INDEX_LAGGING` | `behind` |
| La query responde error o no responde tras los reintentos del paso | Logs RPC | `MB_QUERY_FAILED` | `failing` |
| `MULTIBAAS_URL` o la clave no están configuradas | Logs RPC | ninguna, con `PROJ_SOURCE_FALLBACK_RPC` | `not_configured` |
| La RPC no responde | Nada nuevo. La historia guardada se enseña como vieja | `OBS_RPC_UNAVAILABLE` | sin cambio |

Con un retraso menor que `MB_MAX_LAG_BLOCKS`, el tramo que falta espera a la sincronización siguiente. El estado del índice nunca vacía una vista y nunca crea una entrada en Actions. El motor sigue probando el índice en cada sincronización, así que un rango nuevo vuelve a MultiBaas en cuanto el índice sana.

## 7. Vistas

Cada vista dice su pregunta, sus campos, sus event queries, su comprobación RPC, sus estados vacío y de error, y lo que puede hacer el usuario. Los estados comunes de carga, dato viejo y no observado están en §8.

### 7.1 Cabecera de cuenta

**Pregunta.** ¿Qué cuenta estoy viendo, en qué chain, cuánto vale lo que tiene y de dónde salen los datos?

| Campo | Fuente de verdad | Procedencia en producción | Si falta |
|---|---|---|---|
| Dirección de la cuenta | D1 `accounts`, comprobada contra el factory | `d1`, con `ONB_ADDRESS_MATCH` | No falta tras el onboarding |
| Chain: nombre e id, "Base · 8453" | Configuración de la app | `d1` | No falta |
| Estado: "Not deployed" o "Deployed" | `eth_getCode` en el bloque | `chain_rpc` | "Not observed" |
| Preset y versión de la política | `AccountRecord` y política fijada | `d1` y `journal` | No falta |
| Valor total estimado, en USDC | Suma del total de Portfolio (§7.4) | `estimate` | "Not observed", con la lista de lo que falta: "Missing: cbBTC price" |
| RPC de Base: último bloque observado | Última observación | `chain_rpc` | "Base RPC not responding" |
| Índice: estado y bloque indexado | `mb_sync_state` | `d1`, con el código de §6.6 | "Index status unknown" |
| Chains observadas | `chains` del payload: una entrada, Base (8453) | `d1` | No falta |

Textos fijos:

- Bajo las chains: "Other chains: not observed in v1."
- Estado del índice: `indexing`, "MultiBaas · Base · indexed to block N"; `behind`, "MultiBaas is behind. Newer history comes from Base RPC logs."; `not_indexing_base`, "MultiBaas is not indexing Base. History comes from Base RPC logs."; `failing`, "MultiBaas queries are failing. History comes from Base RPC logs."; `not_configured`, "History comes from Base RPC logs."
- En el plano de verificación, el índice es el lector del fork: "Fork index · Base fork · indexed to block N".

**Event queries.** Ninguna. La cabecera lee el estado del índice que dejó `ReadModelSync`.

**Comprobación RPC.** El estado de despliegue y el bloque salen de la última observación, fijada a número y hash.

**Vacío.** No aplica: la cabecera existe desde el onboarding.

**Error.** "Can't load your account. Mamoru's API did not respond. Try again." con el botón "Try again".

**Acción del usuario.** "Copy address". En producción, "View on Basescan" para la dirección. Ninguna intención.

### 7.2 Actions

**Pregunta.** ¿Qué tengo que decidir o entender ahora?

Actions no es Current Action. Actions lista situaciones de la cuenta, de sus posiciones o de sus datos que piden una decisión del usuario o que tiene que entender. Current Action (§7.3) enseña la operación viva o la siguiente del motor. Una entrada de Actions puede enlazar a Current Action, pero nunca repite el estado de una operación: los códigos `BUNDLER_*`, `RECON_*`, `OP_*`, `EXEC_*` y `DRY_RUN_STOP` no aparecen en Actions (FR-DSH-013).

Tipos de entrada:

- **`critical`.** Hay que actuar ya para proteger la cuenta.
- **`decide`.** La decisión es del usuario. Mamoru no la toma.
- **`understand`.** Mamoru ya actúa o ya no puede actuar. El usuario debe saber por qué.

Catálogo de disparadores. Actions solo contiene entradas de este catálogo.

| Disparador | Código | Tipo | Título | Texto | Acción | Fuente |
|---|---|---|---|---|---|---|
| Uso ajeno de la sesión | `SESSION_FOREIGN_USE` | `critical` | "Revoke Mamoru now" | "Someone used Mamoru's session outside Mamoru. Mamoru paused your account. Revoke the session with your passkey or backup owner." | Enlace "Leave without Mamoru" | `journal` |
| Sesión dentro de la ventana de renovación | `SESSION_RENEWAL_DUE` | `decide` | "Session expires soon" | "Mamoru's session ends at HH:MM UTC. Renew it to keep Mamoru managing your positions." | "Renew session" (`renew_session`) | `chain_rpc` y `journal` |
| Sesión caducada | `SESSION_EXPIRED` | `decide` | "Session expired" | "Mamoru can't act on your positions. Renew the session, or leave without Mamoru." | "Renew session" (`renew_session`) | `chain_rpc` y `journal` |
| Sesión revocada | `SESSION_REVOKED` | `understand` | "Session revoked" | "You revoked Mamoru's session. Mamoru only watches your account now." | Ninguna | `chain_rpc` |
| Posición o token fuera de la política | `OBS_UNMANAGED_ASSET` | `understand` | "Not managed by Mamoru" | Posición: "Mamoru does not manage position #ID. It stays as you left it." Token: "Mamoru does not manage your TOKEN. It stays in your account." | Enlace a la posición o a Portfolio | `chain_rpc` |
| Posición gestionada fuera de rango | `OBS_POSITION_OUT_OF_RANGE` | `understand` | "Position #ID is out of range" | Con `range.adjust = on_out_of_range`: "It earns no fees while out of range. Mamoru will close it at the next review and re-enter around the current price." En cooldown: "It earns no fees while out of range. Mamoru waits until HH:MM UTC before it adjusts again." Con `range.adjust = off`: "It earns no fees while out of range. Mamoru keeps it as it is." | Enlace a Current Action | `journal` y `chain_rpc` |
| Posición no gestionada fuera de rango | `OBS_POSITION_OUT_OF_RANGE` | `decide` | "Position #ID is out of range" | "It earns no fees while out of range. Mamoru does not manage it, so the decision is yours." | Enlace a la posición | `chain_rpc` |
| Comisiones de una posición gestionada por encima del coste | `DECIDE_HARVEST` | `understand` | "Fees above cost on #ID" | "Mamoru will collect them and move them to savings." En modo de seguridad: "Mamoru simulated the collection. Nothing was sent." | Enlace a Current Action | `journal` |
| Comisiones de una posición no gestionada por encima del coste | `OBS_FEES_ABOVE_COST` | `decide` | "Fees ready to collect on #ID" | "Uncollected fees are above the estimated cost to collect them. Mamoru does not manage this position. You can collect them with your owner." | Enlace a la posición | `chain_rpc` y `estimate` |
| Discrepancia en una fila del Savings Log o en la historia de una posición | `PROJ_INDEXER_MISMATCH` | `understand` | "Sources disagree" | "MultiBaas and Base disagree on this record. Mamoru shows the Base value." | Enlace a la fila o a la posición | `chain_rpc` |
| El libro supera el saldo | `PROJ_SAVINGS_EXCEEDS_BALANCE` | `understand` | "Savings above balance" | "Your USDC balance is below your savings record. You may have moved USDC out. Available savings follow your balance." | Enlace a Savings | `journal` y `chain_rpc` |
| Salida pendiente | `EXIT_PENDING`, con la causa | `decide` | "Exit pending" | "Mamoru can't finish your exit: " más el texto de la causa | Si la causa es `SESSION_EXPIRED` o `SESSION_MISSING`, "Renew session" (`renew_session`). Siempre, el enlace "Leave without Mamoru" | `journal` |
| Cuenta en pausa | `DECIDE_PAUSED` | `decide` | "Mamoru is paused" | "Mamoru watches your account but does not enter, collect or adjust. Exits still run." Tras `EXIT_COMPLETED`: "Your exit finished. Mamoru is paused." | "Resume" (`pause` con `paused=false`) | `journal` |
| Fondos con los depósitos cerrados | `ACCT_FUNDS_WHILE_CLOSED` | `decide` | "Funds arrived while deposits are closed" | "Mamoru will not use them. You can withdraw them without Mamoru." | Enlace al procedimiento de WALK-04 | `chain_rpc` |
| Reserva de gas baja con capital gestionado | `ACCT_GAS_RESERVE_LOW` | `decide` | "Add ETH for gas" | "Mamoru pays gas from your account's ETH. Below the reserve it can't act." | Ninguna | `chain_rpc` |
| Restricciones de USDC | `RISK_TOKEN_PAUSED` o `RISK_ACCOUNT_BLOCKLISTED` | `understand` | "USDC restrictions detected" | "Mamoru will not enter new positions." | Ninguna | `chain_rpc` |
| Conversión retenida | `DECIDE_CONVERT_HELD`, con la causa | `understand` | "Conversion waiting" | "Mamoru will convert to USDC when the market is healthy." más el texto de la causa | Enlace a Treasury | `journal` |
| Salida por incidencia | `EXIT_RISK_INCIDENT` | `understand` | "Risk exit" | "Mamoru is closing your positions because of an incident on " más el pool o el token | Enlace a Current Action | `journal` |

Reglas:

1. **Derivación pura.** La API deriva Actions con una función pura de `@mamoru/projector` sobre las demás partes del mismo payload. La SPA no deriva nada y Actions no se guarda (FR-DSH-013).
2. **Orden.** Primero `critical`, después `decide` y después `understand`. Dentro de cada tipo, la más reciente primero. A igualdad, por `id`.
3. **Identidad.** `id` es código, sujeto y referencia: `OBS_POSITION_OUT_OF_RANGE:position:1234`. Una entrada desaparece cuando su condición deja de cumplirse. No se descarta a mano.
4. **Acciones cerradas.** Una entrada lleva como mucho una acción: una intención existente o un enlace. Actions no crea intenciones. Ninguna entrada ofrece convertir, vender, cobrar ni depositar.
5. **Fondos cerrados.** En producción v1 no hay sesiones ni capital, así que no puede aparecer una entrada con botón de intención.
6. **Datos incompletos.** Si un dato del que Actions deriva sus entradas está `not_observed` (la sesión, las posiciones, los saldos o la última decisión), la lista no dice que no hay nada: dice "Mamoru could not check everything. Not observed: " más lo que falta.

**Event queries.** Ninguna propia. Usa lo que ya contrastaron las demás vistas: la historia de posiciones (MBQ-03) para `PROJ_INDEXER_MISMATCH` y las decisiones del diario.

**Comprobación RPC.** Heredada: cada entrada lleva la procedencia de las cifras de las que sale.

**Vacío.** "Nothing needs your decision." Solo si todas las entradas se pudieron observar.

**Error.** "Can't load actions. Mamoru's API did not respond. Try again." con "Try again".

**Acción del usuario.** La de cada entrada. Cada botón tiene su propio estado pendiente y una clave de idempotencia.

### 7.3 Current Action

**Pregunta.** ¿Qué va a hacer Mamoru, qué está haciendo o qué hizo, y por qué?

| Campo | Fuente de verdad | Procedencia |
|---|---|---|
| Operación viva o siguiente: tipo, estado, código y texto | Diario | `journal` |
| Última decisión: tipo, código, bloque de la observación y códigos por posición | Decisión | `journal` |
| Rastro de puertas: Purga, Risk Monitor, Execution Health Gate, ENY y Strategy, con veredicto y código | Decisión | `journal` |
| Anotaciones shadow, rotuladas "Shadow, not used to decide" | Decisión | `journal` |
| "Recent decisions": tipo, código, bloque y hora de cada decisión | Auditoría proyectada en D1 | `journal` |
| "Operations on Base": `userOpHash`, bloque, `success`, coste de gas, "Mamoru" o "Not from Mamoru" | MBQ-05 contrastada, cruzada con el diario | `multibaas` o `chain_rpc`, y `journal` |
| Sesión: "Active until HH:MM UTC", "Renewal due", "Expired", "Revoked" o "No session. Deposits are closed." | Sesiones en cadena y diario | `chain_rpc` y `journal` |
| Pausa y salida: "Paused", "Exit in progress" y "Exit pending: causa" | Diario | `journal` |
| Próxima revisión | `next_review_at` del Durable Object | `journal` |
| Marca "Simulated, not sent" | Estado `discarded` con `DRY_RUN_STOP` | `journal` |

Nombres de estado en la interfaz:

| Estado | Texto |
|---|---|
| `proposed` | "Proposed" |
| `discarded` | "Discarded", o "Simulated, not sent" si el código es `DRY_RUN_STOP` |
| `prepared` | "Prepared" |
| `simulated` | "Simulated" |
| `signed` | "Signed" |
| `submitted` | "Sent" |
| `included` | "Included" |
| `confirmed` | "Confirmed" |
| `failed` | "Failed" |
| `pending_reconciliation` | "Checking the network" |

Notas de operación, solo en Current Action:

| Código | Texto |
|---|---|
| `BUNDLER_UNAVAILABLE` | "Waiting to send." |
| `RECON_TIMEOUT` | "Waiting for the network." |

Los avisos que piden una decisión (`SESSION_FOREIGN_USE`, `EXIT_PENDING`, `ACCT_GAS_RESERVE_LOW`, `ACCT_FUNDS_WHILE_CLOSED` y `RISK_*`) están en Actions. Current Action enseña el estado y enlaza a la entrada.

Botones:

| Botón | Intención | Dónde | Regla |
|---|---|---|---|
| "Pause" | `pause` con `paused=true` | Current Action, si la cuenta no está en pausa | Pendiente propio. Una intención por clave de idempotencia |
| "Exit" | `exit` | Current Action | Pide confirmación. Texto: "Mamoru will close your positions and move them back to USDC in your account." |
| "Resume" | `pause` con `paused=false` | Entrada `DECIDE_PAUSED` de Actions | Pendiente propio |
| "Renew session" | `renew_session` | Entradas de sesión y de `EXIT_PENDING` en Actions | Abre la firma del owner. En producción v1, `FUNDS_GATE_CLOSED` |

En producción v1, "Pause" y "Exit" aparecen deshabilitados con el texto "Nothing to manage. Deposits are closed." La API respondería `INTENT_REJECTED_STATE`.

**Event queries.** MBQ-05 para "Operations on Base". La cuenta va en el filtro como `sender`, y la query no se guarda.

**Comprobación RPC.** Cada operación de la lista está contrastada con `eth_getLogs` del EntryPoint. Una operación es "Mamoru" solo si su `userOpHash` está en el diario. `SESSION_FOREIGN_USE` lo detecta el motor por RPC, no por esta lista.

**Vacío.** Sin decisiones todavía: "Mamoru has not reviewed your account yet. The first review runs within five minutes." Sin operaciones en Base: "No operations on Base yet. In simulation mode Mamoru sends nothing."

**Error.** "Can't load Mamoru's decisions. Try again." Las cifras anteriores siguen visibles como `stale`.

**Acción del usuario.** "Pause" y "Exit". "View transaction" en Basescan para las operaciones incluidas, solo en producción.

### 7.4 Portfolio

**Pregunta.** ¿Qué hay en mi smart account en Base y cuánto vale?

| Campo | Fuente de verdad | Procedencia en producción | Si falta |
|---|---|---|---|
| Saldo de USDC y de cbBTC, rotulados "In your plan" | `balanceOf` en el bloque | `chain_rpc` | "Not observed" |
| Saldo de WETH, rotulado "Not managed by Mamoru" | `balanceOf` en el bloque | `chain_rpc`, con `OBS_UNMANAGED_ASSET` | "Not observed" |
| ETH, rotulado "Gas only, not invested" | `eth_getBalance` en el bloque | `chain_rpc`, con `OBS_ETH_NOT_INVESTED` si pasa la reserva | "Not observed" |
| Valor de cada saldo en USDC | Saldo por precio de `slot0` de los pools de precio del registro, en el mismo bloque | `estimate` | "Not observed" |
| Posiciones: número de gestionadas y no gestionadas, y su valor | Resumen de Pools and positions (§7.6) | `chain_rpc` y `estimate` | "Not observed" |
| Valor total en USDC | Suma de saldos y posiciones valorados | `estimate` | "Not observed", con la lista de lo que falta |
| Asignación frente a preferencia | Saldos, posiciones y la política | `chain_rpc` y versión de la política | "Not observed" |
| USDC sin pool, rotulado "Idle, no executable pool in v1" | Decisión (`PLAN_BUCKET_NO_EXECUTABLE_POOL`) y saldos | `journal` y `chain_rpc` | No falta si hay decisión |
| Activos no gestionados | Observación (`OBS_UNMANAGED_ASSET`) | `chain_rpc` | Lista vacía |

Reglas del valor:

- El valor va en USDC y siempre se rotula como estimación. Precios: cbBTC con `slot0` de USDC/cbBTC 0.05%; ETH y WETH con `slot0` de WETH/USDC 0.3%, que el registro marca como fuente de precio y que ninguna política de producción ejecuta (FR-RPC-005).
- El valor de una posición es tres partes, todas en el mismo bloque: el principal que sigue en liquidez, a precio de `slot0`; el principal ya retirado y todavía no cobrado (`principalOwed`); y las comisiones sin cobrar (`collect` estático menos `principalOwed`). `principalOwed` es capital. Entra en el valor de Portfolio y en el LP de Treasury. No entra en el cajón ni en el crédito de un harvest.
- El total existe solo si todas sus partes están observadas en el mismo bloque. Si falta una, el total dice "Not observed" y nombra la parte.
- Solo se observan los tokens del registro. Texto fijo: "Only tokens in Mamoru's registry are observed: USDC, cbBTC, WETH and ETH."

**Event queries.** Ninguna. El estado de la cuenta sale de la RPC en un bloque.

**Comprobación RPC.** Todas las lecturas van al mismo bloque, con número y hash (FR-RPC-001). La procedencia de cada cifra lleva ese bloque.

**Vacío.** En producción v1 la cuenta es contrafactual y vacía. Portfolio enseña la dirección, "Not deployed", los saldos leídos (ceros reales con su chip) y "No positions. Deposits are closed."

**Error.** RPC caída: cada cifra dice "Not observed". Error de la API: "Can't load your portfolio. Try again."

**Acción del usuario.** Ninguna intención. Enlaces a Treasury y a Pools and positions. Con los depósitos cerrados no hay botón ni dirección para depositar.

### 7.5 Treasury

**Pregunta.** ¿Cómo se reparte mi dinero entre idle, LP y el cajón de ahorro, y cómo vuelve a USDC?

| Campo | Fuente de verdad | Procedencia | Si falta |
|---|---|---|---|
| Idle: USDC fuera del cajón y cbBTC fuera de posiciones, con su valor | Saldo de USDC menos el ahorro disponible (§7.7); saldo de cbBTC | `chain_rpc`, `journal` y `estimate`. Lleva `PLAN_BUCKET_NO_EXECUTABLE_POOL` si aplica | "Not observed" |
| LP: valor de las posiciones gestionadas | Principal en liquidez más `principalOwed` no cobrado, a precio de `slot0`. Las comisiones sin cobrar se muestran aparte y no son ahorro | `chain_rpc` y `estimate` | "Not observed" |
| Cajón de ahorro: disponible | Ahorro disponible de Savings | `journal` y `chain_rpc` | "Not observed" |
| Reserva de gas, fuera del reparto | `eth_getBalance` | `chain_rpc` | "Not observed" |
| Fuera del plan, fuera del reparto | Tokens y posiciones no gestionados, valorados | `chain_rpc` y `estimate` | "Not observed" |
| Camino de conversión | Constante de la política: "Uniswap V3 · USDC/cbBTC 0.05% · SwapRouter02 exactInputSingle · quote from QuoterV2" | `d1` y versión de la política | No falta |
| Pendiente de convertir: cbBTC fuera de posiciones | Saldo de cbBTC | `chain_rpc` | "Not observed" |
| Cotización a USDC | QuoterV2 `quoteExactInputSingle` en el bloque de la revisión | `estimate` | "Not observed" |
| Estado de la conversión | Decisión y diario | `journal` | No falta si hay decisión |
| Swaps de la cuenta: hora, dirección, entra, sale, tipo y enlace | MBQ-08 contrastada, cruzada con el diario | `multibaas` o `chain_rpc`, y `journal` | Lista vacía |

Estados de la conversión:

| Estado | Cuándo | Texto |
|---|---|---|
| `nothing_to_convert` | No hay cbBTC fuera de posiciones | "Nothing to convert." |
| `held_for_entry` | Hay cbBTC fuera de posiciones sin salida en curso | "Held for the next entry." |
| `converting` | `DECIDE_CONVERT` con una operación viva | "Converting to USDC." y el estado de la operación |
| `held` | `DECIDE_CONVERT_HELD` | "Waiting for a healthy market: " más la causa, por ejemplo `EHG_PRICE_DIVERGENCE` |

Textos fijos:

- "Fees in cbBTC are converted to USDC inside each harvest."
- "Mamoru does not convert tokens outside your plan."

Tipos de swap de la cuenta: "Entry swap" (`enter_swap`), "Harvest conversion" (`harvest`), "Exit conversion" (`convert`) y "Not from Mamoru" si la transacción no está en el diario.

Reglas:

- El reparto suma idle, LP y cajón. La reserva de gas y lo que está fuera del plan se enseñan aparte.
- La conversión solo existe en Uniswap V3, por el camino de la política (FR-UNI-001, FR-UNI-002, FR-UNI-008). No hay intención de convertir. La conversión ocurre dentro de un harvest o después de una salida.

**Event queries.** MBQ-08 para los swaps de la cuenta.

**Comprobación RPC.** Cada swap está contrastado con `eth_getLogs` del pool. La cotización se hace con `eth_call` a QuoterV2 en el bloque de la revisión y queda como estimación.

**Vacío.** "Nothing in your treasury yet. Deposits are closed." Sin swaps: "No swaps from your account yet."

**Error.** "Can't load your treasury. Try again."

**Acción del usuario.** "Exit", que lleva a Current Action y convierte a USDC al terminar, y el enlace "Leave without Mamoru". Ninguna otra.

### 7.6 Pools and positions

**Pregunta.** ¿Qué pasa en los pools de mi plan y en mis posiciones: swaps, liquidez, comisiones y rango?

#### 7.6.1 Your positions

Todas las posiciones de la cuenta, gestionadas o no.

| Campo | Fuente de verdad | Procedencia | Si falta |
|---|---|---|---|
| `tokenId`, pool, `tickLower` y `tickUpper` | `positions(tokenId)` en el bloque | `chain_rpc` | "Not observed" |
| "Managed by Mamoru" o "Not managed by Mamoru" | `allowedTokenIds` | `journal` | No falta |
| Estado de rango: "In range" u "Out of range" | `tick` de `slot0` frente a los ticks, en el bloque de la revisión | `chain_rpc` | "Not observed" |
| "Out of range since" | Bloque del último `Swap` que sacó el tick del rango, en las filas guardadas | `multibaas` o `chain_rpc` | "Out of range for more than 7 days" si pasó antes de la retención |
| "In range, last 24 hours" | Bloques en rango sobre los bloques de la ventana `W`, con las filas de MBQ-01 y el tick al inicio de la ventana | Derivado de filas contrastadas | "Not observed" si falta el tick inicial o un tramo de filas |
| Liquidez ahora | `positions(tokenId).liquidity` | `chain_rpc` | "Not observed" |
| Liquidez según eventos | Suma de `IncreaseLiquidity` menos `DecreaseLiquidity` (MBQ-03) | `multibaas` o `chain_rpc` | "History incomplete" con `PROJ_INDEXER_MISMATCH` |
| Principal por token y su valor | Principal en liquidez, a precio de `slot0`, más `principalOwed` todavía no cobrado | `chain_rpc` y `estimate` | "Not observed" |
| Comisiones sin cobrar | `collect` estático menos `principalOwed` | `chain_rpc` | "Not observed" |
| Comisiones cobradas, separadas del principal | `Collect` de MBQ-03 menos el principal pendiente (FR-PRJ-003) | `multibaas` o `chain_rpc` | "Not observed" |
| "Fee movement, last 24 hours" | Comisiones sin cobrar de la última instantánea menos las de la primera de la ventana, más las cobradas en la ventana (FR-PRJ-013) | Derivado de instantáneas y filas | "Since block N" si la posición o las instantáneas son más recientes que la ventana |
| Eventos de la posición: tipo, hora, bloque, importes y "Mamoru" o "Not from Mamoru" | MBQ-03 y MBQ-04, cruzadas con el diario por hash de transacción | `multibaas` o `chain_rpc`, y `journal` | Lista vacía |
| Códigos de la posición | Última decisión: `OBS_UNMANAGED_ASSET`, `OBS_POSITION_OUT_OF_RANGE`, `OBS_FEES_ABOVE_COST`, `DECIDE_HARVEST` o `DECIDE_HARVEST_BELOW_COST` | `journal` | No falta si hay decisión |

**Event queries.** MBQ-03 con los `tokenId` de la cuenta. MBQ-04 con la cuenta. MBQ-01 del pool de la posición para "out of range since" y el tiempo en rango. Ninguna se guarda en el deployment.

**Comprobación RPC.** Filas contrastadas con `eth_getLogs` (§6.5). Invariante de liquidez en cada sincronización. El estado de rango y las comisiones sin cobrar salen de la observación de la revisión, nunca del índice.

**Vacío.** "No positions. Deposits are closed." en producción v1. En el plano de verificación sin posiciones: "No positions yet."

**Error.** "Can't load your positions. Try again." Si solo falla la historia: la posición se enseña con su estado RPC y "History not available yet".

**Acción del usuario.** Ninguna intención por posición. "View transaction" en cada evento, solo en producción. Una posición no gestionada solo se toca con el owner, fuera de Mamoru.

#### 7.6.2 Pools in your plan

Los pools curados de la política fijada. En Conservador v1, USDC/cbBTC 0.05%.

| Campo | Fuente de verdad | Procedencia | Si falta |
|---|---|---|---|
| Precio de cbBTC en USDC | `sqrtPriceX96` de `slot0` y decimales del registro | `chain_rpc` en `H` | "Not observed" |
| Tick actual | `slot0().tick` en `H` | `chain_rpc` | "Not observed" |
| "Spot vs TWAP": desvío en ticks y si pasa la guarda de la política | `observe` con la ventana de la política y la misma función que usa la Execution Health Gate | `chain_rpc` | "Not observed" |
| Liquidez en rango | `liquidity()` en `H` | `chain_rpc` | "Not observed" |
| Saldos del pool por token y su valor | `balanceOf(pool)` de token0 y token1 en `H` | `chain_rpc` y `estimate` | "Not observed" |
| "Last 24 hours": número de swaps | Filas contrastadas de MBQ-01 en [`H − W`, `H`] | `multibaas` o `chain_rpc` | "Not observed" si falta un tramo |
| Volumen por token y su valor | Suma de los importes positivos de `amount0` y de `amount1` de esas filas | Igual, con MBQ-07 como contraste | "Not observed" |
| "Fees paid by swaps, estimate" | Volumen de entrada por el fee del pool | `estimate` | "Not observed" |
| Rango de ticks recorrido | Mínimo y máximo de `tick` de las filas, con MBQ-07 como contraste | Filas contrastadas | "Not observed" |
| Liquidez añadida y retirada: número e importes | Filas de MBQ-02 en la ventana | `multibaas` o `chain_rpc` | "Not observed" |
| "Recent swaps": hora, bloque, dirección, entra, sale, precio después y enlace | Últimas filas de MBQ-01 | `multibaas` o `chain_rpc` | Lista vacía |
| "Recent liquidity changes": hora, "Added" o "Removed", rango, importes y enlace | Últimas filas de MBQ-02 | `multibaas` o `chain_rpc` | Lista vacía |
| Posiciones de la cuenta en este pool, con su estado de rango | Your positions | `chain_rpc` | Lista vacía |

Reglas:

- Las estadísticas se calculan con filas ya contrastadas. MBQ-07 solo las contrasta (FR-PRJ-014).
- Las filas de pool son públicas y se comparten entre cuentas. No llevan `account_key`.
- La ventana `W` y la retención `R` salen de la configuración. En el plano de verificación, el escenario fija su ventana y el runner recalcula con la misma.

**Event queries.** MBQ-01 y MBQ-02 del pool, en sincronización incremental cada tick del cron. MBQ-07 sobre la ventana, como contraste.

**Comprobación RPC.** Contraste de filas con `eth_getLogs`, ancla del último `Swap` frente a `slot0()` y estado del pool leído en `H` (§6.5).

**Vacío.** Sin swaps en la ventana: "No swaps in the last 24 hours." Sin cambios de liquidez: "No liquidity changes in the last 24 hours."

**Error.** "Can't load pool data. Try again." Si solo falta el índice, la vista sale de logs RPC y lo dice la cabecera (§6.6).

**Acción del usuario.** Ninguna intención. "View transaction" y "View pool" en Basescan, solo en producción.

### 7.7 Savings

**Pregunta.** ¿Cuánto he ahorrado y cuánto puedo usar?

| Campo | Fuente de verdad | Procedencia | Si falta |
|---|---|---|---|
| Total del libro | Suma de créditos de las filas en `confirmed`, `reconciled` o `indexer_mismatch` | `journal` y `chain_rpc` | Estado vacío: "No savings yet." |
| Saldo de USDC en el bloque | `balanceOf` | `chain_rpc` | "Not observed" |
| Disponible | El menor entre el libro y el saldo | Derivado. Si difieren, se enseñan los dos con `PROJ_SAVINGS_EXCEEDS_BALANCE` | "Not observed" si falta uno de los dos |
| Pendiente, rotulado "Pending, not credited" | Suma de filas `pending` | `journal` | Nada que mostrar |
| Último harvest | Última operación `harvest` en `confirmed` | `journal` | "No harvests yet." |

**Event queries.** Ninguna propia. El contraste del `Collect` de cada fila es de MBQ-03 (§7.8).

**Comprobación RPC.** El saldo se lee en el bloque de la revisión.

**Vacío.** En producción v1: "No savings yet. Deposits are closed."

**Error.** "Can't load your savings. Try again."

**Acción del usuario.** Ninguna. Enlace al Savings Log.

### 7.8 Savings Log

**Pregunta.** ¿De dónde sale cada cifra del ahorro, cosecha a cosecha?

Solo contiene operaciones incluidas en cadena. Las operaciones paradas por el dry-run se ven en Current Action, no aquí.

| Columna | Fuente de verdad | Procedencia |
|---|---|---|
| Fecha y bloque | Bloque de inclusión y su timestamp | `chain_rpc` |
| Tipo: "Harvest" o "Close" | Diario | `journal` |
| Posición | `tokenId` del diario | `journal` |
| Cobrado, por token | Evento `Collect` | `chain_rpc`, contrastado con MBQ-03 |
| Principal | Principal pendiente del `tokenId`: sube con `DecreaseLiquidity` y baja con cada `Collect`, también si el cobro es parcial | `chain_rpc` |
| Comisiones | Cobrado menos principal | Derivado |
| Conversión: entra y sale | Evento `Swap` | `chain_rpc` |
| Crédito en USDC | Comisiones en USDC más la salida del swap de comisiones. Solo en "Harvest" | Derivado |
| Estado | Proyector | Tabla siguiente |
| Eventos decodificados, en el detalle de la fila | MBQ-06, contrastado con el recibo | `multibaas` o `chain_rpc` |
| Fuentes | Chips del diario, la RPC y MultiBaas | |
| Enlace | Producción: transacción en Basescan. Plano de verificación: bloque y hash del fork, sin enlace | |

| Estado | Texto | ¿Acredita? | Cuándo |
|---|---|---|---|
| `pending` | "Pending" | No | Incluida pero todavía no `safe` |
| `confirmed` | "Confirmed" | Sí | `EXEC_OK` en `safe`, con diario y RPC de acuerdo (`PROJ_CONFIRMED`). Si el índice no tiene el evento: "Confirmed · indexer pending" (`PROJ_INDEXER_PENDING`) |
| `reconciled` | "Reconciled" | Sí | Diario, RPC y MultiBaas de acuerdo (`PROJ_RECONCILED`) |
| `indexer_mismatch` | "Indexer mismatch · chain value shown" | Sí, con importes de la RPC | MultiBaas discrepa (`PROJ_INDEXER_MISMATCH`) |
| `reorged` | "Reorged" | No | Salió de la cadena canónica (`PROJ_REORGED`) |

Una fila "Close" nunca acredita. Enseña el principal y las comisiones que volvieron al capital (`PROJ_PRINCIPAL_EXCLUDED`).

El explorador de MultiBaas pide sesión en el deployment, así que el dashboard no enlaza a él. Enseña los eventos decodificados que devuelve MBQ-06 y enlaza la transacción en Basescan.

**Event queries.** MBQ-03 para el `Collect` y el `DecreaseLiquidity` del `tokenId`. MBQ-06 para los eventos decodificados de la transacción.

**Comprobación RPC.** Importes, principal y conversión salen del recibo y de los logs RPC. MultiBaas solo cambia el estado entre `confirmed`, `reconciled` e `indexer_mismatch`.

**Vacío.** "No harvests yet." En producción v1: "No harvests yet. In simulation mode Mamoru collects nothing."

**Error.** "Can't load the savings log. Try again."

**Acción del usuario.** "View transaction" en Basescan, solo en producción. "Show events" abre el detalle con los eventos decodificados.

### 7.9 Leave without Mamoru

**Pregunta.** ¿Cómo me voy o recupero mis fondos sin Mamoru?

| Campo | Fuente de verdad | Procedencia |
|---|---|---|
| Procedimiento | `docs/walkaway.md` | Estático |
| Kit de recuperación: chain, dirección, parámetros de setup, módulos, owners, `permissionId` y `tokenId` | `AccountRecord` y sesiones | `d1` y `journal` |
| Procedimiento de WALK-04 para una cuenta contrafactual con fondos | `docs/walkaway.md` | Estático |

**Event queries.** Ninguna. Irse no depende de MultiBaas ni de Mamoru (FR-ACC-009).

**Comprobación RPC.** Ninguna en la vista.

**Vacío.** No aplica.

**Error.** "Can't load your recovery kit. Try again. The procedure in the guide works without it if you kept the file you downloaded."

**Acción del usuario.** "Download recovery kit" y "Open the guide".

## 8. Estados de datos

| Estado | Qué enseña |
|---|---|
| Cargando | Esqueleto de la vista, sin cifras |
| Vacío | El texto de estado vacío de la vista (§7) |
| Error de la API | El texto de error de la vista y "Try again". Las cifras anteriores siguen visibles como `stale` |
| Proyección vieja | "Stale · updated HH:MM UTC" |
| Sin observar | "Not observed" en cada cifra afectada |
| Índice por detrás | Chip "Base RPC logs · block N · MultiBaas behind" en las filas posteriores al bloque indexado |
| Índice que no indexa Base | Cabecera "MultiBaas is not indexing Base. History comes from Base RPC logs." y chips "Base RPC logs · block N · MultiBaas not indexing Base" |
| Query de MultiBaas fallida | Chip "Base RPC logs · block N · MultiBaas query failed" |
| Antes del inicio del índice | Chip "Base RPC logs · block N · before MultiBaas start" |
| Fuentes en desacuerdo | "Base · block N · MultiBaas disagreed", con el valor de la RPC, y la entrada `PROJ_INDEXER_MISMATCH` en Actions si la fila es de la cuenta |

## 9. Payload del dashboard

`GET /api/accounts/:accountKey/dashboard` devuelve un único objeto. `GET /api/accounts/:accountKey/history` pagina las listas largas (FR-DSH-020, plan §6.4). Los dos leen solo D1.

```ts
type ChainRef = { chainId: number; name: 'Base' | 'Base fork'; observed: true }

type IndexHealth = {
  provider: 'multibaas' | 'fork_index'
  status: 'indexing' | 'behind' | 'not_indexing_base' | 'failing' | 'not_configured'
  indexedBlock?: number
  code?: ReasonCode
  checkedAt: string
}

type DashboardPayload = {
  mode: 'production' | 'lab'
  chainId: number
  chains: ChainRef[]                       // v1: una sola entrada
  sources: {
    rpc: { status: 'ok' | 'unavailable'; block?: number; safeBlock?: number; observedAt: string }
    index: IndexHealth
  }
  banner: { kind: 'simulation' | 'lab'; text: string; block?: number }
  account: {
    key: string
    address: Figure<`0x${string}`>
    deployed: Figure<boolean>
    preset: 'conservador'
    policyVersion: string
    fundsGate: 'closed' | 'lab'
    totalValue: Figure<string>             // USDC, estimación
    totalMissing: string[]                 // partes sin observar
  }
  actions: { items: ActionItem[]; complete: boolean; notObserved: string[] }
  currentAction: {
    op?: { opId: string; kind: string; state: string; code: ReasonCode; updatedAt: string; txHash?: `0x${string}` }
    decision?: {
      decisionId: string; kind: string; code: ReasonCode; block: number
      trail: GateStep[]; shadow: ShadowNote[]
      positions: { tokenId: string; codes: ReasonCode[] }[]
    }
    recentDecisions: { decisionId: string; kind: string; code: ReasonCode; block: number; at: string }[]
    chainOps: AccountOpView[]
    session: Figure<'active' | 'renewal_due' | 'expired' | 'revoked' | 'missing'>
    sessionValidUntil?: Figure<string>
    paused: Figure<boolean>
    exit?: { status: 'in_progress' | 'pending' | 'completed'; cause?: ReasonCode }
    nextReviewAt: Figure<string>
    notes: ReasonCode[]                    // solo BUNDLER_UNAVAILABLE y RECON_TIMEOUT
  }
  portfolio: {
    tokens: TokenHolding[]
    positions: { managed: number; unmanaged: number; value: Figure<string> }
    allocation: { bucket: string; preference: number; actual: Figure<number>; code: ReasonCode }[]
    unmanaged: { kind: 'token' | 'position'; ref: string; code: ReasonCode }[]
    total: Figure<string>
  }
  treasury: {
    idle: { usdc: Figure<string>; cbBTC: Figure<string>; value: Figure<string>; code?: ReasonCode }
    lp: Figure<string>
    savings: Figure<string>
    gasReserve: Figure<string>
    outsidePlan: Figure<string>
    convert: {
      route: { protocol: 'uniswap-v3'; pool: PoolRef; router: 'SwapRouter02'; method: 'exactInputSingle'; quoter: 'QuoterV2' }
      pending: Figure<string>              // cbBTC fuera de posiciones
      quote: Figure<string>                // USDC, estimación de QuoterV2
      state: 'nothing_to_convert' | 'held_for_entry' | 'converting' | 'held'
      code?: ReasonCode
      cause?: ReasonCode
    }
    swaps: AccountSwapView[]
  }
  pools: { positions: PositionView[]; plan: PoolView[] }
  savings: {
    ledgerTotal: Figure<string>
    usdcBalance: Figure<string>
    available: Figure<string>
    pending: Figure<string>
    lastHarvest?: Figure<string>
  }
  savingsLog: { rows: SavingsRowView[]; next?: string }
  provenanceComplete: boolean
}

type ActionItem = {
  id: string                               // código:sujeto:referencia
  code: ReasonCode
  kind: 'critical' | 'decide' | 'understand'
  subject: { kind: 'account' | 'session' | 'position' | 'token' | 'savings' | 'exit'; ref?: string }
  title: string
  body: string
  cause?: ReasonCode
  action?:
    | { type: 'intent'; intent: 'pause' | 'exit' | 'renew_session'; params?: { paused: boolean } }
    | { type: 'link'; target: 'current-action' | 'portfolio' | 'treasury' | 'position' | 'savings' | 'savings-log' | 'leave' | 'walk-04'; ref?: string }
  since: Figure<string>
  sources: Provenance[]
}

type TokenHolding = {
  token: 'USDC' | 'cbBTC' | 'WETH' | 'ETH'
  role: 'plan' | 'gas' | 'outside_plan'
  amount: Figure<string>
  value: Figure<string>
  code?: ReasonCode
}

type PositionView = {
  tokenId: string
  pool: PoolRef
  managed: boolean
  tickLower: number
  tickUpper: number
  rangeState: Figure<'in_range' | 'out_of_range'>
  outOfRangeSince?: Figure<{ block: number; at: string } | 'before_retention'>
  timeInRange: Figure<string>              // fracción decimal de la ventana
  liquidity: Figure<string>
  liquidityFromEvents: Figure<string>
  historyComplete: boolean
  principal: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string> }
  uncollectedFees: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string> }
  collectedFees: { amount0: Figure<string>; amount1: Figure<string> }
  feeMovement: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string>; fromBlock: number }
  value: Figure<string>
  codes: ReasonCode[]
  events: PositionEventView[]
  nextEvents?: string
}

type PoolView = {
  pool: PoolRef
  block: number                            // H de la sincronización
  price: Figure<string>
  tick: Figure<number>
  twapTick: Figure<number>
  twapGuard: Figure<'ok' | 'above_guard'>
  liquidity: Figure<string>
  balances: { amount0: Figure<string>; amount1: Figure<string>; value: Figure<string> }
  window: { fromBlock: number; toBlock: number }
  stats: {
    swaps: Figure<number>
    volume0: Figure<string>; volume1: Figure<string>; volumeValue: Figure<string>
    fees0: Figure<string>; fees1: Figure<string>; feesValue: Figure<string>
    tickMin: Figure<number>; tickMax: Figure<number>
    added: { count: Figure<number>; amount0: Figure<string>; amount1: Figure<string> }
    removed: { count: Figure<number>; amount0: Figure<string>; amount1: Figure<string> }
  }
  recentSwaps: PoolSwapView[]
  recentLiquidity: PoolLiquidityView[]
  accountPositions: { tokenId: string; rangeState: Figure<'in_range' | 'out_of_range'> }[]
}
```

Las filas de historia (`AccountOpView`, `AccountSwapView`, `PositionEventView`, `PoolSwapView`, `PoolLiquidityView` y `SavingsRowView`) llevan bloque, hash de bloque, hash de transacción, `logIndex`, sus importes como `Figure` y, si son de la cuenta, el `opId` del diario cuando lo hay. Las cantidades de token van como cadenas de enteros en la unidad mínima del token, con `unit` indicando el token. La SPA formatea. La API nunca redondea.

## 10. Producción y plano de verificación

| Aspecto | Producción v1 | Plano de verificación (fork) |
|---|---|---|
| Qué es | El producto | Evidencia de que el ciclo completo funciona |
| Aviso fijo | Banner del modo de seguridad | Banda "Simulation · Base fork · Block N · Not capital" |
| Chain | 8453, "Base" | 31337, "Base fork" |
| Procedencia de cadena | `chain_rpc` | `fork_rpc` |
| Modelo de lectura | MultiBaas contrastado con la RPC, o logs RPC rotulados | Lector del fork que interpreta las mismas MBQ sobre logs de anvil, rotulado `fork_rpc`. Nunca MultiBaas |
| Pools in your plan | Tráfico real de Base | Swaps reales de las perturbaciones del escenario |
| Enlaces | Basescan para transacciones y direcciones de Base | Ninguno: bloque y hash del fork |
| Operaciones | Terminan en "Simulated, not sent" | Ciclo completo contra anvil y Alto |
| Depósito | "Deposits are closed" | Solo por fixture. La vista nunca enseña una dirección para depositar |
| Botones | "Pause" y "Exit" deshabilitados | Activos |

## 11. Mapa del premio de Curvegrid

La entrega al track Best Digital Asset Dashboard es el dashboard de producción en Base (FR-PRZ-001). El revisor del premio no tiene acceso especial: entra como cualquier usuario, termina el onboarding con una cuenta contrafactual, ve su dashboard y lee el README. El plano de verificación no es la entrega. El README lo cita como evidencia en "Setup and tests".

| Qué se juzga | Qué lo enseña | Evidencia |
|---|---|---|
| Un dashboard de activos digitales sobre MultiBaas | Las vistas de §7 en `/dashboard`, en Base | BASE-01, UI-07 |
| Uso real de MultiBaas | Event queries MBQ-01 a MBQ-08 desde el motor, contrastadas con la RPC. Webhooks como wake hints si pasan HOOK y una entrega real | MB-01 a MB-04, DASH-14, DASH-15, HOOK-01 a HOOK-09 |
| Idea | Ahorro autónomo no custodio que explica cada decisión: Actions para lo que es del usuario, Current Action con código para lo que hace Mamoru | DASH-09 a DASH-13, UI-06 |
| Ejecución técnica | Procedencia con chain en cada cifra, contraste fila a fila y respaldo por logs RPC | DASH-08, DASH-17, DASH-18, BASE-02 |
| Entrega | README con los cinco apartados de §12 | DOC-01 |

## 12. README del premio

El README del premio es el `README.md` público, en inglés. Lo escribe T016 cuando existan las evidencias, y `docs/multibaas.md` es su anexo con la evidencia detallada. No se escribe en este pase. DOC-01 comprueba que cada afirmación enlace su evidencia.

### 12.1 Los cinco apartados

El README lleva estos títulos, exactos y en este orden (FR-PRZ-004):

| Título | Qué contiene | Regla |
|---|---|---|
| "One sentence" | Una frase que dice qué es Mamoru v1: ahorro autónomo no custodio en Base, el dashboard y el modo de seguridad | Una sola frase. Nada de la lista prohibida |
| "How MultiBaas was used" | Los contratos enlazados con su alias; las queries que pasaron MB-02 a MB-04 y las vistas que alimentan; la clave de rol mínimo solo en el motor; el contraste con la RPC; el respaldo por logs RPC; los webhooks solo si se cumplen sus condiciones; y la línea "Not covered: DAO votes, vesting schedules and RWA ownership analytics." | Solo queries con `PROJ_RECONCILED` en su comprobación (FR-PRZ-005) |
| "Team handles" | Los handles del equipo | Los da Ot. T016 no inventa miembros ni handles, ni deja marcadores de relleno |
| "Setup and tests" | Cómo correr en local, los nombres de las variables sin valores, los escenarios, BASE-01 y BASE-02, y el ciclo completo del plano de verificación (CYCLE-01) como evidencia | El fork se rotula como verificación, no como producto |
| "Experience with MultiBaas" | Los resultados de MB-01 a MB-04, fallos incluidos; los formatos que se encontraron; lo que costó y lo que funcionó | Nada inventado. Todo con evidencia |

### 12.2 Afirmaciones permitidas

| Afirmación, en inglés | Condición | Evidencia |
|---|---|---|
| "In v1 production, Mamoru runs in simulation mode. It plans and simulates, and it does not sign or send transactions." | Siempre obligatoria | Informes de DRY-01 a DRY-03 |
| "The dashboard shows Base only. Every figure carries its chain id and its source." | Siempre obligatoria | DASH-08, DASH-18 y BASE-01 |
| "The full cycle is verified on a Base fork pinned at block 51811000 with chain id 31337. Fork results are not capital and do not use MultiBaas." | Obligatoria si se cita cualquier resultado del fork | Informes de escenario con su manifiesto |
| "Mamoru links the Uniswap V3 pool it uses, the NonfungiblePositionManager and EntryPoint v0.7 on Base in MultiBaas." | MB-01 con `MB_BASE_INDEXING_OK` | Archivo de `evidence/multibaas/` con los contratos enlazados, sin claves |
| "Pool swaps, liquidity changes, position history and account operations come from MultiBaas event queries that Mamoru's server checks against Base RPC before showing them." | Nombra solo las queries con `PROJ_RECONCILED` en MB-02 a MB-04 | Evidencia de MB-02 a MB-04 y DASH-14, DASH-15 |
| "If MultiBaas is behind or unavailable, the dashboard reads Base RPC logs and labels every row." | DASH-17 y BASE-02 en verde | Informes de esos escenarios |
| "MultiBaas event.emitted webhooks can wake Mamoru's engine early. They are hints: Mamoru re-reads the chain before it decides." | HOOK-01 a HOOK-09 en verde, y una entrega real registrada tras un despliegue que hace Ot fuera de este pack | Informes de HOOK y registro de la entrega real |
| Lo que falló | Siempre obligatoria, en "Experience with MultiBaas" | Resultados de MB-01 a MB-04 y escenarios fallidos |

### 12.3 Afirmaciones prohibidas

- Que MultiBaas firma, envía, retransmite o acelera transacciones, o que Mamoru usa Cloud Wallets.
- Que MultiBaas prueba que una operación liquidó, o que decide algo.
- Que MultiBaas indexa el fork, o que alguna cifra del fork sale de MultiBaas.
- Que una query que no pasó MB-02 a MB-04 alimenta el dashboard.
- Saldos, actividad o soporte en chains distintas de Base.
- Votos de DAO, calendarios de vesting o analítica de propiedad de RWA.
- Que el plano de verificación es el producto, una demo en vivo o capital.
- Usuarios, depósitos, ahorro o TVL reales.
- Rendimientos, APY o cualquier número del Packaging.
- Ejecución en Base con fondos.
- Webhooks funcionando en producción antes de registrar una entrega real.
- Auditorías o garantías de seguridad más allá de los escenarios ejecutados.
- Cualquier afirmación sin enlace a su evidencia.

### 12.4 Si MultiBaas no indexa Base

Si MB-01 da `MB_BASE_INDEXING_ABSENT`, o MB-02 a MB-04 no dan `PROJ_RECONCILED`:

- "How MultiBaas was used" dice qué se enlazó y qué se intentó, y no afirma queries contrastadas.
- "Experience with MultiBaas" cuenta el fallo con su evidencia.
- El dashboard sigue: las vistas salen de logs RPC rotulados. BASE-02 es la evidencia de ese camino. El README la cita como prueba del respaldo, no como un fallo real de MultiBaas.
- MultiBaas sale del motor (`MULTIBAAS_ENGINE_ENABLED=false`): sin webhooks. El motor sigue probando el índice en cada sincronización.

## 13. Fuera de alcance

- Votos de DAO, calendarios de vesting y analítica de propiedad de RWA. No se construyen ni se simulan.
- Saldos, posiciones o actividad en chains distintas de Base. v1 no los observa y no enseña cifras de ellas, ni siquiera un cero.
- Tokens fuera del registro de Base.
- Una intención de conversión, de venta o de cobro. La conversión solo ocurre dentro de un harvest o tras una salida.
- Cotizaciones o rutas que no sean Uniswap V3 con QuoterV2 y SwapRouter02.
- El explorador de MultiBaas como parte de la vista.
- Alertas por email o push.
