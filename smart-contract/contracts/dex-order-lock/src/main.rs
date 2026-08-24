#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(any(feature = "library", test))]
extern crate alloc;

#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
ckb_std::default_alloc!(16384, 1258306, 64);

use ckb_std::{
    ckb_constants::Source,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_data, load_cell_lock, load_cell_lock_hash,
        load_cell_type_hash,
    },
};

const ORDER_ARGS_LEN: usize = 90;
const ORDER_VERSION: u8 = 1;
const SIDE_BUY: u8 = 0;
const SIDE_SELL: u8 = 1;

const ERROR_LOAD_SCRIPT: i8 = -1;
const ERROR_ARGS_LENGTH: i8 = -2;
const ERROR_MAKER_HASH: i8 = -3;
const ERROR_PRICE: i8 = -4;
const ERROR_LOAD_CAPACITY: i8 = -5;
const ERROR_CAPACITY_OVERFLOW: i8 = -6;
const ERROR_OUTPUT_CAPACITY_OVERFLOW: i8 = -7;
const ERROR_LOAD_OUTPUT_CAPACITY: i8 = -8;
const ERROR_SELLER_UNDERPAID: i8 = -9;
const ERROR_DEX_INPUT_COUNT: i8 = -10;
const ERROR_LOAD_TYPE_HASH: i8 = -12;
const ERROR_LOAD_OUTPUT_TYPE_HASH: i8 = -13;
const ERROR_VERSION: i8 = -14;
const ERROR_SIDE: i8 = -15;
const ERROR_XUDT_TYPE_HASH: i8 = -16;
const ERROR_TOKEN_AMOUNT: i8 = -17;
const ERROR_ORDER_PAIR: i8 = -18;
const ERROR_SELL_ASSET: i8 = -19;
const ERROR_LOAD_DATA: i8 = -20;
const ERROR_BUYER_TOKEN_AMOUNT: i8 = -21;
const ERROR_TOKEN_AMOUNT_OVERFLOW: i8 = -22;
const ERROR_BUYER_TOKEN_CAPACITY_OVERFLOW: i8 = -23;
const ERROR_BUY_ORDER_CAPACITY: i8 = -24;
const ERROR_BUY_ORDER_TYPE: i8 = -25;

#[derive(Clone, Copy, PartialEq, Eq)]
struct OrderArgs {
    side: u8,
    maker_lock_hash: [u8; 32],
    xudt_type_hash: [u8; 32],
    token_amount: u128,
    price: u64,
}

fn parse_order_args(args: &[u8]) -> Result<OrderArgs, i8> {
    if args.len() != ORDER_ARGS_LEN {
        ckb_std::debug!("expected {}-byte args, got {}", ORDER_ARGS_LEN, args.len());
        return Err(ERROR_ARGS_LENGTH);
    }

    if args[0] != ORDER_VERSION {
        return Err(ERROR_VERSION);
    }

    let side = args[1];
    if side != SIDE_BUY && side != SIDE_SELL {
        return Err(ERROR_SIDE);
    }

    let maker_lock_hash = args[2..34].try_into().map_err(|_| ERROR_MAKER_HASH)?;
    let xudt_type_hash = args[34..66].try_into().map_err(|_| ERROR_XUDT_TYPE_HASH)?;
    let token_bytes: [u8; 16] = args[66..82].try_into().map_err(|_| ERROR_TOKEN_AMOUNT)?;
    let price_bytes: [u8; 8] = args[82..90].try_into().map_err(|_| ERROR_PRICE)?;

    Ok(OrderArgs {
        side,
        maker_lock_hash,
        xudt_type_hash,
        token_amount: u128::from_le_bytes(token_bytes),
        price: u64::from_le_bytes(price_bytes),
    })
}

fn load_token_amount(index: usize, source: Source) -> Result<u128, i8> {
    let data = load_cell_data(index, source).map_err(|_| ERROR_LOAD_DATA)?;
    if data.len() < 16 {
        return Err(ERROR_TOKEN_AMOUNT);
    }

    let amount_bytes: [u8; 16] = data[..16].try_into().map_err(|_| ERROR_TOKEN_AMOUNT)?;
    Ok(u128::from_le_bytes(amount_bytes))
}

fn validate_sell_order(index: usize, order: OrderArgs) -> Result<(), i8> {
    match load_cell_type_hash(index, Source::Input) {
        Ok(Some(type_hash)) if type_hash == order.xudt_type_hash => {}
        Ok(_) => return Err(ERROR_SELL_ASSET),
        Err(_) => return Err(ERROR_LOAD_TYPE_HASH),
    }

    if load_token_amount(index, Source::Input)? != order.token_amount {
        return Err(ERROR_SELL_ASSET);
    }

    let order_capacity =
        load_cell_capacity(index, Source::Input).map_err(|_| ERROR_LOAD_CAPACITY)?;
    let required_seller_capacity = order_capacity
        .checked_add(order.price)
        .ok_or(ERROR_CAPACITY_OVERFLOW)?;

    let mut seller_output_capacity = 0u64;

    for (output_index, output_lock_hash) in
        QueryIter::new(load_cell_lock_hash, Source::Output).enumerate()
    {
        if output_lock_hash != order.maker_lock_hash {
            continue;
        }

        match load_cell_type_hash(output_index, Source::Output) {
            Ok(None) => {
                let capacity = load_cell_capacity(output_index, Source::Output)
                    .map_err(|_| ERROR_LOAD_OUTPUT_CAPACITY)?;
                seller_output_capacity = seller_output_capacity
                    .checked_add(capacity)
                    .ok_or(ERROR_OUTPUT_CAPACITY_OVERFLOW)?;
            }
            Ok(Some(_)) => {}
            Err(_) => return Err(ERROR_LOAD_OUTPUT_TYPE_HASH),
        }
    }

    if seller_output_capacity < required_seller_capacity {
        return Err(ERROR_SELLER_UNDERPAID);
    }

    Ok(())
}

