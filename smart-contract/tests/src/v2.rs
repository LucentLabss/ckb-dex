use ckb_testtool::{
    builtin::ALWAYS_SUCCESS,
    ckb_script::{ScriptError, TransactionScriptError},
    ckb_types::{
        bytes::Bytes,
        core::{Capacity, ScriptHashType, TransactionBuilder, TransactionView},
        packed::*,
        prelude::*,
    },
    context::Context,
};
use dex_v2_core::*;

const CKB: u64 = 100_000_000;
const ORDER_CAP: u64 = 5_000 * CKB;
const CYCLES: u64 = 100_000_000;

fn hash(script: &Script) -> [u8; 32] {
    script.calc_script_hash().unpack()
}
fn token_data(n: u128) -> Bytes {
    Bytes::copy_from_slice(&n.to_le_bytes())
}
fn assert_failure(env: &Env, tx: &TransactionView, code: i8) {
    let error = env.context.verify_tx(tx, CYCLES).expect_err("must reject");
    match error
        .root_cause()
        .downcast_ref::<TransactionScriptError>()
        .unwrap()
        .script_error()
    {
        ScriptError::ValidationFailure(_, actual) => assert_eq!(*actual, code),
        other => panic!("expected validation error {code}, got {other:?}"),
    }
}

struct Env {
    context: Context,
    eid: OutPoint,
    config_code: OutPoint,
    config_type: Script,
    config_cell: OutPoint,
    admin: Script,
    treasury: Script,
    owners: Vec<Script>,
    base_type: Option<Script>,
    quote_type: Option<Script>,
    market: MarketConfig,
}

