use ckb_testtool::builtin::ALWAYS_SUCCESS;
use ckb_testtool::ckb_error::Error as CkbError;
use ckb_testtool::ckb_script::{ScriptError, TransactionScriptError};
use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{TransactionBuilder, TransactionView},
    packed::*,
    prelude::*,
};
use ckb_testtool::context::Context;

#[test]
fn test_lock_script_contract() {
    let mut context = Context::default();
    let out_point = context.deploy_cell_by_name("lock-script-contract");
    let lock_script = context
        .build_script(&out_point, Bytes::from(vec![42; 20]))
        .expect("script");

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(1000)
            .lock(lock_script.clone())
            .build(),
        Bytes::new(),
    );
    let input = CellInput::new_builder()
        .previous_output(input_out_point)
        .build();
    let outputs = vec![
        CellOutput::new_builder()
            .capacity(500)
            .lock(lock_script.clone())
            .build(),
        CellOutput::new_builder()
            .capacity(500)
            .lock(lock_script)
            .build(),
    ];

    let tx = TransactionBuilder::default()
        .input(input)
        .outputs(outputs)
        .outputs_data(vec![Bytes::new(); 2].pack())
        .build();
    let tx = context.complete_tx(tx);

    let cycles = context
        .verify_tx(&tx, 10_000_000)
        .expect("pass verification");
    println!("consume cycles: {cycles}");
}

const CKB: u64 = 100_000_000;
const ORDER_VERSION: u8 = 1;
const SIDE_BUY: u8 = 0;
const SIDE_SELL: u8 = 1;
const PRICE: u64 = 500 * CKB;
const SELL_ORDER_CAPACITY: u64 = 200 * CKB;
const BUYER_TOKEN_CAPACITY: u64 = 200 * CKB;
const MATCH_FEE_RESERVE: u64 = CKB;
const BUY_ORDER_CAPACITY: u64 = PRICE + BUYER_TOKEN_CAPACITY + MATCH_FEE_RESERVE;
const AUTHORIZATION_CAPACITY: u64 = 100 * CKB;
const TOKEN_AMOUNT: u128 = 1_000;
const MAX_CYCLES: u64 = 10_000_000;

struct DexTestEnv {
    context: Context,
    dex_out_point: OutPoint,
    xudt_type: Script,
    other_type: Script,
    seller_lock: Script,
    buyer_lock: Script,
    attacker_lock: Script,
}

impl DexTestEnv {
    fn new() -> Self {
        let mut context = Context::default();
        let dex_out_point = context.deploy_cell_by_name("dex-order-lock");
        let always_success_out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());

        let xudt_type = context
            .build_script(&always_success_out_point, Bytes::from(vec![10]))
            .expect("xUDT type script");
        let other_type = context
            .build_script(&always_success_out_point, Bytes::from(vec![11]))
            .expect("other type script");
        let seller_lock = context
            .build_script(&always_success_out_point, Bytes::from(vec![1]))
            .expect("seller lock");
        let buyer_lock = context
            .build_script(&always_success_out_point, Bytes::from(vec![2]))
            .expect("buyer lock");
        let attacker_lock = context
            .build_script(&always_success_out_point, Bytes::from(vec![3]))
            .expect("attacker lock");

