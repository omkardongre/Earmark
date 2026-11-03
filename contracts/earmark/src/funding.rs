//! Funding a budget: the DAO sends tokens with `ft_transfer_call` (a Sputnik Transfer proposal
//! with `msg`). Anything that isn't a valid DAO deposit into an open budget is refunded.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json;
use near_sdk::{AccountId, PromiseOrValue, env, log, near, require};

use crate::events::Event;
use crate::{Contract, ContractExt};

#[near(serializers = [json])]
struct FundMsg {
    envelope_id: U64,
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Returns the amount to refund: 0 when the budget is funded, the full amount otherwise.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        // The caller is the token contract. A token we don't accept can't be trusted to refund
        // correctly through its own resolve step, so fail the call instead.
        let token_id = env::predecessor_account_id();
        require!(self.token_ids.contains(&token_id), "token_not_allowed");

        match self.fund(&token_id, &sender_id, amount.0, &msg) {
            Ok(()) => PromiseOrValue::Value(U128(0)),
            Err(reason) => {
                log!("refund: {}", reason);
                PromiseOrValue::Value(amount)
            }
        }
    }
}

impl Contract {
    fn fund(
        &mut self,
        token_id: &AccountId,
        sender_id: &AccountId,
        amount: u128,
        msg: &str,
    ) -> Result<(), &'static str> {
        if *sender_id != self.dao_id {
            return Err("sender_not_dao");
        }
        let FundMsg { envelope_id } = serde_json::from_str(msg).map_err(|_| "invalid_msg")?;
        let envelope = self
            .envelopes
            .get_mut(&envelope_id.0)
            .ok_or("unknown_envelope")?;
        if envelope.token_id != *token_id {
            return Err("wrong_token");
        }
        if envelope.closed {
            return Err("closed");
        }
        envelope.balance = envelope
            .balance
            .checked_add(amount)
            .ok_or("balance_overflow")?;
        let balance = envelope.balance;

        Event::EnvelopeFunded {
            envelope_id,
            token_id,
            amount: U128(amount),
            balance: U128(balance),
        }
        .emit();
        Ok(())
    }
}
