import { Outlet } from "react-router-dom";
import Header from "./Header.jsx";
import Footer from "./Footer.jsx";
import { useWallet } from "../../context/WalletContext.jsx";

export default function MainLayout() {
  const { connected } = useWallet();
  return (
    <div className={`app ${connected ? "is-connected" : ""}`}>
      <Header />
      <Outlet />
      <Footer />
    </div>
  );
}
