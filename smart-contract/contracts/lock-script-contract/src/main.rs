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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn __sync_fetch_and_add_8(ptr: *mut u64, val: u64) -> u64 {
    unsafe {
        let old = ptr.read_volatile();
        ptr.write_volatile(old.wrapping_add(val));
        old
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn __sync_fetch_and_sub_8(ptr: *mut u64, val: u64) -> u64 {
    unsafe {
        let old = ptr.read_volatile();
        ptr.write_volatile(old.wrapping_sub(val));
        old
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn __sync_val_compare_and_swap_8(
    ptr: *mut u64,
    oldval: u64,
    newval: u64,
) -> u64 {
    unsafe {
        let old = ptr.read_volatile();
        if old == oldval {
            ptr.write_volatile(newval);
        }
        old
    }
}

pub fn program_entry() -> i8 {
    let script = match ckb_std::high_level::load_script() {
        Ok(script) => script,
        Err(err) => {
            ckb_std::debug!("load script failed: {:?}", err);
            return -1;
        }
    };

    let args = script.args().raw_data();

    if args.len() != 20 {
        ckb_std::debug!("expected 20-byte args, got {}", args.len());
        return -2;
    }

    0
}
