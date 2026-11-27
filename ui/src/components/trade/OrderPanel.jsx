import { useEffect } from "react";
import Field from "../common/Field.jsx";
import { useWallet } from "../../context/WalletContext.jsx";
import { useMarket } from "../../context/MarketContext.jsx";
import { useOrderForm } from "../../hooks/useOrderForm.js";
import { fmtCkb, fmtPriceAuto, fmtUnits } from "../../utils/format.js";

/** `priceRequest` ({ price }) fills the price field, e.g. from an order book click. */
export default function OrderPanel({ onReview, onDraftReady, priceRequest }) {
  const { connected, connect, token, balance, tokenBalance } = useWallet();
  const { marketPrice } = useMarket();
  const form = useOrderForm({ onReview, onDraftReady });
  const { side, setSide, type, setType, quote, values, setField, setPrice, invalid, submit } = form;
  const isMarket = type === "market";

  useEffect(() => {
    if (priceRequest) setPrice(priceRequest.price);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceRequest]);

  const symbol = token?.symbol ?? "TOKEN";
  const available =
    side === "buy"
      ? balance !== null && fmtCkb(balance)
      : tokenBalance !== null &&
        `${fmtUnits(tokenBalance, token.decimals)} ${symbol}`;

  return (
    <aside className="card order">
      {connected && (
        <div className="toggle">
          <button
            className={side === "buy" ? "on" : ""}
            onClick={() => setSide("buy")}
          >
            Buy
          </button>
          <button
            className={side === "sell" ? "on sell" : ""}
            onClick={() => setSide("sell")}
          >
            Sell
          </button>
        </div>
      )}

      <div className="toggle type" role="tablist" aria-label="Order type">
        {["market", "limit"].map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={type === t}
            className={type === t ? "on accent" : ""}
            onClick={() => setType(t)}
          >
            {t === "market" ? "Market" : "Limit"}
          </button>
        ))}
      </div>

      {connected ? (
        <form className="order-form" onSubmit={submit}>
          <div>
            {isMarket ? (
              <Field
                label="Price"
                hint={quote && !quote.error && `Slippage ${quote.slippage * 100}%`}
                suffix={`CKB / ${symbol}`}
                value={
                  quote && !quote.error
                    ? `≈ ${fmtPriceAuto(quote.avgPrice)} (limit ${fmtPriceAuto(Number(quote.limitPrice))})`
                    : ""
                }
                placeholder="Best available market price"
                readOnly
                disabled
              />
            ) : (
              <Field
                label="Order Price"
                hint={
                  marketPrice !== null &&
                  marketPrice !== undefined && (
                    <button type="button" onClick={() => setPrice(marketPrice)}>
                      Market {fmtPriceAuto(marketPrice)}
                    </button>
                  )
                }
                suffix={`CKB / ${symbol}`}
                placeholder="Enter order price"
                value={values.orderPrice}
                onChange={setField("orderPrice")}
                inputMode="decimal"
                invalid={invalid === "orderPrice"}
              />
            )}
            <Field
              label="Amount"
              suffix={symbol}
              placeholder="Enter amount"
              value={values.amount}
              onChange={setField("amount")}
              inputMode="decimal"
              invalid={invalid === "amount"}
            />
          </div>
          <div className="avail plain">
            Available <span>{available || "-"}</span>
          </div>
          <button
            type="submit"
            className={`cta go ${side === "sell" ? "sell" : ""}`}
            disabled={!token}
          >
            ▦ Review {side === "buy" ? "Buy" : "Sell"} order
          </button>
        </form>
      ) : (
        <>
          <Field
            label={isMarket ? "Price" : "Order Price"}
            suffix="CKB"
            placeholder={isMarket ? "Best available market price" : "Enter order price"}
            disabled
          />
          <Field
            label="Amount"
            suffix={symbol}
            placeholder="Enter amount"
            disabled
          />
          <div className="avail plain">
            Available <span>-</span>
          </div>
          <button className="cta lock" onClick={connect}>
            🔒 Connect Wallet
          </button>
          <div className="info">
            ⓘ Connect your wallet to place orders and start trading.
          </div>
        </>
      )}
    </aside>
  );
}
