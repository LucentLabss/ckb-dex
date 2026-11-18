#![no_std]
extern crate alloc;

use alloc::vec::Vec;

pub type Result<T> = core::result::Result<T, i8>;
pub const VERSION: u8 = 2;
pub const BUY: u8 = 0;
pub const SELL: u8 = 1;
pub const LIMIT: u8 = 0;
pub const MARKET: u8 = 1;
pub const NATIVE: [u8; 32] = [0; 32];
pub const ORDER_LEN: usize = 243;
pub const CONFIG_LEN: usize = 214;
pub const NONE: u32 = u32::MAX;
pub const MAX_ORDERS: usize = 16;
pub const BPS: u128 = 10_000;

pub const FORMAT: i8 = -40;
pub const MARKET_ERROR: i8 = -41;
pub const ASSET: i8 = -42;
pub const AMOUNT: i8 = -43;
pub const PRICE: i8 = -44;
pub const FEE: i8 = -45;
pub const CAPACITY: i8 = -46;
pub const BUDGET: i8 = -47;
pub const OUTPUT: i8 = -48;
pub const SUCCESSOR: i8 = -49;
pub const AUTH: i8 = -50;
pub const SINCE: i8 = -51;
pub const COUNT: i8 = -52;
pub const WITNESS: i8 = -53;
pub const OVERFLOW: i8 = -54;
pub const CONFIG: i8 = -55;
pub const STATE: i8 = -56;
pub const MIN_FILL: i8 = -57;
pub const LOAD: i8 = -58;

pub fn add(a: u128, b: u128) -> Result<u128> {
    a.checked_add(b).ok_or(OVERFLOW)
}
pub fn sub(a: u128, b: u128) -> Result<u128> {
    a.checked_sub(b).ok_or(AMOUNT)
}
pub fn mul(a: u128, b: u128) -> Result<u128> {
    a.checked_mul(b).ok_or(OVERFLOW)
}
pub fn ceil_div(n: u128, d: u128) -> Result<u128> {
    if d == 0 {
        return Err(FORMAT);
    }
    add(n / d, u128::from(n % d != 0))
}