impl Env {
    // 0: token/CKB, 1: token/token, 2: CKB/token.
    fn new(pair: u8) -> Self {
        Self::with_token(pair, None)
    }
    fn with_token(pair: u8, token_binary: Option<Bytes>) -> Self {
        let mut context = Context::default();
        let eid = context.deploy_cell_by_name("dex-order-lock-v2");
        let config_code = context.deploy_cell_by_name("dex-market-config");
        let always = context.deploy_cell(ALWAYS_SUCCESS.clone());
        let admin = context
            .build_script(&always, Bytes::from(vec![90]))
            .unwrap();
        let treasury = context
            .build_script(&always, Bytes::from(vec![91]))
            .unwrap();
        let owners = (1..=16)
            .map(|i| context.build_script(&always, Bytes::from(vec![i])).unwrap())
            .collect();
        let token_code = token_binary
            .map(|binary| context.deploy_cell(binary))
            .unwrap_or_else(|| always.clone());
        let base_script = context
            .build_script_with_hash_type(
                &token_code,
                ScriptHashType::Data2,
                Bytes::from([vec![17; 32], vec![0; 4]].concat()),
            )
            .unwrap();
        let quote_script = context
            .build_script_with_hash_type(
                &token_code,
                ScriptHashType::Data2,
                Bytes::from([vec![18; 32], vec![0; 4]].concat()),
            )
            .unwrap();
        let base_type = if pair == 2 { None } else { Some(base_script) };
        let quote_type = if pair == 0 { None } else { Some(quote_script) };
        let config_type = context
            .build_script_with_hash_type(
                &config_code,
                ScriptHashType::Data2,
                Bytes::from(vec![7; 32]),
            )
            .unwrap();
        let market = MarketConfig {
            admin: hash(&admin),
            treasury: hash(&treasury),
            base: base_type.as_ref().map(hash).unwrap_or(NATIVE),
            quote: quote_type.as_ref().map(hash).unwrap_or(NATIVE),
            maker_bps: 10,
            taker_bps: 20,
            lot_size: 1,
            min_order: 1,
            max_order: 1_000_000,
            tick_num: 1,
            tick_den: 1,
            status: 0,
        };
        let config_cell = context.create_cell(
            CellOutput::new_builder()
                .capacity(1_000 * CKB)
                .lock(admin.clone())
                .type_(Some(config_type.clone()).pack())
                .build(),
            Bytes::from(market.encode()),
        );
        Self {
            context,
            eid,
            config_code,
            config_type,
            config_cell,
            admin,
            treasury,
            owners,
            base_type,
            quote_type,
            market,
        }
    }
    fn order(&self, side: u8, kind: u8, qty: u128, price: u128, owner: usize) -> Order {
        let offered = if side == BUY { qty * price } else { qty };
        Order {
            side,
            kind,
            owner: hash(&self.owners[owner]),
            market: hash(&self.config_type),
            nonce: [owner as u8 + 1; 32],
            price_num: price,
            price_den: 1,
            initial_base: qty,
            remaining_base: qty,
            remaining_offer: offered,
            fee_reserve: if side == BUY {
                ceil_div(offered * 20, BPS).unwrap() + 20
            } else {
                0
            },
            cost_budget: 500 * CKB,
            max_network_fee: 10_000,
            max_refund_fee: 10_000,
            refund_after: 1_800_000_000,
            min_fill: 1,
        }
    }
    fn lock(&mut self, order: &Order) -> Script {
        self.context
            .build_script_with_hash_type(
                &self.eid,
                ScriptHashType::Data2,
                Bytes::from(order.encode()),
            )
            .unwrap()
    }
    fn asset_type(&self, asset: [u8; 32]) -> Option<Script> {
        if asset == NATIVE {
            None
        } else if asset == self.market.base {
            self.base_type.clone()
        } else {
            self.quote_type.clone()
        }
    }
    fn output(&self, lock: Script, asset: [u8; 32], amount: u128) -> (CellOutput, Bytes) {
        let data = if asset == NATIVE {
            Bytes::new()
        } else {
            token_data(amount)
        };
        let output = CellOutput::new_builder()
            .lock(lock)
            .type_(self.asset_type(asset).pack())
            .build();
        let minimum = output
            .occupied_capacity(Capacity::bytes(data.len()).unwrap())
            .unwrap()
            .as_u64();
        let cap = if asset == NATIVE {
            minimum.max(u64::try_from(amount).unwrap())
        } else {
            minimum
        };
        (output.as_builder().capacity(cap).build(), data)
    }
    fn input(&mut self, order: &Order, cap: u64) -> CellInput {
        let lock = self.lock(order);
        let asset = if order.side == BUY {
            self.market.quote
        } else {
            self.market.base
        };
        let (output, data) = self.output(lock, asset, order.remaining_offer + order.fee_reserve);
        let point = self
            .context
            .create_cell(output.as_builder().capacity(cap).build(), data);
        CellInput::new_builder().previous_output(point).build()
    }
    fn case(&mut self, orders: Vec<Order>, base_fills: Vec<u128>, taker: usize) -> Case {
        let n = orders.len();
        let mut fills: Vec<Fill> = base_fills
            .into_iter()
            .enumerate()
            .map(|(i, base)| Fill {
                base,
                quote: if i == taker {
                    0
                } else if orders[i].side == SELL {
                    ceil_div(base * orders[i].price_num, orders[i].price_den).unwrap()
                } else {
                    base * orders[i].price_num / orders[i].price_den
                },
                payout: i as u32,
                refund: NONE,
                successor: NONE,
                network_fee: 1_000,
                treasury_capacity: 0,
            })
            .collect();
        fills[taker].quote = fills
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != taker)
            .map(|(_, f)| f.quote)
            .sum();
        let fees: Vec<u128> = orders
            .iter()
            .enumerate()
            .map(|(i, _o)| {
                let rate = if i == taker {
                    self.market.taker_bps
                } else {
                    self.market.maker_bps
                };
                fills[i].quote * rate as u128 / BPS
            })
            .collect();
        let total_fee: u128 = fees.iter().sum();
        let (treasury, treasury_data) =
            self.output(self.treasury.clone(), self.market.quote, total_fee);
        let native_fee = if self.market.quote == NATIVE {
            total_fee
        } else {
            0
        };
        let treasury_cap: u64 = treasury.capacity().unpack();
        let topup = if total_fee == 0 {
            0
        } else {
            u64::try_from(treasury_cap as u128 - native_fee).unwrap()
        };
        for (i, f) in fills.iter_mut().enumerate() {
            f.treasury_capacity = topup / n as u64 + if i == taker { topup % n as u64 } else { 0 };
        }
        let mut outputs = Vec::new();
        let mut data = Vec::new();
        for i in 0..n {
            let received_asset = if orders[i].side == BUY {
                self.market.base
            } else {
                self.market.quote
            };
            let received = if orders[i].side == BUY {
                fills[i].base
            } else {
                fills[i].quote - fees[i]
            };
            let (output, bytes) = self.output(self.owners[i].clone(), received_asset, received);
            outputs.push(output);
            data.push(bytes);
        }
        let mut inputs = Vec::new();
        for i in 0..n {
            let order = orders[i];
            inputs.push(self.input(&order, ORDER_CAP));
            let fill = fills[i];
            let mut next = order;
            next.remaining_base -= fill.base;
            next.remaining_offer -= if order.side == BUY {
                fill.quote
            } else {
                fill.base
            };
            if order.side == BUY {
                next.fee_reserve -= fees[i];
            }
            next.cost_budget = next
                .cost_budget
                .saturating_sub(fill.network_fee + fill.treasury_capacity);
            let offered_asset = if order.side == BUY {
                self.market.quote
            } else {
                self.market.base
            };
            let mut other_cap = 0;
            if next.remaining_base > 0 && order.kind == LIMIT {
                let lock = self.lock(&next);
                let (output, bytes) =
                    self.output(lock, offered_asset, next.remaining_offer + next.fee_reserve);
                let occupied = output
                    .occupied_capacity(Capacity::bytes(bytes.len()).unwrap())
                    .unwrap()
                    .as_u64();
                let cap = occupied
                    + next.cost_budget
                    + if offered_asset == NATIVE {
                        u64::try_from(next.remaining_offer + next.fee_reserve).unwrap()
                    } else {
                        0
                    };
                fills[i].successor = outputs.len() as u32;
                outputs.push(output.as_builder().capacity(cap).build());
                data.push(bytes);
                other_cap = cap;
            } else if next.remaining_offer + next.fee_reserve > 0 && offered_asset != NATIVE {
                let (output, bytes) = self.output(
                    self.owners[i].clone(),
                    offered_asset,
                    next.remaining_offer + next.fee_reserve,
                );
                other_cap = output.capacity().unpack();
                fills[i].refund = outputs.len() as u32;
                outputs.push(output);
                data.push(bytes);
            }
            let received_asset = if order.side == BUY {
                self.market.base
            } else {
                self.market.quote
            };
            let native_in = if received_asset == NATIVE {
                fill.quote - fees[i]
            } else {
                0
            };
            // A BUY of native CKB receives base units, not quote units.
            let native_in = if received_asset == NATIVE && order.side == BUY {
                fill.base
            } else {
                native_in
            };
            let native_out = if offered_asset == NATIVE {
                if order.side == BUY {
                    fill.quote + fees[i]
                } else {
                    fill.base
                }
            } else {
                0
            };
            let cap = ORDER_CAP as u128 + native_in
                - native_out
                - other_cap as u128
                - fill.network_fee as u128
                - fill.treasury_capacity as u128;
            outputs[i] = outputs[i]
                .clone()
                .as_builder()
                .capacity(u64::try_from(cap).unwrap())
                .build();
        }
        let treasury_output = if total_fee > 0 {
            let index = outputs.len() as u32;
            outputs.push(treasury);
            data.push(treasury_data);
            index
        } else {
            NONE
        };
        Case {
            orders,
            inputs,
            outputs,
            data,
            fills,
            taker,
            treasury_output,
        }
    }
    fn tx(&mut self, case: &Case) -> TransactionView {
        let mut witness = vec![VERSION, 0, case.orders.len() as u8, case.taker as u8];
        witness.extend_from_slice(&case.treasury_output.to_le_bytes());
        for fill in &case.fills {
            fill.encode(&mut witness);
        }
        let witness = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(witness)).pack())
            .build();
        let tx = TransactionBuilder::default()
            .inputs(case.inputs.clone())
            .outputs(case.outputs.clone())
            .outputs_data(case.data.clone().pack())
            .witness(witness.as_bytes().pack())
            .cell_dep(
                CellDep::new_builder()
                    .out_point(self.config_cell.clone())
                    .build(),
            )
            .build();
        self.context.complete_tx(tx)
    }
    fn refund_tx(
        &mut self,
        order: &Order,
        action: u8,
        fee: u64,
        since: u64,
        authorized: bool,
    ) -> TransactionView {
        let owner = self
            .owners
            .iter()
            .find(|lock| hash(lock) == order.owner)
            .unwrap()
            .clone();
        let input = self
            .input(order, ORDER_CAP)
            .as_builder()
            .since(since)
            .build();
        let asset = if order.side == BUY {
            self.market.quote
        } else {
            self.market.base
        };
        let (output, data) = self.output(
            owner.clone(),
            asset,
            order.remaining_offer + order.fee_reserve,
        );
        let mut inputs = vec![input];
        let mut outputs = vec![output.as_builder().capacity(ORDER_CAP - fee).build()];
        let mut outputs_data = vec![data];
        if authorized {
            let auth_point = self.context.create_cell(
                CellOutput::new_builder()
                    .capacity(100 * CKB)
                    .lock(owner.clone())
                    .build(),
                Bytes::new(),
            );
            inputs.push(CellInput::new_builder().previous_output(auth_point).build());
            outputs.push(
                CellOutput::new_builder()
                    .capacity(100 * CKB)
                    .lock(owner)
                    .build(),
            );
            outputs_data.push(Bytes::new());
        }
        let mut witness = vec![VERSION, action];
        witness.extend_from_slice(&0u32.to_le_bytes());
        witness.extend_from_slice(&fee.to_le_bytes());
        let witness = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(witness)).pack())
            .build();
        let tx = TransactionBuilder::default()
            .inputs(inputs)
            .outputs(outputs)
            .outputs_data(outputs_data.pack())
            .witness(witness.as_bytes().pack())
            .build();
        self.context.complete_tx(tx)
    }
}

