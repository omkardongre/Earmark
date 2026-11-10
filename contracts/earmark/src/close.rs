//! `close_envelope` (R11, R12): the only way money leaves a budget other than a spend.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::{U64, U128};
use near_sdk::{Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, near, require};

use crate::events::Event;
use crate::request::RequestStatus;
use crate::{Contract, ContractExt};

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_REFUND: Gas = Gas::from_tgas(10);

#[near]
impl Contract {
    /// DAO only, through a `FunctionCall` proposal. Marks the budget closed, rejects requests
    /// waiting for approval and sends the free balance back to the DAO. Amounts still being paid
    /// settle first; call again to send what is left. Returns the amount sent.
    pub fn close_envelope(&mut self, envelope_id: U64) -> PromiseOrValue<U128> {
        self.assert_dao();
        let id = envelope_id.0;
        let envelope = self
            .envelopes
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("unknown_envelope"));
        envelope.closed = true;
        let pending: Vec<String> = envelope.pending.iter().cloned().collect();

        for request_id in &pending {
            let request = self.requests.get(request_id).cloned().unwrap();
            self.envelopes.get_mut(&id).unwrap().committed -= request.amount.0;
            self.release(request_id, request, RequestStatus::Rejected, Some("closed"));
        }

        let envelope = self.envelopes.get_mut(&id).unwrap();
        let refund = envelope.available();
        envelope.balance -= refund;
        let token_id = envelope.token_id.clone();
        Event::EnvelopeClosed {
            envelope_id,
            rejected_requests: pending.len() as u32,
            refund: U128(refund),
        }
        .emit();
        if refund == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        ext_ft_core::ext(token_id)
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(
                self.dao_id.clone(),
                U128(refund),
                Some(format!("earmark close {id}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_REFUND)
                    .on_close_refund(envelope_id, U128(refund)),
            )
            .into()
    }

    /// Puts the amount back if the refund failed, so `close_envelope` can be called again.
    #[private]
    pub fn on_close_refund(
        &mut self,
        envelope_id: U64,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> U128 {
        if result.is_ok() {
            return amount;
        }
        if let Some(envelope) = self.envelopes.get_mut(&envelope_id.0) {
            envelope.balance += amount.0;
        }
        Event::CloseRefundFailed {
            envelope_id,
            amount,
        }
        .emit();
        U128(0)
    }
}

/// Gas for each token's `ft_balance_of` and for the check that then deletes the account.
const GAS_FT_BALANCE: Gas = Gas::from_tgas(5);
const GAS_ON_DELETE_CHECK: Gas = Gas::from_tgas(10);

#[near]
impl Contract {
    /// DAO only, through a `FunctionCall` proposal (R23). Deletes this contract account and
    /// sends all its NEAR to the DAO, so the storage NEAR comes back when Earmark is retired.
    /// Refused unless every budget is closed with nothing held, reserved or being paid, and no
    /// DAO vote or held DAO payment is open. Then it reads the contract's balance of every
    /// allowed token and deletes only if all are zero, because tokens left in a deleted account
    /// are lost. The beneficiary is always the DAO: NEAR sent to an account that doesn't exist
    /// is burned.
    pub fn delete_contract(&mut self) -> Promise {
        self.assert_dao();
        for (_, e) in self.envelopes.iter() {
            require!(e.closed, "budget_open");
            require!(
                e.balance == 0 && e.committed == 0 && e.in_flight == 0,
                "budget_not_empty"
            );
            require!(
                e.spenders.values().all(|s| s.open_escalations == 0),
                "dao_payment_open"
            );
        }
        let me = env::current_account_id();
        let mut tokens = self.token_ids.iter();
        let first = tokens.next().unwrap_or_else(|| env::panic_str("no_tokens"));
        let balance = |t: &near_sdk::AccountId| {
            ext_ft_core::ext(t.clone())
                .with_static_gas(GAS_FT_BALANCE)
                .ft_balance_of(me.clone())
        };
        tokens.fold(balance(first), |p, t| p.and(balance(t))).then(
            Self::ext(me.clone())
                .with_static_gas(GAS_ON_DELETE_CHECK)
                .on_delete_check(),
        )
    }

    /// Deletes the account if every token balance read back as zero; otherwise does nothing.
    #[private]
    pub fn on_delete_check(&mut self) -> bool {
        // A balance is a short JSON string; 64 bytes is plenty and bounds the read.
        let empty = (0..env::promise_results_count()).all(|i| {
            env::promise_result_checked(i, 64)
                .ok()
                .and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok())
                .is_some_and(|b| b.0 == 0)
        });
        if !empty {
            near_sdk::log!("delete refused: tokens_left");
            return false;
        }
        Promise::new(env::current_account_id())
            .delete_account(self.dao_id.clone())
            .detach();
        true
    }
}