pub struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}
impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, offset: 0 }
    }
    pub fn bytes<const N: usize>(&mut self) -> Result<[u8; N]> {
        let end = self.offset.checked_add(N).ok_or(FORMAT)?;
        let value = self
            .data
            .get(self.offset..end)
            .ok_or(FORMAT)?
            .try_into()
            .map_err(|_| FORMAT)?;
        self.offset = end;
        Ok(value)
    }
    pub fn byte(&mut self) -> Result<u8> {
        Ok(self.bytes::<1>()?[0])
    }
    pub fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.bytes()?))
    }
    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }
    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }
    pub fn u128(&mut self) -> Result<u128> {
        Ok(u128::from_le_bytes(self.bytes()?))
    }
    pub fn done(&self) -> Result<()> {
        if self.offset == self.data.len() {
            Ok(())
        } else {
            Err(FORMAT)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Order {
    pub side: u8,
    pub kind: u8,
    pub owner: [u8; 32],
    pub market: [u8; 32],
    pub nonce: [u8; 32],
    pub price_num: u128,
    pub price_den: u128,
    pub initial_base: u128,
    pub remaining_base: u128,
    pub remaining_offer: u128,
    pub fee_reserve: u128,
    pub cost_budget: u64,
    pub max_network_fee: u64,
    pub max_refund_fee: u64,
    pub refund_after: u64,
    pub min_fill: u128,
}
impl Order {
    pub fn decode(data: &[u8]) -> Result<Self> {
        if data.len() != ORDER_LEN {
            return Err(FORMAT);
        }
        let mut r = Reader::new(data);
        if r.byte()? != VERSION {
            return Err(FORMAT);
        }
        let value = Self {
            side: r.byte()?,
            kind: r.byte()?,
            owner: r.bytes()?,
            market: r.bytes()?,
            nonce: r.bytes()?,
            price_num: r.u128()?,
            price_den: r.u128()?,
            initial_base: r.u128()?,
            remaining_base: r.u128()?,
            remaining_offer: r.u128()?,
            fee_reserve: r.u128()?,
            cost_budget: r.u64()?,
            max_network_fee: r.u64()?,
            max_refund_fee: r.u64()?,
            refund_after: r.u64()?,
            min_fill: r.u128()?,
        };
        r.done()?;
        if value.side > SELL || value.kind > MARKET {
            return Err(FORMAT);
        }
        Ok(value)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = alloc::vec![VERSION, self.side, self.kind];
        b.extend_from_slice(&self.owner);
        b.extend_from_slice(&self.market);
        b.extend_from_slice(&self.nonce);
        for n in [
            self.price_num,
            self.price_den,
            self.initial_base,
            self.remaining_base,
            self.remaining_offer,
            self.fee_reserve,
        ] {
            b.extend_from_slice(&n.to_le_bytes());
        }
        for n in [
            self.cost_budget,
            self.max_network_fee,
            self.max_refund_fee,
            self.refund_after,
        ] {
            b.extend_from_slice(&n.to_le_bytes());
        }
        b.extend_from_slice(&self.min_fill.to_le_bytes());
        b
    }
    pub fn validate(&self, market: &MarketConfig) -> Result<()> {
        if self.owner == NATIVE
            || self.nonce == NATIVE
            || self.initial_base == 0
            || self.remaining_base == 0
            || self.remaining_base > self.initial_base
            || self.remaining_offer == 0
            || self.price_num == 0
            || self.price_den != market.tick_den
            || self.price_num % market.tick_num != 0
            || self.initial_base < market.min_order
            || self.initial_base > market.max_order
            || self.initial_base % market.lot_size != 0
            || self.remaining_base % market.lot_size != 0
            || self.min_fill == 0
            || self.min_fill > self.initial_base
            || self.min_fill % market.lot_size != 0
            || self.max_refund_fee > self.max_network_fee
            || self.refund_after >= (1u64 << 56)
            || (self.kind == MARKET && self.refund_after == 0)
        {
            return Err(STATE);
        }
        if self.side == SELL
            && (self.remaining_offer != self.remaining_base || self.fee_reserve != 0)
        {
            return Err(STATE);
        }
        if self.side == BUY {
            if self.kind == LIMIT {
                let required_quote =
                    ceil_div(mul(self.remaining_base, self.price_num)?, self.price_den)?;
                if self.remaining_offer < required_quote {
                    return Err(AMOUNT);
                }
            }
            let worst_rate = market.maker_bps.max(market.taker_bps) as u128;
            let required_reserve = ceil_div(mul(self.remaining_offer, worst_rate)?, BPS)?;
            if self.fee_reserve < required_reserve {
                return Err(FEE);
            }
        }
        Ok(())
    }
    pub fn offered(&self, market: &MarketConfig) -> [u8; 32] {
        if self.side == BUY {
            market.quote
        } else {
            market.base
        }
    }
    pub fn received(&self, market: &MarketConfig) -> [u8; 32] {
        if self.side == BUY {
            market.base
        } else {
            market.quote
        }
    }
    pub fn escrow_amount(&self) -> Result<u128> {
        add(self.remaining_offer, self.fee_reserve)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketConfig {
    pub admin: [u8; 32],
    pub treasury: [u8; 32],
    pub base: [u8; 32],
    pub quote: [u8; 32],
    pub maker_bps: u16,
    pub taker_bps: u16,
    pub lot_size: u128,
    pub min_order: u128,
    pub max_order: u128,
    pub tick_num: u128,
    pub tick_den: u128,
    pub status: u8,
}
impl MarketConfig {
    pub fn decode(data: &[u8]) -> Result<Self> {
        if data.len() != CONFIG_LEN {
            return Err(CONFIG);
        }
        let mut r = Reader::new(data);
        if r.byte()? != VERSION {
            return Err(CONFIG);
        }
        let value = Self {
            admin: r.bytes()?,
            treasury: r.bytes()?,
            base: r.bytes()?,
            quote: r.bytes()?,
            maker_bps: r.u16()?,
            taker_bps: r.u16()?,
            lot_size: r.u128()?,
            min_order: r.u128()?,
            max_order: r.u128()?,
            tick_num: r.u128()?,
            tick_den: r.u128()?,
            status: r.byte()?,
        };
        r.done()?;
        if value.admin == NATIVE
            || value.treasury == NATIVE
            || value.base == value.quote
            || value.maker_bps > 10_000
            || value.taker_bps > 10_000
            || value.lot_size == 0
            || value.min_order == 0
            || value.max_order < value.min_order
            || value.min_order % value.lot_size != 0
            || value.max_order % value.lot_size != 0
            || value.tick_num == 0
            || value.tick_den == 0
            || value.status > 2
        {
            return Err(CONFIG);
        }
        Ok(value)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = alloc::vec![VERSION];
        for h in [self.admin, self.treasury, self.base, self.quote] {
            b.extend_from_slice(&h);
        }
        b.extend_from_slice(&self.maker_bps.to_le_bytes());
        b.extend_from_slice(&self.taker_bps.to_le_bytes());
        for n in [
            self.lot_size,
            self.min_order,
            self.max_order,
            self.tick_num,
            self.tick_den,
        ] {
            b.extend_from_slice(&n.to_le_bytes());
        }
        b.push(self.status);
        b
    }
    pub fn same_policy(&self, other: &Self) -> bool {
        let mut next = *self;
        next.treasury = other.treasury;
        next.status = other.status;
        next == *other
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Fill {
    pub base: u128,
    pub quote: u128,
    pub payout: u32,
    pub refund: u32,
    pub successor: u32,
    pub network_fee: u64,
    pub treasury_capacity: u64,
}
impl Fill {
    pub fn decode(r: &mut Reader<'_>) -> Result<Self> {
        Ok(Self {
            base: r.u128()?,
            quote: r.u128()?,
            payout: r.u32()?,
            refund: r.u32()?,
            successor: r.u32()?,
            network_fee: r.u64()?,
            treasury_capacity: r.u64()?,
        })
    }
    pub fn encode(&self, b: &mut Vec<u8>) {
        b.extend_from_slice(&self.base.to_le_bytes());
        b.extend_from_slice(&self.quote.to_le_bytes());
        for n in [self.payout, self.refund, self.successor] {
            b.extend_from_slice(&n.to_le_bytes());
        }
        b.extend_from_slice(&self.network_fee.to_le_bytes());
        b.extend_from_slice(&self.treasury_capacity.to_le_bytes());
    }
}
