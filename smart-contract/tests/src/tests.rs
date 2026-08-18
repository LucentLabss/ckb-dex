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

// Include your tests here
// See https://github.com/xxuejie/ckb-native-build-sample/blob/main/tests/src/tests.rs for more examples

// generated unit test for contract ckb-dapp-contract
#[test]
fn test_lock_script_contract() {
    // deploy contract
    let mut context = Context::default();
    let out_point = context.deploy_cell_by_name("lock-script-contract");

    // prepare scripts
    let lock_script = context
        .build_script(&out_point, Bytes::from(vec![42; 20]))
        .expect("script");

    // prepare cells
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

    let outputs_data = vec![Bytes::new(); 2];

    // build transaction
    let tx = TransactionBuilder::default()
        .input(input)
        .outputs(outputs)
        .outputs_data(outputs_data.pack())
        .build();
    let tx = context.complete_tx(tx);

    // run
    let cycles = context
        .verify_tx(&tx, 10_000_000)
        .expect("pass verification");
    println!("consume cycles: {}", cycles);
}

const CKB: u64 = 100_000_000;
const ASK_PRICE: u64 = 500 * CKB;
const ORDER_CAPACITY: u64 = 200 * CKB;
const BUYER_INPUT_CAPACITY: u64 = 700 * CKB;
const AUTHORIZATION_CAPACITY: u64 = 100 * CKB;
const TOKEN_AMOUNT: u128 = 1_000;
const MAX_CYCLES: u64 = 10_000_000;

struct DexTestEnv {
    context: Context,
    dex_out_point: OutPoint,
    mock_type_script: Script,
    maker_lock: Script,
    buyer_lock: Script,
    attacker_lock: Script,
}

impl DexTestEnv {
    fn new() -> Self {
        let mut context = Context::default();
        let dex_out_point = context.deploy_cell_by_name("dex-order-lock");
        let always_success_out_point = context.deploy_cell(ALWAYS_SUCCESS.clone());

        let mock_type_script = context
            .build_script(&always_success_out_point, Bytes::new())
            .expect("type script");
        let maker_lock = context
            .build_script(&always_success_out_point, Bytes::from(vec![1]))
            .expect("maker lock");
        let buyer_lock = context
            .build_script(&always_success_out_point, Bytes::from(vec![2]))
            .expect("buyer lock");
        let attacker_lock = context
            .build_script(&always_success_out_point, Bytes::from(vec![3]))
            .expect("attacker lock");

        Self {
            context,
            dex_out_point,
            mock_type_script,
            maker_lock,
            buyer_lock,
            attacker_lock,
        }
    }

