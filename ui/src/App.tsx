import { useEffect, useState } from 'react'
import { ArrowDownToLine, ChevronDown, CircleAlert, Copy, ExternalLink, RefreshCw, ShieldCheck, SlidersHorizontal, Wallet, X } from 'lucide-react'
import './App.css'

type Order = { price: string; amount: string; total: string; age: string; hash: string; side: 'ask' | 'bid' }
type Trade = { time: string; price: string; amount: string; side: 'buy' | 'sell'; hash: string }

const asks: Order[] = [
  { price: '520', amount: '180', total: '93,600', age: '2m', hash: '0x7e4b...a91c', side: 'ask' },
  { price: '515', amount: '420', total: '216,300', age: '4m', hash: '0x2d18...cc04', side: 'ask' },
  { price: '510', amount: '250', total: '127,500', age: '7m', hash: '0x91ac...30f8', side: 'ask' },
  { price: '505', amount: '100', total: '50,500', age: '11m', hash: '0x0cf2...7e16', side: 'ask' },
]
const bids: Order[] = [
  { price: '500', amount: '100', total: '50,000', age: '1m', hash: '0xa6b2...d1e0', side: 'bid' },
  { price: '495', amount: '300', total: '148,500', age: '5m', hash: '0x4b20...f33b', side: 'bid' },
  { price: '490', amount: '210', total: '102,900', age: '9m', hash: '0xd971...a15c', side: 'bid' },
  { price: '480', amount: '600', total: '288,000', age: '14m', hash: '0x31ad...55e2', side: 'bid' },
]
const trades: Trade[] = [
  { time: '12:42:18', price: '500', amount: '100', side: 'buy', hash: '0x91a3...44b2' },
  { time: '12:39:02', price: '505', amount: '50', side: 'sell', hash: '0x0cfa...8e31' },
  { time: '12:31:47', price: '500', amount: '220', side: 'buy', hash: '0x7d02...9c10' },
  { time: '12:26:11', price: '510', amount: '80', side: 'sell', hash: '0x321e...51aa' },
]
const apiBase = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1'

