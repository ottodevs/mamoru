# Constitución de Mamoru

Versión 2.0.0. Ratificada el 2026-09-26 como 1.0.0. Enmendada el 2026-10-29 por las decisiones de Ot que recoge la sección "Enmiendas". Obliga a `specs/001-mamoru-v1/`, a `specs/002-multichain-monad/` y a todo pack posterior.

La ley es `inputs/mamoru-spec-v1.md`, cerrada el 2026-09-26, más las decisiones de Ot que la amplían y que recoge la sección "Enmiendas". Esta constitución las traduce a reglas que un spec, un plan, una tarea o un escenario pueden incumplir de forma comprobable. Si un documento del pack contradice a esta constitución, gana la constitución. Si esta constitución contradice a la ley, gana la ley y se corrige la constitución.

La prosa de esta constitución y de `specs/001-mamoru-v1/` va en español; la de los packs desde 002 va en inglés, como ya hacen 003 a 008. Los ids de requisito, los nombres de tipo, los códigos de razón y las rutas van en inglés.

## Decisiones cerradas que ningún documento reabre

- El framework del panel: SPA con Vite, React, Tailwind, TanStack Query y TanStack Router.
- El runtime del motor: Cloudflare Workers con Cron, Durable Objects y Workflows.
- La cuenta: Safe con módulo ERC-7579 y Smart Sessions de Rhinestone, con el passkey del usuario como owner.
- Las chains: Base y Monad son chains de ejecución, Base es la principal; Ethereum es chain de entrada.
- Mover fondos entre chains es parte del producto, siempre por la ruta más eficiente y sobre rutas existentes antes que piezas propias.
- La regla de dry-run en producción.
- El camino de ejecución de Uniswap: V3 con QuoterV2, el router V3 y el NonfungiblePositionManager.

## Principios

### I. No custodia

El capital, el idle y el cajón de ahorro viven en la smart account del usuario. Ninguna cuenta de Mamoru recibe ni retiene fondos del usuario. Toda llamada que mueve tokens tiene como destinatario la propia cuenta. En un movimiento entre chains, el destinatario es la cuenta del mismo usuario en la chain de destino, y ningún contrato, relayer ni solver de Mamoru guarda los fondos en tránsito.

Se comprueba con `INV-RECIPIENT` en todos los escenarios de fork y con SESS-01 a SESS-04.

### II. Producción en dry-run

Producción corre en `CORE_DRY_RUN`. El dry-run termina antes de firmar y de enviar. En v1 esa bandera solo admite `true` y la puerta de fondos (`FUNDS_GATE`) está cerrada hasta T-000025. Ninguna tarea, escenario ni configuración de este pack abre la firma en Base.

El laboratorio firma solo contra el chain id del fork y contra un bundler en loopback. No es una excepción al dry-run: el dry-run es una regla de producción y el laboratorio no es producción.

Se comprueba con DRY-01 a DRY-03, M13 y UI-01.

### III. Chains

La lista de chains es cerrada y explícita: no hay chain por defecto, y una pieza que no dice su chain no arranca.

- Base (chain id 8453) es chain de ejecución y la principal: la cuenta nace allí y los depósitos se reciben allí.
- Monad (chain id 143) es chain de ejecución: Mamoru opera posiciones allí con la misma cuenta, el mismo `decide` y las mismas puertas.
- Ethereum (chain id 1) es chain de entrada: Mamoru detecta fondos de la cuenta allí y los lleva a Base. No ejecuta estrategia en Ethereum mientras el Lab no demuestre que gana después de gas.

Cada chain tiene su registro de direcciones con sus code hashes, su política, su operador, y su Durable Object y su proyección por cuenta y chain. El tope por cuenta y la puerta de fondos se aplican en cada chain.

El fork del laboratorio no usa el chain id de ninguna chain soportada ni el de sus redes de prueba, para que ninguna firma de escenario valga en ninguna red.

Se comprueba con LAB-01, SESS-19, M06 y los escenarios CHN de `specs/002-multichain-monad/`.

