//! Money from the DAO, sent with `ft_transfer_call` (a Sputnik Transfer proposal with `msg`):
//! - `{"envelope_id": "<id>"}` funds a budget;
//! - `{"request_id": "<id>"}` is the money for an escalation the DAO approved (R22). Earmark
//!   holds it for that request and pays the payee itself, so "paid by DAO" rests on Earmark's
//!   own transfer, not on the proposal's status.
//!
//! Anything that isn't a valid DAO deposit is refunded.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json;
use near_sdk::{AccountId, PromiseOrValue, env, log, near, require};

use crate::events::Event;
use crate::request::{RequestStatus, Tier};
use crate::{Contract, ContractExt};

#[near(serializers = [json])]
struct FundMsg {
    envelope_id: U64,
}

#[near(serializers = [json])]
struct EscalationMsg {
    request_id: String,
}

#[near]
impl FungibleTokenReceiver for Contract {
    /// Returns the amount to refund: 0 when the money is accepted, the full amount otherwise.
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

        let accepted = if sender_id != self.dao_id {
            Err("sender_not_dao")
        } else if let Ok(EscalationMsg { request_id }) = serde_json::from_str(&msg) {
            self.receive_escalation(&token_id, amount.0, &request_id)
        } else {
            self.fund(&token_id, amount.0, &msg)
        };
        match accepted {
            Ok(()) => PromiseOrValue::Value(U128(0)),
            Err(reason) => {
                log!("refund: {}", reason);
                PromiseOrValue::Value(amount)
            }
        }
    }
}

impl Contract {
    fn fund(&mut self, token_id: &AccountId, amount: u128, msg: &str) -> Result<(), &'static str> {
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

    /// R22: accepts exactly the request's amount in the budget's token, once, while the request
    /// waits for its DAO vote. Anything else (a second payment, a closed request, a different
    /// amount) is refunded, so the DAO can't pay the same request twice. Pays the payee in the
    /// same transaction when enough gas is left; otherwise `settle_escalation` pays it.
    fn receive_escalation(
        &mut self,
        token_id: &AccountId,
        amount: u128,
        request_id: &str,
    ) -> Result<(), &'static str> {
        let mut request = self
            .requests
            .get(request_id)
            .cloned()
            .ok_or("unknown_request")?;
        if request.tier != Tier::Escalate || request.status != RequestStatus::Escalated {
            return Err("not_escalated");
        }
        if amount != request.amount.0 {
            return Err("wrong_amount");
        }
        let envelope = self.envelopes.get(&request.envelope_id.0).unwrap();
        if envelope.token_id != *token_id {
            return Err("wrong_token");
        }
        Event::EscalationSettled {
            request_id,
            dao_proposal_id: request.dao_proposal_id,
            outcome: "approved",
        }
        .emit();
        request.status = RequestStatus::DaoFunded;
        self.requests.insert(request_id.to_owned(), request.clone());
        if self.gas_left_for_dao_payout(request_id) {
            self.pay_from_dao(token_id, request_id, request).detach();
        }
        Ok(())
    }
}