struct Case {
    orders: Vec<Order>,
    inputs: Vec<CellInput>,
    outputs: Vec<CellOutput>,
    data: Vec<Bytes>,
    fills: Vec<Fill>,
    taker: usize,
    treasury_output: u32,
}

#[test]
fn v2_full_crossing_fill_supports_every_asset_direction() {
    for pair in 0..3 {
        let mut e = Env::new(pair);
        let orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let c = e.case(orders, vec![1000, 1000], 0);
        let tx = e.tx(&c);
        let cycles = e.context.verify_tx(&tx, CYCLES).unwrap();
        println!("v2 pair {pair} full fill: {cycles} cycles");
    }
}

#[test]
fn v2_partial_fill_creates_exact_successor_and_cancels_remaining_order() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, LIMIT, 400, 3, 0),
        e.order(SELL, LIMIT, 1000, 2, 1),
    ];
    let c = e.case(orders, vec![400, 400], 0);
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
    let index = c.fills[1].successor as usize;
    let next = Order::decode(c.outputs[index].lock().args().raw_data().as_ref()).unwrap();
    assert_eq!(next.remaining_base, 600);
    assert_eq!(next.remaining_offer, 600);
    assert!(next.cost_budget < c.orders[1].cost_budget);
    assert_eq!(next.nonce, c.orders[1].nonce);
    let successor = e
        .context
        .create_cell(c.outputs[index].clone(), c.data[index].clone());
    let refund = e.refund_tx(&next, 1, 1_000, 0, true);
    let mut refund_inputs: Vec<CellInput> = refund.inputs().into_iter().collect();
    refund_inputs[0] = refund_inputs[0]
        .clone()
        .as_builder()
        .previous_output(successor)
        .build();
    let next_capacity: u64 = c.outputs[index].capacity().unpack();
    let mut refund_outputs: Vec<CellOutput> = refund.outputs().into_iter().collect();
    refund_outputs[0] = refund_outputs[0]
        .clone()
        .as_builder()
        .capacity(next_capacity - 1_000)
        .build();
    let refund = refund
        .as_advanced_builder()
        .set_inputs(refund_inputs)
        .set_outputs(refund_outputs)
        .build();
    e.context.verify_tx(&refund, CYCLES).unwrap();
}

#[test]
fn v2_market_buy_and_sell_refund_unfilled_balance_without_successor() {
    for pair in 0..3 {
        for side in [BUY, SELL] {
            let mut e = Env::new(pair);
            let orders = vec![
                e.order(side, MARKET, 1000, if side == BUY { 3 } else { 1 }, 0),
                e.order(1 - side, LIMIT, 400, 2, 1),
            ];
            let c = e.case(orders, vec![400, 400], 0);
            assert_eq!(c.fills[0].successor, NONE);
            let tx = e.tx(&c);
            e.context.verify_tx(&tx, CYCLES).unwrap();
        }
    }
}

#[test]
fn v2_market_order_consumes_multiple_makers_at_their_prices() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, MARKET, 1000, 4, 0),
        e.order(SELL, LIMIT, 400, 2, 1),
        e.order(SELL, LIMIT, 600, 3, 2),
    ];
    let c = e.case(orders, vec![1000, 400, 600], 0);
    assert_eq!(c.fills[0].quote, 2600);
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_rejects_price_bound_violation() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, LIMIT, 1000, 1, 0),
        e.order(SELL, LIMIT, 1000, 2, 1),
    ];
    // Keep the escrow funded, but authorise a price below the proposed execution.
    let mut orders = orders;
    orders[0].remaining_offer = 3000;
    orders[0].fee_reserve = 100;
    let c = e.case(orders, vec![1000, 1000], 0);
    let tx = e.tx(&c);
    assert_failure(&e, &tx, PRICE);
}

