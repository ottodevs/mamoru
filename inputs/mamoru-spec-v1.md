---
title: "Mamoru — spec v1"
type: spec
project: mamoru
status: active
tags: [mamoru, arquitectura, spec]
date: 2026-09-26
aliases: [mamoru-spec-v1]
related:
  - "[[mamoru]]"
  - "[[mamoru-diagramas]]"
  - "[[2026-09-25-sin-aqua-ni-1inch]]"
  - "[[2026-09-26-superficie]]"
  - "[[packaging-delta-2026-09-11]]"
---

# Mamoru — spec v1

Plan definitivo del 2026-09-26. Consejo: Grok 4.7 xhigh, Cursor `claude-opus-5-5-high`, Codex `gpt-6-astra` high. La landing Astro queda fuera. Decisión: [[2026-09-26-arquitectura-v1]].

Nada de esto se copia al repo público en este paso. La implementación sale después, en commits cortos, sin historial ajeno al proyecto.

## Invariantes

- No-custodia. El capital, el idle y el cajón de ahorro viven en la smart account del usuario.
- Producción en `CORE_DRY_RUN`. El dry-run termina antes de firmar y de enviar. Fondos reales cerrados hasta T-000025.
- Chain de ejecución de v1: Base. El fork no usa el chain id de Base.
- Uniswap V3 es la única ejecución: QuoterV2 cotiza, el router V3 hace el swap, el NonfungiblePositionManager hace el LP y el cobro. Aqua, 1inch, Trading API, LP API, UniswapX, hooks v4, CoW y Tenderly no mueven capital.
- Puertas, en este orden de significado: Purga solo al entrar o reentrar. Risk Monitor con el capital dentro. Execution Health Gate por operación. ENY. Strategy. Una salida pedida por una puerta alta no la cancela una puerta baja. En emergencia se sale aunque el gate de ejecución sea NO GO, si la sesión y la transacción son válidas. Si no se puede enviar, queda pendiente con la causa a la vista.
- BOP y Safety no son puertas nuevas. Su sentido del prototipo vive dentro de Purga y de Risk Monitor.
- Los números del Packaging y del Colab siguen en shadow hasta T-000056. 50/40/10 es preferencia.
- La chain manda sobre los fondos. El Durable Object manda sobre el ciclo de una operación. D1 es proyección.
- El login de producto no autoriza fondos.

## Piezas

| Plano | Pieza | Deber |
|---|---|---|
| App | `mamoru-app` | SPA Vite, React, Tailwind, TanStack Query y TanStack Router. Workers Static Assets. Rutas `/`, `/onboarding`, `/dashboard`. Habla solo con la API. No firma. |
| App | API Hono en el mismo Worker | Sesión de producto, vista del dashboard, intenciones (preset, pausa, salida, renovar sesión). No firma. |
| Motor | `mamoru-engine` | Cron, Durable Object y Workflow. Fuera del panel. |
| Motor | Durable Object por cuenta y chain | Un solo escritor. Diario de la operación: intención, nonce reservado, hash, bytes firmados, estado. |
| Motor | `@mamoru/decide` | Función pura. Observación y política versionada entran. Decisión y código de razón salen. |
| Motor | Adaptador Uniswap V3 | Arma quotes y calldata. No firma. |
| Motor | Adaptador RPC | Lee y simula con viem. Alchemy es el primer proveedor y se puede cambiar. |
| Motor | Adaptador de cuenta | Safe, ERC-7579, Smart Sessions. La session key vive cifrada. La toca solo el motor. |
| Motor | Adaptador 4337 | Lleva la userOp y reconcilia el recibo. Pimlico es el primer bundler y se puede cambiar. |
| Lectura | MultiBaas | Indexa eventos y avisa. No decide y no firma. |
| Lectura | Proyector | Junta chain, decisiones y eventos en la vista. |
| Lectura | D1 | Identidad de producto, preferencias, proyección, auditoría. |
| Escenarios | Runner bun + anvil | El mismo `decide` y los mismos adaptadores, contra un fork. |
| Escenarios | Catálogo | Estado inicial, bloque, perturbaciones, resultados esperados. |

`mamoru-lol` no entra. Los pines de Vite 8.1.4, React 19.2.7 y TanStack Query 5.101.2 son el punto de partida del prototipo. El primer commit de la app los congela. Nada queda en `latest`.

Estados de una operación: propuesta, descartada, preparada, simulada, firmada, enviada, incluida, confirmada, fallida, pendiente de reconciliación. Un timeout no abre otro nonce. Se reconcilia la misma operación. Hay prueba de caída antes del envío y después.

## Cuenta

Safe con módulo ERC-7579 y Smart Sessions de Rhinestone. El owner es el passkey del usuario, con un owner de respaldo suyo antes del depósito. La sesión del servidor es explícita: contratos, selectores, argumentos, tokens, importe, destinatario igual a la propia cuenta, posición, caducidad y revocación. No instala módulos, no cambia owners y no se amplía. Sin política por defecto y sin cañón de intents hacia el Orchestrator.

