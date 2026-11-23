#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]
#[cfg(any(feature = "library", test))]
extern crate alloc;
#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
ckb_std::default_alloc!(16384, 1258306, 64);

use alloc::vec::Vec;
use ckb_std::{ckb_constants::Source, ckb_types::packed::Script, error::SysError, high_level::*};
use dex_v2_core::*;

fn count(source: Source, max: usize) -> Result<usize> {
    for index in 0..=max {
        match load_cell_capacity(index, source) {
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => return Ok(index),
            Err(_) => return Err(LOAD),
        }
    }
    Err(COUNT)
}

fn capacity(index: usize, source: Source) -> Result<u128> {
    Ok(load_cell_capacity(index, source).map_err(|_| LOAD)? as u128)
}

fn asset_cell(index: usize, source: Source, asset: [u8; 32], amount: u128) -> Result<u128> {
    let cap = capacity(index, source)?;
    let occupied = load_cell_occupied_capacity(index, source).map_err(|_| LOAD)? as u128;
    if cap < occupied {
        return Err(CAPACITY);
    }
    let cell_type = load_cell_type_hash(index, source).map_err(|_| LOAD)?;
    let data = load_cell_data(index, source).map_err(|_| LOAD)?;
    if asset == NATIVE {
        if cell_type.is_some() || !data.is_empty() {
            return Err(ASSET);
        }
        if cap < amount {
            return Err(AMOUNT);
        }
    } else {
        if cell_type != Some(asset) || data.as_slice() != amount.to_le_bytes() {
            return Err(ASSET);
        }
    }
    Ok(cap)
}

fn offer_asset(order: &Order, market: &MarketConfig) -> [u8; 32] {
    order.offered(market)
}
fn receive_asset(order: &Order, market: &MarketConfig) -> [u8; 32] {
    order.received(market)
}
fn escrow(index: usize, source: Source, order: &Order, market: &MarketConfig) -> Result<u128> {
    let offered = offer_asset(order, market);
    if order.side == SELL
        && (order.remaining_offer != order.remaining_base || order.fee_reserve != 0)
    {
        return Err(STATE);
    }
    let amount = order.escrow_amount()?;
    let cap = asset_cell(index, source, offered, amount)?;
    let occupied = load_cell_occupied_capacity(index, source).map_err(|_| LOAD)? as u128;
    let needed = add(occupied, order.cost_budget as u128)?;
    let needed = if offered == NATIVE {
        add(needed, amount)?
    } else {
        needed
    };
    if cap < needed {
        return Err(CAPACITY);
    }
    Ok(cap)
}

fn market_config(hash: [u8; 32]) -> Result<MarketConfig> {
    let mut found = None;
    for index in 0..count(Source::CellDep, 256)? {
        if load_cell_type_hash(index, Source::CellDep).map_err(|_| LOAD)? == Some(hash) {
            if found.is_some() {
                return Err(CONFIG);
            }
            found = Some(MarketConfig::decode(
                &load_cell_data(index, Source::CellDep).map_err(|_| LOAD)?,
            )?);
        }
    }
    found.ok_or(CONFIG)
}

fn take_output(index: u32, used: &mut [bool]) -> Result<usize> {
    let slot = used.get_mut(index as usize).ok_or(OUTPUT)?;
    if *slot {
        return Err(OUTPUT);
    }
    *slot = true;
    Ok(index as usize)
}

fn owned_output(
    index: u32,
    used: &mut [bool],
    owner: [u8; 32],
    asset: [u8; 32],
    amount: u128,
) -> Result<u128> {
    let index = take_output(index, used)?;
    if load_cell_lock_hash(index, Source::Output).map_err(|_| LOAD)? != owner {
        return Err(OUTPUT);
    }
    asset_cell(index, Source::Output, asset, amount)
}

fn check_price(order: &Order, base: u128, quote: u128) -> Result<()> {
    let paid = mul(quote, order.price_den)?;
    let limit = mul(base, order.price_num)?;
    if (order.side == BUY && paid > limit) || (order.side == SELL && paid < limit) {
        return Err(PRICE);
    }
    Ok(())
}