fn validate_buy_order(index: usize, order: OrderArgs) -> Result<(), i8> {
    match load_cell_type_hash(index, Source::Input) {
        Ok(None) => {}
        Ok(Some(_)) => return Err(ERROR_BUY_ORDER_TYPE),
        Err(_) => return Err(ERROR_LOAD_TYPE_HASH),
    }

    let buy_order_capacity =
        load_cell_capacity(index, Source::Input).map_err(|_| ERROR_LOAD_CAPACITY)?;
    let mut buyer_token_amount = 0u128;
    let mut buyer_token_capacity = 0u64;

    for (output_index, output_lock_hash) in
        QueryIter::new(load_cell_lock_hash, Source::Output).enumerate()
    {
        if output_lock_hash != order.maker_lock_hash {
            continue;
        }

        match load_cell_type_hash(output_index, Source::Output) {
            Ok(Some(type_hash)) if type_hash == order.xudt_type_hash => {
                let amount = load_token_amount(output_index, Source::Output)?;
                buyer_token_amount = buyer_token_amount
                    .checked_add(amount)
                    .ok_or(ERROR_TOKEN_AMOUNT_OVERFLOW)?;

                let capacity = load_cell_capacity(output_index, Source::Output)
                    .map_err(|_| ERROR_LOAD_OUTPUT_CAPACITY)?;
                buyer_token_capacity = buyer_token_capacity
                    .checked_add(capacity)
                    .ok_or(ERROR_BUYER_TOKEN_CAPACITY_OVERFLOW)?;
            }
            Ok(_) => {}
            Err(_) => return Err(ERROR_LOAD_OUTPUT_TYPE_HASH),
        }
    }

    if buyer_token_amount != order.token_amount {
        return Err(ERROR_BUYER_TOKEN_AMOUNT);
    }

    let required_buy_capacity = order
        .price
        .checked_add(buyer_token_capacity)
        .ok_or(ERROR_CAPACITY_OVERFLOW)?;

    if buy_order_capacity < required_buy_capacity {
        return Err(ERROR_BUY_ORDER_CAPACITY);
    }

    Ok(())
}

pub fn program_entry() -> i8 {
    let script = match ckb_std::high_level::load_script() {
        Ok(script) => script,
        Err(err) => {
            ckb_std::debug!("load script failed: {:?}", err);
            return ERROR_LOAD_SCRIPT;
        }
    };

    let own_args_data = script.args().raw_data();
    let own_order = match parse_order_args(own_args_data.as_ref()) {
        Ok(order) => order,
        Err(code) => return code,
    };

    let dex_code_hash = script.code_hash();
    let dex_hash_type = script.hash_type();

    let dex_input_count = QueryIter::new(load_cell_lock, Source::Input)
        .filter(|input_lock| {
            input_lock.code_hash() == dex_code_hash && input_lock.hash_type() == dex_hash_type
        })
        .count();

    let maker_input_exists = QueryIter::new(load_cell_lock_hash, Source::Input)
        .any(|lock_hash| lock_hash == own_order.maker_lock_hash);

    if maker_input_exists {
        return if dex_input_count == 1 {
            0
        } else {
            ERROR_DEX_INPUT_COUNT
        };
    }

    if dex_input_count != 2 {
        return ERROR_DEX_INPUT_COUNT;
    }

    let mut buy_order = None;
    let mut sell_order = None;

    for (index, input_lock) in QueryIter::new(load_cell_lock, Source::Input).enumerate() {
        if input_lock.code_hash() != dex_code_hash || input_lock.hash_type() != dex_hash_type {
            continue;
        }

        let input_args_data = input_lock.args().raw_data();
        let order = match parse_order_args(input_args_data.as_ref()) {
            Ok(order) => order,
            Err(code) => return code,
        };

        match order.side {
            SIDE_BUY if buy_order.is_none() => buy_order = Some((index, order)),
            SIDE_SELL if sell_order.is_none() => sell_order = Some((index, order)),
            _ => return ERROR_ORDER_PAIR,
        }
    }

    let (buy_index, buy) = match buy_order {
        Some(order) => order,
        None => return ERROR_ORDER_PAIR,
    };
    let (sell_index, sell) = match sell_order {
        Some(order) => order,
        None => return ERROR_ORDER_PAIR,
    };

    if buy.xudt_type_hash != sell.xudt_type_hash
        || buy.token_amount != sell.token_amount
        || buy.price != sell.price
    {
        return ERROR_ORDER_PAIR;
    }

    let result = match own_order.side {
        SIDE_BUY => validate_buy_order(buy_index, buy),
        SIDE_SELL => validate_sell_order(sell_index, sell),
        _ => Err(ERROR_SIDE),
    };

    match result {
        Ok(()) => 0,
        Err(code) => code,
    }
}
