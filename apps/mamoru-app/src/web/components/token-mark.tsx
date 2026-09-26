import type { TokenHolding } from '@mamoru/domain'

type Symbol = TokenHolding['token']

// Ported from the designer's TokenMark. cbBTC uses the BTC mark in Coinbase blue.
// EURC and JPYC follow the same flat disc: issuer colour, white glyph.
export function TokenMark({ symbol, size = 28 }: { symbol: Symbol | string; size?: number }) {
  return (
    <span className="inline-grid shrink-0 place-items-center" title={symbol} style={{ width: size, height: size }}>
      {symbol === 'USDC' ? (
        <svg viewBox="0 0 32 32" aria-hidden="true" className="block h-full w-full">
          <circle cx="16" cy="16" r="16" fill="#2775CA" />
          <path
            fill="#fff"
            d="M20.4 17.4c0-2.2-1.3-2.9-4-3.2-1.9-.2-2.3-.6-2.3-1.4 0-.8.6-1.4 1.8-1.4 1.1 0 1.7.4 2 1.2l2.3-.9c-.5-1.3-1.7-2.2-3.4-2.4V7.5h-2.2v1.8c-1.8.3-3 1.5-3 3.1 0 2.1 1.3 2.8 4 3.2 1.8.3 2.2.7 2.2 1.4 0 .8-.7 1.5-1.9 1.5-1.4 0-2.3-.6-2.6-1.6l-2.3.9c.6 1.6 2 2.6 4 2.9v1.8h2.2v-1.8c1.9-.3 3.2-1.6 3.2-3.4z"
          />
        </svg>
      ) : symbol === 'ETH' || symbol === 'WETH' ? (
        <svg viewBox="0 0 32 32" aria-hidden="true" className="block h-full w-full">
          <circle cx="16" cy="16" r="16" fill="#627EEA" />
          <path fill="#fff" fillOpacity=".7" d="M16.1 6.5v7.1l6 2.7z" />
          <path fill="#fff" d="M16.1 6.5 10 16.3l6.1-2.7z" />
          <path fill="#fff" fillOpacity=".7" d="M16.1 21.4v4.1l6-8.5z" />
          <path fill="#fff" d="M16.1 25.5v-4.1L10 17z" />
          <path fill="#fff" fillOpacity=".4" d="M16.1 19.3 22.1 16.6 16.1 13.9z" />
          <path fill="#fff" fillOpacity=".8" d="M10 16.6l6.1 2.7V13.9z" />
        </svg>
      ) : symbol === 'EURC' ? (
        <svg viewBox="0 0 32 32" aria-hidden="true" className="block h-full w-full">
          <circle cx="16" cy="16" r="16" fill="#2775CA" />
          <path fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" d="M20.6 10.6a6.4 6.4 0 1 0 0 10.8" />
          <path fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" d="M9.6 14.4h8.2M9.6 17.6h8.2" />
        </svg>
      ) : symbol === 'JPYC' || symbol === 'JPY' ? (
        <svg viewBox="0 0 32 32" aria-hidden="true" className="block h-full w-full">
          <circle cx="16" cy="16" r="16" fill="#1D3B8B" />
          <path fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" d="M10.8 8.6 16 16l5.2-7.4M16 16v8" />
          <path fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" d="M11.6 17.4h8.8M11.6 20.6h8.8" />
        </svg>
      ) : symbol === 'cbBTC' ? (
        <svg viewBox="0 0 32 32" aria-hidden="true" className="block h-full w-full">
          <circle cx="16" cy="16" r="16" fill="#0052FF" />
          <path
            fill="#fff"
            d="M21.4 14.2c.3-1.8-1.1-2.8-3-3.4l.6-2.5-1.5-.4-.6 2.4c-.4-.1-.8-.2-1.2-.3l.6-2.4-1.5-.4-.6 2.5c-.3-.1-.7-.2-1-.2l-2.1-.5-.4 1.6s1.1.3 1.1.3c.6.2.7.5.8.9l-.8 3.1c0 .1.1.1.1.1l-.1-.1-1.1 4.5c-.1.2-.3.5-.7.4 0 0-1.1-.3-1.1-.3l-.7 1.7 2 .5c.4.1.7.2 1.1.3l-.6 2.5 1.5.4.6-2.5c.4.1.8.2 1.2.3l-.6 2.4 1.5.4.6-2.5c2.5.5 4.4.3 5.2-2 .6-1.8 0-2.9-1.4-3.6 1-.2 1.7-1 1.9-2.5zm-3.4 4.8c-.5 1.8-3.5.8-4.5.6l.8-3.2c1 .2 4.2.7 3.7 2.6zm.4-4.8c-.4 1.7-2.9.8-3.8.6l.7-2.9c.8.2 3.5.6 3.1 2.3z"
          />
        </svg>
      ) : (
        <span className="font-mono text-[0.6rem]">{symbol.slice(0, 4)}</span>
      )}
    </span>
  )
}