### IV. Uniswap V3 es la única ejecución

Dentro de una chain, QuoterV2 cotiza. SwapRouter02, el router V3 desplegado en Base, hace el swap con `exactInputSingle`. El NonfungiblePositionManager hace el LP y el cobro. Trading API, LP API, UniswapX, hooks v4, CoW, Tenderly, Aqua y 1inch no mueven capital, no producen calldata y no deciden. La Trading API, si algún día hay key, solo se muestra como cotización de research marcada. Los contratos de ruta entre chains mueven capital solo según el principio XIX.

Se comprueba con `INV-TARGETS` y con OPS-03.

### V. Puertas y precedencia

Orden de significado: Purga, solo al entrar o reentrar. Risk Monitor, con el capital dentro. Execution Health Gate, por operación. ENY. Strategy.

Una salida pedida por una puerta alta no la cancela una puerta baja. En emergencia se sale aunque la Execution Health Gate diga NO GO, si la sesión y la transacción son válidas. Si no se puede enviar, la salida queda pendiente con la causa a la vista. BOP y Safety no son puertas: su sentido del prototipo vive dentro de Purga y de Risk Monitor.

Se comprueba con GATE-01 a GATE-09.

### VI. Números en shadow

Los números del Packaging y del Colab siguen en shadow hasta T-000056: se calculan, se anotan y no aprueban ni rechazan nada. 50/40/10 es preferencia. Ningún escenario depende de un umbral del Packaging.

Los parámetros de ingeniería de la política (tolerancia de slippage, guarda de manipulación, topes de la sesión, ventanas de tiempo) van versionados con la política, están documentados como parámetros que no son del Packaging y ningún escenario afirma su valor.

Se comprueba revisando `scenarios.md`, que no contiene umbrales, y con GATE-01.

### VII. Autoridad de los datos

La chain manda sobre los fondos. El Durable Object manda sobre el ciclo de una operación. D1 es proyección. MultiBaas indexa y avisa. El motor no decide con datos de D1 ni con el cuerpo de un webhook: relee la chain.

Se comprueba con HOOK-08, DASH-04 y la familia JRNL.

### VIII. Login y vista

El login de producto no autoriza fondos. Abrir la vista de una cuenta exige una prueba ERC-1271 de esa cuenta, o ERC-6492 si el Safe aún no está desplegado. Esa prueba no sustituye al owner.

Se comprueba con ONB-04, ONB-06 y TEN-01 a TEN-07.

### IX. Sesión explícita

La sesión que usa el servidor dice contratos, selectores, argumentos, tokens, importe, destinatario igual a la propia cuenta, posición, caducidad y revocación. No instala módulos, no cambia owners y no se amplía. No hay política por defecto ni acción comodín. No hay canal de intents hacia el Orchestrator. Ninguna userOp de sesión usa paymaster; la única excepción es la userOp del owner que despliega la cuenta en una chain de entrada y lleva sus fondos a Base, que puede pagar su gas en USDC con un paymaster ERC-20. La sesión no firma mensajes ERC-1271 ni ERC-7739 en nombre de la cuenta.

Si una regla no se puede expresar con las primitivas de Smart Sessions, se parte en sesiones más estrechas. Nunca se relaja una regla para que pase una prueba.

Se comprueba con SESS-01 a SESS-25.

### X. Walkaway

El usuario puede revocar y retirar con su owner mientras Mamoru, el login y MultiBaas están apagados. Hasta que esa prueba pase en fork, T-000025 sigue cerrado.

Se comprueba con WALK-01 a WALK-05.

### XI. Una operación, un nonce

Como mucho hay una operación no terminal por cuenta y chain. Los bytes firmados, el hash y el nonce se guardan antes de cualquier envío. Un timeout no abre otro nonce: se reconcilia la misma operación. Una operación solo pasa a `failed` con prueba. Hay prueba de caída antes del envío y después.

Se comprueba con JRNL-01 a JRNL-09 y RETRY-01 a RETRY-06.

### XII. MultiBaas lee y avisa