    fn dex_lock(&mut self, ask_price: u64) -> Script {
        let maker_lock_hash: [u8; 32] = self.maker_lock.calc_script_hash().unpack();
        let mut args = maker_lock_hash.to_vec();
        args.extend_from_slice(&ask_price.to_le_bytes());
        assert_eq!(args.len(), 40);
        self.dex_lock_with_args(Bytes::from(args))
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

    fn order_input(&mut self, dex_lock: Script, has_type_script: bool) -> CellInput {
        let type_script = has_type_script.then(|| self.mock_type_script.clone());
        self.create_input(ORDER_CAPACITY, dex_lock, type_script, token_data())
    }

    fn buyer_input(&mut self) -> CellInput {
        self.create_input(
            BUYER_INPUT_CAPACITY,
            self.buyer_lock.clone(),
            None,
            Bytes::new(),
        )
    }

    fn maker_authorization_input(&mut self) -> CellInput {
        self.create_input(
            AUTHORIZATION_CAPACITY,
            self.maker_lock.clone(),
            None,
            Bytes::new(),
        )
    }

    fn attacker_input(&mut self) -> CellInput {
        self.create_input(
            AUTHORIZATION_CAPACITY,
            self.attacker_lock.clone(),
            None,
            Bytes::new(),
        )
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
}

fn token_data() -> Bytes {
    Bytes::from(TOKEN_AMOUNT.to_le_bytes().to_vec())
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
fn test_dex_fill_succeeds_when_maker_receives_full_payment() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let order_input = env.order_input(dex_lock, true);
    let buyer_input = env.buyer_input();

    let outputs = vec![
        output(ORDER_CAPACITY + ASK_PRICE, env.maker_lock.clone(), None),
        output(
            ORDER_CAPACITY,
            env.buyer_lock.clone(),
            Some(env.mock_type_script.clone()),
        ),
    ];
    let tx = env.transaction(
        vec![order_input, buyer_input],
        outputs,
        vec![Bytes::new(), token_data()],
    );

    let cycles = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("correctly paid order should pass");
    println!("successful fill cycles: {cycles}");
}

#[test]
fn test_dex_fill_fails_when_maker_is_underpaid() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let order_input = env.order_input(dex_lock, true);
    let buyer_input = env.buyer_input();

    let outputs = vec![
        output(ORDER_CAPACITY + ASK_PRICE - 1, env.maker_lock.clone(), None),
        output(
            ORDER_CAPACITY + 1,
            env.buyer_lock.clone(),
            Some(env.mock_type_script.clone()),
        ),
    ];
    let tx = env.transaction(
        vec![order_input, buyer_input],
        outputs,
        vec![Bytes::new(), token_data()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("underpayment should fail");
    assert_validation_failure(error, -9);
}

#[test]
fn test_dex_fill_fails_when_payment_uses_wrong_lock() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let order_input = env.order_input(dex_lock, true);
    let buyer_input = env.buyer_input();

    let outputs = vec![
        output(ORDER_CAPACITY + ASK_PRICE, env.attacker_lock.clone(), None),
        output(
            ORDER_CAPACITY,
            env.buyer_lock.clone(),
            Some(env.mock_type_script.clone()),
        ),
    ];
    let tx = env.transaction(
        vec![order_input, buyer_input],
        outputs,
        vec![Bytes::new(), token_data()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("payment to the wrong lock should fail");
    assert_validation_failure(error, -9);
}

#[test]
fn test_dex_fill_fails_when_maker_payment_has_type_script() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let order_input = env.order_input(dex_lock, true);
    let buyer_input = env.buyer_input();

    let outputs = vec![
        output(
            ORDER_CAPACITY + ASK_PRICE,
            env.maker_lock.clone(),
            Some(env.mock_type_script.clone()),
        ),
        output(
            ORDER_CAPACITY,
            env.buyer_lock.clone(),
            Some(env.mock_type_script.clone()),
        ),
    ];
    let tx = env.transaction(
        vec![order_input, buyer_input],
        outputs,
        vec![Bytes::new(), token_data()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("typed maker output should not count as plain CKB payment");
    assert_validation_failure(error, -9);
}

#[test]
fn test_dex_cancellation_succeeds_with_maker_authorization() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let order_input = env.order_input(dex_lock, true);
    let maker_input = env.maker_authorization_input();

    let outputs = vec![
        output(
            ORDER_CAPACITY,
            env.maker_lock.clone(),
            Some(env.mock_type_script.clone()),
        ),
        output(AUTHORIZATION_CAPACITY, env.maker_lock.clone(), None),
    ];
    let tx = env.transaction(
        vec![order_input, maker_input],
        outputs,
        vec![token_data(), Bytes::new()],
    );

    let cycles = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("maker-authorized cancellation should pass");
    println!("successful cancellation cycles: {cycles}");
}

#[test]
fn test_dex_cancellation_fails_without_maker_authorization() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let order_input = env.order_input(dex_lock, true);
    let attacker_input = env.attacker_input();

    let outputs = vec![
        output(
            ORDER_CAPACITY,
            env.attacker_lock.clone(),
            Some(env.mock_type_script.clone()),
        ),
        output(AUTHORIZATION_CAPACITY, env.attacker_lock.clone(), None),
    ];
    let tx = env.transaction(
        vec![order_input, attacker_input],
        outputs,
        vec![token_data(), Bytes::new()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("cancellation without a maker input should fail");
    assert_validation_failure(error, -9);
}

#[test]
fn test_dex_malformed_lock_arguments_fail() {
    let mut env = DexTestEnv::new();
    let malformed_dex_lock = env.dex_lock_with_args(Bytes::from(vec![0; 39]));
    let order_input = env.order_input(malformed_dex_lock, true);

    let outputs = vec![output(
        ORDER_CAPACITY,
        env.buyer_lock.clone(),
        Some(env.mock_type_script.clone()),
    )];
    let tx = env.transaction(vec![order_input], outputs, vec![token_data()]);

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("malformed DEX arguments should fail");
    assert_validation_failure(error, -2);
}

#[test]
fn test_dex_fill_fails_when_order_has_no_type_script() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let order_input = env.order_input(dex_lock, false);
    let buyer_input = env.buyer_input();

    let outputs = vec![
        output(ORDER_CAPACITY + ASK_PRICE, env.maker_lock.clone(), None),
        output(ORDER_CAPACITY, env.buyer_lock.clone(), None),
    ];
    let tx = env.transaction(
        vec![order_input, buyer_input],
        outputs,
        vec![Bytes::new(), token_data()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("an untyped order should fail on the fill path");
    assert_validation_failure(error, -11);
}

#[test]
fn test_dex_multiple_order_inputs_fail() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(ASK_PRICE);
    let first_order_input = env.order_input(dex_lock.clone(), true);
    let second_order_input = env.order_input(dex_lock, true);

    let outputs = vec![output(
        ORDER_CAPACITY * 2,
        env.buyer_lock.clone(),
        Some(env.mock_type_script.clone()),
    )];
    let tx = env.transaction(
        vec![first_order_input, second_order_input],
        outputs,
        vec![token_data()],
    );

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("multiple DEX order inputs should fail");
    assert_validation_failure(error, -10);
}

#[test]
fn test_dex_capacity_addition_overflow_fails() {
    let mut env = DexTestEnv::new();
    let dex_lock = env.dex_lock(u64::MAX);
    let order_input = env.order_input(dex_lock, true);

    let outputs = vec![output(
        ORDER_CAPACITY,
        env.buyer_lock.clone(),
        Some(env.mock_type_script.clone()),
    )];
    let tx = env.transaction(vec![order_input], outputs, vec![token_data()]);

    let error = env
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("capacity addition overflow should fail");
    assert_validation_failure(error, -6);
}
