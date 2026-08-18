#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(any(feature = "library", test))]
extern crate alloc;

#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
// By default, the following heap configuration is used:
// * 16KB fixed heap
// * 1.2MB(rounded up to be 16-byte aligned) dynamic heap
// * Minimal memory block in dynamic heap is 64 bytes
// For more details, please refer to ckb-std's default_alloc macro
// and the buddy-alloc alloc implementation.
ckb_std::default_alloc!(16384, 1258306, 64);

use ckb_std::{
    ckb_constants::Source,
    high_level::{
        QueryIter, load_cell_capacity, load_cell_lock, load_cell_lock_hash, load_cell_type_hash,
    },
};

pub fn program_entry() -> i8 {
    let script = match ckb_std::high_level::load_script() {
        Ok(script) => script,
        Err(err) => {
            ckb_std::debug!("load script failed: {:?}", err);
            return -1;
        }
    };

    let args = script.args().raw_data();

    // Length of own script args must be 40
    if args.len() != 40 {
        ckb_std::debug!("expected 40-byte args, got {}", args.len());
        return -2;
    }

    // divide the args into the maker_lock_hash and the ask price
    let args_slice: &[u8] = args.as_ref();
    let (maker_bytes, price_bytes) = args_slice.split_at(32);

    let maker_lock_hash: [u8; 32] = match maker_bytes.try_into() {
        Ok(bytes) => bytes,
        Err(_) => return -3,
    };

    let price_array: [u8; 8] = match price_bytes.try_into() {
        Ok(bytes) => bytes,
        Err(_) => return -4,
    };

    let ask_price = u64::from_le_bytes(price_array);

    // For cancellation, check if maker input exist using the maker_lock_hash from own script args
    let maker_input_exists = QueryIter::new(load_cell_lock_hash, Source::Input)
        .any(|lock_hash| lock_hash == maker_lock_hash);

    let mut counter: usize = 0;
    let dex_code_hash = script.code_hash();
    let dex_hash_type = script.hash_type();

    // Only one cell of own lock script may exist in a transaction
    for input_lock in QueryIter::new(load_cell_lock, Source::Input) {
        if input_lock.code_hash() == dex_code_hash && input_lock.hash_type() == dex_hash_type {
            counter += 1;
        }
    }

    // fail if more than one dex order cell in one tx
    if counter != 1 {
        return -10;
    }

    // cancellation success path
    if maker_input_exists {
        return 0;
    }

    // fail when order cell lacks a type hash
    match load_cell_type_hash(0, Source::GroupInput) {
        Ok(Some(_)) => {}
        Ok(None) => return -11,
        Err(err) => {
            ckb_std::debug!("failed to load order type hash: {:?}", err);
            return -12;
        }
    }

    let order_capacity = match load_cell_capacity(0, Source::GroupInput) {
        Ok(capacity) => capacity,
        Err(err) => {
            ckb_std::debug!("Failed to load order capacity: {:?}", err);
            return -5;
        }
    };

    // calculate required maker capacity by summing up the order cell capacity with the ask price
    let required_maker_capacity = match order_capacity.checked_add(ask_price) {
        Some(capacity) => capacity,
        None => {
            ckb_std::debug!("Failed to add ask price to order capacity; overflowed");
            return -6;
        }
    };

    let mut maker_output_capacity: u64 = 0;

    // compute the total capacity actually going to the maker by summing up all maker output capacity
    for (index, output_lock_hash) in QueryIter::new(load_cell_lock_hash, Source::Output).enumerate()
    {
        if output_lock_hash == maker_lock_hash {
            match load_cell_type_hash(index, Source::Output) {
                Ok(None) => match load_cell_capacity(index, Source::Output) {
                    Ok(capacity) => match maker_output_capacity.checked_add(capacity) {
                        Some(total) => maker_output_capacity = total,
                        None => return -7,
                    },
                    Err(_err) => return -8,
                },
                Ok(Some(_)) => continue,
                Err(_err) => return -13,
            }
        }
    }

    // fill order success path (actual maker capacity must not be less than required maker capacity)
    if maker_output_capacity < required_maker_capacity {
        return -9;
    }

    0
}