#[test]
fn v2_rejects_modified_successor_terms_and_reset_budgets() {
    for field in [
        "owner", "market", "nonce", "price", "quantity", "offer", "fee", "budget",
    ] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, LIMIT, 400, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let mut c = e.case(orders, vec![400, 400], 0);
        let index = c.fills[1].successor as usize;
        let mut next = Order::decode(c.outputs[index].lock().args().raw_data().as_ref()).unwrap();
        match field {
            "owner" => next.owner = [99; 32],
            "market" => next.market = [99; 32],
            "nonce" => next.nonce = [99; 32],
            "price" => next.price_num += 1,
            "quantity" => next.remaining_base += 1,
            "offer" => next.remaining_offer += 1,
            "fee" => next.fee_reserve += 1,
            "budget" => next.cost_budget = c.orders[1].cost_budget,
            _ => unreachable!(),
        }
        let lock = e.lock(&next);
        c.outputs[index] = c.outputs[index].clone().as_builder().lock(lock).build();
        let tx = e.tx(&c);
        assert_failure(&e, &tx, SUCCESSOR);
    }
}

#[test]
fn v2_rejects_shared_payout_or_hidden_outputs() {
    for hidden in [false, true] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let mut c = e.case(orders, vec![1000, 1000], 0);
        if hidden {
            c.outputs.push(
                CellOutput::new_builder()
                    .capacity(100 * CKB)
                    .lock(e.admin.clone())
                    .build(),
            );
            c.data.push(Bytes::new());
        } else {
            c.fills[1].payout = c.fills[0].payout;
        }
        let tx = e.tx(&c);
        assert_failure(&e, &tx, OUTPUT);
    }
}

#[test]
fn v2_rejects_wrong_token_amount_or_recipient() {
    for wrong_owner in [false, true] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let mut c = e.case(orders, vec![1000, 1000], 0);
        if wrong_owner {
            c.outputs[0] = c.outputs[0]
                .clone()
                .as_builder()
                .lock(e.admin.clone())
                .build();
        } else {
            c.data[0] = token_data(999);
        }
        let tx = e.tx(&c);
        assert_failure(&e, &tx, if wrong_owner { OUTPUT } else { ASSET });
    }
}

#[test]
fn v2_rejects_fee_diversion_and_treasury_overfunding() {
    for defect in ["recipient", "overfund", "amount"] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let mut c = e.case(orders, vec![1000, 1000], 0);
        let index = c.treasury_output as usize;
        match defect {
            "recipient" => {
                c.outputs[index] = c.outputs[index]
                    .clone()
                    .as_builder()
                    .lock(e.admin.clone())
                    .build()
            }
            "overfund" => {
                c.fills[0].treasury_capacity += CKB;
                let old: u64 = c.outputs[index].capacity().unpack();
                c.outputs[index] = c.outputs[index]
                    .clone()
                    .as_builder()
                    .capacity(old + CKB)
                    .build();
                let old: u64 = c.outputs[0].capacity().unpack();
                c.outputs[0] = c.outputs[0]
                    .clone()
                    .as_builder()
                    .capacity(old - CKB)
                    .build();
            }
            "amount" => c.data[index] = token_data(1),
            _ => unreachable!(),
        }
        let tx = e.tx(&c);
        assert_failure(
            &e,
            &tx,
            if defect == "recipient" {
                OUTPUT
            } else if defect == "amount" {
                ASSET
            } else {
                FEE
            },
        );
    }
}

#[test]
fn v2_rejects_network_fee_over_cap_or_total_budget() {
    for over_total in [false, true] {
        let mut e = Env::new(1);
        let mut orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        if over_total {
            orders[0].cost_budget = 1;
        }
        let mut c = e.case(orders, vec![1000, 1000], 0);
        if !over_total {
            c.fills[0].network_fee = 10_001;
        }
        let tx = e.tx(&c);
        assert_failure(&e, &tx, BUDGET);
    }
}

#[test]
fn v2_owner_can_cancel_without_market_dependency() {
    for pair in 0..3 {
        let mut e = Env::new(pair);
        let order = e.order(BUY, LIMIT, 1000, 2, 0);
        let tx = e.refund_tx(&order, 1, 1000, 0, true);
        e.context.verify_tx(&tx, CYCLES).unwrap();
        let tx = e.refund_tx(&order, 1, 1000, 0, false);
        assert_failure(&e, &tx, AUTH);
    }
}

#[test]
fn v2_permissionless_refund_requires_absolute_timestamp_since() {
    for pair in 0..3 {
        let mut e = Env::new(pair);
        let order = e.order(BUY, MARKET, 1000, 2, 0);
        for since in [
            0,
            order.refund_after,
            0x4000_0000_0000_0000 | (order.refund_after - 1),
            0xc000_0000_0000_0000 | order.refund_after,
        ] {
            let tx = e.refund_tx(&order, 2, 1000, since, false);
            assert_failure(&e, &tx, SINCE);
        }
        let tx = e.refund_tx(
            &order,
            2,
            1000,
            0x4000_0000_0000_0000 | order.refund_after,
            false,
        );
        e.context.verify_tx(&tx, CYCLES).unwrap();
    }
}

