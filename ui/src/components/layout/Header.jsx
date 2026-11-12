import { NavLink } from "react-router-dom";
import Logo from "./Logo.jsx";
import { useWallet } from "../../context/WalletContext.jsx";
import { useFaucet } from "../../hooks/useFaucet.js";
import { fmtCkb, fmtUnits, shortAddr } from "../../utils/format.js";

/** Token + CKB balances; shown inside the wallet pill on wide screens and in the header strip on phones. */
function Balances({ className }) {
  const { token, tokenBalance, balance, balancePending } = useWallet();
  const cls = `${className} ${balancePending ? "updating" : ""}`;
  return (
    <>
      {token && tokenBalance !== null && (
        <span className={cls}>
          {fmtUnits(tokenBalance, token.decimals)} {token.symbol}
        </span>
      )}
      {balance !== null && <span className={cls}>{fmtCkb(balance)}</span>}
    </>
  );
}

export default function Header() {
  const { connected, address, walletName, walletIcon, token, balancePending, network, connect } = useWallet();
  const faucet = useFaucet();
  return (
    <header className="hdr">
      <Logo />
      <span className="net-badge" title={`Connected to CKB ${network.toLowerCase()}`}>
        {network}
      </span>
      <nav>
        <NavLink to="/" end className={({ isActive }) => `nav ${isActive ? "active" : ""}`}>
          Trade
        </NavLink>
      </nav>
      <div className="hdr-right">
        {connected && (
          <div className="hdr-strip">
            <div className="hdr-bals" title={balancePending ? "Includes a transaction waiting for confirmation" : undefined}>
              <Balances className="strip-bal" />
            </div>
            {faucet.enabled && token && (
              <button
                className="pill get-token"
                onClick={faucet.claim}
                disabled={faucet.loading || Boolean(faucet.cooldownLabel)}
                title={
                  faucet.cooldownLabel
                    ? `You can claim again in ${faucet.cooldownLabel}`
                    : `Mint free test ${token.symbol} to your wallet`
                }
              >
                {faucet.loading ? (
                  "Requesting…"
                ) : faucet.cooldownLabel ? (
                  <>
                    ◉ <span className="hide-phone">{token.symbol} in </span>
                    {faucet.cooldownLabel}
                  </>
                ) : (
                  `◉ Get ${token.symbol}`
                )}
              </button>
            )}
            <a
              className="pill get-ckb"
              href="https://faucet.nervos.org"
              target="_blank"
              rel="noreferrer"
              title="Testnet CKB from the Nervos faucet (needed for order deposits and fees)"
            >
              Get CKB<span className="hide-phone"> ↗</span>
            </a>
          </div>
        )}
        <button
          className="pill wallet"
          onClick={connect}
          title={
            connected
              ? `${walletName} · ${address}${balancePending ? " · balances include a transaction waiting for confirmation" : ""}`
              : undefined
          }
        >
          {connected ? (
            <>
              {walletIcon && <img className="wallet-icon" src={walletIcon} alt={walletName} />}
              <span className="wallet-addr">{shortAddr(address)}</span>
              <Balances className="wallet-bal" />
            </>
          ) : (
            "Connect Wallet"
          )}
        </button>
      </div>
    </header>
  );
}
