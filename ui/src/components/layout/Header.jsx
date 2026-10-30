import { NavLink } from "react-router-dom";
import Logo from "./Logo.jsx";
import { useWallet } from "../../context/WalletContext.jsx";
import { useFaucet } from "../../hooks/useFaucet.js";
import { fmtCkb, fmtUnits, shortAddr } from "../../utils/format.js";

export default function Header() {
  const { connected, address, walletName, walletIcon, balance, token, tokenBalance, balancePending, network, connect } =
    useWallet();
  const faucet = useFaucet();
  const balClass = `wallet-bal ${balancePending ? "updating" : ""}`;
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
        {connected && faucet.enabled && token && (
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
            {faucet.loading
              ? "Requesting…"
              : faucet.cooldownLabel
                ? `◉ ${token.symbol} in ${faucet.cooldownLabel}`
                : `◉ Get ${token.symbol}`}
          </button>
        )}
        {connected && (
          <a
            className="pill get-ckb"
            href="https://faucet.nervos.org"
            target="_blank"
            rel="noreferrer"
            title="Testnet CKB from the Nervos faucet (needed for order deposits and fees)"
          >
            Get CKB ↗
          </a>
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
              {walletIcon && (
                <img className="wallet-icon" src={walletIcon} alt={walletName} />
              )}
              <span className="wallet-addr">{shortAddr(address)}</span>
              {token && tokenBalance !== null && (
                <span className={balClass}>
                  {fmtUnits(tokenBalance, token.decimals)} {token.symbol}
                </span>
              )}
              {balance !== null && <span className={balClass}>{fmtCkb(balance)}</span>}
            </>
          ) : (
            "Connect Wallet"
          )}
        </button>
      </div>
    </header>
  );
}