#[test]
fn v2_late_fill_remains_valid_without_claiming_hard_expiry() {
    let mut e = Env::new(1);
    let mut buy = e.order(BUY, MARKET, 1000, 3, 0);
    buy.refund_after = 1; // A refund-enabling deadline, not a settlement upper time bound.
    let orders = vec![buy, e.order(SELL, LIMIT, 1000, 2, 1)];
    let c = e.case(orders, vec![1000, 1000], 0);
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_small_execution_fees_round_down_without_historical_credit() {
    let mut e = Env::new(1);
    let buy = e.order(BUY, LIMIT, 1000, 3, 0);
    let reserve = buy.fee_reserve;
    let c = e.case(vec![buy, e.order(SELL, LIMIT, 10, 2, 1)], vec![10, 10], 0);
    let next = Order::decode(
        c.outputs[c.fills[0].successor as usize]
            .lock()
            .args()
            .raw_data()
            .as_ref(),
    )
    .unwrap();
    assert_eq!(next.fee_reserve, reserve);
    assert_eq!(c.treasury_output, NONE);
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_rejects_market_to_market_and_duplicate_order_nonces() {
    for duplicate in [false, true] {
        let mut e = Env::new(1);
        let buy = e.order(BUY, MARKET, 1000, 3, 0);
        let mut sell = e.order(SELL, if duplicate { LIMIT } else { MARKET }, 1000, 2, 1);
        if duplicate {
            sell.nonce = buy.nonce;
        }
        let c = e.case(vec![buy, sell], vec![1000, 1000], 0);
        let tx = e.tx(&c);
        assert_failure(&e, &tx, if duplicate { STATE } else { MARKET_ERROR });
    }
}

#[test]
fn v2_rejects_minimum_fill_violation_and_arithmetic_overflow() {
    let mut e = Env::new(1);
    let mut buy = e.order(BUY, LIMIT, 1000, 3, 0);
    buy.min_fill = 100;
    let c = e.case(vec![buy, e.order(SELL, LIMIT, 10, 2, 1)], vec![10, 10], 0);
    let tx = e.tx(&c);
    assert_failure(&e, &tx, MIN_FILL);
    assert_eq!(mul(u128::MAX, 2), Err(OVERFLOW));
    assert_eq!(ceil_div(u128::MAX, u128::MAX), Ok(1));
}

#[test]
fn v2_encodings_are_fixed_length_and_reject_truncation() {
    let e = Env::new(1);
    let order = e.order(BUY, LIMIT, 1000, 3, 0);
    assert_eq!(order.encode().len(), ORDER_LEN);
    assert_eq!(e.market.encode().len(), CONFIG_LEN);
    assert_eq!(Order::decode(&order.encode()).unwrap(), order);
    assert_eq!(MarketConfig::decode(&e.market.encode()).unwrap(), e.market);
    for n in 0..ORDER_LEN {
        assert_eq!(Order::decode(&order.encode()[..n]), Err(FORMAT));
    }
}

fn config_update(e: &mut Env, next: MarketConfig, authorized: bool) -> TransactionView {
    let input = CellInput::new_builder()
        .previous_output(e.config_cell.clone())
        .build();
    let output = CellOutput::new_builder()
        .capacity(1_000 * CKB)
        .lock(e.admin.clone())
        .type_(Some(e.config_type.clone()).pack())
        .build();
    let mut inputs = vec![input];
    let mut outputs = vec![output];
    let mut data = vec![Bytes::from(next.encode())];
    if authorized {
        let point = e.context.create_cell(
            CellOutput::new_builder()
                .capacity(100 * CKB)
                .lock(e.admin.clone())
                .build(),
            Bytes::new(),
        );
        inputs.push(CellInput::new_builder().previous_output(point).build());
        outputs.push(
            CellOutput::new_builder()
                .capacity(100 * CKB)
                .lock(e.admin.clone())
                .build(),
        );
        data.push(Bytes::new());
    }
    let tx = TransactionBuilder::default()
        .inputs(inputs)
        .outputs(outputs)
        .outputs_data(data.pack())
        .build();
    e.context.complete_tx(tx)
}

#[test]
fn v2_admin_can_rotate_treasury_but_cannot_change_existing_market_policy() {
    let mut e = Env::new(1);
    let mut next = e.market;
    next.treasury = hash(&e.owners[0]);
    let tx = config_update(&mut e, next, true);
    e.context.verify_tx(&tx, CYCLES).unwrap();
    // The configuration input itself is admin-locked, so its lock also authenticates an update.
    let tx = config_update(&mut e, next, false);
    e.context.verify_tx(&tx, CYCLES).unwrap();
    for field in ["fees", "base", "quote", "admin", "tick", "lot", "limits"] {
        let mut e = Env::new(1);
        let mut next = e.market;
        match field {
            "fees" => next.maker_bps += 1,
            "base" => next.base = [99; 32],
            "quote" => next.quote = [99; 32],
            "admin" => next.admin = hash(&e.owners[0]),
            "tick" => next.tick_num += 1,
            "lot" => next.lot_size = 2,
            "limits" => next.max_order += 1,
            _ => unreachable!(),
        }
        let tx = config_update(&mut e, next, true);
        assert_failure(&e, &tx, if field == "admin" { AUTH } else { CONFIG });
    }
}

#[test]
fn v2_market_creation_requires_type_id_and_admin_authorization() {
    for authorized in [false, true] {
        let mut e = Env::new(1);
        let lock = if authorized {
            e.admin.clone()
        } else {
            e.owners[0].clone()
        };
        let point = e.context.create_cell(
            CellOutput::new_builder()
                .capacity(1_000 * CKB)
                .lock(lock)
                .build(),
            Bytes::new(),
        );
        let input = CellInput::new_builder().previous_output(point).build();
        let mut seed = input.as_slice().to_vec();
        seed.extend_from_slice(&0u64.to_le_bytes());
        let id = CellOutput::calc_data_hash(&Bytes::from(seed));
        let script = e
            .context
            .build_script_with_hash_type(&e.config_code, ScriptHashType::Data2, id.as_bytes())
            .unwrap();
        let output = CellOutput::new_builder()
            .capacity(1_000 * CKB)
            .lock(e.admin.clone())
            .type_(Some(script).pack())
            .build();
        let tx = TransactionBuilder::default()
            .input(input)
            .output(output)
            .output_data(Bytes::from(e.market.encode()).pack())
            .build();
        let tx = e.context.complete_tx(tx);
        if authorized {
            e.context.verify_tx(&tx, CYCLES).unwrap();
        } else {
            assert_failure(&e, &tx, AUTH);
        }
    }
}

fn decode_hex(text: &str) -> Vec<u8> {
    text.strip_prefix("0x")
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn real_xudt() -> Bytes {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/xudt-testnet.json")).unwrap();
    let bytes = Bytes::from(decode_hex(fixture["code"].as_str().unwrap()));
    assert_eq!(
        CellOutput::calc_data_hash(&bytes).as_slice(),
        decode_hex(fixture["dataHash"].as_str().unwrap()).as_slice()
    );
    bytes
}

#[test]
fn v2_real_xudt_conservation_full_partial_and_market_settlements() {
    for pair in 0..3 {
        for kind in [LIMIT, MARKET] {
            let mut e = Env::with_token(pair, Some(real_xudt()));
            let orders = vec![
                e.order(BUY, kind, 1000, 3, 0),
                e.order(SELL, LIMIT, 400, 2, 1),
            ];
            let c = e.case(orders, vec![400, 400], 0);
            let tx = e.tx(&c);
            let cycles = e.context.verify_tx(&tx, CYCLES).unwrap();
            println!("v2 real xUDT pair {pair} kind {kind}: {cycles} cycles");
        }
    }
}

#[test]
fn v2_real_xudt_fixture_rejects_token_inflation() {
    let mut e = Env::with_token(1, Some(real_xudt()));
    let ty = e.base_type.clone();
    let point = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(200 * CKB)
            .lock(e.owners[0].clone())
            .type_(ty.clone().pack())
            .build(),
        token_data(1000),
    );
    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(point).build())
        .output(
            CellOutput::new_builder()
                .capacity(200 * CKB)
                .lock(e.owners[0].clone())
                .type_(ty.pack())
                .build(),
        )
        .output_data(token_data(1001).pack())
        .build();
    let tx = e.context.complete_tx(tx);
    assert_failure(&e, &tx, -52); // xUDT ERROR_AMOUNT, not an unrelated VM failure.
}

#[test]
fn v2_limit_sell_can_take_a_resting_buy_at_the_buy_makers_price() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(SELL, LIMIT, 1000, 1, 0),
        e.order(BUY, LIMIT, 1000, 3, 1),
    ];
    let c = e.case(orders, vec![1000, 1000], 0);
    assert_eq!(c.fills[0].quote, 3000);
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_rejects_a_partial_better_maker_before_another_maker() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, MARKET, 1000, 4, 0),
        e.order(SELL, LIMIT, 500, 2, 1),
        e.order(SELL, LIMIT, 500, 3, 2),
    ];
    let c = e.case(orders, vec![800, 300, 500], 0);
    let tx = e.tx(&c);
    assert_failure(&e, &tx, AMOUNT);
}