        Self {
            context,
            dex_out_point,
            xudt_type,
            other_type,
            seller_lock,
            buyer_lock,
            attacker_lock,
        }
    }

    fn order_args(
        &self,
        version: u8,
        side: u8,
        maker_lock: &Script,
        xudt_type: &Script,
        token_amount: u128,
        price: u64,
    ) -> Bytes {
        let maker_lock_hash: [u8; 32] = maker_lock.calc_script_hash().unpack();
        let xudt_type_hash: [u8; 32] = xudt_type.calc_script_hash().unpack();

        let mut args = vec![version, side];
        args.extend_from_slice(&maker_lock_hash);
        args.extend_from_slice(&xudt_type_hash);
        args.extend_from_slice(&token_amount.to_le_bytes());
        args.extend_from_slice(&price.to_le_bytes());
        assert_eq!(args.len(), 90);
        Bytes::from(args)
    }

    fn order_lock(
        &mut self,
        side: u8,
        maker_lock: &Script,
        token_amount: u128,
        price: u64,
    ) -> Script {
        let xudt_type = self.xudt_type.clone();
        let args = self.order_args(
            ORDER_VERSION,
            side,
            maker_lock,
            &xudt_type,
            token_amount,
            price,
        );
        self.dex_lock_with_args(args)
    }

    fn dex_lock_with_args(&mut self, args: Bytes) -> Script {
        self.context
            .build_script(&self.dex_out_point, args)
            .expect("DEX lock")
    }

    fn create_input(
        &mut self,
        capacity: u64,
        lock: Script,
        type_script: Option<Script>,
        data: Bytes,
    ) -> CellInput {
        let out_point = self.context.create_cell(
            CellOutput::new_builder()
                .capacity(capacity)
                .lock(lock)
                .type_(type_script.pack())
                .build(),
            data,
        );

        CellInput::new_builder().previous_output(out_point).build()
    }

    fn sell_order_input(&mut self, lock: Script, amount: u128) -> CellInput {
        self.create_input(
            SELL_ORDER_CAPACITY,
            lock,
            Some(self.xudt_type.clone()),
            token_data(amount),
        )
    }

    fn buy_order_input(&mut self, lock: Script, capacity: u64) -> CellInput {
        self.create_input(capacity, lock, None, Bytes::new())
    }

    fn authorization_input(&mut self, lock: Script) -> CellInput {
        self.create_input(AUTHORIZATION_CAPACITY, lock, None, Bytes::new())
    }

    fn transaction(
        &mut self,
        inputs: Vec<CellInput>,
        outputs: Vec<CellOutput>,
        outputs_data: Vec<Bytes>,
    ) -> TransactionView {
        let tx = TransactionBuilder::default()
            .inputs(inputs)
            .outputs(outputs)
            .outputs_data(outputs_data.pack())
            .build();
        self.context.complete_tx(tx)
    }

    fn matching_order_inputs(
        &mut self,
        buy_amount: u128,
        buy_price: u64,
        sell_amount: u128,
        sell_price: u64,
    ) -> (CellInput, CellInput) {
        let buyer_lock = self.buyer_lock.clone();
        let seller_lock = self.seller_lock.clone();
        let buy_lock = self.order_lock(SIDE_BUY, &buyer_lock, buy_amount, buy_price);
        let sell_lock = self.order_lock(SIDE_SELL, &seller_lock, sell_amount, sell_price);

        (
            self.buy_order_input(buy_lock, BUY_ORDER_CAPACITY),
            self.sell_order_input(sell_lock, sell_amount),
        )
    }
}

fn token_data(amount: u128) -> Bytes {
    Bytes::from(amount.to_le_bytes().to_vec())
}

fn output(capacity: u64, lock: Script, type_script: Option<Script>) -> CellOutput {
    CellOutput::new_builder()
        .capacity(capacity)
        .lock(lock)
        .type_(type_script.pack())
        .build()
}

fn assert_validation_failure(error: CkbError, expected_code: i8) {
    let transaction_error = error
        .root_cause()
        .downcast_ref::<TransactionScriptError>()
        .expect("transaction script error");

    match transaction_error.script_error() {
        ScriptError::ValidationFailure(_, actual_code) => {
            assert_eq!(*actual_code, expected_code);
        }
        other => panic!("expected validation failure {expected_code}, got {other:?}"),
    }
}

#[test]
fn test_dex_exact_buy_and_sell_match_succeeds() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE);

    let outputs = vec![
        output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
        output(
            BUYER_TOKEN_CAPACITY,
            env.buyer_lock.clone(),
            Some(env.xudt_type.clone()),
        ),
    ];
    let tx = env.transaction(
        vec![buy_input, sell_input],
        outputs,
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let cycles = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("matching buy and sell orders should settle");
    println!("successful exact match cycles: {cycles}");
}

#[test]
fn test_dex_mismatched_prices_fail() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE + 1);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(
                SELL_ORDER_CAPACITY + PRICE + 1,
                env.seller_lock.clone(),
                None,
            ),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("different prices must not match");
    assert_validation_failure(error, -18);
}

#[test]
fn test_dex_mismatched_token_amounts_fail() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT - 1, PRICE);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("different token amounts must not match");
    assert_validation_failure(error, -18);
}

#[test]
fn test_dex_seller_underpayment_fails() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(
                SELL_ORDER_CAPACITY + PRICE - 1,
                env.seller_lock.clone(),
                None,
            ),
            output(
                BUYER_TOKEN_CAPACITY + 1,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("seller underpayment must fail");
    assert_validation_failure(error, -9);
}

#[test]
fn test_dex_payment_to_wrong_seller_lock_fails() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.attacker_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("payment to the wrong seller must fail");
    assert_validation_failure(error, -9);
}

#[test]
fn test_dex_typed_seller_payment_fails() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(
                SELL_ORDER_CAPACITY + PRICE,
                env.seller_lock.clone(),
                Some(env.other_type.clone()),
            ),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("typed seller payment must not count as plain CKB");
    assert_validation_failure(error, -9);
}

#[test]
fn test_dex_tokens_to_wrong_buyer_lock_fail() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.attacker_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("tokens sent to the wrong buyer must fail");
    assert_validation_failure(error, -21);
}

