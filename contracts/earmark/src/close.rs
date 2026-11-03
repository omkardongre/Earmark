//! `close_envelope` (R11, R12): the only way money leaves a budget other than a spend.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::{U64, U128};
use near_sdk::{Gas, NearToken, PromiseError, PromiseOrValue, env, near};

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