fn settlement(r: &mut Reader<'_>, own_script: &Script) -> Result<()> {
    let n = r.byte()? as usize;
    let taker = r.byte()? as usize;
    let treasury_output = r.u32()?;
    if !(2..=MAX_ORDERS).contains(&n) || taker >= n || count(Source::Input, MAX_ORDERS)? != n {
        return Err(COUNT);
    }
    let output_count = count(Source::Output, MAX_ORDERS * 3 + 1)?;
    let mut used = alloc::vec![false; output_count];
    let mut orders = Vec::with_capacity(n);
    let mut fills = Vec::with_capacity(n);
    for i in 0..n {
        let lock = load_cell_lock(i, Source::Input).map_err(|_| LOAD)?;
        if lock.code_hash() != own_script.code_hash() || lock.hash_type() != own_script.hash_type()
        {
            return Err(COUNT);
        }
        let order = Order::decode(lock.args().raw_data().as_ref())?;
        if orders
            .iter()
            .any(|prior: &Order| prior.nonce == order.nonce)
        {
            return Err(STATE);
        }
        orders.push(order);
        fills.push(Fill::decode(r)?);
    }
    r.done()?;
    let market = market_config(orders[0].market)?;
    if market.status != 0 {
        return Err(MARKET_ERROR);
    }
    for order in &orders {
        if order.market != orders[0].market {
            return Err(MARKET_ERROR);
        }
        order.validate(&market)?;
    }
    let mut base_sum = 0;
    let mut quote_sum = 0;
    let mut last_price = None;
    let mut prior_maker: Option<usize> = None;
    for i in 0..n {
        if i == taker {
            continue;
        }
        let maker = &orders[i];
        if maker.kind != LIMIT || maker.side == orders[taker].side {
            return Err(MARKET_ERROR);
        }
        if let Some(price) = last_price {
            if (orders[taker].side == BUY && maker.price_num < price)
                || (orders[taker].side == SELL && maker.price_num > price)
            {
                return Err(PRICE);
            }
        }
        // Do not skip a partially used better-priced maker within this batch.
        if let Some(prior) = prior_maker {
            if fills[prior].base != orders[prior].remaining_base {
                return Err(AMOUNT);
            }
        }
        prior_maker = Some(i);
        last_price = Some(maker.price_num);
        let numerator = mul(fills[i].base, maker.price_num)?;
        let expected_quote = if maker.side == SELL {
            ceil_div(numerator, maker.price_den)?
        } else {
            numerator / maker.price_den
        };
        if fills[i].quote != expected_quote {
            return Err(PRICE);
        }
        // Slippage is a per-execution bound, not merely an acceptable batch average.
        check_price(&orders[taker], fills[i].base, fills[i].quote)?;
        base_sum = add(base_sum, fills[i].base)?;
        quote_sum = add(quote_sum, fills[i].quote)?;
    }
    if fills[taker].base != base_sum || fills[taker].quote != quote_sum {
        return Err(AMOUNT);
    }

    let mut total_fees = 0u128;
    let mut treasury_capacity = 0u128;
    let mut network_fees = 0u128;
    let mut input_capacity = 0u128;

    for i in 0..n {
        let order = &orders[i];
        let fill = &fills[i];
        if fill.base == 0
            || fill.quote == 0
            || fill.base > order.remaining_base
            || fill.base % market.lot_size != 0
        {
            return Err(AMOUNT);
        }
        if fill.base < order.min_fill && fill.base != order.remaining_base {
            return Err(MIN_FILL);
        }
        check_price(order, fill.base, fill.quote)?;
        let original_capacity = escrow(i, Source::Input, order, &market)?;
        input_capacity = add(input_capacity, original_capacity)?;
        if fill.network_fee > order.max_network_fee {
            return Err(BUDGET);
        }
        let cost = fill
            .network_fee
            .checked_add(fill.treasury_capacity)
            .ok_or(OVERFLOW)?;
        let remaining_cost = order.cost_budget.checked_sub(cost).ok_or(BUDGET)?;
        let rate = if i == taker {
            market.taker_bps
        } else {
            market.maker_bps
        };
        // Round each execution down to whole quote units; no claimed historical fee credit.
        let fee = mul(fill.quote, rate as u128)? / BPS;
        let remaining_base = sub(order.remaining_base, fill.base)?;
        let remaining_offer = sub(
            order.remaining_offer,
            if order.side == BUY {
                fill.quote
            } else {
                fill.base
            },
        )?;
        let fee_reserve = if order.side == BUY {
            sub(order.fee_reserve, fee)?
        } else {
            0
        };
        let received = if order.side == BUY {
            fill.base
        } else {
            sub(fill.quote, fee)?
        };
        let mut returned_capacity = owned_output(
            fill.payout,
            &mut used,
            order.owner,
            receive_asset(order, &market),
            received,
        )?;

        if remaining_base > 0 && order.kind == LIMIT {
            if fill.refund != NONE || fill.successor == NONE {
                return Err(SUCCESSOR);
            }
            let index = take_output(fill.successor, &mut used)?;
            let mut next = *order;
            next.remaining_base = remaining_base;
            next.remaining_offer = remaining_offer;
            next.fee_reserve = fee_reserve;
            next.cost_budget = remaining_cost;
            next.validate(&market)?;
            let input_lock = load_cell_lock(i, Source::Input).map_err(|_| LOAD)?;
            let output_lock = load_cell_lock(index, Source::Output).map_err(|_| LOAD)?;
            if input_lock.code_hash() != output_lock.code_hash()
                || input_lock.hash_type() != output_lock.hash_type()
                || output_lock.args().raw_data().as_ref() != next.encode().as_slice()
            {
                return Err(SUCCESSOR);
            }
            returned_capacity = add(
                returned_capacity,
                escrow(index, Source::Output, &next, &market)?,
            )?;
        } else {
            if fill.successor != NONE {
                return Err(SUCCESSOR);
            }
            let remainder = add(remaining_offer, fee_reserve)?;
            if remainder > 0 && offer_asset(order, &market) == NATIVE && fill.refund == NONE {
                // Keep unused CKB in the received token cell instead of fragmenting it.
                if returned_capacity < remainder {
                    return Err(CAPACITY);
                }
            } else if remainder > 0 {
                returned_capacity = add(
                    returned_capacity,
                    owned_output(
                        fill.refund,
                        &mut used,
                        order.owner,
                        offer_asset(order, &market),
                        remainder,
                    )?,
                )?;
            } else if fill.refund != NONE {
                returned_capacity = add(
                    returned_capacity,
                    owned_output(fill.refund, &mut used, order.owner, NATIVE, 0)?,
                )?;
            }
        }

        let native_received = if receive_asset(order, &market) == NATIVE {
            received
        } else {
            0
        };
        let native_spent = if offer_asset(order, &market) == NATIVE {
            if order.side == BUY {
                add(fill.quote, fee)?
            } else {
                fill.base
            }
        } else {
            0
        };
        let expected_capacity = sub(add(original_capacity, native_received)?, native_spent)?;
        let accounted = add(returned_capacity, cost as u128)?;
        if expected_capacity != accounted {
            return Err(CAPACITY);
        }
        total_fees = add(total_fees, fee)?;
        treasury_capacity = add(treasury_capacity, fill.treasury_capacity as u128)?;
        network_fees = add(network_fees, fill.network_fee as u128)?;
    }

    if total_fees == 0 {
        if treasury_output != NONE || treasury_capacity != 0 {
            return Err(FEE);
        }
    } else {
        let cap = owned_output(
            treasury_output,
            &mut used,
            market.treasury,
            market.quote,
            total_fees,
        )?;
        let expected = add(
            treasury_capacity,
            if market.quote == NATIVE {
                total_fees
            } else {
                0
            },
        )?;
        if cap != expected {
            return Err(FEE);
        }
        // Fund only the minimum treasury-cell capacity, not an arbitrary reserve transfer.
        let occupied = load_cell_occupied_capacity(treasury_output as usize, Source::Output)
            .map_err(|_| LOAD)? as u128;
        let native_fees = if market.quote == NATIVE {
            total_fees
        } else {
            0
        };
        let top_up = occupied.saturating_sub(native_fees);
        if treasury_capacity != top_up {
            return Err(FEE);
        }
        // Equal storage shares; the taker pays the integer remainder.
        for (i, fill) in fills.iter().enumerate() {
            let share = top_up / n as u128 + if i == taker { top_up % n as u128 } else { 0 };
            if fill.treasury_capacity as u128 != share {
                return Err(FEE);
            }
        }
    }
    if used.iter().any(|slot| !slot) {
        return Err(OUTPUT);
    }
    let mut output_capacity = 0;
    for index in 0..output_count {
        output_capacity = add(output_capacity, capacity(index, Source::Output)?)?;
    }
    if sub(input_capacity, output_capacity)? != network_fees {
        return Err(CAPACITY);
    }
    Ok(())
}

