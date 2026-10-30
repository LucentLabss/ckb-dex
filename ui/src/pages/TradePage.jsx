import { useCallback, useState } from "react";
import PairBar from "../components/trade/PairBar.jsx";
import OrderBook from "../components/trade/OrderBook.jsx";
import ChartCard from "../components/trade/ChartCard.jsx";
import OrderPanel from "../components/trade/OrderPanel.jsx";
import OpenOrders from "../components/trade/OpenOrders.jsx";
import OrderConfirmModal from "../components/trade/OrderConfirmModal.jsx";
import { useOrders } from "../hooks/useOrders.js";

export default function TradePage() {
  const { open, history, loadError, prebuildOrder, prepareOrder, placeOrder, cancelOrder } = useOrders();
  const [review, setReview] = useState(null); // { draft, resetForm }
  const [priceRequest, setPriceRequest] = useState(null);
  const pickPrice = useCallback((price) => setPriceRequest({ price }), []);

  const startReview = useCallback((draft, resetForm) => setReview({ draft, resetForm }), []);
  const closeReview = useCallback(() => setReview(null), []);

  const confirm = useCallback(
    async (draft, prepared, onStage) => {
      await placeOrder(draft, prepared, onStage);
      review?.resetForm();
      setReview(null);
    },
    [placeOrder, review]
  );

  return (
    <main className="trade-grid">
      <PairBar />
      <OrderPanel onReview={startReview} onDraftReady={prebuildOrder} priceRequest={priceRequest} />
      <OrderBook onPickPrice={pickPrice} />
      <ChartCard />
      <OpenOrders open={open} history={history} error={loadError} onCancel={cancelOrder} />
      {review && (
        <OrderConfirmModal
          draft={review.draft}
          onPrepare={prepareOrder}
          onConfirm={confirm}
          onClose={closeReview}
        />
      )}
    </main>
  );
}