#[test]
fn test_dex_wrong_token_type_for_buyer_fails() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.other_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("wrong token type for buyer must fail");
    assert_validation_failure(error, -21);
}

#[test]
fn test_dex_wrong_token_amount_for_buyer_fails() {
    let mut env = DexTestEnv::new();
    let (buy_input, sell_input) =
        env.matching_order_inputs(TOKEN_AMOUNT, PRICE, TOKEN_AMOUNT, PRICE);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT - 1)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("wrong token amount for buyer must fail");
    assert_validation_failure(error, -21);
}

#[test]
fn test_dex_sell_order_asset_mismatch_fails() {
    let mut env = DexTestEnv::new();
    let buyer_lock = env.buyer_lock.clone();
    let seller_lock = env.seller_lock.clone();
    let buy_lock = env.order_lock(SIDE_BUY, &buyer_lock, TOKEN_AMOUNT, PRICE);
    let sell_lock = env.order_lock(SIDE_SELL, &seller_lock, TOKEN_AMOUNT, PRICE);
    let buy_input = env.buy_order_input(buy_lock, BUY_ORDER_CAPACITY);
    let sell_input = env.create_input(
        SELL_ORDER_CAPACITY,
        sell_lock,
        Some(env.other_type.clone()),
        token_data(TOKEN_AMOUNT),
    );

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("sell Order Cell must contain the declared xUDT");
    assert_validation_failure(error, -19);
}

