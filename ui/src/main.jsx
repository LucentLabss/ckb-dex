import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { WalletProvider } from "./context/WalletContext.jsx";
import { ToastProvider } from "./context/ToastContext.jsx";
import { MarketProvider } from "./context/MarketContext.jsx";
import StartupGate from "./components/common/StartupGate.jsx";
import { verifyChain } from "./services/ckb/client.js";
import "@fontsource-variable/dm-sans";
import "./styles/variables.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/responsive.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <StartupGate verify={verifyChain}>
    <React.StrictMode>
      <BrowserRouter>
        <ToastProvider>
          <WalletProvider>
            <MarketProvider>
              <App />
            </MarketProvider>
          </WalletProvider>
        </ToastProvider>
      </BrowserRouter>
    </React.StrictMode>
  </StartupGate>,
);