fn refund(r: &mut Reader<'_>, own_script: &Script, action: u8) -> Result<()> {
    let output = r.u32()? as usize;
    let fee = r.u64()?;
    r.done()?;
    let order = Order::decode(own_script.args().raw_data().as_ref())?;
    let mut dex_count = 0;
    for lock in QueryIter::new(load_cell_lock, Source::Input) {
        if lock.code_hash() == own_script.code_hash() && lock.hash_type() == own_script.hash_type()
        {
            dex_count += 1;
        }
    }
    if dex_count != 1 || load_cell_lock(0, Source::Input).map_err(|_| LOAD)? != *own_script {
        return Err(COUNT);
    }
    if fee > order.max_refund_fee || fee > order.cost_budget {
        return Err(BUDGET);
    }
    if action == 1 {
        if !QueryIter::new(load_cell_lock_hash, Source::Input).any(|h| h == order.owner) {
            return Err(AUTH);
        }
    } else {
        if order.refund_after == 0 || order.refund_after >= (1u64 << 56) {
            return Err(SINCE);
        }
        let since = load_input_since(0, Source::Input).map_err(|_| LOAD)?;
        if since & 0xff00_0000_0000_0000 != 0x4000_0000_0000_0000
            || (since & 0x00ff_ffff_ffff_ffff) < order.refund_after
        {
            return Err(SINCE);
        }
        if count(Source::Input, MAX_ORDERS)? != 1
            || count(Source::Output, MAX_ORDERS)? != 1
            || output != 0
        {
            return Err(COUNT);
        }
    }
    if load_cell_lock_hash(output, Source::Output).map_err(|_| LOAD)? != order.owner
        || load_cell_type_hash(output, Source::Output).map_err(|_| LOAD)?
            != load_cell_type_hash(0, Source::Input).map_err(|_| LOAD)?
        || load_cell_data(output, Source::Output).map_err(|_| LOAD)?
            != load_cell_data(0, Source::Input).map_err(|_| LOAD)?
    {
        return Err(OUTPUT);
    }
    if capacity(output, Source::Output)?
        != capacity(0, Source::Input)?
            .checked_sub(fee as u128)
            .ok_or(CAPACITY)?
    {
        return Err(CAPACITY);
    }
    if capacity(output, Source::Output)?
        < load_cell_occupied_capacity(output, Source::Output).map_err(|_| LOAD)? as u128
    {
        return Err(CAPACITY);
    }
    Ok(())
}

fn validate() -> Result<()> {
    let script = load_script().map_err(|_| LOAD)?;
    if script.hash_type() != 4u8.into() {
        return Err(CONFIG);
    }
    let witness = load_witness_args(0, Source::Input).map_err(|_| WITNESS)?;
    // xUDT owns input_type. Keep DEX settlement data in the lock witness field.
    let data = witness.lock().to_opt().ok_or(WITNESS)?.raw_data();
    if data.len() > 8 + MAX_ORDERS * 60 {
        return Err(WITNESS);
    }
    let mut r = Reader::new(data.as_ref());
    if r.byte()? != VERSION {
        return Err(WITNESS);
    }
    let action = r.byte()?;
    match action {
        0 => settlement(&mut r, &script),
        1 | 2 => refund(&mut r, &script, action),
        _ => Err(WITNESS),
    }
}
pub fn program_entry() -> i8 {
    match validate() {
        Ok(()) => 0,
        Err(code) => code,
    }
}