#[test]
fn test_dex_buy_order_with_type_script_fails() {
    let mut env = DexTestEnv::new();
    let buyer_lock = env.buyer_lock.clone();
    let seller_lock = env.seller_lock.clone();
    let buy_lock = env.order_lock(SIDE_BUY, &buyer_lock, TOKEN_AMOUNT, PRICE);
    let sell_lock = env.order_lock(SIDE_SELL, &seller_lock, TOKEN_AMOUNT, PRICE);
    let buy_input = env.create_input(
        BUY_ORDER_CAPACITY,
        buy_lock,
        Some(env.other_type.clone()),
        Bytes::new(),
    );
    let sell_input = env.sell_order_input(sell_lock, TOKEN_AMOUNT);

    let tx = env.transaction(
        vec![buy_input, sell_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("buy Order Cell must contain plain CKB");
    assert_validation_failure(error, -25);
}

#[test]
fn test_dex_underfunded_buy_order_fails() {
    let mut env = DexTestEnv::new();
    let buyer_lock = env.buyer_lock.clone();
    let seller_lock = env.seller_lock.clone();
    let attacker_lock = env.attacker_lock.clone();
    let buy_lock = env.order_lock(SIDE_BUY, &buyer_lock, TOKEN_AMOUNT, PRICE);
    let sell_lock = env.order_lock(SIDE_SELL, &seller_lock, TOKEN_AMOUNT, PRICE);
    let buy_input = env.buy_order_input(buy_lock, PRICE + BUYER_TOKEN_CAPACITY - CKB);
    let sell_input = env.sell_order_input(sell_lock, TOKEN_AMOUNT);
    let subsidy_input = env.create_input(100 * CKB, attacker_lock.clone(), None, Bytes::new());

    let tx = env.transaction(
        vec![buy_input, sell_input, subsidy_input],
        vec![
            output(SELL_ORDER_CAPACITY + PRICE, env.seller_lock.clone(), None),
            output(
                BUYER_TOKEN_CAPACITY,
                env.buyer_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
            output(99 * CKB, attacker_lock, None),
        ],
        vec![Bytes::new(), token_data(TOKEN_AMOUNT), Bytes::new()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("buy order must fund its price and buyer token Cell");
    assert_validation_failure(error, -24);
}

#[test]
fn test_dex_two_sell_orders_do_not_form_a_match() {
    let mut env = DexTestEnv::new();
    let seller_lock = env.seller_lock.clone();
    let attacker_lock = env.attacker_lock.clone();
    let first_lock = env.order_lock(SIDE_SELL, &seller_lock, TOKEN_AMOUNT, PRICE);
    let second_lock = env.order_lock(SIDE_SELL, &attacker_lock, TOKEN_AMOUNT, PRICE);
    let first_input = env.sell_order_input(first_lock, TOKEN_AMOUNT);
    let second_input = env.sell_order_input(second_lock, TOKEN_AMOUNT);

    let tx = env.transaction(
        vec![first_input, second_input],
        vec![output(
            SELL_ORDER_CAPACITY * 2,
            env.attacker_lock.clone(),
            Some(env.xudt_type.clone()),
        )],
        vec![token_data(TOKEN_AMOUNT * 2)],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("a match requires exactly one buy and one sell order");
    assert_validation_failure(error, -18);
}

#[test]
fn test_dex_sell_cancellation_succeeds_with_maker_authorization() {
    let mut env = DexTestEnv::new();
    let seller_lock = env.seller_lock.clone();
    let order_lock = env.order_lock(SIDE_SELL, &seller_lock, TOKEN_AMOUNT, PRICE);
    let order_input = env.sell_order_input(order_lock, TOKEN_AMOUNT);
    let authorization_input = env.authorization_input(seller_lock.clone());

    let tx = env.transaction(
        vec![order_input, authorization_input],
        vec![
            output(
                SELL_ORDER_CAPACITY,
                seller_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
            output(AUTHORIZATION_CAPACITY, seller_lock, None),
        ],
        vec![token_data(TOKEN_AMOUNT), Bytes::new()],
    );

    let cycles = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("seller-authorized cancellation should pass");
    println!("successful sell cancellation cycles: {cycles}");
}

#[test]
fn test_dex_buy_cancellation_succeeds_with_maker_authorization() {
    let mut env = DexTestEnv::new();
    let buyer_lock = env.buyer_lock.clone();
    let order_lock = env.order_lock(SIDE_BUY, &buyer_lock, TOKEN_AMOUNT, PRICE);
    let order_input = env.buy_order_input(order_lock, BUY_ORDER_CAPACITY);
    let authorization_input = env.authorization_input(buyer_lock.clone());

    let tx = env.transaction(
        vec![order_input, authorization_input],
        vec![output(
            BUY_ORDER_CAPACITY + AUTHORIZATION_CAPACITY,
            buyer_lock,
            None,
        )],
        vec![Bytes::new()],
    );

    let cycles = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("buyer-authorized cancellation should pass");
    println!("successful buy cancellation cycles: {cycles}");
}

#[test]
fn test_dex_cancellation_without_maker_authorization_fails() {
    let mut env = DexTestEnv::new();
    let seller_lock = env.seller_lock.clone();
    let attacker_lock = env.attacker_lock.clone();
    let order_lock = env.order_lock(SIDE_SELL, &seller_lock, TOKEN_AMOUNT, PRICE);
    let order_input = env.sell_order_input(order_lock, TOKEN_AMOUNT);
    let attacker_input = env.authorization_input(attacker_lock.clone());

    let tx = env.transaction(
        vec![order_input, attacker_input],
        vec![
            output(
                SELL_ORDER_CAPACITY,
                attacker_lock.clone(),
                Some(env.xudt_type.clone()),
            ),
            output(AUTHORIZATION_CAPACITY, attacker_lock, None),
        ],
        vec![token_data(TOKEN_AMOUNT), Bytes::new()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("cancellation without the maker must fail");
    assert_validation_failure(error, -10);
}

#[test]
fn test_dex_malformed_arguments_fail() {
    let mut env = DexTestEnv::new();
    let malformed_lock = env.dex_lock_with_args(Bytes::from(vec![0; 89]));
    let order_input = env.buy_order_input(malformed_lock, BUY_ORDER_CAPACITY);

    let tx = env.transaction(
        vec![order_input],
        vec![output(BUY_ORDER_CAPACITY, env.attacker_lock.clone(), None)],
        vec![Bytes::new()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("malformed arguments must fail");
    assert_validation_failure(error, -2);
}

#[test]
fn test_dex_unsupported_version_fails() {
    let mut env = DexTestEnv::new();
    let buyer_lock = env.buyer_lock.clone();
    let xudt_type = env.xudt_type.clone();
    let args = env.order_args(
        ORDER_VERSION + 1,
        SIDE_BUY,
        &buyer_lock,
        &xudt_type,
        TOKEN_AMOUNT,
        PRICE,
    );
    let order_lock = env.dex_lock_with_args(args);
    let order_input = env.buy_order_input(order_lock, BUY_ORDER_CAPACITY);

    let tx = env.transaction(
        vec![order_input],
        vec![output(BUY_ORDER_CAPACITY, env.attacker_lock.clone(), None)],
        vec![Bytes::new()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("unsupported order version must fail");
    assert_validation_failure(error, -14);
}

#[test]
fn test_dex_unknown_side_fails() {
    let mut env = DexTestEnv::new();
    let buyer_lock = env.buyer_lock.clone();
    let xudt_type = env.xudt_type.clone();
    let args = env.order_args(
        ORDER_VERSION,
        2,
        &buyer_lock,
        &xudt_type,
        TOKEN_AMOUNT,
        PRICE,
    );
    let order_lock = env.dex_lock_with_args(args);
    let order_input = env.buy_order_input(order_lock, BUY_ORDER_CAPACITY);

    let tx = env.transaction(
        vec![order_input],
        vec![output(BUY_ORDER_CAPACITY, env.attacker_lock.clone(), None)],
        vec![Bytes::new()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("unknown order side must fail");
    assert_validation_failure(error, -15);
}
