import { useState } from "react";
import type { Hex } from "viem";
import { shortHex } from "../lib/format.ts";
import { usd, usdInput } from "../lib/money.ts";
import { type InjectedWallet } from "../lib/wallets.ts";

const load = () => import("../lib/wallet-client.ts");

type Conn = { wallet: InjectedWallet; account: Hex; balance: bigint | null };

function message(e: unknown): string {
  const err = e as {
    code?: number;
    cause?: { code?: number };
    shortMessage?: string;
    message?: string;
  };
  if (
    err?.code === 4001 ||
    err?.cause?.code === 4001 ||
    /reject|denied|cancel/i.test(err?.message ?? "")
  )
    return "Cancelled in your wallet.";
  if (/insufficient/i.test(err?.message ?? ""))
    return "Not enough ETH on Base to pay the network fee.";
  return err?.shortMessage ?? "The wallet could not complete this. Try again.";
}

function WalletIcon({ w }: { w: InjectedWallet }) {
  return w.icon ? (
    <img
      src={w.icon}
      alt=""
      width={20}
      height={20}
      className="h-5 w-5 shrink-0"
    />
  ) : (
    <span className="h-5 w-5 shrink-0 border border-wash" aria-hidden="true" />
  );
}

/** Connect a browser wallet and send USDC on Base to the account address. Hidden when no wallet is found. */
export function ConnectWallet({
  to,
  wallets,
}: {
  to: string;
  wallets: InjectedWallet[];
}) {
  const [picking, setPicking] = useState(false);
  const [conn, setConn] = useState<Conn | null>(null);
  const [busy, setBusy] = useState<null | "connecting" | "sending">(null);
  const [amount, setAmount] = useState("");
  const [tx, setTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (wallets.length === 0) return null;

  async function pick(w: InjectedWallet) {
    setPicking(false);
    setError(null);
    setBusy("connecting");
    try {
      const c = await load();
      const account = await c.connect(w.provider);
      setConn({ wallet: w, account, balance: null });
      const balance = await c
        .usdcBalance(w.provider, account)
        .catch(() => null);
      setConn({ wallet: w, account, balance });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!conn) return;
    setError(null);
    const c = await load();
    const raw = c.parseUsdc(amount);
    if (raw === null || raw <= 0n) return setError("Enter an amount.");
    if (conn.balance !== null && raw > conn.balance)
      return setError(`Your wallet has ${usd(conn.balance)} USDC.`);
    setBusy("sending");
    try {
      const hash = await c.sendUsdc(
        conn.wallet.provider,
        conn.account,
        to as Hex,
        raw,
      );
      setTx(hash);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  }

  if (!conn) {
    return (
      <div className="grid gap-3" data-testid="connect-wallet">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="cta"
            disabled={busy !== null}
            onClick={() =>
              wallets.length === 1
                ? void pick(wallets[0] as InjectedWallet)
                : setPicking((p) => !p)
            }
          >
            {busy === "connecting" ? "Check your wallet" : "Connect wallet"}
          </button>
          <span className="text-[0.85rem] text-stone">
            Or scan the code from your phone.
          </span>
        </div>
        {picking ? (
          <ul
            className="sheet m-0 grid list-none p-0"
            aria-label="Choose a wallet"
          >
            {wallets.map((w) => (
              <li key={w.id} className="border-b border-wash last:border-b-0">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-3 bg-transparent px-4 py-3 text-left text-[0.95rem] text-ink hover:bg-wash/40"
                  onClick={() => void pick(w)}
                >
                  <WalletIcon w={w} />
                  {w.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? <p className="err m-0">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="sheet grid gap-3 p-4" data-testid="wallet-send">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[0.92rem]">
          <WalletIcon w={conn.wallet} />
          <span className="font-mono" title={conn.account}>
            {shortHex(conn.account)}
          </span>
        </span>
        <span className="font-mono text-[0.8rem] text-stone">
          {conn.balance === null
            ? "Reading balance"
            : `${usd(conn.balance)} USDC on Base`}
        </span>
      </div>
      {tx ? (
        <p className="m-0 text-[0.92rem]" role="status">
          Sent. Waiting for Base to confirm.{" "}
          <a
            className="underline decoration-wash underline-offset-4 hover:text-emerald"
            href={`https://basescan.org/tx/${tx}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Basescan
          </a>
        </p>
      ) : (
        <form
          className="flex flex-wrap items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="relative min-w-[9rem] flex-1">
            <span className="sr-only">Amount in USDC</span>
            <input
              className="field"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="chipbtn"
            disabled={conn.balance === null}
            onClick={() =>
              conn.balance !== null && setAmount(usdInput(conn.balance))
            }
          >
            Max
          </button>
          <button type="submit" className="cta" disabled={busy !== null}>
            {busy === "sending" ? "Confirm in wallet" : "Send"}
          </button>
        </form>
      )}
      {error ? <p className="err m-0">{error}</p> : null}
    </div>
  );
}