MultiBaas enlaza contratos, responde event queries y puede adelantar una revisión con `event.emitted`. No usa Cloud Wallets ni claves de proveedor. No firma, no envía, no acelera, no decide y no usa `transaction.included`. Nunca es la única prueba de que algo liquidó. No indexa el fork. Si el deployment no indexa Base, MultiBaas sale del motor, no del intento de lectura.

Se comprueba con MB-01, HOOK-01 a HOOK-09, DASH-03 y DASH-04.

### XIII. Escenarios reproducibles

Anvil corre en la máquina de trabajo, en CI y en el portátil de la demo. Nunca en Cloudflare. El bloque de fork es obligatorio y se comprueba su hash. El artefacto reproducible es el estado volcado, la versión de anvil, el bloque y las fixtures. El id de `evm_snapshot` solo sirve dentro de la ejecución que lo creó. El runner usa el mismo `decide` y los mismos adaptadores que producción. Los resultados esperados son códigos de razón y estados.

Se comprueba con LAB-01 a LAB-11.

### XIV. Cloudflare

El motor corre en Workers Paid, con un mínimo publicado de 5 USD al mes, en la cuenta de Nexa Havenworks. Esa cuenta ya está en el usage model `standard`. No se contrata un plan Pro de zona ni un segundo mínimo de Workers. Ningún agente toca Billing: Ot lo mira una vez. El motor vive fuera del panel y no tiene rutas públicas.

Se comprueba con OPS-01.

### XV. Panel

SPA con Vite, React, Tailwind, TanStack Query y TanStack Router, servida con Workers Static Assets. Rutas `/`, `/onboarding` y `/dashboard`. Habla solo con la API Hono del mismo Worker. No firma. No necesita SSR. `mamoru-lol` y la landing Astro quedan fuera.

Se comprueba con UI-01 a UI-05 y OPS-01.

### XVI. Verdad en pantalla

Cada cifra dice de dónde sale. No se inventan números: un dato que falta se muestra como no observado, nunca como cero. La simulación siempre se rotula. El laboratorio no enlaza a Basescan y sus datos no entran en la vista de producción. El README del premio solo cuenta lo ejecutado y registrado, y cuenta lo que falló.

Los fondos en tránsito entre chains se enseñan como en tránsito, con su ruta y su tiempo, nunca como cero ni dos veces.

Se comprueba con UI-01 a UI-05, DASH-08, TEN-06 y DOC-01.

### XVII. Secretos

Las claves viven solo como secretos de Workers o en un `.dev.vars` local ignorado por git. Nunca en el repo, en argv, en logs, en el navegador, en D1 ni en artefactos de escenario. En las fixtures solo aparecen dos tipos de clave, y ambos valen solo en el fork. Las claves de desarrollo de anvil, que son públicas. Las claves de prueba del autenticador WebAuthn de software.

Se comprueba con LAB-06 y OPS-01.

### XVIII. Método

El ciclo es el de GitHub Spec Kit: constitución, spec, plan y tareas. Se para antes de implementar. Cada requisito tiene id. Cada tarea cita requisitos, nombra el escenario que la acepta y dice lo que no debe hacer. Cada escenario cita requisitos. Ninguna tarea despliega ni sube versiones a Cloudflare. Ninguna abre la puerta de fondos ni desactiva el dry-run. La implementación sale en commits cortos y revisados, sin historial ajeno al proyecto.

### XIX. Movimiento entre chains

Mover fondos de la cuenta entre chains está dentro del alcance. Se hace siempre por la ruta más barata que pasa las comprobaciones de seguridad, y esa elección se enseña al usuario.