#[test]
fn v2_rejects_maker_price_ordering_and_incorrect_execution_quote() {
    for wrong_quote in [false, true] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, MARKET, 1000, 4, 0),
            e.order(SELL, LIMIT, 500, if wrong_quote { 2 } else { 3 }, 1),
            e.order(SELL, LIMIT, 500, 2, 2),
        ];
        let mut c = e.case(orders, vec![1000, 500, 500], 0);
        if wrong_quote {
            c.fills[1].quote += 1;
        }
        let tx = e.tx(&c);
        assert_failure(&e, &tx, PRICE);
    }
}

#[test]
fn v2_paused_market_cannot_settle_but_owner_refund_still_works() {
    let mut e = Env::new(1);
    e.market.status = 1;
    e.config_cell = e.context.create_cell(
        CellOutput::new_builder()
            .capacity(1000 * CKB)
            .lock(e.admin.clone())
            .type_(Some(e.config_type.clone()).pack())
            .build(),
        Bytes::from(e.market.encode()),
    );
    let orders = vec![
        e.order(BUY, LIMIT, 1000, 3, 0),
        e.order(SELL, LIMIT, 1000, 2, 1),
    ];
    let c = e.case(orders, vec![1000, 1000], 0);
    let tx = e.tx(&c);
    assert_failure(&e, &tx, MARKET_ERROR);
    let tx = e.refund_tx(&c.orders[0], 1, 1000, 0, true);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_expired_refund_rejects_wrong_owner_asset_amount_and_extra_outputs() {
    for defect in ["owner", "amount", "fee", "extra"] {
        let mut e = Env::new(1);
        let order = e.order(SELL, MARKET, 1000, 2, 0);
        let tx = e.refund_tx(
            &order,
            2,
            1000,
            0x4000_0000_0000_0000 | order.refund_after,
            false,
        );
        let mut outputs: Vec<CellOutput> = tx.outputs().into_iter().collect();
        let mut data: Vec<Bytes> = tx
            .outputs_data()
            .into_iter()
            .map(|b| b.raw_data())
            .collect();
        match defect {
            "owner" => {
                outputs[0] = outputs[0]
                    .clone()
                    .as_builder()
                    .lock(e.treasury.clone())
                    .build()
            }
            "amount" => data[0] = token_data(999),
            "fee" => {
                outputs[0] = outputs[0]
                    .clone()
                    .as_builder()
                    .capacity(ORDER_CAP - 1001)
                    .build()
            }
            "extra" => {
                outputs.push(outputs[0].clone());
                data.push(data[0].clone());
            }
            _ => unreachable!(),
        }
        let tx = tx
            .as_advanced_builder()
            .set_outputs(outputs)
            .set_outputs_data(data.iter().map(|b| b.pack()).collect())
            .build();
        assert!(e.context.verify_tx(&tx, CYCLES).is_err(), "{defect}");
    }
}

#[test]
fn v2_refund_fee_is_bounded_and_deadline_cannot_be_disabled() {
    let mut e = Env::new(1);
    let order = e.order(BUY, MARKET, 1000, 2, 0);
    let since = 0x4000_0000_0000_0000 | order.refund_after;
    let tx = e.refund_tx(&order, 2, 10001, since, false);
    assert_failure(&e, &tx, BUDGET);
    let mut order = order;
    order.refund_after = 0;
    let tx = e.refund_tx(&order, 2, 1000, since, false);
    assert_failure(&e, &tx, SINCE);
}

#[test]
fn v2_maximum_batch_of_sixteen_orders_is_bounded() {
    let mut e = Env::new(1);
    let mut orders = vec![e.order(BUY, MARKET, 1500, 3, 0)];
    for i in 1..16 {
        orders.push(e.order(SELL, LIMIT, 100, 2, i));
    }
    let mut amounts = vec![1500];
    amounts.extend(vec![100; 15]);
    let c = e.case(orders, amounts, 0);
    let tx = e.tx(&c);
    let cycles = e.context.verify_tx(&tx, CYCLES).unwrap();
    println!("v2 max batch: {cycles} cycles");
}

#[test]
fn v2_market_config_cannot_be_destroyed_or_duplicated() {
    for duplicate in [false, true] {
        let mut e = Env::new(1);
        let next = e.market;
        let tx = config_update(&mut e, next, false);
        let mut outputs: Vec<CellOutput> = tx.outputs().into_iter().collect();
        let mut data: Vec<Bytes> = tx
            .outputs_data()
            .into_iter()
            .map(|b| b.raw_data())
            .collect();
        if duplicate {
            outputs.push(outputs[0].clone());
            data.push(data[0].clone());
        } else {
            outputs[0] = outputs[0]
                .clone()
                .as_builder()
                .type_(None::<Script>.pack())
                .build();
            data[0] = Bytes::new();
        }
        let tx = tx
            .as_advanced_builder()
            .set_outputs(outputs)
            .set_outputs_data(data.iter().map(|b| b.pack()).collect())
            .build();
        assert_failure(&e, &tx, CONFIG);
    }
}

#[test]
fn v2_zero_fee_native_quote_needs_no_treasury_output() {
    let mut e = Env::new(0);
    let orders = vec![e.order(BUY, LIMIT, 1, 3, 0), e.order(SELL, LIMIT, 1, 2, 1)];
    let c = e.case(orders, vec![1, 1], 0);
    assert_eq!(c.treasury_output, NONE);
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_rejects_missing_successor_and_market_successor() {
    for market in [false, true] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, if market { MARKET } else { LIMIT }, 1000, 3, 0),
            e.order(SELL, LIMIT, 400, 2, 1),
        ];
        let mut c = e.case(orders, vec![400, 400], 0);
        c.fills[0].successor = if market { c.fills[0].payout } else { NONE };
        let tx = e.tx(&c);
        assert_failure(&e, &tx, SUCCESSOR);
    }
}