La prueba que tumba esta elección, en fork, con la session key tratada como comprometida: desviar el destinatario, pasar el gasto, ampliar approvals, tocar otra posición, esconder llamadas en un batch, reusar una sesión revocada, o salir por intents. También la tumba que el usuario no pueda revocar y retirar con su owner mientras Mamoru, el login y MultiBaas están apagados. Hasta que esa prueba pase, T-000025 sigue cerrado. thirdweb queda fuera de este alcance.

El login de producto es Google, passkey o email, recuperable antes del depósito. Abrir la vista de una cuenta exige una prueba ERC-1271 de esa cuenta, o ERC-6492 si el Safe aún no está desplegado. Esa prueba no sustituye al owner. Better Auth es candidato del login, no una pieza cerrada.

## Escenarios

Anvil corre en la máquina de trabajo, en CI y en el portátil de la demo. Nunca en Cloudflare. El bundler del laboratorio apunta solo a anvil. El chain id del fork no es el de Base, para que una firma del escenario no valga en la red. El bloque es obligatorio (`--fork-block-number`) y se comprueba el hash. El artefacto reproducible es el estado volcado, la versión de anvil, el bloque y las fixtures. El id de `evm_snapshot` solo sirve para repetir estrategias dentro de esa ejecución.

El panel, con el runtime en fork, usa el mismo dashboard (Portfolio, Savings, Current Action, Savings Log) y una banda fija: simulación, fork de Base, bloque, no es capital. Esos datos no se cuelan en la vista de producción. No enlazan a Basescan.

El catálogo de Mamoru cubre el ciclo con bloque fijo. Archivos de origen: `s01` observe, `s02` deposit, `s03` swap, `s04` harvest, `s05` fixture, `s06` mainnet, `s07` LP V3, `s08a` cerrar posición, `s09` y `s10` ERC-7540, `s11` loop ETH, `s12` tres buckets, `s13` dry-run, `s14` ajuste de rango. Se suman prioridad de puertas, permisos, reintento y aislamiento. Los resultados esperados son códigos de razón y estados, no umbrales.

## MultiBaas

Sirve al premio Best Digital Asset Dashboard y al aviso del motor.

En la lectura: contratos de los pools V3, el Position Manager y el EntryPoint de Base. Event queries para liquidez, cobros y actividad por posición. El dashboard muestra activos, acción pendiente, decisión operativa con el motivo, y el Savings Log, y dice de dónde sale cada cifra. Un `Collect` no cuenta solo como yield: puede llevar principal. El proyector lo reconcilia con la operación y con una lectura RPC.

En el motor: un webhook `event.emitted` puede adelantar una revisión. No es un GO. El motor relee por RPC. Si el webhook no llega, el cron sigue. Se comprueban firma, antigüedad, duplicado y reorg. `transaction.included` no cubre las userOps de Mamoru.

Prohibido: Cloud Wallets, cualquier clave, firmar, enviar, decidir, y ser la única prueba de que algo liquidó. Si el deployment no indexa Base, MultiBaas sale del motor y el README cuenta solo la lectura que sí se haya probado. La aceptación es una query real sobre un pool conocido, reconciliada con `eth_call`.

## Uniswap en el demo

El demo del premio es: cuenta de prueba, Conservador, pools, harvest a stable en el fork, y el dashboard al lado. La capa B basta. La Trading API, si algún día hay key, puede mostrarse como cotización de research, marcada, sin volverse calldata.

## Cloudflare

El motor no cabe en el plan gratuito: cada paso muere a los 10 ms de CPU. Hace falta Workers Paid, mínimo publicado 5 USD al mes por cuenta, en Nexa Havenworks. La cuenta ya está en el usage model `standard`, que es el de ese plan. No se activa un segundo mínimo. Ot mira Billing una vez. Si Workers Paid ya figura, no toca nada. Si no figura, activa los 5 USD. El consejo no lo activa. Antes de desplegar el motor, un `limits.cpu_ms` que el plan gratuito rechace confirma de qué lado está la cuenta.

## Cómo se implementa

La spec ejecutable es este documento más el catálogo de escenarios. No se genera un armazón de Spec Kit en el repo público.

Orden: permisos de la cuenta en fork, harvest en fork, diario del Workflow, dashboard con MultiBaas, demo. Cada tramo deja evidencia. El README público se escribe cuando haya algo que montar, con el uso real de MultiBaas y sin resultados inventados.

## Qué tumba el plan

- La prueba adversarial de la sesión no pasa.
- Hace falta SSR de verdad para el panel.
- Un paso del motor no cabe en los límites de Workers ni partiéndolo. Entonces se mide Containers. Salir de Cloudflare pide que Containers tampoco alcance.
- MultiBaas no indexa los contratos de Base. Entonces se queda fuera del motor, no del intento de lectura.