- Rutas existentes antes que piezas propias: CCTP v2, Across, Relay, LI.FI y los puentes canónicos. Mamoru no escribe un puente, un relayer de mensajes ni un contrato de liquidez entre chains.
- La session key solo ejecuta rutas cuyo destinatario una política de sesión fija en cadena (hoy CCTP v2 `depositForBurn` y Across `depositV3`), con destinatario igual a la cuenta en la chain de destino, importe y comisión acotados. Las demás rutas las firma el owner, con el calldata decodificado y el destinatario comprobado antes de firmar; si no se puede comprobar, la ruta no se ofrece.
- La cuenta de destino tiene que estar lista para operar antes de que salga el dinero; si no, el movimiento espera con un código de razón.
- Cada movimiento se mide: ruta, comisión del puente, gas en las dos chains, slippage y tiempo en tránsito, y se guarda en el ledger. El coste por movimiento es un número que se sigue en el informe diario y en el gate de release y del Lab.
- Una ruta nueva, o un cambio que la abarate, entra por el Lab antes de mover fondos en vivo.
- Un movimiento en tránsito cuenta una vez en la valoración, y uno atascado tiene un camino de recuperación que el owner puede ejecutar sin Mamoru.

Se comprueba con los escenarios XCH y COST de `specs/002-multichain-monad/`.

## Pruebas que tumban el plan

1. La prueba adversarial de la sesión no pasa (SESS-01 a SESS-25).
2. El walkaway con el owner no pasa (WALK-01 y WALK-02). T-000025 sigue cerrado.
3. Hace falta SSR de verdad para el panel.
4. Un paso del motor no cabe en los límites de Workers ni partiéndolo. Entonces se mide Containers. Salir de Cloudflare pide que Containers tampoco alcance.
5. MultiBaas no indexa los contratos de Base (MB-01). Entonces MultiBaas se queda fuera del motor, no del intento de lectura.

## Líneas abiertas

Solo estas tres quedan abiertas. Todo lo demás está decidido en el pack.

1. Better Auth es candidato del login de producto, no una pieza cerrada. Lo acepta o lo descarta la tarea T010, detrás de `ProductAuthPort`, con ONB-01, ONB-06, TEN-01 y TEN-02. El canal de email del login va con el candidato.
2. Los pines de versión se congelan en el primer commit de implementación. El punto de partida es Vite 8.1.4, React 19.2.7 y TanStack Query 5.101.2. El mismo commit fija también:
   - la versión de anvil y la de Alto;
   - la `compatibility_date` de los Workers;
   - los code hashes del registro en el bloque del catálogo.

   Nada queda en `latest` ni en un rango.
3. Que MultiBaas indexe Base es una comprobación de aceptación: una query real sobre un pool conocido, reconciliada con `eth_call` (MB-01).

## Gobierno

- Una enmienda cambia primero la ley. Después sube la versión de esta constitución y revisa el pack en el mismo cambio. La versión sigue semver: mayor si cambia un principio, menor si se añade uno, parche si solo se aclara.
- Un documento del pack no reabre una decisión cerrada marcándola como dudosa.
- Este pack vive en la copia de trabajo. La spec cerrada dice que no se genera un armazón de Spec Kit en el repo público. Publicar este pack o no es decisión de Ot al revisarlo.

## Enmiendas

| Versión | Fecha | Qué cambia | Fuente |
|---|---|---|---|
| 1.0.0 | 2026-09-26 | Ratificación | `inputs/mamoru-spec-v1.md` |
| 2.0.0 | 2026-10-29 | El principio III pasa de una chain a una lista cerrada: Base y Monad de ejecución, Ethereum de entrada, sin chain por defecto, el fork evita todo chain id soportado. Nuevo principio XIX: el movimiento entre chains está en alcance y cada movimiento se mide. I, IV, IX y XVI se ajustan a eso. Las decisiones cerradas cambian en la chain y suman el movimiento entre chains. La regla de idioma recoge que los packs desde 002 van en inglés. `specs/001-mamoru-v1/` no se reabre; `specs/002-multichain-monad/` es el delta | Decisiones de Ot: 2026-10-01 (Monad como chain de ejecución), 2026-10-18 (rutas abiertas entre chains; rescate en L1 por userOp con paymaster ERC-20, otto/mamoru#180), 2026-10-27 (mover fondos entre chains es núcleo y su coste se optimiza siempre) |