#[test]
fn v2_rejects_wrong_asset_and_capacity_diversion() {
    for wrong_asset in [false, true] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let mut c = e.case(orders, vec![1000, 1000], 0);
        if wrong_asset {
            c.outputs[0] = c.outputs[0]
                .clone()
                .as_builder()
                .type_(e.quote_type.clone().pack())
                .build();
        } else {
            let a: u64 = c.outputs[0].capacity().unpack();
            let b: u64 = c.outputs[1].capacity().unpack();
            c.outputs[0] = c.outputs[0].clone().as_builder().capacity(a - 1).build();
            c.outputs[1] = c.outputs[1].clone().as_builder().capacity(b + 1).build();
        }
        let tx = e.tx(&c);
        assert_failure(&e, &tx, if wrong_asset { ASSET } else { CAPACITY });
    }
}

#[test]
fn v2_rejects_insufficient_buy_reserve_and_invalid_sell_reserve() {
    for buy in [false, true] {
        let mut e = Env::new(1);
        let orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let mut c = e.case(orders, vec![1000, 1000], 0);
        let index = if buy { 0 } else { 1 };
        let mut invalid = c.orders[index];
        invalid.fee_reserve = if buy { 4 } else { 1 };
        c.inputs[index] = e.input(&invalid, ORDER_CAP);
        let tx = e.tx(&c);
        assert_failure(&e, &tx, if buy { FEE } else { STATE });
    }
}

#[test]
fn v2_rejects_malformed_and_misplaced_witness_data() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, LIMIT, 1000, 3, 0),
        e.order(SELL, LIMIT, 1000, 2, 1),
    ];
    let c = e.case(orders, vec![1000, 1000], 0);
    let tx = e.tx(&c);
    for data in [
        vec![],
        vec![1, 0],
        vec![2, 9],
        vec![2, 0, 17, 0],
        vec![2; 969],
    ] {
        let witness = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(data)).pack())
            .build();
        let bad = tx
            .as_advanced_builder()
            .set_witnesses(vec![witness.as_bytes().pack()])
            .build();
        assert!(e.context.verify_tx(&bad, CYCLES).is_err());
    }
    let payload = WitnessArgs::from_slice(tx.witnesses().get(0).unwrap().raw_data().as_ref())
        .unwrap()
        .lock()
        .to_opt()
        .unwrap();
    let witness = WitnessArgs::new_builder()
        .input_type(Some(payload.raw_data()).pack())
        .build();
    let bad = tx
        .as_advanced_builder()
        .set_witnesses(vec![witness.as_bytes().pack()])
        .build();
    assert_failure(&e, &bad, WITNESS);
}

#[test]
fn v2_market_tick_lot_and_quantity_policy_is_validated() {
    let e = Env::new(1);
    let mut market = e.market;
    market.lot_size = 10;
    market.min_order = 10;
    market.tick_num = 2;
    let mut order = e.order(BUY, LIMIT, 1000, 2, 0);
    order.min_fill = 10;
    order.validate(&market).unwrap();
    order.price_num = 3;
    assert_eq!(order.validate(&market), Err(STATE));
    order.price_num = 2;
    order.remaining_base = 1001;
    assert_eq!(order.validate(&market), Err(STATE));
    market.base = market.quote;
    assert_eq!(MarketConfig::decode(&market.encode()), Err(CONFIG));
}

