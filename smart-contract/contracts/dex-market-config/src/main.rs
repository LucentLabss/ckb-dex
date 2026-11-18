#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]
#[cfg(any(feature = "library", test))]
extern crate alloc;
#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
ckb_std::default_alloc!();

use ckb_std::{ckb_constants::Source, error::SysError, high_level::*, type_id::validate_type_id};
use dex_v2_core::*;

fn validate() -> Result<()> {
    let script = load_script().map_err(|_| LOAD)?;
    // Policy code itself must be immutable, not replaceable through a code-cell Type ID.
    if script.hash_type() != 4u8.into() {
        return Err(CONFIG);
    }
    let args = script.args().raw_data();
    if args.len() != 32 {
        return Err(CONFIG);
    }
    validate_type_id(args.as_ref()).map_err(|_| CONFIG)?;
    // Never destroy the configuration identity: existing orders still reference it.
    let next = MarketConfig::decode(&load_cell_data(0, Source::GroupOutput).map_err(|_| CONFIG)?)?;
    if load_cell_lock_hash(0, Source::GroupOutput).map_err(|_| LOAD)? != next.admin {
        return Err(AUTH);
    }
    if !QueryIter::new(load_cell_lock_hash, Source::Input).any(|h| h == next.admin) {
        return Err(AUTH);
    }
    match load_cell_data(0, Source::GroupInput) {
        Ok(data) => {
            let old = MarketConfig::decode(&data)?;
            if !old.same_policy(&next) {
                return Err(CONFIG);
            }
            if load_cell_lock_hash(0, Source::GroupInput).map_err(|_| LOAD)? != old.admin {
                return Err(AUTH);
            }
            if load_cell_capacity(0, Source::GroupOutput).map_err(|_| LOAD)?
                < load_cell_capacity(0, Source::GroupInput).map_err(|_| LOAD)?
            {
                return Err(CAPACITY);
            }
        }
        Err(SysError::IndexOutOfBound) => {}
        Err(_) => return Err(LOAD),
    }
    Ok(())
}

pub fn program_entry() -> i8 {
    match validate() {
        Ok(()) => 0,
        Err(code) => code,
    }
}
