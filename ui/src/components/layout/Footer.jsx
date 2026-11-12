import { useWallet } from "../../context/WalletContext.jsx";
import { useMarket } from "../../context/MarketContext.jsx";

const STATUS = {
  live: ["up", "Live"],
  loading: ["magenta", "Connecting…"],
  offline: ["down", "Server unreachable"],
  unconfigured: ["magenta", "No market configured"],
};

export default function Footer() {
  const { network } = useWallet();
  const { status } = useMarket();
  const [tone, label] = STATUS[status];
  return (
    <footer className="foot">
      <span className="dot" />
      <span className="foot-status">
        <span className="foot-label">Connection: </span>
        <b className={tone}>{label}</b>
      </span>
      <span className="copy">© 2026 LucentDex • {network}</span>
    </footer>
  );
}