#[test]
fn v2_treasury_rotation_is_used_by_settlements_without_changing_order_args() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, LIMIT, 1000, 3, 0),
        e.order(SELL, LIMIT, 1000, 2, 1),
    ];
    e.treasury = e.owners[3].clone();
    e.market.treasury = hash(&e.treasury);
    let next = e.market;
    let update = config_update(&mut e, next, false);
    e.context.verify_tx(&update, CYCLES).unwrap();
    e.config_cell = e.context.create_cell(
        update.outputs().get(0).unwrap(),
        update.outputs_data().get(0).unwrap().raw_data(),
    );
    let c = e.case(orders, vec![1000, 1000], 0);
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_market_slippage_rejects_an_out_of_bounds_leg_even_at_a_valid_average() {
    for side in [BUY, SELL] {
        let mut e = Env::new(1);
        let prices = if side == BUY { [1, 3] } else { [3, 1] };
        let orders = vec![
            e.order(side, MARKET, 1000, 2, 0),
            e.order(1 - side, LIMIT, 500, prices[0], 1),
            e.order(1 - side, LIMIT, 500, prices[1], 2),
        ];
        let c = e.case(orders, vec![1000, 500, 500], 0);
        assert_eq!(c.fills[0].quote, 2000);
        let tx = e.tx(&c);
        assert_failure(&e, &tx, PRICE);
    }
}

#[test]
fn v2_real_xudt_full_fills_work_for_buy_and_sell_takers() {
    for pair in 0..3 {
        for side in [BUY, SELL] {
            let mut e = Env::with_token(pair, Some(real_xudt()));
            let orders = vec![
                e.order(side, LIMIT, 1000, if side == BUY { 3 } else { 1 }, 0),
                e.order(1 - side, LIMIT, 1000, 2, 1),
            ];
            let c = e.case(orders, vec![1000, 1000], 0);
            let tx = e.tx(&c);
            e.context.verify_tx(&tx, CYCLES).unwrap();
        }
    }
}

#[test]
fn v2_real_xudt_market_sell_matches_multiple_buy_makers_and_refunds_residual() {
    for pair in 0..3 {
        let mut e = Env::with_token(pair, Some(real_xudt()));
        let orders = vec![
            e.order(SELL, MARKET, 1000, 1, 0),
            e.order(BUY, LIMIT, 400, 3, 1),
            e.order(BUY, LIMIT, 300, 2, 2),
        ];
        let c = e.case(orders, vec![700, 400, 300], 0);
        assert_eq!(c.fills[0].successor, NONE);
        assert_eq!(c.fills[0].quote, 1800);
        let tx = e.tx(&c);
        e.context.verify_tx(&tx, CYCLES).unwrap();
    }
}

#[test]
fn v2_fractional_prices_round_up_for_sell_makers_and_down_for_buy_makers() {
    for side in [BUY, SELL] {
        let mut e = Env::with_token(1, Some(real_xudt()));
        e.market.tick_den = 3;
        e.config_cell = e.context.create_cell(
            CellOutput::new_builder()
                .capacity(1000 * CKB)
                .lock(e.admin.clone())
                .type_(Some(e.config_type.clone()).pack())
                .build(),
            Bytes::from(e.market.encode()),
        );
        let mut taker = e.order(side, LIMIT, 34, if side == BUY { 3 } else { 1 }, 0);
        let mut maker = e.order(1 - side, LIMIT, 34, 2, 1);
        taker.price_den = 3;
        maker.price_den = 3;
        let c = e.case(vec![taker, maker], vec![34, 34], 0);
        assert_eq!(c.fills[0].quote, if side == BUY { 23 } else { 22 });
        let tx = e.tx(&c);
        e.context.verify_tx(&tx, CYCLES).unwrap();
    }
}

#[test]
fn v2_underfunded_ckb_reserves_are_rejected_before_spending_users_assets() {
    for pair in 0..3 {
        let mut e = Env::new(pair);
        let orders = vec![
            e.order(BUY, LIMIT, 1000, 3, 0),
            e.order(SELL, LIMIT, 1000, 2, 1),
        ];
        let mut c = e.case(orders, vec![1000, 1000], 0);
        let original = c.inputs[0].previous_output();
        let (cell, data) = e.context.get_cell(&original).unwrap();
        let occupied = cell
            .occupied_capacity(Capacity::bytes(data.len()).unwrap())
            .unwrap()
            .as_u64();
        let point = e
            .context
            .create_cell(cell.as_builder().capacity(occupied).build(), data);
        c.inputs[0] = CellInput::new_builder().previous_output(point).build();
        let tx = e.tx(&c);
        assert_failure(&e, &tx, CAPACITY);
    }
}

#[test]
fn v2_fees_are_ten_and_twenty_basis_points_in_quote_units() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, LIMIT, 1000, 3, 0),
        e.order(SELL, LIMIT, 1000, 2, 1),
    ];
    let c = e.case(orders, vec![1000, 1000], 0);
    // Gross quote is 2000. Taker pays 4; maker pays 2.
    assert_eq!(c.data[c.treasury_output as usize], token_data(6));
    assert_eq!(c.data[c.fills[1].payout as usize], token_data(1998));
    let tx = e.tx(&c);
    e.context.verify_tx(&tx, CYCLES).unwrap();
}

#[test]
fn v2_limit_buy_must_fund_its_remaining_quantity_at_its_limit_price() {
    let mut e = Env::new(1);
    let orders = vec![
        e.order(BUY, LIMIT, 1000, 3, 0),
        e.order(SELL, LIMIT, 1000, 2, 1),
    ];
    let mut c = e.case(orders, vec![1000, 1000], 0);
    let mut underfunded = c.orders[0];
    underfunded.remaining_offer = 1;
    c.inputs[0] = e.input(&underfunded, ORDER_CAP);
    let tx = e.tx(&c);
    assert_failure(&e, &tx, AMOUNT);
}