function App() {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [apiError, setApiError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`${apiBase}/markets`).then((response) => {
      if (!response.ok) throw new Error(`GET /markets returned HTTP ${response.status}`)
      return response.json()
    }).catch((error: Error) => {
      if (!cancelled) setApiError(`${error.message}. The interface is using development fixture data.`)
    })
    return () => { cancelled = true }
  }, [])

  function refreshBook() {
    setRefreshing(true)
    setApiError(null)
    window.setTimeout(() => { setRefreshing(false); setNotice('Market snapshot refreshed from the local fixture.') }, 550)
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">C</span><span>CKB<span className="brand-muted"> / DEX</span></span><span className="dev-chip">DEVNET</span></div>
      <nav><button className="nav-link active">Trade</button><button className="nav-link">Portfolio</button><button className="nav-link">Activity</button></nav>
      <button className="wallet-button" onClick={() => setNotice('Wallet connection is not available in this development build.')}><Wallet size={16} /> Connect wallet</button>
    </header>
    <main>
      <div className="page-heading"><div><p className="eyebrow">NON-CUSTODIAL ORDER BOOK</p><h1>Trade with precision.</h1></div><div className="system-status"><span className="status-dot" /> Indexer online <span className="divider" /> Block 1,842,091</div></div>
      {(apiError || notice) && <div className={`alert ${apiError ? 'error' : 'notice'}`}><CircleAlert size={17} /><span>{apiError ?? notice}</span><button aria-label="Dismiss" onClick={() => { setApiError(null); setNotice(null) }}><X size={16} /></button></div>}
      <section className="market-strip"><div className="market-name"><span className="token-icon">X</span><div><strong>TEST / CKB</strong><small>xUDT type hash · 0x9f3a...c812</small></div><ChevronDown size={16} /></div><MarketStat label="LAST PRICE" value="500" unit="CKB" /><MarketStat label="24H CHANGE" value="+2.04%" positive /><MarketStat label="24H VOLUME" value="1,248" unit="TEST" /><MarketStat label="SPREAD" value="5 CKB" /></section>
      <div className="workspace-grid">
        <section className="panel orderbook-panel"><div className="panel-header"><div><h2>Order book</h2><p>Price-time priority · Full fills only</p></div><div className="panel-actions"><button className="icon-button" title="Filter orders"><SlidersHorizontal size={16} /></button><button className="icon-button" title="Refresh market" onClick={refreshBook}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button></div></div><div className="book-meta"><span>PRICE <i>CKB</i></span><span>AMOUNT <i>TEST</i></span><span>TOTAL <i>CKB</i></span></div><div className="orders asks">{asks.map((order) => <OrderRow key={order.hash} order={order} onClick={() => setSelectedOrder(order)} />)}</div><div className="mid-price"><strong>500.00</strong><span>≈ $0.42</span><span className="mid-label">MID MARKET</span></div><div className="orders bids">{bids.map((order) => <OrderRow key={order.hash} order={order} onClick={() => setSelectedOrder(order)} />)}</div><div className="book-footer"><span><span className="live-dot" /> Live snapshot</span><span>Updated just now</span></div></section>
        <section className="panel order-entry"><div className="panel-header"><div><h2>Place an order</h2><p>Sign directly from your wallet</p></div><ShieldCheck size={19} className="secure-icon" /></div><div className="segmented"><button className={side === 'buy' ? 'selected buy' : ''} onClick={() => setSide('buy')}>Buy TEST</button><button className={side === 'sell' ? 'selected sell' : ''} onClick={() => setSide('sell')}>Sell TEST</button></div><label>Price <span>CKB per TEST</span><div className="input-wrap"><input defaultValue="500" inputMode="decimal" /><span>CKB</span></div></label><label>Amount <span>Available balance: <b>Connect wallet</b></span><div className="input-wrap"><input placeholder="0.00" inputMode="decimal" /><span>TEST</span></div></label><div className="summary"><div><span>Order value</span><strong>0 CKB</strong></div><div><span>Network fee</span><strong>Est. 0.001 CKB</strong></div><div><span>Settlement</span><strong>Atomic · on-chain</strong></div></div><button className={`primary-action ${side}`} onClick={() => setNotice('Wallet connection is not available yet. Order signing will be enabled when the wallet layer is added.')}>{side === 'buy' ? 'Review buy order' : 'Review sell order'} <ArrowDownToLine size={16} /></button><p className="entry-note">Your assets remain in your wallet until a matching order is settled on CKB.</p></section>
      </div>
      <section className="panel trades-panel"><div className="panel-header"><div><h2>Recent trades</h2><p>Confirmed settlements on CKB</p></div><button className="text-button">View all <ExternalLink size={14} /></button></div><div className="table-scroll"><table><thead><tr><th>TIME</th><th>PRICE <i>CKB</i></th><th>AMOUNT <i>TEST</i></th><th>TYPE</th><th>SETTLEMENT</th></tr></thead><tbody>{trades.map((trade) => <tr key={trade.hash}><td className="muted">{trade.time}</td><td>{trade.price}</td><td>{trade.amount}</td><td><span className={`trade-type ${trade.side}`}>{trade.side}</span></td><td><button className="hash-link">{trade.hash} <ExternalLink size={12} /></button></td></tr>)}</tbody></table></div></section>
    </main>
    <footer><span>CKB DEX · DEVELOPMENT BUILD</span><span>Data is indexed from chain projections · <a href="https://testnet.ckb.dev" target="_blank" rel="noreferrer">Explorer <ExternalLink size={12} /></a></span></footer>
    {selectedOrder && <div className="drawer-backdrop" onClick={() => setSelectedOrder(null)}><aside className="order-drawer" onClick={(event) => event.stopPropagation()}><div className="drawer-head"><div><p className="eyebrow">ORDER DETAILS</p><h2>{selectedOrder.side === 'ask' ? 'Sell' : 'Buy'} TEST</h2></div><button className="icon-button" onClick={() => setSelectedOrder(null)}><X size={18} /></button></div><div className="drawer-status"><span className="live-dot" /> Live order</div><dl><div><dt>Price</dt><dd>{selectedOrder.price} CKB / TEST</dd></div><div><dt>Remaining amount</dt><dd>{selectedOrder.amount} TEST</dd></div><div><dt>Total value</dt><dd>{selectedOrder.total} CKB</dd></div><div><dt>Created</dt><dd>{selectedOrder.age} ago</dd></div><div><dt>Outpoint</dt><dd>{selectedOrder.hash} <Copy size={13} /></dd></div></dl><button className="secondary-action" onClick={() => setNotice('Order filling requires a connected wallet and client-side transaction builder.')}>Connect wallet to fill <Wallet size={15} /></button></aside></div>}
  </div>
}

function MarketStat({ label, value, unit, positive = false }: { label: string; value: string; unit?: string; positive?: boolean }) { return <div className={`market-stat ${positive ? 'positive' : ''}`}><small>{label}</small><strong>{value} {unit && <span>{unit}</span>}</strong></div> }
function OrderRow({ order, onClick }: { order: Order; onClick: () => void }) { return <button className="order-row" onClick={onClick}><span>{order.price}</span><span>{order.amount}</span><span>{order.total}</span><i className="row-depth" style={{ width: `${Math.min(Number(order.amount) / 6, 92)}%` }} /></button> }
export default App
